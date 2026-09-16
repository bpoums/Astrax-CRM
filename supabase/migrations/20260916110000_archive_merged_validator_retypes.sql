-- Archives the validator "re-typed" duplicates whose contents were merged onto
-- the closer's row by 20260916100000_merge_legacy_validator_retypes.
--
-- Archived rather than deleted, deliberately: `archived_at` takes a row out of
-- every queue and out of reporting, but leaves it readable behind the admin
-- panel's "Show archived" toggle and restorable via `unarchive_submission`.
-- Deleting is available afterwards and is the owner's call; this step is the
-- reversible half.
--
-- SCOPE: exactly the 74 rows the merge actually consumed - the EARLIEST
-- validator submission per customer. Two customers have a SECOND validator
-- submission that this deliberately leaves untouched, because they are not
-- duplicates of anything:
--
--   Elizabeth Holmander  Insta Brain 0101885537 $78.72  (merged)
--                        Corbridge   6260250369 $89.93  (LEFT ACTIVE)
--   Tommy L Davis        Corbridge   7260260391         (merged)
--                        Insta Brain AMH6348530 $50.82  (LEFT ACTIVE)
--
-- Different carriers, different policy numbers, different premiums - two
-- genuine second policies. Archiving them would erase real sales, and the
-- merge never read them, so their data exists nowhere else.
--
-- Mirrors archive_submission() exactly rather than just stamping archived_at:
-- same cleared assignment fields, same form_events entry, so these rows look
-- to every screen like any other archived lead. `archived_by` and the event's
-- `actor_id` are null because no person performed this - the reason string on
-- the event is the honest audit trail, and attributing it to an admin who did
-- not click anything would be worse than leaving it blank.
--
-- The sheet-sync UPDATE trigger is disabled for the duration: archiving changes
-- `archived_at`, which the trigger treats as sync-worthy, and 74 simultaneous
-- net.http_post calls would overrun the Apps Script 30-second lock. The Google
-- Sheet therefore still shows these rows as live and must be reconciled
-- separately - the sync has no delete path, so a row that leaves the database
-- never leaves the spreadsheet on its own.

alter table public.submissions disable trigger sheet_sync_on_closed;

with s as (
  select id, ssn_normalized, created_at,
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
targets as (
  select distinct on (ssn_normalized) id
  from s join paired using (ssn_normalized)
  where role = 'validator'
  order by ssn_normalized, created_at
),
archived as (
  update public.submissions s
     set archived_at = now(),
         archived_by = null,
         assigned_to = null,
         assigned_at = null,
         claimed_at  = null
    from targets t
   where s.id = t.id and s.archived_at is null
  returning s.id
)
insert into public.form_events (submission_id, actor_id, event_type, detail)
select a.id, null, 'archived',
       jsonb_build_object(
         'reason',
         'Legacy duplicate: this lead was re-typed by a validator before '
         || 'final carrier / agent name / policy number existed on the closer '
         || 'form. Its contents were merged onto the closer''s original row by '
         || 'migration 20260916100000; archived to remove the double count.'
       )
from archived a;

alter table public.submissions enable trigger sheet_sync_on_closed;
