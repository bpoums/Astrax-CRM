# Spreadsheet import

## Purpose
Bring leads in from partner-center spreadsheets, entirely parsed in the
browser, deterministically normalized and flagged, then approved batch-by-
batch by a manager before they reach the ordinary queue.

## Current status
Live. One genuine, currently-failing unit test (see Known limitations) and
one documentation/behavior mismatch against `PRODUCT.md` (also below) were
found during this audit — neither blocks the feature from working, but both
are worth fixing deliberately rather than by accident.

## Roles involved
**data_uploader** (upload, map, review, import their own batches; sees only
their own `lead_imports`/imported `submissions`), **admin** (everything a
data_uploader can do, plus every uploader's history), **manager** (approves
or rejects a pending batch — this is the only role that can move an imported
lead out of the import gate).

## Routes / screens
`/upload` → `src/routes/_authenticated/upload.tsx` →
`src/components/data-uploader.tsx` (3-step: upload → map → review) +
`src/components/import-history.tsx`. Manager-side approval lives on
`/manager`'s "Pending Imports" tab → `src/components/pending-imports.tsx`.

## Important components
`data-uploader.tsx`, `upload-review.tsx`, `import-history.tsx` (added
2026-09-25: clicking a lead inside an opened batch now opens that lead's
own detail sheet — `LeadPayload`, `DataFlagList`, and, admin only,
`PaymentPanel`. Editable only for `admin` (`update_payload_field`/
`payment_summary` don't accept `data_uploader`), so a `data_uploader`
viewing their own batch gets the payload and flags read-only and no
banking panel at all rather than one that would just error. Reuses the
row already fetched for the batch table — no extra query per lead.
**Added 2026-09-28: batch download** — admin-only, a checkbox column on
the batch table plus a reused "Selected (N)" / amber-ready-bar download
control, same pattern `exports.tsx` established. Selecting one or more
batches and clicking Download CSV/Excel fetches every `submissions` row
tagged with those `import_id`s — current payload, corrections included,
every status (approved/pending/rejected) — and builds a file client-side,
same `papaparse`/`xlsx` path `Exports` uses. One batch selected keeps that
batch's file name; more than one produces a combined file with a "Source
File" column so rows stay traceable to their batch. No column picker,
unlike `Exports` — the intent here is "give the admin their batch back,"
not a curated report, so every payload field (union across the downloaded
rows, deduped by display label) plus Source File/Status/Uploaded
On/Uploader metadata columns are always included. **Added 2026-09-28: the
batch table itself is now server-paginated** (`LEAD_PAGE_SIZE`/25 per page,
`PaginationBar`, the same pattern `SubmissionsExplorer` uses) — it used to
be a single unpaginated fetch capped at the 100 most recent batches, with
no way to reach anything older. Selection is tracked as `Map<id, ImportRow>`
(row snapshot, not just the id) specifically so a batch selected on one page
survives navigating to another — the same reasoning `exports.tsx` documents
for its own selection state),
**Added 2026-09-29: the opened-batch leads table now shows Age, State, and
Zip** alongside Customer/Status/Flags — read straight off the already-fetched
`payload` (no new query), using the closer form's own field labels (`"Age"`,
`"State"`, `"Customer Zip Code"` — `closer-form.tsx` `SECTIONS`), which an
imported lead's payload carries under the same keys since
`canonical-fields.ts` derives its import targets from that same form.
`pending-imports.tsx`, `src/lib/parse-file.ts` (papaparse/xlsx dispatch),
`src/lib/canonical-fields.ts` (import target catalog, derived from the
closer form — see [closer-submission-and-forms.md](closer-submission-and-forms.md)),
and the whole `src/lib/normalize/` engine (detection, validation,
normalization, duplicate grouping — see
[decisions/0003](../decisions/0003-deterministic-import-normalization.md)).

## Database
- `start_lead_import(p_file_name, p_row_count)` opens a `lead_imports` batch.
- The `ingest-sheet-lead` **Edge Function** is what actually writes lead
  rows, in batches of up to 50 from the client (its own ceiling is 200) —
  each batch call presumably invokes the `ingest_sheet_lead` RPC per row
  server-side (the Edge Function's source is not in this repository; this
  is the client's contract with it, not verified end-to-end).
- `approve_import_batch(p_import_id, p_reject_ids[]?)` / `reject_import_batch`
  — manager/admin only, from `pending-imports.tsx`.
- Rows sit at `status='pending_import_approval'` until one of those two
  RPCs resolves the batch; the `pending_import_batches` view is what feeds
  the Pending Imports list, and it drops a batch automatically once every
  lead in it has been decided (approved or rejected/archived) — no explicit
  "close batch" step exists or is needed.

## Business rules
- **Detect from content, not from the header** — real files put a card
  number in a column headed "Routing / Card Detail." Content-based
  detectors win over a mismatched column mapping; a contradiction between
  the two is flagged rather than silently trusting either one.
- **A dismissed flag is never sent to the database** — "Ignore without
  fixing" only removes the flag from what the operator sees; correcting a
  value re-runs detection and clears the flag if the new value passes.
- **Flags never block import** — a flagged, uncorrected row still imports
  and carries its flag into `submissions.data_flags`; the manager-approval
  step, not the flag, is the actual gate.
- **Duplicates stay visible, dimmed, and editable** — only the "kept" row
  of a duplicate group is sent to `ingest-sheet-lead`; the others are shown
  struck-through rather than silently dropped, so an operator can correct a
  false-positive duplicate match by editing the row that would otherwise be
  discarded.
- **Card data is shown unmasked in the pre-import review grid, on purpose**
  — the code's own comment states the operator already has the source
  spreadsheet open on the same machine, so masking the parsed copy
  "protects nothing." This is the one place in the app where a full card
  number and CVV are ever rendered outside a validator's own open review.
- **Batch download reads live `payload`, not the original upload** — no raw
  file is ever stored, so "download this batch" reconstructs a spreadsheet
  from whatever `submissions.payload` currently holds. A value corrected
  after import via `update_payload_field` downloads as the corrected value,
  not the one originally uploaded. "Include everything tagged with that
  batch" was a deliberate choice, not a default: an approved, a still-pending
  and a rejected (archived, still `pending_import_approval`) lead from the
  same batch all download together, distinguished only by the Status column.

## Derived columns (fixed 2026-09-17)

`ingest_sheet_lead` used to insert **no** `draft_date`, `future_draft_date` or
`ssn_normalized` — only `submit_form_internal` ever derived them — so every
uploaded lead had all three null. The visible effects: a blank Draft Date column
in the CX pipeline, no uploaded lead ever appearing on the By Draft Date desk,
and none of them visible to `check_duplicate_ssn`. `update_payload_field` had
the same gap in reverse: correcting the text by hand wrote `payload` and left
the column null, so the correction changed nothing a filter could see.

Both now derive the three columns through `parse_lead_date()` and
`normalize_ssn()`. Uploaded leads mostly state a *recurrence* rather than a date
("3rd of the month", "3rd wed of the month" — 26 of the 33 that carry any draft
text), which is resolved to its next real occurrence and rolled forward nightly
by the `roll-recurring-draft-dates` cron job; see
[decisions/0006](../decisions/0006-recurring-draft-dates-resolved.md) for why
that was chosen over keeping the rule and interpreting it at read time. Text
that resolves to no single date — `Every 2nd Friday` — stays null, and the CX
pipeline shows the wording itself rather than an empty cell.

The backfill filled 31 of 44 uploaded leads' `draft_date` and all 44
`ssn_normalized`.

## Missing information (added 2026-10-10)

An uploaded (`source = 'sheet'`) lead that has no value for one of its required
fields is labelled **Missing info (N)** and can be completed by the people who
may edit the lead. Measured on 2026-10-10: only 171 of 500 uploaded leads had
all 15 core fields; draft date was blank on 175, zip on 28, state on 7.

- **A generated column, not a flag.** `submissions.missing_info` (a stored
  generated `text[]`, from `missing_required_fields()` — migration
  `20261010100000_missing_info_filter.sql`) lists the labels each uploaded lead
  has no value for. Postgres recomputes it on every payload write, so it is right
  for every lead already imported, clears itself when the value is saved, and the
  database can filter and count by it. No flag to clear and no `ingest-sheet-lead`
  change. A closer's lead can never be missing anything (the form refuses to
  submit), so only `sheet` leads report. The SQL function is the **only**
  definition of the list; the browser reads the column. To change the list, see
  the maintenance note in `docs/database.md` (drop and re-add the column; do not
  `UPDATE` rows).
- **Required for an uploaded lead:** Full Name, Gender, Date of Birth, Age, State,
  SSN Number, Phone Number, Residential Address, Customer Zip Code, Proposed
  Carrier, Coverage Amount, Premium, Plan Type, Beneficiary Name, Draft Date.
  Deliberately not the closer form's whole required list: Birth State, Birth
  Country, Height and Weight are empty on 459-492 of 500 uploaded leads, so
  counting them would label every one. Bank fields live in `payment_details` and
  are not covered. If the closer form relabels one of these fields, the SQL list
  has to move with it (the labels are the payload keys).
- **Where:** the completeness strip (`MissingInfoBadge`, see below) is in the manager queue's status cell,
  the Submissions Manual list, the Closing Desk Source column and the import
  batch's lead table. The fill-in list (`MissingInfoSection`, above the payload
  editor in each lead panel) saves each field through `update_payload_field`.
  Editable for manager and admin (manager queue, Submissions), admin
  (import history) and closing_manager / general_manager (Closing Desk); everyone
  else sees the list read-only.
- Label only. It does not block assigning, validating or approving the lead.
- **Filter and counts (added 2026-10-10).** Submissions → Manual has a
  "Missing info (N)" chip (N respects the search, carrier and date filters) and,
  once on, a dropdown narrowing to one field with its count (from
  `missing_info_by_field()`), both applied in the database so paging is correct.
  The manager's Manual queue has the same chip, filtered in the browser (the whole
  open queue is already loaded). Import history has a "Missing info" count per
  batch and a "Missing info" toggle inside an opened batch. Counts exclude
  archived (rejected) leads. The Closing Desk has a "Missing info" dropdown among
  its filters ("Any missing field" plus each field with its count; counts are
  RLS-scoped, so a closing manager counts their own centre).

### Banking fields and the uploader's pre-import count (added 2026-10-10)

- **Banking is a second, separate group.** Account Title, Bank Name, Bank Type,
  Routing Number and Account Number are required for an uploaded lead (they are
  required on the closer's form); Card Number, Exp Date and CVC are optional.
  They are tracked in `submissions.missing_bank`, apart from the 15 core fields in
  `missing_info`, because Account Title was empty on **all 500** uploaded leads
  and Bank Type on 468 when this was built — one combined label would have been
  on every lead. Its ring is grey rather than amber for the same
  reason; amber stays on the core group. Four of the five are `payment_details`
  columns, Bank Type is a payload key (see `docs/database.md` for how
  `missing_bank` is kept current).
- **The fill rings (2026-10-10).** The list badges are two small rings, not two
  count pills: one for the 15 core fields (amber) and one for the 5 banking fields
  (grey), about 64px wide on one line. A ring fills in proportion to how many of
  its group's fields are present, and the number in the middle is how many are
  still **missing**, so nobody counts anything; a complete group is a dim ring with
  a tick, which keeps the two rings in the same positions down a column. The two
  pills ("Missing info (6)" + "Missing bank info (5)") did not fit beside a
  customer name and wrapped most uploaded rows onto two lines; a one-tick-per-field
  strip replaced them first but was too small to read, so it was dropped. It is a
  `role="img"` with a text label, and the missing field names are in its `title`.
  The group totals come from `uploaded_required_fields()` through
  `useUploadedRequiredFields()` (`src/lib/required-fields.ts`, also used by the
  uploader's review step), so they cannot drift from the database; if that read
  fails it falls back to the two counts. A lead missing nothing shows nothing. The
  host cells keep `flex-wrap`, so on a narrow window the rings drop under the name
  instead of widening the table.
- **Filling them in.** The lead panel's "Missing bank information" list saves
  Bank Type through `update_payload_field` and the other four through
  `update_payment_field`, then refreshes the banking panel. Inputs show for
  **admin, manager and general_manager**; any other role (including a closing
  manager) sees the field names read-only.
- **Seeing what a lead already has.** The Submissions detail (admin, manager) now
  mounts the Banking panel (`PaymentPanel`, editable) beneath Lead details. Bank
  values are in `payment_details`, not the payload, so before this a lead with a
  bank name and account number looked as if it had neither.
- **Filters and counts.** Every place that has the core filter has a bank one:
  Submissions → Manual (chip + per-field dropdown, from `missing_bank_by_field()`),
  the manager's Manual queue (chip), the Closing Desk ("Missing bank info"
  dropdown) and Import history (per-batch "Missing bank" count and a toggle inside
  an opened batch).
- **The uploader's review step shows it before import.** A "Missing required
  fields" panel reads the live list from `uploaded_required_fields()` and counts,
  over the rows that will actually be sent, how many lack a core field and how many
  lack a banking field, with the fields most often missing named. It says when a
  required field has **no column mapped to it** (every row is then missing it, and
  the fix is the mapping, not 400 typed values). Each row gets a "Missing" cell
  (Info N / Bank N; the names are in the tooltip) and two filter chips ("Missing
  info", "Missing bank info"). Counts update as cells are edited. Informational
  only: it never blocks Import, same as flags. Calculation:
  `src/lib/missing-upload.ts` (pure, tested); the list itself is not restated in
  the browser.
- Not covered yet: nothing on the uploader's side blocks or warns on import
  itself, by design.

## Known limitations
- **`npm test` currently fails 1 of 140 tests** (`review-columns.test.ts`,
  "does not lose the card columns when the only card number is cleared").
  Root cause, confirmed by reading the source: `canonical-fields.ts` builds
  its catalog by combining the closer form's own fields (which include a
  plain-text `"Card Number"` field) with a separately hand-written
  `CARD_FIELDS` list that *also* declares a `card_number` entry, with a
  different detector kind. The combined catalog ends up with two entries
  sharing the key `card_number`; `buildLead()` resolves the collision one
  way (`Map`, last-write-wins → the correct `"card"` kind) and
  `setLeadField()` resolves it the other way (`Array.find()`, first-match
  → the wrong `"text"` kind) — so editing a card number *after* the initial
  parse silently loses card-specific validation. This predates this audit
  and was not introduced by it; fixing it is an application-code change and
  is out of scope for this documentation pass.
- **`PRODUCT.md` overstates the payment-data guarantee for this specific
  screen**: it says card numbers and CVVs "never reach... an uploader's
  browser." That is true after import (only the role-checked, logged
  `card_details` RPC can retrieve a card), but is contradicted by this
  screen's own design and its own code comments — the pre-import review
  grid deliberately shows full card numbers and CVVs, because the operator
  reviewing them is the same person who has the source file. This document
  states the actual behavior; `PRODUCT.md` should be read with that
  caveat until it's revised.
- The `data_uploader` role is granted `clear_data_flag` RPC access
  server-side, but no confirmed UI path in the current post-import screens
  (`ImportHistory`, `PendingImports`) exposes flag-clearing to that role —
  their flag correction happens entirely pre-import, client-side, before
  anything is sent to `ingest-sheet-lead`. Whether the RPC grant is
  intentionally forward-looking or simply unused was not resolved by this
  audit.
- Only the first sheet of a multi-sheet `.xlsx` file is ever read.
- **Batch download carries the same PII-export caveat `docs/features/lead-export.md` records for the Exports tab**: no audit trail records who downloaded which batch, and SSNs/bank-account text sitting in `payload` are in scope and not logged. Card number/CVV are not at risk here — those go to `payment_details` for an imported lead, never into `payload` (see `CLAUDE.md`'s "Payment data never goes in `payload`" rule) — so an imported lead's downloaded row never carries them regardless.
- **The download fetch itself is still unpaginated** — the batch *table* is now paginated (25/page), but selecting batches across many pages and downloading still issues one single `.in("import_id", [...])` request for every lead in every selected batch. Bounded by the 200-leads-per-batch ingest ceiling per batch, but an admin could in principle select hundreds of batches across many pages and trigger one very large request. Not tested against a realistic worst case in this pass.

## Future work
None found as explicit code TODOs beyond the items above.
