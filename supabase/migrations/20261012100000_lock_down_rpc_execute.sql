-- Lock down SECURITY DEFINER functions that `anon` (the publishable key that ships
-- in the browser bundle) could still execute.
--
-- Found 2026-10-12: 48 SECURITY DEFINER functions in `public` were executable by
-- `anon`. Three of them had fail-open guards (`v_role not in (...)` is NULL, not
-- true, for a caller with no role, so it fell through): payment_summary returned
-- bank details, update_payload_field performed the write, card_details was not
-- refused. Others had no caller check at all because they were only ever meant
-- for cron or an edge function (ingest_sheet_lead, bump_import_skipped,
-- purge_old_reporting_leads, purge_payment_data, ...).
--
-- 1. The three guards are rewritten fail-closed.
-- 2. EXECUTE is revoked from `public` and `anon` by name on every SECURITY DEFINER
--    function except the three that RLS policies and the pre-login suspension
--    check call, which return only NULL / harmless values for anon. Every other
--    function is then granted to `authenticated` explicitly, so nothing depends
--    on the PUBLIC grant that was just removed.
-- 3. Cron-, trigger- and edge-function-only functions are not callable by
--    `authenticated` either. `postgres` (pg_cron, triggers) and `service_role`
--    (the edge functions) keep their access.
-- 4. Functions created from now on are not anon-executable by default.

-- 1. Fail-closed guards -------------------------------------------------------

create or replace function public.payment_summary(p_sub uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_role app_role := my_role(); r payment_details;
begin
  if v_role is null or v_role not in ('admin','manager','closing_manager','general_manager','validator','cxm','cxa') then
    raise exception 'not authorized';
  end if;
  if v_role = 'validator' then
    perform 1 from submissions
      where id = p_sub and assigned_to = auth.uid() and archived_at is null;
    if not found then raise exception 'not assigned to you'; end if;
  end if;
  if v_role in ('cxm','cxa') and not cx_pipeline_member(p_sub) then
    raise exception 'lead is not in the customer pipeline';
  end if;

  select * into r from payment_details where submission_id = p_sub;
  if r.submission_id is null then return null; end if;

  return jsonb_build_object(
    'payment_type', r.payment_type,
    'bank_name', r.bank_name,
    'routing_number', r.routing_number,
    'account_number', r.account_number,
    'account_title', r.account_title,
    'card_last4', r.card_last4,
    'card_exp', r.card_exp,
    'has_card', r.card_number is not null,
    'cvv_purged', r.cvv_purged_at is not null
  );
end $function$;

create or replace function public.card_details(p_sub uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_role app_role := my_role(); r payment_details;
begin
  if v_role is null or v_role not in ('admin','validator') then
    raise exception 'not authorized';
  end if;
  if v_role = 'validator' then
    perform 1 from submissions
      where id = p_sub and assigned_to = auth.uid()
        and status = 'in_review' and archived_at is null;
    if not found then raise exception 'not currently reviewing this lead'; end if;
  end if;

  select * into r from payment_details where submission_id = p_sub;
  if r.submission_id is null then return null; end if;

  insert into card_access_log (submission_id, actor_id) values (p_sub, auth.uid());

  return jsonb_build_object(
    'card_number', r.card_number,
    'card_exp', r.card_exp,
    'cvv', r.cvv,
    'cvv_purged', r.cvv_purged_at is not null,
    'card_purged', r.card_purged_at is not null
  );
end $function$;

create or replace function public.update_payload_field(p_sub uuid, p_field text, p_value text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_role app_role := my_role(); v_old text; v_locked boolean;
begin
  if v_role is null or v_role not in ('closing_manager','general_manager','manager','admin','cxa','cxm') then
    raise exception 'not authorized';
  end if;

  if v_role in ('cxa','cxm') and not cx_pipeline_member(p_sub) then
    raise exception 'lead is not in the customer pipeline';
  end if;

  if p_field in ('ID','Submitted By Role') then
    raise exception '% is set by the system and cannot be edited', p_field;
  end if;

  select payload->>p_field, archived_at is not null into v_old, v_locked
  from submissions where id = p_sub;
  if not found then raise exception 'submission not found'; end if;
  if v_locked then raise exception 'archived leads cannot be edited'; end if;

  update submissions
     set payload = jsonb_set(payload, array[p_field], to_jsonb(p_value), true)
   where id = p_sub;

  -- Three payload keys are mirrored into real columns, and those columns are
  -- what every date filter, the By Draft Date desk and the duplicate check
  -- read. Writing the payload without re-deriving them left a correction
  -- invisible everywhere it mattered.
  if p_field = 'Draft Date' then
    update submissions set draft_date = parse_lead_date(p_value) where id = p_sub;
  elsif p_field = 'Future Draft Date' then
    update submissions set future_draft_date = parse_lead_date(p_value) where id = p_sub;
  elsif p_field = 'SSN Number' then
    update submissions set ssn_normalized = normalize_ssn(p_value) where id = p_sub;
  end if;

  insert into payload_edits (submission_id, actor_id, field, old_value, new_value)
  values (p_sub, auth.uid(), p_field, v_old, p_value);

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'payload_edited',
          jsonb_build_object('field', p_field, 'by_role', v_role));

  return jsonb_build_object('ok', true, 'field', p_field);
end $function$;

-- 2 + 3. Grants ---------------------------------------------------------------

do $$
declare
  f record;
  -- Called by RLS policies and the pre-login suspension check; harmless for anon.
  keep_public constant text[] := array['my_role', 'review_window', 'review_settings'];
  -- Cron, triggers and edge functions only. No signed-in user calls these.
  internal_only constant text[] := array[
    'ingest_sheet_lead', 'bump_import_skipped', 'submit_external_lead',
    'purge_old_reporting_leads', 'purge_payment_data', 'expire_stale_reviews',
    'roll_recurring_draft_dates', 'drain_sheet_sync_queue',
    'retry_failed_sheet_syncs', 'resolve_sheet_syncs', 'sheet_sync_row',
    'sync_submission_to_sheet', 'clear_expired_suspension',
    'guard_last_admin', 'handle_new_user', 'notify_sheet_sync'
  ];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prokind = 'f'
      and p.prosecdef
      and p.proname <> all (keep_public)
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname = any (internal_only) then
      execute format('revoke execute on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- 4. New functions are not anon-executable by default -------------------------

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon;

-- 5. Found by the security advisor after the above ----------------------------
-- submit_form_internal takes the lead's status as an argument and has a guard
-- that is NULL (fails open) for a signed-in caller with no profile; it is only
-- ever called from submit_form / submit_form_parked, which run as the owner, so
-- no signed-in user needs to reach it directly. The two trigger functions are
-- never called as RPCs either.
revoke execute on function public.submit_form_internal(jsonb, sub_status) from authenticated;
revoke execute on function public.payment_details_sync_missing_bank() from authenticated;
revoke execute on function public.submissions_set_missing_bank() from authenticated;
