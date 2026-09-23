-- External transfer clients.
--
-- A closer who presses "External Transfer" parks a lead instead of sending it
-- to the manager's queue. Until now nothing recorded WHO the lead was
-- transferred to, so Parked Leads was one undifferentiated list. This adds the
-- client: an admin-managed vocabulary table, a required argument on
-- submit_form_parked, and two stamped columns on submissions.
--
-- The client deliberately does NOT go in submissions.payload. payload is what
-- the sheet-sync trigger pushes to Google Sheets, so a new key there becomes a
-- new Sheet column. center_id/center_name set the precedent this follows.

-- ---------------------------------------------------------------------------
-- The vocabulary table, modelled on centers/carriers.
-- ---------------------------------------------------------------------------

create table if not exists public.transfer_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

alter table public.transfer_clients enable row level security;

-- `(select my_role())` and not a bare call: a bare one is evaluated per
-- candidate row, the subquery is an InitPlan evaluated once per query.
drop policy if exists "admin manages transfer clients" on public.transfer_clients;
create policy "admin manages transfer clients"
  on public.transfer_clients
  for all
  using ((select my_role()) = 'admin')
  with check ((select my_role()) = 'admin');

-- Every role reads it, the same list `carriers readable` uses. A closer has to
-- be able to read it to pick one.
drop policy if exists "transfer clients readable" on public.transfer_clients;
create policy "transfer clients readable"
  on public.transfer_clients
  for select
  using (
    (select my_role()) = any (array[
      'admin'::app_role, 'manager'::app_role, 'closing_manager'::app_role,
      'general_manager'::app_role, 'validator'::app_role, 'cxm'::app_role,
      'cxa'::app_role, 'data_uploader'::app_role, 'closer'::app_role
    ])
  );

-- ---------------------------------------------------------------------------
-- The link on the lead.
-- ---------------------------------------------------------------------------

-- transfer_client_name is the name AS IT STOOD when the lead was parked,
-- stamped the way center_name is, so renaming a client never rewrites what
-- history says about leads already transferred.
alter table public.submissions
  add column if not exists transfer_client_id uuid references public.transfer_clients(id),
  add column if not exists transfer_client_name text;

-- Parked Leads is the only screen that filters on it, and it always does so
-- alongside status = 'parked'.
create index if not exists submissions_transfer_client_parked_idx
  on public.submissions (transfer_client_id)
  where status = 'parked';

-- ---------------------------------------------------------------------------
-- Parking now requires a client.
-- ---------------------------------------------------------------------------

-- The one-argument version is dropped rather than kept alongside: leaving it
-- would be a way to park with no client at all, which is exactly what this
-- migration exists to stop.
drop function if exists public.submit_form_parked(jsonb);

create or replace function public.submit_form_parked(p_payload jsonb, p_client uuid)
returns submissions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r submissions;
  v_client_name text;
begin
  r := public.submit_form_internal(p_payload, 'parked'::sub_status);

  -- A validator's own submission auto-accepts and closes; there is nothing to
  -- park and therefore no client to name.
  if r.submitted_by_role = 'validator' then
    return r;
  end if;

  if p_client is null then
    raise exception 'select a client to transfer to';
  end if;

  select name into v_client_name
  from transfer_clients
  where id = p_client and active;

  if v_client_name is null then
    raise exception 'client is not available';
  end if;

  update submissions
     set transfer_client_id = p_client,
         transfer_client_name = v_client_name
   where id = r.id
  returning * into r;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (
    r.id, auth.uid(), 'parked',
    jsonb_build_object('via', 'external_transfer', 'client', v_client_name)
  );

  return r;
end;
$function$;

-- Both, and in this order. Revoking from `anon` alone leaves the blanket
-- PUBLIC grant, which anon inherits; revoking from `public` alone leaves
-- Supabase's own direct grant to anon. `authenticated` keeps its explicit
-- grant either way, which is the only one the app needs.
revoke execute on function public.submit_form_parked(jsonb, uuid) from public;
revoke execute on function public.submit_form_parked(jsonb, uuid) from anon;

-- ---------------------------------------------------------------------------
-- The closer sees which client their own lead went to.
-- ---------------------------------------------------------------------------

-- Return type changes, so the function has to go first. The payload stripping
-- is unchanged — those keys are removed in SQL so no client code path can leak
-- one onto the Forwarded Leads screen.
drop function if exists public.my_forwarded_leads();

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
  transfer_client_name text,
  payload jsonb
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    s.id,
    s.created_at,
    s.status,
    s.disposition,
    s.disposed_at,
    s.timeout_count,
    s.hold_count,
    s.rejection_count,
    s.transfer_client_name,
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
$function$;

revoke execute on function public.my_forwarded_leads() from public;
revoke execute on function public.my_forwarded_leads() from anon;

-- ---------------------------------------------------------------------------
-- Tab counts for Parked Leads.
-- ---------------------------------------------------------------------------

-- The table is paginated, so the per-client counts cannot be derived from the
-- rows on screen. Guards are written `is distinct from` deliberately: a NULL
-- role (no profile, no JWT, or a deactivated one) makes `<>` return NULL, not
-- true, and the function would answer a caller it should refuse.
create or replace function public.parked_client_counts()
returns table (client_id uuid, client_name text, lead_count bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if my_role() is distinct from 'admin' and my_role() is distinct from 'general_manager' then
    raise exception 'not authorized';
  end if;

  return query
  select s.transfer_client_id, s.transfer_client_name, count(*)
  from submissions s
  where s.status = 'parked'
    and s.archived_at is null
  group by s.transfer_client_id, s.transfer_client_name
  -- Leads with no client sort last, under "No client".
  order by (s.transfer_client_id is null), s.transfer_client_name;
end;
$function$;

revoke execute on function public.parked_client_counts() from public;
revoke execute on function public.parked_client_counts() from anon;
