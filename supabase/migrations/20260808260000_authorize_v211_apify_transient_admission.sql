-- MIGRATION_PREDECESSOR=20260808250000
-- The incident helper already authorizes r9, but the shared request-creation
-- guard still pins the v2.11 policy branch to r8. Add one exact r9 branch and
-- record the requestless PROVIDER_RUN_ADOPTION_REQUIRED resume immutably.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := FALSE;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1
                FROM supabase_migrations.schema_migrations
                WHERE version = '20260808250000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_APIFY_ADMISSION_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE TABLE public.earlybird_v211_apify_transient_admission_resumes (
    order_id UUID PRIMARY KEY
        REFERENCES public.earlybird_v211_apify_transient_replays(order_id)
        ON DELETE RESTRICT,
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.earlybird_v211_apify_transient_admission_resumes
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_apify_transient_admission_resumes
    FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_v211_apify_transient_admission_resumes
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER prevent_earlybird_v211_apify_transient_admission_resume_mutation
BEFORE UPDATE OR DELETE
ON public.earlybird_v211_apify_transient_admission_resumes
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

DO $readiness_patch$
DECLARE
    v_signature TEXT :=
        'public.earlybird_provider_run_adoption_ready(uuid,uuid,uuid)';
    v_definition TEXT;
    v_rewritten TEXT;
    v_expected_old_hash CONSTANT TEXT := '0fee6978e531a3f838fe47dc178fd064';
    v_old TEXT := $old$                                  OR (
                                      public.earlybird_v211_policy_identity_replay_ready(
                                          recovery.order_id, failed_request.id,
                                          recovery.recovery_preflight_id,
                                          current_preflight.id
                                      )
                                      AND current_preflight.idempotency_key =
                                          'earlybird.fulfillment.'
                                          || pg_catalog.replace(
                                              earlybird_order.id::TEXT, '-', ''
                                          ) || '.r8'
                                  )$old$;
    v_new TEXT := $new$                                  OR (
                                      public.earlybird_v211_policy_identity_replay_ready(
                                          recovery.order_id, failed_request.id,
                                          recovery.recovery_preflight_id,
                                          current_preflight.id
                                      )
                                      AND current_preflight.idempotency_key =
                                          'earlybird.fulfillment.'
                                          || pg_catalog.replace(
                                              earlybird_order.id::TEXT, '-', ''
                                          ) || '.r8'
                                  )
                                  OR (
                                      public.earlybird_v211_apify_transient_replay_ready(
                                          recovery.order_id, failed_request.id,
                                          recovery.recovery_preflight_id,
                                          current_preflight.id
                                      )
                                      AND current_preflight.idempotency_key =
                                          'earlybird.fulfillment.'
                                          || pg_catalog.replace(
                                              earlybird_order.id::TEXT, '-', ''
                                          ) || '.r9'
                                  )$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.md5(v_definition) <> v_expected_old_hash
       OR pg_catalog.strpos(v_definition, v_old) = 0
       OR pg_catalog.strpos(
            v_definition,
            'public.analysis_v2_valid_recovery_adoption_preflights('
       ) = 0
       OR pg_catalog.strpos(v_definition, 'source_run.status = ''aborted''') = 0 THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_APIFY_ADMISSION_READINESS_OLD_SHAPE_MISMATCH';
    END IF;
    v_rewritten := pg_catalog.replace(v_definition, v_old, v_new);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(
            v_rewritten,
            'public.earlybird_v211_apify_transient_replay_ready('
       ) = 0
       OR pg_catalog.strpos(v_rewritten, ') || ''.r9''') = 0 THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_APIFY_ADMISSION_READINESS_REWRITE_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$readiness_patch$;

REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.resume_earlybird_v211_apify_transient_admission(
    p_order_id UUID,
    p_expected_manual_review_at TIMESTAMP WITH TIME ZONE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_replay public.earlybird_v211_apify_transient_replays%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_recovery public.earlybird_schema_failure_recoveries%ROWTYPE;
    v_existing public.earlybird_v211_apify_transient_admission_resumes%ROWTYPE;
BEGIN
    IF p_order_id IS NULL OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_APIFY_ADMISSION_RESUME_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id FOR UPDATE;
    SELECT replay.* INTO v_replay
    FROM public.earlybird_v211_apify_transient_replays AS replay
    WHERE replay.order_id = p_order_id FOR UPDATE;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_replay.rearmed_preflight_id FOR UPDATE;
    SELECT recovery.* INTO v_recovery
    FROM public.earlybird_schema_failure_recoveries AS recovery
    WHERE recovery.order_id = p_order_id FOR UPDATE;
    SELECT resume.* INTO v_existing
    FROM public.earlybird_v211_apify_transient_admission_resumes AS resume
    WHERE resume.order_id = p_order_id FOR UPDATE;

    IF FOUND THEN
        IF v_existing.expected_manual_review_at
                IS DISTINCT FROM p_expected_manual_review_at
           OR v_order.preflight_id IS DISTINCT FROM v_replay.rearmed_preflight_id
           OR v_order.status NOT IN ('paid', 'analysis_in_progress', 'completed')
           OR v_fulfillment.status NOT IN (
                'admission_pending', 'retryable_failure',
                'analysis_in_progress', 'completed'
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_V211_APIFY_ADMISSION_RESUME_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN TRUE;
    END IF;

    IF v_order.id IS NULL
       OR v_replay.order_id IS NULL
       OR v_recovery.order_id IS NULL
       OR v_order.preflight_id IS DISTINCT FROM v_replay.rearmed_preflight_id
       OR v_order.status <> 'paid'
       OR v_order.result_request_id IS NOT NULL
       OR v_order.plan_id <> 'basic'
       OR v_order.expected_amount_krw <> 990
       OR v_order.actual_amount_krw <> 990
       OR v_order.payment_id IS NULL
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_fulfillment.status <> 'manual_review'
       OR v_fulfillment.attempt_count <> 1
       OR v_fulfillment.request_id IS NOT NULL
       OR v_fulfillment.last_error_code <> 'PROVIDER_RUN_ADOPTION_REQUIRED'
       OR v_fulfillment.manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       OR v_fulfillment.lease_token IS NOT NULL
       OR v_fulfillment.lease_expires_at IS NOT NULL
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.status <> 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.pii_scrubbed_at IS NOT NULL
       OR v_preflight.idempotency_key IS DISTINCT FROM (
            'earlybird.fulfillment.'
            || pg_catalog.replace(v_order.id::TEXT, '-', '') || '.r9'
       )
       OR v_preflight.target_instagram_id IS DISTINCT FROM
            v_order.target_instagram_id
       OR v_preflight.admission_status <> 'ready'
       OR v_preflight.admission_selected_plan_id <> 'basic'
       OR v_preflight.admission_dispatch_state <> 'enqueued'
       OR NOT public.earlybird_v211_apify_transient_replay_ready(
            v_order.id,
            v_replay.original_failed_request_id,
            v_recovery.recovery_preflight_id,
            v_preflight.id
       )
       OR NOT public.earlybird_provider_run_adoption_ready(
            v_order.id,
            v_replay.original_failed_request_id,
            v_recovery.recovery_preflight_id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_requests AS request
            WHERE request.preflight_id = v_preflight.id
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_APIFY_ADMISSION_RESUME_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.earlybird_v211_apify_transient_admission_resumes(
        order_id, expected_manual_review_at
    ) VALUES (v_order.id, p_expected_manual_review_at);

    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending', attempt_count = 0, request_id = NULL,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = v_now,
        operator_admitted_at = v_now, last_error_code = NULL,
        last_error_at = NULL, manual_review_at = NULL,
        completed_at = NULL, updated_at = v_now
    WHERE fulfillment.order_id = v_order.id;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.resume_earlybird_v211_apify_transient_admission(
    UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resume_earlybird_v211_apify_transient_admission(
    UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

DO $final_guard$
DECLARE
    v_readiness TEXT :=
        'public.earlybird_provider_run_adoption_ready(uuid,uuid,uuid)';
    v_resume TEXT :=
        'public.resume_earlybird_v211_apify_transient_admission('
        || 'uuid,timestamp with time zone)';
BEGIN
    IF pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(v_readiness::pg_catalog.regprocedure),
            'public.earlybird_v211_apify_transient_replay_ready('
       ) = 0
       OR pg_catalog.strpos(
            pg_catalog.pg_get_functiondef(v_readiness::pg_catalog.regprocedure),
            ') || ''.r9'''
       ) = 0
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc AS proc
            CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                proc.proacl, pg_catalog.acldefault('f', proc.proowner)
            )) AS privilege
            WHERE proc.oid IN (
                v_readiness::pg_catalog.regprocedure,
                v_resume::pg_catalog.regprocedure
            )
              AND privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_resume, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_resume, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_resume, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_readiness, 'EXECUTE') THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_APIFY_ADMISSION_FINAL_GUARD_MISMATCH';
    END IF;
END;
$final_guard$;

COMMIT;
