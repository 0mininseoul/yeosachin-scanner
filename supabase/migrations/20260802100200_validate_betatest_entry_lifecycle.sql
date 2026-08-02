-- Validation is deliberately separate from the short ADD COLUMN / NOT VALID
-- phase and the runtime/backfill phase so production writes never inherit the
-- schema migration's ACCESS EXCLUSIVE lock for the duration of a table scan.
DO $migration_transaction_fence$
BEGIN
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    PERFORM pg_catalog.set_config('statement_timeout', '2min', true);
END;
$migration_transaction_fence$;

ALTER TABLE public.analysis_preflights
    VALIDATE CONSTRAINT analysis_preflights_beta_provenance_check;
ALTER TABLE public.analysis_preflights
    VALIDATE CONSTRAINT analysis_preflights_beta_prepare_shape_check;
