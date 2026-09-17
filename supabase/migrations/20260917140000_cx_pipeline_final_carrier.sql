-- The CX pipeline shows the carrier the policy was WRITTEN on, not the one a
-- closer pitched.
--
-- `cx_pipeline` carried only `payload`, so the Customers Pipeline's Carrier
-- column read the intake form's own text — a proposal. For a team servicing a
-- live policy that is the wrong answer, and for an uploaded lead it is usually
-- no answer at all: of the 25 sheet leads in the pipeline today only 1 carries
-- carrier text in its payload, while 19 have a `final_carrier_id` stamped by a
-- validator. The column was blank for exactly the leads whose carrier was
-- known all along, in a column this view never selected.
--
-- Five columns are appended (a `create or replace` can only add at the end, so
-- every existing column keeps its position and ordinal):
--
--   submitted_by_role  — lets `finalCarrierName()` resolve a validator's own
--                        submission, whose carrier is `payload->>'Agency'` and
--                        which never gets the FK stamped (0 of 260 live).
--   final_carrier_id   — the FK itself.
--   final_carrier_name — resolved HERE rather than embedded client-side, so the
--                        search box can filter on the name with no per-keystroke
--                        carriers lookup and the column needs no second query.
--   agent_name
--   policy_number      — the other two validator-completed fields, so the CX
--                        detail sheet can show the placement read-only.
--
-- No policy change: `carriers` is already readable by cxa/cxm ("carriers
-- readable"), and this view is security_invoker, so the join resolves under the
-- reader's own rights.

create or replace view public.cx_pipeline
with (security_invoker = true) as
 SELECT s.id AS submission_id,
    s.payload,
    s.created_at AS submitted_on,
    s.disposed_at AS approved_on,
    s.source,
    po.code AS policy_code,
    po.label AS policy_label,
    po.tone AS policy_tone,
    st.policy_reason,
    pr.code AS premium_code,
    pr.label AS premium_label,
    pr.tone AS premium_tone,
    st.premium_reason,
    cm.code AS commission_code,
    cm.label AS commission_label,
    cm.tone AS commission_tone,
    st.commission_reason,
    cb.code AS chargeback_code,
    cb.label AS chargeback_label,
    cb.tone AS chargeback_tone,
    st.chargeback_reason,
    st.updated_at AS cx_updated_at,
    u.full_name AS cx_updated_by,
    s.draft_date,
    s.status,
    s.disposition,
    s.reopened_from_cx_at,
    s.submitted_by_role,
    s.final_carrier_id,
    fc.name AS final_carrier_name,
    s.agent_name,
    s.policy_number
   FROM submissions s
     LEFT JOIN cx_lead_status st ON st.submission_id = s.id
     LEFT JOIN cx_status_options po ON po.id = st.policy_status_id
     LEFT JOIN cx_status_options pr ON pr.id = st.premium_status_id
     LEFT JOIN cx_status_options cm ON cm.id = st.commission_status_id
     LEFT JOIN cx_status_options cb ON cb.id = st.chargeback_status_id
     LEFT JOIN profiles u ON u.id = st.updated_by
     LEFT JOIN carriers fc ON fc.id = s.final_carrier_id
  WHERE s.archived_at IS NULL
    AND s.cx_removed_at IS NULL
    AND (s.disposition = 'accepted'::disposition_t OR s.reopened_from_cx_at IS NOT NULL);
