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

