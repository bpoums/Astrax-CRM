# 0007 — Duplicate SSN now blocks submission, exempted only by a CX-applied tag

## Status
Current, added 2026-09-25.

## Context
`check_duplicate_ssn` and `duplicateSsnWarning()` were built as **advisory
only, never blocking** — documented as a deliberate choice, because a
repeat SSN is often a legitimate re-write of a lead after a decline, and
refusing the submission on a guess would lose a real sale.

The business rule changed: a duplicate SSN must now actually stop a
submission — closer or validator — when it matches an **accepted**
("Submitted") lead, unless a CX agent has explicitly marked that customer
as eligible for a second policy. A duplicate against a **declined** or
**still-in-progress** lead keeps the original leniency and only warns,
exactly as before — that case is still very often a legitimate re-write
(e.g. after a decline), and the request was specifically about a customer
who already has a sold policy, not one whose earlier attempt didn't go
through.

## Decision
- `submit_form_internal` (the single insert point behind `submit_form`,
  `submit_form_parked`, and the validator's own direct submission) now
  `raise exception`s before inserting when the payload's SSN matches
  `ssn_normalized` on another non-archived submission **with
  `disposition = 'accepted'`**, **unless** at least one of those accepted
  matches carries a `cx_tags` row via `submission_tags` where
  `allows_duplicate_ssn` is true. One exempted accepted match anywhere in
  the SSN's history is enough — the block does not require every duplicate
  to be individually cleared. A declined or undisposed (in-progress)
  duplicate is not examined by this check at all.
- The exemption is applied to the **existing** (already-filed) lead, not
  the new one — CX marks the customer's on-file policy as "this person may
  have a second one," which then opens the door for a new submission with
  the same SSN. This reuses the pre-existing, already-wired
  `add_submission_tag`/`remove_submission_tag` RPCs unchanged: they already
  require the target lead to be `disposition = 'accepted'` and not
  archived, which is exactly "the customer's existing, sold policy" — no
  RPC change was needed, only a UI (`SubmissionTags`) to call them. See
  [database.md](../database.md) and
  [features/cx-lifecycle.md](../features/cx-lifecycle.md).
- The exemption is a **property of the tag** (`cx_tags.allows_duplicate_ssn`),
  not a hardcoded tag name or id. One tag is seeded with it,
  "Eligible For Second Policy," but any tag an admin or cxm marks this way
  grants the same exemption — `cx_tags` is one of the few tables a `cxm`
  can write directly (`FOR ALL` RLS), so this vocabulary doesn't require
  admin involvement to extend.
- `check_duplicate_ssn` stays read-only/advisory and un-gating — it is
  still only ever called from a field's blur handler, never from the
  submit path — but now also returns `exempt` (meaningful only when
  `status = 'accepted'`), so the client-side hint can warn accurately about
  what submitting will actually do: an accepted match names the block
  explicitly; a declined/in-progress match keeps its original, unchanged
  wording ("you may still proceed").
- Scope: **every** call path through `submit_form_internal` for the
  accepted-match check specifically — both the closer's forms and the
  validator's own auto-accepting submission. A duplicate on a validator's
  own submission is written straight to `closed`/`accepted` with no review
  step, so leaving that path unguarded would have been a bigger gap than
  the closer path, not a smaller one. Declined/in-progress duplicates are
  untouched on both forms.

## Addendum (2026-09-25) — manager and general_manager can also apply the tag

Originally `add_submission_tag`/`remove_submission_tag` and the
`cx_tags`/`submission_tags` read policies stayed at their pre-existing
cxa/cxm/admin gate — `SubmissionTags` was mounted only in the Customers
Pipeline detail sheet those three roles reach. Extended same-day to
`manager` and `general_manager`, since both can already see and edit an
accepted lead from their own screens (`ReportingDashboard`'s Reporting tab,
`ClosingDesk`) and the request was specifically for those two roles (plus
admin, already covered) to be able to apply the tag too.

`closing_manager` — who shares the `ClosingDesk` screen with
`general_manager` — was deliberately left out of both the RPC role check
and the UI mount, rather than given a control that would call the RPC and
receive "not authorized." The gate is enforced twice, redundantly on
purpose: server-side in the RPC (the real boundary) and client-side in
`ClosingDesk` (`profile.role === "general_manager"`), so a `closing_manager`
never even sees the control.

Every mount (Customers Pipeline, Reporting, Closing Desk) only renders
`SubmissionTags` when the lead is `disposition === "accepted"`, since
`add_submission_tag` refuses anything else — showing the chip list on a
lead where every click would fail was avoided rather than left to the
RPC's own error message.

## Consequences
- A closer or validator can now be refused a submission outright when the
  SSN already belongs to an accepted lead — where before that case was
  also only warned. A declined or in-progress duplicate is completely
  unaffected: still just a warning, still a normal re-write. The
  workaround for the blocked case is procedural, not technical: ask CX to
  tag the original accepted policy. This trades a small amount of
  closer/validator friction, only on the accepted case, for actually
  preventing the duplicate-*policy* case the business wanted stopped.
- `submission_tags`, wired end-to-end since `20260821184015` but unused in
  production (0 rows) until now, has its first real consumer and its first
  UI mount (`SubmissionTags` in the Customers Pipeline detail sheet).
- The exemption check runs an extra `EXISTS` query per submission with a
  9-digit SSN — negligible at current volume, indexed on
  `ssn_normalized`/`archived_at` the same way `check_duplicate_ssn` already
  was.
