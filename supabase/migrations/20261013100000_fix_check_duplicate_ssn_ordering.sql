-- check_duplicate_ssn picked the lead to describe with
--   order by (s.disposition = 'accepted') desc, ...
-- A pending lead has disposition NULL, so that expression is NULL, and NULL sorts
-- BEFORE true in a DESC sort. A still-pending duplicate therefore shadowed an
-- accepted one and the form showed the soft "In Progress" hint instead of the
-- blocking "already Submitted" one. submit_form_internal was never affected
-- (it uses exists(... disposition = 'accepted')). Only the ordering changes.
create or replace function public.check_duplicate_ssn(p_ssn text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_norm text;
  r record;
  v_exempt boolean := false;
begin
  if my_role() is null or my_role() not in ('closer','validator','manager','admin') then
    raise exception 'not authorized';
  end if;

  v_norm := regexp_replace(coalesce(p_ssn,''), '\D', '', 'g');
  if length(v_norm) <> 9 then
    return jsonb_build_object('exists', false);
  end if;

  select
    case
      when s.disposition = 'accepted' then 'accepted'
      when s.disposition = 'declined' then 'declined'
      else 'in_progress'
    end as bucket,
    s.created_at
  into r
  from submissions s
  where s.ssn_normalized = v_norm
    and s.archived_at is null
  order by (s.disposition is not distinct from 'accepted') desc, s.created_at desc
  limit 1;

  if r is null then
    return jsonb_build_object('exists', false);
  end if;

  -- exempt only ever matters for an accepted match, mirroring exactly what
  -- submit_form_internal will decide -- checked against every accepted
  -- duplicate, not just the one row picked as "most relevant" to display.
  if r.bucket = 'accepted' then
    select exists (
      select 1
      from submissions s
      join submission_tags st on st.submission_id = s.id
      join cx_tags t on t.id = st.tag_id
      where s.ssn_normalized = v_norm
        and s.archived_at is null
        and s.disposition = 'accepted'
        and t.allows_duplicate_ssn
    ) into v_exempt;
  end if;

  return jsonb_build_object(
    'exists', true,
    'status', r.bucket,
    'submitted_at', r.created_at,
    'exempt', v_exempt
  );
end;
$function$;
