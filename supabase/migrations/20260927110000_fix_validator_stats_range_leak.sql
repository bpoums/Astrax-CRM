-- Fix: validator_stats_range() hands every validator's record to any caller.
--
-- assigned/approved/declined/pending come from `submissions` and are
-- correctly scoped by the caller's RLS. timed_out/rejected/holds come from
-- `form_events`, whose SELECT policy lets manager/admin/closing_manager/
-- general_manager read every row with no centre scoping at all -- so those
-- three columns come back whole-business for a closing_manager/general_manager
-- caller even though their submissions-derived columns are correctly narrowed.
-- Verified live under a closing manager's JWT (docs/TODO.md, 2026-09-18).
--
-- The only caller today is `ReportingStats` on the manager's Reporting tab
-- (manager and admin only -- ClosingOverview explicitly does not fetch this
-- for the Closing Desk screen closing_manager/general_manager share). Both
-- admin and manager already see whole-business form_events by RLS design, so
-- restricting execution to admin/manager -- one of the two fixes docs/TODO.md
-- names explicitly -- closes the leak with no change in behaviour for either
-- role that actually uses it.
--
-- Converted from `language sql` to `language plpgsql` to add the guard;
-- the query itself is byte-for-byte the live definition.

create or replace function public.validator_stats_range(p_days integer default null::integer, p_start_date date default null::date, p_end_date date default null::date)
 returns table(validator_id uuid, validator_name text, staff_id text, assigned bigint, approved bigint, declined bigint, pending bigint, timed_out bigint, rejected bigint, holds bigint)
 language plpgsql
 stable
 set search_path to 'public'
as $function$
begin
  if my_role() is null or my_role() not in ('admin','manager') then
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

revoke execute on function public.validator_stats_range(integer, date, date) from anon;
