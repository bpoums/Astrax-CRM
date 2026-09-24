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
`/closing` → `src/routes/_authenticated/closing.tsx`, three tabs:
**Closing Desk** (`ClosingDesk`, the default), **Overview**
(`ClosingOverview`, added 2026-09-18) and **Parked Leads** (`ParkedLeads`,
general_manager/admin only). Before 2026-09-18 a closing manager got no tab
bar at all — just the bare desk — because Parked Leads was the only other tab
and it was not theirs; the Overview is offered to every role here, so the tab
bar now renders for all of them.

## Important components
`closing-desk.tsx`, `closing-overview.tsx`, `parked-leads.tsx`,
`forwarded-leads.tsx` (the closer's side of the same park/release mechanism —
see [closer-submission-and-forms.md](closer-submission-and-forms.md)).

## The Overview tab (added 2026-09-18)
The same three panels the admin Overview and the manager's Reporting tab
show — `OverviewPanels` in `overview-panels.tsx`: intake for the selected
window, the Submitted/Declined outcome, and the live queue. See
[reporting.md](reporting.md) for the panels themselves.

**It adds no access.** Every figure comes from the `_range` RPCs, which are
`SECURITY INVOKER` and read `submissions` directly, so each caller gets exactly
their own slice of the `submissions read scoped` policy and nothing else.
Verified live by calling them under each role's JWT: a **general manager** sees
351 live / 41 uploaded / 202 validator across all three centres — the same
figures an admin sees — while a **closing manager** sees 56 live / 1 uploaded /
**0 validator**, all of it their own centre.

One thing is therefore hidden from a closing manager, because RLS leaves it
permanently dead rather than because it is secret: **the other centres.**
`submission_totals_by_center_range` left-joins from `centers`, so the ones
outside their scope come back present and zero rather than absent.
`ClosingOverview` filters the list to `profile.center_id` — matched on the
reader's own centre, not on "has any leads", so their centre still shows when it
is genuinely at zero.

Nothing else is filtered by the client. The panel's **Manual** column counts
uploads for them, because their read policy excludes `submitted_by_role =
'validator'` outright — the figure is narrowed by RLS, not by this screen. (A
sheet-imported lead is written `submitted_by_role = 'closer'`, so it *is* inside
their scope when it carries their centre.) Until 2026-09-18 this file described
a `showValidatorRow` prop that hid a Validator row; that row no longer exists —
the panel shows centres per origin instead.

This tab also passes `includeValidatorStats: false` to `useOverviewStats`, so it
never calls `validator_stats_range`. That RPC returns every validator's name and
performance, and three of its columns are counted from `form_events` and come
back whole-business whatever the caller's centre — see the security entry in
[TODO.md](../TODO.md). Nothing here renders it, so nothing here fetches it.

## Database
Read: the same wide `submissions` select used elsewhere (`BASE_SELECT`),
plus the `CX_LEAD_STATUS_SELECT` embed for the four read-only CX columns.
`BASE_SELECT` also carries `disposed_at`, shown as its own "Disposed" table
column (and in the detail sheet's subtitle) next to "Submitted"
(`created_at`) — `created_at` is when the lead was first submitted,
`disposed_at` is when a disposition (Submit/Declined/Pending) was last
recorded on it. Stamped by `dispose_submission` every time it runs, whether
called by a validator inside their review or by a manager/admin; `null`
until a disposition has actually been recorded.
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
- **Filter by submitted date** (added 2026-09-15, available to both
  `closing_manager` and `general_manager`). A From/To pair over `created_at`,
  the date the "Submitted" column already draws; a blank "To" filters exactly
  the single day in "From". It composes with every other filter rather than
  replacing them, and like all of them it runs in the database — this table is
  paged, so a browser-side match would only ever see the rows already fetched.
  Boundaries come from the **`reporting_window` RPC**, the same one Reporting
  calls, never from browser date maths: a Pacific calendar day is not a UTC
  day, and the difference is real rather than theoretical — for 2026-09-14 the
  Pacific window holds 27 closer leads where a naive `created_at::date`
  comparison holds 25. Reusing the RPC is also what keeps a "today" here
  meaning the same day as a "today" in Reporting.
  The RPC needs no role gate of its own: `EXECUTE` is granted to
  `authenticated`, it is not `SECURITY DEFINER`, and it takes no submission id
  and returns no lead data — only `{since, until}`. The rows themselves stay
  scoped by the `submissions` RLS policy, so a closing manager filtering by
  date still sees only their own centre.
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
- **The Parked Leads table opens a detail panel** (added 2026-09-15). Clicking
  a row opens a `Sheet` rendering `PayloadTable` — the same component every
  other detail view uses, so a parked lead reads identically here and in
  Reporting. It needs no extra query: `payload` was always part of the
  component's `SELECT` and was simply never rendered. "Move to Validation"
  appears both on the row and inside the panel, driven by the one mutation;
  the row's own button stops event propagation so it does not also open the
  panel, and a successful move closes the panel, since the lead leaves the
  list at that moment.

## Known limitations
- **A parked lead's payload is shown unmasked**, banking fields included. The
  closer form writes `Routing Number`, `Account Number`, `Card Number`,
  `Exp Date` and `CVC` straight into `payload` (see its "Banking" section),
  and `PayloadTable` masks none of them. This is **not specific to this
  panel** — Reporting, the manager queue and the customers pipeline have
  always rendered the same payload the same way to the same roles, and an
  admin can already read any parked lead in Reporting → Submissions. It is
  recorded here because it sits awkwardly against `CLAUDE.md`'s "card numbers
  and CVVs never reach a manager's or uploader's browser", which appears
  aimed at the `payment_details` path for imported leads rather than at
  closer-form payloads. Masking would be one change to `PayloadTable`
  affecting every view at once; doing it in a single panel would read as
  fixed while leaving the exposure intact.

## Future work
None found as explicit TODOs.
