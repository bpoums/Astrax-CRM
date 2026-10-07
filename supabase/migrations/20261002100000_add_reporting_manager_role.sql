-- New role: reporting_manager. Read-only access to business-wide reporting
-- (Sales Breakdown, All-time Submissions, Submissions Outcome, L.A.
-- Operations, Validators Team Dashboard) — no lead-editing RPCs are granted
-- to it anywhere.
--
-- Postgres will not let a freshly added enum value be referenced (in a CASE,
-- a function body, etc.) inside the same transaction that added it, so this
-- is its own migration file; the RLS/RPC grants that actually use the value
-- live in the migration that follows this one.
alter type app_role add value if not exists 'reporting_manager' after 'general_manager';
