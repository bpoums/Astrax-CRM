# Sales Breakdown (admin reporting tab)

## Purpose
Answer, over approved sales only, three questions no existing view or RPC
covers: how many Level/Graded/Mod/GI sales closed, the same split per
carrier and per customer state, and which closer is currently performing
best/worst by accepted-sale count.

## Current status
Live; built in this working session. Read-only, no database change.

## Roles involved
**admin** only (mounted on the admin-only `/admin` route; no other role has
a route to it).

## Routes / screens
`/admin?tab=sales-breakdown` → `src/components/sales-breakdown.tsx`
(`SalesBreakdown`).

## Important components
`sales-breakdown.tsx` (`SalesBreakdown`, `PivotTable`, `LeaderboardCard`,
`StatCard`), `src/lib/plan-type.ts` (`normalizePlanType`,
`PLAN_TYPE_COLUMNS`). Reuses, unmodified: `carrierName`/`Disposition`
(`ops.tsx`), `useCarriers`/`carrierRefs` (`lib/carriers.ts`), `lookupCarrier`
(`lib/normalize/carriers.ts`), `STATE_CODES`/`STATE_ABBREVIATIONS`
(`lib/normalize/states.ts`), `MetricBar` (`metric-bar.tsx`).

## Database
Read-only, no RPC/view/migration added.
- **Approved-sales breakdown**: `.from("submissions").select("payload, final_carrier:carriers!submissions_final_carrier_id_fkey(name)")`
  filtered to `disposition = 'accepted'` and `archived_at is null`, fully
  paginated (1000 rows/page, no cap) rather than capped the way `Exports` is
  — this is an aggregate total, and silently truncating it would misreport
  a real count rather than just show a shorter preview.
- **Closer leaderboard**: a second, independent fetch —
  `.select("closer_id, disposition, closer:profiles!submissions_closer_id_fkey(full_name)")`
  filtered to `closer_id is not null` and `archived_at is null` (any
  disposition, so a conversion rate is computable) — same pagination, same
  date window.
- **Date filtering**: the `This Week` / `This Month` chips call
  `reporting_window({ p_days: 7 | 30 })`; `Custom` calls it with
  `p_start_date`/`p_end_date` — the exact RPC and call shape
  `SubmissionsExplorer` already uses for its own date filter
  (`src/components/reporting.tsx`), so this tab's day boundaries can never
  disagree with the rest of the app's. `All time` (the default) skips the
  RPC entirely.

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
- Carrier/state aggregation is computed client-side (fetches all matching
  rows, aggregates in the browser) rather than via a SQL view, because the
  alias/state-name matching it needs already lives once, on purpose, in
  `src/lib/normalize/*` (built pure so it can be lifted anywhere) —
  reimplementing that matching in SQL would create a second, divergent copy
  of the same logic.

## Future work
None named yet.
