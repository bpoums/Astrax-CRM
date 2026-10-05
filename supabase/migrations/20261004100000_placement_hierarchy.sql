-- Placement hierarchy, phase 1: Agency -> IMO -> Carrier -> Agent.
--
-- Vocabulary and mapping only. Nothing here changes how a lead is validated,
-- accepted or declined; phase 2 (placement_rule) switches that on once the
-- admin has filled these lists in. The three new submissions columns are
-- nullable and start empty on every existing row.
--
-- Every link is many-to-many: one carrier is contracted through several IMOs,
-- and an agent's appointment belongs to one IMO->Carrier contract, not to the
-- carrier in general.
--
-- Writes go through two admin-only SECURITY DEFINER RPCs. There are no write
-- policies, and the table-level write grants Supabase hands anon/authenticated
-- by default are revoked (RLS does not cover TRUNCATE). No delete: rows are
-- deactivated, so leads that point at them keep resolving.

-- ---------------------------------------------------------------- lists

create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);
create unique index agencies_name_key on public.agencies (lower(btrim(name)));

create table public.imos (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);
create unique index imos_name_key on public.imos (lower(btrim(name)));

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  npn text,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);
create unique index agents_name_key on public.agents (lower(btrim(name)));

-- ---------------------------------------------------------------- links

create table public.agency_imos (
  agency_id uuid not null references public.agencies (id),
  imo_id uuid not null references public.imos (id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (agency_id, imo_id)
);
create index agency_imos_imo_idx on public.agency_imos (imo_id);

create table public.imo_carriers (
  id uuid primary key default gen_random_uuid(),
  imo_id uuid not null references public.imos (id),
  carrier_id uuid not null references public.carriers (id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (imo_id, carrier_id)
);
create index imo_carriers_carrier_idx on public.imo_carriers (carrier_id);

create table public.agent_appointments (
  agent_id uuid not null references public.agents (id),
  imo_carrier_id uuid not null references public.imo_carriers (id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (agent_id, imo_carrier_id)
);
create index agent_appointments_link_idx on public.agent_appointments (imo_carrier_id);

-- ------------------------------------------------- submissions columns

alter table public.submissions
  add column agency_id uuid references public.agencies (id),
  add column imo_id uuid references public.imos (id),
  add column agent_id uuid references public.agents (id);

create index submissions_agency_id_idx on public.submissions (agency_id) where agency_id is not null;
create index submissions_imo_id_idx on public.submissions (imo_id) where imo_id is not null;
create index submissions_agent_id_idx on public.submissions (agent_id) where agent_id is not null;

-- ---------------------------------------------------------------- RLS

do $$
declare t text;
begin
  foreach t in array array['agencies','imos','agents','agency_imos','imo_carriers','agent_appointments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format($p$
      create policy "%s readable" on public.%I for select using (
        (select my_role()) = any (array['admin','manager','closing_manager','general_manager',
          'validator','cxm','cxa','data_uploader','closer','reporting_manager']::app_role[])
      )$p$, t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------- RPCs

-- Add (p_id null) or edit an agency, IMO or agent. Omitted arguments keep
-- their current value on edit.
create or replace function public.placement_upsert_item(
  p_kind text,
  p_id uuid default null,
  p_name text default null,
  p_active boolean default null,
  p_sort_order integer default null,
  p_npn text default null
) returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_table text;
  v_id uuid;
  v_old jsonb;
  v_new jsonb;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if my_role() is distinct from 'admin' then raise exception 'not authorized'; end if;

  v_table := case p_kind when 'agency' then 'agencies' when 'imo' then 'imos'
                         when 'agent' then 'agents' end;
  if v_table is null then raise exception 'unknown list %', p_kind; end if;
  if p_npn is not null and p_kind <> 'agent' then
    raise exception 'only agents have an NPN';
  end if;

  if p_id is null then
    if v_name is null then raise exception 'a name is required'; end if;
    execute format(
      'insert into public.%I (name, active, sort_order) values ($1, coalesce($2, true),
         coalesce($3, (select coalesce(max(sort_order), 0) + 10 from public.%I)))
       returning id', v_table, v_table)
      into v_id using v_name, p_active, p_sort_order;
    if p_kind = 'agent' then
      update agents set npn = nullif(btrim(p_npn), '') where id = v_id;
    end if;
  else
    execute format('select to_jsonb(t) from public.%I t where id = $1', v_table)
      into v_old using p_id;
    if v_old is null then raise exception '% not found', p_kind; end if;
    if p_name is not null and v_name is null then raise exception 'a name is required'; end if;
    execute format(
      'update public.%I set name = coalesce($2, name), active = coalesce($3, active),
         sort_order = coalesce($4, sort_order) where id = $1', v_table)
      using p_id, v_name, p_active, p_sort_order;
    if p_kind = 'agent' and p_npn is not null then
      update agents set npn = nullif(btrim(p_npn), '') where id = p_id;
    end if;
    v_id := p_id;
  end if;

  execute format('select to_jsonb(t) from public.%I t where id = $1', v_table)
    into v_new using v_id;
  insert into settings_audit (actor_id, key, old_value, new_value)
  values (auth.uid(), 'placement.' || p_kind || ':' || v_id, v_old::text, v_new::text);
  return v_id;
exception when unique_violation then
  raise exception 'a % named "%" already exists', p_kind, v_name;
end $$;

-- Turn one link on or off, creating it the first time.
--   agency_imo:        parent = agency,            child = IMO
--   imo_carrier:       parent = IMO,               child = carrier
--   agent_appointment: parent = imo_carriers.id,   child = agent
create or replace function public.placement_set_link(
  p_kind text,
  p_parent uuid,
  p_child uuid,
  p_active boolean
) returns void
language plpgsql security definer set search_path to 'public'
as $$
declare v_old boolean;
begin
  if my_role() is distinct from 'admin' then raise exception 'not authorized'; end if;
  if p_parent is null or p_child is null or p_active is null then
    raise exception 'parent, child and active are required';
  end if;

  if p_kind = 'agency_imo' then
    select active into v_old from agency_imos where agency_id = p_parent and imo_id = p_child;
    insert into agency_imos (agency_id, imo_id, active) values (p_parent, p_child, p_active)
    on conflict (agency_id, imo_id) do update set active = excluded.active;
  elsif p_kind = 'imo_carrier' then
    select active into v_old from imo_carriers where imo_id = p_parent and carrier_id = p_child;
    insert into imo_carriers (imo_id, carrier_id, active) values (p_parent, p_child, p_active)
    on conflict (imo_id, carrier_id) do update set active = excluded.active;
  elsif p_kind = 'agent_appointment' then
    select active into v_old from agent_appointments
      where imo_carrier_id = p_parent and agent_id = p_child;
    insert into agent_appointments (imo_carrier_id, agent_id, active)
      values (p_parent, p_child, p_active)
    on conflict (agent_id, imo_carrier_id) do update set active = excluded.active;
  else
    raise exception 'unknown link %', p_kind;
  end if;

  insert into settings_audit (actor_id, key, old_value, new_value)
  values (auth.uid(), 'placement.' || p_kind || ':' || p_parent || ':' || p_child,
          v_old::text, p_active::text);
exception when foreign_key_violation then
  raise exception 'that % link points at something that does not exist', p_kind;
end $$;

revoke execute on function public.placement_upsert_item(text, uuid, text, boolean, integer, text) from public, anon;
revoke execute on function public.placement_set_link(text, uuid, uuid, boolean) from public, anon;
grant execute on function public.placement_upsert_item(text, uuid, text, boolean, integer, text) to authenticated;
grant execute on function public.placement_set_link(text, uuid, uuid, boolean) to authenticated;
