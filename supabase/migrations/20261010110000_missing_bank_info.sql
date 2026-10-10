-- Banking in "Missing information", as its own group.
--
-- The five banking fields are required on an uploaded lead (they are required on
-- the closer's form), but they are tracked apart from the 15 core fields: on
-- 2026-10-10 Account Title was empty on all 500 uploaded leads and Bank Type on
-- 468, so folding them into `missing_info` would have labelled every lead.
-- Card Number / Exp Date / CVC stay optional and are not listed.
--
-- Four of the five live in payment_details; Bank Type is a payload key. A
-- generated column cannot read another table, so `missing_bank` is a plain
-- column kept current by two triggers. An UPDATE that touches only this column
-- never enqueues a Google Sheets sync — notify_sheet_sync returns early when
-- none of the columns it cares about changed.

-- One definition of "required for an uploaded lead", both groups, in form order.
create or replace function public.uploaded_required_fields()
returns table (ord int, label text, grp text, store text, pay_col text)
language sql
immutable
parallel safe
set search_path = public
as $$
  select * from (values
    (1,  'Full Name',               'core', 'payload', null::text),
    (2,  'Gender',                  'core', 'payload', null),
    (3,  'Date of Birth',           'core', 'payload', null),
    (4,  'Age',                     'core', 'payload', null),
    (5,  'State',                   'core', 'payload', null),
    (6,  'SSN Number',              'core', 'payload', null),
    (7,  'Phone Number',            'core', 'payload', null),
    (8,  'Residential Address',     'core', 'payload', null),
    (9,  'Customer Zip Code',       'core', 'payload', null),
    (10, 'Proposed Carrier',        'core', 'payload', null),
    (11, 'Coverage Amount',         'core', 'payload', null),
    (12, 'Premium',                 'core', 'payload', null),
    (13, 'Plan Type',               'core', 'payload', null),
    (14, 'Beneficiary Name',        'core', 'payload', null),
    (15, 'Draft Date',              'core', 'payload', null),
    (16, 'Account Title',           'bank', 'payment', 'account_title'),
    (17, 'Bank Name',               'bank', 'payment', 'bank_name'),
    (18, 'Bank Type',               'bank', 'payload', null),
    (19, 'Routing Number',          'bank', 'payment', 'routing_number'),
    (20, 'Account Number',          'bank', 'payment', 'account_number')
  ) as t(ord, label, grp, store, pay_col)
  order by ord
$$;

revoke execute on function public.uploaded_required_fields() from public, anon;
grant execute on function public.uploaded_required_fields() to authenticated;

-- Same result as before for the core group, now read from the one definition.
-- The generated submissions.missing_info column keeps calling this by name.
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
        from public.uploaded_required_fields() f
        where f.grp = 'core'
          and nullif(btrim(p_payload ->> f.label), '') is null
      ),
      '{}'::text[]
    )
  end
$$;

create or replace function public.missing_bank_fields(
  p_source text,
  p_payload jsonb,
  p_bank_name text,
  p_account_title text,
  p_routing_number text,
  p_account_number text
)
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
        from public.uploaded_required_fields() f
        where f.grp = 'bank'
          and nullif(btrim(
            case f.pay_col
              when 'bank_name' then p_bank_name
              when 'account_title' then p_account_title
              when 'routing_number' then p_routing_number
              when 'account_number' then p_account_number
              else p_payload ->> f.label
            end
          ), '') is null
      ),
      '{}'::text[]
    )
  end
$$;

alter table public.submissions
  add column if not exists missing_bank text[] not null default '{}';

comment on column public.submissions.missing_bank is
  'Required banking fields an uploaded (source = sheet) lead has no value for; {} for any other lead. Maintained by triggers on submissions (payload) and payment_details (bank columns) — see missing_bank_fields().';

-- Payload side: Bank Type is a payload key, and a new lead needs its starting
-- value. Reads the lead's payment row, which does not exist yet on INSERT; the
-- payment trigger below corrects it a moment later.
create or replace function public.submissions_set_missing_bank()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  pd payment_details;
begin
  if new.source = 'sheet' then
    select * into pd from payment_details where submission_id = new.id;
    new.missing_bank := missing_bank_fields(
      new.source, new.payload, pd.bank_name, pd.account_title, pd.routing_number, pd.account_number
    );
  else
    new.missing_bank := '{}'::text[];
  end if;
  return new;
end;
$$;

drop trigger if exists submissions_missing_bank on public.submissions;
create trigger submissions_missing_bank
  before insert or update of payload, source on public.submissions
  for each row execute function public.submissions_set_missing_bank();

-- Payment side: the four bank columns.
create or replace function public.payment_details_sync_missing_bank()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text;
  v_payload jsonb;
  v_missing text[];
begin
  select source, payload into v_source, v_payload from submissions where id = new.submission_id;
  if not found then
    return new;
  end if;

  v_missing := missing_bank_fields(
    v_source, v_payload, new.bank_name, new.account_title, new.routing_number, new.account_number
  );

  update submissions
     set missing_bank = v_missing
   where id = new.submission_id
     and missing_bank is distinct from v_missing;
  return new;
end;
$$;

drop trigger if exists payment_details_missing_bank on public.payment_details;
create trigger payment_details_missing_bank
  after insert or update of bank_name, account_title, routing_number, account_number
  on public.payment_details
  for each row execute function public.payment_details_sync_missing_bank();

revoke execute on function public.submissions_set_missing_bank() from public, anon, authenticated;
revoke execute on function public.payment_details_sync_missing_bank() from public, anon, authenticated;

-- Backfill the uploaded leads already in the table. This UPDATE changes only
-- missing_bank, so the Sheets trigger returns early and nothing is enqueued.
update public.submissions s
   set missing_bank = public.missing_bank_fields(
     s.source,
     s.payload,
     (select p.bank_name from public.payment_details p where p.submission_id = s.id),
     (select p.account_title from public.payment_details p where p.submission_id = s.id),
     (select p.routing_number from public.payment_details p where p.submission_id = s.id),
     (select p.account_number from public.payment_details p where p.submission_id = s.id)
   )
 where s.source = 'sheet';

-- Per-field counts for the filter dropdowns. SECURITY INVOKER: RLS scopes it.
create or replace function public.missing_bank_by_field()
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
  cross join lateral unnest(s.missing_bank) as m(label)
  where s.archived_at is null
  group by m.label
  order by count(*) desc, m.label;
end;
$$;

revoke execute on function public.missing_bank_by_field() from public, anon;
grant execute on function public.missing_bank_by_field() to authenticated;

-- general_manager may now enter bank fields (the other four listed in
-- v_bank_fields plus payment_type and card_exp). Card number and CVV stay admin
-- only. The role guard is also written fail-closed: a caller with no role
-- (NULL) used to slip past `not in (...)`, which is NULL rather than true.
create or replace function public.update_payment_field(p_sub uuid, p_field text, p_value text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  if p_field = any(v_card_fields) and v_role <> 'admin' then
    raise exception 'only an admin may change card credentials';
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
      set card_last4 = right(regexp_replace(coalesce(p_value,''), '\D', '', 'g'), 4)
    where submission_id = p_sub;
  end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'payment_edited',
          jsonb_build_object('field', p_field,
                             'had_value', v_old is not null and v_old <> '',
                             'by_role', v_role));

  return jsonb_build_object('ok', true, 'field', p_field);
end $$;
