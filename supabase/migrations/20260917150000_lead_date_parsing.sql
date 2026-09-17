-- Uploaded leads get a real draft date, and a payload correction moves it.
--
-- `submit_form_internal` was the ONLY function in the database that wrote
-- `draft_date`. `ingest_sheet_lead` inserted no `draft_date`, no
-- `future_draft_date` and no `ssn_normalized` at all, so every uploaded lead
-- (44 of 44 live) had all three null — which is why the CX queue's Draft Date
-- column was blank for them, why they never reached the By Draft Date desk, and
-- why none of them was visible to `check_duplicate_ssn`.
--
-- `update_payload_field` wrote `payload` and nothing else, so correcting the
-- text by hand to "10/03/2026" changed the payload and left the column null.
-- That is the bug as it was reported, and the sync below is the fix.
--
-- Most of what an uploaded lead carries is not a date at all but a recurrence —
-- "3rd of the month", "3rd wed of the month". Those are resolved to a real
-- date (see decisions/0006) so the leads reach the date-keyed screens, and
-- rolled forward nightly so a resolved date cannot quietly go stale.

/**
 * One draft-date string, as a date. Null when it does not resolve to one.
 *
 * DateStyle is deliberately not trusted — the forms are matched by pattern and
 * built with make_date, so this returns the same answer on any connection.
 * Nothing here raises: an unrecognised string is null, which is a value the
 * callers already handle.
 */
create or replace function public.parse_lead_date(p_text text, p_from date default current_date)
returns date
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v text := lower(btrim(coalesce(p_text, '')));
  m text[];
  v_day int;
  v_nth int;
  v_dow int;
  v_first date;
  v_offset int;
  v_candidate date;
begin
  if v = '' then return null; end if;

  -- ISO: 2026-10-03
  m := regexp_match(v, '^(\d{4})-(\d{1,2})-(\d{1,2})$');
  if m is not null then
    begin
      return make_date(m[1]::int, m[2]::int, m[3]::int);
    exception when others then return null; end;
  end if;

  -- MM/DD/YYYY, the form the import engine normalises to. Also M/D/YY.
  m := regexp_match(v, '^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$');
  if m is not null then
    begin
      return make_date(
        case when length(m[3]) = 2 then 2000 + m[3]::int else m[3]::int end,
        m[1]::int, m[2]::int);
    exception when others then return null; end;
  end if;

  -- "3rd of the month", "15th of the Month", "1st of month"
  m := regexp_match(v, '^(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(?:the\s+)?month$');
  if m is not null then
    v_day := m[1]::int;
    if v_day < 1 or v_day > 31 then return null; end if;
    return public.next_monthly_day(v_day, p_from);
  end if;

  -- "3rd wed of the month", "2nd Wednesday of the month"
  m := regexp_match(v,
    '^(\d{1,2})(?:st|nd|rd|th)?\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+of\s+(?:the\s+)?month$');
  if m is not null then
    v_nth := m[1]::int;
    if v_nth < 1 or v_nth > 5 then return null; end if;
    v_dow := case m[2]
      when 'sun' then 0 when 'mon' then 1 when 'tue' then 2 when 'wed' then 3
      when 'thu' then 4 when 'fri' then 5 else 6 end;

    -- This month's occurrence if it has not passed, otherwise the next month
    -- that actually has one: a 5th Wednesday exists in only some months, so a
    -- two-month window would return null for it rather than a date.
    for i in 0..11 loop
      v_first := date_trunc('month', p_from + (i || ' month')::interval)::date;
      v_offset := (v_dow - extract(dow from v_first)::int + 7) % 7;
      v_candidate := v_first + v_offset + (v_nth - 1) * 7;
      -- A 5th occurrence does not exist in every month; skip to the next one.
      if date_trunc('month', v_candidate) = date_trunc('month', v_first)
         and v_candidate >= p_from then
        return v_candidate;
      end if;
    end loop;
    return null;
  end if;

  -- Anything else — "Every 2nd Friday" and the like. A fortnightly cadence has
  -- no single date to resolve to, and inventing one would be worse than null.
  return null;
end $function$;

/**
 * Day `p_day` of the current month if it is still to come, else of the next.
 * Clamped to the month's length, so "31st of the month" in February is the
 * 28th/29th rather than nothing.
 */
create or replace function public.next_monthly_day(p_day int, p_from date default current_date)
returns date
language plpgsql
immutable
set search_path to 'public'
as $function$
declare v_start date; v_last int; v_candidate date;
begin
  for i in 0..1 loop
    v_start := date_trunc('month', p_from + (i || ' month')::interval)::date;
    v_last := extract(day from (v_start + interval '1 month - 1 day'))::int;
    v_candidate := v_start + (least(p_day, v_last) - 1);
    if v_candidate >= p_from then return v_candidate; end if;
  end loop;
  return null;
end $function$;

-- The digits-only SSN rule, spelled once instead of a third time.
create or replace function public.normalize_ssn(p_text text)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select case
    when length(regexp_replace(coalesce(p_text, ''), '\D', '', 'g')) = 9
    then regexp_replace(coalesce(p_text, ''), '\D', '', 'g')
  end
$$;

grant execute on function public.parse_lead_date(text, date) to authenticated;
grant execute on function public.next_monthly_day(int, date) to authenticated;
grant execute on function public.normalize_ssn(text) to authenticated;
