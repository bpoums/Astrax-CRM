# Authentication & Authorization

## Identity

- Accounts live in Supabase Auth (`auth.users`) plus a mirrored `profiles` row
  (`id`, `full_name`, `role`, `active`, `staff_id`, `org_name`, `center_id`),
  created automatically by the `handle_new_user()` trigger on signup.
- **There is no public signup.** Nothing in the client calls `supabase.auth.signUp`.
  The only way an account is created is the admin-only `invite-user` Edge
  Function (`verify_jwt: true`), invoked from `src/components/user-admin.tsx`.
  It sets `role` and `staff_id` in the invite call; `center_id` is a second,
  separate write straight to `profiles` afterward (the invite function doesn't
  accept it) — so an invite is really two writes, and the UI reports the
  second one's failure on its own rather than silently losing it.
- **Bootstrap admin**: `handle_new_user()` hardcodes one email —
  `bpoums@gmail.com` (lowercased comparison) — to receive `role = 'admin'` on
  first signup; every other new signup gets `role = 'closer'`. This is the
  only way the very first admin account comes to exist; there is no seed
  script or migration that inserts an admin profile directly.
- Password reset / "set your password" both go through `/reset-password`
  (`src/routes/reset-password.tsx`), which is **outside** the `_authenticated`
  route tree — it must be reachable without a session, since it's exactly
  where a not-yet-logged-in invitee lands. It never creates an account; it
  only exchanges a Supabase recovery token (delivered in the URL fragment) for
  a session and then calls `supabase.auth.updateUser({ password })`.
- A dead recovery/invite link reports failure in the **URL fragment**
  (`#error=access_denied&error_code=otp_expired`), not as a failed network
  request — `reset-password.tsx`'s `linkErrorFromHash()` is what catches this.
- Email delivery is Gmail SMTP (`bpoums@gmail.com`, app password held in
  Supabase, not in this repo) — no custom sending domain, so mail can land in
  spam. This is operational context, not something the code can fix.

## Session lifecycle (`src/lib/auth.tsx`)

- `AuthProvider` wraps the whole app (mounted in `src/routes/__root.tsx`,
  inside `QueryClientProvider`) and holds `session`/`profile`/`loading` in
  React state, kept in sync via `supabase.auth.onAuthStateChange` (only reacts
  to `SIGNED_IN`/`SIGNED_OUT`/`USER_UPDATED`) plus an initial
  `getSession()`/profile fetch.
- `useAuth()` is the read hook everything else uses (`profile`, `session`,
  `signOut`). `signOut()` cancels in-flight queries and clears the whole
  TanStack Query cache before calling `supabase.auth.signOut()` — so a signed
  -out browser can never render a stale, previously-fetched screen for a
  moment before redirecting.
- Every route's guard (`beforeLoad`) independently calls
  `supabase.auth.getUser()` — there is no shared "wait for AuthProvider"
  step in routing; the guard and the provider both read the session
  independently from the same Supabase client.

## Route guard: `requireRole()`

```ts
export async function requireRole(allowed: AppRole[]) {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw redirect({ to: "/login" });
  const { data: profile } = await supabase.from("profiles").select("role")
    .eq("id", data.user.id).maybeSingle();
  const role = (profile?.role as AppRole | undefined) ?? "closer";
  if (!allowed.includes(role)) throw redirect({ to: roleHome[role], replace: true });
}
```

This is called from every `_authenticated/*` route's `beforeLoad`. It is
explicitly **not** a security boundary — the code comment says so directly:
"RLS is still what actually protects the data; this keeps a role out of a
screen that would only ever show them an empty one." A role missing from a
route's `requireRole([...])` list simply gets redirected to its own home; it
is never the reason a query returns nothing. See
[decisions/0001-rls-as-the-only-boundary.md](decisions/0001-rls-as-the-only-boundary.md).

A profile row missing or unreadable falls back to `role = "closer"` in three
separate places (`requireRole`, `login.tsx`, `reset-password.tsx`, `index.tsx`)
— never to "no role"/an error. This is a deliberate fail-safe default (routes
you to the least-privileged screen) rather than a fail-open one.

## The database-side identity function: `my_role()`

```sql
select role from profiles where id = auth.uid() and active
```

Every RLS policy and every RPC's authorization check reads through this one
function. Its `and active` clause is the entire mechanism behind "an inactive
profile resolves to no role at all" — deactivating a user is a single write
(`profiles.active = false`) that simultaneously:
- fails every RLS policy's role check (read access to everything disappears),
- fails every RPC's `my_role() not in (...)` guard (write access disappears),
- fails `requireRole()` (client redirects to `/login`... actually to
  `roleHome["closer"]` per the fallback above, since `profile?.role` comes
  back `undefined` once `active=false` — a deactivated user is redirected as
  if they had no role, not sent to a login screen specifically).

There is no second place that checks `active` — by design, so there is
exactly one lever to pull to cut someone off completely, and no risk of a
policy or RPC forgetting to check it.

`guard_last_admin()` (a `BEFORE UPDATE` trigger on `profiles`) refuses to
deactivate (`active: false`) or demote (`role <> 'admin'`) the currently
active admin if no *other* active admin would remain — the one guardrail that
keeps this single-lever design from being able to lock everyone out.

## Roles and where each lands (`roleHome`)

| Role | Home route | Reachable elsewhere |
|---|---|---|
| `admin` | `/admin` | every route in the app admits `admin` |
| `manager` | `/manager` | `/validator-form`, `/closer`, `/forwarded-leads` |
| `validator` | `/validator` | `/validator-form`, `/closer`, `/forwarded-leads` |
| `closing_manager` | `/closing` | — |
| `general_manager` | `/closing` (same screen as closing_manager) | also gets the "Parked Leads" tab there |
| `closer` | `/closer` | `/forwarded-leads` |
| `data_uploader` | `/upload` | — |
| `cxm` | `/cx` | — |
| `cxa` | `/cx` | — |

`closing_manager` and `general_manager` sharing one route/component
(`ClosingDesk`) with no client-side role branch (bar one message-only check,
see [features/closing-desk.md](features/closing-desk.md)) is the clearest
example in the codebase of "the database decides scope, the client only
displays" — see [multi-tenancy.md](multi-tenancy.md).

## A refused read is not an empty result

Every `SECURITY DEFINER` RPC that raises `not authorized` (or a specific
reason) does so as a thrown Postgres exception, which `supabase-js` surfaces
as `{ data: null, error: {...} }` — the same shape a legitimately-empty
result takes (`{ data: null, error: null }`) if a caller doesn't check
`error` before falling back to an empty state. `CLAUDE.md` documents this
pattern as a house rule (branch on the error before the empty case); the
audited components (`payment-panel.tsx`, `admin-settings.tsx`,
`cx-status-cell.tsx`, and others) consistently surface the RPC's own error
text (e.g. `payment_summary`'s "not authorized", `update_payload_field`'s
"`% is set by the system and cannot be edited`") rather than a generic
message.
