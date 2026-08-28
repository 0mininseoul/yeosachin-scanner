-- Third-stage recovery: a paid earlybird order already recorded in
-- earlybird_pfe_target_evidence_start_rejection_rearms (the second-stage PFE
-- rearm ledger) was admitted onto that rearm's fresh preflight (generation
-- '.r1'), and the resulting successor request (idempotency key
-- 'earlybird:<order>.r2', the order's third analysis_requests generation
-- counting the immutable base key as generation 0) itself terminally failed
-- at track:profile-ai:batch:3 with ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR.
--
-- Investigation (see lib/services/analysis/v2-worker.ts:
-- classifyAnalysisV2JobFailure / failureDispositionForCode /
-- isTransientMediaObjectFailure, and lib/services/analysis/
-- v2-media-artifact-store.ts) found no runtime defect: GCS object-layer
-- failures are already classified transient only for 408/429/5xx/unknown
-- status and permanent otherwise, and this exact failure category --
-- ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR at a track:profile-ai:batch:N job
-- -- is already a recognized, previously-handled recoverable failure mode
-- (see 20260815220000_first15_canary_existing_route_generation_two.sql and
-- the generation-three first15-canary migrations, which route the identical
-- code/track pattern through their own rearm). No application code change
-- is made by this migration; it is a data-recovery migration only.
--
-- Every provider run this second successor made is terminal (succeeded) and
-- usage-reconciled, and every media artifact it registered is deleted
-- (terminal cleanup already ran). This migration audits that evidence,
-- preserves all three prior failed request/job/provider-run/media-artifact
-- ledgers immutably, and admits one more fresh preflight/request generation
-- through the unmodified production creator so the order can retry with a
-- brand-new, zero-adoption provider call and a brand-new, zero-reuse media
-- artifact namespace (media artifact object names are content-addressed
-- under analysis-v2/<request_id>/..., so a fresh request id makes prior
-- media artifacts structurally unreachable -- no adoption path exists or is
-- added for them). Provider-run adoption is deliberately kept at zero for
-- this successor too, exactly like the first- and second-stage recoveries:
-- the production create_or_replay_earlybird_fulfillment_request creator
-- always resolves the order's *base*-key request (the original
-- job-exhausted request) as the "conflicting" request on every admission,
-- regardless of how many rearm generations exist, so any adoption gate can
-- only ever be evaluated against that base request's own (minimal) dataset
-- -- never against this richer, later-failed successor's own 13 succeeded
-- runs. Safely adopting the later successor's specific runs would require a
-- new, request-scoped adoption path this migration does not add; re-running
-- those provider calls is the smallest change that stays safe and auditable
-- with the existing architecture, at the cost of re-incurring their
-- provider-side cost (the order itself already settled at
-- actual_amount_krw = 0, so there is no customer-facing charge either way).
--
-- Pre-apply correction: the real incident's paid-order relationship counts
-- (earlybird_orders.target_followers_count/target_following_count, frozen at
-- checkout) are both greater than this consumed r2 preflight's own
-- target_followers_count/target_following_count -- the same legitimate
-- checkout-vs-later-observation drift 20260731030000_allow_capacity_safe_
-- earlybird_admission_count_drift.sql, 20260808240000_allow_v211_policy_
-- replay_capacity_safe_count_drift.sql, and 20260826165211_earlybird_direct_
-- fresh_apify_checkpoint.sql already authorize elsewhere in this same
-- Earlybird admission surface. An exact byte-for-byte equality between the
-- two would reject this exact production candidate. The eligibility gate
-- below therefore replaces that equality with the same independently-
-- bounded, fully-witnessed capacity-safe drift check those precedents use:
-- the preflight's own fresh-admission witness must still match its current
-- target counts and plan/card snapshots exactly, and both the order's and
-- the preflight's own observations must be non-negative and independently
-- fit inside the capacity of the one card the order's paid plan selects.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Every multi-word column below would push Postgres's default
-- "<table>_<column>_fkey/key/check" auto-naming past the 63-byte
-- NAMEDATALEN identifier limit (silently truncated), exactly like the
-- second-stage rearm table before it. Every PK/UNIQUE/FK/CHECK constraint is
-- therefore given a short, explicit, unique-per-table name instead.
CREATE TABLE public.earlybird_pfe3_media_artifact_rearms (
    order_id UUID
        CONSTRAINT pfe3_rearms_pkey PRIMARY KEY,
    pfe_original_failed_request_id UUID NOT NULL,
    pfe2_rejected_successor_request_id UUID NOT NULL,
    media_failed_request_id UUID NOT NULL,
    rearmed_preflight_id UUID NOT NULL,
    prior_attempt_count SMALLINT NOT NULL,
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT pfe3_rearms_order_fk FOREIGN KEY (order_id)
        REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    CONSTRAINT pfe3_rearms_orig_req_fk
        FOREIGN KEY (pfe_original_failed_request_id)
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    CONSTRAINT pfe3_rearms_orig_req_key
        UNIQUE (pfe_original_failed_request_id),
    CONSTRAINT pfe3_rearms_b_req_fk
        FOREIGN KEY (pfe2_rejected_successor_request_id)
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    CONSTRAINT pfe3_rearms_b_req_key
        UNIQUE (pfe2_rejected_successor_request_id),
    CONSTRAINT pfe3_rearms_media_req_fk
        FOREIGN KEY (media_failed_request_id)
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    CONSTRAINT pfe3_rearms_media_req_key
        UNIQUE (media_failed_request_id),
    CONSTRAINT pfe3_rearms_preflight_fk FOREIGN KEY (rearmed_preflight_id)
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    CONSTRAINT pfe3_rearms_preflight_key UNIQUE (rearmed_preflight_id),
    CONSTRAINT pfe3_rearms_prior_attempt_chk CHECK (
        prior_attempt_count BETWEEN 0 AND 10
    ),
    CONSTRAINT pfe3_rearms_distinct_chk CHECK (
        pfe_original_failed_request_id <> pfe2_rejected_successor_request_id
        AND pfe2_rejected_successor_request_id <> media_failed_request_id
        AND pfe_original_failed_request_id <> media_failed_request_id
    )
);

ALTER TABLE public.earlybird_pfe3_media_artifact_rearms
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_pfe3_media_artifact_rearms
    FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_pfe3_media_artifact_rearms
    FROM PUBLIC, anon, authenticated, service_role;

-- Reuse the existing generic append-only guard: this ledger is immutable,
-- exactly like every sibling earlybird recovery/rearm ledger it is modeled
-- on.
CREATE TRIGGER prevent_earlybird_pfe3_media_artifact_rearm_mutation
BEFORE UPDATE OR DELETE
ON public.earlybird_pfe3_media_artifact_rearms
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE FUNCTION public.rearm_earlybird_pfe3_media_artifact_error(
    p_order_id UUID,
    p_expected_media_failed_request_id UUID,
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
    v_pfe2_lineage public.earlybird_pfe_target_evidence_start_rejection_rearms%ROWTYPE;
    v_existing public.earlybird_pfe3_media_artifact_rearms%ROWTYPE;
    v_selected_card JSONB;
    v_new_preflight_id UUID;
    v_new_preflight_key CONSTANT TEXT := 'earlybird.fulfillment.'
        || pg_catalog.replace(p_order_id::TEXT, '-', '') || '.r2';
BEGIN
    IF p_order_id IS NULL
       OR p_expected_media_failed_request_id IS NULL
       OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- User-first lock ordering, then fulfillment -> order -> own ledger ->
    -- media-failed request -> preflight, matching the exact prefix
    -- create_or_replay_earlybird_fulfillment_request itself uses, and
    -- matching both prior recoveries' own internal order for the same
    -- reason.
    SELECT earlybird_order.user_id INTO v_user_id
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_NOT_FOUND',
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
            MESSAGE = 'EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT rearm.* INTO v_existing
    FROM public.earlybird_pfe3_media_artifact_rearms AS rearm
    WHERE rearm.order_id = p_order_id
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.media_failed_request_id
                IS DISTINCT FROM p_expected_media_failed_request_id
           OR v_existing.expected_manual_review_at
                IS DISTINCT FROM p_expected_manual_review_at THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        IF v_order.preflight_id IS DISTINCT FROM v_existing.rearmed_preflight_id
           OR v_order.status <> 'paid'
           OR v_order.result_request_id IS NOT NULL
           OR v_fulfillment.request_id IS NOT NULL
           OR v_fulfillment.status NOT IN ('admission_pending', 'retryable_failure') THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            p_order_id,
            v_fulfillment.status,
            v_existing.rearmed_preflight_id,
            v_existing.media_failed_request_id;
        RETURN;
    END IF;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_expected_media_failed_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_SNAPSHOT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    -- Immutable, append-only: read without a lock, it can never change
    -- under us.
    SELECT lineage.* INTO v_pfe2_lineage
    FROM public.earlybird_pfe_target_evidence_start_rejection_rearms AS lineage
    WHERE lineage.order_id = p_order_id;

    -- The one card the order's own paid plan actually selects, resolved
    -- once up front so both the admission-witness comparison and the
    -- capacity bound below read the exact same value.
    v_selected_card := v_preflight.plan_cards_snapshot -> v_order.plan_id;

    IF v_pfe2_lineage.order_id IS NULL
       OR v_pfe2_lineage.rearmed_preflight_id IS DISTINCT FROM v_preflight.id
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
       -- error_message, exactly like both prior recoveries.
       OR v_fulfillment.last_error_code IS DISTINCT FROM 'ANALYSIS_FAILED'
       OR v_fulfillment.manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       OR v_fulfillment.attempt_count NOT BETWEEN 1 AND 10
       OR v_request.id = v_pfe2_lineage.pfe_original_failed_request_id
       OR v_request.id = v_pfe2_lineage.rejected_successor_request_id
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status <> 'failed'
       OR v_request.current_step IS DISTINCT FROM 'failed'
       OR v_request.error_message
            IS DISTINCT FROM 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
       OR v_preflight.status <> 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.pii_scrubbed_at IS NULL
       -- Each scrub token is derived from -- and only from -- the id of the
       -- row that carries it, exactly like both prior recoveries.
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
       -- Checkout froze the paid order's own relationship-count observation
       -- (earlybird_orders.target_followers_count/target_following_count) at
       -- admission time, while this consumed preflight can carry a later,
       -- independent observation from its own fresh-admission pass; the two
       -- are not required to be byte-identical (see 20260731030000_allow_
       -- capacity_safe_earlybird_admission_count_drift.sql, 20260808240000_
       -- allow_v211_policy_replay_capacity_safe_count_drift.sql, and
       -- 20260826165211_earlybird_direct_fresh_apify_checkpoint.sql, all of
       -- which already authorize this exact independently-bounded drift for
       -- other Earlybird admission paths). What must still hold, byte for
       -- byte: the preflight's own fresh-admission witness has not itself
       -- drifted from its current target counts, the admission-time selected
       -- plan matches the plan the order actually paid for, and the
       -- admission-time capacity/required-plan/card witnesses still match
       -- the preflight's current snapshots -- then both the order's and the
       -- preflight's own observations must be non-negative and
       -- independently fit inside the capacity of the one card the paid
       -- plan actually selects.
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_followers_count < 0
       OR v_preflight.target_following_count IS NULL
       OR v_preflight.target_following_count < 0
       OR v_order.target_followers_count IS NULL
       OR v_order.target_followers_count < 0
       OR v_order.target_following_count IS NULL
       OR v_order.target_following_count < 0
       OR v_preflight.admission_target_followers_count IS NULL
       OR v_preflight.admission_target_followers_count
            IS DISTINCT FROM v_preflight.target_followers_count
       OR v_preflight.admission_target_following_count IS NULL
       OR v_preflight.admission_target_following_count
            IS DISTINCT FROM v_preflight.target_following_count
       OR v_preflight.admission_selected_plan_id
            IS DISTINCT FROM v_order.plan_id
       OR v_preflight.admission_capacity_required_plan_id
            IS DISTINCT FROM v_preflight.capacity_required_plan_id
       OR v_preflight.admission_required_plan_id
            IS DISTINCT FROM v_preflight.required_plan_id
       OR v_preflight.admission_plan_cards_snapshot
            IS DISTINCT FROM v_preflight.plan_cards_snapshot
       OR v_selected_card IS NULL
       OR v_selected_card ->> 'launchStatus' <> 'production'
       OR v_selected_card ->> 'selectionState'
            NOT IN ('required', 'available_upgrade')
       OR COALESCE(
            v_selected_card -> 'relationshipCapacity' ->> 'followers', ''
          ) !~ '^[0-9]+$'
       OR COALESCE(
            v_selected_card -> 'relationshipCapacity' ->> 'following', ''
          ) !~ '^[0-9]+$'
       OR v_order.target_followers_count > (
            v_selected_card -> 'relationshipCapacity' ->> 'followers'
          )::INTEGER
       OR v_order.target_following_count > (
            v_selected_card -> 'relationshipCapacity' ->> 'following'
          )::INTEGER
       OR v_preflight.target_followers_count > (
            v_selected_card -> 'relationshipCapacity' ->> 'followers'
          )::INTEGER
       OR v_preflight.target_following_count > (
            v_selected_card -> 'relationshipCapacity' ->> 'following'
          )::INTEGER
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
              AND receipt.failed_job_key = 'track:profile-ai:batch:3'
              AND receipt.error_code = 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS pipeline_job
            WHERE pipeline_job.request_id = v_request.id
              AND pipeline_job.status IN ('pending', 'processing', 'retryable')
       )
       -- The pipeline track column uses an underscore ('profile_ai') even
       -- though the job_key segment stays hyphenated
       -- ('track:profile-ai:batch:3'); a hyphenated track value must not
       -- satisfy the gate.
       -- attempt_count = 3 matches the production incident exactly. Its
       -- own analysis_pipeline_jobs_lease_check / _completion_check /
       -- _error_check / _failed_error_check constraints already force a
       -- 'failed' row's lease_token/lease_expires_at to NULL and its
       -- completed_at/last_error_at to NOT NULL, so no separate gate clause
       -- is needed for those; only the exact attempt count is not implied by
       -- any constraint and must be checked explicitly.
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS pipeline_job
            WHERE pipeline_job.request_id = v_request.id
              AND pipeline_job.job_key = 'track:profile-ai:batch:3'
              AND pipeline_job.track = 'profile_ai'
              AND pipeline_job.status = 'failed'
              AND pipeline_job.last_error_code
                    = 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
              AND pipeline_job.attempt_count = 3
       )
       -- Every provider run this successor made must exist, be fully
       -- succeeded and usage-reconciled, and run on the order's own
       -- retained secondary slot -- narrower than either prior recovery's
       -- own bar, matching this exact incident (no rejected/aborted rows).
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
                  OR provider_run.credential_slot IS DISTINCT FROM 'secondary'
              )
       )
       -- analysis_v2_ai_attempts is the distinct Gemini AI-attempt ledger --
       -- separate from analysis_v2_provider_runs above, which records only
       -- third-party Instagram scraper calls (logical_provider values like
       -- 'apify' or 'coderx', never Gemini). Require at least one AI attempt
       -- exists for this successor, and that every one of them is terminal
       -- ('reserved' is the ledger's sole non-terminal status; every other
       -- status -- 'success', 'rate_limited', 'ambiguous', 'rejected',
       -- 'response_rejected', 'cutoff' -- is terminal, matching
       -- analysis_v2_ai_attempt_status_check and the application's own
       -- TERMINAL_STATUSES constant) with a fully accounted usage/terminal
       -- shape, matching the production precheck that every r2 AI attempt
       -- is already terminal and accounted for.
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_ai_attempts AS ai_attempt
            WHERE ai_attempt.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_ai_attempts AS ai_attempt
            WHERE ai_attempt.request_id = v_request.id
              AND (
                  ai_attempt.status = 'reserved'
                  OR ai_attempt.usage_metadata_status IS NULL
                  OR ai_attempt.usage_complete IS NULL
                  OR ai_attempt.terminalized_at IS NULL
              )
       )
       -- analysis_v2_scheduler_operations' sole non-terminal status is
       -- 'claimed' ('ready' and 'terminal_unavailable' are both terminal,
       -- per its own analysis_v2_scheduler_operation_status_check); no
       -- operation for this successor may still be actively claimed.
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_scheduler_operations AS operation
            WHERE operation.request_id = v_request.id
              AND operation.status = 'claimed'
       )
       -- analysis_revenue_run_ledgers is exclusively a test_entitlement-mode
       -- ledger: its own CHECK constraint pins access_mode to
       -- 'test_entitlement', and begin_analysis_revenue_cost_ledger_v1 (the
       -- table's only inserter) rejects any request whose
       -- plan_access_mode_snapshot is not 'test_entitlement'. A production
       -- access_mode='production' earlybird successor can therefore never
       -- have one -- see 20260826165211_earlybird_direct_fresh_apify_
       -- checkpoint.sql's own identical
       -- "OR EXISTS (... analysis_revenue_run_ledgers ...)" fence -- and,
       -- because analysis_revenue_cost_operations' only foreign key cascades
       -- from this ledger's own primary key, no cost-operation child could
       -- exist without it either. Fail closed if one is ever found instead
       -- of assuming applicability either way.
       OR EXISTS (
            SELECT 1
            FROM public.analysis_revenue_run_ledgers AS ledger
            WHERE ledger.request_id = v_request.id
       )
       -- Zero adoption: neither prior recovery's own resolver wrapper ever
       -- let this successor adopt anything.
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
            WHERE adoption.request_id = v_request.id
       )
       -- Every media artifact this successor registered (including the
       -- failing job's own) must already be deleted -- the mandatory
       -- terminal-cleanup sweep already ran to completion for it. A fresh
       -- successor request gets a disjoint object-name namespace
       -- (analysis-v2/<request_id>/...), so nothing here is ever reachable
       -- by, or needs to be adopted by, the request this migration mints.
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_media_artifacts AS artifact
            WHERE artifact.request_id = v_request.id
              AND artifact.deleted_at IS NULL
       )
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_media_artifacts AS artifact
            WHERE artifact.request_id = v_request.id
              AND artifact.registration_job_key = 'track:profile-ai:batch:3'
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
            MESSAGE = 'EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    v_new_preflight_id := extensions.gen_random_uuid();
    IF EXISTS (
        SELECT 1
        FROM public.analysis_preflights AS existing_preflight
        WHERE existing_preflight.user_id = v_order.user_id
          AND existing_preflight.idempotency_key = v_new_preflight_key
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_KEY_COLLISION',
            ERRCODE = 'P0001';
    END IF;

    -- The fresh preflight is built only from the paid order's own immutable
    -- target fields and the terminal, scrubbed current (second-stage-rearm)
    -- preflight's immutable admission/pricing/policy snapshots -- never from
    -- the media-failed successor's working data, and never touching the
    -- order's payment or credential slot columns. order_scoped_apify_
    -- credential_slot is set explicitly here as belt-and-suspenders: the
    -- existing copy_earlybird_order_scoped_apify_slot trigger also repoints
    -- it when earlybird_orders.preflight_id is updated below.
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

    INSERT INTO public.earlybird_pfe3_media_artifact_rearms(
        order_id, pfe_original_failed_request_id,
        pfe2_rejected_successor_request_id, media_failed_request_id,
        rearmed_preflight_id, prior_attempt_count, expected_manual_review_at
    ) VALUES (
        v_order.id, v_pfe2_lineage.pfe_original_failed_request_id,
        v_pfe2_lineage.rejected_successor_request_id, v_request.id,
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

REVOKE ALL ON FUNCTION public.rearm_earlybird_pfe3_media_artifact_error(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_pfe3_media_artifact_error(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

-- create_or_replay_earlybird_fulfillment_request always rediscovers this
-- order's original, immutable base-key request (the first-stage recovery's
-- own failed request) as the "conflicting" request on every future
-- admission attempt, and its provider-run-adoption gate does not yet know
-- that a *third* rebind preflight for this exact lineage is safe. Rename
-- the current dispatcher and re-front it with a narrow, exact helper, the
-- same way the second-stage rearm itself re-fronted the first-stage
-- dispatcher before it.
ALTER FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) RENAME TO earlybird_provider_run_adoption_ready_pre_pfe3;
REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready_pre_pfe3(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.earlybird_pfe3_media_artifact_adoption_ready(
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
    -- earlybird_pfe3_media_artifact_rearms is immutable, so matching the
    -- order/original-failed-request/rearmed-preflight triple exactly is
    -- sufficient: this lineage never produces a second '.r2'-generation
    -- preflight to drift to.
    SELECT EXISTS (
        SELECT 1
        FROM public.earlybird_pfe3_media_artifact_rearms AS rearm
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
              || '.r2'
          -- The readiness bar is against the *original* job-exhausted
          -- request's own dataset -- the one create_or_replay always
          -- rediscovers as the conflicting request -- not either
          -- intervening successor, which contributed nothing adoptable
          -- through this architecture.
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

REVOKE ALL ON FUNCTION public.earlybird_pfe3_media_artifact_adoption_ready(
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
    SELECT public.earlybird_provider_run_adoption_ready_pre_pfe3(
        p_order_id, p_failed_request_id, p_recovery_preflight_id
    )
    OR public.earlybird_pfe3_media_artifact_adoption_ready(
        p_order_id, p_failed_request_id, p_recovery_preflight_id
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

-- Guarantee zero adoption of any of the three prior requests' datasets for
-- the final successor this rearm produces. Rename the current resolver (the
-- second-stage rearm's own wrapper) and reinstall its exact original
-- signature as a thin router in front of it: return NULL only for the exact
-- successor request this rearm lineage produced -- forcing a brand-new
-- external call -- and delegate byte-for-byte to the renamed resolver for
-- every other caller.
ALTER FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) RENAME TO resolve_analysis_v2_recovery_provider_run_pre_pfe3;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run_pre_pfe3(
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
    v_rearm public.earlybird_pfe3_media_artifact_rearms%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
BEGIN
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id;

    SELECT rearm.* INTO v_rearm
    FROM public.earlybird_pfe3_media_artifact_rearms AS rearm
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

    RETURN public.resolve_analysis_v2_recovery_provider_run_pre_pfe3(
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
