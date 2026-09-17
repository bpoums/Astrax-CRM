-- Replaces fire-on-trigger Google Sheets sync with a durable queue drained at
-- a pace Apps Script can actually accept.
--
-- WHY. Leads were being lost, and the loss grew with concurrency. Measured on
-- this project: firing N syncs at once failed ~20% of the time at N=5, ~30% at
-- N=20 and ~61% at N=59. Thirteen leads had never reached Sheets at all, four
-- of them completed sales. With ~100 closers and validators submitting at once
-- this becomes routine data loss.
--
-- Three compounding causes, all verified against the live system:
--
--   1. Google rejects concurrent requests to an Apps Script web app - as 404s,
--      or as HTTP 200 carrying an HTML error page. The script also serialises
--      itself on lock.waitLock(30000), so it can only ever do one write at a
--      time regardless.
--   2. notify_sheet_sync() fired its own net.http_post per row, so N
--      submissions produced N simultaneous requests. pg_net batches its
--      dispatch, so this cannot be paced from SQL: pg_sleep between calls does
--      nothing, because the background worker collects whatever has been queued
--      and fires it together.
--   3. retry_failed_sheet_syncs() gave up permanently after 3 attempts, and
--      retried by looping over every pending attempt firing each one - which
--      recreated the very burst that caused the failure. Nothing surfaced
--      'gave_up' to a human.
--
-- WHAT CHANGES. The trigger stops making HTTP calls and enqueues instead. A
-- cron job drains the queue in bounded batches through the sheet-sync edge
-- function, which walks each batch sequentially so Apps Script sees exactly one
-- request at a time. Failures back off exponentially and are never abandoned.
--
-- The Apps Script contract is untouched: the per-row body below is byte-for-byte
-- what sync_submission_to_sheet() already sent. Its deployment belongs to
-- someone else and cannot be changed by us.
--
-- REVERTING is one statement - point notify_sheet_sync back at
-- sync_submission_to_sheet, which is deliberately left in place and unmodified.

-- 1. The queue -------------------------------------------------------------
--
-- submission_id is the PRIMARY KEY, and that is load-bearing rather than
-- incidental: a lead whose status changes four times before the drain runs
-- collapses into ONE row and ONE write carrying the final state, instead of
-- four separate syncs racing each other. Under load that dedup removes a large
-- share of the traffic on its own.

create table if not exists public.sheet_sync_queue (
  submission_id uuid primary key references public.submissions(id) on delete cascade,
  enqueued_at timestamptz not null default now(),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  -- The pg_net request currently carrying this row, or null when idle. Set by
  -- the drain, cleared by the resolve.
  in_flight_request_id bigint,
  last_error text
);

create index if not exists sheet_sync_queue_ready_idx
  on public.sheet_sync_queue (next_attempt_at)
  where in_flight_request_id is null;

-- Internal plumbing, never read by the browser. RLS on with no policies means
-- no client can reach it at all, the same posture as sheet_sync_attempts.
alter table public.sheet_sync_queue enable row level security;

comment on table public.sheet_sync_queue is
  'Outbound Google Sheets sync queue. One row per submission awaiting a write; '
  'the primary key deduplicates repeated status changes into a single write.';

-- 2. The trigger now enqueues ----------------------------------------------
--
-- Every decision about WHETHER to sync is unchanged - the import-approval gate,
-- the "nothing meaningful changed" checks, the first-approval special case.
-- Only the action changes, from an HTTP call to an upsert. No HTTP in a
-- trigger means a submission can never be slowed down, or fail, because Google
-- is having a bad minute.

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
  -- A lead still inside the import gate belongs to Pending Imports and nowhere
  -- else; it syncs on approval, not before.
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

  -- Already queued: refresh it so the drain sends current state, and pull the
  -- next attempt forward - a fresh change should not wait out a backoff earned
  -- by an older one. attempts is deliberately NOT reset, so a row that keeps
  -- failing keeps backing off rather than hammering on every edit.
  insert into public.sheet_sync_queue (submission_id)
  values (new.id)
  on conflict (submission_id) do update
    set enqueued_at = now(),
        next_attempt_at = least(public.sheet_sync_queue.next_attempt_at, now());

  return new;
end;
$function$;

-- 3. The body one row sends ------------------------------------------------
--
-- Extracted from sync_submission_to_sheet() so the queue and the old direct
-- path cannot drift about what a row looks like. Returns null when the
-- submission is gone.

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
    -- Already a final carrier, just stored in the payload instead of the FK.
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
    'center_name', coalesce(s.center_name, ''),
    'lead_source', case when s.submitted_by_role = 'closer'
                         and s.source = 'live' then 'Live' else 'Manual' end,
    'source', s.source::text,
    'uploader_name', coalesce(v_uploader, '')
  );
end;
$function$;

-- 4. Drain -----------------------------------------------------------------
--
-- Bounded concurrency is the entire point: ONE net.http_post carrying up to
-- p_limit rows, never p_limit requests. The edge function then walks them
-- sequentially, so Apps Script never sees two at once.
--
-- FOR UPDATE SKIP LOCKED makes overlapping cron runs safe - a second run picks
-- up different rows rather than re-sending the first run's.

create or replace function public.drain_sheet_sync_queue(p_limit int default 25)
returns int
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_url text; v_secret text;
  v_ids uuid[];
  v_rows jsonb;
  v_request_id bigint;
begin
  select value into v_url from public.app_config where key = 'sheet_sync_url';
  select value into v_secret from public.app_config where key = 'sync_secret';
  if v_url is null or v_secret is null then return 0; end if;

  with ready as (
    select q.submission_id
      from public.sheet_sync_queue q
     where q.in_flight_request_id is null
       and q.next_attempt_at <= now()
     order by q.enqueued_at
     limit p_limit
     for update skip locked
  )
  select array_agg(submission_id) into v_ids from ready;

  if v_ids is null or cardinality(v_ids) = 0 then return 0; end if;

  -- A row whose submission has since been deleted yields null and is dropped
  -- here rather than being sent as a null and failing downstream.
  select jsonb_agg(r) into v_rows
    from unnest(v_ids) as t(id),
         lateral public.sheet_sync_row(t.id) as r
   where r is not null;

  if v_rows is null then
    delete from public.sheet_sync_queue where submission_id = any(v_ids);
    return 0;
  end if;

  -- Generous timeout: the edge function is deliberately sequential, so a
  -- 25-row batch is ~25 Apps Script round trips end to end. Too short a
  -- timeout would abandon a batch that is still working and duplicate it.
  select net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type','application/json','x-sync-secret', v_secret),
    body := jsonb_build_object('rows', v_rows),
    timeout_milliseconds := 120000
  ) into v_request_id;

  update public.sheet_sync_queue
     set in_flight_request_id = v_request_id
   where submission_id = any(v_ids);

  return cardinality(v_ids);
end;
$function$;

-- 5. Resolve ---------------------------------------------------------------
--
-- Reads back what the drain sent. The critical property: a row is only ever
-- DELETED on confirmed success. Anything else goes back in the queue with a
-- longer wait. There is no give-up path, because a permanently abandoned row is
-- exactly the silent data loss this migration exists to end - a row that keeps
-- failing stays visible in the queue instead.

create or replace function public.resolve_sheet_syncs()
returns int
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  n int := 0;
  r record;
  v_ok boolean;
  v_err text;
begin
  for r in
    select q.submission_id, q.in_flight_request_id, q.attempts,
           resp.status_code, resp.content
      from public.sheet_sync_queue q
      join net._http_response resp on resp.id = q.in_flight_request_id
     where q.in_flight_request_id is not null
  loop
    v_ok := false;
    v_err := null;

    if r.status_code = 200 and r.content is not null then
      -- Per-row outcome from the batch response, so one bad row in a batch of
      -- 25 retries one row rather than all 25.
      select (elem->>'ok')::boolean, elem->>'error'
        into v_ok, v_err
        from jsonb_array_elements((r.content::jsonb)->'results') as elem
       where elem->>'submission_id' = r.submission_id::text
       limit 1;

      if v_ok is null then
        v_ok := false;
        v_err := 'row missing from batch response';
      end if;
    else
      v_err := coalesce('http ' || r.status_code::text, 'no response');
    end if;

    if v_ok then
      delete from public.sheet_sync_queue where submission_id = r.submission_id;
      n := n + 1;
    else
      -- 30s, 1m, 2m, 4m, 8m, 16m, 32m, then hourly forever.
      update public.sheet_sync_queue
         set in_flight_request_id = null,
             attempts = attempts + 1,
             last_error = v_err,
             next_attempt_at = now()
               + least(interval '1 hour',
                       interval '30 seconds' * power(2, least(attempts, 7))::int)
       where submission_id = r.submission_id;
    end if;
  end loop;

  -- A request pg_net never answered at all (worker restart, row aged out of
  -- net._http_response). Without this the row would sit in flight forever.
  update public.sheet_sync_queue
     set in_flight_request_id = null,
         attempts = attempts + 1,
         last_error = 'no response recorded',
         next_attempt_at = now() + interval '2 minutes'
   where in_flight_request_id is not null
     and enqueued_at < now() - interval '10 minutes'
     and not exists (
       select 1 from net._http_response resp
        where resp.id = sheet_sync_queue.in_flight_request_id
     );

  return n;
end;
$function$;

-- 6. Backlog, visible ------------------------------------------------------
--
-- A queue nobody watches is the same failure as a silent drop. security_invoker
-- is off (the default) so an admin screen can read it without needing RLS on
-- the queue table itself; it exposes counts only, never lead data.

create or replace view public.sheet_sync_backlog as
select
  count(*) as queued,
  count(*) filter (where in_flight_request_id is not null) as in_flight,
  count(*) filter (where attempts >= 5) as struggling,
  coalesce(max(extract(epoch from now() - enqueued_at))::int, 0) as oldest_seconds,
  max(last_error) filter (where attempts >= 5) as sample_error
from public.sheet_sync_queue;

grant select on public.sheet_sync_backlog to authenticated;

-- 7. Schedule --------------------------------------------------------------
--
-- The old retry is replaced wholesale: it gave up after three attempts and
-- burst on retry. sync_submission_to_sheet() and retry_failed_sheet_syncs()
-- are both left defined, so reverting means re-pointing the trigger rather
-- than restoring anything.

select cron.unschedule('retry-sheet-sync')
 where exists (select 1 from cron.job where jobname = 'retry-sheet-sync');

select cron.schedule(
  'drain-sheet-sync',
  '* * * * *',
  $$select public.drain_sheet_sync_queue(25)$$
);

select cron.schedule(
  'resolve-sheet-sync',
  '* * * * *',
  $$select public.resolve_sheet_syncs()$$
);

-- 8. Backfill --------------------------------------------------------------
--
-- The leads that never reached Sheets under the old path. They drain like
-- anything else now, and unlike before they cannot be abandoned. Excludes rows
-- still inside the import gate, which are not due to sync yet.

insert into public.sheet_sync_queue (submission_id)
select s.id
  from public.submissions s
 where not (s.source = 'sheet' and s.status = 'pending_import_approval')
   and exists (
     select 1 from public.sheet_sync_attempts a where a.submission_id = s.id
   )
   and not exists (
     select 1 from public.sheet_sync_attempts a
      where a.submission_id = s.id and a.resolved_status = 'ok'
   )
on conflict (submission_id) do nothing;
