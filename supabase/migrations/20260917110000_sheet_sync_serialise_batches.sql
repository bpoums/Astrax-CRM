-- One batch in flight at a time.
--
-- Observed on the first live burst: a 25-row batch takes longer than the
-- one-minute cron interval, so the next tick started a SECOND batch while the
-- first was still running. SKIP LOCKED meant they never sent the same row
-- twice, but Apps Script still saw two concurrent requests - and six rows came
-- back with "apps script returned an HTML error page", the same concurrency
-- failure this whole design exists to remove. Sending one batch at a time is
-- the entire point; letting cron overlap quietly gave part of it back.
--
-- The guard is simply "is anything already in flight". resolve_sheet_syncs()
-- clears in_flight on every outcome, and has its own 10-minute fallback for a
-- request pg_net never answered, so a crashed batch cannot wedge the drain
-- permanently - it stalls for at most one resolve cycle.

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
  -- Strict serialisation: never a second batch while one is outstanding.
  if exists (
    select 1 from public.sheet_sync_queue where in_flight_request_id is not null
  ) then
    return 0;
  end if;

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
