-- check_duplicate_account: "has this account number been on a lead before?",
-- asked live on the closer form's Account Number field.
--
-- ADVISORY ONLY. Unlike check_duplicate_ssn, nothing on the submit path reads
-- this: submit_form_internal is untouched, so a duplicate account number can
-- never block a submission. It exists to put a warning in front of the closer.
--
-- Why an RPC: an account number lives in two places - payload -> 'Account
-- Number' on a form lead, and payment_details.account_number on an imported one
-- - and the browser can read neither across other people's leads (RLS scopes
-- submissions; payment_details has no policy at all, by design). Same reasoning,
-- same privacy design as check_duplicate_ssn: the answer is "a lead has it", how
-- many, the latest outcome and when. Never a name, phone, bank or lead id.
--
-- Matching is on digits only. Stored values carry spaces, tabs and the odd
-- "n/a", so values are stripped to digits before comparing, and anything under
-- six digits is treated as "nothing to check" rather than as a number.

create or replace function public.check_duplicate_account(p_account text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_norm text;
  r record;
begin
  if coalesce(my_role()::text, '') not in ('closer', 'validator', 'manager', 'admin') then
    raise exception 'not authorized';
  end if;

  v_norm := regexp_replace(coalesce(p_account, ''), '\D', '', 'g');
  if length(v_norm) < 6 then
    return jsonb_build_object('exists', false);
  end if;

  with hits as (
    select s.id, s.disposition, s.created_at
    from submissions s
    where s.archived_at is null
      and regexp_replace(coalesce(s.payload ->> 'Account Number', ''), '\D', '', 'g') = v_norm
    union
    select s.id, s.disposition, s.created_at
    from payment_details p
    join submissions s on s.id = p.submission_id
    where s.archived_at is null
      and regexp_replace(coalesce(p.account_number, ''), '\D', '', 'g') = v_norm
  )
  select
    count(*)::int as total,
    (array_agg(
       case
         when h.disposition = 'accepted' then 'accepted'
         when h.disposition = 'declined' then 'declined'
         else 'in_progress'
       end
       order by h.created_at desc
     ))[1] as bucket,
    max(h.created_at) as latest
  into r
  from hits h;

  if r.total = 0 then
    return jsonb_build_object('exists', false);
  end if;

  return jsonb_build_object(
    'exists', true,
    'count', r.total,
    'status', r.bucket,
    'submitted_at', r.latest
  );
end;
$$;

revoke all on function public.check_duplicate_account(text) from public;
revoke all on function public.check_duplicate_account(text) from anon;
grant execute on function public.check_duplicate_account(text) to authenticated;
