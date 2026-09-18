-- All-origin outcome and centre totals.
--
-- WHY. `submission_totals_range` counted dispositions with
-- `submitted_by_role = 'closer' AND source = 'live'` hardcoded into the
-- `approved`/`declined`/`pending` filters, while its INTAKE columns
-- (closer/validator/offline) counted everything. The admin Overview draws both
-- side by side, so it reported 183 Submitted against 351 Live + 243 Manual
-- taken in — where the business has actually sold 386. Its acceptance ring read
-- 74% where all origins give 84%. The Sales Breakdown tab has always counted
-- `disposition = 'accepted'` with no origin filter, so the two admin screens
-- disagreed and the Overview was the wrong one.
--
-- `submission_totals_by_center_range` carried the same two conditions in its
-- left join, which is the only reason manual leads could not be broken down by
-- centre. They always could: every manual lead carries a `center_id`
-- (41/41 uploaded, 202/202 validator as of today).
--
-- WHAT. Both functions keep every existing column with its existing meaning and
-- gain origin-agnostic ones alongside. Nothing that reads the old columns
-- changes behaviour.
--
-- Both are DROP + CREATE rather than CREATE OR REPLACE because the return type
-- changes, which REPLACE cannot do. Dropping a function DROPS ITS GRANTS, so
-- they are restored at the bottom exactly as they were (public, anon,
-- authenticated, postgres, service_role on both). `anon` holding EXECUTE is a
-- pre-existing exposure tracked in docs/TODO.md; it is deliberately not altered
-- here, because this migration is about one wrong number and should not quietly
-- change who can call what.
--
-- Both stay SECURITY INVOKER, so every figure is still scoped by the caller's
-- own RLS: a closing manager gets their centre, a general manager gets all of
-- them, and nothing here widens what anybody can read.

drop function if exists public.submission_totals_range(integer, date, date);

create function public.submission_totals_range(
  p_days integer default null,
  p_start_date date default null,
  p_end_date date default null
)
returns table(
  closer_submissions bigint,
  validator_submissions bigint,
  offline_submissions bigint,
  approved bigint,
  declined bigint,
  pending bigint,
  in_review bigint,
  awaiting_manager bigint,
  timeouts bigint,
  rejections bigint,
  -- The same three dispositions over EVERY origin. `pending_import_approval`
  -- is excluded so an unapproved import batch contributes nothing, which is the
  -- rule `offline_submissions` already applies and the one CLAUDE.md states:
  -- those rows appear nowhere until a batch is accepted.
  approved_all bigint,
  declined_all bigint,
  pending_all bigint
)
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
        and (b.until is null or e.created_at < b.until)),
    count(*) filter (where s.disposition = 'accepted'
                       and s.status <> 'pending_import_approval'),
    count(*) filter (where s.disposition = 'declined'
                       and s.status <> 'pending_import_approval'),
    count(*) filter (where s.disposition = 'pending'
                       and s.status <> 'pending_import_approval')
  from submissions s, b
  where s.archived_at is null
    and (b.since is null or s.created_at >= b.since)
    and (b.until is null or s.created_at < b.until)
$function$;

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
  -- That centre's leads of every origin, live and manual.
  total_submissions_all bigint
)
language sql
stable
set search_path to 'public'
as $function$
  with b as (select * from reporting_window(p_days, p_start_date, p_end_date))
  select c.id, c.name, c.sort_order,
    -- The origin test moved OFF the join and into these filters. The join has
    -- to see manual rows for `total_submissions_all` to exist at all, and each
    -- existing column re-applies the condition it used to get from the join —
    -- so every one of them returns exactly what it returned before.
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
                          and s.status <> 'pending_import_approval')
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

-- Restored verbatim: DROP took the originals with it.
grant execute on function public.submission_totals_range(integer, date, date)
  to public, anon, authenticated, service_role;
grant execute on function public.submission_totals_by_center_range(integer, date, date)
  to public, anon, authenticated, service_role;
