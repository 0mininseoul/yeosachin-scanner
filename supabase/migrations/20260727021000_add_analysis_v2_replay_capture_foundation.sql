-- Opt-in replay capture metadata only. Encrypted bytes remain in a separate private bucket.
-- No capture hook is installed by this migration.

-- This single exact predicate is the forward-only replay policy fence. A policy
-- rollout must update this function and its contract fixture together.
CREATE OR REPLACE FUNCTION public.analysis_v2_replay_capture_policy_is_exact(
    p_snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT p_snapshot IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_snapshot) = 'object'
       AND p_snapshot ?& ARRAY['pipeline', 'risk', 'aiStage', 'scheduler']
       AND p_snapshot - ARRAY['pipeline', 'risk', 'aiStage', 'scheduler']
            = '{}'::JSONB
       AND p_snapshot->>'pipeline' = 'v2'
       AND p_snapshot->>'risk' = 'risk-policy-v2.4'
       AND p_snapshot->>'aiStage' = 'ai-stage-policy-v2.7'
       AND p_snapshot->>'scheduler' = 'ai-scheduler-v1'
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_replay_capture_policy_is_exact(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.analysis_v2_replay_capture_authorizations (
    capture_id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    preflight_id UUID NOT NULL UNIQUE REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    request_id UUID UNIQUE REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    owner_user_id UUID NOT NULL,
    target_handle_commitment VARCHAR(64) NOT NULL
        CHECK (target_handle_commitment ~ '^[a-f0-9]{64}$'),
    purpose TEXT NOT NULL DEFAULT 'authorized_standard_e2e'
        CHECK (purpose = 'authorized_standard_e2e'),
    state TEXT NOT NULL DEFAULT 'armed'
        CHECK (state IN ('armed', 'capturing', 'sealed', 'failed', 'expired', 'deleting', 'deleted')),
    recipient_key_fingerprint VARCHAR(64) NOT NULL CHECK (recipient_key_fingerprint ~ '^[a-f0-9]{64}$'),
    expected_policy_hash VARCHAR(64) NOT NULL CHECK (expected_policy_hash ~ '^[a-f0-9]{64}$'),
    expected_snapshot_hash VARCHAR(64) NOT NULL CHECK (expected_snapshot_hash ~ '^[a-f0-9]{64}$'),
    expected_context_hash VARCHAR(64) NOT NULL CHECK (expected_context_hash ~ '^[a-f0-9]{64}$'),
    scheduler_policy_version TEXT NOT NULL
        CHECK (scheduler_policy_version = 'ai-scheduler-v1'),
    armed_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    arm_expires_at TIMESTAMPTZ NOT NULL,
    artifact_expires_at TIMESTAMPTZ NOT NULL,
    expected_public_count INTEGER CHECK (expected_public_count BETWEEN 0 AND 256),
    expected_private_count INTEGER CHECK (expected_private_count BETWEEN 0 AND 256),
    expected_fragment_count INTEGER NOT NULL CHECK (expected_fragment_count BETWEEN 1 AND 128),
    actual_public_count INTEGER CHECK (actual_public_count BETWEEN 0 AND 256),
    actual_private_count INTEGER CHECK (actual_private_count BETWEEN 0 AND 256),
    actual_fragment_count INTEGER NOT NULL DEFAULT 0 CHECK (actual_fragment_count BETWEEN 0 AND 128),
    actual_ciphertext_byte_size BIGINT NOT NULL DEFAULT 0
        CHECK (actual_ciphertext_byte_size BETWEEN 0 AND 67108864),
    manifest_hash VARCHAR(64) CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
    failure_code VARCHAR(64) CHECK (failure_code ~ '^[A-Z0-9_]{1,64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    bound_at TIMESTAMPTZ,
    sealed_at TIMESTAMPTZ,
    write_lease_token UUID NOT NULL,
    write_lease_acquired_at TIMESTAMPTZ NOT NULL,
    write_lease_expires_at TIMESTAMPTZ NOT NULL,
    CHECK (arm_expires_at > armed_at AND arm_expires_at <= armed_at + INTERVAL '4 hours'),
    CHECK (artifact_expires_at >= arm_expires_at AND artifact_expires_at <= armed_at + INTERVAL '24 hours'),
    CHECK (write_lease_acquired_at >= armed_at
        AND write_lease_expires_at > write_lease_acquired_at
        AND write_lease_expires_at <= write_lease_acquired_at + INTERVAL '15 minutes'
        AND write_lease_expires_at <= arm_expires_at
        AND write_lease_expires_at <= artifact_expires_at),
    CHECK ((state <> 'armed') OR (request_id IS NULL AND bound_at IS NULL AND sealed_at IS NULL
        AND manifest_hash IS NULL AND actual_fragment_count = 0 AND actual_ciphertext_byte_size = 0)),
    CHECK ((state <> 'capturing') OR (request_id IS NOT NULL AND bound_at IS NOT NULL AND sealed_at IS NULL)),
    CHECK ((state <> 'sealed') OR (request_id IS NOT NULL AND bound_at IS NOT NULL
        AND sealed_at IS NOT NULL AND manifest_hash IS NOT NULL
        AND actual_fragment_count = expected_fragment_count
        AND actual_public_count IS NOT DISTINCT FROM expected_public_count
        AND actual_private_count IS NOT DISTINCT FROM expected_private_count)),
    CHECK (actual_public_count IS NULL OR expected_public_count IS NULL OR actual_public_count <= expected_public_count),
    CHECK (actual_private_count IS NULL OR expected_private_count IS NULL OR actual_private_count <= expected_private_count),
    CHECK (actual_fragment_count <= expected_fragment_count)
);

CREATE TABLE public.analysis_v2_replay_capture_fragments (
    capture_id UUID NOT NULL REFERENCES public.analysis_v2_replay_capture_authorizations(capture_id) ON DELETE CASCADE,
    opaque_locator_hash VARCHAR(64) NOT NULL CHECK (opaque_locator_hash ~ '^[a-f0-9]{64}$'),
    fragment_kind VARCHAR(32) NOT NULL CHECK (fragment_kind IN ('provider_payload', 'normalized_snapshot', 'execution_trace')),
    stage VARCHAR(32) NOT NULL CHECK (stage IN ('preflight', 'collection', 'scoring', 'finalization')),
    batch_ordinal INTEGER NOT NULL CHECK (batch_ordinal BETWEEN 0 AND 127),
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 1023),
    object_key TEXT NOT NULL UNIQUE,
    ciphertext_sha256 VARCHAR(64) NOT NULL CHECK (ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
    content_commitment VARCHAR(64) NOT NULL CHECK (content_commitment ~ '^[a-f0-9]{64}$'),
    ciphertext_byte_size INTEGER NOT NULL CHECK (ciphertext_byte_size BETWEEN 1 AND 8388608),
    envelope_version SMALLINT NOT NULL CHECK (envelope_version = 1),
    expires_at TIMESTAMPTZ NOT NULL,
    cleanup_status TEXT NOT NULL DEFAULT 'pending' CHECK (cleanup_status IN ('pending', 'leased', 'deleted', 'failed')),
    cleanup_lease_token UUID,
    cleanup_lease_acquired_at TIMESTAMPTZ,
    cleanup_lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (capture_id, opaque_locator_hash, fragment_kind, stage, batch_ordinal, ordinal),
    CHECK (
        object_key = 'replay/v1/' || capture_id::TEXT || '/'
            || pg_catalog.encode(
                extensions.digest(
                    'replay/v1' || pg_catalog.chr(10)
                    || capture_id::TEXT || pg_catalog.chr(10)
                    || opaque_locator_hash || pg_catalog.chr(10)
                    || fragment_kind || pg_catalog.chr(10)
                    || stage || pg_catalog.chr(10)
                    || batch_ordinal::TEXT || pg_catalog.chr(10)
                    || ordinal::TEXT,
                    'sha256'
                ),
                'hex'
            )
            || '.enc'
    ),
    CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '24 hours'),
    CHECK (
        (cleanup_status = 'leased' AND cleanup_lease_token IS NOT NULL
            AND cleanup_lease_acquired_at IS NOT NULL
            AND cleanup_lease_expires_at IS NOT NULL
            AND cleanup_lease_acquired_at >= expires_at
            AND cleanup_lease_expires_at > cleanup_lease_acquired_at
            AND cleanup_lease_expires_at <= cleanup_lease_acquired_at + INTERVAL '15 minutes')
        OR (cleanup_status <> 'leased' AND cleanup_lease_token IS NULL
            AND cleanup_lease_acquired_at IS NULL AND cleanup_lease_expires_at IS NULL)
    )
);

CREATE TABLE public.analysis_v2_replay_capture_audit_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    capture_id UUID NOT NULL REFERENCES public.analysis_v2_replay_capture_authorizations(capture_id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN ('arm', 'bind', 'register', 'seal', 'export', 'delete')),
    operator_fingerprint VARCHAR(64) NOT NULL CHECK (operator_fingerprint ~ '^[a-f0-9]{64}$'),
    reason_code VARCHAR(64) NOT NULL CHECK (reason_code ~ '^[A-Z0-9_]{1,64}$'),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.analysis_v2_replay_capture_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_replay_capture_authorizations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_replay_capture_fragments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_replay_capture_fragments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_replay_capture_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_replay_capture_audit_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.analysis_v2_replay_capture_authorizations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_replay_capture_fragments FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_replay_capture_audit_events FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.arm_analysis_v2_replay_capture(
    p_preflight_id UUID,
    p_expected_policy_hash TEXT,
    p_expected_context_hash TEXT,
    p_recipient_key_fingerprint TEXT,
    p_expected_public_count INTEGER,
    p_expected_private_count INTEGER,
    p_expected_fragment_count INTEGER,
    p_operator_fingerprint TEXT,
    p_reason_code TEXT
)
RETURNS TABLE (
    capture_id UUID,
    write_lease_token UUID,
    write_lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_capture_id UUID;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_policy_hash TEXT;
    v_snapshot_hash TEXT;
    v_context_hash TEXT;
    v_target TEXT;
    v_target_commitment TEXT;
    v_write_lease_token UUID;
    v_write_lease_expires_at TIMESTAMPTZ;
BEGIN
    IF p_expected_policy_hash !~ '^[a-f0-9]{64}$'
       OR p_expected_context_hash !~ '^[a-f0-9]{64}$'
       OR p_recipient_key_fingerprint !~ '^[a-f0-9]{64}$'
       OR p_operator_fingerprint !~ '^[a-f0-9]{64}$'
       OR p_reason_code !~ '^[A-Z0-9_]{1,64}$'
       OR p_expected_public_count NOT BETWEEN 0 AND 256
       OR p_expected_private_count NOT BETWEEN 0 AND 256
       OR p_expected_fragment_count NOT BETWEEN 1 AND 128 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_CAPTURE_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.status = 'ready'
      AND preflight.access_mode = 'production'
      AND preflight.consumed_request_id IS NULL
      AND preflight.expires_at > v_now
      AND preflight.user_id IS NOT NULL
      AND pg_catalog.lower(pg_catalog.btrim(preflight.target_instagram_id))
            ~ '^[a-z0-9._]{1,30}$'
      AND public.analysis_v2_replay_capture_policy_is_exact(
            preflight.policy_versions_snapshot
      )
      AND preflight.plan_cards_snapshot->'standard'->>'launchStatus' = 'production'
      AND preflight.plan_cards_snapshot->'standard'->>'selectionState' IN ('required', 'available_upgrade')
      AND preflight.target_followers_count BETWEEN 0
          AND (preflight.plan_cards_snapshot->'standard'->'relationshipCapacity'->>'followers')::INTEGER
      AND preflight.target_following_count BETWEEN 0
          AND (preflight.plan_cards_snapshot->'standard'->'relationshipCapacity'->>'following')::INTEGER
      AND (preflight.plan_cards_snapshot->'standard'->'relationshipCapacity'->>'followers')::INTEGER BETWEEN 1 AND 10000000
      AND (preflight.plan_cards_snapshot->'standard'->'relationshipCapacity'->>'following')::INTEGER BETWEEN 1 AND 10000000
      AND (preflight.plan_cards_snapshot->'standard'->>'detailedMutualLimit')::INTEGER BETWEEN 1 AND 100000
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_CAPTURE_PREFLIGHT_REJECTED', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.analysis_v2_replay_capture_authorizations WHERE preflight_id = p_preflight_id) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_CAPTURE_ALREADY_ARMED', ERRCODE = 'P0001';
    END IF;
    v_target := pg_catalog.lower(pg_catalog.btrim(v_preflight.target_instagram_id));
    v_policy_hash := pg_catalog.encode(extensions.digest(v_preflight.policy_versions_snapshot::TEXT, 'sha256'), 'hex');
    IF v_policy_hash IS DISTINCT FROM p_expected_policy_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_CAPTURE_POLICY_MISMATCH', ERRCODE = 'P0001';
    END IF;
    v_context_hash := pg_catalog.encode(
        extensions.digest(
            'replay-capture-context-v1' || pg_catalog.chr(10)
            || v_preflight.user_id::TEXT || pg_catalog.chr(10)
            || v_target || pg_catalog.chr(10)
            || v_preflight.policy_versions_snapshot::TEXT,
            'sha256'
        ),
        'hex'
    );
    IF v_context_hash IS DISTINCT FROM p_expected_context_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_CAPTURE_CONTEXT_MISMATCH', ERRCODE = 'P0001';
    END IF;
    v_target_commitment := pg_catalog.encode(
        extensions.digest(
            'replay-target-v1' || pg_catalog.chr(10)
            || v_preflight.user_id::TEXT || pg_catalog.chr(10) || v_target,
            'sha256'
        ),
        'hex'
    );
    v_snapshot_hash := pg_catalog.encode(extensions.digest(pg_catalog.jsonb_build_object('policy', v_preflight.policy_versions_snapshot, 'planCards', v_preflight.plan_cards_snapshot)::TEXT, 'sha256'), 'hex');
    v_write_lease_token := extensions.gen_random_uuid();
    v_write_lease_expires_at := v_now + INTERVAL '15 minutes';
    INSERT INTO public.analysis_v2_replay_capture_authorizations AS inserted_authorization (
        preflight_id, owner_user_id, target_handle_commitment,
        recipient_key_fingerprint, expected_policy_hash, expected_snapshot_hash,
        expected_context_hash, scheduler_policy_version,
        armed_at, arm_expires_at, artifact_expires_at,
        write_lease_token, write_lease_acquired_at, write_lease_expires_at,
        expected_public_count, expected_private_count, expected_fragment_count
    ) VALUES (
        p_preflight_id, v_preflight.user_id, v_target_commitment,
        p_recipient_key_fingerprint, p_expected_policy_hash, v_snapshot_hash,
        p_expected_context_hash, 'ai-scheduler-v1',
        v_now,
        v_now + INTERVAL '4 hours', v_now + INTERVAL '24 hours',
        v_write_lease_token, v_now, v_write_lease_expires_at,
        p_expected_public_count, p_expected_private_count, p_expected_fragment_count
    ) RETURNING inserted_authorization.capture_id INTO v_capture_id;
    INSERT INTO public.analysis_v2_replay_capture_audit_events (capture_id, event_type, operator_fingerprint, reason_code)
    VALUES (v_capture_id, 'arm', p_operator_fingerprint, p_reason_code);
    RETURN QUERY SELECT
        v_capture_id,
        v_write_lease_token,
        v_write_lease_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.bind_analysis_v2_replay_capture(
    p_capture_id UUID, p_request_id UUID, p_operator_fingerprint TEXT, p_reason_code TEXT
)
RETURNS TABLE (
    write_lease_token UUID,
    write_lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_capture public.analysis_v2_replay_capture_authorizations%ROWTYPE;
    v_policy_hash TEXT;
    v_snapshot_hash TEXT;
    v_context_hash TEXT;
    v_target_commitment TEXT;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_write_lease_token UUID;
    v_write_lease_expires_at TIMESTAMPTZ;
BEGIN
    IF p_operator_fingerprint !~ '^[a-f0-9]{64}$' OR p_reason_code !~ '^[A-Z0-9_]{1,64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_CAPTURE_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_capture FROM public.analysis_v2_replay_capture_authorizations WHERE capture_id = p_capture_id FOR UPDATE;
    IF NOT FOUND OR v_capture.state <> 'armed'
       OR v_capture.arm_expires_at <= v_now
       OR v_capture.artifact_expires_at <= v_now
       OR v_capture.request_id IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_CAPTURE_BIND_REJECTED', ERRCODE = 'P0001';
    END IF;
    SELECT
        pg_catalog.encode(extensions.digest(analysis_request.policy_versions_snapshot::TEXT, 'sha256'), 'hex'),
        pg_catalog.encode(extensions.digest(pg_catalog.jsonb_build_object('policy', analysis_request.policy_versions_snapshot, 'planCards', analysis_request.plan_cards_snapshot)::TEXT, 'sha256'), 'hex'),
        pg_catalog.encode(extensions.digest(
            'replay-capture-context-v1' || pg_catalog.chr(10)
            || analysis_request.user_id::TEXT || pg_catalog.chr(10)
            || pg_catalog.lower(pg_catalog.btrim(analysis_request.target_instagram_id))
            || pg_catalog.chr(10) || analysis_request.policy_versions_snapshot::TEXT,
            'sha256'
        ), 'hex'),
        pg_catalog.encode(extensions.digest(
            'replay-target-v1' || pg_catalog.chr(10)
            || analysis_request.user_id::TEXT || pg_catalog.chr(10)
            || pg_catalog.lower(pg_catalog.btrim(analysis_request.target_instagram_id)),
            'sha256'
        ), 'hex')
    INTO v_policy_hash, v_snapshot_hash, v_context_hash, v_target_commitment
    FROM public.analysis_requests AS analysis_request
    JOIN public.analysis_preflights AS preflight ON preflight.id = analysis_request.preflight_id
    WHERE analysis_request.id = p_request_id
      AND analysis_request.preflight_id = v_capture.preflight_id
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status IN ('pending', 'processing')
      AND analysis_request.selected_plan_id_snapshot = 'standard'
      AND analysis_request.plan_access_mode_snapshot = 'production'
      AND analysis_request.user_id = preflight.user_id
      AND analysis_request.user_id = v_capture.owner_user_id
      AND pg_catalog.lower(pg_catalog.btrim(analysis_request.target_instagram_id))
            = pg_catalog.lower(pg_catalog.btrim(preflight.target_instagram_id))
      AND public.analysis_v2_replay_capture_policy_is_exact(
            analysis_request.policy_versions_snapshot
      )
      AND preflight.status = 'consumed'
      AND preflight.consumed_request_id = analysis_request.id;
    IF NOT FOUND
       OR v_policy_hash IS DISTINCT FROM v_capture.expected_policy_hash
       OR v_snapshot_hash IS DISTINCT FROM v_capture.expected_snapshot_hash
       OR v_context_hash IS DISTINCT FROM v_capture.expected_context_hash
       OR v_target_commitment IS DISTINCT FROM v_capture.target_handle_commitment THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_CAPTURE_BIND_REJECTED', ERRCODE = 'P0001';
    END IF;
    v_write_lease_token := extensions.gen_random_uuid();
    v_write_lease_expires_at := CASE
        WHEN v_now + INTERVAL '15 minutes' < v_capture.arm_expires_at
            THEN v_now + INTERVAL '15 minutes'
        ELSE v_capture.arm_expires_at
    END;
    UPDATE public.analysis_v2_replay_capture_authorizations
    SET request_id = p_request_id,
        state = 'capturing',
        bound_at = v_now,
        write_lease_token = v_write_lease_token,
        write_lease_acquired_at = v_now,
        write_lease_expires_at = v_write_lease_expires_at,
        updated_at = v_now
    WHERE capture_id = p_capture_id;
    INSERT INTO public.analysis_v2_replay_capture_audit_events (capture_id, event_type, operator_fingerprint, reason_code)
    VALUES (p_capture_id, 'bind', p_operator_fingerprint, p_reason_code);
    RETURN QUERY SELECT v_write_lease_token, v_write_lease_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.register_analysis_v2_replay_capture_fragment(
    p_capture_id UUID, p_write_lease_token UUID,
    p_opaque_locator_hash TEXT, p_fragment_kind TEXT, p_stage TEXT,
    p_batch_ordinal INTEGER, p_ordinal INTEGER, p_object_key TEXT, p_ciphertext_sha256 TEXT,
    p_ciphertext_byte_size INTEGER, p_envelope_version SMALLINT,
    p_content_commitment TEXT, p_operator_fingerprint TEXT, p_reason_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_capture public.analysis_v2_replay_capture_authorizations%ROWTYPE;
    v_existing public.analysis_v2_replay_capture_fragments%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    IF p_write_lease_token IS NULL
       OR p_opaque_locator_hash !~ '^[a-f0-9]{64}$'
       OR p_ciphertext_sha256 !~ '^[a-f0-9]{64}$'
       OR p_content_commitment !~ '^[a-f0-9]{64}$'
       OR p_object_key IS DISTINCT FROM (
            'replay/v1/' || p_capture_id::TEXT || '/'
            || pg_catalog.encode(
                extensions.digest(
                    'replay/v1' || pg_catalog.chr(10)
                    || p_capture_id::TEXT || pg_catalog.chr(10)
                    || p_opaque_locator_hash || pg_catalog.chr(10)
                    || p_fragment_kind || pg_catalog.chr(10)
                    || p_stage || pg_catalog.chr(10)
                    || p_batch_ordinal::TEXT || pg_catalog.chr(10)
                    || p_ordinal::TEXT,
                    'sha256'
                ),
                'hex'
            )
            || '.enc'
       )
       OR p_fragment_kind NOT IN ('provider_payload', 'normalized_snapshot', 'execution_trace')
       OR p_stage NOT IN ('preflight', 'collection', 'scoring', 'finalization')
       OR p_batch_ordinal NOT BETWEEN 0 AND 127 OR p_ordinal NOT BETWEEN 0 AND 1023
       OR p_ciphertext_byte_size NOT BETWEEN 1 AND 8388608 OR p_envelope_version <> 1
       OR p_operator_fingerprint !~ '^[a-f0-9]{64}$' OR p_reason_code !~ '^[A-Z0-9_]{1,64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_CAPTURE_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_capture FROM public.analysis_v2_replay_capture_authorizations WHERE capture_id = p_capture_id FOR UPDATE;
    IF NOT FOUND OR v_capture.state <> 'capturing'
       OR v_capture.write_lease_token IS DISTINCT FROM p_write_lease_token
       OR v_capture.write_lease_expires_at <= v_now
       OR v_capture.artifact_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_CAPTURE_REGISTER_REJECTED', ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_existing FROM public.analysis_v2_replay_capture_fragments
    WHERE capture_id = p_capture_id AND opaque_locator_hash = p_opaque_locator_hash
      AND fragment_kind = p_fragment_kind AND stage = p_stage AND batch_ordinal = p_batch_ordinal AND ordinal = p_ordinal;
    IF FOUND THEN
        IF v_existing.ciphertext_sha256 IS DISTINCT FROM p_ciphertext_sha256
           OR v_existing.ciphertext_byte_size IS DISTINCT FROM p_ciphertext_byte_size
           OR v_existing.content_commitment IS DISTINCT FROM p_content_commitment
           OR v_existing.object_key IS DISTINCT FROM p_object_key THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_CAPTURE_FRAGMENT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN;
    END IF;
    IF v_capture.actual_fragment_count >= v_capture.expected_fragment_count
       OR v_capture.actual_ciphertext_byte_size + p_ciphertext_byte_size > 67108864 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REPLAY_CAPTURE_FRAGMENT_LIMIT', ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.analysis_v2_replay_capture_fragments (
        capture_id, opaque_locator_hash, fragment_kind, stage, batch_ordinal, ordinal,
        object_key, ciphertext_sha256, content_commitment,
        ciphertext_byte_size, envelope_version, expires_at
    ) VALUES (
        p_capture_id, p_opaque_locator_hash, p_fragment_kind, p_stage, p_batch_ordinal, p_ordinal,
        p_object_key, p_ciphertext_sha256, p_content_commitment,
        p_ciphertext_byte_size, p_envelope_version, v_capture.artifact_expires_at
    );
    UPDATE public.analysis_v2_replay_capture_authorizations
    SET actual_fragment_count = actual_fragment_count + 1,
        actual_ciphertext_byte_size = actual_ciphertext_byte_size + p_ciphertext_byte_size,
        updated_at = v_now
    WHERE capture_id = p_capture_id;
    INSERT INTO public.analysis_v2_replay_capture_audit_events (capture_id, event_type, operator_fingerprint, reason_code)
    VALUES (p_capture_id, 'register', p_operator_fingerprint, p_reason_code);
END;
$$;

REVOKE ALL ON FUNCTION public.arm_analysis_v2_replay_capture(UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bind_analysis_v2_replay_capture(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.register_analysis_v2_replay_capture_fragment(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, INTEGER, SMALLINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arm_analysis_v2_replay_capture(UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_analysis_v2_replay_capture(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_analysis_v2_replay_capture_fragment(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, INTEGER, SMALLINT, TEXT, TEXT, TEXT) TO service_role;
