# 0004 — Only `accepted` is terminal; every other outcome re-enters the queue

## Status
Current, and extended since it was first documented — the CX reopen path
(below) is a second mechanism reaching the same rule, added after the
original workflow rules were written.

## Context
A validator disposing of a lead has three outcomes (`disposition_t`:
`accepted`, `declined`, `pending`). A lead that is merely "not right yet"
must not disappear from anyone's work — it needs to come back to a manager
to be routed again, potentially to a different carrier.

## Decision
`dispose_submission` sets `status = 'closed'` (the only status meaning
"done") only when `p_disposition = 'accepted'`. Declined and Pending both
set `status = 'pending_manager'` and clear the assignment — the lead returns
to the manager's queue as an ordinary, unassigned row, distinguishable from
a never-touched lead only by its `disposition` and `rejection_count`/
`last_rejected_by` (see `QueueStatusBadge`'s precedence rules in
`src/components/ops.tsx`).

**This rule was extended, not just observed, by the CX-lifecycle work**: once
a lead is accepted and later handled by the CX team, marking its **policy**
status `DECLINED`, `WITHDRAWN`, or `CANCELLED` (via `set_cx_status`) reopens
it — `status` goes back to `pending_manager`, `disposition` and every
validator-set field (`final_carrier_id`, `agent_name`, `policy_number`) are
cleared, and `reopened_from_cx_at` is stamped (never cleared again, so the
row keeps a permanent trace that it didn't arrive by the ordinary
flow). `LAPSED` is deliberately excluded from this list — a lapsed policy
existed and may be reinstated, which is a different situation from one that
never took at all. See [database.md](../database.md#rpc-functions-the-entire-writeread-gated-api)
and [features/cx-lifecycle.md](../features/cx-lifecycle.md).

## Addendum (2026-09-12) — the CX reopen became an explicit action

The CX-reopen mechanism described above was itself changed shortly after
being documented, in response to a workflow request: setting a policy status
to `DECLINED`/`WITHDRAWN`/`CANCELLED` no longer reopens the lead by itself.
`set_cx_status` is now a pure status write for all four categories,
including policy. Reopening is a separate, explicit RPC,
`return_lead_for_validation(p_sub, p_reason?)`, exposed to cxa/cxm/admin as
a standalone "Return For Validation" button in the Customers Pipeline table
— independent of what any of the four statuses currently read. It performs
exactly the same reset the old automatic path did (see above).

**Why**: coupling the reopen to one specific status value meant a CXA could
not record that a policy declined without the lead immediately leaving their
queue. Separating "what happened" (the status) from "hand this back for
another validation pass" (an action) lets both be decided independently.

This also surfaced a pre-existing bug, fixed in the same change: the
manager's Operations queue (`manager.tsx`) unconditionally excludes every
`submitted_by_role='validator'` row, including ones just reopened — since
that column is permanent lineage and is never cleared on reopen. The queue's
`.or(...)` filter now admits a row when `reopened_from_cx_at` is set,
regardless of `submitted_by_role`.

## Consequences
- "Closed" is a stronger word in this schema than in most: a `closed`
  submission can still, weeks later, become `pending_manager` again through
  the CX path — closed means "accepted, for now," not "will never change
  again."
- Every screen that lists leads by status has to treat `pending_manager`
  as a mixed bag: never-touched, returned-by-timeout, rejected-by-validator,
  declined, *and* reopened-from-CX all land there. `QueueStatusBadge`
  exists specifically to disambiguate this one status into the right badge
  without duplicating that precedence logic across the manager queue, the
  admin Submissions table, and the closing desk.
- The three validator-set fields being cleared on CX reopen is deliberate,
  not incidental: leaving them would let the next validator's Accept pass
  the `dispose_submission` gate on stale values describing the previous,
  failed placement.
