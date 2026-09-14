-- Stamps the uploader's center onto every lead they import, the same way
-- submit_form already stamps a closer's center at submission. Verified live
-- that ingest_sheet_lead never touched center_id/center_name before this —
-- every sheet-sourced submission had both null, regardless of whether the
-- uploader's profile had a center set.
--
-- p_uploaded_by, not auth.uid(): this function runs from the ingest-sheet-
-- lead edge function using the service role key, so auth.uid() inside this
-- SECURITY DEFINER function is not the uploader — the uploader's id is
-- already passed in as p_uploaded_by (resolved by the edge function from the
-- caller's own JWT before it ever calls this RPC).

create or replace function public.ingest_sheet_lead(
  p_payload jsonb,
  p_source_ref text,
  p_uploaded_by uuid default null::uuid,
  p_import_id uuid default null::uuid,
  p_flags jsonb default '[]'::jsonb,
  p_payment jsonb default null::jsonb
)
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
    uploaded_by, import_id, data_flags, center_id, center_name
  )
  values (
    null, p_payload, 'closer', 'pending_import_approval', 'sheet', p_source_ref,
    p_uploaded_by, p_import_id, coalesce(p_flags, '[]'::jsonb), v_center_id, v_center_name
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
