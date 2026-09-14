# CX (customer-lifecycle) workspace

## Purpose
Track what happens to a sale *after* it's accepted, across four independent
dimensions (policy, premium, commission, chargeback), and route a policy
that didn't stand back to the manager for another attempt.

## Current status
**Partially built.** Of the four tabs in the CX workspace, only one —
Customers Pipeline — is implemented. The other three are routed, guarded,
and navigable, but render a literal "Coming soon" placeholder
(`CxPlaceholder` in `src/components/cx-shell.tsx`). This is a genuine,
current gap, not a hypothetical one — confirmed by reading the route/tab
code directly.

## Roles involved
**cxa**, **cxm** (work the pipeline, set statuses, tag leads), **admin**
(same access, plus manages the status/tag vocabulary), **manager**,
**closing_manager**, **general_manager** (read-only visibility into CX data
where their own screens embed it — see below).

## Routes / screens
- `/cx` → `src/routes/_authenticated/cx/route.tsx` (layout,
  `requireRole(["cxa","cxm","admin"])`) → `src/routes/_authenticated/cx/index.tsx`,
  which renders all four pipelines as `?tab=` switches on **one** URL:
  `customers` (built), `transfer`/`chargeback`/`analytics` (placeholders).
- `/cx/analytics`, `/cx/chargeback`, `/cx/transfer` still exist as routes,
  but each is now just a redirect to `/cx?tab=...` — kept only so an old
  bookmark/link doesn't 404.
- Admin also reaches the built pipeline read-only via `/admin?tab=pipeline`.

## Important components
`cx-shell.tsx` (`CxShell`, `CxTabs`, `CxPlaceholder`), `customers-pipeline.tsx`
(`CustomersPipeline`, the only built pipeline), `cx-status-admin.tsx`
(vocabulary management), `cx-status-breakdown.tsx` + `cx-status-cell.tsx`
(the editable/read-only status controls, shared by every screen that shows a
CX status), `src/lib/cx-status.ts` (categories, tones, the reopen-code list).

## Database
Tables: `cx_status_options`, `cx_lead_status`, `cx_status_history`,
`cx_tags`, `submission_tags` (0 rows in production — effectively unused so
far). Views: `cx_pipeline`, `cx_status_summary`, `cx_untouched`,
`closer_lead_alerts`. RPCs: `set_cx_status`, `return_lead_for_validation`,
`add_submission_tag`, `remove_submission_tag`. Full detail in
[database.md](../database.md).

## Business rules
- **Four independent dimensions** — `set_cx_status` writes exactly one
  category's columns per call; setting a policy status never touches
  premium/commission/chargeback, and **none** of the four touch
  `submissions.status`/`disposition` — not even policy, as of 2026-09-12 (see
  below). A status change and returning a lead are two separate decisions now.
- **"Return For Validation" is the only way a lead leaves the pipeline** —
  a standalone button (`ReturnForValidationButton` in
  `src/components/cx-status-cell.tsx`), its own column in the Customers
  Pipeline table, calling `return_lead_for_validation(p_sub, p_reason?)`.
  cxa/cxm/admin, on any lead currently `disposition='accepted'` and not
  archived, regardless of what its four CX statuses currently read. Resets
  the same fields the old auto-reopen did: `status='pending_manager'`,
  `disposition`/`disposed_*`/`assigned_*`/`final_carrier_id`/`agent_name`/
  `policy_number` all cleared, `reopened_from_cx_at` stamped. See
  [decisions/0004](../decisions/0004-only-accepted-is-terminal.md), which
  this superseded the auto-reopen part of.
- **The manager's Operations queue must admit a reopened lead regardless of
  `submitted_by_role`** — `submitted_by_role` is permanent lineage and is
  never cleared on reopen, so a validator-submitted lead sent back via
  "Return For Validation" still reads `submitted_by_role='validator'`.
  `manager.tsx`'s queue query (`src/routes/_authenticated/manager.tsx`)
  admits it anyway via `reopened_from_cx_at.not.is.null` in its `.or(...)`
  filter — without that clause the row is silently invisible to every
  manager despite being correctly `pending_manager` in the database. This was
  a real bug, found and fixed 2026-09-12.
- **A reopened lead gets its own Operations tab, not a spot in Live/Manual**
  — the Operations queue is three tabs (Live, Manual, **CXA Returned**), and
  `queueTabOf()` in `manager.tsx` puts any row carrying `reopened_from_cx_at`
  into CXA Returned regardless of its original `source`, so it stops
  appearing in whichever origin tab it started in. That tab's own columns mix
  both origins (`sourceLabel()` for which one, `closerName()` for who handled
  it) and add a "Returned" column (`relativeTime(row.reopened_from_cx_at)`)
  — the thing that tab specifically answers. Added 2026-09-14.
- **No vocabulary delete, only deactivate** — `cx_status_options` and
  `cx_tags` rows are FK-referenced by history/lead-status tables; the admin
  UI has no delete control for either, only `active` toggling.
- **`showUpdatedBy` is admin-only for a structural reason, not a permission
  choice**: `cx_pipeline` is a `SECURITY INVOKER` view, so its embedded
  "who last updated this" join resolves under the *reader's own* RLS on
  `profiles` — a CXA can only read their own profile row, so the column
  would render correctly for their own edits and blank for a colleague's.
  An admin can read every profile, so the column resolves fully. This is why
  `showUpdatedBy` is passed `true` only from the admin-mounted instance.
- Read-only mounts of CX status (`closing-desk.tsx`, `draft-date-desk.tsx`)
  use a **different, plain read-only display component**
  (`CxLeadStatusValue`) than the editable one (`CxStatusCell`) — there is no
  editable control anywhere outside the `/cx` workspace and the admin
  Pipeline tab (which is explicitly passed `readOnly`).

## Known limitations
- Three of four pipelines are "Coming soon" — Transfer, Chargeback,
  Analytics have no query, no table beyond what the vocabulary/history
  tables already support, and no UI beyond the placeholder text.
- `submission_tags` has 0 rows in production despite the RPCs
  (`add_submission_tag`/`remove_submission_tag`) and the `cx_tags` vocabulary
  existing and being populated (2 tags) — the tagging feature appears wired
  end-to-end but not yet used, or not yet exposed anywhere a CXA would find
  it (no confirmed UI mount for tag-adding was found in the files read
  during this audit).

## Future work
Building out the Transfer, Chargeback, and Analytics pipelines is the
clearest, most concrete piece of unfinished work found anywhere in this
codebase during the audit.
