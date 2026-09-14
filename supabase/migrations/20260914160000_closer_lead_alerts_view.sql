-- Creates closer_lead_alerts, documented at length in
-- src/components/forwarded-leads.tsx as the source of a closer's "Policy
-- Status" column but never actually created — confirmed live: it did not
-- exist as a table or view at all, breaking the "Forwarded Leads" screen
-- (reachable from the closer form) for every closer, since before this
-- session's work (traced to 4fcbd35, the common ancestor of every branch
-- merged today).
--
-- Read-only security boundary for a role RLS otherwise gives nothing to:
-- a closer cannot read `submissions` or `cx_lead_status` directly, so this
-- view (default security_invoker = false, i.e. it runs with the view
-- owner's privileges, the read-side equivalent of a SECURITY DEFINER RPC —
-- see docs/decisions/0001-rls-as-the-only-boundary.md) bakes
-- `s.closer_id = auth.uid()` into itself rather than relying on RLS it
-- would otherwise need on tables no other role should read directly.
--
-- One row per (lead, CX dimension) that is currently a problem — tone
-- destructive or warning only, per the same vocabulary set_cx_status
-- already uses — never every dimension's full status, and never an
-- archived lead.

create view public.closer_lead_alerts as
select s.id as submission_id, 'policy'::text as category, po.label as status_label, po.tone
  from public.submissions s
  join public.cx_lead_status st on st.submission_id = s.id
  join public.cx_status_options po on po.id = st.policy_status_id
 where s.closer_id = auth.uid()
   and s.archived_at is null
   and po.tone in ('destructive', 'warning')
union all
select s.id, 'premium', pr.label, pr.tone
  from public.submissions s
  join public.cx_lead_status st on st.submission_id = s.id
  join public.cx_status_options pr on pr.id = st.premium_status_id
 where s.closer_id = auth.uid()
   and s.archived_at is null
   and pr.tone in ('destructive', 'warning')
union all
select s.id, 'commission', cm.label, cm.tone
  from public.submissions s
  join public.cx_lead_status st on st.submission_id = s.id
  join public.cx_status_options cm on cm.id = st.commission_status_id
 where s.closer_id = auth.uid()
   and s.archived_at is null
   and cm.tone in ('destructive', 'warning')
union all
select s.id, 'chargeback', cb.label, cb.tone
  from public.submissions s
  join public.cx_lead_status st on st.submission_id = s.id
  join public.cx_status_options cb on cb.id = st.chargeback_status_id
 where s.closer_id = auth.uid()
   and s.archived_at is null
   and cb.tone in ('destructive', 'warning');

grant select on public.closer_lead_alerts to authenticated;
