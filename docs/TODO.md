# Known bugs, gaps and future work

Findings that are real but not yet fixed. Add to this rather than leaving a
discovery only inside a feature doc's "Known limitations".

---

## SECURITY — ~20 `SECURITY DEFINER` RPCs fail open for a roleless caller

**Found 2026-09-17. Not fixed. Reachable from the public internet.**

The standard guard in these functions is

```sql
if my_role() <> 'admin' then raise exception 'not authorized'; end if;
-- or
if my_role() not in ('manager','admin') then raise exception 'not authorized'; end if;
```

`my_role()` returns **NULL** when the caller has no profile, no JWT, or an
**inactive** profile. `NULL <> 'admin'` evaluates to NULL, not true, and
`NULL NOT IN (...)` likewise — so the `IF` never fires and the function
proceeds. The guard reads correctly and does nothing.

Verified live against the production project, no JWT presented:

| call | result |
|---|---|
| `admin_settings()` as `anon` | **returned the settings** |
| `reporting_retention_status()` as `anon` | **returned the cron history** |

Supabase's default privileges grant EXECUTE on public-schema functions to
`anon`, so these are reachable with the publishable key that ships in the
browser bundle.

**This also contradicts `CLAUDE.md`**, which states that deactivating a profile
"cascades through every policy and every RPC in one write". It cascades through
every *policy* — RLS compares with `=`, so NULL simply fails to match — but not
through these RPCs. A deactivated admin still passes their guards.

### Affected (20)

`<>` form: `admin_settings`, `reject_assignment`, `reporting_retention_status`,
`restore_to_cx_pipeline`, `set_admin_setting`.

`NOT IN` form: `add_submission_tag`, `approve_import_batch`,
`archive_submission`, `assign_to_validator`, `check_duplicate_ssn`,
`clear_data_flag`, `move_to_validation`, `reject_import_batch`,
`remove_from_cx_pipeline`, `remove_submission_tag`,
`return_lead_for_validation`, `set_cx_status`, `start_lead_import`,
`unarchive_submission`.

Several are **writes** — `archive_submission`, `assign_to_validator`,
`set_admin_setting`, `approve_import_batch` — so the exposure is not only a
read leak.

`sheet_sync_backlog_status` had the same bug on first write and was fixed
before release; it is the reference for the correct shape.

### The fix

Mechanical, and the same shape as the RLS InitPlan pass:

```sql
if my_role() is distinct from 'admin' then ...
if my_role() is null or my_role() not in ('manager','admin') then ...
-- or: if coalesce(my_role()::text,'') <> 'admin' then ...
```

Belt and braces, also revoke EXECUTE from `anon` on every RPC that is not meant
to be public — `revoke ... from public` does **not** remove Supabase's direct
grant to `anon`; name the role.

**Verify by** calling each affected function with no JWT as `anon` and as
`authenticated`, and as an inactive profile: every one must raise
`not authorized`. The role×user harness used for the RLS matrix
(`set local role` + `request.jwt.claim.sub`) works unchanged.

---

## ~~CORRECTNESS — the Overview's outcome and centre figures count LIVE leads only~~

**Found 2026-09-18 by the product owner. FIXED the same day in
`20260918160000_all_origin_totals.sql` — `approved_all`, `declined_all`,
`pending_all` and `total_submissions_all` now carry the all-origin figures and
the Overview reads them. Kept here for the reasoning; delete once it has been
live for a while.**

`submission_totals_range` hardcodes `submitted_by_role = 'closer' AND
source = 'live'` on its `approved`, `declined` and `pending` filters.
`submission_totals_by_center_range` applies the same two conditions in its
`left join`. So every outcome figure on the Overview describes live leads only,
while the intake figures beside it (`closer_submissions`,
`offline_submissions`, `validator_submissions`) describe everything.

Verified live, non-archived, excluding `pending_import_approval`:

| Origin | accepted | declined | rows | has center_id |
|---|---|---|---|---|
| live (closer) | **183** | 63 | 356 | 356 |
| manual: uploaded | 19 | 8 | 41 | 41 |
| manual: validator | 184 | 0 | 202 | 202 |
| **total** | **386** | **71** | 599 | **all of them** |

Two consequences:

1. **Submission Outcome under-reports by more than half.** It prints 183
   Submitted where the business has sold 386, and 63 Declined against 71. Its
   acceptance ring reads **74%** where all origins give **84%**. The panel sits
   beside "Live 351 / Manual 243", so a reader has every reason to believe the
   outcome covers both. The redesign did not introduce the filter — the old
   Overview had the same `approved` figure — but it made it far more prominent
   and put it next to a merged Manual intake, which is what turns a quiet
   inconsistency into a misleading one.

2. **Manual sales cannot be broken down by centre**, though the data fully
   supports it: every manual lead carries a `center_id`. The Overview's source
   list therefore splits Live by centre but Manual only by
   Uploaded/Validator, which is a limitation of the RPC, not of the record.

**Fix taken: server-side.** New columns alongside the old ones rather than
widening the existing ones in place, so no existing caller's meaning changed
silently. The two paths that were weighed:

- **Server-side (preferred).** Widen the two functions, or add
  `submission_outcomes_range` / a centre variant that groups by origin as well
  as centre. Needs a migration and a `docs/database.md` update. Widening the
  existing columns in place would silently change every existing caller,
  including the manager's Reporting tab — so new columns alongside the old ones
  is the safer shape.
- **Client-side.** Two `count: "exact", head: true` queries for accepted and
  declined with no origin filter (no rows or payload transferred), plus a
  minimal `center_id, submitted_by_role, source, disposition` select to group
  Manual by centre. Cheap and ships without a migration, but it puts the
  definition of "sold" in the client, which `docs/database.md` deliberately
  keeps in the database.

**Verify by** reconciling each figure against the table above under an admin
JWT, and against a closing manager's JWT, where the same query must narrow to
that centre.

---

---

## Sales stats on the admin Overview — deferred, design settled enough to resume

**Raised 2026-09-18. Deliberately not built yet.** The ask: put Total Sales,
the plan split, By Carrier and By State on the Overview tab.

**Recommended shape** (agreed direction, not yet approved in detail): not three
more co-equal panels — the Overview's top row answers "what is happening now"
and sales is the record. One **Sales** panel (hero total + Level/Graded/Mod/GI)
in the record section, then **Top Carriers** and **Top States** side by side,
top five each with a `MetricBar` and a link through to the full Sales Breakdown
tab, which keeps its filters, pivots and CSV export.

**Three things found while scoping it, all of which need deciding first:**

1. **The two tabs mean different things by "period".** The Overview's chips are
   rolling (Today / 7 days / 30 days, Pacific); Sales Breakdown's are
   calendar-anchored (This Week from Monday, This Month from the 1st, via
   `mostRecentMonday`/`firstOfMonth`). "30 days" and "This Month" will print
   different numbers for the same business, so one screen showing both would
   need the mismatch spelled out, or one of them subordinated.

2. **`SalesBreakdown` aggregates in the browser, not the server.** It pages
   every accepted lead's **full payload** in via `fetchAllRows` and pivots in a
   `useMemo`, because carrier and state come from payload free text that needs
   the alias-aware normalizers (`lib/normalize/carriers.ts`,
   `lib/normalize/states.ts`). Measured 2026-09-18: **386 rows, 393 kB of
   payload, ~1 kB each**, growing linearly with sales. Acceptable on a tab
   someone opens deliberately; not on the Overview, which everybody opens all
   day. It also ships customer PII to the browser purely to count carriers.

3. **A `sales_breakdown_range` RPC is the right long-term answer** — same
   pattern as `submission_totals_range`, and it would make the Sales tab cheap
   too. The cost is reimplementing the alias folding in SQL against `carriers`
   and the state list, which is real work rather than a transcription. If it is
   built, the totals should come from the same place as the outcome figures in
   the entry above, so the two cannot disagree.

**Whatever is built must also settle** whether "sales" means all origins or
live only — see the correctness entry above. Today the Sales Breakdown tab
counts `disposition = 'accepted'` with **no origin filter** (so 386), while the
Overview's Submitted says 183. Those two screens already disagree.

---

## SECURITY — `validator_stats_range` hands every validator's record to any caller

**Found 2026-09-18. Not fixed. Database-side; the client door is now shut.**

`validator_stats_range()` is `SECURITY INVOKER`, but only three of its columns
are actually scoped by the caller's RLS. `assigned`, `approved`, `declined` and
`pending` come from `submissions` and narrow correctly. **`timed_out`,
`rejected` and `holds` are counted from `form_events`**, whose read policy does
not scope the same way — so they come back whole-business for anyone.

Verified live under a closing manager's own JWT (`set local role authenticated`
+ `request.jwt.claims`), a role whose `submissions` policy is limited to their
own centre's closer-originated leads:

```
Samia Aslam   assigned 16  approved 11  rejected  2  timed_out 5  holds 103
Saad Waheed   assigned  8  approved  3  rejected 13  timed_out 4  holds  78
Rabia Ahmed   assigned  7  approved  2  rejected  4  timed_out 10 holds 123
```

Thirteen rows: every validator's `full_name`, `staff_id` and performance. The
holds counts (103, 123) against 7–16 assigned leads are the tell — those are not
that centre's numbers.

Anyone who can sign in can call this directly over PostgREST, so the exposure
does not depend on a screen rendering it. The Closing Desk's Overview was
briefly going to fetch it automatically on every visit; that call was removed
before it shipped (`includeValidatorStats` in `lib/overview-stats.ts`), which
closes the app's door but not the database's.

**Fix** is server-side and needs a migration, so it has not been applied:
scope the three `form_events` subqueries the way the `submissions` join is
scoped, or restrict EXECUTE to the roles that have any business reading a
validators table (admin, manager) and name the roles rather than relying on
`revoke ... from public` — see the RPC finding above for why that is not enough.

**Verify by** calling `validator_stats_range()` under a closing manager's and a
general manager's JWT and confirming the counts match the leads that role can
actually read, and that a role with no business there cannot execute it at all.

---

## `npm test` fails 1 of 140

`src/lib/normalize/review-columns.test.ts` — "does not lose the card columns
when the only card number is cleared." Duplicate `card_number` catalog key
resolved two different ways by `buildLead()` vs `setLeadField()` (`Map`
last-write-wins vs `Array.find` first-match). Pre-existing, found in the
2026-09-10 audit. See
[decisions/0003](decisions/0003-deterministic-import-normalization.md).

---

## Unmasked card/bank data in `PayloadTable`

Detail views render payload fields verbatim. Recorded in
[features/closing-desk.md](features/closing-desk.md).

