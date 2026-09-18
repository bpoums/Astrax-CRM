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
**admin** (Overview + Submissions tabs — Overview is its own screen since
2026-09-18, see below), **manager** (`ReportingStats` via the Reporting tab,
narrower view), and since 2026-09-18 **closing_manager** / **general_manager**
(the three panels only, on the Closing Desk's Overview tab).

## Routes / screens
- `/admin?tab=overview` → `src/components/admin-overview.tsx`'s `AdminOverview`
  (**redesigned 2026-09-18**; it used to be `ReportingStats
  showValidatorSubmissions`).
- `/admin?tab=submissions` → `src/components/reporting.tsx`'s
  `SubmissionsExplorer`, on its own tab so only one of the two queries at a
  time.
- `/manager` → Reporting tab → `ReportingDashboard` (`ReportingStats` +
  `SubmissionsExplorer` combined, since there's no second tab to split them
  across there). It gained the same three panels on 2026-09-18, in place of the
  standalone queue strip it used to show.
- `/closing` → Overview tab → `closing-overview.tsx`'s `ClosingOverview`
  (2026-09-18) — the same panels for a closing or general manager, scoped by
  their own RLS. See [closing-desk.md](closing-desk.md).

## Important components
`reporting.tsx` (`ReportingStats`, `SubmissionsExplorer`, `ReportingDashboard`,
plus `TotalsPanel` and `LeadsByCenterPanel`, which both dashboards render),
`admin-overview.tsx` (the admin Overview screen), `overview-panels.tsx`
(`OverviewPanels` — the three-panel row all three screens render),
`closing-overview.tsx` (the Closing Desk's copy, role-adapted), `queue-flow.tsx` (`QueueFlow`
— the proportional "where leads are right now" bar), `metric-bar.tsx`
(`MetricBar` — a generic single-track comparator bar, also reused by the CX
coverage card), `submission-outcome.tsx` (the Submitted/Declined donut),
`flip-number.tsx` (the split-flap counter), `period-picker.tsx` +
`lib/period-range.ts` (the window chips and the one derivation behind them),
`lib/overview-stats.ts` (every figure both dashboards are built from, fetched
once), `validation-timeline.tsx`, `payload-history.tsx`.

## The three panels (`overview-panels.tsx`)
One row, three questions, on **three screens**: the admin Overview, the
manager's Reporting tab and the Closing Desk's Overview tab. One component
rather than three copies, because it is the business's own picture of itself
and three copies would start disagreeing within a month.

`OverviewPanels` is **given** its data and never fetches any. `useOverviewStats`
opens a realtime channel, two Supabase subscriptions may not share one name, and
`ReportingStats` already calls that hook on the manager's tab — so a second call
inside the panels would mount the same channel twice on one screen. Each parent
calls `usePeriod()` and `useOverviewStats()` once and passes both down: one
window, one fetch, one channel per screen. The Closing Desk passes its own
channel name (`closing-overview`) through the hook's existing `channel` option.

Nothing in the component is gated on a role. Every figure arrives already scoped
by the caller's RLS, so a closing manager reads their centre's numbers through
the identical code an admin reads the whole business through; its two
presentational props (`centers`, `showValidatorRow`) are about what is worth
drawing, never about what a role may know. See
[closing-desk.md](closing-desk.md) for what that means there.

The panels:

1. **Intake** — titled with the selected window ("All time", "Last 7 days",
   "Today", or the custom range). It read the literal word "Today" whatever the
   chips said until 2026-09-18, which made the panel contradict the figures
   inside it.

   **Two columns since 2026-09-18: Live and Manual, each with its own centre
   list underneath** (`total_submissions` and `manual_submissions`). It was
   briefly one merged centre list earlier that day, which answered "how big is
   this centre" but destroyed the question the panel is actually opened with —
   *where did the uploaded leads come from*. A centre whose forty leads are all
   uploads and one whose two hundred are all validator submissions had looked
   identical. Both columns share **one** bar scale, so they can be compared
   rather than each normalising to its own busiest centre. Manual is uploads
   plus validator submissions; which of the two a given lead is stays on the
   Submissions tab's Type column.

2. **Submission Outcome** — `Submitted` (`approved_all`) against `Declined`
   (`declined_all`), **every origin**, as an
   inline SVG donut with the acceptance rate in the middle. No charting
   library. `pending` is deliberately absent: it is not an outcome, it is a
   lead back in the manager's queue, and it is counted in panel 3.
3. **L.A. Operations** — the same `QueueFlow` strip the manager works from,
   with `orientation="rows"` and `flip` set. Never windowed by the period
   chips, and the panel says so.

**Where each screen puts them:**
- **admin** `/admin?tab=overview` — the row, then `TotalsPanel` and
  `LeadsByCenterPanel` as the record for the selected window, and finally a
  two-column closing row of health checks: `CxCoverageCard` and
  `SheetSyncBacklogCard`. Both are plain panels placed by `admin.tsx`; before
  2026-09-18 each positioned itself and so sat alone on a mostly empty row.
- **manager** `/manager` → Reporting — the row **in place of the standalone
  queue strip** it used to show there (2026-09-18), then the same period chips,
  totals strip, Validators Team Dashboard and explorer as before. The chips also
  moved ABOVE the row in the same change: the first panel is now titled with the
  window, and a control that changes a heading has to be readable before that
  heading, not after it.
- **closing_manager / general_manager** `/closing` → Overview — the chips and
  the row, nothing below.

Counts flip over like a split-flap board when they change (`FlipNumber`).
A digit animates only when that digit actually changes, once, over 400ms;
nothing idles or loops, and `prefers-reduced-motion: reduce` swaps the value
outright — checked in JS as well as CSS, because with `animation: none` the
`animationend` that retires the moving flaps never fires. Pure CSS 3D in
`styles.css` (`@keyframes flip-fall`/`flip-rise`, `.flip-card` and friends);
no animation library was added.

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
- **The search matches the Manual tab's Type column** (added 2026-09-18).
  Type prints "Validator" or "Upload" per row, and both words now filter:
  "validator" (or "manual") adds `submitted_by_role.eq.validator`, and
  "upload"/"uploaded" adds `source.eq.sheet` — `matchesValidatorRole()` and
  `matchesUploadKind()` in `reporting.tsx`. Before this, "upload" matched
  **nothing at all**: no status, disposition or source alias contains the
  word, so searching the term printed on screen returned an empty table. The
  upload clause is harmless on the Live tab, which ANDs `source = 'live'` over
  the whole `or` group.

## Business rules
- **Two tabs, Live and Manual** (renamed/merged 2026-09-15 from three:
  Closer/Validator/Manual). Live = `source='live'` AND not
  `submitted_by_role='validator'`; Manual = (`submitted_by_role='validator'`
  OR `source='sheet'`) AND not `pending_import_approval`. Both tests are
  needed, not either alone: an imported lead is written with
  `submitted_by_role='closer'` and `closer_id=null`, so splitting on role
  alone would put it on Live with a blank Closer column, while a validator's
  own submission is stored `source='live'`, so splitting on origin alone
  would miss it. The `pending_import_approval` exclusion sits outside the OR
  group deliberately — only a sheet import is ever in that status
  (`submit_form_internal` hardcodes `closed` for a validator submission), so
  an unconditional exclusion hides exactly the right rows and stays flat.
  Spelled once in `applyManualTabFilter()` because the paged fetch and the
  chip's head-count both use it and must agree.
- **The merged Manual table's columns are chosen so none changes meaning by
  row kind.** It mixes validator-typed and uploaded leads, so the two columns
  that *would* have changed meaning were replaced: `Source` (which
  `sourceLabel()` reads as "Manual" for both kinds, saying nothing inside a
  tab already named that) became **Type** — Validator vs Upload, the one
  distinction the old tab split conveyed for free — and the old `Validator`
  column, which meant the *author* on the Validator tab but the *assignee* on
  the Manual tab, split into **Submitted By** (`closerName()`, which already
  resolves the uploading centre or the validator themselves off `source`) and
  **Validated By** (`assignee`, a dash on a validator row because it genuinely
  was never assigned). Validation Status and Disposition show the real stored
  values on validator rows — "Completed"/"Submit", constant but true, and
  matching what the detail sheet shows. Its carrier column is the **Final
  Carrier** (`finalCarrierName()`), not the proposal.
- **Two carrier filters, not one** (2026-09-15): a *Proposed carrier* box and
  a *Final carrier* box. Each is its own PostgREST `or` group, and repeated
  groups AND together, so filling both asks for the intersection — "pitched
  Amicable, written on TransAmerica" is a real slice of the book (8 leads
  live) that a single combined box could not express. The Final box spans
  both shapes the concept has: `final_carrier_id.in.(...)`, resolved from the
  typed text by `matchingCarrierIds()` because the column holds a uuid, plus
  `payload->>Agency` for a validator's own submission, which never gets that
  FK. The Proposed box deliberately matches nothing on a validator row rather
  than falling back to `Agency` — those leads have no proposal stage. See
  [closer-submission-and-forms.md](closer-submission-and-forms.md) for the
  two-concept model. `exports.tsx` keeps its single combined carrier box for
  now; giving it the same treatment is an open follow-up.
- **Every reporting screen now reads Live/Manual, merged** (2026-09-18), closing
  the inconsistency with the Live/Manual chips that this file recorded as an
  open follow-up. Manual is `offline_submissions + validator_submissions`,
  added in the client — the two are disjoint by construction (a row is exactly
  one of closer / uploaded / validator), so this adds two aggregates the view
  already publishes rather than re-deriving either from rows. No filter rule is
  restated client-side and no lead can be counted twice, which is the thing
  [database.md](../database.md) is guarding against; a view migration would
  produce the identical number. The Uploaded/Validator split survives one level
  down, in the Overview's own source breakdown and in the Submissions tab's
  Type column. The manager's record strip was merged in the same pass, and had
  to be: with the panels merging and the strip not, one screen printed
  "Manual 243" and "Manual 41" one above the other, which is worse than either
  figure being wrong on its own. Its only remaining difference from the admin's
  is `TotalsPanel`'s `showReviewFailures` — the Timeouts and Rejections tiles,
  which are the review desk's own failures and belong on the screen of the
  person who can act on them.
- **Archived and non-archived never mix** — the toggle switches which set
  you see; there is no combined view.
- Realtime invalidation on `SubmissionsExplorer` only invalidates the
  **currently active page's** cache key, not every cached page — retiring
  every page on every change would send an idle reader's view back to the
  network for pages nobody is looking at.
- The period selector (today/7d/30d/all-time/**custom**) applies only to the
  totals panel and the two RPC-backed breakdowns — `QueueFlow` is deliberately
  never windowed, since "leads open right now" has no meaningful time boundary.
  Since 2026-09-18 the chips are one component (`PeriodPicker`) over one
  derivation (`usePeriod` in `lib/period-range.ts`), and the four queries
  behind both dashboards are one hook (`useOverviewStats` in
  `lib/overview-stats.ts`) with the query keys unchanged — so the admin
  Overview and the manager's Reporting tab share a cache entry and cannot
  drift apart.
- **Custom date filtering, added 2026-09-10**: a "Custom" chip on the
  Overview tab reveals From/To date inputs (To optional — a single day
  filters exactly that day); `SubmissionsExplorer` on the Submissions tab
  has its own independent From/To inputs in its filter bar, ANDed with the
  existing search/carrier/archived filters the same way the carrier boxes
  already narrow the search box. Both features call the same
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
