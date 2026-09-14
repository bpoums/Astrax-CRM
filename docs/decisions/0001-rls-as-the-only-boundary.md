# 0001 — RLS + SECURITY DEFINER RPCs are the only security boundary

## Status
Current, consistently applied.

## Context
An internal ops console with nine roles, several of which are scoped to a
subset of leads (their own, their center's, their assignment). The client is
a public SPA — anyone can open devtools and call `supabase.rpc(...)` or
`supabase.from(...)` directly with their own session token, bypassing any
React component entirely.

## Decision
Every read is scoped by a Postgres RLS policy keyed off `my_role()` (and,
where relevant, an ownership/assignment column). Every write goes through a
named `SECURITY DEFINER` SQL function that re-checks the caller's role itself
and raises a specific error rather than failing silently. As of this audit,
exactly one table (`profiles`) has a client-reachable direct RLS write
policy, restricted to `admin`. Every other table — `submissions` included —
has zero write policies; the only door in is a named RPC.

`src/lib/auth.tsx`'s `requireRole()` route guard exists **only** to keep a
role off a screen that would show it nothing useful. It grants nothing by
itself, and the codebase's own comments say so at every call site.

## Consequences
- Adding a role to a route's `requireRole([...])` list does not grant that
  role any data access — a genuinely common mistake this codebase's own docs
  (`WHERE-TO-CHANGE.md` §12) warn against explicitly.
- A refused RPC call and a legitimately-empty result arrive at the client in
  the same shape (`data: null`), so every caller must branch on `error`
  before falling back to an empty-state UI, or a permission refusal silently
  renders as "no details attached." See [authentication.md](../authentication.md).
- Client-side role checks (e.g. `profile?.role === "admin"`) that appear in
  a handful of components (`closing-desk.tsx`'s one `noCenter` message
  branch, `closing.tsx`'s `canMoveParked`) are for **UI presentation only**
  — which tab/message to show — never for deciding what data to fetch or
  whether a mutation should be attempted. Grep for `profile?.role` /
  `profile.role` before assuming any such check is a security control; in
  every instance found during this audit, it wasn't.
