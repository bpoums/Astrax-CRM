# Sales Breakdown (admin reporting tab)

## Purpose
Answer, over approved sales only, three questions no existing view or RPC
covers: how many Level/Graded/Mod/GI sales closed, the same split per
carrier and per customer state, and which closer is currently performing
best/worst by accepted-sale count.

## Current status
Live; built in this working session. Read-only, no database change.

## Roles involved
**admin** (mounted on `/admin`) and, since **2026-10-02**, **reporting_manager**
(mounted on its own `/reporting` route — see [reporting.md](reporting.md)).
No other role has a route to it.

## Routes / screens
**Changed 2026-10-07:** admin no longer has a Sales Breakdown tab. `SalesBreakdown`
is rendered at the bottom of the admin **Overview** tab (under a "Sales"
divider) with `sharedPeriod={usePeriod()}` from `AdminOverview`, so one filter
(Today / 7 days / 30 days / All time / Custom, Pacific-day rolling windows)
governs both the Overview panels and this section; the component then hides
its own chips and lays By Carrier / By State side by side at `xl`. The
calendar-aligned "This Week / This Month" chips no longer exist in admin.
An old `/admin?tab=sales-breakdown` link falls back to Overview.

`/reporting?tab=sales-breakdown` still mounts `SalesBreakdown` with no props
and keeps its own chips (including This Week / This Month). The component has
no role branching; what differs by role is which RPCs will answer it.

## Important components
`sales-breakdown.tsx` (`SalesBreakdown`, `PivotTable`, `LeaderboardCard`,
`StatCard`), `src/lib/plan-type.ts` (`PLAN_TYPE_COLUMNS`, used only for the
table's column headers now — bucketing itself happens in
`sales_plan_type_bucket` server-side), `MetricBar` (`metric-bar.tsx`). The
component no longer imports `carrierName`, `useCarriers`/`carrierRefs`,
`lookupCarrier`, or the state-normalizer constants — all of that logic moved
to the SQL functions listed under Database.

## Database
**Role guard widened 2026-10-02** (`20261002110000_reporting_manager_grants.sql`):
both RPCs below were `my_role() is distinct from 'admin'`; now
`my_role() is null or my_role() not in ('admin','reporting_manager')`
(converted from `language sql` to `language plpgsql` to hold the check) —
queries themselves unchanged. See [database.md](../database.md).

**Server-side aggregation, added 2026-09-27** (`20260927120000_sales_breakdown_range.sql`).
Previously this tab paged every accepted lead's full payload into the browser
and pivoted client-side; that shipped customer PII to the browser purely to
count carriers and was measured at 386 rows / 393 kB live (2026-09-18,
tracked in `docs/TODO.md`). It now calls two admin-only RPCs that do the same
aggregation server-side:
- **`sales_breakdown_range(p_days, p_start_date, p_end_date)`** — scoped
  exactly as before (`disposition = 'accepted'`, `archived_at is null`),
  returning one `'total'` row plus one row per resolved carrier and per
  resolved state, each with the five plan-type bucket counts and a total.
  The carrier/state resolution and plan-type bucketing (see "Business rules"
  below) are reimplemented in SQL by three helper functions
  (`sales_plan_type_bucket`, `sales_resolve_carrier`, `sales_resolve_state`)
  that mirror `src/lib/plan-type.ts`/`src/lib/normalize/carriers.ts`/
  `src/lib/normalize/states.ts` exactly, so the rules described below still
  apply — only where they run changed. See `docs/database.md` for the full
  signature list.
- **`sales_closer_leaderboard_range(p_days, p_start_date, p_end_date)`** —
  the closer leaderboard, same scope as before (`closer_id is not null`,
  `submitted_by_role <> 'validator'`, `archived_at is null`).
- **Center badge per closer** (2026-10-06): the RPC returns no center, so the
  component reads `profiles.center_id` for the leaderboard's closer ids and
  colors it from `useCenters(false)` (inactive centers included). It's the
  closer's **current** profile center, not a center stamped at submission —
  a closer who moves centers shows all their history under the new one.
  Shown in the table's Center column and on the Top Performer / Needs
  Support cards; a closer with no center shows "—".
- **Date filtering**: unchanged in the UI (`This Week`/`This Month` resolve
  to calendar-boundary dates client-side; `Custom` uses the picked dates;
  `All time` sends neither) but now passed straight through to the two RPCs'
  own `p_start_date`/`p_end_date` args (the same `reporting_window`-driven
  resolution `submission_totals_range` uses) instead of first resolving a
  window via a separate `reporting_window` call and filtering client-side.
- Verified live equivalent to the old client-side result: the RPC's total
  matched a direct `count(*) filter (disposition='accepted' and archived_at
  is null)`, and the carrier/state group sums both reconciled to that same
  total.

## Business rules
- **Scope is `disposition = 'accepted'` only** — the same "Submit"/approved
  scope `Exports` uses. Declined/pending leads are out of scope by design,
  matching how the person requesting this report described "approved
  sales."
- **Plan Type bucketing** (`src/lib/plan-type.ts`) handles real drift in the
  stored value: case (`LEVEL`, `GI`), punctuation (`G.I` vs `GI`), and a
  combined `"Graded / Mod"` value. Bucket order is Mod → Level → Graded → GI
  → Unspecified; **Mod is its own 4th bucket**, not folded into Graded, by
  explicit decision — it's rare (2 of 390 rows at build time) but distinct.
- **Carrier resolution**, three steps, each falling through to the next:
  1. `final_carrier_id` (validator-set, resolved via the `carriers` table)
     wins when present.
  2. Otherwise the free-text payload field (`Carrier Name` / `Agency`, via
     `carrierName()`) is run through `lookupCarrier()` against the
     `carriers` table's `aliases` — an **exact** match (after stripping
     case/punctuation/spaces), so `"COREBRIDGE"`/`"Corebridge"` fold into
     `Corbridge` because that alias is registered.
  3. Failing that, `prefixMatchCarrier()` (local to this file, not part of
     `src/lib/normalize`) checks whether the text **starts with** a
     registered carrier name or alias — so `"Corebridge GIWL"`, `"Corebridge
     Financial"`, `"Transamerica Express Select"` fold into their carrier
     even though nobody registered that exact product name as an alias.
     Deliberately not added to the shared `lookupCarrier` the upload-import
     pipeline uses — that pipeline's "never guess, always exact or flagged"
     rule is a financial-data safety property this reporting tab doesn't
     need to inherit.
  A name that still doesn't match after all three steps shows up as its own
  raw-text row (case/whitespace-normalized so `"American Amicable"` and
  `"AMERICAN AMICABLE"` land in one row) rather than disappearing into
  "Unspecified" — only a genuinely blank carrier field buckets there. A
  carrier that isn't registered in the `carriers` table at all (e.g. an
  entirely new one nobody's added yet) cannot be folded by any alias — it
  has to be added as a carrier first (Admin → Settings → Carriers) before
  its spelling variants can be aliased together.
- **State resolution**: `COALESCE(State, Residential State, Birth State)` —
  the validator form never collects a plain "State" field (only "Birth
  State"), so falling back through all three is what makes validator-
  submitted approved sales (the majority of them) show up in this report at
  all. A non-recognizable value (blank, "N/A", a typo, a non-US value) at
  one field falls through to try the next field before giving up to
  "Unspecified".
- **Closer leaderboard excludes validator self-submissions.** A
  validator-submitted lead (`submitted_by_role = 'validator'`) auto-closes as
  accepted and stamps `closer_id` with the *validator's own* profile id, not
  a real closer's — without filtering `submitted_by_role != 'validator'` out
  of the leaderboard fetch, every validator appears as a "closer" with a
  trivial 100% conversion rate from their own leads, crowding out and
  misrepresenting actual closer performance. Confirmed live: e.g. Rabia
  Ahmed (role `validator`) had 75 self-submitted leads, 74 accepted — a
  real closer's leads go through a validator's review, so a 100% rate for a
  role="validator" account is a strong tell this is the case, not a genuine
  outlier closer.
- **Closer leaderboard "worst performer"** is scoped to closers who
  submitted at least one lead in the selected period — ranking every closer
  account that exists (including ones idle in that window) would just tie
  a pile of accounts at zero and call that "worst."
- **Calendar boundaries, not rolling windows** — "This Week" is
  Monday-of-the-current-week through today; "This Month" is the 1st of the
  current calendar month through today. (Originally shipped as a rolling
  `p_days: 7`/`p_days: 30` window matching `ReportingStats`' Today/7d/30d
  chips, then corrected: with under 30 days of data in the system, that made
  "This Month" read identical to "All time," and the ask was explicitly for
  September's numbers, not "the last 30 days.") The anchor dates (today,
  the most recent Monday, the 1st of the month) are computed from the
  browser's local calendar and handed to `reporting_window` as plain
  `p_start_date`/`p_end_date` values — the same mechanism `Custom` already
  uses for a manually-picked range — so only the actual day-boundary math
  (midnight, DST) stays server-side/Pacific. A viewer far from Pacific time
  could in principle see a period label off by one calendar day right at
  midnight, the same tolerance `Custom`'s plain date inputs already carry.

## Known limitations
- No realtime invalidation — unlike `ReportingStats`/`SubmissionsExplorer`,
  this tab does not subscribe to `postgres_changes`; a stale view clears on
  next visit/refetch, not live. Consistent with `Exports`, which behaves the
  same way.
- The carrier/state alias-matching logic now exists in two places: the
  client-side normalizers in `src/lib/normalize/*` (used by the upload-import
  pipeline) and the SQL reimplementation in
  `sales_resolve_carrier`/`sales_resolve_state` (used only by this tab's
  RPCs). This was a deliberate, accepted tradeoff to get the aggregation off
  the browser (see `docs/TODO.md`'s "Sales stats on the admin Overview" entry)
  — a change to carrier alias rules or the state list needs updating in both
  places if it should apply to both the import pipeline and this report.

## Future work
None named yet.
