-- The status cards must count the leads the table below them shows.
--
-- cx_status_summary joined `submissions` with a LEFT JOIN whose conditions
-- (disposition = 'accepted' and archived_at is null) never removed a row, so it
-- counted the status of every lead that ever had one: archived leads and leads
-- CX had removed from its pipeline included. On 2026-10-10 Policy Status
-- "Approved" read 86 against 73 in the table — 73 in the pipeline, 12 archived,
-- 1 removed. Same gap on every card.
--
-- The table reads cx_pipeline, which owns the membership rule (not archived, not
-- removed by CX, accepted or sent back for re-validation). Joining the summary
-- through it means the cards and the table share one rule and cannot drift.
-- Same columns, same types; security_invoker kept so RLS scopes it per caller.
create or replace view public.cx_status_summary
with (security_invoker = true) as
select
  o.category,
  o.code,
  o.label,
  o.tone,
  o.sort_order,
  count(p.submission_id) as lead_count
from public.cx_status_options o
left join public.cx_lead_status s
  on  (o.category = 'policy'     and s.policy_status_id     = o.id)
  or  (o.category = 'premium'    and s.premium_status_id    = o.id)
  or  (o.category = 'commission' and s.commission_status_id = o.id)
  or  (o.category = 'chargeback' and s.chargeback_status_id = o.id)
left join public.cx_pipeline p
  on p.submission_id = s.submission_id
where o.active
group by o.category, o.code, o.label, o.tone, o.sort_order;
