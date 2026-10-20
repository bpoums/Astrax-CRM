# 0003 — The spreadsheet-import normalizer is deterministic, not AI-based

## Status
Current, verified by direct code inspection (no exceptions found).

## Context
Imported leads arrive as arbitrary spreadsheets from partner centers/vendors:
inconsistent headers, values embedded inside a single cell (e.g. a "Routing /
Card Detail" column containing an SSN, a card number and an expiry date all
in one cell, with the header not agreeing with what's actually there), typos,
and duplicate rows across re-uploads.

## Decision
`src/lib/normalize/` is a pure, rules-only engine: fixed checksum/format
validators (Luhn, ABA routing mod-10, SSA SSN issuance rules), a ZIP↔state
cross-reference table, a fuzzy header-to-field mapper, and content-based
detectors that win over a mismatched header. No network call, no LLM/AI call,
and no randomness anywhere in the directory — confirmed by grepping the whole
directory for `openai|anthropic|fetch\(|axios|supabase\.|process\.env` and
finding zero matches, and by the module's own header comment stating the
same constraint. Every function that needs external data (the carrier list)
receives it as a parameter rather than fetching it, which is also what keeps
the module framework-free enough to "be lifted into a Deno edge function
unchanged" if needed.

## Consequences
- Import results are fast, free, repeatable, and — because every rule is a
  named, testable function — auditable and unit-testable
  (`src/lib/normalize/*.test.ts`, run via `npm test`).
- **The one crack found in the 2026-09-10 audit is fixed (2026-10-12).**
  `canonical-fields.ts` used to combine the closer form's fields (including its
  plain-text "Card Number") with a hand-written `CARD_FIELDS` list that also
  declared `card_number`, so the catalog held two entries under one key.
  `buildLead()` resolved the key through a `Map` (last wins, kind `card`),
  `setLeadField()` through `Array.find()` (first wins, kind `text`), so editing
  a card number after the initial parse used the wrong detector, and the
  payload-target copy put the card number into `payload`. `buildCatalog()` now
  drops the form-derived entry, `CARD_FIELDS` is the only definition, and
  `canonical-fields.test.ts` asserts keys are unique. The rule going forward:
  a catalog key must be unique, because the engine looks fields up by key in
  more than one way.
  audit's scope.
- The engine being pure/no-I/O also means it cannot itself call the database
  RPC `resolve_carrier` — if that RPC and this module's own `carriers.ts`
  matching logic are meant to agree, they are two independent
  implementations of similar logic rather than one shared source, and could
  in principle drift. Not confirmed either way in this audit — flagged as
  unclear.
