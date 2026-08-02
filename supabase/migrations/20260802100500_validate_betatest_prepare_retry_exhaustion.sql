-- Validate separately from both the short constraint swap and the row-level
-- runtime backfill so PostgreSQL scans only after every row is normalized.
DO $migration_transaction_fence$
BEGIN
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    PERFORM pg_catalog.set_config('statement_timeout', '2min', true);
END;
$migration_transaction_fence$;

ALTER TABLE public.analysis_preflights
    VALIDATE CONSTRAINT analysis_preflights_beta_prepare_shape_check;
