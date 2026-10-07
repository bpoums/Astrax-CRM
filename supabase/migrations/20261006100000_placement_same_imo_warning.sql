-- Placement rule, revision: another carrier under the SAME IMO is a warning,
-- not a block.
--
-- Before: a carrier rejection at IMO X -> carrier C blocked carrier C under
-- every IMO AND every other carrier under IMO X.
-- Now:    only the first half blocks. Placing the customer with a different
--         carrier under IMO X is allowed, but the validator is warned and must
--         tick "I understand" to save; the warning and the tick are recorded in
--         the lead's validator_fields_set event.
--
-- Nothing live calls the changed function yet (the deployed app still uses the
-- 4-argument set_validator_fields, and placement_rule_enabled is 'false'), so
-- the 6-argument overload from 20261005100000 is dropped and replaced rather
-- than kept alongside.

-- ------------------------------------------------- the block: same carrier only

create or replace function public.placement_conflict(p_sub uuid, p_imo uuid, p_carrier uuid)
returns text
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_ssn text; r record;
begin
  if p_imo is null or p_carrier is null then return null; end if;
  if exists (select 1 from placement_overrides
             where submission_id = p_sub and imo_id = p_imo and carrier_id = p_carrier) then
    return null;
  end if;
  select ssn_normalized into v_ssn from submissions where id = p_sub;

  select d.declined_at, c.name as carrier_name, i.name as imo_name
    into r
  from carrier_declines d
  join submissions s on s.id = d.submission_id
  join carriers c on c.id = d.carrier_id
  left join imos i on i.id = d.imo_id
  where d.kind = 'carrier_rejected'
    and d.carrier_id = p_carrier
    and (s.id = p_sub or (v_ssn is not null and s.ssn_normalized = v_ssn))
  order by d.declined_at
  limit 1;

  if r.declined_at is null then return null; end if;
  return format('%s already rejected this customer%s on %s — it cannot be used again under any IMO.',
    r.carrier_name, coalesce(' via ' || r.imo_name, ''),
    to_char(r.declined_at at time zone 'Asia/Karachi', 'MM/DD/YYYY'));
end $$;

-- ------------------------------------------------- the warning: same IMO, other carrier

-- Null when there is nothing to warn about. Only a rejection that names its IMO
-- can warn: declines from before IMOs existed (imo_id null) have none.
-- Internal: not granted to clients.
create or replace function public.placement_warning(p_sub uuid, p_imo uuid, p_carrier uuid)
returns text
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_ssn text; r record;
begin
  if p_imo is null or p_carrier is null then return null; end if;
  select ssn_normalized into v_ssn from submissions where id = p_sub;

  select d.declined_at, c.name as carrier_name, i.name as imo_name
    into r
  from carrier_declines d
  join submissions s on s.id = d.submission_id
  join carriers c on c.id = d.carrier_id
  join imos i on i.id = d.imo_id
  where d.kind = 'carrier_rejected'
    and d.imo_id = p_imo
    and d.carrier_id <> p_carrier
    and (s.id = p_sub or (v_ssn is not null and s.ssn_normalized = v_ssn))
  order by d.declined_at
  limit 1;

  if r.declined_at is null then return null; end if;
  return format('%s rejected this customer via %s on %s. You are applying to a different carrier under the same IMO — confirm that is intended.',
    r.carrier_name, r.imo_name,
    to_char(r.declined_at at time zone 'Asia/Karachi', 'MM/DD/YYYY'));
end $$;

-- ------------------------------------------------- the save

drop function public.set_validator_fields(uuid, uuid, uuid, uuid, uuid, text);

-- Same chain validation and block as before, plus the same-IMO warning: with
-- p_acknowledge_warning false the save is refused with the warning's text; with
-- it true the save goes ahead and the warning is written to the event. A closed
-- lead is history being mapped, so neither the block nor the warning applies.
create or replace function public.set_validator_fields(
  p_sub uuid,
  p_agency_id uuid,
  p_imo_id uuid,
  p_final_carrier_id uuid,
  p_agent_id uuid,
  p_policy_number text,
  p_acknowledge_warning boolean default false
) returns submissions
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_role app_role := my_role();
  v_sub submissions;
  r submissions;
  v_closed boolean;
  v_link uuid;
  v_conflict text;
  v_warning text;
  v_agent_name text;
begin
  if v_role is null or v_role not in ('manager','validator','admin','general_manager') then
    raise exception 'not authorized';
  end if;
  select * into v_sub from submissions where id = p_sub;
  if v_sub.id is null or v_sub.archived_at is not null then
    raise exception 'submission not found or archived';
  end if;
  if v_role = 'validator' and v_sub.assigned_to is distinct from auth.uid() then
    raise exception 'not assigned to you';
  end if;
  v_closed := v_sub.status = 'closed';

  if p_imo_id is not null and p_agency_id is null then raise exception 'choose the agency first'; end if;
  if p_final_carrier_id is not null and p_imo_id is null then raise exception 'choose the IMO first'; end if;
  if p_agent_id is not null and p_final_carrier_id is null then raise exception 'choose the carrier first'; end if;

  if p_agency_id is not null and p_agency_id is distinct from v_sub.agency_id
     and not exists (select 1 from agencies where id = p_agency_id and active) then
    raise exception 'invalid or inactive agency';
  end if;

  if p_imo_id is not null
     and not (p_imo_id = v_sub.imo_id and p_agency_id is not distinct from v_sub.agency_id)
     and not exists (select 1 from agency_imos ai join imos i on i.id = ai.imo_id
                     where ai.agency_id = p_agency_id and ai.imo_id = p_imo_id
                       and ai.active and i.active) then
    raise exception 'that IMO is not set up under that agency';
  end if;

  if p_final_carrier_id is not null then
    select ic.id into v_link from imo_carriers ic
    where ic.imo_id = p_imo_id and ic.carrier_id = p_final_carrier_id;
    if not (p_final_carrier_id = v_sub.final_carrier_id and p_imo_id is not distinct from v_sub.imo_id)
       and not exists (select 1 from imo_carriers ic join carriers c on c.id = ic.carrier_id
                       where ic.id = v_link and ic.active and c.active) then
      raise exception 'that carrier is not set up under that IMO';
    end if;
  end if;

  if p_agent_id is not null
     and not (p_agent_id = v_sub.agent_id and p_final_carrier_id is not distinct from v_sub.final_carrier_id
              and p_imo_id is not distinct from v_sub.imo_id)
     and not exists (select 1 from agent_appointments ap join agents a on a.id = ap.agent_id
                     where ap.imo_carrier_id = v_link and ap.agent_id = p_agent_id
                       and ap.active and a.active) then
    raise exception 'that agent is not appointed with that carrier through that IMO';
  end if;

  if not v_closed then
    v_conflict := placement_conflict(p_sub, p_imo_id, p_final_carrier_id);
    if v_conflict is not null then raise exception 'Blocked: %', v_conflict; end if;

    v_warning := placement_warning(p_sub, p_imo_id, p_final_carrier_id);
    if v_warning is not null and not coalesce(p_acknowledge_warning, false) then
      raise exception 'Warning: % Tick "I understand" to continue.', v_warning;
    end if;
  end if;

  if p_agent_id is null then
    v_agent_name := v_sub.agent_name;
  elsif v_closed and nullif(btrim(coalesce(v_sub.agent_name, '')), '') is not null then
    v_agent_name := v_sub.agent_name;
  else
    select name into v_agent_name from agents where id = p_agent_id;
  end if;

  update submissions set
    agency_id = p_agency_id,
    imo_id = p_imo_id,
    final_carrier_id = p_final_carrier_id,
    agent_id = p_agent_id,
    agent_name = v_agent_name,
    policy_number = nullif(btrim(p_policy_number), '')
  where id = p_sub
  returning * into r;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'validator_fields_set',
          jsonb_build_object('by_role', v_role,
            'has_agency', p_agency_id is not null,
            'has_imo', p_imo_id is not null,
            'has_carrier', p_final_carrier_id is not null,
            'has_agent', p_agent_id is not null,
            'has_policy', nullif(btrim(p_policy_number), '') is not null,
            'placement_warning', v_warning,
            'warning_acknowledged', v_warning is not null));
  return r;
end $$;

-- ------------------------------------------------- grants

revoke execute on function public.placement_warning(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.set_validator_fields(uuid, uuid, uuid, uuid, uuid, text, boolean) from public, anon;
grant execute on function public.set_validator_fields(uuid, uuid, uuid, uuid, uuid, text, boolean) to authenticated;
