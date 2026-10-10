-- The top cards (Untouched / In CX / Submitted leads) must agree with the table
-- and the status cards. Submitted leads and In CX already come from cx_pipeline;
-- Untouched came from a separate accepted-only rule, so a lead CX had sent back
-- for re-validation, still on the pipeline table with no status, was counted as
-- "in CX" (800 - 597 = 203) while the table has 202 leads with a status.
--
-- Untouched is now the pipeline leads with no status in any of the four
-- categories — the same rule the table uses, via cx_pipeline. Same columns and
-- types as before (submission_id, payload, disposed_at); security_invoker kept.
create or replace view public.cx_untouched
with (security_invoker = true) as
select
  p.submission_id,
  p.payload,
  p.approved_on as disposed_at
from public.cx_pipeline p
where p.policy_code is null
  and p.premium_code is null
  and p.commission_code is null
  and p.chargeback_code is null;
