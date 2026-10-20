-- lead_ids_by_bank: which leads were imported with a bank whose name matches.
--
-- The Exports tab's Bank search has to cover two places a bank name lives:
-- payload -> 'Bank Name' on closer-form leads (the browser can search that
-- itself) and payment_details.bank_name on imported leads. payment_details has
-- RLS enabled with no policy on purpose (docs/decisions/0001, 0002: banking is
-- reachable only through RPCs), so the browser cannot search it. This is the
-- narrow doorway: it returns lead ids and nothing else, never a bank, an
-- account or a routing number.
--
-- Same audience as payment_summary's bank fields: admin, manager,
-- general_manager. Written `is distinct from` style so a caller with no profile
-- (NULL role) is refused rather than slipping through a NULL comparison.
--
-- Capped: the ids travel back to the browser inside a URL filter, so more than
-- 500 would not fit. It raises instead of silently truncating, which would make
-- a search look complete when it was not.

create or replace function public.lead_ids_by_bank(p_term text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_term text := btrim(coalesce(p_term, ''));
  v_ids uuid[];
begin
  if coalesce(my_role()::text, '') not in ('admin', 'manager', 'general_manager') then
    raise exception 'not authorized';
  end if;
  if v_term = '' then
    return;
  end if;

  -- Match literally: a typed % or _ must not act as a wildcard.
  select array_agg(submission_id) into v_ids
  from (
    select submission_id
    from public.payment_details
    where bank_name ilike
      '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    limit 501
  ) matched;

  if coalesce(array_length(v_ids, 1), 0) > 500 then
    raise exception 'too many banks match "%" - type more of the bank name', v_term;
  end if;

  return query select unnest(coalesce(v_ids, '{}'::uuid[]));
end;
$$;

revoke all on function public.lead_ids_by_bank(text) from public;
revoke all on function public.lead_ids_by_bank(text) from anon;
grant execute on function public.lead_ids_by_bank(text) to authenticated;
