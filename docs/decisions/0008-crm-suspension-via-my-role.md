# 0008 — CRM-wide suspension folded into `my_role()`, not into every policy

## Status
Current, added 2026-09-29.

## Context
Ahead of commercializing ASTRAX, an admin needed a global kill switch:
suspend the whole app for every non-admin role, timed (auto-resume) or
manual (indefinite), with affected users force-signed-out and shown why.

The naive implementation would edit every RLS read policy and every RPC
guard to also check a suspension flag — dozens of call sites, and a pattern
this codebase has already paid for once: `docs/database.md` describes
`~20 existing RPCs` still needing the NULL-role fix from
`20260927100000_fix_null_role_auth_bypass.sql` precisely because a guard
written by hand in many places drifts out of sync.

## Decision
- `my_role()` — `select role from profiles where id = auth.uid() and active`
  — is the one function nearly every RLS policy and RPC guard in the app
  already calls, and every one of those call sites already treats a `NULL`
  result as "no access" (that was the entire point of the 2026-09-27 fix:
  `is distinct from 'admin'`, `is null or ... not in (...)`). Individual
  deactivation already relies on this: `active = false` makes `my_role()`
  return `NULL`, which cascades through every policy with zero
  per-policy edits.
- This feature reuses exactly that mechanism instead of inventing a second
  one: `my_role()` now also returns `NULL` for a non-admin while
  `crm_suspension.suspended` is true and (`resumes_at` is null or still in
  the future), with `role = 'admin'` short-circuiting the check so the
  admin panel — and `set_crm_suspension` itself — keeps working while
  suspended. No other RLS policy or RPC guard needed editing.
- `crm_suspension` is a **new, dedicated table**, not a key in `app_config`.
  `app_config` has zero RLS policies by design (`docs/database.md`) and
  already holds a live secret (`sync_secret`); the suspension state needs
  the opposite shape — publicly readable, including by an anon/signed-out
  visitor, so a just-kicked user can still see the blocking message. Putting
  a public-read row in `app_config` would have meant splitting that table's
  access model; a new table keeps `app_config`'s deny-everything shape
  intact and gives `crm_suspension` exactly one policy (`for select using
  (true)`), with all writes still going through `set_crm_suspension`
  (`SECURITY DEFINER`, admin-only).
- The `my_role()` change alone does **not** force a sign-out — it only
  makes reads/writes fail the next time they're attempted, the same gap
  individual deactivation has today (a deactivated user stays logged in
  and just sees silently-empty screens). This was treated as a real gap to
  close, not to repeat: `AuthProvider` subscribes to `crm_suspension` via
  Supabase Realtime (the table is added to the `supabase_realtime`
  publication) and calls the existing `signOut()` the moment a non-admin
  session sees an active suspension, rather than waiting for the next
  request to come back empty.
- A pg_cron sweep (`clear-expired-suspension`, every minute, same cadence as
  the existing `expire-reviews` job) flips `suspended` back to `false` once
  `resumes_at` passes. This is cosmetic consistency only — `my_role()`
  compares `resumes_at` to `now()` directly, so enforcement never depends on
  the cron tick firing on time, the same belt-and-suspenders relationship
  `review_window()` already has with its own sweep.

## Consequences
- Suspending is a one-function change (`my_role()`) plus one new table and
  two RPCs — not a sweep across every table's RLS policy — so it can't drift
  out of sync with a policy added later the way the NULL-role bug did,
  provided every *future* policy/RPC keeps using `my_role()` rather than
  reading `profiles.role` directly (already the established convention).
- The one deliberate public-read RLS policy in the entire schema now lives
  on `crm_suspension`. It exposes only `suspended`/`resumes_at`/`message` —
  no PII, no operational data — so the exception is narrow and intentional,
  not a precedent for relaxing RLS elsewhere.
- Individual-user deactivation's own gap (no forced sign-out, no login
  block) is **not** fixed by this change — it's a separate mechanism
  (`profiles.active`) that happens to share the same `NULL`-cascade idea.
  Fixing it the same way `AuthProvider` now handles suspension is flagged
  in `docs/TODO.md` as follow-up work, not done here.
