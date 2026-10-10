-- Transfer clients belong to a center.
--
-- An external client (Orbit Insurance, Top Dawg Financial Group) is linked to
-- the center whose closers hand leads to it. NULL means "offered to every
-- center", which keeps a client usable until someone links it. The Overview then
-- shows each client under its center, and External Transfer offers a closer only
-- the clients of their own center — enforced in submit_form_parked below, not
-- just in the dialog.
alter table public.transfer_clients
  add column if not exists center_id uuid references public.centers (id);

comment on column public.transfer_clients.center_id is
  'The center whose closers may transfer to this client. NULL = offered to every center.';

-- Both existing clients are UMS BPO's.
update public.transfer_clients
   set center_id = (select id from public.centers where name = 'UMS BPO')
 where center_id is null;

-- Leads still parked with each client, per center, for a period. Grouped by the
-- LEAD's center (the one its closer's row is counted under in the Live column),
-- so a client's number is always a subset of that center's live total and
-- "In House = live - clients" cannot go negative. `created_at` windowed through
-- reporting_window(), like every _range RPC. Leads with no client are not listed.
create or replace function public.parked_client_counts_range(
  p_days integer default null,
  p_start_date date default null,
  p_end_date date default null
)
returns table (center_id uuid, client_id uuid, client_name text, lead_count bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if my_role() is distinct from 'admin' and my_role() is distinct from 'general_manager' then
    raise exception 'not authorized';
  end if;

  return query
  with b as (select * from reporting_window(p_days, p_start_date, p_end_date))
  select s.center_id, s.transfer_client_id, tc.name, count(*)
  from submissions s
  cross join b
  join transfer_clients tc on tc.id = s.transfer_client_id
  where s.status = 'parked'
    and s.archived_at is null
    and (b.since is null or s.created_at >= b.since)
    and (b.until is null or s.created_at < b.until)
  group by s.center_id, s.transfer_client_id, tc.name, tc.sort_order
  order by tc.sort_order, tc.name;
end;
$$;

revoke execute on function public.parked_client_counts_range(integer, date, date) from public, anon;
grant execute on function public.parked_client_counts_range(integer, date, date) to authenticated;

-- Server-side half of "closers are offered only their own center's clients".
create or replace function public.submit_form_parked(p_payload jsonb, p_client uuid)
returns submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  r submissions;
  v_client_name text;
  v_client_center uuid;
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

  select name, center_id into v_client_name, v_client_center
  from transfer_clients
  where id = p_client and active;

  if v_client_name is null then
    raise exception 'client is not available';
  end if;

  -- A client linked to a center is that center's alone. Raising here aborts the
  -- whole call, including the row submit_form_internal just inserted.
  if v_client_center is not null and r.center_id is distinct from v_client_center then
    raise exception 'client is not available for your center';
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
$$;
