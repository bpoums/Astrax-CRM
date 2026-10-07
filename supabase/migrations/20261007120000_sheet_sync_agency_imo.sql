-- Send the validator-typed Agency and IMO (submissions.agency_name / imo_name)
-- to the Google Sheet. Three changes, all create-or-replace of live definitions:
--  * sheet_sync_row and sync_submission_to_sheet add the two keys to the body
--  * notify_sheet_sync re-queues a row when either value changes

create or replace function public.sheet_sync_row(p_sub uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  s public.submissions;
  v_closer text; v_disposer text; v_final_carrier text; v_uploader text;
begin
  select * into s from public.submissions where id = p_sub;
  if s.id is null then return null; end if;

  select full_name into v_closer from public.profiles where id = s.closer_id;
  if s.disposed_by is not null then
    select full_name into v_disposer from public.profiles where id = s.disposed_by;
  end if;
  if s.final_carrier_id is not null then
    select name into v_final_carrier from public.carriers where id = s.final_carrier_id;
  elsif s.submitted_by_role = 'validator' then
    v_final_carrier := nullif(s.payload->>'Agency', '');
  end if;
  if s.uploaded_by is not null then
    select full_name into v_uploader from public.profiles where id = s.uploaded_by;
  end if;

  return jsonb_build_object(
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
    'agency_name', coalesce(s.agency_name, ''),
    'imo_name', coalesce(s.imo_name, ''),
    'center_name', coalesce(s.center_name, ''),
    'lead_source', case when s.submitted_by_role = 'closer'
                         and s.source = 'live' then 'Live' else 'Manual' end,
    'source', s.source::text,
    'uploader_name', coalesce(v_uploader, '')
  );
end;
$function$;

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
      'agency_name', coalesce(s.agency_name, ''),
      'imo_name', coalesce(s.imo_name, ''),
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

create or replace function public.notify_sheet_sync()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_first_approval_sync boolean := TG_OP = 'UPDATE'
    and old.source = 'sheet'
    and old.status = 'pending_import_approval'
    and new.status <> 'pending_import_approval';
begin
  if new.source = 'sheet' and new.status = 'pending_import_approval' then
    return new;
  end if;

  if TG_OP = 'UPDATE' and not v_first_approval_sync then
    if new.disposition is not distinct from old.disposition
       and new.status is not distinct from old.status
       and new.archived_at is not distinct from old.archived_at
       and new.payload is not distinct from old.payload
       and new.final_carrier_id is not distinct from old.final_carrier_id
       and new.agent_name is not distinct from old.agent_name
       and new.policy_number is not distinct from old.policy_number
       and new.agency_name is not distinct from old.agency_name
       and new.imo_name is not distinct from old.imo_name then
      return new;
    end if;
    if new.disposition is not distinct from old.disposition
       and new.archived_at is not distinct from old.archived_at
       and new.payload is not distinct from old.payload
       and new.final_carrier_id is not distinct from old.final_carrier_id
       and new.agent_name is not distinct from old.agent_name
       and new.policy_number is not distinct from old.policy_number
       and new.agency_name is not distinct from old.agency_name
       and new.imo_name is not distinct from old.imo_name
       and new.status <> 'closed'
       and new.status <> 'parked'
       and old.status <> 'parked' then
      return new;
    end if;
  end if;

  insert into public.sheet_sync_queue (submission_id)
  values (new.id)
  on conflict (submission_id) do update
    set enqueued_at = now(),
        next_attempt_at = least(public.sheet_sync_queue.next_attempt_at, now());

  return new;
end;
$function$;
