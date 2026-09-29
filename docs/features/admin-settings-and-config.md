# Admin settings, carriers, centers, transfer clients, suspension, and the audit trail

## Purpose
Let an admin tune operational behavior (review window, hold limit, data
retention/purge windows), suspend the whole CRM for every non-admin role, and
manage the three vocabulary tables the whole app reads from (carriers,
centers, transfer clients) — all without a deploy.

## Current status
Live for carriers/centers/transfer-clients management, system suspension, and
four of six operational settings.
The Audit tab (settings + card-access history) is currently unreachable
from the UI — see [payments-security.md](payments-security.md).

## Roles involved
**admin** only, for every write described here.

## Routes / screens
`/admin?tab=settings` → `SuspensionControl` + `AdminSettings` + `CenterAdmin` +
`TransferClientAdmin` + `CarrierAdmin` + `CxStatusAdmin`. The Audit tab (`CardAccessLog` + `SettingsAudit`) exists in
code but its tab entry and `TabsContent` are both commented out in
`admin.tsx`. The blocking page a suspended non-admin is redirected to lives
at the public route `/suspended` (`suspended.tsx`), outside the auth gate,
same as `reset-password.tsx`.

## Important components
`suspension-control.tsx`, `admin-settings.tsx`, `carrier-admin.tsx`,
`center-admin.tsx`, `transfer-client-admin.tsx`, `settings-audit.tsx`
(unreachable, see above). `lib/crm-suspension.ts` holds the shared query/RPC
helpers (`useCrmSuspension`, `fetchCrmSuspension`, `setCrmSuspension`,
`isActiveSuspension`, `subscribeToCrmSuspension`) used by
`suspension-control.tsx`, `suspended.tsx`, and the auth gates below.

## Database
- `app_config` (key/value, no RLS policy — reachable only via RPC),
  `settings_audit` (admin-read-only, written only by `set_admin_setting` and
  `set_crm_suspension`).
- `crm_suspension` (added 2026-09-29) — a **singleton** row
  (`suspended`, `resumes_at`, `message`, `updated_by`, `updated_at`). One RLS
  policy, `for select using (true)` — readable by anyone, including a
  signed-out/anon visitor, so a just-kicked user can still see the blocking
  message. No write policy: all writes go through `set_crm_suspension`. In
  the `supabase_realtime` publication, so `AuthProvider` can subscribe to
  changes directly (see "System suspension" below). See
  [decisions/0008](../decisions/0008-crm-suspension-via-my-role.md) for why
  this is a dedicated table rather than an `app_config` key.
- `carriers`, `centers`, `transfer_clients` — all three admin-writable
  **directly** (no RPC exists for any of them), on the reasoning (stated in
  each admin component's own comments) that naming a carrier, a center or a
  client is vocabulary, not workflow, and needs none of the ordering/audit
  guarantees an RPC exists to provide. All three are readable by every role.
- RPCs: `admin_settings()` (read all six keys at once), `set_admin_setting`
  (allow-listed keys, per-key validation, writes `settings_audit`),
  `reporting_retention_status()` (reads `cron.job_run_details` for the
  nightly purge job's last run), `set_crm_suspension(p_suspended,
  p_duration_minutes?, p_message?)` (admin-only; sets or clears the
  suspension, writes `settings_audit`), `clear_expired_suspension()`
  (cron-only, `EXECUTE` revoked from `anon`/`authenticated` — cosmetic sweep,
  see below).

## System suspension
- **Enforcement is server-side, in `my_role()` itself** — not a separate RLS
  policy or RPC guard. `my_role()` returns `NULL` for a non-admin caller
  while `crm_suspension.suspended` is true and (`resumes_at` is null or
  still in the future); admins are exempted inline. Because every existing
  RLS policy and RPC guard already treats a `NULL` role as "no access" (the
  2026-09-27 NULL-bypass fix), a suspended non-admin loses every read and
  write app-wide immediately, with no other policy or RPC touched. See
  [decisions/0008](../decisions/0008-crm-suspension-via-my-role.md).
- **The forced sign-out is client-side, in `AuthProvider`** (`lib/auth.tsx`):
  a realtime subscription on `crm_suspension` calls the existing `signOut()`
  and navigates to `/suspended` the instant a non-admin session sees an
  active suspension — this is what turns the server-side block into an
  actual kick instead of a silently-empty screen. `requireRole()` and
  `_authenticated/route.tsx`'s `beforeLoad` also check on every navigation,
  covering a suspended non-admin who is not currently signed in.
- **Timed vs. manual**: `set_crm_suspension(p_suspended, p_duration_minutes,
  p_message)`. A duration sets `resumes_at = now() + p_duration_minutes`; no
  duration means indefinite (`resumes_at = null`) until an admin calls it
  again with `p_suspended = false`. `clear_expired_suspension()` runs every
  minute via pg_cron (`clear-expired-suspension`) to flip `suspended` back to
  `false` once `resumes_at` passes — cosmetic only, so the admin's own
  Settings view reflects the state without a manual resume; the actual
  block in `my_role()` compares `resumes_at` to `now()` directly and never
  depends on the cron tick, the same relationship `review_window()` has with
  the `expire-reviews` sweep.
- **The message** defaults to "The system is temporarily suspended for
  maintenance." when left blank on suspend, and is shown on `/suspended`
  along with a live countdown when `resumes_at` is set.

## Business rules
- **Six configurable keys exist; four have a live control**:
  `review_timeout_enabled`, `review_timeout_minutes`, `max_holds`,
  `reporting_retention_days` are all rendered and editable.
  `cvv_purge_days`/`card_purge_days` exist in the same `KEYS` constant and
  the RPC accepts them, but their UI blocks are commented out — see
  [payments-security.md](payments-security.md).
- **No delete for carriers, centers or transfer clients, ever** — all three
  are FK-referenced (carriers by
  `carrier_declines`/`submissions.final_carrier_id`; centers by
  `profiles.center_id`/`submissions.center_id`; transfer clients by
  `submissions.transfer_client_id`). Deactivate is the only removal
  mechanism, and each admin screen says so on-screen, not just in a comment.
- **Renaming a carrier is not history-safe; renaming a center is.** A
  carrier rename changes the Google Sheet tab name for *future* validator
  submissions to it (existing rows keep pointing at the old tab name,
  because the sheet-sync payload sends the carrier name as it is *now*, at
  sync time, not a frozen copy). A center rename is safe because
  `submissions.center_name` is a frozen copy taken at submission time, never
  a live join. **Renaming a transfer client is safe for the same reason**:
  `submissions.transfer_client_name` is stamped when the lead is parked.
- **Transfer clients** (added 2026-09-19) are the external parties a closer
  hands a lead to with **External Transfer**. Active ones, in this order,
  are exactly what the closer's transfer dialog offers, and Parked Leads
  groups its chips by them — see
  [closer-submission-and-forms.md](closer-submission-and-forms.md).
- **Reordering** (carriers, centers and transfer clients alike) rewrites every
  changed row's `sort_order` as `(index+1)*10` rather than swapping two
  values — chosen
  specifically to avoid a tie where two rows share a `sort_order` and can
  never be moved past each other again.
- `set_admin_setting` validates per key server-side (e.g. `cvv_purge_days`
  capped at 30, `review_timeout_minutes` must be ≥ 1) and the client
  surfaces that exact validation message rather than a generic one.

## Known limitations
See [payments-security.md](payments-security.md) for the purge-settings and
Audit-tab gaps — they're the same underlying issue, documented once there to
avoid duplicating it here.

## Future work
Re-enabling or deliberately removing the commented-out Audit tab and the two
purge-day controls.
