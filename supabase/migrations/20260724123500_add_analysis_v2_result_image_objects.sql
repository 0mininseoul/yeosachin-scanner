-- Durable private R2-backed result images. Raw source URLs deliberately remain
-- in the short-lived V2 working set; this schema stores only opaque locators,
-- content fingerprints, and bounded provider-independent failure codes.

CREATE TABLE public.analysis_v2_result_image_manifests (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    producer_job_key VARCHAR(160) NOT NULL,
    producer_input_hash VARCHAR(64) NOT NULL CHECK (
        producer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    producer_claim_token UUID NOT NULL,
    ordered_manifest_hash VARCHAR(64) NOT NULL CHECK (
        ordered_manifest_hash ~ '^[a-f0-9]{64}$'
    ),
    expected_rows INTEGER NOT NULL CHECK (
        expected_rows BETWEEN 0 AND 50001
    ),
    durable_rows INTEGER CHECK (
        durable_rows BETWEEN 0 AND 50001
    ),
    sourced_images INTEGER CHECK (
        sourced_images BETWEEN 0 AND 50001
    ),
    ready_images INTEGER CHECK (
        ready_images BETWEEN 0 AND 50001
    ),
    capture_failed_images INTEGER CHECK (
        capture_failed_images BETWEEN 0 AND 50001
    ),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    sealed_at TIMESTAMP WITH TIME ZONE,
    FOREIGN KEY (request_id, producer_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);

CREATE TABLE public.analysis_v2_result_image_objects (
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    kind VARCHAR(16) NOT NULL CHECK (
        kind IN ('target', 'female', 'private')
    ),
    candidate_locator VARCHAR(128) NOT NULL CHECK (
        candidate_locator ~ '^[A-Za-z0-9._:-]{1,128}$'
        AND candidate_locator !~* 'https?'
    ),
    sort_ordinal INTEGER NOT NULL CHECK (
        sort_ordinal BETWEEN 0 AND 50000
    ),
    source_fingerprint VARCHAR(64) CHECK (
        source_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    status VARCHAR(24) NOT NULL CHECK (
        status IN ('ready', 'source_missing', 'capture_failed')
    ),
    object_key TEXT UNIQUE CHECK (
        object_key ~ '^v1/[a-f0-9]{32}/(target|female|private)/[a-f0-9]{32}[.]webp$'
        AND object_key !~* 'https?'
    ),
    sha256 VARCHAR(64) CHECK (
        sha256 ~ '^[a-f0-9]{64}$'
    ),
    byte_size INTEGER CHECK (
        byte_size BETWEEN 1 AND 131072
    ),
    captured_at TIMESTAMP WITH TIME ZONE,
    observed_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    failure_code VARCHAR(64) CHECK (
        failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
    is_mandatory BOOLEAN NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, kind, candidate_locator),
    UNIQUE (request_id, sort_ordinal),
    CONSTRAINT analysis_v2_result_image_identity_check CHECK (
        (kind = 'target' AND candidate_locator = 'target' AND sort_ordinal = 0)
        OR (
            kind IN ('female', 'private')
            AND candidate_locator <> 'target'
            AND sort_ordinal BETWEEN 1 AND 50000
        )
    ),
    CONSTRAINT analysis_v2_result_image_outcome_check CHECK (
        (
            status = 'ready'
            AND source_fingerprint IS NOT NULL
            AND object_key IS NOT NULL
            AND pg_catalog.strpos(object_key, '/' || kind || '/') > 0
            AND sha256 IS NOT NULL
            AND byte_size IS NOT NULL
            AND captured_at IS NOT NULL
            AND failure_code IS NULL
            AND pg_catalog.abs(EXTRACT(
                epoch FROM (
                    expires_at - captured_at - INTERVAL '30 days'
                )
            )) <= 3600
        )
        OR (
            status = 'source_missing'
            AND source_fingerprint IS NULL
            AND object_key IS NULL
            AND sha256 IS NULL
            AND byte_size IS NULL
            AND captured_at IS NULL
            AND failure_code IS NULL
            AND pg_catalog.abs(EXTRACT(
                epoch FROM (
                    expires_at - observed_at - INTERVAL '30 days'
                )
            )) <= 3600
        )
        OR (
            status = 'capture_failed'
            AND source_fingerprint IS NOT NULL
            AND object_key IS NULL
            AND sha256 IS NULL
            AND byte_size IS NULL
            AND captured_at IS NULL
            AND failure_code IS NOT NULL
            AND pg_catalog.abs(EXTRACT(
                epoch FROM (
                    expires_at - observed_at - INTERVAL '30 days'
                )
            )) <= 3600
        )
    )
);

CREATE TABLE public.analysis_v2_result_image_repair_outbox (
    request_id UUID NOT NULL,
    kind VARCHAR(16) NOT NULL,
    candidate_locator VARCHAR(128) NOT NULL,
    failure_code VARCHAR(64) NOT NULL CHECK (
        failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'claimed')
    ),
    attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (
        attempt_count BETWEEN 0 AND 20
    ),
    available_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    claim_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, kind, candidate_locator),
    FOREIGN KEY (request_id, kind, candidate_locator)
        REFERENCES public.analysis_v2_result_image_objects(
            request_id, kind, candidate_locator
        ) ON DELETE CASCADE,
    CONSTRAINT analysis_v2_result_image_repair_claim_check CHECK (
        (status = 'pending' AND claim_token IS NULL AND lease_expires_at IS NULL)
        OR (
            status = 'claimed'
            AND claim_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
        )
    )
);

-- This table intentionally has no request foreign key. It must survive an owner
-- deleting the request so physical object deletion can be retried.
CREATE TABLE public.analysis_v2_result_image_purge_outbox (
    object_key TEXT PRIMARY KEY CHECK (
        object_key ~ '^v1/[a-f0-9]{32}/(target|female|private)/[a-f0-9]{32}[.]webp$'
        AND object_key !~* 'https?'
    ),
    request_id UUID NOT NULL,
    kind VARCHAR(16) NOT NULL CHECK (
        kind IN ('target', 'female', 'private')
    ),
    candidate_locator VARCHAR(128) NOT NULL,
    reason VARCHAR(16) NOT NULL CHECK (
        reason IN ('owner_delete', 'expired')
    ),
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'claimed')
    ),
    attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (
        attempt_count BETWEEN 0 AND 20
    ),
    available_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    claim_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_v2_result_image_purge_claim_check CHECK (
        (status = 'pending' AND claim_token IS NULL AND lease_expires_at IS NULL)
        OR (
            status = 'claimed'
            AND claim_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
        )
    )
);

CREATE INDEX idx_analysis_v2_result_image_expiry
    ON public.analysis_v2_result_image_objects(expires_at, request_id);
CREATE INDEX idx_analysis_v2_result_image_repair_claim
    ON public.analysis_v2_result_image_repair_outbox(
        status, available_at, lease_expires_at
    );
CREATE INDEX idx_analysis_v2_result_image_purge_claim
    ON public.analysis_v2_result_image_purge_outbox(
        status, available_at, lease_expires_at
    );

ALTER TABLE public.analysis_v2_result_image_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_image_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_image_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_image_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_image_repair_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_image_repair_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_image_purge_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_image_purge_outbox FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.analysis_v2_result_image_manifests
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_result_image_objects
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_result_image_repair_outbox
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_result_image_purge_outbox
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.analysis_v2_result_image_coverage_ok(
    p_expected_rows INTEGER,
    p_durable_rows INTEGER,
    p_sourced_images INTEGER,
    p_ready_images INTEGER,
    p_capture_failed_images INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT
        p_expected_rows BETWEEN 0 AND 50001
        AND p_durable_rows BETWEEN 0 AND p_expected_rows
        AND p_sourced_images BETWEEN 0 AND p_durable_rows
        AND p_ready_images BETWEEN 0 AND p_sourced_images
        AND p_capture_failed_images BETWEEN 0
            AND p_sourced_images - p_ready_images
        AND (
            p_expected_rows = 0
            OR (
                p_durable_rows::NUMERIC / p_expected_rows >= 0.98
                AND p_expected_rows - p_durable_rows <= 5
            )
        )
        AND (
            p_sourced_images = 0
            OR (
                p_ready_images::NUMERIC / p_sourced_images >= 0.95
                AND p_capture_failed_images <= 10
            )
        );
$$;

CREATE FUNCTION public.analysis_v2_assert_result_image_job_fence(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS DISTINCT FROM 'coordinator:finalize'
       OR p_claim_token IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_requests AS analysis_request
            JOIN public.analysis_pipeline_jobs AS job
              ON job.request_id = analysis_request.id
             AND job.job_key = p_job_key
            WHERE analysis_request.id = p_request_id
              AND analysis_request.pipeline_version = 'v2'
              AND analysis_request.status IN ('pending', 'processing')
              AND job.track = 'coordinator'
              AND job.kind = 'finalizer'
              AND job.status = 'processing'
              AND job.input_hash = p_job_input_hash
              AND job.lease_token = p_claim_token
              AND job.lease_expires_at > pg_catalog.clock_timestamp()
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
END;
$$;

CREATE FUNCTION public.begin_analysis_v2_result_image_manifest(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_ordered_manifest_hash TEXT,
    p_expected_rows INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_existing public.analysis_v2_result_image_manifests%ROWTYPE;
BEGIN
    IF p_ordered_manifest_hash !~ '^[a-f0-9]{64}$'
       OR p_expected_rows NOT BETWEEN 0 AND 50001 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    PERFORM public.analysis_v2_assert_result_image_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );

    SELECT manifest.* INTO v_existing
    FROM public.analysis_v2_result_image_manifests AS manifest
    WHERE manifest.request_id = p_request_id
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key IS DISTINCT FROM p_job_key
           OR v_existing.producer_input_hash IS DISTINCT FROM p_job_input_hash
           OR v_existing.ordered_manifest_hash IS DISTINCT FROM
                p_ordered_manifest_hash
           OR v_existing.expected_rows IS DISTINCT FROM p_expected_rows THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_v2_result_image_manifests AS manifest
        SET producer_claim_token = p_claim_token
        WHERE manifest.request_id = p_request_id
          AND manifest.producer_claim_token IS DISTINCT FROM p_claim_token;
        RETURN pg_catalog.jsonb_build_object(
            'requestId', p_request_id,
            'orderedManifestHash', v_existing.ordered_manifest_hash,
            'expectedRows', v_existing.expected_rows,
            'sealed', v_existing.sealed_at IS NOT NULL
        );
    END IF;

    INSERT INTO public.analysis_v2_result_image_manifests (
        request_id, producer_job_key, producer_input_hash,
        producer_claim_token, ordered_manifest_hash, expected_rows
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash,
        p_claim_token, p_ordered_manifest_hash, p_expected_rows
    );
    RETURN pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'orderedManifestHash', p_ordered_manifest_hash,
        'expectedRows', p_expected_rows,
        'sealed', FALSE
    );
END;
$$;

CREATE FUNCTION public.register_analysis_v2_result_image_outcome(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_outcome JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_manifest public.analysis_v2_result_image_manifests%ROWTYPE;
    v_existing public.analysis_v2_result_image_objects%ROWTYPE;
    v_kind TEXT;
    v_locator TEXT;
    v_ordinal INTEGER;
    v_source_fingerprint TEXT;
    v_status TEXT;
    v_object_key TEXT;
    v_sha256 TEXT;
    v_byte_size INTEGER;
    v_captured_at TIMESTAMP WITH TIME ZONE;
    v_expires_at TIMESTAMP WITH TIME ZONE;
    v_failure_code TEXT;
    v_is_mandatory BOOLEAN;
    v_expected_mandatory BOOLEAN;
BEGIN
    PERFORM public.analysis_v2_assert_result_image_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF p_outcome IS NULL
       OR pg_catalog.jsonb_typeof(p_outcome) <> 'object'
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_outcome) AS key_name(value)
            WHERE key_name.value NOT IN (
                'kind', 'candidateLocator', 'sortOrdinal',
                'sourceFingerprint', 'status', 'objectKey', 'sha256',
                'byteSize', 'capturedAt', 'expiresAt', 'failureCode',
                'isMandatory'
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT manifest.* INTO v_manifest
    FROM public.analysis_v2_result_image_manifests AS manifest
    WHERE manifest.request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_manifest.producer_job_key IS DISTINCT FROM p_job_key
       OR v_manifest.producer_input_hash IS DISTINCT FROM p_job_input_hash
       OR v_manifest.producer_claim_token IS DISTINCT FROM p_claim_token
       OR v_manifest.sealed_at IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    BEGIN
        v_kind := p_outcome->>'kind';
        v_locator := p_outcome->>'candidateLocator';
        v_ordinal := (p_outcome->>'sortOrdinal')::INTEGER;
        v_source_fingerprint := NULLIF(p_outcome->>'sourceFingerprint', '');
        v_status := p_outcome->>'status';
        v_object_key := NULLIF(p_outcome->>'objectKey', '');
        v_sha256 := NULLIF(p_outcome->>'sha256', '');
        v_byte_size := NULLIF(p_outcome->>'byteSize', '')::INTEGER;
        v_captured_at := NULLIF(p_outcome->>'capturedAt', '')
            ::TIMESTAMP WITH TIME ZONE;
        v_expires_at := (p_outcome->>'expiresAt')
            ::TIMESTAMP WITH TIME ZONE;
        v_failure_code := NULLIF(p_outcome->>'failureCode', '');
        v_is_mandatory := (p_outcome->>'isMandatory')::BOOLEAN;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_INVALID',
            ERRCODE = 'P0001';
    END;

    v_expected_mandatory := v_source_fingerprint IS NOT NULL
        AND (
            v_kind = 'target'
            OR (v_kind = 'female' AND v_ordinal BETWEEN 1 AND 3)
        );
    IF v_kind NOT IN ('target', 'female', 'private')
       OR v_locator !~ '^[A-Za-z0-9._:-]{1,128}$'
       OR v_locator ~* 'https?'
       OR (
            v_kind = 'target'
            AND (v_locator <> 'target' OR v_ordinal <> 0)
       )
       OR (
            v_kind IN ('female', 'private')
            AND (
                v_locator = 'target'
                OR v_ordinal NOT BETWEEN 1 AND 50000
            )
       )
       OR (
            v_source_fingerprint IS NOT NULL
            AND v_source_fingerprint !~ '^[a-f0-9]{64}$'
       )
       OR v_status NOT IN ('ready', 'source_missing', 'capture_failed')
       OR v_is_mandatory IS DISTINCT FROM v_expected_mandatory
       OR v_expires_at IS NULL
       OR (
            v_status = 'ready'
            AND (
                v_source_fingerprint IS NULL
                OR v_object_key !~
                    '^v1/[a-f0-9]{32}/(target|female|private)/[a-f0-9]{32}[.]webp$'
                OR pg_catalog.strpos(v_object_key, '/' || v_kind || '/') = 0
                OR v_sha256 !~ '^[a-f0-9]{64}$'
                OR v_byte_size NOT BETWEEN 1 AND 131072
                OR v_captured_at IS NULL
                OR v_captured_at > v_now + INTERVAL '5 minutes'
                OR pg_catalog.abs(EXTRACT(
                    epoch FROM (
                        v_expires_at - v_captured_at - INTERVAL '30 days'
                    )
                )) > 3600
                OR v_failure_code IS NOT NULL
            )
       )
       OR (
            v_status = 'source_missing'
            AND (
                v_source_fingerprint IS NOT NULL
                OR pg_catalog.num_nonnulls(
                    v_object_key, v_sha256, v_byte_size, v_captured_at,
                    v_failure_code
                ) <> 0
                OR pg_catalog.abs(EXTRACT(
                    epoch FROM (
                        v_expires_at - v_now - INTERVAL '30 days'
                    )
                )) > 3600
            )
       )
       OR (
            v_status = 'capture_failed'
            AND (
                v_source_fingerprint IS NULL
                OR pg_catalog.num_nonnulls(
                    v_object_key, v_sha256, v_byte_size, v_captured_at
                ) <> 0
                OR v_failure_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
                OR pg_catalog.abs(EXTRACT(
                    epoch FROM (
                        v_expires_at - v_now - INTERVAL '30 days'
                    )
                )) > 3600
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT image_object.* INTO v_existing
    FROM public.analysis_v2_result_image_objects AS image_object
    WHERE image_object.request_id = p_request_id
      AND image_object.kind = v_kind
      AND image_object.candidate_locator = v_locator
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.status = 'capture_failed'
           AND v_status = 'ready'
           AND v_existing.sort_ordinal IS NOT DISTINCT FROM v_ordinal
           AND v_existing.source_fingerprint IS NOT DISTINCT FROM
                v_source_fingerprint
           AND v_existing.is_mandatory IS NOT DISTINCT FROM v_is_mandatory THEN
            UPDATE public.analysis_v2_result_image_objects AS image_object
            SET status = 'ready',
                object_key = v_object_key,
                sha256 = v_sha256,
                byte_size = v_byte_size,
                captured_at = v_captured_at,
                expires_at = v_expires_at,
                failure_code = NULL,
                updated_at = v_now
            WHERE image_object.request_id = p_request_id
              AND image_object.kind = v_kind
              AND image_object.candidate_locator = v_locator;
            DELETE FROM public.analysis_v2_result_image_repair_outbox AS repair
            WHERE repair.request_id = p_request_id
              AND repair.kind = v_kind
              AND repair.candidate_locator = v_locator;
            RETURN pg_catalog.jsonb_build_object(
                'registered', TRUE,
                'status', 'ready'
            );
        END IF;
        IF v_existing.sort_ordinal IS DISTINCT FROM v_ordinal
           OR v_existing.source_fingerprint IS DISTINCT FROM
                v_source_fingerprint
           OR v_existing.status IS DISTINCT FROM v_status
           OR v_existing.object_key IS DISTINCT FROM v_object_key
           OR v_existing.sha256 IS DISTINCT FROM v_sha256
           OR v_existing.byte_size IS DISTINCT FROM v_byte_size
           OR v_existing.captured_at IS DISTINCT FROM v_captured_at
           OR v_existing.expires_at IS DISTINCT FROM v_expires_at
           OR v_existing.failure_code IS DISTINCT FROM v_failure_code
           OR v_existing.is_mandatory IS DISTINCT FROM v_is_mandatory THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'registered', FALSE,
            'status', v_existing.status
        );
    END IF;

    INSERT INTO public.analysis_v2_result_image_objects (
        request_id, kind, candidate_locator, sort_ordinal,
        source_fingerprint, status, object_key, sha256, byte_size,
        captured_at, observed_at, expires_at, failure_code, is_mandatory
    ) VALUES (
        p_request_id, v_kind, v_locator, v_ordinal,
        v_source_fingerprint, v_status, v_object_key, v_sha256, v_byte_size,
        v_captured_at, v_now, v_expires_at, v_failure_code, v_is_mandatory
    );

    IF v_status = 'capture_failed' THEN
        INSERT INTO public.analysis_v2_result_image_repair_outbox (
            request_id, kind, candidate_locator, failure_code
        ) VALUES (
            p_request_id, v_kind, v_locator, v_failure_code
        )
        ON CONFLICT (request_id, kind, candidate_locator) DO UPDATE
        SET failure_code = EXCLUDED.failure_code,
            status = 'pending',
            claim_token = NULL,
            lease_expires_at = NULL,
            updated_at = v_now;
    END IF;
    RETURN pg_catalog.jsonb_build_object(
        'registered', TRUE,
        'status', v_status
    );
END;
$$;

CREATE FUNCTION public.seal_analysis_v2_result_image_manifest(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_ordered_manifest_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_manifest public.analysis_v2_result_image_manifests%ROWTYPE;
    v_durable_rows INTEGER;
    v_sourced_images INTEGER;
    v_ready_images INTEGER;
    v_capture_failed_images INTEGER;
BEGIN
    PERFORM public.analysis_v2_assert_result_image_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    SELECT manifest.* INTO v_manifest
    FROM public.analysis_v2_result_image_manifests AS manifest
    WHERE manifest.request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_manifest.producer_job_key IS DISTINCT FROM p_job_key
       OR v_manifest.producer_input_hash IS DISTINCT FROM p_job_input_hash
       OR v_manifest.producer_claim_token IS DISTINCT FROM p_claim_token
       OR v_manifest.ordered_manifest_hash IS DISTINCT FROM
            p_ordered_manifest_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT
        pg_catalog.count(*)::INTEGER,
        pg_catalog.count(*) FILTER (
            WHERE image_object.source_fingerprint IS NOT NULL
        )::INTEGER,
        pg_catalog.count(*) FILTER (
            WHERE image_object.status = 'ready'
        )::INTEGER,
        pg_catalog.count(*) FILTER (
            WHERE image_object.status = 'capture_failed'
        )::INTEGER
    INTO
        v_durable_rows, v_sourced_images, v_ready_images,
        v_capture_failed_images
    FROM public.analysis_v2_result_image_objects AS image_object
    WHERE image_object.request_id = p_request_id;

    IF NOT public.analysis_v2_result_image_coverage_ok(
        v_manifest.expected_rows,
        v_durable_rows,
        v_sourced_images,
        v_ready_images,
        v_capture_failed_images
    )
       OR (
            v_manifest.expected_rows > 0
            AND NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_result_image_objects AS target_image
                WHERE target_image.request_id = p_request_id
                  AND target_image.kind = 'target'
                  AND target_image.candidate_locator = 'target'
            )
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_result_image_objects AS image_object
            WHERE image_object.request_id = p_request_id
              AND image_object.is_mandatory
              AND image_object.status <> 'ready'
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_result_image_objects AS image_object
            WHERE image_object.request_id = p_request_id
              AND image_object.status = 'ready'
              AND image_object.expires_at <= v_now
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_MANIFEST_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    IF v_manifest.sealed_at IS NOT NULL THEN
        IF v_manifest.durable_rows IS DISTINCT FROM v_durable_rows
           OR v_manifest.sourced_images IS DISTINCT FROM v_sourced_images
           OR v_manifest.ready_images IS DISTINCT FROM v_ready_images
           OR v_manifest.capture_failed_images IS DISTINCT FROM
                v_capture_failed_images THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    ELSE
        UPDATE public.analysis_v2_result_image_manifests AS manifest
        SET durable_rows = v_durable_rows,
            sourced_images = v_sourced_images,
            ready_images = v_ready_images,
            capture_failed_images = v_capture_failed_images,
            sealed_at = v_now
        WHERE manifest.request_id = p_request_id;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'orderedManifestHash', p_ordered_manifest_hash,
        'expectedRows', v_manifest.expected_rows,
        'durableRows', v_durable_rows,
        'sourcedImages', v_sourced_images,
        'readyImages', v_ready_images,
        'captureFailedImages', v_capture_failed_images
    );
END;
$$;

CREATE FUNCTION public.load_analysis_v2_result_image_manifest_page(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_after_ordinal INTEGER,
    p_page_size INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_after_ordinal NOT BETWEEN -1 AND 50000
       OR p_page_size NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    PERFORM public.analysis_v2_assert_result_image_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    RETURN COALESCE((
        SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'kind', page.kind,
                'candidateLocator', page.candidate_locator,
                'sortOrdinal', page.sort_ordinal,
                'sourceFingerprint', page.source_fingerprint,
                'status', page.status,
                'objectKey', page.object_key,
                'sha256', page.sha256,
                'byteSize', page.byte_size,
                'capturedAt', page.captured_at,
                'expiresAt', page.expires_at,
                'failureCode', page.failure_code,
                'isMandatory', page.is_mandatory
            )
            ORDER BY page.sort_ordinal
        )
        FROM (
            SELECT image_object.*
            FROM public.analysis_v2_result_image_objects AS image_object
            WHERE image_object.request_id = p_request_id
              AND image_object.sort_ordinal > p_after_ordinal
            ORDER BY image_object.sort_ordinal
            LIMIT p_page_size
        ) AS page
    ), '[]'::JSONB);
END;
$$;

CREATE FUNCTION public.claim_analysis_v2_result_image_repairs(
    p_claim_token UUID,
    p_limit INTEGER,
    p_lease_seconds INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_rows JSONB;
BEGIN
    IF p_claim_token IS NULL
       OR p_limit NOT BETWEEN 1 AND 100
       OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    WITH claimable AS (
        SELECT repair.request_id, repair.kind, repair.candidate_locator
        FROM public.analysis_v2_result_image_repair_outbox AS repair
        WHERE repair.available_at <= v_now
          AND (
            repair.status = 'pending'
            OR (
                repair.status = 'claimed'
                AND repair.lease_expires_at <= v_now
            )
          )
        ORDER BY repair.available_at, repair.request_id,
            repair.kind, repair.candidate_locator
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ),
    claimed AS (
        UPDATE public.analysis_v2_result_image_repair_outbox AS repair
        SET status = 'claimed',
            claim_token = p_claim_token,
            lease_expires_at = v_now
                + pg_catalog.make_interval(secs => p_lease_seconds),
            attempt_count = repair.attempt_count + 1,
            updated_at = v_now
        FROM claimable
        WHERE repair.request_id = claimable.request_id
          AND repair.kind = claimable.kind
          AND repair.candidate_locator = claimable.candidate_locator
        RETURNING repair.request_id, repair.kind,
            repair.candidate_locator, repair.failure_code
    )
    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'requestId', claimed.request_id,
            'kind', claimed.kind,
            'candidateLocator', claimed.candidate_locator,
            'failureCode', claimed.failure_code
        )
        ORDER BY claimed.request_id, claimed.kind,
            claimed.candidate_locator
    ), '[]'::JSONB)
    INTO v_rows
    FROM claimed;
    RETURN v_rows;
END;
$$;

CREATE FUNCTION public.complete_analysis_v2_result_image_repair(
    p_request_id UUID,
    p_kind TEXT,
    p_candidate_locator TEXT,
    p_claim_token UUID,
    p_success BOOLEAN,
    p_failure_code TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF p_request_id IS NULL OR p_claim_token IS NULL
       OR p_kind NOT IN ('target', 'female', 'private')
       OR p_candidate_locator !~ '^[A-Za-z0-9._:-]{1,128}$'
       OR (
            p_success
            AND p_failure_code IS NOT NULL
       )
       OR (
            NOT p_success
            AND p_failure_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    IF p_success THEN
        DELETE FROM public.analysis_v2_result_image_repair_outbox AS repair
        WHERE repair.request_id = p_request_id
          AND repair.kind = p_kind
          AND repair.candidate_locator = p_candidate_locator
          AND repair.status = 'claimed'
          AND repair.claim_token = p_claim_token
          AND repair.lease_expires_at > v_now;
    ELSE
        UPDATE public.analysis_v2_result_image_repair_outbox AS repair
        SET status = 'pending',
            failure_code = p_failure_code,
            available_at = v_now + INTERVAL '5 minutes',
            claim_token = NULL,
            lease_expires_at = NULL,
            updated_at = v_now
        WHERE repair.request_id = p_request_id
          AND repair.kind = p_kind
          AND repair.candidate_locator = p_candidate_locator
          AND repair.status = 'claimed'
          AND repair.claim_token = p_claim_token
          AND repair.lease_expires_at > v_now;
    END IF;
    RETURN FOUND;
END;
$$;

CREATE FUNCTION public.claim_analysis_v2_result_image_purges(
    p_claim_token UUID,
    p_limit INTEGER,
    p_lease_seconds INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_rows JSONB;
BEGIN
    IF p_claim_token IS NULL
       OR p_limit NOT BETWEEN 1 AND 100
       OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_v2_result_image_purge_outbox (
        object_key, request_id, kind, candidate_locator, reason
    )
    SELECT image_object.object_key, image_object.request_id,
        image_object.kind, image_object.candidate_locator, 'expired'
    FROM public.analysis_v2_result_image_objects AS image_object
    WHERE image_object.status = 'ready'
      AND image_object.expires_at <= v_now
    ON CONFLICT (object_key) DO NOTHING;

    WITH claimable AS (
        SELECT purge.object_key
        FROM public.analysis_v2_result_image_purge_outbox AS purge
        WHERE purge.available_at <= v_now
          AND (
            purge.status = 'pending'
            OR (
                purge.status = 'claimed'
                AND purge.lease_expires_at <= v_now
            )
          )
        ORDER BY purge.available_at, purge.object_key
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ),
    claimed AS (
        UPDATE public.analysis_v2_result_image_purge_outbox AS purge
        SET status = 'claimed',
            claim_token = p_claim_token,
            lease_expires_at = v_now
                + pg_catalog.make_interval(secs => p_lease_seconds),
            attempt_count = purge.attempt_count + 1,
            updated_at = v_now
        FROM claimable
        WHERE purge.object_key = claimable.object_key
        RETURNING purge.object_key, purge.reason
    )
    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'objectKey', claimed.object_key,
            'reason', claimed.reason
        )
        ORDER BY claimed.object_key
    ), '[]'::JSONB)
    INTO v_rows
    FROM claimed;
    RETURN v_rows;
END;
$$;

CREATE FUNCTION public.complete_analysis_v2_result_image_purge(
    p_object_key TEXT,
    p_claim_token UUID,
    p_deleted BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request_id UUID;
    v_kind TEXT;
    v_candidate_locator TEXT;
BEGIN
    IF p_claim_token IS NULL
       OR p_object_key !~
            '^v1/[a-f0-9]{32}/(target|female|private)/[a-f0-9]{32}[.]webp$'
       OR NOT p_deleted THEN
        RETURN FALSE;
    END IF;
    DELETE FROM public.analysis_v2_result_image_purge_outbox AS purge
    WHERE purge.object_key = p_object_key
      AND purge.status = 'claimed'
      AND purge.claim_token = p_claim_token
      AND purge.lease_expires_at > v_now
    RETURNING purge.request_id, purge.kind, purge.candidate_locator
    INTO v_request_id, v_kind, v_candidate_locator;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    DELETE FROM public.analysis_v2_result_image_objects AS image_object
    WHERE image_object.request_id = v_request_id
      AND image_object.kind = v_kind
      AND image_object.candidate_locator = v_candidate_locator
      AND image_object.object_key = p_object_key
      AND image_object.expires_at <= v_now;
    RETURN TRUE;
END;
$$;

CREATE FUNCTION public.enqueue_analysis_v2_result_image_purges_before_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.analysis_v2_result_image_purge_outbox (
        object_key, request_id, kind, candidate_locator, reason
    )
    SELECT image_object.object_key, image_object.request_id,
        image_object.kind, image_object.candidate_locator, 'owner_delete'
    FROM public.analysis_v2_result_image_objects AS image_object
    WHERE image_object.request_id = OLD.id
      AND image_object.status = 'ready'
    ON CONFLICT (object_key) DO NOTHING;
    RETURN OLD;
END;
$$;

CREATE TRIGGER enqueue_analysis_v2_result_image_purges_before_delete
BEFORE DELETE ON public.analysis_requests
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_analysis_v2_result_image_purges_before_delete();

CREATE FUNCTION public.complete_analysis_v2_result_and_purge_with_images(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_target_profile_image_url TEXT,
    p_image_manifest_hash TEXT,
    p_image_expected_rows INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_manifest public.analysis_v2_result_image_manifests%ROWTYPE;
BEGIN
    SELECT manifest.* INTO v_manifest
    FROM public.analysis_v2_result_image_manifests AS manifest
    WHERE manifest.request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_manifest.producer_job_key IS DISTINCT FROM p_job_key
       OR v_manifest.producer_input_hash IS DISTINCT FROM p_job_input_hash
       OR v_manifest.producer_claim_token IS DISTINCT FROM p_claim_token
       OR v_manifest.ordered_manifest_hash IS DISTINCT FROM p_image_manifest_hash
       OR v_manifest.expected_rows IS DISTINCT FROM p_image_expected_rows
       OR v_manifest.sealed_at IS NULL
       OR NOT public.analysis_v2_result_image_coverage_ok(
            v_manifest.expected_rows,
            v_manifest.durable_rows,
            v_manifest.sourced_images,
            v_manifest.ready_images,
            v_manifest.capture_failed_images
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_result_image_objects AS image_object
            WHERE image_object.request_id = p_request_id
              AND image_object.is_mandatory
              AND image_object.status <> 'ready'
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_result_image_objects AS image_object
            WHERE image_object.request_id = p_request_id
              AND image_object.status = 'ready'
              AND image_object.expires_at <= pg_catalog.clock_timestamp()
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_IMAGE_MANIFEST_NOT_READY',
            ERRCODE = 'P0001';
    END IF;
    RETURN public.complete_analysis_v2_result_and_purge(
        p_request_id,
        p_job_key,
        p_claim_token,
        p_job_input_hash,
        p_target_profile_image_url
    );
END;
$$;

CREATE FUNCTION public.load_analysis_v2_result_image_object(
    p_request_id UUID,
    p_user_id UUID,
    p_kind TEXT,
    p_candidate_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_locator TEXT;
    v_result JSONB;
BEGIN
    IF p_request_id IS NULL OR p_user_id IS NULL
       OR p_kind NOT IN ('target', 'female', 'private')
       OR (
            p_kind = 'target'
            AND p_candidate_id IS NOT NULL
       )
       OR (
            p_kind <> 'target'
            AND (
                p_candidate_id IS NULL
                OR p_candidate_id !~ '^[A-Za-z0-9._:-]{1,128}$'
                OR p_candidate_id ~* 'https?'
            )
       ) THEN
        RETURN NULL;
    END IF;
    v_locator := CASE
        WHEN p_kind = 'target' THEN 'target'
        ELSE p_candidate_id
    END;
    SELECT pg_catalog.jsonb_build_object(
        'objectKey', image_object.object_key,
        'sha256', image_object.sha256,
        'byteSize', image_object.byte_size,
        'expiresAt', image_object.expires_at
    )
    INTO v_result
    FROM public.analysis_requests AS analysis_request
    JOIN public.analysis_v2_result_image_objects AS image_object
      ON image_object.request_id = analysis_request.id
     AND image_object.kind = p_kind
     AND image_object.candidate_locator = v_locator
    WHERE analysis_request.id = p_request_id
      AND analysis_request.user_id = p_user_id
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status = 'completed'
      AND image_object.status = 'ready'
      AND image_object.expires_at > pg_catalog.clock_timestamp();
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_result_image_coverage_ok(
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_assert_result_image_job_fence(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.begin_analysis_v2_result_image_manifest(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.register_analysis_v2_result_image_outcome(
    UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seal_analysis_v2_result_image_manifest(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.load_analysis_v2_result_image_manifest_page(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_analysis_v2_result_image_repairs(
    UUID, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_analysis_v2_result_image_repair(
    UUID, TEXT, TEXT, UUID, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_analysis_v2_result_image_purges(
    UUID, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_analysis_v2_result_image_purge(
    TEXT, UUID, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enqueue_analysis_v2_result_image_purges_before_delete()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_analysis_v2_result_and_purge_with_images(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.load_analysis_v2_result_image_object(
    UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.analysis_v2_result_image_coverage_ok(
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_analysis_v2_result_image_manifest(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_analysis_v2_result_image_outcome(
    UUID, TEXT, UUID, TEXT, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.seal_analysis_v2_result_image_manifest(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_result_image_manifest_page(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_result_image_repairs(
    UUID, INTEGER, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_result_image_repair(
    UUID, TEXT, TEXT, UUID, BOOLEAN, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_result_image_purges(
    UUID, INTEGER, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_result_image_purge(
    TEXT, UUID, BOOLEAN
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_result_and_purge_with_images(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_result_image_object(
    UUID, UUID, TEXT, TEXT
) TO service_role;
