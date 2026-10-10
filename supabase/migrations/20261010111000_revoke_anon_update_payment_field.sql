-- update_payment_field was still executable by `anon`. Its role guard used
-- `v_role not in (...)`, which is NULL (not true) for a caller with no role, so
-- an unauthenticated call fell straight through to the write. The previous
-- migration rewrites the guard fail-closed; this removes the grant as well, by
-- name from both `public` and `anon` (revoking from one leaves the other), as
-- the 2026-09-27 null-role fix did for the 19 RPCs it covered.
revoke execute on function public.update_payment_field(uuid, text, text) from public, anon;
grant execute on function public.update_payment_field(uuid, text, text) to authenticated;
