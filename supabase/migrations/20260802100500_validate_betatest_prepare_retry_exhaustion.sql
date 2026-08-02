-- Validate separately from both the short constraint swap and the row-level
-- runtime backfill so PostgreSQL scans only after every row is normalized.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_preflights
    VALIDATE CONSTRAINT analysis_preflights_beta_prepare_shape_check;
COMMIT;
