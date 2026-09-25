-- "Approved Success" / "Denied Failure" were seeded in cx_tags_and_customer_pipeline
-- (20260821184015) when the CX tagging system was first built, before any UI
-- existed to apply them. Verified live: 0 leads tagged with either, no code
-- reference anywhere in the app, and neither carries allows_duplicate_ssn.
-- Deactivating rather than deleting -- cx_tags rows are FK-referenced by
-- submission_tags, so there is no delete control anywhere in this app for
-- vocabulary tables, only active toggling (see docs/features/cx-lifecycle.md).

update cx_tags
set active = false
where label in ('Approved Success', 'Denied Failure');
