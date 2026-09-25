-- Duplicate SSN is no longer advisory-only for an ACCEPTED lead: closer and
-- validator submissions (submit_form / submit_form_parked / the validator's
-- own direct submit, all through submit_form_internal) are blocked when the
-- SSN already belongs to an accepted, non-archived submission, unless a CX
-- agent has tagged that *existing accepted* policy as eligible for a second
-- one. Declined and in-progress duplicates keep their original,
-- advisory-only behavior (warn, never block) -- a re-write after a decline,
-- or a lead still being worked, is not "a second policy."
--
-- The exemption is a property of the tag, not a hardcoded label, so any tag
-- an admin/cxm marks this way grants it -- not just the one seeded below.

alter table cx_tags
  add column allows_duplicate_ssn boolean not null default false;

insert into cx_tags (label, tone, sort_order, active, allows_duplicate_ssn)
values ('Eligible For Second Policy', 'positive', 20, true, true);

create or replace function public.submit_form_internal(p_payload jsonb, p_status sub_status)
returns submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  r submissions;
  v_role app_role := my_role();
  v_staff text;
  v_center_id uuid;
  v_center_name text;
  v_draft_date date;
  v_future_draft_date date;
  v_ssn text;
  v_status sub_status;
  v_duplicate_exists boolean;
  v_exempted boolean;
begin
  if v_role not in ('closer','validator') then
    raise exception 'not authorized to submit';
  end if;

  select p.staff_id, p.center_id, c.name
    into v_staff, v_center_id, v_center_name
  from profiles p left join centers c on c.id = p.center_id
  where p.id = auth.uid();

  begin
    v_draft_date := nullif(p_payload->>'Draft Date', '')::date;
  exception when others then
    v_draft_date := null;
  end;
  begin
    v_future_draft_date := nullif(p_payload->>'Future Draft Date', '')::date;
  exception when others then
    v_future_draft_date := null;
  end;

  -- digits-only SSN for duplicate matching; null unless it forms a clean 9 digits
  v_ssn := regexp_replace(coalesce(p_payload->>'SSN Number',''), '\D', '', 'g');
  if length(v_ssn) <> 9 then v_ssn := null; end if;

  -- Blocked only when the SSN already belongs to an ACCEPTED lead and none
  -- of those accepted leads carries an exemption tag. Declined/in-progress
  -- duplicates are not checked here at all -- that leniency lives only in
  -- the advisory check_duplicate_ssn/duplicateSsnWarning path now.
  if v_ssn is not null then
    select exists (
      select 1 from submissions s
      where s.ssn_normalized = v_ssn
        and s.archived_at is null
        and s.disposition = 'accepted'
    ) into v_duplicate_exists;

    if v_duplicate_exists then
      select exists (
        select 1
        from submissions s
        join submission_tags st on st.submission_id = s.id
        join cx_tags t on t.id = st.tag_id
        where s.ssn_normalized = v_ssn
          and s.archived_at is null
          and s.disposition = 'accepted'
          and t.allows_duplicate_ssn
      ) into v_exempted;

      if not v_exempted then
        raise exception 'This SSN already belongs to an accepted lead. Ask a CX agent to tag the original policy as eligible for a second policy before resubmitting.';
      end if;
    end if;
  end if;

  -- A validator submission always auto-accepts and closes regardless of any
  -- requested status override -- parking only makes sense for a closer-
  -- originated lead. submit_form_parked() checks submitted_by_role after
  -- this call and treats a validator's own submission as already handled.
  v_status := case
    when v_role = 'validator' then 'closed'::sub_status
    else coalesce(p_status, 'pending_manager'::sub_status)
  end;

  insert into submissions (
    closer_id, payload, submitted_by_role, center_id, center_name,
    draft_date, future_draft_date, ssn_normalized,
    status, disposition, disposed_by, disposed_at
  )
  values (
    auth.uid(),
    p_payload
      || jsonb_build_object('ID', coalesce(v_staff, ''))
      || jsonb_build_object('Submitted By Role', v_role::text),
    v_role,
    v_center_id, v_center_name,
    v_draft_date, v_future_draft_date, v_ssn,
    v_status,
    case when v_role = 'validator' then 'accepted'::disposition_t else null end,
    case when v_role = 'validator' then auth.uid() else null end,
    case when v_role = 'validator' then now() else null end
  )
  returning * into r;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (r.id, auth.uid(), 'submitted', jsonb_build_object('by_role', v_role, 'staff_id', v_staff));

  if v_role = 'validator' then
    insert into form_events (submission_id, actor_id, event_type, detail)
    values (r.id, auth.uid(), 'disposed',
            jsonb_build_object('disposition', 'accepted', 'by_role', v_role, 'auto', true));
  end if;

  return r;
end;
$$;

-- check_duplicate_ssn stays advisory/read-only, but now also reports whether
-- an accepted match is exempted, so the client can tell the caller in
-- advance whether an actual submit will succeed. `exempt` is only ever
-- meaningful when `status = 'accepted'` -- declined/in-progress matches
-- never block, so exemption is irrelevant to them.
create or replace function public.check_duplicate_ssn(p_ssn text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_norm text;
  r record;
  v_exempt boolean := false;
begin
  if my_role() not in ('closer','validator','manager','admin') then
    raise exception 'not authorized';
  end if;

  v_norm := regexp_replace(coalesce(p_ssn,''), '\D', '', 'g');
  if length(v_norm) <> 9 then
    return jsonb_build_object('exists', false);
  end if;

  -- most relevant existing match: prefer an accepted one, else newest.
  -- archived leads are excluded -- a removed lead shouldn't warn.
  select
    case
      when s.disposition = 'accepted' then 'accepted'
      when s.disposition = 'declined' then 'declined'
      else 'in_progress'
    end as bucket,
    s.created_at
  into r
  from submissions s
  where s.ssn_normalized = v_norm
    and s.archived_at is null
  order by (s.disposition = 'accepted') desc, s.created_at desc
  limit 1;

  if r is null then
    return jsonb_build_object('exists', false);
  end if;

  if r.bucket = 'accepted' then
    -- checked against every accepted duplicate, not just the one row picked
    -- above as "most relevant" to display -- mirrors submit_form_internal's
    -- own check exactly.
    select exists (
      select 1
      from submissions s
      join submission_tags st on st.submission_id = s.id
      join cx_tags t on t.id = st.tag_id
      where s.ssn_normalized = v_norm
        and s.archived_at is null
        and s.disposition = 'accepted'
        and t.allows_duplicate_ssn
    ) into v_exempt;
  end if;

  return jsonb_build_object(
    'exists', true,
    'status', r.bucket,
    'submitted_at', r.created_at,
    'exempt', v_exempt
  );
end;
$$;
