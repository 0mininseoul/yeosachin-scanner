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
    disposition TEXT NOT NULL CHECK (disposition IN (
        'accepted', 'duplicate', 'no_sale', 'rejected', 'payment_pending'
    )),
    amount_krw INTEGER CHECK (amount_krw IS NULL OR amount_krw >= 0),
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
    lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    lease_token UUID,
    lease_holder_hash TEXT CHECK (lease_holder_hash IS NULL OR lease_holder_hash ~ '^[a-f0-9]{64}$'),
    lease_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    terminal_at TIMESTAMPTZ,
    last_error_code TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object'),
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

-- Hash contract: the bytes are UTF-8(`${namespace}\n${canonical_json_v1(value)}`).
-- canonical_json_v1 is deliberately explicit instead of relying on JSONB's
-- display output. Object keys are ordered by their UTF-8 bytes, arrays retain
-- order, strings use PostgreSQL's JSON string encoder, and numbers use the
-- ECMAScript-compatible decimal/scientific thresholds used by JSON.stringify.
CREATE FUNCTION public.canonical_json_string_v1(
    p_value TEXT
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT pg_catalog.to_json(p_value)::TEXT;
$$;

CREATE FUNCTION public.canonical_json_number_v1(
    p_value JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = ''
SET extra_float_digits = 3
AS $$
DECLARE
    v_number DOUBLE PRECISION;
    v_number_text TEXT;
    v_mantissa TEXT;
    v_exponent INTEGER;
    v_decimal TEXT;
    v_unsigned_mantissa TEXT;
    v_digits TEXT;
    v_decimal_position INTEGER;
BEGIN
    IF pg_catalog.jsonb_typeof(p_value) <> 'number' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CANONICAL_JSON_NUMBER_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_number := (p_value #>> '{}')::DOUBLE PRECISION;
    v_number_text := v_number::TEXT;
    IF v_number <> v_number
       OR v_number_text IN ('Infinity', '-Infinity', 'NaN') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CANONICAL_JSON_NUMBER_INVALID',
            ERRCODE = 'P0001';
    END IF;
    IF v_number = 0 THEN
        RETURN '0';
    END IF;

    -- JSON.stringify uses decimal notation in [1e-6, 1e21), even when the
    -- PostgreSQL float formatter chooses scientific notation.
    IF pg_catalog.abs(v_number) >= 1e-6
       AND pg_catalog.abs(v_number) < 1e21 THEN
        v_number_text := pg_catalog.lower(v_number::TEXT);
        v_decimal := v_number_text;
        -- Expand PostgreSQL's shortest float representation when it uses
        -- scientific notation; this keeps all significant digits instead of
        -- going through numeric's lower-precision display cast.
        IF pg_catalog.strpos(v_number_text, 'e') > 0 THEN
            v_mantissa := pg_catalog.split_part(v_number_text, 'e', 1);
            v_exponent := pg_catalog.split_part(v_number_text, 'e', 2)::INTEGER;
            v_unsigned_mantissa := pg_catalog.ltrim(v_mantissa, '+-');
            v_digits := pg_catalog.replace(v_unsigned_mantissa, '.', '');
            v_decimal_position := (
                CASE
                    WHEN pg_catalog.strpos(v_unsigned_mantissa, '.') > 0
                    THEN pg_catalog.strpos(v_unsigned_mantissa, '.') - 1
                    ELSE pg_catalog.length(v_unsigned_mantissa)
                END
            ) + v_exponent;
            IF v_decimal_position <= 0 THEN
                v_decimal := CASE WHEN pg_catalog.left(v_mantissa, 1) = '-' THEN '-' ELSE '' END
                    || '0.'
                    || pg_catalog.repeat('0', -v_decimal_position)
                    || v_digits;
            ELSIF v_decimal_position >= pg_catalog.length(v_digits) THEN
                v_decimal := CASE WHEN pg_catalog.left(v_mantissa, 1) = '-' THEN '-' ELSE '' END
                    || v_digits
                    || pg_catalog.repeat('0', v_decimal_position - pg_catalog.length(v_digits));
            ELSE
                v_decimal := CASE WHEN pg_catalog.left(v_mantissa, 1) = '-' THEN '-' ELSE '' END
                    || pg_catalog.substr(v_digits, 1, v_decimal_position)
                    || '.'
                    || pg_catalog.substr(v_digits, v_decimal_position + 1);
            END IF;
        END IF;
        IF pg_catalog.strpos(v_decimal, '.') > 0 THEN
            v_decimal := pg_catalog.rtrim(pg_catalog.rtrim(v_decimal, '0'), '.');
        END IF;
        RETURN v_decimal;
    END IF;

    v_number_text := pg_catalog.lower(v_number_text);
    IF pg_catalog.strpos(v_number_text, 'e') = 0 THEN
        RETURN v_number_text;
    END IF;
    v_mantissa := pg_catalog.split_part(v_number_text, 'e', 1);
    v_exponent := pg_catalog.split_part(v_number_text, 'e', 2)::INTEGER;
    IF pg_catalog.strpos(v_mantissa, '.') > 0 THEN
        v_mantissa := pg_catalog.rtrim(pg_catalog.rtrim(v_mantissa, '0'), '.');
    END IF;
    RETURN v_mantissa || 'e'
        || CASE WHEN v_exponent >= 0 THEN '+' ELSE '' END
        || v_exponent::TEXT;
END;
$$;

CREATE FUNCTION public.canonical_json_v1(
    p_value JSONB,
    p_depth INTEGER DEFAULT 0
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_result TEXT;
BEGIN
    IF p_depth IS NULL OR p_depth NOT BETWEEN 0 AND 8 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CANONICAL_JSON_DEPTH_LIMIT',
            ERRCODE = 'P0001';
    END IF;

    CASE pg_catalog.jsonb_typeof(p_value)
        WHEN 'object' THEN
            IF (
                SELECT pg_catalog.count(*)
                FROM pg_catalog.jsonb_object_keys(p_value)
            ) > 100
            OR EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_object_keys(p_value) AS object_key(key)
                WHERE object_key.key IS NULL
                   OR pg_catalog.length(object_key.key) = 0
                   OR pg_catalog.length(object_key.key) > 128
            ) THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'CANONICAL_JSON_KEY_INVALID',
                    ERRCODE = 'P0001';
            END IF;
            SELECT '{' || COALESCE(pg_catalog.string_agg(
                public.canonical_json_string_v1(entry.key) || ':'
                    || public.canonical_json_v1(entry.value, p_depth + 1),
                ',' ORDER BY pg_catalog.encode(
                    pg_catalog.convert_to(entry.key, 'UTF8'),
                    'hex'
                ) COLLATE "C"
            ), '') || '}'
            INTO v_result
            FROM pg_catalog.jsonb_each(p_value) AS entry(key, value);
        WHEN 'array' THEN
            IF pg_catalog.jsonb_array_length(p_value) > 100 THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'CANONICAL_JSON_ARRAY_LIMIT',
                    ERRCODE = 'P0001';
            END IF;
            SELECT '[' || COALESCE(pg_catalog.string_agg(
                public.canonical_json_v1(entry.value, p_depth + 1),
                ',' ORDER BY entry.ordinality
            ), '') || ']'
            INTO v_result
            FROM pg_catalog.jsonb_array_elements(p_value)
                WITH ORDINALITY AS entry(value, ordinality);
        WHEN 'string' THEN
            IF pg_catalog.length(p_value #>> '{}') > 8192 THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'CANONICAL_JSON_STRING_LIMIT',
                    ERRCODE = 'P0001';
            END IF;
            v_result := public.canonical_json_string_v1(p_value #>> '{}');
        WHEN 'number' THEN
            v_result := public.canonical_json_number_v1(p_value);
        WHEN 'boolean' THEN
            v_result := p_value #>> '{}';
        WHEN 'null' THEN
            v_result := 'null';
        ELSE
            RAISE EXCEPTION USING
                MESSAGE = 'CANONICAL_JSON_VALUE_INVALID',
                ERRCODE = 'P0001';
    END CASE;

    IF pg_catalog.octet_length(v_result) > 262144 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CANONICAL_JSON_SIZE_LIMIT',
            ERRCODE = 'P0001';
    END IF;
    RETURN v_result;
END;
$$;

CREATE FUNCTION public.canonical_json_hash_v1(
    p_namespace TEXT,
    p_value JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF pg_catalog.length(p_namespace) = 0
       OR pg_catalog.strpos(p_namespace, pg_catalog.chr(10)) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CANONICAL_JSON_NAMESPACE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    RETURN pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                p_namespace || pg_catalog.chr(10)
                    || public.canonical_json_v1(p_value),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
END;
$$;

-- Keep this named boundary for callers that need to display/verify the exact
-- configuration bytes; all hashes use the same canonical serializer above.
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

CREATE FUNCTION public.record_payment_event_v1(
    p_event_id TEXT,
    p_idempotency_key TEXT,
    p_event_type TEXT,
    p_payment_id TEXT,
    p_order_id UUID,
    p_provider TEXT,
    p_disposition TEXT,
    p_payload_hash TEXT,
    p_payload JSONB,
    p_occurred_at TIMESTAMPTZ,
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
       OR p_provider NOT IN ('groble')
       OR p_disposition NOT IN ('accepted', 'duplicate', 'no_sale', 'rejected', 'payment_pending')
       OR p_payload_hash IS NULL OR p_payload_hash !~ '^[a-f0-9]{64}$'
       OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR p_occurred_at IS NULL
       OR (p_amount_krw IS NOT NULL AND p_amount_krw < 0) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PAYMENT_EVENT_INPUT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT payment_event.*
    INTO v_existing
    FROM public.payment_events AS payment_event
    WHERE payment_event.event_id = p_event_id
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.idempotency_key IS DISTINCT FROM p_idempotency_key THEN
            RAISE EXCEPTION USING MESSAGE = 'PAYMENT_EVENT_IDEMPOTENCY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF v_existing.event_type IS DISTINCT FROM p_event_type
           OR v_existing.payment_id IS DISTINCT FROM p_payment_id
           OR v_existing.order_id IS DISTINCT FROM p_order_id
           OR v_existing.provider IS DISTINCT FROM p_provider
           OR v_existing.disposition IS DISTINCT FROM p_disposition
           OR v_existing.payload_hash IS DISTINCT FROM p_payload_hash
           OR v_existing.payload IS DISTINCT FROM p_payload
           OR v_existing.occurred_at IS DISTINCT FROM p_occurred_at
           OR v_existing.amount_krw IS DISTINCT FROM p_amount_krw THEN
            RAISE EXCEPTION USING MESSAGE = 'PAYMENT_EVENT_IDEMPOTENCY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object('status', 'recorded', 'duplicate', TRUE);
    END IF;

    SELECT payment_event.*
    INTO v_existing
    FROM public.payment_events AS payment_event
    WHERE payment_event.idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PAYMENT_EVENT_IDEMPOTENCY_KEY_CONFLICT', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.payment_events(
        event_id,
        idempotency_key,
        provider,
        event_type,
        payment_id,
        order_id,
        disposition,
        amount_krw,
        payload_hash,
        payload,
        occurred_at
    ) VALUES (
        p_event_id,
        p_idempotency_key,
        p_provider,
        p_event_type,
        p_payment_id,
        p_order_id,
        p_disposition,
        p_amount_krw,
        p_payload_hash,
        p_payload,
        p_occurred_at
    )
    ON CONFLICT DO NOTHING;

    IF FOUND THEN
        RETURN pg_catalog.jsonb_build_object('status', 'recorded', 'duplicate', FALSE);
    END IF;

    SELECT payment_event.*
    INTO v_existing
    FROM public.payment_events AS payment_event
    WHERE payment_event.event_id = p_event_id
       OR payment_event.idempotency_key = p_idempotency_key
    ORDER BY payment_event.event_id = p_event_id DESC
    LIMIT 1;
    IF FOUND AND v_existing.event_id = p_event_id
       AND v_existing.idempotency_key = p_idempotency_key
       AND v_existing.event_type = p_event_type
       AND v_existing.payment_id = p_payment_id
       AND v_existing.order_id IS NOT DISTINCT FROM p_order_id
       AND v_existing.provider = p_provider
       AND v_existing.disposition = p_disposition
       AND v_existing.payload_hash = p_payload_hash
       AND v_existing.payload = p_payload
       AND v_existing.occurred_at = p_occurred_at
       AND v_existing.amount_krw IS NOT DISTINCT FROM p_amount_krw THEN
        RETURN pg_catalog.jsonb_build_object('status', 'recorded', 'duplicate', TRUE);
    END IF;
    IF FOUND AND v_existing.idempotency_key = p_idempotency_key THEN
        RAISE EXCEPTION USING MESSAGE = 'PAYMENT_EVENT_IDEMPOTENCY_KEY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION USING MESSAGE = 'PAYMENT_EVENT_IDEMPOTENCY_CONFLICT', ERRCODE = 'P0001';
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

CREATE FUNCTION public.append_account_lifecycle_v1(
    p_account_id UUID,
    p_event_kind TEXT,
    p_state TEXT,
    p_payload JSONB DEFAULT '{}'::JSONB,
    p_content_hash TEXT DEFAULT NULL
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
       OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ACCOUNT_LIFECYCLE_INPUT_INVALID', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.account_lifecycle(account_id, event_kind, state, content_hash, payload)
    VALUES (p_account_id, p_event_kind, p_state, p_content_hash, p_payload)
    RETURNING id INTO v_id;
    RETURN pg_catalog.jsonb_build_object('status', 'recorded', 'id', v_id);
END;
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

CREATE FUNCTION public.enqueue_maintenance_job_v1(
    p_kind TEXT,
    p_target_key_hash TEXT,
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
    v_existing public.maintenance_jobs%ROWTYPE;
BEGIN
    IF p_kind NOT IN (
           'recovery', 'replay', 'rearm', 'cleanup',
           'terminalize', 'purge', 'audit_assembly'
       )
       OR p_target_key_hash IS NULL OR p_target_key_hash !~ '^[a-f0-9]{64}$'
       OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$'
       OR p_requeue IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'MAINTENANCE_JOB_INPUT_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT maintenance.*
    INTO v_existing
    FROM public.maintenance_jobs AS maintenance
    WHERE maintenance.kind = p_kind
      AND maintenance.target_key_hash = p_target_key_hash
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.content_hash = p_content_hash AND v_existing.payload = p_payload THEN
            IF p_requeue AND v_existing.state = 'blocked' THEN
                UPDATE public.maintenance_jobs
                SET state = 'queued',
                    attempt_count = 0,
                    next_attempt_at = pg_catalog.clock_timestamp(),
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
        RAISE EXCEPTION USING MESSAGE = 'MAINTENANCE_CONTENT_CONFLICT', ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.maintenance_jobs(kind, target_key_hash, state, payload, content_hash)
    VALUES (p_kind, p_target_key_hash, 'queued', p_payload, p_content_hash)
    ON CONFLICT DO NOTHING;
    IF FOUND THEN
        RETURN pg_catalog.jsonb_build_object('status', 'queued', 'duplicate', FALSE);
    END IF;
    SELECT maintenance.*
    INTO v_existing
    FROM public.maintenance_jobs AS maintenance
    WHERE maintenance.kind = p_kind
      AND maintenance.target_key_hash = p_target_key_hash;
    IF FOUND AND v_existing.content_hash = p_content_hash AND v_existing.payload = p_payload THEN
        IF p_requeue AND v_existing.state = 'blocked' THEN
            UPDATE public.maintenance_jobs
            SET state = 'queued',
                attempt_count = 0,
                next_attempt_at = pg_catalog.clock_timestamp(),
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
    RAISE EXCEPTION USING MESSAGE = 'MAINTENANCE_CONTENT_CONFLICT', ERRCODE = 'P0001';
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

CREATE FUNCTION public.claim_maintenance_jobs_v1(
    p_limit INTEGER,
    p_holder_hash TEXT,
    p_lease_seconds INTEGER
)
RETURNS SETOF public.maintenance_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100
       OR p_holder_hash IS NULL OR p_holder_hash !~ '^[a-f0-9]{64}$'
       OR p_lease_seconds IS NULL OR p_lease_seconds < 60 OR p_lease_seconds > 600 THEN
        RAISE EXCEPTION USING MESSAGE = 'MAINTENANCE_CLAIM_INPUT_INVALID', ERRCODE = 'P0001';
    END IF;
    RETURN QUERY
    WITH candidates AS (
        SELECT maintenance.id
        FROM public.maintenance_jobs AS maintenance
        WHERE maintenance.state IN ('queued', 'retryable')
          AND maintenance.attempt_count < 1000
          AND maintenance.next_attempt_at <= pg_catalog.clock_timestamp()
          AND (maintenance.lease_expires_at IS NULL OR maintenance.lease_expires_at <= pg_catalog.clock_timestamp())
        ORDER BY maintenance.next_attempt_at, maintenance.created_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.maintenance_jobs AS maintenance
    SET state = 'leased',
        attempt_count = maintenance.attempt_count + 1,
        lease_generation = maintenance.lease_generation + 1,
        lease_token = extensions.gen_random_uuid(),
        lease_holder_hash = p_holder_hash,
        lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
        updated_at = pg_catalog.clock_timestamp()
    FROM candidates
    WHERE maintenance.id = candidates.id
    RETURNING maintenance.*;
END;
$$;

CREATE FUNCTION public.finish_maintenance_job_v1(
    p_job_id UUID,
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
    v_row public.maintenance_jobs%ROWTYPE;
    v_state TEXT;
BEGIN
    IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_generation IS NULL OR p_lease_generation < 0
       OR p_outcome NOT IN ('succeeded', 'retryable', 'blocked')
       OR p_retry_after_seconds IS NULL OR p_retry_after_seconds < 0 OR p_retry_after_seconds > 3600 THEN
        RAISE EXCEPTION USING MESSAGE = 'MAINTENANCE_FINISH_INPUT_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT maintenance.*
    INTO v_row
    FROM public.maintenance_jobs AS maintenance
    WHERE maintenance.id = p_job_id
    FOR UPDATE;
    IF NOT FOUND OR v_row.lease_token IS DISTINCT FROM p_lease_token
       OR v_row.lease_generation IS DISTINCT FROM p_lease_generation
       OR v_row.state <> 'leased' THEN
        RAISE EXCEPTION USING MESSAGE = 'MAINTENANCE_FENCE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    v_state := CASE
        WHEN p_outcome = 'succeeded' THEN 'succeeded'
        WHEN p_outcome = 'blocked' OR v_row.attempt_count >= 1000 THEN 'blocked'
        ELSE 'retryable'
    END;
    UPDATE public.maintenance_jobs
    SET state = v_state,
        next_attempt_at = CASE WHEN v_state = 'retryable'
            THEN pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_retry_after_seconds)
            ELSE next_attempt_at END,
        terminal_at = CASE WHEN v_state = 'blocked' THEN pg_catalog.clock_timestamp() ELSE terminal_at END,
        last_error_code = p_error_code,
        lease_token = NULL,
        lease_holder_hash = NULL,
        lease_expires_at = NULL,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_job_id;
    RETURN pg_catalog.jsonb_build_object('status', v_state, 'duplicate', FALSE);
END;
$$;

CREATE FUNCTION public.reconcile_stale_maintenance_jobs_v1(
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
        RAISE EXCEPTION USING MESSAGE = 'MAINTENANCE_RECONCILE_LIMIT_INVALID', ERRCODE = 'P0001';
    END IF;
    WITH stale AS (
        SELECT maintenance.id
        FROM public.maintenance_jobs AS maintenance
        WHERE maintenance.state = 'leased'
          AND maintenance.lease_expires_at IS NOT NULL
          AND maintenance.lease_expires_at <= pg_catalog.clock_timestamp()
        ORDER BY maintenance.lease_expires_at, maintenance.created_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.maintenance_jobs AS maintenance
    SET state = CASE WHEN attempt_count >= 1000 THEN 'blocked' ELSE 'retryable' END,
        next_attempt_at = pg_catalog.clock_timestamp(),
        terminal_at = CASE WHEN attempt_count >= 1000 THEN pg_catalog.clock_timestamp() ELSE terminal_at END,
        last_error_code = 'LEASE_EXPIRED',
        lease_token = NULL,
        lease_holder_hash = NULL,
        lease_expires_at = NULL,
        updated_at = pg_catalog.clock_timestamp()
    FROM stale
    WHERE maintenance.id = stale.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN pg_catalog.jsonb_build_object('status', 'reconciled', 'count', v_count);
END;
$$;

-- The notification shadow check reads the three legacy outboxes as one
-- bounded, content-shaped family. Counts alone cannot detect a wrong payload
-- behind a matching row count, so each branch derives the same safe payload
-- and content hash used by the dual-write producers.
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

REVOKE EXECUTE ON FUNCTION public.record_payment_event_v1(TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_event_v1(TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ, INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.canonical_json_string_v1(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.canonical_json_number_v1(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.canonical_json_v1(JSONB, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.canonical_json_hash_v1(TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.canonical_system_configuration_json(JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.canonical_system_configuration_json(JSONB) TO service_role;
REVOKE EXECUTE ON FUNCTION public.upsert_fulfillment_job_v1(UUID, UUID, TEXT, SMALLINT, BIGINT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_fulfillment_job_v1(UUID, UUID, TEXT, SMALLINT, BIGINT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
REVOKE EXECUTE ON FUNCTION public.enqueue_notification_v1(TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_notification_v1(TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) TO service_role;
REVOKE EXECUTE ON FUNCTION public.append_account_lifecycle_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_account_lifecycle_v1(UUID, TEXT, TEXT, JSONB, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.record_system_configuration_v1(TEXT, INTEGER, TEXT, JSONB, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_system_configuration_v1(TEXT, INTEGER, TEXT, JSONB, TEXT, TIMESTAMPTZ) TO service_role;
REVOKE EXECUTE ON FUNCTION public.acquire_system_lease_v1(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_system_lease_v1(TEXT, TEXT, TEXT, INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.enqueue_maintenance_job_v1(TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_maintenance_job_v1(TEXT, TEXT, JSONB, TEXT, BOOLEAN) TO service_role;
REVOKE EXECUTE ON FUNCTION public.claim_notification_outbox_v1(INTEGER, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_outbox_v1(INTEGER, TEXT, INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.finish_notification_outbox_v1(UUID, UUID, BIGINT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_notification_outbox_v1(UUID, UUID, BIGINT, TEXT, TEXT, INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.reconcile_stale_notification_outbox_v1(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_notification_outbox_v1(INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.claim_maintenance_jobs_v1(INTEGER, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_maintenance_jobs_v1(INTEGER, TEXT, INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.finish_maintenance_job_v1(UUID, UUID, BIGINT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_maintenance_job_v1(UUID, UUID, BIGINT, TEXT, TEXT, INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.reconcile_stale_maintenance_jobs_v1(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_maintenance_jobs_v1(INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.list_notification_legacy_outbox_v1(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_notification_legacy_outbox_v1(INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.list_notification_outbox_v1(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_notification_outbox_v1(INTEGER) TO service_role;

-- PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED: this additive migration never
-- changes an order status. The existing no-sale reconciliation RPC remains the
-- sole evidence-gated path for a payment_pending -> payment_failed transition.
