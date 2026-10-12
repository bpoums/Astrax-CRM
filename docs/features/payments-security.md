# Payment data handling

## Purpose
Keep bank/card instrument data for imported leads out of the payload that
syncs to Google Sheets, and restrict who can ever see a full card number.

## Current status
Live and working for the roles that have a UI path to it — but see "Known
limitations": the admin card-reveal path described in `CLAUDE.md` currently
has no UI to invoke it, and two of the six purge-related admin settings have
no control to change them from their defaults.

## Roles involved
**admin** (bank summary + full card via RPC — but see limitation below),
**manager**, **closing_manager**, **general_manager**, **cxm**, **cxa**
(bank summary only, cxm/cxa additionally gated to accepted leads),
**validator** (bank summary + full card, only for their own current
assignment).

## Routes / screens
No dedicated route — `PaymentPanel` (`src/components/payment-panel.tsx`) is
mounted inside the detail sheet on `/manager`, `/closing`, and `/validator`.

## Database
`payment_details` (imported leads only; **zero RLS policies** — reachable
only through the RPCs below), `card_access_log` (admin-read-only, written
only by `card_details`). RPCs: `payment_summary`, `card_details`,
`update_payment_field`. Full signatures and role gates in
[database.md](../database.md).

## Business rules
- `payment_summary` returns bank fields, `card_last4`, and `card_exp` —
  **never** the full card number or CVV, for any role including admin.
- `card_details` is the only RPC that returns a full card number/CVV. It's
  allowed for **admin**, **manager** and **general_manager** (any lead; widened
  2026-10-12), or for the **assigned validator while the lead is `in_review`**
  (`assigned_to = auth.uid() and status='in_review'`). The guard is fail-closed
  (`v_role is null or ...`). Every call inserts a `card_access_log` row first,
  unconditionally.
- `update_payment_field`: bank fields (`payment_type`, `bank_name`,
  `routing_number`, `account_number`, `account_title`, `card_exp`) are
  manager/admin/**general_manager**, plus cxa/cxm on their own pipeline lead.
  `card_number`/`cvv` are writable by **admin, manager and general_manager only**
  (widened from admin-only on 2026-10-12, `20261012110000_card_entry_and_manager_reveal.sql`);
  cxa/cxm are refused. Saving a card number on a lead whose `payment_type` is
  still `unknown` makes it `card`. The anon grant was removed in
  `20261010111000_revoke_anon_update_payment_field.sql` and the whole function
  family in `20261012100000_lock_down_rpc_execute.sql`.
- `payment_summary` also returns `has_card` and `has_cvv` (booleans, never the
  values) so `PaymentPanel` knows which optional card fields a lead is missing.
- **Card entry UI (2026-10-12):** `PaymentPanel` shows a "Card details
  (optional)" block to admin/manager/general_manager with one input per missing
  field (number, expiry, CVC), validated with the importer's `normalizeCard` /
  `normalizeExpiry` / `normalizeCvv`. It also shows on leads with no payment
  details. A CVC the retention job already purged is not offered again.
- `purge_payment_data` (nightly cron, 03:17): nulls `cvv` once the lead is
  disposed or `cvv_purge_days` old, whichever comes first; nulls
  `card_number` once `card_purge_days` past disposal or creation.

## Known limitations
- **`card_details` reveal button (changed 2026-10-12):** `PaymentPanel` shows
  "Show card details" to admin, manager and general_manager on any lead with a
  stored card number (the role is read from `useAuth()` inside the panel, so no
  mount site changed), and to a validator via `canRevealCard` while `in_review`.
- **`CardAccessLog` (the admin audit view of every card reveal) is imported
  in `admin.tsx` but not rendered anywhere** — its `TabsContent` block and
  its tab-list entry are both commented out. Same for `SettingsAudit`. Both
  screens are currently dead from a navigation standpoint, even though the
  tables/RLS behind them (per each component's own comments) remain
  admin-readable.
- **Two of the six admin-configurable settings have no live control**:
  `cvv_purge_days` and `card_purge_days` exist in `admin-settings.tsx`'s
  `KEYS` constant and the RPCs accept them, but both `<NumberSetting>`
  blocks for them are commented out in the JSX. The nightly purge job still
  runs using whatever value is currently stored in `app_config` (defaulting
  to 7 and 90 days respectively if never set) — an admin just can't change
  either number from the UI right now.
- `PRODUCT.md`'s "card numbers and CVVs never reach... an uploader's
  browser" is not accurate for the **pre-import** review step — see
  [spreadsheet-import.md](spreadsheet-import.md)'s Known limitations. It is
  accurate for every screen after import.

## Future work
Wiring up the admin card-reveal button, un-commenting the two purge
settings, and re-enabling (or deliberately removing) the Audit tab are the
three concrete, low-risk pieces of unfinished work this subsystem surfaced.
