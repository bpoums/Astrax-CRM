-- Google Sheets sync was silently dropping submissions.
--
-- notify_sheet_sync() posts every relevant insert/update to Google Sheets via
-- pg_net's net.http_post(...), with no timeout_milliseconds argument — so it
-- silently used pg_net's own default of 5000ms. Checking net._http_response
-- (pg_net's own response log) showed roughly 4 in 10 recent sync attempts
-- timing out at essentially exactly 5000ms — Apps Script answering, just not
-- always inside 5 seconds — with no retry anywhere in the trigger, so a
-- timed-out sync was simply lost. This is what produced the gap between the
-- CRM's submission counts and the Google Sheet's row counts.
--
-- pg_net is asynchronous: net.http_post only queues the request and returns
-- immediately; a background worker performs the actual HTTP call. Raising the
-- timeout therefore costs nothing on the triggering transaction — it only
-- gives Apps Script more time to answer before pg_net gives up. No other
-- behavior of this function changes.

create or replace function public.notify_sheet_sync()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_url text; v_secret text; v_closer text; v_disposer text; v_final_carrier text;
begin
  if new.source = 'sheet' then return new; end if;

  -- re-fire on change to disposition/status/archive/payload OR to any of the
  -- three validator-finalized fields (which are set after submission).
  if TG_OP = 'UPDATE' then
    if new.disposition is not distinct from old.disposition
       and new.status is not distinct from old.status
       and new.archived_at is not distinct from old.archived_at
       and new.payload is not distinct from old.payload
       and new.final_carrier_id is not distinct from old.final_carrier_id
       and new.agent_name is not distinct from old.agent_name
       and new.policy_number is not distinct from old.policy_number then
      return new;
    end if;
    -- pure queue movement with no outcome/field change, still open: skip.
    --
    -- Parking and releasing are the exception. They ARE pure queue movement,
    -- but they are the two moments the sheet is otherwise wrong about: a lead
    -- inserted as pending_manager and parked a moment later would sit in the
    -- sheet claiming a manager has it, while the manager cannot see it at all.
    -- So a transition with 'parked' on either side syncs.
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

  select value into v_url from app_config where key = 'sheet_sync_url';
  select value into v_secret from app_config where key = 'sync_secret';
  if v_url is null or v_secret is null then return new; end if;

  select full_name into v_closer from profiles where id = new.closer_id;
  if new.disposed_by is not null then
    select full_name into v_disposer from profiles where id = new.disposed_by;
  end if;
  if new.final_carrier_id is not null then
    select name into v_final_carrier from carriers where id = new.final_carrier_id;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type','application/json','x-sync-secret', v_secret),
    body := jsonb_build_object(
      'id', new.id, 'payload', new.payload,
      'status', case when new.archived_at is not null then 'archived' else new.status::text end,
      'disposition', coalesce(new.disposition::text, ''),
      'submitted_at', new.created_at, 'disposed_at', new.disposed_at,
      'timeout_count', new.timeout_count, 'closer_name', v_closer,
      'disposed_by_name', v_disposer,
      'submitted_by_role', coalesce(new.submitted_by_role::text, 'closer'),
      'final_carrier', coalesce(v_final_carrier, ''),
      'agent_name', coalesce(new.agent_name, ''),
      'policy_number', coalesce(new.policy_number, ''),
      -- The two new ones. Only a closer's own live submission is Live;
      -- a validator's own form and anything uploaded are Manual.
      'center_name', coalesce(new.center_name, ''),
      'lead_source', case when new.submitted_by_role = 'closer'
                           and new.source = 'live' then 'Live' else 'Manual' end
    ),
    -- Was implicitly pg_net's 5000ms default. Apps Script does not always
    -- answer inside 5 seconds (cold starts especially), and pg_net does not
    -- retry, so a slow-but-healthy response was being thrown away as a
    -- failure. Async call, no cost to the triggering transaction either way.
    timeout_milliseconds := 20000
  );
  return new;
end
$function$;
