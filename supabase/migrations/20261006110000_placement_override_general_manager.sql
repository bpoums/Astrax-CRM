-- Placement override: general managers may grant it too, not only admins.
--
-- Same function, same arguments, same effect — one lead, one IMO -> carrier,
-- a required reason, the rejection itself untouched. Only who may call it
-- changes, so the load of approving a blocked placement is shared. The event
-- now records the approver's role, since there are two of them.
--
-- CREATE OR REPLACE keeps the existing grants: authenticated may execute,
-- anon may not.

create or replace function public.override_placement_block(
  p_sub uuid, p_imo_id uuid, p_carrier_id uuid, p_reason text
) returns void
language plpgsql security definer set search_path to 'public'
as $$
declare v_role app_role := my_role();
begin
  if v_role is null or v_role not in ('admin', 'general_manager') then
    raise exception 'not authorized';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'an override needs a reason';
  end if;
  if not exists (select 1 from submissions where id = p_sub and archived_at is null) then
    raise exception 'submission not found or archived';
  end if;

  insert into placement_overrides (submission_id, imo_id, carrier_id, reason, overridden_by)
  values (p_sub, p_imo_id, p_carrier_id, btrim(p_reason), auth.uid())
  on conflict (submission_id, imo_id, carrier_id) do nothing;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'placement_override',
          jsonb_build_object(
            'by_role', v_role,
            'imo', (select name from imos where id = p_imo_id),
            'carrier', (select name from carriers where id = p_carrier_id),
            'reason', btrim(p_reason)));
end $$;
