-- Short schema phase for dedicated betatest provenance, durable prepare
-- fencing, and the operational database gate. Expensive backfill, runtime
-- functions, and validation are intentionally committed in later migrations
-- so analysis_preflights is not held ACCESS EXCLUSIVE across function DDL.
DO $migration_transaction_fence$
BEGIN
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    PERFORM pg_catalog.set_config('statement_timeout', '2min', true);
END;
$migration_transaction_fence$;

CREATE TABLE public.analysis_beta_runtime_gate (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp()
);
INSERT INTO public.analysis_beta_runtime_gate(singleton, enabled, generation)
VALUES (TRUE, FALSE, 1);
ALTER TABLE public.analysis_beta_runtime_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_beta_runtime_gate FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_beta_runtime_gate
    FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.analysis_beta_runtime_gate IS
    'Sanitized service-owned operational gate. It stores no provider identity, balance, token, or account metadata.';

ALTER TABLE public.analysis_preflights
    ADD COLUMN beta_entry_provenance TEXT,
    ADD COLUMN beta_prepare_generation INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN beta_prepare_token UUID,
    ADD COLUMN beta_prepare_state TEXT,
    ADD COLUMN beta_prepare_dispatch_state TEXT,
    ADD COLUMN beta_prepare_dispatched_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN beta_prepare_lease_token UUID,
    ADD COLUMN beta_prepare_lease_expires_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN beta_prepare_completed_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN beta_prepare_retry_exhausted_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.analysis_preflights
    ADD CONSTRAINT analysis_preflights_beta_provenance_check CHECK (
        beta_entry_provenance IS NULL
        OR beta_entry_provenance IN ('betatest_service_v1', 'legacy_betatest_v1')
    ) NOT VALID,
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
                'reserved', 'preparing', 'prepared', 'capacity_blocked', 'expired'
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
                    'prepared', 'capacity_blocked', 'expired'
                )
                OR beta_prepare_dispatch_state = 'completed'
            )
            AND (
                beta_prepare_retry_exhausted_at IS NULL
                OR (
                    beta_prepare_state = 'reserved'
                    AND beta_prepare_dispatch_state = 'completed'
                )
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

COMMENT ON COLUMN public.analysis_preflights.beta_entry_provenance IS
    'Service-only durable betatest origin; never accepted from request body, header, query, or referrer.';
COMMENT ON COLUMN public.analysis_preflights.beta_prepare_token IS
    'Opaque persisted task fence. It is unrelated to any provider token.';
