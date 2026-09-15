-- Renames the closer form's payload key "Carrier Name" -> "Proposed Carrier".
--
-- WHY the rename: what a closer types is the carrier they PITCHED. The carrier
-- the policy is actually written on is `submissions.final_carrier_id`, stamped
-- by set_validator_fields during review — and on 80 live leads today the two
-- genuinely differ (proposed "American Amicable", written TransAmerica). One
-- name for both made that distinction unaskable in reporting.
--
-- The closer form's field labels ARE the payload keys, the Google Sheet column
-- headers and (via canonical-fields.ts) the spreadsheet-import target fields —
-- see docs/features/closer-submission-and-forms.md. So this migration exists to
-- bring the 285 rows written before the label change into line with the rows
-- written after it, leaving exactly one key in play rather than two meaning the
-- same thing.
--
-- NOT touched: the validator form's "Agency" key, which already holds a FINAL
-- carrier (a validator only files the form once the carrier has accepted) and
-- which cannot be renamed at all — the Apps Script routes a Google Sheet tab
-- off that exact literal.
--
-- The sheet-sync UPDATE trigger is disabled for the duration. Left enabled,
-- this single statement would fire ~285 net.http_post calls at once into a path
-- that already needs the sheet_sync_attempts retry table and is subject to Apps
-- Script quotas; a partial failure would leave a half-migrated spreadsheet with
-- no way to tell which rows landed. The Google Sheet's own header cell is
-- renamed by hand instead, which preserves the existing column and its history.
-- Only the UPDATE trigger is touched: sheet_sync_on_insert cannot fire here.
--
-- SAFE TO RE-RUN, and worth re-running once the matching front-end is
-- deployed. The `where payload ? 'Carrier Name'` clause makes this idempotent,
-- so any lead a closer submits between this migration and that deploy — still
-- writing the old key from the old bundle — is swept up by running it again.

alter table public.submissions disable trigger sheet_sync_on_closed;

update public.submissions
   set payload = (payload - 'Carrier Name')
               || jsonb_build_object('Proposed Carrier', payload->>'Carrier Name')
 where payload ? 'Carrier Name';

alter table public.submissions enable trigger sheet_sync_on_closed;
