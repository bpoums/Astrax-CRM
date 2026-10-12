-- Managers and general managers may read a full card number, and admin, manager
-- and general_manager may add the optional card fields (number, expiry, CVV) to a
-- lead that lacks them.
--
-- This reverses the old rule that card numbers never reach a manager's browser.
-- Every reveal is still one explicit click on `card_details`, which writes a
-- `card_access_log` row before returning anything. The uploader, closing_manager
-- and the CX roles still can neither read nor write a card.
--
-- 1. card_details: + manager, general_manager. Fail-closed guard kept.
-- 2. update_payment_field: card_number / cvv writable by admin, manager and
--    general_manager (was admin only). Saving a card number on a lead whose
--    payment_type is still unknown makes it a card lead, so the panel shows it.
-- 3. payment_summary: + has_cvv (a boolean, never the value) so the UI can tell
--    which optional card fields are missing.

create or replace function public.card_details(p_sub uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_role app_role := my_role(); r payment_details;
begin
  if v_role is null or v_role not in ('admin','manager','general_manager','validator') then
    raise exception 'not authorized';
  end if;
  if v_role = 'validator' then
    perform 1 from submissions
      where id = p_sub and assigned_to = auth.uid()
        and status = 'in_review' and archived_at is null;
    if not found then raise exception 'not currently reviewing this lead'; end if;
  end if;

  select * into r from payment_details where submission_id = p_sub;
  if r.submission_id is null then return null; end if;

  insert into card_access_log (submission_id, actor_id) values (p_sub, auth.uid());

  return jsonb_build_object(
    'card_number', r.card_number,
    'card_exp', r.card_exp,
    'cvv', r.cvv,
    'cvv_purged', r.cvv_purged_at is not null,
    'card_purged', r.card_purged_at is not null
  );
end $function$;

create or replace function public.update_payment_field(p_sub uuid, p_field text, p_value text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role app_role := my_role();
  v_bank_fields text[] := array['payment_type','bank_name','routing_number',
                                'account_number','account_title','card_exp'];
  v_card_fields text[] := array['card_number','cvv'];
  v_old text;
begin
  if v_role is null or v_role not in ('manager','admin','general_manager','cxa','cxm') then
    raise exception 'not authorized';
  end if;

  if p_field = any(v_card_fields) and v_role not in ('admin','manager','general_manager') then
    raise exception 'only an admin, manager or general manager may change card credentials';
  end if;

  if v_role in ('cxa','cxm') and not cx_pipeline_member(p_sub) then
    raise exception 'lead is not in the customer pipeline';
  end if;

  if not (p_field = any(v_bank_fields) or p_field = any(v_card_fields)) then
    raise exception 'field % is not editable here', p_field;
  end if;

  if p_field = 'payment_type' and p_value not in ('card','draft','unknown') then
    raise exception 'payment_type must be card, draft or unknown';
  end if;

  insert into payment_details (submission_id) values (p_sub)
  on conflict (submission_id) do nothing;

  execute format('select %I::text from payment_details where submission_id = $1', p_field)
    into v_old using p_sub;

  execute format('update payment_details set %I = $2 where submission_id = $1', p_field)
    using p_sub, nullif(p_value, '');

  if p_field = 'card_number' then
    update payment_details
      set card_last4 = right(regexp_replace(coalesce(p_value,''), '\D', '', 'g'), 4),
          payment_type = case
            when nullif(p_value, '') is not null
             and coalesce(payment_type, 'unknown') = 'unknown' then 'card'
            else payment_type
          end
    where submission_id = p_sub;
  end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'payment_edited',
          jsonb_build_object('field', p_field,
                             'had_value', v_old is not null and v_old <> '',
                             'by_role', v_role));

  return jsonb_build_object('ok', true, 'field', p_field);
end $function$;

create or replace function public.payment_summary(p_sub uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_role app_role := my_role(); r payment_details;
begin
  if v_role is null or v_role not in ('admin','manager','closing_manager','general_manager','validator','cxm','cxa') then
    raise exception 'not authorized';
  end if;
  if v_role = 'validator' then
    perform 1 from submissions
      where id = p_sub and assigned_to = auth.uid() and archived_at is null;
    if not found then raise exception 'not assigned to you'; end if;
  end if;
  if v_role in ('cxm','cxa') and not cx_pipeline_member(p_sub) then
    raise exception 'lead is not in the customer pipeline';
  end if;

  select * into r from payment_details where submission_id = p_sub;
  if r.submission_id is null then return null; end if;

  return jsonb_build_object(
    'payment_type', r.payment_type,
    'bank_name', r.bank_name,
    'routing_number', r.routing_number,
    'account_number', r.account_number,
    'account_title', r.account_title,
    'card_last4', r.card_last4,
    'card_exp', r.card_exp,
    'has_card', r.card_number is not null,
    'has_cvv', r.cvv is not null,
    'cvv_purged', r.cvv_purged_at is not null
  );
end $function$;
