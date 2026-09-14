# User management

## Purpose
Let an admin invite staff, change their role/center/org label, and
activate/deactivate accounts — the single lever that revokes all access at
once (see [authentication.md](../authentication.md)).

## Current status
Live. Search/filter and the activate/deactivate control were added in this
working session (see [CHANGELOG.md](../../CHANGELOG.md)); everything else
predates it.

## Roles involved
**admin** only.

## Routes / screens
`/admin?tab=users` → `src/components/user-admin.tsx` (`UserAdmin`).

## Important components
`user-admin.tsx` — one file, two sections: the invite form and the users
table (now with a filter bar and a capped, sticky-header scroll region).

## Database
- Invite: the `invite-user` **Edge Function** (`verify_jwt: true`,
  re-checks the caller is admin server-side), which creates the
  `auth.users` row (triggering `handle_new_user()` → the matching `profiles`
  row) and sets `role`/`staff_id` in one call. `center_id` is a *second*,
  separate direct write to `profiles` immediately after, because the invite
  function itself doesn't accept it — so an invite is genuinely two writes,
  and the UI reports the second one's failure independently rather than
  swallowing it.
- Role, center, org-label, and active-status changes: all direct writes to
  `profiles`, under the one client-reachable RLS write policy in the whole
  schema (`admin manages profiles`, `FOR ALL`, admin-only — see
  [decisions/0001](../decisions/0001-rls-as-the-only-boundary.md)).

## Business rules
- **Deactivating is a single write with no confirmation dialog**, by
  deliberate choice made in this session — consistent with every other
  inline edit in this file (role, center, org label), all of which commit
  immediately with no confirm step. The safety net is entirely server-side:
  `guard_last_admin()` refuses to deactivate the last active admin, and its
  raised message is shown verbatim via the same `toast.error(error.message)`
  pattern the other mutations already use.
- **A center picker only renders for roles a center means something for**
  (`closer`, `closing_manager`) — everyone else's center cell is a plain
  dash, because nothing reads a center for any other role.
- **The users table is filtered client-side** (name/staff-id/center text
  search, role chips, active/inactive chips) over the whole fetched list —
  acceptable at the current scale (56 profiles); would need a server-side
  search if the roster grows into the many hundreds.

## Known limitations
- Search does not cover email, because `profiles` has no email column
  (email lives in `auth.users`, which the browser cannot read directly) —
  search is limited to name, staff ID, and center/org label.
- No pagination on the users table — a capped-height, sticky-header,
  scrollbar-hidden scroll region substitutes for it (see
  [CHANGELOG.md](../../CHANGELOG.md) for why that specific implementation
  needed a follow-up fix: `Table` wraps itself in its own scrolling `div`,
  so height/overflow/scrollbar utilities have to target that inner div via
  a `[&>div]:` arbitrary-variant selector, not the outer wrapper).

## Future work
None specifically requested beyond what's implemented; a server-side
search/pagination path would be the natural next step if the roster grows
substantially.
