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
Read-only. `.from("submissions")`, built by `buildExportQuery` in
`src/lib/export-filters.ts` — one builder for the paged table and for "Select all
matching", so the two cannot disagree. **No row cap (removed 2026-10-17; it was a
silent 500).** The table pages 50 at a time with an exact count (`PaginationBar`).
One RPC: `lead_ids_by_bank` (below).

## Scope (changed 2026-10-17)
**Every lead, submitted or not.** Until 2026-10-17 the tab was fixed to
`disposition = 'accepted'`; that is now a filter (**Disposition**, with "Not
disposed") alongside **Validation Status**. **Archived** leads are hidden by
default, as everywhere in the CRM; the Archived filter switches to "Include" or
"Archived only". The table shows Validation status and Disposition columns so a
mixed list stays readable; the detail panel shows tags only on accepted leads
(`add_submission_tag` refuses the rest). Leads still in `pending_import_approval`
appear too, as they are real rows.

## Filters
Search (customer, closer, phone, SSN, policy #), **Bank**, Proposed carrier, Final
carrier, Disposition, Validation Status, Archived, Submitted By (closer / validator
/ manual), Center, Missing info, Missing bank info, Submitted on (`disposed_at`),
Sale made on (`created_at`), Draft date, Age (from–to; stored as text, so matched
with `in` over the exact ages; kept current nightly by `refresh-lead-ages`, so it is today's age), and the four Customer statuses (behind a
disclosure). Same composition as the Closing Desk: each filter is its own
condition, all AND, all run in the database. Day boundaries come from the
`reporting_window` RPC. An "Applied" strip names every active filter and removes it
on click. Missing info / Missing bank info counts are tallied over the non-archived
leads on this tab, not taken from `missing_info_by_field()`, which was counting a
different set (Draft Date read 175 against 3 submitted leads). The Closing Desk
still carries its own copy of this logic; it has not been moved onto the shared
builder.

### Bank search (added 2026-10-17)
A bank name lives in two disjoint places: `payload."Bank Name"` on closer-form
leads, and `payment_details.bank_name` on imported leads. The browser cannot read
`payment_details` (RLS on, no policy, by design), so the filter ORs a payload
`ilike` with `id in (…)` from the new `lead_ids_by_bank(p_term)` RPC. The RPC is
`SECURITY DEFINER`, admin/manager/general_manager only, returns **lead ids and
nothing else** (never a bank, account or routing number), and refuses a caller with
no role. It raises "too many banks match" past 500 ids rather than truncating,
because the ids travel in a URL. An imported lead's bank name is not an export
column (it is not in the payload) — only searchable.

## Opening a lead
Clicking a row opens the same detail panel as Admin → Submissions (editable as
admin, with history). **Selecting is the checkbox only** — before 2026-10-17 a row
click toggled selection. Edits made in the panel refresh the held selection, so the
export carries the corrected value.

## Selecting across pages
The header checkbox selects the current page. Once a whole page is ticked, "Select
all N matching" reads every matching lead in 1,000-row chunks (the PostgREST
maximum) into the same selection. Selection is a Map of full rows, so it survives
paging and filter changes.

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
- No export audit trail — unlike `card_access_log` for payment reveals,
  nothing records who exported what, or which columns. Payload fields
  exposed here never include card/CVV (those never enter `payload` in the
  first place), but SSNs and bank account numbers are in scope for this
  export and are not logged when exported.

## Future work
Extending scope to declined/pending leads (explicitly named as a "maybe
later" by the person who requested this feature, not committed).
