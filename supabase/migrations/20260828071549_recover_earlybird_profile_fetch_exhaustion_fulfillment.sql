-- Allow one audited fresh admission after a paid V2 request terminally failed
-- with JOB_ATTEMPTS_EXHAUSTED following repeated PROFILE_FETCH_PERSISTENCE_ERROR
-- profile-batch failures. The original payment, request, job, and provider-run
-- ledgers remain immutable; the replacement preflight is the only new work
-- admitted for the already-paid order. It also renames and re-fronts the
-- existing resolve_analysis_v2_recovery_provider_run RPC so the fresh
-- successor request this recovery mints can never adopt a pre-exhaustion
-- provider Dataset (see the resolver wrapper below for details).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.earlybird_profile_fetch_exhaustion_recoveries (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    recovery_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    prior_attempt_count SMALLINT NOT NULL CHECK (
        prior_attempt_count BETWEEN 1 AND 10
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.earlybird_profile_fetch_exhaustion_recoveries
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_profile_fetch_exhaustion_recoveries
    FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_profile_fetch_exhaustion_recoveries
    FROM PUBLIC, anon, authenticated, service_role;

-- Reuse the existing generic immutability guard: this ledger is append-only,
-- exactly like the sibling schema-failure and profile-evidence recovery
-- ledgers it is modeled on.
CREATE TRIGGER prevent_earlybird_profile_fetch_exhaustion_recovery_mutation
BEFORE UPDATE OR DELETE
ON public.earlybird_profile_fetch_exhaustion_recoveries
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE FUNCTION public.recover_earlybird_profile_fetch_exhaustion_fulfillment(
    p_order_id UUID,
    p_expected_failed_request_id UUID,
    p_expected_manual_review_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(
    order_id UUID,
    fulfillment_status TEXT,
    preflight_id UUID,
    failed_request_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_user_id UUID;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_existing public.earlybird_profile_fetch_exhaustion_recoveries%ROWTYPE;
    v_new_preflight_id UUID;
    v_recovery_key TEXT;
BEGIN
    IF p_order_id IS NULL
       OR p_expected_failed_request_id IS NULL
       OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- User-first lock ordering: learn the owning user without a row lock,
    -- take the same plain user advisory-lock key the checkout/claim paths
    -- use, then lock fulfillment -> order -> recovery -> request -> preflight
    -- in that fixed order -- matching create_or_replay_earlybird_fulfillment_
    -- request's own fulfillment-then-order-then-preflight prefix -- so this
    -- function can never deadlock against it.
    SELECT earlybird_order.user_id INTO v_user_id
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_user_id::TEXT, 0)
    );

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT recovery.* INTO v_existing
    FROM public.earlybird_profile_fetch_exhaustion_recoveries AS recovery
    WHERE recovery.order_id = p_order_id
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.failed_request_id IS DISTINCT FROM p_expected_failed_request_id
           OR v_existing.expected_manual_review_at
                IS DISTINCT FROM p_expected_manual_review_at THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        IF v_order.preflight_id IS DISTINCT FROM v_existing.recovery_preflight_id
           OR v_order.status <> 'paid'
           OR v_order.result_request_id IS NOT NULL
           OR v_fulfillment.request_id IS NOT NULL
           OR v_fulfillment.status NOT IN ('admission_pending', 'retryable_failure') THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            p_order_id,
            v_fulfillment.status,
            v_existing.recovery_preflight_id,
            v_existing.failed_request_id;
        RETURN;
    END IF;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_expected_failed_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_SNAPSHOT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_order.status <> 'analysis_in_progress'
       OR v_order.result_request_id IS DISTINCT FROM v_request.id
       OR v_order.user_id IS DISTINCT FROM v_user_id
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.paid_at IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.earlybird_webhook_events AS webhook_event
            WHERE webhook_event.order_id = v_order.id
       )
       OR NOT EXISTS (
            SELECT 1
            FROM public.earlybird_webhook_events AS webhook_event
            WHERE webhook_event.order_id = v_order.id
              AND webhook_event.event_type = 'payment.completed'
       )
       OR v_fulfillment.status <> 'manual_review'
       OR v_fulfillment.request_id IS DISTINCT FROM v_request.id
       OR v_fulfillment.last_error_code IS DISTINCT FROM 'ANALYSIS_FAILED'
       OR v_fulfillment.manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       OR v_fulfillment.attempt_count NOT BETWEEN 1 AND 10
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status <> 'failed'
       OR v_request.current_step IS DISTINCT FROM 'failed'
       OR v_request.error_message IS DISTINCT FROM 'JOB_ATTEMPTS_EXHAUSTED'
       OR v_preflight.status <> 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.pii_scrubbed_at IS NULL
       -- Each scrub token is derived from -- and only from -- the id of the
       -- row that carries it: the failed request's own canonical token, and
       -- the consumed preflight's own canonical token. They are never
       -- required to equal each other.
       OR v_request.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_request.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_preflight.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_preflight.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_order.concierge_apify_credential_slot IS DISTINCT FROM 'secondary'
       OR v_preflight.order_scoped_apify_credential_slot
            IS DISTINCT FROM v_order.concierge_apify_credential_slot
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_following_count IS NULL
       OR v_preflight.target_followers_count
            IS DISTINCT FROM v_order.target_followers_count
       OR v_preflight.target_following_count
            IS DISTINCT FROM v_order.target_following_count
       OR v_preflight.target_is_private IS DISTINCT FROM FALSE
       OR v_preflight.capacity_required_plan_id IS NULL
       OR v_preflight.required_plan_id IS NULL
       OR v_preflight.plan_cards_snapshot IS NULL
       OR NOT public.analysis_v2_valid_launch_snapshot(
            v_preflight.launch_status_snapshot
       )
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(
            v_preflight.plan_catalog_snapshot
       )
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(
            v_preflight.plan_cards_snapshot
       )
       OR NOT public.analysis_v2_valid_pricing_snapshot(
            v_preflight.pricing_snapshot
       )
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(
            v_preflight.policy_versions_snapshot
       )
       -- analysis_v2_failure_receipts.request_id is the table's own primary
       -- key, so at most one row can ever exist per request; this is
       -- therefore both the "exactly one" and the "matches this exact
       -- failure" gate in a single check.
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
              AND receipt.failed_job_key = 'track:target-evidence:collect'
              AND receipt.error_code = 'JOB_ATTEMPTS_EXHAUSTED'
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS pipeline_job
            WHERE pipeline_job.request_id = v_request.id
              AND pipeline_job.status IN ('pending', 'processing', 'retryable')
       )
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS pipeline_job
            WHERE pipeline_job.request_id = v_request.id
              AND pipeline_job.track = 'profiles'
              AND pipeline_job.status = 'cancelled'
              AND pipeline_job.last_error_code = 'PROFILE_FETCH_PERSISTENCE_ERROR'
       )
       -- This exact incident requires at least one provider run, and every
       -- one of them must have fully succeeded and reconciled -- narrower
       -- than "terminal", so the resolver wrapper below can treat every
       -- source run for this lineage as adoption-ready.
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
              AND (
                  provider_run.status IS DISTINCT FROM 'succeeded'
                  OR provider_run.run_id IS NULL
                  OR provider_run.actual_usage_usd IS NULL
                  OR provider_run.usage_reconciled_at IS NULL
              )
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_requests AS active_request
            WHERE active_request.user_id = v_order.user_id
              AND active_request.id <> v_request.id
              AND active_request.status IN ('pending', 'processing')
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_preflights AS active_preflight
            WHERE active_preflight.user_id = v_order.user_id
              AND active_preflight.id <> v_preflight.id
              AND active_preflight.status IN ('pending', 'processing', 'ready')
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    -- The shared, append-only admission ledger below is keyed one row per
    -- order. An unrelated, earlier recovery (e.g. the original schema-
    -- failure path) may already hold that row; fail closed with a
    -- descriptive error instead of surfacing a raw unique-constraint
    -- violation from the bridge INSERT further down.
    IF EXISTS (
        SELECT 1
        FROM public.earlybird_schema_failure_recoveries AS shared_recovery
        WHERE shared_recovery.order_id = v_order.id
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_SHARED_LEDGER_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_new_preflight_id := extensions.gen_random_uuid();
    -- Canonical key so the existing create_or_replay_earlybird_fulfillment_request
    -- request-generation guard recognizes this fresh-admitted lineage exactly
    -- the way it already recognizes every other earlybird recovery lineage.
    v_recovery_key := 'earlybird.schema-recovery.'
        || pg_catalog.replace(v_order.id::TEXT, '-', '');

    -- The fresh preflight is built only from the paid order's own immutable
    -- target fields and the old (terminal, scrubbed) preflight's immutable
    -- admission/pricing/policy snapshots -- never from the failed request's
    -- working data, and never touching the order's payment or credential slot
    -- columns. Setting order_scoped_apify_credential_slot explicitly here is
    -- belt-and-suspenders: the existing copy_earlybird_order_scoped_apify_slot
    -- trigger also repoints it when earlybird_orders.preflight_id is updated
    -- below, as long as the order still carries a non-null slot.
    INSERT INTO public.analysis_preflights(
        id, user_id, idempotency_key, target_instagram_id, status,
        exclusion_decision, excluded_instagram_id, access_mode,
        launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
        pricing_version, pricing_snapshot, policy_versions_snapshot,
        target_followers_count, target_following_count, target_is_private,
        capacity_required_plan_id, required_plan_id,
        order_scoped_apify_credential_slot,
        created_at, updated_at, expires_at, ready_at
    ) VALUES (
        v_new_preflight_id, v_order.user_id, v_recovery_key,
        v_order.target_instagram_id, 'ready', v_order.exclusion_decision,
        v_order.excluded_instagram_id, 'production',
        v_preflight.launch_status_snapshot, v_preflight.plan_catalog_snapshot,
        v_preflight.plan_cards_snapshot, v_preflight.pricing_version,
        v_preflight.pricing_snapshot, v_preflight.policy_versions_snapshot,
        v_order.target_followers_count, v_order.target_following_count,
        FALSE, v_preflight.capacity_required_plan_id,
        v_preflight.required_plan_id, v_order.concierge_apify_credential_slot,
        v_now, v_now, v_now + INTERVAL '30 minutes', v_now
    );

    -- Bridge into the existing shared admission ledger so the unmodified
    -- create_or_replay_earlybird_fulfillment_request request-generation guard
    -- recognizes this lineage and can mint a fresh idempotency-key generation
    -- for the order's immutable base key instead of rejecting the replay.
    INSERT INTO public.earlybird_schema_failure_recoveries(
        order_id, failed_request_id, recovery_preflight_id, prior_attempt_count
    ) VALUES (
        v_order.id, v_request.id, v_new_preflight_id, v_fulfillment.attempt_count
    );

    INSERT INTO public.earlybird_profile_fetch_exhaustion_recoveries(
        order_id, failed_request_id, recovery_preflight_id,
        prior_attempt_count, expected_manual_review_at
    ) VALUES (
        v_order.id, v_request.id, v_new_preflight_id,
        v_fulfillment.attempt_count, p_expected_manual_review_at
    );

    UPDATE public.earlybird_orders AS earlybird_order
    SET preflight_id = v_new_preflight_id,
        status = 'paid',
        result_request_id = NULL,
        updated_at = v_now
    WHERE earlybird_order.id = v_order.id;

    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending',
        attempt_count = 0,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = v_now,
        request_id = NULL,
        operator_admitted_at = v_now,
        last_error_code = NULL,
        last_error_at = NULL,
        completed_at = NULL,
        manual_review_at = NULL,
        updated_at = v_now
    WHERE fulfillment.order_id = v_order.id;

    RETURN QUERY SELECT
        v_order.id,
        'admission_pending'::TEXT,
        v_new_preflight_id,
        v_request.id;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_earlybird_profile_fetch_exhaustion_fulfillment(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_earlybird_profile_fetch_exhaustion_fulfillment(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

-- The bridge insert above means create_or_replay_earlybird_fulfillment_
-- request's own request-generation guard already recognizes this lineage's
-- preserved, terminally-failed request as a conflicting request via the
-- shared earlybird_schema_failure_recoveries ledger. Its separate
-- provider-run adoption gate does not yet know this exact lineage is safe
-- to adopt, though: rename it and re-front it with a narrow, exact helper,
-- exactly like the existing first15-canary rearm
-- (earlybird_first15_canary_provider_rearm_request_ready).
ALTER FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) RENAME TO earlybird_provider_run_adoption_ready_pre_pfe;
REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready_pre_pfe(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.earlybird_profile_fetch_exhaustion_provider_run_adoption_ready(
    p_order_id UUID,
    p_failed_request_id UUID,
    p_recovery_preflight_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    -- earlybird_profile_fetch_exhaustion_recoveries is immutable (see the
    -- mutation-preventing trigger above), so matching it exactly -- order,
    -- failed request, and recovery preflight all at once -- is sufficient:
    -- unlike schema-failure recovery's own multi-generation rearms, this
    -- lineage never produces a second preflight generation to drift to.
    SELECT EXISTS (
        SELECT 1
        FROM public.earlybird_profile_fetch_exhaustion_recoveries AS recovery
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = recovery.order_id
        JOIN public.analysis_preflights AS recovery_preflight
          ON recovery_preflight.id = recovery.recovery_preflight_id
        WHERE recovery.order_id = p_order_id
          AND recovery.failed_request_id = p_failed_request_id
          AND recovery.recovery_preflight_id = p_recovery_preflight_id
          AND earlybird_order.preflight_id = recovery.recovery_preflight_id
          -- Same paid order the recovery admitted: still paid, and not yet
          -- bound to any result request -- exactly the state the creator's
          -- own admission checks already guarantee before it ever reaches
          -- this readiness gate.
          AND earlybird_order.status = 'paid'
          AND earlybird_order.result_request_id IS NULL
          AND recovery_preflight.status = 'ready'
          AND recovery_preflight.access_mode = 'production'
          AND recovery_preflight.idempotency_key =
              'earlybird.schema-recovery.'
              || pg_catalog.replace(earlybird_order.id::TEXT, '-', '')
          -- At least one source provider run must exist, and every one of
          -- them must be fully succeeded and reconciled: the same narrower-
          -- than-terminal bar the admitting recover_earlybird_profile_fetch_
          -- exhaustion_fulfillment function itself enforced at admission
          -- time. A plain NOT EXISTS(bad row) alone would be vacuously true
          -- for zero runs, so the existence half is required too.
          AND EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = recovery.failed_request_id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = recovery.failed_request_id
                AND (
                    source_run.status IS DISTINCT FROM 'succeeded'
                    OR source_run.run_id IS NULL
                    OR source_run.actual_usage_usd IS NULL
                    OR source_run.usage_reconciled_at IS NULL
                )
          )
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_profile_fetch_exhaustion_provider_run_adoption_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.earlybird_provider_run_adoption_ready(
    p_order_id UUID,
    p_failed_request_id UUID,
    p_recovery_preflight_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT public.earlybird_provider_run_adoption_ready_pre_pfe(
        p_order_id, p_failed_request_id, p_recovery_preflight_id
    )
    OR public.earlybird_profile_fetch_exhaustion_provider_run_adoption_ready(
        p_order_id, p_failed_request_id, p_recovery_preflight_id
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

-- The task contract for this recovery forbids reusing any pre-exhaustion
-- provider Dataset: the fresh successor request minted above must never
-- adopt a stale run recorded against the terminally failed request. Rename
-- the current resolver and reinstall its exact original signature as a thin
-- router in front of it, exactly like the existing first15-canary router
-- (resolve_analysis_v2_recovery_provider_run_first15): return NULL only for
-- the exact successor request this recovery lineage produced -- so the
-- current-request provider store makes a brand-new external call -- and
-- delegate byte-for-byte to the renamed resolver for every other caller,
-- including a request resuming its own earlier provider run.
ALTER FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) RENAME TO resolve_analysis_v2_recovery_provider_run_pre_pfe;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run_pre_pfe(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_recovery public.earlybird_profile_fetch_exhaustion_recoveries%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
BEGIN
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id;

    SELECT recovery.* INTO v_recovery
    FROM public.earlybird_profile_fetch_exhaustion_recoveries AS recovery
    WHERE recovery.recovery_preflight_id = v_request.preflight_id;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = v_recovery.order_id;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_recovery.order_id;

    -- Only the exact successor this recovery lineage produced short-circuits
    -- to NULL: the same order's preflight and result_request_id, and the
    -- same order's fulfillment request_id, must all still point at this
    -- exact p_request_id.
    IF v_request.id IS NOT NULL
       AND v_recovery.order_id IS NOT NULL
       AND v_order.id IS NOT NULL
       AND v_order.preflight_id = v_recovery.recovery_preflight_id
       AND v_order.result_request_id = p_request_id
       AND v_fulfillment.order_id IS NOT NULL
       AND v_fulfillment.request_id = p_request_id
    THEN
        RETURN NULL;
    END IF;

    RETURN public.resolve_analysis_v2_recovery_provider_run_pre_pfe(
        p_request_id, p_job_key, p_claim_token, p_operation_key, p_input_hash,
        p_logical_provider, p_actor_id, p_credential_slot, p_max_charge_usd
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) TO service_role;
