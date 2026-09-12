-- Deterministic recovery artifact for the post-deploy W1A contraction.
-- This file is recovery code and must be reviewed and run only against an
-- isolated target after an explicit restore decision. It is never included
-- by the forward migration and was not executed while preparing this change.
-- Table/function bodies are copied from immutable migrations. The live catalog
-- correction includes analysis_cache_state_check; fulfillment_jobs_check5 is
-- absent; CHAR identities use PostgreSQL canonical type name character.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';

-- RESTORE_OBJECTS_BEGIN
 -- Immutable source: 20260909095740_add_analysis_canonical_tables.sql.
 CREATE TABLE public.analysis_artifacts (
     id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
     request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
     job_id UUID REFERENCES public.analysis_jobs(id) ON DELETE RESTRICT,
     kind TEXT NOT NULL CHECK (kind IN ('evidence', 'manifest', 'media_ref', 'replay')),
     artifact_key TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('staged', 'retained', 'expired', 'blocked')),
     content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
     payload JSONB NOT NULL DEFAULT '{"schemaVersion":1}'::JSONB,
     retention_class TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     UNIQUE (request_id, artifact_key, content_hash),
     CHECK (public.analysis_canonical_payload_has_only_keys(payload, ARRAY[
         'schemaVersion', 'jobKey', 'generation', 'successorCount', 'eventCode', 'copyCode',
         'aggregateCount', 'tracks', 'artifactKey', 'kind', 'state', 'source', 'resultHash',
         'targetManifest', 'candidate', 'interaction', 'order', 'retention', 'counts', 'evidence',
         'inputHash', 'likerSourceHash', 'commentSourceHash', 'interactorCount',
         'likerCount', 'commentCount', 'frozenAt'
     ]::TEXT[]))
 );

 CREATE TABLE public.analysis_costs (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
     provider TEXT NOT NULL,
     operation_key TEXT NOT NULL,
     stage TEXT NOT NULL,
     currency CHAR(3) NOT NULL DEFAULT 'USD',
     amount_known NUMERIC(18,12),
     amount_conservative NUMERIC(18,12),
     usage_unknown BOOLEAN NOT NULL,
     source_hash TEXT NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
     -- A provider/source observation can be retried after a lost response.  The
     -- key is durable so reconciliation does not allocate another cost row.
     idempotency_key TEXT,
     payload JSONB NOT NULL DEFAULT '{"schemaVersion":1}'::JSONB,
     retention_class TEXT NOT NULL DEFAULT 'permanent',
     recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     CHECK (amount_known IS NULL OR amount_known >= 0),
     CHECK (amount_conservative IS NULL OR amount_conservative >= 0),
     CHECK (NOT usage_unknown OR amount_known IS NULL),
     CHECK (amount_conservative IS NULL OR amount_known IS NULL OR amount_conservative >= amount_known),
     CHECK (public.analysis_canonical_payload_has_only_keys(payload, ARRAY[
         'schemaVersion', 'runId', 'status', 'maxChargeUsd', 'credentialSlot', 'usageUnknown',
         'amountKnown', 'amountConservative', 'sourceHash', 'operationKey', 'provider'
     ]::TEXT[]))
 );

 CREATE TABLE public.analysis_cache (
     id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
     request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
     scope TEXT NOT NULL CHECK (scope IN ('ai', 'profile', 'anonymous', 'blite')),
     cache_key_hash TEXT NOT NULL CHECK (cache_key_hash ~ '^[a-f0-9]{64}$'),
     state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed', 'expired')),
     expires_at TIMESTAMPTZ NOT NULL,
     single_flight_token_hash TEXT CHECK (
         single_flight_token_hash IS NULL OR single_flight_token_hash ~ '^[a-f0-9]{64}$'
     ),
     payload JSONB NOT NULL DEFAULT '{"schemaVersion":1}'::JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     UNIQUE (request_id, scope, cache_key_hash),
     CHECK (public.analysis_canonical_payload_has_only_keys(payload, ARRAY[
         'schemaVersion', 'requestId', 'scope', 'cacheKeyHash', 'state', 'expiresAt',
         'singleFlightTokenHash'
     ]::TEXT[]))
 );

 CREATE TABLE public.analysis_audit_bundles (
     id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
     request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
     version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 100000),
     kind TEXT NOT NULL CHECK (kind IN ('bundle', 'candidate', 'interaction')),
     candidate_key TEXT,
     ordinal INTEGER,
     state TEXT NOT NULL CHECK (state IN ('complete', 'partial', 'inconsistent', 'failed')),
     content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
     -- Late cost audit rows carry the same durable key as their cost row.  It is
     -- nullable for ordinary audit rows, which keeps the family append-only.
     idempotency_key TEXT,
     retention_class TEXT NOT NULL DEFAULT 'permanent',
     payload JSONB NOT NULL DEFAULT '{"schemaVersion":1}'::JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     UNIQUE (request_id, version, kind, content_hash),
     CHECK (public.analysis_canonical_payload_has_only_keys(payload, ARRAY[
         'schemaVersion', 'finalized', 'requestStatus', 'resultStatus', 'projection', 'lateCost',
         'provider', 'operationKey', 'cost', 'retention', 'unknownSource', 'candidate',
         'interaction', 'order', 'state'
     ]::TEXT[]))
 );

 -- Immutable source: 20260909095932_add_commerce_operation_canonical_tables.sql.
 CREATE TABLE public.fulfillment_jobs (
     id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
     order_id UUID NOT NULL UNIQUE REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
     request_id UUID UNIQUE REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
     state TEXT NOT NULL CHECK (state IN (
         'awaiting_operator', 'admission_pending', 'analysis_in_progress',
         'completed', 'retryable_failure', 'manual_review'
     )),
     attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
     lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
     lease_token UUID,
     lease_expires_at TIMESTAMPTZ,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     last_error_code TEXT,
     operator_admitted_at TIMESTAMPTZ,
     last_error_at TIMESTAMPTZ,
     completed_at TIMESTAMPTZ,
     manual_review_at TIMESTAMPTZ,
     payload JSONB NOT NULL DEFAULT '{}'::JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     CHECK (pg_catalog.jsonb_typeof(payload) = 'object'),
     CHECK (
         (lease_token IS NULL AND lease_expires_at IS NULL)
         OR (
             lease_token IS NOT NULL
             AND lease_expires_at IS NOT NULL
             AND state IN ('admission_pending', 'retryable_failure')
         )
     ),
     CHECK (
         (state = 'awaiting_operator' AND operator_admitted_at IS NULL AND request_id IS NULL)
         OR (state <> 'awaiting_operator' AND operator_admitted_at IS NOT NULL)
     ),
     CHECK (
         (state IN ('analysis_in_progress', 'completed') AND request_id IS NOT NULL)
         OR state NOT IN ('analysis_in_progress', 'completed')
     ),
     CHECK (
         (state = 'completed' AND completed_at IS NOT NULL)
         OR (state <> 'completed' AND completed_at IS NULL)
     ),
     CHECK (
         (state = 'manual_review' AND manual_review_at IS NOT NULL)
         OR (state <> 'manual_review' AND manual_review_at IS NULL)
     )
 );

 CREATE TABLE public.notification_outbox (
     id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
     channel TEXT NOT NULL CHECK (channel IN ('discord', 'kakao', 'sentry')),
     event_kind TEXT NOT NULL,
     dedupe_key TEXT NOT NULL UNIQUE,
     state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'sent', 'retryable', 'dead')),
     attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
     lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
     lease_token UUID,
     lease_holder_hash TEXT CHECK (lease_holder_hash IS NULL OR lease_holder_hash ~ '^[a-f0-9]{64}$'),
     lease_expires_at TIMESTAMPTZ,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     delivered_at TIMESTAMPTZ,
     terminal_at TIMESTAMPTZ,
     last_error_code TEXT,
     payload JSONB NOT NULL DEFAULT '{}'::JSONB,
     content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
     created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
 );

 CREATE TABLE public.system_configuration (
     config_key TEXT NOT NULL,
     version INTEGER NOT NULL CHECK (version > 0),
     state TEXT NOT NULL CHECK (state IN ('draft', 'effective', 'retired')),
     config JSONB NOT NULL,
     content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
     effective_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     PRIMARY KEY (config_key, version),
     CHECK (pg_catalog.jsonb_typeof(config) = 'object')
 );

 CREATE TABLE public.system_leases (
     lease_key TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('provider', 'capacity', 'maintenance', 'notification')),
     generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
     state TEXT NOT NULL CHECK (state IN ('available', 'held', 'expired', 'fenced')),
     holder_hash TEXT CHECK (holder_hash IS NULL OR holder_hash ~ '^[a-f0-9]{64}$'),
     lease_expires_at TIMESTAMPTZ,
     heartbeat_at TIMESTAMPTZ,
     fence_token BIGINT NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
     payload JSONB NOT NULL DEFAULT '{}'::JSONB,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
     CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
 );

 CREATE INDEX analysis_artifacts_request_kind_idx
     ON public.analysis_artifacts(request_id, kind, created_at);

 CREATE INDEX analysis_costs_request_recorded_idx
     ON public.analysis_costs(request_id, recorded_at);

 CREATE UNIQUE INDEX analysis_costs_request_idempotency_idx
     ON public.analysis_costs(request_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL;

 CREATE INDEX analysis_cache_expiry_idx
     ON public.analysis_cache(expires_at, state);

 CREATE INDEX analysis_cache_request_updated_idx
     ON public.analysis_cache(request_id, updated_at, id);

 CREATE INDEX analysis_audit_request_version_idx
     ON public.analysis_audit_bundles(request_id, version, kind);

 CREATE UNIQUE INDEX analysis_audit_request_idempotency_idx
     ON public.analysis_audit_bundles(request_id, kind, idempotency_key)
     WHERE idempotency_key IS NOT NULL;

 CREATE INDEX fulfillment_jobs_recovery_idx
     ON public.fulfillment_jobs(state, next_attempt_at, created_at)
     WHERE state IN ('admission_pending', 'retryable_failure', 'analysis_in_progress');

 CREATE INDEX notification_outbox_delivery_idx
     ON public.notification_outbox(state, next_attempt_at, created_at)
     WHERE state IN ('queued', 'retryable');

 CREATE INDEX system_configuration_effective_idx
     ON public.system_configuration(config_key, effective_at DESC, version DESC)
     WHERE state = 'effective';

 CREATE INDEX system_leases_expiry_idx
     ON public.system_leases(kind, state, lease_expires_at);

 ALTER TABLE public.analysis_artifacts ENABLE ROW LEVEL SECURITY;

 ALTER TABLE public.analysis_artifacts FORCE ROW LEVEL SECURITY;

 ALTER TABLE public.analysis_costs ENABLE ROW LEVEL SECURITY;

 ALTER TABLE public.analysis_costs FORCE ROW LEVEL SECURITY;

 ALTER TABLE public.analysis_cache ENABLE ROW LEVEL SECURITY;

 ALTER TABLE public.analysis_cache FORCE ROW LEVEL SECURITY;

 ALTER TABLE public.analysis_audit_bundles ENABLE ROW LEVEL SECURITY;

 ALTER TABLE public.analysis_audit_bundles FORCE ROW LEVEL SECURITY;

 ALTER TABLE public.fulfillment_jobs ENABLE ROW LEVEL SECURITY;

 ALTER TABLE public.fulfillment_jobs FORCE ROW LEVEL SECURITY;

 ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;

 ALTER TABLE public.notification_outbox FORCE ROW LEVEL SECURITY;

 ALTER TABLE public.system_configuration ENABLE ROW LEVEL SECURITY;

 ALTER TABLE public.system_configuration FORCE ROW LEVEL SECURITY;

 ALTER TABLE public.system_leases ENABLE ROW LEVEL SECURITY;

 ALTER TABLE public.system_leases FORCE ROW LEVEL SECURITY;

 REVOKE ALL ON TABLE public.analysis_artifacts FROM PUBLIC, anon, authenticated, service_role;

 REVOKE ALL ON TABLE public.analysis_costs FROM PUBLIC, anon, authenticated, service_role;

 REVOKE ALL ON TABLE public.analysis_cache FROM PUBLIC, anon, authenticated, service_role;

 REVOKE ALL ON TABLE public.analysis_audit_bundles FROM PUBLIC, anon, authenticated, service_role;

 REVOKE ALL ON TABLE public.fulfillment_jobs FROM PUBLIC, anon, authenticated, service_role;

 REVOKE ALL ON TABLE public.notification_outbox FROM PUBLIC, anon, authenticated, service_role;

 REVOKE ALL ON TABLE public.system_configuration FROM PUBLIC, anon, authenticated, service_role;

 REVOKE ALL ON TABLE public.system_leases FROM PUBLIC, anon, authenticated, service_role;

 -- Immutable source: 20260911100000_grant_wave1_backfill_projection_select.sql.
 -- Preserve the exact live column ACLs observed for the two projection tables.
 GRANT SELECT (
     id, request_id, job_id, kind, artifact_key, state, content_hash,
     payload, retention_class, created_at, updated_at
 ) ON TABLE public.analysis_artifacts TO service_role;
 GRANT SELECT (
     id, request_id, provider, operation_key, stage, currency, amount_known,
     amount_conservative, usage_unknown, source_hash, idempotency_key, payload,
     retention_class, recorded_at
 ) ON TABLE public.analysis_costs TO service_role;

-- RESTORE_OBJECTS_NEXT
 -- Immutable source routine definitions follow. append artifact is the latest exact definition from 20260911123000_add_analysis_canonical_backfill_apply.sql.
 CREATE OR REPLACE FUNCTION public.append_analysis_canonical_artifact(
     p_request_id UUID,
     p_job_id UUID,
     p_kind TEXT,
     p_artifact_key TEXT,
     p_state TEXT,
     p_content_hash TEXT,
     p_payload JSONB,
     p_retention_class TEXT
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 DECLARE
     v_row public.analysis_artifacts;
 BEGIN
     IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
         RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_PAYLOAD' USING ERRCODE = '22023';
     END IF;
     PERFORM pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(p_request_id::TEXT || ':' || p_artifact_key, 0)
     );
     IF EXISTS (
         SELECT 1
           FROM public.analysis_artifacts
          WHERE request_id = p_request_id
            AND artifact_key = p_artifact_key
            AND (
                content_hash IS DISTINCT FROM p_content_hash
                OR payload->>'source' IS DISTINCT FROM p_payload->>'source'
            )
     ) THEN
         RAISE EXCEPTION 'ANALYSIS_CANONICAL_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
     END IF;
     INSERT INTO public.analysis_artifacts(
         request_id, job_id, kind, artifact_key, state, content_hash,
         payload, retention_class
     ) VALUES (
         p_request_id, p_job_id, p_kind, p_artifact_key, p_state, p_content_hash,
         p_payload, p_retention_class
     )
     ON CONFLICT (request_id, artifact_key, content_hash) DO UPDATE SET
         state = EXCLUDED.state,
         payload = EXCLUDED.payload,
         retention_class = EXCLUDED.retention_class,
         updated_at = pg_catalog.clock_timestamp()
     RETURNING * INTO v_row;
     RETURN pg_catalog.to_jsonb(v_row);
 END;
 $$;

 -- Immutable source: 20260911123000_add_analysis_canonical_backfill_apply.sql (exact backfill routine).
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
                 OR v_job.lease_expires_at IS DISTINCT FROM (CASE
                     WHEN p_row->>'leaseExpiresAt' IS NULL THEN NULL
                     ELSE (p_row->>'leaseExpiresAt')::TIMESTAMPTZ
                 END)
                 OR v_job.completion_hash IS DISTINCT FROM (CASE
                     WHEN p_row->>'completionHash' IS NULL THEN NULL
                     ELSE p_row->>'completionHash'
                 END)
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
        -- NUMERIC(18,12) money crosses the RPC as a canonical decimal string;
        -- JSON numbers are rejected because their JavaScript representation may
        -- already have rounded away significant fractional digits.
        OR (
            p_row->>'amountKnown' IS NOT NULL
            AND (
                pg_catalog.jsonb_typeof(p_row->'amountKnown') <> 'string'
                OR p_row->>'amountKnown' !~ '^(0|[1-9][0-9]{0,5})([.][0-9]{1,12})?$'
            )
        )
        OR (
            p_row->>'amountConservative' IS NOT NULL
            AND (
                pg_catalog.jsonb_typeof(p_row->'amountConservative') <> 'string'
                OR p_row->>'amountConservative' !~ '^(0|[1-9][0-9]{0,5})([.][0-9]{1,12})?$'
            )
        )
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
            OR v_cost.amount_known IS DISTINCT FROM (CASE
                WHEN p_row->>'amountKnown' IS NULL THEN NULL
                ELSE (p_row->>'amountKnown')::NUMERIC
            END)
            OR v_cost.amount_conservative IS DISTINCT FROM (CASE
                WHEN p_row->>'amountConservative' IS NULL THEN NULL
                ELSE (p_row->>'amountConservative')::NUMERIC
            END)
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
         IF NOT FOUND
            OR v_cost.source_hash IS DISTINCT FROM v_source_hash
            OR v_cost.provider IS DISTINCT FROM p_row->>'provider'
            OR v_cost.operation_key IS DISTINCT FROM p_row->>'operationKey'
            OR v_cost.stage IS DISTINCT FROM p_row->>'stage'
            OR v_cost.currency IS DISTINCT FROM p_row->>'currency'
            OR v_cost.amount_known IS DISTINCT FROM (CASE
                WHEN p_row->>'amountKnown' IS NULL THEN NULL
                ELSE (p_row->>'amountKnown')::NUMERIC
            END)
            OR v_cost.amount_conservative IS DISTINCT FROM (CASE
                WHEN p_row->>'amountConservative' IS NULL THEN NULL
                ELSE (p_row->>'amountConservative')::NUMERIC
            END)
            OR v_cost.usage_unknown IS DISTINCT FROM (p_row->>'usageUnknown')::BOOLEAN
            OR v_cost.payload IS DISTINCT FROM p_row->'payload'
            OR v_cost.retention_class IS DISTINCT FROM p_row->>'retentionClass'
            OR v_cost.recorded_at IS DISTINCT FROM (p_row->>'recordedAt')::TIMESTAMPTZ THEN
             RAISE EXCEPTION 'ANALYSIS_CANONICAL_BACKFILL_IDEMPOTENCY_CONFLICT'
                 USING ERRCODE = '22023';
         END IF;
     END;
     RETURN pg_catalog.jsonb_build_object('status', 'applied', 'family', p_family);
 END;
 $$;
 CREATE OR REPLACE FUNCTION public.append_analysis_canonical_audit(
     p_request_id UUID,
     p_version INTEGER,
     p_kind TEXT,
     p_candidate_key TEXT,
     p_ordinal INTEGER,
     p_state TEXT,
     p_content_hash TEXT,
     p_retention_class TEXT DEFAULT 'permanent',
     p_payload JSONB DEFAULT '{"schemaVersion":1}'::JSONB,
     p_idempotency_key TEXT DEFAULT NULL
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 DECLARE
     v_row public.analysis_audit_bundles;
 BEGIN
     IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
         RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_PAYLOAD' USING ERRCODE = '22023';
     END IF;
     -- Serialize every audit writer on the request aggregate. A version is a
     -- bundle-level fence, so a max(version)+1 read must share the same lock as
     -- an ordinary append to prevent a late-cost writer from racing it.
     PERFORM 1
     FROM public.analysis_requests
     WHERE id = p_request_id
     FOR UPDATE;
     INSERT INTO public.analysis_audit_bundles(
         request_id, version, kind, candidate_key, ordinal, state,
         content_hash, idempotency_key, retention_class, payload
     ) VALUES (
         p_request_id, p_version, p_kind, p_candidate_key, p_ordinal, p_state,
         p_content_hash, p_idempotency_key, p_retention_class, p_payload
     ) RETURNING * INTO v_row;
     RETURN pg_catalog.to_jsonb(v_row);
 END;
 $$;

 CREATE OR REPLACE FUNCTION public.append_analysis_canonical_late_cost_audit(
     p_request_id UUID,
     p_provider TEXT,
     p_operation_key TEXT,
     p_stage TEXT,
     p_currency CHAR(3),
     p_amount_known NUMERIC,
     p_amount_conservative NUMERIC,
     p_usage_unknown BOOLEAN,
     p_source_hash TEXT,
     p_idempotency_key TEXT,
     p_cost_payload JSONB,
     p_cost_retention_class TEXT,
     p_audit_content_hash TEXT,
     p_audit_payload JSONB,
     p_audit_retention_class TEXT
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 DECLARE
     v_version INTEGER;
     v_cost public.analysis_costs;
     v_audit public.analysis_audit_bundles;
     v_existing_cost public.analysis_costs;
     v_existing_audit public.analysis_audit_bundles;
 BEGIN
     IF p_cost_payload IS NULL OR pg_catalog.jsonb_typeof(p_cost_payload) <> 'object'
        OR p_audit_payload IS NULL OR pg_catalog.jsonb_typeof(p_audit_payload) <> 'object' THEN
         RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_PAYLOAD' USING ERRCODE = '22023';
     END IF;
     IF p_idempotency_key IS NULL OR pg_catalog.char_length(p_idempotency_key) < 1
        OR pg_catalog.char_length(p_idempotency_key) > 256 THEN
         RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_IDEMPOTENCY_KEY' USING ERRCODE = '22023';
     END IF;
     -- The parent aggregate row exists for every canonical cost/audit row and
     -- provides a stable lock even when this request has no audit rows yet.
     PERFORM 1
     FROM public.analysis_requests
     WHERE id = p_request_id
     FOR UPDATE;
     -- Reconcile a replay after the client lost the successful response before
     -- allocating a new version.  Both rows are written in this transaction, so
     -- a committed result is always discoverable by its durable key.
     SELECT * INTO v_existing_cost
       FROM public.analysis_costs
      WHERE request_id = p_request_id
        AND idempotency_key = p_idempotency_key
      FOR UPDATE;
     SELECT * INTO v_existing_audit
       FROM public.analysis_audit_bundles
      WHERE request_id = p_request_id
        AND kind = 'bundle'
        AND idempotency_key = p_idempotency_key
      FOR UPDATE;
     IF v_existing_cost.id IS NOT NULL OR v_existing_audit.id IS NOT NULL THEN
         IF v_existing_cost.id IS NOT NULL
            AND v_existing_cost.source_hash <> p_source_hash THEN
             RAISE EXCEPTION 'ANALYSIS_CANONICAL_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
         END IF;
         IF v_existing_audit.id IS NOT NULL
            AND v_existing_audit.content_hash <> p_audit_content_hash THEN
             RAISE EXCEPTION 'ANALYSIS_CANONICAL_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
         END IF;
     END IF;
     v_version := CASE
         WHEN v_existing_audit.id IS NOT NULL THEN v_existing_audit.version
         ELSE NULL
     END;
     IF v_version IS NULL THEN
         SELECT COALESCE(pg_catalog.max(version), 0) + 1
           INTO v_version
           FROM public.analysis_audit_bundles
          WHERE request_id = p_request_id;
     END IF;
     IF v_version > 100000 THEN
         RAISE EXCEPTION 'ANALYSIS_CANONICAL_AUDIT_VERSION_EXHAUSTED' USING ERRCODE = '22023';
     END IF;
     IF v_existing_cost.id IS NULL THEN
         INSERT INTO public.analysis_costs(
             request_id, provider, operation_key, stage, currency, amount_known,
             amount_conservative, usage_unknown, source_hash, idempotency_key,
             payload, retention_class
         ) VALUES (
             p_request_id, p_provider, p_operation_key, p_stage,
             COALESCE(p_currency, 'USD'), p_amount_known,
             p_amount_conservative, p_usage_unknown, p_source_hash,
             p_idempotency_key, p_cost_payload, p_cost_retention_class
         ) RETURNING * INTO v_cost;
     ELSE
         v_cost := v_existing_cost;
     END IF;
     IF v_existing_audit.id IS NULL THEN
         INSERT INTO public.analysis_audit_bundles(
             request_id, version, kind, state, content_hash, idempotency_key,
             retention_class, payload
         ) VALUES (
             p_request_id, v_version, 'bundle', 'complete', p_audit_content_hash,
             p_idempotency_key, p_audit_retention_class, p_audit_payload
         ) RETURNING * INTO v_audit;
     ELSE
         v_audit := v_existing_audit;
     END IF;
     RETURN pg_catalog.jsonb_build_object(
         'version', v_version,
         'cost', pg_catalog.to_jsonb(v_cost),
         'audit', pg_catalog.to_jsonb(v_audit)
     );
 END;
 $$;

 CREATE OR REPLACE FUNCTION public.upsert_analysis_canonical_cache(
     p_request_id UUID,
     p_scope TEXT,
     p_cache_key_hash TEXT,
     p_state TEXT,
     p_expires_at TIMESTAMPTZ,
     p_single_flight_token_hash TEXT,
     p_payload JSONB DEFAULT '{"schemaVersion":1}'::JSONB
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 DECLARE
     v_row public.analysis_cache;
 BEGIN
     IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
         RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_PAYLOAD' USING ERRCODE = '22023';
     END IF;
     INSERT INTO public.analysis_cache(
         request_id, scope, cache_key_hash, state, expires_at,
         single_flight_token_hash, payload
     ) VALUES (
         p_request_id, p_scope, p_cache_key_hash, p_state, p_expires_at,
         p_single_flight_token_hash, p_payload
     )
     ON CONFLICT (request_id, scope, cache_key_hash) DO UPDATE SET
         state = EXCLUDED.state,
         expires_at = EXCLUDED.expires_at,
         single_flight_token_hash = EXCLUDED.single_flight_token_hash,
         payload = EXCLUDED.payload,
         updated_at = pg_catalog.clock_timestamp()
     RETURNING * INTO v_row;
     RETURN pg_catalog.to_jsonb(v_row);
 END;
 $$;

 CREATE OR REPLACE FUNCTION public.append_analysis_canonical_cost(
     p_request_id UUID,
     p_provider TEXT,
     p_operation_key TEXT,
     p_stage TEXT,
     p_currency CHAR(3),
     p_amount_known NUMERIC,
     p_amount_conservative NUMERIC,
     p_usage_unknown BOOLEAN,
     p_source_hash TEXT,
     p_payload JSONB DEFAULT '{"schemaVersion":1}'::JSONB,
     p_retention_class TEXT DEFAULT 'permanent',
     p_idempotency_key TEXT DEFAULT NULL
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 DECLARE
     v_row public.analysis_costs;
 BEGIN
     IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
         RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_PAYLOAD' USING ERRCODE = '22023';
     END IF;
     IF p_idempotency_key IS NOT NULL THEN
         SELECT * INTO v_row
         FROM public.analysis_costs
         WHERE request_id = p_request_id
           AND idempotency_key = p_idempotency_key
         FOR UPDATE;
         IF v_row.id IS NOT NULL AND v_row.source_hash <> p_source_hash THEN
             RAISE EXCEPTION 'ANALYSIS_CANONICAL_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
         END IF;
     END IF;
     INSERT INTO public.analysis_costs(
         request_id, provider, operation_key, stage, currency, amount_known,
         amount_conservative, usage_unknown, source_hash, idempotency_key, payload, retention_class
     ) VALUES (
         p_request_id, p_provider, p_operation_key, p_stage,
         COALESCE(p_currency, 'USD'), p_amount_known, p_amount_conservative,
         p_usage_unknown, p_source_hash, p_idempotency_key, p_payload, p_retention_class
     )
     ON CONFLICT (request_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL
     DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
         WHERE public.analysis_costs.source_hash = EXCLUDED.source_hash
     RETURNING * INTO v_row;
     IF p_idempotency_key IS NOT NULL AND NOT FOUND THEN
         -- A concurrent insert may have won the unique-key race after the
         -- preflight SELECT above. Re-read its committed row and apply the
         -- same source-hash conflict rule instead of silently accepting it.
         SELECT * INTO v_row
         FROM public.analysis_costs
         WHERE request_id = p_request_id
           AND idempotency_key = p_idempotency_key
         FOR UPDATE;
         IF NOT FOUND OR v_row.source_hash IS DISTINCT FROM p_source_hash THEN
             RAISE EXCEPTION 'ANALYSIS_CANONICAL_IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
         END IF;
     END IF;
     RETURN pg_catalog.to_jsonb(v_row);
 END;
 $$;

 CREATE OR REPLACE FUNCTION public.enqueue_analysis_canonical_retry(
     p_request_id UUID,
     p_family TEXT
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 DECLARE
     v_key TEXT := p_request_id::TEXT || ':' || p_family;
     v_hash TEXT := pg_catalog.encode(
         extensions.digest(pg_catalog.convert_to(v_key, 'UTF8'), 'sha256'),
         'hex'
     );
     v_row public.analysis_events;
 BEGIN
     IF p_family NOT IN ('jobs', 'evidence', 'cost', 'cache', 'audit') THEN
         RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_RETRY_FAMILY' USING ERRCODE = '22023';
     END IF;
     INSERT INTO public.analysis_events(
         request_id, kind, state, payload, content_hash, retention_class
     ) VALUES (
         p_request_id, 'operational', 'canonical_retry',
         pg_catalog.jsonb_build_object('family', p_family, 'retryKey', v_key),
         v_hash, 'standard'
     )
     ON CONFLICT (request_id, state, content_hash)
         WHERE kind = 'operational' AND state = 'canonical_retry'
     DO NOTHING
     RETURNING * INTO v_row;
     IF v_row.id IS NULL THEN
         SELECT * INTO v_row FROM public.analysis_events
         WHERE request_id = p_request_id
           AND kind = 'operational'
           AND state = 'canonical_retry'
           AND content_hash = v_hash;
     END IF;
     RETURN pg_catalog.jsonb_build_object(
         'id', v_row.id,
         'request_id', v_row.request_id,
         'kind', v_row.kind,
         'state', v_row.state,
         'payload', v_row.payload,
         'content_hash', v_row.content_hash,
         'retention_class', v_row.retention_class,
         'created_at', pg_catalog.to_char(
             v_row.created_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         )
     );
 END;
 $$;

 CREATE OR REPLACE FUNCTION public.load_analysis_canonical_family(
     p_request_id UUID,
     p_family TEXT
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 BEGIN
     IF p_family NOT IN ('jobs', 'evidence', 'cost', 'cache', 'audit') THEN
         RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_READ_FAMILY' USING ERRCODE = '22023';
     END IF;
     RETURN pg_catalog.jsonb_build_object(
         'jobs', CASE WHEN p_family = 'jobs' THEN COALESCE((
             SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
             FROM (
                 SELECT source_row.*
                 FROM public.analysis_jobs AS source_row
                 WHERE source_row.request_id = p_request_id
                 ORDER BY source_row.created_at, source_row.id
                 LIMIT 100
             ) AS row
         ), '[]'::JSONB) ELSE '[]'::JSONB END,
         'events', CASE WHEN p_family = 'evidence' THEN COALESCE((
             SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
             FROM (
                 SELECT source_row.*
                 FROM public.analysis_events AS source_row
                 WHERE source_row.request_id = p_request_id
                 ORDER BY source_row.created_at, source_row.id
                 LIMIT 100
             ) AS row
         ), '[]'::JSONB) ELSE '[]'::JSONB END,
         'artifacts', CASE WHEN p_family = 'evidence' THEN COALESCE((
             SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
             FROM (
                 SELECT source_row.*
                 FROM public.analysis_artifacts AS source_row
                 WHERE source_row.request_id = p_request_id
                 ORDER BY source_row.created_at, source_row.id
                 LIMIT 100
             ) AS row
         ), '[]'::JSONB) ELSE '[]'::JSONB END,
         'costs', CASE WHEN p_family = 'cost' THEN COALESCE((
             SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.recorded_at, row.id)
             FROM (
                 SELECT source_row.*
                 FROM public.analysis_costs AS source_row
                 WHERE source_row.request_id = p_request_id
                 ORDER BY source_row.recorded_at, source_row.id
                 LIMIT 100
             ) AS row
         ), '[]'::JSONB) ELSE '[]'::JSONB END,
         'caches', CASE WHEN p_family = 'cache' THEN COALESCE((
             SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.updated_at, row.id)
             FROM (
                 SELECT source_row.*
                 FROM public.analysis_cache AS source_row
                 WHERE source_row.request_id = p_request_id
                 ORDER BY source_row.updated_at, source_row.id
                 LIMIT 100
             ) AS row
         ), '[]'::JSONB) ELSE '[]'::JSONB END,
         'audits', CASE WHEN p_family = 'audit' THEN COALESCE((
             SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
             FROM (
                 SELECT source_row.*
                 FROM public.analysis_audit_bundles AS source_row
                 WHERE source_row.request_id = p_request_id
                 ORDER BY source_row.created_at, source_row.id
                 LIMIT 100
             ) AS row
         ), '[]'::JSONB) ELSE '[]'::JSONB END
     );
 END;
 $$;

 CREATE FUNCTION public.upsert_fulfillment_job_v1(
     p_order_id UUID,
     p_request_id UUID,
     p_state TEXT,
     p_attempt_count SMALLINT,
     p_lease_generation BIGINT,
     p_lease_token UUID DEFAULT NULL,
     p_lease_expires_at TIMESTAMPTZ DEFAULT NULL,
     p_next_attempt_at TIMESTAMPTZ DEFAULT NULL,
     p_last_error_code TEXT DEFAULT NULL,
     p_payload JSONB DEFAULT '{}'::JSONB,
     p_operator_admitted_at TIMESTAMPTZ DEFAULT NULL,
     p_last_error_at TIMESTAMPTZ DEFAULT NULL,
     p_completed_at TIMESTAMPTZ DEFAULT NULL,
     p_manual_review_at TIMESTAMPTZ DEFAULT NULL
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 DECLARE
     v_job public.fulfillment_jobs%ROWTYPE;
     v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
     v_current_rank INTEGER;
     v_incoming_rank INTEGER;
     v_next_state TEXT;
     v_next_request_id UUID;
     v_next_lease_token UUID;
     v_next_lease_expires_at TIMESTAMPTZ;
     v_next_attempt_at TIMESTAMPTZ;
     v_next_last_error_code TEXT;
     v_next_operator_admitted_at TIMESTAMPTZ;
     v_next_last_error_at TIMESTAMPTZ;
     v_next_completed_at TIMESTAMPTZ;
     v_next_manual_review_at TIMESTAMPTZ;
     v_inserted BOOLEAN := FALSE;
 BEGIN
     IF p_order_id IS NULL
        OR p_state NOT IN (
            'awaiting_operator', 'admission_pending', 'analysis_in_progress',
            'completed', 'retryable_failure', 'manual_review'
        )
        OR p_attempt_count IS NULL OR p_attempt_count < 0 OR p_attempt_count > 10
        OR p_lease_generation IS NULL OR p_lease_generation < 0
        OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
        OR (p_lease_token IS NULL AND p_lease_expires_at IS NOT NULL)
        OR p_last_error_code IS NOT NULL
           AND p_last_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
         RAISE EXCEPTION USING MESSAGE = 'FULFILLMENT_JOB_INPUT_INVALID', ERRCODE = 'P0001';
     END IF;
     IF p_next_attempt_at IS NULL THEN
         p_next_attempt_at := v_now;
     END IF;
     SELECT fulfillment_job.*
     INTO v_job
     FROM public.fulfillment_jobs AS fulfillment_job
     WHERE fulfillment_job.order_id = p_order_id
     FOR UPDATE;
     IF NOT FOUND THEN
         v_next_state := p_state;
         v_next_request_id := p_request_id;
         v_next_last_error_code := p_last_error_code;
         v_next_operator_admitted_at := CASE
             WHEN v_next_state = 'awaiting_operator' THEN NULL
             ELSE COALESCE(p_operator_admitted_at, v_now)
         END;
         v_next_last_error_at := CASE
             WHEN v_next_last_error_code IS NULL THEN NULL
             ELSE COALESCE(p_last_error_at, v_now)
         END;
         v_next_completed_at := CASE
             WHEN v_next_state = 'completed' THEN COALESCE(p_completed_at, v_now)
             ELSE NULL
         END;
         v_next_manual_review_at := CASE
             WHEN v_next_state = 'manual_review' THEN COALESCE(p_manual_review_at, v_now)
             ELSE NULL
         END;
         v_next_lease_token := CASE
             WHEN v_next_state IN ('admission_pending', 'retryable_failure')
                 THEN p_lease_token
             ELSE NULL
         END;
         v_next_lease_expires_at := CASE
             WHEN v_next_lease_token IS NULL THEN NULL
             WHEN p_lease_expires_at IS NOT NULL THEN p_lease_expires_at
             ELSE v_now + INTERVAL '5 minutes'
         END;
         IF (v_next_state = 'awaiting_operator' AND (
                 v_next_operator_admitted_at IS NOT NULL OR v_next_request_id IS NOT NULL
             ))
            OR (v_next_state <> 'awaiting_operator' AND v_next_operator_admitted_at IS NULL)
            OR (v_next_state IN ('analysis_in_progress', 'completed') AND v_next_request_id IS NULL)
            OR (v_next_state = 'completed' AND v_next_completed_at IS NULL)
            OR (v_next_state <> 'completed' AND v_next_completed_at IS NOT NULL)
            OR (v_next_state = 'manual_review' AND v_next_manual_review_at IS NULL)
            OR (v_next_state <> 'manual_review' AND v_next_manual_review_at IS NOT NULL) THEN
             RAISE EXCEPTION USING MESSAGE = 'FULFILLMENT_JOB_INPUT_INVALID', ERRCODE = 'P0001';
         END IF;
         INSERT INTO public.fulfillment_jobs(
             order_id, request_id, state, attempt_count, lease_generation,
             lease_token, lease_expires_at, next_attempt_at, last_error_code,
             operator_admitted_at, last_error_at, completed_at, manual_review_at,
             payload
         ) VALUES (
             p_order_id, p_request_id, p_state, p_attempt_count, p_lease_generation,
             v_next_lease_token, v_next_lease_expires_at, p_next_attempt_at,
             v_next_last_error_code, v_next_operator_admitted_at, v_next_last_error_at,
             v_next_completed_at, v_next_manual_review_at, p_payload
         )
         ON CONFLICT DO NOTHING
         RETURNING * INTO v_job;
         IF FOUND THEN
             v_inserted := TRUE;
         ELSE
             -- The unique order key may have been won by a concurrent first
             -- fulfillment call. Re-read the committed row and let the normal
             -- request/fence/monotonic checks decide whether this replay is
             -- compatible.
             SELECT fulfillment_job.*
             INTO v_job
             FROM public.fulfillment_jobs AS fulfillment_job
             WHERE fulfillment_job.order_id = p_order_id
             FOR UPDATE;
             IF NOT FOUND THEN
                 IF p_request_id IS NOT NULL AND EXISTS (
                     SELECT 1
                     FROM public.fulfillment_jobs AS request_job
                     WHERE request_job.request_id = p_request_id
                 ) THEN
                     RAISE EXCEPTION USING MESSAGE = 'FULFILLMENT_JOB_REQUEST_CONFLICT', ERRCODE = 'P0001';
                 END IF;
                 RAISE EXCEPTION USING MESSAGE = 'FULFILLMENT_JOB_INSERT_CONFLICT', ERRCODE = 'P0001';
             END IF;
         END IF;
     END IF;
     IF NOT v_inserted THEN
         IF p_request_id IS NOT NULL AND EXISTS (
             SELECT 1
             FROM public.fulfillment_jobs AS request_job
             WHERE request_job.request_id = p_request_id
               AND request_job.order_id IS DISTINCT FROM p_order_id
         ) THEN
             RAISE EXCEPTION USING MESSAGE = 'FULFILLMENT_JOB_REQUEST_CONFLICT', ERRCODE = 'P0001';
         END IF;
         IF v_job.request_id IS NOT NULL AND p_request_id IS NOT NULL
            AND v_job.request_id IS DISTINCT FROM p_request_id THEN
             RAISE EXCEPTION USING MESSAGE = 'FULFILLMENT_JOB_REQUEST_CONFLICT', ERRCODE = 'P0001';
         END IF;
         IF v_job.lease_token IS NOT NULL AND p_lease_token IS NOT NULL
            AND v_job.lease_token IS DISTINCT FROM p_lease_token
            AND p_lease_generation <= v_job.lease_generation THEN
             RAISE EXCEPTION USING MESSAGE = 'FULFILLMENT_JOB_FENCE_CONFLICT', ERRCODE = 'P0001';
         END IF;
         v_current_rank := CASE v_job.state
             WHEN 'awaiting_operator' THEN 0
             WHEN 'admission_pending' THEN 1
             WHEN 'analysis_in_progress' THEN 2
             WHEN 'retryable_failure' THEN 3
             WHEN 'completed' THEN 4
             WHEN 'manual_review' THEN 4
         END;
         v_incoming_rank := CASE p_state
             WHEN 'awaiting_operator' THEN 0
             WHEN 'admission_pending' THEN 1
             WHEN 'analysis_in_progress' THEN 2
             WHEN 'retryable_failure' THEN 3
             WHEN 'completed' THEN 4
             WHEN 'manual_review' THEN 4
         END;
         IF p_lease_generation < v_job.lease_generation THEN
             RAISE EXCEPTION USING MESSAGE = 'FULFILLMENT_JOB_FENCE_CONFLICT', ERRCODE = 'P0001';
         END IF;
         -- A generation is a lease fence, not permission to rewind the
         -- fulfillment state. In particular, an old terminal result must not
         -- be replaced by a newer retry/manual-review snapshot, and the two
         -- terminal states are not interchangeable at equal rank.
         IF v_incoming_rank < v_current_rank
            OR (v_current_rank = 4 AND v_incoming_rank = 4 AND p_state <> v_job.state) THEN
             RAISE EXCEPTION USING MESSAGE = 'FULFILLMENT_JOB_MONOTONIC_CONFLICT', ERRCODE = 'P0001';
         END IF;
         v_next_state := p_state;
         v_next_request_id := COALESCE(p_request_id, v_job.request_id);
         v_next_last_error_code := COALESCE(p_last_error_code, v_job.last_error_code);
         v_next_operator_admitted_at := CASE
             WHEN v_next_state = 'awaiting_operator' THEN NULL
             ELSE COALESCE(p_operator_admitted_at, v_job.operator_admitted_at, v_now)
         END;
         v_next_last_error_at := CASE
             WHEN v_next_last_error_code IS NULL THEN NULL
             ELSE COALESCE(p_last_error_at, v_job.last_error_at, v_now)
         END;
         v_next_completed_at := CASE
             WHEN v_next_state = 'completed' THEN COALESCE(p_completed_at, v_job.completed_at, v_now)
             ELSE NULL
         END;
         v_next_manual_review_at := CASE
             WHEN v_next_state = 'manual_review' THEN COALESCE(p_manual_review_at, v_job.manual_review_at, v_now)
             ELSE NULL
         END;
         v_next_lease_token := CASE
             WHEN v_next_state IN ('admission_pending', 'retryable_failure')
                 THEN COALESCE(p_lease_token, v_job.lease_token)
             ELSE NULL
         END;
         v_next_lease_expires_at := CASE
             WHEN v_next_lease_token IS NULL THEN NULL
             WHEN p_lease_expires_at IS NOT NULL THEN p_lease_expires_at
             WHEN p_lease_token IS NOT NULL THEN v_now + INTERVAL '5 minutes'
             ELSE v_job.lease_expires_at
         END;
         v_next_attempt_at := CASE
             WHEN p_lease_generation > v_job.lease_generation THEN p_next_attempt_at
             ELSE GREATEST(p_next_attempt_at, v_job.next_attempt_at)
         END;
         IF (v_next_state = 'awaiting_operator' AND (
                 v_next_operator_admitted_at IS NOT NULL OR v_next_request_id IS NOT NULL
             ))
            OR (v_next_state <> 'awaiting_operator' AND v_next_operator_admitted_at IS NULL)
            OR (v_next_state IN ('analysis_in_progress', 'completed') AND v_next_request_id IS NULL)
            OR (v_next_state = 'completed' AND v_next_completed_at IS NULL)
            OR (v_next_state <> 'completed' AND v_next_completed_at IS NOT NULL)
            OR (v_next_state = 'manual_review' AND v_next_manual_review_at IS NULL)
            OR (v_next_state <> 'manual_review' AND v_next_manual_review_at IS NOT NULL) THEN
             RAISE EXCEPTION USING MESSAGE = 'FULFILLMENT_JOB_INPUT_INVALID', ERRCODE = 'P0001';
         END IF;
         UPDATE public.fulfillment_jobs
         SET request_id = v_next_request_id,
             state = v_next_state,
             attempt_count = GREATEST(p_attempt_count, v_job.attempt_count),
             lease_generation = GREATEST(p_lease_generation, v_job.lease_generation),
             lease_token = v_next_lease_token,
             lease_expires_at = v_next_lease_expires_at,
             next_attempt_at = v_next_attempt_at,
             last_error_code = v_next_last_error_code,
             operator_admitted_at = v_next_operator_admitted_at,
             last_error_at = v_next_last_error_at,
             completed_at = v_next_completed_at,
             manual_review_at = v_next_manual_review_at,
             payload = CASE WHEN p_payload = '{}'::JSONB AND v_job.payload <> '{}'::JSONB
                 THEN v_job.payload ELSE p_payload END,
             updated_at = pg_catalog.clock_timestamp()
         WHERE order_id = p_order_id
         RETURNING * INTO v_job;
     END IF;
     RETURN pg_catalog.jsonb_build_object(
         'status', 'recorded',
         'order_id', v_job.order_id,
         'state', v_job.state,
         'request_id', v_job.request_id,
         'lease_generation', v_job.lease_generation,
         'lease_token', v_job.lease_token
     );
 END;
 $$;

 CREATE FUNCTION public.enqueue_notification_v1(
     p_channel TEXT,
     p_event_kind TEXT,
     p_dedupe_key TEXT,
     p_payload JSONB DEFAULT '{}'::JSONB,
     p_content_hash TEXT DEFAULT NULL,
     p_requeue BOOLEAN DEFAULT FALSE
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 DECLARE
     v_existing public.notification_outbox%ROWTYPE;
 BEGIN
     IF p_channel NOT IN ('discord', 'kakao', 'sentry')
        OR p_event_kind IS NULL OR pg_catalog.length(pg_catalog.btrim(p_event_kind)) = 0
        OR p_dedupe_key IS NULL OR pg_catalog.length(pg_catalog.btrim(p_dedupe_key)) = 0
        OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
        OR p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$'
        OR p_requeue IS NULL THEN
         RAISE EXCEPTION USING MESSAGE = 'NOTIFICATION_INPUT_INVALID', ERRCODE = 'P0001';
     END IF;
     SELECT notification.*
     INTO v_existing
     FROM public.notification_outbox AS notification
     WHERE notification.dedupe_key = p_dedupe_key
     FOR UPDATE;
     IF FOUND THEN
         IF v_existing.channel = p_channel
            AND v_existing.event_kind = p_event_kind
            AND v_existing.content_hash = p_content_hash
            AND v_existing.payload = p_payload THEN
             IF p_requeue AND v_existing.state = 'dead' THEN
                 UPDATE public.notification_outbox
                 SET state = 'queued',
                     attempt_count = 0,
                     next_attempt_at = pg_catalog.clock_timestamp(),
                     delivered_at = NULL,
                     terminal_at = NULL,
                     last_error_code = NULL,
                     lease_token = NULL,
                     lease_holder_hash = NULL,
                     lease_expires_at = NULL,
                     updated_at = pg_catalog.clock_timestamp()
                 WHERE id = v_existing.id;
                 RETURN pg_catalog.jsonb_build_object('status', 'queued', 'duplicate', TRUE);
             END IF;
             RETURN pg_catalog.jsonb_build_object('status', v_existing.state, 'duplicate', TRUE);
         END IF;
         RAISE EXCEPTION USING MESSAGE = 'NOTIFICATION_DEDUPE_CONTENT_CONFLICT', ERRCODE = 'P0001';
     END IF;
     INSERT INTO public.notification_outbox(
         channel, event_kind, dedupe_key, state, payload, content_hash
     ) VALUES (
         p_channel, p_event_kind, p_dedupe_key, 'queued', p_payload, p_content_hash
     )
     ON CONFLICT DO NOTHING;
     IF FOUND THEN
         RETURN pg_catalog.jsonb_build_object('status', 'queued', 'duplicate', FALSE);
     END IF;
     SELECT notification.*
     INTO v_existing
     FROM public.notification_outbox AS notification
     WHERE notification.dedupe_key = p_dedupe_key;
     IF FOUND AND v_existing.channel = p_channel
        AND v_existing.event_kind = p_event_kind
        AND v_existing.content_hash = p_content_hash
        AND v_existing.payload = p_payload THEN
         IF p_requeue AND v_existing.state = 'dead' THEN
             UPDATE public.notification_outbox
             SET state = 'queued',
                 attempt_count = 0,
                 next_attempt_at = pg_catalog.clock_timestamp(),
                 delivered_at = NULL,
                 terminal_at = NULL,
                 last_error_code = NULL,
                 lease_token = NULL,
                 lease_holder_hash = NULL,
                 lease_expires_at = NULL,
                 updated_at = pg_catalog.clock_timestamp()
             WHERE id = v_existing.id;
             RETURN pg_catalog.jsonb_build_object('status', 'queued', 'duplicate', TRUE);
         END IF;
         RETURN pg_catalog.jsonb_build_object('status', v_existing.state, 'duplicate', TRUE);
     END IF;
     RAISE EXCEPTION USING MESSAGE = 'NOTIFICATION_DEDUPE_CONTENT_CONFLICT', ERRCODE = 'P0001';
 END;
 $$;

 CREATE FUNCTION public.claim_notification_outbox_v1(
     p_limit INTEGER,
     p_holder_hash TEXT,
     p_lease_seconds INTEGER
 )
 RETURNS SETOF public.notification_outbox
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 BEGIN
     IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100
        OR p_holder_hash IS NULL OR p_holder_hash !~ '^[a-f0-9]{64}$'
        OR p_lease_seconds IS NULL OR p_lease_seconds < 60 OR p_lease_seconds > 600 THEN
         RAISE EXCEPTION USING MESSAGE = 'NOTIFICATION_CLAIM_INPUT_INVALID', ERRCODE = 'P0001';
     END IF;
     RETURN QUERY
     WITH candidates AS (
         SELECT notification.id
         FROM public.notification_outbox AS notification
         WHERE notification.state IN ('queued', 'retryable')
           AND notification.attempt_count < 20
           AND notification.next_attempt_at <= pg_catalog.clock_timestamp()
           AND (notification.lease_expires_at IS NULL OR notification.lease_expires_at <= pg_catalog.clock_timestamp())
         ORDER BY notification.next_attempt_at, notification.created_at
         LIMIT p_limit
         FOR UPDATE SKIP LOCKED
     )
     UPDATE public.notification_outbox AS notification
     SET state = 'leased',
         attempt_count = notification.attempt_count + 1,
         lease_generation = notification.lease_generation + 1,
         lease_token = extensions.gen_random_uuid(),
         lease_holder_hash = p_holder_hash,
         lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
         updated_at = pg_catalog.clock_timestamp()
     FROM candidates
     WHERE notification.id = candidates.id
     RETURNING notification.*;
 END;
 $$;

 CREATE FUNCTION public.finish_notification_outbox_v1(
     p_outbox_id UUID,
     p_lease_token UUID,
     p_lease_generation BIGINT,
     p_outcome TEXT,
     p_error_code TEXT DEFAULT NULL,
     p_retry_after_seconds INTEGER DEFAULT 0
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 DECLARE
     v_row public.notification_outbox%ROWTYPE;
     v_state TEXT;
 BEGIN
     IF p_outbox_id IS NULL OR p_lease_token IS NULL OR p_lease_generation IS NULL OR p_lease_generation < 0
        OR p_outcome NOT IN ('sent', 'retryable', 'dead')
        OR p_retry_after_seconds IS NULL OR p_retry_after_seconds < 0 OR p_retry_after_seconds > 3600 THEN
         RAISE EXCEPTION USING MESSAGE = 'NOTIFICATION_FINISH_INPUT_INVALID', ERRCODE = 'P0001';
     END IF;
     SELECT notification.*
     INTO v_row
     FROM public.notification_outbox AS notification
     WHERE notification.id = p_outbox_id
     FOR UPDATE;
     IF NOT FOUND OR v_row.lease_token IS DISTINCT FROM p_lease_token
        OR v_row.lease_generation IS DISTINCT FROM p_lease_generation
        OR v_row.state <> 'leased' THEN
         RAISE EXCEPTION USING MESSAGE = 'NOTIFICATION_FENCE_CONFLICT', ERRCODE = 'P0001';
     END IF;
     v_state := CASE
         WHEN p_outcome = 'sent' THEN 'sent'
         WHEN p_outcome = 'dead' OR v_row.attempt_count >= 20 THEN 'dead'
         ELSE 'retryable'
     END;
     UPDATE public.notification_outbox
     SET state = v_state,
         next_attempt_at = CASE WHEN v_state = 'retryable'
             THEN pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_retry_after_seconds)
             ELSE next_attempt_at END,
         delivered_at = CASE WHEN v_state = 'sent' THEN pg_catalog.clock_timestamp() ELSE delivered_at END,
         terminal_at = CASE WHEN v_state = 'dead' THEN pg_catalog.clock_timestamp() ELSE terminal_at END,
         last_error_code = p_error_code,
         lease_token = NULL,
         lease_holder_hash = NULL,
         lease_expires_at = NULL,
         updated_at = pg_catalog.clock_timestamp()
     WHERE id = p_outbox_id;
     RETURN pg_catalog.jsonb_build_object('status', v_state, 'duplicate', FALSE);
 END;
 $$;

 CREATE FUNCTION public.reconcile_stale_notification_outbox_v1(
     p_limit INTEGER DEFAULT 100
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 DECLARE
     v_count INTEGER;
 BEGIN
     IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
         RAISE EXCEPTION USING MESSAGE = 'NOTIFICATION_RECONCILE_LIMIT_INVALID', ERRCODE = 'P0001';
     END IF;
     WITH stale AS (
         SELECT notification.id
         FROM public.notification_outbox AS notification
         WHERE notification.state = 'leased'
           AND notification.lease_expires_at IS NOT NULL
           AND notification.lease_expires_at <= pg_catalog.clock_timestamp()
         ORDER BY notification.lease_expires_at, notification.created_at
         LIMIT p_limit
         FOR UPDATE SKIP LOCKED
     )
     UPDATE public.notification_outbox AS notification
     SET state = CASE WHEN attempt_count >= 20 THEN 'dead' ELSE 'retryable' END,
         next_attempt_at = pg_catalog.clock_timestamp(),
         terminal_at = CASE WHEN attempt_count >= 20 THEN pg_catalog.clock_timestamp() ELSE terminal_at END,
         last_error_code = 'LEASE_EXPIRED',
         lease_token = NULL,
         lease_holder_hash = NULL,
         lease_expires_at = NULL,
         updated_at = pg_catalog.clock_timestamp()
     FROM stale
     WHERE notification.id = stale.id;
     GET DIAGNOSTICS v_count = ROW_COUNT;
     RETURN pg_catalog.jsonb_build_object('status', 'reconciled', 'count', v_count);
 END;
 $$;

 CREATE FUNCTION public.list_notification_outbox_v1(
     p_limit INTEGER DEFAULT 10
 )
 RETURNS SETOF public.notification_outbox
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 BEGIN
     IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
         RAISE EXCEPTION USING MESSAGE = 'NOTIFICATION_READ_LIMIT_INVALID', ERRCODE = 'P0001';
     END IF;
     RETURN QUERY
     SELECT notification.*
     FROM public.notification_outbox AS notification
     ORDER BY notification.created_at
     LIMIT p_limit;
 END;
 $$;

 CREATE FUNCTION public.list_notification_legacy_outbox_v1(
     p_limit INTEGER DEFAULT 10
 )
 RETURNS TABLE (
     dedupe_key TEXT,
     channel TEXT,
     event_kind TEXT,
     payload JSONB,
     content_hash TEXT
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 BEGIN
     IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
         RAISE EXCEPTION USING MESSAGE = 'NOTIFICATION_READ_LIMIT_INVALID', ERRCODE = 'P0001';
     END IF;
     RETURN QUERY
     WITH legacy AS (
         SELECT payment.dedupe_key,
                payment.channel,
                payment.event_kind,
                payment.payload,
                public.canonical_json_hash_v1(
                    'payment-discord-content',
                    payment.payload
                ) AS content_hash
         FROM (
             SELECT 'earlybird-payment:' || outbox.order_id::TEXT AS dedupe_key,
                    'discord'::TEXT AS channel,
                    'earlybird.payment.completed'::TEXT AS event_kind,
                    outbox.order_id,
                    earlybird_order.plan_id,
                    earlybird_order.actual_amount_krw AS amount_krw,
                    pg_catalog.to_char(
                        earlybird_order.paid_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                    ) AS paid_at,
                    pg_catalog.jsonb_build_object(
                        'order_id', outbox.order_id::TEXT,
                        'plan_id', earlybird_order.plan_id,
                        'amount_krw', earlybird_order.actual_amount_krw,
                        'paid_at', pg_catalog.to_char(
                            earlybird_order.paid_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                        )
                    ) AS payload
             FROM public.earlybird_payment_discord_outbox AS outbox
             JOIN public.earlybird_orders AS earlybird_order
               ON earlybird_order.id = outbox.order_id
         ) AS payment
         UNION ALL
         SELECT kakao.dedupe_key,
                kakao.channel,
                kakao.event_kind,
                kakao.payload,
                public.canonical_json_hash_v1(
                    'kakao-signup-content',
                    kakao.payload
                ) AS content_hash
         FROM (
             SELECT 'kakao-signup:' || public.canonical_json_hash_v1(
                        'kakao-signup-key',
                        pg_catalog.to_jsonb(outbox.user_id::TEXT)
                    ) AS dedupe_key,
                    'kakao'::TEXT AS channel,
                    'kakao.signup'::TEXT AS event_kind,
                    pg_catalog.jsonb_build_object(
                        'user_id', outbox.user_id::TEXT,
                        'masked_name', outbox.masked_name,
                        'birthyear', pg_catalog.btrim(outbox.birthyear),
                        'gender', outbox.gender,
                        'signed_up_at', pg_catalog.to_char(
                            outbox.signed_up_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                        ),
                        'attribution_origin', CASE
                            WHEN outbox.attribution_origin IS NOT NULL
                                 AND outbox.attribution_origin ~ '^https?://[a-z0-9][a-z0-9.-]{0,251}/$'
                                 AND outbox.attribution_origin !~ '^https?://(?:localhost|(?:[0-9]{1,3}\.){3}[0-9]{1,3})/'
                            THEN outbox.attribution_origin
                            ELSE NULL
                        END
                    ) AS payload
             FROM public.kakao_signup_discord_outbox AS outbox
         ) AS kakao
         UNION ALL
         SELECT sentry.dedupe_key,
                sentry.channel,
                sentry.event_kind,
                sentry.payload,
                public.canonical_json_hash_v1(
                    'sentry-notification-content',
                    sentry.payload
                ) AS content_hash
         FROM (
             SELECT 'sentry:' || public.canonical_json_hash_v1(
                        'sentry-dedupe-key',
                        pg_catalog.to_jsonb(pg_catalog.btrim(outbox.dedupe_key))
                    ) AS dedupe_key,
                    'sentry'::TEXT AS channel,
                    'sentry.issue_alert'::TEXT AS event_kind,
                    pg_catalog.jsonb_build_object(
                        'dedupe_key_hash', public.canonical_json_hash_v1(
                            'sentry-dedupe-key',
                            pg_catalog.to_jsonb(pg_catalog.btrim(outbox.dedupe_key))
                        ),
                        'project_slug', CASE
                            WHEN outbox.project_slug IS NOT NULL
                                 AND outbox.project_slug ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$'
                            THEN outbox.project_slug
                            ELSE NULL
                        END,
                        'occurred_at', pg_catalog.to_char(
                            outbox.occurred_at AT TIME ZONE 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                        ),
                        'issue_url', CASE
                            WHEN outbox.issue_url IS NOT NULL
                                 AND outbox.issue_url ~ '^https://(?:sentry\.io|[^/]+\.sentry\.io)/organizations/[^/]+/issues/[0-9]+/?$'
                            THEN outbox.issue_url
                            ELSE NULL
                        END,
                        'issue_short_id', CASE
                            WHEN outbox.issue_short_id IS NOT NULL
                                 AND outbox.issue_short_id ~ '^[A-Z][A-Z0-9_-]{0,49}-[0-9]{1,12}$'
                            THEN outbox.issue_short_id
                            ELSE NULL
                        END,
                        'error_type', CASE
                            WHEN outbox.error_type IS NOT NULL
                                 AND outbox.error_type ~ '^[A-Za-z_$][A-Za-z0-9_$.]*(::[A-Za-z_$][A-Za-z0-9_$.]*)*$'
                            THEN outbox.error_type
                            ELSE NULL
                        END,
                        'release', CASE
                            WHEN outbox.release IS NOT NULL
                                 AND outbox.release ~ '^[0-9A-Za-z][0-9A-Za-z._+-]*$'
                                 AND pg_catalog.length(outbox.release) <= 80
                                 AND outbox.release !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                            THEN outbox.release
                            ELSE NULL
                        END
                    ) AS payload
             FROM public.sentry_discord_alert_outbox AS outbox
         ) AS sentry
     )
     SELECT legacy.dedupe_key,
            legacy.channel,
            legacy.event_kind,
            legacy.payload,
            legacy.content_hash
     FROM legacy
     ORDER BY legacy.dedupe_key
     LIMIT p_limit;
 END;
 $$;

 CREATE FUNCTION public.canonical_system_configuration_json(
     p_config JSONB
 )
 RETURNS TEXT
 LANGUAGE SQL
 IMMUTABLE
 SECURITY DEFINER
 SET search_path = ''
 AS $$
     SELECT public.canonical_json_v1(p_config);
 $$;

 CREATE FUNCTION public.record_system_configuration_v1(
     p_config_key TEXT,
     p_version INTEGER,
     p_state TEXT,
     p_config JSONB,
     p_content_hash TEXT,
     p_effective_at TIMESTAMPTZ
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 DECLARE
     v_existing public.system_configuration%ROWTYPE;
 BEGIN
     IF p_config_key IS NULL OR pg_catalog.length(pg_catalog.btrim(p_config_key)) = 0
        OR p_version IS NULL OR p_version < 1
        OR p_state NOT IN ('draft', 'effective', 'retired')
        OR p_config IS NULL OR pg_catalog.jsonb_typeof(p_config) <> 'object'
        OR p_config = '{}'::JSONB
        OR p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$'
        OR (p_state = 'effective' AND p_effective_at IS NULL) THEN
         RAISE EXCEPTION USING MESSAGE = 'SYSTEM_CONFIGURATION_INPUT_INVALID', ERRCODE = 'P0001';
     END IF;
     IF p_content_hash IS DISTINCT FROM public.canonical_json_hash_v1(
         'system-configuration',
         p_config
     ) THEN
         RAISE EXCEPTION USING MESSAGE = 'SYSTEM_CONFIGURATION_HASH_INVALID', ERRCODE = 'P0001';
     END IF;
     SELECT configuration.*
     INTO v_existing
     FROM public.system_configuration AS configuration
     WHERE configuration.config_key = p_config_key
       AND configuration.version = p_version
     FOR UPDATE;
     IF FOUND THEN
         IF v_existing.state = p_state
            AND v_existing.config = p_config
            AND v_existing.content_hash = p_content_hash
            AND v_existing.effective_at IS NOT DISTINCT FROM p_effective_at THEN
             RETURN pg_catalog.jsonb_build_object('status', 'recorded', 'duplicate', TRUE);
         END IF;
         RAISE EXCEPTION USING MESSAGE = 'SYSTEM_CONFIGURATION_CONTENT_CONFLICT', ERRCODE = 'P0001';
     END IF;
     INSERT INTO public.system_configuration(
         config_key, version, state, config, content_hash, effective_at
     ) VALUES (
         p_config_key, p_version, p_state, p_config, p_content_hash, p_effective_at
     );
     RETURN pg_catalog.jsonb_build_object('status', 'recorded', 'duplicate', FALSE);
 END;
 $$;

 CREATE FUNCTION public.acquire_system_lease_v1(
     p_lease_key TEXT,
     p_kind TEXT,
     p_holder_hash TEXT,
     p_lease_seconds INTEGER
 )
 RETURNS JSONB
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
 AS $$
 DECLARE
     v_lease public.system_leases%ROWTYPE;
     v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
 BEGIN
     IF p_lease_key IS NULL OR pg_catalog.length(pg_catalog.btrim(p_lease_key)) = 0
        OR p_kind NOT IN ('provider', 'capacity', 'maintenance', 'notification')
        OR p_holder_hash IS NULL OR p_holder_hash !~ '^[a-f0-9]{64}$'
        OR p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 3600 THEN
         RAISE EXCEPTION USING MESSAGE = 'SYSTEM_LEASE_INPUT_INVALID', ERRCODE = 'P0001';
     END IF;

     INSERT INTO public.system_leases(lease_key, kind)
     VALUES (p_lease_key, p_kind)
     ON CONFLICT (lease_key) DO NOTHING;
     SELECT system_lease.*
     INTO v_lease
     FROM public.system_leases AS system_lease
     WHERE system_lease.lease_key = p_lease_key
     FOR UPDATE;
     IF v_lease.state IN ('available', 'expired')
        OR v_lease.lease_expires_at IS NULL
        OR v_lease.lease_expires_at <= v_now
        OR v_lease.holder_hash = p_holder_hash THEN
         UPDATE public.system_leases
         SET kind = p_kind,
             generation = v_lease.generation + 1,
             state = 'held',
             holder_hash = p_holder_hash,
             lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
             heartbeat_at = v_now,
             fence_token = v_lease.fence_token + 1,
             updated_at = v_now
         WHERE lease_key = p_lease_key
         RETURNING * INTO v_lease;
         RETURN pg_catalog.jsonb_build_object(
             'acquired', TRUE,
             'generation', v_lease.generation,
             'fence_token', v_lease.fence_token,
             'lease_expires_at', v_lease.lease_expires_at
         );
     END IF;
     RETURN pg_catalog.jsonb_build_object(
         'acquired', FALSE,
         'generation', v_lease.generation,
         'fence_token', v_lease.fence_token,
         'lease_expires_at', v_lease.lease_expires_at
     );
 END;
 $$;

 REVOKE ALL ON FUNCTION public.append_analysis_canonical_artifact(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_artifact(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT) TO service_role;

 REVOKE ALL ON FUNCTION public.apply_analysis_canonical_backfill_row(
     TEXT, TEXT, TEXT, TEXT, TEXT, UUID, JSONB
 ) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.apply_analysis_canonical_backfill_row(
     TEXT, TEXT, TEXT, TEXT, TEXT, UUID, JSONB
 ) TO service_role;

 REVOKE ALL ON FUNCTION public.append_analysis_canonical_audit(UUID, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_audit(UUID, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB, TEXT) TO service_role;

 REVOKE ALL ON FUNCTION public.append_analysis_canonical_late_cost_audit(UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_late_cost_audit(UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB, TEXT) TO service_role;

 REVOKE ALL ON FUNCTION public.upsert_analysis_canonical_cache(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.upsert_analysis_canonical_cache(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB) TO service_role;

 REVOKE ALL ON FUNCTION public.append_analysis_canonical_cost(UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.append_analysis_canonical_cost(UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, JSONB, TEXT, TEXT) TO service_role;

 REVOKE ALL ON FUNCTION public.enqueue_analysis_canonical_retry(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.enqueue_analysis_canonical_retry(UUID, TEXT) TO service_role;

 REVOKE ALL ON FUNCTION public.load_analysis_canonical_family(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.load_analysis_canonical_family(UUID, TEXT) TO service_role;

 REVOKE ALL ON FUNCTION public.upsert_fulfillment_job_v1(UUID, UUID, TEXT, SMALLINT, BIGINT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.upsert_fulfillment_job_v1(UUID, UUID, TEXT, SMALLINT, BIGINT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

 REVOKE ALL ON FUNCTION public.enqueue_notification_v1(TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.enqueue_notification_v1(TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) TO service_role;

 REVOKE ALL ON FUNCTION public.claim_notification_outbox_v1(INTEGER, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.claim_notification_outbox_v1(INTEGER, TEXT, INTEGER) TO service_role;

 REVOKE ALL ON FUNCTION public.finish_notification_outbox_v1(UUID, UUID, BIGINT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.finish_notification_outbox_v1(UUID, UUID, BIGINT, TEXT, TEXT, INTEGER) TO service_role;

 REVOKE ALL ON FUNCTION public.reconcile_stale_notification_outbox_v1(INTEGER) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.reconcile_stale_notification_outbox_v1(INTEGER) TO service_role;

 REVOKE ALL ON FUNCTION public.list_notification_outbox_v1(INTEGER) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.list_notification_outbox_v1(INTEGER) TO service_role;

 REVOKE ALL ON FUNCTION public.list_notification_legacy_outbox_v1(INTEGER) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.list_notification_legacy_outbox_v1(INTEGER) TO service_role;

 REVOKE ALL ON FUNCTION public.canonical_system_configuration_json(JSONB) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.canonical_system_configuration_json(JSONB) TO service_role;

 REVOKE ALL ON FUNCTION public.record_system_configuration_v1(TEXT, INTEGER, TEXT, JSONB, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.record_system_configuration_v1(TEXT, INTEGER, TEXT, JSONB, TEXT, TIMESTAMPTZ) TO service_role;

 REVOKE ALL ON FUNCTION public.acquire_system_lease_v1(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;

 GRANT EXECUTE ON FUNCTION public.acquire_system_lease_v1(TEXT, TEXT, TEXT, INTEGER) TO service_role;

 CREATE TRIGGER analysis_costs_append_only
     BEFORE UPDATE OR DELETE ON public.analysis_costs
     FOR EACH ROW EXECUTE FUNCTION public.reject_analysis_canonical_mutation();

 CREATE TRIGGER analysis_audit_bundles_append_only
     BEFORE UPDATE OR DELETE ON public.analysis_audit_bundles
     FOR EACH ROW EXECUTE FUNCTION public.reject_analysis_canonical_mutation();

 CREATE TRIGGER system_configuration_immutable
 BEFORE UPDATE OR DELETE ON public.system_configuration
 FOR EACH ROW EXECUTE FUNCTION public.reject_commerce_append_only_mutation();

 -- RESTORE_OBJECTS_END
 COMMIT;

 -- Exact source anchors: analysis tables 366-456; commerce tables 27-135; artifact latest definition backfill 34-85; remaining routines analysis 654-1041 and commerce 473-1643.
