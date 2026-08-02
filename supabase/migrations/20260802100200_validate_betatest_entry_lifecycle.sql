-- Validation is deliberately separate from the short ADD COLUMN / NOT VALID
-- phase and the runtime/backfill phase so production writes never inherit the
-- schema migration's ACCESS EXCLUSIVE lock for the duration of a table scan.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_preflights
    VALIDATE CONSTRAINT analysis_preflights_beta_provenance_check;
ALTER TABLE public.analysis_preflights
    VALIDATE CONSTRAINT analysis_preflights_beta_prepare_shape_check;
COMMIT;
