-- MIGRATION_PREDECESSOR=20260815220000
-- Forward-only Gemini-only copy correction for the already sealed first paid
-- concierge result. The v2.13 copy ledger remains immutable; this successor
-- CAS-binds the full current non-copy result snapshot before changing copy.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
       AND (
           NOT EXISTS (
               SELECT 1 FROM supabase_migrations.schema_migrations
               WHERE version = '20260815220000'
           )
           OR NOT EXISTS (
               SELECT 1 FROM supabase_migrations.schema_migrations
               WHERE version = '20260815180000'
           )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_PREDECESSOR_MISSING', ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE TABLE public.earlybird_v214_concierge_gemini_copy_corrections (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id),
    result_request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    prior_correction_result_hash TEXT NOT NULL CHECK (prior_correction_result_hash ~ '^[a-f0-9]{64}$'),
    correction_result_hash TEXT NOT NULL CHECK (correction_result_hash ~ '^[a-f0-9]{64}$'),
    copy_payload JSONB NOT NULL CHECK (pg_catalog.jsonb_typeof(copy_payload) = 'object'),
    corrected_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (order_id, correction_result_hash)
);
ALTER TABLE public.earlybird_v214_concierge_gemini_copy_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v214_concierge_gemini_copy_corrections FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_v214_concierge_gemini_copy_corrections
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_CORRECTION_IMMUTABLE', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER prevent_earlybird_v214_concierge_gemini_copy_correction_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v214_concierge_gemini_copy_corrections
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation();

CREATE FUNCTION public.correct_earlybird_v214_concierge_gemini_copy(
    p_order_id UUID,
    p_owner_id UUID,
    p_result_request_id UUID,
    p_source_fingerprint TEXT,
    p_expected_published_result_hash TEXT,
    p_prior_correction_result_hash TEXT,
    p_expected_v213_fact_snapshot JSONB,
    p_correction_result_hash TEXT,
    p_copy_payload JSONB
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_order public.earlybird_orders%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_replay public.earlybird_v211_concierge_replays%ROWTYPE;
    v_prior public.earlybird_v213_concierge_copy_corrections%ROWTYPE;
    v_existing public.earlybird_v214_concierge_gemini_copy_corrections%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_candidate_count INTEGER;
    v_result_count INTEGER;
    v_high_risk_count INTEGER;
    v_current_fact_snapshot JSONB;
    v_row JSONB;
BEGIN
    IF p_order_id IS NULL OR p_owner_id IS NULL OR p_result_request_id IS NULL
       OR p_source_fingerprint !~ '^[a-f0-9]{64}$'
       OR p_expected_published_result_hash !~ '^[a-f0-9]{64}$'
       OR p_prior_correction_result_hash !~ '^[a-f0-9]{64}$'
       OR p_correction_result_hash !~ '^[a-f0-9]{64}$'
       OR pg_catalog.jsonb_typeof(p_expected_v213_fact_snapshot) IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(p_expected_v213_fact_snapshot) IS DISTINCT FROM 16
       OR pg_catalog.jsonb_typeof(p_copy_payload) IS DISTINCT FROM 'object'
       OR p_copy_payload->>'qualityVersion' IS DISTINCT FROM 'v214-gemini-first-payment-copy-v1'
       OR pg_catalog.jsonb_typeof(p_copy_payload->'rows') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(p_copy_payload->'rows') IS DISTINCT FROM 16 THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_INPUT_INVALID', ERRCODE = 'P0001';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'earlybird-v211-concierge-first-paid-basic:2026-08-12', 0));
    SELECT pg_catalog.count(*) INTO v_candidate_count
    FROM public.earlybird_orders AS candidate
    WHERE candidate.plan_id = 'basic' AND candidate.status = 'completed'
      AND candidate.paid_at >= '2026-08-12T00:00:00Z'::TIMESTAMPTZ
      AND candidate.paid_at < '2026-08-13T00:00:00Z'::TIMESTAMPTZ
      AND candidate.payment_id IS NOT NULL
      AND candidate.expected_amount_krw = 990 AND candidate.actual_amount_krw = 990
      AND candidate.seller_reference_confirmed_at IS NOT NULL
      AND candidate.actual_groble_product_id IS NOT DISTINCT FROM candidate.expected_groble_product_id
      AND NOT EXISTS (
          SELECT 1 FROM public.earlybird_webhook_events AS refund_event
          WHERE refund_event.event_type = 'payment.refunded'
            AND refund_event.payment_id = candidate.payment_id
            AND refund_event.product_id = candidate.actual_groble_product_id
            AND refund_event.amount_krw = candidate.actual_amount_krw
            AND refund_event.refund_amount_krw = candidate.actual_amount_krw
            AND refund_event.partial_refund IS FALSE
      );
    IF v_candidate_count <> 1 THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_ORDER_SCOPE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id FOR UPDATE;
    SELECT fulfillment.* INTO v_fulfillment FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id FOR UPDATE;
    SELECT request.* INTO v_request FROM public.analysis_requests AS request
    WHERE request.id = p_result_request_id FOR UPDATE;
    SELECT replay.* INTO v_replay FROM public.earlybird_v211_concierge_replays AS replay
    WHERE replay.order_id = p_order_id FOR UPDATE;
    SELECT correction.* INTO v_prior FROM public.earlybird_v213_concierge_copy_corrections AS correction
    WHERE correction.order_id = p_order_id FOR UPDATE;
    SELECT correction.* INTO v_existing FROM public.earlybird_v214_concierge_gemini_copy_corrections AS correction
    WHERE correction.order_id = p_order_id FOR UPDATE;

    IF v_order.id IS NULL OR v_order.user_id IS DISTINCT FROM p_owner_id
       OR v_order.result_request_id IS DISTINCT FROM p_result_request_id
       OR v_order.status IS DISTINCT FROM 'completed' OR v_order.plan_id IS DISTINCT FROM 'basic'
       OR v_order.expected_amount_krw IS DISTINCT FROM 990 OR v_order.actual_amount_krw IS DISTINCT FROM 990
       OR v_order.payment_id IS NULL OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.actual_groble_product_id IS DISTINCT FROM v_order.expected_groble_product_id
       OR pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id)) !~ '^[a-z0-9._]{1,30}$'
       OR v_order.exclusion_decision IS DISTINCT FROM 'exclude' OR v_order.excluded_instagram_id IS NULL
       OR pg_catalog.lower(pg_catalog.btrim(v_order.excluded_instagram_id)) !~ '^[a-z0-9._]{1,30}$'
       OR pg_catalog.lower(pg_catalog.btrim(v_order.excluded_instagram_id))
            IS NOT DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
       OR v_request.id IS NULL OR v_request.user_id IS DISTINCT FROM p_owner_id
       OR pg_catalog.lower(pg_catalog.btrim(v_request.target_instagram_id))
            IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
       OR v_request.status IS DISTINCT FROM 'completed' OR v_request.pipeline_version IS DISTINCT FROM 'v1'
       OR v_replay.order_id IS NULL OR v_replay.reviewed_source_owner_id IS DISTINCT FROM p_owner_id
       OR v_replay.reviewed_source_result_request_id IS DISTINCT FROM p_result_request_id
       OR pg_catalog.lower(pg_catalog.btrim(v_replay.reviewed_source_target_instagram_id))
            IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
       OR v_replay.reviewed_source_fingerprint IS DISTINCT FROM p_source_fingerprint
       OR v_replay.published_source_fingerprint IS DISTINCT FROM p_source_fingerprint
       OR v_replay.published_result_hash IS DISTINCT FROM p_expected_published_result_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_SCOPE_OR_CAS_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_fulfillment.order_id IS NULL OR v_fulfillment.status IS DISTINCT FROM 'analysis_in_progress'
       OR v_fulfillment.attempt_count IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_FULFILLMENT_SCOPE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.earlybird_webhook_events AS refund_event
        WHERE refund_event.event_type = 'payment.refunded' AND refund_event.payment_id = v_order.payment_id
          AND refund_event.product_id = v_order.actual_groble_product_id
          AND refund_event.amount_krw = v_order.actual_amount_krw
          AND refund_event.refund_amount_krw = v_order.actual_amount_krw
          AND refund_event.partial_refund IS FALSE
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_REFUND_REJECTED', ERRCODE = 'P0001';
    END IF;
    IF v_prior.order_id IS NULL
       OR v_prior.result_request_id IS DISTINCT FROM p_result_request_id
       OR v_prior.correction_result_hash IS DISTINCT FROM p_prior_correction_result_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_PRIOR_CORRECTION_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_existing.order_id IS NOT NULL THEN
        IF v_existing.result_request_id IS DISTINCT FROM p_result_request_id
           OR v_existing.prior_correction_result_hash IS DISTINCT FROM p_prior_correction_result_hash
           OR v_existing.correction_result_hash IS DISTINCT FROM p_correction_result_hash
           OR v_existing.copy_payload IS DISTINCT FROM p_copy_payload THEN
            RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_REPLAY_HASH_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object('state', 'already_corrected', 'correctedRows', 16, 'correctedHighRiskRows', 2);
    END IF;

    SELECT pg_catalog.count(*) INTO v_result_count FROM public.analysis_results WHERE request_id = p_result_request_id;
    SELECT pg_catalog.count(*) INTO v_high_risk_count FROM public.analysis_results
    WHERE request_id = p_result_request_id AND risk_grade = 'high_risk';
    IF v_result_count IS DISTINCT FROM 16 OR v_high_risk_count IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_RESULT_SCOPE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    SELECT pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(current_row) - ARRAY['one_line_overview', 'risk_analysis']
        ORDER BY current_row.rank
    ) INTO v_current_fact_snapshot
    FROM public.analysis_results AS current_row
    WHERE current_row.request_id = p_result_request_id;
    IF v_current_fact_snapshot IS DISTINCT FROM p_expected_v213_fact_snapshot THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_FACT_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_prior.copy_payload->'rows') AS prior_row
        JOIN public.analysis_results AS current_row
          ON current_row.request_id = p_result_request_id AND current_row.rank = (prior_row->>'rank')::INTEGER
        WHERE current_row.one_line_overview IS DISTINCT FROM prior_row->>'oneLineOverview'
           OR current_row.risk_analysis IS DISTINCT FROM prior_row->'riskAnalysis'
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_PRIOR_COPY_CAS_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item
        WHERE pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR item->>'rank' !~ '^[0-9]{1,2}$' OR (item->>'rank')::INTEGER NOT BETWEEN 1 AND 16
           OR item->>'suspectInstagramId' !~ '^[a-z0-9._]{1,30}$'
           OR item->>'riskGrade' NOT IN ('normal', 'caution', 'high_risk')
           OR item->>'source' IS DISTINCT FROM 'gemini'
           OR pg_catalog.char_length(pg_catalog.btrim(item->>'oneLineOverview')) NOT BETWEEN 25 AND 180
           OR item->>'oneLineOverview' ~ '[0-9@]'
           OR item->>'oneLineOverview' ~ '(대상[[:space:]]*계정|후보[[:space:]]*계정)'
           OR pg_catalog.jsonb_typeof(item->'previousRiskAnalysis') IS DISTINCT FROM 'array'
           OR pg_catalog.jsonb_typeof(item->'riskAnalysis') IS DISTINCT FROM 'array'
           OR (item->>'riskGrade' = 'high_risk' AND (
                pg_catalog.jsonb_array_length(item->'riskAnalysis') <> 2
                OR pg_catalog.jsonb_typeof(item->'evidence') IS DISTINCT FROM 'object'
                OR pg_catalog.char_length(pg_catalog.btrim(item->'evidence'->>'candidateFullName')) < 1
                OR pg_catalog.char_length(pg_catalog.btrim(item->'evidence'->>'targetFullName')) < 1
                OR item->'evidence'->>'observedInteraction' NOT IN ('like', 'comment', 'tag', 'mention')
                OR (item->'riskAnalysis'->>0) NOT LIKE '%' || (item->'evidence'->>'candidateFullName') || '%'
                OR (item->'riskAnalysis'->>1) NOT LIKE '%' || (item->'evidence'->>'candidateFullName') || '%'
                OR (item->'riskAnalysis'->>1) NOT LIKE '%' || (item->'evidence'->>'targetFullName') || '%'
                OR (item->'evidence'->>'observedInteraction' = 'like'
                    AND ((item->'riskAnalysis'->>0) || (item->'riskAnalysis'->>1)) NOT LIKE '%좋아요%')
                OR (item->'evidence'->>'observedInteraction' = 'comment'
                    AND ((item->'riskAnalysis'->>0) || (item->'riskAnalysis'->>1)) NOT LIKE '%댓글%')
                OR (item->'evidence'->>'observedInteraction' = 'tag'
                    AND ((item->'riskAnalysis'->>0) || (item->'riskAnalysis'->>1)) NOT LIKE '%태그%')
                OR (item->'evidence'->>'observedInteraction' = 'mention'
                    AND ((item->'riskAnalysis'->>0) || (item->'riskAnalysis'->>1)) NOT LIKE '%멘션%')
                OR ((item->'riskAnalysis'->>0) || (item->'riskAnalysis'->>1)) ~ '(대상[[:space:]]*계정|후보[[:space:]]*계정|위장여사친)'
           ))
           OR (item->>'riskGrade' <> 'high_risk' AND (
                pg_catalog.jsonb_array_length(item->'riskAnalysis') <> 0
                OR item ? 'evidence'
           ))
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_HIGH_RISK_EVIDENCE_INVALID', ERRCODE = 'P0001';
    END IF;
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows'))
       <> (SELECT pg_catalog.count(DISTINCT item->>'rank') FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item)
       OR (SELECT pg_catalog.count(DISTINCT item->>'oneLineOverview') FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item) <> 16
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item
           WHERE item->>'riskGrade' = 'high_risk') <> 2 THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_PAYLOAD_INVALID', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item
        WHERE item->>'riskGrade' = 'high_risk'
          AND item->'riskAnalysis' IS NOT DISTINCT FROM item->'previousRiskAnalysis'
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_HIGH_RISK_NARRATIVE_UNCHANGED', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item
        JOIN public.analysis_results AS current_row
          ON current_row.request_id = p_result_request_id AND current_row.rank = (item->>'rank')::INTEGER
        WHERE current_row.suspect_instagram_id IS DISTINCT FROM item->>'suspectInstagramId'
           OR current_row.risk_grade IS DISTINCT FROM item->>'riskGrade'
           OR current_row.one_line_overview IS DISTINCT FROM item->>'previousOverview'
           OR current_row.risk_analysis IS DISTINCT FROM item->'previousRiskAnalysis'
           OR item->>'oneLineOverview' IS NOT DISTINCT FROM item->>'previousOverview'
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_SEMANTIC_DIFF_CONFLICT', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.earlybird_v214_concierge_gemini_copy_corrections(
        order_id, result_request_id, prior_correction_result_hash, correction_result_hash, copy_payload
    ) VALUES (
        p_order_id, p_result_request_id, p_prior_correction_result_hash,
        p_correction_result_hash, p_copy_payload
    );
    FOR v_row IN SELECT item FROM pg_catalog.jsonb_array_elements(p_copy_payload->'rows') AS item LOOP
        UPDATE public.analysis_results
        SET one_line_overview = v_row->>'oneLineOverview', risk_analysis = v_row->'riskAnalysis'
        WHERE request_id = p_result_request_id AND rank = (v_row->>'rank')::INTEGER;
    END LOOP;
    RETURN pg_catalog.jsonb_build_object('state', 'corrected', 'correctedRows', 16, 'correctedHighRiskRows', 2);
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.correct_earlybird_v214_concierge_gemini_copy(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.correct_earlybird_v214_concierge_gemini_copy(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, JSONB
) TO service_role;
COMMIT;
