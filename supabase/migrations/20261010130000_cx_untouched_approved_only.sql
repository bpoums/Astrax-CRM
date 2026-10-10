-- "Untouched" counts APPROVED leads that no one on the CX team has set a status
-- on — leads that never entered CX. Leads CX sent back to the manager for
-- re-validation have their own card, so they must not be folded in here.
--
-- Read through cx_pipeline so the membership rule (not archived, not removed by
-- CX) is the table's own rather than a copy; the approved test is the pipeline's
-- `disposition = 'accepted'`. The previous migration (20261010121000) made this
-- view cover every pipeline lead, which put a sent-back lead with no status in
-- "untouched" (598); this narrows it again to 597. Same columns and types;
-- security_invoker kept.
create or replace view public.cx_untouched
with (security_invoker = true) as
select
  p.submission_id,
  p.payload,
  p.approved_on as disposed_at
from public.cx_pipeline p
where p.disposition = 'accepted'
  and p.policy_code is null
  and p.premium_code is null
  and p.commission_code is null
  and p.chargeback_code is null;
