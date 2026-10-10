# Changelog

## 2026-10-10 — Transfer clients belong to a center; the Overview shows them under it

External transfer clients are now linked to a center (both existing ones to UMS BPO; future clients
can belong to other centers). In the Overview's Live | Manual card, a center with clients breaks its
Live number down: **UMS BPO 594 = In House 574 + Orbit 18 + Top Dawg 2**. The client numbers are leads
*still parked* that were submitted in the selected period, so they follow the date chips and In House
always adds up. This replaces the earlier "Parked with clients" footer (`ParkedClientsStrip` removed).
- **Settings → Transfer Clients:** a Center select on the add form and in the table ("Any center" = offered
  to every center). **External Transfer dialog:** a closer is offered only their own center's clients, and
  `submit_form_parked` enforces it server-side (verified in a rolled-back test: another center's client is
  refused, own-center and unlinked clients work).
- **Database** (`20261010140000_transfer_clients_center.sql`, applied live): `transfer_clients.center_id`
  (backfilled to UMS BPO), `parked_client_counts_range()`, `submit_form_parked` center check. `types.ts`
  regenerated (additive).
- Code: `overview-panels.tsx`, `admin-overview.tsx`, `parked-leads.tsx`, `transfer-client-admin.tsx`,
  `transfer-client-dialog.tsx`, `lib/transfer-clients.ts`. Docs: `docs/database.md`,
  `docs/features/admin-settings-and-config.md`, `docs/features/reporting.md`.
- Names show as stored ("Orbit Insurance (Keller)", "Top Dawg Financial Group (Kwanii)"); an admin can
  rename a client in Settings.

## 2026-10-10 — Top cards count approved leads; "Sent back" gets its own card

The cards above the status cards counted the whole pipeline (800), mixing approved leads with leads
CX sent back to the manager. They are now: **Submitted leads 729** (approved; the Submission Outcome
figure), **In CX 132** (approved with at least one status), **Untouched 597** (approved with no status,
never entered CX), and a new **Sent back 71** card (with the manager for re-validation, not approved
again; "69 waiting for a manager"). 132 + 597 = 729 and 729 + 71 = 800, every row of the table, and the
table's Approved / Sent back chips read 729 / 71. The Overview's "CX coverage" card follows (132 / 729).
- Database: `20261010130000_cx_untouched_approved_only.sql` (applied live): `cx_untouched` reads
  `cx_pipeline` for the shared not-archived / not-removed rule and keeps an approved-only test. This
  supersedes the previous entry's `cx_untouched` change (598).
- Code: `cx-status-breakdown.tsx`, `lib/cx-overview.ts`. Docs: `docs/database.md`, ADR 0005,
  `docs/features/cx-lifecycle.md`.
- Unchanged: the four status cards still equal the table (all 800 rows), so the Policy header is 202
  (132 plus the 70 sent-back leads that kept statuses).

## 2026-10-10 — Sent-back leads are visible on the Customer Pipeline

The pipeline's 800 includes 71 leads CX sent back to the manager for re-validation, but nothing marked
them for an admin (the Return button that says so is the CXA's and is hidden from the read-only view).
Now, for every role that opens the table: a **"Sent back" badge** beside the customer name (tooltip: date
sent and current stage), a **stage filter** (All 800 / Approved 729 / Sent back 71, counts respecting the
other filters, run in the database), and the **Submitted leads** card caption reads
"729 approved + 71 sent back for validation" on both the Customer Pipeline tab and the Overview block.
729 is the Submission Outcome figure, and 800 = 729 + 71. The badge is hidden while the "Sent back"
filter is on (every row is one, so it only took room from the name). No database change.
- Code: `customers-pipeline.tsx`, `cx-status-breakdown.tsx`, `lib/cx-overview.ts`.
- Docs: `docs/features/cx-lifecycle.md`.

## 2026-10-10 — Status cards now equal the pipeline table (fix)

On the Customer Pipeline tab and the Overview's "Customer Policy Lifetime" block, the Policy Status
card said Approved = 86 while the table below, filtered to Approved, listed 73. The cards' view
(`cx_status_summary`) joined `submissions` with a LEFT JOIN that removed nothing, so it also counted
archived leads (12) and a lead CX had removed from its pipeline (1). It now joins `cx_pipeline`, the
same source as the table, so every card equals the table filtered to that status (checked: 0
mismatches over all 26 status options; Approved = 73, Policy header 217 → 202).
- Database: `20261010120000_cx_status_summary_matches_pipeline.sql` (applied live). Code: none.
- Docs: `docs/database.md`; `docs/decisions/0005` gets a dated amendment (it said the view keeps an
  accepted-only filter that, in fact, never applied).
- **Top cards aligned too** (`20261010121000_cx_untouched_matches_pipeline.sql`, applied live):
  `cx_untouched` (Untouched, and In CX = Submitted − Untouched) now reads `cx_pipeline` and returns
  the pipeline leads with no status, instead of its own accepted-only rule. Effect: 1 lead
  (Untouched 597 → 598, In CX 203 → 202, Submitted leads 800), so Submitted, Untouched, In CX, the
  status cards and the table all answer for the same leads. `closer_lead_alerts` unchanged.

## 2026-10-10 — Two fill rings instead of two "Missing info" badges

The two badges ("Missing info (6)" amber, "Missing bank info (5)" muted) did not fit beside a customer
name, so most uploaded rows in the Submissions list wrapped onto two lines. They are replaced by two
small rings (about 64px, one line): core fields in amber, banking in grey. Each ring fills with how
complete its group is and shows the number of fields still missing in the middle, so nothing needs
counting; a complete group shows a tick so the rings keep their positions. (A first attempt, one 3px
tick per field, was too small to read and was replaced.) Text label and a title naming the missing
fields; falls back to the two counts if the required list cannot be read. Same component name, so
every list (Submissions, manager queue, Closing Desk, Import history) updates with no call-site
change. The group totals come from one shared hook, `useUploadedRequiredFields()`, which the
uploader's review step also uses.
- Code: `missing-info.tsx`, new `lib/required-fields.ts`, `upload-review.tsx`. Database: none.
- Docs: `docs/features/spreadsheet-import.md`.

## 2026-10-10 — Banking panel in the Submissions detail

A lead's bank name, account number and routing number are stored in `payment_details`, not the
payload, and the admin Submissions detail had no panel for them — so a lead that was only missing
Account Title and Bank Type looked as if it had no bank details at all. The Banking panel
(`PaymentPanel`, editable) now sits under Lead details there, for admin and manager only (the roles
`payment_summary` accepts). Code: `reporting.tsx`. Database: none. Docs: `docs/features/spreadsheet-import.md`.

## 2026-10-10 — Banking in "Missing information" + missing-field count in the uploader's review

- **Banking fields are required for an uploaded lead** (Account Title, Bank Name, Bank Type, Routing
  Number, Account Number; card number / expiry / CVC stay optional) and tracked as a **separate group**,
  `submissions.missing_bank`, with its own muted "Missing bank info (N)" badge, so the core "Missing info"
  label stays useful (Account Title was empty on all 500 uploaded leads, Bank Type on 468). A manager, admin
  or general manager fills them in from the lead panel's new "Missing bank information" list; filters and
  counts mirror the core ones on Submissions → Manual, the manager Manual queue, the Closing Desk and
  Import history.
- **Uploader review step:** a "Missing required fields" panel, a per-row "Missing" cell and two filter
  chips show how many rows lack required fields *before* import, name the fields most often missing, and
  call out required fields with no mapped column. Live as cells are edited; informational, never blocks.
- **Permission change:** `update_payment_field` now also accepts `general_manager` (bank fields only; card
  number / CVV remain admin only). Its guard was rewritten fail-closed and `anon`'s EXECUTE revoked.
- **Database** (`20261010110000_missing_bank_info.sql`, `20261010111000_revoke_anon_update_payment_field.sql`,
  applied live): `uploaded_required_fields()` (single definition of all 20 fields), `missing_bank_fields()`,
  `submissions.missing_bank` + two triggers (backfilled; verified a bank edit enqueues no Sheets sync),
  `missing_bank_by_field()`. `types.ts` regenerated (additive).
- **Found, not fixed:** `payment_summary`, `update_payload_field` and `card_details` still run for an
  unauthenticated caller — see `docs/TODO.md` ("SECURITY — several SECURITY DEFINER RPCs still run for anon").
- Code: `missing-info.tsx`, `upload-review.tsx`, `lib/missing-upload.ts` (+ test), `manager.tsx`,
  `reporting.tsx`, `closing-desk.tsx`, `import-history.tsx`, `ops.tsx`. Docs: `CLAUDE.md`,
  `docs/database.md`, `docs/features/spreadsheet-import.md`, `docs/features/payments-security.md`,
  `docs/TODO.md`.

## 2026-10-10 — "Missing info" label on uploaded leads, fillable in place

Uploaded leads often arrive without required fields (draft date blank on 175 of 500, zip on 28,
state on 7; only 171 of 500 complete). They now carry an amber **Missing info (N)** badge, and
each lead's panel has a **Missing information** list where a manager, admin or (on the Closing
Desk) closing/general manager fills the gaps. Saves go through `update_payload_field`, so edits are
audited and `draft_date` / `ssn_normalized` are re-derived. Label only; nothing is blocked.
- Code: new `components/missing-info.tsx`; wired into `manager.tsx`, `reporting.tsx`,
  `import-history.tsx`, `closing-desk.tsx`.
- Docs: `docs/features/spreadsheet-import.md`.

## 2026-10-10 — Missing information: filter and counts

Filter and count uploaded leads by what they are missing, answered by the database so paging is right.
- **Database** (`20261010100000_missing_info_filter.sql`, applied live): `missing_required_fields()`
  (immutable, the one definition of the 15 required fields), `submissions.missing_info text[]` stored
  generated column (recomputes on every payload edit, `{}` for non-uploaded leads), and
  `missing_info_by_field()` (SECURITY INVOKER, anon revoked). Checked live: 329 of 500 uploaded leads
  have a gap; Draft Date 175, Zip 28, State 7. `types.ts` regenerated (additive only).
- **UI:** Submissions → Manual: "Missing info (N)" chip plus a per-field dropdown with counts; manager
  Manual queue: chip (client-side); Import history: per-batch "Missing info" count and a toggle in an
  opened batch. The badge and fill-in section now read the column.
- The phase-1 TypeScript rule (`src/lib/missing-info.ts` and its test) is removed: the SQL function is
  the single source of truth.
- Closing Desk: a "Missing info" dropdown among the filters (any missing field, or one field with its
  count); runs in the database like the other filters there. Bank fields are logged as an undecided
  idea in `docs/TODO.md`.
- Code: `reporting.tsx`, `manager.tsx`, `import-history.tsx`, `closing-desk.tsx`, `missing-info.tsx`,
  `ops.tsx` (`SubmissionRow.missing_info`). Docs: `docs/database.md`, `docs/features/spreadsheet-import.md`,
  `docs/TODO.md`.

## 2026-10-10 — Parked leads per client on the admin Overview

The Live | Manual panel on the admin Overview now ends with a "Parked with clients" footer: the
total parked and one row per transfer client with its count and a bar (e.g. Keller 18, Kwanii 2).
It is current state, not a period figure, so the date chips don't change it and the footer says so.
- `OverviewPanels` gained an optional `footer` slot (it still fetches nothing); only the admin
  Overview passes one, because `parked_client_counts` is admin / general_manager only. The manager
  Reporting tab and the Closing Desk are unchanged.
- New `ParkedClientsStrip` in `src/components/parked-leads.tsx`, on the same query key as the
  Parked Leads tab's chips, so moving a lead there refreshes it.
- Code: `overview-panels.tsx`, `admin-overview.tsx`, `parked-leads.tsx`. Database: none.
- Docs: `docs/features/reporting.md`.

## 2026-10-10 — CX status breakdown on the admin Overview

The Customer Pipeline tab's status block (Untouched / In CX / Submitted leads, then the Policy,
Premium, Commission and Chargeback status columns) is now also shown on the Overview tab, under
the Closer Leaderboard and a "Customer Policy Lifetime" divider. It is the same `CxStatusBreakdown`
component with the same query keys, so both tabs show identical numbers; the Customer Pipeline
tab is unchanged.
- Code: `src/routes/_authenticated/admin.tsx` only. Database: none.
- Docs: `docs/features/reporting.md`.

## 2026-10-09 — Back to Admin button on the Reporting screen

An admin who opens the Reporting Manager View had no way back except the browser's back
button. The header now shows a **Back to Admin** chip for admins only, mirroring the manager
queue (`manager.tsx`). The `reporting_manager` role never sees it.
- Code: `src/routes/_authenticated/reporting.tsx` only. Database: none.
- Docs: `docs/features/reporting.md`.

## 2026-10-09 — Faster page loads: shared auth snapshot + self-hosted fonts

Measured on the live site: a serial chain of ~9 auth round trips (`getUser`, `profiles`,
`crm_suspension`, repeated by the parent route, the child route, `index.tsx` and
`AuthProvider`) ran before any page data was requested (~2.5 s admin, ~4.3 s manager on
sign-in), and the Google Fonts stylesheet blocked first paint (~2.5 s on `/login`).
- `loadAuthSnapshot()` in `src/lib/auth.tsx`: session read locally with `getSession()`,
  `profiles` + `crm_suspension` fetched in parallel, in-flight promise shared, result reused
  for 10 s and dropped on sign-in/out/user-update/token refresh and in `signOut()`.
  `requireRole()`, `_authenticated/route.tsx`, `routes/index.tsx` and `AuthProvider` now read it;
  behaviour (role fallback, suspension redirect, role redirect) is unchanged.
- Fonts self-hosted: `public/fonts/*.woff2` (Latin subset of DM Sans and Space Grotesk, same
  families), `@font-face` in `src/styles.css`, preloads in `__root.tsx`; the Google Fonts links are gone.
- Database: none. Docs: `docs/authentication.md`, `docs/features/admin-settings-and-config.md`,
  `docs/decisions/0010-route-guards-read-session-locally.md`.

## 2026-10-09 — Interim simple Decline dialog (carrier + reason)

While the agency/IMO mapping has no real data, declining a lead no longer asks for
IMO → carrier and a Carrier rejected / Fixable choice. With
`app_config.placement_rule_enabled = 'false'`, `DeclineDialog` shows the active
carriers (multi-select) and a required reason, and calls the existing carrier-only
`decline_with_carriers(p_sub, p_carrier_ids, p_reason)`. The full dialog is kept in
the same file and returns when the flag is set to `'true'`, the same switch the
Accept panel uses; nothing is commented out.
- Code: `src/components/decline-dialog.tsx` only. Applies to validators and managers.
- Database: none (no migration; the 3-argument overload already existed).
- Docs: `docs/features/validation-queue.md`.

## 2026-10-08 — Agency / IMO / Carrier mapping moved to the Agencies tab

The editable mapping (Agency → IMOs, IMO → Carriers) now sits at the top of the admin
**Agencies** tab, above the connection diagram. Settings keeps the Agencies, IMOs and
Agents lists and Carriers.
- `PlacementMapping` is exported from `placement-admin.tsx` and mounted in `admin.tsx`.
- Removed the "See the whole map" link (the map is on the same page); empty-state hints
  now point to Settings.
- No database change.

## 2026-10-08 — Closer form: Health Conditions and Medications typeahead

**Health Conditions** (existing field, same label and payload key) is now a chip list
with suggestions as the closer types, and a new **Medications** field sits right under it.
- Suggestions come from the US National Library of Medicine Clinical Tables (conditions,
  RxTerms for drugs), called straight from the browser like the ZIP lookup. Only the typed
  characters are sent. If the lookup fails the field still accepts typed text.
- Stored as one comma-separated string in `payload` (`Health Conditions`, `Medications`),
  so existing rows, Sheets sync and imports are unchanged. Enter or comma adds text the
  list doesn't know.
- `Medications` moved from the import-only catalog entries into the form-derived catalog
  (one entry, same aliases) so the import catalog has no duplicate key.
- The payload and lead editors show both as a plain text area, as before.
- New `suggest-input.tsx`, `lib/health-suggest.ts` (+ tests). No database change.

## 2026-10-08 — Manager: Submissions is its own tab

The submissions table that sat under the stats on the manager's Reporting tab now has
its own **Submissions** tab (between By Draft Date and Reporting), the same split the
admin page already uses. Reporting keeps the stats panels only.
- `manager.tsx` mounts `SubmissionsExplorer` and `ReportingStats` separately instead of
  `ReportingDashboard`, which no longer has a caller (left in `reporting.tsx`).
- No database change.

## 2026-10-08 — Operations queue: sortable columns and paging

The manager's Operations queue (Live, Manual, CXA Returned) now renders through one
shared `DataTable` instead of three hand-written tables. The tabs and their columns
are unchanged.
- Every column header sorts; default order is still newest first.
- 50 rows a page (client-side). The queue is still one unpaged query kept fresh by
  realtime, so tab counts and search are unchanged.
- The header checkbox now selects the assignable rows of the current page, not the
  whole tab. Selection is also cleared when the sort changes.
- New `src/components/data-table.tsx`, `src/lib/queue-sort.ts` (+ tests); new
  dependency `@tanstack/react-table` v8 (v9 is npm's `latest` but has a different API).
- No database change.

## 2026-10-07 — Settings: cleaner Agencies / IMOs / Agents / Carriers panels

UI-only redesign. Tables of four-chip rows became cards of rows with hover icon
actions, scroll-capped lists with a filter box, link counts on agencies and IMOs,
and a master–detail mapping with toggle pills in place of select + checklist.
Carriers use the same rows (Order/Active columns removed).
- New `src/components/admin-list.tsx`; rebuilt `placement-admin.tsx` and
  `carrier-admin.tsx` UI. No RPC, query or database change.

## 2026-10-07 — Admin "Agencies" tab: Agency → IMO → Carrier map

New read-only tab showing which IMOs connect to which agencies and carriers, as
three columns joined by curves, with click/hover path highlighting, per-name link
counts, a "Show inactive" toggle and a stacked per-IMO fallback on narrow screens.
- New `src/components/agency-map.tsx`; mounted from `admin.tsx`.
- No database change; editing the mapping stays in Settings.

## 2026-10-07 — Sales Breakdown merged into the admin Overview

The admin "Sales Breakdown" tab is gone; its content now sits below the Overview
panels, driven by the Overview's single time filter (Today / 7 days / 30 days /
All time / Custom). The filter row sticks to the top while scrolling.
- `sales-breakdown.tsx`: new optional `sharedPeriod` prop (a `usePeriod()` result);
  when set it feeds `p_days`/`p_start_date`/`p_end_date` to the existing RPCs and
  hides the component's own chips. Without it (the `/reporting` Sales tab) nothing changes.
- `admin-overview.tsx` renders it; `admin.tsx` drops the tab.
- Behaviour change: admin loses the calendar "This Week / This Month" chips.
- No database change.

## 2026-10-07 — Agents are independent of the placement rule

Only Agency → IMO → Carrier follow the placement mapping now. Agents are a plain
list: add one in Admin → Settings and it appears in the validator's Agent Name
dropdown, regardless of agency, IMO or carrier.
- Migration `20261007130000_agents_independent.sql`: `set_validator_fields` (uuid
  overload) drops the carrier-first and appointment checks and only requires an
  active agent (or the lead's current one); `placement_set_link` drops the
  `agent_appointment` kind; `agent_appointments` (empty) is dropped.
- UI: the "Agent appointments" mapping box is gone from `placement-admin.tsx`;
  `validator-fields.tsx` offers all active agents and never clears the agent when
  the chain changes; `placement.ts` loses `agentsForLink`/appointments.
- The placement rule is still switched off (`placement_rule_enabled = false`).

## 2026-10-07 — Typed Agency and IMO now reach the Google Sheet

The free-text Agency and IMO a validator types (`submissions.agency_name` / `imo_name`)
were saved but never sent to the sheet. Now they go as two new trailing columns,
`Placement Agency` and `Placement IMO` (not `Agency`/`IMO`, since `Agency` is already a
payload key holding the carrier on some forms).
- Migration `20261007120000_sheet_sync_agency_imo.sql`: `sheet_sync_row` and
  `sync_submission_to_sheet` add `agency_name`/`imo_name` to the body; `notify_sheet_sync`
  re-queues a row when either changes.
- Edge function `sheet-sync` (v14): `buildRow()` appends the two columns.
- The 3 existing leads with typed text were re-queued once.

## 2026-10-07 — Final carrier filter in the Closing Desk

general_manager and closing_manager get a "Final carrier" box beside the search box.
It is its own `or` group, so it is ANDed with the search (customer + carrier narrows).
Matches `final_carrier_id` via the typed carrier name, plus `payload.Agency` for
validator submissions, reusing `finalCarrierSearchClauses`/`matchingCarrierIds`.
`closing-desk.tsx` only; no database change.

## 2026-10-07 — Draft Date range filter in the Closing Desk

general_manager and closing_manager can filter the Closing Desk by draft date: a
labelled Draft from/to pair beside the Submitted pair. One date alone is that exact
day; two are an inclusive range (reversed pairs are swapped). Filters
`submissions.draft_date` directly, so leads with no draft date never match.
`closing-desk.tsx` only; no database change.

## 2026-10-07 — Free-text Agency and IMO while the placement rule is off

Simple mode would have dropped the Agency and IMO a validator knew. Migration
`20261007110000_free_text_agency_imo.sql` adds `submissions.agency_name` and
`imo_name` (text), replaces the 4-argument `set_validator_fields` with a 6-argument
rule-off version that writes them, and makes `dispose_submission` require all five
fields on accept while the rule is off (rule-on branch unchanged). Validator form,
Closing Desk query and the accept gate follow. Not synced to Google Sheets.
Leads already in review need agency and IMO filled before they can be accepted.

## 2026-10-07 — Interim free-text placement while the mapping is not ready

Validators could not accept a lead without picking Agency → IMO → Carrier → Agent
from a mapping that has no data yet. While `placement_rule_enabled` is `false`,
`ValidatorFields` now shows just Final Carrier, a typed Agent Name and Policy
Number (the server already accepted exactly this on the rule-off path), and
`acceptBlockedReason` gates on those three. New `usePlacementRuleEnabled()` in
`placement.ts`; `manager.tsx` and `validator.tsx` pass its value to the gate.
Flip the `app_config` flag to `'true'` to restore the full chain. Client only,
no migration.

## 2026-10-07 — CXA/CXM can edit Final Carrier, Agent Name and Policy Number

The "Filled By Validator" panel in the Customers Pipeline detail sheet was
read-only. It is now editable for cxa/cxm (the admin Pipeline mount stays
read-only): a Final Carrier dropdown, Agent Name and Policy Number inputs, and a
Save chip. New migration `20261007100000_cx_set_placement_fields.sql` adds
`cx_set_placement_fields(p_sub, p_agent_name, p_policy_number, p_final_carrier_id
default null)` — cxa/cxm/admin, guarded by `cx_pipeline_member`, writes only
those three columns (not agency/IMO/agent ids, not the placement rule) and logs
a `cx_placement_fields_set` form event with old/new values. Anon has no
execute. Note: these columns are watched by `notify_sheet_sync()`, so an edit
re-syncs the lead to Google Sheets, same as a manager's edit would.

## 2026-10-06 — Center badge on each closer in the Closer Leaderboard

The leaderboard's Center column was a hardcoded "-". It now shows a colored
`CenterBadge` per closer (also on the Top Performer / Needs Support cards),
resolved client-side from the closer's current `profiles.center_id`.
`sales-breakdown.tsx` only; no database change.

## 2026-10-06 — Fix: policy-number search missed validator-submitted (manual) leads

The new policy-number search only checked the `policy_number` column, which is
set at review. A validator's own submission auto-accepts and never reaches
review, so its policy number exists only in `payload->>'Policy Number'` (0 of
224 had the column, 220 had the payload key). Both the Closing Desk and the
Customers Pipeline now search the column **or** that payload key. Verified as
a general manager: such a lead matched 0 before the fix and 1 after. Client
only.

## 2026-10-06 — "Reporting Manager View" button in the admin header

Links to `/reporting`, next to Manager View, Closer Form and Validator Form
(`admin.tsx`). The route already admitted admin, and the screen has no edit
controls, so it is read-only. No database change.

## 2026-10-06 — Search by policy number (CX pipeline) and SSN + policy number (Closing Desk)

Customers Pipeline's search box now also matches `policy_number`
(`customers-pipeline.tsx`). The Closing Desk's (general manager and closing
manager) now matches `policy_number`, and SSN via `ssn_normalized` using the
digits of the search term, so dashed, undashed and last-4 searches all work.
It needs at least 4 digits (`closing-desk.tsx`). Placeholders updated on both.
Client only, no database change. See `docs/features/cx-lifecycle.md` and
`docs/features/closing-desk.md`.

## 2026-10-06 — Placement override opened to general managers

`override_placement_block` now accepts a **general manager** as well as an admin
(`20261006110000_placement_override_general_manager.sql`, applied live; the
switch is still OFF). It's the same function and the same effect: one lead, one
IMO → carrier, a required reason, the rejection untouched. The event now
records the approver's `by_role`. The Override button in `validator-fields.tsx`
shows for both roles. Managers and validators still can't override.

Pass codes for bypassing the rule were considered and rejected; see
[decisions/0009](docs/decisions/0009-placement-rule-server-side-by-ssn.md).

Verified in a rolled-back dry run:
- Admin and general manager can override, and the role is recorded.
- A blank reason is refused.
- Manager, validator and a caller with no role are all refused.

## 2026-10-06 — Placement rule revised: same-IMO is a warning, not a block (still switched OFF)

A carrier rejection at IMO X → carrier C now **blocks** only carrier C under
other IMOs. A **different** carrier under the same IMO X is **allowed with a
warning**, and the validator must tick "I understand" to save. See
[decisions/0009](docs/decisions/0009-placement-rule-server-side-by-ssn.md).

**Database** (`20261006100000_placement_same_imo_warning.sql`, applied live; no
live code calls it, and `placement_rule_enabled` is still `'false'`):
- `placement_conflict` now blocks on the same carrier only.
- New internal `placement_warning` returns the same-IMO warning text.
- `set_validator_fields` gains `p_acknowledge_warning` (the 6-argument version
  was dropped, since nothing live called it). Without the tick the save is
  refused with the warning text, and a ticked save writes `placement_warning`
  and `warning_acknowledged` to the `validator_fields_set` event.

**UI** (not deployed): an amber **Warning** box with an **I understand** tick in
`validator-fields.tsx`, `placementWarningReason` in `lib/placement.ts`, and
reworded text in the Decline dialog and the manager's "Prior rejections" badge.

`types.ts` was regenerated through the Supabase MCP generator because
Windows Application Control blocked `supabase.exe`. That output omits the unused
`graphql_public` section the CLI includes. The next `npm run types` run with a
working CLI restores it.

Verified in a rolled-back dry run:
- Same carrier is blocked, even with the tick.
- Same IMO without the tick is refused, and with it saves.
- A different IMO needs no tick.
- Overrides work.
- Legacy, fixable and closed leads are never warned.
- Accept works.
- Callers with no role are refused.

## 2026-10-05 — Placement rule, phase 2: Agency/IMO/Agent dropdowns and the rejection block (switched OFF)

Stops a customer a carrier has rejected from being re-shopped to that carrier
through another IMO, or to another carrier through the same IMO. See
[decisions/0009](docs/decisions/0009-placement-rule-server-side-by-ssn.md).

**Database** (`20261005100000_placement_rule.sql`, applied live with
`placement_rule_enabled = 'false'`):
- **`carrier_declines`** gains `imo_id`, `source` and `kind`. The 301 old rows
  were classified from their reason text: 88 `carrier_rejected`, 48 `fixable`,
  165 `unclassified`.
- **New table** `placement_overrides`.
- **New functions:** `placement_conflict` (internal), `placement_blocks`,
  `record_carrier_rejection`, `override_placement_block`,
  `classify_decline_reason` and `placement_rule_enabled`.
- **New overloads:** a 6-argument `set_validator_fields` and an IMO-aware
  `decline_with_carriers`, alongside the old ones. `dispose_submission`'s
  accept gate requires five fields and runs the rule once the switch is on.
- **New view:** `submission_customer_rejections`.
- **Guard fix:** the NULL-role guard is fixed in the three replaced functions.

**UI** (not deployed):
- **"To Be Filled By Validator"** is now Agency → IMO → Final Carrier → Agent
  dropdowns, plus Policy Number. Blocked carriers are disabled with the reason;
  admins can override per lead; managers and admins can record a carrier
  rejection after Submit.
- **The Decline dialog** groups IMO → carrier contracts and asks "Carrier
  rejected" or "Fixable issue".
- **Operations** shows a "Prior rejections" badge.
- **Files:** `validator-fields.tsx`, `decline-dialog.tsx`, `lib/placement.ts`,
  `manager.tsx`, `ops.tsx` and `closing-desk.tsx`.

**The live app is unaffected.** It still calls the old functions, which behave
exactly as before while the switch is off.

Verified:
- In a rolled-back dry run, every rule case passed, plus the switch-off and
  switch-on behaviour and anon refusals.
- After applying, `submission_totals`, the `validator_stats` hash and
  `sheet_sync_queue` are unchanged.
- tsc and build pass.

## 2026-10-04 — Placement hierarchy, phase 1: agencies, IMOs, agents and their mapping

New admin vocabulary for where a lead is placed: Agency → IMO → Carrier →
Agent. Every link is many-to-many, and an agent's appointment belongs to one
IMO→Carrier contract.

**Database** (`20261004100000_placement_hierarchy.sql`):
- New tables `agencies`, `imos`, `agents`, `agency_imos`, `imo_carriers` and
  `agent_appointments`.
- New nullable columns `submissions.agency_id`, `imo_id` and `agent_id`.
- Two admin-only RPCs, `placement_upsert_item` and `placement_set_link`, both
  audited to `settings_audit`.
- Every role can read the tables. Direct writes, including `TRUNCATE`, are
  revoked from `anon` and `authenticated`.

**UI:** a new "Agencies, IMOs and agents" panel in Admin → Settings
(`placement-admin.tsx`, `lib/placement.ts`).

**No behaviour change for validators.** The validation flow doesn't read any of
this yet. Phase 2 (cascading dropdowns plus the rejection-block rule) ships once
the mapping is filled in.

Verified:
- `submission_totals`, the `validator_stats` hash and `sheet_sync_queue` are
  identical before and after the migration.
- 0 existing rows changed.
- The RPCs refuse a caller with no role.

## 2026-10-02 — Fix: reporting_manager saw "Unnamed closer", no centers, no validators

The new role could read `submissions` but not the lookup tables the
reporting RPCs join to. Those RPCs are `SECURITY INVOKER`, so the joins ran
under its RLS and came back empty without raising an error. Added
`reporting_manager` to the read policies on `profiles`, `centers`, `carriers`
and `form_events` (`20261002120000_reporting_manager_lookup_reads.sql`). The
`carriers` grant also fixes By Carrier, which had been falling back to raw
proposed-carrier text. Write policies are unchanged. Verified under a
simulated reporting_manager JWT: 3 centers, 13 validators, 40 named closers,
0 "Unnamed closer".

## 2026-10-02 — New role: reporting_manager

A tenth `app_role` value for read-only, business-wide reporting with no
queue and no edit RPCs granted anywhere. Added via two migrations (the enum
addition has to commit before anything can reference it):
`20261002100000_add_reporting_manager_role.sql` and
`20261002110000_reporting_manager_grants.sql`. The second widens the
`submissions` read policy (same scope as `general_manager` — business-wide,
not center-scoped) and the role guards on `validator_stats_range`,
`sales_breakdown_range` and `sales_closer_leaderboard_range` (previously
admin-only). New route `/reporting` (`src/routes/_authenticated/reporting.tsx`)
mounts two tabs: "Reporting" (`OverviewPanels` fixed at the "All time" window
plus a new `ValidatorsTeamDashboard` export pulled out of `reporting.tsx`'s
`ReportingStats`) and "Sales Breakdown" (`SalesBreakdown`, unchanged). The
`invite-user` edge function's hardcoded `VALID_ROLES` allow-list and
`user-admin.tsx`'s `ROLES` array both updated so the role is actually
invitable. See `docs/features/reporting.md`, `docs/features/sales-breakdown.md`,
`docs/features/user-management.md` and `docs/database.md`.

## 2026-10-01 — Fix: center API key generation couldn't find pgcrypto

`admin_generate_center_api_key`/`submit_external_lead` (added earlier today)
failed with `function gen_random_bytes(integer) does not exist` — this
project has `pgcrypto` installed in the `extensions` schema, not `public`,
and both functions' `search_path` only included `public`. Widened to
`'public', 'extensions'` on both. No logic change.

## 2026-10-01 — External center intake: API-key-authenticated lead POST endpoint

A center being onboarded runs its own CRM and has no Astrax closer logged in
behind its leads. Added `ingest-center-lead`, a new edge function the
center's CRM POSTs to (payload keyed by the closer form's exact labels, auth
via a per-center `x-api-key` header), backed by a new RPC
`submit_external_lead` that inserts exactly the shape a closer's own
submission takes — `pending_manager`, assignable, synced to Sheets, the same
accepted-match duplicate-SSN block — tagged `source='api'` instead of
`'live'`. New table `center_api_keys` (hashed keys only, zero RLS policies)
and two admin RPCs (`admin_generate_center_api_key`,
`admin_list_center_api_keys`) back a new "API Key" action on each center's
row in `CenterAdmin`, where the raw key is shown once at generation time.
`submissions_source_chk` widened to allow `'api'`; `ops.tsx`'s `LeadSource`/
`closerName()`/`sourceLabel()` updated so these rows show a distinct "API"
origin badge with the center's name in place of a closer's.
See `docs/features/closer-submission-and-forms.md` and `docs/database.md`.

## 2026-09-29 — Lead Imports "When" column shows the date, not a relative duration

Same fix as 2026-09-28's Parked Leads change, applied to `import-history.tsx`'s
batch list: the "When" column now shows `formatDate(created_at)` instead of
`relativeTime`, with the relative duration still available on hover (the
cell's `title`).

## 2026-09-29 — Age/State/Zip columns on the Uploads batch leads table

Clicking a batch in the admin Uploads tab (`import-history.tsx`) showed only
Customer/Status/Flags. Added Age, State, and Zip Code, read from the
already-fetched `payload` (no new query, no schema change) using the closer
form's own field labels. See `docs/features/spreadsheet-import.md`.

## 2026-09-29 — Deactivation now signs the user out and blocks login

Individual deactivation (`profiles.active = false`, Users tab) already
cascaded through every RLS policy and RPC guard via `my_role()`, but left an
already-open session logged in (screens just went silently empty) and didn't
stop the account signing back in. `login.tsx` now checks `active` right
after sign-in and refuses with "This account has been deactivated. Contact
your admin." if false; `AuthProvider` subscribes to realtime updates on the
signed-in user's own `profiles` row and force-signs-out the instant `active`
flips false mid-session, redirecting to `/login?reason=deactivated`. New
migration `20260929140000_profiles_realtime_deactivation.sql` adds
`profiles` to the `supabase_realtime` publication. See
`docs/features/user-management.md`.

## 2026-09-29 — CRM-wide suspend/maintenance mode

New admin Settings-tab control (`SuspensionControl`) to pause the whole CRM
for every non-admin role, timed (auto-resume) or manual (indefinite), ahead
of commercializing the product. Enforcement is server-side in `my_role()`
(a non-admin resolves to no role while suspended, cascading through every
existing RLS policy and RPC guard the same way individual deactivation
already does — no other policy or RPC edited); the forced sign-out is a new
realtime subscription in `AuthProvider` that signs out and redirects an
affected session to the new public `/suspended` page the instant the switch
flips, closing the gap individual deactivation still has (see
`docs/TODO.md`). New table `crm_suspension`, RPCs `set_crm_suspension`/
`clear_expired_suspension`, cron job `clear-expired-suspension`. See
`docs/decisions/0008-crm-suspension-via-my-role.md` and
`docs/features/admin-settings-and-config.md`.

Migration `20260929120000_crm_suspension.sql` applied live 2026-09-29;
`npm run types` re-run afterward, removing the temporary type-cast
workarounds `lib/crm-suspension.ts` carried while the table wasn't yet in
the generated `Database` type.

## 2026-09-28 — Parked Leads shows the date it was parked, not a relative duration

`parked-leads.tsx` — shared by the admin panel's Parked Leads tab and the
general_manager's Closing Desk Parked Leads tab, one component, so this
fixes both at once — swapped the "Parked" column and the detail panel's
subtitle from `relativeTime(created_at)` ("2d ago") to `formatDate(created_at)`
(the calendar date). The relative duration is still there on hover (the
table cell's `title`). See `docs/features/closing-desk.md`.

## 2026-09-28 — Fixed "error code: 1003" opening Voice Clone Studio

`src/lib/voicebox.ts` fetched the external tool by its bare IP
(`http://132.226.187.244`). Cloudflare Workers' `fetch()` rejects a raw
IP-literal URL with its own error 1003 ("Direct IP Access Not Allowed") —
confirmed live: the identical request reached the tool fine from a normal
outside network, only failed when made from inside the Worker, and the
Worker faithfully relayed Cloudflare's own error page back to the browser as
if it were the tool's page. Fixed by adding a DNS-only (not proxied) `A`
record, `voicebox-origin.astrax.live → 132.226.187.244`, and pointing
`TOOL_URL` at that hostname instead of the IP. See
`docs/features/voice-clone-studio.md`.

## 2026-09-28 — Fixed "Voice Clone Studio is not configured" after setting the secret

`src/lib/voicebox.ts` read `VOICEBOX_SESSION_SECRET` off its handler's `env`
function argument — the textbook Cloudflare Workers convention. In this
Nitro build that argument is always empty by the time it reaches
`src/server.ts`: traced by reading the built `.output/server/index.mjs`,
where Nitro's own Cloudflare adapter sets `globalThis.__env__ = env` and
then calls `nitroApp.fetch(request)` with no `env` parameter at all. Fixed
to read `globalThis.__env__` directly instead of the function argument — the
secret was set correctly the whole time, the code just never looked in the
right place. See `docs/features/voice-clone-studio.md`.

## 2026-09-28 — Voice Clone tab now opens the tool's real interface at astrax.live/voicebox

Replaced the hand-built form in the admin Voice Clone tab
(`voice-clone-studio.tsx`, deleted) with an "Open Voice Clone Studio" button
(`voicebox-launcher.tsx`) that opens the external tool's own, unmodified
interface in a new tab at `astrax.live/voicebox`, proxied through this app's
own Cloudflare Worker — admin-only. New `src/lib/voicebox.ts`, wired into
`src/server.ts` (this app's actual Worker `fetch` handler): exchanges the
current Supabase session for a short-lived signed cookie
(`POST /api/voicebox/session`), then proxies `/voicebox` and
`/voicebox/api/*` to the tool, rewriting its three confirmed root-relative
`fetch()` calls in transit so its own API calls stay within the proxy.
Needed because this app's Supabase session lives in `localStorage`, not a
cookie, so a plain navigation carries no proof of who's asking. New
Cloudflare Worker secret `VOICEBOX_SESSION_SECRET` (HMAC signing only — no
new Supabase secret needed). `supabase/functions/voice-clone-proxy` is
superseded but left deployed, unused, by explicit decision. See
`docs/features/voice-clone-studio.md`, `docs/database.md`.

## 2026-09-28 — Lead imports batch list is now paginated

`ImportHistory` (`/admin?tab=uploads`, `/upload`) used to fetch the 100 most
recent batches in one unpaginated request, with no way to reach anything
older. Now server-paginated at 25/page (`LEAD_PAGE_SIZE`, `PaginationBar`,
the same pattern `SubmissionsExplorer` already uses). Batch selection for
the CSV/Excel download (below) is now tracked by row snapshot
(`Map<id, ImportRow>`) rather than by id alone, so a batch selected on one
page stays selected after navigating to another — the same fix `exports.tsx`
already needed for its own selection state, applied here before shipping
the same bug.

## 2026-09-28 — Admin can download uploaded batches as CSV/Excel

`ImportHistory` (`/admin?tab=uploads`) gained a checkbox column and a reused
"Selected (N)" / amber-ready-bar download control (the same pattern
`exports.tsx` established) — admin-only. Selecting one or more lead-import
batches and downloading builds a file from every `submissions` row tagged
with those batches' `import_id`s: current payload (corrections included),
every status (approved/pending/rejected), every payload field present
(union across the downloaded rows, no column picker — the intent is "give
the batch back," not a curated report). One batch keeps its own file name;
more than one produces a combined file with a "Source File" column. No new
RPC or migration — reads `submissions` directly, same access an admin
already has everywhere else on this screen. See
`docs/features/spreadsheet-import.md`.

## 2026-09-28 — Closing Desk's date filter now searches "Submitted On" (`disposed_at`), not "SaleMade On" (`created_at`)

The Closing Desk table (`/closing`, `closing_manager`/`general_manager`)
names its two date columns deliberately the other way round from what the
raw column names suggest: "SaleMade On" is `created_at` (when the lead
entered the queue) and "Submitted On" is `disposed_at` (when it was
submitted to the carrier/outcome). The From/To filter above the table was
querying `created_at` — "SaleMade On" — instead of the "Submitted On" column
its own labels claimed. Changed the filter to query `disposed_at`; headers
and every other column are unchanged. A row with no `disposed_at` yet
(never dispositioned) now falls out of any date-filtered result, correctly —
there is no submitted date to test yet. See `docs/features/closing-desk.md`.

## 2026-09-27 — Sales Breakdown aggregation moved server-side

`SalesBreakdown` (`/admin?tab=sales-breakdown`) previously paged every
accepted lead's full payload into the browser (measured 386 rows / 393 kB
live, tracked in `docs/TODO.md`) to compute the carrier/state/plan-type
pivots and closer leaderboard client-side. Two new admin-only RPCs,
`sales_breakdown_range` and `sales_closer_leaderboard_range`, now do that
aggregation server-side, with three SQL helpers
(`sales_plan_type_bucket`/`sales_resolve_carrier`/`sales_resolve_state`)
reimplementing the same carrier-alias/state-fallback rules
`src/lib/normalize/carriers.ts`/`src/lib/normalize/states.ts` use elsewhere.
`sales-breakdown.tsx` no longer fetches or holds any raw lead payload.
Verified live equivalent to the old result before and after the change. See
`docs/database.md` and `docs/features/sales-breakdown.md`.

## 2026-09-27 — Fixed two live RPC security bugs

Two bugs already diagnosed in `docs/TODO.md` were fixed: (1) ~19
`SECURITY DEFINER` RPCs (`admin_settings`, `archive_submission`,
`assign_to_validator`, and others) used a role guard (`my_role() <> 'admin'`
or `my_role() not in (...)`) that silently passed for a roleless caller,
since `my_role()` returns NULL for no-JWT/no-profile/inactive callers and
`NULL <> 'admin'` is NULL, not true — verified live that `admin_settings()`
and `reporting_retention_status()` returned real data to `anon`. (2)
`validator_stats_range()` returned whole-business validator figures to any
caller regardless of their actual RLS scope, because three of its columns
come from `form_events`, whose read policy isn't centre-scoped the way
`submissions` is — verified live under a closing manager's JWT. Both fixed
with a corrected guard (`is distinct from` / an explicit `is null or`
check) and `EXECUTE` revoked from `anon` by name; `validator_stats_range` is
now also restricted to `admin`/`manager`, the only two roles that actually
call it. See `docs/TODO.md` and `docs/database.md`.

## 2026-09-25 — Clicking a lead inside an opened import batch now opens its detail sheet

`import-history.tsx`'s "Leads in this batch" table (Admin → Uploads, and
the uploader's own `/upload` history) listed each lead's name/status/flags
but nothing was clickable — there was no way to see a single imported
lead's payload or flags from this screen. Clicking a row now opens a detail
sheet with `LeadPayload`, `DataFlagList`, and (admin only) `PaymentPanel`,
reusing the row already fetched for the batch table rather than a second
query. Editable only for `admin` — `update_payload_field` and
`payment_summary` don't accept `data_uploader`, so an uploader viewing
their own batch gets a read-only payload/flags view and no banking panel.
See `docs/features/spreadsheet-import.md`.

## 2026-09-25 — Manager and general_manager can apply the second-policy tag too

`add_submission_tag`/`remove_submission_tag` and the `cx_tags`/
`submission_tags` read policies were cxa/cxm/admin only. Extended to
`manager` and `general_manager` (not `closing_manager`, which shares
`ClosingDesk` with general_manager but wasn't granted this), since both can
already see and edit an accepted lead from their own screens.
`SubmissionTags` is now also mounted in `ReportingDashboard`'s detail sheet
(`src/components/reporting.tsx`, shared by admin's Overview/Reporting and
the manager's Reporting tab) and in `ClosingDesk`
(`src/components/closing-desk.tsx`, gated in-component to
`general_manager`), each only rendering for an accepted lead. See
`docs/decisions/0007-duplicate-ssn-blocks-unless-tagged.md`.

## 2026-09-25 — Deactivated two unused CX tags

`Approved Success` and `Denied Failure` in the `cx_tags` vocabulary had 0
leads tagged and no code reference anywhere — leftover placeholders from
when the CX tagging system was first built (`20260821184015`), before any
UI existed to apply tags. Deactivated (`active = false`), not deleted —
`cx_tags` rows are FK-referenced by `submission_tags`, so there's no delete
path for vocabulary tables, only the existing active-toggle convention.
They no longer appear in `SubmissionTags`' chip list. Only
"Eligible For Second Policy" remains active.

## 2026-09-25 — Duplicate SSN blocks submission for an accepted lead, unless CX tags the original policy

A repeat SSN used to be advisory only (`check_duplicate_ssn`) — warned, but
never stopped a submission, since a repeat SSN is often a legitimate
re-write after a decline. Now `submit_form_internal` (behind both the
closer's forms and the validator's own direct submission) refuses the
insert when the SSN already belongs to another non-archived **accepted**
lead, unless a CX agent has tagged that existing policy as eligible for a
second one. A duplicate against a declined or still-in-progress lead is
**unchanged** — still advisory only, still just a warning — narrowed to
this scope after the first pass blocked on any duplicate at all. A new
component, `SubmissionTags` (`src/components/submission-tags.tsx`), mounted
in the Customers Pipeline detail sheet, is the first UI for the
`cx_tags`/`submission_tags` system — previously wired end-to-end via
`add_submission_tag`/`remove_submission_tag` but unused (0 rows) in
production. The exemption is a flag on the tag
(`cx_tags.allows_duplicate_ssn`), not a hardcoded name, seeded on one new
tag, "Eligible For Second Policy." `check_duplicate_ssn`'s advisory hint on
both forms now previews whether an accepted-SSN match will actually be
blocked or has been cleared. See
`docs/decisions/0007-duplicate-ssn-blocks-unless-tagged.md`,
`docs/features/closer-submission-and-forms.md`, and
`docs/features/cx-lifecycle.md`.

## 2026-09-24 — Closing Desk shows when a lead was disposed, not just submitted

The Closing Desk (`general_manager`/`closing_manager`, `/closing`) only
showed `created_at` ("Submitted") per lead. Added a "Disposed" column and a
matching line in the detail sheet's subtitle, both reading `disposed_at` —
already an existing `submissions` column, stamped by the existing
`dispose_submission` RPC every time a validator (or manager/admin) records
an outcome, and `null` until then. No schema, RPC, or migration change; the
column was simply not yet selected or rendered on this screen. See
`docs/features/closing-desk.md`.

## 2026-09-23 — Voice Clone Studio, proxied into a new admin tab

A new admin-only tab (`/admin?tab=voice-clone`) wraps an existing external
tool that clones a voice from a sample clip and speaks arbitrary text in it.
That tool runs on plain HTTP at a bare IP with no authentication of its own,
so it isn't embedded directly — a new `voice-clone-proxy` edge function
(`supabase/functions/voice-clone-proxy/index.ts`) is the actual boundary:
it re-checks the caller is an admin (same pattern as `invite-user`) before
forwarding the request server-side, so the browser only ever talks HTTPS to
Supabase and the tool's address/lack of auth never reaches the client. See
`docs/features/voice-clone-studio.md` for the response-shape caveat (the
tool's own OpenAPI spec doesn't document what `clone-speak` returns) and the
limitation that admin-only gating here only controls access *through this
CRM* — the tool itself remains reachable directly by anyone who has its IP.

## 2026-09-22 — Duplicate-SSN warning states the lead's actual outcome

The closer form's duplicate-SSN warning said a matched lead was "accepted" —
the one word the app is never supposed to show, since `accepted` is
displayed everywhere else as "Submitted" (`dispositionLabel()` in
`ops.tsx`). The warning now uses that same helper, so a closer sees
"marked Submitted" / "marked Declined" / "marked In Progress" — consistent
with every queue, badge, and report in the app. The outcome word itself is
now colour-coded within the sentence too: Submitted in emerald (the same
hardcoded exception `DispositionBadge` already uses), Declined in the
existing `text-destructive` token — so the closer catches the outcome at a
glance, not just on a careful read. `duplicateSsnWarning()`'s hint text is
now a `ReactNode` instead of a plain string to allow the inline colour;
both the closer and validator forms (`closer-form.tsx`, `validator-form.tsx`)
key their hint list by index now instead of by hint text for the same
reason. Still advisory, still no new data from `check_duplicate_ssn`.

## 2026-09-19 — External Transfer names its client

**External Transfer** parked a lead and recorded nothing about where it went.
Parked Leads was therefore one undifferentiated list — 11 rows, no way to tell
one external party's transfers from another's — and the only thing the row said
about the handover was that it had happened.

A closer now picks the client before anything is sent. The button opens
`TransferClientDialog` instead of submitting; the required-field check runs
first, so nobody is asked which client to transfer to and only then told that
Full Name is blank. Parked Leads gained a chip per client above the table
(`All · each client · No client`, with counts) and a **Client** column beside
the existing Closer column, so a row reads who parked it and to whom. The
filter is applied server-side in the same query, so search and pagination keep
working exactly as they did.

Who parked what, to whom, is now recorded three times over with no new column
for it: `closer_id` and `transfer_client_id` sit on the same row, the `parked`
`form_events` row carries the actor and the client name in `detail`, and
`my_forwarded_leads()` returns the client so the closer sees it on their own
screen.

**Migration `20260919100000_external_transfer_clients.sql`** adds the
`transfer_clients` vocabulary table (admin-writable directly, readable by every
role — the same shape as `carriers`/`centers`), `transfer_client_id` and
`transfer_client_name` on `submissions`, and `parked_client_counts()` for the
chip counts, which the paginated table cannot derive from one page of rows.
`submit_form_parked` takes a required `p_client`, and the one-argument version
was **dropped** rather than kept alongside — leaving it would have been a way
to park a lead against no client at all, which is the thing this change exists
to stop.

Two deliberate choices worth stating. The client lives in **columns, never in
`payload`**: `payload` is what sheet-sync pushes to Google Sheets, so a key
there becomes a new Sheet column, and `center_id`/`center_name` already set the
precedent. And `transfer_client_name` is a **frozen copy** taken at park time,
so renaming a client moves the label on the picker without rewriting what
history says about leads already handed over — which is also why the admin
screen offers deactivate and not delete.

Verified live against `ozbpmrmndkemvvnlnudb`, every probe rolled back: a closer
parking with a real client gets `status='parked'`, both stamped columns, their
own `closer_id`, and a `parked` event reading
`{"via":"external_transfer","client":"…"}`; a null client raises
`select a client to transfer to` and leaves **no** `submissions` row and **no**
`form_events` row behind (694/4021 before and after). `parked_client_counts()`
answers an admin (the 11 existing leads, under a null-id "No client" row) and
raises `not authorized` for a closer, who can still read `transfer_clients`.
`EXECUTE` is revoked from both `public` and `anon` on all three new/changed
functions — revoking from either alone leaves the other's grant standing, which
the first attempt here demonstrated.

- Database: **`supabase/migrations/20260919100000_external_transfer_clients.sql`**,
  applied to `ozbpmrmndkemvvnlnudb`
- Added: `src/lib/transfer-clients.ts`,
  `src/components/transfer-client-dialog.tsx`,
  `src/components/transfer-client-admin.tsx`
- Changed: `src/components/closer-form.tsx` (the dialog, and a park now carries
  its client through a discriminated argument rather than an optional one),
  `src/components/parked-leads.tsx` (chips, Client column, filtered query),
  `src/components/forwarded-leads.tsx`, `src/lib/event-labels.ts`,
  `src/routes/_authenticated/admin.tsx` (Settings tab),
  `src/integrations/supabase/types.ts` (regenerated)
- Docs: `docs/database.md`, `docs/features/closer-submission-and-forms.md`,
  `docs/features/admin-settings-and-config.md`

While updating `docs/database.md`, one pre-existing claim was corrected against
the live policies: "Direct client write policy: `profiles` only" was not true —
`carriers` and `centers` already had admin `FOR ALL` policies of their own, and
`transfer_clients` now makes three.

## 2026-09-18 — Live and Manual, each with its own centres

The all-origin fix earlier today made the Overview's centre rows count both
origins, and in doing so destroyed the question the panel is actually opened
with: **which centre did the uploaded leads come from.** A centre whose forty
leads are all uploads and one whose two hundred are all validator submissions
had looked identical.

The intake panel is now two columns — **Live** with its centres beneath,
**Manual** with its centres beneath — sharing one bar scale so the two sides can
be compared rather than each normalising to its own busiest centre. On today's
data that reads at a glance: CROSSNOTCH 0 live / 40 manual (all uploads),
UMS BPO 303 live / 202 manual (all validator), DESCOM 58 / 1.

**Migration `20260918170000_center_manual_submissions.sql`** adds
`manual_submissions` to `submission_totals_by_center_range`. It could have been
derived in the browser as `total_submissions_all - total_submissions`, which is
exactly equal — it is a named column instead so that "manual leads from this
centre" is something the database says rather than something the client infers.
Verified against a direct count: 202 / 40 / 1, with
`total_submissions + manual_submissions = total_submissions_all` on every row,
and re-checked under a closing manager's JWT, where only their own centre
reports figures.

Two things went with it. The **Uploaded / Validator rows are gone** from this
panel — that split now lives only on the Submissions tab's Type column, which
names it per lead — and with them the `showValidatorRow` prop, whose only job
was hiding the Validator row from a closing manager. **`LeadsByCenterPanel` is
deleted**: with centres now shown per origin above it, a second list of the same
centres over the same window was duplication rather than a record.

- Database: **`supabase/migrations/20260918170000_center_manual_submissions.sql`**,
  applied to `ozbpmrmndkemvvnlnudb`
- Changed: `src/components/overview-panels.tsx` (the restructure),
  `src/components/closing-overview.tsx`, `src/components/admin-overview.tsx`,
  `src/components/reporting.tsx` (panel removed),
  `src/integrations/supabase/types.ts` (regenerated)
- Docs: `docs/database.md`, `docs/features/reporting.md`,
  `docs/features/closing-desk.md`, `docs/TODO.md`

## 2026-09-18 — The Overview counted only live leads as sold

The product owner spotted the Submission Outcome panel reporting **183**
Submitted where the business has sold **386**. The panel was faithful; the
database was not. `submission_totals_range` had
`submitted_by_role = 'closer' AND source = 'live'` hardcoded into its
`approved`, `declined` and `pending` filters, while the intake columns beside
them counted everything — so the panel showed live-only outcomes next to
Live + Manual intake, and its acceptance ring read 74% where all origins give
**84%**. The Sales Breakdown tab has always counted `accepted` with no origin
filter, so the two admin screens disagreed and the Overview was the wrong one.

The same hardcoded pair in `submission_totals_by_center_range`'s join was the
only reason manual leads could not be grouped by centre — they always could:
every manual lead carries a `center_id` (41/41 uploaded, 202/202 validator).

**Migration `20260918160000_all_origin_totals.sql`** adds `approved_all`,
`declined_all`, `pending_all` and `total_submissions_all` alongside the
existing columns, which keep their exact previous meaning — so nothing that
read them changed behaviour. All four exclude `pending_import_approval`, the
rule `offline_submissions` already applied. Both functions were dropped and
recreated because a changed return type cannot be `CREATE OR REPLACE`d, and the
migration restores the EXECUTE grants that the drop removes.

Verified against the live database, in one transaction against a direct count:
`approved_all` 388 = 388, `declined_all` 74 = 74, and `approved` still 185 —
unchanged. Re-checked under a closing manager's own JWT, where `approved_all`
narrows to 26 and only their centre reports figures: **`SECURITY INVOKER` means
this widened what is counted, never who may read it.** CROSSNOTCH, which had
shown 0 leads on the Overview, turns out to have 40 — all of them manual, and
invisible until now.

The Overview's centre rows now cover both origins, with Uploaded and Validator
kept underneath as the origin split, so the centre rows finally sum to total
intake.

- Database: **`supabase/migrations/20260918160000_all_origin_totals.sql`**,
  applied to `ozbpmrmndkemvvnlnudb`
- Changed: `src/components/overview-panels.tsx`, `src/components/reporting.tsx`,
  `src/components/admin-overview.tsx`,
  `src/integrations/supabase/types.ts` (regenerated — it was also four
  functions behind the live schema)
- Docs: `docs/database.md`, `docs/features/reporting.md`, `docs/TODO.md`

## 2026-09-18 — The Closing Desk stops fetching the validators table

Found while checking what a deploy of the Overview work would actually change.
`ClosingOverview` called `useOverviewStats`, which fetches all four queries —
including `validator_stats_range`, which that screen never renders. Run as a
closing manager it returns thirteen rows: every validator's name, staff id and
performance, with `timed_out`, `rejected` and `holds` counted from
`form_events` rather than `submissions` and therefore **not** scoped to their
centre (holds of 103 and 123 against 7–16 assigned leads).

`useOverviewStats` now takes `includeValidatorStats`, and the Closing Desk
passes `false`. A screen that does not draw the validators table no longer pulls
it into the reader's browser.

**This closes the app's door, not the database's.** The RPC is executable by any
authenticated caller, so anyone who can sign in can still request it directly
over PostgREST. That fix is server-side and needs a migration, so it is recorded
in `docs/TODO.md` rather than quietly patched here.

- Changed: `src/lib/overview-stats.ts`, `src/components/closing-overview.tsx`
- Docs: `docs/TODO.md` (new security entry), `docs/features/closing-desk.md`
- Database: **none** — the underlying gap is still open, deliberately and on the
  record

## 2026-09-18 — The Overview's last two cards join the redesign

**CX coverage** and **Sheets sync** were the only things left on the admin
Overview still drawn the old way. Each wrapped *itself* in a grid and claimed
about two sevenths of it, so each sat alone on a full-width row with dead space
beside it, reading as two loose strips under the new panels rather than part of
them.

Both now return a plain panel and let the page place them: the Overview tab
pairs them in one two-column row, full width and equal height, as the closing
row of the screen. A component that decides where it sits on someone else's page
cannot be placed by that page.

Their leading figures flip like every other number on the screen — both move on
their own (CX coverage off the realtime subscription, the backlog off its own
30-second refetch), so the motion is the same cue it is everywhere else rather
than decoration.

**Nothing either card reports changed**: same RPCs, same `STRUGGLING_ATTEMPTS`
and `STALLED_SECONDS` thresholds, same wording, same red for a struggling or
stalled queue. The Sheets sync refusal path was re-checked by forcing a 403 at
the network layer — it still prints "not authorized" in destructive red rather
than a healthy-looking zero, which is the whole point of that branch.

- Changed: `src/components/cx-status-breakdown.tsx` (`CxCoverageCard` only),
  `src/components/sheet-sync-backlog.tsx` (all three branches — loading, error
  and loaded), `src/routes/_authenticated/admin.tsx` (pairs the two)
- Docs: `docs/features/reporting.md`
- Database: **none**

## 2026-09-18 — The Overview panels reach the Manager and the Closing Desk

The three panels built for the admin Overview earlier today are now the same
three panels on the **manager's Reporting tab** and on a new **Overview tab on
the Closing Desk**, extracted into one shared `OverviewPanels` rather than
copied. They are the business's own picture of itself; three copies of it would
start disagreeing within a month.

**Fixed: the first panel lied about its own window.** Its heading was the
literal word "Today" whatever the period chips were set to, while the figures
underneath were All time or Last 7 days. It now carries the selected window,
and the duplicate small label it used to print on the right is gone. On the
manager's tab the chips also moved above the panels — a control that changes a
heading has to be readable before that heading, not after it.

**No new access, and no database change.** The `_range` RPCs are all
`SECURITY INVOKER` reading `submissions` directly, so every figure was already
scoped by the caller's own RLS before any of this. Verified by calling them
under each role's own JWT rather than as admin:

| Role | Live | Uploaded | Validator | Scope |
|---|---|---|---|---|
| general_manager | 351 | 41 | 202 | every centre — same as admin |
| closing_manager | 56 | 1 | **0** | own centre only |

So a **closing manager** loses two things from the shared panel, because their
policy leaves both permanently dead rather than because either is secret: the
other centres (the per-centre RPC left-joins from `centers`, so they come back
present and zero) and the Validator row (their policy excludes that role
outright). Their own centre still shows even when it is genuinely at zero, and
Uploaded stays — a sheet-imported lead is written `submitted_by_role = 'closer'`
and is squarely inside their scope.

**The Closing Desk has a tab bar for every role now.** A closing manager used to
get the bare desk, because Parked Leads was the only other tab and it is not
theirs. Parked Leads is still gated on `move_to_validation`'s own rule; the
Overview is not. The desk stays first and stays the default — it is the screen
the role opens in order to work — and Radix leaves the Overview unmounted until
it is opened, so none of the reporting RPCs run before then.

**The manager's record strip was merged too, and had to be.** With the panels
merging uploads and validator submissions into one Manual and the strip beneath
them not, that screen printed "Manual 243" and "Manual 41" one above the other
— worse than either figure being wrong on its own. Both now say Live and Manual
in the same words with the same arithmetic; the only difference left between the
two dashboards' strips is the Timeouts and Rejections tiles, which stay on the
manager's, being the review desk's own failures.

- New: `src/components/overview-panels.tsx`, `src/components/closing-overview.tsx`
- Changed: `src/components/admin-overview.tsx` and `src/components/reporting.tsx`
  (both render the extracted row; `TotalsPanel`'s `variant` became
  `showReviewFailures`), `src/routes/_authenticated/closing.tsx`
  (tabs for every role, plus the new tab)
- Docs: `docs/features/reporting.md`, `docs/features/closing-desk.md`
- Database: **none** — no migration, no RPC, no policy touched

## 2026-09-18 — The admin Overview, redesigned: three panels and a split-flap board

The Overview tab was a single column of stacked panels. It is now three panels
across the top — **Today**, **Submission Outcome**, **L.A. Operations** — over
the record it always carried, following a layout sketched by the business.
The top row answers *what is happening now*; everything below it answers *what
happened over the selected window*.

**No database change.** Every figure already existed in
`submission_totals_range` and `submission_totals_by_center_range`; nothing was
added, replaced or recomputed. Verified against the live database: the centre
rows sum to Live exactly, because the centre RPC filters
`submitted_by_role = 'closer' AND source = 'live'`.

**Live and Manual, merged.** The headline origins are two, not three — Manual
is uploads plus validator submissions, the same merge the Submissions tab made
on 2026-09-15 when Closer/Validator/Manual became Live/Manual. The split is not
lost: Uploaded and Validator are their own rows in the panel's source
breakdown, and the Submissions tab's Type column still names each lead. This
closes an inconsistency `docs/features/reporting.md` had recorded as an open
follow-up.

**Counts flip like a departure board when they change.** A digit animates only
when that digit actually changes, once, over 400ms — nothing idles, nothing
loops, and a board that has not moved is completely still. These figures are
already re-fetched by a realtime subscription, so the flip is the cue that a
number moved while the reader was looking elsewhere. `prefers-reduced-motion:
reduce` swaps the value outright, checked in JS as well as in CSS because with
`animation: none` the `animationend` that retires the moving flaps would never
fire. Pure CSS 3D — **no animation library was added**.

**The manager's Reporting tab is unchanged**, which was the constraint on the
refactor and was verified by screenshotting the tab before and after. The
shared parts moved rather than being copied: one period derivation
(`usePeriod`), one chips component (`PeriodPicker`), one query layer
(`useOverviewStats`, query keys unchanged so both dashboards share a cache
entry), and the two record panels (`TotalsPanel`, `LeadsByCenterPanel`) are now
rendered by both screens instead of living inside one.

- New: `src/components/admin-overview.tsx`, `flip-number.tsx`,
  `submission-outcome.tsx`, `period-picker.tsx`, `src/lib/period-range.ts`,
  `src/lib/overview-stats.ts`
- Changed: `src/components/reporting.tsx` (consumes the extracted layers;
  exports `TotalsPanel`/`LeadsByCenterPanel`), `queue-flow.tsx` (optional
  `title`/`orientation`/`flip`/`className`, all defaulting to today's
  behaviour), `src/styles.css` (the split-flap utilities and keyframes; no new
  colour token), `src/routes/_authenticated/admin.tsx` (mounts `AdminOverview`)
- Docs: `docs/features/reporting.md`
- Database: **none**

## 2026-09-18 — The stuck uploaded leads are in the Sheet; backlog drained to zero

The Apps Script owner deployed, so the Validation Feed permission failure that
had held uploaded leads out of Google Sheets for ~12 hours is gone. Confirmed
by sending one stuck lead and reading the response rather than assuming from
the stale error — `{"results":[{"submission_id":"fd8dd23f…","ok":true}]}`.

The rest were then flushed in one sequential batch: **13 leads, every one
`ok: true`**, and `sheet_sync_backlog` now reads **0 queued / 0 in flight /
0 struggling**.

Two live leads (one closer, one validator) were also in the queue from the
minutes before, with the transient concurrency errors (`apps script http 404`,
`apps script returned an HTML error page`) rather than the permission one.
Those resolved on their own retry and needed nothing.

**Nothing was lost, which is the whole point of ADR 0006.** A failed write
accumulated instead of vanishing, so all 14 were still there to send when the
far end came back. The pre-queue behaviour would have dropped them silently and
there would have been nothing to flush.

One operational note now recorded in `docs/features/sheet-sync.md`: when
flushing by hand, call `resolve_sheet_syncs()` **after** the batch has actually
answered. Called too early it records `no response recorded` and costs the row
an attempt — which happened once here, on the probe lead, before the real send.

- `docs/features/sheet-sync.md` (status + limitation rewritten, manual-flush
  recipe added), `docs/TODO.md` (stuck-leads item removed)

## 2026-09-18 — Manual Submissions is searchable by its Type column

The Manual tab's Type column prints "Validator" or "Upload" on every row, and
searching for "upload" returned an **empty table**. Not a near-miss: no status,
disposition or source alias contains that word, so the term matched no clause
anywhere and the query came back with nothing. (The one profile whose name
contains "upload", "Descom Uploader", has uploaded zero leads, so even the
person-name clause found nothing.) "Validator" already worked, through
`matchesValidatorRole()`.

`matchesUploadKind()` now adds `source.eq.sheet` for "upload"/"uploaded" —
verified against the live data, where every Upload row is `source = 'sheet'`
and every Validator row is `'live'`, so the clause is exact rather than
approximate. Searching "upload" returns all 33 unarchived uploads; no validator
row's payload contains the word, so nothing extra is dragged in by the `or`
group. The clause is inert on the Live tab, which ANDs `source = 'live'` over
the whole group.

The placeholder now says "…status, source, type…", because an unadvertised
filter is barely a filter.

- `src/components/reporting.tsx`, `docs/features/reporting.md`

## 2026-09-18 — Validator submissions from before the centers existed get their center back

**Migration `20260918100000_backfill_validator_center.sql`.** The Center column
was blank on a batch of validator submissions in Submissions. Not a display
bug: `center_id` and `center_name` were genuinely NULL on 40 rows.

`submit_form_internal` stamps the center from the **submitter's profile at
submission time** — a snapshot, and deliberately so, since a lead should keep
the center it was taken in even if the person later moves. The side effect is
that assigning a center to a profile never reaches rows already submitted. Six
validators submitted between 2026-08-26 and 2026-08-29, before any validator
had a center; everything from 2026-08-31 onward is stamped correctly. So this
was historical, not an ongoing fault, and the migration is a no-op if re-run.

Reported for two validators (Maha Waheed 4, Rabia Ahmed 29). Checking the whole
table found four more with the identical problem in the identical window —
Shahzaib Imtiaz 3, Waqas Ahmed 2, Sardar Ali 1, Syed Zubair Hussain Shah 1 —
and all six were fixed together, 40 rows, 18 of them archived. The center is
read from each submitter's own profile rather than hardcoded, so no generated
id is baked into the migration.

**Nothing moved except the blank column**, which was checked rather than
assumed:

- `submission_totals_by_center` joins only `submitted_by_role = 'closer' AND
  source = 'live'`; every row touched here is validator-submitted, and a direct
  count confirmed **zero** updated rows fall in that view's scope. The Leads by
  Center figures did rise over the same period (UMS BPO 275 → 286, DESCOM
  46 → 48) — that is 13 new closer leads submitted since, accounted for
  exactly, not this backfill.
- The `closing_manager` branch of `submissions read scoped` also requires
  `submitted_by_role = 'closer'`, so no role can see a lead it could not see
  before.

**Deliberately left alone:** one uploaded lead (`source = 'sheet'`,
2026-09-11) whose uploader also had no center at import time.
`ingest_sheet_lead` stamps uploaded leads `submitted_by_role = 'closer'`, so
giving that row a center *would* newly expose it to that center's
closing_manager — a real visibility change, and its own decision rather than
something to carry along with a cosmetic backfill.

Documented the underlying trap in `docs/multi-tenancy.md`: set
`profiles.center_id` **before** someone starts submitting, because afterwards
only a backfill can repair it.

## 2026-09-17 — Uploaded leads finally have a draft date (and a normalised SSN)

**Migrations `20260917150000_lead_date_parsing.sql` and
`20260917150100_sheet_lead_derived_columns.sql`.** The CX queue's Draft Date
column was blank on every uploaded lead, and editing the payload to a proper
mm/dd/yyyy date did not fix it. Neither was a display bug:

- `submit_form_internal` was the **only** function in the database that wrote
  `draft_date`. `ingest_sheet_lead` inserted no `draft_date`, no
  `future_draft_date` and no `ssn_normalized` at all — so all 44 uploaded leads
  had all three null, never appeared on the By Draft Date desk, and were
  invisible to `check_duplicate_ssn`.
- `update_payload_field` wrote `payload` and nothing else, so a hand correction
  changed the text and left the column null. That is exactly the symptom
  reported.

Both now derive the three columns, through two new `IMMUTABLE` helpers:
`parse_lead_date(text, from_date)` and `normalize_ssn(text)`. The parser matches
by pattern and builds with `make_date`, so `DateStyle` cannot change its answer.

Uploaded leads mostly state a recurrence rather than a date — "3rd of the
month", "3rd wed of the month" — and those are resolved to the next real
occurrence so the leads reach the date-keyed screens at all, with the new
`roll-recurring-draft-dates` cron job (daily 05:23) moving them forward once a
date passes. An explicitly typed date never matches those patterns and is never
moved. `Every 2nd Friday` resolves to nothing and stays null, and the pipeline
shows that wording rather than an empty cell. See
[decisions/0006](docs/decisions/0006-recurring-draft-dates-resolved.md).

Backfill: 31 of 44 uploaded leads gained a `draft_date`, all 44 gained
`ssn_normalized`. The remaining 13 are the one unresolvable cadence and twelve
leads whose payload carries no draft text at all.

Also, in the CX detail sheet, the panel added yesterday moved below Lead Details
and is now headed **"Filled By Validator"** — it reads as the rest of the same
record, not as a separate thing above it.

## 2026-09-17 — The CX pipeline shows the carrier the policy was written on

**Migration `20260917140000_cx_pipeline_final_carrier.sql`.** The Customers
Pipeline's Carrier column rendered `carrierName(payload)` — the carrier as typed
on the intake form, which for a closer or an uploaded lead is only a *proposal*.
It was a deliberate choice once, and wrong twice over: a team servicing a live
policy needs to know who actually wrote it, and an uploaded lead carries no
carrier text in its payload at all, so the column was blank for exactly the
leads whose carrier was already known — in `final_carrier_id`, a column this
view never selected. Of the 25 uploaded leads in the pipeline, 19 have a final
carrier stamped and 1 has payload carrier text.

`cx_pipeline` gains five columns: `submitted_by_role`, `final_carrier_id`,
`final_carrier_name` (joined from `carriers`), `agent_name` and
`policy_number`. Resolving the name inside the view — rather than embedding it
per page — is what lets the column draw in one query and the search filter on
the name with no carriers lookup per keystroke. No policy change: `carriers` is
already readable by cxa/cxm and the view is `security_invoker`.

- **Final Carrier column**, through the shared `finalCarrierName()` in
  `ops.tsx`, which resolves both storage shapes (the FK for a reviewed lead,
  `payload->>'Agency'` for a validator's own submission, which never gets one).
  360 of 412 pipeline leads resolve a real final carrier. The 52 with none show
  their proposal muted and marked "· proposed", with a tooltip saying so —
  a dash would have taken text off a screen that had it.
- **A read-only Placement panel** in the detail sheet: Final Carrier, Agent
  Name, Policy Number. Read-only because `set_validator_fields` does not accept
  a CX role. On a validator-submitted lead the agent and policy are payload keys
  rather than columns, so each falls back before showing a dash — 191 of 412
  leads would otherwise read empty.
- **The search follows the column**: one more clause on `final_carrier_name`, so
  a carrier a reader can see is a carrier they can type.

## 2026-09-17 - Pin the Cloudflare worker name; deploys had been going to the wrong worker

`npm run build && npx wrangler deploy` reported **success** while the live site
kept serving the old build. The deploy was real - it was going to a different
worker.

Nitro auto-generates the worker name **from the git remote**:

```js
generateWorkerName() // remote.origin.url -> "owner/repo" -> slug
```

`bpoums/closerform` produced `bpoums-closerform`, which is the live site. When
the GitHub repo was renamed to `bpoums/Astrax-CRM` the generated name became
`bpoums-astrax-crm`, so every deploy since published a brand-new worker at a
different address. Nothing in wrangler's output indicated a problem, because
nothing was wrong from its point of view.

Added `wrangler.json` at the repo root pinning `name` (Nitro's
`readWranglerConfig` merges a user config over its defaults, and the auto-name
only applies when `name` is unset). The deploy target no longer depends on what
the repo is called.

Pinned `compatibility_date` in the same file while there. It had been stamped
with **today's date** on every build, and Cloudflare rejects a date it
considers to be in the future - the reason every deploy had to pass
`--compatibility-date` by hand and why deploys broke after ~7pm PKT. Builds are
now deterministic and `npx wrangler deploy` is correct on its own.

- `wrangler.json` (new), `CLAUDE.md` (deployment section corrected - the flag is
  no longer required)

**Leftover to clean up:** the accidental `bpoums-astrax-crm` worker is live and
public, serving a full copy of the CRM against the same Supabase project. It
should be deleted (`npx wrangler delete --name bpoums-astrax-crm`).

## 2026-09-17 - Sheets sync backlog card, and the view it reads stops leaking to anon

ADR 0006 said plainly that the admin card was "not optional decoration": the
queue's whole design is that a failed write accumulates instead of vanishing,
which is only an improvement if somebody sees it. It was never built, so the
queue was unwatched - and it currently holds **13 rows, 8 attempts each, 1.6h
old**, all failing with the same Apps Script permission error. Nothing in the
app said so.

`SheetSyncBacklogCard` now sits on the admin Overview tab: queued, in flight,
how many are failing, and the age of the oldest. It deliberately does not print
the Apps Script error - that comes back in the script owner's own locale, so it
lands in whatever language that account is set to, and unreadable text under a
red number is noise rather than a diagnosis. It stays available in SQL via
`select sample_error from sheet_sync_backlog`.
It reads destructive when anything has failed 5+ times **or** the oldest item
is over 10 minutes old - a large queue that is moving is a busy morning, a
small one that is not is a fault, and a count alone cannot tell those apart.
Read-only: the cron drains every 60s and retries with backoff, so a button
would mostly duplicate that.

**Two security bugs found while building it, both of which fail open while
looking like a working guard.**

*The view was readable by `anon`.* `sheet_sync_queue` has RLS enabled with zero
policies so the client cannot reach it - but `sheet_sync_backlog` is a view
over it that does not set `security_invoker`, so it runs as its owner and
bypasses RLS, and Supabase's default grants gave `SELECT` to `anon` and
`authenticated`. Verified with no JWT at all:

| as | `sheet_sync_queue` | `sheet_sync_backlog` |
|---|---|---|
| `anon` | 0 rows (RLS holds) | **`queued = 13`** |

Both grants revoked; the view is SQL/ops-only. The admin reaches the numbers
through `sheet_sync_backlog_status()`, a `SECURITY DEFINER` RPC that re-checks
the caller's role - the pattern ADR 0001 requires.

*`my_role() <> 'admin'` is not a guard.* `my_role()` returns NULL for a caller
with no profile, no JWT, or an **inactive** profile, and `NULL <> 'admin'` is
NULL rather than true - so the `IF` never fires and the function returns its
data. The first version of this RPC had it, copied from the existing house
style, and returned the backlog to a caller with no JWT. Fixed to
`is distinct from`. Also: `revoke ... from public` does not remove `anon`'s
EXECUTE, because Supabase grants it to `anon` directly - the role must be named.

**~20 pre-existing RPCs share the second bug and are NOT fixed here**, including
`admin_settings` and `reporting_retention_status`, both confirmed returning
data to `anon` with no JWT. Several are writes (`archive_submission`,
`assign_to_validator`, `set_admin_setting`, `approve_import_batch`). This also
contradicts `CLAUDE.md`'s claim that deactivating a profile cascades through
"every policy and every RPC" - it cascades through every policy, because RLS
compares with `=`, but not through these. Catalogued in the new `docs/TODO.md`
and corrected in `CLAUDE.md`; fixing them is its own change.

- `supabase/migrations/20260917130000_sheet_sync_backlog_admin_only.sql`
- `src/components/sheet-sync-backlog.tsx` (new), mounted in `admin.tsx`
- `src/integrations/supabase/types.ts` (regenerated)
- `docs/features/sheet-sync.md` (new), `docs/TODO.md` (new), `docs/database.md`,
  `docs/decisions/0006-...md`, `CLAUDE.md`

## 2026-09-17 - RLS policies stop re-evaluating my_role() once per row

The app had been getting slower as the database grew, and cloud Supabase was
the suspected cause. It was not. The database is **27 MB / 633 submissions** -
small enough to sit entirely in cache - and on the manager queue query the
index scan took **0.058 ms** while the whole query took **14.8 ms**. Finding
the rows was free; **~99% of the time was the RLS filter**. Self-hosting would
have moved the same policy onto a slower machine behind a worse network path
and fixed nothing.

The cause: policies called `my_role()` bare, so Postgres evaluated it **once
per candidate row**. `my_role()` is `SECURITY DEFINER` and runs
`select role from profiles where id = auth.uid() and active`, so every row
scanned cost a `profiles` lookup plus a JWT parse. Being `STABLE` *permits*
hoisting but does not force it - Postgres will not hoist a function call
inside a `CASE` in a filter expression.

Proven by A/B on the same query and rows, changing one call site only:

| predicate | execution |
|---|---|
| `case my_role() ...` | 8.46 ms |
| `case (select my_role()) ...` | 5.17 ms |

**~6 us per row per call site**, linear in table size - which is exactly the
reported symptom. At 633 rows that is ~4 ms per call site; at 60,000 it is
~360 ms, and there were 20 call sites.

All 20 policies across 15 tables were recreated with each bare `my_role()` and
`auth.uid()` wrapped as a scalar subquery, which forces a single InitPlan
evaluation. Nothing else in any predicate changed. The plan now reads
`CASE (InitPlan 1).col1` with `loops=1`.

| query | before | after |
|---|---|---|
| manager queue (`pending_manager`, 50) | 14.78 ms | **1.32 ms** |
| manager `count(submissions)` | - | 2.74 ms |
| manager `count(form_events)` (3,555 rows) | - | 1.59 ms |
| closing_manager `count(submissions)` | - | 1.24 ms |
| general_manager `count(submissions)` | - | 0.99 ms |

**Verification, because this is the security boundary.** Before applying, a
role x table matrix recorded the visible row count for **every one of the 58
profiles** against all 19 RLS-protected tables - not one representative per
role, so per-user scoping like `closing_manager`'s centre was covered too. The
same matrix was recaptured afterwards and compared in SQL: **1,121 cells, 0
differing.** The matrix is discriminating rather than uniformly zero (admin
633, manager 622, general_manager 546, cxa 413, closing_manager 47,
closer/validator/anon 0, `data_uploader` 0-26 varying per user), so an
unchanged result is evidence and not an artefact. Writes were checked
separately, since the matrix only covers reads: admin updates `profiles` (1
row), a closer cannot (0 rows), a closer insert into `carriers` raises, and no
test value leaked. `auth_rls_initplan` is gone from the advisor and no new
security finding appeared.

**Deliberately not done**, and worth knowing why: the advisor's 21 "unindexed
foreign keys" were left alone - `submissions` already carries 17 indexes
covering every column the app filters on, and the flagged columns
(`archived_by`, `disposed_by`, `last_timeout_by`, ...) are only read through
embedded profile joins that resolve against `profiles.id`, already the primary
key. Twenty-one more indexes would add write cost on every insert for no
measurable read gain. The 25 "multiple permissive policies" findings were also
left: real, but on single-digit-row vocabulary tables, and merging two policies
into one is a genuine change to the boundary rather than a timing fix - the
wrong thing to bundle into a performance pass.

Also corrected in `docs/database.md`: the zero-policy table list named only
`app_config` and `payment_details`; `sheet_sync_attempts` and
`sheet_sync_queue` are also zero-policy, confirmed live.

- `supabase/migrations/20260917120000_rls_initplan_wrap_role_checks.sql`
- `docs/database.md` (Row-Level Security summary)

No application code changed - this is invisible to the client.

## 2026-09-17 - Sheets sync moved to a durable queue; leads can no longer be dropped

Fire-on-trigger sync could not survive concurrency, and it was losing leads.
Measured on this project, firing N syncs at once failed ~20% of the time at
N=5, ~30% at N=20 and **~61% at N=59** - Google rejects concurrent requests to
an Apps Script web app (as 404s, or as HTTP 200 carrying an HTML error page),
and the script serialises itself on a 30-second LockService lock regardless.
**Thirteen leads had never reached Sheets at all, four of them completed
sales.** With ~100 closers and validators submitting at once this becomes
routine data loss.

The old retry made it worse rather than better: it abandoned a row permanently
after 3 attempts (`gave_up`, surfaced to nobody), and it retried by looping
over every pending attempt firing each one - recreating the very burst that
caused the failure. `pg_net` batches its dispatch, so this could not be paced
from SQL; `pg_sleep` between calls does nothing, because the worker collects
whatever is queued and fires it together.

`notify_sheet_sync()` now enqueues into `sheet_sync_queue` instead of making an
HTTP call. Every guard about *whether* to sync is unchanged. The queue is keyed
by `submission_id`, which is load-bearing: a lead whose status changes four
times before the drain runs collapses into one row and one write carrying the
final state.

`drain_sheet_sync_queue()` sends up to 25 rows as **one** request rather than
25, and `sheet-sync` v13 walks a batch **sequentially**, so Apps Script only
ever sees one request at a time - the fix for the concurrency failure, achieved
without touching the Apps Script, whose deployment we do not own.
`resolve_sheet_syncs()` reads per-row results back, so one bad row in a batch
retries one row rather than 25, and **a row is only ever deleted on confirmed
success**; anything else backs off exponentially (30s, 1m, 2m ... capped at 1h)
and is never abandoned. `sheet_sync_backlog` exposes queue depth and age.

A follow-up migration (`20260917110000`) stops the drain starting a second
batch while one is in flight. The first live burst showed a 25-row batch
outrunning the 60-second cron interval, so two batches overlapped and six rows
came back with the same concurrency error the design exists to remove. They
were retried and delivered rather than lost - which was the point - but the
overlap is now prevented outright.

Verified on rollout: a 60-lead burst, the scenario that previously lost ~60%,
drained to zero with no permanent failures. The only rows left queued are the
13 blocked on the **Astrax Uploader Feed** permission error, which is an Apps
Script access problem for its owner to fix - they now retry safely until then
instead of being dropped.

## 2026-09-16 — The manager can see why CX sent a lead back, read its history, and find it

**No database change.** Three gaps on the Operations queue, all reported from
the floor.

- **The CXA's return reason now reaches the manager.** It was never lost —
  `return_lead_for_validation` writes it as the `reopened_from_cx` event's
  `detail->>'reason'` — but nothing on the manager's screen read it. The queue
  now batches those events for its returned rows (newest per lead, since a lead
  can make the round trip more than once) and shows the reason in a clamped
  **Reason** column on the CXA Returned tab, with the whole of it on hover, and
  in full in a "Returned by CX" block at the top of the detail sheet.
- **View History** in the detail sheet, mounting the same `LeadHistoryDialog`
  the closing desk, the CX pipeline, the draft-date desk and reporting already
  use: the validation passes and the customer lifecycle, each at the dialog's
  full width. The manager queue was the one lead screen without it.
- **Search**, beside the tab list, matching the customer's name. The queue
  already holds every open row, so this filters what is loaded rather than
  querying — unlike the paged tables, which must search server-side. It narrows
  **only the open tab**; the other tabs keep whole counts, so a term that
  matches nothing on Live does not imply the lead does not exist. Changing the
  term clears any pending bulk selection, exactly as changing tab does.

Also worded `cx_removed` / `cx_restored` in `event-labels.ts` — they shipped
with the CX queue work earlier today and were falling through to the generic
humanizer ("Cx removed") in the very timeline this change puts in front of a
manager.

## 2026-09-16 — The CX queue keeps its leads: retention, removal and editing

**Migration `20260916140000_cx_queue_retention.sql`.** Pressing **Return For
Validation** used to delete the lead from the CXA's own screen. The pipeline was
defined as `disposition = 'accepted'`, and returning a lead clears the
disposition — so the CXA lost sight of the lead at the moment they were waiting
on an answer about it.

Membership of the pipeline is now "a lead CX has not finished with":
non-archived, not CX-removed, and either accepted **or** carrying
`reopened_from_cx_at`. It is spelled once as `cx_pipeline_member(p_sub)`, which
every CX RPC guards on, and inline in the `cxa`/`cxm` branches of the
`submissions` RLS policy (a policy on `submissions` cannot call a function that
reads `submissions`). `cx_pipeline` follows the same rule and now carries
`status`, `disposition` and `reopened_from_cx_at`.

- **A returned lead stays put**, marked "In Validation" where the Return button
  was, with its four CX statuses still editable. `return_lead_for_validation`
  keeps its strict `disposition = 'accepted'` guard, so a second send is refused
  server-side and not merely hidden.
- **`remove_from_cx_pipeline(p_sub, p_reason?)`** (cxa/cxm/admin) is the only
  thing that takes a lead off the queue. It is not an archive: reporting,
  exports, the manager's queue, the sheet and the lead's own history are
  untouched, and it changes none of the columns `notify_sheet_sync()` watches,
  so no Sheets write fires. **`restore_to_cx_pipeline(p_sub)`** (admin) undoes
  it, from the new `RemovedFromPipeline` panel on the admin's Pipeline tab.
- **A CXA can correct the lead they are servicing.** The detail sheet mounts the
  same `LeadPayload` editor a manager uses (per-field `update_payload_field`,
  one `payload_edits` before/after row each) and an editable `PaymentPanel` for
  the four bank-draft fields. `update_payload_field` and `update_payment_field`
  gained `cxa`/`cxm`, scoped by `cx_pipeline_member` to their own queue. The
  card-credentials check was not touched — the same line that refuses a manager
  refuses a CXA, and no CX screen renders a card number or CVV input.

Applying this brought 39 previously-returned leads back onto the queue; they
already carried `reopened_from_cx_at`. See
[decisions/0005](docs/decisions/0005-cx-queue-retention-and-removal.md).

## 2026-09-16 — Merged 74 legacy validator re-types back onto the closer's row

**Data repair, no code change.** Before 2026-09-07 a validator had no way to
record the carrier that actually wrote a policy, nor the agent name or policy
number, on a closer's lead. When a closer forwarded a lead proposed for one
carrier and a different carrier accepted it, the validator re-typed the entire
lead through "New Submission" with the correct details — one real sale,
recorded twice. `set_validator_fields` ended the practice.

The data dates the cutover precisely: closer leads carrying a `final_carrier_id`
go from 0–1/day before 09/05 to 4–18/day from 09/07, and no closer lead since
09/05 shares an SSN *or a name* with a validator submission. The last re-typed
pair is 09/04.

Matching on `ssn_normalized` found 74 such pairs. The two halves are
complementary — the closer row has the attribution and the proposed carrier, the
validator copy has the true carrier (`payload['Agency']`), policy number and
agent name — so `20260916100000` keeps the **closer's** row (attribution drives
commission and the leaderboard) and lifts everything the copy knows onto it:
the three columns, plus every payload key the validator filled and the closer
left empty. Gap-fill only; nothing entered by a closer was overwritten.
Result: final carrier / agent / policy 5 → 74, future draft date 0 → 54, and
245 further payload fields recovered (email address on 53, bank type on 23,
card details where present). Verified afterwards that no closer row gained
`Agency` / `Agent Name` / `Policy Number` as payload keys — `Agency` especially
would have been read by `CARRIER_KEYS` and rendered as the proposal.

`20260916110000` then archives the 74 consumed copies — archived, not deleted,
so they stay readable under the admin panel's "Show archived" and restorable.
It mirrors `archive_submission()` (same cleared assignment fields, same
`form_events` entry) so they look like any other archived lead;
`archived_by`/`actor_id` are null because no person performed it, with the
reason string carrying the audit trail.

Accepted rows for 25 Aug – 4 Sep fall from **256 to 190** against 184 real
sales — a 39% overstatement reduced to 3%.

**Two rows deliberately left active.** Elizabeth Holmander and Tommy L Davis
each had a *second* validator submission under a different carrier, policy
number and premium — genuine second policies, not duplicates. The merge only
ever consumed the earliest copy per customer, so archiving all 76 would have
erased two real sales.

Both migrations disable `sheet_sync_on_closed` for their duration: 74
simultaneous `net.http_post` calls overrun the Apps Script 30-second lock. **The
Google Sheet therefore still shows all 74 as live** — the sync has no delete
path, so a row leaving the database never leaves the spreadsheet on its own.

## 2026-09-15 — Closing desk can filter by submitted date

The desk could be narrowed by search, origin, status, disposition, centre and
four CX categories, but not by date — a closing manager working a day's book
had to page through everything. Adds a From/To pair over `created_at`, the
date the "Submitted" column already draws, for both roles that reach the
screen (`closing_manager` and `general_manager`). A blank "To" filters exactly
the single day in "From", and the pair composes with every other filter rather
than replacing them.

Boundaries come from the existing `reporting_window` RPC rather than browser
date maths, for two reasons. A Pacific calendar day is not a UTC day and the
gap is real, not theoretical: for 2026-09-14 the Pacific window holds 27
closer leads where a naive `created_at::date` comparison holds 25. And reusing
the RPC is what keeps a "today" here meaning the same day as a "today" in
Reporting, instead of two screens quietly disagreeing about midnight.

No new access: `reporting_window` is already granted to `authenticated`, is
not `SECURITY DEFINER`, and takes no submission id while returning only
`{since, until}`. The rows stay scoped by the `submissions` RLS policy, so the
filter only ever narrows — a closing manager filtering by date still sees only
their own centre. `created_at` was already in the query's select, so nothing
about what the database returns changed either.

Also worth knowing, unchanged here: `DraftDateDesk` is mounted only for admin
and manager, so closing and general managers still have no draft-date view.

## 2026-09-15 — Parked Leads gets the detail panel it never had

A parked ("External Transfer") lead could be seen in the table but not opened,
so the decision to release it into validation was made against a customer name
and a date. This was not a broken panel: `ParkedLeads` had no `openId` state,
no `Sheet` and no click handler on its rows. It was never built.

Rows are now clickable and open a `Sheet` rendering `PayloadTable` — the same
component every other detail view uses, so a parked lead reads identically
here and in Reporting. No query changed: `payload` was already in the
component's `SELECT` and was simply never rendered, which also means no change
to what the database returns or to any RLS surface. An admin could already
read all six parked leads in Reporting → Submissions; this puts the same thing
one click from where the decision is made, for both roles that can act on it
(admin, and general_manager at `/closing?tab=parked`).

"Move to Validation" now appears inside the panel as well as on the row, both
driven by the one existing mutation. The row's button stops event propagation
so it does not also open the panel, and a successful move closes the panel —
the lead leaves the list at that moment and the panel would otherwise sit over
a row that no longer exists.

Recorded as a known limitation rather than changed here: a parked lead's
payload renders unmasked, banking fields included, because the closer form
writes `Routing Number` / `Account Number` / `Card Number` / `Exp Date` / `CVC`
straight into `payload` and `PayloadTable` masks none of them. That is
pre-existing and applies equally to Reporting, the manager queue and the
customers pipeline. See `docs/features/closing-desk.md`.

## 2026-09-15 — sheet-sync no longer reports failed Google Sheets writes as successes

Uploaded leads were reaching Google Sheets' door and being turned away, with
every layer reporting success. Diagnosed from the edge function logs: Apps
Script was throwing

> `Exception: リクエストされたドキュメントにアクセスする権限がありません。（行 26、ファイル「Code」）`
> — *"You do not have permission to access the requested document"*

on line 26, `SpreadsheetApp.openById(sheetId)`. The routing was correct (the
log line reads `synced … uploaded …`), but the Apps Script project has no
access to the **Astrax Uploader Feed** spreadsheet. That part is a Google
permissions fix, outside this repo.

What *was* ours: an Apps Script web app answers **200 even when `doPost`
threw**, returning its HTML error page instead of the `'ok'` the handler sends
on success. `sheet-sync` only checked `res.ok`, so every exception was logged
as a synced row, recorded `resolved_status = 'ok'` in `sheet_sync_attempts`,
and gave `retry_failed_sheet_syncs` nothing to retry. Sync could fail
indefinitely with no signal anywhere.

**sheet-sync v12** adds `appsScriptFailure()`, which inspects the body for the
three failure shapes that arrive as 200 — an HTML error page, any `Exception:`
text, or the literal `unauthorized` on a secret mismatch — and returns 502 so
the attempt is recorded truthfully and retried. It also logs just the extracted
`Exception:` line rather than ~8KB of Google's CSP shim. Verified against the
still-failing lead: the sync now returns `502 apps script error` where it
previously returned `200 {"ok":true}`.

Separately worth knowing: an uploaded lead does not sync at all until its
import batch is approved — `notify_sheet_sync()` returns early while
`source = 'sheet' and status = 'pending_import_approval'`. That is by design,
not a fault, but it means a freshly uploaded lead is legitimately absent from
the Sheet until a manager accepts the batch.

## 2026-09-15 — Proposed Carrier vs Final Carrier, split apart

Two different facts had been sharing one name. What a closer types is the
carrier they *pitched*; what the policy is actually written on is the
validator's `final_carrier_id`. Both surfaced as "Carrier Name", so reporting
could not tell the two apart — and on 80 live leads they genuinely differ
(pitched "American Amicable", written TransAmerica).

The closer form's field is now **Proposed Carrier**. Because a closer-form
label is simultaneously the payload key, the Google Sheet column header and
the spreadsheet-import target, that one rename moved all three; migration
`20260915120000` brought the 285 pre-existing rows onto the new key, with the
sheet-sync UPDATE trigger disabled so the statement could not fire ~285
`net.http_post` calls at once. It is idempotent (`where payload ? 'Carrier
Name'`) and worth re-running after the front-end deploy to sweep up anything
the old bundle wrote in between. The Sheet's own header cell is renamed by
hand, which keeps the existing column and its history.

The conflict between the two forms resolves as a lifecycle, not a collision —
a validator submission simply has no proposal stage, because that form is only
filed once the carrier has accepted:

- **Proposed Carrier** — `payload['Proposed Carrier']`, closer/uploaded only.
- **Final Carrier** — `final_carrier_id` -> `carriers.name`, or `Agency` for a
  validator's own submission, or null when not yet determined. Read through
  the new `finalCarrierName()` in `ops.tsx`; `PAYLOAD_LABEL` now relabels
  `Agency` as "Final Carrier", which is what it always meant.

Reporting gains **two carrier boxes** instead of one. Each is its own
PostgREST `or` group and repeated groups AND together, so filling both asks
for the intersection — "pitched Amicable, written on TransAmerica" (8 leads)
is now directly askable, which one combined box could not express. The Final
box spans both storage shapes, resolving typed text to carrier ids via the new
`matchingCarrierIds()` because the column holds a uuid.

Also fixed: the Sheet's `Final Carrier` column was blank on all 260 validator
rows, since it was resolved only from `final_carrier_id`. Migration
`20260915121000` falls back to `Agency` for those, gated on the role so a mere
proposal is never reported as an issued policy.

## 2026-09-15 — Reporting: Live/Manual chips replace Closer/Validator/Manual

The Submissions explorer (shared by admin → Submissions and the manager's
Reporting tab) split leads across three chips. The business categorises them
as two: a closer's phone lead is *Live*; a validator's own submission and an
uploaded lead are both *Manual*. So "Closer Submissions" is now "Live
Submissions", and the Validator and Manual chips are one.

Merging the two tables meant resolving two columns that would otherwise have
changed meaning depending on which kind of row you were looking at:

- **Source** said "Manual" for both kinds (`sourceLabel()` maps a validator
  submission and a sheet upload to the same word), so inside a tab already
  named Manual it said nothing — and the reader lost the one thing the tab
  split gave them for free. Replaced by **Type** (Validator / Upload).
- **Validator** meant the *author* on the old Validator tab but the
  *assignee* on the Manual tab. Split into **Submitted By** (the uploading
  centre, or the validator themselves) and **Validated By** (a dash on a
  validator row, which is the fact: it auto-accepts on submit and is never
  assigned to anyone).

Validation Status and Disposition were kept and show their real stored values
on validator rows — "Completed"/"Submit", constant but true, and consistent
with what the row's own detail sheet shows. The Manual selection is spelled
once in `applyManualTabFilter()` since the paged fetch and the chip's
head-count both use it and must agree. Searching "manual" or "validator" now
also matches validator submissions, which are stored `source='live'`.

Not changed: the Overview stat strip still reads Closer/Manual/Validator —
those are `submission_totals` view columns, and merging them properly needs a
view migration rather than a client-side sum. A known inconsistency, left for
a follow-up.

## 2026-09-15 — Validators get a real Center field in Users, not a dash

An admin had set every validator's `center_id` to UMS BPO directly (already
correct live), but the Users tab still showed a plain "—" for every
validator's Center cell, because `CENTER_ROLES` in `src/lib/centers.ts` only
listed `closer`, `closing_manager`, and `data_uploader` — the roles a center
is actually read for server-side. Added `validator` to that list: it's
tracked as roster information only (nothing server-side reads it, unlike
`closing_manager`'s queue-scoping use), but is now visible and editable in
the Users table and required (with the same real dropdown data_uploader
already used, in place of the old free-text "Center / Organisation" box)
when inviting a new validator.

## 2026-09-14 — Manager Operations gets a dedicated "CXA Returned" tab

A lead sent back from the Customers Pipeline via "Return For Validation"
(`return_lead_for_validation`) used to reappear mixed into whichever of the
Live/Manual tabs matched its original `source`, indistinguishable from a
fresh submission without opening the row. The Operations queue in
`src/routes/_authenticated/manager.tsx` is now three tabs — Live, Manual,
CXA Returned — and any row carrying `reopened_from_cx_at` is classified into
the new tab regardless of origin (`queueTabOf()`), which shows Origin
(Live/Manual), who handled it, and how long ago CX sent it back. No RPC,
RLS, or schema change — purely a client-side reclassification of rows the
existing queue query already fetched.

## 2026-09-12 — `sheet_sync_attempts` now cascades on submission delete

Deleting a submission from Supabase Studio failed with a foreign-key error
whenever that lead had a logged sync attempt — `sheet_sync_attempts_submission_id_fkey`
was created without a delete rule, unlike every other table referencing
`submissions.id` (`form_events`, `payment_details`, `carrier_declines`, etc.),
all of which already cascade. Since `sheet_sync_attempts` is pure internal
bookkeeping never read by the client, there's no reason it should outlive
its parent row. Migration:
`supabase/migrations/20260912180000_sheet_sync_attempts_cascade_delete.sql`,
applied to the live project.

## 2026-09-12 — Fixed a race that could leave a parked lead's Google Sheet row stale

A parked ("External Transfer") lead could show `parked` correctly in
Supabase while Google Sheets still showed `pending_manager` — confirmed live
on a real lead. Root cause: `submit_form_parked` inserted the row
(`status='pending_manager'`, firing the sheet-sync INSERT trigger) then
immediately updated it to `status='parked'` (firing the sheet-sync UPDATE
trigger) — two outbound syncs for the same lead in one transaction, with no
guarantee Apps Script's upsert-by-`Submission ID` processes the newer one
last.

Fixed by extracting the shared insert logic into a new, **not
client-callable** `submit_form_internal(p_payload, p_status)` (`EXECUTE`
revoked from `anon`/`authenticated`) — `submit_form` and
`submit_form_parked` are now thin wrappers over it, and a parked lead is
created with `status='parked'` in its one INSERT instead of insert-then-
update, so exactly one sync ever fires. Migration:
`supabase/migrations/20260912170000_fix_parked_lead_sheet_sync_race.sql`,
applied to the live project. See
[docs/decisions/0005](docs/decisions/0005-single-insert-status-to-avoid-sheet-sync-races.md)
and [docs/database.md](docs/database.md).

## 2026-09-12 — Sales Breakdown reporting tab (plan type, carrier, state, closer leaderboard)

New admin-only tab (`Admin → Sales Breakdown`, `src/components/sales-breakdown.tsx`)
answering: how many Level/Graded/Mod/GI sales were approved (`disposition =
'accepted'`), the same broken down per carrier and per customer state, and a
closer leaderboard (best/worst by accepted-sale count) over This Week / This
Month / All time / Custom.

Read-only, no migration — reuses `reporting_window` (the same Pacific-day RPC
`SubmissionsExplorer` already calls for its own date filter) for the period
math, and the alias-aware normalizers the upload engine already owns
(`src/lib/normalize/carriers.ts`'s `lookupCarrier`, `src/lib/normalize/states.ts`'s
`STATE_CODES`) to fold messy free-text payload values ("TRANSAMERICA" /
"COREBRIDGE", "Texas" / "TX") into the same row rather than re-deriving that
matching in SQL. New pure helper `src/lib/plan-type.ts` buckets the "Plan
Type" field into Level/Graded/Mod/GI/Unspecified — Mod kept as its own
bucket rather than folded into Graded, since it's the rarer, more specific
category. The closer leaderboard excludes `submitted_by_role = 'validator'`
rows — those auto-close as accepted and stamp `closer_id` with the
validator's own id, which otherwise surfaced every validator as a "closer"
with a trivial 100% conversion rate. "This Week"/"This Month" were corrected
from a rolling 7/30-day window to real calendar boundaries (Monday-to-today,
1st-of-month-to-today) — the rolling version made "This Month" read
identical to "All time" with under 30 days of data in the system, and read
wrong regardless of data age against the actual ask ("only September"). The
By Carrier breakdown also had a case-sensitivity bug — "American Amicable"
and "AMERICAN AMICABLE" (same text, different case) counted as two separate
rows; carrier grouping is now case/whitespace-normalized. A new local
`prefixMatchCarrier()` also folds an unregistered product-name variant
("Corebridge GIWL", "Transamerica Express Select") into its carrier when the
text starts with a registered name/alias, without requiring a new exact
alias per product — deliberately kept local to this report rather than
loosened in `src/lib/normalize`, whose exact-match-only behavior is a
safety property the upload-import pipeline still needs. See
[docs/features/sales-breakdown.md](docs/features/sales-breakdown.md).

## 2026-09-12 — CX reopen is now an explicit "Return For Validation" action

Fixes a bug and changes a workflow found while investigating it. A
validator-submitted lead that a CXA declined disappeared from the CXA
pipeline but never reached the manager's Operations queue as
[decisions/0004](docs/decisions/0004-only-accepted-is-terminal.md) says it
should. Root cause: `set_cx_status` did correctly reopen the lead
(`status='pending_manager'`, `reopened_from_cx_at` stamped), but
`manager.tsx`'s queue query unconditionally excludes every
`submitted_by_role = 'validator'` row — including one that had just been
reopened, since that column is permanent lineage and is never cleared.
`src/routes/_authenticated/manager.tsx`'s Operations query now admits a row
regardless of `submitted_by_role` when `reopened_from_cx_at` is set.

Separately, the workflow itself changed: a CX status change no longer moves
a lead out of the pipeline by itself. `set_cx_status` (database function) is
now a pure status write for all four categories — policy included. Sending a
lead back to the manager is a new, explicit, standalone action instead: the
`return_lead_for_validation(p_sub, p_reason?)` RPC, exposed as a **"Return
For Validation"** button (`ReturnForValidationButton` in
`src/components/cx-status-cell.tsx`) added as its own column in the
Customers Pipeline table (`src/components/customers-pipeline.tsx`). A CXA can
now record a policy as declined without the lead leaving their queue, and
hand it back only when they mean to.

Database: `supabase/migrations/20260912000000_cx_explicit_return_for_validation.sql`
replaces `set_cx_status` and adds `return_lead_for_validation`, applied to
the live project.

## 2026-09-11 — Parked Leads count on the tab trigger (Closing + Admin)

Same pattern as the Pending Imports count added earlier today. A general
manager (and a closing manager, cosmetically — the query is disabled for
them since they never see this tab) previously had no way to know whether
any leads were parked without opening the tab.
`src/routes/_authenticated/closing.tsx`'s "Parked Leads" trigger now reads
"Parked Leads (N)", via a small always-on head-count query
(`enabled: canMoveParked`) sharing `parked-leads.tsx`'s exported
`PARKED_LEADS_KEY` prefix, so `move_to_validation`'s existing invalidation
of that key refreshes the count for free.

Admin's own "Parked Leads" tab (`src/routes/_authenticated/admin.tsx`) had
the identical gap and got the same fix for consistency.

Both client-side only; no database, RLS, or RPC change.

## 2026-09-11 — Per-tab counts on Submissions chips and Pending Imports

`SubmissionsExplorer` (`src/components/reporting.tsx`, shared by Admin →
Submissions and the manager's Reporting tab): the heading is now the plain
"Submissions" label, and each of the three chips shows its own count —
"Closer Submissions (N)", "Validator Submissions (N)", "Manual Submissions
(N)" — matching whatever search/carrier/archived/date filters are currently
active, via a new lightweight head-count-only query that runs for all three
tabs at once (the paginated row fetch stays lazy, only the active tab's).

Manager's "Pending Imports" tab trigger now shows the batch count waiting
for approval ("Pending Imports (N)") without needing to open the tab —
`src/routes/_authenticated/manager.tsx` gained a small always-on count
query against the existing `pending_import_batches` view, sharing
`PENDING_IMPORTS_KEY` so the realtime invalidation already in place covers
it for free.

Both are client-side only; no database, RLS, or RPC change.

## 2026-09-11 — Per-tab counts on the manager Operations queue

`src/routes/_authenticated/manager.tsx`'s Live/Manual tabs now show their
own count ("Live (92)", "Manual (2)") instead of one combined total on the
"Open submissions" heading — no more clicking over to Manual just to see
how many are there. Purely client-side (`allRows` was already fetched by
the existing query); no database, RLS, or RPC change.

## 2026-09-10 — Date-range filtering on Admin → Overview and → Submissions

Added a "Custom" date option to the Overview tab's period selector (From/To,
To optional for a single-day filter) and an independent From/To date filter
to the Submissions tab's filter bar. Both reuse one new shared DB function,
`reporting_window`, rather than computing Pacific-day boundaries in the
browser.

`supabase/migrations/20260910220000_reporting_date_filter.sql`: new
`reporting_window(p_days, p_start_date, p_end_date)`; extended
`submission_totals_range`, `submission_totals_by_center_range`,
`validator_stats_range` to accept the same two new optional parameters
(existing `p_days`-only calls unaffected). Applied live; regenerated
`src/integrations/supabase/types.ts` afterward.

**Caught and fixed during rollout**: `CREATE OR REPLACE` with a new
parameter list creates a second overload instead of replacing the original,
which made every existing single-argument call to these three RPCs
ambiguous the moment the migration landed. Fixed immediately by dropping
the old one-argument overloads (now part of the same migration file, so a
fresh replay produces the correct end state directly). See
`docs/database.md`'s note under the `_range` RPCs for detail.

This log starts from this documentation audit (2026-09-10) going forward.
The "Reconstructed history" section below is derived from `git log` commit
messages for context — it is a best-effort summary of past work, not a
verified line-by-line record, since most early commits are simply titled
"Changes."

## 2026-09-10 — Google Sheets sync: retry logic + corrected architecture

Follow-up to the same-day timeout fix below. Reading the actual deployed
source of both downstream hops (the `sheet-sync` Edge Function, and — shared
directly by the user — the Apps Script `doPost` handler it calls) revealed
the real architecture: Postgres → Edge Function → Apps Script, with a second,
previously-uncapped timeout risk on the Edge Function → Apps Script hop
(Apps Script holds a lock for up to 30s under concurrent requests). It also
confirmed retries are safe: Apps Script upserts by `Submission ID` rather
than blindly appending, so re-sending a submission can never create a
duplicate row.

`supabase/migrations/20260910210000_sheet_sync_retry.sql`:
- Raised the Postgres → Edge Function timeout further, from 20000ms to
  45000ms.
- Extracted the network call into `sync_submission_to_sheet(p_sub uuid)` so
  the trigger and a retry job share one implementation.
- New table `sheet_sync_attempts` logs every attempt with its `pg_net`
  request id.
- New function `retry_failed_sheet_syncs()` + new cron job
  `retry-sheet-sync` (every 5 minutes): resolves successful attempts,
  retries unresolved ones after a 3-minute grace period (up to 3 attempts),
  gives up past that rather than retrying forever.

Applied live via migration and verified (function bodies, trigger wiring,
cron registration all re-checked after applying). Does not backfill leads
already missing from the sheet — still a separate, not-yet-done task. See
`docs/database.md`'s `notify_sheet_sync` entry for full detail.

## 2026-09-10 — Fix: Google Sheets sync silently dropping submissions

Root cause found via direct Supabase inspection (reported by the user as a
count mismatch: CRM showed 209 validator submissions, the Google Sheet
showed 167). `notify_sheet_sync()`'s `net.http_post` call had no explicit
`timeout_milliseconds`, so it used `pg_net`'s default of 5000ms; `pg_net`'s
own response log showed roughly 4 in 10 recent sync attempts timing out at
essentially exactly that wall, with no retry anywhere in the trigger — a
timed-out sync was simply lost. Fixed by `supabase/migrations/20260910200000_sheet_sync_timeout.sql`,
which adds `timeout_milliseconds := 20000` to that one call and changes
nothing else. Applied live via migration, not a one-off change. See
`docs/database.md`'s `notify_sheet_sync` entry for detail.

Does not recover leads already missing from the sheet, and does not add
retry/delivery-confirmation logic — both intentionally deferred (see the
implementation plan discussed with the user).

## 2026-09-10 — Documentation audit + three admin features

- Added a full `docs/` structure (architecture, database, authentication,
  multi-tenancy, per-feature docs, decision records) derived from direct
  inspection of the live database and the codebase — see this repo's
  `docs/` directory. Corrected several stale claims in `CLAUDE.md` found
  during the audit (see that file's own history for specifics).
- **Admin read-only form preview**: `/closer` and `/validator-form` render
  a disabled preview for `admin` sessions instead of the live form, so an
  admin can inspect field layout without logging in as a closer/validator.
  Nav links added on the Admin page.
- **Users tab (Admin → Users)**: added search (name/staff ID/center) + role
  + active/inactive filters, a capped scroll region with a sticky header
  (fixed in a follow-up once the initial implementation's height/overflow
  landed on the wrong DOM node — see `docs/features/user-management.md`),
  and an inline Activate/Deactivate control wired to the existing
  admin-only direct write on `profiles`.
- **Exports tab (Admin → Exports)**: new — filter accepted leads by
  carrier/customer/draft date, multi-select, pick columns (a union of
  metadata + payload fields across the checked leads), download as CSV or
  Excel. See `docs/features/lead-export.md`.

## Reconstructed history (from `git log`, approximate)

- **2026-08-13 → 2026-08-14** — Project scaffolded on Lovable
  (`tanstack_start_ts` template). Design system and fonts added. Closer
  form built up field-by-field (age/birthday hints, zodiac sign, weekend
  draft-date hint, live ZIP weather lookup). Auth and role-based dashboards
  added.
- **2026-08-21** — "working app before uploader" — the app functioning
  end-to-end prior to the spreadsheet-import feature.
- **2026-08-31** — Uploader tool and center separation for closers.
- **2026-09-03** — "latest updates" (unspecified in the commit message).
- **2026-09-08 → 2026-09-09** — General manager role, parked leads,
  validator-completed fields (final carrier/agent/policy), CX reopen path;
  a redesign of the validation and customer-lifecycle timelines; several
  Reporting-tab refinements (period selector, queue-age display, visual
  separation of waiting stages) — the most recent work before this audit.
