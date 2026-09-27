-- Server-side aggregation for the admin Sales Breakdown tab.
--
-- SalesBreakdown (src/components/sales-breakdown.tsx) previously paged every
-- accepted lead's full payload into the browser (fetchAllRows, 386 rows /
-- 393 kB measured live 2026-09-18) to compute carrier/state/plan-type pivots
-- and a closer leaderboard client-side -- expensive, and it ships customer
-- PII to the browser purely to count carriers. docs/TODO.md names the fix:
-- a `sales_breakdown_range` RPC in the same style as `submission_totals_range`.
--
-- These three helpers reproduce, in SQL, exactly the logic already reviewed
-- and shipped in the client:
--   - sales_plan_type_bucket  mirrors src/lib/plan-type.ts normalizePlanType
--   - sales_resolve_carrier   mirrors sales-breakdown.tsx's resolveCarrier
--                             (which itself calls src/lib/normalize/carriers.ts
--                             lookupCarrier/carrierKey, and the file-local
--                             prefixMatchCarrier)
--   - sales_resolve_state     mirrors sales-breakdown.tsx's resolveState
--                             (src/lib/normalize/states.ts STATE_CODES /
--                             STATE_ABBREVIATIONS)
--
-- Scope matches the existing tab exactly: disposition = 'accepted',
-- archived_at is null, filtered through reporting_window() the same way
-- SubmissionsExplorer/ReportingStats already do.

create or replace function public.sales_plan_type_bucket(p_raw text)
 returns text
 language sql
 immutable
as $function$
  select case
    when p_raw is null or btrim(p_raw) = '' then 'Unspecified'
    when upper(btrim(p_raw)) like '%MOD%' then 'Mod'
    when upper(btrim(p_raw)) like '%LEVEL%' then 'Level'
    when upper(btrim(p_raw)) like '%GRADED%' then 'Graded'
    when replace(upper(btrim(p_raw)), '.', '') = 'GI' then 'GI'
    else 'Unspecified'
  end
$function$;

create or replace function public.sales_resolve_carrier(p_final_carrier_name text, p_payload jsonb)
 returns text
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare
  v_raw text;
  v_key text;
  v_exact text;
  v_prefix text;
begin
  if nullif(btrim(p_final_carrier_name), '') is not null then
    return btrim(p_final_carrier_name);
  end if;

  v_raw := coalesce(
    nullif(btrim(p_payload->>'Proposed Carrier'), ''),
    nullif(btrim(p_payload->>'Agency'), '')
  );
  if v_raw is null then
    return 'Unspecified';
  end if;

  v_key := regexp_replace(lower(v_raw), '[^a-z0-9]+', '', 'g');
  if v_key = '' then
    return regexp_replace(btrim(v_raw), '\s+', ' ', 'g');
  end if;

  -- Exact match: carrier NAME keys take priority over ALIAS keys, matching
  -- src/lib/normalize/carriers.ts's carrierIndex() build order (a name is
  -- indexed first and an alias never displaces an existing key).
  select c.name into v_exact
  from carriers c
  where regexp_replace(lower(c.name), '[^a-z0-9]+', '', 'g') = v_key
  limit 1;

  if v_exact is null then
    select c.name into v_exact
    from carriers c, unnest(c.aliases) as alias
    where regexp_replace(lower(alias), '[^a-z0-9]+', '', 'g') = v_key
    limit 1;
  end if;

  if v_exact is not null then
    return v_exact;
  end if;

  -- Prefix match: the longest registered name/alias (>=4 chars in key form)
  -- that the lead's key starts with, mirroring prefixMatchCarrier() -- only
  -- used for this report, never the stricter upload-import pipeline.
  select c.name into v_prefix
  from carriers c
  cross join lateral (
    select regexp_replace(lower(c.name), '[^a-z0-9]+', '', 'g') as candidate_key
    union all
    select regexp_replace(lower(a), '[^a-z0-9]+', '', 'g') from unnest(c.aliases) as a
  ) k
  where length(k.candidate_key) >= 4
    and left(v_key, length(k.candidate_key)) = k.candidate_key
  order by length(k.candidate_key) desc
  limit 1;

  if v_prefix is not null then
    return v_prefix;
  end if;

  return regexp_replace(btrim(v_raw), '\s+', ' ', 'g');
end;
$function$;

create or replace function public.sales_resolve_state(p_payload jsonb)
 returns text
 language plpgsql
 immutable
as $function$
declare
  v_field text;
  v_value text;
  v_upper text;
  v_code text;
begin
  foreach v_field in array array['State','Residential State','Birth State'] loop
    v_value := nullif(btrim(p_payload->>v_field), '');
    if v_value is null then continue; end if;

    v_upper := upper(v_value);
    if v_upper in (
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
      'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','PR','RI','SC',
      'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
    ) then
      return v_upper;
    end if;

    v_code := case lower(v_value)
      when 'alabama' then 'AL' when 'alaska' then 'AK' when 'arizona' then 'AZ' when 'arkansas' then 'AR'
      when 'california' then 'CA' when 'colorado' then 'CO' when 'connecticut' then 'CT' when 'delaware' then 'DE'
      when 'district of columbia' then 'DC' when 'washington dc' then 'DC' when 'florida' then 'FL'
      when 'georgia' then 'GA' when 'hawaii' then 'HI' when 'idaho' then 'ID' when 'illinois' then 'IL'
      when 'indiana' then 'IN' when 'iowa' then 'IA' when 'kansas' then 'KS' when 'kentucky' then 'KY'
      when 'louisiana' then 'LA' when 'maine' then 'ME' when 'maryland' then 'MD' when 'massachusetts' then 'MA'
      when 'michigan' then 'MI' when 'minnesota' then 'MN' when 'mississippi' then 'MS' when 'missouri' then 'MO'
      when 'montana' then 'MT' when 'nebraska' then 'NE' when 'nevada' then 'NV' when 'new hampshire' then 'NH'
      when 'new jersey' then 'NJ' when 'new mexico' then 'NM' when 'new york' then 'NY'
      when 'north carolina' then 'NC' when 'north dakota' then 'ND' when 'ohio' then 'OH' when 'oklahoma' then 'OK'
      when 'oregon' then 'OR' when 'pennsylvania' then 'PA' when 'puerto rico' then 'PR'
      when 'rhode island' then 'RI' when 'south carolina' then 'SC' when 'south dakota' then 'SD'
      when 'tennessee' then 'TN' when 'texas' then 'TX' when 'utah' then 'UT' when 'vermont' then 'VT'
      when 'virginia' then 'VA' when 'washington' then 'WA' when 'west virginia' then 'WV'
      when 'wisconsin' then 'WI' when 'wyoming' then 'WY'
      else null
    end;

    if v_code is not null then
      return v_code;
    end if;
    -- present but unrecognised (blank handled above, "N/A", a typo, a
    -- non-US value): fall through to the next field rather than stopping.
  end loop;

  return 'Unspecified';
end;
$function$;

create or replace function public.sales_breakdown_range(
  p_days integer default null::integer,
  p_start_date date default null::date,
  p_end_date date default null::date
)
 returns table(
   dimension text,
   label text,
   level_count bigint,
   graded_count bigint,
   mod_count bigint,
   gi_count bigint,
   unspecified_count bigint,
   total_count bigint
 )
 language plpgsql
 stable
 set search_path to 'public'
as $function$
begin
  if my_role() is distinct from 'admin' then
    raise exception 'not authorized';
  end if;

  return query
  with b as (select * from reporting_window(p_days, p_start_date, p_end_date)),
  accepted as (
    select
      s.created_at,
      sales_plan_type_bucket(s.payload->>'Plan Type') as bucket,
      sales_resolve_carrier(c.name, s.payload) as carrier_label,
      sales_resolve_state(s.payload) as state_label
    from submissions s
    cross join b
    left join carriers c on c.id = s.final_carrier_id
    where s.disposition = 'accepted'
      and s.archived_at is null
      and (b.since is null or s.created_at >= b.since)
      and (b.until is null or s.created_at < b.until)
  ),
  totals as (
    select
      'total'::text as dimension,
      'Total'::text as label,
      count(*) filter (where bucket = 'Level') as level_count,
      count(*) filter (where bucket = 'Graded') as graded_count,
      count(*) filter (where bucket = 'Mod') as mod_count,
      count(*) filter (where bucket = 'GI') as gi_count,
      count(*) filter (where bucket = 'Unspecified') as unspecified_count,
      count(*) as total_count
    from accepted
  ),
  by_carrier as (
    select
      'carrier'::text as dimension,
      (array_agg(carrier_label order by created_at))[1] as label,
      count(*) filter (where bucket = 'Level') as level_count,
      count(*) filter (where bucket = 'Graded') as graded_count,
      count(*) filter (where bucket = 'Mod') as mod_count,
      count(*) filter (where bucket = 'GI') as gi_count,
      count(*) filter (where bucket = 'Unspecified') as unspecified_count,
      count(*) as total_count
    from accepted
    group by lower(carrier_label)
  ),
  by_state as (
    select
      'state'::text as dimension,
      state_label as label,
      count(*) filter (where bucket = 'Level') as level_count,
      count(*) filter (where bucket = 'Graded') as graded_count,
      count(*) filter (where bucket = 'Mod') as mod_count,
      count(*) filter (where bucket = 'GI') as gi_count,
      count(*) filter (where bucket = 'Unspecified') as unspecified_count,
      count(*) as total_count
    from accepted
    group by state_label
  )
  select * from totals
  union all
  select * from by_carrier
  union all
  select * from by_state;
end;
$function$;

create or replace function public.sales_closer_leaderboard_range(
  p_days integer default null::integer,
  p_start_date date default null::date,
  p_end_date date default null::date
)
 returns table(
   closer_id uuid,
   closer_name text,
   accepted bigint,
   total bigint
 )
 language plpgsql
 stable
 set search_path to 'public'
as $function$
begin
  if my_role() is distinct from 'admin' then
    raise exception 'not authorized';
  end if;

  return query
  with b as (select * from reporting_window(p_days, p_start_date, p_end_date))
  select
    s.closer_id,
    coalesce(nullif(btrim(p.full_name), ''), 'Unnamed closer'),
    count(*) filter (where s.disposition = 'accepted'),
    count(*)
  from submissions s
  cross join b
  left join profiles p on p.id = s.closer_id
  where s.closer_id is not null
    -- A validator-submitted lead auto-closes as accepted and stamps
    -- closer_id with the VALIDATOR's own id -- without this exclusion every
    -- validator shows up as a "closer" with a trivial 100% conversion rate.
    and s.submitted_by_role <> 'validator'
    and s.archived_at is null
    and (b.since is null or s.created_at >= b.since)
    and (b.until is null or s.created_at < b.until)
  group by s.closer_id, p.full_name;
end;
$function$;

revoke execute on function public.sales_breakdown_range(integer, date, date) from anon;
revoke execute on function public.sales_closer_leaderboard_range(integer, date, date) from anon;
