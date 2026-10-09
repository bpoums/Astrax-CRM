# 0010 — Route guards read the session locally and share one cached snapshot

## Status
Current, added 2026-10-09.

## Context
Every page load ran a serial chain of Supabase round trips before any data was
requested: `getUser()` (a network call), then `profiles`, then `crm_suspension`,
repeated by the `_authenticated` parent guard, again by the child route's
`requireRole()`, again by `routes/index.tsx` and by `AuthProvider`. Measured on the
live site that was ~9 requests / ~2.5 s for an admin and ~4.3 s for a manager on
sign-in, with the page's own data then loading in ~0.5 s.

## Decision
- Guards use `supabase.auth.getSession()` (local) instead of `getUser()`, and a
  single `loadAuthSnapshot()` fetches `profiles` and `crm_suspension` in parallel,
  shares the in-flight promise, and caches for 10 s (cleared on auth events and
  sign-out).
- Fonts are self-hosted so first paint no longer waits on a third party.

## Consequences
- The guard no longer asks the auth server to validate the JWT on each navigation.
  That is acceptable because the guard was never a security boundary
  ([0001](0001-rls-as-the-only-boundary.md)): a revoked or expired token still gets
  nothing back from any query, and supabase-js refreshes expiring tokens itself.
- A role change or deactivation is picked up by the guards within 10 s (sooner on
  any auth event); deactivation and suspension keep their realtime kicks in
  `AuthProvider` ([0008](0008-crm-suspension-via-my-role.md)).
- Any new code that needs the caller's role/profile in a route guard should call
  `loadAuthSnapshot()` rather than `getUser()` + `profiles`.
