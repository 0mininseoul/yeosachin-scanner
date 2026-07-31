-- Retention can scrub the recorded recovery preflight a second time after the
-- paid order has already been rebound. Preserve the original attested branch,
-- and add a narrower fully-scrubbed branch whose authority is the immutable
-- recovery/failure receipt plus the current deterministic descendant.
ALTER FUNCTION public.analysis_v2_valid_recovery_adoption_preflights(
    public.earlybird_orders, public.analysis_preflights, public.analysis_preflights
) RENAME TO analysis_v2_valid_retained_admission_adoption_preflights;

CREATE FUNCTION public.analysis_v2_valid_recovery_adoption_preflights(
    p_order public.earlybird_orders,
    p_recovery public.analysis_preflights,
    p_current public.analysis_preflights
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_plan_id TEXT;
    v_plan_rank INTEGER;
    v_catalog JSONB;
    v_launch TEXT;
    v_capacity TEXT;
    v_required TEXT;
    v_capacity_rank INTEGER;
    v_required_rank INTEGER;
    v_cards JSONB := '{}'::JSONB;
    v_state TEXT;
    v_reason TEXT;
    v_selected JSONB;
BEGIN
    -- The first-generation recovery shape still has its immutable admission
    -- witness. Keep the already-reviewed dual-recomputation policy for it.
    IF p_recovery.admission_target_followers_count IS NOT NULL
       OR p_recovery.admission_target_following_count IS NOT NULL
       OR p_recovery.admission_plan_cards_snapshot IS NOT NULL THEN
        IF p_recovery.admission_status <> 'ready'
           OR p_recovery.admission_selected_plan_id IS DISTINCT FROM p_order.plan_id
           OR p_recovery.admission_entitlement_jti_hash IS DISTINCT FROM
                pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
                    'earlybird-fulfillment-admission-v1'
                    || pg_catalog.chr(10)
                    || pg_catalog.lower(p_order.id::TEXT),
                    'UTF8'
                ), 'sha256'), 'hex') THEN
            RETURN FALSE;
        END IF;
        RETURN public.analysis_v2_valid_retained_admission_adoption_preflights(
            p_order, p_recovery, p_current
        );
    END IF;

    IF p_order.plan_id NOT IN ('basic', 'standard')
       OR p_order.target_followers_count IS NULL
       OR p_order.target_following_count IS NULL
       OR p_recovery.status <> 'expired'
       OR p_recovery.pii_scrubbed_at IS NULL
       OR p_recovery.pii_scrubbed_at < p_recovery.expires_at
       OR p_recovery.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(p_recovery.id::TEXT, '-', ''), 1, 20
            )
       )
       OR p_recovery.target_full_name IS NOT NULL
       OR p_recovery.target_bio IS NOT NULL
       OR p_recovery.target_profile_image_url IS NOT NULL
       OR p_recovery.target_followers_count IS NOT NULL
       OR p_recovery.target_following_count IS NOT NULL
       OR p_recovery.target_is_private IS NOT NULL
       OR p_recovery.capacity_required_plan_id IS NOT NULL
       OR p_recovery.required_plan_id IS NOT NULL
       OR p_recovery.plan_cards_snapshot IS NOT NULL
       OR p_recovery.exclusion_decision <> 'skip'
       OR p_recovery.excluded_instagram_id IS NOT NULL
       OR p_recovery.lease_token IS NOT NULL
       OR p_recovery.lease_expires_at IS NOT NULL
       OR p_recovery.error_code IS NOT NULL
       OR p_recovery.blocked_at IS NOT NULL
       OR p_recovery.ready_at IS NOT NULL
       OR p_recovery.admission_status <> 'idle'
       OR p_recovery.admission_selected_plan_id IS NOT NULL
       OR p_recovery.admission_entitlement_jti_hash IS NOT NULL
       OR p_recovery.admission_token IS NOT NULL
       OR p_recovery.admission_requested_at IS NOT NULL
       OR p_recovery.admission_refreshed_at IS NOT NULL
       OR p_recovery.admission_claim_token IS NOT NULL
       OR p_recovery.admission_lease_expires_at IS NOT NULL
       OR p_recovery.admission_dispatch_state <> 'idle'
       OR p_recovery.admission_dispatch_token IS NOT NULL
       OR p_recovery.admission_dispatch_reserved_at IS NOT NULL
       OR p_recovery.admission_dispatched_at IS NOT NULL
       OR p_recovery.admission_error_code IS NOT NULL
       OR p_recovery.admission_capacity_required_plan_id IS NOT NULL
       OR p_recovery.admission_required_plan_id IS NOT NULL
       OR p_recovery.admission_last_error_code IS NOT NULL
       OR p_current.user_id IS DISTINCT FROM p_order.user_id
       OR p_current.access_mode <> 'production'
       OR p_current.target_instagram_id IS DISTINCT FROM p_order.target_instagram_id
       OR p_current.target_followers_count IS NULL
       OR p_current.target_following_count IS NULL
       OR p_current.exclusion_decision IS DISTINCT FROM p_order.exclusion_decision
       OR p_current.excluded_instagram_id IS DISTINCT FROM p_order.excluded_instagram_id
       OR p_current.launch_status_snapshot IS DISTINCT FROM p_recovery.launch_status_snapshot
       OR p_current.plan_catalog_snapshot IS DISTINCT FROM p_recovery.plan_catalog_snapshot
       OR p_current.pricing_version IS DISTINCT FROM p_recovery.pricing_version
       OR p_current.pricing_snapshot IS DISTINCT FROM p_recovery.pricing_snapshot
       OR p_current.policy_versions_snapshot IS DISTINCT FROM
            p_recovery.policy_versions_snapshot
       OR NOT public.analysis_v2_valid_launch_snapshot(p_current.launch_status_snapshot)
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(p_current.plan_catalog_snapshot)
       OR NOT public.analysis_v2_valid_pricing_snapshot(p_current.pricing_snapshot)
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(
            p_current.policy_versions_snapshot
       ) THEN
        RETURN FALSE;
    END IF;

    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog := p_current.plan_catalog_snapshot->v_plan_id;
        v_launch := p_current.launch_status_snapshot->>v_plan_id;
        IF v_catalog->>'launchStatus' IS DISTINCT FROM v_launch THEN RETURN FALSE; END IF;
        IF v_capacity_rank IS NULL
           AND p_current.target_followers_count
                <= (v_catalog->'relationshipCapacity'->>'followers')::INTEGER
           AND p_current.target_following_count
                <= (v_catalog->'relationshipCapacity'->>'following')::INTEGER THEN
            v_capacity_rank := v_plan_rank;
            v_capacity := v_plan_id;
        END IF;
    END LOOP;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        IF v_required_rank IS NULL AND v_plan_rank >= v_capacity_rank
           AND p_current.launch_status_snapshot->>v_plan_id = 'production' THEN
            v_required_rank := v_plan_rank;
            v_required := v_plan_id;
        END IF;
    END LOOP;
    IF v_capacity_rank IS NULL OR v_required_rank IS NULL THEN RETURN FALSE; END IF;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog := p_current.plan_catalog_snapshot->v_plan_id;
        v_launch := p_current.launch_status_snapshot->>v_plan_id;
        IF v_plan_rank < v_capacity_rank THEN
            v_state := 'unavailable'; v_reason := 'below_required_plan';
        ELSIF v_launch <> 'production' THEN
            v_state := 'unavailable'; v_reason := 'launch_gate';
        ELSIF v_plan_id = v_required THEN
            v_state := 'required'; v_reason := NULL;
        ELSE
            v_state := 'available_upgrade'; v_reason := NULL;
        END IF;
        v_cards := v_cards || pg_catalog.jsonb_build_object(
            v_plan_id, pg_catalog.jsonb_build_object(
                'launchStatus', v_launch,
                'relationshipCapacity', v_catalog->'relationshipCapacity',
                'detailedMutualLimit', v_catalog->'detailedMutualLimit',
                'selectionState', v_state, 'unavailableReason', v_reason
            )
        );
    END LOOP;
    v_selected := v_cards->p_order.plan_id;
    RETURN public.analysis_v2_valid_plan_cards_snapshot(v_cards)
       AND p_current.capacity_required_plan_id = v_capacity
       AND p_current.required_plan_id = v_required
       AND p_current.plan_cards_snapshot = v_cards
       AND v_selected->>'launchStatus' = 'production'
       AND v_selected->>'selectionState' IN ('required', 'available_upgrade')
       AND p_order.target_followers_count
            <= (v_selected->'relationshipCapacity'->>'followers')::INTEGER
       AND p_order.target_following_count
            <= (v_selected->'relationshipCapacity'->>'following')::INTEGER
       AND p_current.admission_status = 'ready'
       AND p_current.admission_selected_plan_id = p_order.plan_id
       AND p_current.admission_target_followers_count =
            p_current.target_followers_count
       AND p_current.admission_target_following_count =
            p_current.target_following_count
       AND p_current.admission_capacity_required_plan_id = v_capacity
       AND p_current.admission_required_plan_id = v_required
       AND p_current.admission_plan_cards_snapshot = v_cards;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_recovery_adoption_preflights(
    public.earlybird_orders, public.analysis_preflights, public.analysis_preflights
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.earlybird_provider_run_adoption_ready(
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
    SELECT EXISTS (
        SELECT 1
        FROM public.earlybird_schema_failure_recoveries AS recovery
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = recovery.order_id
        JOIN public.analysis_requests AS failed_request
          ON failed_request.id = recovery.failed_request_id
        JOIN public.analysis_preflights AS recovery_preflight
          ON recovery_preflight.id = recovery.recovery_preflight_id
        JOIN public.analysis_preflights AS current_preflight
          ON current_preflight.id = earlybird_order.preflight_id
        WHERE recovery.order_id = p_order_id
          AND recovery.failed_request_id = p_failed_request_id
          AND current_preflight.id = p_recovery_preflight_id
          AND failed_request.user_id = earlybird_order.user_id
          AND failed_request.pipeline_version = 'v2'
          AND failed_request.status = 'failed'
          AND EXISTS (
              SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
              WHERE receipt.request_id = failed_request.id
                AND receipt.error_code = failed_request.error_message
          )
          AND current_preflight.idempotency_key ~ (
              '^earlybird[.]fulfillment[.]'
              || pg_catalog.replace(earlybird_order.id::TEXT, '-', '')
              || '([.]r[1-9])?$'
          )
          AND public.analysis_v2_valid_recovery_adoption_preflights(
              earlybird_order, recovery_preflight, current_preflight
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = failed_request.id
                AND (
                    source_run.status <> 'succeeded'
                    OR source_run.run_id IS NULL
                    OR source_run.actual_usage_usd IS NULL
                    OR source_run.usage_reconciled_at IS NULL
                )
          )
    );
$$;

-- Remove only the superseded 060 inline shape assumptions. The resolver keeps
-- all paid-order, failure-receipt, active-claim and immutable run-identity fences,
-- and delegates both retention generations to the replacement helper above.
DO $migration$
DECLARE
    v_definition TEXT;
    v_rewritten TEXT;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        'public.resolve_analysis_v2_recovery_provider_run(uuid,text,uuid,text,text,text,text,text,numeric)'::pg_catalog.regprocedure
    );
    v_rewritten := pg_catalog.replace(v_definition, $old$
       OR v_current_preflight.target_followers_count
            IS DISTINCT FROM v_order.target_followers_count
       OR v_current_preflight.target_following_count
            IS DISTINCT FROM v_order.target_following_count
$old$, '');
    v_rewritten := pg_catalog.replace(v_rewritten, $old$
       OR v_recovery_preflight.admission_status <> 'ready'
       OR v_recovery_preflight.admission_selected_plan_id
            IS DISTINCT FROM v_order.plan_id
       OR v_recovery_preflight.admission_entitlement_jti_hash IS DISTINCT FROM
            pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
                'earlybird-fulfillment-admission-v1'
                || pg_catalog.chr(10) || pg_catalog.lower(v_order.id::TEXT),
                'UTF8'
            ), 'sha256'), 'hex')
       OR v_recovery_preflight.admission_target_followers_count IS NULL
       OR v_recovery_preflight.admission_target_following_count IS NULL
       OR v_recovery_preflight.admission_plan_cards_snapshot IS NULL
$old$, '');
    v_rewritten := pg_catalog.replace(v_rewritten, $old$
       OR v_failed_request.pipeline_version <> 'v2'
       OR v_current_preflight.user_id IS DISTINCT FROM v_order.user_id
$old$, $new$
       OR v_failed_request.pipeline_version <> 'v2'
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_failed_request.id
              AND receipt.error_code = v_failed_request.error_message
       )
       OR v_current_preflight.user_id IS DISTINCT FROM v_order.user_id
$new$);
    v_rewritten := pg_catalog.replace(v_rewritten, $old$
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF v_source.status <> 'succeeded'
$old$, $new$
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;
    IF v_source.status <> 'succeeded'
$new$);
    v_rewritten := pg_catalog.replace(v_rewritten, $old$
       OR v_source.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
        RETURN NULL;
    END IF;
$old$, $new$
       OR v_source.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;
$new$);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(
            v_rewritten,
            'v_current_preflight.target_followers_count'
                || pg_catalog.chr(10)
                || '            IS DISTINCT FROM v_order.target_followers_count'
       ) > 0
       OR pg_catalog.strpos(
            v_rewritten, 'v_recovery_preflight.admission_status <> ''ready'''
       ) > 0
       OR pg_catalog.strpos(
            v_rewritten,
            'OR NOT public.analysis_v2_valid_recovery_adoption_preflights('
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE'
       ) = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_FULLY_SCRUBBED_ADOPTION_PATCH_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$migration$;
