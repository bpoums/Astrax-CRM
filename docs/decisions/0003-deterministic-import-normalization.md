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
- **This guarantee currently has one real crack**, found during this audit:
  `canonical-fields.ts` builds its field catalog by combining the closer
  form's own fields (which include a plain-text "Card Number" field, since
  the closer form has no masking concept) with a hand-written `CARD_FIELDS`
  list that *also* declares `card_number` — with a different detector kind
  (`"card"` vs `"text"`). The catalog ends up with two entries sharing the
  key `card_number`. `buildLead()` resolves duplicate keys through a `Map`
  (last write wins → the `"card"` kind), but `setLeadField()` (used when an
  operator edits a cell after the initial build) resolves the same key
  through `Array.find()` (first entry wins → the `"text"` kind). The result:
  editing a card number after the initial parse silently uses the wrong
  detector. This is caught by an existing failing test
  (`review-columns.test.ts`, "does not lose the card columns when the only
  card number is cleared") — `npm test` currently reports **1 failing test**
  because of it. See [features/spreadsheet-import.md](../features/spreadsheet-import.md)
  for the fix options; this document does not change the code, per the
  audit's scope.
- The engine being pure/no-I/O also means it cannot itself call the database
  RPC `resolve_carrier` — if that RPC and this module's own `carriers.ts`
  matching logic are meant to agree, they are two independent
  implementations of similar logic rather than one shared source, and could
  in principle drift. Not confirmed either way in this audit — flagged as
  unclear.
