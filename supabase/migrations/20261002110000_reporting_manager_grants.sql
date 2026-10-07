-- Grants for the new reporting_manager role (added in the prior migration).
-- Read-only, business-wide: same visibility scope as general_manager on
-- `submissions` (so submission_totals_range / submission_totals_by_center_range
-- / the direct openQueue select all return real numbers, not zeros), plus
-- the two reporting RPCs that were previously admin-only.
--
-- No write RPC anywhere is touched — this role never assigns, disposes, or
-- edits a lead.

-- 1. submissions read policy: add a reporting_manager branch, same scope as
--    general_manager (business-wide, not center-scoped).
drop policy if exists "submissions read scoped" on public.submissions;

create policy "submissions read scoped" on public.submissions
for select
using (
  case (select my_role())
    when 'admin' then true
    when 'manager' then (status <> 'parked')
    when 'closing_manager' then (
      submitted_by_role = 'closer'
      and archived_at is null
      and center_id is not null
      and center_id = (select p.center_id from profiles p where p.id = (select auth.uid()))
    )
    when 'general_manager' then (
      submitted_by_role = any (array['closer','validator']::app_role[])
      and archived_at is null
    )
    when 'reporting_manager' then (
      submitted_by_role = any (array['closer','validator']::app_role[])
      and archived_at is null
    )
    when 'validator' then (
      assigned_to = (select auth.uid())
      and archived_at is null
      and status = any (array['assigned','in_review']::sub_status[])
      and (claimed_at is null or claimed_at > (now() - review_window()))
    )
    when 'data_uploader' then (uploaded_by = (select auth.uid()))
    when 'cxm' then (
      archived_at is null
      and cx_removed_at is null
      and (disposition = 'accepted' or reopened_from_cx_at is not null)
    )
    when 'cxa' then (
      archived_at is null
      and cx_removed_at is null
      and (disposition = 'accepted' or reopened_from_cx_at is not null)
    )
    else false
  end
);

-- 2. validator_stats_range: widen the role guard.
create or replace function public.validator_stats_range(
  p_days integer default null::integer,
  p_start_date date default null::date,
  p_end_date date default null::date
)
returns table(
  validator_id uuid,
  validator_name text,
  staff_id text,
  assigned bigint,
  approved bigint,
  declined bigint,
  pending bigint,
  timed_out bigint,
  rejected bigint,
  holds bigint
)
language plpgsql
stable
set search_path to 'public'
as $function$
begin
  if my_role() is null or my_role() not in ('admin','manager','reporting_manager') then
    raise exception 'not authorized';
  end if;

  return query
  with b as (select * from reporting_window(p_days, p_start_date, p_end_date))
  select p.id, p.full_name, p.staff_id,
    count(s.id) filter (where s.assigned_to = p.id or s.disposed_by = p.id),
    count(s.id) filter (where s.disposed_by = p.id and s.disposition = 'accepted'),
    count(s.id) filter (where s.disposed_by = p.id and s.disposition = 'declined'),
    count(s.id) filter (where s.disposed_by = p.id and s.disposition = 'pending'),
    (select count(*) from form_events e
      where e.actor_id = p.id and e.event_type = 'timeout'
        and (b.since is null or e.created_at >= b.since)
        and (b.until is null or e.created_at < b.until)),
    (select count(*) from form_events e
      where e.actor_id = p.id and e.event_type = 'rejected'
        and (b.since is null or e.created_at >= b.since)
        and (b.until is null or e.created_at < b.until)),
    (select count(*) from form_events e
      where e.actor_id = p.id and e.event_type = 'held'
        and (b.since is null or e.created_at >= b.since)
        and (b.until is null or e.created_at < b.until))
  from profiles p
  cross join b
  left join submissions s
    on (s.assigned_to = p.id or s.disposed_by = p.id)
   and (b.since is null or s.assigned_at >= b.since or s.disposed_at >= b.since)
   and (b.until is null or s.assigned_at < b.until or s.disposed_at < b.until)
  where p.role = 'validator'
  group by p.id, p.full_name, p.staff_id, b.since, b.until
  order by p.full_name;
end
$function$;

-- 3. sales_breakdown_range / sales_closer_leaderboard_range: widen from
--    admin-only to admin-or-reporting_manager. Bodies otherwise unchanged.
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
  if my_role() is null or my_role() not in ('admin','reporting_manager') then
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
returns table(closer_id uuid, closer_name text, accepted bigint, total bigint)
language plpgsql
stable
set search_path to 'public'
as $function$
begin
  if my_role() is null or my_role() not in ('admin','reporting_manager') then
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
    and s.submitted_by_role <> 'validator'
    and s.archived_at is null
    and (b.since is null or s.created_at >= b.since)
    and (b.until is null or s.created_at < b.until)
  group by s.closer_id, p.full_name;
end;
$function$;
