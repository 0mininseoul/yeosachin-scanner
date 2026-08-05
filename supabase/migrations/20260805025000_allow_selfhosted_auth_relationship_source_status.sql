-- The authenticated relationship ledger is a valid collected source. The
-- legacy source-status check predated that provider and only admitted Apify.
ALTER TABLE public.analysis_v2_relationship_sides
    DROP CONSTRAINT IF EXISTS analysis_v2_relationship_sides_source_status_check,
    ADD CONSTRAINT analysis_v2_relationship_sides_source_status_check CHECK (
        (
            source_status = 'not_applicable'
            AND declared_count = 0
            AND collected_count = 0
            AND coverage_bps = 10000
            AND input_hash = analysis_v2_relationship_not_applicable_input_hash(side)
            AND provider IS NULL
            AND provider_run_id IS NULL
            AND provider_operation_key IS NULL
            AND provider_credential_slot IS NULL
        )
        OR (
            source_status = 'collected'
            AND declared_count > 0
            AND provider IN ('apify', 'selfhosted_auth')
            AND provider_run_id IS NOT NULL
            AND provider_operation_key IS NOT NULL
            AND provider_credential_slot IS NOT NULL
        )
    );
