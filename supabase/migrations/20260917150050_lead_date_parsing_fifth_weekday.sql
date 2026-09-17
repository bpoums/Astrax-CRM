-- Correction applied on top of 20260917150000_lead_date_parsing.sql, before any
-- row was written by it.
--
-- The weekday branch searched only the current and next month, so "5th wed of
-- the month" returned null whenever neither of those two months happened to
-- have a fifth Wednesday — a date that does exist, just further out. The window
-- is now a year, which always contains one.
--
-- No live data used a 5th-weekday recurrence; this was caught by testing the
-- parser against constructed inputs rather than only the strings in the table.
-- The function body here is identical to the one in the file above, which
-- carries the fix — this file exists so the checked-in migration names match
-- the live migration history one for one.

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

  m := regexp_match(v, '^(\d{4})-(\d{1,2})-(\d{1,2})$');
  if m is not null then
    begin
      return make_date(m[1]::int, m[2]::int, m[3]::int);
    exception when others then return null; end;
  end if;

  m := regexp_match(v, '^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$');
  if m is not null then
    begin
      return make_date(
        case when length(m[3]) = 2 then 2000 + m[3]::int else m[3]::int end,
        m[1]::int, m[2]::int);
    exception when others then return null; end;
  end if;

  m := regexp_match(v, '^(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(?:the\s+)?month$');
  if m is not null then
    v_day := m[1]::int;
    if v_day < 1 or v_day > 31 then return null; end if;
    return public.next_monthly_day(v_day, p_from);
  end if;

  m := regexp_match(v,
    '^(\d{1,2})(?:st|nd|rd|th)?\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+of\s+(?:the\s+)?month$');
  if m is not null then
    v_nth := m[1]::int;
    if v_nth < 1 or v_nth > 5 then return null; end if;
    v_dow := case m[2]
      when 'sun' then 0 when 'mon' then 1 when 'tue' then 2 when 'wed' then 3
      when 'thu' then 4 when 'fri' then 5 else 6 end;

    for i in 0..11 loop
      v_first := date_trunc('month', p_from + (i || ' month')::interval)::date;
      v_offset := (v_dow - extract(dow from v_first)::int + 7) % 7;
      v_candidate := v_first + v_offset + (v_nth - 1) * 7;
      if date_trunc('month', v_candidate) = date_trunc('month', v_first)
         and v_candidate >= p_from then
        return v_candidate;
      end if;
    end loop;
    return null;
  end if;

  return null;
end $function$;
