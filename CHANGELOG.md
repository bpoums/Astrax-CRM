# Changelog

## 2026-09-17 - Sheets sync backlog card, and the view it reads stops leaking to anon

ADR 0006 said plainly that the admin card was "not optional decoration": the
queue's whole design is that a failed write accumulates instead of vanishing,
which is only an improvement if somebody sees it. It was never built, so the
queue was unwatched - and it currently holds **13 rows, 8 attempts each, 1.6h
old**, all failing with the same Apps Script permission error. Nothing in the
app said so.

`SheetSyncBacklogCard` now sits on the admin Overview tab: queued, in flight,
how many are failing, age of the oldest, and the Apps Script error verbatim.
It reads destructive when anything has failed 5+ times **or** the oldest item
is over 10 minutes old - a large queue that is moving is a busy morning, a
small one that is not is a fault, and a count alone cannot tell those apart.
Read-only: the cron drains every 60s and retries with backoff, so a button
would mostly duplicate that.

**Two security bugs found while building it, both of which fail open while
looking like a working guard.**

*The view was readable by `anon`.* `sheet_sync_queue` has RLS enabled with zero
policies so the client cannot reach it - but `sheet_sync_backlog` is a view
over it that does not set `security_invoker`, so it runs as its owner and
bypasses RLS, and Supabase's default grants gave `SELECT` to `anon` and
`authenticated`. Verified with no JWT at all:

| as | `sheet_sync_queue` | `sheet_sync_backlog` |
|---|---|---|
| `anon` | 0 rows (RLS holds) | **`queued = 13`** |

Both grants revoked; the view is SQL/ops-only. The admin reaches the numbers
through `sheet_sync_backlog_status()`, a `SECURITY DEFINER` RPC that re-checks
the caller's role - the pattern ADR 0001 requires.

*`my_role() <> 'admin'` is not a guard.* `my_role()` returns NULL for a caller
with no profile, no JWT, or an **inactive** profile, and `NULL <> 'admin'` is
NULL rather than true - so the `IF` never fires and the function returns its
data. The first version of this RPC had it, copied from the existing house
style, and returned the backlog to a caller with no JWT. Fixed to
`is distinct from`. Also: `revoke ... from public` does not remove `anon`'s
EXECUTE, because Supabase grants it to `anon` directly - the role must be named.

**~20 pre-existing RPCs share the second bug and are NOT fixed here**, including
`admin_settings` and `reporting_retention_status`, both confirmed returning
data to `anon` with no JWT. Several are writes (`archive_submission`,
`assign_to_validator`, `set_admin_setting`, `approve_import_batch`). This also
contradicts `CLAUDE.md`'s claim that deactivating a profile cascades through
"every policy and every RPC" - it cascades through every policy, because RLS
compares with `=`, but not through these. Catalogued in the new `docs/TODO.md`
and corrected in `CLAUDE.md`; fixing them is its own change.

- `supabase/migrations/20260917130000_sheet_sync_backlog_admin_only.sql`
- `src/components/sheet-sync-backlog.tsx` (new), mounted in `admin.tsx`
- `src/integrations/supabase/types.ts` (regenerated)
- `docs/features/sheet-sync.md` (new), `docs/TODO.md` (new), `docs/database.md`,
  `docs/decisions/0006-...md`, `CLAUDE.md`

## 2026-09-17 - RLS policies stop re-evaluating my_role() once per row

The app had been getting slower as the database grew, and cloud Supabase was
the suspected cause. It was not. The database is **27 MB / 633 submissions** -
small enough to sit entirely in cache - and on the manager queue query the
index scan took **0.058 ms** while the whole query took **14.8 ms**. Finding
the rows was free; **~99% of the time was the RLS filter**. Self-hosting would
have moved the same policy onto a slower machine behind a worse network path
and fixed nothing.

The cause: policies called `my_role()` bare, so Postgres evaluated it **once
per candidate row**. `my_role()` is `SECURITY DEFINER` and runs
`select role from profiles where id = auth.uid() and active`, so every row
scanned cost a `profiles` lookup plus a JWT parse. Being `STABLE` *permits*
hoisting but does not force it - Postgres will not hoist a function call
inside a `CASE` in a filter expression.

Proven by A/B on the same query and rows, changing one call site only:

| predicate | execution |
|---|---|
| `case my_role() ...` | 8.46 ms |
| `case (select my_role()) ...` | 5.17 ms |

**~6 us per row per call site**, linear in table size - which is exactly the
reported symptom. At 633 rows that is ~4 ms per call site; at 60,000 it is
~360 ms, and there were 20 call sites.

All 20 policies across 15 tables were recreated with each bare `my_role()` and
`auth.uid()` wrapped as a scalar subquery, which forces a single InitPlan
evaluation. Nothing else in any predicate changed. The plan now reads
`CASE (InitPlan 1).col1` with `loops=1`.

| query | before | after |
|---|---|---|
| manager queue (`pending_manager`, 50) | 14.78 ms | **1.32 ms** |
| manager `count(submissions)` | - | 2.74 ms |
| manager `count(form_events)` (3,555 rows) | - | 1.59 ms |
| closing_manager `count(submissions)` | - | 1.24 ms |
| general_manager `count(submissions)` | - | 0.99 ms |

**Verification, because this is the security boundary.** Before applying, a
role x table matrix recorded the visible row count for **every one of the 58
profiles** against all 19 RLS-protected tables - not one representative per
role, so per-user scoping like `closing_manager`'s centre was covered too. The
same matrix was recaptured afterwards and compared in SQL: **1,121 cells, 0
differing.** The matrix is discriminating rather than uniformly zero (admin
633, manager 622, general_manager 546, cxa 413, closing_manager 47,
closer/validator/anon 0, `data_uploader` 0-26 varying per user), so an
unchanged result is evidence and not an artefact. Writes were checked
separately, since the matrix only covers reads: admin updates `profiles` (1
row), a closer cannot (0 rows), a closer insert into `carriers` raises, and no
test value leaked. `auth_rls_initplan` is gone from the advisor and no new
security finding appeared.

**Deliberately not done**, and worth knowing why: the advisor's 21 "unindexed
foreign keys" were left alone - `submissions` already carries 17 indexes
covering every column the app filters on, and the flagged columns
(`archived_by`, `disposed_by`, `last_timeout_by`, ...) are only read through
embedded profile joins that resolve against `profiles.id`, already the primary
key. Twenty-one more indexes would add write cost on every insert for no
measurable read gain. The 25 "multiple permissive policies" findings were also
left: real, but on single-digit-row vocabulary tables, and merging two policies
into one is a genuine change to the boundary rather than a timing fix - the
wrong thing to bundle into a performance pass.

Also corrected in `docs/database.md`: the zero-policy table list named only
`app_config` and `payment_details`; `sheet_sync_attempts` and
`sheet_sync_queue` are also zero-policy, confirmed live.

- `supabase/migrations/20260917120000_rls_initplan_wrap_role_checks.sql`
- `docs/database.md` (Row-Level Security summary)

No application code changed - this is invisible to the client.

## 2026-09-17 - Sheets sync moved to a durable queue; leads can no longer be dropped

Fire-on-trigger sync could not survive concurrency, and it was losing leads.
Measured on this project, firing N syncs at once failed ~20% of the time at
N=5, ~30% at N=20 and **~61% at N=59** - Google rejects concurrent requests to
an Apps Script web app (as 404s, or as HTTP 200 carrying an HTML error page),
and the script serialises itself on a 30-second LockService lock regardless.
**Thirteen leads had never reached Sheets at all, four of them completed
sales.** With ~100 closers and validators submitting at once this becomes
routine data loss.

The old retry made it worse rather than better: it abandoned a row permanently
after 3 attempts (`gave_up`, surfaced to nobody), and it retried by looping
over every pending attempt firing each one - recreating the very burst that
caused the failure. `pg_net` batches its dispatch, so this could not be paced
from SQL; `pg_sleep` between calls does nothing, because the worker collects
whatever is queued and fires it together.

`notify_sheet_sync()` now enqueues into `sheet_sync_queue` instead of making an
HTTP call. Every guard about *whether* to sync is unchanged. The queue is keyed
by `submission_id`, which is load-bearing: a lead whose status changes four
times before the drain runs collapses into one row and one write carrying the
final state.

`drain_sheet_sync_queue()` sends up to 25 rows as **one** request rather than
25, and `sheet-sync` v13 walks a batch **sequentially**, so Apps Script only
ever sees one request at a time - the fix for the concurrency failure, achieved
without touching the Apps Script, whose deployment we do not own.
`resolve_sheet_syncs()` reads per-row results back, so one bad row in a batch
retries one row rather than 25, and **a row is only ever deleted on confirmed
success**; anything else backs off exponentially (30s, 1m, 2m ... capped at 1h)
and is never abandoned. `sheet_sync_backlog` exposes queue depth and age.

A follow-up migration (`20260917110000`) stops the drain starting a second
batch while one is in flight. The first live burst showed a 25-row batch
outrunning the 60-second cron interval, so two batches overlapped and six rows
came back with the same concurrency error the design exists to remove. They
were retried and delivered rather than lost - which was the point - but the
overlap is now prevented outright.

Verified on rollout: a 60-lead burst, the scenario that previously lost ~60%,
drained to zero with no permanent failures. The only rows left queued are the
13 blocked on the **Astrax Uploader Feed** permission error, which is an Apps
Script access problem for its owner to fix - they now retry safely until then
instead of being dropped.

## 2026-09-16 — The manager can see why CX sent a lead back, read its history, and find it

**No database change.** Three gaps on the Operations queue, all reported from
the floor.

- **The CXA's return reason now reaches the manager.** It was never lost —
  `return_lead_for_validation` writes it as the `reopened_from_cx` event's
  `detail->>'reason'` — but nothing on the manager's screen read it. The queue
  now batches those events for its returned rows (newest per lead, since a lead
  can make the round trip more than once) and shows the reason in a clamped
  **Reason** column on the CXA Returned tab, with the whole of it on hover, and
  in full in a "Returned by CX" block at the top of the detail sheet.
- **View History** in the detail sheet, mounting the same `LeadHistoryDialog`
  the closing desk, the CX pipeline, the draft-date desk and reporting already
  use: the validation passes and the customer lifecycle, each at the dialog's
  full width. The manager queue was the one lead screen without it.
- **Search**, beside the tab list, matching the customer's name. The queue
  already holds every open row, so this filters what is loaded rather than
  querying — unlike the paged tables, which must search server-side. It narrows
  **only the open tab**; the other tabs keep whole counts, so a term that
  matches nothing on Live does not imply the lead does not exist. Changing the
  term clears any pending bulk selection, exactly as changing tab does.

Also worded `cx_removed` / `cx_restored` in `event-labels.ts` — they shipped
with the CX queue work earlier today and were falling through to the generic
humanizer ("Cx removed") in the very timeline this change puts in front of a
manager.

## 2026-09-16 — The CX queue keeps its leads: retention, removal and editing

**Migration `20260916140000_cx_queue_retention.sql`.** Pressing **Return For
Validation** used to delete the lead from the CXA's own screen. The pipeline was
defined as `disposition = 'accepted'`, and returning a lead clears the
disposition — so the CXA lost sight of the lead at the moment they were waiting
on an answer about it.

Membership of the pipeline is now "a lead CX has not finished with":
non-archived, not CX-removed, and either accepted **or** carrying
`reopened_from_cx_at`. It is spelled once as `cx_pipeline_member(p_sub)`, which
every CX RPC guards on, and inline in the `cxa`/`cxm` branches of the
`submissions` RLS policy (a policy on `submissions` cannot call a function that
reads `submissions`). `cx_pipeline` follows the same rule and now carries
`status`, `disposition` and `reopened_from_cx_at`.

- **A returned lead stays put**, marked "In Validation" where the Return button
  was, with its four CX statuses still editable. `return_lead_for_validation`
  keeps its strict `disposition = 'accepted'` guard, so a second send is refused
  server-side and not merely hidden.
- **`remove_from_cx_pipeline(p_sub, p_reason?)`** (cxa/cxm/admin) is the only
  thing that takes a lead off the queue. It is not an archive: reporting,
  exports, the manager's queue, the sheet and the lead's own history are
  untouched, and it changes none of the columns `notify_sheet_sync()` watches,
  so no Sheets write fires. **`restore_to_cx_pipeline(p_sub)`** (admin) undoes
  it, from the new `RemovedFromPipeline` panel on the admin's Pipeline tab.
- **A CXA can correct the lead they are servicing.** The detail sheet mounts the
  same `LeadPayload` editor a manager uses (per-field `update_payload_field`,
  one `payload_edits` before/after row each) and an editable `PaymentPanel` for
  the four bank-draft fields. `update_payload_field` and `update_payment_field`
  gained `cxa`/`cxm`, scoped by `cx_pipeline_member` to their own queue. The
  card-credentials check was not touched — the same line that refuses a manager
  refuses a CXA, and no CX screen renders a card number or CVV input.

Applying this brought 39 previously-returned leads back onto the queue; they
already carried `reopened_from_cx_at`. See
[decisions/0005](docs/decisions/0005-cx-queue-retention-and-removal.md).

## 2026-09-16 — Merged 74 legacy validator re-types back onto the closer's row

**Data repair, no code change.** Before 2026-09-07 a validator had no way to
record the carrier that actually wrote a policy, nor the agent name or policy
number, on a closer's lead. When a closer forwarded a lead proposed for one
carrier and a different carrier accepted it, the validator re-typed the entire
lead through "New Submission" with the correct details — one real sale,
recorded twice. `set_validator_fields` ended the practice.

The data dates the cutover precisely: closer leads carrying a `final_carrier_id`
go from 0–1/day before 09/05 to 4–18/day from 09/07, and no closer lead since
09/05 shares an SSN *or a name* with a validator submission. The last re-typed
pair is 09/04.

Matching on `ssn_normalized` found 74 such pairs. The two halves are
complementary — the closer row has the attribution and the proposed carrier, the
validator copy has the true carrier (`payload['Agency']`), policy number and
agent name — so `20260916100000` keeps the **closer's** row (attribution drives
commission and the leaderboard) and lifts everything the copy knows onto it:
the three columns, plus every payload key the validator filled and the closer
left empty. Gap-fill only; nothing entered by a closer was overwritten.
Result: final carrier / agent / policy 5 → 74, future draft date 0 → 54, and
245 further payload fields recovered (email address on 53, bank type on 23,
card details where present). Verified afterwards that no closer row gained
`Agency` / `Agent Name` / `Policy Number` as payload keys — `Agency` especially
would have been read by `CARRIER_KEYS` and rendered as the proposal.

`20260916110000` then archives the 74 consumed copies — archived, not deleted,
so they stay readable under the admin panel's "Show archived" and restorable.
It mirrors `archive_submission()` (same cleared assignment fields, same
`form_events` entry) so they look like any other archived lead;
`archived_by`/`actor_id` are null because no person performed it, with the
reason string carrying the audit trail.

Accepted rows for 25 Aug – 4 Sep fall from **256 to 190** against 184 real
sales — a 39% overstatement reduced to 3%.

**Two rows deliberately left active.** Elizabeth Holmander and Tommy L Davis
each had a *second* validator submission under a different carrier, policy
number and premium — genuine second policies, not duplicates. The merge only
ever consumed the earliest copy per customer, so archiving all 76 would have
erased two real sales.

Both migrations disable `sheet_sync_on_closed` for their duration: 74
simultaneous `net.http_post` calls overrun the Apps Script 30-second lock. **The
Google Sheet therefore still shows all 74 as live** — the sync has no delete
path, so a row leaving the database never leaves the spreadsheet on its own.

## 2026-09-15 — Closing desk can filter by submitted date

The desk could be narrowed by search, origin, status, disposition, centre and
four CX categories, but not by date — a closing manager working a day's book
had to page through everything. Adds a From/To pair over `created_at`, the
date the "Submitted" column already draws, for both roles that reach the
screen (`closing_manager` and `general_manager`). A blank "To" filters exactly
the single day in "From", and the pair composes with every other filter rather
than replacing them.

Boundaries come from the existing `reporting_window` RPC rather than browser
date maths, for two reasons. A Pacific calendar day is not a UTC day and the
gap is real, not theoretical: for 2026-09-14 the Pacific window holds 27
closer leads where a naive `created_at::date` comparison holds 25. And reusing
the RPC is what keeps a "today" here meaning the same day as a "today" in
Reporting, instead of two screens quietly disagreeing about midnight.

No new access: `reporting_window` is already granted to `authenticated`, is
not `SECURITY DEFINER`, and takes no submission id while returning only
`{since, until}`. The rows stay scoped by the `submissions` RLS policy, so the
filter only ever narrows — a closing manager filtering by date still sees only
their own centre. `created_at` was already in the query's select, so nothing
about what the database returns changed either.

Also worth knowing, unchanged here: `DraftDateDesk` is mounted only for admin
and manager, so closing and general managers still have no draft-date view.

## 2026-09-15 — Parked Leads gets the detail panel it never had

A parked ("External Transfer") lead could be seen in the table but not opened,
so the decision to release it into validation was made against a customer name
and a date. This was not a broken panel: `ParkedLeads` had no `openId` state,
no `Sheet` and no click handler on its rows. It was never built.

Rows are now clickable and open a `Sheet` rendering `PayloadTable` — the same
component every other detail view uses, so a parked lead reads identically
here and in Reporting. No query changed: `payload` was already in the
component's `SELECT` and was simply never rendered, which also means no change
to what the database returns or to any RLS surface. An admin could already
read all six parked leads in Reporting → Submissions; this puts the same thing
one click from where the decision is made, for both roles that can act on it
(admin, and general_manager at `/closing?tab=parked`).

"Move to Validation" now appears inside the panel as well as on the row, both
driven by the one existing mutation. The row's button stops event propagation
so it does not also open the panel, and a successful move closes the panel —
the lead leaves the list at that moment and the panel would otherwise sit over
a row that no longer exists.

Recorded as a known limitation rather than changed here: a parked lead's
payload renders unmasked, banking fields included, because the closer form
writes `Routing Number` / `Account Number` / `Card Number` / `Exp Date` / `CVC`
straight into `payload` and `PayloadTable` masks none of them. That is
pre-existing and applies equally to Reporting, the manager queue and the
customers pipeline. See `docs/features/closing-desk.md`.

## 2026-09-15 — sheet-sync no longer reports failed Google Sheets writes as successes

Uploaded leads were reaching Google Sheets' door and being turned away, with
every layer reporting success. Diagnosed from the edge function logs: Apps
Script was throwing

> `Exception: リクエストされたドキュメントにアクセスする権限がありません。（行 26、ファイル「Code」）`
> — *"You do not have permission to access the requested document"*

on line 26, `SpreadsheetApp.openById(sheetId)`. The routing was correct (the
log line reads `synced … uploaded …`), but the Apps Script project has no
access to the **Astrax Uploader Feed** spreadsheet. That part is a Google
permissions fix, outside this repo.

What *was* ours: an Apps Script web app answers **200 even when `doPost`
threw**, returning its HTML error page instead of the `'ok'` the handler sends
on success. `sheet-sync` only checked `res.ok`, so every exception was logged
as a synced row, recorded `resolved_status = 'ok'` in `sheet_sync_attempts`,
and gave `retry_failed_sheet_syncs` nothing to retry. Sync could fail
indefinitely with no signal anywhere.

**sheet-sync v12** adds `appsScriptFailure()`, which inspects the body for the
three failure shapes that arrive as 200 — an HTML error page, any `Exception:`
text, or the literal `unauthorized` on a secret mismatch — and returns 502 so
the attempt is recorded truthfully and retried. It also logs just the extracted
`Exception:` line rather than ~8KB of Google's CSP shim. Verified against the
still-failing lead: the sync now returns `502 apps script error` where it
previously returned `200 {"ok":true}`.

Separately worth knowing: an uploaded lead does not sync at all until its
import batch is approved — `notify_sheet_sync()` returns early while
`source = 'sheet' and status = 'pending_import_approval'`. That is by design,
not a fault, but it means a freshly uploaded lead is legitimately absent from
the Sheet until a manager accepts the batch.

## 2026-09-15 — Proposed Carrier vs Final Carrier, split apart

Two different facts had been sharing one name. What a closer types is the
carrier they *pitched*; what the policy is actually written on is the
validator's `final_carrier_id`. Both surfaced as "Carrier Name", so reporting
could not tell the two apart — and on 80 live leads they genuinely differ
(pitched "American Amicable", written TransAmerica).

The closer form's field is now **Proposed Carrier**. Because a closer-form
label is simultaneously the payload key, the Google Sheet column header and
the spreadsheet-import target, that one rename moved all three; migration
`20260915120000` brought the 285 pre-existing rows onto the new key, with the
sheet-sync UPDATE trigger disabled so the statement could not fire ~285
`net.http_post` calls at once. It is idempotent (`where payload ? 'Carrier
Name'`) and worth re-running after the front-end deploy to sweep up anything
the old bundle wrote in between. The Sheet's own header cell is renamed by
hand, which keeps the existing column and its history.

The conflict between the two forms resolves as a lifecycle, not a collision —
a validator submission simply has no proposal stage, because that form is only
filed once the carrier has accepted:

- **Proposed Carrier** — `payload['Proposed Carrier']`, closer/uploaded only.
- **Final Carrier** — `final_carrier_id` -> `carriers.name`, or `Agency` for a
  validator's own submission, or null when not yet determined. Read through
  the new `finalCarrierName()` in `ops.tsx`; `PAYLOAD_LABEL` now relabels
  `Agency` as "Final Carrier", which is what it always meant.

Reporting gains **two carrier boxes** instead of one. Each is its own
PostgREST `or` group and repeated groups AND together, so filling both asks
for the intersection — "pitched Amicable, written on TransAmerica" (8 leads)
is now directly askable, which one combined box could not express. The Final
box spans both storage shapes, resolving typed text to carrier ids via the new
`matchingCarrierIds()` because the column holds a uuid.

Also fixed: the Sheet's `Final Carrier` column was blank on all 260 validator
rows, since it was resolved only from `final_carrier_id`. Migration
`20260915121000` falls back to `Agency` for those, gated on the role so a mere
proposal is never reported as an issued policy.

## 2026-09-15 — Reporting: Live/Manual chips replace Closer/Validator/Manual

The Submissions explorer (shared by admin → Submissions and the manager's
Reporting tab) split leads across three chips. The business categorises them
as two: a closer's phone lead is *Live*; a validator's own submission and an
uploaded lead are both *Manual*. So "Closer Submissions" is now "Live
Submissions", and the Validator and Manual chips are one.

Merging the two tables meant resolving two columns that would otherwise have
changed meaning depending on which kind of row you were looking at:

- **Source** said "Manual" for both kinds (`sourceLabel()` maps a validator
  submission and a sheet upload to the same word), so inside a tab already
  named Manual it said nothing — and the reader lost the one thing the tab
  split gave them for free. Replaced by **Type** (Validator / Upload).
- **Validator** meant the *author* on the old Validator tab but the
  *assignee* on the Manual tab. Split into **Submitted By** (the uploading
  centre, or the validator themselves) and **Validated By** (a dash on a
  validator row, which is the fact: it auto-accepts on submit and is never
  assigned to anyone).

Validation Status and Disposition were kept and show their real stored values
on validator rows — "Completed"/"Submit", constant but true, and consistent
with what the row's own detail sheet shows. The Manual selection is spelled
once in `applyManualTabFilter()` since the paged fetch and the chip's
head-count both use it and must agree. Searching "manual" or "validator" now
also matches validator submissions, which are stored `source='live'`.

Not changed: the Overview stat strip still reads Closer/Manual/Validator —
those are `submission_totals` view columns, and merging them properly needs a
view migration rather than a client-side sum. A known inconsistency, left for
a follow-up.

## 2026-09-15 — Validators get a real Center field in Users, not a dash

An admin had set every validator's `center_id` to UMS BPO directly (already
correct live), but the Users tab still showed a plain "—" for every
validator's Center cell, because `CENTER_ROLES` in `src/lib/centers.ts` only
listed `closer`, `closing_manager`, and `data_uploader` — the roles a center
is actually read for server-side. Added `validator` to that list: it's
tracked as roster information only (nothing server-side reads it, unlike
`closing_manager`'s queue-scoping use), but is now visible and editable in
the Users table and required (with the same real dropdown data_uploader
already used, in place of the old free-text "Center / Organisation" box)
when inviting a new validator.

## 2026-09-14 — Manager Operations gets a dedicated "CXA Returned" tab

A lead sent back from the Customers Pipeline via "Return For Validation"
(`return_lead_for_validation`) used to reappear mixed into whichever of the
Live/Manual tabs matched its original `source`, indistinguishable from a
fresh submission without opening the row. The Operations queue in
`src/routes/_authenticated/manager.tsx` is now three tabs — Live, Manual,
CXA Returned — and any row carrying `reopened_from_cx_at` is classified into
the new tab regardless of origin (`queueTabOf()`), which shows Origin
(Live/Manual), who handled it, and how long ago CX sent it back. No RPC,
RLS, or schema change — purely a client-side reclassification of rows the
existing queue query already fetched.

## 2026-09-12 — `sheet_sync_attempts` now cascades on submission delete

Deleting a submission from Supabase Studio failed with a foreign-key error
whenever that lead had a logged sync attempt — `sheet_sync_attempts_submission_id_fkey`
was created without a delete rule, unlike every other table referencing
`submissions.id` (`form_events`, `payment_details`, `carrier_declines`, etc.),
all of which already cascade. Since `sheet_sync_attempts` is pure internal
bookkeeping never read by the client, there's no reason it should outlive
its parent row. Migration:
`supabase/migrations/20260912180000_sheet_sync_attempts_cascade_delete.sql`,
applied to the live project.

## 2026-09-12 — Fixed a race that could leave a parked lead's Google Sheet row stale

A parked ("External Transfer") lead could show `parked` correctly in
Supabase while Google Sheets still showed `pending_manager` — confirmed live
on a real lead. Root cause: `submit_form_parked` inserted the row
(`status='pending_manager'`, firing the sheet-sync INSERT trigger) then
immediately updated it to `status='parked'` (firing the sheet-sync UPDATE
trigger) — two outbound syncs for the same lead in one transaction, with no
guarantee Apps Script's upsert-by-`Submission ID` processes the newer one
last.

Fixed by extracting the shared insert logic into a new, **not
client-callable** `submit_form_internal(p_payload, p_status)` (`EXECUTE`
revoked from `anon`/`authenticated`) — `submit_form` and
`submit_form_parked` are now thin wrappers over it, and a parked lead is
created with `status='parked'` in its one INSERT instead of insert-then-
update, so exactly one sync ever fires. Migration:
`supabase/migrations/20260912170000_fix_parked_lead_sheet_sync_race.sql`,
applied to the live project. See
[docs/decisions/0005](docs/decisions/0005-single-insert-status-to-avoid-sheet-sync-races.md)
and [docs/database.md](docs/database.md).

## 2026-09-12 — Sales Breakdown reporting tab (plan type, carrier, state, closer leaderboard)

New admin-only tab (`Admin → Sales Breakdown`, `src/components/sales-breakdown.tsx`)
answering: how many Level/Graded/Mod/GI sales were approved (`disposition =
'accepted'`), the same broken down per carrier and per customer state, and a
closer leaderboard (best/worst by accepted-sale count) over This Week / This
Month / All time / Custom.

Read-only, no migration — reuses `reporting_window` (the same Pacific-day RPC
`SubmissionsExplorer` already calls for its own date filter) for the period
math, and the alias-aware normalizers the upload engine already owns
(`src/lib/normalize/carriers.ts`'s `lookupCarrier`, `src/lib/normalize/states.ts`'s
`STATE_CODES`) to fold messy free-text payload values ("TRANSAMERICA" /
"COREBRIDGE", "Texas" / "TX") into the same row rather than re-deriving that
matching in SQL. New pure helper `src/lib/plan-type.ts` buckets the "Plan
Type" field into Level/Graded/Mod/GI/Unspecified — Mod kept as its own
bucket rather than folded into Graded, since it's the rarer, more specific
category. The closer leaderboard excludes `submitted_by_role = 'validator'`
rows — those auto-close as accepted and stamp `closer_id` with the
validator's own id, which otherwise surfaced every validator as a "closer"
with a trivial 100% conversion rate. "This Week"/"This Month" were corrected
from a rolling 7/30-day window to real calendar boundaries (Monday-to-today,
1st-of-month-to-today) — the rolling version made "This Month" read
identical to "All time" with under 30 days of data in the system, and read
wrong regardless of data age against the actual ask ("only September"). The
By Carrier breakdown also had a case-sensitivity bug — "American Amicable"
and "AMERICAN AMICABLE" (same text, different case) counted as two separate
rows; carrier grouping is now case/whitespace-normalized. A new local
`prefixMatchCarrier()` also folds an unregistered product-name variant
("Corebridge GIWL", "Transamerica Express Select") into its carrier when the
text starts with a registered name/alias, without requiring a new exact
alias per product — deliberately kept local to this report rather than
loosened in `src/lib/normalize`, whose exact-match-only behavior is a
safety property the upload-import pipeline still needs. See
[docs/features/sales-breakdown.md](docs/features/sales-breakdown.md).

## 2026-09-12 — CX reopen is now an explicit "Return For Validation" action

Fixes a bug and changes a workflow found while investigating it. A
validator-submitted lead that a CXA declined disappeared from the CXA
pipeline but never reached the manager's Operations queue as
[decisions/0004](docs/decisions/0004-only-accepted-is-terminal.md) says it
should. Root cause: `set_cx_status` did correctly reopen the lead
(`status='pending_manager'`, `reopened_from_cx_at` stamped), but
`manager.tsx`'s queue query unconditionally excludes every
`submitted_by_role = 'validator'` row — including one that had just been
reopened, since that column is permanent lineage and is never cleared.
`src/routes/_authenticated/manager.tsx`'s Operations query now admits a row
regardless of `submitted_by_role` when `reopened_from_cx_at` is set.

Separately, the workflow itself changed: a CX status change no longer moves
a lead out of the pipeline by itself. `set_cx_status` (database function) is
now a pure status write for all four categories — policy included. Sending a
lead back to the manager is a new, explicit, standalone action instead: the
`return_lead_for_validation(p_sub, p_reason?)` RPC, exposed as a **"Return
For Validation"** button (`ReturnForValidationButton` in
`src/components/cx-status-cell.tsx`) added as its own column in the
Customers Pipeline table (`src/components/customers-pipeline.tsx`). A CXA can
now record a policy as declined without the lead leaving their queue, and
hand it back only when they mean to.

Database: `supabase/migrations/20260912000000_cx_explicit_return_for_validation.sql`
replaces `set_cx_status` and adds `return_lead_for_validation`, applied to
the live project.

## 2026-09-11 — Parked Leads count on the tab trigger (Closing + Admin)

Same pattern as the Pending Imports count added earlier today. A general
manager (and a closing manager, cosmetically — the query is disabled for
them since they never see this tab) previously had no way to know whether
any leads were parked without opening the tab.
`src/routes/_authenticated/closing.tsx`'s "Parked Leads" trigger now reads
"Parked Leads (N)", via a small always-on head-count query
(`enabled: canMoveParked`) sharing `parked-leads.tsx`'s exported
`PARKED_LEADS_KEY` prefix, so `move_to_validation`'s existing invalidation
of that key refreshes the count for free.

Admin's own "Parked Leads" tab (`src/routes/_authenticated/admin.tsx`) had
the identical gap and got the same fix for consistency.

Both client-side only; no database, RLS, or RPC change.

## 2026-09-11 — Per-tab counts on Submissions chips and Pending Imports

`SubmissionsExplorer` (`src/components/reporting.tsx`, shared by Admin →
Submissions and the manager's Reporting tab): the heading is now the plain
"Submissions" label, and each of the three chips shows its own count —
"Closer Submissions (N)", "Validator Submissions (N)", "Manual Submissions
(N)" — matching whatever search/carrier/archived/date filters are currently
active, via a new lightweight head-count-only query that runs for all three
tabs at once (the paginated row fetch stays lazy, only the active tab's).

Manager's "Pending Imports" tab trigger now shows the batch count waiting
for approval ("Pending Imports (N)") without needing to open the tab —
`src/routes/_authenticated/manager.tsx` gained a small always-on count
query against the existing `pending_import_batches` view, sharing
`PENDING_IMPORTS_KEY` so the realtime invalidation already in place covers
it for free.

Both are client-side only; no database, RLS, or RPC change.

## 2026-09-11 — Per-tab counts on the manager Operations queue

`src/routes/_authenticated/manager.tsx`'s Live/Manual tabs now show their
own count ("Live (92)", "Manual (2)") instead of one combined total on the
"Open submissions" heading — no more clicking over to Manual just to see
how many are there. Purely client-side (`allRows` was already fetched by
the existing query); no database, RLS, or RPC change.

## 2026-09-10 — Date-range filtering on Admin → Overview and → Submissions

Added a "Custom" date option to the Overview tab's period selector (From/To,
To optional for a single-day filter) and an independent From/To date filter
to the Submissions tab's filter bar. Both reuse one new shared DB function,
`reporting_window`, rather than computing Pacific-day boundaries in the
browser.

`supabase/migrations/20260910220000_reporting_date_filter.sql`: new
`reporting_window(p_days, p_start_date, p_end_date)`; extended
`submission_totals_range`, `submission_totals_by_center_range`,
`validator_stats_range` to accept the same two new optional parameters
(existing `p_days`-only calls unaffected). Applied live; regenerated
`src/integrations/supabase/types.ts` afterward.

**Caught and fixed during rollout**: `CREATE OR REPLACE` with a new
parameter list creates a second overload instead of replacing the original,
which made every existing single-argument call to these three RPCs
ambiguous the moment the migration landed. Fixed immediately by dropping
the old one-argument overloads (now part of the same migration file, so a
fresh replay produces the correct end state directly). See
`docs/database.md`'s note under the `_range` RPCs for detail.

This log starts from this documentation audit (2026-09-10) going forward.
The "Reconstructed history" section below is derived from `git log` commit
messages for context — it is a best-effort summary of past work, not a
verified line-by-line record, since most early commits are simply titled
"Changes."

## 2026-09-10 — Google Sheets sync: retry logic + corrected architecture

Follow-up to the same-day timeout fix below. Reading the actual deployed
source of both downstream hops (the `sheet-sync` Edge Function, and — shared
directly by the user — the Apps Script `doPost` handler it calls) revealed
the real architecture: Postgres → Edge Function → Apps Script, with a second,
previously-uncapped timeout risk on the Edge Function → Apps Script hop
(Apps Script holds a lock for up to 30s under concurrent requests). It also
confirmed retries are safe: Apps Script upserts by `Submission ID` rather
than blindly appending, so re-sending a submission can never create a
duplicate row.

`supabase/migrations/20260910210000_sheet_sync_retry.sql`:
- Raised the Postgres → Edge Function timeout further, from 20000ms to
  45000ms.
- Extracted the network call into `sync_submission_to_sheet(p_sub uuid)` so
  the trigger and a retry job share one implementation.
- New table `sheet_sync_attempts` logs every attempt with its `pg_net`
  request id.
- New function `retry_failed_sheet_syncs()` + new cron job
  `retry-sheet-sync` (every 5 minutes): resolves successful attempts,
  retries unresolved ones after a 3-minute grace period (up to 3 attempts),
  gives up past that rather than retrying forever.

Applied live via migration and verified (function bodies, trigger wiring,
cron registration all re-checked after applying). Does not backfill leads
already missing from the sheet — still a separate, not-yet-done task. See
`docs/database.md`'s `notify_sheet_sync` entry for full detail.

## 2026-09-10 — Fix: Google Sheets sync silently dropping submissions

Root cause found via direct Supabase inspection (reported by the user as a
count mismatch: CRM showed 209 validator submissions, the Google Sheet
showed 167). `notify_sheet_sync()`'s `net.http_post` call had no explicit
`timeout_milliseconds`, so it used `pg_net`'s default of 5000ms; `pg_net`'s
own response log showed roughly 4 in 10 recent sync attempts timing out at
essentially exactly that wall, with no retry anywhere in the trigger — a
timed-out sync was simply lost. Fixed by `supabase/migrations/20260910200000_sheet_sync_timeout.sql`,
which adds `timeout_milliseconds := 20000` to that one call and changes
nothing else. Applied live via migration, not a one-off change. See
`docs/database.md`'s `notify_sheet_sync` entry for detail.

Does not recover leads already missing from the sheet, and does not add
retry/delivery-confirmation logic — both intentionally deferred (see the
implementation plan discussed with the user).

## 2026-09-10 — Documentation audit + three admin features

- Added a full `docs/` structure (architecture, database, authentication,
  multi-tenancy, per-feature docs, decision records) derived from direct
  inspection of the live database and the codebase — see this repo's
  `docs/` directory. Corrected several stale claims in `CLAUDE.md` found
  during the audit (see that file's own history for specifics).
- **Admin read-only form preview**: `/closer` and `/validator-form` render
  a disabled preview for `admin` sessions instead of the live form, so an
  admin can inspect field layout without logging in as a closer/validator.
  Nav links added on the Admin page.
- **Users tab (Admin → Users)**: added search (name/staff ID/center) + role
  + active/inactive filters, a capped scroll region with a sticky header
  (fixed in a follow-up once the initial implementation's height/overflow
  landed on the wrong DOM node — see `docs/features/user-management.md`),
  and an inline Activate/Deactivate control wired to the existing
  admin-only direct write on `profiles`.
- **Exports tab (Admin → Exports)**: new — filter accepted leads by
  carrier/customer/draft date, multi-select, pick columns (a union of
  metadata + payload fields across the checked leads), download as CSV or
  Excel. See `docs/features/lead-export.md`.

## Reconstructed history (from `git log`, approximate)

- **2026-08-13 → 2026-08-14** — Project scaffolded on Lovable
  (`tanstack_start_ts` template). Design system and fonts added. Closer
  form built up field-by-field (age/birthday hints, zodiac sign, weekend
  draft-date hint, live ZIP weather lookup). Auth and role-based dashboards
  added.
- **2026-08-21** — "working app before uploader" — the app functioning
  end-to-end prior to the spreadsheet-import feature.
- **2026-08-31** — Uploader tool and center separation for closers.
- **2026-09-03** — "latest updates" (unspecified in the commit message).
- **2026-09-08 → 2026-09-09** — General manager role, parked leads,
  validator-completed fields (final carrier/agent/policy), CX reopen path;
  a redesign of the validation and customer-lifecycle timelines; several
  Reporting-tab refinements (period selector, queue-age display, visual
  separation of waiting stages) — the most recent work before this audit.
