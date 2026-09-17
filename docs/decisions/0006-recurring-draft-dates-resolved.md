# 0006 — A recurring draft date is resolved to a real date, and rolled nightly

## Status
Current, 2026-09-17.

## Context
`submissions.draft_date` is a real SQL `date` column, and it is what every
date-keyed screen reads: the By Draft Date desk, the CX pipeline's date filter,
the exports, the closing desk. `submit_form_internal` derived it from
`payload->>'Draft Date'` on submit — and nothing else in the database ever wrote
it. `ingest_sheet_lead` set no `draft_date`, no `future_draft_date` and no
`ssn_normalized`, so all 44 uploaded leads had all three null, and
`update_payload_field` wrote `payload` without re-deriving any of them, so
correcting the text by hand moved nothing.

Filling the column on ingest is uncontroversial. What is not is *what to fill it
with*: an uploaded lead usually does not carry a date at all. It carries an
arrangement — `3rd of the month` (9 leads), `1st of the month` (7),
`3rd wed of the month` (3+2), `15th of the month` (2+1) — against only four
genuine dates in the whole set.

## Decision
A recurrence is **resolved to the next real occurrence** and stored in the date
column, rather than being kept as a rule and interpreted at read time.

`parse_lead_date(text, from_date)` handles `YYYY-MM-DD`, `MM/DD/YYYY`,
`Nth of the month` and `Nth <weekday> of the month`, returning the first
occurrence on or after `from_date`. Anything it does not recognise —
`Every 2nd Friday`, a fortnightly cadence with no single date — returns null
rather than a guess.

Because a resolved date is only true until its month turns,
`roll_recurring_draft_dates()` runs daily (`23 5 * * *`) and moves any past
`draft_date` whose payload text is itself a recurrence to its next occurrence.
An explicitly typed date does not match those patterns and is never moved.

## Why not keep the rule and interpret at read time
The column is a real `date` precisely so the database can filter and sort on it.
A rule interpreted in the browser would leave every uploaded lead invisible to
`.eq("draft_date", …)` — the By Draft Date desk's entire query — unless each of
those screens learned to parse recurrences too, in a language that is not the
one the parser is written in. Resolving once, server-side, keeps one
implementation and one answer.

## Consequences
- A stored `draft_date` on an uploaded lead may be a date the system worked out,
  not one an operator wrote. Every surface that shows it therefore keeps the
  original wording within reach: the CX pipeline's cell carries it as a title,
  and `payload->>'Draft Date'` is unchanged and still rendered in Lead Details.
- The nightly roll is load-bearing. If that cron job stops, recurring leads
  silently drift into the past rather than failing loudly — worth checking
  alongside `expire-reviews` when dates look wrong.
- 31 of 44 uploaded leads now carry a draft date where none did. The remainder
  are the one unresolvable cadence and twelve leads whose payload has no draft
  text at all.
- `normalize_ssn()` was extracted in the same pass and the same backfill filled
  `ssn_normalized` on all 44 uploaded leads, which had been invisible to
  `check_duplicate_ssn` since the importer was built.
