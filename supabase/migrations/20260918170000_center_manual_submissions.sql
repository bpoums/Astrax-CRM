-- Per-centre MANUAL volume.
--
-- WHY. `20260918160000` earlier today gave the centre function an all-origin
-- total, and the Overview started drawing centre rows that counted live and
-- manual leads together. That lost the question the panel existed to answer:
-- which centre an uploaded lead came from. The panel is being split into two
-- columns — Live with its centres, Manual with its centres — and the right-hand
-- column needs a figure of its own.
--
-- It could have been derived in the browser as `total_submissions_all -
-- total_submissions`, which is exactly equal. It is a named column instead so
-- that "manual leads from this centre" is something the database says rather
-- than something the client infers — the subtraction would go quietly wrong the
-- day anybody changed what `total_submissions` counts.
--
-- Second DROP/CREATE of this function today. One migration would have done had
-- the layout been settled first; both are checked in rather than squashed,
-- because the live database has already run the first.
--
-- Same mechanics as before: DROP + CREATE because the return type changes,
-- SECURITY INVOKER so every figure stays scoped by the caller's own RLS, and
-- the grants restored at the bottom because DROP takes them with it.

drop function if exists public.submission_totals_by_center_range(integer, date, date);

create function public.submission_totals_by_center_range(
  p_days integer default null,
  p_start_date date default null,
  p_end_date date default null
)
returns table(
  center_id uuid,
  center_name text,
  sort_order integer,
  total_submissions bigint,
  approved bigint,
  declined bigint,
  pending bigint,
  awaiting_manager bigint,
  total_submissions_all bigint,
  -- Everything this centre took that nobody closed live: validator submissions
  -- and approved uploads. By construction
  -- `total_submissions + manual_submissions = total_submissions_all`.
  manual_submissions bigint
)
language sql
stable
set search_path to 'public'
as $function$
  with b as (select * from reporting_window(p_days, p_start_date, p_end_date))
  select c.id, c.name, c.sort_order,
    count(s.id) filter (where s.archived_at is null
                          and s.submitted_by_role = 'closer' and s.source = 'live'),
    count(s.id) filter (where s.archived_at is null
                          and s.submitted_by_role = 'closer' and s.source = 'live'
                          and s.disposition = 'accepted'),
    count(s.id) filter (where s.archived_at is null
                          and s.submitted_by_role = 'closer' and s.source = 'live'
                          and s.disposition = 'declined'),
    count(s.id) filter (where s.archived_at is null
                          and s.submitted_by_role = 'closer' and s.source = 'live'
                          and s.disposition = 'pending'),
    count(s.id) filter (where s.archived_at is null
                          and s.submitted_by_role = 'closer' and s.source = 'live'
                          and s.status = 'pending_manager' and s.disposition is null),
    count(s.id) filter (where s.archived_at is null
                          and s.status <> 'pending_import_approval'),
    count(s.id) filter (where s.archived_at is null
                          and s.status <> 'pending_import_approval'
                          and not (s.submitted_by_role = 'closer' and s.source = 'live'))
  from centers c
  cross join b
  left join submissions s
    on s.center_id = c.id
   and (b.since is null or s.created_at >= b.since)
   and (b.until is null or s.created_at < b.until)
  where c.active
  group by c.id, c.name, c.sort_order
  order by c.sort_order
$function$;

grant execute on function public.submission_totals_by_center_range(integer, date, date)
  to public, anon, authenticated, service_role;
