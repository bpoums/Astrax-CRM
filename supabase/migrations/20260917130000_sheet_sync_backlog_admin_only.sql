-- Make the Sheets sync backlog admin-only, and reachable the way everything
-- else on a zero-policy table is reached: through a role-checking RPC.
--
-- THE LEAK THIS CLOSES
--
-- `sheet_sync_queue` has RLS enabled with zero policies, deliberately, so the
-- client cannot reach it. But `sheet_sync_backlog` is a view over it with
-- `security_invoker` unset, so it runs as its owner and bypasses RLS - and it
-- carried GRANT SELECT to `anon` and `authenticated`. Verified directly before
-- this migration:
--
--     as anon:           select * from sheet_sync_queue    -> 0 rows (RLS holds)
--     as anon:           select * from sheet_sync_backlog  -> queued = 13
--
-- So queue depth, in-flight and stuck counts, and a raw Apps Script error
-- string were readable by anyone holding the publishable key, which ships in
-- the browser bundle. Not customer data, but precisely what the zero-policy
-- design exists to prevent.
--
-- Nothing in src/ or supabase/functions/ selected from the view, so revoking
-- breaks no caller. The view itself is kept for SQL and ops use.
--
-- The replacement follows the pattern CLAUDE.md and decisions/0001 mandate: a
-- SECURITY DEFINER function that re-checks the caller's role itself. A
-- zero-policy table is never opened up by widening RLS or by granting on a
-- definer view.
--
-- TWO TRAPS, both hit while building this and both verified live
--
-- 1. `if my_role() <> 'admin' then raise` DOES NOT GUARD. `my_role()` returns
--    NULL for a caller with no profile, no JWT, or an INACTIVE profile, and
--    `NULL <> 'admin'` is NULL, not true - so the IF never fires and the
--    function returns its data. Measured: calling this with no JWT at all
--    returned the backlog. It must be `is distinct from`, which is true for
--    NULL. (The same bug exists in ~20 pre-existing RPCs, including
--    `admin_settings` and `reporting_retention_status`, which were both
--    confirmed returning data to `anon`. Reported separately - not fixed here.)
--
-- 2. `revoke ... from public` DOES NOT REMOVE anon's EXECUTE. Supabase's
--    default privileges grant EXECUTE on new public-schema functions directly
--    to `anon` and `authenticated`, and revoking from PUBLIC does not touch a
--    direct grant. `anon` must be named explicitly.
--
-- Neither trap announces itself: both fail open and look like a working guard.

revoke all on public.sheet_sync_backlog from anon, authenticated;

create or replace function public.sheet_sync_backlog_status()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v record;
begin
  -- `is distinct from`, never `<>` - see trap 1 above. NULL is distinct from
  -- 'admin', so a caller with no role is refused rather than waved through.
  if my_role() is distinct from 'admin' then raise exception 'not authorized'; end if;

  select * into v from sheet_sync_backlog;

  return jsonb_build_object(
    'queued',         coalesce(v.queued, 0),
    'in_flight',      coalesce(v.in_flight, 0),
    -- attempts >= 5: failing repeatedly rather than merely waiting a turn.
    'struggling',     coalesce(v.struggling, 0),
    'oldest_seconds', coalesce(v.oldest_seconds, 0),
    -- The Apps Script error off a struggling row, so the reader learns WHY
    -- without needing SQL access. Null when nothing is struggling.
    'sample_error',   v.sample_error
  );
end $function$;

comment on function public.sheet_sync_backlog_status() is
  'Admin-only Sheets sync queue health. Raises ''not authorized'' otherwise. '
  'Backs the Overview card required by decisions/0006 - an unwatched queue is '
  'the same failure as a silent drop, just slower.';

-- `anon` named explicitly - see trap 2 above; revoking from PUBLIC alone
-- leaves Supabase's default direct grant in place.
revoke all on function public.sheet_sync_backlog_status() from public, anon;
grant execute on function public.sheet_sync_backlog_status() to authenticated;
