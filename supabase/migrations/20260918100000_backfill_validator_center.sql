-- Backfill center_id/center_name on validator submissions that predate their
-- submitters being assigned a centre.
--
-- WHY THEY ARE NULL
--
-- submit_form_internal stamps the centre from the SUBMITTER'S PROFILE at
-- submission time:
--
--     select p.staff_id, p.center_id, c.name
--       into v_staff, v_center_id, v_center_name
--     from profiles p left join centers c on c.id = p.center_id
--
-- That is a snapshot, not a live join, and deliberately so: a lead should keep
-- the centre it was taken in even if the person later moves centre. The side
-- effect is that assigning a centre to a profile never reaches rows already
-- submitted. Six validators submitted between 2026-08-26 and 2026-08-29,
-- before any of them had a centre, so those 40 rows carry NULL in both columns
-- (never one without the other). Everything from 2026-08-31 onward is stamped
-- correctly, so this is historical rather than an ongoing bug, and re-running
-- this migration is a no-op.
--
-- WHAT THIS DOES NOT CHANGE — checked before writing it
--
--  - Reporting. `submission_totals_by_center` joins only
--    `submitted_by_role = 'closer' AND source = 'live'`, so the Leads by
--    Center figures do not move by a single lead.
--  - Visibility. The `closing_manager` branch of `submissions read scoped`
--    also requires `submitted_by_role = 'closer'`, so no role can see a row it
--    could not see before. Every row here is validator-submitted.
--
-- The only visible effect is the reported one: the Center column stops being
-- blank in Submissions. Archived rows are included (18 of the 40) so the
-- column is consistent when Show Archive is on.
--
-- The centre is read from each submitter's own profile rather than hardcoded,
-- so no generated id is baked into this file and each validator gets their own
-- centre rather than an assumed one.
--
-- DELIBERATELY EXCLUDED: one uploaded lead (source = 'sheet', 2026-09-11)
-- whose uploader likewise had no centre at import time. `ingest_sheet_lead`
-- stamps uploaded leads `submitted_by_role = 'closer'`, so giving that row a
-- centre WOULD newly expose it to that centre's closing_manager. That is a
-- real visibility change and belongs in its own decision, not carried along by
-- a cosmetic backfill.

update submissions s
   set center_id   = p.center_id,
       center_name = c.name
  from profiles p
  join centers  c on c.id = p.center_id
 where p.id = s.closer_id
   and s.center_id is null
   and s.submitted_by_role = 'validator'
   and s.source = 'live';
