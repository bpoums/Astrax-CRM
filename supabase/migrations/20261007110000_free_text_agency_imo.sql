-- While the placement rule is off, validators type the Agency and IMO as text
-- so nothing is lost. These are NOT the agency_id / imo_id FKs (free text can't
-- go there) and NOT payload (that is pushed to Google Sheets, and the payload
-- key 'Agency' already carries the carrier on validator-submitted leads).

alter table public.submissions
  add column if not exists agency_name text,
  add column if not exists imo_name text;

-- Rule-off set_validator_fields gains the two text fields. The old 4-arg form is
-- dropped first: keeping both would make a 4-arg call ambiguous.
drop function if exists public.set_validator_fields(uuid, uuid, text, text);

create or replace function public.set_validator_fields(
  p_sub uuid,
  p_final_carrier_id uuid,
  p_agent_name text,
  p_policy_number text,
  p_agency_name text default null,
  p_imo_name text default null
) returns public.submissions
language plpgsql
security definer
set search_path = public
as $$
declare r submissions; v_role app_role := my_role(); v_carrier_ok boolean;
begin
  if v_role is null or v_role not in ('manager','validator','admin','general_manager') then
    raise exception 'not authorized';
  end if;
  if placement_rule_enabled() then
    raise exception 'This screen is out of date. Refresh the page and try again.';
  end if;

  if p_final_carrier_id is not null then
    select true into v_carrier_ok from carriers where id = p_final_carrier_id and active;
    if v_carrier_ok is null then raise exception 'invalid or inactive carrier'; end if;
  end if;

  update submissions set
    final_carrier_id = p_final_carrier_id,
    agent_name = nullif(trim(p_agent_name), ''),
    policy_number = nullif(trim(p_policy_number), ''),
    agency_name = nullif(trim(p_agency_name), ''),
    imo_name = nullif(trim(p_imo_name), '')
  where id = p_sub and archived_at is null
  returning * into r;

  if r.id is null then raise exception 'submission not found or archived'; end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'validator_fields_set',
          jsonb_build_object('by_role', v_role,
            'has_carrier', p_final_carrier_id is not null,
            'has_agent', nullif(trim(p_agent_name),'') is not null,
            'has_policy', nullif(trim(p_policy_number),'') is not null,
            'has_agency_name', nullif(trim(p_agency_name),'') is not null,
            'has_imo_name', nullif(trim(p_imo_name),'') is not null));
  return r;
end $$;

revoke execute on function public.set_validator_fields(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function public.set_validator_fields(uuid, uuid, text, text, text, text) to authenticated;

-- dispose_submission: rule-off accept now also needs the typed agency and IMO.
-- The rule-on branch is unchanged.
create or replace function public.dispose_submission(p_sub uuid, p_disposition disposition_t)
returns submissions
language plpgsql security definer set search_path to 'public'
as $$
declare r submissions; v_role app_role := my_role(); v_sub submissions; v_conflict text;
begin
  if v_role is null or v_role not in ('manager','admin','validator') then
    raise exception 'cannot dispose this submission';
  end if;

  if p_disposition = 'accepted' then
    select * into v_sub from submissions where id = p_sub;
    if v_sub.id is not null and v_sub.submitted_by_role = 'closer' then
      if placement_rule_enabled() then
        if v_sub.agency_id is null or v_sub.imo_id is null or v_sub.final_carrier_id is null
           or v_sub.agent_id is null
           or nullif(trim(coalesce(v_sub.policy_number,'')),'') is null then
          raise exception 'agency, IMO, final carrier, agent and policy number are required before accepting';
        end if;
        v_conflict := placement_conflict(p_sub, v_sub.imo_id, v_sub.final_carrier_id);
        if v_conflict is not null then raise exception 'Blocked: %', v_conflict; end if;
      elsif v_sub.final_carrier_id is null
         or nullif(trim(coalesce(v_sub.agency_name,'')),'') is null
         or nullif(trim(coalesce(v_sub.imo_name,'')),'') is null
         or nullif(trim(coalesce(v_sub.agent_name,'')),'') is null
         or nullif(trim(coalesce(v_sub.policy_number,'')),'') is null then
        raise exception 'agency, IMO, final carrier, agent name and policy number are required before accepting';
      end if;
    end if;
  end if;

  update submissions set
    status = case when p_disposition = 'accepted'
                  then 'closed'::sub_status
                  else 'pending_manager'::sub_status end,
    disposition = p_disposition,
    disposed_by = auth.uid(),
    disposed_at = now(),
    assigned_to = case when p_disposition = 'accepted' then assigned_to else null end,
    assigned_at = case when p_disposition = 'accepted' then assigned_at else null end,
    claimed_at  = case when p_disposition = 'accepted' then claimed_at  else null end
  where id = p_sub
    and status <> 'closed'
    and archived_at is null
    and (
      (v_role in ('manager','admin'))
      or (v_role = 'validator' and assigned_to = auth.uid() and status = 'in_review'
          and claimed_at > now() - review_window())
    )
  returning * into r;

  if r.id is null then raise exception 'cannot dispose this submission'; end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'disposed',
          jsonb_build_object('disposition', p_disposition, 'by_role', v_role,
                             'terminal', p_disposition = 'accepted'));
  return r;
end $$;

revoke execute on function public.dispose_submission(uuid, disposition_t) from public, anon;
grant execute on function public.dispose_submission(uuid, disposition_t) to authenticated;
