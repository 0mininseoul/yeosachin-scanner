-- Validate betatest entry-channel checks only after the preceding foundation
-- migration commits and releases its ACCESS EXCLUSIVE metadata-change locks.
-- New writes were already protected by the NOT VALID constraints; these scans
-- establish validation for the rows that predated the columns.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Each target remains explicit. These scans use PostgreSQL's lighter SHARE
-- UPDATE EXCLUSIVE validation lock and do not repeat the metadata mutations.
ALTER TABLE public.analysis_preflights
    VALIDATE CONSTRAINT analysis_preflights_entry_channel_check;
ALTER TABLE public.analysis_preflights
    VALIDATE CONSTRAINT analysis_preflights_entry_channel_access_check;
ALTER TABLE public.analysis_requests
    VALIDATE CONSTRAINT analysis_requests_entry_channel_check;
ALTER TABLE public.analysis_requests
    VALIDATE CONSTRAINT analysis_requests_entry_channel_access_check;
COMMIT;
