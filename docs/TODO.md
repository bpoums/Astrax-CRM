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

