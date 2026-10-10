# Database

Source of truth: the live Supabase project `ozbpmrmndkemvvnlnudb`, inspected
directly via SQL (`pg_policy`, `pg_proc`, `pg_views`, `information_schema`,
`cron.job`) on 2026-09-10. **`supabase/migrations/` is not authoritative** —
only two files exist there and the live schema has diverged from them
substantially (most tables, functions and views below do not appear in either
migration file at all).

## Enums

| Enum | Values (in order) |
|---|---|
| `app_role` | `admin`, `closer`, `manager`, `validator`, `data_uploader`, `cxm`, `cxa`, `closing_manager`, `general_manager`, `reporting_manager` (added 2026-10-02) |
| `sub_status` | `pending_manager`, `assigned`, `in_review`, `returned_timeout`, `closed`, `pending_import_approval`, `parked` |
| `disposition_t` | `accepted`, `declined`, `pending` |

`CLAUDE.md` previously listed `sub_status` with only 5 values — the two
newest (`pending_import_approval`, `parked`) support the spreadsheet-import
gate and the External Transfer / parked-lead flow respectively (both already
present in `src/components/ops.tsx`'s `SUB_STATUSES`, just not in the root
doc).

`submissions.source` is `text`, not an enum, constrained by
`submissions_source_chk` to `'live'` (the closer/validator forms),
`'sheet'` (spreadsheet import) and, **added 2026-10-01**, `'api'` — a lead
pushed in by a center's own CRM via `submit_external_lead`
(`20261001100000_center_api_key_external_lead_ingest.sql`). See "External CRM
intake" below.

## Tables

Row counts are a snapshot at audit time, for scale intuition only.

| Table | Rows | Purpose |
|---|---|---|
| `profiles` | 56 | One row per `auth.users` row (trigger-created, see `handle_new_user` below). `role`, `active`, `staff_id`, `org_name`, `center_id`. |
| `submissions` | 422 | The one lead-lifecycle table. See column list below — it is much wider than `CLAUDE.md` previously documented. |
| `form_events` | 1838 | Append-only audit trail. `submission_id`, `actor_id` (nullable — system-run purges write `null`), `event_type` (free text, not an enum), `detail` jsonb. |
| `payment_details` | 4 | Bank/card fields for **imported** leads only. One row per submission, written by `ingest_sheet_lead` or lazily by `update_payment_field`. **No RLS policy exists on this table at all** — every access is through `payment_summary`/`card_details`/`update_payment_field`, all `SECURITY DEFINER`. |
| `card_access_log` | 0 | One row per `card_details()` call. Read-only to admin. |
| `lead_imports` | 12 | One row per uploaded batch (`start_lead_import`). `row_count`, `imported_count`, `skipped_count`, `upload_ip` (best-effort `x-forwarded-for`, explicitly documented in its own column comment as weak identification behind shared NAT). |
| `carriers` | 7 | Vocabulary table: `name`, `active`, `sort_order`, `aliases text[]`. Admin-writable directly (no RPC — see `centers.ts` comment pattern, same reasoning applies to carriers). |
| `carrier_declines` | 301 | One row per (submission, carrier) decline, written by `decline_with_carriers` (both overloads) and `record_carrier_rejection`. Added 2026-10-05 (`20261005100000_placement_rule.sql`): `imo_id` (null on every row from before), `source` (`validator`/`after_submit`) and `kind` (`carrier_rejected`/`fixable`/`unclassified`, not null). Only `carrier_rejected` rows feed the placement rule. Old rows were backfilled by `classify_decline_reason(reason)`: 88/48/165. |
| `placement_overrides` | added 2026-10-05 | An admin's or general manager's permission for one lead to be placed at one blocked IMO → carrier (`submission_id`, `imo_id`, `carrier_id`, unique together; `reason` not null; `overridden_by`, `created_at`). Readable by admin/manager/general_manager. No write policy, and direct writes are revoked; it is written only by `override_placement_block`. |
| `centers` | 2 | The two call centers (UMS BPO, DESCOM). Admin-writable directly. |
| `agencies`, `imos`, `agents` | added 2026-10-04 | Placement vocabulary (`20261004100000_placement_hierarchy.sql`): `name` (unique, case/space-insensitive), `active`, `sort_order`; `agents` also has an optional `npn`. Unlike `carriers`, **not** directly writable: write grants (incl. `TRUNCATE`) are revoked from `anon`/`authenticated`, there is no write policy, and every write goes through the admin-only `placement_upsert_item`. Readable by every role. No delete — deactivate. |
| `agency_imos`, `imo_carriers` | added 2026-10-04 | The many-to-many links: agency↔IMO (PK pair) and IMO↔carrier (`id` PK, unique pair — one IMO→Carrier *contract*). Each has `active`. (`agent_appointments` existed 2026-10-04 → 2026-10-07 and was dropped: agents are a standalone list.) Same grants/RLS as the lists; written only by `placement_set_link`. See [features/admin-settings-and-config.md](features/admin-settings-and-config.md). |
| `transfer_clients` | 0 | Added 2026-09-19. **`center_id` (added 2026-10-10, `20261010140000_transfer_clients_center.sql`): the center whose closers may transfer to the client and under which the Overview lists it; null = every center; both existing clients are UMS BPO's.** Vocabulary table: `name` (unique), `active`, `sort_order`. The external parties a closer transfers a lead to with **External Transfer**. Admin-writable directly, readable by every role (the closer's transfer dialog reads it). Referenced by `submissions.transfer_client_id`, so there is no delete — deactivate instead. |
| `center_api_keys` | added 2026-10-01 | One row per center with an API key issued: `center_id` (PK, FK `centers`), `key_hash bytea` (`digest(raw, 'sha256')` — the raw key is never stored), `key_prefix` (first 8 hex chars, display only), `created_at`, `created_by`, `last_used_at`. **RLS enabled, zero policies** — same trust boundary as `app_config`/`payment_details`: reachable only through `admin_generate_center_api_key`/`admin_list_center_api_keys`/`submit_external_lead`, never a direct `from()`. One key per center; regenerating overwrites and immediately invalidates the old one (`on conflict (center_id) do update`) — there is no separate revoke. |
| `cx_status_options` | 26 | The configurable vocabulary for the four CX categories. `category` check-constrained to `policy|premium|commission|chargeback`. `tone` check-constrained to `muted|accent|positive|destructive|warning`. |
| `cx_lead_status` | 2 | One row per submission (PK is `submission_id`), four independent status-option pointers (`policy_status_id`, `premium_status_id`, `commission_status_id`, `chargeback_status_id`) each with its own free-text `_reason`. |
| `cx_status_history` | 4 | Append-only log of every `set_cx_status` change: `from_code`/`to_code`/`reason`/`actor_id`. |
| `cx_tags` | 3 | Free-form tag vocabulary for CX leads (`label`, `tone`, `sort_order`, `active`). **Added 2026-09-25**: `allows_duplicate_ssn boolean` — a tag carrying this flag exempts the lead it's applied to from the duplicate-SSN block in `submit_form_internal`. Seeded with one such tag, "Eligible For Second Policy". See [decisions/0007](decisions/0007-duplicate-ssn-blocks-unless-tagged.md). |
| `submission_tags` | — | Many-to-many `submissions` ↔ `cx_tags`, written by `add_submission_tag`/`remove_submission_tag`. Was unused in production (0 rows) until the tags UI (`SubmissionTags`, mounted in the Customers Pipeline detail sheet) gave CX a way to apply one. |
| `payload_edits` | 11 | Before/after value history for `payload` field edits, written exclusively by `update_payload_field`. Distinct from `form_events`' `payload_edited` entries, which only record *that* a field changed, not the values — see `src/components/payload-history.tsx`. |
| `settings_audit` | 10 | Before/after history for `app_config` changes, written by `set_admin_setting`. Admin-only read. |
| `app_config` | 8 | Key/value config store. **No RLS policy at all** — reachable only through `admin_settings()`/`set_admin_setting()`/`review_window()`/`review_settings()`. |
| `crm_suspension` | added 2026-09-29 | Singleton row (`id boolean primary key default true`, `suspended`, `resumes_at`, `message`, `updated_by`, `updated_at`) — the CRM-wide maintenance switch. **One RLS policy, `for select using (true)`** — the deliberate exception: readable by anyone, including anon/signed-out, so a just-kicked user can still see why. No write policy; writes go only through `set_crm_suspension()`. In the `supabase_realtime` publication so the client can subscribe to changes. See [decisions/0008](decisions/0008-crm-suspension-via-my-role.md). |
| `sheet_sync_attempts` | added 2026-09-10 | One row per Google Sheets sync attempt (`sync_submission_to_sheet`/`notify_sheet_sync`/`retry_failed_sheet_syncs`). `submission_id`, `request_id` (the `pg_net` request id), `attempt_number`, `resolved_at`, `resolved_status` (`ok`/`retried`/`superseded`/`gave_up`, or null while still pending). RLS enabled, no policies — internal bookkeeping only, never read by the client. See the `notify_sheet_sync` entry below for why this exists. `submission_id` is `ON DELETE CASCADE` (fixed 2026-09-12 — it was created without a delete rule, unlike every other table referencing `submissions.id`, which blocked deleting any submission that had ever had a sync attempt logged). |

### `submissions` — full current column list

```
id, closer_id, payload jsonb, status sub_status, assigned_to, assigned_at,
claimed_at, last_timeout_by, timeout_count, disposition disposition_t,
disposed_by, disposed_at, created_at, submitted_by_role app_role,
hold_count, last_held_at, last_rejected_by, rejection_count,
archived_at, archived_by, source text ('live'|'sheet'), source_ref,
uploaded_by, import_id, data_flags jsonb,
cx_assigned_to, cx_assigned_at,
center_id, center_name, draft_date, future_draft_date, ssn_normalized,
final_carrier_id, agent_name, policy_number,
reopened_from_cx_at,
agency_id, imo_id, agent_id
```

`agency_id`/`imo_id`/`agent_id` (added 2026-10-04, FKs to `agencies`/`imos`/`agents`)
are nullable and were added empty on every existing row. They're written by the
6-argument `set_validator_fields` (added 2026-10-05), and filled by hand for
historical leads. `notify_sheet_sync` ignores them, so
setting them never re-sends a row to Google Sheets. `agent_name` stays the column
every reader uses.

Columns **not** previously documented in `CLAUDE.md`: `cx_assigned_to`,
`cx_assigned_at` (present on the table; not observed written by any RPC read
in this audit — see "Unclear / undocumented" in the audit summary),
`center_id`/`center_name` (stamped at submission — see
[multi-tenancy.md](multi-tenancy.md)), `draft_date`/`future_draft_date`
(derived from `payload` as real `date`
columns, so they can be indexed/filtered without a jsonb cast — by `submit_form`
at submission, by `ingest_sheet_lead` at import and by `update_payload_field`
on a correction, all three through `parse_lead_date`; an uploaded lead's
recurrence text is resolved to its next real occurrence, see
[decisions/0006](decisions/0006-recurring-draft-dates-resolved.md)),
`ssn_normalized` (digits-only SSN, populated only when it forms a clean 9
digits — powers `check_duplicate_ssn`; written by the same three functions
through `normalize_ssn`), `final_carrier_id`/`agent_name`/`policy_number` (the
three validator-completed fields, columns not payload keys — see
[features/validation-queue.md](features/validation-queue.md); note
`final_carrier_id` is **null on every validator-submitted lead**, 0 of 260
live, because those auto-accept on submit and never reach
`set_validator_fields` — their final carrier is `payload->>'Agency'`, and
`finalCarrierName()` in `ops.tsx` is what resolves the two shapes),
`reopened_from_cx_at` (stamped by `return_lead_for_validation` — see the CX
lifecycle RPCs below — when a CXA sends the lead back to the manager's queue;
never cleared, so it stays as a permanent trace on that row, and as of
2026-09-16 it is also what keeps the lead on the CX pipeline while it is away),
`cx_removed_at`/`cx_removed_by` (added 2026-09-16, written by
`remove_from_cx_pipeline`/`restore_to_cx_pipeline` — a CX-workspace-only
dismissal, invisible to every other queue and report),
`transfer_client_id`/`transfer_client_name` (added 2026-09-19, written only by
`submit_form_parked` — which external client a parked lead was transferred to.
The **name is a frozen copy** taken at park time, the way `center_name` is, so
renaming a client never rewrites the history of leads already handed over;
`transfer_client_id` is what Parked Leads filters its per-client chips on.
Both are null on the 11 leads parked before clients existed, and a
`submissions_transfer_client_parked_idx` partial index covers
`transfer_client_id where status = 'parked'`. Deliberately **columns, not
payload keys**: `payload` is what sheet-sync pushes to Google Sheets, so a key
there would become a new Sheet column),
`missing_info text[]` (added 2026-10-10, `20261010100000_missing_info_filter.sql`
— a **`GENERATED ALWAYS ... STORED`** column: the labels of the required fields an
uploaded (`source = 'sheet'`) lead has no value for, `{}` for every other lead.
Computed by `missing_required_fields(source, payload)`, the one definition of the
15 required fields (Full Name, Gender, Date of Birth, Age, State, SSN Number,
Phone Number, Residential Address, Customer Zip Code, Proposed Carrier, Coverage
Amount, Premium, Plan Type, Beneficiary Name, Draft Date — deliberately not the
closer form's whole `required` list, see `features/spreadsheet-import.md`).
Recomputed by Postgres on every payload write, so filling a field removes it.
Filter with `missing_info <> '{}'` (any) or `missing_info @> '{"Draft Date"}'`
(one field). **Changing the list does not recompute existing rows**: ship a
migration that drops and re-adds the column (a table rewrite, no triggers fire) —
never an `UPDATE` to "touch" rows, which would re-fire the Google Sheets sync.
Not a payload key, so it adds no Sheet column),
`missing_bank text[]` (added 2026-10-10, `20261010110000_missing_bank_info.sql` —
the **banking** counterpart of `missing_info`: which of Account Title, Bank Name,
Bank Type, Routing Number and Account Number an uploaded lead has no value for.
A plain column, **not generated**, because four of the five live in
`payment_details` and a generated column cannot read another table. Kept current
by two triggers: `submissions_missing_bank` (BEFORE INSERT/UPDATE OF
`payload`, `source` — covers Bank Type, which is a payload key — and reads the
lead's payment row) and `payment_details_missing_bank` (AFTER INSERT/UPDATE OF the
four bank columns — updates `submissions.missing_bank`). Both are `SECURITY
DEFINER`, `EXECUTE` revoked from everyone. An UPDATE that changes only this column
never enqueues a Sheets sync: `notify_sheet_sync` returns early when none of the
columns it watches changed (verified live). Card number, expiry and CVC are
optional and are not tracked). `uploaded_required_fields()` is the **single
definition** of all 20 required fields (15 `core`, 5 `bank`); `missing_required_fields`
and `missing_bank_fields` both read it, and the uploader's review step fetches it,
so the uploader, `missing_info` and `missing_bank` cannot disagree.

## Views

| View | Purpose |
|---|---|
| `submission_totals` | One row: `closer_submissions, validator_submissions, offline_submissions, approved, declined, pending, in_review, awaiting_manager, timeouts, rejections`. Excludes archived rows. |
| `submission_totals_by_center` | Same shape, one row per active center. |
| `validator_stats` | Per validator: `assigned, approved, declined, pending, timed_out, rejected, holds`. |
| `carrier_decline_stats` | Per active carrier: `total_declines`, `leads_declined` (distinct submissions), `last_decline`. |
| `submission_declined_carriers` | Per submission that has ≥1 decline: aggregated `declined_carriers` name array, `decline_count`, `last_declined_at`. |
| `submission_customer_rejections` | Added 2026-10-05, `security_invoker`. Per submission whose customer (same `ssn_normalized`, any lead) has ≥1 `carrier_rejected` decline: `rejection_count` and a `rejected_carriers` name array. Feeds the manager's "Prior rejections" badge. |
| `pending_import_batches` | Batches still awaiting manager approval, with `lead_count` and `flagged_count` (rows with ≥1 data flag). |
| `cx_pipeline` | Every submission in the CX pipeline — non-archived, `cx_removed_at is null`, and either `disposition='accepted'` or carrying `reopened_from_cx_at` — joined to its four resolved CX status codes/labels/tones. The read model for Customers Pipeline. Also carries `status`, `disposition` and `reopened_from_cx_at` so the table can mark a lead that is out for re-validation, and (2026-09-17) `submitted_by_role`, `final_carrier_id`, `final_carrier_name` (joined from `carriers`), `agent_name` and `policy_number` — the placement. The name is resolved **in the view** so the pipeline's Final Carrier column needs no second query and its search box can filter on `final_carrier_name` directly. |
| `cx_status_summary` | Per (category, option): `lead_count` of leads **in `cx_pipeline`** carrying that status — feeds the status cards on the admin Overview ("Customer Policy Lifetime") and the Customer Pipeline tab, so each card equals the table below it filtered to that status. `security_invoker`. **Changed 2026-10-10** (`20261010120000_cx_status_summary_matches_pipeline.sql`): it used to join `submissions` with a LEFT JOIN whose `accepted`/`archived_at` conditions removed nothing, so it also counted archived leads and leads CX had removed from its pipeline (Policy "Approved" read 86 against 73 in the table: 73 + 12 archived + 1 removed). It now joins `cx_pipeline`, which owns the membership rule. |
| `cx_untouched` | **Approved** leads (`disposition = 'accepted'`) **in `cx_pipeline`** with no status in any of the four categories — leads that never entered CX. Sent-back leads are deliberately not counted (they have their own card). `security_invoker`. **Changed 2026-10-10** (`20261010121000`, then `20261010130000_cx_untouched_approved_only.sql`): it used to read `submissions` directly with its own accepted-only copy of the rule; it now reads `cx_pipeline`, so the pipeline's membership rule (not archived, not CX-removed) is shared with the table and the status cards, while the approved-only test is kept. |
| `closer_lead_alerts` | Per closer (`s.closer_id = auth.uid()`), their own leads whose CX status just changed to something toned `destructive`/`warning` — the read model behind `forwarded-leads.tsx`'s alerting. |

The app's TypeScript layer mostly calls **`_range`-suffixed RPC wrappers**
(`submission_totals_range`, `submission_totals_by_center_range`,
`validator_stats_range` — `SECURITY INVOKER`, so the `submissions`-derived
columns run under the caller's own RLS) rather than selecting these views
directly; the wrappers add an optional `p_days` window (via
`reporting_since(p_days)`, which computes a Pacific-timezone day boundary) on
top of the same underlying view logic.

**`validator_stats_range` role guard, added 2026-09-27**
(`20260927110000_fix_validator_stats_range_leak.sql`). `assigned`/`approved`/
`declined`/`pending` come from `submissions` and were always correctly scoped
by the caller's RLS, but `timed_out`/`rejected`/`holds` come from
`form_events`, whose SELECT policy lets `manager`/`admin`/`closing_manager`/
`general_manager` read every row with **no** centre scoping — so those three
columns came back whole-business for any of those four roles, not just the
two that should see it. Verified live under a closing manager's JWT (recorded
in [TODO.md](TODO.md)): all thirteen validators' full-business figures came
back, not that centre's. Fixed by adding an explicit
`my_role() is null or my_role() not in ('admin','manager')` guard inside the
function (converted from `language sql` to `language plpgsql` to hold it; the
query itself is unchanged) rather than fixing the `form_events` policy, since
the only two real-world callers — the manager Reporting tab; the Closing Desk
never fetches it for `closing_manager`/`general_manager` — are exactly the two
roles the guard now allows. `EXECUTE` revoked from `anon`. **Widened
2026-10-02** (`20261002110000_reporting_manager_grants.sql`) to also allow
`reporting_manager`, whose Reporting screen mounts the same Validators Team
Dashboard table.

**All-origin outcome columns, added 2026-09-18**
(`20260918160000_all_origin_totals.sql`). Every disposition count in these two
functions was filtered to `submitted_by_role = 'closer' AND source = 'live'`,
while the intake columns beside them counted everything — so the admin
Overview reported 183 Submitted where the business had sold 386, and manual
leads could not be grouped by centre at all even though every one of them
carries a `center_id`. The originals are unchanged; new columns sit alongside:

| Function | New column(s) | Meaning |
|---|---|---|
| `submission_totals_range` | `approved_all`, `declined_all`, `pending_all` | The same three dispositions over **every** origin |
| `submission_totals_by_center_range` | `total_submissions_all` | That centre's leads of every origin, live and manual |
| `submission_totals_by_center_range` | `manual_submissions` (added same day, `20260918170000`) | That centre's non-live leads — validator submissions plus approved uploads. `total_submissions + manual_submissions = total_submissions_all` by construction |

All five exclude `status = 'pending_import_approval'`, so an unapproved import
batch contributes nothing — the same rule `offline_submissions` already
applied. `approved`, `declined`, `pending` and `total_submissions` still mean
exactly what they meant before, so nothing that read them changed behaviour; in
the centre function the origin test simply moved off the `left join` and into a
`filter` on each existing column, because the join has to see manual rows for
the new column to exist. Both functions were `DROP`ped and recreated (a
changed return type is not something `CREATE OR REPLACE` can do), which drops
their grants — the migration restores EXECUTE to `public`, `anon`,
`authenticated` and `service_role` exactly as it found them.

**Date-range filtering, added 2026-09-10**: all three `_range` RPCs also
accept `p_start_date date` / `p_end_date date`, resolved through a new
shared function `reporting_window(p_days, p_start_date, p_end_date) returns
table(since timestamptz, until timestamptz)`. `p_days` behaves exactly as
before (`since` from `reporting_since`, `until = null`, open-ended through
now) and takes precedence when given. Otherwise, if `p_start_date` is given:
`since` is that Pacific calendar day's midnight, and `until` is the day
*after* `coalesce(p_end_date, p_start_date)`'s midnight (exclusive) — so
`p_start_date` alone filters exactly one day, and both together filter an
inclusive range. Both null still means all time.

Because `CREATE OR REPLACE FUNCTION` does not change a function's parameter
list — a different signature creates a second overload rather than
replacing the original — the migration that added these parameters also had
to explicitly `DROP FUNCTION` the old one-argument versions first; without
that, every existing `{ p_days: 7 }`-style call became ambiguous ("function
is not unique") the moment the three-argument versions existed alongside
them. Worth remembering for any future RPC signature change: extending a
function's parameter list is not, by itself, backward compatible at the
Postgres level even though the call site's optional-argument usage looks
backward compatible from the client.

## RPC functions (the entire write/read-gated API)

All are `SECURITY DEFINER` unless noted `INVOKER`. Every one starts by
checking `my_role()` (or an equivalent ownership/assignment check) and raises
`not authorized` — or a specific reason — rather than failing silently.
Grouped by subsystem; see the matching `docs/features/*.md` for the workflow
each supports.

> ### ⚠ Write the role check as `is distinct from`, never `<>` or `NOT IN`
>
> `my_role()` returns **NULL** for a caller with no profile, no JWT, or an
> **inactive** profile. `NULL <> 'admin'` is NULL — not true — so
> `if my_role() <> 'admin' then raise` **never fires and the function returns
> its data**. Same for `NOT IN`. The guard reads correctly and does nothing.
>
> Use `my_role() is distinct from 'admin'`, or
> `my_role() is null or my_role() not in (...)`.
>
> Also revoke EXECUTE from `anon` by name where a function is not public:
> Supabase's default privileges grant it to `anon` directly, and
> `revoke ... from public` does **not** remove a direct grant.
>
> **Fixed 2026-09-27** in `20260927100000_fix_null_role_auth_bypass.sql` for
> all 19 affected RPCs, including `admin_settings` and
> `reporting_retention_status`, both previously verified returning data to
> `anon` with no JWT (2026-09-17). Every one now uses one of the two forms
> above and has `EXECUTE` revoked from `anon`. History and the affected list
> kept in [TODO.md](TODO.md). `sheet_sync_backlog_status()` remains the
> reference for the correct shape.

**Identity / bootstrap**
- `my_role()` — **changed 2026-09-29**: `select role from profiles where id = auth.uid() and active and (role = 'admin' or not exists (select 1 from crm_suspension where id = true and suspended and (resumes_at is null or resumes_at > now())))`. The single point every other check reads through; an inactive profile, or a non-admin while the CRM is suspended, resolves to no role — i.e. **NULL**, which is why the `<>` / `NOT IN` warning above matters. RLS policies compare with `=` and so correctly deny a NULL role; the RPCs using `<>` do not. See [decisions/0008](decisions/0008-crm-suspension-via-my-role.md) for why system suspension was folded into this function rather than added to every policy/RPC separately.
- `handle_new_user()` (trigger, on `auth.users` insert) — creates the matching `profiles` row. **Hardcodes** `role := 'admin'` when the new email is exactly `bpoums@gmail.com` (lowercased comparison), else `'closer'`. This is how the first admin account exists — there is no other bootstrap path.
- `guard_last_admin()` (trigger, `BEFORE UPDATE` on `profiles`) — raises if the update would deactivate or demote the last active admin.

**Closer / validator submission**
- `submit_form_internal(p_payload jsonb, p_status sub_status)` — **not a client-facing RPC**; `EXECUTE` is revoked from `anon`/`authenticated` (added 2026-09-12). Holds the actual insert logic shared by the two public wrappers below: stamps `ID` (staff_id) and `Submitted By Role` into the payload, parses `Draft Date`/`Future Draft Date` into real date columns and a digits-only SSN into `ssn_normalized`, and inserts the row with `status = p_status` (or `'pending_manager'` if `p_status` is null) — except a **validator's own submission always auto-closes** regardless of `p_status`: `status='closed'`, `disposition='accepted'`, `disposed_by/at` = self, immediately, in the same insert. Kept unreachable directly so a client can never pass an arbitrary `p_status` and skip the normal `pending_manager` review start state.
  **Blocks on a duplicate SSN, added 2026-09-25**: before the insert, if the payload's SSN normalizes to 9 digits and matches `ssn_normalized` on another non-archived submission **with `disposition = 'accepted'`**, the call `raise exception`s unless at least one of those accepted matches carries a tag with `cx_tags.allows_duplicate_ssn`. A declined or still-undisposed (in-progress) duplicate is **not** checked here at all — that stays advisory-only via `check_duplicate_ssn`. Applies to both `v_role` branches — a closer's forms and the validator's own auto-accepting submission alike. See [decisions/0007](decisions/0007-duplicate-ssn-blocks-unless-tagged.md), which supersedes the "advisory only" note this doc previously carried here.
- `submit_form(p_payload jsonb)` — closer or validator only. Thin wrapper: `submit_form_internal(p_payload, null)`.
- `submit_form_parked(p_payload jsonb, p_client uuid)` — closer or validator only. Thin wrapper: `submit_form_internal(p_payload, 'parked')`, then (only for a closer-originated result) resolves `p_client` against `transfer_clients`, stamps `transfer_client_id`/`transfer_client_name` on the row, and writes the `'parked'`/`external_transfer` `form_events` row with the client name in `detail`. A validator submission passes through unchanged (already closed by `submit_form_internal`), since there is nothing to park.
  **Changed 2026-09-19** (`20260919100000_external_transfer_clients.sql`): `p_client` was added and is **required** for a closer's transfer — the RPC raises `select a client to transfer to` on a null and `client is not available` on an id that is missing or deactivated. The one-argument `submit_form_parked(jsonb)` was **dropped**, not kept alongside, because leaving it would have been a way to park a lead against no client at all. A refusal aborts the whole call: verified live that a null client leaves neither a `submissions` row nor a `form_events` row behind.
  **Fixed 2026-09-12**: this used to call `submit_form()` (one INSERT, status `pending_manager`) and then `UPDATE ... SET status='parked'` on the same row — two separate writes, each firing its own `sheet_sync_*` trigger, dispatching two outbound HTTP requests to Apps Script within the same transaction with no guaranteed ordering. Apps Script upserts by `Submission ID`, so whichever of the two concurrent requests it finished processing *last* won — occasionally the stale `pending_manager` one — leaving the Sheet showing a status Supabase had already moved past. Routing both `submit_form`/`submit_form_parked` through one shared, single-INSERT `submit_form_internal` means a parked lead now fires exactly one sync, carrying its final status from the start.
- `missing_info_by_field()` — `SECURITY INVOKER`, so RLS scopes what each caller counts (added 2026-10-10). Returns `(field, lead_count)` over unarchived leads' `missing_info`, most-missing first; drives the per-field dropdown on Submissions → Manual. Raises `not authorized` for a caller with no role; `EXECUTE` revoked from `public` and `anon`.
- `missing_required_fields(p_source text, p_payload jsonb)` — `IMMUTABLE` helper behind the `missing_info` column (added 2026-10-10); not called by the app. Since `20261010110000` it reads the core group from `uploaded_required_fields()`.
- `missing_bank_fields(p_source, p_payload, p_bank_name, p_account_title, p_routing_number, p_account_number)` — `IMMUTABLE` helper behind `missing_bank` (added 2026-10-10); not called by the app.
- `uploaded_required_fields()` — `IMMUTABLE`, returns `(ord, label, grp, store, pay_col)` for the 20 required fields of an uploaded lead (added 2026-10-10). Read by the uploader's review step. `EXECUTE` granted to `authenticated` only (revoked from `public`/`anon`).
- `missing_bank_by_field()` — `SECURITY INVOKER` twin of `missing_info_by_field()` over `missing_bank` (added 2026-10-10); `EXECUTE` revoked from `public`/`anon`.
- `move_to_validation(p_sub)` — admin or `general_manager` only. Releases a `'parked'` lead back to `'pending_manager'`. The client stays stamped on the row; releasing a lead does not clear it, because it is a record of what happened rather than a queue pointer.
- `parked_client_counts()` — admin or `general_manager` only (added 2026-09-19). Returns `(client_id, client_name, lead_count)` over unarchived `'parked'` leads, including a **null-id row** for the ones with no client, ordered with that row last. Drives the per-client chips above the Parked Leads table; it exists because that table is paginated, so the counts cannot be derived from the one page of rows on screen. Guard written `my_role() is distinct from ...` — see the NULL-role note in `CLAUDE.md` — and `EXECUTE` revoked from **both** `public` and `anon` (revoking from one alone leaves the other's grant in place; verified live that `anon` cannot execute it and `authenticated` can).
- `parked_client_counts_range(p_days, p_start_date, p_end_date)` — admin or `general_manager` only (added 2026-10-10). Returns `(center_id, client_id, client_name, lead_count)` for unarchived `'parked'` leads submitted in the window (`reporting_window()` on `created_at`), grouped by the **lead's** center and client and named by the client's current name. Feeds the In House / client breakdown in the Overview's Live column; because it is a subset of the center's live total, `In House = live - clients` cannot go negative. Leads with no client are not listed. Guard `my_role() is distinct from ...`; `EXECUTE` revoked from `public` and `anon`. The window-less `parked_client_counts()` above is unchanged.
- `submit_form_parked` — **changed 2026-10-10**: after resolving the client it also raises `client is not available for your center` when the client has a `center_id` and the new lead's center is different (an unlinked client, and a validator's own submission, are unaffected).
- `check_duplicate_ssn(p_ssn)` — closer/validator/manager/admin. Looks up `ssn_normalized` (excluding archived rows), returns the most relevant existing match's bucket (`accepted`/`declined`/`in_progress`), `submitted_at`, and (**added 2026-09-25**) `exempt` — whether any accepted, non-archived lead sharing the SSN carries a tag with `allows_duplicate_ssn`. `exempt` is only ever `true` when `status = 'accepted'`; it's meaningless (always `false`) for a declined/in-progress match, since those never block. This RPC itself stays read-only and advisory; `exempt` only previews what `submit_form_internal` will actually decide.

**External CRM intake (added 2026-10-01)** — see
[features/closer-submission-and-forms.md](features/closer-submission-and-forms.md)'s
"External center intake" section.
- `admin_generate_center_api_key(p_center_id)` — admin only. Generates a
  random 32-byte key (`encode(gen_random_bytes(32), 'hex')`), stores its
  sha256 hash + an 8-char display prefix in `center_api_keys` (upserted —
  regenerating replaces and invalidates the previous key), returns the raw
  key. The **only** time the raw key is ever available; not retrievable
  afterwards. **Fixed 2026-10-01** (`20261001110000_fix_center_api_key_search_path.sql`):
  `pgcrypto` is installed in the `extensions` schema on this project, not
  `public` — `set search_path to 'public'` alone made `gen_random_bytes`
  unresolvable (`function gen_random_bytes(integer) does not exist`). Both
  this function and `submit_external_lead` below now set
  `search_path to 'public', 'extensions'`.
- `admin_list_center_api_keys()` — admin only. Returns `(center_id,
  key_prefix, created_at, last_used_at)` for every center with a key issued —
  never the hash. Backs the "API Key" dialog in `CenterAdmin`
  (`src/components/center-admin.tsx`).
- `submit_external_lead(p_api_key, p_payload)` — **not role-gated** (there is
  no caller role; the API key parameter *is* the authorization check, the
  same trust model `ingest-sheet-lead`'s edge function already uses for
  Apps Script). Looks up `center_api_keys` by `digest(p_api_key, 'sha256')`;
  raises `invalid api key` on no match. On match, inserts exactly the shape
  a closer's own submission takes — `closer_id=null`,
  `submitted_by_role='closer'`, `status='pending_manager'`, `source='api'`,
  `center_id`/`center_name` stamped from the matched key row,
  `draft_date`/`future_draft_date`/`ssn_normalized` parsed via
  `parse_lead_date`/`normalize_ssn`, and the **same accepted-match
  duplicate-SSN block** `submit_form_internal` enforces (copied rather than
  shared, since this path has no `auth.uid()` to key `submit_form_internal`
  off). Payment/banking fields travel as ordinary `payload` keys, exactly
  like a live closer submission — **not** split into `payment_details`; that
  split is specific to `ingest_sheet_lead`'s import path. Called from the
  `ingest-center-lead` edge function (`verify_jwt: false`, auth via the
  `x-api-key` header), never directly from a browser session. Stamps
  `center_api_keys.last_used_at` on success.

**Manager queue**
- `assign_to_validator(p_sub, p_validator)` — manager/admin. Only from `pending_manager`/`returned_timeout`, and only for `submitted_by_role='closer'` (a validator's own submission is never assignable).
- `dispose_submission(p_sub, p_disposition)` — manager/admin any time; a validator only while `status='in_review'`, `assigned_to=self`, and inside `review_window()`. **Accept gate**: if `p_disposition='accepted'` and the lead is closer-originated, it raises unless the required fields are set.
  - With `placement_rule_enabled()` off, that's `final_carrier_id`/`agent_name`/`policy_number`.
  - With it on, that's `agency_id`/`imo_id`/`final_carrier_id`/`agent_id`/`policy_number`, plus no `placement_conflict`.

  Accepting sets `status='closed'` (the only terminal state); declining/pending sets `status='pending_manager'` and clears the assignment. Since 2026-10-05 a NULL role is refused up front.
- `decline_with_carriers(p_sub, p_carrier_ids[], p_reason?)` — the **old** overload, same actor rules as `dispose_submission`. Writes one `carrier_declines` row per carrier id, with `kind` from `classify_decline_reason`, then disposes the lead as `declined` in the same call. Refuses once `placement_rule_enabled()` is true.
- `decline_with_carriers(p_sub, p_imo_carrier_ids[], p_kind, p_reason?)` — the **new** overload, added 2026-10-05.
  - Takes `imo_carriers` ids and `p_kind` (`carrier_rejected`/`fixable`, required). Each row records `imo_id`, `carrier_id` and `kind`.
  - Refuses inactive links, and the same carrier under two IMOs in one call.
  - Disposes exactly like the old one.
- `archive_submission(p_sub, p_reason?)` / `unarchive_submission(p_sub)` — manager/admin only.
- `reject_assignment(p_sub, p_reason?)` — validator only, on their own assignment. Returns the lead to `pending_manager`, increments `rejection_count`.
- `hold_submission(p_sub)` — the assigned validator only, while `in_review`. Enforces `max_holds` from `app_config` (0 = unlimited) and raises once reached. Releases the claim (`claimed_at=null`, back to `'assigned'`) without losing the assignment; reopening restarts the full window.
- `set_validator_fields(p_sub, p_final_carrier_id, p_agent_name, p_policy_number, p_agency_name default null, p_imo_name default null)` — the **rule-off** overload, used by the app live today (6 arguments since 2026-10-07; the 4-argument form was dropped so a short call is not ambiguous). Also writes the typed `submissions.agency_name` / `imo_name` columns (added 2026-10-07, migration `20261007110000_free_text_agency_imo.sql`; plain text, not the `agency_id`/`imo_id` FKs; synced to Sheets as `Placement Agency` / `Placement IMO` since 2026-10-07, migration `20261007120000_sheet_sync_agency_imo.sql`, which adds both keys to `sheet_sync_row` and `sync_submission_to_sheet` and to `notify_sheet_sync`'s change check). `dispose_submission` on accept, rule off, now requires agency, IMO, carrier, agent name and policy number. Manager/validator/admin/`general_manager`. Validates the carrier id is active if provided. Callable at any stage, not gated to `in_review`. Once `placement_rule_enabled()` is true it raises "This screen is out of date. Refresh the page and try again."
- `set_validator_fields(p_sub, p_agency_id, p_imo_id, p_final_carrier_id, p_agent_id, p_policy_number, p_acknowledge_warning default false)` — the **new** overload, added 2026-10-05 as 6 arguments and given `p_acknowledge_warning` on 2026-10-06 (the 6-argument version was dropped; nothing live called it). Same roles, but a validator only on a lead assigned to them.
  - It validates the chain: agency active; IMO linked to the agency; carrier linked to the IMO; agent exists and is active (no link to IMO or carrier). A value the lead already holds is always accepted.
  - It refuses a placement conflict (`Blocked: …`) unless the lead is closed.
  - It also refuses a same-IMO warning (`Warning: … Tick "I understand" to continue.`) unless `p_acknowledge_warning` is true. Closed leads skip both.
  - It sets `agent_name` from the agent, except on a closed lead that already has one.
  - Its `validator_fields_set` event carries `placement_warning` (text or null) and `warning_acknowledged`.
  - It does not depend on the switch.
- `placement_rule_enabled()` — added 2026-10-05. Returns `app_config.placement_rule_enabled = 'true'`; it is `'false'` until go-live. It's read by the old overloads and `dispose_submission`.
- `classify_decline_reason(p_reason)` — added 2026-10-05, `IMMUTABLE`. Reads free-text reasons, fixable words first: `fixable` (account/bank/card/premium/SSN/identity/phone/beneficiary), `carrier_rejected` (underwriting/medical/ineligible/age/dupe/declined/coverage/already/state), else `unclassified`. Used for the backfill and by the old decline overload.
- `placement_conflict(p_sub, p_imo, p_carrier)` — added 2026-10-05. **Internal**: EXECUTE is revoked from `authenticated`. It returns null when allowed, otherwise the human-readable reason. Customers are matched by `ssn_normalized`, or by the lead itself when there's no SSN. Only `carrier_rejected` rows count. **Only a same-carrier match blocks**, under any IMO (revised 2026-10-06; a same-IMO match used to block too, and is now `placement_warning`). An override for this lead and this pair lets it through.
- `placement_warning(p_sub, p_imo, p_carrier)` — added 2026-10-06. **Internal**: EXECUTE is revoked from `authenticated`. It returns null, or the text of a warning when this customer has a `carrier_rejected` decline at the same IMO for a **different** carrier. Only rows that name an IMO can warn, so declines from before IMOs existed never do. Overrides don't affect it.
- `placement_blocks(p_sub)` — added 2026-10-05, `jsonb {rejections, overrides}`. This is what the dropdowns grey out. Manager/admin/`general_manager` can call it, and a validator only for their assigned lead.
- `record_carrier_rejection(p_sub, p_imo_carrier_id, p_reason?)` — added 2026-10-05, manager/admin, **closed leads only**. Inserts a `carrier_rejected`/`after_submit` row. Doesn't change the lead.
- `override_placement_block(p_sub, p_imo_id, p_carrier_id, p_reason)` — added 2026-10-05, admin only; widened on 2026-10-06 to **admin or `general_manager`** (`is null or not in` guard, EXECUTE revoked from `anon`). The reason is required. Writes `placement_overrides` (with `overridden_by`) and a `placement_override` form event whose detail includes `by_role`.
- `placement_upsert_item(p_kind, p_id?, p_name?, p_active?, p_sort_order?, p_npn?)` — added 2026-10-04, admin only (`is distinct from` guard, EXECUTE revoked from `anon`). `p_kind` is `agency`/`imo`/`agent`. No `p_id` adds a row (name required, appended to the end of the order); with `p_id`, omitted arguments keep their value. `p_npn` is agents only; an empty string clears it. A duplicate name raises `a <kind> named "<name>" already exists`. Writes `settings_audit` (`key = placement.<kind>:<id>`, before/after row as JSON).
- `placement_set_link(p_kind, p_parent, p_child, p_active)` — added 2026-10-04, admin only. Creates or toggles one link: `agency_imo` (agency → IMO), `imo_carrier` (IMO → carrier). Writes `settings_audit`.
- `parse_lead_date(p_text, p_from default current_date)` — added 2026-09-17, `IMMUTABLE`. One draft-date string as a date, or null. Accepts `YYYY-MM-DD`, `MM/DD/YYYY`/`M/D/YY`, `Nth of the month` and `Nth <weekday> of the month` (returning the first occurrence on or after `p_from`, searching up to a year ahead so a 5th Wednesday resolves). Pattern-matched and built with `make_date`, so `DateStyle` cannot change its answer; unrecognised text — `Every 2nd Friday` — is null rather than a guess.
- `next_monthly_day(p_day, p_from default current_date)` — added 2026-09-17, `IMMUTABLE`. Day N of this month if still to come, else next; clamped to the month's length, so "31st" in February is the 28th/29th.
- `normalize_ssn(p_text)` — added 2026-09-17, `IMMUTABLE`. The digits-only-and-exactly-nine rule, extracted so `submit_form_internal`, `ingest_sheet_lead` and `update_payload_field` share one definition.
- `roll_recurring_draft_dates()` — cron only, added 2026-09-17. See the scheduled jobs table.
- `expire_stale_reviews()` — no role check (called only by `pg_cron`, not exposed to the client as something a role would invoke meaningfully). Runs every minute; moves any `in_review` row whose `claimed_at` has exceeded `review_window()` to `returned_timeout`, tagging `last_timeout_by`.

**Payload / data-quality**
- `update_payload_field(p_sub, p_field, p_value)` — closing_manager/general_manager/manager/admin, plus **cxa/cxm** (2026-09-16), who must additionally pass `cx_pipeline_member(p_sub)` so a CX agent can only correct a lead on their own queue. Refuses `ID`/`Submitted By Role` (system-stamped) and archived leads. Re-derives the mirrored column when the edited field is `Draft Date`, `Future Draft Date` or `SSN Number` (2026-09-17) — writing the payload alone left a correction invisible to every date filter and the duplicate check, which is exactly how the bug was found. Writes one `payload_edits` row with old/new value per call — this is the **only** write path to `submissions.payload`; there is no RLS policy that lets any role update it directly (see [decisions/0002](decisions/0002-payload-writes-via-rpc.md)).
- `clear_data_flag(p_sub, p_field)` — manager/admin/**data_uploader**. Removes one entry from the `data_flags` jsonb array by field name. (The data_uploader grant appears unused by the current UI — see the audit summary's "unclear" section.)
- `cx_set_placement_fields(p_sub, p_agent_name, p_policy_number, p_final_carrier_id default null)` — cxa/cxm/admin (added 2026-10-07), scoped by `cx_pipeline_member(p_sub)`. Writes only `final_carrier_id`, `agent_name`, `policy_number` (carrier must be active unless unchanged); leaves `agency_id`/`imo_id`/`agent_id` alone and skips the placement rule. Logs `cx_placement_fields_set` to `form_events`. Migration `20261007100000_cx_set_placement_fields.sql`.
- `update_payment_field(p_sub, p_field, p_value)` — manager/admin, plus **general_manager** (added 2026-10-10, `20261010110000_missing_bank_info.sql` — so the Missing bank information section works for them; bank fields only, card credentials still admin only), plus **cxa/cxm** (2026-09-16, scoped by `cx_pipeline_member(p_sub)`), for bank fields (`payment_type`, `bank_name`, `routing_number`, `account_number`, `account_title`, `card_exp`); **admin only** for `card_number`/`cvv` — the one card check refuses every non-admin role, CX included. Auto-derives `card_last4` when `card_number` changes. Creates the `payment_details` row on first write if none exists.

**Payment reads**
- `payment_summary(p_sub)` — admin, manager, closing_manager, general_manager, validator (only their own assignment), **cxm/cxa** (only if `cx_pipeline_member(p_sub)`). Returns bank fields + `card_last4`, never the number.
- `card_details(p_sub)` — admin, or the assigned validator while the lead is `in_review`. Returns the full card + CVV, and **always** writes a `card_access_log` row first.
- `purge_payment_data()` — cron only. Nulls `cvv` once the lead is disposed or `cvv_purge_days` old (whichever first); nulls `card_number` once `card_purge_days` past disposal or creation.

**CX lifecycle**
- `cx_pipeline_member(p_sub)` — added 2026-09-16, `STABLE SECURITY DEFINER`, returns whether a lead is on the CX pipeline (`archived_at is null and cx_removed_at is null and (disposition='accepted' or reopened_from_cx_at is not null)`). The single definition of pipeline membership that every CX RPC guards on; the RLS policy repeats the predicate inline because a policy on `submissions` must not call a function that reads `submissions`.
- `set_cx_status(p_sub, p_category, p_option_id, p_reason?)` — cxa/cxm/admin, on any `cx_pipeline_member` lead (so statuses stay settable while a lead is out for re-validation). No-ops if the value is unchanged and no new reason. Writes `cx_lead_status` (upserted) and a `cx_status_history` row. **As of 2026-09-12, never touches `submissions`** for any of the four categories, policy included — it used to auto-reopen the lead on a policy decline/withdrawal/cancellation; that side effect moved to `return_lead_for_validation` below so a status change and returning the lead are separate actions.
- `return_lead_for_validation(p_sub, p_reason?)` — cxa/cxm/admin, only on a lead `disposition='accepted'`, not archived and not CX-removed (raises `'lead is not in the customer pipeline'` otherwise — same wording `set_cx_status` uses; that strict guard is also what makes a second send impossible while the lead is already out). The explicit action that hands a lead back to the manager — as of 2026-09-16 it does **not** take the lead off the CX pipeline, which keeps it via `reopened_from_cx_at` — regardless of what its four CX statuses currently read: `status='pending_manager'`, `disposition`/`disposed_*`/`assigned_*`/`final_carrier_id`/`agent_name`/`policy_number` all cleared, `reopened_from_cx_at` stamped, one `form_events` row (`reopened_from_cx`).
- `remove_from_cx_pipeline(p_sub, p_reason?)` — added 2026-09-16. cxa/cxm/admin, on any `cx_pipeline_member` lead. Stamps `cx_removed_at`/`cx_removed_by` and writes a `cx_removed` `form_events` row. The CX team's own housekeeping, **not** an archive: every other queue, view and report still sees the row, and none of the columns `notify_sheet_sync()` watches change, so no Sheets write fires.
- `restore_to_cx_pipeline(p_sub)` — added 2026-09-16. **admin only.** Clears both columns and writes a `cx_restored` event; raises `'lead was not removed from the customer pipeline'` if there was nothing to undo.
- `add_submission_tag(p_sub, p_tag)` / `remove_submission_tag(p_sub, p_tag)` — cxa/cxm/admin, **plus manager/general_manager (added 2026-09-25)**, only on accepted/non-archived leads. `closing_manager` is deliberately not included — no UI mount offers it either.

**Spreadsheet import**
- `start_lead_import(p_file_name, p_row_count)` — data_uploader/admin. Opens a `lead_imports` batch row.
- `ingest_sheet_lead(p_payload, p_source_ref, p_uploaded_by?, p_import_id?, p_flags?, p_payment?)` — idempotent on `source_ref` (returns the existing row if already ingested rather than duplicating). Inserts with `status='pending_import_approval'`, `source='sheet'`, `closer_id=null`. Writes `payment_details` in the same call if `p_payment` is given. **As of 2026-09-17 it also derives `draft_date`, `future_draft_date` (via `parse_lead_date`) and `ssn_normalized` (via `normalize_ssn`)** — it set none of the three before, which is why every uploaded lead had a blank Draft Date column, never appeared on the By Draft Date desk, and was invisible to `check_duplicate_ssn`.
- `bump_import_skipped(p_import_id, p_count)` — increments a batch's `skipped_count`.
- `approve_import_batch(p_import_id, p_reject_ids[]?)` / `reject_import_batch(p_import_id, p_reason?)` — manager/admin. Approve moves every non-rejected row in the batch to `pending_manager`; any explicitly rejected ids (or, for `reject_import_batch`, the whole batch) are archived instead.
- `my_forwarded_leads()` — returns the calling closer's own leads with every sensitive payload key stripped (`SSN Number`, `Routing Number`, `Account Number`, `Card Number`, `CVC`, `CVV`, `Exp Date`) — stripped in SQL, not in the client, so there is no path for those keys to reach the browser for this screen even by mistake. **Changed 2026-09-19**: gained `transfer_client_name`, so a closer can see which client their own External Transfer went to. The stripping is untouched. Because the return type changed, the function is dropped and recreated rather than replaced.
- `resolve_carrier(p_input text)` — `STABLE`, matches free text against `carriers.name` or `.aliases`, case/punctuation-insensitive. (Whether this is actually invoked from the client's own normalizer or only from server-side ingestion was not confirmed in this audit — the client-side `src/lib/normalize/` is documented as pure/no-I/O, so if it duplicates this matching logic in JS rather than calling this RPC, the two could in principle drift. Flagged for follow-up.)

**Settings / admin**
- `admin_settings()` — admin only. Returns the six configurable keys from `app_config` as one object.
- `set_admin_setting(p_key, p_value)` — admin only, allow-listed keys (`review_timeout_enabled`, `review_timeout_minutes`, `max_holds`, `reporting_retention_days`, `cvv_purge_days`, `card_purge_days`), with validation per key (e.g. `cvv_purge_days` capped at 30, `review_timeout_minutes` ≥ 1). Writes a `settings_audit` row with old/new value.
- `review_window()` / `review_settings()` — read `review_timeout_enabled`/`review_timeout_minutes`; `review_window()` returns `interval '100 years'` when the timeout is disabled (rather than special-casing "disabled" everywhere it's compared against).
- `reporting_since(p_days)` — `INVOKER`, pure date arithmetic in `America/Los_Angeles`, no role check (it computes a boundary, not a query).
- `reporting_retention_status()` — admin only. Reads `cron.job_run_details` for the `purge-reporting-leads` job's last run, and counts how many rows that run archived.
- `purge_old_reporting_leads()` — cron only. Archives `closed` leads whose `disposed_at` is older than `reporting_retention_days` (skipped entirely if that setting is `0`).
- `set_crm_suspension(p_suspended, p_duration_minutes?, p_message?)` — admin only (added 2026-09-29). `p_suspended=true` sets `crm_suspension.suspended=true` and `resumes_at = now() + p_duration_minutes` (or `null` for indefinite when `p_duration_minutes` is omitted); `p_suspended=false` clears both. `p_message` defaults to "The system is temporarily suspended for maintenance." when blank. Writes a `settings_audit` row (`key='crm_suspension'`). See [decisions/0008](decisions/0008-crm-suspension-via-my-role.md).
- `clear_expired_suspension()` — cron only, `EXECUTE` revoked from `anon`/`authenticated`. Flips `crm_suspension.suspended` back to `false` once `resumes_at` has passed — cosmetic consistency for the admin's own Settings view; `my_role()` compares `resumes_at` to `now()` directly and never waits on this tick.

**Sales reporting (added 2026-09-27)** — see [features/sales-breakdown.md](features/sales-breakdown.md).
`sales_breakdown_range`/`sales_closer_leaderboard_range` were admin-only until
**2026-10-02** (`20261002110000_reporting_manager_grants.sql`), which widened
both guards to `my_role() is null or my_role() not in ('admin','reporting_manager')`
— converted from `language sql` to `language plpgsql` to hold the check, the
query in each is otherwise unchanged — so the new `reporting_manager` role's
Sales Breakdown tab can call them. `sales_plan_type_bucket`/`sales_resolve_carrier`/
`sales_resolve_state` were untouched (no role check either before or after).
- `sales_breakdown_range(p_days, p_start_date, p_end_date)` — admin or reporting_manager. Same `reporting_window`-driven scope as `submission_totals_range` (`disposition = 'accepted' and archived_at is null`), returning one `'total'` row plus one row per resolved carrier and per resolved state (`dimension`, `label`, `level_count`/`graded_count`/`mod_count`/`gi_count`/`unspecified_count`/`total_count`). Replaces the client-side aggregation `SalesBreakdown` (`src/components/sales-breakdown.tsx`) used to do by paging every accepted lead's full payload into the browser (measured 386 rows / 393 kB live on 2026-09-18, tracked in [TODO.md](TODO.md)).
- `sales_closer_leaderboard_range(p_days, p_start_date, p_end_date)` — admin or reporting_manager. Same scope as the closer leaderboard the client used to compute: `closer_id is not null`, `submitted_by_role <> 'validator'` (excludes a validator's own auto-accepted self-submissions, which would otherwise show every validator as a 100%-conversion "closer"), `archived_at is null`. Returns `(closer_id, closer_name, accepted, total)` per closer.
- `sales_plan_type_bucket(p_raw text) returns text` — pure, no role check. SQL reimplementation of `src/lib/plan-type.ts`'s `normalizePlanType`: substring match on `MOD`/`LEVEL`/`GRADED`, then an exact match on `GI` with dots stripped, else `'Unspecified'`.
- `sales_resolve_carrier(p_final_carrier_name text, p_payload jsonb) returns text` — `STABLE`, no role check (reads only whatever `carriers` rows the caller's own RLS permits). Reimplements `sales-breakdown.tsx`'s `resolveCarrier`: the final-carrier name wins if present; else `coalesce(payload->>'Proposed Carrier', payload->>'Agency')` is matched exactly against `carriers.name` (checked first) then `carriers.aliases`, using the same non-alphanumeric-stripped lowercase key `src/lib/normalize/carriers.ts`'s `carrierKey` computes; failing that, the longest registered name/alias (≥4 characters) that the lead's key **starts with** wins (mirrors the file-local `prefixMatchCarrier`, deliberately not shared with the stricter upload-import pipeline); failing that, the raw text itself, whitespace-collapsed.
- `sales_resolve_state(p_payload jsonb) returns text` — pure, no role check. Reimplements `resolveState`: checks `'State'`, `'Residential State'`, `'Birth State'` in order, returning the first field with either a recognized 2-letter abbreviation or a full state name (case-insensitive); a present-but-unrecognized value falls through to the next field rather than stopping; `'Unspecified'` if none resolve.

All five have `EXECUTE` revoked from `anon`; the two top-level RPCs guard with `my_role() is null or my_role() not in ('admin','reporting_manager')` (originally `my_role() is distinct from 'admin'`, widened 2026-10-02).

**Google Sheets sync (added/changed 2026-09-10)** — see the `notify_sheet_sync` entry under Triggers below for the full story.
- `sync_submission_to_sheet(p_sub uuid) returns bigint` — no role check (called only by the trigger and the retry job, never by a client). Re-reads the submission fresh, builds the same payload `notify_sheet_sync` always has, posts it with a 45s timeout, returns the `pg_net` request id (or `null` if sync isn't configured or the row doesn't exist). **Updated 2026-09-15** (`20260915121000`): the `final_carrier` field now falls back to `payload->>'Agency'` when `final_carrier_id` is null *and* `submitted_by_role = 'validator'`. Those submissions auto-accept on submit and so never pass through `set_validator_fields`, which left the Sheet's `Final Carrier` column blank on all 260 of them — even though their `Agency` value *is* the final carrier and matches a real `carriers` row. The fallback is gated on the role deliberately: on a closer/uploaded lead the payload only holds a *proposed* carrier, and letting it through would report a pitch as an issued policy.
- `retry_failed_sheet_syncs() returns integer` — cron only. Resolves `sheet_sync_attempts` rows whose response was `200`, retries unresolved ones past a 3-minute grace period (max 3 attempts), gives up past that.

## Triggers

| Table | Trigger | Fires | Function |
|---|---|---|---|
| `profiles` | `guard_last_admin_trg` | `BEFORE UPDATE` | `guard_last_admin()` |
| `submissions` | `sheet_sync_on_insert` | `AFTER INSERT` | `notify_sheet_sync()` |
| `submissions` | `sheet_sync_on_closed` | `AFTER UPDATE` | `notify_sheet_sync()` |

`notify_sheet_sync()` is more permissive than its name suggests: on **insert**
it always fires (for `source <> 'sheet'` rows — imported leads never sync this
way); on **update** it fires whenever `disposition`, `status`, `archived_at`,
`payload`, `final_carrier_id`, `agent_name`, or `policy_number` changes, *or*
when the status transition involves `'parked'` on either side (parking or
releasing a lead is the one pure-queue-movement case that still has to sync,
because the sheet would otherwise claim a manager has a lead that is actually
parked).

**The actual downstream path, confirmed 2026-09-10** (previously flagged as
unverified in this doc): `app_config.sheet_sync_url` points at the deployed
**`sheet-sync` Edge Function**, not at Apps Script directly. That function
checks the `x-sync-secret` header, reshapes the payload into the flat row
shape Apps Script expects (`Submission ID`, `Status`, `Disposition`, etc.),
then does its own `fetch()` to the actual Apps Script web app URL — **with no
timeout of its own**. Apps Script's `doPost` handler (its real source was
shared directly) **upserts by `Submission ID`** — it looks for an existing
row with a matching id and updates it in place, only appending a new row if
none is found — and holds a lock for up to 30 seconds under concurrent
requests. So there are two hops with independent failure modes: Postgres →
Edge Function, and Edge Function → Apps Script.

**Fixed in two stages, 2026-09-10:**
1. `supabase/migrations/20260910200000_sheet_sync_timeout.sql` — the
   Postgres → Edge Function `net.http_post` call had no `timeout_milliseconds`
   argument, so it silently used `pg_net`'s default of 5000ms. Reading
   `net._http_response` (`pg_net`'s own response log) showed roughly 4 in 10
   attempts timing out at almost exactly that wall — this was the direct
   cause of a mismatch between the CRM's submission counts and the Google
   Sheet's row counts, since a timed-out sync had no retry and was simply
   lost with nothing recorded anywhere.
2. `supabase/migrations/20260910210000_sheet_sync_retry.sql` — raised the
   timeout further to **45000ms** (the 30-second Apps Script lock alone can
   exceed the first fix's 20s), extracted the network call into
   `sync_submission_to_sheet(p_sub uuid)` so it can be reused, and added real
   retry logic (below). Retrying is safe specifically *because* Apps Script's
   own handler upserts by `Submission ID` — re-sending a submission can never
   create a duplicate row.

**SUPERSEDED 2026-09-17 by a durable queue** (`20260917100000`,
`20260917110000`). The retry mechanism described below no longer runs; its cron
job `retry-sheet-sync` is unscheduled. `sync_submission_to_sheet()` and
`retry_failed_sheet_syncs()` remain defined but unused, so the change can be
reverted by pointing `notify_sheet_sync` back at the former.

**Why it was replaced.** Fire-on-trigger could not survive concurrency. Measured
on this project, firing N syncs at once failed ~20% of the time at N=5, ~30% at
N=20 and **~61% at N=59** — Google rejects concurrent requests to an Apps Script
web app (as 404s, or as HTTP 200 carrying an HTML error page), and the script
serialises itself on a 30-second `LockService` lock regardless. Thirteen leads
had never reached Sheets at all, four of them completed sales. The retry made it
worse in two ways: it abandoned a row permanently after 3 attempts (`gave_up`,
surfaced to nobody), and it retried by looping over every pending attempt firing
each one — recreating the burst that caused the failure. `pg_net` batches its
dispatch, so this could not be paced from SQL: `pg_sleep` between calls does
nothing, because the worker collects whatever is queued and fires it together.

**The queue** (`sheet_sync_queue`, keyed by `submission_id`):
- `notify_sheet_sync()` no longer makes HTTP calls. Every guard about *whether*
  to sync is unchanged; it upserts into the queue instead. The primary key is
  load-bearing — a lead whose status changes four times before the drain runs
  collapses into **one** row and **one** write carrying the final state.
- `drain_sheet_sync_queue(p_limit)` (cron `drain-sheet-sync`, every minute)
  sends up to 25 rows as **one** `net.http_post` (120s timeout), not 25
  requests. `sheet-sync` v13 accepts `{rows:[...]}` and walks them
  **sequentially**, so Apps Script only ever sees one request at a time. It
  refuses to start a second batch while one is in flight — added in
  `20260917110000` after the first live burst showed a 25-row batch outrunning
  the 60-second cron interval, letting two batches overlap and reintroducing the
  very concurrency the design removes.
- `resolve_sheet_syncs()` (cron `resolve-sheet-sync`, every minute) reads the
  per-row `results` array back, so one bad row in a batch of 25 retries one row
  rather than 25. A row is **only ever deleted on confirmed success**; anything
  else gets `attempts + 1` and exponential backoff (30s, 1m, 2m … capped at 1h).
  **There is no give-up path** — a permanently abandoned row is precisely the
  silent loss this replaced. A stuck row stays visible in the queue instead.
- `sheet_sync_backlog` (view) exposes depth, in-flight count, rows at
  `attempts >= 5`, the age of the oldest item, and a sample error. Counts and
  an error string only, never lead data. A queue nobody watches is the same
  failure as a silent drop.
  **Corrected 2026-09-17 — this previously read "`select` granted to
  `authenticated`", and that grant was a leak.** The view does not set
  `security_invoker`, so it runs as its owner and bypasses the zero-policy RLS
  on `sheet_sync_queue`; combined with Supabase's default grants it was
  readable by **`anon`**, verified returning `queued = 13` with no JWT. Both
  grants are now revoked and the view is SQL/ops-only.
- `sheet_sync_backlog_status()` — **admin only**, the sole client path to those
  numbers, backing the Overview card. Guarded with
  `my_role() is distinct from 'admin'`, **not** `<>` — see the warning under
  the RPC list.

**Verified live on rollout**: a 60-lead burst — the scenario that previously
lost ~60% — drained to zero with no permanent failures, including six rows that
failed to the overlapping-batch bug and recovered on retry.

`sheet_sync_attempts` is retained for history; nothing writes to it now.

Rows missing from the sheet before 2026-09-10 are still a separate, not-yet-done
backfill (discussed as a manual export, not an automated reconciliation, since
nothing in this app reads the sheet back to diff against it).

## Scheduled jobs (`pg_cron`)

| Job | Schedule | Runs |
|---|---|---|
| `expire-reviews` | every minute (`* * * * *`) | `expire_stale_reviews()` |
| `purge-payment-data` | daily 03:17 | `purge_payment_data()` |
| `purge-reporting-leads` | daily 04:11 | `purge_old_reporting_leads()` |
| `retry-sheet-sync` | every 5 minutes (`*/5 * * * *`) | `retry_failed_sheet_syncs()` — added 2026-09-10 |
| `roll-recurring-draft-dates` | daily 05:23 | `roll_recurring_draft_dates()` — added 2026-09-17. Moves a lead whose `draft_date` has passed and whose payload text is a recurrence ("3rd of the month") to its next occurrence. An explicitly typed date does not match those patterns and is never moved. See [decisions/0006](decisions/0006-recurring-draft-dates-resolved.md). |
| `clear-expired-suspension` | every minute (`* * * * *`) | `clear_expired_suspension()` — added 2026-09-29. Cosmetic sweep only; see [decisions/0008](decisions/0008-crm-suspension-via-my-role.md). |

## Edge Functions

Five, all deployed; source for `invite-user`, `ingest-sheet-lead` and
`sheet-sync` is **not** in this repository (only visible server-side in
Supabase) — `voice-clone-proxy` and `ingest-center-lead`'s source lives in
this repo, at `supabase/functions/voice-clone-proxy/index.ts` and
`supabase/functions/ingest-center-lead/index.ts`. Confirmed to exist and
their JWT-verification setting via the Supabase API:

| Function | `verify_jwt` | Called from |
|---|---|---|
| `invite-user` | `true` | `src/components/user-admin.tsx` (`supabase.functions.invoke("invite-user", ...)`). **Hardcodes its own `VALID_ROLES` allow-list** (fetched live 2026-10-02) — kept in sync with `app_role` by hand, not read from the enum. Had drifted once already (comment in the source notes it used to block `closing_manager`/`general_manager`/`data_uploader`/`cxm`/`cxa`); `reporting_manager` was added to the list and the function redeployed (v6) as part of adding that role, so the invite flow would otherwise have 400'd on it with "role must be one of …". Any future new role needs the same manual addition here. |
| `ingest-sheet-lead` | `false` | Not called from this client codebase at all — invoked externally (the batch-of-50/200 ceiling described in `CLAUDE.md` implies an external importer or Apps Script calls this directly with the service key, then it presumably calls the `ingest_sheet_lead` RPC per row). Not independently confirmed in this audit. |
| `ingest-center-lead` | `false` | **Added 2026-10-01.** Not called from this client codebase — invoked externally, by a center's own CRM, authenticated with the `x-api-key` header (see `center_api_keys`/`admin_generate_center_api_key` above) rather than a Supabase JWT. Calls `submit_external_lead` with the service-role key. See [features/closer-submission-and-forms.md](features/closer-submission-and-forms.md). |
| `sheet-sync` | `false` | Not called from the client; reached only via `sync_submission_to_sheet()`'s `net.http_post` (called from the `notify_sheet_sync()` trigger and from `retry_failed_sheet_syncs()`). **Source read directly 2026-09-10**: it validates `x-sync-secret`, reshapes the payload, then itself calls out to an Apps Script web app URL (`APPS_SCRIPT_URL`/`APPS_SCRIPT_SECRET` env vars) with no timeout of its own, and only responds to Postgres once that call resolves. Apps Script's own `doPost` (source also confirmed directly) upserts by a `Submission ID` field and holds a lock for up to 30s under concurrent requests — see the `notify_sheet_sync` entry under Triggers. **v12, 2026-09-15 — a 200 from Apps Script does not mean the row was written.** An Apps Script web app answers `200` even when `doPost` threw, with its HTML error page as the body instead of the `'ok'` the handler returns on success. Checking `res.ok` alone therefore logged every exception as a successful sync, wrote `resolved_status = 'ok'` to `sheet_sync_attempts`, and left the retry job with nothing to retry — which is how uploaded leads went missing silently. `appsScriptFailure()` now inspects the body for the three failure shapes that arrive as 200 (an HTML page, any `Exception:` text, or the literal `unauthorized` on a secret mismatch) and returns `502`, so the attempt is recorded honestly and `retry_failed_sheet_syncs` picks it up. It also logs just the extracted `Exception:` line rather than ~8KB of Google's CSP shim. |
| `voice-clone-proxy` | `true` | **Superseded 2026-09-28, left deployed but unused.** Added 2026-09-23 to front the same external tool this described; the admin tab now proxies the tool's whole interface through the Cloudflare Worker itself (`src/lib/voicebox.ts`, `src/server.ts`) instead of calling this function for one endpoint — see `docs/features/voice-clone-studio.md`. Nothing in the app calls `supabase.functions.invoke("voice-clone-proxy", ...)` anymore. |

## Row-Level Security summary

Every table has RLS **enabled**. Policy count per table, condensed:

> **Every policy wraps its role check as `(select my_role())`, never a bare
> `my_role()`** — likewise `(select auth.uid())`. This is not cosmetic. A bare
> call in a policy predicate is executed **once per candidate row**; an
> uncorrelated scalar subquery becomes an InitPlan evaluated once per query.
> Since `my_role()` is `SECURITY DEFINER` and does a `profiles` lookup plus a
> JWT parse, the bare form cost ~6 µs per row per call site and made every
> query scale linearly with table size. Applied 2026-09-17 in
> `20260917120000_rls_initplan_wrap_role_checks.sql`; the manager queue query
> went from 14.8 ms to 1.3 ms. **Any new or edited policy must keep the
> wrapping** — the check is that no policy body in `public` contains
> `my_role()` or `auth.uid()` not immediately preceded by `SELECT`.

- **Direct client write policies** (corrected 2026-09-25 against the live
  policies — this previously named only `profiles`, `carriers`, `centers`
  and `transfer_clients`, missing `cx_tags`): `profiles`, the three
  admin-only vocabulary tables `carriers`, `centers` and `transfer_clients`
  (each `FOR ALL` with `USING/CHECK (select my_role()) = 'admin'`), and
  `cx_tags` (`FOR ALL`, `admin` **or** `cxm` — the one vocabulary table a
  non-admin role can write directly, so a CXM can add a new tag, e.g. a
  further duplicate-SSN exemption, without an admin). No *lead* table has
  one — `submissions` has zero write policies of any kind, see
  [decisions/0002](decisions/0002-payload-writes-via-rpc.md).
- **Read policies**, one per table, role-scoped via `(select my_role())`:
  - `submissions` — the single most complex policy in the schema, one `CASE`
    per role (admin sees all; manager sees everything except `parked`;
    `closing_manager` sees only closer-originated, non-archived leads whose
    `center_id` matches their own `profiles.center_id`; `general_manager` sees
    closer- and validator-originated non-archived leads across every center;
    `validator` sees only their own current assignment, inside the review
    window; `data_uploader` sees only `uploaded_by = self`; `cxm`/`cxa` see
    the CX pipeline — non-archived, not CX-removed leads that are either
    accepted or carry `reopened_from_cx_at` (2026-09-16: widened from
    "accepted only", so a lead sent back for re-validation stays visible to
    the CX team); `reporting_manager` (added 2026-10-02) gets the identical
    predicate `general_manager` does — business-wide, not center-scoped —
    which is what lets `submission_totals_range`/`submission_totals_by_center_range`
    (both `SECURITY INVOKER`, read straight through this policy) and the
    direct `openQueue` select in `useOverviewStats` return real company-wide
    numbers for this role instead of zeros; everyone else, nothing).
  - Most reference/config/audit tables (`carriers`, `centers`,
    `transfer_clients`, `cx_status_options`, `cx_tags`, `carrier_declines`, `form_events`,
    `payload_edits`, `settings_audit`, `card_access_log`, `cx_lead_status`,
    `cx_status_history`, `submission_tags`) are readable by a fixed,
    hand-listed set of roles — no per-row scoping, since these describe
    vocabulary or an audit trail rather than a specific person's work.
    `cx_tags`/`submission_tags` specifically: `admin/cxm/cxa/manager`, plus
    **`general_manager` (added 2026-09-25)**.
    **`reporting_manager` was added on 2026-10-02 to the read policies on
    `profiles`, `centers`, `carriers` and `form_events`**
    (`20261002120000_reporting_manager_lookup_reads.sql`), the same lists
    `general_manager` sits in. The reporting RPCs are `SECURITY INVOKER`, so
    a join inside them runs under the caller's RLS. Without these grants the
    joins came back empty with no error: "Unnamed closer" on the leaderboard,
    an empty Validators Team Dashboard, "No active centers", and By Carrier
    falling back to raw proposed-carrier text. **When you add a role that
    reads reporting, grant it the joined lookup tables too, not just
    `submissions`.**
  - `lead_imports` — `uploaded_by = (select auth.uid()) OR (select my_role())
    in (manager, admin)`.
  - `crm_suspension` — **the one table readable by literally everyone,
    including `anon`** (`for select using (true)`, no role check at all),
    added 2026-09-29. Deliberate: the blocking message on `/suspended` has to
    reach a session that's already been signed out, or was never signed in.
    See [decisions/0008](decisions/0008-crm-suspension-via-my-role.md).
- **Zero policies at all** (deny-everything to the client, reachable only
  through `SECURITY DEFINER` functions): `app_config`, `payment_details`,
  and — corrected 2026-09-17, this list previously named only the first two —
  `sheet_sync_attempts` and `sheet_sync_queue`. Verified live: an `authenticated`
  session simulating every one of the 58 profiles reads 0 rows from all four,
  the admin included.

See [authentication.md](authentication.md) for how `my_role()` and profile
`active` interact, and [multi-tenancy.md](multi-tenancy.md) for the
`center_id` scoping specifically.
