# Closer & validator intake forms

## Purpose
Capture a sale over the phone, in one screen, with no separate "carrier
step" for the closer and a per-carrier field set for a validator's own
direct submissions.

## Current status
Live, stable. No placeholders.

## Roles involved
- **closer** — the only role this form exists for by default.
- **validator** — has their own separate form (`/validator-form`) for
  writing applications directly, bypassing the review queue entirely.
- **manager**, **admin** — admitted to both routes (`requireRole`), so they
  can see the forms; only closer/validator sessions actually submit through
  them in normal operation.

## Routes / screens
- `/closer` → `src/components/closer-form.tsx`.
- `/validator-form` → `src/components/validator-form.tsx`.
- `/forwarded-leads` → `src/components/forwarded-leads.tsx` (a closer's own
  past submissions, read-only, sensitive fields stripped server-side — see
  below).

## Proposed Carrier vs Final Carrier

Renamed 2026-09-15. The closer's carrier field is **Proposed Carrier** — what
was *pitched*. It is not the carrier the policy ends up on, and on 80 live
leads the two differ (pitched "American Amicable", written TransAmerica).

| | Where it lives | Which leads |
|---|---|---|
| **Proposed Carrier** | `payload['Proposed Carrier']` | closer + uploaded only |
| **Final Carrier** | `final_carrier_id` -> `carriers.name` | closer + uploaded, once reviewed |
| | `payload['Agency']` | validator's own submission |
| | *(null — not yet determined)* | anything still awaiting review |

A validator submission has **no proposal stage at all**: that form is only
filed once the carrier has accepted, so its `Agency` value is already final.
It also never gets `final_carrier_id`, because it auto-accepts on submit and
never passes through `set_validator_fields` (verified live: 0 of 260).

Read these through `finalCarrierName()` / `proposedCarrierName()` in `ops.tsx`,
never by reaching for a payload key directly. `carrierName()` still exists for
the narrower question "whatever carrier text this lead carries, either key".

Migrations `20260915120000` (renamed the key on all 285 pre-existing rows, with
the sheet-sync UPDATE trigger disabled — it is idempotent and safe to re-run)
and `20260915121000` (the Sheet's `Final Carrier` column now falls back to
`Agency` for a validator submission, which had left it blank on 260 rows).

## Important components
- `closer-form.tsx` — `SECTIONS` is the single source of the field catalog:
  every label is simultaneously the payload jsonb key, the Google Sheet
  column header, and (via `canonical-fields.ts`) the spreadsheet-import
  target field. Renaming a label renames all three at once. Includes live
  keystroke masking (SSN, height, money), a ZIP→weather/local-time lookup
  (the one deliberately non-Pacific clock in the app), zodiac-sign rapport
  hints, and a weekend warning on the draft date.
- `validator-form.tsx` — one shared form for every carrier (carrier is a
  field, not a step), with its own duplicate-SSN/expiry/draft-date checks.
  Stores the carrier under payload key `Agency` (not `Proposed Carrier`) —
  required because the sheet-sync layer routes a Google Sheet tab off that
  exact key; `payloadDisplayLabel()` in `ops.tsx` relabels it to
  **"Final Carrier"** for display only. The carrier is picked from the
  `carriers` list rather than typed, so every stored value matches a real
  carriers row (verified live: 260 of 260).
- `forwarded-leads.tsx` — calls the RPC `my_forwarded_leads()` rather than
  reading `submissions` directly, because the closer RLS policy on
  `submissions` gives a closer nothing beyond their own submission at
  creation time. The RPC strips `SSN Number`, `Routing Number`, `Account
  Number`, `Card Number`, `CVC`/`CVV`, `Exp Date` **in SQL**, so there is no
  code path — client bug or otherwise — that could leak those keys onto this
  screen. Also surfaces "problem" badges from the `closer_lead_alerts` view
  (CX statuses toned `destructive`/`warning` on the closer's own leads).

## Database
- Write: `submit_form(p_payload)` (both roles),
  `submit_form_parked(p_payload, p_client)` (closer's "External Transfer"
  button only). `p_client` is a `transfer_clients.id` and is **required** —
  the RPC raises `select a client to transfer to` on a null and
  `client is not available` on one that is missing or deactivated.
- Read: `transfer_clients` (every role, under RLS) — the list the transfer
  dialog offers.
- Read (closer's own leads only): `my_forwarded_leads()` RPC, plus the
  `closer_lead_alerts` view.
- See [database.md](../database.md) for full column/RPC detail.

## External center intake (API) — added 2026-10-01

A center onboarded with its own CRM has no Astrax closer logged in behind its
leads, so it cannot call `submit_form`. It POSTs instead to the
`ingest-center-lead` edge function, which lands the lead in the manager queue
exactly like a normal closer submission — `pending_manager`, assignable,
synced to Google Sheets, reportable — just tagged with a different origin.

- **Endpoint**: `POST <project>/functions/v1/ingest-center-lead`
  (`supabase/functions/ingest-center-lead/index.ts`).
- **Auth**: header `x-api-key: <raw key>`. One key per center, generated (and
  regenerated — overwrite, not append) from the "API Key" action on that
  center's row in `CenterAdmin` (`src/components/center-admin.tsx`,
  Admin → Settings → Centers). The raw key is shown exactly once, at
  generation time; only its sha256 hash is stored
  (`center_api_keys`/`admin_generate_center_api_key`). There is no separate
  revoke — regenerating immediately invalidates whatever key existed before.
- **Payload contract**: `{ "payload": { "Full Name": "...", "SSN Number":
  "...", "Draft Date": "...", ... } }` — a flat object keyed by the closer
  form's **exact labels**, `SECTIONS` in `closer-form.tsx`, Banking section
  included (`Account Title`, `Bank Name`, `Routing Number`, `Account
  Number`, `Card Number`, `Exp Date`, `CVC`). No field-name mapping. This
  deliberately mirrors `submit_form`'s own payload shape rather than the
  spreadsheet-import pipeline's: payment/banking fields travel as ordinary
  payload keys (synced to Google Sheets like any closer submission), **not**
  split into `payment_details` the way an uploaded lead's are — that split
  is specific to `ingest_sheet_lead`.
- **Response**: `200 { ok: true, id }` on success; `401` on a missing/wrong
  `x-api-key`; `400` for bad JSON, an empty payload, or any error
  `submit_external_lead` raises (including the duplicate-SSN block message
  below) — the real message is returned, not a generic one.
- **What it inserts** (`submit_external_lead`, mirroring
  `submit_form_internal`): `closer_id=null`, `submitted_by_role='closer'`,
  `status='pending_manager'`, `source='api'`, `center_id`/`center_name`
  stamped from the matched API key, `draft_date`/`future_draft_date`/
  `ssn_normalized` parsed the same way, and the **same accepted-match
  duplicate-SSN block** described above — an API lead cannot bypass it.
- **Shown in the UI as origin "API"**, distinct from "Live" (typed into our
  own closer form) and "Manual" (uploader/validator) — see `sourceLabel()`/
  `OriginBadge` in `ops.tsx`. `closerName()` shows the center's name for
  these rows, since there is no closer to show.
- No approval gate: unlike `ingest_sheet_lead` (`pending_import_approval`),
  these go straight to `pending_manager` — confirmed with the business owner
  as the intended behavior for this integration.

## Business rules
- A **validator's own submission auto-accepts**: `submit_form` sets
  `status='closed'`, `disposition='accepted'` immediately, in the same
  insert. It is never assignable and never enters the manager queue.
- A **closer's submission** starts `pending_manager`, with no disposition.
- **External Transfer** (`submit_form_parked`) only has an effect for a
  closer-originated result — a validator submission passes through
  unchanged (nothing to park; it's already closed).
- **A transfer names its client.** Added 2026-09-19. The button opens
  `TransferClientDialog` (`src/components/transfer-client-dialog.tsx`)
  instead of submitting; nothing is sent until an active client is chosen.
  The required-field check runs *before* the dialog opens, so a closer is
  never asked which client to transfer to only to be told afterwards that a
  field is blank. The RPC stamps `transfer_client_id` and
  `transfer_client_name` on the lead and records the client name in the
  `'parked'` `form_events` detail, so who parked what and to whom is on the
  row, in the timeline, and on the closer's own Forwarded Leads.
  The client is stored in **columns, never in `payload`** — `payload` is what
  sheet-sync pushes to Google Sheets, so a key there would become a new Sheet
  column. A refusal rolls the whole submission back: verified live that a
  null client leaves no `submissions` row and no `form_events` row behind.
- **The client list is admin-managed**, in Admin → Settings
  (`TransferClientAdmin`). Deactivating one takes it out of the closer's
  dialog and changes nothing about the leads already transferred to it;
  renaming one is safe, because each lead keeps the stamped
  `transfer_client_name` it was parked under. There is no delete — parked
  leads point at the row.
- Draft date / future draft date and a digits-only SSN are parsed out of the
  payload at submission time into real `submissions` columns
  (`draft_date`, `future_draft_date`, `ssn_normalized`) — this is what makes
  the duplicate-SSN check and the "By Draft Date" desk possible without a
  jsonb scan.
- **Duplicate SSN now blocks submission for an accepted match, changed
  2026-09-25.** Both the closer's forms and the validator's own direct
  submission (`submit_form` / `submit_form_parked`, via
  `submit_form_internal`) refuse to insert when the SSN already belongs to
  another non-archived lead **marked accepted** — unless a CX agent has
  tagged that existing policy as eligible for a second one (see
  "Second-policy exemption tag" below); the block checks whether **any**
  accepted match carries that tag, not just the most recent one. A
  **declined or still-in-progress duplicate is unchanged** — advisory only,
  never blocks, for the original reason (a repeat SSN there is often a
  legitimate re-write, e.g. after a decline). This narrows the previously-
  documented "advisory only, never block" rule rather than removing it
  outright — see
  [decisions/0007](../decisions/0007-duplicate-ssn-blocks-unless-tagged.md)
  for why and the exact scope.
  `check_duplicate_ssn` (still a separate, read-only RPC called on blur)
  is now a **preview** of that gate rather than a standalone opinion: it
  returns the same match info as before (`dispositionLabel()`-worded
  outcome, "In Progress" for an undisposed lead) plus `exempt` — meaningful
  only when `status = 'accepted'` — so `duplicateSsnWarning()` in
  `src/lib/duplicate-ssn.ts` can tell the closer or validator in advance
  whether an accepted-SSN match will actually be blocked (danger tone) or
  has been cleared (ok tone), before they hit Submit and find out from the
  RPC's own error. The real gate is enforced server-side in
  `submit_form_internal` regardless of what this hint shows or whether it
  loaded at all.

### Second-policy exemption tag

A customer legitimately taking out a second policy is the one case the
block has to allow for. `cxa`/`cxm`/admin do this from the **Customers
Pipeline** detail sheet (`src/components/customers-pipeline.tsx`), which
mounts `SubmissionTags` (`src/components/submission-tags.tsx`) — the same
chip-toggle pattern used elsewhere in the app, listing the active `cx_tags`
vocabulary and calling the existing `add_submission_tag`/
`remove_submission_tag` RPCs. Those RPCs already require the target lead to
be `disposition = 'accepted'` and not archived, which is exactly "the
customer's existing, already-sold policy" — no RPC change was needed for
this, only a UI to call them (previously wired end-to-end but unused, 0
rows in production; see `docs/features/cx-lifecycle.md`).

**Extended 2026-09-25** to `manager` and `general_manager` as well, since
they can already see and edit an accepted lead from their own screens:
`SubmissionTags` is also mounted in `ReportingDashboard`'s detail sheet
(`src/components/reporting.tsx`, shared by the admin page and the manager's
Reporting tab — gated the same way the payload editor there already is,
`profile.role === "manager" || "admin"`) and in `ClosingDesk`
(`src/components/closing-desk.tsx`), the latter gated in the component
itself to `profile.role === "general_manager"` only — `closing_manager`
shares that same screen but is deliberately **not** granted this, so it
never sees a control that would just error. Every mount also only renders
when `selected.disposition === "accepted"`, the same precondition
`add_submission_tag` itself enforces.

The exemption is a **property of the tag**, not a hardcoded label:
`cx_tags.allows_duplicate_ssn` marks which tag(s) unlock a duplicate SSN.
One such tag is seeded, "Eligible For Second Policy", but an admin/cxm can
mark any tag this way — `cx_tags` is one of the few tables a `cxm` (not
just admin) can write directly, via its `FOR ALL` RLS policy.

## Health Conditions / Medications typeahead — added 2026-10-08

On the closer form only, `Health Conditions` and `Medications` (field types
`condition` / `medication`) render `SuggestInput` (`src/components/suggest-input.tsx`):
removable chips plus a suggestion list, keyboard navigable. Suggestions come from the
NLM Clinical Tables API (`conditions/v3` and `rxterms/v3`, no key, CORS-open) via
`useSuggestions` in `src/lib/health-suggest.ts` — 250 ms debounce, 2-character minimum,
stale requests aborted, results cached per session, failures silent. Only the typed
characters leave the browser. The value is a single comma-separated string in
`payload`; text the list doesn't know is accepted on Enter, comma or blur. Commas
inside a picked name are replaced with spaces so the chips round-trip. The payload and
lead editors treat both as plain textareas. `Medications` is derived from `SECTIONS`
into the import catalog (`canonical-fields.ts`) and no longer declared twice.
Not on the validator form.

## Beneficiary group — added 2026-10-14

Both forms replace the three beneficiary fields with `BeneficiaryGroup`
(`src/components/beneficiary-group.tsx`): one row per person, up to six, each with
Name, Relationship (a dropdown of common relationships plus "Other", which opens a text
box) and a free-text Info line (DOB, share, notes — anything). The three fields stay in
each form's `SECTIONS`, so their labels remain the payload keys, the Sheet headers and
the import targets; the forms render the group once, in the place of the first of them.

The logic is pure and lives in `src/lib/beneficiaries.ts`:
- **Saved format.** The rows are joined with ` | ` into the same three keys, in the same
  order, so item N of each is one person. An empty Info keeps its slot
  (`DOB 01/07/1957 | `). One beneficiary looks exactly like the old single value.
- **Lossless.** A typed `|` becomes `/` and a line break becomes a space on entry, so
  splitting on `|` always recovers the rows. The group is controlled by the three
  strings alone (`parseBeneficiaries` in, `serializeBeneficiaries` out); a form reset
  returns it to one blank row.
- **On submit** (`withSubmittedBeneficiaries`) blank rows are dropped, every part is
  trimmed and whitespace-collapsed, and each name is Title-Cased. `validateBeneficiaries`
  requires at least one beneficiary with a name, a relationship **and Info** (the first
  beneficiary only, changed 2026-10-14), and a name and relationship on any further row
  that has something in it; later rows may leave Info blank.
- **Validator form** now has `Beneficiary Info` (it had Name and Relationship only). The
  **Validator Submissions** sheet tab has no `Beneficiary Info` column, so add that
  header there; until then the value is stored in `payload` but may not appear in the
  tab. Apps Script is not changed by this.
- **Not parsed back on edit.** The payload editors, the data-flag fixer and the import
  pipeline still treat the three keys as plain text, so an edited value stays readable
  as `A | B`. Leads saved before this change hold a single flat value and read as one
  beneficiary; three existing values already contain a `|` and would read as extra
  entries if reopened in the group.
- No database change: nothing server-side parses these keys (only
  `uploaded_required_fields` checks that `Beneficiary Name` is present on an import).

## Digits-only fields — added 2026-10-14

A `number` field renders as a text input (`inputMode="numeric"` only picks the phone
keypad), so letters used to go straight in. These labels now keep **digits only** in the
shared mask registry, so a typed or pasted value is reduced to digits and cut at the
longest real value. Both forms get them.

| Field | Max digits |
|---|---|
| Phone Number, Doc Phone | 15 (a leading country code is never cut) |
| Age | 3 (still auto-filled from Date of Birth, still editable) |
| Routing Number | 9 |
| Card Number | 19 |
| CVC | 4 |
| Account Number | 20 (a number with letters or dashes can no longer be entered) |
| Exp Date | `MM/YY` via `formatExpDate` (the validator form already did this; the closer form now does too) |

Not changed: SSN and ZIP (already masked), and the advisory checks in `form-warnings.ts`.

## Name formatting and paste handling — added 2026-10-14

Closers often paste a value instead of typing it, and a paste carries tabs, line breaks,
non-breaking spaces, zero-width characters and whatever casing the source had. The rules
live in the shared mask registry (`src/lib/field-mask.ts`), keyed by label, so they reach
both forms. A paste arrives through the same `onChange` as a keystroke, so no paste
handler exists; the live mask fixes it the instant it lands.

| Field | Live (every keystroke / paste) | On blur |
|---|---|---|
| **Full Name** | invisible characters removed, curly apostrophe made straight, spaces collapsed, then **always Title Case** (`joHN dOE`, `JOHN DOE` -> `John Doe`); a single trailing space is kept so a space can be typed | trimmed; `Doe, John` -> `John Doe` (one comma, right side not a suffix such as `Jr`) |
| **Beneficiary Name** (each row) | same as Full Name | trimmed; **no** comma flip, because a comma there more likely separates two people |
| **Doc Name** | invisible characters removed, spaces collapsed. **No casing, no `Dr.` prefix, no placeholder blanking** | trimmed |

- **Doc Name is deliberately left alone.** When a customer cannot remember their doctor the
  closer writes the hospital they last visited there, so its wording is not ours to change.
- **Account Title may differ from Full Name**; it has no rule.
- **Title Case is forced** by `forceTitleCaseName` (`src/lib/normalize/text.ts`), separate
  from the import engine's `titleCaseName`, which still leaves a word with an inner capital
  alone. Mc, hyphen and apostrophe names are handled (`McDonald`, `Smith-Jones`,
  `O'Brien`), particles are capitalised (`De La Cruz`), a final `II`/`III`/`IV` is
  upper-cased. The accepted cost: `MacLeod` becomes `Macleod`, `DeVito` becomes `Devito`.
  Initials keep what was typed (`S` stays `S`, `S.` stays `S.`).
- **On submit** both forms run `closeAllFields(...)` over the payload (every field's blur
  rule, all idempotent), because Enter submits without leaving the field and a blur would
  never have run.
- **Advisory warning**: a digit or a slash in Full Name shows "Looks like two names or a
  typo" (`form-warnings.ts`). Never blocks.
- Leads from the center API (`ingest-center-lead`) bypass the forms and are not formatted;
  existing rows are not rewritten.

## Bank Name dropdown — added 2026-10-14

`Bank Name` is a searchable list on both forms (`BankSelect`,
`src/components/bank-select.tsx`; closer: required, validator: optional with a "Clear
selection" row) instead of free text. The list is the `banks` table (see
[database.md](../database.md)); `useBanks()` in `src/lib/banks.ts` reads it.
- **Stored value is unchanged**: the bank NAME as a plain string under the label
  `Bank Name`, which is still the payload key and the Sheet header.
- **Search by typing** filters on the name and on the aliases, so `Chase` finds
  `Chase Bank` and `Wels Fargo` finds `Wells Fargo`. Enter takes the top match.
- **A bank that is not in the list**: the last row offers `+ Add "<Name>" as a new bank`.
  The name is written in Title Case by `formatBankName` (acronyms such as `US`, `PNC`,
  `TD`, `M&T` stay upper-case; `of`, `and`, `the` stay lower-case: `Bank of America`),
  saved for everyone through the `add_bank` RPC, and selected. The RPC returns the
  existing entry if the name or an alias is already known, and refuses placeholders such
  as `N/A`; its message is shown in the list.
- **Seed list**: 119 banks, every bank seen on two or more live leads on 2026-10-14, with
  variants merged and kept as aliases (for example `Chase` and every `JPMorgan Chase`
  spelling are one entry, `Chase Bank`). Banks seen once, and junk (`N/A`, `credit union`),
  were not seeded; a one-off comes back through the add row.
- **Admin** manages the list in Settings -> Banks (`src/components/bank-admin.tsx`):
  search, add, rename, deactivate/reactivate. No delete. A rename changes what the
  dropdown offers and does not rewrite leads that already carry the old spelling.
- **Not changed**: names already on existing leads, the import engine's
  `normalizeBankName`, and the payment-detail editors for imported leads.

## Dev-only "Fill test data" button — added 2026-10-12
Both intake forms show a **Fill test data** chip beside Submit when the app runs under `npm run dev`.
It fills every required field with fresh random valid data and does not submit: the user still
presses Submit.
- **Dev only.** The button is guarded by `import.meta.env.DEV` at the call site in
  `closer-form.tsx` and `validator-form.tsx`, so a production build folds it to nothing. Checked
  by grepping the built bundle (`.output`) for the button text and the sample strings: no match.
  It is also hidden in the admin read-only preview.
- **Generator:** `src/lib/test-data.ts` (`closerTestData`, `validatorTestData`) is pure, with
  `now` and `random` injectable. Values are in the final masked form (`123-45-6789`, `$25,000`,
  `5'8"`), the state and ZIP agree, the routing number passes the ABA check, both draft dates are
  weekdays, and the SSN differs on each press so the duplicate-SSN check does not block repeat tests.
  `src/lib/test-data.test.ts` checks that every required field of each form is filled.
- **Left blank on purpose:** Card Number, Exp Date, CVC, Health Conditions, Medications (all
  optional), so the manager's "Card details (optional)" screen can be tested on the resulting lead.
- **Same database as production.** The dev server uses the live Supabase project, so a submitted
  test lead is a real row. The name starts with `Test` so it is easy to find and archive (changed 2026-10-14 from `TEST`:
  the form now Title-Cases names, so search case-insensitively).

## Known limitations
- Field labels doubling as payload keys, Sheet columns, *and* import target
  fields means a label rename has three simultaneous consequences — this is
  a deliberate trade-off (see `CLAUDE.md`), not a bug, but it is easy to
  underestimate the blast radius of a one-line label change.
- The closer form's plain-text "Card Number" field collides with the
  import catalog's own hand-written `card_number` entry — see
  [decisions/0003](../decisions/0003-deterministic-import-normalization.md)
  for the concrete bug this causes in the *import* pipeline specifically
  (this form itself is unaffected; the collision only matters once a
  spreadsheet cell is normalized against the combined catalog).

## Admin read-only preview (added in this working session)
Both `CloserForm` and `ValidatorForm` accept an optional `readOnly` prop
(default `false`). The `/closer` and `/validator-form` routes pass
`readOnly={profile?.role === "admin"}`, so an admin can open either form to
inspect field layout/order/types without ever reaching the `submit_form`
RPC — the fields render inside a disabled `<fieldset>`, the Submit/External
Transfer buttons are replaced by a "Preview only" banner, and the submit
handlers short-circuit as a second, redundant safeguard. Closer, validator,
and manager sessions are unaffected and still get the live form. `admin.tsx`
gained "Closer Form" and "Validator Form" links alongside the existing
"Manager View" link so this is actually discoverable.

## Future work
None identified from the code; no TODOs or commented-out sections found in
either form file.
