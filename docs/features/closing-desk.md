# Closing desk (closing_manager / general_manager) + parked leads

## Purpose
One screen giving `closing_manager` visibility (and payload-edit rights)
over every closer-originated lead in their own center, and giving
`general_manager` the same screen and rights across every center and both
lead origins — plus the mechanism (External Transfer / Parked Leads) for a
closer to route a lead around the ordinary queue until a general manager or
admin decides to release it.

## Current status
Live, stable.

## Roles involved
**closing_manager** (own center, closer leads only), **general_manager**
(every center, closer + validator leads, plus Parked Leads), **admin**
(everything either can do, plus Parked Leads).

## Routes / screens
`/closing` → `src/routes/_authenticated/closing.tsx` → `ClosingDesk` +
(general_manager/admin only) a "Parked Leads" tab → `ParkedLeads`.

## Important components
`closing-desk.tsx`, `parked-leads.tsx`, `forwarded-leads.tsx` (the closer's
side of the same park/release mechanism — see
[closer-submission-and-forms.md](closer-submission-and-forms.md)).

## Database
Read: the same wide `submissions` select used elsewhere (`BASE_SELECT`),
plus the `CX_LEAD_STATUS_SELECT` embed for the four read-only CX columns.
Write: `update_payload_field` for in-place edits, `set_validator_fields`,
`decline_with_carriers`/`dispose_submission` are **not** available here —
this desk edits the payload and can view outcomes but does not itself
dispose leads. Park/release: `submit_form_parked` (closer side),
`move_to_validation` (release, general_manager/admin).

## Relationships / scoping
The row set a closing_manager vs. general_manager sees is decided entirely
by the `submissions` RLS policy — see [multi-tenancy.md](../multi-tenancy.md).
Confirmed by direct grep of `closing-desk.tsx`: the component itself
contains exactly **one** role-string check in the whole file
(`profile?.role === "closing_manager" && !profile.center_id`), used solely
to pick which empty-state *message* to show — it does not affect the
query, the columns, or any control. The `"general_manager"`/`"admin"`
branch that decides whether the Parked Leads tab even renders lives in the
**route** file (`closing.tsx`), not in the desk component.

## Business rules
- **The four CX columns are read-only here, deliberately** — the desk shows
  "Set by the CX team; read-only here." and mounts the plain
  `CxLeadStatusValue` display, never the editable `CxStatusCell`. Offering
  a control that `set_cx_status` would refuse anyway would be worse than
  offering none.
- **No client-side row filtering "to help"** — the desk asks the database
  for submissions and shows exactly what comes back; adding a client-side
  filter on top would risk quietly disagreeing with the server-side rule the
  moment that rule changes.
- **Parking**: the closer's "External Transfer" button calls
  `submit_form_parked`, which sets `status='parked'` on a closer-originated
  result (a validator submission has nothing to park — it's already
  closed). A parked lead is invisible to the manager queue's ordinary read
  (the `submissions` RLS policy explicitly excludes `parked` from what a
  manager sees) but still reaches Google Sheets and the admin Submissions
  listing.
- **Releasing**: `move_to_validation` moves a `parked` lead back to
  `pending_manager`. Confirmed directly from the live function body: it
  raises `not authorized` unless `my_role() in ('admin', 'general_manager')`
  — so the restriction is enforced server-side, not just by the client
  omitting a button for anyone else. It only succeeds when the target row's
  `status = 'parked'` and `archived_at is null`.

## Known limitations
None identified for this specific mechanism.

## Future work
None found as explicit TODOs.
