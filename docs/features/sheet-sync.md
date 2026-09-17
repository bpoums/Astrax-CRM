# Google Sheets sync

## Purpose
Mirror every submission into Google Sheets, where the owner and the daily email
export read it. The Sheet is a **management reporting mirror, not a working
surface** — nobody operates the business out of it, which is what makes
eventual consistency acceptable.

## Current status
Live. Queue-based since 2026-09-17
([decisions/0006](../decisions/0006-sheet-sync-queue-not-fire-on-trigger.md)).
The backlog is **empty**: the Apps Script permission failure that held 14 uploaded
leads out of the Sheet was fixed by the script owner on 2026-09-18 and the
queue drained to zero.

## Roles involved
Nobody triggers a sync by hand. It is entirely server-side; the browser never
writes to Sheets. Only **admin** can see the backlog.

## How it works

```
submission insert/update
  -> notify_sheet_sync()          trigger: ENQUEUES only, no I/O
  -> sheet_sync_queue             PK submission_id, so repeat changes collapse
  -> drain_sheet_sync_queue()     pg_cron, every 60s, up to 25 rows as ONE post
  -> sheet-sync edge function     walks the batch SEQUENTIALLY
  -> Apps Script web app          one write at a time, 30s LockService lock
  -> resolve_sheet_syncs()        only confirmed success removes a row
```

The two load-bearing details, both the result of measured failures:

- **`submission_id` is the primary key.** A lead whose status changes four
  times before the drain runs collapses into one row and one write carrying
  the final state, rather than four writes racing each other.
- **A batch is walked sequentially, never in parallel.** Google rejects
  concurrent requests to an Apps Script web app — measured at ~20% failure with
  5 at once and ~61% with 59. Sending N rows as one request that is walked in
  turn is the entire fix, and it needed no change to the Apps Script, whose
  deployment we do not own.

An Apps Script **HTTP 200 does not mean the row was written** — it answers 200
with an HTML error page when `doPost` throws. `appsScriptFailure()` in the edge
function inspects the body for the three failure shapes that arrive as 200, so
a failure is recorded as a failure and retried rather than logged `ok`.

## Routes / screens
`/admin?tab=overview` → `SheetSyncBacklogCard`
(`src/components/sheet-sync-backlog.tsx`).

Read-only: queued, in flight, how many are failing, and the age of the oldest.
It turns destructive when anything has failed 5+ times **or** the oldest item
is over 10 minutes old — a big queue that is moving is a busy morning, a small
one that is not is a fault, and a count alone cannot tell those apart.

**The card deliberately does not show the Apps Script error.** Apps Script
returns exceptions in the script owner's own locale, so the string arrives in
whatever language that account is set to — unreadable text under a red number
is noise rather than a diagnosis. `sheet_sync_backlog_status()` still returns
`sample_error`, and `sheet_sync_backlog` still exposes it, for whoever is
debugging in SQL. To read the current cause:
`select sample_error from sheet_sync_backlog;`

There is no "drain now" button: the cron drains every 60s and retries with
exponential backoff (30s, 1m, 2m … capped at 1h), so a button would mostly
duplicate what the system already does.

**This card is not decoration.** The queue's whole design is that a failed
write accumulates instead of vanishing — which is only an improvement if
somebody sees it. An unwatched queue is the same failure as a silent drop, just
slower.

## Important components / functions
- `src/components/sheet-sync-backlog.tsx` — the card.
- `sheet_sync_backlog_status()` — admin-only RPC behind it.
- `sheet_sync_backlog` view — the same numbers, for SQL/ops use. **Not
  client-readable**; `anon` and `authenticated` have no grant on it.
- `supabase/functions/sheet-sync/index.ts` — accepts a single row or
  `{rows:[...]}`.

## Security notes
`sheet_sync_queue` has RLS enabled with **zero policies**, so it is unreachable
from the client. The backlog reaches the admin only through
`sheet_sync_backlog_status()`, a `SECURITY DEFINER` function that re-checks the
caller's role — the pattern
[decisions/0001](../decisions/0001-rls-as-the-only-boundary.md) requires.

Two traps were hit building that gate, both of which **fail open while looking
like a working guard**:

1. `if my_role() <> 'admin' then raise` does not guard. `my_role()` is NULL for
   a caller with no profile, no JWT, or an **inactive** profile, and
   `NULL <> 'admin'` is NULL rather than true — so the `IF` never fires. Use
   `is distinct from`. Verified: with `<>`, calling the RPC with no JWT
   returned the data.
2. `revoke ... from public` does not remove `anon`'s EXECUTE. Supabase's
   default privileges grant it to `anon` directly, and revoking from `PUBLIC`
   does not touch a direct grant. Name `anon` explicitly.

## Known limitations
- **Resolved 2026-09-18 — the Validation Feed permission failure.** For about
  12 hours the Apps Script could not open the Validation Feed spreadsheet
  (`Exception: リクエストされたドキュメントにアクセスする権限がありません。（行 26…）`),
  and 14 uploaded leads accumulated in the queue at up to 21 attempts each. We
  do not own that deployment, so it was blocked on the script's owner. Once
  they deployed, all 14 flushed and the queue drained to zero. **Nothing was
  lost** — which is the queue design working as intended: a failed write
  accumulated instead of vanishing, and the leads were still there to send when
  the far end came back. The pre-queue behaviour would have dropped all 14
  silently.
  The retry is capped at a 1h backoff, so a fixed far end clears itself within
  the hour; to flush immediately instead, set `next_attempt_at = now()` on the
  queue and call `drain_sheet_sync_queue(25)`, then `resolve_sheet_syncs()`
  **after** the batch has actually answered — resolving too early records
  `no response recorded` and costs the row an attempt.
- **The Sheet is eventually consistent.** Under sustained peak it can lag by
  minutes. Accepted deliberately. If it ever needs to be immediate, the levers
  are batch size, cron frequency, then replacing Apps Script with the Sheets
  API.
- **Throughput is bounded by Apps Script** at roughly 25 writes/minute with one
  batch in flight. That ceiling is inherent to a serialising web app.
- **~20 other `SECURITY DEFINER` RPCs still use the `<>` / `NOT IN` guard**
  described above, including `admin_settings` and `reporting_retention_status`,
  both confirmed returning data to `anon`. Not fixed here — see
  [TODO.md](../TODO.md).
