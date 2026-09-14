# Reporting

## Purpose
Give managers and admins volume, disposition, and per-validator performance
figures, plus a searchable/paginated record of every submission (including
archived ones), without recomputing any of it client-side.

## Current status
Live, actively developed — the five most recent commits in the repository's
history are all reporting-UI refinements (period selector, queue-age
display, visual separation of waiting stages), see [CHANGELOG.md](../../CHANGELOG.md).

## Roles involved
**admin** (Overview + Submissions tabs, with the fuller `showValidatorSubmissions`
view), **manager** (the same dashboard via the Reporting tab, narrower view).

## Routes / screens
- `/admin?tab=overview`, `/admin?tab=submissions` → `src/components/reporting.tsx`'s
  `ReportingStats` and `SubmissionsExplorer`, mounted on separate tabs so
  only one queries at a time.
- `/manager` → Reporting tab → `ReportingDashboard` (both combined, since
  there's no second tab to split them across there).

## Important components
`reporting.tsx` (all three exports), `queue-flow.tsx` (`QueueFlow` — the
proportional "where leads are right now" bar), `metric-bar.tsx` (`MetricBar`
— a generic single-track comparator bar, also reused by the CX coverage
card), `validation-timeline.tsx`, `payload-history.tsx`.

## Database
- RPCs: `submission_totals_range`, `submission_totals_by_center_range`,
  `validator_stats_range` (all `SECURITY INVOKER`). These wrap the plain
  views `submission_totals`, `submission_totals_by_center`,
  `validator_stats` documented in [database.md](../database.md) — confirmed
  to exist by direct database inspection; the client code only ever calls
  the `_range` RPC wrappers.
- **Date filtering, added 2026-09-10**: all three now also accept optional
  `p_start_date`/`p_end_date` (in addition to the original `p_days`), via a
  new shared `reporting_window(p_days, p_start_date, p_end_date)` function.
  Passing only `p_start_date` filters exactly that one Pacific calendar day;
  passing both filters an inclusive range. `p_days` still means what it
  always did (open-ended, last N days through now) and existing calls are
  unaffected. See [database.md](../database.md) for the exact semantics.
- `QueueFlow`'s `assigned`/`onHold`/`returned` counts and every stage's
  "oldest" age come from a direct, unpaged `submissions` query (open
  statuses only) run inside `ReportingStats` — not from any view, because
  neither the hold-shape condition nor per-stage oldest-age is expressible
  through the existing views/RPCs.
- `SubmissionsExplorer` reads `submissions` directly and paginated (25/page,
  `LEAD_PAGE_SIZE` in `src/lib/lead-search.ts`), with server-side search
  (`payload->>Key ilike`) built in `lib/lead-search.ts` — never a client-side
  filter over an already-fetched page, since that would silently miss
  matches sitting on a different page.

## Business rules
- **Origin split, not role split**: the Closer/Validator/Manual tabs split by
  `source` + `submitted_by_role` together, not either alone — an imported
  lead is written with `submitted_by_role='closer'` and `closer_id=null`, so
  splitting on role alone would put it on the Closer tab with a blank Closer
  column.
- **Archived and non-archived never mix** — the toggle switches which set
  you see; there is no combined view.
- Realtime invalidation on `SubmissionsExplorer` only invalidates the
  **currently active page's** cache key, not every cached page — retiring
  every page on every change would send an idle reader's view back to the
  network for pages nobody is looking at.
- The period selector (today/7d/30d/all-time/**custom**) applies only to the
  totals panel and the two RPC-backed breakdowns — `QueueFlow` above it is
  deliberately never windowed, since "leads open right now" has no
  meaningful time boundary.
- **Custom date filtering, added 2026-09-10**: a "Custom" chip on the
  Overview tab reveals From/To date inputs (To optional — a single day
  filters exactly that day); `SubmissionsExplorer` on the Submissions tab
  has its own independent From/To inputs in its filter bar, ANDed with the
  existing search/carrier/archived filters the same way the carrier box
  already narrows the search box. Both features call the same
  `reporting_window` RPC rather than computing date boundaries in the
  browser — this codebase is deliberately strict about Pacific-timezone
  math staying server-side (DST makes a hardcoded JS offset wrong roughly
  half the year; see `src/lib/format-date.ts`'s own comments).

## Known limitations
- `ReportingStats`' period default is `"all"` explicitly to avoid every
  lifetime figure looking like a drop the moment the feature shipped —
  worth knowing if a future change is tempted to default to a shorter
  window.
- No cross-center reporting view is consumed by any role except admin's
  Overview tab (see [multi-tenancy.md](../multi-tenancy.md)).

## Future work
None found as explicit TODOs; the commit history suggests this is the area
under the most active, incremental refinement right now.
