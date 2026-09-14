# 0002 — `submissions.payload` writes moved from direct RLS to `update_payload_field`

## Status
Current. Supersedes an older documented exception.

## Context
`CLAUDE.md`, prior to this audit, documented two RLS-restricted exceptions to
"all writes go through RPCs": an admin updating `profiles.role` directly, and
"a manager or admin may update `submissions.payload` directly, which is how
the data-flag correction flow fixes a bad imported value."

Direct inspection of the live database's policies
(`docs/database.md#row-level-security-summary`) found **no** write policy on
`submissions` at all — not for `payload`, not for anything. The only write
path to `payload` is the `update_payload_field(p_sub, p_field, p_value)` RPC.

## Decision (as it now stands, whether or not it was a deliberate migration)
`update_payload_field` is the sole write path to `submissions.payload`.
Beyond re-checking the caller's role
(`closing_manager`/`general_manager`/`manager`/`admin`), it does two things a
bare `UPDATE` could not:
- refuses `ID` and `Submitted By Role` (the two system-stamped keys),
- writes a `payload_edits` row (old value, new value, actor, timestamp) for
  every field it changes, in the same transaction as the update.

`src/components/lead-editor.tsx`'s own comment confirms an older, single
bulk-patch RPC existed that wrote a whole payload at once and recorded only a
`payload_edited` event with no before/after value — "that RPC is the only
path that could write a payload without recording what it replaced, so
nothing calls it any more." The current editor calls
`update_payload_field` once per changed field instead.

## Consequences
- `CLAUDE.md`'s "manager or admin may update submissions.payload directly"
  line is stale and has been corrected in this audit (see
  [architecture.md](../architecture.md)) — do not write new code assuming a
  direct-write path exists for `payload`; it does not.
- Because the RPC writes one `payload_edits` row per field per call, every
  payload correction now has a genuine before/after audit trail
  (`src/components/payload-history.tsx`), which a bulk direct write never
  could have produced.
- `data-flags.tsx`'s correction flow (write the value, then clear the flag,
  and only in that order) depends on this RPC's per-field granularity and
  its own error being distinguishable from success — a flag is never cleared
  for a write that didn't actually happen.
