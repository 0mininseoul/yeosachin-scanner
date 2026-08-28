-- Fourth-stage recovery: a paid earlybird order already recorded in
-- earlybird_pfe3_media_artifact_rearms (the third-stage PFE3 rearm ledger)
-- was admitted onto that rearm's fresh preflight (generation '.r2'), and the
-- resulting successor request (idempotency key 'earlybird:<order>.r3', the
-- order's fourth analysis_requests generation counting the immutable base
-- key as generation 0) itself terminally failed with JOB_ATTEMPTS_EXHAUSTED
-- at track:profile-ai:batch:7.
--
-- Investigation found no runtime defect in the failing job itself: this
-- successor's own Gemini AI-attempt ledger (analysis_v2_ai_attempts) is
-- fully settled -- all 309 rows are terminal, none 'reserved' -- so no AI
-- call ever stalled. The real root cause sits one stage upstream, in the
-- profile-fetch checkpoint this successor's paid Earlybird route uses
-- (checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1, added by
-- 20260826165211_earlybird_direct_fresh_apify_checkpoint.sql): both
-- track:profiles:batch:5 and track:profiles:batch:7 completed a direct
-- fresh-Apify fetch with one username each left terminally unresolved
-- (batch 5: 29 of 30 resolved to 'success', 1 terminally
-- 'failed'/'incomplete'; batch 7: 26 of 27 resolved to 'success', 1
-- terminally 'failed'/'incomplete'). The profile-ai stage's own
-- candidate-input builder still assumes the legacy pre-fresh-Apify
-- contract, where every requested username resolves to a profile snapshot
-- before that stage's batch can be constructed at all; it does not yet
-- recognize a frozen, terminally-unresolved username as anything other than
-- "not ready yet", so it re-requests the identical batch input on every one
-- of its own retries instead of proceeding with the 29-of-30 (batch 5) or
-- 26-of-27 (batch 7) profiles that did resolve. Batch 7 -- the last
-- profile-ai batch -- spent its full seven-attempt budget this way and
-- terminally failed the whole request with JOB_ATTEMPTS_EXHAUSTED; batch
-- 5's own job was still mid-retry (attempt 6, itself never terminal) when
-- that whole-request failure aborted every other in-flight job, so it now
-- reads 'cancelled' rather than 'completed' or 'failed'. No application
-- code change is made by this migration; it is a data-recovery migration
-- only.
--
-- The raw per-username checkpoint rows this incident produced
-- (analysis_v2_profile_fetch_batches/analysis_v2_profile_fetch_outcomes)
-- are themselves already gone by the time this migration runs: the same
-- mandatory terminal-cleanup sweep that already removed this successor's
-- media artifacts also swept its profile-fetch checkpoint rows. The
-- persistent, PII-free analysis_v2_profile_fetch_telemetry rollup (also
-- populated by capture_analysis_v2_profile_fetch_telemetry, and never
-- touched by that cleanup) is the only evidence of the exact per-batch
-- fresh-Apify success/incomplete split that survives, so this migration's
-- eligibility gate reads that rollup instead of the raw checkpoint rows.
--
-- Every provider run this third successor made is terminal (succeeded) and
-- usage-reconciled, every AI attempt is settled, and every media artifact it
-- registered is deleted (terminal cleanup already ran). This migration
-- audits that evidence, preserves all four prior failed
-- request/job/provider-run/media-artifact/profile-fetch ledgers immutably,
-- and admits one more fresh preflight/request generation through the
-- unmodified production creator so the order can retry with a brand-new,
-- zero-adoption provider call and a brand-new, zero-reuse media artifact
-- namespace (media artifact object names are content-addressed under
-- analysis-v2/<request_id>/..., so a fresh request id makes prior media
-- artifacts structurally unreachable -- no adoption path exists or is added
-- for them). Provider-run adoption is deliberately kept at zero for this
-- successor too, exactly like the first three recoveries: the production
-- create_or_replay_earlybird_fulfillment_request creator always resolves
-- the order's *base*-key request (the original job-exhausted request) as
-- the "conflicting" request on every admission, regardless of how many
-- rearm generations exist, so any adoption gate can only ever be evaluated
-- against that base request's own (minimal) dataset -- never against this
-- richer, later-failed successor's own 13 succeeded runs. Safely adopting
-- the later successor's specific runs would require a new, request-scoped
-- adoption path this migration does not add; re-running those provider
-- calls is the smallest change that stays safe and auditable with the
-- existing architecture, at the cost of re-incurring their provider-side
-- cost (the order itself already settled at actual_amount_krw = 0, so there
-- is no customer-facing charge either way).
--
-- This migration must apply only after the generic fix in 20260829110000
-- (owned separately) is already applied; its own timestamp orders it
-- strictly after that migration for that reason.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Every multi-word column below would push Postgres's default
-- "<table>_<column>_fkey/key/check" auto-naming past the 63-byte
-- NAMEDATALEN identifier limit (silently truncated), exactly like every
-- sibling rearm table before it. Every PK/UNIQUE/FK/CHECK constraint is
-- therefore given a short, explicit, unique-per-table name instead.
CREATE TABLE public.earlybird_pfe4_profile_consumer_rearms (
    order_id UUID
        CONSTRAINT pfe4_rearms_pkey PRIMARY KEY,
    pfe_original_failed_request_id UUID NOT NULL,
    pfe2_rejected_successor_request_id UUID NOT NULL,
    pfe3_media_failed_request_id UUID NOT NULL,
    profile_consumer_failed_request_id UUID NOT NULL,
    rearmed_preflight_id UUID NOT NULL,
    prior_attempt_count SMALLINT NOT NULL,
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT pfe4_rearms_order_fk FOREIGN KEY (order_id)
        REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    CONSTRAINT pfe4_rearms_orig_req_fk
        FOREIGN KEY (pfe_original_failed_request_id)
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    CONSTRAINT pfe4_rearms_orig_req_key
        UNIQUE (pfe_original_failed_request_id),
    CONSTRAINT pfe4_rearms_b_req_fk
        FOREIGN KEY (pfe2_rejected_successor_request_id)
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    CONSTRAINT pfe4_rearms_b_req_key
        UNIQUE (pfe2_rejected_successor_request_id),
    CONSTRAINT pfe4_rearms_c_req_fk
        FOREIGN KEY (pfe3_media_failed_request_id)
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    CONSTRAINT pfe4_rearms_c_req_key
        UNIQUE (pfe3_media_failed_request_id),
    CONSTRAINT pfe4_rearms_d_req_fk
        FOREIGN KEY (profile_consumer_failed_request_id)
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    CONSTRAINT pfe4_rearms_d_req_key
        UNIQUE (profile_consumer_failed_request_id),
    CONSTRAINT pfe4_rearms_preflight_fk FOREIGN KEY (rearmed_preflight_id)
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    CONSTRAINT pfe4_rearms_preflight_key UNIQUE (rearmed_preflight_id),
    CONSTRAINT pfe4_rearms_prior_attempt_chk CHECK (
        prior_attempt_count BETWEEN 0 AND 10
    ),
    CONSTRAINT pfe4_rearms_distinct_chk CHECK (
        pfe_original_failed_request_id <> pfe2_rejected_successor_request_id
        AND pfe_original_failed_request_id <> pfe3_media_failed_request_id
        AND pfe_original_failed_request_id <> profile_consumer_failed_request_id
        AND pfe2_rejected_successor_request_id <> pfe3_media_failed_request_id
        AND pfe2_rejected_successor_request_id <> profile_consumer_failed_request_id
        AND pfe3_media_failed_request_id <> profile_consumer_failed_request_id
    )
);

ALTER TABLE public.earlybird_pfe4_profile_consumer_rearms
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_pfe4_profile_consumer_rearms
    FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_pfe4_profile_consumer_rearms
    FROM PUBLIC, anon, authenticated, service_role;

-- Reuse the existing generic append-only guard: this ledger is immutable,
-- exactly like every sibling earlybird recovery/rearm ledger it is modeled
-- on.
CREATE TRIGGER prevent_earlybird_pfe4_consumer_rearm_mutation
BEFORE UPDATE OR DELETE
ON public.earlybird_pfe4_profile_consumer_rearms
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

-- Narrow, reusable witness for one profile-fetch batch's exact settled
-- fresh-Apify telemetry shape, read from the persistent
-- analysis_v2_profile_fetch_telemetry rollup rather than the (by now
-- deleted) raw checkpoint rows. The live sanitized audit for this exact
-- incident shows precisely two rows per (request, job_key), both with a
-- NULL http_status: this witness therefore requires exactly two rows whose
-- outcome_count sums to the requested count, exactly one of them a
-- 'fresh_apify'/'success' row with a NULL failure_category and NULL
-- http_status at the given success count, and exactly one a
-- 'fresh_apify'/'failed' row with failure_category = 'incomplete' and NULL
-- http_status at the requested-minus-success count -- any additional row
-- (a second failed/incomplete row split by http_status, cache/selfhosted/
-- fallback/repair contamination, an 'unavailable' outcome, or any other
-- failure category) already fails the exact-two-rows count. p_requested_
-- count/p_success_count are bounds-checked because this function's own
-- ACL below leaves it uncallable except from inside the rearm function's
-- SECURITY DEFINER body, which only ever passes this incident's own fixed
-- literals. Shared by both batch:5 and batch:7 below to avoid repeating
-- this shape twice.
CREATE FUNCTION public.earlybird_pfe4_profile_fetch_telemetry_settled(
    p_request_id UUID,
    p_job_key TEXT,
    p_requested_count INTEGER,
    p_success_count INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p_requested_count > 0
       AND p_success_count BETWEEN 0 AND p_requested_count
       AND 2 = (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_profile_fetch_telemetry AS telemetry
            WHERE telemetry.request_id = p_request_id
              AND telemetry.job_key = p_job_key
       )
       AND p_requested_count = (
            SELECT pg_catalog.sum(telemetry.outcome_count)
            FROM public.analysis_v2_profile_fetch_telemetry AS telemetry
            WHERE telemetry.request_id = p_request_id
              AND telemetry.job_key = p_job_key
       )
       AND EXISTS (
            SELECT 1
            FROM public.analysis_v2_profile_fetch_telemetry AS telemetry
            WHERE telemetry.request_id = p_request_id
              AND telemetry.job_key = p_job_key
              AND telemetry.source = 'fresh_apify'
              AND telemetry.status = 'success'
              AND telemetry.failure_category IS NULL
              AND telemetry.http_status IS NULL
              AND telemetry.outcome_count = p_success_count
       )
       AND EXISTS (
            SELECT 1
            FROM public.analysis_v2_profile_fetch_telemetry AS telemetry
            WHERE telemetry.request_id = p_request_id
              AND telemetry.job_key = p_job_key
              AND telemetry.source = 'fresh_apify'
              AND telemetry.status = 'failed'
              AND telemetry.failure_category = 'incomplete'
              AND telemetry.http_status IS NULL
              AND telemetry.outcome_count = p_requested_count - p_success_count
       );
$$;

REVOKE ALL ON FUNCTION public.earlybird_pfe4_profile_fetch_telemetry_settled(
    UUID, TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.rearm_earlybird_pfe4_profile_consumer_failure(
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
    v_pfe3_lineage public.earlybird_pfe3_media_artifact_rearms%ROWTYPE;
    v_existing public.earlybird_pfe4_profile_consumer_rearms%ROWTYPE;
    v_selected_card JSONB;
    v_new_preflight_id UUID;
    v_new_preflight_key CONSTANT TEXT := 'earlybird.fulfillment.'
        || pg_catalog.replace(p_order_id::TEXT, '-', '') || '.r3';
BEGIN
    IF p_order_id IS NULL
       OR p_expected_failed_request_id IS NULL
       OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE4_CONSUMER_REARM_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- User-first lock ordering, then fulfillment -> order -> own ledger ->
    -- failed request -> preflight, matching the exact prefix
    -- create_or_replay_earlybird_fulfillment_request itself uses, and
    -- matching every prior recovery's own internal order for the same
    -- reason.
    SELECT earlybird_order.user_id INTO v_user_id
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE4_CONSUMER_REARM_NOT_FOUND',
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
            MESSAGE = 'EARLYBIRD_PFE4_CONSUMER_REARM_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE4_CONSUMER_REARM_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT rearm.* INTO v_existing
    FROM public.earlybird_pfe4_profile_consumer_rearms AS rearm
    WHERE rearm.order_id = p_order_id
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.profile_consumer_failed_request_id
                IS DISTINCT FROM p_expected_failed_request_id
           OR v_existing.expected_manual_review_at
                IS DISTINCT FROM p_expected_manual_review_at THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PFE4_CONSUMER_REARM_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        IF v_order.preflight_id IS DISTINCT FROM v_existing.rearmed_preflight_id
           OR v_order.status <> 'paid'
           OR v_order.result_request_id IS NOT NULL
           OR v_fulfillment.request_id IS NOT NULL
           OR v_fulfillment.status NOT IN ('admission_pending', 'retryable_failure') THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PFE4_CONSUMER_REARM_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            p_order_id,
            v_fulfillment.status,
            v_existing.rearmed_preflight_id,
            v_existing.profile_consumer_failed_request_id;
        RETURN;
    END IF;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_expected_failed_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE4_CONSUMER_REARM_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PFE4_CONSUMER_REARM_SNAPSHOT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    -- Immutable, append-only: read without a lock, it can never change
    -- under us.
    SELECT lineage.* INTO v_pfe3_lineage
    FROM public.earlybird_pfe3_media_artifact_rearms AS lineage
    WHERE lineage.order_id = p_order_id;

    -- The one card the order's own paid plan actually selects, resolved
    -- once up front so both the admission-witness comparison and the
    -- capacity bound below read the exact same value.
    v_selected_card := v_preflight.plan_cards_snapshot -> v_order.plan_id;

    IF v_pfe3_lineage.order_id IS NULL
       OR v_pfe3_lineage.rearmed_preflight_id IS DISTINCT FROM v_preflight.id
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
       -- error_message, exactly like all three prior recoveries.
       OR v_fulfillment.last_error_code IS DISTINCT FROM 'ANALYSIS_FAILED'
       OR v_fulfillment.manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       -- Unlike the looser 1-10 band every prior recovery in this lineage
       -- used, the live audited incident's own fulfillment-level counter is
       -- exactly 1 (this is the *first* manual-review cycle since the
       -- third-stage rearm re-armed the order): pin the gate to that exact
       -- value rather than the wider band.
       OR v_fulfillment.attempt_count IS DISTINCT FROM 1
       OR v_request.id = v_pfe3_lineage.pfe_original_failed_request_id
       OR v_request.id = v_pfe3_lineage.pfe2_rejected_successor_request_id
       OR v_request.id = v_pfe3_lineage.media_failed_request_id
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status <> 'failed'
       OR v_request.current_step IS DISTINCT FROM 'failed'
       OR v_request.error_message IS DISTINCT FROM 'JOB_ATTEMPTS_EXHAUSTED'
       -- Binds this rearm to the exact failed-request generation this
       -- incident audited (the successor the third-stage rearm's own '.r2'
       -- preflight produced), not merely "some failed request the caller
       -- happened to pass": a request from a different lineage or a
       -- differently-numbered generation must never satisfy this gate even
       -- if every other column happened to match.
       OR v_request.idempotency_key IS DISTINCT FROM (
            'earlybird:' || pg_catalog.lower(p_order_id::TEXT) || '.r3'
       )
       OR v_preflight.status <> 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.access_mode <> 'production'
       -- The exact preflight generation the third-stage rearm minted --
       -- byte-for-byte the same key
       -- rearm_earlybird_pfe3_media_artifact_error's own v_new_preflight_key
       -- computed -- not merely "some preflight the lineage row happens to
       -- point at".
       OR v_preflight.idempotency_key IS DISTINCT FROM (
            'earlybird.fulfillment.'
            || pg_catalog.replace(p_order_id::TEXT, '-', '')
            || '.r2'
       )
       OR v_preflight.pii_scrubbed_at IS NULL
       -- Each scrub token is derived from -- and only from -- the id of the
       -- row that carries it, exactly like every prior recovery.
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
       -- allow_v211_policy_replay_capacity_safe_count_drift.sql,
       -- 20260826165211_earlybird_direct_fresh_apify_checkpoint.sql, and
       -- 20260829090000_rearm_earlybird_pfe3_media_artifact_error.sql, all
       -- of which already authorize this exact independently-bounded drift
       -- for other Earlybird admission paths). What must still hold, byte
       -- for byte: the preflight's own fresh-admission witness has not
       -- itself drifted from its current target counts, the admission-time
       -- selected plan matches the plan the order actually paid for, and
       -- the admission-time capacity/required-plan/card witnesses still
       -- match the preflight's current snapshots -- then both the order's
       -- and the preflight's own observations must be non-negative and
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
              AND receipt.failed_job_key = 'track:profile-ai:batch:7'
              AND receipt.error_code = 'JOB_ATTEMPTS_EXHAUSTED'
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS pipeline_job
            WHERE pipeline_job.request_id = v_request.id
              AND pipeline_job.status IN ('pending', 'processing', 'retryable')
       )
       -- attempt_count = 7 matches ANALYSIS_V2_JOB_MAX_ATTEMPTS (see
       -- lib/services/analysis/v2-worker.ts) and the production incident
       -- exactly: the batch job's own attempt budget is fully spent. Its own
       -- analysis_pipeline_jobs_lease_check / _completion_check / _error_
       -- check / _failed_error_check constraints already force a 'failed'
       -- row's lease_token/lease_expires_at to NULL and its
       -- completed_at/last_error_at to NOT NULL, so no separate gate clause
       -- is needed for those; only the exact attempt count is not implied by
       -- any constraint and must be checked explicitly.
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS pipeline_job
            WHERE pipeline_job.request_id = v_request.id
              AND pipeline_job.job_key = 'track:profile-ai:batch:7'
              AND pipeline_job.track = 'profile_ai'
              AND pipeline_job.status = 'failed'
              AND pipeline_job.last_error_code = 'JOB_ATTEMPTS_EXHAUSTED'
              AND pipeline_job.attempt_count = 7
       )
       -- The exact production fact for the sibling in-flight batch: its own
       -- job was still mid-retry (never terminal on its own) when batch 7's
       -- whole-request failure aborted every other in-flight job, so it now
       -- reads 'cancelled' at attempt 6 -- never 'completed' or 'failed' --
       -- a material witness that this is the profile-fetch-consumer defect
       -- and not a wider pipeline outage.
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS pipeline_job
            WHERE pipeline_job.request_id = v_request.id
              AND pipeline_job.job_key = 'track:profile-ai:batch:5'
              AND pipeline_job.track = 'profile_ai'
              AND pipeline_job.status = 'cancelled'
              AND pipeline_job.attempt_count = 6
       )
       -- The exact upstream root cause this incident audited, read from the
       -- persistent telemetry rollup because the raw per-username checkpoint
       -- rows for both profile-fetch batches are already gone: each
       -- completed a direct fresh-Apify fetch with one terminally
       -- unresolved username, which the profile-ai stage's own legacy
       -- candidate-input builder cannot yet consume.
       OR NOT public.earlybird_pfe4_profile_fetch_telemetry_settled(
            v_request.id, 'track:profiles:batch:5', 30, 29
       )
       OR NOT public.earlybird_pfe4_profile_fetch_telemetry_settled(
            v_request.id, 'track:profiles:batch:7', 27, 26
       )
       -- Every provider run this successor made must exist, be fully
       -- succeeded and usage-reconciled, and run on the order's own
       -- retained secondary slot -- exactly like every prior recovery's own
       -- bar. This exact incident's own audited count is 13.
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
       OR 13 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
       )
       -- analysis_v2_ai_attempts is the distinct Gemini AI-attempt ledger --
       -- separate from analysis_v2_provider_runs above, which records only
       -- third-party Instagram scraper calls. Unlike the upstream
       -- profile-fetch checkpoint above, this successor's own AI-attempt
       -- ledger is not where the incident lives: every one of its 309 rows
       -- is already fully settled (a terminal status with a complete usage
       -- record) -- 'reserved' never appears -- matching the production
       -- precheck for this exact incident.
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
       OR 309 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_ai_attempts AS ai_attempt
            WHERE ai_attempt.request_id = v_request.id
       )
       -- analysis_v2_scheduler_operations' sole non-terminal status is
       -- 'claimed' ('ready' and 'terminal_unavailable' are both terminal);
       -- no operation for this successor may still be actively claimed.
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_scheduler_operations AS operation
            WHERE operation.request_id = v_request.id
              AND operation.status = 'claimed'
       )
       -- analysis_revenue_run_ledgers is exclusively a test_entitlement-mode
       -- ledger; a production access_mode='production' earlybird successor
       -- can therefore never have one -- see 20260829090000_rearm_
       -- earlybird_pfe3_media_artifact_error.sql's own identical
       -- "OR EXISTS (... analysis_revenue_run_ledgers ...)" fence. Fail
       -- closed if one is ever found instead of assuming applicability
       -- either way.
       OR EXISTS (
            SELECT 1
            FROM public.analysis_revenue_run_ledgers AS ledger
            WHERE ledger.request_id = v_request.id
       )
       -- A terminally 'failed' request must never have produced a scored
       -- result row either; fail closed if one is ever found instead of
       -- assuming a 'failed' status already guarantees it.
       OR EXISTS (
            SELECT 1
            FROM public.analysis_results AS result
            WHERE result.request_id = v_request.id
       )
       -- Zero adoption: no prior recovery's own resolver wrapper ever let
       -- this successor adopt anything.
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
            WHERE adoption.request_id = v_request.id
       )
       -- Every media artifact this successor registered (including the
       -- exhausted batch's own) must already be deleted -- the mandatory
       -- terminal-cleanup sweep already ran to completion for it. This
       -- exact incident's own audited count is 55. A fresh successor
       -- request gets a disjoint object-name namespace
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
              AND artifact.registration_job_key = 'track:profile-ai:batch:7'
       )
       OR 55 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_media_artifacts AS artifact
            WHERE artifact.request_id = v_request.id
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
            MESSAGE = 'EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE',
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
            MESSAGE = 'EARLYBIRD_PFE4_CONSUMER_REARM_KEY_COLLISION',
            ERRCODE = 'P0001';
    END IF;

    -- The fresh preflight is built only from the paid order's own immutable
    -- target fields and the terminal, scrubbed current (third-stage-rearm)
    -- preflight's immutable admission/pricing/policy snapshots -- never from
    -- the failed successor's working data, and never touching the order's
    -- payment or credential slot columns. order_scoped_apify_credential_slot
    -- is set explicitly here as belt-and-suspenders: the existing
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

    INSERT INTO public.earlybird_pfe4_profile_consumer_rearms(
        order_id, pfe_original_failed_request_id,
        pfe2_rejected_successor_request_id, pfe3_media_failed_request_id,
        profile_consumer_failed_request_id, rearmed_preflight_id,
        prior_attempt_count, expected_manual_review_at
    ) VALUES (
        v_order.id, v_pfe3_lineage.pfe_original_failed_request_id,
        v_pfe3_lineage.pfe2_rejected_successor_request_id,
        v_pfe3_lineage.media_failed_request_id, v_request.id,
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

REVOKE ALL ON FUNCTION public.rearm_earlybird_pfe4_profile_consumer_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_pfe4_profile_consumer_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

-- create_or_replay_earlybird_fulfillment_request always rediscovers this
-- order's original, immutable base-key request (the first-stage recovery's
-- own failed request) as the "conflicting" request on every future
-- admission attempt, and its provider-run-adoption gate does not yet know
-- that a *fourth* rebind preflight for this exact lineage is safe. Rename
-- the current dispatcher and re-front it with a narrow, exact helper, the
-- same way the third-stage rearm itself re-fronted the second-stage
-- dispatcher before it.
ALTER FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) RENAME TO earlybird_provider_run_adoption_ready_pre_pfe4;
REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready_pre_pfe4(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.earlybird_pfe4_consumer_rearm_adoption_ready(
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
    -- earlybird_pfe4_profile_consumer_rearms is immutable, so matching the
    -- order/original-failed-request/rearmed-preflight triple exactly is
    -- sufficient: this lineage never produces a second '.r3'-generation
    -- preflight to drift to.
    SELECT EXISTS (
        SELECT 1
        FROM public.earlybird_pfe4_profile_consumer_rearms AS rearm
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
              || '.r3'
          -- The readiness bar is against the *original* job-exhausted
          -- request's own dataset -- the one create_or_replay always
          -- rediscovers as the conflicting request -- not any of the three
          -- intervening successors, which contributed nothing adoptable
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

REVOKE ALL ON FUNCTION public.earlybird_pfe4_consumer_rearm_adoption_ready(
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
    SELECT public.earlybird_provider_run_adoption_ready_pre_pfe4(
        p_order_id, p_failed_request_id, p_recovery_preflight_id
    )
    OR public.earlybird_pfe4_consumer_rearm_adoption_ready(
        p_order_id, p_failed_request_id, p_recovery_preflight_id
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

-- Guarantee zero adoption of any of the four prior requests' datasets for
-- the final successor this rearm produces. Rename the current resolver (the
-- third-stage rearm's own wrapper) and reinstall its exact original
-- signature as a thin router in front of it: return NULL only for the exact
-- successor request this rearm lineage produced -- forcing a brand-new
-- external call -- and delegate byte-for-byte to the renamed resolver for
-- every other caller.
ALTER FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) RENAME TO resolve_analysis_v2_recovery_provider_run_pre_pfe4;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run_pre_pfe4(
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
    v_rearm public.earlybird_pfe4_profile_consumer_rearms%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
BEGIN
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id;

    SELECT rearm.* INTO v_rearm
    FROM public.earlybird_pfe4_profile_consumer_rearms AS rearm
    WHERE rearm.rearmed_preflight_id = v_request.preflight_id;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = v_rearm.order_id;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_rearm.order_id;

    -- Only the exact successor this rearm lineage produced short-circuits to
    -- NULL: the same order's preflight and result_request_id, the same
    -- order's fulfillment request_id, and -- pinned explicitly rather than
    -- left implicit in the pointer chain above -- this exact request's own
    -- generation identity (idempotency_key '.r4', pipeline v2, and its own
    -- user/preflight linkage matching the order/rearm exactly) must all
    -- still hold. A future request bound onto the same rearmed preflight
    -- through some other path, with a different generation key, must never
    -- receive this bypass.
    IF v_request.id IS NOT NULL
       AND v_rearm.order_id IS NOT NULL
       AND v_order.id IS NOT NULL
       AND v_order.preflight_id = v_rearm.rearmed_preflight_id
       AND v_order.result_request_id = p_request_id
       AND v_fulfillment.order_id IS NOT NULL
       AND v_fulfillment.request_id = p_request_id
       AND v_request.user_id = v_order.user_id
       AND v_request.preflight_id = v_rearm.rearmed_preflight_id
       AND v_request.pipeline_version = 'v2'
       AND v_request.idempotency_key = (
            'earlybird:' || pg_catalog.lower(v_order.id::TEXT) || '.r4'
       )
    THEN
        RETURN NULL;
    END IF;

    RETURN public.resolve_analysis_v2_recovery_provider_run_pre_pfe4(
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
