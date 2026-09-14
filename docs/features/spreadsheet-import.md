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
`data-uploader.tsx`, `upload-review.tsx`, `import-history.tsx`,
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

## Future work
None found as explicit code TODOs beyond the items above.
