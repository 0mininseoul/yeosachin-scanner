-- Isolated rollback operation for the Supabase 22 earlybird receipt wave.
--
-- Run only in a disposable, explicitly isolated database after setting:
--
--   SET supabase.retirement_isolated = 'true';
--   \i supabase/operations/20260912_restore_earlybird_receipt_tables.sql
--
-- This operation recreates the historical relations from the canonical
-- maintenance archive.  It never deletes or rewrites maintenance rows.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL timezone = 'UTC';

SELECT pg_catalog.pg_advisory_xact_lock(22091112, 22);

DO $restore_guard$
BEGIN
    IF CURRENT_USER IS DISTINCT FROM 'postgres'
       OR SESSION_USER IS DISTINCT FROM 'postgres' THEN
        RAISE EXCEPTION 'EARLYBIRD_RECEIPT_RESTORE_POSTGRES_REQUIRED';
    END IF;
    IF pg_catalog.current_setting('supabase.retirement_isolated', TRUE)
        IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'EARLYBIRD_RECEIPT_RESTORE_ISOLATED_GUARD';
    END IF;
    IF pg_catalog.to_regclass('public.maintenance_jobs') IS NULL THEN
        RAISE EXCEPTION 'EARLYBIRD_RECEIPT_RESTORE_ARCHIVE_MISSING';
    END IF;
    IF pg_catalog.to_regprocedure(
        'public.prevent_earlybird_schema_failure_recovery_mutation()'
    ) IS NULL THEN
        RAISE EXCEPTION 'EARLYBIRD_RECEIPT_RESTORE_SHARED_GUARD_MISSING';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM (VALUES
            ('earlybird_adoption_policy_failure_rearms'),
            ('earlybird_concierge_snapshot_conflict_recoveries'),
            ('earlybird_pfe_target_evidence_start_rejection_rearms'),
            ('earlybird_pfe3_media_artifact_rearms'),
            ('earlybird_profile_fetch_exhaustion_recoveries'),
            ('earlybird_schema_failure_recoveries'),
            ('earlybird_terminal_unavailable_exhaustion_rearms'),
            ('earlybird_v211_apify_transient_replays'),
            ('earlybird_v211_concierge_replays'),
            ('earlybird_v211_lease_policy_failure_rearms'),
            ('earlybird_v211_policy_identity_replays'),
            ('earlybird_v211_profile_ai_diagnostic_replays'),
            ('earlybird_v211_relationship_lineage_failure_rearms')
        ) AS source_names(source_table)
        WHERE pg_catalog.to_regclass('public.' || source_names.source_table) IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'EARLYBIRD_RECEIPT_RESTORE_TARGET_ALREADY_PRESENT';
    END IF;
END;
$restore_guard$;

LOCK TABLE public.maintenance_jobs IN SHARE MODE;

DO $restore_archive_integrity_guard$
DECLARE
    v_archive_count BIGINT;
BEGIN
    -- The archive lock is acquired before inspecting receipt contents.  All
    -- checks below therefore observe one immutable maintenance snapshot.
    SELECT pg_catalog.count(*) INTO v_archive_count
    FROM public.maintenance_jobs AS job
    WHERE job.payload->>'legacy_source_table' IN (
        'earlybird_adoption_policy_failure_rearms',
        'earlybird_concierge_snapshot_conflict_recoveries',
        'earlybird_pfe_target_evidence_start_rejection_rearms',
        'earlybird_pfe3_media_artifact_rearms',
        'earlybird_profile_fetch_exhaustion_recoveries',
        'earlybird_schema_failure_recoveries',
        'earlybird_terminal_unavailable_exhaustion_rearms',
        'earlybird_v211_apify_transient_replays',
        'earlybird_v211_concierge_replays',
        'earlybird_v211_lease_policy_failure_rearms',
        'earlybird_v211_policy_identity_replays',
        'earlybird_v211_profile_ai_diagnostic_replays',
        'earlybird_v211_relationship_lineage_failure_rearms'
    );
    IF v_archive_count <> 21 THEN
        RAISE EXCEPTION 'EARLYBIRD_RECEIPT_RESTORE_ARCHIVE_COUNT:%', v_archive_count;
    END IF;

    IF EXISTS (
        WITH source_contract(source_table, expected_kind, expected_count, required_fields) AS (
            VALUES
                ('earlybird_adoption_policy_failure_rearms', 'rearm', 2,
                    ARRAY[
                        'order_id', 'original_failed_request_id',
                        'policy_failed_request_id', 'rearmed_preflight_id',
                        'expected_fulfillment_attempt_count',
                        'expected_manual_review_at', 'created_at'
                    ]::TEXT[]),
                ('earlybird_concierge_snapshot_conflict_recoveries', 'recovery', 1,
                    ARRAY[
                        'order_id', 'preflight_id', 'provider_operation_key',
                        'provider_input_hash', 'provider_run_id_hash',
                        'expected_manual_review_at', 'expected_admission_refreshed_at',
                        'old_order_followers_count', 'old_order_following_count',
                        'old_preflight_followers_count', 'old_preflight_following_count',
                        'new_witness_followers_count', 'new_witness_following_count',
                        'old_snapshot_recorded_at', 'new_witness_recorded_at',
                        'recovery_reason', 'followers_absolute_delta',
                        'following_absolute_delta', 'created_at'
                    ]::TEXT[]),
                ('earlybird_pfe_target_evidence_start_rejection_rearms', 'rearm', 1,
                    ARRAY[
                        'order_id', 'pfe_original_failed_request_id',
                        'rejected_successor_request_id', 'rearmed_preflight_id',
                        'prior_attempt_count', 'expected_manual_review_at', 'created_at'
                    ]::TEXT[]),
                ('earlybird_pfe3_media_artifact_rearms', 'rearm', 1,
                    ARRAY[
                        'order_id', 'pfe_original_failed_request_id',
                        'pfe2_rejected_successor_request_id', 'media_failed_request_id',
                        'rearmed_preflight_id', 'prior_attempt_count',
                        'expected_manual_review_at', 'created_at'
                    ]::TEXT[]),
                ('earlybird_profile_fetch_exhaustion_recoveries', 'recovery', 1,
                    ARRAY[
                        'order_id', 'failed_request_id', 'recovery_preflight_id',
                        'prior_attempt_count', 'expected_manual_review_at', 'created_at'
                    ]::TEXT[]),
                ('earlybird_schema_failure_recoveries', 'recovery', 7,
                    ARRAY[
                        'order_id', 'failed_request_id', 'recovery_preflight_id',
                        'prior_attempt_count', 'created_at'
                    ]::TEXT[]),
                ('earlybird_terminal_unavailable_exhaustion_rearms', 'rearm', 1,
                    ARRAY[
                        'order_id', 'failed_request_id', 'rearmed_preflight_id',
                        'expected_fulfillment_attempt_count',
                        'expected_manual_review_at', 'created_at'
                    ]::TEXT[]),
                ('earlybird_v211_apify_transient_replays', 'replay', 1,
                    ARRAY[
                        'order_id', 'original_failed_request_id',
                        'policy_identity_failed_request_id', 'transient_failed_request_id',
                        'failed_preflight_id', 'rearmed_preflight_id',
                        'expected_fulfillment_attempt_count',
                        'expected_manual_review_at', 'created_at'
                    ]::TEXT[]),
                ('earlybird_v211_concierge_replays', 'replay', 2,
                    ARRAY[
                        'order_id', 'original_failed_request_id',
                        'first_relationship_failed_request_id',
                        'second_relationship_failed_request_id', 'failed_preflight_id',
                        'rearmed_preflight_id', 'expected_fulfillment_attempt_count',
                        'expected_manual_review_at', 'created_at',
                        'reviewed_source_request_id', 'reviewed_source_owner_id',
                        'reviewed_source_target_instagram_id',
                        'reviewed_source_result_request_id', 'reviewed_source_target_posts',
                        'reviewed_source_target_evidence', 'reviewed_source_fingerprint',
                        'reviewed_source_registered_at', 'published_source_fingerprint',
                        'published_result_hash', 'published_at'
                    ]::TEXT[]),
                ('earlybird_v211_lease_policy_failure_rearms', 'rearm', 1,
                    ARRAY[
                        'order_id', 'failed_request_id', 'source_preflight_id',
                        'rearmed_preflight_id', 'expected_fulfillment_attempt_count',
                        'expected_manual_review_at', 'created_at'
                    ]::TEXT[]),
                ('earlybird_v211_policy_identity_replays', 'replay', 1,
                    ARRAY[
                        'order_id', 'original_failed_request_id',
                        'policy_identity_failed_request_id', 'failed_preflight_id',
                        'rearmed_preflight_id', 'expected_fulfillment_attempt_count',
                        'expected_manual_review_at', 'created_at'
                    ]::TEXT[]),
                ('earlybird_v211_profile_ai_diagnostic_replays', 'replay', 1,
                    ARRAY[
                        'order_id', 'original_failed_request_id',
                        'profile_ai_failed_request_id', 'failed_preflight_id',
                        'rearmed_preflight_id', 'expected_fulfillment_attempt_count',
                        'expected_manual_review_at', 'created_at'
                    ]::TEXT[]),
                ('earlybird_v211_relationship_lineage_failure_rearms', 'rearm', 1,
                    ARRAY[
                        'order_id', 'original_failed_request_id',
                        'relationship_failed_request_id', 'source_preflight_id',
                        'rearmed_preflight_id', 'expected_fulfillment_attempt_count',
                        'expected_manual_review_at', 'created_at'
                    ]::TEXT[])
        ), source_rows AS (
            SELECT contract.source_table, contract.expected_kind,
                   contract.expected_count, contract.required_fields, job.*
            FROM source_contract AS contract
            LEFT JOIN public.maintenance_jobs AS job
              ON job.payload->>'legacy_source_table' = contract.source_table
        )
        SELECT 1
        FROM source_rows
        GROUP BY source_table, expected_kind, expected_count, required_fields
        HAVING pg_catalog.count(id) <> expected_count
            OR pg_catalog.bool_or(
                id IS NULL
                OR state IS DISTINCT FROM 'succeeded'
                OR legacy_pending_user_id IS NOT NULL
                OR pg_catalog.jsonb_typeof(payload) IS DISTINCT FROM 'object'
                OR NOT (payload ?& ARRAY[
                    'legacy_source_table', 'legacy_primary_key',
                    'legacy_row', 'schema_version'
                ]::TEXT[])
                OR (payload - ARRAY[
                    'legacy_source_table', 'legacy_primary_key',
                    'legacy_row', 'schema_version'
                ]::TEXT[]) <> '{}'::JSONB
                OR pg_catalog.jsonb_typeof(payload->'legacy_source_table') IS DISTINCT FROM 'string'
                OR pg_catalog.jsonb_typeof(payload->'legacy_primary_key') IS DISTINCT FROM 'object'
                OR NOT (payload->'legacy_primary_key' ?& ARRAY['order_id']::TEXT[])
                OR ((payload->'legacy_primary_key') - ARRAY['order_id']::TEXT[]) <> '{}'::JSONB
                OR pg_catalog.jsonb_typeof(payload->'legacy_primary_key'->'order_id') IS DISTINCT FROM 'string'
                OR payload->'legacy_primary_key'->>'order_id' IS NULL
                OR pg_catalog.jsonb_typeof(payload->'legacy_row') IS DISTINCT FROM 'object'
                OR NOT (payload->'legacy_row' ?& required_fields)
                OR ((payload->'legacy_row') - required_fields) <> '{}'::JSONB
                OR pg_catalog.jsonb_typeof(payload->'schema_version') IS DISTINCT FROM 'number'
                OR payload->>'schema_version' IS DISTINCT FROM '1'
                OR kind IS DISTINCT FROM expected_kind
                OR content_hash IS DISTINCT FROM pg_catalog.encode(
                    extensions.digest(convert_to(payload::TEXT, 'UTF8'), 'sha256'), 'hex'
                )
                OR target_key_hash IS DISTINCT FROM pg_catalog.encode(
                    extensions.digest(convert_to(
                        'supabase-22-legacy-earlybird-retirement-v1:'
                        || kind || ':' || (payload->>'legacy_source_table') || ':'
                        || (payload->'legacy_primary_key')::TEXT, 'UTF8'
                    ), 'sha256'), 'hex'
                )
            )
    ) THEN
        RAISE EXCEPTION 'EARLYBIRD_RECEIPT_RESTORE_ARCHIVE_MANIFEST_INVALID';
    END IF;
END;
$restore_archive_integrity_guard$;
CREATE TABLE public.earlybird_adoption_policy_failure_rearms (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    policy_failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL,
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.earlybird_concierge_snapshot_conflict_recoveries (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    preflight_id UUID NOT NULL UNIQUE REFERENCES public.analysis_preflights(id)
        ON DELETE RESTRICT,
    provider_operation_key TEXT NOT NULL CHECK (
        provider_operation_key = 'target-profile-fresh-admission:g3'
    ),
    provider_input_hash VARCHAR(64) NOT NULL CHECK (
        provider_input_hash ~ '^[a-f0-9]{64}$'
    ),
    provider_run_id_hash VARCHAR(32) NOT NULL CHECK (
        provider_run_id_hash ~ '^[a-f0-9]{32}$'
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    expected_admission_refreshed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    old_order_followers_count INTEGER NOT NULL CHECK (old_order_followers_count = 158),
    old_order_following_count INTEGER NOT NULL CHECK (old_order_following_count = 361),
    old_preflight_followers_count INTEGER NOT NULL CHECK (old_preflight_followers_count = 158),
    old_preflight_following_count INTEGER NOT NULL CHECK (old_preflight_following_count = 361),
    new_witness_followers_count INTEGER NOT NULL CHECK (new_witness_followers_count = 158),
    new_witness_following_count INTEGER NOT NULL CHECK (new_witness_following_count = 362),
    old_snapshot_recorded_at TIMESTAMP WITH TIME ZONE NOT NULL,
    new_witness_recorded_at TIMESTAMP WITH TIME ZONE NOT NULL,
    recovery_reason TEXT NOT NULL CHECK (recovery_reason = 'bounded_time_snapshot_drift'),
    followers_absolute_delta INTEGER NOT NULL CHECK (followers_absolute_delta = 0),
    following_absolute_delta INTEGER NOT NULL CHECK (following_absolute_delta = 1),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.earlybird_pfe_target_evidence_start_rejection_rearms (
    order_id UUID CONSTRAINT pfe2_rearms_pkey PRIMARY KEY,
    pfe_original_failed_request_id UUID NOT NULL,
    rejected_successor_request_id UUID NOT NULL,
    rearmed_preflight_id UUID NOT NULL,
    prior_attempt_count SMALLINT NOT NULL,
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT pfe2_rearms_order_fk FOREIGN KEY (order_id)
        REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    CONSTRAINT pfe2_rearms_pfe_failed_req_fk FOREIGN KEY (pfe_original_failed_request_id)
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    CONSTRAINT pfe2_rearms_pfe_failed_req_key UNIQUE (pfe_original_failed_request_id),
    CONSTRAINT pfe2_rearms_rejected_req_fk FOREIGN KEY (rejected_successor_request_id)
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    CONSTRAINT pfe2_rearms_rejected_req_key UNIQUE (rejected_successor_request_id),
    CONSTRAINT pfe2_rearms_preflight_fk FOREIGN KEY (rearmed_preflight_id)
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    CONSTRAINT pfe2_rearms_preflight_key UNIQUE (rearmed_preflight_id),
    CONSTRAINT pfe2_rearms_prior_attempt_chk CHECK (prior_attempt_count BETWEEN 0 AND 10),
    CONSTRAINT pfe2_rearms_distinct_chk
        CHECK (pfe_original_failed_request_id <> rejected_successor_request_id)
);

CREATE TABLE public.earlybird_pfe3_media_artifact_rearms (
    order_id UUID CONSTRAINT pfe3_rearms_pkey PRIMARY KEY,
    pfe_original_failed_request_id UUID NOT NULL,
    pfe2_rejected_successor_request_id UUID NOT NULL,
    media_failed_request_id UUID NOT NULL,
    rearmed_preflight_id UUID NOT NULL,
    prior_attempt_count SMALLINT NOT NULL,
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT pfe3_rearms_order_fk FOREIGN KEY (order_id)
        REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    CONSTRAINT pfe3_rearms_orig_req_fk FOREIGN KEY (pfe_original_failed_request_id)
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    CONSTRAINT pfe3_rearms_orig_req_key UNIQUE (pfe_original_failed_request_id),
    CONSTRAINT pfe3_rearms_b_req_fk FOREIGN KEY (pfe2_rejected_successor_request_id)
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    CONSTRAINT pfe3_rearms_b_req_key UNIQUE (pfe2_rejected_successor_request_id),
    CONSTRAINT pfe3_rearms_media_req_fk FOREIGN KEY (media_failed_request_id)
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    CONSTRAINT pfe3_rearms_media_req_key UNIQUE (media_failed_request_id),
    CONSTRAINT pfe3_rearms_preflight_fk FOREIGN KEY (rearmed_preflight_id)
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    CONSTRAINT pfe3_rearms_preflight_key UNIQUE (rearmed_preflight_id),
    CONSTRAINT pfe3_rearms_prior_attempt_chk CHECK (prior_attempt_count BETWEEN 0 AND 10),
    CONSTRAINT pfe3_rearms_distinct_chk CHECK (
        pfe_original_failed_request_id <> pfe2_rejected_successor_request_id
        AND pfe2_rejected_successor_request_id <> media_failed_request_id
        AND pfe_original_failed_request_id <> media_failed_request_id
    )
);

CREATE TABLE public.earlybird_profile_fetch_exhaustion_recoveries (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    recovery_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    prior_attempt_count SMALLINT NOT NULL CHECK (prior_attempt_count BETWEEN 1 AND 10),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.earlybird_schema_failure_recoveries (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    recovery_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    prior_attempt_count SMALLINT NOT NULL CHECK (prior_attempt_count BETWEEN 0 AND 10),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.earlybird_terminal_unavailable_exhaustion_rearms (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL CHECK (
        expected_fulfillment_attempt_count BETWEEN 0 AND 10
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.earlybird_v211_apify_transient_replays (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    policy_identity_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    transient_failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    failed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL CHECK (
        expected_fulfillment_attempt_count = 1
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.earlybird_v211_concierge_replays (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    first_relationship_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    second_relationship_failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    failed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL CHECK (
        expected_fulfillment_attempt_count = 1
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    reviewed_source_request_id UUID,
    reviewed_source_owner_id UUID,
    reviewed_source_target_instagram_id TEXT,
    reviewed_source_result_request_id UUID,
    reviewed_source_target_posts JSONB,
    reviewed_source_target_evidence JSONB,
    reviewed_source_fingerprint VARCHAR(64),
    reviewed_source_registered_at TIMESTAMP WITH TIME ZONE,
    published_source_fingerprint VARCHAR(64),
    published_result_hash VARCHAR(64),
    published_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE public.earlybird_v211_lease_policy_failure_rearms (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    source_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL CHECK (
        expected_fulfillment_attempt_count BETWEEN 0 AND 10
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.earlybird_v211_policy_identity_replays (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    policy_identity_failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    failed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL CHECK (
        expected_fulfillment_attempt_count = 1
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.earlybird_v211_profile_ai_diagnostic_replays (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    profile_ai_failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    failed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL CHECK (
        expected_fulfillment_attempt_count = 1
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.earlybird_v211_relationship_lineage_failure_rearms (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    relationship_failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    source_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL CHECK (
        expected_fulfillment_attempt_count = 1
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.earlybird_v211_concierge_replays
    ADD CONSTRAINT earlybird_v211_concierge_reviewed_source_shape_check CHECK (
        (
            reviewed_source_fingerprint IS NULL
            AND reviewed_source_request_id IS NULL
            AND reviewed_source_owner_id IS NULL
            AND reviewed_source_target_instagram_id IS NULL
            AND reviewed_source_result_request_id IS NULL
            AND reviewed_source_target_posts IS NULL
            AND reviewed_source_target_evidence IS NULL
            AND reviewed_source_registered_at IS NULL
        )
        OR (
            reviewed_source_fingerprint ~ '^[a-f0-9]{64}$'
            AND reviewed_source_request_id IS NOT NULL
            AND reviewed_source_owner_id IS NOT NULL
            AND reviewed_source_target_instagram_id ~ '^[a-z0-9._]{1,30}$'
            AND reviewed_source_result_request_id IS NOT NULL
            AND pg_catalog.jsonb_typeof(reviewed_source_target_posts) = 'array'
            AND pg_catalog.jsonb_typeof(reviewed_source_target_evidence) = 'array'
            AND reviewed_source_registered_at IS NOT NULL
        )
    ),
    ADD CONSTRAINT earlybird_v211_concierge_publication_marker_check CHECK (
        (
            published_source_fingerprint IS NULL
            AND published_result_hash IS NULL
            AND published_at IS NULL
        )
        OR (
            published_source_fingerprint ~ '^[a-f0-9]{64}$'
            AND published_result_hash ~ '^[a-f0-9]{64}$'
            AND published_at IS NOT NULL
        )
    );

ALTER TABLE public.earlybird_adoption_policy_failure_rearms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_adoption_policy_failure_rearms FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_concierge_snapshot_conflict_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_concierge_snapshot_conflict_recoveries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_pfe_target_evidence_start_rejection_rearms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_pfe_target_evidence_start_rejection_rearms FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_pfe3_media_artifact_rearms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_pfe3_media_artifact_rearms FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_profile_fetch_exhaustion_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_profile_fetch_exhaustion_recoveries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_schema_failure_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_schema_failure_recoveries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_terminal_unavailable_exhaustion_rearms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_terminal_unavailable_exhaustion_rearms FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_apify_transient_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_apify_transient_replays FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_concierge_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_concierge_replays FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_lease_policy_failure_rearms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_lease_policy_failure_rearms FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_policy_identity_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_policy_identity_replays FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_profile_ai_diagnostic_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_profile_ai_diagnostic_replays FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_relationship_lineage_failure_rearms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_relationship_lineage_failure_rearms FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.earlybird_adoption_policy_failure_rearms FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.earlybird_concierge_snapshot_conflict_recoveries FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.earlybird_pfe_target_evidence_start_rejection_rearms FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.earlybird_pfe3_media_artifact_rearms FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.earlybird_profile_fetch_exhaustion_recoveries FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.earlybird_schema_failure_recoveries FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.earlybird_terminal_unavailable_exhaustion_rearms FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.earlybird_v211_apify_transient_replays FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.earlybird_v211_concierge_replays FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.earlybird_v211_lease_policy_failure_rearms FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.earlybird_v211_policy_identity_replays FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.earlybird_v211_profile_ai_diagnostic_replays FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.earlybird_v211_relationship_lineage_failure_rearms FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prevent_earlybird_adoption_policy_failure_rearm_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'EARLYBIRD_ADOPTION_POLICY_FAILURE_REARM_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

GRANT EXECUTE ON FUNCTION public.prevent_earlybird_adoption_policy_failure_rearm_mutation()
    TO PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prevent_earlybird_v211_concierge_replay_mutation_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND (
            (
                OLD.reviewed_source_fingerprint IS NULL
                AND NEW.reviewed_source_fingerprint IS NOT NULL
                AND NEW.reviewed_source_registered_at IS NOT NULL
                AND pg_catalog.current_setting(
                    'app.earlybird_v211_concierge_reviewed_source_register', TRUE
                ) = '1'
                AND OLD.published_source_fingerprint IS NULL
                AND OLD.published_result_hash IS NULL
                AND OLD.published_at IS NULL
            )
            OR (
                OLD.reviewed_source_fingerprint IS NOT NULL
                AND NEW.reviewed_source_fingerprint IS NOT DISTINCT FROM OLD.reviewed_source_fingerprint
                AND OLD.published_source_fingerprint IS NULL
                AND NEW.published_source_fingerprint IS NOT NULL
                AND NEW.published_result_hash IS NOT NULL
                AND NEW.published_at IS NOT NULL
                AND OLD.reviewed_source_request_id IS NOT DISTINCT FROM NEW.reviewed_source_request_id
                AND OLD.reviewed_source_owner_id IS NOT DISTINCT FROM NEW.reviewed_source_owner_id
                AND OLD.reviewed_source_target_instagram_id
                    IS NOT DISTINCT FROM NEW.reviewed_source_target_instagram_id
                AND OLD.reviewed_source_result_request_id
                    IS NOT DISTINCT FROM NEW.reviewed_source_result_request_id
                AND OLD.reviewed_source_target_posts
                    IS NOT DISTINCT FROM NEW.reviewed_source_target_posts
                AND OLD.reviewed_source_target_evidence
                    IS NOT DISTINCT FROM NEW.reviewed_source_target_evidence
                AND OLD.reviewed_source_registered_at
                    IS NOT DISTINCT FROM NEW.reviewed_source_registered_at
                AND pg_catalog.current_setting(
                    'app.earlybird_v211_concierge_publication_marker', TRUE
                ) = '1'
            )
       )
       AND OLD.order_id IS NOT DISTINCT FROM NEW.order_id
       AND OLD.original_failed_request_id IS NOT DISTINCT FROM NEW.original_failed_request_id
       AND OLD.first_relationship_failed_request_id
            IS NOT DISTINCT FROM NEW.first_relationship_failed_request_id
       AND OLD.second_relationship_failed_request_id
            IS NOT DISTINCT FROM NEW.second_relationship_failed_request_id
       AND OLD.failed_preflight_id IS NOT DISTINCT FROM NEW.failed_preflight_id
       AND OLD.rearmed_preflight_id IS NOT DISTINCT FROM NEW.rearmed_preflight_id
       AND OLD.expected_fulfillment_attempt_count
            IS NOT DISTINCT FROM NEW.expected_fulfillment_attempt_count
       AND OLD.expected_manual_review_at
            IS NOT DISTINCT FROM NEW.expected_manual_review_at
       AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
       THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION USING
        MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_earlybird_v211_concierge_replay_mutation_v2()
    FROM PUBLIC, anon, authenticated, service_role;

DO $restore_trigger_function_guard$
DECLARE
    v_bad_signature TEXT;
BEGIN
    SELECT expected.signature
      INTO v_bad_signature
    FROM (VALUES
        ('public.prevent_earlybird_adoption_policy_failure_rearm_mutation()',
            '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
        ('public.prevent_earlybird_schema_failure_recovery_mutation()',
            '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
        ('public.prevent_earlybird_v211_concierge_replay_mutation_v2()',
            '{postgres=X/postgres}')
    ) AS expected(signature, expected_acl)
    LEFT JOIN LATERAL (
        SELECT p.proowner,
               p.prosecdef,
               p.proconfig,
               COALESCE(p.proacl::TEXT, '<default>') AS acl
        FROM pg_catalog.pg_proc AS p
        WHERE p.oid = pg_catalog.to_regprocedure(expected.signature)
    ) AS actual ON TRUE
    WHERE actual.proowner IS NULL
       OR actual.proowner <> 'postgres'::REGROLE
       OR actual.prosecdef IS DISTINCT FROM TRUE
       OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=""']::TEXT[]
       OR actual.acl IS DISTINCT FROM expected.expected_acl
    LIMIT 1;

    IF v_bad_signature IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_RESTORE_TRIGGER_FUNCTION_METADATA:'
                || v_bad_signature,
            ERRCODE = 'P0001';
    END IF;
END;
$restore_trigger_function_guard$;

CREATE TRIGGER prevent_earlybird_adoption_policy_failure_rearm_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_adoption_policy_failure_rearms
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_adoption_policy_failure_rearm_mutation();
CREATE TRIGGER prevent_earlybird_concierge_snapshot_conflict_recovery_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_concierge_snapshot_conflict_recoveries
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();
CREATE TRIGGER prevent_earlybird_pfe_target_evidence_rearm_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_pfe_target_evidence_start_rejection_rearms
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();
CREATE TRIGGER prevent_earlybird_pfe3_media_artifact_rearm_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_pfe3_media_artifact_rearms
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();
CREATE TRIGGER prevent_earlybird_profile_fetch_exhaustion_recovery_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_profile_fetch_exhaustion_recoveries
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();
CREATE TRIGGER prevent_earlybird_schema_failure_recovery_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_schema_failure_recoveries
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();
CREATE TRIGGER prevent_earlybird_terminal_unavailable_exhaustion_rearm_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_terminal_unavailable_exhaustion_rearms
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();
CREATE TRIGGER prevent_earlybird_v211_apify_transient_replay_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v211_apify_transient_replays
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();
CREATE TRIGGER prevent_earlybird_v211_concierge_replay_mutation_v2
BEFORE UPDATE OR DELETE ON public.earlybird_v211_concierge_replays
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_v211_concierge_replay_mutation_v2();
CREATE TRIGGER prevent_earlybird_v211_lease_policy_failure_rearm_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v211_lease_policy_failure_rearms
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();
CREATE TRIGGER prevent_earlybird_v211_policy_identity_replay_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v211_policy_identity_replays
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();
CREATE TRIGGER prevent_earlybird_v211_profile_ai_diagnostic_replay_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v211_profile_ai_diagnostic_replays
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();
CREATE TRIGGER prevent_earlybird_v211_relationship_lineage_rearm_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v211_relationship_lineage_failure_rearms
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

-- Every destination column is explicitly typed.  Missing required fields or
-- malformed scalar values fail before any restored row is committed.
INSERT INTO public.earlybird_adoption_policy_failure_rearms (
    order_id, original_failed_request_id, policy_failed_request_id,
    rearmed_preflight_id, expected_fulfillment_attempt_count,
    expected_manual_review_at, created_at
)
SELECT r.order_id, r.original_failed_request_id, r.policy_failed_request_id,
       r.rearmed_preflight_id, r.expected_fulfillment_attempt_count,
       r.expected_manual_review_at, r.created_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, original_failed_request_id UUID, policy_failed_request_id UUID,
    rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT,
    expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ
)
WHERE job.kind = 'rearm' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_adoption_policy_failure_rearms';

INSERT INTO public.earlybird_concierge_snapshot_conflict_recoveries (
    order_id, preflight_id, provider_operation_key, provider_input_hash,
    provider_run_id_hash, expected_manual_review_at,
    expected_admission_refreshed_at, old_order_followers_count,
    old_order_following_count, old_preflight_followers_count,
    old_preflight_following_count, new_witness_followers_count,
    new_witness_following_count, old_snapshot_recorded_at,
    new_witness_recorded_at, recovery_reason, followers_absolute_delta,
    following_absolute_delta, created_at
)
SELECT r.order_id, r.preflight_id, r.provider_operation_key, r.provider_input_hash,
       r.provider_run_id_hash, r.expected_manual_review_at,
       r.expected_admission_refreshed_at, r.old_order_followers_count,
       r.old_order_following_count, r.old_preflight_followers_count,
       r.old_preflight_following_count, r.new_witness_followers_count,
       r.new_witness_following_count, r.old_snapshot_recorded_at,
       r.new_witness_recorded_at, r.recovery_reason, r.followers_absolute_delta,
       r.following_absolute_delta, r.created_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, preflight_id UUID, provider_operation_key TEXT,
    provider_input_hash VARCHAR(64), provider_run_id_hash VARCHAR(32),
    expected_manual_review_at TIMESTAMPTZ, expected_admission_refreshed_at TIMESTAMPTZ,
    old_order_followers_count INTEGER, old_order_following_count INTEGER,
    old_preflight_followers_count INTEGER, old_preflight_following_count INTEGER,
    new_witness_followers_count INTEGER, new_witness_following_count INTEGER,
    old_snapshot_recorded_at TIMESTAMPTZ, new_witness_recorded_at TIMESTAMPTZ,
    recovery_reason TEXT, followers_absolute_delta INTEGER,
    following_absolute_delta INTEGER, created_at TIMESTAMPTZ
)
WHERE job.kind = 'recovery' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_concierge_snapshot_conflict_recoveries';

INSERT INTO public.earlybird_pfe_target_evidence_start_rejection_rearms (
    order_id, pfe_original_failed_request_id, rejected_successor_request_id,
    rearmed_preflight_id, prior_attempt_count, expected_manual_review_at, created_at
)
SELECT r.order_id, r.pfe_original_failed_request_id, r.rejected_successor_request_id,
       r.rearmed_preflight_id, r.prior_attempt_count, r.expected_manual_review_at,
       r.created_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, pfe_original_failed_request_id UUID,
    rejected_successor_request_id UUID, rearmed_preflight_id UUID,
    prior_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
)
WHERE job.kind = 'rearm' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_pfe_target_evidence_start_rejection_rearms';

INSERT INTO public.earlybird_pfe3_media_artifact_rearms (
    order_id, pfe_original_failed_request_id, pfe2_rejected_successor_request_id,
    media_failed_request_id, rearmed_preflight_id, prior_attempt_count,
    expected_manual_review_at, created_at
)
SELECT r.order_id, r.pfe_original_failed_request_id,
       r.pfe2_rejected_successor_request_id, r.media_failed_request_id,
       r.rearmed_preflight_id, r.prior_attempt_count,
       r.expected_manual_review_at, r.created_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, pfe_original_failed_request_id UUID,
    pfe2_rejected_successor_request_id UUID, media_failed_request_id UUID,
    rearmed_preflight_id UUID, prior_attempt_count SMALLINT,
    expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ
)
WHERE job.kind = 'rearm' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_pfe3_media_artifact_rearms';

INSERT INTO public.earlybird_profile_fetch_exhaustion_recoveries (
    order_id, failed_request_id, recovery_preflight_id, prior_attempt_count,
    expected_manual_review_at, created_at
)
SELECT r.order_id, r.failed_request_id, r.recovery_preflight_id,
       r.prior_attempt_count, r.expected_manual_review_at, r.created_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, failed_request_id UUID, recovery_preflight_id UUID,
    prior_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
)
WHERE job.kind = 'recovery' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_profile_fetch_exhaustion_recoveries';

INSERT INTO public.earlybird_schema_failure_recoveries (
    order_id, failed_request_id, recovery_preflight_id, prior_attempt_count, created_at
)
SELECT r.order_id, r.failed_request_id, r.recovery_preflight_id,
       r.prior_attempt_count, r.created_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, failed_request_id UUID, recovery_preflight_id UUID,
    prior_attempt_count SMALLINT, created_at TIMESTAMPTZ
)
WHERE job.kind = 'recovery' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_schema_failure_recoveries';

INSERT INTO public.earlybird_terminal_unavailable_exhaustion_rearms (
    order_id, failed_request_id, rearmed_preflight_id,
    expected_fulfillment_attempt_count, expected_manual_review_at, created_at
)
SELECT r.order_id, r.failed_request_id, r.rearmed_preflight_id,
       r.expected_fulfillment_attempt_count, r.expected_manual_review_at, r.created_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, failed_request_id UUID, rearmed_preflight_id UUID,
    expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
)
WHERE job.kind = 'rearm' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_terminal_unavailable_exhaustion_rearms';

INSERT INTO public.earlybird_v211_apify_transient_replays (
    order_id, original_failed_request_id, policy_identity_failed_request_id,
    transient_failed_request_id, failed_preflight_id, rearmed_preflight_id,
    expected_fulfillment_attempt_count, expected_manual_review_at, created_at
)
SELECT r.order_id, r.original_failed_request_id, r.policy_identity_failed_request_id,
       r.transient_failed_request_id, r.failed_preflight_id, r.rearmed_preflight_id,
       r.expected_fulfillment_attempt_count, r.expected_manual_review_at, r.created_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, original_failed_request_id UUID,
    policy_identity_failed_request_id UUID, transient_failed_request_id UUID,
    failed_preflight_id UUID, rearmed_preflight_id UUID,
    expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
)
WHERE job.kind = 'replay' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_v211_apify_transient_replays';

INSERT INTO public.earlybird_v211_concierge_replays (
    order_id, original_failed_request_id, first_relationship_failed_request_id,
    second_relationship_failed_request_id, failed_preflight_id, rearmed_preflight_id,
    expected_fulfillment_attempt_count, expected_manual_review_at, created_at,
    reviewed_source_request_id, reviewed_source_owner_id,
    reviewed_source_target_instagram_id, reviewed_source_result_request_id,
    reviewed_source_target_posts, reviewed_source_target_evidence,
    reviewed_source_fingerprint, reviewed_source_registered_at,
    published_source_fingerprint, published_result_hash, published_at
)
SELECT r.order_id, r.original_failed_request_id,
       r.first_relationship_failed_request_id, r.second_relationship_failed_request_id,
       r.failed_preflight_id, r.rearmed_preflight_id,
       r.expected_fulfillment_attempt_count, r.expected_manual_review_at, r.created_at,
       r.reviewed_source_request_id, r.reviewed_source_owner_id,
       r.reviewed_source_target_instagram_id, r.reviewed_source_result_request_id,
       r.reviewed_source_target_posts, r.reviewed_source_target_evidence,
       r.reviewed_source_fingerprint, r.reviewed_source_registered_at,
       r.published_source_fingerprint, r.published_result_hash, r.published_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, original_failed_request_id UUID,
    first_relationship_failed_request_id UUID, second_relationship_failed_request_id UUID,
    failed_preflight_id UUID, rearmed_preflight_id UUID,
    expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ, reviewed_source_request_id UUID, reviewed_source_owner_id UUID,
    reviewed_source_target_instagram_id TEXT, reviewed_source_result_request_id UUID,
    reviewed_source_target_posts JSONB, reviewed_source_target_evidence JSONB,
    reviewed_source_fingerprint VARCHAR(64), reviewed_source_registered_at TIMESTAMPTZ,
    published_source_fingerprint VARCHAR(64), published_result_hash VARCHAR(64),
    published_at TIMESTAMPTZ
)
WHERE job.kind = 'replay' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_v211_concierge_replays';

INSERT INTO public.earlybird_v211_lease_policy_failure_rearms (
    order_id, failed_request_id, source_preflight_id, rearmed_preflight_id,
    expected_fulfillment_attempt_count, expected_manual_review_at, created_at
)
SELECT r.order_id, r.failed_request_id, r.source_preflight_id, r.rearmed_preflight_id,
       r.expected_fulfillment_attempt_count, r.expected_manual_review_at, r.created_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, failed_request_id UUID, source_preflight_id UUID,
    rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT,
    expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ
)
WHERE job.kind = 'rearm' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_v211_lease_policy_failure_rearms';

INSERT INTO public.earlybird_v211_policy_identity_replays (
    order_id, original_failed_request_id, policy_identity_failed_request_id,
    failed_preflight_id, rearmed_preflight_id, expected_fulfillment_attempt_count,
    expected_manual_review_at, created_at
)
SELECT r.order_id, r.original_failed_request_id, r.policy_identity_failed_request_id,
       r.failed_preflight_id, r.rearmed_preflight_id,
       r.expected_fulfillment_attempt_count, r.expected_manual_review_at, r.created_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, original_failed_request_id UUID,
    policy_identity_failed_request_id UUID, failed_preflight_id UUID,
    rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT,
    expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ
)
WHERE job.kind = 'replay' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_v211_policy_identity_replays';

INSERT INTO public.earlybird_v211_profile_ai_diagnostic_replays (
    order_id, original_failed_request_id, profile_ai_failed_request_id,
    failed_preflight_id, rearmed_preflight_id, expected_fulfillment_attempt_count,
    expected_manual_review_at, created_at
)
SELECT r.order_id, r.original_failed_request_id, r.profile_ai_failed_request_id,
       r.failed_preflight_id, r.rearmed_preflight_id,
       r.expected_fulfillment_attempt_count, r.expected_manual_review_at, r.created_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, original_failed_request_id UUID, profile_ai_failed_request_id UUID,
    failed_preflight_id UUID, rearmed_preflight_id UUID,
    expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
)
WHERE job.kind = 'replay' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_v211_profile_ai_diagnostic_replays';

INSERT INTO public.earlybird_v211_relationship_lineage_failure_rearms (
    order_id, original_failed_request_id, relationship_failed_request_id,
    source_preflight_id, rearmed_preflight_id, expected_fulfillment_attempt_count,
    expected_manual_review_at, created_at
)
SELECT r.order_id, r.original_failed_request_id, r.relationship_failed_request_id,
       r.source_preflight_id, r.rearmed_preflight_id,
       r.expected_fulfillment_attempt_count, r.expected_manual_review_at, r.created_at
FROM public.maintenance_jobs AS job
CROSS JOIN LATERAL jsonb_to_record(job.payload->'legacy_row') AS r(
    order_id UUID, original_failed_request_id UUID,
    relationship_failed_request_id UUID, source_preflight_id UUID,
    rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT,
    expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ
)
WHERE job.kind = 'rearm' AND job.state = 'succeeded'
  AND job.payload->>'legacy_source_table' = 'earlybird_v211_relationship_lineage_failure_rearms';

DO $restore_parity$
DECLARE
    v_source_table TEXT;
    v_expected INTEGER;
    v_actual BIGINT;
BEGIN
    FOR v_source_table, v_expected IN
        SELECT * FROM (VALUES
            ('earlybird_adoption_policy_failure_rearms', 2),
            ('earlybird_concierge_snapshot_conflict_recoveries', 1),
            ('earlybird_pfe_target_evidence_start_rejection_rearms', 1),
            ('earlybird_pfe3_media_artifact_rearms', 1),
            ('earlybird_profile_fetch_exhaustion_recoveries', 1),
            ('earlybird_schema_failure_recoveries', 7),
            ('earlybird_terminal_unavailable_exhaustion_rearms', 1),
            ('earlybird_v211_apify_transient_replays', 1),
            ('earlybird_v211_concierge_replays', 2),
            ('earlybird_v211_lease_policy_failure_rearms', 1),
            ('earlybird_v211_policy_identity_replays', 1),
            ('earlybird_v211_profile_ai_diagnostic_replays', 1),
            ('earlybird_v211_relationship_lineage_failure_rearms', 1)
        ) AS expected_rows(source_table, expected_count)
    LOOP
        EXECUTE pg_catalog.format(
            'SELECT count(*) FROM public.%I', v_source_table
        ) INTO v_actual;
        IF v_actual <> v_expected THEN
            RAISE EXCEPTION 'EARLYBIRD_RECEIPT_RESTORE_PARITY:%:%:%',
                v_source_table, v_expected, v_actual;
        END IF;
    END LOOP;
END;
$restore_parity$;

COMMIT;
