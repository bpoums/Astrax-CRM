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
  (the queue), Pending Imports, By Draft Date, Submissions (the submissions
  explorer, moved out of Reporting 2026-10-08), Reporting.
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

**Sorting and paging are client-side too.** Each of the three tabs renders through
the shared `DataTable` (`src/components/data-table.tsx`, TanStack Table v8) over
the rows already loaded, so the query, the tab counts, the search and the realtime
refresh are unchanged. The tabs keep their own columns; only the table code is shared.
- **Sorting:** every column header sorts (click to toggle ascending/descending).
  The default is still newest first (Submitted / Uploaded On / Returned). Status sorts
  by need for action: timed out, then awaiting assignment, then assigned, then in review.
  Empty cells sink to the bottom either way. Sort keys live in `src/lib/queue-sort.ts`.
- **Paging:** 50 rows a page, with the range and Previous/Next under the table only when
  there is more than one page. A realtime refetch keeps the reader on their page (clamped
  if the last page disappears); a new search term or sort goes back to page one.
- **Bulk selection is page-scoped.** The header checkbox ticks the assignable rows of the
  page on screen only, so one click can never reach a lead that is not visible. Ticks
  survive moving between pages, and are cleared by a tab change, a search change or a
  sort change, as before. `in_review` rows still have no checkbox.
- The `Reason` column on CXA Returned is still switched off (kept as a comment in the
  column list in `manager.tsx`).

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
  for a closer-originated lead unless the validator fields are set.
  - **While `placement_rule_enabled` is off (the live state today):** the
    original three, `final_carrier_id`, `agent_name` and `policy_number`.
  - **Once it is on:** all five, `agency_id`, `imo_id`, `final_carrier_id`,
    `agent_id` and `policy_number`, and no placement conflict (see "Placement
    rule" below).

  `acceptBlockedReason()` in `validator-fields.tsx` checks the five against the
  *saved* row, not the draft. It does this only to disable the button and say
  why; the actual enforcement is the RPC.
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
  - **New dialog:** the validator ticks **IMO → carrier** contracts, grouped by
    IMO, and must say **why**: "Carrier rejected" or "Fixable issue".
  - **One IMO per carrier.** The same carrier can't be ticked under two IMOs;
    the dialog disables it and the RPC refuses it.
  - **Already rejected:** carriers this customer was already rejected by are
    struck through.
  - **Old dialog:** the old carrier-only overload still works while the switch
    is off. Its rows get a `kind` classified from the reason text.
- `in_review` rows are deliberately excluded from bulk-assign eligibility —
  reassigning a lead a validator currently has open would yank it out from
  under them mid-review.

## Placement rule (added 2026-10-05, built but switched OFF)

Its purpose is license protection: a customer a carrier has rejected must not
be re-shopped to that carrier through another IMO. Placing them with a
different carrier under the same IMO is allowed, but only after a warning the
validator has to acknowledge. See
[decisions/0009](../decisions/0009-placement-rule-server-side-by-ssn.md).

**Interim simple mode (added 2026-10-07).** While `app_config.placement_rule_enabled`
is `false` — the state it ships in, until the agency/IMO/agent mapping is ready —
`ValidatorFields` renders five fields: **Agency** and **IMO** (free text), **Final
Carrier** (any active carrier), **Agent Name** (free text) and **Policy Number**. No
blocks or warnings. Agency and IMO are stored in the text columns
`submissions.agency_name` / `imo_name` (not the `agency_id`/`imo_id` FKs). They are
synced to Google Sheets as the `Placement Agency` and `Placement IMO` columns (added
2026-10-07), so nothing the validator enters is lost. Save calls the
rule-off `set_validator_fields`, and both `dispose_submission` and
`acceptBlockedReason` require all five. When the rule goes on, a lead that has typed
agency/IMO but no ids shows them as a "Typed before the mapping" note; mapping the
text onto real ids is a separate job. The switch
is read client-side by `usePlacementRuleEnabled()` (`placement_rule_enabled()` RPC).
Setting it to `'true'` brings back the five-field panel below with no deploy; agent
names typed in the meantime stay in `agent_name`, unlinked to an `agent_id`.

**The panel (rule on).** "To Be Filled By Validator" (`validator-fields.tsx`) has five
fields. Four are dropdowns. The first three are each narrowed by the one before it,
following the mapping in Admin → Settings ([admin-settings-and-config.md](admin-settings-and-config.md)):
- **Agency**
- **IMO**: only IMOs linked to that agency.
- **Final Carrier**: only carriers contracted through that IMO.
- **Agent Name**: independent of the three above — every active agent, always
  selectable. Changing the agency, IMO or carrier never clears it.

The fifth, **Policy Number**, is free text.

Changing a parent keeps any child that is still valid under it. A value the
lead already holds stays offered, so an old lead with a since-retired agent
still renders. A lead whose agent was typed before agents became a list shows
that text beneath the dropdowns. Save calls the 7-argument
`set_validator_fields`.

**The rule.** Customers are matched by `ssn_normalized` across every lead, or
by the lead itself when there's no SSN. A `carrier_declines` row with
`kind = 'carrier_rejected'` at IMO X → carrier C has two effects (revised
2026-10-06; it first also blocked the whole IMO):

| The validator picks… | Result |
|---|---|
| carrier C under **any other IMO** | **Blocked** (admin or general manager override only) |
| a **different carrier under IMO X** | **Allowed with a warning**; Save needs the "I understand" tick |
| anything else | Allowed |

Some declines don't block or warn, or do less:
- `fixable` and `unclassified` declines block and warn about nothing.
- Declines recorded before IMOs existed (`imo_id` null) block their carrier but
  can never warn, since they name no IMO.
- Blocks never expire.
- Closed leads are never re-checked. Mapping an old accepted lead skips the rule
  and keeps its typed `agent_name`, so its Sheet row isn't re-sent.

**Where it's enforced:**
- `set_validator_fields` (7-argument version) refuses a blocked combination,
  with a reason that names the carrier, IMO and date. For the same-IMO warning
  it refuses unless `p_acknowledge_warning` is true.
- `dispose_submission` re-checks only the **block** on accept. The warning is
  not re-asked there: it was acknowledged when the fields were saved.
- `placement_blocks` feeds the dropdowns. Blocked carriers are disabled, and a
  "Blocked for this customer" list under the selects gives each reason. It's
  display only.

**The warning.** When the chosen carrier shares an IMO with an earlier
rejection, an amber **Warning** box appears under the dropdowns with the
rejecting carrier, IMO and date, and an **I understand** tick. Save stays off
until it's ticked. The tick resets whenever the lead, IMO or carrier changes,
because that's a different decision. The save is recorded in the lead's
`validator_fields_set` event with `placement_warning` (the text shown) and
`warning_acknowledged: true`, so there's a trail that the validator went ahead
knowingly.

**Override.** In that list, an **admin or a general manager** can
**Override…** one blocked carrier for one lead (general managers added
2026-10-06, so the approvals are shared and don't queue on the admins). A reason
is required; it's stored in `placement_overrides` with who approved it, and
logged as a `placement_override` form event that also records the approver's
role. The rejection itself stays on file. Managers and validators can't
override, and there is deliberately no pass-code route around it: see
[decisions/0009](../decisions/0009-placement-rule-server-side-by-ssn.md).

**After Submit.** On an accepted lead, managers and admins get "Carrier
rejected this after Submit…". It records a `carrier_rejected`/`after_submit`
row without changing the lead's outcome.

**Manager queue.** Every Operations table shows a red **Prior rejections:
<carriers>** badge next to the customer when the customer has carrier
rejections on any lead. The data comes from the `submission_customer_rejections`
view.

**Old declines.** The 301 declines from before this feature were classified by
`classify_decline_reason()` from their reason text:
- 88 `carrier_rejected`: underwriting, medical, ineligible, age, dupe, already
  approved, maximum coverage, state.
- 48 `fixable`: account, bank, card, premium, SSN, identity, phone, beneficiary.
- 165 `unclassified`: 157 blank, plus 8 unclear.

**Go-live.** The live app doesn't call the new functions. While
`app_config.placement_rule_enabled = 'false'`, the old 4-argument
`set_validator_fields`, the old carrier-only `decline_with_carriers` and the
3-field accept gate all behave exactly as before. To go live, apply one
migration and deploy the app in the same window:

```sql
update public.app_config set value = 'true' where key = 'placement_rule_enabled';
```

From then on, the old two overloads raise "This screen is out of date. Refresh
the page", and accept needs all five fields. Before going live, the real
agencies, IMOs and carriers must be mapped and agents added. Otherwise
validators have nothing to pick and can't accept.

## Known limitations
- Validator self-submitted forms (`validator-form.tsx`) don't capture an IMO,
  so the placement rule doesn't see those placements. See `docs/TODO.md`.
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
