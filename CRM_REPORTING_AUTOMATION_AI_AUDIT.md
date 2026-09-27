# ASTRAX CRM — Reporting, Automation & AI Audit

**Audit date:** 2026-09-27 · **Branch audited:** `integration` · **Method:** static read of routes, components, `docs/*`, `supabase/migrations/*`, and Supabase edge functions. No code, schema, or config was changed. No live database queries were run in this pass — findings about live RLS/RPC behavior are taken from `docs/database.md` and `docs/TODO.md`, which the repo's own convention (see `CLAUDE.md`) treats as verified against the live project as of 2026-09-25.

---

## EXECUTIVE SUMMARY

ASTRAX is a single-tenant lead-validation console, not yet a full insurance CRM in the commission/policy-lifecycle sense. Its entire domain model is one table, `submissions`, carrying a lead from closer submission through manager assignment, validator review, and a terminal `accepted` disposition. There is no `policies`, `commissions`, or `chargebacks` table, and **no monetary field exists anywhere in the schema** — not a premium amount, not a commission amount. `policy_number`, `agent_name`, and `final_carrier_id` are the only "post-sale" fields. Three of the four Customer Experience (CX) pipeline tabs — Transfer, Chargeback, Analytics — are unbuilt placeholders. This means the majority of textbook insurance-CRM reports requested in the prompt (premium volume, commission volume, net revenue, chargeback trends, persistency) **cannot be built today without new schema work**, and this audit says so explicitly rather than inventing numbers to report on.

What does exist is a well-instrumented **operational pipeline**: every status transition, timeout, hold, rejection, and disposition is timestamped and attributable (`submissions`, `form_events`, `payload_edits`, `card_access_log`, `settings_audit`). Three dashboards already exist (`ReportingDashboard` shared by admin/manager, `AdminOverview`, `ClosingOverview`), all built on the same server-side RPCs (`submission_totals_range`, `submission_totals_by_center_range`, `validator_stats_range`, `reporting_window`) — so period-scoped counts are already correct and centralized. The one dashboard that breaks this pattern, `SalesBreakdown`, aggregates client-side by paging every accepted lead's full payload into the browser (386 rows / 393 KB measured live) — already flagged in `docs/TODO.md` as needing a server-side `sales_breakdown_range` RPC.

Two live, **unfixed security defects** are directly load-bearing for this audit's recommendations: (1) roughly 20 RPCs use `my_role() <> 'admin'` instead of `IS DISTINCT FROM`, so an inactive/no-JWT caller's NULL role silently passes the guard — confirmed live against `admin_settings()` and `reporting_retention_status()`; (2) `validator_stats_range()` returns `timed_out`/`rejected`/`holds` figures un-scoped by center, so a `closing_manager` who should only see their own center's validators currently sees whole-business validator performance. Any new General Manager or Manager report that reuses this RPC inherits that leak until `docs/TODO.md`'s fix lands — this audit flags it at every recommendation that touches it rather than repeating the caveat once and hoping it's remembered.

There is no charting library in use (Recharts is an installed-but-dead dependency; every existing chart is a hand-built CSS bar or animated counter), no notification system beyond ephemeral toasts and one pull-based "problem badge" list on the closer's Forwarded Leads screen, and no AI/LLM integration of any kind in the product — the one AI-adjacent feature, Voice Clone Studio, is an admin-only proxy to an unrelated, unauthenticated third-party TTS tool with no audit log, not a CRM capability.

The recommendations below are deliberately conservative: most Priority-0/1 items are reports and automations buildable entirely on data that already exists, phrased as new RPCs/views and small UI additions rather than new subsystems — consistent with `CLAUDE.md`'s instruction to keep this a small, maintainable codebase. Where a report needs data that doesn't exist (premium amount, first-contact timestamp, chargeback records), that is called out as a **Data Gap**, not silently assumed.

---

## 1. EXISTING CRM CAPABILITIES

**Domain model.** One lifecycle entity: `submissions` (422 live rows). No separate Lead/Customer/Application/Policy/Commission/Chargeback tables — those concepts are folded into `submissions.status` (`sub_status`: `pending_manager, assigned, in_review, returned_timeout, closed, pending_import_approval, parked`) and `submissions.disposition` (`disposition_t`: `accepted, declined, pending`). `accepted` is the only terminal state (`docs/decisions/0004-only-accepted-is-terminal.md`); `declined`/`pending` both loop back to `pending_manager`.

**Two intake origins**, enforced by `submissions_source_chk`: `'live'` (closer-submitted via `submit_form`, then validated) and `'sheet'` (spreadsheet-imported via the uploader flow, or validator-direct-submitted forms which auto-close as accepted). `sourceLabel()`/`closerName()` in `src/components/ops.tsx` are the single place this distinction is rendered — "Live" vs "Manual."

**Post-acceptance CX pipeline.** An accepted (or CX-reopened) lead becomes a member of the CX pipeline (`cx_pipeline_member()`), where `cxm`/`cxa` roles track four independent status categories via `set_cx_status` (policy / premium / commission / chargeback — these are **categorical status labels** from `cx_status_options`, not computed dollar figures) and can attach free-text tags (`cx_tags`/`submission_tags`). Only the "Customers Pipeline" UI tab is built; Transfer, Chargeback, and Analytics render literal "Coming soon" (`CxPlaceholder`).

**Roles (9, `app_role` enum):** admin, manager, closing_manager, general_manager, closer, validator, data_uploader, cxm, cxa. `my_role()` (`select role from profiles where id=auth.uid() and active`) is the sole authority — an inactive profile resolves to no role.

**Existing dashboards/reports** (all confirmed by direct file reads):
- `ReportingDashboard` (`src/components/reporting.tsx`) — mounted on `/manager?tab=reporting` and (its `SubmissionsExplorer` half only) on `/admin?tab=submissions`. Period-filtered totals (`TotalsPanel`), a 3-panel Overview row (`OverviewPanels`: intake by center, outcome, queue-flow), and a per-validator table.
- `AdminOverview` (`/admin`, default tab) — `OverviewPanels` + `CxCoverageCard` + `SheetSyncBacklogCard`. Its `TotalsPanel` lifetime-totals strip is present in code but commented out, so the admin Overview currently shows no lifetime numbers strip.
- `ClosingOverview` (`/closing?tab=overview`) — same `OverviewPanels` pattern, scoped to the closing manager's center or all centers for a general manager, client-side.
- `SalesBreakdown` (`/admin?tab=sales-breakdown`, admin-only) — accepted-leads-only analytics: plan-type buckets, by-carrier / by-state pivot tables, closer leaderboard. Aggregates client-side over every accepted lead's payload (flagged as a scale/PII risk in `docs/TODO.md`).
- `Exports` (`/admin?tab=exports`, admin-only) — CSV/Excel download of accepted, non-archived leads, 500-row cap, dynamic payload columns, no export audit trail.
- `CxStatusBreakdown` / `CxCoverageCard` — CX pipeline coverage counts, server-grouped via `cx_status_summary`.
- `DraftDateDesk` (`/admin?tab=draft-dates`) — accepted leads by draft date, read-only.
- `ImportHistory` / `PendingImports` — uploader batch history and manager approval queue for spreadsheet-imported leads.
- Audit trails that exist in code but are **not reachable from any live UI tab**: `SettingsAudit` and `CardAccessLog` (both tabs commented out in `admin.tsx`).

**Existing automation** (pg_cron, per `docs/database.md`): `expire-reviews` (every minute, enforces the review window server-side), `purge-payment-data` (daily), `purge-reporting-leads` (daily), `roll-recurring-draft-dates` (daily), `drain-sheet-sync`/`resolve-sheet-sync` (every minute, current Google Sheets sync mechanism). No business-facing automation exists — no stale-lead alerts, no follow-up reminders, no manager digests.

**Existing "AI."** None, except `voice-clone-proxy` (`supabase/functions/voice-clone-proxy/index.ts`) — an admin-only pass-through to an external, unauthenticated third-party TTS/voice-cloning tool at a bare IP. It has no audit log and is unrelated to CRM data; it is not a foundation to build CRM AI on.

**Notifications.** `sonner` toasts only, plus one pull-based mechanism: the `closer_lead_alerts` view surfaces problem badges on a closer's own Forwarded Leads screen. No email/SMS/push for business events; Gmail SMTP exists solely for Supabase Auth's invite/reset emails.

---

## 2. LIFECYCLE MAP

### Entity: Lead / Submission (the only lifecycle entity in the system)

- **Current stages** (`sub_status`): `pending_import_approval → pending_manager → assigned → in_review → closed`, with `returned_timeout` and `parked` as side-branches. (`parked` = External Transfer flow, added 2026-09-19, released back into validation only by `move_to_validation`, admin/general_manager only.)
- **Disposition** (`disposition_t`, independent of status): `accepted` (terminal — displayed everywhere as "Submit"), `declined`, `pending` (both non-terminal, loop back to `pending_manager`).
- **Who can change stage:** closer (`submit_form` → `pending_manager`), manager (`assign_to_validator` → `assigned`), validator (`claim_submission` → `in_review`; `dispose_submission` → `accepted`/`declined`/`pending`; `hold_submission` → back to `assigned`; `reject_assignment` → back to `pending_manager`), the `expire-reviews` cron (→ `returned_timeout`), manager/admin (`archive_submission`/`unarchive_submission`), admin/general_manager (`move_to_validation` releases a `parked` lead), data_uploader + manager (`start_lead_import` → `pending_import_approval`, then `approve_import_batch`/`reject_import_batch`).
- **Important timestamps:** `created_at`, `assigned_at`, `claimed_at`, `last_held_at`, `disposed_at` (added 2026-09-18, distinct from `created_at`), `archived_at`, `reopened_from_cx_at`, `draft_date`/`future_draft_date`. **Not captured:** first-contact time, any closer-side "worked this lead at X" timestamp, application-submitted-at as distinct from `created_at`.
- **Important monetary values: none.** No premium amount, no commission amount, no policy face value anywhere on `submissions` or any related table.
- **Important relationships:** `closer_id`→`profiles` (nullable — sheet leads have no closer), `assigned_to`→`profiles` (validator), `uploaded_by`→`profiles`, `import_id`→`lead_imports`, `final_carrier_id`→`carriers`, `center_id`/`center_name` (frozen snapshot, not a live join), `transfer_client_id`/`transfer_client_name` (External Transfer, added 2026-09-19).
- **Existing reporting:** period totals (live-only historically, corrected 2026-09-18 to count every origin — see `all_origin_totals` migration), per-center intake split (Live vs Manual), queue-flow stage counts, per-validator counts, accepted-only carrier/state/plan-type breakdown.
- **Missing reporting opportunities:** age-in-stage / SLA breach reporting (untouched leads, stale assignments), closer-level conversion funnel (submitted → accepted rate per closer, which `SalesBreakdown`'s leaderboard only partially covers), carrier decline-reason analytics beyond raw counts, and anything requiring dollar figures.

### Entity: CX Pipeline Membership (accepted leads, post-sale)

- **Current stages:** membership is boolean (`cx_pipeline_member()`), driven by `disposition='accepted'` OR a non-null `reopened_from_cx_at`; four independent status categories (policy/premium/commission/chargeback) each hold a value from `cx_status_options`, set via `set_cx_status`.
- **Who can change:** cxm/cxa (`set_cx_status`, `add_submission_tag`/`remove_submission_tag`); cxm/cxa (`remove_from_cx_pipeline`); admin only (`restore_to_cx_pipeline`); general_manager/admin (`return_lead_for_validation`, an explicit reopen distinct from any status change).
- **Important timestamps:** `cx_assigned_at`, `cx_removed_at`.
- **Important monetary values:** none — the "commission" and "premium" categories are status labels (e.g., presumably "paid"/"pending"-style options in `cx_status_options`), not amounts. This was not independently verified row-by-row in this pass since `cx_status_options`' actual label values weren't read, but no numeric/currency column exists on any CX table per `docs/database.md`.
- **Existing reporting:** `CxStatusBreakdown` (per-category counts across the 26 status options), `CxCoverageCard` (in-pipeline vs untouched count).
- **Missing reporting opportunities:** aging within a CX status (how long has a lead sat in "commission: pending"?), category-to-category transition tracking, and everything the Chargeback/Transfer/Analytics placeholders imply but don't yet do.

### Entity: Spreadsheet Import Batch

- **Current stages:** batch created (`start_lead_import`) → leads land as `pending_import_approval` → manager `approve_import_batch` (leads move into the normal queue) or `reject_import_batch`.
- **Who can change:** data_uploader creates; manager/admin approves or rejects.
- **Important timestamps:** `lead_imports.created_at`; no explicit "approved_at"/"rejected_at" column found — approval state is inferred client-side in `import-history.tsx` from the resulting leads' `status`/`archived_at`, not stored directly on the batch.
- **Existing reporting:** `ImportHistory` (per-batch counts, drill into leads), `PendingImports` (approval queue).
- **Missing reporting opportunities:** approval SLA (how long a batch sits in `pending_import_approval`), per-uploader data-quality trend (flag rate over time) — the raw flags exist (`data_flags` jsonb) but no rollup view exists yet.

---

## 3. ROLE ANALYSIS

| Role | Key decisions | Has today | Missing today | Immediate exceptions |
|---|---|---|---|---|
| **admin** | Everything; user/carrier/center admin; settings; exports | Full `ReportingDashboard`+`SubmissionsExplorer`, `AdminOverview`, `SalesBreakdown`, `Exports`, `SettingsAudit`/`CardAccessLog` (code exists, **UI unreachable** — tabs commented out) | Lifetime totals on Overview (commented out), server-side sales aggregation, any dollar-based report | The two unfixed RPC-auth bugs (NULL-role bypass on ~20 RPCs; `admin_settings`/`reporting_retention_status` confirmed reachable by `anon` live) |
| **general_manager** | Cross-center oversight of closer+validator leads; only non-admin role that can release a parked lead | `ClosingDesk`/`ClosingOverview` across all centers, both origins | No manager-comparison view (closing_manager vs closing_manager), no validator-stats-by-center (the RPC doesn't scope by center — see below) | `ClosingOverview` explicitly **disables** `validator_stats_range` for `closing_manager` (comment: RPC returns whole-business data ungated by center) but **general_manager legitimately wants that same figure and currently has no correctly-scoped way to get it either**, since the RPC itself isn't center-aware |
| **manager** | Assigns to validators; disposes; archives; approves imports | `ReportingDashboard` (own tab), full validation queue, `PendingImports`, `DraftDateDesk` | Per-validator SLA/aging view beyond raw counts, workload balancing view, stale-assignment alerting | None found beyond the shared RPC bugs above |
| **closing_manager** | Edits closer-originated leads in their own center; cannot set CX status | `ClosingDesk`/`ClosingOverview` scoped to own center | Any productivity/conversion comparison across their own closers (no closer-level dashboard on this screen) | `validator_stats_range` is explicitly hidden from this role in the UI (correctly, given the leak), so they see **less** than a general_manager on the same screen — a real, currently-accepted gap |
| **closer** | Submits leads; nothing else | Own Forwarded Leads + `closer_lead_alerts` badges | No visibility into own conversion rate, no acceptance-rate feedback loop | — |
| **validator** | Claims, disposes, holds, rejects assignments | Own queue only, countdown timer | No personal performance view (their own accept/decline/timeout rate over time — this is visible to managers via `validator_stats_range`, not to the validator themselves) | — |
| **data_uploader** | Imports leads | `ImportHistory` scoped to own batches | Own data-quality trend over time | — |
| **cxm / cxa** | Sets 4 CX status categories; tags; removes from pipeline | `CustomersPipeline`, `CxStatusBreakdown` | Chargeback/Transfer/Analytics tabs (placeholders); no aging-in-status report | — |

**Daily/weekly/monthly monitoring, by role — what's answerable today vs not:**
- Admin daily: queue depth, timeouts, rejections (**answerable** via `TotalsPanel`/`OverviewPanels`). Admin weekly/monthly: sales trend by carrier/state (**answerable but expensive** — `SalesBreakdown` pages all rows client-side). Admin: chargeback rate, commission volume, persistency (**not answerable — no data**).
- General manager daily: cross-center queue depth (**answerable**). Weekly: which center/closer is underperforming (**partially** — center split exists, closer-level comparison doesn't exist on this screen). Monthly: manager-vs-manager comparison (**not answerable — no such report exists at all**, since managers aren't scoped to a team/center themselves; there is currently no "manager" ↔ "team of closers" relationship in the schema).
- Manager daily: which leads are stuck, which validator is overloaded (**partially answerable** from the queue table by eye; no computed staleness/aging report exists).

---

## 4. CURRENT REPORTING CAPABILITIES & GAPS (summary before the report catalog)

**What's solid:** period-scoped counts (submitted/approved/declined/pending, live vs manual, per-center) are correctly computed server-side via `submission_totals_range`/`submission_totals_by_center_range`/`reporting_window`, and reused consistently by `ReportingStats`, `AdminOverview`, `ClosingOverview`. This is a good foundation — new reports should extend these RPCs rather than compute new client-side aggregates (the anti-pattern `SalesBreakdown` and `Exports` already exhibit, at 386-row and 500-row scale respectively, both flagged for cost/PII exposure in `docs/TODO.md`).

**What's structurally missing:**
1. No dollar figures anywhere (premium, commission) — the single biggest gap versus a typical insurance CRM report set.
2. No SLA/aging computation server-side — every "how long has this been stuck" question currently requires eyeballing a `created_at`/`assigned_at` column in a table, not a computed report.
3. No closer-to-manager or validator-to-manager organizational hierarchy in the schema — "my team's performance" isn't computable because "my team" isn't a modeled relationship. `closing_manager` is scoped by `center_id`, not by an owned set of closers; `manager` isn't scoped to anything (all managers see the same one queue).
4. `validator_stats_range()`'s center-blindness is both a security bug (confirmed leak to closing_manager) and a reporting gap (general_manager can't get a correctly center-split version either).

---

## 5. ADMIN REPORTING RECOMMENDATIONS

| # | Report | Purpose / Question | Data available? | Tables/Fields/RPCs | Filters/Dims | Metric/Formula | Viz | Granularity | Priority | Complexity |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | **Business Overview (restore lifetime totals)** | "How is the business doing right now, in total, not just this period?" | YES | `submission_totals_range` w/ all-time window (re-enable the commented-out `TotalsPanel` call in `admin-overview.tsx:57`) | none (lifetime) | Straight counts, no formula | Stat cards (existing `TotalsPanel`) | All-time | P0 | Trivial — uncomment + wire prop |
| A2 | **Server-side Sales Breakdown** | "By carrier / state / plan type, what have we sold, without shipping 400 rows of PII to every admin's browser?" | YES (data exists; aggregation doesn't) | New RPC `sales_breakdown_range(p_start,p_end)` grouping `submissions` by `final_carrier_id`/derived state/plan-type over `disposition='accepted'` | Period, carrier, state, plan type | `count(*)` per group, `% of total` | Existing `MetricBar` bars (already built) | Day/Week/Month | P0 | Medium — one SQL function, swap `SalesBreakdown`'s two client-side queries for it |
| A3 | **Closer Conversion Funnel** | "Which closers submit a lot but convert poorly?" | YES | `submissions` grouped by `closer_id`, `disposition`, `submitted_by_role<>'validator'` (extends `SalesBreakdown`'s existing leaderboard query) | Period, center | `accepted / (accepted+declined+pending)` per closer | Table, sortable, existing Top-Performer/Needs-Support cards extended | Week/Month | P1 | Low — extend existing query, add a rate column |
| A4 | **Validator Throughput & Timeout Rate** | "Which validators are slow or timing leads out?" | YES, but **must fix the center-leak bug first** if this is ever exposed below admin | `validator_stats_range` | Period | `timed_out / assigned`, `rejected / assigned` | Table (already exists, just add rate columns) | Week/Month | P1 | Low (once RPC is fixed) |
| A5 | **Carrier Decline Reason Report** | "Why are carriers declining our leads?" | YES | `carrier_declines`, `carrier_decline_stats` view (documented, not currently surfaced as a report anywhere) | Period, carrier | Count per decline reason | Table/bar | Week/Month | P2 | Low — a view already exists per `docs/database.md`; just needs a UI tab |
| A6 | **Data Quality / Flag Rate Trend** | "Is import quality getting better or worse?" | YES | `submissions.data_flags`, `lead_imports` | Period, uploader | flagged rows / total imported | Line/trend (would need a chart lib — see UX section) | Week/Month | P2 | Medium — needs a rollup, no existing view |
| A7 | **Import Approval SLA** | "How long do imported batches sit waiting on a manager?" | PARTIAL — no `approved_at` column exists; would infer from `form_events` | `lead_imports`, `submissions.status` transitions in `form_events` | Period, uploader | `first(status!=pending_import_approval).created_at - lead_imports.created_at` | Table | Week | P2 | Medium |
| A8 | **Chargeback / Commission / Premium reports** (as literally requested) | — | **NO — data does not exist** | none | — | — | — | — | N/A | Requires new schema (see Data Gaps §13) before this is a reporting task at all |

---

## 6. GENERAL MANAGER REPORTING RECOMMENDATIONS

`general_manager` already sees everything `closing_manager` sees, cross-center, per `docs/features/closing-desk.md`. The gap isn't visibility into leads — it's visibility into **people and centers as comparison units**, which no report currently does.

| # | Report | Purpose | Data available? | Tables/RPCs | Dims | Metric | Viz | Granularity | Priority | Complexity |
|---|---|---|---|---|---|---|---|---|---|---|
| G1 | **Center-vs-Center Production** | "Is UMS BPO or DESCOM converting better?" | YES | `submission_totals_by_center_range` (already computes this — just not rendered as a comparison, only as a side-by-side intake list in `OverviewPanels`) | Period, center | accepted/declined/pending per center, acceptance rate | Two-column comparison (extend existing `OverviewPanels` origin columns with a rate line) | Week/Month | P1 | Low — data's already fetched, just add a derived rate row |
| G2 | **Cross-Center Validator Load** (fix-then-build) | "Are validators overloaded, and does that vary by center?" | **NO — blocked** by `validator_stats_range`'s lack of center scoping (the same function `ClosingOverview` deliberately hides today) | Needs a new/fixed `validator_stats_by_center_range` | Period, center | assigned/timed_out/rejected per center | Table | Week/Month | P1 | Medium — requires the security fix from `docs/TODO.md` as a prerequisite; do not ship a GM-facing report on the current function |
| G3 | **Aging Leads Across Centers** | "Which center has the most stuck leads right now?" | PARTIAL — raw timestamps exist, no aging rollup | `submissions` (`created_at`,`assigned_at`,`claimed_at`) grouped by center | Center, stage | `now() - stage_entered_at` bucketed (0-1d/1-3d/3d+) | Stacked bar or table | Real-time snapshot | P1 | Medium — needs a new view, no existing one |
| G4 | **Parked / External Transfer Backlog** | "How many leads are sitting in External Transfer, by client?" | YES | `parked_client_counts()` RPC already exists (used only for filter chips in `parked-leads.tsx`, not surfaced as a standalone report) | Transfer client | count | Existing chip counts, promote to a small stat panel | Real-time | P2 | Trivial — reuse the existing RPC |
| G5 | **Manager-vs-Manager Comparison** | "Which manager's queue moves fastest?" | **NO** — `manager` role isn't scoped to any subset of leads or people; every manager works the same single queue | none | — | — | — | — | N/A | Requires a data-model decision (are managers meant to own a subset of the queue?) — flagged as a question, not assumed |

---

## 7. MANAGER REPORTING RECOMMENDATIONS

"Where are my team's problems and what should I do today?" — the manager already has the best-covered screen in the app (`docs/features/validation-queue.md` calls it "the reference implementation"). The gap here is turning the existing queue table into computed exception lists rather than something a manager has to scan by eye.

| # | Report | Purpose | Data available? | Tables/RPCs | Dims | Metric | Viz | Granularity | Priority | Complexity |
|---|---|---|---|---|---|---|---|---|---|---|
| M1 | **Untouched Leads (>X hours in pending_manager)** | "What have I not assigned yet?" | YES | `submissions.status='pending_manager'`, `created_at` | Age threshold | `now() - created_at` | Sort/filter on existing Live/Manual tab, add an age column + default sort | Real-time | P0 | Trivial — add a computed column + sort, no new query |
| M2 | **On-Hold Leads Exceeding Max Holds** | "Which leads have been held repeatedly and need my attention?" | YES | `submissions.hold_count`, `app_config` max-holds setting (already exists per `admin-settings-and-config.md`) | Threshold | `hold_count >= max_holds` | Highlight/badge on existing table row | Real-time | P1 | Trivial — client-side flag using data already fetched |
| M3 | **Validator Workload Balance** | "Is one validator sitting on 20 leads while another has 2?" | YES | `submissions.assigned_to` group count (client-computable from the existing manager query, or a small new RPC) | Validator | count of open assigned leads per validator | Small bar list next to the assign dropdown | Real-time | P1 | Low |
| M4 | **Rejected/Timed-Out Leads Needing Reassignment** | "What bounced back and needs a different validator?" | YES | `submissions.status IN (pending_manager) AND (rejection_count>0 OR last_timeout_by IS NOT NULL)` | — | count, list | Already partially visible via `QueueStatusBadge`'s "Rejected by {name}"/"Unsubmitted by {name}" labels — promote to a filterable view | Real-time | P1 | Trivial — filter, not a new query |
| M5 | **Pending Import Batches Aging** | "Which uploaded batches am I sitting on?" | YES | `pending_import_batches` view, `lead_imports.created_at` | Age | `now() - created_at` | Add age column to existing `PendingImports` list | Real-time | P2 | Trivial |
| M6 | **Daily Production Summary** | "What moved today?" | YES | `submission_totals_range` for a 1-day window | Day | today's accepted/declined/pending/timeouts | Existing `TotalsPanel` with a fixed "today" period preset | Daily | P2 | Trivial — add a "Today" chip to `PeriodPicker` |

---

## 8. KPI FRAMEWORK

| KPI | Definition | Formula | Source | Visible to | Period | Caveats |
|---|---|---|---|---|---|---|
| **Acceptance Rate** | Share of dispositioned leads that reach `accepted` | `approved_all / (approved_all + declined_all + pending_all)` | `submission_totals_range` (use the `_all` columns added 2026-09-18 — the older `approved`/`declined` columns are live-origin-only and will silently understate this if used by mistake, per the exact bug `f8699ec` fixed) | admin, manager, GM, closing_manager (own center) | Day/Week/Month | Recycled leads (declined→re-submitted) aren't deduplicated; a lead disposed twice (unlikely given `accepted` is terminal, but `declined`/`pending` can loop) is not double counted in totals since these are current-state counts, not funnel-event counts — but a *funnel* conversion metric computed differently could double-count if not careful |
| **Validator Timeout Rate** | Share of a validator's assigned leads that expire the review window | `timed_out / assigned` | `validator_stats_range` | manager, admin (GM/closing_manager **blocked pending the center-leak fix**) | Week/Month | Currently returns whole-business figures regardless of the caller's center scope — see §5/§6 fix prerequisite |
| **Untouched-Lead Count** | Leads sitting in `pending_manager` past a threshold | `count(status='pending_manager' AND now()-created_at > threshold)` | New computed field, no existing RPC | manager, admin | Real-time | Threshold is a judgment call (start with 4 business hours, per no SLA currently defined anywhere in code/docs) |
| **Import Data Quality Rate** | Share of imported leads with zero flags | `count(data_flags=[]) / count(*)` per batch | `submissions.data_flags`, `lead_imports` | admin, data_uploader (own batches) | Per batch / Week | A flag being "ignored" (`clear_data_flag` without a value change) still counts as resolved by this metric even though the underlying data wasn't fixed — this is a known, documented tension in `docs/features/*` (the "Ignore without fixing" action exists precisely because sometimes the flag is a false positive) |
| **Center Conversion Rate** | Acceptance rate scoped to one center | Same as Acceptance Rate, filtered by `center_id` | `submission_totals_by_center_range` | GM, closing_manager (own center), admin | Week/Month | `center_id`/`center_name` on `submissions` is a frozen snapshot at submission time — renaming a center later does not retroactively relabel historical rows (`docs/multi-tenancy.md`); a center comparison spanning a rename will show the old name for old rows |
| **Premium Volume / Commission Volume / Chargeback Rate** | — | — | **No data source exists** | — | — | Not computable until schema captures a monetary amount and a chargeback event — see Data Gaps |

---

## 9. AUTOMATION RECOMMENDATIONS

Kept deliberately short — the instructions warn against alert fatigue, and this app has zero business-event automation today, so even a small set is a big relative jump.

| Automation | Trigger | Conditions | Action | Recipient | Channel | Existing infra? | Priority | Complexity |
|---|---|---|---|---|---|---|---|---|
| **Stale unassigned lead nudge** | Lead stays `pending_manager` | age > 4 business hours (configurable, mirrors the existing `app_config`-driven settings pattern used for review timeout) | Surface in an in-app exception list (M1 above) first; email digest is a stretch goal, not v1 | manager | In-app (toast/list is enough for v1 — no email infra exists) | Partial — `app_config` pattern exists, no email/notification service exists | P0 | Low (in-app), Medium (email — needs new infra) |
| **Repeated-hold flag** | `hold_count >= max_holds` (setting already exists in `app_config`, currently only enforced as a hard block per `docs/features/admin-settings-and-config.md`) | — | Surface as a manager exception (M2) | manager | In-app | Yes — the config value already exists, just isn't surfaced as a report | P0 | Trivial |
| **Manager daily production summary** | Scheduled, end of day | — | Render the existing `TotalsPanel` for "today" (M6) — a real push/email digest would need new email infra | manager, admin | In-app now; email is a P2 stretch | Partial | P1 (in-app) / P2 (email) | Low (in-app) / Medium (email) |
| **Pending import batch aging alert** | Batch sits in `pending_import_approval` | age > 24h | Surface in `PendingImports` sorted by age (M5) | manager | In-app | Yes | P1 | Trivial |
| **Sheet-sync backlog alert** | `sheet_sync_backlog_status()` shows stuck rows | already computed, already has an admin-only card (`SheetSyncBacklogCard`) | Nothing new needed — this already exists; recommendation is to **not duplicate it** | admin | In-app (exists) | Yes, already built | — | Already done |
| **Validator workload rebalancing** | Manual bulk-assign is already non-atomic (client-side loop, per `docs/features/validation-queue.md`) | — | Show live per-validator open-count (M3) next to the assign control so a manager balances by eye — do **not** auto-assign; the workflow is explicitly manager-judgment-driven today | manager | In-app | Partial | P1 | Low |

Deliberately **not** recommended: automated lead reassignment, automated SLA escalation to a different role, or any automation that writes to `submissions` outside the existing RPC-gated mutation set — that would cut across the "RLS + RPC is the only write boundary" architecture decision (`docs/decisions/0001-rls-as-the-only-boundary.md`) and should not be introduced as an audit side-effect.

---

## 10. AI FEATURE RECOMMENDATIONS

### A. High value / practical (uses data already in the CRM, SQL/deterministic where possible)

- **Lead summary for validators** — a validator opening a claimed lead currently reads the raw `PayloadTable`. A short LLM-generated summary ("this lead: 62yo, TransAmerica proposed, 2 prior carrier declines for X/Y reasons") would speed review. **Needs:** the lead's payload + `carrier_declines` history, both already queried on that screen. **Doesn't need:** RAG or embeddings — it's a single-lead, single-call summarization of data already fetched client-side.
- **"What changed and why" explainer for the acceptance-rate metric** — when `SubmissionOutcome`/`TotalsPanel` numbers move, an admin currently has no explanation tool. A natural-language wrapper that runs the *existing* RPCs (`submission_totals_range` for two periods) and has an LLM narrate the diff is low-risk: the LLM never touches raw rows, only the two aggregate rows already computed server-side.

### B. Medium value

- **Manager daily briefing** — narrate the exception lists proposed in §9 (untouched leads, repeated holds, aging imports) into a short paragraph. Purely a presentation layer over data that will already exist as structured queries; no new data access needed once M1/M2/M5 exist.
- **Import flag triage assistant** — summarize a batch's flag patterns for the uploader ("14 rows had ambiguous MM/DD dates, 3 had a card number in the wrong column") instead of scrolling the grid row by row. Uses `data_flags` already computed by the deterministic `src/lib/normalize/` engine — the LLM only summarizes existing structured output, it does not re-do the normalization (which must stay deterministic per `docs/decisions/0003-deterministic-import-normalization.md` — that ADR explicitly forbids AI in that engine, and this audit agrees: don't touch it).

### C. Experimental / future — do not build yet

- **Natural-language ad-hoc reporting ("ask a question about the data")** — genuinely useful in principle, but given the current gaps (no premium/commission data, unfixed RPC auth bugs, no center-scoped validator stats), an NL query layer would either be too limited to be useful or would need to run arbitrary SQL against a schema that has known privilege-check holes. **Do this only after** the RPC auth fixes in `docs/TODO.md` land and a proper read-only, role-scoped query surface exists to hang it on.
- **Anomaly detection on KPI trends** — worth revisiting once there's more than one derived KPI series to watch; premature today given how few computed rollups exist.

**Explicitly rejected as not fitting this CRM:** an AI chatbot for its own sake, and any AI feature that would require ingesting customer PII (SSN, bank details, payload) into a third-party LLM call without a documented data-handling review — several payload fields are exactly the sensitive fields `CLAUDE.md` is strict about keeping out of unintended paths (payment data never in `payload`, card numbers never reaching most roles' browsers). Any AI feature that touches a lead's raw payload needs an explicit decision about which fields are safe to send to a model provider before implementation, not just a permissions check.

---

## 11. AI DATA / ARCHITECTURE NOTES (Phase 8, condensed)

For every AI feature above: prefer the existing RPCs for the actual numbers (deterministic, already correct, already RLS/role-scoped) and use the LLM only to *narrate* the RPC's output — never to compute the number itself. None of the High/Medium value features above need embeddings or RAG; they're single-call summarization/narration over data already fetched by an existing query on that screen. The one thing every AI feature would need that doesn't exist yet: a server-side boundary (an edge function, mirroring the existing `voice-clone-proxy` pattern for admin-gating) that (a) re-checks the caller's role exactly like every other RPC does, (b) decides which payload fields are allowed to leave the boundary to a model provider, and (c) logs the call the way `card_details` logs to `card_access_log` — an AI feature that reads a lead's payload with no log is a worse gap than the currently-known "Voice Clone Studio has no audit trail" limitation, not a better one.

---

## 12. ALERTS & EXCEPTION RECOMMENDATIONS

| Condition | Severity | Role | Notification | Suggested action |
|---|---|---|---|---|
| Lead in `pending_manager` > 4 business hours | WARNING | manager | In-app exception list (M1) | Assign to a validator |
| `hold_count >= max_holds` | WARNING | manager | In-app exception list (M2) | Manually resolve/reassign |
| Import batch in `pending_import_approval` > 24h | WARNING | manager | In-app exception list (M5) | Approve or reject the batch |
| RPC auth-guard bug (`my_role() <> 'admin'` pattern) reachable by `anon` | CRITICAL | admin/eng | This is a code-fix item, not a CRM feature — surfaced here because it's the single most urgent "exception" this audit found | Fix per `docs/TODO.md`'s existing, already-diagnosed list of ~20 functions |
| `validator_stats_range` cross-center leak | CRITICAL | admin/eng | Same — code-fix item | Add center scoping before any GM/manager report is built on it (blocks §6 G2) |
| Sheet-sync backlog stuck rows | WARNING | admin | Already surfaced (`SheetSyncBacklogCard`) | No new work — already done |

Deliberately not recommended: "unusual activity pattern" or generic anomaly alerts — with as few computed rollups as currently exist, a generic anomaly detector would have almost nothing to compare against and would be pure alert-fatigue risk.

---

## 13. DATA MODEL GAPS

| Missing field/event | Why it matters | Where it'd live | Reports/automations needing it | Priority |
|---|---|---|---|---|
| **Premium amount** | Underlies premium volume, commission, most classic insurance KPIs | New column on `submissions` or a linked table, written via a new RPC (not a direct write, consistent with the RLS-as-boundary decision) | A1 (partially), all commission/premium reports, KPI framework's blocked rows | P0 if the business wants these reports at all — otherwise this audit doesn't invent a reason to add it |
| **Commission amount + status** | Same | Same, needs a real `commissions`-shaped table if commission has its own lifecycle (paid/pending/charged back) distinct from the CX pipeline's categorical status | Admin/GM commission reports | P0 if needed |
| **Chargeback event** (amount, date, reason) | The CX "Chargeback" tab is currently a placeholder with nothing behind it | New table, since a chargeback is an event, not a status | Any chargeback report at all | P1 — only after the CX Chargeback tab itself is prioritized as a feature, which is outside this audit's scope |
| **`stage_entered_at` per status** or a status-history table | Needed for aging/SLA reports (M1, M3, G3) without recomputing from `form_events` each time | Either a lightweight `status_history` table or accept computing from existing `assigned_at`/`claimed_at`/`created_at` (sufficient for v1 — see complexity notes above, most P0/P1 aging reports don't actually need a new table) | M1, M3, G3 | P1 for the table; P0 items above work without it using existing timestamps |
| **`import_batches.approved_at`/`rejected_at`** | A7's approval SLA currently must be inferred from `form_events`, which is fragile | `lead_imports` table | A7 | P2 |
| **Manager↔team ownership** (which closers/validators does a manager manage) | Blocks any "my team" report for `manager` (G5) | Would need a real decision about whether managers own a subset of the queue — not assumed here | G5 | P3 — flagged as an open business-model question, not a code gap |

---

## 14. SECURITY / TENANT CONSIDERATIONS

This is explicitly **not a multi-tenant application** (`docs/multi-tenancy.md`'s own words) — one Supabase project, no `tenant_id`. The only isolation mechanism is `centers` (2 rows), scoping exactly one role (`closing_manager`) via `profiles.center_id` = `submissions.center_id`. Every reporting recommendation above that touches `closing_manager` inherits that scoping automatically through RLS — the audit did not find a report design in this document that would require a new tenant-boundary concept.

Two concrete, already-diagnosed cross-scope leak risks must gate any new reporting work:
1. **~20 RPCs with the NULL-role bypass bug** (`docs/TODO.md`) — any new report built as a new RPC must use `my_role() IS DISTINCT FROM 'admin'` (or the appropriate role list), never `<>`/`NOT IN`, per `CLAUDE.md`'s own stated rule, which this audit fully endorses and treats as non-negotiable for every RPC recommended above.
2. **`validator_stats_range()`'s center blindness** — explicitly named as a blocker for G2 above; do not build a GM/manager-facing report on this function until it's fixed.

No other cross-tenant/cross-scope leak was found in the reporting surfaces read for this audit (`ReportingDashboard`, `AdminOverview`, `ClosingOverview`, `SalesBreakdown`, `Exports` all filter through role-appropriate RLS-backed queries or already-scoped RPCs). `Exports` and `SalesBreakdown` both pull full lead payloads (potentially including sensitive fields) to the browser at 500-row/386-row scale respectively — not a cross-tenant leak (admin-only), but worth noting as the same PII-exposure pattern `docs/TODO.md` already flags for `SalesBreakdown`, and a reason to keep any future AI feature (§10/§11) from reusing that same wide `select("*")` pattern.

---

## 15. IMPLEMENTATION PRIORITY

| Priority | Feature | Role | Type | Data available? | Complexity | Recommendation |
|---|---|---|---|---|---|---|
| P0 | Fix ~20 RPC NULL-role auth bugs | eng | Security | n/a | Low (mechanical, per `docs/TODO.md`'s own list) | Do this before anything else in this document |
| P0 | Fix `validator_stats_range` center leak | eng | Security | n/a | Medium | Prerequisite for G2 |
| P0 | Restore lifetime `TotalsPanel` on Admin Overview (A1) | admin | Report | Yes | Trivial | Ship immediately |
| P0 | Untouched-lead / repeated-hold exception lists (M1, M2) | manager | Report | Yes | Trivial–Low | Highest daily operational value for lowest cost |
| P1 | Server-side `sales_breakdown_range` RPC (A2) | admin | Report/perf | Yes | Medium | Fixes a real cost/PII problem already flagged in `docs/TODO.md` |
| P1 | Closer conversion funnel (A3) | admin | Report | Yes | Low | |
| P1 | Center-vs-center production comparison (G1) | GM | Report | Yes | Low | |
| P1 | Validator workload/aging views (M3, M5) | manager | Report | Yes | Low | |
| P2 | Carrier decline reason report (A5) | admin | Report | Yes | Low | |
| P2 | Manager daily production summary, in-app (M6) | manager | Report | Yes | Low | |
| P2 | AI lead summary for validators, AI KPI-diff narration | validator/admin | AI | Yes (existing data) | Medium | Only after a logged, role-checked AI boundary function exists |
| P3 | Premium/commission/chargeback reporting | admin | Report | **No — schema gap** | High | Requires a prior product decision to capture monetary data at all |
| P3 | Manager↔team ownership model + manager comparison (G5) | GM | Report | **No — schema gap** | High | Open business-model question, not a code task |

### PHASE 1 — QUICK WINS (existing data + architecture, ship first)
Restore Admin lifetime totals (A1) · Untouched-lead & repeated-hold exception lists (M1/M2) · Reject/timeout reassignment filter (M4) · Pending-import aging (M5) · Parked/transfer backlog panel (G4) · Manager daily "Today" totals (M6).

### PHASE 2 — HIGH VALUE (needs backend work, no new subsystems)
Fix the two RPC security bugs (prerequisite, not optional) · `sales_breakdown_range` RPC replacing client-side aggregation (A2) · Closer conversion funnel (A3) · Center-vs-center comparison (G1) · Validator workload/aging views (M3/G3) · Carrier decline report (A5).

### PHASE 3 — ADVANCED (new capability, do last)
AI lead-summary and KPI-narration features behind a new logged/role-checked edge function (§10/§11) · Any premium/commission/chargeback schema work, only after a product decision to capture that data · Manager-team ownership model, only after a product decision on what "my team" means for the `manager` role.

---

## TOP 10 RECOMMENDED FEATURES

1. **Fix the ~20 RPC NULL-role auth bugs** — already fully diagnosed in `docs/TODO.md`; the single highest-value, lowest-effort item in this entire audit, and a prerequisite for #4.
2. **Fix `validator_stats_range()`'s center-scoping leak** — required before any General Manager/manager validator-performance report can be trusted.
3. **Untouched-lead and repeated-hold exception lists for managers** (M1/M2) — highest daily operational value, buildable entirely from data already fetched by the existing manager queue query.
4. **Server-side `sales_breakdown_range` RPC** — replaces a documented, already-flagged client-side PII/performance problem in `SalesBreakdown` with the same pattern the rest of reporting already uses correctly.
5. **Restore the Admin Overview lifetime totals strip** (A1) — one line of code (uncomment + wire), currently missing for no functional reason.
6. **Closer conversion funnel / leaderboard extension** (A3) — extends an existing query with one derived rate column.
7. **Center-vs-center production comparison for General Managers** (G1) — the data (`submission_totals_by_center_range`) is already fetched; this is a display/derivation addition, not a new data path.
8. **Validator workload balance view next to the manager's assign control** (M3) — directly supports the manual-assignment workflow that already exists, without introducing auto-assignment.
9. **AI lead summary for validators**, gated behind a new logged/role-checked edge function mirroring the `voice-clone-proxy` access-control pattern — the first genuinely useful AI feature, deferred until items 1–2 are fixed since it would otherwise sit on top of the same unresolved auth gaps.
10. **A product decision on capturing premium/commission data** — not a build item, but the prerequisite decision this audit surfaces: without it, roughly a third of the reports requested in the original brief (premium volume, commission volume, chargeback trends, net revenue) will remain out of reach regardless of engineering effort.
