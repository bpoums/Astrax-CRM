# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Nine roles, separated by what each may see rather than by screen furniture. All
of them are staff of the operation — there is no customer-facing surface and no
public signup; accounts exist only because an admin invited them.

- **closer** — takes the call and submits the lead. Sees the submission form and
  their own forwarded leads, nothing else.
- **validator** — verifies a submitted lead against the customer inside a timed
  review window, then records the outcome. Sees only leads assigned to them, and
  only while the window is open.
- **manager** — works the validation queue: assigns leads to validators, disposes
  them, archives, and approves uploaded batches.
- **closing_manager** — every closer-originated lead in their own centre, at any
  stage, with the payload editable in place.
- **general_manager** — the same desk across every centre, and both closer and
  validator work. Also releases parked External Transfer leads into the queue.
- **cxa** / **cxm** — the customer-lifecycle team. Work approved leads only, and
  set the four post-sale statuses.
- **data_uploader** — imports leads from spreadsheets, and sees only the leads
  they imported themselves.
- **admin** — everything, plus user management, centres, carriers, the CX status
  vocabulary, operational settings and the audit trail.

## Product Purpose

ASTRAX is the operations console for a US life/final-expense insurance sales
operation. A closer takes a sale on the phone; the console is what happens next
— a second person verifies it before it reaches a carrier, and the outcome is
tracked until the money is safe.

Confirmed as its core jobs, all four at once:

1. **A quality gate before the carrier.** Every sale is re-verified by a
   different person inside a timed review window before it goes out.
2. **Post-sale lifecycle and chargebacks.** Policy, premium, commission and
   chargeback status are tracked after approval so revenue that falls through is
   caught rather than discovered later.
3. **An auditable record.** Who did what to which lead, defensibly.
4. **Throughput and routing.** Leads reach the right validator quickly and
   nothing sits stuck.

Success is a sale that survives: verified before submission, placed with a
carrier, and still paying months later.

## Positioning

Internal, and deliberately not a CRM. The mechanism a neighbouring tool would
not truthfully copy is the **timed second-person review**: a lead is handed to a
named validator who has a fixed window to confirm it with the customer, and the
window is enforced by the database — in the read policy, in the disposal
function, and in a scheduled sweep — not by the interface. A lead nobody
finishes in time returns to the queue on its own, tagged with who had it.

The second is that **only acceptance is terminal**. Declined and Pending are
recorded outcomes that send a lead back to a manager rather than ending it, so
work is never silently lost.

## Operating Context

- **Staff in Pakistan working United States hours.** Every date and time in the
  interface is rendered in `America/Los_Angeles`, the timezone the business
  operates on, so a lead taken at 4pm Pacific does not read as tomorrow to the
  person reviewing it. The one deliberate exception is the closer form's weather
  clock, which shows the customer's own local time.
- **Desk-based work on desktops and laptops during US business hours.**
  Confirmed: small screens are not a working scenario for any role. Queues are
  dense, wide tables by design.
- **Multiple centres.** Staff belong to a centre (UMS BPO and DESCOM are the
  two currently active); a lead is stamped with the centre it was taken in, at
  the moment it was taken, so renaming or moving a person never rewrites
  history.
- **Google Sheets is a downstream system of record.** A Postgres trigger calls an
  edge function that posts to Apps Script; validator submissions go to one
  spreadsheet and closer submissions to another, routed by role. The browser
  never writes to Sheets. Form field labels ARE the payload keys and the Sheet
  column headers, so renaming a label renames a column.
- **Two ways a lead arrives.** A closer submits one live, or a data uploader
  imports a spreadsheet through a browser-side normalisation and mapping flow
  that a manager then approves batch by batch.
- **Carriers, centres, CX statuses and the review window are configured in the
  app**, not in code. Adding a carrier or a centre is an admin action requiring
  no deploy.

## Capabilities and Constraints

**Confirmed functionality**

- Two intake forms: a fixed one for closers, and a per-carrier one for
  validators' own submissions (which auto-accept and are never assigned out).
- Validation queue with assignment, claiming, holds, rejection, timeout sweep,
  and per-carrier decline records.
- Three validator-completed fields — final carrier, agent name, policy number —
  required before a closer-originated lead can be accepted.
- External Transfer: a closer can park a lead out of every queue until a general
  manager or admin releases it.
- Customer lifecycle across four independent dimensions (policy, premium,
  commission, chargeback). A policy marked Declined, Withdrawn or Cancelled
  returns the lead to the manager's queue for another attempt.
- Spreadsheet import with deterministic field detection, data flags, and a
  manager approval gate.
- Reporting over a selectable window (today / 7 / 30 days / all time), plus a
  live queue view that is deliberately not windowed.

**Durable technical constraints**

- **The database is the security boundary.** Row-level security scopes every
  read per role, and every write goes through a `SECURITY DEFINER` function.
  The client-side route guard only keeps a role off a screen that would show
  them nothing; it grants nothing.
- **An inactive profile resolves to no role at all**, so deactivating a user
  revokes access everywhere in one write. A trigger refuses to deactivate or
  demote the last remaining admin.
- **Payment data never travels in `payload`**, because `payload` is what is
  pushed to Google Sheets. Card numbers and CVVs never reach a manager's or an
  uploader's browser; only a validator inside their own open review may read a
  full card, and every such read is logged.
- **The normalisation engine is deterministic.** No LLM or AI call belongs in
  it, so import results stay fast, free, repeatable and auditable.
- Deployed to Cloudflare Workers. The app's address exists in three places —
  Supabase Site URL, Supabase Redirect URLs, and the invite function's secret —
  and all three must move together or auth email breaks silently.
- The live schema is ahead of the checked-in migrations; the database is the
  source of truth.

**Terminology that must not drift**

- The `accepted` outcome is shown everywhere as **"Submit" / "Submitted"**,
  never as "Approved". The stored value stays `accepted`.
- A validator's own submission stores the carrier under the key `Agency`, which
  the Apps Script uses to route a Sheet tab. The key cannot be renamed; it is
  displayed as "Carrier Name".
- A **pass** is one validator's tenure with a lead, from assignment to outcome.

## Brand Commitments

- The product is **ASTRAX**. UMS BPO is the operating company that runs it, and
  DESCOM is a second centre whose staff also log in.
- The ASTRAX lockup — mark, wordmark and tagline — ships as `public/logo.png`
  with `public/logo.svg` alongside it, at a 885×176 aspect ratio. It appears in
  the header of every screen.

## Evidence on Hand

- **A live production system with real data**: roughly 390 submissions across
  two active centres, real staff and customer records, running at
  <https://bpoums-closerform.umsvalidation.workers.dev>. Supabase project ref
  `ozbpmrmndkemvvnlnudb`.
- `CLAUDE.md` at the repository root is the maintained engineering record of
  schema, workflow rules and deployment, and is more current than any other doc.
- **`README.md` is stale boilerplate from an unrelated Lovable project
  ("Workflow Explorer", n8n).** It describes neither this product nor its
  workflow and should not be read as product truth.
- **There is no marketing material, no customer testimonial, no case study, no
  pricing and no public site.** This is an internal tool. Future work must not
  invent any of these.

## Product Principles

1. **The server decides; the client displays.** Scope, permission and timing are
   settled by RLS and RPCs. Re-deriving any of them in the browser creates a
   second source of truth that will drift.
2. **Every state change is attributable.** An actor and an event are recorded
   for anything that moves a lead, because the audit trail is a product feature
   and not a debugging aid.
3. **Sensitive instrument data stays contained.** Payment fields never ride with
   the payload, never reach a browser without a reason, and are logged when they
   do.
4. **No lead is ever lost.** Only acceptance ends a lead's journey; every other
   outcome returns it to somebody's queue, and anything stuck should be visible
   as stuck.
5. **The downstream contract is load-bearing.** Field labels, payload keys and
   Sheet columns are the same strings. Renaming one renames all three.
