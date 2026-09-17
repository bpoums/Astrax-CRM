-- Uploaded leads fill the three derived columns they always skipped, and a
-- payload correction now moves them. See 20260917150000_lead_date_parsing.sql
-- for the parser these call, and decisions/0006 for why a recurrence is
-- resolved to a concrete date and rolled nightly.

-- An imported lead now gets the same three derived columns a submitted one has.
create or replace function public.ingest_sheet_lead(p_payload jsonb, p_source_ref text, p_uploaded_by uuid default null::uuid, p_import_id uuid default null::uuid, p_flags jsonb default '[]'::jsonb, p_payment jsonb default null::jsonb)
 returns submissions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  r submissions;
  v_center_id uuid;
  v_center_name text;
begin
  select * into r from submissions where source_ref = p_source_ref;
  if r.id is not null then return r; end if;

  if p_uploaded_by is not null then
    select p.center_id, c.name
      into v_center_id, v_center_name
    from profiles p left join centers c on c.id = p.center_id
    where p.id = p_uploaded_by;
  end if;

  insert into submissions (
    closer_id, payload, submitted_by_role, status, source, source_ref,
    uploaded_by, import_id, data_flags, center_id, center_name,
    draft_date, future_draft_date, ssn_normalized
  )
  values (
    null, p_payload, 'closer', 'pending_import_approval', 'sheet', p_source_ref,
    p_uploaded_by, p_import_id, coalesce(p_flags, '[]'::jsonb), v_center_id, v_center_name,
    parse_lead_date(p_payload->>'Draft Date'),
    parse_lead_date(p_payload->>'Future Draft Date'),
    normalize_ssn(p_payload->>'SSN Number')
  )
  returning * into r;

  if p_payment is not null then
    insert into payment_details (
      submission_id, payment_type, bank_name, routing_number, account_number,
      account_title, card_number, card_last4, card_exp, cvv
    ) values (
      r.id,
      coalesce(p_payment->>'payment_type', 'unknown'),
      p_payment->>'bank_name', p_payment->>'routing_number', p_payment->>'account_number',
      p_payment->>'account_title', p_payment->>'card_number', p_payment->>'card_last4',
      p_payment->>'card_exp', p_payment->>'cvv'
    );
  end if;

  if p_import_id is not null then
    update lead_imports set imported_count = imported_count + 1 where id = p_import_id;
  end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (r.id, p_uploaded_by, 'submitted',
          jsonb_build_object('source','sheet','source_ref',p_source_ref,
                             'import_id',p_import_id,
                             'flag_count', jsonb_array_length(coalesce(p_flags,'[]'::jsonb))));
  return r;
end $function$;

-- Correcting the payload now moves the column the date filters actually read.
create or replace function public.update_payload_field(p_sub uuid, p_field text, p_value text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_role app_role := my_role(); v_old text; v_locked boolean;
begin
  if v_role not in ('closing_manager','general_manager','manager','admin','cxa','cxm') then
    raise exception 'not authorized';
  end if;

  if v_role in ('cxa','cxm') and not cx_pipeline_member(p_sub) then
    raise exception 'lead is not in the customer pipeline';
  end if;

  if p_field in ('ID','Submitted By Role') then
    raise exception '% is set by the system and cannot be edited', p_field;
  end if;

  select payload->>p_field, archived_at is not null into v_old, v_locked
  from submissions where id = p_sub;
  if not found then raise exception 'submission not found'; end if;
  if v_locked then raise exception 'archived leads cannot be edited'; end if;

  update submissions
     set payload = jsonb_set(payload, array[p_field], to_jsonb(p_value), true)
   where id = p_sub;

  -- Three payload keys are mirrored into real columns, and those columns are
  -- what every date filter, the By Draft Date desk and the duplicate check
  -- read. Writing the payload without re-deriving them left a correction
  -- invisible everywhere it mattered.
  if p_field = 'Draft Date' then
    update submissions set draft_date = parse_lead_date(p_value) where id = p_sub;
  elsif p_field = 'Future Draft Date' then
    update submissions set future_draft_date = parse_lead_date(p_value) where id = p_sub;
  elsif p_field = 'SSN Number' then
    update submissions set ssn_normalized = normalize_ssn(p_value) where id = p_sub;
  end if;

  insert into payload_edits (submission_id, actor_id, field, old_value, new_value)
  values (p_sub, auth.uid(), p_field, v_old, p_value);

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'payload_edited',
          jsonb_build_object('field', p_field, 'by_role', v_role));

  return jsonb_build_object('ok', true, 'field', p_field);
end $function$;

/**
 * Rolls a resolved recurrence forward once its date has passed.
 *
 * This is the price of resolving "3rd of the month" to a real date: without it
 * the value silently rots the moment the month turns. Only leads whose payload
 * text is itself a recurrence are touched — an explicitly typed date does not
 * match those patterns, so a date an operator entered is never moved.
 */
create or replace function public.roll_recurring_draft_dates()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_count int;
begin
  with rolled as (
    update submissions s
       set draft_date = parse_lead_date(s.payload->>'Draft Date', current_date)
     where s.archived_at is null
       and s.draft_date is not null
       and s.draft_date < current_date
       and lower(btrim(coalesce(s.payload->>'Draft Date',''))) ~
           '^\d{1,2}(st|nd|rd|th)?\s+((sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+)?of\s+(the\s+)?month$'
       and parse_lead_date(s.payload->>'Draft Date', current_date) is distinct from s.draft_date
    returning 1
  )
  select count(*) into v_count from rolled;
  return v_count;
end $function$;

select cron.schedule('roll-recurring-draft-dates', '23 5 * * *',
                     'select public.roll_recurring_draft_dates()');

-- Backfill: the same derivations, once, over the leads that never got them.
update submissions
   set ssn_normalized = normalize_ssn(payload->>'SSN Number')
 where ssn_normalized is null
   and normalize_ssn(payload->>'SSN Number') is not null;

update submissions
   set draft_date = parse_lead_date(payload->>'Draft Date', current_date)
 where draft_date is null
   and parse_lead_date(payload->>'Draft Date', current_date) is not null;

update submissions
   set future_draft_date = parse_lead_date(payload->>'Future Draft Date', current_date)
 where future_draft_date is null
   and parse_lead_date(payload->>'Future Draft Date', current_date) is not null;
