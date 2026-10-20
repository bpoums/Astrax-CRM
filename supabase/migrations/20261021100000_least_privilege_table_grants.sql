-- Least-privilege Data API grants on public tables and views.
--
-- Until now every public table carried the Supabase blanket grant
-- (anon + authenticated: all privileges), so row level security was the only
-- thing between the API and the data - and RLS does not cover TRUNCATE or
-- REFERENCES at all. This brings the grants in line with the access model
-- (docs/decisions/0001, 0002): RLS scopes reads, SECURITY DEFINER RPCs do the
-- writes, and only six admin-managed tables are written directly by the client.
--
-- Also makes the 2026-10-30 Supabase change (no automatic grants on new tables)
-- a non-event: new tables get nothing until their migration grants it.
--
-- Not touched: SECURITY DEFINER RPCs, triggers, pg_cron (run as the owner) and
-- edge functions (service_role).

-- 1. Start from nothing for the two client roles.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

-- 2. Signed-in users may read; RLS (or security_invoker views) scopes the rows.
grant select on all tables in schema public to authenticated;

-- 3. Server-side-only tables: no client read at all (no reads in src/).
--    sheet_sync_backlog was already closed to both roles.
revoke select on public.center_api_keys,
                      public.sheet_sync_queue,
                      public.sheet_sync_attempts,
                      public.sheet_sync_backlog
  from authenticated;

-- 4. The only direct client writes: admin screens, each behind an admin-only
--    FOR ALL policy (carrier/center/cx-status/transfer-client/user admin, tags).
grant insert, update, delete on
  public.carriers,
  public.centers,
  public.cx_status_options,
  public.cx_tags,
  public.transfer_clients,
  public.profiles
  to authenticated;

-- 5. Edge functions and server jobs keep full access.
grant all on all tables in schema public to service_role;

-- 6. Future tables: no automatic grant to the client roles. Each migration that
--    creates a table must grant explicitly (see CLAUDE.md).
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

do $$
begin
  alter default privileges for role supabase_admin in schema public
    revoke all on tables from anon, authenticated;
exception when others then
  raise notice 'supabase_admin default privileges not changed: %', sqlerrm;
end $$;
