-- MIGRATION_PREDECESSOR=20260813221946
-- One paid Basic concierge order reached manual review because its immutable
-- checkout/preflight snapshot observed 158/361 while the exact successful
-- generation-3 tertiary fresh-admission witness observed 158/362. Preserve
-- both snapshots. Authorize only this receipt-backed bounded time drift through
-- the existing request creator instead of rewriting either snapshot.
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
                WHERE version = '20260813221946'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE FUNCTION public.earlybird_snapshot_count_drift_within_tolerance(
    p_old_count INTEGER,
    p_new_count INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_old_count >= 0
        AND p_new_count >= 0
        AND pg_catalog.abs(p_new_count - p_old_count) <= 3
        AND (
            p_new_count = p_old_count
            OR (
                p_old_count > 0
                AND pg_catalog.abs(p_new_count - p_old_count)::NUMERIC * 100
                    <= p_old_count::NUMERIC
            )
        ),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.earlybird_snapshot_count_drift_within_tolerance(
    INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.earlybird_concierge_snapshot_conflict_recoveries (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    preflight_id UUID NOT NULL UNIQUE REFERENCES public.analysis_preflights(id)
        ON DELETE RESTRICT,
    provider_operation_key TEXT NOT NULL CHECK (
        provider_operation_key = 'target-profile-fresh-admission:g3'
    ),
    provider_input_hash VARCHAR(64) NOT NULL CHECK (
        provider_input_hash ~ '^[a-f0-9]{64}$'
    ),
    provider_run_id_hash VARCHAR(32) NOT NULL CHECK (
        provider_run_id_hash ~ '^[a-f0-9]{32}$'
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    expected_admission_refreshed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    old_order_followers_count INTEGER NOT NULL CHECK (
        old_order_followers_count = 158
    ),
    old_order_following_count INTEGER NOT NULL CHECK (
        old_order_following_count = 361
    ),
    old_preflight_followers_count INTEGER NOT NULL CHECK (
        old_preflight_followers_count = 158
    ),
    old_preflight_following_count INTEGER NOT NULL CHECK (
        old_preflight_following_count = 361
    ),
    new_witness_followers_count INTEGER NOT NULL CHECK (
        new_witness_followers_count = 158
    ),
    new_witness_following_count INTEGER NOT NULL CHECK (
        new_witness_following_count = 362
    ),
    old_snapshot_recorded_at TIMESTAMP WITH TIME ZONE NOT NULL,
    new_witness_recorded_at TIMESTAMP WITH TIME ZONE NOT NULL,
    recovery_reason TEXT NOT NULL CHECK (
        recovery_reason = 'bounded_time_snapshot_drift'
    ),
    followers_absolute_delta INTEGER NOT NULL CHECK (
        followers_absolute_delta = 0
    ),
    following_absolute_delta INTEGER NOT NULL CHECK (
        following_absolute_delta = 1
    ),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.earlybird_concierge_snapshot_conflict_recoveries
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_concierge_snapshot_conflict_recoveries
    FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_concierge_snapshot_conflict_recoveries
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER prevent_earlybird_concierge_snapshot_conflict_recovery_mutation
BEFORE UPDATE OR DELETE
ON public.earlybird_concierge_snapshot_conflict_recoveries
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE FUNCTION public.earlybird_concierge_snapshot_conflict_receipt_authorized(
    p_order_id UUID,
    p_preflight_id UUID,
    p_order_followers_count INTEGER,
    p_order_following_count INTEGER,
    p_preflight_followers_count INTEGER,
    p_preflight_following_count INTEGER,
    p_admission_followers_count INTEGER,
    p_admission_following_count INTEGER,
    p_admission_generation INTEGER,
    p_admission_refreshed_at TIMESTAMP WITH TIME ZONE
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT COALESCE(
        EXISTS (
            SELECT 1
            FROM public.earlybird_concierge_snapshot_conflict_recoveries
                AS recovery
            WHERE recovery.order_id = p_order_id
              AND recovery.preflight_id = p_preflight_id
              AND recovery.old_order_followers_count = p_order_followers_count
              AND recovery.old_order_following_count = p_order_following_count
              AND recovery.old_preflight_followers_count =
                    p_preflight_followers_count
              AND recovery.old_preflight_following_count =
                    p_preflight_following_count
              AND recovery.new_witness_followers_count =
                    p_admission_followers_count
              AND recovery.new_witness_following_count =
                    p_admission_following_count
              AND p_admission_generation = 3
              AND p_admission_refreshed_at = recovery.new_witness_recorded_at
              AND recovery.recovery_reason = 'bounded_time_snapshot_drift'
              AND EXISTS (
                    SELECT 1
                    FROM public.analysis_preflight_provider_runs AS provider_run
                    WHERE provider_run.preflight_id = p_preflight_id
                      AND provider_run.operation_key = recovery.provider_operation_key
                      AND provider_run.operation_key =
                            'target-profile-fresh-admission:g3'
                      AND provider_run.input_hash = recovery.provider_input_hash
                      AND pg_catalog.md5(provider_run.run_id) =
                            recovery.provider_run_id_hash
                      AND provider_run.status = 'succeeded'
              )
              AND 3 = (
                    SELECT pg_catalog.count(*)::INTEGER
                    FROM public.analysis_preflight_provider_runs AS provider_lineage
                    WHERE provider_lineage.preflight_id = p_preflight_id
                      AND provider_lineage.operation_key IN (
                            'target-profile-fresh-admission:g1',
                            'target-profile-fresh-admission:g2',
                            'target-profile-fresh-admission:g3'
                      )
                      AND provider_lineage.input_hash = recovery.provider_input_hash
                      AND provider_lineage.status = 'succeeded'
                      AND provider_lineage.logical_provider = 'apify'
                      AND provider_lineage.actor_id =
                            'apify/instagram-profile-scraper'
                      AND provider_lineage.credential_slot = 'tertiary'
                      AND provider_lineage.run_id IS NOT NULL
                      AND provider_lineage.terminalized_at IS NOT NULL
                      AND provider_lineage.actual_usage_usd IS NOT NULL
                      AND provider_lineage.usage_reconciled_at IS NOT NULL
                      AND provider_lineage.reusable_profile_schema_version = 1
              )
              AND public.earlybird_snapshot_count_drift_within_tolerance(
                    p_preflight_followers_count,
                    p_admission_followers_count
              )
              AND public.earlybird_snapshot_count_drift_within_tolerance(
                    p_preflight_following_count,
                    p_admission_following_count
              )
        ),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION
    public.earlybird_concierge_snapshot_conflict_receipt_authorized(
        UUID, UUID, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
        INTEGER, TIMESTAMP WITH TIME ZONE
    ) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.earlybird_concierge_snapshot_conflict_counts_authorized(
    p_order_id UUID,
    p_preflight_id UUID,
    p_order_followers_count INTEGER,
    p_order_following_count INTEGER,
    p_preflight_followers_count INTEGER,
    p_preflight_following_count INTEGER,
    p_admission_followers_count INTEGER,
    p_admission_following_count INTEGER,
    p_admission_generation INTEGER,
    p_admission_refreshed_at TIMESTAMP WITH TIME ZONE
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT COALESCE(
        (
            p_admission_followers_count = p_preflight_followers_count
            AND p_admission_following_count = p_preflight_following_count
        )
        OR public.earlybird_concierge_snapshot_conflict_receipt_authorized(
            p_order_id,
            p_preflight_id,
            p_order_followers_count,
            p_order_following_count,
            p_preflight_followers_count,
            p_preflight_following_count,
            p_admission_followers_count,
            p_admission_following_count,
            p_admission_generation,
            p_admission_refreshed_at
        ),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION
    public.earlybird_concierge_snapshot_conflict_counts_authorized(
        UUID, UUID, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
        INTEGER, TIMESTAMP WITH TIME ZONE
    ) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.recover_earlybird_concierge_snapshot_conflict(
    p_order_id UUID,
    p_expected_preflight_id UUID,
    p_expected_manual_review_at TIMESTAMP WITH TIME ZONE,
    p_expected_admission_refreshed_at TIMESTAMP WITH TIME ZONE,
    p_server_target_input_hash TEXT
)
RETURNS TABLE(
    applied BOOLEAN,
    fulfillment_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_user_id_hint UUID;
    v_payment_id_hint TEXT;
    v_incident_count INTEGER;
    v_provider_lineage_count INTEGER;
    v_provider_lineage_input_hash_count INTEGER;
    v_provider_lineage_exact_count INTEGER;
    v_updated INTEGER;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_provider_run public.analysis_preflight_provider_runs%ROWTYPE;
    v_existing public.earlybird_concierge_snapshot_conflict_recoveries%ROWTYPE;
BEGIN
    IF p_order_id IS NULL
       OR p_expected_preflight_id IS NULL
       OR p_expected_manual_review_at IS NULL
       OR p_expected_admission_refreshed_at IS NULL
       OR p_server_target_input_hash IS NULL
       OR p_server_target_input_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Prove this is the only Basic order paid in the incident minute before
    -- resolving its opaque identity. No target or buyer identity is returned.
    SELECT pg_catalog.count(*)::INTEGER INTO v_incident_count
    FROM public.earlybird_orders AS incident_order
    WHERE incident_order.plan_id = 'basic'
      AND incident_order.paid_at >= TIMESTAMPTZ '2026-08-12 18:07:00+09'
      AND incident_order.paid_at < TIMESTAMPTZ '2026-08-12 18:08:00+09';
    IF v_incident_count <> 1 OR NOT EXISTS (
        SELECT 1
        FROM public.earlybird_orders AS incident_order
        WHERE incident_order.id = p_order_id
          AND incident_order.plan_id = 'basic'
          AND incident_order.paid_at >= TIMESTAMPTZ '2026-08-12 18:07:00+09'
          AND incident_order.paid_at < TIMESTAMPTZ '2026-08-12 18:08:00+09'
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.user_id, earlybird_order.payment_id
    INTO v_user_id_hint, v_payment_id_hint
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF v_payment_id_hint IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_payment_id_hint, 0)
    );

    -- Take the fulfillment before the order, matching request creation; the
    -- user key-share prevents deletion without introducing the inverse lock.
    PERFORM 1
    FROM public.users AS recovery_user
    WHERE recovery_user.id = v_user_id_hint
    FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_order.user_id IS DISTINCT FROM v_user_id_hint
       OR v_order.payment_id IS DISTINCT FROM v_payment_id_hint
       OR v_order.preflight_id IS DISTINCT FROM p_expected_preflight_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_preflight.id IS DISTINCT FROM p_expected_preflight_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.* INTO v_provider_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = v_preflight.id
      AND provider_run.operation_key = 'target-profile-fresh-admission:g3'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_WITNESS_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflight_provider_runs AS provider_lineage
    WHERE provider_lineage.preflight_id = v_preflight.id
      AND provider_lineage.operation_key IN (
          'target-profile-fresh-admission:g1',
          'target-profile-fresh-admission:g2',
          'target-profile-fresh-admission:g3'
      )
    ORDER BY provider_lineage.operation_key
    FOR UPDATE;

    SELECT
        pg_catalog.count(*)::INTEGER,
        pg_catalog.count(DISTINCT provider_lineage.input_hash)::INTEGER,
        pg_catalog.count(*) FILTER (WHERE
            provider_lineage.status = 'succeeded'
            AND provider_lineage.logical_provider = 'apify'
            AND provider_lineage.actor_id = 'apify/instagram-profile-scraper'
            AND provider_lineage.credential_slot = 'tertiary'
            AND provider_lineage.run_id IS NOT NULL
            AND provider_lineage.terminalized_at IS NOT NULL
            AND provider_lineage.actual_usage_usd IS NOT NULL
            AND provider_lineage.usage_reconciled_at IS NOT NULL
            AND provider_lineage.reusable_profile_schema_version = 1
        )::INTEGER
    INTO v_provider_lineage_count,
        v_provider_lineage_input_hash_count,
        v_provider_lineage_exact_count
    FROM public.analysis_preflight_provider_runs AS provider_lineage
    WHERE provider_lineage.preflight_id = v_preflight.id
      AND provider_lineage.operation_key IN (
          'target-profile-fresh-admission:g1',
          'target-profile-fresh-admission:g2',
          'target-profile-fresh-admission:g3'
      );

    SELECT recovery.* INTO v_existing
    FROM public.earlybird_concierge_snapshot_conflict_recoveries AS recovery
    WHERE recovery.order_id = v_order.id
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.preflight_id IS DISTINCT FROM p_expected_preflight_id
           OR v_existing.expected_manual_review_at
                IS DISTINCT FROM p_expected_manual_review_at
           OR v_existing.expected_admission_refreshed_at
                IS DISTINCT FROM p_expected_admission_refreshed_at
           OR v_order.preflight_id IS DISTINCT FROM v_existing.preflight_id
           OR v_order.target_followers_count <> 158
           OR v_order.target_following_count <> 361
           OR v_preflight.target_followers_count <> 158
           OR v_preflight.target_following_count <> 361
           OR v_preflight.admission_target_followers_count <> 158
           OR v_preflight.admission_target_following_count <> 362
           OR v_existing.old_snapshot_recorded_at
                IS DISTINCT FROM v_order.created_at
           OR v_existing.new_witness_recorded_at
                IS DISTINCT FROM p_expected_admission_refreshed_at
           OR v_existing.recovery_reason
                IS DISTINCT FROM 'bounded_time_snapshot_drift'
           OR v_provider_run.input_hash IS DISTINCT FROM v_existing.provider_input_hash
           OR v_provider_run.input_hash IS DISTINCT FROM p_server_target_input_hash
           OR v_provider_lineage_count <> 3
           OR v_provider_lineage_input_hash_count <> 1
           OR v_provider_lineage_exact_count <> 3
           OR v_provider_run.logical_provider IS DISTINCT FROM 'apify'
           OR v_provider_run.actor_id
                IS DISTINCT FROM 'apify/instagram-profile-scraper'
           OR v_provider_run.credential_slot IS DISTINCT FROM 'tertiary'
           OR v_provider_run.status IS DISTINCT FROM 'succeeded'
           OR v_provider_run.run_id IS NULL
           OR v_provider_run.terminalized_at IS NULL
           OR v_provider_run.actual_usage_usd IS NULL
           OR v_provider_run.usage_reconciled_at IS NULL
           OR v_provider_run.reusable_profile_schema_version IS DISTINCT FROM 1
           OR v_preflight.admission_generation <> 3
           OR v_preflight.admission_refreshed_at
                IS DISTINCT FROM p_expected_admission_refreshed_at
           OR pg_catalog.md5(v_provider_run.run_id)
                IS DISTINCT FROM v_existing.provider_run_id_hash
           OR v_order.status NOT IN (
                'paid', 'analysis_in_progress', 'completed'
           )
           OR EXISTS (
                SELECT 1
                FROM public.earlybird_webhook_events AS refund_event
                WHERE refund_event.payment_id = v_order.payment_id
                  AND refund_event.event_type = 'payment.refunded'
           )
           OR v_fulfillment.status NOT IN (
                'retryable_failure', 'admission_pending',
                'analysis_in_progress', 'completed'
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_REPLAY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT FALSE, v_fulfillment.status;
        RETURN;
    END IF;

    IF v_fulfillment.manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       OR v_preflight.admission_refreshed_at
            IS DISTINCT FROM p_expected_admission_refreshed_at THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_CAS_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF NOT (
        v_order.status = 'paid'
        AND v_order.plan_id = 'basic'
        AND v_order.pricing_version = 'earlybird-2026-08-v3'
        AND v_order.seller_reference_confirmed_at IS NOT NULL
        AND v_order.payment_id IS NOT NULL
        AND v_order.actual_amount_krw = 990
        AND v_order.expected_amount_krw = 990
        AND v_order.actual_groble_product_id
            IS NOT DISTINCT FROM v_order.expected_groble_product_id
        AND v_order.result_request_id IS NULL
        AND v_order.target_followers_count = 158
        AND v_order.target_following_count = 361
        AND v_order.concierge_apify_credential_slot = 'tertiary'
        AND v_fulfillment.status = 'manual_review'
        AND v_fulfillment.last_error_code = 'SNAPSHOT_CONFLICT'
        AND v_fulfillment.request_id IS NULL
        AND v_fulfillment.lease_token IS NULL
        AND v_fulfillment.lease_expires_at IS NULL
        AND v_fulfillment.operator_admitted_at IS NOT NULL
        AND v_fulfillment.attempt_count = 1
        AND v_preflight.user_id IS NOT DISTINCT FROM v_order.user_id
        AND v_preflight.id IS NOT DISTINCT FROM p_expected_preflight_id
        AND v_preflight.target_instagram_id
            IS NOT DISTINCT FROM v_order.target_instagram_id
        AND pg_catalog.lower(pg_catalog.btrim(v_preflight.target_instagram_id))
            IS NOT DISTINCT FROM
                pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
        AND v_preflight.exclusion_decision
            IS NOT DISTINCT FROM v_order.exclusion_decision
        AND v_preflight.excluded_instagram_id
            IS NOT DISTINCT FROM v_order.excluded_instagram_id
        AND v_preflight.status = 'ready'
        AND v_preflight.access_mode = 'production'
        AND v_preflight.consumed_request_id IS NULL
        AND v_preflight.target_followers_count = 158
        AND v_preflight.target_following_count = 361
        AND v_preflight.target_is_private IS NOT DISTINCT FROM FALSE
        AND v_preflight.admission_status = 'ready'
        AND v_preflight.admission_generation = 3
        AND v_preflight.admission_selected_plan_id = 'basic'
        AND v_preflight.admission_target_followers_count = 158
        AND v_preflight.admission_target_following_count = 362
        AND v_preflight.admission_capacity_required_plan_id = 'basic'
        AND v_preflight.admission_required_plan_id = 'basic'
        AND v_preflight.admission_plan_cards_snapshot
            IS NOT DISTINCT FROM v_preflight.plan_cards_snapshot
        AND v_preflight.order_scoped_apify_credential_slot = 'tertiary'
        AND public.earlybird_snapshot_count_drift_within_tolerance(
            v_preflight.target_followers_count,
            v_preflight.admission_target_followers_count
        )
        AND public.earlybird_snapshot_count_drift_within_tolerance(
            v_preflight.target_following_count,
            v_preflight.admission_target_following_count
        )
        AND public.analysis_v2_valid_launch_snapshot(
            v_preflight.launch_status_snapshot
        )
        AND public.analysis_v2_valid_plan_catalog_snapshot(
            v_preflight.plan_catalog_snapshot
        )
        AND public.analysis_v2_valid_plan_cards_snapshot(
            v_preflight.plan_cards_snapshot
        )
        AND public.analysis_v2_valid_pricing_snapshot(
            v_preflight.pricing_snapshot
        )
        AND public.analysis_v2_valid_policy_versions_snapshot(
            v_preflight.policy_versions_snapshot
        )
        AND v_preflight.plan_cards_snapshot
            -> 'basic' ->> 'launchStatus' = 'production'
        AND v_preflight.plan_cards_snapshot
            -> 'basic' ->> 'selectionState' IN ('required', 'available_upgrade')
        AND COALESCE(
            v_preflight.plan_cards_snapshot
                -> 'basic' -> 'relationshipCapacity' ->> 'followers', ''
        ) ~ '^[0-9]+$'
        AND COALESCE(
            v_preflight.plan_cards_snapshot
                -> 'basic' -> 'relationshipCapacity' ->> 'following', ''
        ) ~ '^[0-9]+$'
        AND 158 <= (
            v_preflight.plan_cards_snapshot
                -> 'basic' -> 'relationshipCapacity' ->> 'followers'
        )::INTEGER
        AND 362 <= (
            v_preflight.plan_cards_snapshot
                -> 'basic' -> 'relationshipCapacity' ->> 'following'
        )::INTEGER
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.earlybird_webhook_events AS refund_event
        WHERE refund_event.payment_id = v_order.payment_id
          AND refund_event.event_type = 'payment.refunded'
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_REFUNDED',
            ERRCODE = 'P0001';
    END IF;

    IF NOT (
        v_provider_lineage_count = 3
        AND v_provider_lineage_input_hash_count = 1
        AND v_provider_lineage_exact_count = 3
        AND v_provider_run.input_hash = p_server_target_input_hash
        AND
        v_provider_run.operation_key = 'target-profile-fresh-admission:g3'
        AND v_provider_run.input_hash ~ '^[a-f0-9]{64}$'
        AND v_provider_run.logical_provider = 'apify'
        AND v_provider_run.actor_id = 'apify/instagram-profile-scraper'
        AND v_provider_run.credential_slot = 'tertiary'
        AND v_provider_run.status = 'succeeded'
        AND v_provider_run.run_id IS NOT NULL
        AND v_provider_run.reserved_at >= v_preflight.admission_requested_at
        AND v_provider_run.run_started_at >= v_preflight.admission_requested_at
        AND v_provider_run.terminalized_at IS NOT NULL
        AND v_provider_run.terminalized_at
            <= v_preflight.admission_refreshed_at
        AND v_provider_run.actual_usage_usd IS NOT NULL
        AND v_provider_run.usage_reconciled_at IS NOT NULL
        AND v_provider_run.reusable_profile_schema_version = 1
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_WITNESS_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_requests AS prior_request
        WHERE prior_request.preflight_id = v_preflight.id
    ) OR EXISTS (
        SELECT 1
        FROM public.analysis_requests AS active_request
        WHERE active_request.user_id = v_order.user_id
          AND active_request.status IN ('pending', 'processing')
    ) OR EXISTS (
        SELECT 1
        FROM public.analysis_preflights AS active_preflight
        WHERE active_preflight.user_id = v_order.user_id
          AND active_preflight.id <> v_preflight.id
          AND active_preflight.status IN ('pending', 'processing', 'ready')
    ) OR EXISTS (
        SELECT 1
        FROM public.earlybird_orders AS other_order
        WHERE other_order.user_id = v_order.user_id
          AND other_order.id <> v_order.id
          AND other_order.status IN ('paid', 'analysis_in_progress')
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_UNRELATED_WORK',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'retryable_failure',
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = v_now,
        last_error_code = 'CONCIERGE_SNAPSHOT_CONFLICT_RECOVERY',
        last_error_at = v_now,
        manual_review_at = NULL,
        updated_at = v_now
    WHERE fulfillment.order_id = v_order.id
      AND fulfillment.status = 'manual_review'
      AND fulfillment.last_error_code = 'SNAPSHOT_CONFLICT'
      AND fulfillment.request_id IS NULL
      AND fulfillment.manual_review_at
            IS NOT DISTINCT FROM p_expected_manual_review_at;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_CAS_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.earlybird_concierge_snapshot_conflict_recoveries(
        order_id, preflight_id, provider_operation_key, provider_input_hash,
        provider_run_id_hash, expected_manual_review_at,
        expected_admission_refreshed_at, old_order_followers_count,
        old_order_following_count, old_preflight_followers_count,
        old_preflight_following_count, new_witness_followers_count,
        new_witness_following_count, old_snapshot_recorded_at,
        new_witness_recorded_at, recovery_reason, followers_absolute_delta,
        following_absolute_delta
    ) VALUES (
        v_order.id, v_preflight.id, v_provider_run.operation_key,
        v_provider_run.input_hash, pg_catalog.md5(v_provider_run.run_id),
        p_expected_manual_review_at, p_expected_admission_refreshed_at,
        158, 361, 158, 361, 158, 362, v_order.created_at,
        p_expected_admission_refreshed_at,
        'bounded_time_snapshot_drift', 0, 1
    );

    RETURN QUERY SELECT TRUE, 'retryable_failure'::TEXT;
END;
$$;

DO $request_snapshot_guard_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.create_or_replay_earlybird_fulfillment_request(uuid,uuid,bigint)';
    v_definition TEXT;
    v_rewritten TEXT;
    v_old_guard CONSTANT TEXT := $old$       OR v_preflight.admission_target_followers_count IS DISTINCT FROM v_preflight.target_followers_count
       OR v_preflight.admission_target_following_count IS DISTINCT FROM v_preflight.target_following_count$old$;
    v_new_guard CONSTANT TEXT := $new$       OR NOT public.earlybird_concierge_snapshot_conflict_counts_authorized(
            v_order.id,
            v_preflight.id,
            v_order.target_followers_count,
            v_order.target_following_count,
            v_preflight.target_followers_count,
            v_preflight.target_following_count,
            v_preflight.admission_target_followers_count,
            v_preflight.admission_target_following_count,
            v_preflight.admission_generation,
            v_preflight.admission_refreshed_at
       )$new$;
    v_old_freshness_guard CONSTANT TEXT := $old$    IF v_preflight.admission_refreshed_at IS NOT NULL AND v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes' THEN$old$;
    v_new_freshness_guard CONSTANT TEXT := $new$    IF v_preflight.admission_refreshed_at IS NOT NULL
       AND v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes'
       AND NOT public.earlybird_concierge_snapshot_conflict_receipt_authorized(
            v_order.id,
            v_preflight.id,
            v_order.target_followers_count,
            v_order.target_following_count,
            v_preflight.target_followers_count,
            v_preflight.target_following_count,
            v_preflight.admission_target_followers_count,
            v_preflight.admission_target_following_count,
            v_preflight.admission_generation,
            v_preflight.admission_refreshed_at
       ) THEN$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF (
        pg_catalog.char_length(v_definition)
        - pg_catalog.char_length(pg_catalog.replace(
            v_definition, v_old_guard, ''
        ))
    ) <> pg_catalog.char_length(v_old_guard)
       OR (
            pg_catalog.char_length(v_definition)
            - pg_catalog.char_length(pg_catalog.replace(
                v_definition, v_old_freshness_guard, ''
            ))
       ) <> pg_catalog.char_length(v_old_freshness_guard)
       OR pg_catalog.strpos(
            v_definition,
            'earlybird_concierge_snapshot_conflict_counts_authorized'
       ) <> 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_REQUEST_SHAPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_rewritten := pg_catalog.replace(
        v_definition, v_old_guard, v_new_guard
    );
    v_rewritten := pg_catalog.replace(
        v_rewritten, v_old_freshness_guard, v_new_freshness_guard
    );
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(v_rewritten, v_old_guard) <> 0
       OR pg_catalog.strpos(v_rewritten, v_old_freshness_guard) <> 0
       OR pg_catalog.strpos(
            v_rewritten,
            'earlybird_concierge_snapshot_conflict_counts_authorized'
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_REQUEST_REWRITE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$request_snapshot_guard_patch$;

DO $claim_snapshot_guard_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.claim_earlybird_fulfillment(uuid,uuid,integer)';
    v_definition TEXT;
    v_rewritten TEXT;
    v_old_freshness_guard CONSTANT TEXT := $old$       OR v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes'$old$;
    v_new_freshness_guard CONSTANT TEXT := $new$       OR (
            v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes'
            AND NOT public.earlybird_concierge_snapshot_conflict_receipt_authorized(
                v_order.id,
                v_preflight.id,
                v_order.target_followers_count,
                v_order.target_following_count,
                v_preflight.target_followers_count,
                v_preflight.target_following_count,
                v_preflight.admission_target_followers_count,
                v_preflight.admission_target_following_count,
                v_preflight.admission_generation,
                v_preflight.admission_refreshed_at
            )
       )$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF (
        pg_catalog.char_length(v_definition)
        - pg_catalog.char_length(pg_catalog.replace(
            v_definition, v_old_freshness_guard, ''
        ))
    ) <> pg_catalog.char_length(v_old_freshness_guard)
       OR pg_catalog.strpos(
            v_definition,
            'earlybird_concierge_snapshot_conflict_receipt_authorized'
       ) <> 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_CLAIM_SHAPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    v_rewritten := pg_catalog.replace(
        v_definition, v_old_freshness_guard, v_new_freshness_guard
    );
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(v_rewritten, v_old_freshness_guard) <> 0
       OR pg_catalog.strpos(
            v_rewritten,
            'earlybird_concierge_snapshot_conflict_receipt_authorized'
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_CLAIM_REWRITE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$claim_snapshot_guard_patch$;

CREATE FUNCTION public.inspect_earlybird_concierge_snapshot_recovery_execution(
    p_order_id UUID,
    p_preflight_id UUID,
    p_expected_manual_review_at TIMESTAMP WITH TIME ZONE,
    p_expected_admission_refreshed_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(
    recovered BOOLEAN,
    request_id UUID,
    request_status TEXT,
    fulfillment_status TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_recovery public.earlybird_concierge_snapshot_conflict_recoveries%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
BEGIN
    IF p_order_id IS NULL
       OR p_preflight_id IS NULL
       OR p_expected_manual_review_at IS NULL
       OR p_expected_admission_refreshed_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_EXECUTION_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id;
    IF v_order.id IS NULL
       OR v_fulfillment.order_id IS NULL
       OR v_preflight.id IS NULL
       OR v_order.preflight_id IS DISTINCT FROM v_preflight.id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_EXECUTION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    SELECT recovery.* INTO v_recovery
    FROM public.earlybird_concierge_snapshot_conflict_recoveries AS recovery
    WHERE recovery.order_id = v_order.id
      AND recovery.preflight_id = v_preflight.id;
    IF NOT FOUND THEN
        RETURN QUERY SELECT
            FALSE, NULL::UUID, NULL::TEXT, v_fulfillment.status::TEXT;
        RETURN;
    END IF;
    IF v_recovery.expected_manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       OR v_recovery.expected_admission_refreshed_at
            IS DISTINCT FROM p_expected_admission_refreshed_at
       OR NOT public.earlybird_concierge_snapshot_conflict_receipt_authorized(
            v_order.id,
            v_preflight.id,
            v_order.target_followers_count,
            v_order.target_following_count,
            v_preflight.target_followers_count,
            v_preflight.target_following_count,
            v_preflight.admission_target_followers_count,
            v_preflight.admission_target_following_count,
            v_preflight.admission_generation,
            v_preflight.admission_refreshed_at
       )
       OR EXISTS (
            SELECT 1
            FROM public.earlybird_webhook_events AS refund_event
            WHERE refund_event.payment_id = v_order.payment_id
              AND refund_event.event_type = 'payment.refunded'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_EXECUTION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_order.result_request_id IS NULL THEN
        IF v_order.status IS DISTINCT FROM 'paid'
           OR v_fulfillment.status IS DISTINCT FROM 'retryable_failure'
           OR v_fulfillment.request_id IS NOT NULL
           OR v_preflight.consumed_request_id IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'CONCIERGE_SNAPSHOT_EXECUTION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            TRUE, NULL::UUID, NULL::TEXT, v_fulfillment.status::TEXT;
        RETURN;
    END IF;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = v_order.result_request_id;
    IF v_request.id IS NULL
       OR v_order.status NOT IN ('analysis_in_progress', 'completed')
       OR v_fulfillment.status NOT IN ('analysis_in_progress', 'completed')
       OR v_fulfillment.request_id IS DISTINCT FROM v_request.id
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing', 'completed')
       OR (
            v_request.status = 'completed'
            AND (
                v_order.status NOT IN ('analysis_in_progress', 'completed')
                OR v_fulfillment.status NOT IN (
                    'analysis_in_progress', 'completed'
                )
            )
       )
       OR (
            v_request.status <> 'completed'
            AND (
                v_order.status <> 'analysis_in_progress'
                OR v_fulfillment.status <> 'analysis_in_progress'
            )
       )
       OR (
            (v_order.status = 'completed')
                IS DISTINCT FROM (v_fulfillment.status = 'completed')
       )
       OR (v_request.status = 'completed' AND EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS active_job
            WHERE active_job.request_id = v_request.id
              AND active_job.status IN ('pending', 'processing')
       )) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_EXECUTION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT
        TRUE, v_request.id, v_request.status::TEXT, v_fulfillment.status::TEXT;
END;
$$;

CREATE FUNCTION public.create_earlybird_concierge_snapshot_recovery_request(
    p_order_id UUID,
    p_preflight_id UUID,
    p_lease_token UUID
)
RETURNS TABLE(
    order_id UUID,
    fulfillment_status TEXT,
    request_id UUID,
    created BOOLEAN,
    initial_job_key TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_payment_id_hint TEXT;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_claim RECORD;
    v_created RECORD;
BEGIN
    IF p_order_id IS NULL OR p_preflight_id IS NULL OR p_lease_token IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_REQUEST_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT earlybird_order.payment_id INTO v_payment_id_hint
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND OR v_payment_id_hint IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_REQUEST_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_payment_id_hint, 0)
    );
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF v_fulfillment.order_id IS NULL
       OR v_order.id IS NULL
       OR v_preflight.id IS NULL
       OR v_order.payment_id IS DISTINCT FROM v_payment_id_hint
       OR v_order.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_order.status IS DISTINCT FROM 'paid'
       OR v_order.result_request_id IS NOT NULL
       OR v_fulfillment.status IS DISTINCT FROM 'retryable_failure'
       OR v_fulfillment.request_id IS NOT NULL
       OR v_fulfillment.lease_token IS NOT NULL
       OR v_fulfillment.lease_expires_at IS NOT NULL
       OR v_preflight.consumed_request_id IS NOT NULL
       OR NOT public.earlybird_concierge_snapshot_conflict_receipt_authorized(
            v_order.id,
            v_preflight.id,
            v_order.target_followers_count,
            v_order.target_following_count,
            v_preflight.target_followers_count,
            v_preflight.target_following_count,
            v_preflight.admission_target_followers_count,
            v_preflight.admission_target_following_count,
            v_preflight.admission_generation,
            v_preflight.admission_refreshed_at
       )
       OR EXISTS (
            SELECT 1
            FROM public.earlybird_webhook_events AS refund_event
            WHERE refund_event.payment_id = v_order.payment_id
              AND refund_event.event_type = 'payment.refunded'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_REQUEST_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_claim
    FROM public.claim_earlybird_fulfillment(
        p_order_id, p_lease_token, 300
    );
    IF v_claim.claimed IS DISTINCT FROM TRUE
       OR v_claim.fulfillment_status IS DISTINCT FROM 'admission_pending'
       OR v_claim.lease_token IS DISTINCT FROM p_lease_token
       OR v_claim.lease_fence IS NULL
       OR v_claim.lease_fence < 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_REQUEST_CLAIM_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_created
    FROM public.create_or_replay_earlybird_fulfillment_request(
        p_order_id, p_lease_token, v_claim.lease_fence
    );
    IF v_created.order_id IS DISTINCT FROM p_order_id
       OR v_created.fulfillment_status IS DISTINCT FROM 'analysis_in_progress'
       OR v_created.request_id IS NULL
       OR v_created.initial_job_key IS DISTINCT FROM 'coordinator:bootstrap' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_REQUEST_CREATION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT
        v_created.order_id,
        v_created.fulfillment_status::TEXT,
        v_created.request_id,
        v_created.created,
        v_created.initial_job_key::TEXT;
END;
$$;

CREATE FUNCTION public.mark_earlybird_concierge_snapshot_recovery_job_local(
    p_order_id UUID,
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_payment_id_hint TEXT;
    v_task_name TEXT;
    v_recovery public.earlybird_concierge_snapshot_conflict_recoveries%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_order_id IS NULL
       OR p_request_id IS NULL
       OR p_dispatch_token IS NULL
       OR p_dispatch_generation IS NULL
       OR p_dispatch_generation NOT BETWEEN 1 AND 1000
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_LOCAL_JOB_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.payment_id INTO v_payment_id_hint
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND OR v_payment_id_hint IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_LOCAL_JOB_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_payment_id_hint, 0)
    );

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    SELECT recovery.* INTO v_recovery
    FROM public.earlybird_concierge_snapshot_conflict_recoveries AS recovery
    WHERE recovery.order_id = p_order_id
      AND recovery.preflight_id = v_preflight.id
    FOR UPDATE;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;

    IF v_fulfillment.order_id IS NULL
       OR v_order.id IS NULL
       OR v_preflight.id IS NULL
       OR v_recovery.order_id IS NULL
       OR v_request.id IS NULL
       OR v_job.request_id IS NULL
       OR v_order.payment_id IS DISTINCT FROM v_payment_id_hint
       OR v_order.status IS DISTINCT FROM 'analysis_in_progress'
       OR v_order.result_request_id IS DISTINCT FROM p_request_id
       OR v_order.preflight_id IS DISTINCT FROM v_recovery.preflight_id
       OR v_fulfillment.status IS DISTINCT FROM 'analysis_in_progress'
       OR v_fulfillment.request_id IS DISTINCT FROM p_request_id
       OR v_preflight.consumed_request_id IS DISTINCT FROM p_request_id
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR NOT public.earlybird_concierge_snapshot_conflict_receipt_authorized(
            v_order.id,
            v_preflight.id,
            v_order.target_followers_count,
            v_order.target_following_count,
            v_preflight.target_followers_count,
            v_preflight.target_following_count,
            v_preflight.admission_target_followers_count,
            v_preflight.admission_target_following_count,
            v_preflight.admission_generation,
            v_preflight.admission_refreshed_at
       )
       OR EXISTS (
            SELECT 1
            FROM public.earlybird_webhook_events AS refund_event
            WHERE refund_event.payment_id = v_order.payment_id
              AND refund_event.event_type = 'payment.refunded'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_LOCAL_JOB_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_task_name := 'manual-local/concierge-snapshot-conflict/'
        || pg_catalog.md5(p_request_id::TEXT || pg_catalog.chr(10) || p_job_key)
        || '/g' || p_dispatch_generation::TEXT;
    IF v_job.status = 'pending'
       AND v_job.dispatch_state = 'reserved'
       AND v_job.dispatch_generation = p_dispatch_generation
       AND v_job.dispatch_reservation_token = p_dispatch_token THEN
        UPDATE public.analysis_pipeline_jobs AS job
        SET dispatch_state = 'enqueued',
            dispatched_at = v_now,
            dispatch_task_name = v_task_name,
            updated_at = v_now
        WHERE job.request_id = p_request_id
          AND job.job_key = p_job_key;
        RETURN TRUE;
    END IF;
    IF v_job.status IN ('pending', 'processing')
       AND v_job.dispatch_state IN ('enqueued', 'delivered')
       AND v_job.dispatch_generation = p_dispatch_generation
       AND v_job.dispatch_reservation_token = p_dispatch_token
       AND v_job.dispatch_task_name = v_task_name THEN
        RETURN FALSE;
    END IF;
    RAISE EXCEPTION USING
        MESSAGE = 'CONCIERGE_SNAPSHOT_LOCAL_JOB_CAS_MISMATCH',
        ERRCODE = 'P0001';
END;
$$;

CREATE FUNCTION public.complete_earlybird_concierge_snapshot_recovery(
    p_order_id UUID,
    p_preflight_id UUID,
    p_request_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_payment_id_hint TEXT;
    v_recovery public.earlybird_concierge_snapshot_conflict_recoveries%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
BEGIN
    IF p_order_id IS NULL OR p_preflight_id IS NULL OR p_request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_COMPLETION_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT earlybird_order.payment_id INTO v_payment_id_hint
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND OR v_payment_id_hint IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_COMPLETION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_payment_id_hint, 0)
    );
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    SELECT recovery.* INTO v_recovery
    FROM public.earlybird_concierge_snapshot_conflict_recoveries AS recovery
    WHERE recovery.order_id = p_order_id
      AND recovery.preflight_id = p_preflight_id
    FOR UPDATE;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF v_fulfillment.order_id IS NULL
       OR v_order.id IS NULL
       OR v_preflight.id IS NULL
       OR v_recovery.order_id IS NULL
       OR v_request.id IS NULL
       OR v_order.payment_id IS DISTINCT FROM v_payment_id_hint
       OR v_order.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_order.result_request_id IS DISTINCT FROM v_request.id
       OR v_fulfillment.request_id IS DISTINCT FROM v_request.id
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status IS DISTINCT FROM 'completed'
       OR EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS active_job
            WHERE active_job.request_id = v_request.id
              AND active_job.status IN ('pending', 'processing')
       )
       OR NOT public.earlybird_concierge_snapshot_conflict_receipt_authorized(
            v_order.id,
            v_preflight.id,
            v_order.target_followers_count,
            v_order.target_following_count,
            v_preflight.target_followers_count,
            v_preflight.target_following_count,
            v_preflight.admission_target_followers_count,
            v_preflight.admission_target_following_count,
            v_preflight.admission_generation,
            v_preflight.admission_refreshed_at
       )
       OR EXISTS (
            SELECT 1
            FROM public.earlybird_webhook_events AS refund_event
            WHERE refund_event.payment_id = v_order.payment_id
              AND refund_event.event_type = 'payment.refunded'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_COMPLETION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_order.status = 'completed'
       AND v_fulfillment.status = 'completed' THEN
        RETURN FALSE;
    END IF;
    IF v_order.status IS DISTINCT FROM 'analysis_in_progress'
       OR v_fulfillment.status IS DISTINCT FROM 'analysis_in_progress' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_COMPLETION_CAS_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'completed',
        completed_at = v_now,
        updated_at = v_now
    WHERE fulfillment.order_id = v_order.id
      AND fulfillment.status = 'analysis_in_progress'
      AND fulfillment.request_id = v_request.id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_COMPLETION_CAS_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    UPDATE public.earlybird_orders AS earlybird_order
    SET status = 'completed',
        updated_at = v_now
    WHERE earlybird_order.id = v_order.id
      AND earlybird_order.status = 'analysis_in_progress'
      AND earlybird_order.result_request_id = v_request.id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_COMPLETION_CAS_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_analysis_v2_dispatchable_jobs(
    p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(
    request_id UUID,
    job_key TEXT,
    job_status TEXT,
    dispatch_state TEXT,
    dispatch_generation INTEGER,
    reservation_token UUID,
    dispatch_reserved_at TIMESTAMP WITH TIME ZONE,
    dispatched_at TIMESTAMP WITH TIME ZONE,
    task_name TEXT,
    lease_expires_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_JOB_SCAN_INPUT',
            ERRCODE = 'P0001';
    END IF;
    RETURN QUERY
    SELECT
        job.request_id,
        job.job_key::TEXT,
        job.status::TEXT,
        job.dispatch_state::TEXT,
        job.dispatch_generation,
        job.dispatch_reservation_token,
        job.dispatch_reserved_at,
        job.dispatched_at,
        job.dispatch_task_name::TEXT,
        job.lease_expires_at
    FROM public.analysis_pipeline_jobs AS job
    JOIN public.analysis_requests AS analysis_request
      ON analysis_request.id = job.request_id
    WHERE analysis_request.pipeline_version = 'v2'
      AND analysis_request.status IN ('pending', 'processing')
      AND job.status IN ('pending', 'processing')
      AND job.recovery_not_before <= pg_catalog.clock_timestamp()
      AND (
            job.scheduler_not_before_at IS NULL
            OR job.scheduler_not_before_at <= pg_catalog.clock_timestamp()
      )
      AND NOT EXISTS (
            SELECT 1
            FROM public.earlybird_concierge_snapshot_conflict_recoveries
                AS recovery
            JOIN public.earlybird_orders AS local_order
              ON local_order.id = recovery.order_id
             AND local_order.preflight_id = recovery.preflight_id
            JOIN public.earlybird_fulfillments AS local_fulfillment
              ON local_fulfillment.order_id = local_order.id
            JOIN public.analysis_preflights AS local_preflight
              ON local_preflight.id = recovery.preflight_id
            WHERE local_order.result_request_id = job.request_id
              AND local_fulfillment.request_id = job.request_id
              AND local_preflight.consumed_request_id = job.request_id
              AND public.earlybird_concierge_snapshot_conflict_receipt_authorized(
                    local_order.id,
                    local_preflight.id,
                    local_order.target_followers_count,
                    local_order.target_following_count,
                    local_preflight.target_followers_count,
                    local_preflight.target_following_count,
                    local_preflight.admission_target_followers_count,
                    local_preflight.admission_target_following_count,
                    local_preflight.admission_generation,
                    local_preflight.admission_refreshed_at
              )
      )
    ORDER BY job.recovery_not_before, job.request_id, job.job_key
    LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    UUID, UUID, BIGINT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    UUID, UUID, BIGINT
) TO service_role;

REVOKE ALL ON FUNCTION public.recover_earlybird_concierge_snapshot_conflict(
    UUID, UUID, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_earlybird_concierge_snapshot_conflict(
    UUID, UUID, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, TEXT
) TO service_role;
REVOKE ALL ON FUNCTION public.mark_earlybird_concierge_snapshot_recovery_job_local(
    UUID, UUID, TEXT, INTEGER, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_earlybird_concierge_snapshot_recovery_job_local(
    UUID, UUID, TEXT, INTEGER, UUID
) TO service_role;
REVOKE ALL ON FUNCTION public.inspect_earlybird_concierge_snapshot_recovery_execution(
    UUID, UUID, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inspect_earlybird_concierge_snapshot_recovery_execution(
    UUID, UUID, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) TO service_role;
REVOKE ALL ON FUNCTION public.create_earlybird_concierge_snapshot_recovery_request(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_earlybird_concierge_snapshot_recovery_request(
    UUID, UUID, UUID
) TO service_role;
REVOKE ALL ON FUNCTION public.complete_earlybird_concierge_snapshot_recovery(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_earlybird_concierge_snapshot_recovery(
    UUID, UUID, UUID
) TO service_role;
REVOKE ALL ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER)
    TO service_role;
COMMENT ON FUNCTION public.mark_earlybird_concierge_snapshot_recovery_job_local(
    UUID, UUID, TEXT, INTEGER, UUID
) IS 'Marks one exact receipt-bound request job for incident-scoped local execution without creating shared Cloud Tasks work.';

COMMENT ON FUNCTION public.recover_earlybird_concierge_snapshot_conflict(
    UUID, UUID, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, TEXT
) IS 'One-order concierge recovery for the unique paid Basic 2026-08-12 18:07 KST 158/361 to tertiary 158/362 snapshot conflict.';

DO $final_guard$
DECLARE
    v_request_signature CONSTANT TEXT :=
        'public.create_or_replay_earlybird_fulfillment_request(uuid,uuid,bigint)';
    v_recovery_signature CONSTANT TEXT :=
        'public.recover_earlybird_concierge_snapshot_conflict('
        || 'uuid,uuid,timestamp with time zone,timestamp with time zone,text)';
    v_count_signature CONSTANT TEXT :=
        'public.earlybird_snapshot_count_drift_within_tolerance(integer,integer)';
    v_authorization_signature CONSTANT TEXT :=
        'public.earlybird_concierge_snapshot_conflict_counts_authorized('
        || 'uuid,uuid,integer,integer,integer,integer,integer,integer,'
        || 'integer,timestamp with time zone)';
    v_receipt_signature CONSTANT TEXT :=
        'public.earlybird_concierge_snapshot_conflict_receipt_authorized('
        || 'uuid,uuid,integer,integer,integer,integer,integer,integer,'
        || 'integer,timestamp with time zone)';
    v_local_job_signature CONSTANT TEXT :=
        'public.mark_earlybird_concierge_snapshot_recovery_job_local('
        || 'uuid,uuid,text,integer,uuid)';
    v_inspect_signature CONSTANT TEXT :=
        'public.inspect_earlybird_concierge_snapshot_recovery_execution('
        || 'uuid,uuid,timestamp with time zone,timestamp with time zone)';
    v_complete_signature CONSTANT TEXT :=
        'public.complete_earlybird_concierge_snapshot_recovery(uuid,uuid,uuid)';
    v_create_signature CONSTANT TEXT :=
        'public.create_earlybird_concierge_snapshot_recovery_request('
        || 'uuid,uuid,uuid)';
    v_claim_signature CONSTANT TEXT :=
        'public.claim_earlybird_fulfillment(uuid,uuid,integer)';
    v_dispatchable_signature CONSTANT TEXT :=
        'public.list_analysis_v2_dispatchable_jobs(integer)';
    v_request_definition TEXT;
    v_claim_definition TEXT;
    v_dispatchable_definition TEXT;
BEGIN
    v_request_definition := pg_catalog.pg_get_functiondef(
        v_request_signature::pg_catalog.regprocedure
    );
    v_claim_definition := pg_catalog.pg_get_functiondef(
        v_claim_signature::pg_catalog.regprocedure
    );
    v_dispatchable_definition := pg_catalog.pg_get_functiondef(
        v_dispatchable_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.strpos(
            v_request_definition,
            'earlybird_concierge_snapshot_conflict_counts_authorized'
       ) = 0
       OR pg_catalog.has_function_privilege(
            'anon', v_request_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'authenticated', v_request_signature, 'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege(
            'service_role', v_request_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'anon', v_recovery_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'authenticated', v_recovery_signature, 'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege(
            'service_role', v_recovery_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'anon', v_local_job_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'authenticated', v_local_job_signature, 'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege(
            'service_role', v_local_job_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'anon', v_inspect_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'authenticated', v_inspect_signature, 'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege(
            'service_role', v_inspect_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'anon', v_complete_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'authenticated', v_complete_signature, 'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege(
            'service_role', v_complete_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'anon', v_create_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'authenticated', v_create_signature, 'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege(
            'service_role', v_create_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'service_role', v_count_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'service_role', v_authorization_signature, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
            'service_role', v_receipt_signature, 'EXECUTE'
       )
       OR pg_catalog.strpos(
            v_claim_definition,
            'earlybird_concierge_snapshot_conflict_receipt_authorized'
       ) = 0
       OR pg_catalog.strpos(
            v_dispatchable_definition,
            'earlybird_concierge_snapshot_conflict_recoveries'
       ) = 0
       OR pg_catalog.strpos(
            v_dispatchable_definition,
            'earlybird_concierge_snapshot_conflict_receipt_authorized'
       ) = 0
       OR pg_catalog.has_table_privilege(
            'service_role',
            'public.earlybird_concierge_snapshot_conflict_recoveries',
            'SELECT,INSERT,UPDATE,DELETE'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_SNAPSHOT_RECOVERY_FINAL_GUARD_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
END;
$final_guard$;

COMMIT;
