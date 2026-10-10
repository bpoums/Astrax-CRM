-- Missing information on uploaded leads: a column the database can filter and
-- count by, because the browser only ever holds one page of them.
--
-- The list below is THE definition of "required for an uploaded lead". The
-- labels are the closer form's own, which are the payload keys. It is the
-- closer form's `required` list minus Birth State / Birth Country / Height /
-- Weight (empty on 459-492 of 500 uploaded leads, so they would label every
-- one) and minus the bank fields (those live in payment_details).
--
-- Changing the list later: a STORED generated column is NOT recomputed when the
-- function it calls changes. Ship a migration that drops and re-adds the
-- column (a table rewrite, which fires no triggers). Do not "touch" rows with an
-- UPDATE — that would re-fire the Google Sheets sync.

create or replace function public.missing_required_fields(p_source text, p_payload jsonb)
returns text[]
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
    when p_source is distinct from 'sheet' then '{}'::text[]
    else coalesce(
      (
        select array_agg(f.label order by f.ord)
        from unnest(array[
          'Full Name', 'Gender', 'Date of Birth', 'Age', 'State', 'SSN Number',
          'Phone Number', 'Residential Address', 'Customer Zip Code',
          'Proposed Carrier', 'Coverage Amount', 'Premium', 'Plan Type',
          'Beneficiary Name', 'Draft Date'
        ]) with ordinality as f(label, ord)
        where nullif(btrim(p_payload ->> f.label), '') is null
      ),
      '{}'::text[]
    )
  end
$$;

alter table public.submissions
  add column if not exists missing_info text[]
  generated always as (public.missing_required_fields(source, payload)) stored;

comment on column public.submissions.missing_info is
  'Required fields an uploaded (source = sheet) lead has no value for; {} for any other lead. Generated from missing_required_fields().';

-- Per-field counts for the filter dropdown. SECURITY INVOKER on purpose: RLS
-- scopes the rows, so each role counts only the leads it can already read.
create or replace function public.missing_info_by_field()
returns table (field text, lead_count bigint)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if my_role() is null then
    raise exception 'not authorized';
  end if;

  return query
  select m.label, count(*)
  from submissions s
  cross join lateral unnest(s.missing_info) as m(label)
  where s.archived_at is null
  group by m.label
  order by count(*) desc, m.label;
end;
$$;

revoke execute on function public.missing_info_by_field() from public, anon;
grant execute on function public.missing_info_by_field() to authenticated;
