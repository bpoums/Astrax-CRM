-- Daily Age refresh.
-- payload."Age" is typed once and stored as text, so it goes stale. This job
-- recalculates it every night from payload."Date of Birth" (stored either as
-- YYYY-MM-DD or MM/DD/YYYY). Rows whose date of birth cannot be parsed are
-- left untouched. Modelled on roll_recurring_draft_dates / its cron job.

create or replace function public.refresh_lead_ages()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r       record;
  v_dob   date;
  v_age   int;
  v_count int := 0;
begin
  for r in
    select s.id, s.payload->>'Date of Birth' as dob, s.payload->>'Age' as age
      from submissions s
     where s.archived_at is null
       and s.payload->>'Date of Birth' ~ '^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}/\d{1,2}/\d{4})$'
  loop
    begin
      if r.dob like '%/%' then
        v_dob := make_date(split_part(r.dob, '/', 3)::int,
                           split_part(r.dob, '/', 1)::int,
                           split_part(r.dob, '/', 2)::int);
      else
        v_dob := make_date(split_part(r.dob, '-', 1)::int,
                           split_part(r.dob, '-', 2)::int,
                           split_part(r.dob, '-', 3)::int);
      end if;
    exception when others then
      continue; -- impossible date such as 02/31: skip, never abort the batch
    end;

    v_age := date_part('year', age(current_date, v_dob))::int;
    if v_age < 0 or v_age > 120 then
      continue;
    end if;

    if r.age is distinct from v_age::text then
      update submissions
         set payload = jsonb_set(payload, '{Age}', to_jsonb(v_age::text))
       where id = r.id;
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end $function$;

-- Cron-only: no client may call it.
revoke execute on function public.refresh_lead_ages() from public, anon, authenticated;

select cron.schedule('refresh-lead-ages', '31 5 * * *',
                     'select public.refresh_lead_ages()');
