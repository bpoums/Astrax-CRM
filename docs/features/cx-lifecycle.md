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
(same access, plus manages the status/tag vocabulary), **closing_manager**
(read-only visibility into CX data where its own screen embeds it — see
below). **manager** and **general_manager** also have read-only visibility
into CX data the same way, **plus** (added 2026-09-25) can apply/remove a
`submission_tags` tag on an accepted lead from their own screens
(`ReportingDashboard` for manager, `ClosingDesk` for general_manager) — the
one CX-pipeline write either role can make, since everything else about
the pipeline (statuses, removal, return-for-validation) stays cxa/cxm/admin
only.

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
CX status), `src/lib/cx-status.ts` (categories, tones, the reopen-code list),
`submission-tags.tsx` (`SubmissionTags`, added 2026-09-25 — the first UI
mount of the `cx_tags`/`submission_tags` system. Chip-toggle list of the
active `cx_tags`, calling `add_submission_tag`/`remove_submission_tag`. A
tag whose `allows_duplicate_ssn` is set does more than label the lead:
applying it exempts that lead's SSN from the block `submit_form_internal`
otherwise raises on a repeat submission — see
[closer-submission-and-forms.md](closer-submission-and-forms.md) and
[decisions/0007](../decisions/0007-duplicate-ssn-blocks-unless-tagged.md).
Mounted in three places: the Customers Pipeline detail sheet (cxa/cxm/admin,
editable), `ReportingDashboard`'s detail sheet (admin/manager, editable;
read-only for anyone else who reaches Reporting), and `ClosingDesk`'s
detail sheet (general_manager only, gated in-component —
`closing_manager` shares that screen but is not granted this). Every mount
only renders for a lead that's `disposition === "accepted"`, matching what
`add_submission_tag` itself requires.

## Database
Tables: `cx_status_options`, `cx_lead_status`, `cx_status_history`,
`cx_tags` (now including `allows_duplicate_ssn`, see below),
`submission_tags`. Views: `cx_pipeline`, `cx_status_summary`, `cx_untouched`,
`closer_lead_alerts`. RPCs: `set_cx_status`, `return_lead_for_validation`,
`add_submission_tag`, `remove_submission_tag`. Full detail in
[database.md](../database.md).

## Business rules
- **Four independent dimensions** — `set_cx_status` writes exactly one
  category's columns per call; setting a policy status never touches
  premium/commission/chargeback, and **none** of the four touch
  `submissions.status`/`disposition` — not even policy, as of 2026-09-12 (see
  below). A status change and returning a lead are two separate decisions now.
- **The pipeline is "a lead CX has not finished with", not "an accepted
  lead"** — as of 2026-09-16 its membership rule is `archived_at is null and
  cx_removed_at is null and (disposition = 'accepted' or reopened_from_cx_at
  is not null)`, spelled in the `cx_pipeline` view, the `cxa`/`cxm` branches
  of the `submissions` RLS policy, and the helper `cx_pipeline_member(p_sub)`
  that every CX RPC guards on. See
  [decisions/0005](../decisions/0005-cx-queue-retention-and-removal.md).
- **"Return For Validation" no longer removes the lead from the pipeline** —
  a standalone button (`ReturnForValidationButton` in
  `src/components/cx-status-cell.tsx`), its own column in the Customers
  Pipeline table, calling `return_lead_for_validation(p_sub, p_reason?)`.
  cxa/cxm/admin, on any lead currently `disposition='accepted'`, not archived
  and not CX-removed, regardless of what its four CX statuses currently read.
  Resets the same fields the old auto-reopen did: `status='pending_manager'`,
  `disposition`/`disposed_*`/`assigned_*`/`final_carrier_id`/`agent_name`/
  `policy_number` all cleared, `reopened_from_cx_at` stamped. See
  [decisions/0004](../decisions/0004-only-accepted-is-terminal.md), which
  this superseded the auto-reopen part of.
  Because `reopened_from_cx_at` survives, the lead **stays on the CXA's
  queue** through the whole re-validation round. Its row shows an
  "In Validation" chip where the Return button was — the RPC would refuse a
  second send anyway, since the lead no longer has a disposition — and its
  four statuses stay editable throughout. `inValidation()` in
  `customers-pipeline.tsx` is the one place that decides this
  (`reopened_from_cx_at` set and `disposition <> 'accepted'`).
- **A lead leaves the pipeline only when a CXA removes it** —
  `RemoveFromQueueButton` → `remove_from_cx_pipeline(p_sub, p_reason?)`
  (cxa/cxm/admin) stamps `cx_removed_at`/`cx_removed_by` and writes a
  `cx_removed` event. This is **not** an archive: the lead stays in
  reporting, exports, the manager's queue and its own history, and none of
  the columns `notify_sheet_sync()` watches change, so no Google Sheets write
  fires. `restore_to_cx_pipeline(p_sub)` (admin only) undoes it; the admin's
  Pipeline tab carries the `RemovedFromPipeline` panel that lists removed
  leads and restores one.
- **The pipeline's carrier column is the FINAL carrier** (2026-09-17). It used
  to render `carrierName(payload)` — the carrier as typed on the intake form,
  which for a closer or an uploaded lead is only a *proposal*. Two things were
  wrong with that: a team servicing a live policy needs to know who actually
  wrote it, and an uploaded lead carries no carrier text in its payload at all
  (1 of 25 live), so the column was blank for exactly the leads whose carrier
  was already known — in `final_carrier_id`, which the view did not select.
  `cx_pipeline` now carries `submitted_by_role`, `final_carrier_id`,
  `final_carrier_name`, `agent_name` and `policy_number`, and the column calls
  the shared `finalCarrierName()` from `ops.tsx`, which resolves both storage
  shapes (the FK for a reviewed lead, `payload->>'Agency'` for a validator's
  own submission, which never gets the FK). Of 412 pipeline leads today 360
  resolve a real final carrier. The 52 that have none show their **proposal,
  muted and marked "· proposed"** with a tooltip saying so, rather than a dash
  — losing the text would take information off a screen that had it. The search
  box follows the column: `final_carrier_name` is one more clause in its `or`
  group, so a carrier that is only a stamped FK is still findable by name.
- **The detail sheet has a read-only "Filled By Validator" panel** — Final
  Carrier, Agent Name, Policy Number, sitting directly under Lead Details
  because it reads as the rest of the same record: what the validator added to
  what the closer typed. Read-only on purpose: `set_validator_fields` does not
  accept a CX role, and `ValidatorFields` (`src/components/validator-fields.tsx`)
  is the editor for the roles that do. For a validator-submitted lead the agent
  and policy live in `payload` rather than in the columns, so each falls back to
  the payload value before showing a dash — without that the panel would read
  empty on 191 of today's 412 leads.
- **The Draft Date column reads an uploaded lead's arrangement** (2026-09-17).
  `draft_date` is derived from the payload on import now — it never was before,
  which is why the column was blank on every uploaded lead — and an uploaded
  lead usually states a recurrence ("3rd of the month") rather than a date. That
  is resolved to its next real occurrence, so the cell keeps the original
  wording in its title rather than presenting a worked-out date as something an
  operator wrote. Text that resolves to no single date (`Every 2nd Friday`) is
  shown as written. See
  [decisions/0006](../decisions/0006-recurring-draft-dates-resolved.md) and
  [spreadsheet-import.md](spreadsheet-import.md).
- **A CXA can correct the lead they are servicing** — the detail sheet mounts
  the same `LeadPayload` editor a manager uses (per-field
  `update_payload_field`, one `payload_edits` before/after row each) and an
  editable `PaymentPanel` for the four bank-draft fields
  (`update_payment_field`). Both RPCs gained `cxa`/`cxm`, and for those two
  roles only they also require `cx_pipeline_member()`. **Card number and CVV
  are unchanged and remain admin-only** — the same line that refuses a
  manager refuses a CXA, and neither field is ever rendered as an input in
  the CX workspace.
- **The manager's Operations queue must admit a reopened lead regardless of
  `submitted_by_role`** — `submitted_by_role` is permanent lineage and is
  never cleared on reopen, so a validator-submitted lead sent back via
  "Return For Validation" still reads `submitted_by_role='validator'`.
  The reason the CXA typed reaches the manager too, as of 2026-09-16: it is
  stored only as the `reopened_from_cx` event's `detail->>'reason'`, and the
  Operations queue batches those events for its CXA Returned tab, showing them
  in a clamped Reason column and in full at the top of the detail sheet (see
  [validation-queue.md](validation-queue.md)). The same sheet now opens
  `LeadHistoryDialog`, so a manager can read the CX lifecycle of the lead they
  are about to reassign.
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

## Future work
Building out the Transfer, Chargeback, and Analytics pipelines is the
clearest, most concrete piece of unfinished work found anywhere in this
codebase during the audit.
