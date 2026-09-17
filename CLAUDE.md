# ASTRAX CRM

TanStack Start + React 19 + Tailwind v4 + shadcn/ui, Supabase backend.
Internal call-center tool. Dense, information-first UI — not marketing.

This file stays terse by design — the day-to-day rules. For the full
picture (every table/RPC/view/policy verified directly against the live
database, per-feature workflow docs, and load-bearing architectural
decisions), see `docs/architecture.md`, `docs/database.md`,
`docs/authentication.md`, `docs/multi-tenancy.md`, `docs/features/*.md`,
and `docs/decisions/*.md` — last audited 2026-09-10. Where this file and
`docs/` disagree, `docs/` is the more recently verified one; both are kept
in sync when either changes.

## Feature workflow — follow this for every new feature or change

**Before writing any code:**

1. Read the relevant existing code, not just its docs.
2. Read the relevant `docs/features/*.md` file(s) for current behavior,
   known limitations, and prior decisions in that area.
3. Verify the relevant schema, RLS policies, RPCs, and migrations against
   the **live** database (see the MCP rule below) — never assume
   `docs/database.md`, `CLAUDE.md`, or the checked-in migrations are
   current; they can drift, and this repo has already caught them drifting
   once.
4. Enter Plan Mode and produce an implementation plan.
5. Wait for explicit approval before making any change. Do not start
   implementing on the strength of a plan that hasn't been approved.

**While implementing:**

- Follow the approved plan; if reality forces a deviation, surface it and
  get it re-approved rather than silently diverging.
- Reuse existing patterns and components — check `docs/features/*.md` and
  the components it names before writing a new one from scratch.
- Add no new dependency unless the task genuinely needs it.
- Touch only what the task requires — do not fix, refactor, or restyle
  unrelated code along the way.
- Any database change goes through a new Supabase migration file — never
  a one-off change applied only to the live project with nothing checked
  in.
- Every new access path follows the existing model: RLS scopes reads, a
  `SECURITY DEFINER` RPC gates writes and re-checks the caller's role
  itself. Don't add a client-reachable direct-write RLS policy as a
  shortcut — see `docs/decisions/0001-rls-as-the-only-boundary.md` and
  `0002-payload-writes-via-rpc.md` for why that pattern was deliberately
  narrowed to one table.

**After implementing:**

1. Verify the change actually works (typecheck/lint/tests as applicable;
   exercise the feature where practical).
2. Review the git diff yourself before calling the work done — confirm it
   touches only what the plan said it would.
3. Update the matching `docs/features/*.md` file to describe the new
   current behavior.
4. Update `docs/database.md` if any table/RLS/RPC/view/migration changed.
5. Add an entry to `CHANGELOG.md`.
6. Add or update a `docs/decisions/*.md` record **only** if a meaningful
   architectural decision was actually made — not for routine feature work.
7. Report back exactly what changed: code, database (including the
   migration file), and documentation — not a summary that omits one of
   the three.

## Documentation hierarchy — what each file is for

- `CLAUDE.md` — permanent project rules and working instructions (this file).
- `docs/features/*.md` — current behavior of individual features.
- `docs/database.md` — current database architecture.
- `docs/architecture.md`, `docs/authentication.md`, `docs/multi-tenancy.md`
  — current system-level architecture.
- `CHANGELOG.md` — chronological record of implemented changes.
- `docs/decisions/*.md` — important architectural decisions (ADRs), added
  sparingly.
- `docs/TODO.md` — known bugs, gaps, and future work (not yet created as of
  2026-09-10; create it the first time there's something to put in it,
  rather than leaving findings scattered only inside feature docs' "Known
  limitations" sections).
- Git commits — the exact implementation history.
- Supabase migrations — the exact database change history.

Docs describe **actual current behavior**, not intent. If a doc conflicts
with the code or the live database, investigate and correct the doc — never
assume the doc is right just because it's already written down.

## Verifying the database — always live, never assumed

For any question about current schema, RLS policies, RPCs, views, triggers,
or cron jobs: check the **live** Supabase database directly (the connected
Supabase MCP tools, when available) rather than trusting
`docs/database.md`, this file, or `supabase/migrations/` on their own.
`supabase/migrations/` is known to be behind the live schema — that gap is
exactly what the 2026-09-10 audit found, and there is nothing structural
stopping it from happening again between audits.

## Environment & deployment

- **npm, not bun.** Node 22. `bun` is not installed — `bun dev` fails.
- Deployed to **Cloudflare Workers**, not Vercel:
  ```
  npm run build
  npx wrangler deploy --compatibility-date 2026-08-01
  ```
  The `--compatibility-date` flag is **required**. `.output/server/wrangler.json`
  is regenerated on every build stamped with today's date, and Cloudflare rejects
  a date it considers to be in the future — which bites when deploying after
  ~7pm PKT.
- Live at <https://bpoums-closerform.umsvalidation.workers.dev>
- Supabase project ref `ozbpmrmndkemvvnlnudb`. **`supabase/config.toml`'s
  `project_id` (`pqvnfqwtojdaxwewbaal`) does not match this** — that file
  appears stale/disconnected from the live project. `npm run types` hardcodes
  the correct ref directly in its script command, so it is unaffected; be
  careful with any other `supabase` CLI command that would otherwise read
  `config.toml`.

### The app address lives in THREE places

Change the URL (a custom domain, say) and all three must be updated together, or
auth emails break silently — the link is sent but lands somewhere that cannot
consume it:

1. Supabase → Authentication → URL Configuration → **Site URL**
2. Supabase → Authentication → URL Configuration → **Redirect URLs**
   (must include `<url>/reset-password`)
3. The **`SITE_URL` secret** on the `invite-user` edge function

## Database — ALREADY MIGRATED. Never create or alter tables, policies, or functions.

`supabase/migrations` is NOT the source of truth; the live schema is ahead of it.

Enums (verified directly against the live database 2026-09-10 — full detail
in `docs/database.md`):
`app_role` (admin|manager|closing_manager|**general_manager**|closer|validator|data_uploader|cxm|cxa) — nine values; `general_manager` was previously missing from this list,
`sub_status` (pending_manager|assigned|in_review|returned_timeout|closed|**pending_import_approval**|**parked**) — seven values; the last two support the import-approval gate and the External Transfer/parked-lead flow and were previously missing from this list,
`disposition_t` (accepted|declined|**pending**)

Tables not listed below but present live and documented in
`docs/database.md`: `carriers`, `centers`, `carrier_declines`,
`cx_status_options`, `cx_lead_status`, `cx_status_history`, `cx_tags`,
`submission_tags`, `payload_edits`, `settings_audit`. `submissions` itself
also carries `cx_assigned_to`, `cx_assigned_at`, `center_id`, `center_name`,
`draft_date`, `future_draft_date`, `ssn_normalized`, `final_carrier_id`,
`agent_name`, `policy_number`, `reopened_from_cx_at` — none of which were in
this file's column list below until this audit.

- `profiles(id -> auth.users, full_name, role, active, staff_id, created_at)`
  — trigger auto-creates on signup, role `closer`
- `submissions(id, closer_id, payload jsonb, status, submitted_by_role,
  assigned_to, assigned_at, claimed_at,
  last_timeout_by, timeout_count, hold_count, last_held_at,
  last_rejected_by, rejection_count,
  disposition, disposed_by, disposed_at,
  archived_at, archived_by, created_at)`
  **plus** `source ('live'|'sheet')` — enforced by `submissions_source_chk`, so
  those are the only two values that exist; `'form'` is not one of them —
  `source_ref`, `uploaded_by`, `import_id`,
  `data_flags jsonb`. **`closer_id` IS NULLABLE** — a sheet lead has no closer.
  Use `closerName()` from `ops.tsx`; never read `closer.full_name` directly.
- `form_events(id, submission_id, actor_id, event_type, detail jsonb, created_at)`
- `lead_imports(id, uploaded_by, file_name, row_count, imported_count,
  skipped_count, created_at)`
- `payment_details(submission_id, payment_type, bank_name, routing_number,
  account_number, account_title, card_number, card_last4, card_exp, cvv,
  card_purged_at, cvv_purged_at, created_at)` — imported leads only
- `card_access_log(id, submission_id, actor_id, accessed_at)`
- `app_config(key, value)` — drives `review_window()`

Views (select from these; do not recompute their numbers client-side):

- `submission_totals` — one row: `closer_submissions, validator_submissions,
  approved, declined, pending, in_review, awaiting_manager, timeouts, rejections`
- `validator_stats` — per validator: `validator_id, validator_name, staff_id,
  assigned, approved, declined, pending, rejected, timed_out, holds`

Foreign keys used for embedded selects (spell them exactly):
`submissions_closer_id_fkey`, `submissions_assigned_to_fkey`,
`submissions_last_timeout_by_fkey`, `submissions_last_rejected_by_fkey`,
`submissions_disposed_by_fkey`, `submissions_archived_by_fkey`,
`submissions_uploaded_by_fkey`, `lead_imports_uploaded_by_fkey`,
`form_events_actor_id_fkey`, `card_access_log_actor_id_fkey`.

Each of those FKs resolves to **both** `profiles` and `validator_stats`. Naming
`profiles` in the hint (`closer:profiles!submissions_closer_id_fkey(full_name)`)
is what disambiguates it — keep that form.

## All writes go through RPCs. Never insert/update these tables from the client.

This list covers the ones a screen you're likely to touch will call. It is
**not exhaustive** — roughly 30 more exist (CX lifecycle, spreadsheet-import
approval, carriers/settings admin, validator-completed fields, purge jobs).
Full list with role gates in `docs/database.md`.

- `submit_form(p_payload jsonb)`
- `assign_to_validator(p_sub uuid, p_validator uuid)`
- `claim_submission(p_sub uuid)`
- `hold_submission(p_sub uuid)`
- `reject_assignment(p_sub uuid, p_reason text?)`
- `dispose_submission(p_sub uuid, p_disposition disposition_t)`
- `archive_submission(p_sub uuid, p_reason text?)` — manager/admin only
- `unarchive_submission(p_sub uuid)` — manager/admin only
- `start_lead_import(p_file_name text, p_row_count int)` — opens a batch
- `clear_data_flag(p_sub uuid, p_field text)` — manager/admin resolve action
- `payment_summary(p_sub uuid)` — bank fields plus `card_last4`, never the number
- `card_details(p_sub uuid)` — full card; validator, in_review, theirs, **logged**
- `update_payment_field(p_sub uuid, p_field text, p_value text)` — manager/admin
  (and cxa/cxm on their own pipeline lead) for `payment_type`, `bank_name`,
  `routing_number`, `account_number`, `account_title`, `card_exp`;
  **admin only** for `card_number` and `cvv`. It
  raises its own authorisation message; show that message rather than a generic
  one.

Imported leads are written by the `ingest-sheet-lead` edge function, not by the
browser. It is invoked with `{ import_id, leads: [{ source_ref, payload, flags,
payment }] }` in batches of 50 (its own ceiling is 200).

**Corrected 2026-09-10**: this used to document a second direct-write
exception for `submissions.payload` — verified against the live RLS policies
and it no longer exists (if it ever did). `submissions` has **zero** RLS
write policies of any kind; every mutation on it, `payload` included, goes
through a named RPC. The one real exception is:

- an admin may `update` `profiles` directly (not just `role` — the live
  policy is `FOR ALL`, which is also how the Users tab's activate/deactivate
  and center/org-label edits work).

The data-flag correction flow (`src/components/data-flags.tsx`) writes the
value through `update_payload_field(p_sub, p_field, p_value)` (payload) or
`update_payment_field` (payment fields), and calls `clear_data_flag` only
after that write succeeds — same order, same RPC-only path, just not a
direct table write. See `docs/decisions/0002-payload-writes-via-rpc.md`.

Reads go through `supabase.from(...)` and RLS scopes them per role.

## Workflow rules — do not break these

- **Only `accepted` is terminal.** It is displayed everywhere as **"Submit"**;
  spelled once in `DISPOSITION_LABEL` in `ops.tsx` and read everywhere through
  `dispositionLabel()` — never hardcode the word in a button or a cell. The
  stored value and the value sent to the RPC stay `accepted`. `declined` and
  `pending` record the outcome and return the lead to the manager's Operations
  queue — they are not end states.
- **Validator-submitted forms** (`submitted_by_role = 'validator'`) auto-close as
  accepted and are never assignable. Keep them out of the manager queue.
- **The 20-minute review window is enforced server-side in three places**: the RLS
  read policy, `dispose_submission`, and the pg_cron sweep. All three read
  `review_window()`, which is driven by `app_config`. Never enforce it
  client-side. Client countdowns are display only — when one hits zero, close the
  view, invalidate the query and toast. Do not fire an RPC on expiry.
- **Archived rows** (`archived_at not null`) are excluded from every queue, the
  timeout sweep, and reporting. Every submissions query needs
  `.is("archived_at", null)` unless it is deliberately listing archived rows.
- **Google Sheets sync is server-side.** A Postgres trigger calls the `sheet-sync`
  edge function, which posts to Apps Script. Validator submissions go to one
  spreadsheet, closer submissions to another. The browser never writes to Sheets.
- **The n8n webhook is retired.** Do not reintroduce any client-side webhook
  write. Supabase is the only write path from the browser.
- **Payment data never goes in `payload`.** `payload` is what the sheet-sync
  trigger pushes to Google Sheets. A card number placed there is exported to a
  spreadsheet. For imported leads every instrument field goes in the `payment`
  object, which lands in `payment_details` and is never synced.
- **Card numbers and CVVs never reach a manager's or uploader's browser.** The
  uploader sees the last four and corrects a mis-parse by re-parsing the
  original cell, never by reading or typing the number. Managers get
  `payment_summary`. Only a validator inside their own open review can call
  `card_details`, and every call is logged to `card_access_log`.

## Flow

```
closer submits -> pending_manager -> manager assigns -> assigned
  -> validator confirms "ready" -> in_review (claimed_at set)
       -> Submit              -> closed (terminal)
       -> Declined / Pending  -> outcome recorded, back to pending_manager
       -> Hold                -> back to assigned; reopening re-claims and
                                 restarts the FULL window (no resume)
       -> window elapses      -> returned_timeout (tagged last_timeout_by)
  -> validator rejects the assignment -> back to pending_manager
       (last_rejected_by, rejection_count)
any state -> archived (archived_at) -> out of every queue until unarchived
```

## Roles

Nine of them, and RLS is what actually separates them — the client-side guard
in `requireRole()` only keeps someone off a screen that would show them nothing.

- **admin** — everything. User management, settings, the audit trail (the
  Audit tab is currently commented out in `admin.tsx` — see
  `docs/features/payments-security.md`).
- **manager** — the validation queue. Assigns to validators, disposes, archives.
- **closing_manager** — every closer-originated lead **in their own center**
  (`profiles.center_id` scoped). Edits the payload, and every edit is
  recorded. Reads the CX statuses but cannot set them.
- **general_manager** — the same screen as `closing_manager`
  (`/closing`, `ClosingDesk`), but across **every** center and both
  closer- and validator-originated leads — the scope difference is entirely
  server-side (see `docs/multi-tenancy.md`). Also the only role besides admin
  that can release a parked lead (`move_to_validation`).
- **closer** — submits the form. Sees nothing else, plus their own
  Forwarded Leads (sensitive fields stripped server-side).
- **validator** — only the leads assigned to them, and only inside the review
  window. Disposes them.
- **data_uploader** — `/upload` and nothing else, and only the leads they
  imported themselves.
- **cxm** / **cxa** — the CX pipeline: approved leads, plus any lead they sent
  back for re-validation, until one of them removes it
  (`remove_from_cx_pipeline`; admin-only `restore_to_cx_pipeline` undoes it).
  They set the four CX statuses and may edit a lead's payload and bank fields
  on their own queue — never `card_number`/`cvv`, which stay admin-only.
  Three of the four CX-pipeline tabs (Transfer, Chargeback, Analytics) are
  placeholders — only Customers Pipeline is built. See
  `docs/features/cx-lifecycle.md`.

`my_role()` reads `select role from profiles where id = auth.uid() and active`,
so **an inactive profile resolves to no role at all** — NULL. Deactivation
cascades through every **policy** in one write, because RLS compares with `=`
and NULL never matches; there is no second place to revoke access, and no
policy that needs an `active` check of its own. A trigger (`guard_last_admin`)
refuses to deactivate or demote the last active admin, so that cascade cannot
lock everyone out.

**Corrected 2026-09-17: it does NOT currently cascade through every RPC.** A
guard written `if my_role() <> 'admin'` (or `not in (...)`) does not fire on a
NULL role — `NULL <> 'admin'` is NULL, not true — so the function returns its
data to a caller with no profile, no JWT, or an inactive one. Verified live:
`admin_settings()` and `reporting_retention_status()` both returned data to
`anon`. **Write every new guard as `my_role() is distinct from 'admin'`**, and
revoke EXECUTE from `anon` by name (revoking from `public` does not remove
Supabase's direct grant). ~20 existing RPCs still need fixing — see
`docs/TODO.md`.

**In an RLS policy always write `(select my_role())`, never a bare
`my_role()`** — same for `(select auth.uid())`. A bare call is evaluated once
per candidate row; the subquery makes it an InitPlan evaluated once per query.
Because `my_role()` is `SECURITY DEFINER` and hits `profiles`, the bare form
cost ~6 µs per row per call site and made every query scale with table size —
it was the entire reason the app slowed down as data grew (2026-09-17,
`20260917120000`). The value is identical either way; only the timing changes.

### A refused read is not an empty result

Every guard that raises `not authorized` must reach the user **as an
authorisation error**. Never let it fall through to an empty state.

A `SECURITY DEFINER` RPC that raises and one that legitimately returns nothing
arrive at the client as the same shape — `data` undefined — so the natural
`if (!data) return <Empty/>` renders "no details attached" over a refusal. The
reader then goes looking for missing data that was never missing. Branch on the
error before the empty case and print the message the function raised; it is
written to be read (`payment_summary` says "not authorized", `card_details` says
"not assigned to you", `update_payload_field` names the field it refused).

## Auth model

- **There is no public signup page, by design.** Nothing in the client may call
  `signUp`. Accounts are created by an admin through the `invite-user` edge
  function, which invites by email and sets `role` and `staff_id` in one call.
- Invited users set their own password at `/reset-password`, which is also the
  target of the "Forgot password?" flow on `/login`.
- Auth email goes through **Gmail SMTP** (`bpoums@gmail.com`, app password held
  in Supabase — not in this repo). No custom sending domain yet, so mail may land
  in spam.
- `invite-user` runs with `verify_jwt: true`, re-checks that the caller is an
  admin, and returns `{ error: "..." }` with useful text (duplicate email,
  invalid role). `supabase.functions.invoke` surfaces any non-2xx as a generic
  message — read the real one off `FunctionsHttpError.context.json()`.
- Password-reset and invite links report failure in the **URL fragment**
  (`#error=access_denied&error_code=otp_expired`), not as a failed request.

## Layout

- `src/lib/auth.tsx` — `AuthProvider`, `useAuth()`, `roleHome`, `ROLE_LABEL`,
  and `requireRole()`, the `beforeLoad` guard every `_authenticated` route uses.
  A `data_uploader` reaches `/upload` and nothing else. Mounted in
  `src/routes/__root.tsx` inside `QueryClientProvider`, alongside the Sonner
  `<Toaster />`. Both are required for the app to boot.
- `src/routes/login.tsx` — sign in + "Forgot password?" (`resetPasswordForEmail`).
- `src/routes/reset-password.tsx` — **public**, outside the auth gate. Sets a
  password on an existing account; it must never create one.
- `src/routes/_authenticated/route.tsx` — auth gate, `ssr: false` + `beforeLoad`
  redirect to `/login`.
- `src/routes/index.tsx` — `beforeLoad` redirects by role: unauthenticated ->
  `/login`, otherwise `roleHome[role]`.
- `src/routes/_authenticated/closer.tsx` + `src/components/closer-form.tsx` —
  the closer's single fixed form, no carrier step.
- `src/routes/_authenticated/validator-form.tsx` +
  `src/components/validator-form.tsx` — the per-carrier form (TransAmerica,
  Amicable, Insta Brain, Corbridge). Both forms write through `submit_form` only.
  Field labels ARE the jsonb keys and the Sheet column headers — changing a label
  changes a column. Do not touch the zodiac/age/SSN-masking/MM-YY/zip-weather
  logic.
- `src/routes/_authenticated/manager.tsx` — Operations + Reporting tabs. Queue,
  realtime, bulk assign, dispose, archive. **This is the reference
  implementation.** Mirror its query/mutation/realtime structure before writing
  anything new.
- `src/routes/_authenticated/validator.tsx` — own queue, "Are you ready?" confirm
  -> `claim_submission`, detail sheet with countdown, Submit/Decline/Pending,
  Hold, and "Can't take this" (reject).
- `src/routes/_authenticated/admin.tsx` — **not thin anymore.** Tabs:
  Overview, Submissions, Parked Leads, Customer Pipeline (read-only), By
  Draft Date, **Exports** (added 2026-09-10 — filter/select accepted leads,
  download CSV/Excel, see `docs/features/lead-export.md`), Users, Uploads,
  Settings. Also mounts the read-only admin previews of the closer and
  validator forms via nav links. Two tabs (Imports, Audit) exist in code but
  are commented out.
- `src/components/reporting.tsx` — `ReportingDashboard`, **shared by the admin
  page and the manager's Reporting tab** so the two never drift. Stat cards,
  per-validator table, Closer/Validator submission tabs, archived toggle,
  `form_events` timeline per row. A change here lands in both places.
- `src/components/user-admin.tsx` — admin-only invite panel + user list with
  inline role change.
- `src/routes/_authenticated/upload.tsx` + `src/components/data-uploader.tsx`,
  `upload-review.tsx`, `import-history.tsx` — the data uploader's only screen:
  upload -> map -> review -> import. Files are parsed **in the browser**
  (papaparse / SheetJS) and never leave the machine until Import is pressed.
- `src/lib/normalize/` — the detection and normalisation engine. **Pure**: no
  I/O, no React, no browser globals, so it can be lifted into a Deno edge
  function unchanged. **No LLM or AI call belongs anywhere in it** —
  deterministic rules only, so results are fast, free, repeatable and auditable.
  Vitest covers every rule (`npm test`).
  Dates normalise to **MM/DD/YYYY**; parsing still accepts ISO, day-first,
  two-digit years, named months and spreadsheet serials.
  The core principle: **detect from cell content, treat headers as hints.** Real
  files put a card in a column headed "Routing / Card Detail". One cell can
  yield several fields. Where the header and the content disagree, the content
  wins and the row is flagged.
- `src/lib/canonical-fields.ts` — the import target fields, **derived from the
  closer form's `SECTIONS`**, not restated. Change a form label and the import
  target moves with it. Only the card fields are declared here, because the
  closer form has no equivalent.
- `src/components/payment-panel.tsx` — banking for one submission, via
  `payment_summary` / `card_details`.
- `src/components/data-flags.tsx` — `DataFlagList`, the flag list wherever flags
  are shown. **A flag is never cleared on its own.** Clearing without changing
  the value hides the problem instead of fixing it, so the primary action edits
  the value and clears the flag afterwards; "Ignore without fixing" is a
  separate, quieter action that says plainly that nothing changed. Read-only for
  validators and reporting; editable for managers and admins.
  A lead's values sit in **two stores** and the operator is not shown that:
  payload fields update `submissions.payload`, payment fields go through
  `update_payment_field`, and both then call `clear_data_flag`. `card_number`
  and `cvv` cannot be read back out of `payment_summary`, so their inputs start
  empty, say that whatever is typed replaces the stored value, and render for
  admins only.
  The uploader's pre-import grid gets the same treatment in `upload-review.tsx`,
  where a dismissed flag is simply not sent to the database.
- `src/lib/payment-summary.ts` — `usePaymentSummary`, `paymentSummaryKey`. Both
  the banking panel and the flag editor read this one cache entry, so a payment
  correction invalidates the key the panel is drawing from. Don't re-query
  `payment_summary` by hand.
- `src/components/ops.tsx` — `AppHeader`, `PayloadTable`, `StatusBadge`,
  `DispositionBadge`, `OriginBadge`, `FlagBadge`, `dispositionLabel`,
  `customerName`, `closerName`, `dataFlags`, `relativeTime`, `remainingMs`,
  `formatClock`, `useNow`, `useReviewSettings`, `REVIEW_WINDOW_MS`,
  `SubmissionRow`, `Disposition`, `LeadSource`. Reuse these; don't reimplement
  them.

`src/routeTree.gen.ts` is generated — let the dev server rebuild it, never
hand-edit. A new route file will not typecheck until the dev server has run.

## Design system — compose from these, don't invent

All styling lives in `src/styles.css` as Tailwind v4 `@utility` classes. Use them.
Never hardcode a hex/rgb colour, never add a new colour token, never introduce
another font. If something needs a colour, it's already a semantic variable:
`background`, `foreground`, `card`, `primary`, `accent`, `muted`,
`muted-foreground`, `border`, `input`, `ring`, `destructive`.

Custom utilities available:

- `.panel` — card container, gradient fill, hides its own scrollbar
- `.panel-title` — section heading: 0.7rem, uppercase, 0.22em tracking, muted
- `.field-label` — 0.66rem, uppercase, muted, truncates
- `.table-head-band` — the recessed fill behind a table header row. Applied by
  `TableHeader` in `components/ui/table.tsx`, paired with `.field-label` on
  `TableHead`, so every table in the app gets the same header treatment — style
  it there, never per table.
- `.field-input` — form input, amber focus ring
- `.chip` / `.chip-active` — pill toggle buttons (used for radio-style choices)
- `.btn-submit` — primary amber pill button with glow shadow
- `.font-display` — Space Grotesk, for headings only

Rules:

- Amber (accent) is the ONLY accent colour. Use it sparingly — one emphasis
  per view. Destructive red is for timeouts and declines only.
- Dense by default. Small type, tight gaps (`gap-2`/`gap-3`), no generous padding.
  This is an ops console used all day, not a landing page.
- Headings use `.font-display`; body inherits DM Sans automatically.
- shadcn components already read the same CSS variables, so Table/Sheet/Dialog/
  Badge match without extra work. Style them with semantic Tailwind classes
  (`text-muted-foreground`, `border-border`) rather than custom CSS.

**One deliberate exception:** `DispositionBadge` in `ops.tsx` uses a hardcoded
`emerald` green for the `accepted` outcome, because a red/amber/green outcome
scale was asked
for and there is no green token. It is the only hardcoded colour in the app —
leave it, or promote it to a real token; don't quietly "fix" it back to amber.

### Careful: `:root` IS the dark theme

The `.dark` block in `src/styles.css` contains a generic shadcn palette that does
NOT match the brand. Never add a `dark` class to any element or wrapper — it
overrides the amber/navy identity with grey.

## Working on this repo

- Scripts: `dev` (`vite dev`), `build`, `lint` (`eslint .`),
  `format` (`prettier --write .`), `types` (regenerates the Supabase types),
  `test` (`vitest run`, the normalisation engine).
  There is no `typecheck` script — run `npx tsc --noEmit`.
- **`npm test` currently fails 1 of 140 tests**, found during the
  2026-09-10 audit and not yet fixed:
  `src/lib/normalize/review-columns.test.ts` — "does not lose the card
  columns when the only card number is cleared." Root cause: the closer
  form's own `"Card Number"` field and `canonical-fields.ts`'s hand-written
  `CARD_FIELDS` both produce a catalog entry keyed `card_number`, and
  `buildLead()`/`setLeadField()` resolve that duplicate key two different
  ways (`Map` vs `Array.find`, so last-write-wins vs first-match). See
  `docs/decisions/0003-deterministic-import-normalization.md`. This is
  pre-existing, not introduced by this audit, and fixing it is an
  application-code change outside this pass's scope.

### Generated types are a rule, not a note

- `src/integrations/supabase/types.ts` is **GENERATED — never hand-edit it**, not
  even to add one missing column. Run `npm run types` after any schema change and
  commit the result. Hand-patching it previously shipped a wrong return type that
  the generator caught. The same goes for `src/integrations/supabase/client.ts`.
- `tsconfig` is strict, including `noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature` and `exactOptionalPropertyTypes`.
- Because of `exactOptionalPropertyTypes`, an optional RPC arg typed
  `p_reason?: string` **rejects an explicit `null`** — omit the key entirely and
  let the SQL default apply:
  ```ts
  supabase.rpc("reject_assignment", reason ? { p_sub: id, p_reason: reason } : { p_sub: id });
  ```

### Lint

`npm run lint` is dirty repo-wide: `core.autocrlf=true` gives the working tree
CRLF endings while prettier expects LF, so nearly every pre-existing file reports
`Delete ␍`. Lint the files you touched (`npx eslint <paths>`) rather than reading
the repo-wide total.
