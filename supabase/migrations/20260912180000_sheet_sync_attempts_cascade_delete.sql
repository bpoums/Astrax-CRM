-- sheet_sync_attempts_submission_id_fkey was created with the default
-- ON DELETE NO ACTION, unlike every other table referencing submissions.id
-- (form_events, payment_details, carrier_declines, cx_lead_status,
-- cx_status_history, payload_edits, submission_tags, card_access_log — all
-- already ON DELETE CASCADE). That inconsistency blocked deleting a
-- submission whenever it had any sync attempts logged, with an unhelpful
-- Postgres FK error surfaced straight to whoever tried it in Supabase
-- Studio. sheet_sync_attempts is pure internal bookkeeping (never read by
-- the client — see docs/database.md), so there is no reason to keep it
-- around once its parent submission is gone; it should cascade like every
-- other child table.

alter table public.sheet_sync_attempts
  drop constraint sheet_sync_attempts_submission_id_fkey,
  add constraint sheet_sync_attempts_submission_id_fkey
    foreign key (submission_id) references public.submissions(id)
    on delete cascade;
