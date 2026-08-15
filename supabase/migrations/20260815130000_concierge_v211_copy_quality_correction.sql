-- MIGRATION_PREDECESSOR=20260815113000
-- Forward-only, service-role-only copy correction for the already published
-- first paid Basic concierge result.  The immutable order/replay/source audit
-- remains untouched; only the 16 one-line overviews and two risk narratives
-- may be replaced after an exact source-fingerprint/result-hash CAS.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := TRUE;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1
                FROM supabase_migrations.schema_migrations
                WHERE version = '20260815113000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE TABLE public.earlybird_v211_concierge_copy_corrections (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id),
    result_request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    published_source_fingerprint TEXT NOT NULL
        CHECK (published_source_fingerprint ~ '^[a-f0-9]{64}$'),
    expected_published_result_hash TEXT NOT NULL
        CHECK (expected_published_result_hash ~ '^[a-f0-9]{64}$'),
    correction_result_hash TEXT NOT NULL
        CHECK (correction_result_hash ~ '^[a-f0-9]{64}$'),
    copy_payload JSONB NOT NULL
        CHECK (pg_catalog.jsonb_typeof(copy_payload) = 'object'),
    corrected_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (order_id, correction_result_hash)
);

ALTER TABLE public.earlybird_v211_concierge_copy_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_concierge_copy_corrections FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_v211_concierge_copy_corrections
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.prevent_earlybird_v211_concierge_copy_correction_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_IMMUTABLE',
            ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER prevent_earlybird_v211_concierge_copy_correction_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v211_concierge_copy_corrections
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_v211_concierge_copy_correction_mutation();

CREATE FUNCTION public.correct_earlybird_v211_concierge_copy(
    p_order_id UUID,
    p_owner_id UUID,
    p_result_request_id UUID,
    p_source_fingerprint TEXT,
    p_expected_published_result_hash TEXT,
    p_correction_result_hash TEXT,
    p_copy_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_candidate_count INTEGER;
    v_result_count INTEGER;
    v_high_risk_count INTEGER;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_replay public.earlybird_v211_concierge_replays%ROWTYPE;
    v_existing public.earlybird_v211_concierge_copy_corrections%ROWTYPE;
    v_row JSONB;
BEGIN
    IF p_order_id IS NULL
       OR p_owner_id IS NULL
       OR p_result_request_id IS NULL
       OR p_source_fingerprint IS NULL
       OR p_source_fingerprint !~ '^[a-f0-9]{64}$'
       OR p_expected_published_result_hash IS NULL
       OR p_expected_published_result_hash !~ '^[a-f0-9]{64}$'
       OR p_correction_result_hash IS NULL
       OR p_correction_result_hash !~ '^[a-f0-9]{64}$'
       OR pg_catalog.jsonb_typeof(p_copy_payload) IS DISTINCT FROM 'object'
       OR p_copy_payload->>'qualityVersion' IS DISTINCT FROM 'v211-evidence-specific-v1'
       OR pg_catalog.jsonb_typeof(p_copy_payload->'rows') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(p_copy_payload->'rows') IS DISTINCT FROM 16 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_INPUT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- This lock is deliberately the same historical one-shot scope as the
    -- bootstrap RPC; it does not broaden admission or rearm locking.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'earlybird-v211-concierge-first-paid-basic:2026-08-12', 0
        )
    );

    SELECT pg_catalog.count(*) INTO v_candidate_count
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.plan_id = 'basic'
      AND earlybird_order.status = 'completed'
      AND earlybird_order.paid_at >= '2026-08-12T00:00:00Z'::TIMESTAMPTZ
      AND earlybird_order.paid_at < '2026-08-13T00:00:00Z'::TIMESTAMPTZ
      AND earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.expected_amount_krw = 990
      AND earlybird_order.actual_amount_krw = 990
      AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
      AND earlybird_order.actual_groble_product_id
            IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_webhook_events AS refund_event
          WHERE refund_event.event_type = 'payment.refunded'
            AND refund_event.payment_id = earlybird_order.payment_id
            AND refund_event.product_id = earlybird_order.actual_groble_product_id
            AND refund_event.amount_krw = earlybird_order.actual_amount_krw
            AND refund_event.refund_amount_krw = earlybird_order.actual_amount_krw
            AND refund_event.partial_refund IS FALSE
      );
    IF v_candidate_count <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_ORDER_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_result_request_id
    FOR UPDATE;
    SELECT replay.* INTO v_replay
    FROM public.earlybird_v211_concierge_replays AS replay
    WHERE replay.order_id = p_order_id
    FOR UPDATE;

    IF v_order.id IS NULL
       OR v_order.user_id IS DISTINCT FROM p_owner_id
       OR v_order.result_request_id IS DISTINCT FROM p_result_request_id
       OR v_order.status IS DISTINCT FROM 'completed'
       OR v_order.plan_id IS DISTINCT FROM 'basic'
       OR v_order.expected_amount_krw IS DISTINCT FROM 990
       OR v_order.actual_amount_krw IS DISTINCT FROM 990
       OR v_order.payment_id IS NULL
       OR v_order.seller_reference_confirmed_at IS NULL
       OR pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
            !~ '^[a-z0-9._]{1,30}$'
       OR v_order.exclusion_decision IS DISTINCT FROM 'exclude'
       OR v_order.excluded_instagram_id IS NULL
       OR pg_catalog.lower(pg_catalog.btrim(v_order.excluded_instagram_id))
            !~ '^[a-z0-9._]{1,30}$'
       OR pg_catalog.lower(pg_catalog.btrim(v_order.excluded_instagram_id))
            IS NOT DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
       OR v_order.paid_at < '2026-08-12T00:00:00Z'::TIMESTAMPTZ
       OR v_order.paid_at >= '2026-08-13T00:00:00Z'::TIMESTAMPTZ THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_ORDER_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.earlybird_webhook_events AS refund_event
        WHERE refund_event.event_type = 'payment.refunded'
          AND refund_event.payment_id = v_order.payment_id
          AND refund_event.product_id = v_order.actual_groble_product_id
          AND refund_event.amount_krw = v_order.actual_amount_krw
          AND refund_event.refund_amount_krw = v_order.actual_amount_krw
          AND refund_event.partial_refund IS FALSE
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_REFUND_REJECTED',
            ERRCODE = 'P0001';
    END IF;
    IF v_fulfillment.order_id IS NULL
       OR v_fulfillment.status IS DISTINCT FROM 'analysis_in_progress'
       OR v_fulfillment.attempt_count IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_FULFILLMENT_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_request.id IS NULL
       OR v_request.user_id IS DISTINCT FROM p_owner_id
       OR pg_catalog.lower(pg_catalog.btrim(v_request.target_instagram_id))
            IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
       OR v_request.status IS DISTINCT FROM 'completed'
       OR v_request.pipeline_version IS DISTINCT FROM 'v1'
       OR v_replay.order_id IS NULL
       OR v_replay.reviewed_source_owner_id IS DISTINCT FROM p_owner_id
       OR v_replay.reviewed_source_result_request_id IS DISTINCT FROM p_result_request_id
       OR pg_catalog.lower(pg_catalog.btrim(v_replay.reviewed_source_target_instagram_id))
            IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
       OR v_replay.reviewed_source_fingerprint IS DISTINCT FROM p_source_fingerprint
       OR v_replay.published_source_fingerprint IS DISTINCT FROM p_source_fingerprint
       OR v_replay.published_result_hash IS DISTINCT FROM p_expected_published_result_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_CAS_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT correction.* INTO v_existing
    FROM public.earlybird_v211_concierge_copy_corrections AS correction
    WHERE correction.order_id = p_order_id
    FOR UPDATE;
    IF v_existing.order_id IS NOT NULL THEN
        IF v_existing.result_request_id IS DISTINCT FROM p_result_request_id
           OR v_existing.published_source_fingerprint IS DISTINCT FROM p_source_fingerprint
           OR v_existing.expected_published_result_hash IS DISTINCT FROM p_expected_published_result_hash
           OR v_existing.correction_result_hash IS DISTINCT FROM p_correction_result_hash
           OR v_existing.copy_payload IS DISTINCT FROM p_copy_payload THEN
            RAISE EXCEPTION USING
                MESSAGE = 'CONCIERGE_COPY_CORRECTION_REPLAY_HASH_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'state', 'already_corrected', 'orderScope', 'first-paid-basic-2026-08-12',
            'resultRequestId', p_result_request_id,
            'correctionResultHash', p_correction_result_hash
        );
    END IF;

    SELECT pg_catalog.count(*) INTO v_result_count
    FROM public.analysis_results
    WHERE request_id = p_result_request_id;
    SELECT pg_catalog.count(*) INTO v_high_risk_count
    FROM public.analysis_results
    WHERE request_id = p_result_request_id AND risk_grade = 'high_risk';
    IF v_result_count IS DISTINCT FROM 16 OR v_high_risk_count IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_RESULT_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item
        WHERE pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR item->>'rank' !~ '^[0-9]{1,2}$'
           OR (item->>'rank')::INTEGER NOT BETWEEN 1 AND 16
           OR item->>'suspect_instagram_id' IS NULL
           OR item->>'suspect_instagram_id' !~ '^[a-z0-9._]{1,30}$'
           OR item->>'oneLineOverview' IS NULL
           OR pg_catalog.char_length(pg_catalog.btrim(item->>'oneLineOverview')) NOT BETWEEN 25 AND 180
           OR item->>'oneLineOverview' IN (
                '사진과 소개에 드러난 개인 기록의 결이 선명해서, 피드가 보여 준 장면부터 차분히 짚어볼 계정입니다.',
                '창작과 일상 기록이 섞여 있고, 피드에 드러난 활동 흐름을 중심으로 읽어볼 만한 계정입니다.',
                '공식 단체나 브랜드 맥락으로 분류됐습니다. 개인 계정보다 조직 성격을 먼저 볼 만합니다.',
                '소개와 피드에 여러 결이 겹친 계정입니다. 보이는 장면을 중심으로 흐름을 정리해볼 만합니다.'
           )
           OR item->>'oneLineOverview' ~ '[0-9@]'
           OR pg_catalog.jsonb_typeof(item->'evidenceTerms') IS DISTINCT FROM 'array'
           OR pg_catalog.jsonb_array_length(item->'evidenceTerms') < 1
           OR pg_catalog.jsonb_array_length(item->'evidenceTerms') > 4
           OR NOT EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_array_elements_text(item->'evidenceTerms') AS term
                 WHERE pg_catalog.strpos(pg_catalog.lower(item->>'oneLineOverview'), pg_catalog.lower(term)) > 0
           )
           OR pg_catalog.jsonb_typeof(item->'riskAnalysis') IS DISTINCT FROM 'array'
           OR (
                item->>'riskGrade' = 'high_risk'
                AND pg_catalog.jsonb_array_length(item->'riskAnalysis') <> 2
           )
           OR (
                item->>'riskGrade' <> 'high_risk'
                AND pg_catalog.jsonb_array_length(item->'riskAnalysis') <> 0
           )
           OR EXISTS (
                SELECT 1
                 FROM pg_catalog.jsonb_array_elements_text(item->'riskAnalysis') AS line
                 WHERE pg_catalog.char_length(line) NOT BETWEEN 1 AND 180
                    OR line ~ '[0-9@]'
                    OR line IN (
                        '공개 프로필과 최근 피드, 맞팔 흐름은 눈에 띄어야 할 재료를 꽤 성실하게 쌓아 두었습니다.',
                        '관측 표본에서 공개 상호작용을 확정할 재료는 제한적이며, 표본 밖 기록도 없다고 순진하게 믿을 근거는 없습니다.'
                    )
                    OR line ~ '(바람|불륜|외도|연인|교제|사귀|남자친구|여자친구|점수|순위|등급)'
           )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_PAYLOAD_INVALID',
            ERRCODE = 'P0001';
    END IF;
    IF (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item
    ) <> (
        SELECT pg_catalog.count(DISTINCT item->>'suspect_instagram_id')
        FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item
    ) OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item
        WHERE item->>'riskGrade' = 'high_risk'
    ) <> 2 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_PAYLOAD_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Every identity/risk bucket is bound to the already published row.  The
    -- correction cannot reorder, add, or remove accounts or alter scores.
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item
        LEFT JOIN public.analysis_results AS current_row
          ON current_row.request_id = p_result_request_id
         AND current_row.rank = (item->>'rank')::INTEGER
        WHERE current_row.id IS NULL
           OR current_row.suspect_instagram_id IS DISTINCT FROM item->>'suspect_instagram_id'
           OR current_row.risk_grade IS DISTINCT FROM item->>'riskGrade'
           OR current_row.gender_status IS DISTINCT FROM 'confirmed'
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_ROW_BINDING_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.earlybird_v211_concierge_copy_corrections(
        order_id, result_request_id, published_source_fingerprint,
        expected_published_result_hash, correction_result_hash, copy_payload
    ) VALUES (
        p_order_id, p_result_request_id, p_source_fingerprint,
        p_expected_published_result_hash, p_correction_result_hash, p_copy_payload
    );

    FOR v_row IN
        SELECT item
        FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item
    LOOP
        UPDATE public.analysis_results
        SET one_line_overview = v_row->>'oneLineOverview',
            risk_analysis = v_row->'riskAnalysis'
        WHERE request_id = p_result_request_id
          AND rank = (v_row->>'rank')::INTEGER;
    END LOOP;

    UPDATE public.analysis_requests
    SET step_data = pg_catalog.jsonb_set(
        CASE WHEN pg_catalog.jsonb_typeof(step_data) = 'object'
             THEN step_data ELSE '{}'::JSONB END,
        '{conciergeBootstrap,copyCorrection}',
        pg_catalog.jsonb_build_object(
            'qualityVersion', 'v211-evidence-specific-v1',
            'sourceFingerprint', p_source_fingerprint,
            'publishedResultHash', p_expected_published_result_hash,
            'correctionResultHash', p_correction_result_hash,
            'correctedRows', 16,
            'correctedHighRiskRows', 2
        ),
        TRUE
    )
    WHERE id = p_result_request_id;

    RETURN pg_catalog.jsonb_build_object(
        'state', 'corrected',
        'orderScope', 'first-paid-basic-2026-08-12',
        'resultRequestId', p_result_request_id,
        'correctedRows', 16,
        'correctedHighRiskRows', 2,
        'sourceFingerprint', p_source_fingerprint,
        'publishedResultHash', p_expected_published_result_hash,
        'correctionResultHash', p_correction_result_hash
    );
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_earlybird_v211_concierge_copy_correction_mutation()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.correct_earlybird_v211_concierge_copy(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.correct_earlybird_v211_concierge_copy(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB
) TO service_role;

COMMENT ON FUNCTION public.correct_earlybird_v211_concierge_copy(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB
) IS 'One-shot service-role-only evidence-specific copy correction for the exact first paid non-refunded 2026-08-12 Basic concierge result; preserves immutable replay/source audit and binds the published source/result CAS.';

DO $final_guard$
DECLARE
    v_signature TEXT :=
        'public.correct_earlybird_v211_concierge_copy(uuid,uuid,uuid,text,text,text,jsonb)';
    v_definition TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_signature::pg_catalog.regprocedure)
    INTO v_definition;
    IF pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')
       OR pg_catalog.strpos(v_definition, 'search_path') = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_COPY_CORRECTION_FINAL_CONTRACT_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
END;
$final_guard$;

COMMIT;
