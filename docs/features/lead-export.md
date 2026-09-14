# Lead export (Exports tab)

## Purpose
Let an admin filter down to a handful of accepted leads and download exactly
the columns they choose, as CSV or Excel — entirely client-side.

## Current status
Live; built in this working session (see [CHANGELOG.md](../../CHANGELOG.md)).
Scoped deliberately to `disposition='accepted'` leads only, by explicit
product decision — declined/pending leads were named as a possible future
scope, not built now.

## Roles involved
**admin** only (the tab is admin-only; no other role has a route to it).

## Routes / screens
`/admin?tab=exports` → `src/components/exports.tsx` (`Exports`).

## Important components
`exports.tsx` — filters, a capped/sticky-header/scrollbar-hidden leads
table, a "Selected (N)" removable-chip strip (added after user testing
surfaced that a selection could scroll out of view in a long filtered
list), a progressive column picker (metadata + a union of payload fields
across just the checked leads, deduped by display label so the
Agency/"Carrier Name" alias doesn't appear as two options), and CSV/Excel
export via `papaparse`/`xlsx` (both already project dependencies, previously
used only for *reading* uploaded files).

## Database
Read-only. `.from("submissions")` filtered to `disposition='accepted'`,
`archived_at is null`, with the same filter-clause builders
(`carrierSearchClauses`, plus two added for this feature:
`customerNameSearchClause`, `draftDateSearchClauses`) that
`SubmissionsExplorer` already uses — capped at 500 rows, no RPC, no write
path at all.

## Business rules
- **Selection holds the row object, not just the id** — a Map keyed by
  submission id, holding the full fetched row. This matters because
  changing a filter can drop a previously-selected lead out of the current
  result set entirely; if selection only tracked ids, that lead's data (and
  therefore its place in the export) would silently disappear the moment
  the filter changed.
- **Column availability is a union across checked leads, not an
  intersection** — checking a closer lead and a validator lead offers every
  field either one has; a lead missing a chosen column simply gets a blank
  cell in the export, by explicit product decision.
- **The three validator-completed fields** (`final_carrier_id` resolved to
  a name via an embed, `agent_name`, `policy_number`) are exposed as
  metadata columns, since they're columns on `submissions`, not payload
  keys, and would otherwise be invisible to this feature entirely.
- The one deliberate motion in the UI: the ready-to-export bar's border
  warms from muted to amber only once there's a real, non-empty selection
  of both leads and columns — a single orchestrated signal rather than
  scattered hover effects.

## Known limitations
- **500-row cap, no pagination** — a filter combination matching more than
  500 accepted leads will silently omit the rest; there is no page 2.
  Narrowing filters first is the mitigation; the cap could be raised later
  if this proves too tight in practice.
- No export audit trail — unlike `card_access_log` for payment reveals,
  nothing records who exported what, or which columns. Payload fields
  exposed here never include card/CVV (those never enter `payload` in the
  first place), but SSNs and bank account numbers are in scope for this
  export and are not logged when exported.

## Future work
Extending scope to declined/pending leads (explicitly named as a "maybe
later" by the person who requested this feature, not committed).
