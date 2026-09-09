-- Commerce and operations canonical evidence is additive and report-only until
-- the owning family enables a separately reviewed read flag.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.payment_events (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    event_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL CHECK (provider IN ('groble')),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'payment.completed', 'payment.cancel_requested', 'payment.refunded'
    )),
    payment_id TEXT NOT NULL,
    order_id UUID REFERENCES public.earlybird_orders(id) ON DELETE SET NULL,
    disposition TEXT NOT NULL,
    amount_krw INTEGER CHECK (amount_krw IS NULL OR amount_krw > 0),
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

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
    lease_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    last_error_code TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.notification_outbox (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    channel TEXT NOT NULL CHECK (channel IN ('discord', 'kakao', 'sentry')),
    event_kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'sent', 'retryable', 'dead')),
    attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.account_lifecycle (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    event_kind TEXT NOT NULL CHECK (event_kind IN (
        'classification', 'paid_evidence', 'deletion_requested',
        'objects_purged', 'database_purged', 'retired', 'e2e'
    )),
    state TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
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

CREATE TABLE public.maintenance_jobs (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN (
        'recovery', 'replay', 'rearm', 'cleanup',
        'terminalize', 'purge', 'audit_assembly'
    )),
    target_key_hash TEXT NOT NULL CHECK (target_key_hash ~ '^[a-f0-9]{64}$'),
    state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'retryable', 'blocked')),
    attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    lease_expires_at TIMESTAMPTZ,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (kind, target_key_hash)
);

CREATE INDEX payment_events_order_recorded_idx
    ON public.payment_events(order_id, recorded_at DESC)
    WHERE order_id IS NOT NULL;
CREATE INDEX fulfillment_jobs_recovery_idx
    ON public.fulfillment_jobs(state, next_attempt_at, created_at)
    WHERE state IN ('admission_pending', 'retryable_failure', 'analysis_in_progress');
CREATE INDEX notification_outbox_delivery_idx
    ON public.notification_outbox(state, next_attempt_at, created_at)
    WHERE state IN ('queued', 'retryable');
CREATE INDEX account_lifecycle_account_recorded_idx
    ON public.account_lifecycle(account_id, recorded_at DESC);
CREATE INDEX system_configuration_effective_idx
    ON public.system_configuration(config_key, effective_at DESC, version DESC)
    WHERE state = 'effective';
CREATE INDEX system_leases_expiry_idx
    ON public.system_leases(kind, state, lease_expires_at);
CREATE INDEX maintenance_jobs_recovery_idx
    ON public.maintenance_jobs(state, next_attempt_at, created_at)
    WHERE state IN ('queued', 'retryable');

ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE public.account_lifecycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_lifecycle FORCE ROW LEVEL SECURITY;
ALTER TABLE public.system_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_configuration FORCE ROW LEVEL SECURITY;
ALTER TABLE public.system_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_jobs FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.payment_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.payment_events FROM service_role;
REVOKE ALL ON TABLE public.fulfillment_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.fulfillment_jobs FROM service_role;
REVOKE ALL ON TABLE public.notification_outbox FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.notification_outbox FROM service_role;
REVOKE ALL ON TABLE public.account_lifecycle FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.account_lifecycle FROM service_role;
REVOKE ALL ON TABLE public.system_configuration FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.system_configuration FROM service_role;
REVOKE ALL ON TABLE public.system_leases FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.system_leases FROM service_role;
REVOKE ALL ON TABLE public.maintenance_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.maintenance_jobs FROM service_role;

CREATE FUNCTION public.reject_commerce_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'COMMERCE_CANONICAL_APPEND_ONLY',
        ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_commerce_append_only_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER payment_events_immutable
BEFORE UPDATE OR DELETE ON public.payment_events
FOR EACH ROW EXECUTE FUNCTION public.reject_commerce_append_only_mutation();
CREATE TRIGGER account_lifecycle_immutable
BEFORE UPDATE OR DELETE ON public.account_lifecycle
FOR EACH ROW EXECUTE FUNCTION public.reject_commerce_append_only_mutation();
CREATE TRIGGER system_configuration_immutable
BEFORE UPDATE OR DELETE ON public.system_configuration
FOR EACH ROW EXECUTE FUNCTION public.reject_commerce_append_only_mutation();

CREATE FUNCTION public.record_payment_event_v1(
    p_event_id TEXT,
    p_idempotency_key TEXT,
    p_event_type TEXT,
    p_payment_id TEXT,
    p_payload_hash TEXT,
    p_amount_krw INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_existing public.payment_events%ROWTYPE;
BEGIN
    IF p_event_id IS NULL OR pg_catalog.length(pg_catalog.btrim(p_event_id)) = 0
       OR p_idempotency_key IS NULL OR pg_catalog.length(pg_catalog.btrim(p_idempotency_key)) = 0
       OR p_payment_id IS NULL OR pg_catalog.length(pg_catalog.btrim(p_payment_id)) = 0
       OR p_event_type NOT IN ('payment.completed', 'payment.cancel_requested', 'payment.refunded')
       OR p_payload_hash IS NULL OR p_payload_hash !~ '^[a-f0-9]{64}$'
       OR (p_amount_krw IS NOT NULL AND p_amount_krw <= 0) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PAYMENT_EVENT_INPUT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.payment_events(
        event_id,
        idempotency_key,
        provider,
        event_type,
        payment_id,
        disposition,
        amount_krw,
        payload_hash,
        occurred_at
    ) VALUES (
        p_event_id,
        p_idempotency_key,
        'groble',
        p_event_type,
        p_payment_id,
        'received',
        p_amount_krw,
        p_payload_hash,
        pg_catalog.clock_timestamp()
    )
    ON CONFLICT (event_id) DO NOTHING;

    IF FOUND THEN
        RETURN pg_catalog.jsonb_build_object('status', 'recorded', 'duplicate', FALSE);
    END IF;

    SELECT payment_event.*
    INTO v_existing
    FROM public.payment_events AS payment_event
    WHERE payment_event.event_id = p_event_id;
    IF NOT FOUND OR v_existing.idempotency_key IS DISTINCT FROM p_idempotency_key THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PAYMENT_EVENT_IDEMPOTENCY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'recorded', 'duplicate', TRUE);
END;
$$;

CREATE FUNCTION public.upsert_fulfillment_job_v1(
    p_order_id UUID,
    p_request_id UUID,
    p_state TEXT,
    p_attempt_count SMALLINT,
    p_lease_generation BIGINT,
    p_lease_expires_at TIMESTAMPTZ,
    p_next_attempt_at TIMESTAMPTZ,
    p_last_error_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.fulfillment_jobs%ROWTYPE;
BEGIN
    IF p_order_id IS NULL
       OR p_state NOT IN (
           'awaiting_operator', 'admission_pending', 'analysis_in_progress',
           'completed', 'retryable_failure', 'manual_review'
       )
       OR p_attempt_count IS NULL OR p_attempt_count < 0 OR p_attempt_count > 10
       OR p_lease_generation IS NULL OR p_lease_generation < 0
       OR p_next_attempt_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'FULFILLMENT_JOB_INPUT_INVALID', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.fulfillment_jobs(
        order_id,
        request_id,
        state,
        attempt_count,
        lease_generation,
        lease_expires_at,
        next_attempt_at,
        last_error_code
    ) VALUES (
        p_order_id,
        p_request_id,
        p_state,
        p_attempt_count,
        p_lease_generation,
        p_lease_expires_at,
        p_next_attempt_at,
        p_last_error_code
    )
    ON CONFLICT (order_id) DO UPDATE
    SET request_id = EXCLUDED.request_id,
        state = EXCLUDED.state,
        attempt_count = EXCLUDED.attempt_count,
        lease_generation = EXCLUDED.lease_generation,
        lease_expires_at = EXCLUDED.lease_expires_at,
        next_attempt_at = EXCLUDED.next_attempt_at,
        last_error_code = EXCLUDED.last_error_code,
        updated_at = pg_catalog.clock_timestamp();

    SELECT fulfillment_job.*
    INTO v_job
    FROM public.fulfillment_jobs AS fulfillment_job
    WHERE fulfillment_job.order_id = p_order_id;
    RETURN pg_catalog.jsonb_build_object(
        'order_id', v_job.order_id,
        'state', v_job.state,
        'lease_generation', v_job.lease_generation
    );
END;
$$;

CREATE FUNCTION public.enqueue_notification_v1(
    p_channel TEXT,
    p_event_kind TEXT,
    p_dedupe_key TEXT,
    p_content_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_channel NOT IN ('discord', 'kakao', 'sentry')
       OR p_event_kind IS NULL OR pg_catalog.length(pg_catalog.btrim(p_event_kind)) = 0
       OR p_dedupe_key IS NULL OR pg_catalog.length(pg_catalog.btrim(p_dedupe_key)) = 0
       OR p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'NOTIFICATION_INPUT_INVALID', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.notification_outbox(
        channel,
        event_kind,
        dedupe_key,
        state,
        content_hash
    ) VALUES (
        p_channel,
        p_event_kind,
        p_dedupe_key,
        'queued',
        p_content_hash
    )
    ON CONFLICT (dedupe_key) DO NOTHING;
    RETURN pg_catalog.jsonb_build_object(
        'status', 'queued',
        'duplicate', NOT FOUND
    );
END;
$$;

CREATE FUNCTION public.append_account_lifecycle_v1(
    p_account_id UUID,
    p_event_kind TEXT,
    p_state TEXT,
    p_content_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_id BIGINT;
BEGIN
    IF p_account_id IS NULL
       OR p_event_kind NOT IN (
           'classification', 'paid_evidence', 'deletion_requested',
           'objects_purged', 'database_purged', 'retired', 'e2e'
       )
       OR p_state IS NULL OR pg_catalog.length(pg_catalog.btrim(p_state)) = 0
       OR p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ACCOUNT_LIFECYCLE_INPUT_INVALID', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.account_lifecycle(account_id, event_kind, state, content_hash)
    VALUES (p_account_id, p_event_kind, p_state, p_content_hash)
    RETURNING id INTO v_id;
    RETURN pg_catalog.jsonb_build_object('status', 'recorded', 'id', v_id);
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

CREATE FUNCTION public.enqueue_maintenance_job_v1(
    p_kind TEXT,
    p_target_key_hash TEXT,
    p_content_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_kind NOT IN (
           'recovery', 'replay', 'rearm', 'cleanup',
           'terminalize', 'purge', 'audit_assembly'
       )
       OR p_target_key_hash IS NULL OR p_target_key_hash !~ '^[a-f0-9]{64}$'
       OR p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'MAINTENANCE_JOB_INPUT_INVALID', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.maintenance_jobs(kind, target_key_hash, state, content_hash)
    VALUES (p_kind, p_target_key_hash, 'queued', p_content_hash)
    ON CONFLICT (kind, target_key_hash) DO NOTHING;
    RETURN pg_catalog.jsonb_build_object(
        'status', 'queued',
        'duplicate', NOT FOUND
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_payment_event_v1(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_event_v1(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.upsert_fulfillment_job_v1(UUID, UUID, TEXT, SMALLINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_fulfillment_job_v1(UUID, UUID, TEXT, SMALLINT, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.enqueue_notification_v1(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_notification_v1(TEXT, TEXT, TEXT, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.append_account_lifecycle_v1(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_account_lifecycle_v1(UUID, TEXT, TEXT, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.acquire_system_lease_v1(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_system_lease_v1(TEXT, TEXT, TEXT, INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.enqueue_maintenance_job_v1(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_maintenance_job_v1(TEXT, TEXT, TEXT) TO service_role;

-- PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED: this additive migration never
-- changes an order status. The existing no-sale reconciliation RPC remains the
-- sole evidence-gated path for a payment_pending -> payment_failed transition.
