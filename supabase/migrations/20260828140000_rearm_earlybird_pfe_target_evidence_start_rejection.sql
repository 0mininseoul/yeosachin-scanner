-- Second-stage recovery: a paid earlybird order already recorded in
-- earlybird_profile_fetch_exhaustion_recoveries (the profile-fetch-exhaustion
-- recovery ledger) was admitted onto a fresh preflight, and the resulting
-- successor request itself terminally failed at track:target-evidence:collect
-- with SCRAPING_PROVIDER_START_REJECTED_ERROR -- Apify definitively rejected
-- starting apify/instagram-comment-scraper on the order's retained secondary
-- credential slot. Every provider run this successor made is terminal and
-- usage-reconciled (including the zero-usage rejected comments-actor row),
-- and the resolver wrapper installed by the profile-fetch-exhaustion recovery
-- already guaranteed this successor adopted nothing from the original
-- job-exhausted request. This migration audits that evidence, preserves both
-- prior failed request/job/provider-run ledgers immutably, and admits one
-- more fresh preflight/request generation through the unmodified production
-- creator so the order can retry with a brand-new, zero-adoption Actor call.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.earlybird_pfe_target_evidence_start_rejection_rearms (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    pfe_original_failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    rejected_successor_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    prior_attempt_count SMALLINT NOT NULL CHECK (
        prior_attempt_count BETWEEN 0 AND 10
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CHECK (pfe_original_failed_request_id <> rejected_successor_request_id)
);

ALTER TABLE public.earlybird_pfe_target_evidence_start_rejection_rearms
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_pfe_target_evidence_start_rejection_rearms
    FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_pfe_target_evidence_start_rejection_rearms
    FROM PUBLIC, anon, authenticated, service_role;

-- Reuse the existing generic append-only guard: this ledger is immutable,
-- exactly like every sibling earlybird recovery/rearm ledger it is modeled on.
CREATE TRIGGER prevent_earlybird_pfe_target_evidence_rearm_mutation
BEFORE UPDATE OR DELETE
ON public.earlybird_pfe_target_evidence_start_rejection_rearms
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE FUNCTION public.rearm_earlybird_pfe_target_evidence_start_rejection(
    p_order_id UUID,
    p_expected_rejected_request_id UUID,
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
    v_pfe_lineage public.earlybird_profile_fetch_exhaustion_recoveries%ROWTYPE;
    v_existing public.earlybird_pfe_target_evidence_start_rejection_rearms%ROWTYPE;
    v_new_preflight_id UUID;
    v_new_preflight_key TEXT;
BEGIN
    IF p_order_id IS NULL
       OR p_expected_rejected_request_id IS NULL
       OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- User-first lock ordering, then fulfillment -> order -> own ledger ->
    -- rejected request -> preflight, matching the exact prefix
    -- create_or_replay_earlybird_fulfillment_request itself uses
    -- (fulfillment -> order -> preflight) so this function can never
    -- deadlock against it, and matching the profile-fetch-exhaustion
    -- recovery's own internal order for the same reason.
    SELECT earlybird_order.user_id INTO v_user_id
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_NOT_FOUND',
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
            MESSAGE = 'EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT rearm.* INTO v_existing
    FROM public.earlybird_pfe_target_evidence_start_rejection_rearms AS rearm
    WHERE rearm.order_id = p_order_id
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.rejected_successor_request_id
                IS DISTINCT FROM p_expected_rejected_request_id
           OR v_existing.expected_manual_review_at
                IS DISTINCT FROM p_expected_manual_review_at THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        IF v_order.preflight_id IS DISTINCT FROM v_existing.rearmed_preflight_id
           OR v_order.status <> 'paid'
           OR v_order.result_request_id IS NOT NULL
           OR v_fulfillment.request_id IS NOT NULL
           OR v_fulfillment.status NOT IN ('admission_pending', 'retryable_failure') THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            p_order_id,
            v_fulfillment.status,
            v_existing.rearmed_preflight_id,
            v_existing.rejected_successor_request_id;
        RETURN;
    END IF;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_expected_rejected_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_SNAPSHOT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    -- Immutable, append-only: read without a lock, it can never change
    -- under us.
    SELECT lineage.* INTO v_pfe_lineage
    FROM public.earlybird_profile_fetch_exhaustion_recoveries AS lineage
    WHERE lineage.order_id = p_order_id;

    IF v_pfe_lineage.order_id IS NULL
       OR v_pfe_lineage.recovery_preflight_id IS DISTINCT FROM v_preflight.id
       OR v_order.status <> 'analysis_in_progress'
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
       -- The fulfillment-level code is the generic classifier's own
       -- 'ANALYSIS_FAILED' regardless of the underlying request's specific
       -- error_message; the exact SCRAPING_PROVIDER_START_REJECTED_ERROR
       -- code is only preserved on the request and its failure receipt
       -- below.
       OR v_fulfillment.last_error_code IS DISTINCT FROM 'ANALYSIS_FAILED'
       OR v_fulfillment.manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       OR v_fulfillment.attempt_count NOT BETWEEN 1 AND 10
       OR v_request.id = v_pfe_lineage.failed_request_id
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status <> 'failed'
       OR v_request.current_step IS DISTINCT FROM 'failed'
       OR v_request.error_message
            IS DISTINCT FROM 'SCRAPING_PROVIDER_START_REJECTED_ERROR'
       OR v_preflight.status <> 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.pii_scrubbed_at IS NULL
       -- Each scrub token is derived from -- and only from -- the id of the
       -- row that carries it, exactly like the profile-fetch-exhaustion
       -- recovery this lineage descends from.
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
       -- key: at most one receipt can exist per request, so this is both the
       -- "exactly one" and the "matches this exact failure" gate at once.
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
              AND receipt.failed_job_key = 'track:target-evidence:collect'
              AND receipt.error_code = 'SCRAPING_PROVIDER_START_REJECTED_ERROR'
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
              AND pipeline_job.job_key = 'track:target-evidence:collect'
              AND pipeline_job.track = 'target_evidence'
              AND pipeline_job.status = 'failed'
              AND pipeline_job.last_error_code
                    = 'SCRAPING_PROVIDER_START_REJECTED_ERROR'
       )
       -- At least one provider run must exist, and every one of them --
       -- including the zero-usage rejected row below -- must be fully
       -- terminal and usage-reconciled.
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
                  provider_run.status
                        NOT IN ('succeeded', 'failed', 'aborted', 'timed_out', 'rejected')
                  OR provider_run.actual_usage_usd IS NULL
                  OR provider_run.usage_reconciled_at IS NULL
              )
       )
       -- The exact rejected comments-actor row this incident produced:
       -- Apify definitively refused to start the run, so it is 'rejected'
       -- with no run id and exactly zero reconciled usage.
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS rejected_run
            WHERE rejected_run.request_id = v_request.id
              AND rejected_run.job_key = 'track:target-evidence:collect'
              AND rejected_run.operation_key LIKE 'target-comments:%'
              AND rejected_run.logical_provider = 'apify'
              AND rejected_run.actor_id = 'apify/instagram-comment-scraper'
              AND rejected_run.credential_slot = 'secondary'
              AND rejected_run.status = 'rejected'
              AND rejected_run.run_id IS NULL
              AND rejected_run.actual_usage_usd = 0
              AND rejected_run.usage_reconciled_at IS NOT NULL
       )
       -- Zero adoption: the profile-fetch-exhaustion recovery's own resolver
       -- wrapper already forced every one of this successor's provider calls
       -- to be brand-new, so no adoption row can exist for it.
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
            WHERE adoption.request_id = v_request.id
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
            MESSAGE = 'EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    v_new_preflight_id := extensions.gen_random_uuid();
    -- The exact preflight-idempotency-key shape
    -- create_or_replay_earlybird_fulfillment_request's own deep lineage
    -- check requires whenever it re-discovers this order's original,
    -- immutable base-key request as the "conflicting" request and this
    -- rebind preflight does not equal the profile-fetch-exhaustion lineage's
    -- own recovery preflight (see 20260731050000_bound_recovered_earlybird_
    -- request_generation.sql and every later "earlybird.fulfillment.<order>.
    -- r<n>" rearm migration that follows it). Generation 1 is always free
    -- here: the profile-fetch-exhaustion recovery this lineage descends from
    -- used its own distinct 'earlybird.schema-recovery.' prefix instead.
    v_new_preflight_key := 'earlybird.fulfillment.'
        || pg_catalog.replace(v_order.id::TEXT, '-', '')
        || '.r1';
    IF EXISTS (
        SELECT 1
        FROM public.analysis_preflights AS existing_preflight
        WHERE existing_preflight.user_id = v_order.user_id
          AND existing_preflight.idempotency_key = v_new_preflight_key
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_KEY_COLLISION',
            ERRCODE = 'P0001';
    END IF;

    -- The fresh preflight is built only from the paid order's own immutable
    -- target fields and the terminal, scrubbed source preflight's immutable
    -- admission/pricing/policy snapshots -- never from the failed successor
    -- request's working data, and never touching the order's payment or
    -- credential slot columns. order_scoped_apify_credential_slot is set
    -- explicitly here as belt-and-suspenders: the existing
    -- copy_earlybird_order_scoped_apify_slot trigger also repoints it when
    -- earlybird_orders.preflight_id is updated below.
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
        v_new_preflight_id, v_order.user_id, v_new_preflight_key,
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

    INSERT INTO public.earlybird_pfe_target_evidence_start_rejection_rearms(
        order_id, pfe_original_failed_request_id,
        rejected_successor_request_id, rearmed_preflight_id,
        prior_attempt_count, expected_manual_review_at
    ) VALUES (
        v_order.id, v_pfe_lineage.failed_request_id, v_request.id,
        v_new_preflight_id, v_fulfillment.attempt_count,
        p_expected_manual_review_at
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

REVOKE ALL ON FUNCTION public.rearm_earlybird_pfe_target_evidence_start_rejection(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_pfe_target_evidence_start_rejection(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

-- create_or_replay_earlybird_fulfillment_request always rediscovers this
-- order's original, immutable base-key request (the profile-fetch-exhaustion
-- lineage's own failed request) as the "conflicting" request on every future
-- admission attempt, and its provider-run-adoption gate does not yet know
-- that a *second* rebind preflight for this exact lineage is safe. Rename
-- the current dispatcher and re-front it with a narrow, exact helper, the
-- same way the profile-fetch-exhaustion recovery itself re-fronted the
-- first15-canary dispatcher before it.
ALTER FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) RENAME TO earlybird_provider_run_adoption_ready_pre_pfe2;
REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready_pre_pfe2(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.earlybird_pfe_evidence_rejection_adoption_ready(
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
    -- earlybird_pfe_target_evidence_start_rejection_rearms is immutable, so
    -- matching the order/original-failed-request/rearmed-preflight triple
    -- exactly is sufficient: this lineage never produces a second rebind
    -- preflight generation to drift to.
    SELECT EXISTS (
        SELECT 1
        FROM public.earlybird_pfe_target_evidence_start_rejection_rearms AS rearm
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = rearm.order_id
        JOIN public.analysis_preflights AS rearmed_preflight
          ON rearmed_preflight.id = rearm.rearmed_preflight_id
        WHERE rearm.order_id = p_order_id
          AND rearm.pfe_original_failed_request_id = p_failed_request_id
          AND rearm.rearmed_preflight_id = p_recovery_preflight_id
          AND earlybird_order.preflight_id = rearm.rearmed_preflight_id
          -- Same paid order the rearm admitted: still paid, and not yet
          -- bound to any result request -- exactly the state the creator's
          -- own admission checks already guarantee before it ever reaches
          -- this readiness gate.
          AND earlybird_order.status = 'paid'
          AND earlybird_order.result_request_id IS NULL
          AND rearmed_preflight.status = 'ready'
          AND rearmed_preflight.access_mode = 'production'
          AND rearmed_preflight.idempotency_key =
              'earlybird.fulfillment.'
              || pg_catalog.replace(earlybird_order.id::TEXT, '-', '')
              || '.r1'
          -- The readiness bar is against the *original* job-exhausted
          -- request's own dataset -- the one create_or_replay always
          -- rediscovers as the conflicting request -- not the intervening
          -- start-rejected successor, which contributed nothing adoptable.
          AND EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = rearm.pfe_original_failed_request_id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = rearm.pfe_original_failed_request_id
                AND (
                    source_run.status IS DISTINCT FROM 'succeeded'
                    OR source_run.run_id IS NULL
                    OR source_run.actual_usage_usd IS NULL
                    OR source_run.usage_reconciled_at IS NULL
                )
          )
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_pfe_evidence_rejection_adoption_ready(
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
    SELECT public.earlybird_provider_run_adoption_ready_pre_pfe2(
        p_order_id, p_failed_request_id, p_recovery_preflight_id
    )
    OR public.earlybird_pfe_evidence_rejection_adoption_ready(
        p_order_id, p_failed_request_id, p_recovery_preflight_id
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

-- Guarantee zero adoption of either prior request's dataset for the final
-- successor this rearm produces. Rename the current resolver (the profile-
-- fetch-exhaustion recovery's own wrapper) and reinstall its exact original
-- signature as a thin router in front of it: return NULL only for the exact
-- successor request this rearm lineage produced -- forcing a brand-new
-- external call -- and delegate byte-for-byte to the renamed resolver for
-- every other caller.
ALTER FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) RENAME TO resolve_analysis_v2_recovery_provider_run_pre_pfe2;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run_pre_pfe2(
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
    v_rearm public.earlybird_pfe_target_evidence_start_rejection_rearms%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
BEGIN
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id;

    SELECT rearm.* INTO v_rearm
    FROM public.earlybird_pfe_target_evidence_start_rejection_rearms AS rearm
    WHERE rearm.rearmed_preflight_id = v_request.preflight_id;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = v_rearm.order_id;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_rearm.order_id;

    -- Only the exact successor this rearm lineage produced short-circuits to
    -- NULL: the same order's preflight and result_request_id, and the same
    -- order's fulfillment request_id, must all still point at this exact
    -- p_request_id.
    IF v_request.id IS NOT NULL
       AND v_rearm.order_id IS NOT NULL
       AND v_order.id IS NOT NULL
       AND v_order.preflight_id = v_rearm.rearmed_preflight_id
       AND v_order.result_request_id = p_request_id
       AND v_fulfillment.order_id IS NOT NULL
       AND v_fulfillment.request_id = p_request_id
    THEN
        RETURN NULL;
    END IF;

    RETURN public.resolve_analysis_v2_recovery_provider_run_pre_pfe2(
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
