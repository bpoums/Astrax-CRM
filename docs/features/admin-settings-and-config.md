# Admin settings, carriers, centers, transfer clients, and the audit trail

## Purpose
Let an admin tune operational behavior (review window, hold limit, data
retention/purge windows) and manage the three vocabulary tables the whole app
reads from (carriers, centers, transfer clients) — all without a deploy.

## Current status
Live for carriers/centers/transfer-clients management and four of six
operational settings.
The Audit tab (settings + card-access history) is currently unreachable
from the UI — see [payments-security.md](payments-security.md).

## Roles involved
**admin** only, for every write described here.

## Routes / screens
`/admin?tab=settings` → `AdminSettings` + `CenterAdmin` +
`TransferClientAdmin` + `CarrierAdmin` + `CxStatusAdmin`. The Audit tab (`CardAccessLog` + `SettingsAudit`) exists in
code but its tab entry and `TabsContent` are both commented out in
`admin.tsx`.

## Important components
`admin-settings.tsx`, `carrier-admin.tsx`, `center-admin.tsx`,
`transfer-client-admin.tsx`, `settings-audit.tsx` (unreachable, see above).

## Database
- `app_config` (key/value, no RLS policy — reachable only via RPC),
  `settings_audit` (admin-read-only, written only by `set_admin_setting`).
- `carriers`, `centers`, `transfer_clients` — all three admin-writable
  **directly** (no RPC exists for any of them), on the reasoning (stated in
  each admin component's own comments) that naming a carrier, a center or a
  client is vocabulary, not workflow, and needs none of the ordering/audit
  guarantees an RPC exists to provide. All three are readable by every role.
- RPCs: `admin_settings()` (read all six keys at once), `set_admin_setting`
  (allow-listed keys, per-key validation, writes `settings_audit`),
  `reporting_retention_status()` (reads `cron.job_run_details` for the
  nightly purge job's last run).

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
