# Validation queue (manager + validator workflow)

## Purpose
A second person re-verifies every closer-taken sale with the customer,
inside a timed window, before it reaches a carrier.

## Current status
Live, stable, and described in `CLAUDE.md`/`WHERE-TO-CHANGE.md` as the
"reference implementation" other screens should mirror.

## Roles involved
**manager** (assigns, disposes, archives, bulk-assigns), **admin** (same
access as manager, everywhere), **validator** (works their own assignment
only, inside the window).

## Routes / screens
- `/manager` → `src/routes/_authenticated/manager.tsx` — tabs: Operations
  (the queue), Pending Imports, By Draft Date, Reporting.
- `/validator` → `src/routes/_authenticated/validator.tsx` — the validator's
  own queue and detail sheet.

## Important components
`manager.tsx`, `validator.tsx`, `src/components/validator-fields.tsx`
(the three-field accept gate), `src/components/decline-dialog.tsx` +
`carrier-declines.tsx` (per-carrier decline recording), `lead-editor.tsx`
(in-place payload editing), `data-flags.tsx` (correct-then-clear pattern),
`lead-history-dialog.tsx` (the "View History" dialog in the detail sheet —
validation passes plus the CX lifecycle, the same one the closing desk, the
CX pipeline and reporting mount), `free-text.tsx`'s `ClampedText` (the
CX return reason in the queue's Reason column).

## Database
See [database.md](../database.md) for full RPC list. The RPCs specific to
this workflow: `assign_to_validator`, `claim_submission`, `hold_submission`,
`reject_assignment`, `dispose_submission`, `decline_with_carriers`,
`archive_submission`, `unarchive_submission`, `set_validator_fields`, and the
`expire-reviews` cron job (`expire_stale_reviews()`, every minute).

## Relationships / how the manager queue actually queries
One unpaged query against `submissions` (`.in("status", ["pending_manager",
"returned_timeout","assigned","in_review"])`, excluding validator-originated
rows and archived rows) feeds **both** the Live and Manual queue tabs —
they are the same result set, split client-side by `row.source`, not two
separate requests. (The third tab, **CXA Returned**, is the same set again —
`queueTabOf()` routes any row carrying `reopened_from_cx_at` there regardless
of origin.) A single Realtime channel (`"manager-submissions"`,
`postgres_changes` on all `submissions` events) invalidates this query, the
CX return reasons below, and the Pending Imports count.

Because the whole open queue is already loaded, **search is a client-side
filter, not a query** — the opposite of the paged tables, which must search
server-side through `src/lib/lead-search.ts`. The box sits beside the tab
list, matches the customer's name (`customerName()` from `ops.tsx`), and
narrows **only the open tab**: the other tabs' counts stay whole totals, so a
term that matches nothing on Live does not imply the lead does not exist.
Changing the term clears any pending bulk selection, the same way changing
tab does — a bulk assign must never reach a lead that is filtered off screen.

The CXA's **return reason** is not on the submission row; it is the
`detail->>'reason'` of the lead's most recent `reopened_from_cx` event. The
queue fetches it for the returned rows in one batched `form_events` query
(newest first, first-write-wins per lead, because a lead can make the round
trip more than once) and renders it in two places: a clamped **Reason**
column on the CXA Returned tab, with the whole of it on hover, and a
full-text "Returned by CX" block at the top of the detail sheet.

## Business rules
- **The review window is enforced in three places, all server-side**: the
  `validator` branch of the `submissions` RLS read policy (a validator
  can't even *see* a claim older than the window), `dispose_submission`'s
  own `claimed_at > now() - review_window()` check, and the `expire-reviews`
  cron sweep. The client's countdown is display-only — on expiry it closes
  the view and invalidates the query; it never itself fires a timeout RPC.
- **Accept gate**: `dispose_submission` refuses `p_disposition='accepted'`
  for a closer-originated lead unless `final_carrier_id`, `agent_name`, and
  `policy_number` are all set. `acceptBlockedReason()` in
  `validator-fields.tsx` mirrors this client-side against the *saved* row
  (not the in-progress draft) purely to disable the button and explain why
  — the actual enforcement is the RPC.
- **Bulk-assign is not atomic**: it's a client-side loop of individual
  `assign_to_validator` calls, so one already-claimed row failing doesn't
  take the rest of the selection down — partial success is reported by
  toast, naming the count and the first failure's message.
- **Hold** releases the claim (back to `assigned`, `claimed_at=null`) without
  losing the assignment; a max-holds limit from `app_config` (0 = unlimited)
  is enforced by `hold_submission` itself. Reopening restarts the full
  window — there is no resume.
- **Decline with carriers** (`decline_with_carriers`) is one call that both
  records which carriers said no (`carrier_declines`, one row each) and
  disposes the lead as `declined` — replacing what used to be two separate
  steps.
- `in_review` rows are deliberately excluded from bulk-assign eligibility —
  reassigning a lead a validator currently has open would yank it out from
  under them mid-review.

## Known limitations
- No literal review-window "grace period" — the moment `claimed_at +
  review_window()` passes, the next cron tick (up to 60s later) or the next
  RLS-scoped read will treat the row as expired.
- `CarrierDeclineReport` (in `carrier-declines.tsx`) has no confirmed mount
  point anywhere in the routes/components read during this audit — it may
  be unused, or reachable from a screen not covered. Flagged as unclear
  rather than assumed removed.

## Future work
None identified in code comments or commented-out UI for this specific
subsystem.
