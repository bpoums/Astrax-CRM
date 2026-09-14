# 0005 — A submission's final status must be set in one INSERT, not INSERT-then-UPDATE

## Status
Current.

## Context
`submissions` has two triggers pushing to Google Sheets — `sheet_sync_on_insert`
(AFTER INSERT) and `sheet_sync_on_closed` (AFTER UPDATE), both calling
`notify_sheet_sync()`, which dispatches an outbound `net.http_post` to the
`sheet-sync` Edge Function (and on to Apps Script) reflecting the row's
current state.

`submit_form_parked` used to call `submit_form` (INSERT with
`status='pending_manager'`, firing the INSERT trigger), then immediately
`UPDATE ... SET status='parked'` on the same row (firing the UPDATE trigger).
That is two separate outbound HTTP requests, dispatched within the same
transaction, for the same submission id. Postgres marks the first attempt
`superseded` the instant the second is queued — but that only stops Postgres
itself from tracking the first attempt's outcome; the HTTP request already
handed to `pg_net` is not, and cannot be, cancelled. Apps Script's `doPost`
handler upserts by `Submission ID` and queues concurrent requests under its
own lock — nothing guarantees the *newer* request (the correct, `parked`
one) is the one that finishes last. In practice, the stale `pending_manager`
request occasionally won the race, leaving the Sheet showing a status
Supabase had already moved past — confirmed live on a real lead (Supabase
correctly `parked`, Sheet still reading `pending_manager`, with
`sheet_sync_attempts` showing the first attempt correctly marked
`superseded` and the second correctly resolved `ok` — the ordering problem
happens after Postgres's bookkeeping, on the wire to Apps Script).

## Decision
A submission's row must reach its intended final status in **one INSERT**,
never INSERT-then-UPDATE within the same logical "create" operation — so
that at most one sheet-sync trigger ever fires for that operation, and there
is nothing left to race.

Implemented by extracting the shared insert logic out of `submit_form` into
`submit_form_internal(p_payload jsonb, p_status sub_status)`, parameterized
on the target status (defaulting to `pending_manager`, with a validator's
own submission always auto-closing regardless of what's requested).
`submit_form(p_payload)` calls it with `null` (pending_manager);
`submit_form_parked(p_payload)` calls it with `'parked'` directly — one
INSERT, one trigger fire, no second write to race against.

`submit_form_internal` is **not exposed as a client-callable RPC** —
`EXECUTE` is revoked from `anon`/`authenticated`, reachable only through the
two `SECURITY DEFINER` wrappers (which run as their owning role, not the
caller's). This is deliberate, not incidental: if `p_status` were a plain
parameter on the public `submit_form`, any closer could call it directly
with `p_status: 'closed'` (or anything else) and skip the entire
`pending_manager` review start state. Splitting into an unreachable internal
function plus thin, fixed-status public wrappers is how a shared insert path
can be parameterized without widening what a client is allowed to ask for.

## Consequences
- Any future function that needs to write a `submissions` row through more
  than one intended state within a single logical operation should follow
  this pattern — resolve the final status *before* the one INSERT, rather
  than inserting a provisional state and updating it in the same call.
  Sheet sync has no request-ordering guarantee once two requests for the
  same row are in flight, and there's no cheap way to add one after the
  fact.
- A genuine, separate status change *after* creation (a manager assigning a
  parked-then-released lead, a validator disposing it, and so on) is exactly
  what the UPDATE trigger exists for — this decision is only about not
  manufacturing a second write inside what should be a single create.
- `submit_form_internal`'s existence is visible in `types.ts` (the type
  generator introspects `pg_proc` regardless of grants) but calling it
  through `supabase.rpc()` fails with a permission error — this is expected
  and is the point, not a bug to "fix" by granting access.
