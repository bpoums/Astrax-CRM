-- Uploaded leads (source='sheet') never reached Google Sheets at all before
-- this migration — notify_sheet_sync() unconditionally skipped every such
-- row, at every stage of its life (verified live). They now sync once
-- approved out of the import-review queue (pending_import_approval ->
-- pending_manager, via approve_import_batch), never before, so a
-- still-pending or later-rejected import never shows up on any spreadsheet.
--
-- sync_submission_to_sheet's payload gains two fields Apps Script needs to
-- route an uploaded lead to its own spreadsheet and show who imported it:
-- the raw `source` ('live'/'sheet' — not sent before this) and
-- `uploader_name` (resolved from profiles, same pattern as closer_name/
-- disposed_by_name below). The Apps Script side itself is edited separately,
-- outside this repo.

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

create or replace function public.notify_sheet_sync()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_request_id bigint;
  -- The approval transition itself is this row's first real sync — the
  -- equivalent of another source's INSERT. Neither of the two bail-out
  -- checks below may swallow it, or an uploaded lead would silently never
  -- sync at all (a bare pending_import_approval -> pending_manager move
  -- changes no other tracked column, and isn't 'closed' or 'parked').
  v_first_approval_sync boolean := TG_OP = 'UPDATE'
    and old.source = 'sheet'
    and old.status = 'pending_import_approval'
    and new.status <> 'pending_import_approval';
begin
  -- Still gated behind the import-approval queue: nothing sheet-sourced
  -- syncs until an admin/manager approves it out.
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
       and new.policy_number is not distinct from old.policy_number then
      return new;
    end if;
    if new.disposition is not distinct from old.disposition
       and new.archived_at is not distinct from old.archived_at
       and new.payload is not distinct from old.payload
       and new.final_carrier_id is not distinct from old.final_carrier_id
       and new.agent_name is not distinct from old.agent_name
       and new.policy_number is not distinct from old.policy_number
       and new.status <> 'closed'
       and new.status <> 'parked'
       and old.status <> 'parked' then
      return new;
    end if;
  end if;

  update public.sheet_sync_attempts
     set resolved_at = now(), resolved_status = 'superseded'
   where submission_id = new.id and resolved_at is null;

  v_request_id := public.sync_submission_to_sheet(new.id);
  if v_request_id is not null then
    insert into public.sheet_sync_attempts (submission_id, request_id, attempt_number)
    values (new.id, v_request_id, 1);
  end if;

  return new;
end;
$function$;
