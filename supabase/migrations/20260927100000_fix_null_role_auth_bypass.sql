-- Fix: ~19 SECURITY DEFINER RPCs fail open for a roleless caller.
--
-- my_role() returns NULL for a caller with no profile, no JWT, or an
-- inactive profile. `NULL <> 'admin'` and `NULL NOT IN (...)` both evaluate
-- to NULL, not true, so `if my_role() <> 'admin' then raise ...` / `if
-- my_role() not in (...) then raise ...` silently pass instead of raising.
-- Verified live (2026-09-17 audit, docs/TODO.md): admin_settings() and
-- reporting_retention_status() returned real data to `anon`.
--
-- Fix is `is distinct from` for the `<>` form and an explicit `is null or`
-- for the `not in` form -- the same shape already used correctly in
-- sheet_sync_backlog_status(), which had the same bug fixed before release.
-- No other line in any of these functions changes.
--
-- Also revoke EXECUTE from anon by name on every one of them: `revoke ...
-- from public` does not remove Supabase's default direct grant to `anon`.

-- ---------------------------------------------------------------------
-- `<>` form
-- ---------------------------------------------------------------------

create or replace function public.admin_settings()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if my_role() is distinct from 'admin' then raise exception 'not authorized'; end if;
  return (
    select jsonb_object_agg(key, value)
    from app_config
    where key in (
      'review_timeout_enabled','review_timeout_minutes','max_holds',
      'reporting_retention_days','cvv_purge_days','card_purge_days'
    )
  );
end $function$;

create or replace function public.reject_assignment(p_sub uuid, p_reason text default null::text)
 returns submissions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r submissions;
begin
  if my_role() is distinct from 'validator' then raise exception 'not authorized'; end if;

  update submissions set
    status = 'pending_manager',
    assigned_to = null,
    assigned_at = null,
    claimed_at = null,
    last_rejected_by = auth.uid(),
    rejection_count = rejection_count + 1
  where id = p_sub
    and assigned_to = auth.uid()
    and status in ('assigned','in_review')
  returning * into r;

  if r.id is null then raise exception 'not assigned to you, or already actioned'; end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'rejected',
          jsonb_build_object('reason', p_reason, 'rejection_number', r.rejection_count));

  return r;
end $function$;

create or replace function public.reporting_retention_status()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_last timestamptz; v_status text; v_last_count int;
begin
  if my_role() is distinct from 'admin' then raise exception 'not authorized'; end if;

  select d.end_time, d.status into v_last, v_status
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
  where j.jobname = 'purge-reporting-leads'
  order by d.end_time desc limit 1;

  select count(*) into v_last_count
  from submissions
  where archived_by is null
    and archived_at is not null
    and archived_at >= coalesce(v_last, 'epoch'::timestamptz) - interval '1 minute';

  return jsonb_build_object(
    'last_run', v_last, 'last_status', v_status, 'last_archived_count', v_last_count
  );
end $function$;

create or replace function public.restore_to_cx_pipeline(p_sub uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_id uuid;
begin
  if my_role() is distinct from 'admin' then raise exception 'not authorized'; end if;

  update submissions
     set cx_removed_at = null, cx_removed_by = null
   where id = p_sub and cx_removed_at is not null
  returning id into v_id;

  if v_id is null then raise exception 'lead was not removed from the customer pipeline'; end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'cx_restored', '{}'::jsonb);

  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.set_admin_setting(p_key text, p_value text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_allowed text[] := array['review_timeout_enabled','review_timeout_minutes',
                            'max_holds','reporting_retention_days',
                            'cvv_purge_days','card_purge_days'];
  v_old text;
  v_num int;
begin
  if my_role() is distinct from 'admin' then raise exception 'not authorized'; end if;
  if not (p_key = any(v_allowed)) then
    raise exception 'setting % is not editable', p_key;
  end if;

  if p_key = 'review_timeout_enabled' then
    if p_value not in ('true','false') then
      raise exception 'review_timeout_enabled must be true or false';
    end if;
  else
    begin
      v_num := p_value::int;
    exception when others then
      raise exception '% must be a whole number', p_key;
    end;
    if v_num < 0 then raise exception '% cannot be negative', p_key; end if;
    if p_key = 'review_timeout_minutes' and v_num < 1 then
      raise exception 'review window must be at least 1 minute';
    end if;
    if p_key = 'cvv_purge_days' and v_num > 30 then
      raise exception 'CVV must be purged within 30 days';
    end if;
  end if;

  select value into v_old from app_config where key = p_key;

  insert into app_config (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value;

  insert into settings_audit (actor_id, key, old_value, new_value)
  values (auth.uid(), p_key, v_old, p_value);

  return jsonb_build_object('ok', true, 'key', p_key, 'value', p_value);
end $function$;

-- ---------------------------------------------------------------------
-- `not in` form
-- ---------------------------------------------------------------------

create or replace function public.add_submission_tag(p_sub uuid, p_tag uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if my_role() is null or my_role() not in ('cxa','cxm','admin','manager','general_manager') then
    raise exception 'not authorized';
  end if;

  perform 1 from submissions
   where id = p_sub and disposition = 'accepted' and archived_at is null;
  if not found then raise exception 'lead is not in the customer pipeline'; end if;

  insert into submission_tags (submission_id, tag_id, tagged_by)
  values (p_sub, p_tag, auth.uid())
  on conflict do nothing;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'tag_added',
          jsonb_build_object('tag', (select label from cx_tags where id = p_tag)));
end
$function$;

create or replace function public.approve_import_batch(p_import_id uuid, p_reject_ids uuid[] default '{}'::uuid[])
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_approved int; v_rejected int;
begin
  if my_role() is null or my_role() not in ('manager','admin') then raise exception 'not authorized'; end if;

  with approved as (
    update submissions set status = 'pending_manager'
    where import_id = p_import_id
      and status = 'pending_import_approval'
      and not (id = any(p_reject_ids))
    returning id
  )
  insert into form_events (submission_id, actor_id, event_type)
  select id, auth.uid(), 'import_approved' from approved;
  get diagnostics v_approved = row_count;

  if array_length(p_reject_ids, 1) > 0 then
    with rejected as (
      update submissions set
        archived_at = now(), archived_by = auth.uid()
      where import_id = p_import_id
        and status = 'pending_import_approval'
        and id = any(p_reject_ids)
      returning id
    )
    insert into form_events (submission_id, actor_id, event_type)
    select id, auth.uid(), 'import_lead_rejected' from rejected;
    get diagnostics v_rejected = row_count;
  else
    v_rejected := 0;
  end if;

  if v_approved = 0 and v_rejected = 0 then
    raise exception 'batch not found or already decided';
  end if;

  return jsonb_build_object('approved', v_approved, 'rejected', v_rejected);
end $function$;

create or replace function public.archive_submission(p_sub uuid, p_reason text default null::text)
 returns submissions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r submissions;
begin
  if my_role() is null or my_role() not in ('manager','admin') then raise exception 'not authorized'; end if;

  update submissions set
    archived_at = now(), archived_by = auth.uid(),
    assigned_to = null, assigned_at = null, claimed_at = null
  where id = p_sub and archived_at is null
  returning * into r;

  if r.id is null then raise exception 'already archived'; end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'archived', jsonb_build_object('reason', p_reason));
  return r;
end $function$;

create or replace function public.assign_to_validator(p_sub uuid, p_validator uuid)
 returns submissions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r submissions;
begin
  if my_role() is null or my_role() not in ('manager','admin') then raise exception 'not authorized'; end if;

  update submissions set
    status = 'assigned', assigned_to = p_validator,
    assigned_at = now(), claimed_at = null
  where id = p_sub
    and status in ('pending_manager','returned_timeout')
    and submitted_by_role = 'closer'
  returning * into r;

  if r.id is null then
    raise exception 'not assignable: already assigned, closed, or submitted by a validator';
  end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'assigned', jsonb_build_object('validator', p_validator));
  return r;
end $function$;

create or replace function public.check_duplicate_ssn(p_ssn text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_norm text;
  r record;
  v_exempt boolean := false;
begin
  if my_role() is null or my_role() not in ('closer','validator','manager','admin') then
    raise exception 'not authorized';
  end if;

  v_norm := regexp_replace(coalesce(p_ssn,''), '\D', '', 'g');
  if length(v_norm) <> 9 then
    return jsonb_build_object('exists', false);
  end if;

  select
    case
      when s.disposition = 'accepted' then 'accepted'
      when s.disposition = 'declined' then 'declined'
      else 'in_progress'
    end as bucket,
    s.created_at
  into r
  from submissions s
  where s.ssn_normalized = v_norm
    and s.archived_at is null
  order by (s.disposition = 'accepted') desc, s.created_at desc
  limit 1;

  if r is null then
    return jsonb_build_object('exists', false);
  end if;

  -- exempt only ever matters for an accepted match, mirroring exactly what
  -- submit_form_internal will decide -- checked against every accepted
  -- duplicate, not just the one row picked as "most relevant" to display.
  if r.bucket = 'accepted' then
    select exists (
      select 1
      from submissions s
      join submission_tags st on st.submission_id = s.id
      join cx_tags t on t.id = st.tag_id
      where s.ssn_normalized = v_norm
        and s.archived_at is null
        and s.disposition = 'accepted'
        and t.allows_duplicate_ssn
    ) into v_exempt;
  end if;

  return jsonb_build_object(
    'exists', true,
    'status', r.bucket,
    'submitted_at', r.created_at,
    'exempt', v_exempt
  );
end;
$function$;

create or replace function public.clear_data_flag(p_sub uuid, p_field text)
 returns submissions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r submissions;
begin
  if my_role() is null or my_role() not in ('manager','admin','data_uploader') then
    raise exception 'not authorized';
  end if;
  update submissions set data_flags = (
    select coalesce(jsonb_agg(f), '[]'::jsonb) from jsonb_array_elements(data_flags) f
    where f->>'field' <> p_field
  )
  where id = p_sub
  returning * into r;
  if r.id is null then raise exception 'submission not found'; end if;
  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'flag_cleared', jsonb_build_object('field', p_field));
  return r;
end $function$;

create or replace function public.move_to_validation(p_sub uuid)
 returns submissions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r submissions;
begin
  if my_role() is null or my_role() not in ('admin', 'general_manager') then
    raise exception 'not authorized';
  end if;

  update submissions
     set status = 'pending_manager'
   where id = p_sub
     and status = 'parked'
     and archived_at is null
  returning * into r;

  if r.id is null then
    raise exception 'lead is not parked';
  end if;

  insert into form_events (submission_id, actor_id, event_type)
  values (r.id, auth.uid(), 'moved_to_validation');

  return r;
end $function$;

create or replace function public.reject_import_batch(p_import_id uuid, p_reason text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n int;
begin
  if my_role() is null or my_role() not in ('manager','admin') then raise exception 'not authorized'; end if;

  with rejected as (
    update submissions set archived_at = now(), archived_by = auth.uid()
    where import_id = p_import_id and status = 'pending_import_approval'
    returning id
  )
  insert into form_events (submission_id, actor_id, event_type, detail)
  select id, auth.uid(), 'import_batch_rejected', jsonb_build_object('reason', p_reason)
  from rejected;
  get diagnostics n = row_count;

  if n = 0 then raise exception 'batch not found or already decided'; end if;
  return jsonb_build_object('rejected', n);
end $function$;

create or replace function public.remove_from_cx_pipeline(p_sub uuid, p_reason text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if my_role() is null or my_role() not in ('cxa','cxm','admin') then raise exception 'not authorized'; end if;

  if not cx_pipeline_member(p_sub) then
    raise exception 'lead is not in the customer pipeline';
  end if;

  update submissions
     set cx_removed_at = now(), cx_removed_by = auth.uid()
   where id = p_sub;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'cx_removed',
          jsonb_build_object('reason', nullif(p_reason, '')));

  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.remove_submission_tag(p_sub uuid, p_tag uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if my_role() is null or my_role() not in ('cxa','cxm','admin','manager','general_manager') then raise exception 'not authorized'; end if;
  delete from submission_tags where submission_id = p_sub and tag_id = p_tag;
  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'tag_removed',
          jsonb_build_object('tag', (select label from cx_tags where id = p_tag)));
end
$function$;

create or replace function public.return_lead_for_validation(p_sub uuid, p_reason text default null::text)
 returns submissions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r submissions;
begin
  if my_role() is null or my_role() not in ('cxa','cxm','admin') then raise exception 'not authorized'; end if;

  update submissions set
    status = 'pending_manager',
    disposition = null,
    disposed_by = null,
    disposed_at = null,
    assigned_to = null,
    assigned_at = null,
    claimed_at = null,
    final_carrier_id = null,
    agent_name = null,
    policy_number = null,
    reopened_from_cx_at = now()
  where id = p_sub
    and disposition = 'accepted'
    and archived_at is null
    and cx_removed_at is null
  returning * into r;

  if r.id is null then raise exception 'lead is not in the customer pipeline'; end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'reopened_from_cx',
          jsonb_build_object('reason', nullif(p_reason, '')));

  return r;
end $function$;

create or replace function public.set_cx_status(p_sub uuid, p_category text, p_option_id uuid, p_reason text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_opt cx_status_options; v_prev text;
begin
  if my_role() is null or my_role() not in ('cxa','cxm','admin') then raise exception 'not authorized'; end if;

  if not cx_pipeline_member(p_sub) then
    raise exception 'lead is not in the customer pipeline';
  end if;

  if p_option_id is not null then
    select * into v_opt from cx_status_options
     where id = p_option_id and category = p_category and active;
    if v_opt.id is null then
      raise exception 'invalid option for category %', p_category;
    end if;
  end if;

  insert into cx_lead_status (submission_id) values (p_sub)
  on conflict (submission_id) do nothing;

  execute format(
    'select o.code from cx_lead_status s left join cx_status_options o
       on o.id = s.%I where s.submission_id = $1',
    p_category || '_status_id')
  into v_prev using p_sub;

  if v_prev is not distinct from v_opt.code and nullif(p_reason,'') is null then
    return jsonb_build_object('ok', true, 'unchanged', true);
  end if;

  execute format(
    'update cx_lead_status set %I = $2, %I = $3, updated_by = $4, updated_at = now()
      where submission_id = $1',
    p_category || '_status_id', p_category || '_reason')
  using p_sub, p_option_id, nullif(p_reason, ''), auth.uid();

  insert into cx_status_history (submission_id, category, from_code, to_code, reason, actor_id)
  values (p_sub, p_category, v_prev, v_opt.code, nullif(p_reason,''), auth.uid());

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'cx_status_changed',
          jsonb_build_object('category', p_category, 'from', v_prev,
                             'to', v_opt.code, 'reason', nullif(p_reason, '')));

  return jsonb_build_object('ok', true, 'category', p_category, 'code', v_opt.code);
end $function$;

create or replace function public.start_lead_import(p_file_name text, p_row_count integer)
 returns lead_imports
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r lead_imports;
begin
  if my_role() is null or my_role() not in ('data_uploader','admin') then
    raise exception 'not authorized to import leads';
  end if;
  insert into lead_imports (uploaded_by, file_name, row_count)
  values (auth.uid(), p_file_name, p_row_count)
  returning * into r;
  return r;
end $function$;

create or replace function public.unarchive_submission(p_sub uuid)
 returns submissions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r submissions;
begin
  if my_role() is null or my_role() not in ('manager','admin') then raise exception 'not authorized'; end if;
  update submissions set archived_at = null, archived_by = null
  where id = p_sub and archived_at is not null
  returning * into r;
  if r.id is null then raise exception 'not archived'; end if;
  insert into form_events (submission_id, actor_id, event_type)
  values (p_sub, auth.uid(), 'unarchived');
  return r;
end $function$;

-- ---------------------------------------------------------------------
-- Revoke EXECUTE from anon by name (revoking from public alone does not
-- remove Supabase's default direct grant to anon).
-- ---------------------------------------------------------------------

revoke execute on function public.admin_settings() from anon;
revoke execute on function public.reject_assignment(uuid, text) from anon;
revoke execute on function public.reporting_retention_status() from anon;
revoke execute on function public.restore_to_cx_pipeline(uuid) from anon;
revoke execute on function public.set_admin_setting(text, text) from anon;
revoke execute on function public.add_submission_tag(uuid, uuid) from anon;
revoke execute on function public.approve_import_batch(uuid, uuid[]) from anon;
revoke execute on function public.archive_submission(uuid, text) from anon;
revoke execute on function public.assign_to_validator(uuid, uuid) from anon;
revoke execute on function public.check_duplicate_ssn(text) from anon;
revoke execute on function public.clear_data_flag(uuid, text) from anon;
revoke execute on function public.move_to_validation(uuid) from anon;
revoke execute on function public.reject_import_batch(uuid, text) from anon;
revoke execute on function public.remove_from_cx_pipeline(uuid, text) from anon;
revoke execute on function public.remove_submission_tag(uuid, uuid) from anon;
revoke execute on function public.return_lead_for_validation(uuid, text) from anon;
revoke execute on function public.set_cx_status(uuid, text, uuid, text) from anon;
revoke execute on function public.start_lead_import(text, integer) from anon;
revoke execute on function public.unarchive_submission(uuid) from anon;
