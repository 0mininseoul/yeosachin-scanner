-- Phase A/B of the account-principal rollout.
--
-- This migration is deliberately additive. The physical public.users table
-- remains in place while all rolling application revisions move behind the
-- stable service-role RPC boundary. The account_principals rename and the
-- compatibility views belong to the later, separately gated cutover.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- paid-ever has never been trustworthy before this migration. Refuse to
-- reinterpret an unexplained TRUE instead of silently blessing it.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.users AS existing_user
        WHERE existing_user.is_paid_user IS TRUE
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_PAID_EVER_PREEXISTING_TRUE_REQUIRES_REVIEW',
            ERRCODE = 'P0001';
    END IF;
END;
$$;

ALTER TABLE public.users
    ADD COLUMN account_class TEXT NOT NULL DEFAULT 'production',
    ADD COLUMN traffic_class TEXT NOT NULL DEFAULT 'external',
    ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN first_paid_at TIMESTAMP WITH TIME ZONE,
    -- Existing rows remain NULL until the HMAC-gated classification command
    -- has explicitly reviewed them. New bridge-created rows set this field.
    ADD COLUMN classification_version TEXT,
    ADD CONSTRAINT users_account_class_check CHECK (
        account_class IN ('production', 'e2e_test')
    ) NOT VALID,
    ADD CONSTRAINT users_traffic_class_check CHECK (
        traffic_class IN (
            'external', 'operator', 'e2e_test', 'internal_tester'
        )
    ) NOT VALID,
    ADD CONSTRAINT users_lifecycle_check CHECK (
        lifecycle IN ('active', 'retired')
    ) NOT VALID,
    ADD CONSTRAINT users_classification_version_check CHECK (
        classification_version IS NULL
        OR classification_version ~ '^[a-z0-9._-]{1,64}$'
    ) NOT VALID,
    ADD CONSTRAINT users_paid_ever_shape_check CHECK (
        is_paid_user IS NOT TRUE OR first_paid_at IS NOT NULL
    ) NOT VALID;

ALTER TABLE public.users VALIDATE CONSTRAINT users_account_class_check;
ALTER TABLE public.users VALIDATE CONSTRAINT users_traffic_class_check;
ALTER TABLE public.users VALIDATE CONSTRAINT users_lifecycle_check;
ALTER TABLE public.users VALIDATE CONSTRAINT users_classification_version_check;
ALTER TABLE public.users VALIDATE CONSTRAINT users_paid_ever_shape_check;

CREATE INDEX users_account_surface_idx
    ON public.users(account_class, lifecycle, created_at DESC);
CREATE INDEX users_traffic_surface_idx
    ON public.users(traffic_class, lifecycle, created_at DESC);

CREATE TABLE public.account_classification_audit (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    command_version TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    previous_account_class TEXT NOT NULL,
    previous_traffic_class TEXT NOT NULL,
    previous_lifecycle TEXT NOT NULL,
    next_account_class TEXT NOT NULL,
    next_traffic_class TEXT NOT NULL,
    next_lifecycle TEXT NOT NULL,
    recorded_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT account_classification_audit_command_check CHECK (
        command_version ~ '^[a-z0-9._-]{1,64}$'
    ),
    CONSTRAINT account_classification_audit_reason_check CHECK (
        reason_code ~ '^[A-Z0-9_]{1,64}$'
    ),
    CONSTRAINT account_classification_audit_account_class_check CHECK (
        previous_account_class IN ('production', 'e2e_test')
        AND next_account_class IN ('production', 'e2e_test')
    ),
    CONSTRAINT account_classification_audit_traffic_class_check CHECK (
        previous_traffic_class IN (
            'external', 'operator', 'e2e_test', 'internal_tester'
        )
        AND next_traffic_class IN (
            'external', 'operator', 'e2e_test', 'internal_tester'
        )
    ),
    CONSTRAINT account_classification_audit_lifecycle_check CHECK (
        previous_lifecycle IN ('active', 'retired')
        AND next_lifecycle IN ('active', 'retired')
    )
);

CREATE INDEX account_classification_audit_account_idx
    ON public.account_classification_audit(account_id, recorded_at DESC);

ALTER TABLE public.account_classification_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_classification_audit
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.account_classification_audit TO service_role;

CREATE OR REPLACE FUNCTION public.reject_account_classification_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'ACCOUNT_CLASSIFICATION_AUDIT_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_account_classification_audit_mutation()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reject_account_classification_audit_mutation_before_write
BEFORE UPDATE OR DELETE ON public.account_classification_audit
FOR EACH ROW
EXECUTE FUNCTION public.reject_account_classification_audit_mutation();

-- A singleton rollout gate keeps accepted webhooks from being interpreted as
-- external revenue while legacy E2E/operator rows still carry additive
-- defaults. The classification command activates this gate and replays the
-- canonical accepted-event evidence in one transaction.
CREATE TABLE public.account_ledger_rollout_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    paid_ever_state TEXT NOT NULL DEFAULT 'pending' CHECK (
        paid_ever_state IN ('pending', 'active')
    ),
    classification_command_version TEXT,
    classification_completed_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT account_ledger_rollout_activation_check CHECK (
        (
            paid_ever_state = 'pending'
            AND classification_command_version IS NULL
            AND classification_completed_at IS NULL
        )
        OR (
            paid_ever_state = 'active'
            AND classification_command_version
                ~ '^[a-z0-9._-]{1,64}$'
            AND classification_completed_at IS NOT NULL
        )
    )
);

INSERT INTO public.account_ledger_rollout_state(singleton) VALUES (TRUE);
ALTER TABLE public.account_ledger_rollout_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_ledger_rollout_state
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.account_ledger_rollout_state TO service_role;

CREATE TABLE public.account_paid_evidence (
    order_id UUID PRIMARY KEY
        REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    event_id VARCHAR(256) NOT NULL UNIQUE
        REFERENCES public.earlybird_webhook_events(event_id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    payment_id VARCHAR(256) NOT NULL,
    paid_at TIMESTAMP WITH TIME ZONE NOT NULL,
    amount_krw INTEGER NOT NULL CHECK (amount_krw > 0),
    counts_as_external BOOLEAN NOT NULL,
    recorded_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX account_paid_evidence_account_idx
    ON public.account_paid_evidence(account_id, paid_at);

ALTER TABLE public.account_paid_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_paid_evidence
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.account_paid_evidence TO service_role;

CREATE OR REPLACE FUNCTION public.reject_account_paid_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'ACCOUNT_PAID_EVIDENCE_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_account_paid_evidence_mutation()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reject_account_paid_evidence_mutation_before_write
BEFORE UPDATE OR DELETE ON public.account_paid_evidence
FOR EACH ROW
EXECUTE FUNCTION public.reject_account_paid_evidence_mutation();

CREATE OR REPLACE FUNCTION public.enforce_account_paid_ever_monotonic()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF OLD.is_paid_user IS TRUE AND NEW.is_paid_user IS NOT TRUE THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_PAID_EVER_REGRESSION',
            ERRCODE = 'P0001';
    END IF;
    IF OLD.first_paid_at IS NOT NULL
       AND (
            NEW.first_paid_at IS NULL
            OR NEW.first_paid_at > OLD.first_paid_at
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_FIRST_PAID_AT_REGRESSION',
            ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_account_paid_ever_monotonic()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER enforce_account_paid_ever_monotonic_before_update
BEFORE UPDATE OF is_paid_user, first_paid_at ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.enforce_account_paid_ever_monotonic();

CREATE OR REPLACE FUNCTION public.account_profile_patch_valid(
    p_patch JSONB,
    p_allow_phone BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_typeof(p_patch) = 'object'
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_each(p_patch) AS patch_item(key, value)
            WHERE patch_item.key NOT IN (
                    'name', 'nickname', 'profile_image', 'gender', 'birthyear'
                )
                AND NOT (
                    p_allow_phone
                    AND patch_item.key IN (
                        'phone_number',
                        'phone_number_normalized',
                        'phone_number_verification_source',
                        'phone_number_verified_at'
                    )
                )
               OR pg_catalog.jsonb_typeof(patch_item.value)
                    NOT IN ('string', 'null')
       )
$$;

REVOKE ALL ON FUNCTION public.account_profile_patch_valid(JSONB, BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.load_account_principal_v1(p_user_id UUID)
RETURNS TABLE(
    id UUID,
    email VARCHAR,
    provider VARCHAR,
    analysis_count INTEGER,
    is_paid_user BOOLEAN,
    is_unlimited BOOLEAN,
    created_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE,
    name VARCHAR,
    nickname VARCHAR,
    profile_image TEXT,
    gender VARCHAR,
    birthyear VARCHAR,
    account_class TEXT,
    traffic_class TEXT,
    lifecycle TEXT,
    first_paid_at TIMESTAMP WITH TIME ZONE,
    has_active_purchase BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_lifecycle TEXT;
BEGIN
    SELECT account.lifecycle
    INTO v_lifecycle
    FROM public.users AS account
    WHERE account.id = p_user_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;
    IF v_lifecycle <> 'active' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_RETIRED',
            ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    SELECT account.id,
        account.email,
        account.provider,
        COALESCE(account.analysis_count, 0),
        COALESCE(account.is_paid_user, FALSE),
        COALESCE(account.is_unlimited, FALSE),
        account.created_at,
        account.updated_at,
        account.name,
        account.nickname,
        account.profile_image,
        account.gender,
        account.birthyear,
        account.account_class,
        account.traffic_class,
        account.lifecycle,
        account.first_paid_at,
        EXISTS (
            SELECT 1
            FROM public.account_paid_evidence AS evidence
            JOIN public.earlybird_orders AS paid_order
              ON paid_order.id = evidence.order_id
            WHERE evidence.account_id = account.id
              AND evidence.counts_as_external IS TRUE
              AND paid_order.status IN (
                  'paid', 'analysis_in_progress', 'completed'
              )
        ) AS has_active_purchase
    FROM public.users AS account
    WHERE account.id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_account_principal_v1(
    p_user_id UUID,
    p_email TEXT,
    p_provider TEXT,
    p_profile JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE(
    id UUID,
    email VARCHAR,
    provider VARCHAR,
    analysis_count INTEGER,
    is_paid_user BOOLEAN,
    is_unlimited BOOLEAN,
    created_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE,
    name VARCHAR,
    nickname VARCHAR,
    profile_image TEXT,
    gender VARCHAR,
    birthyear VARCHAR,
    account_class TEXT,
    traffic_class TEXT,
    lifecycle TEXT,
    first_paid_at TIMESTAMP WITH TIME ZONE,
    has_active_purchase BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_existing public.users%ROWTYPE;
BEGIN
    IF p_user_id IS NULL
       OR p_email IS NULL
       OR pg_catalog.btrim(p_email) = ''
       OR pg_catalog.char_length(p_email) > 255
       OR p_provider NOT IN ('google', 'kakao')
       OR NOT public.account_profile_patch_valid(p_profile, FALSE) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_PRINCIPAL_INPUT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT account.*
    INTO v_existing
    FROM public.users AS account
    WHERE account.id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.users (
            id, email, provider, analysis_count, is_paid_user, is_unlimited,
            name, nickname, profile_image, gender, birthyear,
            account_class, traffic_class, lifecycle, classification_version
        ) VALUES (
            p_user_id,
            pg_catalog.btrim(p_email),
            p_provider,
            0,
            FALSE,
            FALSE,
            NULLIF(p_profile ->> 'name', ''),
            NULLIF(p_profile ->> 'nickname', ''),
            NULLIF(p_profile ->> 'profile_image', ''),
            NULLIF(p_profile ->> 'gender', ''),
            NULLIF(p_profile ->> 'birthyear', ''),
            'production',
            'external',
            'active',
            'runtime_default_v1'
        );
    ELSE
        IF v_existing.lifecycle <> 'active' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_RETIRED',
                ERRCODE = 'P0001';
        END IF;
        UPDATE public.users AS account
        SET name = COALESCE(
                account.name, NULLIF(p_profile ->> 'name', '')
            ),
            nickname = COALESCE(
                account.nickname, NULLIF(p_profile ->> 'nickname', '')
            ),
            profile_image = COALESCE(
                account.profile_image,
                NULLIF(p_profile ->> 'profile_image', '')
            ),
            gender = COALESCE(
                account.gender, NULLIF(p_profile ->> 'gender', '')
            ),
            birthyear = COALESCE(
                account.birthyear, NULLIF(p_profile ->> 'birthyear', '')
            )
        WHERE account.id = p_user_id;
    END IF;

    RETURN QUERY
    SELECT principal.*
    FROM public.load_account_principal_v1(p_user_id) AS principal;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_kakao_account_profile_v1(
    p_user_id UUID,
    p_email TEXT,
    p_profile JSONB
)
RETURNS TABLE(
    id UUID,
    account_class TEXT,
    traffic_class TEXT,
    lifecycle TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_existing public.users%ROWTYPE;
BEGIN
    IF p_user_id IS NULL
       OR (p_email IS NOT NULL AND (
            pg_catalog.btrim(p_email) = ''
            OR pg_catalog.char_length(p_email) > 255
       ))
       OR NOT public.account_profile_patch_valid(p_profile, TRUE) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_KAKAO_PROFILE_INPUT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT account.*
    INTO v_existing
    FROM public.users AS account
    WHERE account.id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        IF p_email IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_KAKAO_EMAIL_REQUIRED',
                ERRCODE = 'P0001';
        END IF;
        INSERT INTO public.users (
            id, email, provider, analysis_count, is_paid_user, is_unlimited,
            name, nickname, profile_image, gender, birthyear,
            phone_number, phone_number_normalized,
            phone_number_verification_source, phone_number_verified_at,
            account_class, traffic_class, lifecycle, classification_version
        ) VALUES (
            p_user_id,
            pg_catalog.btrim(p_email),
            'kakao',
            0,
            FALSE,
            FALSE,
            NULLIF(p_profile ->> 'name', ''),
            NULLIF(p_profile ->> 'nickname', ''),
            NULLIF(p_profile ->> 'profile_image', ''),
            NULLIF(p_profile ->> 'gender', ''),
            NULLIF(p_profile ->> 'birthyear', ''),
            NULLIF(p_profile ->> 'phone_number', ''),
            NULLIF(p_profile ->> 'phone_number_normalized', ''),
            NULLIF(p_profile ->> 'phone_number_verification_source', ''),
            CASE
                WHEN p_profile ->> 'phone_number_verified_at' IS NULL
                    THEN NULL
                ELSE (p_profile ->> 'phone_number_verified_at')
                    ::TIMESTAMP WITH TIME ZONE
            END,
            'production',
            'external',
            'active',
            'runtime_default_v1'
        );
    ELSE
        IF v_existing.lifecycle <> 'active' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_RETIRED',
                ERRCODE = 'P0001';
        END IF;
        UPDATE public.users AS account
        SET email = COALESCE(pg_catalog.btrim(p_email), account.email),
            provider = 'kakao',
            name = CASE WHEN p_profile ? 'name'
                THEN NULLIF(p_profile ->> 'name', '') ELSE account.name END,
            nickname = CASE WHEN p_profile ? 'nickname'
                THEN NULLIF(p_profile ->> 'nickname', '')
                ELSE account.nickname END,
            profile_image = CASE WHEN p_profile ? 'profile_image'
                THEN NULLIF(p_profile ->> 'profile_image', '')
                ELSE account.profile_image END,
            gender = CASE WHEN p_profile ? 'gender'
                THEN NULLIF(p_profile ->> 'gender', '')
                ELSE account.gender END,
            birthyear = CASE WHEN p_profile ? 'birthyear'
                THEN NULLIF(p_profile ->> 'birthyear', '')
                ELSE account.birthyear END,
            phone_number = CASE WHEN p_profile ? 'phone_number'
                THEN NULLIF(p_profile ->> 'phone_number', '')
                ELSE account.phone_number END,
            phone_number_normalized = CASE
                WHEN p_profile ? 'phone_number_normalized'
                    THEN NULLIF(p_profile ->> 'phone_number_normalized', '')
                ELSE account.phone_number_normalized
            END,
            phone_number_verification_source = CASE
                WHEN p_profile ? 'phone_number_verification_source'
                    THEN NULLIF(
                        p_profile ->> 'phone_number_verification_source', ''
                    )
                ELSE account.phone_number_verification_source
            END,
            phone_number_verified_at = CASE
                WHEN NOT (p_profile ? 'phone_number_verified_at')
                    THEN account.phone_number_verified_at
                WHEN p_profile ->> 'phone_number_verified_at' IS NULL
                    THEN NULL
                ELSE (p_profile ->> 'phone_number_verified_at')
                    ::TIMESTAMP WITH TIME ZONE
            END
        WHERE account.id = p_user_id;
    END IF;

    RETURN QUERY
    SELECT account.id,
        account.account_class,
        account.traffic_class,
        account.lifecycle
    FROM public.users AS account
    WHERE account.id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.load_account_checkout_phone_v1(
    p_user_id UUID
)
RETURNS TABLE(
    id UUID,
    provider VARCHAR,
    phone_number VARCHAR,
    phone_number_normalized TEXT,
    phone_number_verification_source TEXT,
    phone_number_verified_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_lifecycle TEXT;
BEGIN
    SELECT account.lifecycle
    INTO v_lifecycle
    FROM public.users AS account
    WHERE account.id = p_user_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    IF v_lifecycle <> 'active' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_RETIRED',
            ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    SELECT account.id,
        account.provider,
        account.phone_number,
        account.phone_number_normalized,
        account.phone_number_verification_source,
        account.phone_number_verified_at
    FROM public.users AS account
    WHERE account.id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.load_account_classification_v1(
    p_user_id UUID
)
RETURNS TABLE(
    id UUID,
    account_class TEXT,
    traffic_class TEXT,
    lifecycle TEXT,
    classification_version TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT account.id,
        account.account_class,
        account.traffic_class,
        account.lifecycle,
        account.classification_version
    FROM public.users AS account
    WHERE account.id = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.record_external_paid_ever(
    p_order_id UUID,
    p_event_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_state TEXT;
    v_evidence RECORD;
    v_existing public.account_paid_evidence%ROWTYPE;
    v_counts_as_external BOOLEAN;
BEGIN
    SELECT rollout.paid_ever_state
    INTO v_state
    FROM public.account_ledger_rollout_state AS rollout
    WHERE rollout.singleton IS TRUE
    FOR SHARE;
    IF v_state IS DISTINCT FROM 'active' THEN
        RETURN FALSE;
    END IF;

    SELECT paid_order.id AS order_id,
        webhook_event.event_id,
        paid_order.user_id AS account_id,
        paid_order.payment_id,
        paid_order.paid_at,
        paid_order.actual_amount_krw AS amount_krw,
        paid_order.status AS order_status,
        account.traffic_class,
        account.classification_version
    INTO v_evidence
    FROM public.earlybird_orders AS paid_order
    JOIN public.earlybird_webhook_events AS webhook_event
      ON webhook_event.order_id = paid_order.id
    JOIN public.users AS account
      ON account.id = paid_order.user_id
    WHERE paid_order.id = p_order_id
      AND webhook_event.event_id = p_event_id
      AND webhook_event.event_type = 'payment.completed'
      AND webhook_event.disposition = 'accepted'
      AND webhook_event.payment_id = paid_order.payment_id
      AND webhook_event.product_id = paid_order.actual_groble_product_id
      AND webhook_event.amount_krw = paid_order.actual_amount_krw
      AND paid_order.payment_id IS NOT NULL
      AND paid_order.paid_at IS NOT NULL
      AND paid_order.actual_amount_krw > 0
    FOR SHARE OF paid_order, account;

    IF NOT FOUND OR v_evidence.classification_version IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_PAID_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    IF v_evidence.order_status NOT IN (
        'paid',
        'analysis_in_progress',
        'completed',
        'overflow_refund_required',
        'refund_pending',
        'refunded'
    ) THEN
        RETURN FALSE;
    END IF;

    v_counts_as_external := v_evidence.traffic_class = 'external';

    INSERT INTO public.account_paid_evidence (
        order_id, event_id, account_id, payment_id, paid_at, amount_krw,
        counts_as_external
    ) VALUES (
        v_evidence.order_id,
        v_evidence.event_id,
        v_evidence.account_id,
        v_evidence.payment_id,
        v_evidence.paid_at,
        v_evidence.amount_krw,
        v_counts_as_external
    )
    ON CONFLICT (order_id) DO NOTHING;

    SELECT evidence.*
    INTO v_existing
    FROM public.account_paid_evidence AS evidence
    WHERE evidence.order_id = v_evidence.order_id;

    IF v_existing.event_id IS DISTINCT FROM v_evidence.event_id
       OR v_existing.account_id IS DISTINCT FROM v_evidence.account_id
       OR v_existing.payment_id IS DISTINCT FROM v_evidence.payment_id
       OR v_existing.paid_at IS DISTINCT FROM v_evidence.paid_at
       OR v_existing.amount_krw IS DISTINCT FROM v_evidence.amount_krw
       OR v_existing.counts_as_external
            IS DISTINCT FROM v_counts_as_external THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_PAID_EVIDENCE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_counts_as_external THEN
        UPDATE public.users AS account
        SET is_paid_user = TRUE,
            first_paid_at = CASE
                WHEN account.first_paid_at IS NULL
                    THEN v_evidence.paid_at
                ELSE LEAST(
                    account.first_paid_at, v_evidence.paid_at
                )
            END
        WHERE account.id = v_evidence.account_id;
    END IF;

    RETURN v_counts_as_external;
END;
$$;

CREATE OR REPLACE FUNCTION public.classify_account_principals_v1(
    p_assignments JSONB,
    p_command_version TEXT,
    p_activate_paid_ever BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(
    updated_count INTEGER,
    evidence_count INTEGER,
    paid_account_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_assignment JSONB;
    v_account public.users%ROWTYPE;
    v_account_id UUID;
    v_account_class TEXT;
    v_traffic_class TEXT;
    v_lifecycle TEXT;
    v_reason_code TEXT;
    v_updated_count INTEGER := 0;
    v_event RECORD;
BEGIN
    IF p_command_version IS NULL
       OR p_command_version !~ '^[a-z0-9._-]{1,64}$'
       OR pg_catalog.jsonb_typeof(p_assignments) <> 'array'
       OR pg_catalog.jsonb_array_length(p_assignments) NOT BETWEEN 1 AND 100
       OR (
            SELECT pg_catalog.count(*)
            FROM (
                SELECT assignment ->> 'account_id'
                FROM pg_catalog.jsonb_array_elements(p_assignments)
                    AS assignment
                GROUP BY assignment ->> 'account_id'
                HAVING pg_catalog.count(*) > 1
            ) AS duplicate_assignment
       ) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_CLASSIFICATION_INPUT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    FOR v_assignment IN
        SELECT assignment
        FROM pg_catalog.jsonb_array_elements(p_assignments) AS assignment
        ORDER BY assignment ->> 'account_id'
    LOOP
        IF pg_catalog.jsonb_typeof(v_assignment) <> 'object'
           OR EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_object_keys(v_assignment) AS assignment_key
                WHERE assignment_key NOT IN (
                    'account_id', 'account_class', 'traffic_class',
                    'lifecycle', 'reason_code'
                )
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_CLASSIFICATION_INPUT_INVALID',
                ERRCODE = 'P0001';
        END IF;

        BEGIN
            v_account_id := (v_assignment ->> 'account_id')::UUID;
        EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_CLASSIFICATION_INPUT_INVALID',
                ERRCODE = 'P0001';
        END;
        v_account_class := v_assignment ->> 'account_class';
        v_traffic_class := v_assignment ->> 'traffic_class';
        v_lifecycle := v_assignment ->> 'lifecycle';
        v_reason_code := v_assignment ->> 'reason_code';

        IF v_account_class NOT IN ('production', 'e2e_test')
           OR v_traffic_class NOT IN (
                'external', 'operator', 'e2e_test', 'internal_tester'
           )
           OR v_lifecycle NOT IN ('active', 'retired')
           OR v_reason_code IS NULL
           OR v_reason_code !~ '^[A-Z0-9_]{1,64}$' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_CLASSIFICATION_INPUT_INVALID',
                ERRCODE = 'P0001';
        END IF;

        SELECT account.*
        INTO v_account
        FROM public.users AS account
        WHERE account.id = v_account_id
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_CLASSIFICATION_ACCOUNT_NOT_FOUND',
                ERRCODE = 'P0001';
        END IF;

        INSERT INTO public.account_classification_audit (
            account_id, command_version, reason_code,
            previous_account_class, previous_traffic_class,
            previous_lifecycle, next_account_class, next_traffic_class,
            next_lifecycle
        ) VALUES (
            v_account_id, p_command_version, v_reason_code,
            v_account.account_class, v_account.traffic_class,
            v_account.lifecycle, v_account_class, v_traffic_class,
            v_lifecycle
        );

        UPDATE public.users AS account
        SET account_class = v_account_class,
            traffic_class = v_traffic_class,
            lifecycle = v_lifecycle,
            classification_version = p_command_version
        WHERE account.id = v_account_id;
        v_updated_count := v_updated_count + 1;
    END LOOP;

    IF p_activate_paid_ever THEN
        IF EXISTS (
            SELECT 1
            FROM public.users AS account
            WHERE account.classification_version IS NULL
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_CLASSIFICATION_INCOMPLETE',
                ERRCODE = 'P0001';
        END IF;

        UPDATE public.account_ledger_rollout_state AS rollout
        SET paid_ever_state = 'active',
            classification_command_version = p_command_version,
            classification_completed_at = pg_catalog.clock_timestamp(),
            updated_at = pg_catalog.clock_timestamp()
        WHERE rollout.singleton IS TRUE
          AND rollout.paid_ever_state = 'pending';

        IF NOT FOUND AND NOT EXISTS (
            SELECT 1
            FROM public.account_ledger_rollout_state AS rollout
            WHERE rollout.singleton IS TRUE
              AND rollout.paid_ever_state = 'active'
              AND rollout.classification_command_version = p_command_version
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_PAID_EVER_ACTIVATION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        FOR v_event IN
            SELECT webhook_event.order_id,
                webhook_event.event_id
            FROM public.earlybird_webhook_events AS webhook_event
            JOIN public.earlybird_orders AS paid_order
              ON paid_order.id = webhook_event.order_id
            WHERE webhook_event.event_type = 'payment.completed'
              AND webhook_event.disposition = 'accepted'
              AND webhook_event.order_id IS NOT NULL
              AND webhook_event.payment_id = paid_order.payment_id
              AND webhook_event.product_id
                    = paid_order.actual_groble_product_id
              AND webhook_event.amount_krw = paid_order.actual_amount_krw
              AND paid_order.actual_amount_krw > 0
              AND paid_order.status IN (
                    'paid',
                    'analysis_in_progress',
                    'completed',
                    'overflow_refund_required',
                    'refund_pending',
                    'refunded'
              )
            ORDER BY webhook_event.order_id::TEXT
        LOOP
            PERFORM public.record_external_paid_ever(
                v_event.order_id, v_event.event_id
            );
        END LOOP;
    END IF;

    RETURN QUERY
    SELECT v_updated_count,
        (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.account_paid_evidence
        ),
        (
            SELECT pg_catalog.count(*)::INTEGER
            FROM public.users AS account
            WHERE account.is_paid_user IS TRUE
        );
END;
$$;

-- Recreate all three payment-completion entry points. The refund-aware
-- delegate remains the single attribution/locking authority; the wrapper only
-- resolves its immutable accepted event and calls the idempotent paid helper.
CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment(
    p_event_id TEXT,
    p_idempotency_key TEXT,
    p_event_type TEXT,
    p_occurred_at TIMESTAMP WITH TIME ZONE,
    p_payment_id TEXT,
    p_buyer_email TEXT,
    p_buyer_phone_normalized TEXT,
    p_buyer_phone_raw TEXT,
    p_buyer_display_name TEXT,
    p_product_id TEXT,
    p_amount_krw INTEGER,
    p_paid_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(disposition TEXT, order_id UUID, status TEXT, plan_sequence SMALLINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_result RECORD;
    v_accepted_event_id TEXT;
BEGIN
    SELECT finalized.* INTO v_result
    FROM public.finalize_earlybird_groble_payment_refund_aware(
        NULL::UUID, FALSE, p_event_id, p_idempotency_key, p_event_type,
        p_occurred_at, p_payment_id, p_buyer_email, p_buyer_phone_normalized,
        p_buyer_phone_raw, p_buyer_display_name, p_product_id, p_amount_krw,
        p_paid_at
    ) AS finalized;

    SELECT webhook_event.event_id
    INTO v_accepted_event_id
    FROM public.earlybird_webhook_events AS webhook_event
    WHERE webhook_event.order_id = v_result.order_id
      AND webhook_event.event_type = 'payment.completed'
      AND webhook_event.disposition = 'accepted'
    ORDER BY (webhook_event.event_id = p_event_id) DESC,
        webhook_event.processed_at,
        webhook_event.event_id
    LIMIT 1;
    IF FOUND THEN
        PERFORM public.record_external_paid_ever(
            v_result.order_id, v_accepted_event_id
        );
    END IF;

    RETURN QUERY SELECT v_result.disposition::TEXT, v_result.order_id::UUID,
        v_result.status::TEXT, v_result.plan_sequence::SMALLINT;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment_by_reference(
    p_seller_reference TEXT,
    p_event_id TEXT,
    p_idempotency_key TEXT,
    p_event_type TEXT,
    p_occurred_at TIMESTAMP WITH TIME ZONE,
    p_payment_id TEXT,
    p_buyer_email TEXT,
    p_buyer_phone_normalized TEXT,
    p_buyer_phone_raw TEXT,
    p_buyer_display_name TEXT,
    p_product_id TEXT,
    p_amount_krw INTEGER,
    p_paid_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(disposition TEXT, order_id UUID, status TEXT, plan_sequence SMALLINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_referenced_order_id UUID;
    v_result RECORD;
    v_accepted_event_id TEXT;
BEGIN
    IF p_seller_reference IS NULL
       OR p_seller_reference !~ '^ord[.][a-f0-9]{32}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT paid_order.id INTO v_referenced_order_id
    FROM public.earlybird_orders AS paid_order
    WHERE paid_order.groble_seller_reference = p_seller_reference;
    IF v_referenced_order_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_SELLER_REFERENCE_UNMATCHED',
            ERRCODE = 'P0001';
    END IF;

    SELECT finalized.* INTO v_result
    FROM public.finalize_earlybird_groble_payment_refund_aware(
        v_referenced_order_id, FALSE, p_event_id, p_idempotency_key,
        p_event_type, p_occurred_at, p_payment_id, p_buyer_email,
        p_buyer_phone_normalized, p_buyer_phone_raw, p_buyer_display_name,
        p_product_id, p_amount_krw, p_paid_at
    ) AS finalized;

    IF v_result.order_id = v_referenced_order_id
       AND v_result.status IN ('paid', 'analysis_in_progress', 'completed') THEN
        UPDATE public.earlybird_orders AS paid_order
        SET seller_reference_confirmed_at = COALESCE(
                paid_order.seller_reference_confirmed_at,
                pg_catalog.clock_timestamp()
            ),
            updated_at = pg_catalog.clock_timestamp()
        WHERE paid_order.id = v_referenced_order_id;
    END IF;

    SELECT webhook_event.event_id
    INTO v_accepted_event_id
    FROM public.earlybird_webhook_events AS webhook_event
    WHERE webhook_event.order_id = v_result.order_id
      AND webhook_event.event_type = 'payment.completed'
      AND webhook_event.disposition = 'accepted'
    ORDER BY (webhook_event.event_id = p_event_id) DESC,
        webhook_event.processed_at,
        webhook_event.event_id
    LIMIT 1;
    IF FOUND THEN
        PERFORM public.record_external_paid_ever(
            v_result.order_id, v_accepted_event_id
        );
    END IF;

    RETURN QUERY SELECT v_result.disposition::TEXT, v_result.order_id::UUID,
        v_result.status::TEXT, v_result.plan_sequence::SMALLINT;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment(
    p_event_id TEXT,
    p_idempotency_key TEXT,
    p_event_type TEXT,
    p_occurred_at TIMESTAMP WITH TIME ZONE,
    p_payment_id TEXT,
    p_buyer_email TEXT,
    p_product_id TEXT,
    p_amount_krw INTEGER,
    p_paid_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(disposition TEXT, order_id UUID, status TEXT, plan_sequence SMALLINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_result RECORD;
    v_accepted_event_id TEXT;
BEGIN
    SELECT finalized.* INTO v_result
    FROM public.finalize_earlybird_groble_payment_refund_aware(
        NULL::UUID, TRUE, p_event_id, p_idempotency_key, p_event_type,
        p_occurred_at, p_payment_id, p_buyer_email, NULL::TEXT, NULL::TEXT,
        NULL::TEXT, p_product_id, p_amount_krw, p_paid_at
    ) AS finalized;

    SELECT webhook_event.event_id
    INTO v_accepted_event_id
    FROM public.earlybird_webhook_events AS webhook_event
    WHERE webhook_event.order_id = v_result.order_id
      AND webhook_event.event_type = 'payment.completed'
      AND webhook_event.disposition = 'accepted'
    ORDER BY (webhook_event.event_id = p_event_id) DESC,
        webhook_event.processed_at,
        webhook_event.event_id
    LIMIT 1;
    IF FOUND THEN
        PERFORM public.record_external_paid_ever(
            v_result.order_id, v_accepted_event_id
        );
    END IF;

    RETURN QUERY SELECT v_result.disposition::TEXT, v_result.order_id::UUID,
        v_result.status::TEXT, v_result.plan_sequence::SMALLINT;
END;
$$;

REVOKE ALL ON FUNCTION public.load_account_principal_v1(UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_account_principal_v1(
    UUID, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_kakao_account_profile_v1(
    UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_account_checkout_phone_v1(UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_account_classification_v1(UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_external_paid_ever(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.classify_account_principals_v1(
    JSONB, TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.load_account_principal_v1(UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_account_principal_v1(
    UUID, TEXT, TEXT, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_kakao_account_profile_v1(
    UUID, TEXT, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_account_checkout_phone_v1(UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.load_account_classification_v1(UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.record_external_paid_ever(UUID, TEXT)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.classify_account_principals_v1(
    JSONB, TEXT, BOOLEAN
) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment_by_reference(
    TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, TEXT,
    TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment_by_reference(
    TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, INTEGER, TIMESTAMP WITH TIME ZONE
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_earlybird_groble_payment(
    TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,
    TIMESTAMP WITH TIME ZONE
) TO service_role;
