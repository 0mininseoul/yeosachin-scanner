-- Schema-only phase. Keep the ACCESS EXCLUSIVE transaction limited to the
-- replacement NOT VALID check; row backfill, function DDL, and validation are
-- committed by later migrations.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_preflights
    DROP CONSTRAINT analysis_preflights_beta_prepare_shape_check,
    ADD CONSTRAINT analysis_preflights_beta_prepare_shape_check CHECK (
        (
            beta_entry_provenance IS NULL
            AND beta_prepare_generation = 0
            AND beta_prepare_token IS NULL
            AND beta_prepare_state IS NULL
            AND beta_prepare_dispatch_state IS NULL
            AND beta_prepare_dispatched_at IS NULL
            AND beta_prepare_lease_token IS NULL
            AND beta_prepare_lease_expires_at IS NULL
            AND beta_prepare_completed_at IS NULL
            AND beta_prepare_retry_exhausted_at IS NULL
        ) OR (
            beta_entry_provenance IS NOT NULL
            AND access_mode = 'production'
            AND beta_prepare_generation BETWEEN 1 AND 100
            AND beta_prepare_token IS NOT NULL
            AND beta_prepare_state IN (
                'reserved', 'preparing', 'prepared', 'capacity_blocked',
                'retry_exhausted', 'expired'
            )
            AND beta_prepare_dispatch_state IN (
                'reserved', 'enqueued', 'completed'
            )
            AND (
                (beta_prepare_state = 'preparing'
                    AND beta_prepare_lease_token IS NOT NULL
                    AND beta_prepare_lease_expires_at IS NOT NULL)
                OR (beta_prepare_state <> 'preparing'
                    AND beta_prepare_lease_token IS NULL
                    AND beta_prepare_lease_expires_at IS NULL)
            )
            AND (
                beta_prepare_state NOT IN (
                    'prepared', 'capacity_blocked', 'retry_exhausted', 'expired'
                )
                OR beta_prepare_dispatch_state = 'completed'
            )
            AND (
                (beta_prepare_state = 'retry_exhausted'
                    AND beta_prepare_retry_exhausted_at IS NOT NULL)
                OR (beta_prepare_state <> 'retry_exhausted'
                    AND beta_prepare_retry_exhausted_at IS NULL)
            )
            AND (
                beta_prepare_state <> 'capacity_blocked'
                OR (
                    analysis_entry_channel = 'betatest'
                    AND status = 'blocked'
                    AND error_code = 'BETA_CAPACITY_UNAVAILABLE'
                )
            )
            AND (
                beta_prepare_state <> 'retry_exhausted'
                OR (
                    analysis_entry_channel = 'betatest'
                    AND status = 'blocked'
                    AND error_code = 'QUEUE_UNAVAILABLE'
                    AND blocked_at IS NOT NULL
                    AND beta_prepare_completed_at IS NOT NULL
                )
            )
            AND (
                beta_prepare_state NOT IN ('reserved', 'preparing')
                OR (
                    (
                        (beta_prepare_state = 'reserved'
                            AND analysis_entry_channel = 'standard')
                        OR (beta_prepare_state = 'preparing'
                            AND analysis_entry_channel IN ('standard', 'betatest'))
                    )
                    AND status = 'pending'
                    AND dispatch_state = 'unreserved'
                    AND dispatch_generation = 0
                )
            )
            AND (
                beta_prepare_state <> 'prepared'
                OR analysis_entry_channel = 'betatest'
            )
            AND (
                beta_prepare_state <> 'expired'
                OR (
                    analysis_entry_channel = 'betatest'
                    AND status = 'expired'
                    AND beta_prepare_retry_exhausted_at IS NULL
                )
            )
        )
    ) NOT VALID;
