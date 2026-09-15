-- The Google Sheet's "Final Carrier" column is blank on every validator
-- submission — 260 of them live, nearly half the sheet.
--
-- Why it was blank: sync_submission_to_sheet resolves that column from
-- submissions.final_carrier_id, which is stamped by set_validator_fields during
-- review. A validator's OWN submission never goes through review — it
-- auto-accepts and closes on submit (see submit_form_internal) — so the column
-- is null on all 260, and the sheet received ''.
--
-- But those leads DO have a final carrier, and it is the most reliable one in
-- the system: the validator form files it under the payload key "Agency", and
-- it is picked from the carriers list rather than typed, so all 260 live values
-- match a carriers row exactly. A validator only fills that form once the
-- carrier has accepted, which is precisely what "final" means here.
--
-- So: fall back to payload->>'Agency' for a validator submission. This is the
-- same precedence finalCarrierName() applies in ops.tsx and resolveCarrier()
-- in sales-breakdown.tsx; keeping the sheet on a different rule than the app is
-- the drift CLAUDE.md warns about.
--
-- The fallback is deliberately gated on submitted_by_role = 'validator' rather
-- than applied to any row with a blank final carrier. On a closer or uploaded
-- lead, "Agency" is absent and "Proposed Carrier" is only a proposal — letting
-- it through would report a pitch as though it were an issued policy.
--
-- Only rows synced from here on are affected; the 260 historical rows keep
-- their blank cell until something re-syncs them.

create or replace function public.sync_submission_to_sheet(p_sub uuid)
returns bigint
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  s public.submissions;
  v_url text; v_secret text; v_closer text; v_disposer text; v_final_carrier text; v_uploader text;
  v_request_id bigint;
begin
  select * into s from public.submissions where id = p_sub;
  if s.id is null then return null; end if;

  select value into v_url from public.app_config where key = 'sheet_sync_url';
  select value into v_secret from public.app_config where key = 'sync_secret';
  if v_url is null or v_secret is null then return null; end if;

  select full_name into v_closer from public.profiles where id = s.closer_id;
  if s.disposed_by is not null then
    select full_name into v_disposer from public.profiles where id = s.disposed_by;
  end if;
  if s.final_carrier_id is not null then
    select name into v_final_carrier from public.carriers where id = s.final_carrier_id;
  elsif s.submitted_by_role = 'validator' then
    -- Already a final carrier, just stored in the payload instead of the FK.
    v_final_carrier := nullif(s.payload->>'Agency', '');
  end if;
  if s.uploaded_by is not null then
    select full_name into v_uploader from public.profiles where id = s.uploaded_by;
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type','application/json','x-sync-secret', v_secret),
    body := jsonb_build_object(
      'id', s.id, 'payload', s.payload,
      'status', case when s.archived_at is not null then 'archived' else s.status::text end,
      'disposition', coalesce(s.disposition::text, ''),
      'submitted_at', s.created_at, 'disposed_at', s.disposed_at,
      'timeout_count', s.timeout_count, 'closer_name', v_closer,
      'disposed_by_name', v_disposer,
      'submitted_by_role', coalesce(s.submitted_by_role::text, 'closer'),
      'final_carrier', coalesce(v_final_carrier, ''),
      'agent_name', coalesce(s.agent_name, ''),
      'policy_number', coalesce(s.policy_number, ''),
      'center_name', coalesce(s.center_name, ''),
      'lead_source', case when s.submitted_by_role = 'closer'
                           and s.source = 'live' then 'Live' else 'Manual' end,
      'source', s.source::text,
      'uploader_name', coalesce(v_uploader, '')
    ),
    timeout_milliseconds := 45000
  ) into v_request_id;

  return v_request_id;
end;
$function$;
