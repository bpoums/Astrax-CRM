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
| `app_role` | `admin`, `closer`, `manager`, `validator`, `data_uploader`, `cxm`, `cxa`, `closing_manager`, `general_manager` |
| `sub_status` | `pending_manager`, `assigned`, `in_review`, `returned_timeout`, `closed`, `pending_import_approval`, `parked` |
| `disposition_t` | `accepted`, `declined`, `pending` |

`CLAUDE.md` previously listed `sub_status` with only 5 values — the two
newest (`pending_import_approval`, `parked`) support the spreadsheet-import
gate and the External Transfer / parked-lead flow respectively (both already
present in `src/components/ops.tsx`'s `SUB_STATUSES`, just not in the root
doc).

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
| `carrier_declines` | 76 | One row per (submission, carrier) decline, written only by `decline_with_carriers`. |
| `centers` | 2 | The two call centers (UMS BPO, DESCOM). Admin-writable directly. |
| `cx_status_options` | 26 | The configurable vocabulary for the four CX categories. `category` check-constrained to `policy|premium|commission|chargeback`. `tone` check-constrained to `muted|accent|positive|destructive|warning`. |
| `cx_lead_status` | 2 | One row per submission (PK is `submission_id`), four independent status-option pointers (`policy_status_id`, `premium_status_id`, `commission_status_id`, `chargeback_status_id`) each with its own free-text `_reason`. |
| `cx_status_history` | 4 | Append-only log of every `set_cx_status` change: `from_code`/`to_code`/`reason`/`actor_id`. |
| `cx_tags` | 2 | Free-form tag vocabulary for CX leads (`label`, `tone`, `sort_order`, `active`). |
| `submission_tags` | 0 | Many-to-many `submissions` ↔ `cx_tags`, written by `add_submission_tag`/`remove_submission_tag`. Unused in production data so far (0 rows). |
| `payload_edits` | 11 | Before/after value history for `payload` field edits, written exclusively by `update_payload_field`. Distinct from `form_events`' `payload_edited` entries, which only record *that* a field changed, not the values — see `src/components/payload-history.tsx`. |
| `settings_audit` | 10 | Before/after history for `app_config` changes, written by `set_admin_setting`. Admin-only read. |
| `app_config` | 8 | Key/value config store. **No RLS policy at all** — reachable only through `admin_settings()`/`set_admin_setting()`/`review_window()`/`review_settings()`. |
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
reopened_from_cx_at
```

Columns **not** previously documented in `CLAUDE.md`: `cx_assigned_to`,
`cx_assigned_at` (present on the table; not observed written by any RPC read
in this audit — see "Unclear / undocumented" in the audit summary),
`center_id`/`center_name` (stamped at submission — see
[multi-tenancy.md](multi-tenancy.md)), `draft_date`/`future_draft_date`
(parsed out of `payload` at submission time by `submit_form`, as real `date`
columns, so they can be indexed/filtered without a jsonb cast), `ssn_normalized`
(digits-only SSN, populated only when it forms a clean 9 digits — powers
`check_duplicate_ssn`), `final_carrier_id`/`agent_name`/`policy_number` (the
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
dismissal, invisible to every other queue and report).

## Views

| View | Purpose |
|---|---|
| `submission_totals` | One row: `closer_submissions, validator_submissions, offline_submissions, approved, declined, pending, in_review, awaiting_manager, timeouts, rejections`. Excludes archived rows. |
| `submission_totals_by_center` | Same shape, one row per active center. |
| `validator_stats` | Per validator: `assigned, approved, declined, pending, timed_out, rejected, holds`. |
| `carrier_decline_stats` | Per active carrier: `total_declines`, `leads_declined` (distinct submissions), `last_decline`. |
| `submission_declined_carriers` | Per submission that has ≥1 decline: aggregated `declined_carriers` name array, `decline_count`, `last_declined_at`. |
| `pending_import_batches` | Batches still awaiting manager approval, with `lead_count` and `flagged_count` (rows with ≥1 data flag). |
| `cx_pipeline` | Every submission in the CX pipeline — non-archived, `cx_removed_at is null`, and either `disposition='accepted'` or carrying `reopened_from_cx_at` — joined to its four resolved CX status codes/labels/tones. The read model for Customers Pipeline. Also carries `status`, `disposition` and `reopened_from_cx_at` so the table can mark a lead that is out for re-validation. |
| `cx_status_summary` | Per (category, option): `lead_count` across accepted, non-archived leads — feeds the CX coverage card. |
| `cx_untouched` | Accepted, non-archived leads with **no** `cx_lead_status` row, or a row with all four categories null — "nobody on the CX team has looked at this yet." |
| `closer_lead_alerts` | Per closer (`s.closer_id = auth.uid()`), their own leads whose CX status just changed to something toned `destructive`/`warning` — the read model behind `forwarded-leads.tsx`'s alerting. |

The app's TypeScript layer mostly calls **`_range`-suffixed RPC wrappers**
(`submission_totals_range`, `submission_totals_by_center_range`,
`validator_stats_range` — all `SECURITY INVOKER`, so they run under the
caller's own RLS) rather than selecting these views directly; the wrappers add
an optional `p_days` window (via `reporting_since(p_days)`, which computes a
Pacific-timezone day boundary) on top of the same underlying view logic.

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

**Identity / bootstrap**
- `my_role()` — `select role from profiles where id = auth.uid() and active`. The single point every other check reads through; an inactive profile resolves to no role.
- `handle_new_user()` (trigger, on `auth.users` insert) — creates the matching `profiles` row. **Hardcodes** `role := 'admin'` when the new email is exactly `bpoums@gmail.com` (lowercased comparison), else `'closer'`. This is how the first admin account exists — there is no other bootstrap path.
- `guard_last_admin()` (trigger, `BEFORE UPDATE` on `profiles`) — raises if the update would deactivate or demote the last active admin.

**Closer / validator submission**
- `submit_form_internal(p_payload jsonb, p_status sub_status)` — **not a client-facing RPC**; `EXECUTE` is revoked from `anon`/`authenticated` (added 2026-09-12). Holds the actual insert logic shared by the two public wrappers below: stamps `ID` (staff_id) and `Submitted By Role` into the payload, parses `Draft Date`/`Future Draft Date` into real date columns and a digits-only SSN into `ssn_normalized`, and inserts the row with `status = p_status` (or `'pending_manager'` if `p_status` is null) — except a **validator's own submission always auto-closes** regardless of `p_status`: `status='closed'`, `disposition='accepted'`, `disposed_by/at` = self, immediately, in the same insert. Kept unreachable directly so a client can never pass an arbitrary `p_status` and skip the normal `pending_manager` review start state.
- `submit_form(p_payload jsonb)` — closer or validator only. Thin wrapper: `submit_form_internal(p_payload, null)`.
- `submit_form_parked(p_payload)` — closer or validator only. Thin wrapper: `submit_form_internal(p_payload, 'parked')`, then (only for a closer-originated result) writes the `'parked'`/`external_transfer` `form_events` row. A validator submission passes through unchanged (already closed by `submit_form_internal`), since there is nothing to park.
  **Fixed 2026-09-12**: this used to call `submit_form()` (one INSERT, status `pending_manager`) and then `UPDATE ... SET status='parked'` on the same row — two separate writes, each firing its own `sheet_sync_*` trigger, dispatching two outbound HTTP requests to Apps Script within the same transaction with no guaranteed ordering. Apps Script upserts by `Submission ID`, so whichever of the two concurrent requests it finished processing *last* won — occasionally the stale `pending_manager` one — leaving the Sheet showing a status Supabase had already moved past. Routing both `submit_form`/`submit_form_parked` through one shared, single-INSERT `submit_form_internal` means a parked lead now fires exactly one sync, carrying its final status from the start.
- `move_to_validation(p_sub)` — admin or `general_manager` only. Releases a `'parked'` lead back to `'pending_manager'`.
- `check_duplicate_ssn(p_ssn)` — closer/validator/manager/admin. Looks up `ssn_normalized` (excluding archived rows), returns the most relevant existing match's bucket (`accepted`/`declined`/`in_progress`) and `submitted_at`, or `{exists:false}`. Advisory only — never blocks a submission.

**Manager queue**
- `assign_to_validator(p_sub, p_validator)` — manager/admin. Only from `pending_manager`/`returned_timeout`, and only for `submitted_by_role='closer'` (a validator's own submission is never assignable).
- `dispose_submission(p_sub, p_disposition)` — manager/admin any time; a validator only while `status='in_review'`, `assigned_to=self`, and inside `review_window()`. **Accept gate**: if `p_disposition='accepted'` and the lead is closer-originated, `final_carrier_id`/`agent_name`/`policy_number` must all be set or it raises. Accepting sets `status='closed'` (the only terminal state); declining/pending sets `status='pending_manager'` and clears the assignment.
- `decline_with_carriers(p_sub, p_carrier_ids[], p_reason?)` — same actor rules as `dispose_submission`. Writes one `carrier_declines` row per carrier id, then disposes the lead as `declined` in the same call — this is the only path that both records *which* carriers said no and produces the decline outcome.
- `archive_submission(p_sub, p_reason?)` / `unarchive_submission(p_sub)` — manager/admin only.
- `reject_assignment(p_sub, p_reason?)` — validator only, on their own assignment. Returns the lead to `pending_manager`, increments `rejection_count`.
- `hold_submission(p_sub)` — the assigned validator only, while `in_review`. Enforces `max_holds` from `app_config` (0 = unlimited) and raises once reached. Releases the claim (`claimed_at=null`, back to `'assigned'`) without losing the assignment; reopening restarts the full window.
- `set_validator_fields(p_sub, p_final_carrier_id, p_agent_name, p_policy_number)` — manager/validator/admin/`general_manager`. Validates the carrier id is active if provided. Callable at any stage, not gated to `in_review`.
- `expire_stale_reviews()` — no role check (called only by `pg_cron`, not exposed to the client as something a role would invoke meaningfully). Runs every minute; moves any `in_review` row whose `claimed_at` has exceeded `review_window()` to `returned_timeout`, tagging `last_timeout_by`.

**Payload / data-quality**
- `update_payload_field(p_sub, p_field, p_value)` — closing_manager/general_manager/manager/admin, plus **cxa/cxm** (2026-09-16), who must additionally pass `cx_pipeline_member(p_sub)` so a CX agent can only correct a lead on their own queue. Refuses `ID`/`Submitted By Role` (system-stamped) and archived leads. Writes one `payload_edits` row with old/new value per call — this is the **only** write path to `submissions.payload`; there is no RLS policy that lets any role update it directly (see [decisions/0002](decisions/0002-payload-writes-via-rpc.md)).
- `clear_data_flag(p_sub, p_field)` — manager/admin/**data_uploader**. Removes one entry from the `data_flags` jsonb array by field name. (The data_uploader grant appears unused by the current UI — see the audit summary's "unclear" section.)
- `update_payment_field(p_sub, p_field, p_value)` — manager/admin, plus **cxa/cxm** (2026-09-16, scoped by `cx_pipeline_member(p_sub)`), for bank fields (`payment_type`, `bank_name`, `routing_number`, `account_number`, `account_title`, `card_exp`); **admin only** for `card_number`/`cvv` — the one card check refuses every non-admin role, CX included. Auto-derives `card_last4` when `card_number` changes. Creates the `payment_details` row on first write if none exists.

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
- `add_submission_tag(p_sub, p_tag)` / `remove_submission_tag(p_sub, p_tag)` — cxa/cxm/admin, only on accepted/non-archived leads.

**Spreadsheet import**
- `start_lead_import(p_file_name, p_row_count)` — data_uploader/admin. Opens a `lead_imports` batch row.
- `ingest_sheet_lead(p_payload, p_source_ref, p_uploaded_by?, p_import_id?, p_flags?, p_payment?)` — idempotent on `source_ref` (returns the existing row if already ingested rather than duplicating). Inserts with `status='pending_import_approval'`, `source='sheet'`, `closer_id=null`. Writes `payment_details` in the same call if `p_payment` is given.
- `bump_import_skipped(p_import_id, p_count)` — increments a batch's `skipped_count`.
- `approve_import_batch(p_import_id, p_reject_ids[]?)` / `reject_import_batch(p_import_id, p_reason?)` — manager/admin. Approve moves every non-rejected row in the batch to `pending_manager`; any explicitly rejected ids (or, for `reject_import_batch`, the whole batch) are archived instead.
- `my_forwarded_leads()` — returns the calling closer's own leads with every sensitive payload key stripped (`SSN Number`, `Routing Number`, `Account Number`, `Card Number`, `CVC`, `CVV`, `Exp Date`) — stripped in SQL, not in the client, so there is no path for those keys to reach the browser for this screen even by mistake.
- `resolve_carrier(p_input text)` — `STABLE`, matches free text against `carriers.name` or `.aliases`, case/punctuation-insensitive. (Whether this is actually invoked from the client's own normalizer or only from server-side ingestion was not confirmed in this audit — the client-side `src/lib/normalize/` is documented as pure/no-I/O, so if it duplicates this matching logic in JS rather than calling this RPC, the two could in principle drift. Flagged for follow-up.)

**Settings / admin**
- `admin_settings()` — admin only. Returns the six configurable keys from `app_config` as one object.
- `set_admin_setting(p_key, p_value)` — admin only, allow-listed keys (`review_timeout_enabled`, `review_timeout_minutes`, `max_holds`, `reporting_retention_days`, `cvv_purge_days`, `card_purge_days`), with validation per key (e.g. `cvv_purge_days` capped at 30, `review_timeout_minutes` ≥ 1). Writes a `settings_audit` row with old/new value.
- `review_window()` / `review_settings()` — read `review_timeout_enabled`/`review_timeout_minutes`; `review_window()` returns `interval '100 years'` when the timeout is disabled (rather than special-casing "disabled" everywhere it's compared against).
- `reporting_since(p_days)` — `INVOKER`, pure date arithmetic in `America/Los_Angeles`, no role check (it computes a boundary, not a query).
- `reporting_retention_status()` — admin only. Reads `cron.job_run_details` for the `purge-reporting-leads` job's last run, and counts how many rows that run archived.
- `purge_old_reporting_leads()` — cron only. Archives `closed` leads whose `disposed_at` is older than `reporting_retention_days` (skipped entirely if that setting is `0`).

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
- `sheet_sync_backlog` (view, `select` granted to `authenticated`) exposes
  depth, in-flight count, rows at `attempts >= 5`, and the age of the oldest
  item. Counts only, never lead data. A queue nobody watches is the same failure
  as a silent drop.

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

## Edge Functions

Three, all deployed; source is **not** in this repository (only visible
server-side in Supabase). Confirmed to exist and their JWT-verification
setting via the Supabase API:

| Function | `verify_jwt` | Called from |
|---|---|---|
| `invite-user` | `true` | `src/components/user-admin.tsx` (`supabase.functions.invoke("invite-user", ...)`) |
| `ingest-sheet-lead` | `false` | Not called from this client codebase at all — invoked externally (the batch-of-50/200 ceiling described in `CLAUDE.md` implies an external importer or Apps Script calls this directly with the service key, then it presumably calls the `ingest_sheet_lead` RPC per row). Not independently confirmed in this audit. |
| `sheet-sync` | `false` | Not called from the client; reached only via `sync_submission_to_sheet()`'s `net.http_post` (called from the `notify_sheet_sync()` trigger and from `retry_failed_sheet_syncs()`). **Source read directly 2026-09-10**: it validates `x-sync-secret`, reshapes the payload, then itself calls out to an Apps Script web app URL (`APPS_SCRIPT_URL`/`APPS_SCRIPT_SECRET` env vars) with no timeout of its own, and only responds to Postgres once that call resolves. Apps Script's own `doPost` (source also confirmed directly) upserts by a `Submission ID` field and holds a lock for up to 30s under concurrent requests — see the `notify_sheet_sync` entry under Triggers. **v12, 2026-09-15 — a 200 from Apps Script does not mean the row was written.** An Apps Script web app answers `200` even when `doPost` threw, with its HTML error page as the body instead of the `'ok'` the handler returns on success. Checking `res.ok` alone therefore logged every exception as a successful sync, wrote `resolved_status = 'ok'` to `sheet_sync_attempts`, and left the retry job with nothing to retry — which is how uploaded leads went missing silently. `appsScriptFailure()` now inspects the body for the three failure shapes that arrive as 200 (an HTML page, any `Exception:` text, or the literal `unauthorized` on a secret mismatch) and returns `502`, so the attempt is recorded honestly and `retry_failed_sheet_syncs` picks it up. It also logs just the extracted `Exception:` line rather than ~8KB of Google's CSP shim. |

## Row-Level Security summary

Every table has RLS **enabled**. Policy count per table, condensed:

- **Direct client write policy**: `profiles` only (`admin manages profiles`,
  `FOR ALL`, `USING/CHECK my_role() = 'admin'`). Nothing else has one — see
  [decisions/0002](decisions/0002-payload-writes-via-rpc.md).
- **Read policies**, one per table, role-scoped via `my_role()`:
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
    the CX team); everyone else, nothing).
  - Most reference/config/audit tables (`carriers`, `centers`,
    `cx_status_options`, `cx_tags`, `carrier_declines`, `form_events`,
    `payload_edits`, `settings_audit`, `card_access_log`, `cx_lead_status`,
    `cx_status_history`, `submission_tags`) are readable by a fixed,
    hand-listed set of roles — no per-row scoping, since these describe
    vocabulary or an audit trail rather than a specific person's work.
  - `lead_imports` — `uploaded_by = auth.uid() OR my_role() in (manager, admin)`.
- **Zero policies at all** (deny-everything to the client, reachable only
  through `SECURITY DEFINER` functions): `app_config`, `payment_details`.

See [authentication.md](authentication.md) for how `my_role()` and profile
`active` interact, and [multi-tenancy.md](multi-tenancy.md) for the
`center_id` scoping specifically.
