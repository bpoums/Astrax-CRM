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
  allowed for **admin**, or for the **assigned validator while the lead is
  `in_review`** (confirmed directly from the live function body: `if v_role
  not in ('admin','validator') then raise 'not authorized'`; for a
  validator it additionally requires `assigned_to = auth.uid() and
  status='in_review'`). Every call inserts a `card_access_log` row first,
  unconditionally.
- `update_payment_field`: bank fields (`payment_type`, `bank_name`,
  `routing_number`, `account_number`, `account_title`, `card_exp`) are
  manager/admin; `card_number`/`cvv` are **admin only**, even though
  manager can reach the same edit UI (`data-flags.tsx`'s correction flow) —
  the RPC itself refuses a non-admin attempting a card field, and the
  client surfaces that refusal message verbatim rather than hiding the
  control (the input still renders for a manager, per `CLAUDE.md`'s "render
  for admins only" note being about *reading back* a value, not about
  hiding the field entirely).
- `purge_payment_data` (nightly cron, 03:17): nulls `cvv` once the lead is
  disposed or `cvv_purge_days` old, whichever comes first; nulls
  `card_number` once `card_purge_days` past disposal or creation.

## Known limitations
- **No admin UI currently exposes `card_details`.** Every `<PaymentPanel>`
  call site was checked: `closing-desk.tsx` and `manager.tsx` both mount it
  without `canRevealCard`; `validator.tsx` is the **only** call site that
  ever passes `canRevealCard`, gated to `selected.status === "in_review"`.
  So while the RPC itself permits an admin server-side, there is currently
  no button anywhere in the app that would let an admin exercise that
  permission. This is either a genuine gap or an intentional "admin *can*,
  but there's been no need yet" state — not resolved by this audit.
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
