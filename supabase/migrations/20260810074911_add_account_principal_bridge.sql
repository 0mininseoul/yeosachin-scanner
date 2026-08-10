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
    ADD CONSTRAINT users_classification_pair_check CHECK (
        (
            account_class = 'production'
            AND traffic_class IN ('external', 'operator')
        )
        OR (
            account_class = 'e2e_test'
            AND traffic_class IN ('e2e_test', 'internal_tester')
        )
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
ALTER TABLE public.users VALIDATE CONSTRAINT users_classification_pair_check;
ALTER TABLE public.users VALIDATE CONSTRAINT users_classification_version_check;
ALTER TABLE public.users VALIDATE CONSTRAINT users_paid_ever_shape_check;

-- Preserve NULL for the pre-existing rows until the approved classification
-- command reviews them, while keeping legacy user INSERT functions on the
-- production/external runtime path after this bridge is deployed.
ALTER TABLE public.users
    ALTER COLUMN classification_version SET DEFAULT 'runtime_default_v1';

-- Phase A/B keeps the physical relation named users, but the new account
-- fields are already part of the service-owned ledger. Do not leave the
-- legacy authenticated self-select policy as a second client read path.
REVOKE ALL ON TABLE public.users
    FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users
    TO service_role;

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
    SELECT p_patch IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_patch) = 'object'
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
       OR p_provider IS NULL
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
    v_account_id UUID;
    v_evidence RECORD;
    v_existing public.account_paid_evidence%ROWTYPE;
    v_counts_as_external BOOLEAN;
BEGIN
    SELECT paid_order.user_id
    INTO v_account_id
    FROM public.earlybird_orders AS paid_order
    WHERE paid_order.id = p_order_id;

    IF FOUND THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(v_account_id::TEXT, 0)
        );
    END IF;

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
    v_activation_replay BOOLEAN := FALSE;
    v_rollout_state TEXT;
    v_rollout_command_version TEXT;
BEGIN
    IF p_command_version IS NULL
       OR p_command_version !~ '^[a-z0-9._-]{1,64}$'
       OR p_assignments IS NULL
       OR pg_catalog.jsonb_typeof(p_assignments) IS DISTINCT FROM 'array'
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

    IF p_activate_paid_ever IS TRUE THEN
        SELECT rollout.paid_ever_state,
            rollout.classification_command_version
        INTO v_rollout_state, v_rollout_command_version
        FROM public.account_ledger_rollout_state AS rollout
        WHERE rollout.singleton IS TRUE;

        IF v_rollout_state = 'active'
           AND v_rollout_command_version IS DISTINCT FROM p_command_version THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_PAID_EVER_ACTIVATION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    ELSE
        SELECT rollout.paid_ever_state
        INTO v_rollout_state
        FROM public.account_ledger_rollout_state AS rollout
        WHERE rollout.singleton IS TRUE;

        IF v_rollout_state = 'active' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_CLASSIFICATION_ROLLOUT_ACTIVE',
                ERRCODE = 'P0001';
        END IF;
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
        IF v_account_id IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_CLASSIFICATION_INPUT_INVALID',
                ERRCODE = 'P0001';
        END IF;
        v_account_class := v_assignment ->> 'account_class';
        v_traffic_class := v_assignment ->> 'traffic_class';
        v_lifecycle := v_assignment ->> 'lifecycle';
        v_reason_code := v_assignment ->> 'reason_code';

        IF v_account_class IS NULL
           OR v_account_class NOT IN ('production', 'e2e_test')
           OR v_traffic_class IS NULL
           OR v_traffic_class NOT IN (
                'external', 'operator', 'e2e_test', 'internal_tester'
           )
           OR (
                v_account_class = 'production'
                AND v_traffic_class NOT IN ('external', 'operator')
           )
           OR (
                v_account_class = 'e2e_test'
                AND v_traffic_class NOT IN ('e2e_test', 'internal_tester')
           )
           OR v_lifecycle IS NULL
           OR v_lifecycle NOT IN ('active', 'retired')
           OR v_reason_code IS NULL
           OR v_reason_code !~ '^[A-Z0-9_]{1,64}$' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_CLASSIFICATION_INPUT_INVALID',
                ERRCODE = 'P0001';
        END IF;

        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(v_account_id::TEXT, 0)
        );

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

        -- The first rollout read is only an early rejection. A pending
        -- command can have waited for this account lock while activation
        -- completed, so recheck in the account -> rollout lock order before
        -- writing the classification.
        IF p_activate_paid_ever IS NOT TRUE THEN
            SELECT rollout.paid_ever_state
            INTO v_rollout_state
            FROM public.account_ledger_rollout_state AS rollout
            WHERE rollout.singleton IS TRUE
            FOR SHARE;

            IF v_rollout_state = 'active' THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'ACCOUNT_CLASSIFICATION_ROLLOUT_ACTIVE',
                    ERRCODE = 'P0001';
            END IF;
        END IF;

        IF p_activate_paid_ever IS TRUE THEN
            SELECT rollout.paid_ever_state,
                rollout.classification_command_version
            INTO v_rollout_state, v_rollout_command_version
            FROM public.account_ledger_rollout_state AS rollout
            WHERE rollout.singleton IS TRUE;

            IF v_rollout_state = 'active' THEN
                IF v_rollout_command_version IS DISTINCT FROM p_command_version THEN
                    RAISE EXCEPTION USING
                        MESSAGE = 'ACCOUNT_PAID_EVER_ACTIVATION_CONFLICT',
                        ERRCODE = 'P0001';
                END IF;
                IF v_account.classification_version IS DISTINCT FROM p_command_version
                   OR v_account.account_class IS DISTINCT FROM v_account_class
                   OR v_account.traffic_class IS DISTINCT FROM v_traffic_class
                   OR v_account.lifecycle IS DISTINCT FROM v_lifecycle
                   OR NOT EXISTS (
                        SELECT 1
                        FROM public.account_classification_audit AS audit
                        WHERE audit.account_id = v_account_id
                          AND audit.command_version = p_command_version
                          AND audit.reason_code = v_reason_code
                          AND audit.next_account_class = v_account_class
                          AND audit.next_traffic_class = v_traffic_class
                          AND audit.next_lifecycle = v_lifecycle
                   ) THEN
                    RAISE EXCEPTION USING
                        MESSAGE = 'ACCOUNT_PAID_EVER_ACTIVATION_CONFLICT',
                        ERRCODE = 'P0001';
                END IF;
                v_activation_replay := TRUE;
            END IF;
        END IF;

        IF NOT v_activation_replay THEN
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
        END IF;
    END LOOP;

    IF p_activate_paid_ever THEN
        IF NOT v_activation_replay THEN
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

-- This is the approved legacy E2E marker. It is deliberately a relationship
-- predicate, not an email convention or a hand-written UUID allowlist: an
-- unclassified principal without Auth must have both historical analysis and
-- positive-payment-shaped order lineage, while having no accepted external
-- payment lineage. The operator command HMACs its sorted result before any
-- classification can be applied.
CREATE OR REPLACE FUNCTION public.account_ledger_legacy_e2e_candidate_ids_v1()
RETURNS TABLE(account_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT account.id
    FROM public.users AS account
    WHERE account.classification_version IS NULL
      AND NOT EXISTS (
          SELECT 1
          FROM auth.users AS auth_user
          WHERE auth_user.id = account.id
      )
      AND EXISTS (
          SELECT 1
          FROM public.analysis_requests AS analysis_request
          WHERE analysis_request.user_id = account.id
      )
      AND EXISTS (
          SELECT 1
          FROM public.earlybird_orders AS paid_order
          WHERE paid_order.user_id = account.id
            AND paid_order.payment_id IS NOT NULL
            AND paid_order.paid_at IS NOT NULL
            AND paid_order.actual_amount_krw > 0
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_orders AS paid_order
          JOIN public.earlybird_webhook_events AS webhook_event
            ON webhook_event.order_id = paid_order.id
          WHERE paid_order.user_id = account.id
            AND webhook_event.event_type = 'payment.completed'
            AND webhook_event.disposition = 'accepted'
            AND webhook_event.payment_id = paid_order.payment_id
            AND webhook_event.product_id = paid_order.actual_groble_product_id
            AND webhook_event.amount_krw = paid_order.actual_amount_krw
      )
    ORDER BY account.id
$$;

REVOKE ALL ON FUNCTION public.account_ledger_legacy_e2e_candidate_ids_v1()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_account_ledger_legacy_e2e_candidates_v1()
RETURNS TABLE(account_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT candidate.account_id
    FROM public.account_ledger_legacy_e2e_candidate_ids_v1() AS candidate
$$;

REVOKE ALL ON FUNCTION public.list_account_ledger_legacy_e2e_candidates_v1()
    FROM PUBLIC, anon, authenticated, service_role;

-- Build the full bounded payload inside PostgreSQL after recomputing the
-- legacy set. The command receives opaque IDs only from Keychain and never
-- serializes this JSON payload to stdout or an observability sink.
CREATE OR REPLACE FUNCTION public.build_account_ledger_classification_plan_v1(
    p_legacy_candidate_ids JSONB,
    p_operator_account_ids JSONB,
    p_internal_tester_account_ids JSONB
)
RETURNS TABLE(
    assignments JSONB,
    total_count INTEGER,
    legacy_e2e_count INTEGER,
    operator_count INTEGER,
    internal_tester_count INTEGER,
    production_external_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_legacy_ids JSONB;
    v_operator_ids JSONB;
    v_internal_tester_ids JSONB;
    v_actual_legacy_ids JSONB;
    v_total_count INTEGER;
    v_legacy_count INTEGER;
    v_operator_count INTEGER;
    v_internal_tester_count INTEGER;
    v_production_external_count INTEGER;
    v_assignments JSONB;
BEGIN
    IF p_legacy_candidate_ids IS NULL
       OR p_operator_account_ids IS NULL
       OR p_internal_tester_account_ids IS NULL
       OR pg_catalog.jsonb_typeof(p_legacy_candidate_ids) <> 'array'
       OR pg_catalog.jsonb_typeof(p_operator_account_ids) <> 'array'
       OR pg_catalog.jsonb_typeof(p_internal_tester_account_ids) <> 'array'
       OR pg_catalog.jsonb_array_length(p_legacy_candidate_ids) NOT BETWEEN 1 AND 100
       OR pg_catalog.jsonb_array_length(p_operator_account_ids) NOT BETWEEN 1 AND 16
       OR pg_catalog.jsonb_array_length(p_internal_tester_account_ids) NOT BETWEEN 1 AND 16
       OR EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_array_elements(p_legacy_candidate_ids) AS item
           WHERE pg_catalog.jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       )
       OR EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_array_elements(p_operator_account_ids) AS item
           WHERE pg_catalog.jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       )
       OR EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_array_elements(p_internal_tester_account_ids) AS item
           WHERE pg_catalog.jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_CLASSIFICATION_INPUT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(value) ORDER BY value)
    INTO v_legacy_ids
    FROM pg_catalog.jsonb_array_elements_text(p_legacy_candidate_ids) AS value;
    SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(value) ORDER BY value)
    INTO v_operator_ids
    FROM pg_catalog.jsonb_array_elements_text(p_operator_account_ids) AS value;
    SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(value) ORDER BY value)
    INTO v_internal_tester_ids
    FROM pg_catalog.jsonb_array_elements_text(p_internal_tester_account_ids) AS value;

    IF (
        SELECT pg_catalog.count(*)
        FROM (
            SELECT value FROM pg_catalog.jsonb_array_elements_text(v_legacy_ids)
            UNION ALL
            SELECT value FROM pg_catalog.jsonb_array_elements_text(v_operator_ids)
            UNION ALL
            SELECT value FROM pg_catalog.jsonb_array_elements_text(v_internal_tester_ids)
        ) AS supplied_id
    ) <> (
        SELECT pg_catalog.count(DISTINCT value)
        FROM (
            SELECT value FROM pg_catalog.jsonb_array_elements_text(v_legacy_ids)
            UNION ALL
            SELECT value FROM pg_catalog.jsonb_array_elements_text(v_operator_ids)
            UNION ALL
            SELECT value FROM pg_catalog.jsonb_array_elements_text(v_internal_tester_ids)
        ) AS supplied_id
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_CLASSIFICATION_INPUT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(candidate.account_id) ORDER BY candidate.account_id),
        '[]'::JSONB
    )
    INTO v_actual_legacy_ids
    FROM public.account_ledger_legacy_e2e_candidate_ids_v1() AS candidate;
    IF v_legacy_ids IS DISTINCT FROM v_actual_legacy_ids THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_CLASSIFICATION_LEGACY_CANDIDATE_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    IF (
        SELECT pg_catalog.count(*)
        FROM public.users AS account
        WHERE account.id IN (
            SELECT value::UUID
            FROM pg_catalog.jsonb_array_elements_text(v_operator_ids)
            UNION ALL
            SELECT value::UUID
            FROM pg_catalog.jsonb_array_elements_text(v_internal_tester_ids)
        )
          AND account.classification_version IS NULL
    ) <> pg_catalog.jsonb_array_length(v_operator_ids)
        + pg_catalog.jsonb_array_length(v_internal_tester_ids) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_CLASSIFICATION_IDENTIFIER_NOT_PENDING',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*)::INTEGER
    INTO v_total_count
    FROM public.users AS account
    WHERE account.classification_version IS NULL;
    IF v_total_count NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_CLASSIFICATION_PLAN_SIZE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'account_id', account.id,
            'account_class', CASE
                WHEN account.id::TEXT IN (
                    SELECT value FROM pg_catalog.jsonb_array_elements_text(v_legacy_ids)
                ) OR account.id::TEXT IN (
                    SELECT value FROM pg_catalog.jsonb_array_elements_text(v_internal_tester_ids)
                ) THEN 'e2e_test'
                WHEN account.id::TEXT IN (
                    SELECT value FROM pg_catalog.jsonb_array_elements_text(v_operator_ids)
                ) THEN 'production'
                ELSE 'production'
            END,
            'traffic_class', CASE
                WHEN account.id::TEXT IN (
                    SELECT value FROM pg_catalog.jsonb_array_elements_text(v_legacy_ids)
                ) THEN 'e2e_test'
                WHEN account.id::TEXT IN (
                    SELECT value FROM pg_catalog.jsonb_array_elements_text(v_internal_tester_ids)
                ) THEN 'internal_tester'
                WHEN account.id::TEXT IN (
                    SELECT value FROM pg_catalog.jsonb_array_elements_text(v_operator_ids)
                ) THEN 'operator'
                ELSE 'external'
            END,
            'lifecycle', CASE
                WHEN account.id::TEXT IN (
                    SELECT value FROM pg_catalog.jsonb_array_elements_text(v_legacy_ids)
                ) OR account.id::TEXT IN (
                    SELECT value FROM pg_catalog.jsonb_array_elements_text(v_internal_tester_ids)
                ) THEN 'retired'
                ELSE 'active'
            END,
            'reason_code', CASE
                WHEN account.id::TEXT IN (
                    SELECT value FROM pg_catalog.jsonb_array_elements_text(v_legacy_ids)
                ) THEN 'LEGACY_E2E_HMAC_VERIFIED'
                WHEN account.id::TEXT IN (
                    SELECT value FROM pg_catalog.jsonb_array_elements_text(v_internal_tester_ids)
                ) THEN 'INTERNAL_TESTER_KEYCHAIN_VERIFIED'
                WHEN account.id::TEXT IN (
                    SELECT value FROM pg_catalog.jsonb_array_elements_text(v_operator_ids)
                ) THEN 'OPERATOR_KEYCHAIN_VERIFIED'
                ELSE 'PRODUCTION_EXTERNAL_DEFAULT'
            END
        )
        ORDER BY account.id
    )
    INTO v_assignments
    FROM public.users AS account
    WHERE account.classification_version IS NULL;

    SELECT pg_catalog.count(*)::INTEGER
    INTO v_legacy_count
    FROM public.users AS account
    WHERE account.classification_version IS NULL
      AND account.id::TEXT IN (
          SELECT value FROM pg_catalog.jsonb_array_elements_text(v_legacy_ids)
      );
    SELECT pg_catalog.count(*)::INTEGER
    INTO v_operator_count
    FROM public.users AS account
    WHERE account.classification_version IS NULL
      AND account.id::TEXT IN (
          SELECT value FROM pg_catalog.jsonb_array_elements_text(v_operator_ids)
      );
    SELECT pg_catalog.count(*)::INTEGER
    INTO v_internal_tester_count
    FROM public.users AS account
    WHERE account.classification_version IS NULL
      AND account.id::TEXT IN (
          SELECT value FROM pg_catalog.jsonb_array_elements_text(v_internal_tester_ids)
      );
    v_production_external_count := v_total_count - v_legacy_count
        - v_operator_count - v_internal_tester_count;

    RETURN QUERY
    SELECT v_assignments,
        v_total_count,
        v_legacy_count,
        v_operator_count,
        v_internal_tester_count,
        v_production_external_count;
END;
$$;

REVOKE ALL ON FUNCTION public.build_account_ledger_classification_plan_v1(
    JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.load_account_ledger_rollout_state_v1()
RETURNS TABLE(paid_ever_state TEXT, classification_command_version TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT rollout.paid_ever_state, rollout.classification_command_version
    FROM public.account_ledger_rollout_state AS rollout
    WHERE rollout.singleton IS TRUE
$$;

REVOKE ALL ON FUNCTION public.load_account_ledger_rollout_state_v1()
    FROM PUBLIC, anon, authenticated, service_role;

-- A registry makes the two permitted runner plans unique in the database.
-- The Auth metadata is validated on every provisioning/read path; this table
-- is immutable so an administrator cannot silently remap a runner plan.
CREATE TABLE public.account_e2e_test_runners (
    account_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
    runner_plan TEXT NOT NULL UNIQUE CHECK (runner_plan IN ('basic', 'standard')),
    command_version TEXT NOT NULL CHECK (command_version ~ '^[a-z0-9._-]{1,64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.account_e2e_test_runners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_e2e_test_runners
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.account_e2e_test_runners TO service_role;

CREATE OR REPLACE FUNCTION public.reject_account_e2e_test_runner_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'ACCOUNT_E2E_TEST_RUNNER_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_account_e2e_test_runner_mutation()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reject_account_e2e_test_runner_mutation_before_write
BEFORE UPDATE OR DELETE ON public.account_e2e_test_runners
FOR EACH ROW
EXECUTE FUNCTION public.reject_account_e2e_test_runner_mutation();

CREATE OR REPLACE FUNCTION public.provision_e2e_test_runner_v1(
    p_user_id UUID,
    p_email TEXT,
    p_runner_plan TEXT,
    p_command_version TEXT
)
RETURNS TABLE(runner_plan TEXT, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_runner_plan TEXT;
    v_auth_email TEXT;
    v_normalized_email TEXT;
    v_rollout_state TEXT;
    v_rollout_command_version TEXT;
    v_account public.users%ROWTYPE;
    v_registered_account_id UUID;
    v_registered_command_version TEXT;
    v_created BOOLEAN := FALSE;
BEGIN
    v_normalized_email := pg_catalog.lower(pg_catalog.btrim(p_email));
    IF p_user_id IS NULL
       OR p_email IS NULL
       OR v_normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       OR p_runner_plan NOT IN ('basic', 'standard')
       OR p_command_version IS NULL
       OR p_command_version !~ '^[a-z0-9._-]{1,64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_E2E_TEST_RUNNER_INPUT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- This row lock is the authorization invariant. The CLI check is only a
    -- preflight; a direct RPC call cannot provision before exact activation.
    SELECT rollout.paid_ever_state, rollout.classification_command_version
    INTO v_rollout_state, v_rollout_command_version
    FROM public.account_ledger_rollout_state AS rollout
    WHERE rollout.singleton IS TRUE
    FOR SHARE;
    IF NOT FOUND OR v_rollout_state IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_E2E_TEST_RUNNER_ROLLOUT_NOT_ACTIVE',
            ERRCODE = 'P0001';
    END IF;
    IF v_rollout_command_version IS DISTINCT FROM p_command_version THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_E2E_TEST_RUNNER_ROLLOUT_COMMAND_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.lower(pg_catalog.btrim(auth_user.email)),
        auth_user.raw_app_meta_data ->> 'analysis_test_runner_v1'
    INTO v_auth_email, v_auth_runner_plan
    FROM auth.users AS auth_user
    WHERE auth_user.id = p_user_id;
    IF NOT FOUND OR v_auth_email IS DISTINCT FROM v_normalized_email THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_E2E_TEST_RUNNER_AUTH_EMAIL_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    IF v_auth_runner_plan IS DISTINCT FROM p_runner_plan THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_E2E_TEST_RUNNER_AUTH_METADATA_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('account-e2e-test-runner:' || p_runner_plan, 0)
    );
    SELECT runner.account_id, runner.command_version
    INTO v_registered_account_id, v_registered_command_version
    FROM public.account_e2e_test_runners AS runner
    WHERE runner.runner_plan = p_runner_plan
    FOR UPDATE;
    IF FOUND AND v_registered_account_id IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_E2E_TEST_RUNNER_PLAN_ALREADY_BOUND',
            ERRCODE = 'P0001';
    END IF;
    IF FOUND AND v_registered_command_version IS DISTINCT FROM p_command_version THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_E2E_TEST_RUNNER_COMMAND_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT account.*
    INTO v_account
    FROM public.users AS account
    WHERE account.id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO public.users (
            id, email, provider, analysis_count, is_paid_user, is_unlimited,
            account_class, traffic_class, lifecycle, classification_version
        ) VALUES (
            p_user_id, v_normalized_email, 'e2e', 0, FALSE, FALSE,
            'e2e_test', 'e2e_test', 'active', p_command_version
        );
        SELECT account.*
        INTO v_account
        FROM public.users AS account
        WHERE account.id = p_user_id
        FOR UPDATE;
        v_created := TRUE;
    END IF;

    IF pg_catalog.lower(pg_catalog.btrim(v_account.email))
            IS DISTINCT FROM v_normalized_email
       OR v_account.account_class IS DISTINCT FROM 'e2e_test'
       OR v_account.traffic_class IS DISTINCT FROM 'e2e_test'
       OR v_account.lifecycle IS DISTINCT FROM 'active'
       OR v_account.classification_version IS DISTINCT FROM p_command_version THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_E2E_TEST_RUNNER_PRINCIPAL_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.account_e2e_test_runners (
        account_id, runner_plan, command_version
    ) VALUES (
        p_user_id, p_runner_plan, p_command_version
    ) ON CONFLICT (account_id) DO NOTHING;

    SELECT runner.account_id, runner.command_version
    INTO v_registered_account_id, v_registered_command_version
    FROM public.account_e2e_test_runners AS runner
    WHERE runner.runner_plan = p_runner_plan;
    IF v_registered_account_id IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_E2E_TEST_RUNNER_PLAN_ALREADY_BOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_registered_command_version IS DISTINCT FROM p_command_version THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_E2E_TEST_RUNNER_COMMAND_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.account_classification_audit AS audit
        WHERE audit.account_id = p_user_id
          AND audit.command_version = p_command_version
          AND audit.reason_code = 'E2E_RUNNER_PROVISIONED'
    ) THEN
        INSERT INTO public.account_classification_audit (
            account_id, command_version, reason_code,
            previous_account_class, previous_traffic_class, previous_lifecycle,
            next_account_class, next_traffic_class, next_lifecycle
        ) VALUES (
            p_user_id, p_command_version, 'E2E_RUNNER_PROVISIONED',
            'e2e_test', 'e2e_test', 'active',
            'e2e_test', 'e2e_test', 'active'
        );
    END IF;

    RETURN QUERY SELECT p_runner_plan, v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_e2e_test_runner_v1(UUID, TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.load_e2e_test_runner_v1(p_user_id UUID)
RETURNS TABLE(runner_plan TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT runner.runner_plan
    FROM public.account_e2e_test_runners AS runner
    JOIN public.users AS account ON account.id = runner.account_id
    JOIN auth.users AS auth_user ON auth_user.id = runner.account_id
    JOIN public.account_ledger_rollout_state AS rollout ON rollout.singleton IS TRUE
    WHERE runner.account_id = p_user_id
      AND account.account_class = 'e2e_test'
      AND account.traffic_class = 'e2e_test'
      AND account.lifecycle = 'active'
      AND runner.command_version = account.classification_version
      AND runner.command_version = rollout.classification_command_version
      AND rollout.paid_ever_state = 'active'
      AND pg_catalog.lower(pg_catalog.btrim(auth_user.email))
            = pg_catalog.lower(pg_catalog.btrim(account.email))
      AND auth_user.raw_app_meta_data ->> 'analysis_test_runner_v1'
            = runner.runner_plan
$$;

REVOKE ALL ON FUNCTION public.load_e2e_test_runner_v1(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_e2e_test_runner_plans_v1()
RETURNS TABLE(runner_plan TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT runner.runner_plan
    FROM public.account_e2e_test_runners AS runner
    JOIN public.users AS account ON account.id = runner.account_id
    JOIN auth.users AS auth_user ON auth_user.id = runner.account_id
    JOIN public.account_ledger_rollout_state AS rollout ON rollout.singleton IS TRUE
    WHERE account.account_class = 'e2e_test'
      AND account.traffic_class = 'e2e_test'
      AND account.lifecycle = 'active'
      AND runner.command_version = account.classification_version
      AND runner.command_version = rollout.classification_command_version
      AND rollout.paid_ever_state = 'active'
      AND pg_catalog.lower(pg_catalog.btrim(auth_user.email))
            = pg_catalog.lower(pg_catalog.btrim(account.email))
      AND auth_user.raw_app_meta_data ->> 'analysis_test_runner_v1'
            = runner.runner_plan
    ORDER BY runner.runner_plan
$$;

REVOKE ALL ON FUNCTION public.list_e2e_test_runner_plans_v1()
    FROM PUBLIC, anon, authenticated, service_role;

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
GRANT EXECUTE ON FUNCTION public.list_account_ledger_legacy_e2e_candidates_v1()
    TO service_role;
GRANT EXECUTE ON FUNCTION public.build_account_ledger_classification_plan_v1(
    JSONB, JSONB, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_account_ledger_rollout_state_v1()
    TO service_role;
GRANT EXECUTE ON FUNCTION public.provision_e2e_test_runner_v1(UUID, TEXT, TEXT, TEXT)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.load_e2e_test_runner_v1(UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.list_e2e_test_runner_plans_v1()
    TO service_role;

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

-- Owner history is an authenticated RPC used directly by /mypage. Keep the
-- lifecycle boundary in the database as well as in the page guard so a
-- retired session cannot bypass admission by calling the RPC directly.
CREATE OR REPLACE FUNCTION public.load_analysis_owner_history_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_lifecycle TEXT;
    v_items JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_OWNER_HISTORY_AUTH_REQUIRED',
            ERRCODE = '42501';
    END IF;

    SELECT account.lifecycle
    INTO v_lifecycle
    FROM public.users AS account
    WHERE account.id = v_user_id;

    IF NOT FOUND OR v_lifecycle <> 'active' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_OWNER_HISTORY_ACCOUNT_RETIRED',
            ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', analysis_request.id,
                'targetInstagramId', CASE
                    WHEN analysis_request.pipeline_version = 'v2'
                         AND analysis_request.status = 'completed'
                        THEN result_summary.target_instagram_id
                    WHEN analysis_request.pipeline_version = 'v2'
                         AND analysis_request.target_instagram_id LIKE 'retained.%'
                        THEN NULL
                    ELSE analysis_request.target_instagram_id
                END,
                'status', analysis_request.status,
                'createdAt', analysis_request.created_at,
                'planType', analysis_request.plan_type,
                'pipelineVersion', CASE
                    WHEN analysis_request.pipeline_version = 'v2' THEN 'v2'
                    ELSE 'v1'
                END,
                'publicFemaleCount', CASE
                    WHEN analysis_request.pipeline_version = 'v2'
                         AND analysis_request.status = 'completed'
                        THEN result_summary.female_count
                    ELSE NULL
                END
            )
            ORDER BY analysis_request.created_at DESC NULLS LAST, analysis_request.id DESC
        ),
        '[]'::JSONB
    )
    INTO v_items
    FROM public.analysis_requests AS analysis_request
    LEFT JOIN public.analysis_v2_result_summaries AS result_summary
      ON result_summary.request_id = analysis_request.id
     AND analysis_request.pipeline_version = 'v2'
     AND analysis_request.status = 'completed'
    WHERE analysis_request.user_id = v_user_id
      AND analysis_request.status IN ('pending', 'processing', 'completed');

    RETURN pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'items', v_items
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_owner_history_v1()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_owner_history_v1()
    TO authenticated;
