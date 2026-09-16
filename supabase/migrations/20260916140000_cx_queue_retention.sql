-- CX queue retention, CX-only removal, and CXA lead editing.
--
-- Until now the customer pipeline was defined by one predicate repeated in four
-- places: `disposition = 'accepted' and archived_at is null`. Because
-- `return_lead_for_validation` clears `disposition`, sending a lead back to the
-- manager also deleted it from the CXA's own screen — the CXA lost sight of the
-- lead at exactly the moment they were waiting on an answer about it.
--
-- The pipeline is now "a lead the CX team has not finished with": still every
-- accepted lead, plus every lead the CX team sent back, until a CXA explicitly
-- removes it. Removal is a soft, CX-only flag — reporting, exports, the manager
-- queue and the audit trail are untouched, and an admin can restore it.

alter table submissions
  add column if not exists cx_removed_at timestamptz,
  add column if not exists cx_removed_by uuid references profiles(id);

comment on column submissions.cx_removed_at is
  'Set by remove_from_cx_pipeline: the lead leaves the CX workspace only. Not an archive — every other queue, view and report still sees the row.';

-- The pipeline predicate, spelled once.
--
-- `security definer` so the RPC guards below read `submissions` without
-- re-entering RLS. The RLS policy itself keeps the predicate inline: a policy
-- on `submissions` must not call a function that selects from `submissions`.
create or replace function public.cx_pipeline_member(p_sub uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from submissions
     where id = p_sub
       and archived_at is null
       and cx_removed_at is null
       and (disposition = 'accepted' or reopened_from_cx_at is not null)
  )
$$;

-- RLS: the cxa/cxm branches widen to the same predicate. Every other branch is
-- byte-identical to what was live before this migration.
drop policy if exists "submissions read scoped" on submissions;
create policy "submissions read scoped" on submissions
for select using (
  case my_role()
    when 'admin' then true
    when 'manager' then (status <> 'parked'::sub_status)
    when 'closing_manager' then (
      submitted_by_role = 'closer'::app_role
      and archived_at is null
      and center_id is not null
      and center_id = (select p.center_id from profiles p where p.id = auth.uid())
    )
    when 'general_manager' then (
      submitted_by_role = any (array['closer'::app_role, 'validator'::app_role])
      and archived_at is null
    )
    when 'validator' then (
      assigned_to = auth.uid()
      and archived_at is null
      and status = any (array['assigned'::sub_status, 'in_review'::sub_status])
      and (claimed_at is null or claimed_at > (now() - review_window()))
    )
    when 'data_uploader' then (uploaded_by = auth.uid())
    when 'cxm' then (
      archived_at is null
      and cx_removed_at is null
      and (disposition = 'accepted'::disposition_t or reopened_from_cx_at is not null)
    )
    when 'cxa' then (
      archived_at is null
      and cx_removed_at is null
      and (disposition = 'accepted'::disposition_t or reopened_from_cx_at is not null)
    )
    else false
  end
);

-- The view follows the same predicate, and now carries the three columns the
-- pipeline table needs to tell a live lead from one out for re-validation.
create or replace view public.cx_pipeline
with (security_invoker = true) as
 SELECT s.id AS submission_id,
    s.payload,
    s.created_at AS submitted_on,
    s.disposed_at AS approved_on,
    s.source,
    po.code AS policy_code,
    po.label AS policy_label,
    po.tone AS policy_tone,
    st.policy_reason,
    pr.code AS premium_code,
    pr.label AS premium_label,
    pr.tone AS premium_tone,
    st.premium_reason,
    cm.code AS commission_code,
    cm.label AS commission_label,
    cm.tone AS commission_tone,
    st.commission_reason,
    cb.code AS chargeback_code,
    cb.label AS chargeback_label,
    cb.tone AS chargeback_tone,
    st.chargeback_reason,
    st.updated_at AS cx_updated_at,
    u.full_name AS cx_updated_by,
    s.draft_date,
    s.status,
    s.disposition,
    s.reopened_from_cx_at
   FROM submissions s
     LEFT JOIN cx_lead_status st ON st.submission_id = s.id
     LEFT JOIN cx_status_options po ON po.id = st.policy_status_id
     LEFT JOIN cx_status_options pr ON pr.id = st.premium_status_id
     LEFT JOIN cx_status_options cm ON cm.id = st.commission_status_id
     LEFT JOIN cx_status_options cb ON cb.id = st.chargeback_status_id
     LEFT JOIN profiles u ON u.id = st.updated_by
  WHERE s.archived_at IS NULL
    AND s.cx_removed_at IS NULL
    AND (s.disposition = 'accepted'::disposition_t OR s.reopened_from_cx_at IS NOT NULL);

-- Statuses stay editable while a lead is out for re-validation: the CXA is
-- usually setting one *because* of what came back.
create or replace function public.set_cx_status(p_sub uuid, p_category text, p_option_id uuid, p_reason text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_opt cx_status_options; v_prev text;
begin
  if my_role() not in ('cxa','cxm','admin') then raise exception 'not authorized'; end if;

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

  -- no-op guard: re-selecting the same value with no new reason changes nothing
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

-- Same widening for the banking read, so the panel still resolves on a lead
-- that is out for re-validation.
create or replace function public.payment_summary(p_sub uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare v_role app_role := my_role(); r payment_details;
begin
  if v_role not in ('admin','manager','closing_manager','general_manager','validator','cxm','cxa') then
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

-- A CXA corrects the lead they are servicing. Same per-field before/after row
-- in `payload_edits` as every other role's edit; the two system-stamped keys
-- stay refused.
create or replace function public.update_payload_field(p_sub uuid, p_field text, p_value text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_role app_role := my_role(); v_old text; v_locked boolean;
begin
  if v_role not in ('closing_manager','general_manager','manager','admin','cxa','cxm') then
    raise exception 'not authorized';
  end if;

  -- The CX roles reach a lead only through their own queue, so their edit is
  -- scoped to it. Every other role keeps the reach it already had.
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

  insert into payload_edits (submission_id, actor_id, field, old_value, new_value)
  values (p_sub, auth.uid(), p_field, v_old, p_value);

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'payload_edited',
          jsonb_build_object('field', p_field, 'by_role', v_role));

  return jsonb_build_object('ok', true, 'field', p_field);
end $function$;

-- Bank fields for a CXA; card number and CVV stay admin-only. The card check
-- below is unchanged and is what refuses them — the same line that refuses a
-- manager, rather than a second rule that could drift away from it.
create or replace function public.update_payment_field(p_sub uuid, p_field text, p_value text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role app_role := my_role();
  v_bank_fields text[] := array['payment_type','bank_name','routing_number',
                                'account_number','account_title','card_exp'];
  v_card_fields text[] := array['card_number','cvv'];
  v_old text;
begin
  if v_role not in ('manager','admin','cxa','cxm') then
    raise exception 'not authorized';
  end if;

  if p_field = any(v_card_fields) and v_role <> 'admin' then
    raise exception 'only an admin may change card credentials';
  end if;

  if v_role in ('cxa','cxm') and not cx_pipeline_member(p_sub) then
    raise exception 'lead is not in the customer pipeline';
  end if;

  if not (p_field = any(v_bank_fields) or p_field = any(v_card_fields)) then
    raise exception 'field % is not editable here', p_field;
  end if;

  if p_field = 'payment_type' and p_value not in ('card','draft','unknown') then
    raise exception 'payment_type must be card, draft or unknown';
  end if;

  -- create the row if the lead arrived without payment details at all
  insert into payment_details (submission_id) values (p_sub)
  on conflict (submission_id) do nothing;

  execute format('select %I::text from payment_details where submission_id = $1', p_field)
    into v_old using p_sub;

  execute format('update payment_details set %I = $2 where submission_id = $1', p_field)
    using p_sub, nullif(p_value, '');

  -- keep last4 consistent when the card number changes
  if p_field = 'card_number' then
    update payment_details
      set card_last4 = right(regexp_replace(coalesce(p_value,''), '\D', '', 'g'), 4)
    where submission_id = p_sub;
  end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'payment_edited',
          jsonb_build_object('field', p_field,
                             'had_value', v_old is not null and v_old <> '',
                             'by_role', v_role));

  return jsonb_build_object('ok', true, 'field', p_field);
end $function$;

-- Returning keeps its strict guard. A lead already out for re-validation has no
-- `disposition`, so a second send is refused here as well as hidden in the UI.
create or replace function public.return_lead_for_validation(p_sub uuid, p_reason text default null::text)
 returns submissions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r submissions;
begin
  if my_role() not in ('cxa','cxm','admin') then raise exception 'not authorized'; end if;

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

-- The CXA's own "remove from my queue". Nothing is destroyed and nothing leaves
-- any other queue: it sets a CX-only flag and records who did it and why.
create or replace function public.remove_from_cx_pipeline(p_sub uuid, p_reason text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if my_role() not in ('cxa','cxm','admin') then raise exception 'not authorized'; end if;

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

-- Removal is reversible, by an admin only.
create or replace function public.restore_to_cx_pipeline(p_sub uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_id uuid;
begin
  if my_role() <> 'admin' then raise exception 'not authorized'; end if;

  update submissions
     set cx_removed_at = null, cx_removed_by = null
   where id = p_sub and cx_removed_at is not null
  returning id into v_id;

  if v_id is null then raise exception 'lead was not removed from the customer pipeline'; end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'cx_restored', '{}'::jsonb);

  return jsonb_build_object('ok', true);
end $function$;

grant execute on function public.cx_pipeline_member(uuid) to authenticated;
grant execute on function public.remove_from_cx_pipeline(uuid, text) to authenticated;
grant execute on function public.restore_to_cx_pipeline(uuid) to authenticated;
