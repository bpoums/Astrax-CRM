-- CX roles may correct the three things a validator filled in on a lead they
-- are servicing: final carrier, agent name, policy number.
--
-- Deliberately separate from set_validator_fields: that RPC walks the
-- Agency -> IMO -> Carrier -> Agent chain and the placement rule, which CX
-- does not use. This one writes only the three columns and leaves
-- agency_id / imo_id / agent_id untouched.

create or replace function public.cx_set_placement_fields(
  p_sub uuid,
  p_agent_name text,
  p_policy_number text,
  p_final_carrier_id uuid default null
) returns public.submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role app_role := my_role();
  v_old submissions;
  r submissions;
begin
  if v_role is null or v_role not in ('cxa', 'cxm', 'admin') then
    raise exception 'not authorized';
  end if;

  if not cx_pipeline_member(p_sub) then
    raise exception 'lead is not in the customer pipeline';
  end if;

  select * into v_old from submissions where id = p_sub;
  if v_old.id is null or v_old.archived_at is not null then
    raise exception 'submission not found or archived';
  end if;

  if p_final_carrier_id is not null
     and p_final_carrier_id is distinct from v_old.final_carrier_id
     and not exists (select 1 from carriers where id = p_final_carrier_id and active) then
    raise exception 'invalid or inactive carrier';
  end if;

  update submissions set
    final_carrier_id = p_final_carrier_id,
    agent_name = nullif(btrim(p_agent_name), ''),
    policy_number = nullif(btrim(p_policy_number), '')
  where id = p_sub
  returning * into r;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'cx_placement_fields_set',
          jsonb_build_object(
            'by_role', v_role,
            'old', jsonb_build_object(
              'final_carrier_id', v_old.final_carrier_id,
              'agent_name', v_old.agent_name,
              'policy_number', v_old.policy_number),
            'new', jsonb_build_object(
              'final_carrier_id', r.final_carrier_id,
              'agent_name', r.agent_name,
              'policy_number', r.policy_number)));

  return r;
end $$;

revoke execute on function public.cx_set_placement_fields(uuid, text, text, uuid) from public, anon;
grant execute on function public.cx_set_placement_fields(uuid, text, text, uuid) to authenticated;
