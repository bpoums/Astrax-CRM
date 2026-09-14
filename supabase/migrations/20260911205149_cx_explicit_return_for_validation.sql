-- CX status changes no longer automatically move a lead out of the customer
-- pipeline. Previously, set_cx_status() reopened a lead itself whenever a
-- policy status was set to DECLINED/WITHDRAWN/CANCELLED. That coupling made
-- a policy status change and "hand this lead back to the manager" the same
-- action, when a CXA may want to record the former without doing the latter.
--
-- set_cx_status() is now a pure status write for all four categories (it
-- never touched submissions.status/disposition for premium/commission/
-- chargeback; it now doesn't for policy either). Returning a lead is a new,
-- separate, explicit action: return_lead_for_validation().
create or replace function public.set_cx_status(p_sub uuid, p_category text, p_option_id uuid, p_reason text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_opt cx_status_options; v_prev text;
begin
  if my_role() not in ('cxa','cxm','admin') then raise exception 'not authorized'; end if;

  perform 1 from submissions
   where id = p_sub and disposition = 'accepted' and archived_at is null;
  if not found then raise exception 'lead is not in the customer pipeline'; end if;

  if p_option_id is not null then
    select * into v_opt from cx_status_options
     where id = p_option_id and category = p_category and active;
    if v_opt.id is null then
      raise exception 'invalid option for category %', p_category;
    end if;
  end if;

  insert into cx_lead_status (submission_id) values (p_sub)
  on conflict (submission_id) do nothing;

  execute format(
    'select o.code from cx_lead_status s left join cx_status_options o
       on o.id = s.%I where s.submission_id = $1',
    p_category || '_status_id')
  into v_prev using p_sub;

  -- no-op guard: re-selecting the same value with no new reason changes nothing
  if v_prev is not distinct from v_opt.code and nullif(p_reason,'') is null then
    return jsonb_build_object('ok', true, 'unchanged', true);
  end if;

  execute format(
    'update cx_lead_status set %I = $2, %I = $3, updated_by = $4, updated_at = now()
      where submission_id = $1',
    p_category || '_status_id', p_category || '_reason')
  using p_sub, p_option_id, nullif(p_reason, ''), auth.uid();

  insert into cx_status_history (submission_id, category, from_code, to_code, reason, actor_id)
  values (p_sub, p_category, v_prev, v_opt.code, nullif(p_reason,''), auth.uid());

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'cx_status_changed',
          jsonb_build_object('category', p_category, 'from', v_prev,
                             'to', v_opt.code, 'reason', nullif(p_reason, '')));

  return jsonb_build_object('ok', true, 'category', p_category, 'code', v_opt.code);
end $function$;

-- Explicit CXA/CXM/admin action: send an accepted lead back to the manager's
-- queue for another validation pass, regardless of what any of its four CX
-- statuses currently are. This is the only place that resets the lead —
-- moved here from the removed block in set_cx_status() above, unchanged in
-- what it clears.
create or replace function public.return_lead_for_validation(p_sub uuid, p_reason text default null::text)
 returns submissions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r submissions;
begin
  if my_role() not in ('cxa','cxm','admin') then raise exception 'not authorized'; end if;

  update submissions set
    status = 'pending_manager',
    -- Not 'declined': that is a validator's outcome. This lead has no
    -- current outcome at all, which is what puts it back in the queue.
    disposition = null,
    disposed_by = null,
    disposed_at = null,
    assigned_to = null,
    assigned_at = null,
    claimed_at = null,
    -- The next validator places this somewhere new. The old carrier, agent
    -- and policy number describe the attempt that just failed, and leaving
    -- them would let the accept gate pass on stale values.
    final_carrier_id = null,
    agent_name = null,
    policy_number = null,
    reopened_from_cx_at = now()
  where id = p_sub
    and disposition = 'accepted'
    and archived_at is null
  returning * into r;

  if r.id is null then raise exception 'lead is not in the customer pipeline'; end if;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'reopened_from_cx',
          jsonb_build_object('reason', nullif(p_reason, '')));

  return r;
end $function$;
