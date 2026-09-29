-- CRM-wide suspend/maintenance mode.
--
-- A single admin-controlled switch that pauses the entire app for every
-- non-admin role, either for a fixed duration (auto-resume) or indefinitely
-- until manually resumed. Reuses the same NULL-role RLS cascade individual
-- deactivation already relies on (my_role() -> NULL matches no policy), so
-- no other policy or RPC guard needs editing. `crm_suspension` itself is a
-- deliberate exception to "app_config has zero RLS policies": it needs a
-- public-read policy so a just-kicked (or never-authenticated) visitor can
-- still see why they're locked out.

create table public.crm_suspension (
  id boolean primary key default true,
  suspended boolean not null default false,
  resumes_at timestamptz,
  message text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  constraint crm_suspension_singleton check (id)
);

insert into public.crm_suspension (id) values (true);

alter table public.crm_suspension enable row level security;

-- Readable by anyone, including anon/signed-out — the whole point is that a
-- forced-out user can still see the message. No write policy: every change
-- goes through set_crm_suspension() below.
create policy crm_suspension_read on public.crm_suspension
  for select
  using (true);

alter publication supabase_realtime add table public.crm_suspension;

-- Folds the suspension check into the same function nearly every RLS policy
-- and RPC guard in the app already calls, and which the 2026-09-27 fix
-- already made every call site treat a NULL result as "no access". Admins
-- are exempted inline so the admin panel (and set_crm_suspension itself)
-- keeps working while suspended.
create or replace function public.my_role()
returns app_role
language sql stable security definer
set search_path to 'public'
as $function$
  select role from profiles
  where id = auth.uid()
    and active
    and (
      role = 'admin'
      or not exists (
        select 1 from crm_suspension
        where id = true
          and suspended
          and (resumes_at is null or resumes_at > now())
      )
    )
$function$;

create or replace function public.set_crm_suspension(
  p_suspended boolean,
  p_duration_minutes integer default null,
  p_message text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old jsonb;
  v_new jsonb;
begin
  if my_role() is distinct from 'admin' then raise exception 'not authorized'; end if;

  select to_jsonb(c) into v_old from crm_suspension c where id = true;

  if p_suspended then
    if p_duration_minutes is not null and p_duration_minutes <= 0 then
      raise exception 'Duration must be a positive number of minutes';
    end if;

    update crm_suspension
    set suspended = true,
        resumes_at = case when p_duration_minutes is null then null
                          else now() + (p_duration_minutes || ' minutes')::interval end,
        message = coalesce(nullif(trim(p_message), ''),
                            'The system is temporarily suspended for maintenance.'),
        updated_by = auth.uid(),
        updated_at = now()
    where id = true;
  else
    update crm_suspension
    set suspended = false,
        resumes_at = null,
        updated_by = auth.uid(),
        updated_at = now()
    where id = true;
  end if;

  select to_jsonb(c) into v_new from crm_suspension c where id = true;

  insert into settings_audit (actor_id, key, old_value, new_value)
  values (auth.uid(), 'crm_suspension', v_old::text, v_new::text);
end;
$function$;

revoke execute on function public.set_crm_suspension(boolean, integer, text) from anon;

-- Cron-only cosmetic sweep: keeps `suspended`/`resumes_at` honest for
-- display once a timed suspension's clock runs out. Not the real gate —
-- my_role() checks resumes_at directly, so enforcement never depends on
-- this tick firing on time (same belt-and-suspenders pattern as
-- review_window() + the expire-reviews cron job).
create or replace function public.clear_expired_suspension()
returns void
language sql
security definer
set search_path to 'public'
as $function$
  update crm_suspension
  set suspended = false, resumes_at = null
  where id = true
    and suspended
    and resumes_at is not null
    and resumes_at <= now();
$function$;

revoke execute on function public.clear_expired_suspension() from anon, authenticated;

select cron.schedule(
  'clear-expired-suspension',
  '* * * * *',
  'select public.clear_expired_suspension()'
);
