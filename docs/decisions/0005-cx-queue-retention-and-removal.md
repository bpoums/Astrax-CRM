# 0005 — The CX pipeline is "leads CX has not finished with", not "accepted leads"

## Status
Current, 2026-09-16. Supersedes the "Return For Validation is the only way a
lead leaves the pipeline" rule in
[features/cx-lifecycle.md](../features/cx-lifecycle.md), and with it the last
part of [0004](0004-only-accepted-is-terminal.md) that assumed the CX queue and
the accepted set were the same thing.

## Context
Membership of the customer pipeline was one predicate — `disposition =
'accepted' and archived_at is null` — repeated in four places: the `cx_pipeline`
view, the `cxa`/`cxm` branches of the `submissions` RLS policy, and the guards
inside `set_cx_status`, `payment_summary` and `return_lead_for_validation`.

`return_lead_for_validation` clears `disposition`. So pressing **Return For
Validation** — the CXA's own action, on their own lead, usually because the
customer said something that needs a second validation pass — deleted that lead
from their screen at the exact moment they most needed to keep track of it.
There was also no way for a CXA to take a finished lead off their queue, and no
way for them to correct a wrong phone number or a mistyped account number on a
lead they were servicing; they could read both and change neither.

## Decision
Membership becomes:

```sql
archived_at is null
and cx_removed_at is null
and (disposition = 'accepted' or reopened_from_cx_at is not null)
```

spelled once as `cx_pipeline_member(p_sub)` (`STABLE SECURITY DEFINER`) for
every RPC guard, and repeated inline in the RLS policy — a policy on
`submissions` cannot call a function that reads `submissions`.

Three consequences follow deliberately:

- **A returned lead stays.** `reopened_from_cx_at` is never cleared, so it keeps
  the lead on the queue through the whole re-validation round and afterwards.
  The row shows an "In Validation" chip in place of the Return button; the
  button's own RPC keeps its strict `disposition = 'accepted'` guard, so a
  second send is refused server-side and not merely hidden.
- **Only a person removes a lead.** `remove_from_cx_pipeline` sets a
  CX-workspace-only flag. It is not `archive_submission`: reporting, exports,
  the manager's queue, the sheet and the lead's own history are untouched, and
  `restore_to_cx_pipeline` (admin) undoes it. Nothing the CX team does destroys
  a lead.
- **A CXA edits the lead they service.** `update_payload_field` and
  `update_payment_field` gained `cxa`/`cxm`, scoped by `cx_pipeline_member` so
  the reach is exactly their own queue and nothing wider. The card-credentials
  check in `update_payment_field` was not touched — the same line that refuses a
  manager refuses a CXA — and no CX screen renders a card number or CVV input.

## Consequences
- The pipeline now contains leads with no disposition, and with
  `disposition = 'declined'` or `'pending'` if a manager disposes a returned
  lead that way. Any future code reading `cx_pipeline` must not assume
  `disposition = 'accepted'`; `inValidation()` in `customers-pipeline.tsx` is
  the one place that interprets the difference.
- `cx_untouched`, `cx_status_summary` and `closer_lead_alerts` deliberately keep
  their own `disposition = 'accepted'` filters. They measure settled work, not
  the working queue, and widening them would change what the CX coverage card
  counts.
- Applying this made the 39 leads returned under the old rule reappear on the
  queue, since `reopened_from_cx_at` was already stamped on all of them. That is
  the rule working as intended — they were leads the CX team never got an answer
  about — but it is a visible one-off jump in the queue's size.
