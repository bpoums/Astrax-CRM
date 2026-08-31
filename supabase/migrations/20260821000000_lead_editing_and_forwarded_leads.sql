-- Manager/admin lead editing, and the closer's view of their own forwarded leads.
--
-- Three changes, all of them server-side because none of them can be done
-- honestly from the browser:
--
--   1. update_submission_payload — the write path behind "edit this lead".
--      Until now the client updated submissions.payload directly, but there is
--      no UPDATE policy on that table, so every one of those writes matched
--      zero rows and returned no error. The data-flag correction flow was
--      therefore clearing flags without ever fixing the value behind them.
--
--   2. my_forwarded_leads — a closer cannot read submissions at all under the
--      current SELECT policy (ELSE false). This hands them their own leads with
--      the SSN, routing and account numbers stripped in the database, so the
--      redaction is real rather than a browser-side courtesy.
--
--   3. notify_sheet_sync — a payload-only edit changed no status, so the sheet
--      kept the wrong value for good. It now re-pushes on a payload change.

-- 1 -------------------------------------------------------------------------

create or replace function public.update_submission_payload(p_sub uuid, p_patch jsonb)
returns submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  r submissions;
  v_old jsonb;
  v_patch jsonb;
  v_changed text[];
begin
  if my_role() not in ('manager', 'admin') then
    raise exception 'Only a manager or an admin may edit a lead.';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'A payload object is required.';
  end if;

  select payload into v_old from submissions where id = p_sub;
  if not found then
    raise exception 'submission not found';
  end if;

  -- submit_form stamps these; they say who entered the lead, not what it says,
  -- so an edit may never rewrite them.
  v_patch := p_patch - 'ID' - 'Submitted By Role';

  select coalesce(array_agg(k order by k), '{}'::text[])
    into v_changed
  from jsonb_object_keys(v_patch) k
  where v_old -> k is distinct from v_patch -> k;

  -- Nothing actually differs. Return without logging an edit that did not
  -- happen, and without waking the sheet-sync trigger.
  if array_length(v_changed, 1) is null then
    select * into r from submissions where id = p_sub;
    return r;
  end if;

  -- A merge, not a replace: two managers editing different fields of the same
  -- lead do not overwrite each other, and no key can be dropped by omission.
  update submissions
     set payload = payload || v_patch
   where id = p_sub
  returning * into r;

  -- Field names only. The values are what we are protecting, so they do not go
  -- into an event detail that the whole reporting timeline renders.
  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'payload_edited', jsonb_build_object('fields', to_jsonb(v_changed)));

  return r;
end
$$;

grant execute on function public.update_submission_payload(uuid, jsonb) to authenticated;

-- 2 -------------------------------------------------------------------------

create or replace function public.my_forwarded_leads()
returns table (
  id uuid,
  created_at timestamptz,
  status sub_status,
  disposition disposition_t,
  disposed_at timestamptz,
  timeout_count integer,
  hold_count integer,
  rejection_count integer,
  payload jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    s.created_at,
    s.status,
    s.disposition,
    s.disposed_at,
    s.timeout_count,
    s.hold_count,
    s.rejection_count,
    -- Stripped here, in the database. The closer typed these values, but the
    -- forwarded-leads screen is a lookup tool and has no business handing them
    -- back out. The card keys are not on the closer form; they are removed
    -- anyway so a validator-entered lead can never leak one through this path.
    s.payload
      - 'SSN Number'
      - 'Routing Number'
      - 'Account Number'
      - 'Card Number'
      - 'CVC'
      - 'CVV'
      - 'Exp Date'
  from submissions s
  where s.closer_id = auth.uid()
    and s.archived_at is null
  order by s.created_at desc
$$;

grant execute on function public.my_forwarded_leads() to authenticated;

-- 3 -------------------------------------------------------------------------

create or replace function public.notify_sheet_sync()
returns trigger
language plpgsql
security definer
-- Preserved verbatim from the original definition: net.http_post is resolved
-- through this search_path, and dropping 'extensions' silently breaks the sync.
set search_path = public, extensions
as $$
declare
  v_url text; v_secret text; v_closer text; v_disposer text;
begin
  if new.source = 'sheet' then
    return new;
  end if;

  -- A corrected payload always syncs: the whole point of the edit is that the
  -- spreadsheet currently holds a wrong value. Everything below this guard is
  -- the original status/disposition logic, unchanged.
  if TG_OP = 'UPDATE' and new.payload is not distinct from old.payload then
    if new.disposition is not distinct from old.disposition
       and new.status is not distinct from old.status
       and new.archived_at is not distinct from old.archived_at then
      return new;
    end if;
    if new.disposition is not distinct from old.disposition
       and new.archived_at is not distinct from old.archived_at
       and new.status <> 'closed' then
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
      'submitted_by_role', coalesce(new.submitted_by_role::text, 'closer')
    )
  );
  return new;
end
$$;
