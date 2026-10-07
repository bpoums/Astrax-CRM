-- Placement rule, phase 2: record WHERE a carrier rejected a customer, and
-- refuse to place that customer again through the same carrier or the same IMO.
--
-- The rule (matched by customer ssn_normalized across every lead; by the lead
-- itself when it has no SSN): a carrier_rejected decline at IMO X -> Carrier C
-- blocks carrier C under every IMO, and every carrier under IMO X. A decline
-- with no IMO (everything recorded before this) blocks its carrier only.
-- Fixable declines (bank, card, account details) never block. An admin can
-- override one lead + IMO + carrier with a reason; the rejection stays.
--
-- SHIPS SWITCHED OFF. app_config 'placement_rule_enabled' = 'false', and while
-- it is false the app that is live today behaves exactly as before:
--   * set_validator_fields(4 args) and decline_with_carriers(p_carrier_ids)
--     keep working (the old decline now also stamps a `kind`, classified from
--     its reason text, which nothing reads until the switch is on);
--   * dispose_submission's accept gate is unchanged.
-- The new functions sit alongside the old ones and are only called by the new
-- app. Go-live is one later migration that sets the switch to 'true' — the old
-- paths then refuse ("refresh the page") and the accept gate tightens — applied
-- together with the app deploy.
--
-- Also fixes the NULL-role guard (`not in` -> `is null or not in`) in the three
-- functions this replaces.

insert into public.app_config (key, value) values ('placement_rule_enabled', 'false')
on conflict (key) do nothing;

create or replace function public.placement_rule_enabled() returns boolean
language sql stable security definer set search_path to 'public'
as $$ select coalesce((select value = 'true' from app_config where key = 'placement_rule_enabled'), false) $$;

-- ------------------------------------------------- carrier_declines

-- How a free-text decline reason reads, for rows written without an explicit
-- kind: every row before this migration, and anything the old app writes
-- before go-live. Account/payment/identity problems are fixable and checked
-- first, so "ACCOUNT ISSUE ON CORBRIDGE" is not mistaken for a rejection.
-- `\mAGE\M` is a whole word on purpose: a bare "AGE" also matches "COVERAGE".
create or replace function public.classify_decline_reason(p_reason text) returns text
language sql immutable set search_path to 'public'
as $$
  select case
    when nullif(btrim(coalesce(p_reason, '')), '') is null then 'unclassified'
    when upper(p_reason) ~ '\m(ACC|BANK|BNK|CARD|ROUTING|PAYMENT|PREMIUM|SSN|BIRTH|IDENTITY|EMAIL|CELL|PHONE|BENEFICIAR)'
      then 'fixable'
    when upper(p_reason) ~ '(UNDERWRIT|MEDICAL|HEALTH|PRESCRIPTION|INELIG|OVER ?AGE|\mAGE\M|DUPE|DUOE|DUPLICATE|DECLIN|COVERAGE|COVERIGE|ALREADY|MISSISSIPPI|SECUIRCO)'
      then 'carrier_rejected'
    else 'unclassified'
  end
$$;

alter table public.carrier_declines
  add column imo_id uuid references public.imos (id),
  add column source text not null default 'validator',
  add column kind text;

update public.carrier_declines set kind = public.classify_decline_reason(reason);

alter table public.carrier_declines
  alter column kind set not null,
  add constraint carrier_declines_source_chk check (source in ('validator', 'after_submit')),
  add constraint carrier_declines_kind_chk check (kind in ('carrier_rejected', 'fixable', 'unclassified'));

create index carrier_declines_imo_idx on public.carrier_declines (imo_id) where imo_id is not null;

-- ------------------------------------------------- overrides

create table public.placement_overrides (
  id bigint generated always as identity primary key,
  submission_id uuid not null references public.submissions (id) on delete cascade,
  imo_id uuid not null references public.imos (id),
  carrier_id uuid not null references public.carriers (id),
  reason text not null check (btrim(reason) <> ''),
  overridden_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (submission_id, imo_id, carrier_id)
);
alter table public.placement_overrides enable row level security;
revoke insert, update, delete, truncate on public.placement_overrides from anon, authenticated;
create policy "placement overrides readable" on public.placement_overrides for select using (
  (select my_role()) = any (array['admin','manager','general_manager']::app_role[])
);

-- ------------------------------------------------- the rule

-- Null when this lead may be placed at IMO -> carrier, otherwise the reason it
-- may not, written to be shown to the validator as-is. Internal: not granted.
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

  select d.declined_at, d.carrier_id, d.imo_id, c.name as carrier_name, i.name as imo_name,
         (d.carrier_id = p_carrier) as same_carrier
    into r
  from carrier_declines d
  join submissions s on s.id = d.submission_id
  join carriers c on c.id = d.carrier_id
  left join imos i on i.id = d.imo_id
  where d.kind = 'carrier_rejected'
    and (s.id = p_sub or (v_ssn is not null and s.ssn_normalized = v_ssn))
    and (d.carrier_id = p_carrier or (d.imo_id is not null and d.imo_id = p_imo))
  order by (d.carrier_id = p_carrier) desc, d.declined_at
  limit 1;

  if r.declined_at is null then return null; end if;
  if r.same_carrier then
    return format('%s already rejected this customer%s on %s — it cannot be used again under any IMO.',
      r.carrier_name, coalesce(' via ' || r.imo_name, ''),
      to_char(r.declined_at at time zone 'Asia/Karachi', 'MM/DD/YYYY'));
  end if;
  return format('%s rejected this customer via %s on %s — no carrier under %s can be used.',
    r.carrier_name, r.imo_name,
    to_char(r.declined_at at time zone 'Asia/Karachi', 'MM/DD/YYYY'), r.imo_name);
end $$;

-- What the dropdowns need to grey out blocked carriers: this customer's carrier
-- rejections and this lead's overrides. Same audience as set_validator_fields;
-- a validator only for a lead assigned to them.
create or replace function public.placement_blocks(p_sub uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_role app_role := my_role(); v_sub submissions;
begin
  if v_role is null or v_role not in ('manager','validator','admin','general_manager') then
    raise exception 'not authorized';
  end if;
  select * into v_sub from submissions where id = p_sub;
  if v_sub.id is null then raise exception 'submission not found'; end if;
  if v_role = 'validator' and v_sub.assigned_to is distinct from auth.uid() then
    raise exception 'not assigned to you';
  end if;

  return jsonb_build_object(
    'rejections', coalesce((
      select jsonb_agg(jsonb_build_object(
               'imo_id', d.imo_id, 'imo_name', i.name,
               'carrier_id', d.carrier_id, 'carrier_name', c.name,
               'declined_at', d.declined_at, 'source', d.source,
               'same_lead', d.submission_id = p_sub)
             order by d.declined_at)
      from carrier_declines d
      join submissions s on s.id = d.submission_id
      join carriers c on c.id = d.carrier_id
      left join imos i on i.id = d.imo_id
      where d.kind = 'carrier_rejected'
        and (s.id = p_sub or (v_sub.ssn_normalized is not null
                              and s.ssn_normalized = v_sub.ssn_normalized))), '[]'::jsonb),
    'overrides', coalesce((
      select jsonb_agg(jsonb_build_object('imo_id', o.imo_id, 'carrier_id', o.carrier_id,
                                          'reason', o.reason, 'created_at', o.created_at))
      from placement_overrides o where o.submission_id = p_sub), '[]'::jsonb)
  );
end $$;

-- ------------------------------------------------- validator fields

-- The new six-field save. Validates the whole chain (agency->IMO, IMO->carrier,
-- agent appointed on that IMO->carrier); a value the lead already holds is
-- always accepted, so a since-retired agency or agent does not lock an old
-- lead. Enforces the rule unless the lead is closed — a closed lead is
-- history, being mapped, not placed. agent_name follows the chosen agent,
-- except on a closed lead that already has one (keeps its Sheet row unchanged).
create or replace function public.set_validator_fields(
  p_sub uuid,
  p_agency_id uuid,
  p_imo_id uuid,
  p_final_carrier_id uuid,
  p_agent_id uuid,
  p_policy_number text
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
            'has_policy', nullif(btrim(p_policy_number), '') is not null));
  return r;
end $$;

-- The old four-field save, unchanged while the switch is off.
create or replace function public.set_validator_fields(
  p_sub uuid, p_final_carrier_id uuid, p_agent_name text, p_policy_number text
) returns submissions
language plpgsql security definer set search_path to 'public'
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
    policy_number = nullif(trim(p_policy_number), '')
  where id = p_sub and archived_at is null
  returning * into r;

  if r.id is null then raise exception 'submission not found or archived'; end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'validator_fields_set',
          jsonb_build_object('by_role', v_role,
            'has_carrier', p_final_carrier_id is not null,
            'has_agent', nullif(trim(p_agent_name),'') is not null,
            'has_policy', nullif(trim(p_policy_number),'') is not null));
  return r;
end $$;

-- ------------------------------------------------- dispose

create or replace function public.dispose_submission(p_sub uuid, p_disposition disposition_t)
returns submissions
language plpgsql security definer set search_path to 'public'
as $$
declare r submissions; v_role app_role := my_role(); v_sub submissions; v_conflict text;
begin
  if v_role is null or v_role not in ('manager','admin','validator') then
    raise exception 'cannot dispose this submission';
  end if;

  -- Gate: accepting a closer-originated lead requires the validator fields.
  -- Only on accept (declined/pending return to manager, no requirement).
  -- Only for closer-submitted leads (validator self-submissions auto-accept via
  -- submit_form, carrying their own carrier/agent/policy from the form).
  -- With the placement rule on, that is all five fields and no placement
  -- conflict; with it off, the original three.
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
         or nullif(trim(coalesce(v_sub.agent_name,'')),'') is null
         or nullif(trim(coalesce(v_sub.policy_number,'')),'') is null then
        raise exception 'final carrier, agent name and policy number are required before accepting';
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

-- ------------------------------------------------- declines

-- The old carrier-only decline, unchanged while the switch is off apart from
-- stamping a `kind` read from the reason text.
create or replace function public.decline_with_carriers(
  p_sub uuid, p_carrier_ids uuid[], p_reason text default null
) returns submissions
language plpgsql security definer set search_path to 'public'
as $$
declare r submissions; v_role app_role := my_role(); v_cid uuid; v_n int;
begin
  if v_role is null or v_role not in ('validator','manager','admin') then
    raise exception 'not authorized';
  end if;
  if placement_rule_enabled() then
    raise exception 'This screen is out of date. Refresh the page and try again.';
  end if;
  if p_carrier_ids is null or array_length(p_carrier_ids, 1) is null then
    raise exception 'select at least one carrier';
  end if;

  select count(*) into v_n from carriers where id = any(p_carrier_ids) and active;
  if v_n <> array_length(p_carrier_ids, 1) then
    raise exception 'one or more carriers are invalid or inactive';
  end if;

  update submissions set
    status = 'pending_manager',
    disposition = 'declined',
    disposed_by = auth.uid(),
    disposed_at = now(),
    assigned_to = null, assigned_at = null, claimed_at = null
  where id = p_sub
    and status <> 'closed'
    and archived_at is null
    and (
      v_role in ('manager','admin')
      or (v_role = 'validator' and assigned_to = auth.uid() and status = 'in_review'
          and claimed_at > now() - review_window())
    )
  returning * into r;

  if r.id is null then raise exception 'cannot decline this submission'; end if;

  foreach v_cid in array p_carrier_ids loop
    insert into carrier_declines (submission_id, carrier_id, reason, declined_by, kind)
    values (p_sub, v_cid, nullif(p_reason,''), auth.uid(), classify_decline_reason(p_reason));
  end loop;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'disposed',
          jsonb_build_object('disposition','declined','by_role',v_role,
            'carriers', (select jsonb_agg(name order by name)
                           from carriers where id = any(p_carrier_ids)),
            'reason', nullif(p_reason,'')));
  return r;
end $$;

-- The new decline: the validator ticks IMO->Carrier contracts and says whether
-- the carrier rejected the customer or the problem is fixable.
create or replace function public.decline_with_carriers(
  p_sub uuid, p_imo_carrier_ids uuid[], p_kind text, p_reason text default null
) returns submissions
language plpgsql security definer set search_path to 'public'
as $$
declare r submissions; v_role app_role := my_role(); v_n int;
begin
  if v_role is null or v_role not in ('validator','manager','admin') then
    raise exception 'not authorized';
  end if;
  if p_kind is null or p_kind not in ('carrier_rejected','fixable') then
    raise exception 'say whether the carrier rejected the customer or the issue is fixable';
  end if;
  if p_imo_carrier_ids is null or array_length(p_imo_carrier_ids, 1) is null then
    raise exception 'select at least one carrier';
  end if;

  select count(*) into v_n
  from imo_carriers ic join carriers c on c.id = ic.carrier_id join imos i on i.id = ic.imo_id
  where ic.id = any(p_imo_carrier_ids) and ic.active and c.active and i.active;
  if v_n <> array_length(p_imo_carrier_ids, 1) then
    raise exception 'one or more carriers are invalid or inactive';
  end if;
  -- One application per carrier: the same carrier ticked under two IMOs is
  -- exactly the re-shopping this rule exists to stop.
  if (select count(distinct carrier_id) from imo_carriers where id = any(p_imo_carrier_ids))
     <> array_length(p_imo_carrier_ids, 1) then
    raise exception 'a carrier can only be declined under one IMO at a time';
  end if;

  update submissions set
    status = 'pending_manager',
    disposition = 'declined',
    disposed_by = auth.uid(),
    disposed_at = now(),
    assigned_to = null, assigned_at = null, claimed_at = null
  where id = p_sub
    and status <> 'closed'
    and archived_at is null
    and (
      v_role in ('manager','admin')
      or (v_role = 'validator' and assigned_to = auth.uid() and status = 'in_review'
          and claimed_at > now() - review_window())
    )
  returning * into r;

  if r.id is null then raise exception 'cannot decline this submission'; end if;

  insert into carrier_declines (submission_id, carrier_id, imo_id, reason, declined_by, kind, source)
  select p_sub, ic.carrier_id, ic.imo_id, nullif(btrim(p_reason), ''), auth.uid(), p_kind, 'validator'
  from imo_carriers ic where ic.id = any(p_imo_carrier_ids);

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'disposed',
          jsonb_build_object('disposition','declined','by_role',v_role,'kind',p_kind,
            'carriers', (select jsonb_agg(i.name || ' → ' || c.name order by i.name, c.name)
                           from imo_carriers ic join imos i on i.id = ic.imo_id
                           join carriers c on c.id = ic.carrier_id
                           where ic.id = any(p_imo_carrier_ids)),
            'reason', nullif(btrim(p_reason), '')));
  return r;
end $$;

-- A carrier rejection learned after the lead was already accepted (the
-- carrier's underwriting said no later). Records it so the rule sees it; the
-- lead's status and outcome are not touched.
create or replace function public.record_carrier_rejection(
  p_sub uuid, p_imo_carrier_id uuid, p_reason text default null
) returns void
language plpgsql security definer set search_path to 'public'
as $$
declare v_role app_role := my_role(); v_sub submissions; v_link imo_carriers;
begin
  if v_role is null or v_role not in ('manager','admin') then
    raise exception 'not authorized';
  end if;
  select * into v_sub from submissions where id = p_sub;
  if v_sub.id is null or v_sub.archived_at is not null then
    raise exception 'submission not found or archived';
  end if;
  if v_sub.status <> 'closed' then
    raise exception 'only an accepted lead can have an after-submit rejection — use Decline for an open lead';
  end if;
  select * into v_link from imo_carriers where id = p_imo_carrier_id;
  if v_link.id is null then raise exception 'unknown IMO and carrier'; end if;

  insert into carrier_declines (submission_id, carrier_id, imo_id, reason, declined_by, kind, source)
  values (p_sub, v_link.carrier_id, v_link.imo_id, nullif(btrim(p_reason), ''), auth.uid(),
          'carrier_rejected', 'after_submit');

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'carrier_rejected_after_submit',
          jsonb_build_object('by_role', v_role,
            'imo', (select name from imos where id = v_link.imo_id),
            'carrier', (select name from carriers where id = v_link.carrier_id),
            'reason', nullif(btrim(p_reason), '')));
end $$;

-- Admin lets one lead through one blocked IMO -> carrier. The rejection stays.
create or replace function public.override_placement_block(
  p_sub uuid, p_imo_id uuid, p_carrier_id uuid, p_reason text
) returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  if my_role() is distinct from 'admin' then raise exception 'not authorized'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'an override needs a reason';
  end if;
  if not exists (select 1 from submissions where id = p_sub and archived_at is null) then
    raise exception 'submission not found or archived';
  end if;

  insert into placement_overrides (submission_id, imo_id, carrier_id, reason, overridden_by)
  values (p_sub, p_imo_id, p_carrier_id, btrim(p_reason), auth.uid())
  on conflict (submission_id, imo_id, carrier_id) do nothing;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'placement_override',
          jsonb_build_object(
            'imo', (select name from imos where id = p_imo_id),
            'carrier', (select name from carriers where id = p_carrier_id),
            'reason', btrim(p_reason)));
end $$;

-- ------------------------------------------------- manager badge

-- Per lead, how many carrier rejections are on file for that customer (across
-- every lead with the same SSN). Invoker, so it shows only what the reader's
-- own RLS on submissions and carrier_declines lets them see.
create view public.submission_customer_rejections with (security_invoker = true) as
select s.id as submission_id,
       count(distinct d.id) as rejection_count,
       array_agg(distinct c.name order by c.name) as rejected_carriers
from submissions s
join submissions o on o.id = s.id or (s.ssn_normalized is not null and o.ssn_normalized = s.ssn_normalized)
join carrier_declines d on d.submission_id = o.id and d.kind = 'carrier_rejected'
join carriers c on c.id = d.carrier_id
group by s.id;

-- ------------------------------------------------- grants

revoke execute on function public.placement_rule_enabled() from public, anon;
revoke execute on function public.placement_conflict(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.placement_blocks(uuid) from public, anon;
revoke execute on function public.set_validator_fields(uuid, uuid, uuid, uuid, uuid, text) from public, anon;
revoke execute on function public.set_validator_fields(uuid, uuid, text, text) from public, anon;
revoke execute on function public.dispose_submission(uuid, disposition_t) from public, anon;
revoke execute on function public.decline_with_carriers(uuid, uuid[], text) from public, anon;
revoke execute on function public.decline_with_carriers(uuid, uuid[], text, text) from public, anon;
revoke execute on function public.record_carrier_rejection(uuid, uuid, text) from public, anon;
revoke execute on function public.override_placement_block(uuid, uuid, uuid, text) from public, anon;

grant execute on function public.placement_rule_enabled() to authenticated;
grant execute on function public.placement_blocks(uuid) to authenticated;
grant execute on function public.set_validator_fields(uuid, uuid, uuid, uuid, uuid, text) to authenticated;
grant execute on function public.set_validator_fields(uuid, uuid, text, text) to authenticated;
grant execute on function public.dispose_submission(uuid, disposition_t) to authenticated;
grant execute on function public.decline_with_carriers(uuid, uuid[], text) to authenticated;
grant execute on function public.decline_with_carriers(uuid, uuid[], text, text) to authenticated;
grant execute on function public.record_carrier_rejection(uuid, uuid, text) to authenticated;
grant execute on function public.override_placement_block(uuid, uuid, uuid, text) to authenticated;
grant select on public.submission_customer_rejections to authenticated;
