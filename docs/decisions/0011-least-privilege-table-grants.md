# 0011 — Least-privilege Data API grants; RLS is no longer the only barrier

## Status
Current, applied 2026-10-21 (`20261021100000_least_privilege_table_grants.sql`, run by hand in the SQL editor).

## Context
Every `public` table carried Supabase's blanket grant: `anon` and `authenticated` held all privileges, including
`INSERT/UPDATE/DELETE/TRUNCATE`, on ~25 tables (`submissions`, `profiles`, `payment_details`, `card_access_log`,
`center_api_keys`, ...). RLS was the only control, and RLS does not cover `TRUNCATE` or `REFERENCES`. Checked live
2026-10-20. The documented model (ADR 0001/0002) is that writes go through `SECURITY DEFINER` RPCs, with six
admin-managed tables as the only direct client writes.

Supabase also stops auto-granting API access on new `public` tables from 2026-10-30, so new tables need explicit
grants anyway.

## Decision
- `anon`: no table or view privileges at all.
- `authenticated`: `SELECT` on everything except server-only tables (`center_api_keys`, `sheet_sync_queue`,
  `sheet_sync_attempts`, `sheet_sync_backlog`). `INSERT/UPDATE/DELETE` only on `carriers`, `centers`,
  `cx_status_options`, `cx_tags`, `transfer_clients`, `profiles` (each behind an admin-only `FOR ALL` policy).
- `service_role`: unchanged (all).
- Default privileges for `postgres` (and `supabase_admin` where permitted) no longer grant new tables to
  `anon`/`authenticated`; each migration grants explicitly.

## Consequences
- A forgotten or wrong RLS policy no longer exposes a table to `anon`, and `TRUNCATE` is unreachable from the API.
- Adding a client-written table means adding both an RLS policy **and** a grant, deliberately.
- Rollback: re-grant `all` on all public tables to `anon`/`authenticated` (see the migration's header notes).
