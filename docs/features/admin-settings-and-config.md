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
`TransferClientAdmin` + `CarrierAdmin` + `PlacementAdmin` + `CxStatusAdmin`. The Audit tab (`CardAccessLog` + `SettingsAudit`) exists in
code but its tab entry and `TabsContent` are both commented out in
`admin.tsx`. The blocking page a suspended non-admin is redirected to lives
at the public route `/suspended` (`suspended.tsx`), outside the auth gate,
same as `reset-password.tsx`.

## Important components
`suspension-control.tsx`, `admin-settings.tsx`, `carrier-admin.tsx`,
`center-admin.tsx`, `transfer-client-admin.tsx`, `placement-admin.tsx` (with
`lib/placement.ts`), `settings-audit.tsx`
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
- `agencies`, `imos`, `agents` and the links `agency_imos`, `imo_carriers`
  (added 2026-10-04; `agent_appointments` was dropped 2026-10-07 — agents are
  a standalone list) — **not** directly writable, unlike
  the three above: written only through `placement_upsert_item` and
  `placement_set_link` (admin only, both audited to `settings_audit`). See
  "Placement" below.
- RPCs: `admin_settings()` (read all six keys at once), `set_admin_setting`
  (allow-listed keys, per-key validation, writes `settings_audit`),
  `reporting_retention_status()` (reads `cron.job_run_details` for the
  nightly purge job's last run), `set_crm_suspension(p_suspended,
  p_duration_minutes?, p_message?)` (admin-only; sets or clears the
  suspension, writes `settings_audit`), `clear_expired_suspension()`
  (cron-only, `EXECUTE` revoked from `anon`/`authenticated` — cosmetic sweep,
  see below).

## Placement: agencies, IMOs and agents (added 2026-10-04)

**Layout (redesigned 2026-10-07).** Agencies, IMOs and Agents are three cards of
rows (`admin-list.tsx`: `ListCard`, `ListRow`, `RowAction`). Row actions (↑ ↓,
edit, activate/deactivate) are icon buttons shown on hover or focus, always on
touch; lists scroll at a capped height and get a filter box past 8 names;
agencies/IMOs show their link counts. The mapping is a master–detail pane: pick
the parent on the left, toggle its children as pills on the right. `CarrierAdmin`
uses the same row pattern (name, spellings inline, icon actions; the Order and
Active columns are gone — inactive rows are muted and tagged). Behaviour, RPCs
and writes are unchanged.

**Mapping lives on the Agencies tab (moved 2026-10-08).** The admin **Agencies**
tab shows the editable Mapping (`PlacementMapping`, exported from
`placement-admin.tsx`) on top and the connection map under it, so a toggled link
shows in the diagram straight away (both read the same placement-links query).

**Connection map (added 2026-10-07).** Below the mapping, `AgencyMap`
(`src/components/agency-map.tsx`) is a read-only picture of the mapping: Agencies, IMOs and Carriers in three columns with curves between
linked names, plus link counts. Selecting or hovering a name lights its whole
path (agency → IMOs → carriers, or carrier → IMOs → agencies) and dims the rest.
"Show inactive" is off by default; links to hidden items are hidden with them.
Under `lg` it falls back to one card per IMO. It reads through
`usePlacementList`, `usePlacementLinks` and `useCarriers(false)`.

The **Agencies, IMOs and agents** panel (`placement-admin.tsx`) sits under
Carriers in Settings and holds the three lists; the mapping is on the Agencies tab.

**Three lists** (Agencies, IMOs, Agents): add, edit, reorder (↑/↓ rewrites the
order as 10, 20, 30…), deactivate. Agents also carry an optional NPN. Carriers
are still managed in their own panel. **Agents are independent**: adding an agent
here is all it takes for it to appear in the validator's Agent Name dropdown —
no mapping to an IMO or carrier.

**Mapping** (Agencies tab), two boxes, each "pick the parent, tick its children":
- **Agency → IMOs**
- **IMO → Carriers.** One carrier can be ticked under several IMOs. Each
  IMO→Carrier pair is its own contract.

Every link is many-to-many. Inactive items only appear in a checklist while
they're still linked, so a link to something since retired can be seen and
switched off.

**Current status:** the validation flow reads this mapping in the new
"To Be Filled By Validator" dropdowns and the new Decline dialog. Phase 2,
added 2026-10-05, is built but switched **off**
(`app_config.placement_rule_enabled = 'false'`). See "Placement rule" in
[validation-queue.md](validation-queue.md).

The agency → IMO → carrier mapping has to be complete and real before the switch
goes on. A validator can choose any active agent, and accept requires one.

Historical leads' `submissions.agency_id`/`imo_id`/`agent_id` are being filled in
by hand. Those columns don't trigger sheet-sync, so editing them never re-sends a
row to Google Sheets.

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
  `_authenticated/route.tsx`'s `beforeLoad` also check on navigation (through the
  shared `loadAuthSnapshot()`, cached ~10 s), covering a suspended non-admin who
  is not currently signed in.
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
  **Linked to a center (2026-10-10, `transfer_clients.center_id`).** A client
  belongs to a center, chosen on the add form and editable in the table (Settings
  → Transfer Clients); "Any center" (null) offers it to every center. A closer
  is offered only the clients of their own center, and `submit_form_parked`
  enforces it server-side ("client is not available for your center"). A linked
  client is listed under its center in the Overview's Live | Manual card (see
  [reporting.md](reporting.md)). Both existing clients were linked to UMS BPO.
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
