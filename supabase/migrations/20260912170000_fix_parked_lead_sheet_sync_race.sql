-- Fixes a race condition where an "External Transfer" (parked) lead could
-- show a stale status in Google Sheets even though Supabase correctly shows
-- 'parked'.
--
-- Root cause: submit_form_parked() called submit_form() (which INSERTs the
-- row with status='pending_manager', firing the sheet_sync_on_insert
-- trigger), then immediately UPDATEd that same row to status='parked'
-- (firing the separate sheet_sync_on_closed trigger). That dispatches two
-- outbound HTTP requests to Apps Script within the same transaction, with no
-- guarantee the 'parked' request is the one that actually lands last —
-- Apps Script upserts by Submission ID, so whichever of the two concurrent
-- requests it finishes processing last wins, and it is not guaranteed to be
-- the newer one.
--
-- Fix: the parked path now performs exactly one INSERT, already carrying
-- the final 'parked' status, so exactly one sheet-sync request is ever
-- fired for it. The shared insert logic (previously all of submit_form) is
-- extracted into submit_form_internal(p_payload, p_status) so both
-- submit_form() and submit_form_parked() share it without submit_form_parked
-- having to insert-then-update. p_status is intentionally NOT reachable via
-- submit_form() itself (which always passes null) — submit_form_internal's
-- EXECUTE is revoked from anon/authenticated so a client cannot call it
-- directly and choose an arbitrary status, which would otherwise let a
-- closer bypass the normal pending_manager review start state.

create or replace function public.submit_form_internal(p_payload jsonb, p_status sub_status)
returns submissions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r submissions;
  v_role app_role := my_role();
  v_staff text;
  v_center_id uuid;
  v_center_name text;
  v_draft_date date;
  v_future_draft_date date;
  v_ssn text;
  v_status sub_status;
begin
  if v_role not in ('closer','validator') then
    raise exception 'not authorized to submit';
  end if;

  select p.staff_id, p.center_id, c.name
    into v_staff, v_center_id, v_center_name
  from profiles p left join centers c on c.id = p.center_id
  where p.id = auth.uid();

  begin
    v_draft_date := nullif(p_payload->>'Draft Date', '')::date;
  exception when others then
    v_draft_date := null;
  end;
  begin
    v_future_draft_date := nullif(p_payload->>'Future Draft Date', '')::date;
  exception when others then
    v_future_draft_date := null;
  end;

  -- digits-only SSN for duplicate matching; null unless it forms a clean 9 digits
  v_ssn := regexp_replace(coalesce(p_payload->>'SSN Number',''), '\D', '', 'g');
  if length(v_ssn) <> 9 then v_ssn := null; end if;

  -- A validator submission always auto-accepts and closes regardless of any
  -- requested status override — parking only makes sense for a closer-
  -- originated lead. submit_form_parked() checks submitted_by_role after
  -- this call and treats a validator's own submission as already handled.
  v_status := case
    when v_role = 'validator' then 'closed'::sub_status
    else coalesce(p_status, 'pending_manager'::sub_status)
  end;

  insert into submissions (
    closer_id, payload, submitted_by_role, center_id, center_name,
    draft_date, future_draft_date, ssn_normalized,
    status, disposition, disposed_by, disposed_at
  )
  values (
    auth.uid(),
    p_payload
      || jsonb_build_object('ID', coalesce(v_staff, ''))
      || jsonb_build_object('Submitted By Role', v_role::text),
    v_role,
    v_center_id, v_center_name,
    v_draft_date, v_future_draft_date, v_ssn,
    v_status,
    case when v_role = 'validator' then 'accepted'::disposition_t else null end,
    case when v_role = 'validator' then auth.uid() else null end,
    case when v_role = 'validator' then now() else null end
  )
  returning * into r;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (r.id, auth.uid(), 'submitted', jsonb_build_object('by_role', v_role, 'staff_id', v_staff));

  if v_role = 'validator' then
    insert into form_events (submission_id, actor_id, event_type, detail)
    values (r.id, auth.uid(), 'disposed',
            jsonb_build_object('disposition', 'accepted', 'by_role', v_role, 'auto', true));
  end if;

  return r;
end;
$function$;

-- Not a client-facing RPC: only submit_form()/submit_form_parked() (both
-- SECURITY DEFINER, owned by the same role) may call this. Revoking from
-- anon/authenticated is what stops a client from calling it directly with
-- an arbitrary p_status and skipping the normal pending_manager start state.
revoke all on function public.submit_form_internal(jsonb, sub_status) from public, anon, authenticated;

create or replace function public.submit_form(p_payload jsonb)
returns submissions
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  return public.submit_form_internal(p_payload, null);
end;
$function$;

create or replace function public.submit_form_parked(p_payload jsonb)
returns submissions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r submissions;
begin
  r := public.submit_form_internal(p_payload, 'parked'::sub_status);

  -- A validator submission auto-accepts and closes; submit_form_internal
  -- already ignored the 'parked' override for it above, so there is
  -- nothing left to record here.
  if r.submitted_by_role = 'validator' then
    return r;
  end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (r.id, auth.uid(), 'parked', jsonb_build_object('via', 'external_transfer'));

  return r;
end;
$function$;
