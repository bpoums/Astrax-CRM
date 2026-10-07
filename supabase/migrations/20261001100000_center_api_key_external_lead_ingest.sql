-- External closer-form intake for centers running their own CRM.
--
-- A center's own CRM has no Supabase Auth session behind it, so there is no
-- auth.uid() to key off the way submit_form_internal does. A per-center API
-- key stands in for that: center_api_keys stores only its salted hash (RLS
-- enabled, zero policies -- same pattern as app_config/payment_details,
-- reachable only through SECURITY DEFINER functions), submit_external_lead
-- authenticates by matching the presented key's hash, then inserts exactly
-- the shape submit_form_internal would for a closer: pending_manager,
-- closer_id null, same duplicate-SSN block. Payment/banking fields are NOT
-- split into payment_details here -- that split is specific to the
-- sheet-import pipeline (ingest_sheet_lead's p_payment). A live closer
-- submission already carries its Banking section fields as ordinary payload
-- keys, and this mirrors that, not the import path.

alter table public.submissions
  drop constraint submissions_source_chk;
alter table public.submissions
  add constraint submissions_source_chk check (source = any (array['live', 'sheet', 'api']));

create table public.center_api_keys (
  center_id uuid primary key references public.centers(id),
  key_hash bytea not null unique,
  key_prefix text not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  last_used_at timestamptz
);

alter table public.center_api_keys enable row level security;
-- Deliberately no policies: only SECURITY DEFINER functions below touch this
-- table, the same trust boundary as app_config and payment_details.

create or replace function public.admin_generate_center_api_key(p_center_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_raw text;
begin
  if my_role() is distinct from 'admin' then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from centers where id = p_center_id) then
    raise exception 'center not found';
  end if;

  v_raw := encode(gen_random_bytes(32), 'hex');

  insert into center_api_keys (center_id, key_hash, key_prefix, created_by, last_used_at)
  values (p_center_id, digest(v_raw, 'sha256'), left(v_raw, 8), auth.uid(), null)
  on conflict (center_id) do update
    set key_hash = excluded.key_hash,
        key_prefix = excluded.key_prefix,
        created_by = excluded.created_by,
        created_at = now(),
        last_used_at = null;

  return v_raw;
end;
$$;

create or replace function public.admin_list_center_api_keys()
returns table (
  center_id uuid,
  key_prefix text,
  created_at timestamptz,
  last_used_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if my_role() is distinct from 'admin' then
    raise exception 'not authorized';
  end if;

  return query
    select k.center_id, k.key_prefix, k.created_at, k.last_used_at
    from center_api_keys k;
end;
$$;

create or replace function public.submit_external_lead(p_api_key text, p_payload jsonb)
returns submissions
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r submissions;
  v_center_id uuid;
  v_center_name text;
  v_draft_date date;
  v_future_draft_date date;
  v_ssn text;
  v_duplicate_exists boolean;
  v_exempted boolean;
begin
  select k.center_id, c.name
    into v_center_id, v_center_name
  from center_api_keys k
  join centers c on c.id = k.center_id
  where k.key_hash = digest(coalesce(p_api_key, ''), 'sha256');

  if v_center_id is null then
    raise exception 'invalid api key';
  end if;

  if p_payload is null or p_payload = '{}'::jsonb then
    raise exception 'empty payload';
  end if;

  v_draft_date := parse_lead_date(p_payload->>'Draft Date');
  v_future_draft_date := parse_lead_date(p_payload->>'Future Draft Date');
  v_ssn := normalize_ssn(p_payload->>'SSN Number');

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

  insert into submissions (
    closer_id, payload, submitted_by_role, center_id, center_name,
    draft_date, future_draft_date, ssn_normalized,
    status, source
  )
  values (
    null,
    p_payload || jsonb_build_object('Submitted By Role', 'closer'),
    'closer',
    v_center_id, v_center_name,
    v_draft_date, v_future_draft_date, v_ssn,
    'pending_manager', 'api'
  )
  returning * into r;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (r.id, null, 'submitted',
          jsonb_build_object('source', 'api', 'center', v_center_name));

  update center_api_keys set last_used_at = now() where center_id = v_center_id;

  return r;
end;
$$;

revoke all on function public.admin_generate_center_api_key(uuid) from public;
revoke all on function public.admin_list_center_api_keys() from public;
grant execute on function public.admin_generate_center_api_key(uuid) to authenticated;
grant execute on function public.admin_list_center_api_keys() to authenticated;
