-- Banks: the vocabulary behind the Bank Name dropdown on the closer and
-- validator forms.
--
-- The lead keeps storing the bank NAME as a plain string in payload ->
-- 'Bank Name', so the payload shape and the Google Sheet column are unchanged.
-- This table only supplies the list a closer searches and the aliases that
-- find a bank under its other spellings.
--
-- Access model (docs/decisions/0001, 0002): RLS scopes the read; every write is
-- a SECURITY DEFINER RPC that re-checks the caller's role. There is no
-- client-reachable write policy. A closer or validator can add a bank that is
-- not yet in the list (add_bank); renaming or retiring one is admin only.

create table if not exists public.banks (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 80),
  aliases text[] not null default '{}',
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

-- One row per bank whatever the case or spacing someone types.
create unique index if not exists banks_name_key
  on public.banks (lower(regexp_replace(btrim(name), '\s+', ' ', 'g')));

alter table public.banks enable row level security;

drop policy if exists "banks readable" on public.banks;
create policy "banks readable" on public.banks
  for select to authenticated
  using ((select my_role()) is not null);

-- No write policy on purpose; belt and braces on the grants as well.
revoke all on public.banks from anon;
revoke insert, update, delete, truncate on public.banks from authenticated;
grant select on public.banks to authenticated;

-- ---------------------------------------------------------------------------
-- add_bank: closer, validator and admin. Returns the existing row when the name
-- (or one of its aliases) is already known, so two closers adding the same
-- bank at once, or typing a known spelling, end up with the same entry.
-- The client sends the name already Title Cased; the server does not re-case.
-- ---------------------------------------------------------------------------
create or replace function public.add_bank(p_name text)
returns public.banks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_key text;
  v_row public.banks;
begin
  -- NULL-safe: an inactive or missing profile has no role, and
  -- `my_role() <> 'x'` would be NULL (not true) and let it through.
  if coalesce(my_role()::text, '') <> all (array['closer', 'validator', 'admin']) then
    raise exception 'not authorized';
  end if;

  v_name := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  if length(v_name) < 2 or length(v_name) > 80 then
    raise exception 'enter a bank name (2 to 80 characters)';
  end if;
  if lower(v_name) in ('n/a', 'na', 'none', 'null', 'nil', 'unknown', 'no bank', '-', '.') then
    raise exception 'that is not a bank name';
  end if;

  v_key := lower(v_name);

  select * into v_row
    from public.banks b
   where lower(regexp_replace(btrim(b.name), '\s+', ' ', 'g')) = v_key
      or v_key = any (select lower(a) from unnest(b.aliases) as a)
   limit 1;
  if found then
    return v_row;
  end if;

  begin
    insert into public.banks (name, created_by)
    values (v_name, (select auth.uid()))
    returning * into v_row;
  exception when unique_violation then
    select * into v_row
      from public.banks b
     where lower(regexp_replace(btrim(b.name), '\s+', ' ', 'g')) = v_key;
  end;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_rename_bank / admin_set_bank_active: admin only. Renaming does not
-- rewrite the name already stored on a lead; it changes what the list offers.
-- ---------------------------------------------------------------------------
create or replace function public.admin_rename_bank(p_id uuid, p_name text)
returns public.banks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_row public.banks;
begin
  if my_role() is distinct from 'admin'::app_role then
    raise exception 'not authorized';
  end if;

  v_name := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  if length(v_name) < 2 or length(v_name) > 80 then
    raise exception 'enter a bank name (2 to 80 characters)';
  end if;

  begin
    update public.banks set name = v_name where id = p_id returning * into v_row;
  exception when unique_violation then
    raise exception 'another bank already has that name';
  end;

  if not found then
    raise exception 'bank not found';
  end if;
  return v_row;
end;
$$;

create or replace function public.admin_set_bank_active(p_id uuid, p_active boolean)
returns public.banks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.banks;
begin
  if my_role() is distinct from 'admin'::app_role then
    raise exception 'not authorized';
  end if;

  update public.banks set active = coalesce(p_active, true) where id = p_id returning * into v_row;
  if not found then
    raise exception 'bank not found';
  end if;
  return v_row;
end;
$$;

-- Supabase grants EXECUTE to anon directly, so revoking from PUBLIC alone is
-- not enough; name it.
revoke execute on function public.add_bank(text) from public, anon;
revoke execute on function public.admin_rename_bank(uuid, text) from public, anon;
revoke execute on function public.admin_set_bank_active(uuid, boolean) from public, anon;
grant execute on function public.add_bank(text) to authenticated;
grant execute on function public.admin_rename_bank(uuid, text) to authenticated;
grant execute on function public.admin_set_bank_active(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Seed: every bank seen on two or more live leads (2026-10-14, 1,138 leads),
-- spelling variants merged into one name with the variants kept as aliases so
-- typing any of them finds it. Junk (N/A, "credit union") is left out. Banks
-- seen once are not seeded; they come back through "add a new bank".
-- ---------------------------------------------------------------------------
insert into public.banks (name, aliases) values
  ('Wells Fargo', array['Wells Fargo Bank', 'Wels Fargo', 'Wels Fargo Bank', 'Wells Fargo Bank National Association']),
  ('Bank of America', array['Bank Of America', 'Bank of America NA', 'BofA', 'BOA']),
  ('Chase Bank', array['Chase', 'JPMorgan Chase Bank', 'JPMorgan Chase', 'JP Morgan Chase Bank', 'J P Morgan Chase Bank', 'JPMorgan Chase Bank NA']),
  ('Truist Bank', array['Truist', 'The Truist Bank', 'Truist accounts']),
  ('Regions Bank', array['Regions', 'The Regions Bank']),
  ('PNC Bank', array['PNC', 'PNC Bank National Association']),
  ('Fifth Third Bank', array['Fifth Third']),
  ('US Bank', array['U.S. Bank', 'U.S Bank', 'US Bank National Association']),
  ('Woodforest National Bank', array['Woodforest', 'Woodforest Bank', 'Wood Forest', 'Wood Forest Bank']),
  ('Huntington Bank', array['Huntington', 'Huntington National Bank']),
  ('Navy Federal Credit Union', array['Navy Federal', 'NFCU']),
  ('State Employees Credit Union (SECU)', array['State Employees Credit Union', 'State Employees'' Credit Union', 'State Employee''s Credit Union', 'State Employees CU', 'State Employee CU', 'SECU']),
  ('TD Bank', array['TD']),
  ('First National Bank', array[]::text[]),
  ('M&T Bank', array['M & T Bank', 'Manufacturers and Traders Trust Company']),
  ('Sutton Bank', array[]::text[]),
  ('Citizens Bank', array['The Citizens Bank', 'Citizen Bank']),
  ('First Citizens Bank', array['First Citizens', 'First Citizen Bank']),
  ('The Bancorp Bank', array['Bancorp Bank', 'Bancorp']),
  ('Capital One', array['Capital One Bank']),
  ('First Bank', array[]::text[]),
  ('Bank First', array[]::text[]),
  ('KeyBank', array['Key Bank', 'KeyBank National Association']),
  ('Atlantic Union Bank', array[]::text[]),
  ('First Horizon Bank', array['First Horizon']),
  ('Chime', array['Chime Bank']),
  ('Comerica Bank', array['Comerica']),
  ('Pinnacle Bank', array[]::text[]),
  ('Santander Bank', array['Santander']),
  ('Banner Bank', array[]::text[]),
  ('BMO Bank', array['BMO']),
  ('Simmons Bank', array[]::text[]),
  ('Triangle Federal Credit Union', array[]::text[]),
  ('First American Bank', array[]::text[]),
  ('First Commonwealth Bank', array[]::text[]),
  ('First State Community Bank', array[]::text[]),
  ('Hancock Whitney Bank', array['Hancock Whitney']),
  ('Intrust Bank', array[]::text[]),
  ('Langley Federal Credit Union', array[]::text[]),
  ('MidWestOne Bank', array['Midwestone Bank']),
  ('Bank OZK', array['OZK Bank']),
  ('Renasant Bank', array[]::text[]),
  ('Republic Bank & Trust Company', array[]::text[]),
  ('S&T Bank', array['S & T Bank']),
  ('Summit Credit Union', array[]::text[]),
  ('Superior Credit Union', array[]::text[]),
  ('Trustmark Bank', array['Trustmark']),
  ('United Bank', array[]::text[]),
  ('United Community Bank', array[]::text[]),
  ('USAA Federal Savings Bank', array['USAA', 'USAA Bank']),
  ('Vystar Credit Union', array[]::text[]),
  ('WesBanco Bank', array['Wesbanco Bank', 'Wesbanco']),
  ('Apple Federal Credit Union', array[]::text[]),
  ('Arrow Pointe Federal Credit Union', array[]::text[]),
  ('Arthur State Bank', array[]::text[]),
  ('Arvest Bank', array['Arvest']),
  ('Bayport Credit Union', array[]::text[]),
  ('Bayshore Credit Union', array[]::text[]),
  ('Blue Ridge Bank', array[]::text[]),
  ('Broadway Bank', array[]::text[]),
  ('Busey Bank', array['Busey']),
  ('Cadence Bank', array[]::text[]),
  ('Centra Credit Union', array[]::text[]),
  ('Central Bank', array[]::text[]),
  ('CIBC Bank', array['CIBC']),
  ('Citadel Federal Credit Union', array[]::text[]),
  ('Clearview Federal Credit Union', array[]::text[]),
  ('Commerce Bank', array[]::text[]),
  ('Commonwealth Credit Union', array[]::text[]),
  ('Community Bank', array[]::text[]),
  ('CommunityAmerica Credit Union', array['Community America Credit Union']),
  ('Dupaco Bank', array['Dupaco']),
  ('EECU Bank', array['EECU']),
  ('Equity Bank', array[]::text[]),
  ('Everwise Credit Union', array[]::text[]),
  ('The Farmers Bank', array['Farmers Bank']),
  ('Farmers Bank & Trust in Arkansas (AR)', array[]::text[]),
  ('Farmers National Bank', array[]::text[]),
  ('First Bank & Trust Co', array[]::text[]),
  ('First Commerce Credit Union', array[]::text[]),
  ('First Federal Bank of Louisiana', array['First Federal Bank Of Louisiana']),
  ('First National Bank Texas', array[]::text[]),
  ('First Northern Bank', array[]::text[]),
  ('Founders Federal Credit Union', array[]::text[]),
  ('Frost Bank', array[]::text[]),
  ('Gate City Bank', array[]::text[]),
  ('Harvest Federal Credit Union', array[]::text[]),
  ('Heritage Federal Credit Union', array[]::text[]),
  ('Inwood National Bank', array[]::text[]),
  ('Kellogg Community Credit Union', array[]::text[]),
  ('Kirtland Federal Credit Union', array[]::text[]),
  ('Lake Michigan Credit Union', array[]::text[]),
  ('Legend Bank', array[]::text[]),
  ('MECU Credit Union', array['MECU']),
  ('Members 1st Federal Credit Union', array[]::text[]),
  ('MetaBank', array['Meta Bank']),
  ('MUNA Federal Credit Union', array['MUNA']),
  ('NASA Federal Credit Union', array['NASA FCU']),
  ('Old National Bank', array[]::text[]),
  ('Otero Federal Credit Union', array[]::text[]),
  ('Pathward Bank', array['Pathward', 'Pathward National Association']),
  ('Pitsea State Bank', array[]::text[]),
  ('Prosperity Bank', array[]::text[]),
  ('Rally Credit Union', array[]::text[]),
  ('Richland Federal Credit Union', array[]::text[]),
  ('Security First Federal Credit Union', array[]::text[]),
  ('Southern Bank', array['Southern Bank - Tarboro']),
  ('Southside Bank', array[]::text[]),
  ('SouthState Bank', array['South State Bank']),
  ('SSFCU', array[]::text[]),
  ('Stock Yards Bank & Trust', array['Stock Yards Bank']),
  ('Stride Bank', array[]::text[]),
  ('Suncoast Credit Union', array[]::text[]),
  ('Truliant Federal Credit Union', array[]::text[]),
  ('Varo Bank', array['Varo']),
  ('Webster Bank', array['Webster']),
  ('Westamerica Bank', array[]::text[]),
  ('Winsouth Credit Union', array[]::text[]),
  ('The Bank of Princeton', array['Bank of Princeton'])
on conflict do nothing;
