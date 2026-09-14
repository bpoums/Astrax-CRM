-- Date-range filtering for Admin -> Overview and Admin -> Submissions.
--
-- The three reporting RPCs only ever took a day-count (p_days), computing an
-- open-ended lower bound via reporting_since() -- "last N days through now".
-- There was no way to ask for a specific past day or an arbitrary range.
--
-- reporting_window() is the new shared primitive: it keeps the exact
-- existing p_days behavior unchanged (since = reporting_since(p_days), until
-- = null, open-ended) when p_days is given, and adds a genuine [since,
-- until) window in Pacific calendar days when p_start_date is given instead
-- (p_end_date optional -- omitting it filters exactly the one day). All
-- three _range RPCs are extended to accept the same two new optional
-- parameters and use this window for both bounds; existing callers passing
-- only p_days are unaffected.

-- CREATE OR REPLACE does not change a function's parameter list -- a
-- different signature creates a second overload instead of replacing the
-- original, which made every existing single-argument call ("p_days=7")
-- ambiguous the moment the three-argument versions below were added. Drop
-- the old one-argument overloads first so only the new signature survives.
drop function if exists public.submission_totals_range(integer);
drop function if exists public.submission_totals_by_center_range(integer);
drop function if exists public.validator_stats_range(integer);

create or replace function public.reporting_window(
  p_days integer default null,
  p_start_date date default null,
  p_end_date date default null
)
returns table(since timestamptz, until timestamptz)
language sql
stable
set search_path to 'public'
as $function$
  select
    case
      when p_days is not null and p_days > 0 then reporting_since(p_days)
      when p_start_date is not null then (p_start_date::timestamp at time zone 'America/Los_Angeles')
      else null
    end as since,
    case
      when p_days is not null and p_days > 0 then null
      when p_start_date is not null
        then ((coalesce(p_end_date, p_start_date) + 1)::timestamp at time zone 'America/Los_Angeles')
      else null
    end as until
$function$;

create or replace function public.submission_totals_range(
  p_days integer default null,
  p_start_date date default null,
  p_end_date date default null
)
returns table(closer_submissions bigint, validator_submissions bigint, offline_submissions bigint, approved bigint, declined bigint, pending bigint, in_review bigint, awaiting_manager bigint, timeouts bigint, rejections bigint)
language sql
stable
set search_path to 'public'
as $function$
  with b as (select * from reporting_window(p_days, p_start_date, p_end_date))
  select
    count(*) filter (where s.submitted_by_role = 'closer' and s.source = 'live'),
    count(*) filter (where s.submitted_by_role = 'validator'),
    count(*) filter (where s.source = 'sheet' and s.status <> 'pending_import_approval'),
    count(*) filter (where s.submitted_by_role = 'closer' and s.source = 'live'
                       and s.disposition = 'accepted'),
    count(*) filter (where s.submitted_by_role = 'closer' and s.source = 'live'
                       and s.disposition = 'declined'),
    count(*) filter (where s.submitted_by_role = 'closer' and s.source = 'live'
                       and s.disposition = 'pending'),
    count(*) filter (where s.status = 'in_review'),
    count(*) filter (where s.status = 'pending_manager'),
    (select count(*) from form_events e, b
      where e.event_type = 'timeout'
        and (b.since is null or e.created_at >= b.since)
        and (b.until is null or e.created_at < b.until)),
    (select count(*) from form_events e, b
      where e.event_type = 'rejected'
        and (b.since is null or e.created_at >= b.since)
        and (b.until is null or e.created_at < b.until))
  from submissions s, b
  where s.archived_at is null
    and (b.since is null or s.created_at >= b.since)
    and (b.until is null or s.created_at < b.until)
$function$;

create or replace function public.submission_totals_by_center_range(
  p_days integer default null,
  p_start_date date default null,
  p_end_date date default null
)
returns table(center_id uuid, center_name text, sort_order integer, total_submissions bigint, approved bigint, declined bigint, pending bigint, awaiting_manager bigint)
language sql
stable
set search_path to 'public'
as $function$
  with b as (select * from reporting_window(p_days, p_start_date, p_end_date))
  select c.id, c.name, c.sort_order,
    count(s.id) filter (where s.archived_at is null),
    count(s.id) filter (where s.archived_at is null and s.disposition = 'accepted'),
    count(s.id) filter (where s.archived_at is null and s.disposition = 'declined'),
    count(s.id) filter (where s.archived_at is null and s.disposition = 'pending'),
    count(s.id) filter (where s.archived_at is null and s.status = 'pending_manager'
                          and s.disposition is null)
  from centers c
  cross join b
  left join submissions s
    on s.center_id = c.id
   and s.submitted_by_role = 'closer'
   and s.source = 'live'
   and (b.since is null or s.created_at >= b.since)
   and (b.until is null or s.created_at < b.until)
  where c.active
  group by c.id, c.name, c.sort_order
  order by c.sort_order
$function$;

create or replace function public.validator_stats_range(
  p_days integer default null,
  p_start_date date default null,
  p_end_date date default null
)
returns table(validator_id uuid, validator_name text, staff_id text, assigned bigint, approved bigint, declined bigint, pending bigint, timed_out bigint, rejected bigint, holds bigint)
language sql
stable
set search_path to 'public'
as $function$
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
  order by p.full_name
$function$;
