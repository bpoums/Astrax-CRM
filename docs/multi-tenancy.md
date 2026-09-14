# Multi-tenancy

**Short answer: this is not a multi-tenant application.** There is one
Supabase project, one schema, one set of tables, and no `tenant_id` concept
anywhere. Everything described below is a single-tenant app with an internal
**center**-based scoping mechanism for one specific role — worth documenting
precisely so nobody mistakes "centers" for tenant isolation, which it is not.

## What a "center" actually is

`centers` (table, 2 active rows in production: **UMS BPO**, **DESCOM**) is a
plain admin-managed vocabulary table — `id, name, active, sort_order` — with
no RLS-driven data partition of its own. Nothing about it resembles a tenant:
there's no per-center schema, no per-center storage bucket, no per-center
auth realm, and every role except `closing_manager` can see across every
center simultaneously.

Two columns carry the link, and they mean different things:

- **`profiles.center_id`** — which center a *person* belongs to. Only read by
  the `submissions` RLS policy, and only for the `closing_manager` branch (see
  below) — every other role in `CENTER_ROLES` stores it for display/roster
  purposes only, read by nothing server-side. Set by an admin directly
  (`profiles` is the one table with a client-reachable direct write policy —
  see [decisions/0001](decisions/0001-rls-as-the-only-boundary.md)). Required
  (`center_id NOT NULL` is not enforced at the DB level, but `centerRequired()`
  in `src/lib/centers.ts` demands one at invite time) for `closer`,
  `closing_manager`, `data_uploader`, and `validator`. A `closing_manager`
  with no `center_id` set sees **nothing at all** — the closing desk says so
  explicitly rather than showing the generic "no leads yet" empty state. A
  `validator` or `data_uploader` with no `center_id` set is unaffected
  functionally; it's just a blank roster field (`validator` added to
  `CENTER_ROLES` 2026-09-15 — see
  [features/user-management.md](features/user-management.md)).
- **`submissions.center_id` / `submissions.center_name`** — the center a
  *lead* was taken in, stamped once at `submit_form()` time from the
  submitting closer's own `profiles.center_id`/center name at that moment.
  `center_name` is a frozen copy, not a live join — renaming a center in
  Settings, or moving a closer to a different center later, does not rewrite
  history on leads already submitted. Every screen that shows a lead's
  center reads this stamped `center_name`, never `centers.name` through a
  live join.

## The one place scoping actually happens: the `submissions` RLS policy

From the live policy (`submissions read scoped`, see
[database.md](database.md#row-level-security-summary)):

```sql
WHEN 'closing_manager' THEN (
  submitted_by_role = 'closer'
  AND archived_at IS NULL
  AND center_id IS NOT NULL
  AND center_id = (SELECT p.center_id FROM profiles p WHERE p.id = auth.uid())
)
WHEN 'general_manager' THEN (
  submitted_by_role IN ('closer', 'validator')
  AND archived_at IS NULL
)
```

`closing_manager` is the **only** role scoped by center at all. Every other
role — including `general_manager`, despite sharing the exact same screen and
component as `closing_manager` — sees across every center. This is
deliberate: a general manager's job spans centers by definition; a closing
manager's does not.

No other table in the schema has any center-scoping in its RLS policy.
Carriers, CX status options, admin settings, etc. are global — a center is
never a partition boundary for anything except this one role's view of
`submissions`.

## What this means architecturally

- Adding a third center is a pure data operation (insert a `centers` row,
  assign closers to it) — no code or deploy required.
- Adding a role that should be center-scoped requires adding it to
  `CENTER_ROLES` in `src/lib/centers.ts` **and** adding a matching `WHEN`
  branch to the live `submissions` RLS policy — the client-side constant
  alone grants nothing (see [authentication.md](authentication.md)).
- If this product ever needed real multi-tenancy (separate customers who
  must never see each other's data at all, including vocabulary tables like
  `carriers`/`cx_status_options`), the current center mechanism would not
  provide it — it only scopes one table for one role. That would be new,
  cross-cutting work, not an extension of what exists today.

## Future work / known gaps

- `general_manager` seeing every center is documented here as intentional,
  but it does mean there is currently no role that sees "every closer lead,
  but only across a subset of centers larger than one" — the model is binary
  (one center, or all of them).
- No feature currently reports metrics *by* center for roles other than
  admin (`submission_totals_by_center` exists as a view/RPC, but its only
  confirmed consumer is `ReportingStats` when `showValidatorSubmissions` is
  true, i.e. the admin Overview — see
  [features/reporting.md](features/reporting.md)).
