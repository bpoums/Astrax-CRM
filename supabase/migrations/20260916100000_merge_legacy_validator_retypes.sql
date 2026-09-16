-- Merges the legacy validator "re-typed" duplicates back into the closer's row.
--
-- HISTORY this repairs. Before 2026-09-07, a validator had no way to record the
-- carrier that actually wrote a policy, nor the agent name or policy number, on
-- a closer's lead. So when a closer forwarded a lead proposed for (say)
-- Corbridge and Insta Brain accepted it, the validator re-typed the WHOLE lead
-- through "New Submission" with the correct carrier, policy number and agent
-- name. One real sale, recorded twice.
--
-- `set_validator_fields` (final_carrier_id / agent_name / policy_number) ended
-- that workaround. The data confirms the cutover exactly: closer leads carrying
-- a final_carrier_id go from 0-1 per day before 09/05 to 4-18 per day from
-- 09/07, and not one closer lead since 09/05 shares an SSN with a validator
-- submission. The last re-typed pair is 09/04.
--
-- The two halves are complementary and neither is complete alone:
--   closer row     - has closer attribution, proposed carrier, no policy/agent
--   validator copy - has the true carrier (payload 'Agency'), policy number and
--                    agent name, but its closer_id is the VALIDATOR's
--
-- So this keeps the CLOSER's row (attribution drives commission and the
-- leaderboard) and lifts everything the validator copy knows onto it:
--   * payload 'Agency'        -> final_carrier_id  (resolved against carriers;
--                                verified 74/74 resolve exactly)
--   * payload 'Agent Name'    -> agent_name
--   * payload 'Policy Number' -> policy_number
--   * every other payload key the validator filled and the closer left empty
--
-- Gap-fill only: a value the closer actually entered is never overwritten. The
-- match is on ssn_normalized, the system's own identity key, taking the
-- earliest row on each side where a pair has more than one.
--
-- EXCLUDED from the payload merge, deliberately:
--   'Agency', 'Agent Name', 'Policy Number' - these become columns above.
--     'Agency' especially must not land in the closer's payload: CARRIER_KEYS
--     reads it, so the row would render the final carrier where the proposal
--     belongs, silently undoing the distinction this repairs.
--   'ID', 'Submitted By Role' - stamped per submitter by submit_form_internal.
--     Copying them would write the VALIDATOR's staff id onto a closer's lead.
--
-- This migration does NOT delete the validator copies. That is a separate,
-- destructive step held for owner sign-off.
--
-- The sheet-sync UPDATE trigger is disabled for the duration: 74 payload
-- updates would otherwise fire 74 net.http_post calls at once into an Apps
-- Script that serialises on a 30-second lock, and the later ones would fail.
-- Re-sync in batches afterwards if the Sheet needs to reflect the merge.

alter table public.submissions disable trigger sheet_sync_on_closed;

with s as (
  select id, ssn_normalized, created_at, payload,
         case when submitted_by_role = 'validator' then 'validator' else 'closer' end as role
  from public.submissions
  where archived_at is null and source = 'live' and ssn_normalized is not null
),
paired as (
  select ssn_normalized from s
  group by ssn_normalized
  having count(*) filter (where role = 'closer') > 0
     and count(*) filter (where role = 'validator') > 0
),
c as (
  select distinct on (ssn_normalized) *
  from s join paired using (ssn_normalized)
  where role = 'closer' order by ssn_normalized, created_at
),
v as (
  select distinct on (ssn_normalized) *
  from s join paired using (ssn_normalized)
  where role = 'validator' order by ssn_normalized, created_at
),
merged as (
  select
    c.id as closer_id,
    car.id as final_carrier_id,
    nullif(trim(v.payload->>'Agent Name'), '')    as agent_name,
    nullif(trim(v.payload->>'Policy Number'), '') as policy_number,
    coalesce((
      select jsonb_object_agg(k, v.payload->k)
      from jsonb_object_keys(v.payload) k
      where k not in ('Agency', 'Agent Name', 'Policy Number', 'ID', 'Submitted By Role')
        and nullif(trim(v.payload->>k), '') is not null
        and nullif(trim(coalesce(c.payload->>k, '')), '') is null
    ), '{}'::jsonb) as additions
  from c join v using (ssn_normalized)
  left join public.carriers car
    on lower(trim(car.name)) = lower(trim(v.payload->>'Agency'))
)
update public.submissions s
   set payload          = s.payload || m.additions,
       final_carrier_id = coalesce(s.final_carrier_id, m.final_carrier_id),
       agent_name       = coalesce(s.agent_name, m.agent_name),
       policy_number    = coalesce(s.policy_number, m.policy_number)
  from merged m
 where s.id = m.closer_id;

-- 'Future Draft Date' is parsed into its own column at INSERT time by
-- submit_form_internal, so a payload-only merge would leave the column null on
-- the ~54 rows that just gained the key, and the By Draft Date screens filter
-- on the column rather than the payload.
update public.submissions
   set future_draft_date = nullif(payload->>'Future Draft Date', '')::date
 where source = 'live'
   and archived_at is null
   and future_draft_date is null
   and nullif(payload->>'Future Draft Date', '') is not null;

alter table public.submissions enable trigger sheet_sync_on_closed;
