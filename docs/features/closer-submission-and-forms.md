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
- Write: `submit_form(p_payload)` (both roles), `submit_form_parked(p_payload)`
  (closer's "External Transfer" button only).
- Read (closer's own leads only): `my_forwarded_leads()` RPC, plus the
  `closer_lead_alerts` view.
- See [database.md](../database.md) for full column/RPC detail.

## Business rules
- A **validator's own submission auto-accepts**: `submit_form` sets
  `status='closed'`, `disposition='accepted'` immediately, in the same
  insert. It is never assignable and never enters the manager queue.
- A **closer's submission** starts `pending_manager`, with no disposition.
- **External Transfer** (`submit_form_parked`) only has an effect for a
  closer-originated result — a validator submission passes through
  unchanged (nothing to park; it's already closed).
- Draft date / future draft date and a digits-only SSN are parsed out of the
  payload at submission time into real `submissions` columns
  (`draft_date`, `future_draft_date`, `ssn_normalized`) — this is what makes
  the duplicate-SSN check and the "By Draft Date" desk possible without a
  jsonb scan.
- Duplicate-SSN warnings (`check_duplicate_ssn` RPC) are **advisory only** —
  never block submission — because a repeat SSN is often a legitimate
  re-write after a decline.

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
