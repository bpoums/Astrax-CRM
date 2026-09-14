-- Retry logic for the Google Sheets sync.
--
-- notify_sheet_sync() posts to the sheet-sync Edge Function, which itself
-- calls out to Apps Script with no timeout of its own. Apps Script holds a
-- lock for up to 30 seconds under concurrent submissions, so a burst of
-- near-simultaneous leads can queue up behind that lock and exceed even a
-- generous Postgres-side timeout. Until now a timed-out sync was simply
-- lost, with nothing recorded anywhere that it happened.
--
-- Retrying is safe: the Apps Script doPost handler upserts by "Submission
-- ID" (looks for an existing row with a matching id and updates it in
-- place, only appending if none is found), confirmed from its actual
-- deployed source. Re-sending the same submission can never create a
-- duplicate row.
--
-- Three pieces:
--   1. sync_submission_to_sheet(p_sub) — the network call, extracted out of
--      the trigger so both the trigger and the retry job can call the same
--      logic. Timeout raised to 45000ms (from the 20000ms just applied),
--      informed by the newly-confirmed 30s Apps Script lock.
--   2. sheet_sync_attempts — one row per sync attempt, so a retry job has
--      something to check back on. Internal bookkeeping only; RLS enabled,
--      no policies, same as app_config.
--   3. retry_failed_sheet_syncs() + a new pg_cron job — resolves attempts
--      that succeeded, retries ones still unresolved after a grace period
--      (up to 3 attempts total), gives up after that rather than retrying
--      forever.

-- 1 -------------------------------------------------------------------------

create table if not exists public.sheet_sync_attempts (
  id bigserial primary key,
  submission_id uuid not null references public.submissions(id),
  request_id bigint,
  attempt_number int not null default 1,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_status text
);

create index if not exists sheet_sync_attempts_submission_id_idx
  on public.sheet_sync_attempts (submission_id);

create index if not exists sheet_sync_attempts_unresolved_idx
  on public.sheet_sync_attempts (created_at)
  where resolved_at is null;

alter table public.sheet_sync_attempts enable row level security;
-- No policies: internal bookkeeping, never read or written by the client.

-- 2 -------------------------------------------------------------------------

create or replace function public.sync_submission_to_sheet(p_sub uuid)
returns bigint
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  s public.submissions;
  v_url text; v_secret text; v_closer text; v_disposer text; v_final_carrier text;
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
                           and s.source = 'live' then 'Live' else 'Manual' end
    ),
    timeout_milliseconds := 45000
  ) into v_request_id;

  return v_request_id;
end;
$function$;

-- 3 -------------------------------------------------------------------------

create or replace function public.notify_sheet_sync()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_request_id bigint;
begin
  if new.source = 'sheet' then return new; end if;

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

  -- Superseded by this newer event before it has ever been chased, so the
  -- retry job never chases a stale state once a fresher one exists.
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

-- 4 -------------------------------------------------------------------------

create or replace function public.retry_failed_sheet_syncs()
returns integer
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  n int := 0;
  r record;
  v_request_id bigint;
begin
  -- Resolve anything whose response has come back OK.
  update public.sheet_sync_attempts a
     set resolved_at = now(), resolved_status = 'ok'
   where a.resolved_at is null
     and a.request_id is not null
     and exists (
       select 1 from net._http_response resp
        where resp.id = a.request_id and resp.status_code = 200
     );

  -- Retry anything still unresolved after a grace period, up to 3 attempts.
  for r in
    select a.id, a.submission_id, a.attempt_number
      from public.sheet_sync_attempts a
     where a.resolved_at is null
       and a.created_at < now() - interval '3 minutes'
       and a.attempt_number < 3
  loop
    v_request_id := public.sync_submission_to_sheet(r.submission_id);
    if v_request_id is not null then
      insert into public.sheet_sync_attempts (submission_id, request_id, attempt_number)
      values (r.submission_id, v_request_id, r.attempt_number + 1);
      n := n + 1;
    end if;
    update public.sheet_sync_attempts
       set resolved_at = now(), resolved_status = 'retried'
     where id = r.id;
  end loop;

  -- Give up on anything that has exhausted its retries.
  update public.sheet_sync_attempts
     set resolved_at = now(), resolved_status = 'gave_up'
   where resolved_at is null
     and attempt_number >= 3
     and created_at < now() - interval '3 minutes';

  return n;
end;
$function$;

-- 5 -------------------------------------------------------------------------

select cron.schedule(
  'retry-sheet-sync',
  '*/5 * * * *',
  $$select public.retry_failed_sheet_syncs()$$
);
