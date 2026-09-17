# 0006 — Google Sheets sync is a queue, not a trigger-fired HTTP call

## Status
Current. Adopted 2026-09-17 (`20260917100000`, `20260917110000`, `sheet-sync` v13).

## Context

Sheets sync fired `net.http_post` directly from the `notify_sheet_sync()`
trigger, one request per changed row. That works at one request at a time and
fails at scale, because the far end cannot take concurrency:

- Google rejects concurrent requests to an Apps Script web app — sometimes a
  404, sometimes **HTTP 200 carrying an HTML error page**, which is why the
  failures were invisible for so long.
- The script serialises itself on a 30-second `LockService` lock regardless, so
  it can only ever perform one write at a time no matter what is sent.

Measured on this project, firing N syncs simultaneously:

| N | failure rate |
|---|---|
| 5 | ~20% |
| 20 | ~30% |
| 59 | **~61%** |

Thirteen leads had never reached Sheets at all, four of them completed sales.
The target load is ~100 closers and validators submitting concurrently.

Three things made this unfixable in place:

1. **`pg_net` batches its dispatch.** Requests cannot be paced from SQL —
   `pg_sleep` between calls does nothing, because the background worker
   collects whatever has been queued and fires it together. Verified directly:
   12 spaced calls sat in `net.http_request_queue` undispatched.
2. **The retry abandoned rows.** `retry_failed_sheet_syncs()` gave up
   permanently after 3 attempts, marking `gave_up` — a status nothing surfaced
   to a human. Permanent silent loss by design.
3. **The retry was itself a burst.** It looped over every pending attempt
   firing each one, recreating the exact condition that caused the failure.

We do not own the Apps Script deployment, so fixing the far end — batching
there, or replacing it with the Sheets API — was not available.

## Decision

The trigger no longer performs I/O. It enqueues, and a paced drain performs the
writes.

- **`sheet_sync_queue`, keyed by `submission_id`.** The primary key is
  load-bearing, not incidental: a lead whose status changes several times before
  the drain runs collapses into one row and one write carrying the final state,
  rather than several writes racing each other.
- **Batches, walked sequentially.** `drain_sheet_sync_queue()` sends up to 25
  rows as **one** `net.http_post`; `sheet-sync` v13 accepts `{rows:[...]}` and
  awaits each Apps Script call in turn. Apps Script therefore sees exactly one
  request at a time however large the batch — the concurrency fix, obtained
  without any change to the Apps Script itself.
- **Only confirmed success removes a row.** `resolve_sheet_syncs()` reads the
  per-row `results` array back, so one bad row in a batch of 25 retries one row
  rather than 25. Everything else gets exponential backoff (30s, 1m, 2m …
  capped at 1h) and **is never abandoned**.
- **One batch in flight at a time.** Added within an hour of rollout: the first
  live burst showed a 25-row batch outrunning the 60-second cron interval, so
  two batches overlapped and reintroduced concurrency. `SKIP LOCKED` had
  prevented double-sending a row, but not two batches existing at once.
- **The backlog is visible.** `sheet_sync_backlog` exposes depth, in-flight
  count, rows at `attempts >= 5` and the age of the oldest item.

## Consequences

- **The Sheet is eventually consistent, not immediate.** Under sustained peak it
  may lag by minutes. This was explicitly accepted: the Sheet is a management
  reporting mirror read by the owner and the daily email export, not a surface
  anyone works from live. If that ever changes, the levers are batch size, cron
  frequency, and then replacing Apps Script with the Sheets API.
- **A stuck row now accumulates rather than disappearing.** That is the point,
  but it means somebody must watch `sheet_sync_backlog` — a silently growing
  queue is the same failure as a silent drop, just slower. The admin card is
  not optional decoration.
- **Throughput is bounded by Apps Script**, roughly 25 writes per minute with
  one batch at a time. That ceiling is inherent to a serialising web app and
  can only be raised by changing or replacing the far end.
- **Reverting is one statement** — point `notify_sheet_sync()` back at
  `sync_submission_to_sheet()`, which is deliberately left defined and
  unmodified, as is `retry_failed_sheet_syncs()`.
- `sheet_sync_attempts` is retained for history; nothing writes to it now.
- **`sheet-sync` still accepts a single-row body**, so the revert path does not
  require redeploying the edge function.

## Related

The failures were invisible until `sheet-sync` v12 (2026-09-15) stopped
treating an Apps Script HTTP 200 as proof of success. Everything above was
discoverable only after that; before it, every failure was recorded `ok` and
the retry job had nothing to retry. See
[0005](0005-single-insert-status-to-avoid-sheet-sync-races.md) for the earlier
sheet-sync race fix, and `docs/database.md` for the current function reference.
