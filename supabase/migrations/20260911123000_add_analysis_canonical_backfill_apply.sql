-- Bounded Wave 1 copy support. Legacy analysis tables remain authoritative;
-- this migration only adds a service-role-only, one-row idempotent copy RPC.
-- No source table is changed and no reader or feature flag is activated.

-- Backfill job rows carry their source envelope/hash in the canonical payload so
-- a natural-key conflict can be compared after a concurrent DO NOTHING insert.
-- Existing canonical job rows remain valid because the new provenance fields are
-- optional for non-backfill writers.
ALTER TABLE public.analysis_jobs
    DROP CONSTRAINT IF EXISTS analysis_jobs_payload_check,
    DROP CONSTRAINT IF EXISTS analysis_jobs_check;
ALTER TABLE public.analysis_jobs
    ADD CONSTRAINT analysis_jobs_payload_check CHECK (
        public.analysis_canonical_payload_has_only_keys(payload, ARRAY[
            'schemaVersion', 'successorCount', 'track', 'batch', 'jobKey',
            'generation', 'attemptCount', 'dependencyCount', 'completionHash',
            'requestStatus', 'state', 'counts', 'source', 'sourceHash'
        ]::TEXT[])
    );

-- Events are append-only and do not have a general natural-key constraint.
-- Reserve one payload copy code for the backfill rows so a repeated invocation
-- can discover the already committed row without changing event semantics.
CREATE UNIQUE INDEX analysis_events_backfill_copy_key_idx
    ON public.analysis_events(request_id, content_hash)
    WHERE (payload ->> 'copyCode') = 'ANALYSIS_CANONICAL_BACKFILL_V1';

CREATE OR REPLACE FUNCTION public.apply_analysis_canonical_backfill_row(
    p_acknowledgement TEXT,
    p_family TEXT,
    p_source_table TEXT,
    p_source_key TEXT,
    p_source_hash TEXT,
    p_request_id UUID,
    p_row JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_jobs;
    v_event public.analysis_events;
    v_artifact public.analysis_artifacts;
    v_cost public.analysis_costs;
    v_event_id BIGINT;
    v_kind TEXT;
    v_state TEXT;
    v_payload JSONB;
    v_content_hash TEXT;
    v_artifact_key TEXT;
    v_source_hash TEXT;
    v_idempotency_key TEXT;
BEGIN
    IF p_acknowledgement IS NULL
       OR p_acknowledgement <> 'I_UNDERSTAND_ANALYSIS_CANONICAL_BACKFILL_APPLY_V1'
       OR p_family IS NULL
       OR p_family NOT IN ('jobs', 'events', 'artifacts', 'costs')
       OR p_request_id IS NULL
       OR p_source_table IS NULL
       OR p_source_key IS NULL
       OR p_source_key !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'
       OR p_source_hash IS NULL
       OR p_source_hash !~ '^[a-f0-9]{64}$'
       OR p_row IS NULL
       OR pg_catalog.jsonb_typeof(p_row) <> 'object' THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_INVALID_ROW'
            USING ERRCODE = '22023';
    END IF;

    IF p_family = 'jobs' THEN
        IF p_source_table <> 'analysis_pipeline_jobs'
           OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_row)) <> 13
           OR EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_object_keys(p_row) AS key
                WHERE key <> ALL (ARRAY[
                    'jobKey', 'kind', 'state', 'generation', 'attemptCount',
                    'dependencyCount', 'nextAttemptAt', 'leaseExpiresAt',
                    'completionHash', 'payload', 'retentionClass', 'createdAt',
                    'updatedAt'
                ]::TEXT[])
           ) THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_JOB_MAPPING_BLOCKED'
                USING ERRCODE = '22023';
        END IF;
        IF p_row->>'jobKey' IS NULL
           OR p_row->>'jobKey' !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
           OR p_row->>'kind' IS NULL
           OR p_row->>'kind' NOT IN ('coordinator', 'collection', 'ai', 'finalize', 'recovery')
           OR p_row->>'state' IS NULL
           OR p_row->>'state' NOT IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'blocked')
           OR pg_catalog.jsonb_typeof(p_row->'generation') <> 'number'
           OR p_row->>'generation' !~ '^[0-9]+$'
           OR pg_catalog.jsonb_typeof(p_row->'attemptCount') <> 'number'
           OR p_row->>'attemptCount' !~ '^[0-9]+$'
           OR pg_catalog.jsonb_typeof(p_row->'dependencyCount') <> 'number'
           OR p_row->>'dependencyCount' !~ '^[0-9]+$'
           OR p_row->>'nextAttemptAt' IS NULL
           OR p_row->>'createdAt' IS NULL
           OR p_row->>'updatedAt' IS NULL
           OR pg_catalog.jsonb_typeof(p_row->'payload') <> 'object'
           OR NOT public.analysis_canonical_payload_has_only_keys(
               p_row->'payload',
               ARRAY[
                   'schemaVersion', 'successorCount', 'track', 'batch', 'jobKey',
                   'generation', 'attemptCount', 'dependencyCount', 'completionHash',
                   'requestStatus', 'state', 'counts', 'source', 'sourceHash'
               ]::TEXT[]
           )
           OR p_row->'payload'->>'jobKey' IS DISTINCT FROM p_row->>'jobKey'
           OR p_row->'payload'->>'generation' IS DISTINCT FROM p_row->>'generation'
           OR p_row->'payload'->>'attemptCount' IS DISTINCT FROM p_row->>'attemptCount'
           OR p_row->'payload'->>'dependencyCount' IS DISTINCT FROM p_row->>'dependencyCount'
           OR p_row->'payload'->>'state' IS DISTINCT FROM p_row->>'state'
           OR p_row->'payload'->>'source' IS NULL
           OR p_row->'payload'->>'sourceHash' IS DISTINCT FROM p_source_hash
           OR p_row->'payload'->>'sourceHash' !~ '^[a-f0-9]{64}$'
           OR p_row->>'retentionClass' IS NULL
           OR pg_catalog.char_length(p_row->>'retentionClass') > 64
           OR (
               p_row->'leaseExpiresAt' IS NOT NULL
               AND pg_catalog.jsonb_typeof(p_row->'leaseExpiresAt') NOT IN ('null', 'string')
           )
           OR (
               p_row->'completionHash' IS NOT NULL
               AND pg_catalog.jsonb_typeof(p_row->'completionHash') NOT IN ('null', 'string')
           ) THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_JOB_MAPPING_BLOCKED'
                USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.analysis_jobs(
            request_id, job_key, kind, state, generation, attempt_count,
            dependency_count, next_attempt_at, lease_expires_at, completion_hash,
            payload, retention_class, created_at, updated_at
        ) VALUES (
            p_request_id,
            p_row->>'jobKey',
            p_row->>'kind',
            p_row->>'state',
            (p_row->>'generation')::BIGINT,
            (p_row->>'attemptCount')::INTEGER,
            (p_row->>'dependencyCount')::INTEGER,
            (p_row->>'nextAttemptAt')::TIMESTAMPTZ,
            CASE WHEN p_row->>'leaseExpiresAt' IS NULL THEN NULL
                ELSE (p_row->>'leaseExpiresAt')::TIMESTAMPTZ END,
            CASE WHEN p_row->>'completionHash' IS NULL THEN NULL
                ELSE p_row->>'completionHash' END,
            p_row->'payload',
            p_row->>'retentionClass',
            (p_row->>'createdAt')::TIMESTAMPTZ,
            (p_row->>'updatedAt')::TIMESTAMPTZ
        )
        ON CONFLICT (request_id, job_key, generation) DO NOTHING
        RETURNING * INTO v_job;
        IF NOT FOUND THEN
            SELECT *
              INTO v_job
              FROM public.analysis_jobs
             WHERE request_id = p_request_id
               AND job_key = p_row->>'jobKey'
               AND generation = (p_row->>'generation')::BIGINT
             FOR UPDATE;
            IF NOT FOUND OR (
                v_job.kind IS DISTINCT FROM p_row->>'kind'
                OR v_job.state IS DISTINCT FROM p_row->>'state'
                OR v_job.attempt_count IS DISTINCT FROM (p_row->>'attemptCount')::INTEGER
                OR v_job.dependency_count IS DISTINCT FROM (p_row->>'dependencyCount')::INTEGER
                OR v_job.next_attempt_at IS DISTINCT FROM (p_row->>'nextAttemptAt')::TIMESTAMPTZ
                OR v_job.lease_expires_at IS DISTINCT FROM CASE
                    WHEN p_row->>'leaseExpiresAt' IS NULL THEN NULL
                    ELSE (p_row->>'leaseExpiresAt')::TIMESTAMPTZ
                END
                OR v_job.completion_hash IS DISTINCT FROM CASE
                    WHEN p_row->>'completionHash' IS NULL THEN NULL
                    ELSE p_row->>'completionHash'
                END
                OR v_job.payload->>'source' IS DISTINCT FROM p_row->'payload'->>'source'
                OR v_job.payload->>'sourceHash' IS DISTINCT FROM p_source_hash
                OR v_job.payload IS DISTINCT FROM p_row->'payload'
                OR v_job.retention_class IS DISTINCT FROM p_row->>'retentionClass'
                OR v_job.created_at IS DISTINCT FROM (p_row->>'createdAt')::TIMESTAMPTZ
                OR v_job.updated_at IS DISTINCT FROM (p_row->>'updatedAt')::TIMESTAMPTZ
            ) THEN
                RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_IDEMPOTENCY_CONFLICT'
                    USING ERRCODE = '22023';
            END IF;
        END IF;
        RETURN pg_catalog.jsonb_build_object('status', 'applied', 'family', p_family);
    END IF;

    IF p_family = 'events' THEN
        IF p_source_table NOT IN ('analysis_progress_events', 'analysis_step_events')
           OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_row)) <> 6
           OR EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_object_keys(p_row) AS key
                WHERE key <> ALL (ARRAY[
                    'kind', 'state', 'payload', 'contentHash', 'retentionClass', 'createdAt'
                ]::TEXT[])
           ) THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_EVENT_MAPPING_BLOCKED'
                USING ERRCODE = '22023';
        END IF;
        IF p_row->>'kind' IS NULL
           OR p_row->>'kind' NOT IN ('progress', 'lifecycle', 'operational')
           OR p_row->>'state' IS NULL
           OR pg_catalog.char_length(p_row->>'state') > 128
           OR p_row->>'contentHash' IS DISTINCT FROM p_source_hash
           OR p_row->>'contentHash' !~ '^[a-f0-9]{64}$'
           OR p_row->>'retentionClass' IS NULL
           OR pg_catalog.char_length(p_row->>'retentionClass') > 64
           OR p_row->>'createdAt' IS NULL
           OR pg_catalog.jsonb_typeof(p_row->'payload') <> 'object'
           OR NOT public.analysis_canonical_payload_has_only_keys(
               p_row->'payload',
               ARRAY[
                   'schemaVersion', 'jobKey', 'generation', 'successorCount',
                   'eventCode', 'copyCode', 'aggregateCount', 'tracks', 'artifactKey',
                   'kind', 'state', 'source', 'resultHash', 'targetManifest',
                   'candidate', 'interaction', 'order', 'retention', 'counts', 'evidence'
               ]::TEXT[]
           )
           OR (p_row->'payload'->>'copyCode') IS DISTINCT FROM 'ANALYSIS_CANONICAL_BACKFILL_V1'
           OR p_row->'payload'->>'source' IS NULL
           OR p_row->'payload'->>'state' IS DISTINCT FROM p_row->>'state' THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_EVENT_MAPPING_BLOCKED'
                USING ERRCODE = '22023';
        END IF;
        v_kind := p_row->>'kind';
        v_state := p_row->>'state';
        v_payload := p_row->'payload';
        v_content_hash := p_row->>'contentHash';
        INSERT INTO public.analysis_events(
            request_id, job_id, kind, state, payload, content_hash,
            retention_class, created_at
        ) VALUES (
            p_request_id,
            NULL,
            v_kind,
            v_state,
            v_payload,
            v_content_hash,
            p_row->>'retentionClass',
            (p_row->>'createdAt')::TIMESTAMPTZ
        )
        ON CONFLICT (request_id, content_hash)
            WHERE (payload ->> 'copyCode') = 'ANALYSIS_CANONICAL_BACKFILL_V1'
        DO NOTHING
        RETURNING id INTO v_event_id;
        IF v_event_id IS NULL THEN
            SELECT *
              INTO v_event
              FROM public.analysis_events
             WHERE request_id = p_request_id
               AND content_hash = v_content_hash
               AND (payload ->> 'copyCode') = 'ANALYSIS_CANONICAL_BACKFILL_V1'
             FOR UPDATE;
            IF NOT FOUND
               OR v_event.kind IS DISTINCT FROM v_kind
               OR v_event.state IS DISTINCT FROM v_state
               OR v_event.job_id IS NOT NULL
               OR v_event.payload IS DISTINCT FROM v_payload
               OR v_event.retention_class IS DISTINCT FROM p_row->>'retentionClass'
               OR v_event.created_at IS DISTINCT FROM (p_row->>'createdAt')::TIMESTAMPTZ THEN
                RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_IDEMPOTENCY_CONFLICT'
                    USING ERRCODE = '22023';
            END IF;
        END IF;
        RETURN pg_catalog.jsonb_build_object('status', 'applied', 'family', p_family);
    END IF;

    IF p_family = 'artifacts' THEN
        IF p_source_table NOT IN (
            'analysis_v2_relationship_sides',
            'analysis_v2_relationship_manifests',
            'analysis_v2_target_evidence_manifests',
            'analysis_v2_candidate_feature_manifests',
            'analysis_v2_candidate_score_manifests',
            'analysis_v2_media_artifacts'
        )
           OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_row)) <> 8
           OR EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_object_keys(p_row) AS key
                WHERE key <> ALL (ARRAY[
                    'artifactKey', 'kind', 'state', 'contentHash', 'payload',
                    'retentionClass', 'createdAt', 'updatedAt'
                ]::TEXT[])
           ) THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_ARTIFACT_MAPPING_BLOCKED'
                USING ERRCODE = '22023';
        END IF;
        IF p_row->>'artifactKey' IS NULL
           OR p_row->>'artifactKey' !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$'
           OR pg_catalog.char_length(p_row->>'artifactKey') > 512
           OR p_row->>'kind' IS NULL
           OR p_row->>'kind' NOT IN ('evidence', 'manifest', 'media_ref', 'replay')
           OR p_row->>'state' IS NULL
           OR p_row->>'state' NOT IN ('staged', 'retained', 'expired', 'blocked')
           OR p_row->>'contentHash' IS DISTINCT FROM p_source_hash
           OR p_row->>'contentHash' !~ '^[a-f0-9]{64}$'
           OR p_row->>'retentionClass' IS NULL
           OR pg_catalog.char_length(p_row->>'retentionClass') > 64
           OR p_row->>'createdAt' IS NULL
           OR p_row->>'updatedAt' IS NULL
           OR pg_catalog.jsonb_typeof(p_row->'payload') <> 'object'
           OR NOT public.analysis_canonical_payload_has_only_keys(
               p_row->'payload',
               ARRAY[
                   'schemaVersion', 'jobKey', 'generation', 'successorCount',
                   'eventCode', 'copyCode', 'aggregateCount', 'tracks', 'artifactKey',
                   'kind', 'state', 'source', 'resultHash', 'targetManifest',
                   'candidate', 'interaction', 'order', 'retention', 'counts', 'evidence',
                   'inputHash', 'likerSourceHash', 'commentSourceHash', 'interactorCount',
                   'likerCount', 'commentCount', 'frozenAt'
               ]::TEXT[]
           )
           OR (p_row->'payload'->>'copyCode') IS DISTINCT FROM 'ANALYSIS_CANONICAL_BACKFILL_V1'
           OR p_row->'payload'->>'source' IS NULL
           OR p_row->'payload'->>'artifactKey' IS DISTINCT FROM p_row->>'artifactKey'
           OR p_row->'payload'->>'kind' IS DISTINCT FROM p_row->>'kind'
           OR p_row->'payload'->>'state' IS DISTINCT FROM p_row->>'state' THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_ARTIFACT_MAPPING_BLOCKED'
                USING ERRCODE = '22023';
        END IF;
        v_artifact_key := p_row->>'artifactKey';
        -- The canonical schema permits more than one content hash for an
        -- artifact key. Serialize that natural-key check so two concurrent
        -- source identities cannot both create the same key with different
        -- hashes, then use the insert's DO NOTHING result as the race fence.
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(p_request_id::TEXT || ':' || v_artifact_key, 0)
        );
        INSERT INTO public.analysis_artifacts(
            request_id, job_id, kind, artifact_key, state, content_hash,
            payload, retention_class, created_at, updated_at
        ) VALUES (
            p_request_id,
            NULL,
            p_row->>'kind',
            v_artifact_key,
            p_row->>'state',
            p_source_hash,
            p_row->'payload',
            p_row->>'retentionClass',
            (p_row->>'createdAt')::TIMESTAMPTZ,
            (p_row->>'updatedAt')::TIMESTAMPTZ
        )
        ON CONFLICT (request_id, artifact_key, content_hash) DO NOTHING
        RETURNING * INTO v_artifact;
        IF EXISTS (
            SELECT 1
              FROM public.analysis_artifacts
             WHERE request_id = p_request_id
               AND artifact_key = v_artifact_key
               AND (
                   content_hash IS DISTINCT FROM p_source_hash
                   OR payload->>'source' IS DISTINCT FROM p_row->'payload'->>'source'
               )
        ) THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_IDEMPOTENCY_CONFLICT'
                USING ERRCODE = '22023';
        END IF;
        SELECT *
          INTO v_artifact
          FROM public.analysis_artifacts
         WHERE request_id = p_request_id
           AND artifact_key = v_artifact_key
           AND content_hash = p_source_hash
         FOR UPDATE;
        IF NOT FOUND
           OR v_artifact.payload IS DISTINCT FROM p_row->'payload'
           OR v_artifact.kind IS DISTINCT FROM p_row->>'kind'
           OR v_artifact.state IS DISTINCT FROM p_row->>'state'
           OR v_artifact.retention_class IS DISTINCT FROM p_row->>'retentionClass'
           OR v_artifact.created_at IS DISTINCT FROM (p_row->>'createdAt')::TIMESTAMPTZ
           OR v_artifact.updated_at IS DISTINCT FROM (p_row->>'updatedAt')::TIMESTAMPTZ THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_IDEMPOTENCY_CONFLICT'
                USING ERRCODE = '22023';
        END IF;
        RETURN pg_catalog.jsonb_build_object('status', 'applied', 'family', p_family);
    END IF;

    IF p_family <> 'costs'
       OR p_source_table NOT IN ('analysis_v2_cost_attributions', 'analysis_provider_cost_ledger')
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_row)) <> 12
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_row) AS key
            WHERE key <> ALL (ARRAY[
                'provider', 'operationKey', 'stage', 'currency', 'amountKnown',
                'amountConservative', 'usageUnknown', 'sourceHash', 'idempotencyKey',
                'payload', 'retentionClass', 'recordedAt'
            ]::TEXT[])
       ) THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_COST_MAPPING_BLOCKED'
            USING ERRCODE = '22023';
    END IF;
    IF p_row->>'provider' IS NULL
       OR pg_catalog.char_length(p_row->>'provider') = 0
       OR pg_catalog.char_length(p_row->>'provider') > 128
       OR p_row->>'operationKey' IS NULL
       OR pg_catalog.char_length(p_row->>'operationKey') = 0
       OR pg_catalog.char_length(p_row->>'operationKey') > 512
       OR p_row->>'stage' IS NULL
       OR pg_catalog.char_length(p_row->>'stage') = 0
       OR pg_catalog.char_length(p_row->>'stage') > 128
       OR p_row->>'currency' IS NULL
       OR pg_catalog.char_length(p_row->>'currency') <> 3
       OR p_row->>'sourceHash' IS DISTINCT FROM p_source_hash
       OR p_row->>'sourceHash' !~ '^[a-f0-9]{64}$'
       OR p_row->>'idempotencyKey' IS NULL
       OR pg_catalog.char_length(p_row->>'idempotencyKey') = 0
       OR pg_catalog.char_length(p_row->>'idempotencyKey') > 256
       OR pg_catalog.jsonb_typeof(p_row->'amountKnown') NOT IN ('null', 'number')
       OR pg_catalog.jsonb_typeof(p_row->'amountConservative') NOT IN ('null', 'number')
       OR pg_catalog.jsonb_typeof(p_row->'usageUnknown') <> 'boolean'
       OR pg_catalog.jsonb_typeof(p_row->'payload') <> 'object'
       OR NOT public.analysis_canonical_payload_has_only_keys(
           p_row->'payload',
           ARRAY[
               'schemaVersion', 'runId', 'status', 'maxChargeUsd', 'credentialSlot',
               'usageUnknown', 'amountKnown', 'amountConservative', 'sourceHash',
               'operationKey', 'provider'
           ]::TEXT[]
       )
       OR p_row->'payload'->>'provider' IS DISTINCT FROM p_row->>'provider'
       OR p_row->'payload'->>'operationKey' IS DISTINCT FROM p_row->>'operationKey'
       OR p_row->'payload'->>'sourceHash' IS DISTINCT FROM p_row->>'sourceHash'
       OR p_row->'payload'->>'usageUnknown' IS DISTINCT FROM p_row->>'usageUnknown'
       OR p_row->'payload'->>'amountKnown' IS DISTINCT FROM p_row->>'amountKnown'
       OR p_row->'payload'->>'amountConservative' IS DISTINCT FROM p_row->>'amountConservative' THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_COST_MAPPING_BLOCKED'
            USING ERRCODE = '22023';
    END IF;
    IF p_source_table = 'analysis_provider_cost_ledger'
       AND (
           p_row->'payload'->>'runId' IS NULL
           OR p_row->'payload'->>'status' IS NULL
           OR p_row->'payload'->>'maxChargeUsd' IS NULL
           OR p_row->'payload'->>'credentialSlot' NOT IN ('primary', 'secondary')
       ) THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_COST_MAPPING_BLOCKED'
            USING ERRCODE = '22023';
    END IF;
    IF p_row->'usageUnknown' = 'true'::JSONB
       AND p_row->'amountKnown' IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_row->'amountKnown') <> 'null' THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_COST_MAPPING_BLOCKED'
            USING ERRCODE = '22023';
    END IF;
    v_source_hash := p_row->>'sourceHash';
    v_idempotency_key := p_row->>'idempotencyKey';
    SELECT *
      INTO v_cost
      FROM public.analysis_costs
     WHERE request_id = p_request_id
       AND idempotency_key = v_idempotency_key
     FOR UPDATE;
    IF FOUND THEN
        IF v_cost.source_hash IS DISTINCT FROM v_source_hash
           OR v_cost.provider IS DISTINCT FROM p_row->>'provider'
           OR v_cost.operation_key IS DISTINCT FROM p_row->>'operationKey'
           OR v_cost.stage IS DISTINCT FROM p_row->>'stage'
           OR v_cost.currency IS DISTINCT FROM p_row->>'currency'
           OR v_cost.amount_known IS DISTINCT FROM CASE
               WHEN p_row->>'amountKnown' IS NULL THEN NULL
               ELSE (p_row->>'amountKnown')::NUMERIC
           END
           OR v_cost.amount_conservative IS DISTINCT FROM CASE
               WHEN p_row->>'amountConservative' IS NULL THEN NULL
               ELSE (p_row->>'amountConservative')::NUMERIC
           END
           OR v_cost.usage_unknown IS DISTINCT FROM (p_row->>'usageUnknown')::BOOLEAN
           OR v_cost.payload IS DISTINCT FROM p_row->'payload'
           OR v_cost.retention_class IS DISTINCT FROM p_row->>'retentionClass'
           OR v_cost.recorded_at IS DISTINCT FROM (p_row->>'recordedAt')::TIMESTAMPTZ THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_IDEMPOTENCY_CONFLICT'
                USING ERRCODE = '22023';
        END IF;
        RETURN pg_catalog.jsonb_build_object('status', 'applied', 'family', p_family);
    END IF;
    BEGIN
        INSERT INTO public.analysis_costs(
            request_id, provider, operation_key, stage, currency, amount_known,
            amount_conservative, usage_unknown, source_hash, idempotency_key,
            payload, retention_class, recorded_at
        ) VALUES (
            p_request_id,
            p_row->>'provider',
            p_row->>'operationKey',
            p_row->>'stage',
            p_row->>'currency',
            CASE WHEN p_row->>'amountKnown' IS NULL THEN NULL
                ELSE (p_row->>'amountKnown')::NUMERIC END,
            CASE WHEN p_row->>'amountConservative' IS NULL THEN NULL
                ELSE (p_row->>'amountConservative')::NUMERIC END,
            (p_row->>'usageUnknown')::BOOLEAN,
            v_source_hash,
            v_idempotency_key,
            p_row->'payload',
            p_row->>'retentionClass',
            (p_row->>'recordedAt')::TIMESTAMPTZ
        );
    EXCEPTION WHEN unique_violation THEN
        SELECT *
          INTO v_cost
          FROM public.analysis_costs
         WHERE request_id = p_request_id
           AND idempotency_key = v_idempotency_key
         FOR UPDATE;
        IF NOT FOUND OR v_cost.source_hash IS DISTINCT FROM v_source_hash THEN
            RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_IDEMPOTENCY_CONFLICT'
                USING ERRCODE = '22023';
        END IF;
    END;
    RETURN pg_catalog.jsonb_build_object('status', 'applied', 'family', p_family);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_analysis_canonical_backfill_row(
    TEXT, TEXT, TEXT, TEXT, TEXT, UUID, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_analysis_canonical_backfill_row(
    TEXT, TEXT, TEXT, TEXT, TEXT, UUID, JSONB
) TO service_role;
