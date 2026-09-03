-- MIGRATION_PREDECESSOR=20260904000000
-- Supabase CLI applies each migration file in one transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE INDEX IF NOT EXISTS analysis_v2_scheduler_operations_recovery_idx
    ON public.analysis_v2_scheduler_operations (
        recovery_deadline_at,
        request_id,
        operation_key
    )
    WHERE status = 'claimed';
