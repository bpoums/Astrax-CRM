-- Agents are a standalone list: no longer appointed per IMO -> carrier contract.
-- Only agency -> IMO -> carrier follows the placement rule. agent_appointments
-- was empty when this ran, so nothing is lost by dropping it.

create or replace function public.set_validator_fields(
  p_sub uuid, p_agency_id uuid, p_imo_id uuid, p_final_carrier_id uuid,
  p_agent_id uuid, p_policy_number text, p_acknowledge_warning boolean default false)
returns submissions
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Agents are independent of the chain: any active agent, or the one the lead
  -- already holds (so a since-retired agent does not block re-saving the lead).
  if p_agent_id is not null and p_agent_id is distinct from v_sub.agent_id
     and not exists (select 1 from agents where id = p_agent_id and active) then
    raise exception 'invalid or inactive agent';
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
end $function$;

create or replace function public.placement_set_link(
  p_kind text, p_parent uuid, p_child uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  else
    raise exception 'unknown link %', p_kind;
  end if;

  insert into settings_audit (actor_id, key, old_value, new_value)
  values (auth.uid(), 'placement.' || p_kind || ':' || p_parent || ':' || p_child,
          v_old::text, p_active::text);
exception when foreign_key_violation then
  raise exception 'that % link points at something that does not exist', p_kind;
end $function$;

drop table if exists public.agent_appointments;
