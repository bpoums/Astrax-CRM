-- Lets a signed-in session notice its own deactivation live, instead of
-- only finding out the next time it hits an RLS-scoped read/write.
-- `profiles`' own read policy already lets a user see their own row
-- regardless of `active` (`id = auth.uid()` has no active check), so this
-- is safe: the client filters the subscription to its own id in
-- AuthProvider, and RLS would scope it the same way even if it didn't.
alter publication supabase_realtime add table public.profiles;
