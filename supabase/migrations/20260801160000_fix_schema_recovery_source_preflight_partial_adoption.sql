-- Source provider identities are authorized by the failed request's admitted
-- preflight, not by an independently immutable checkout count.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_source_adoption_preflights(
    p_order public.earlybird_orders,
    p_recovery public.analysis_preflights,
    p_source public.analysis_preflights,
    p_current public.analysis_preflights,
    p_failed_request_id UUID,
    p_current_request_id UUID
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
    v_source_capacity TEXT;
    v_source_required TEXT;
    v_source_capacity_rank INTEGER;
    v_source_required_rank INTEGER;
    v_current_capacity TEXT;
    v_current_required TEXT;
    v_current_capacity_rank INTEGER;
    v_current_required_rank INTEGER;
    v_order_capacity TEXT;
    v_order_capacity_rank INTEGER;
    v_order_required_rank INTEGER;
    v_selected_rank INTEGER;
    v_source_cards JSONB := '{}'::JSONB;
    v_current_cards JSONB := '{}'::JSONB;
    v_state TEXT;
    v_reason TEXT;
    v_entitlement_hash TEXT;
BEGIN
    v_entitlement_hash := pg_catalog.encode(extensions.digest(
        pg_catalog.convert_to(
            'earlybird-fulfillment-admission-v1'
            || pg_catalog.chr(10) || pg_catalog.lower(p_order.id::TEXT),
            'UTF8'
        ), 'sha256'
    ), 'hex');
    IF p_order.plan_id NOT IN ('basic', 'standard')
       OR p_order.target_followers_count NOT BETWEEN 0 AND 1200
       OR p_order.target_following_count NOT BETWEEN 0 AND 1200
       OR p_source.id IS NULL
       OR p_source.user_id IS DISTINCT FROM p_order.user_id
       OR p_source.access_mode <> 'production'
       OR p_source.status <> 'consumed'
       OR p_source.consumed_request_id IS DISTINCT FROM p_failed_request_id
       OR p_source.target_followers_count NOT BETWEEN 0 AND 1200
       OR p_source.target_following_count NOT BETWEEN 0 AND 1200
       OR p_source.target_followers_count IS DISTINCT FROM
            p_source.admission_target_followers_count
       OR p_source.target_following_count IS DISTINCT FROM
            p_source.admission_target_following_count
       OR p_source.admission_status <> 'ready'
       OR p_source.admission_selected_plan_id IS DISTINCT FROM p_order.plan_id
       OR p_source.admission_entitlement_jti_hash IS DISTINCT FROM v_entitlement_hash
       OR p_current.user_id IS DISTINCT FROM p_order.user_id
       OR p_current.access_mode <> 'production'
       OR p_current.status <> 'consumed'
       OR p_current.consumed_request_id IS DISTINCT FROM p_current_request_id
       OR p_current.target_followers_count NOT BETWEEN 0 AND 1200
       OR p_current.target_following_count NOT BETWEEN 0 AND 1200
       OR p_current.admission_status <> 'ready'
       OR p_current.admission_selected_plan_id IS DISTINCT FROM p_order.plan_id
       OR p_current.admission_entitlement_jti_hash IS DISTINCT FROM v_entitlement_hash
       OR p_current.admission_target_followers_count IS DISTINCT FROM
            p_current.target_followers_count
       OR p_current.admission_target_following_count IS DISTINCT FROM
            p_current.target_following_count
       OR p_source.launch_status_snapshot IS DISTINCT FROM
            p_recovery.launch_status_snapshot
       OR p_source.plan_catalog_snapshot IS DISTINCT FROM
            p_recovery.plan_catalog_snapshot
       OR p_source.pricing_version IS DISTINCT FROM p_recovery.pricing_version
       OR p_source.pricing_snapshot IS DISTINCT FROM p_recovery.pricing_snapshot
       OR p_source.policy_versions_snapshot IS DISTINCT FROM
            p_recovery.policy_versions_snapshot
       OR p_current.launch_status_snapshot IS DISTINCT FROM
            p_recovery.launch_status_snapshot
       OR p_current.plan_catalog_snapshot IS DISTINCT FROM
            p_recovery.plan_catalog_snapshot
       OR p_current.pricing_version IS DISTINCT FROM p_recovery.pricing_version
       OR p_current.pricing_snapshot IS DISTINCT FROM p_recovery.pricing_snapshot
       OR p_current.policy_versions_snapshot IS DISTINCT FROM
            p_recovery.policy_versions_snapshot
       OR NOT public.analysis_v2_valid_launch_snapshot(p_recovery.launch_status_snapshot)
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(
            p_recovery.plan_catalog_snapshot
       )
       OR NOT public.analysis_v2_valid_pricing_snapshot(p_recovery.pricing_snapshot)
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(
            p_recovery.policy_versions_snapshot
       ) THEN
        RETURN FALSE;
    END IF;

    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog := p_recovery.plan_catalog_snapshot->v_plan_id;
        v_launch := p_recovery.launch_status_snapshot->>v_plan_id;
        IF v_catalog->>'launchStatus' IS DISTINCT FROM v_launch
           OR COALESCE(v_catalog->'relationshipCapacity'->>'followers', '')
                !~ '^[0-9]+$'
           OR COALESCE(v_catalog->'relationshipCapacity'->>'following', '')
                !~ '^[0-9]+$' THEN
            RETURN FALSE;
        END IF;
        IF v_source_capacity_rank IS NULL
           AND p_source.admission_target_followers_count
                <= (v_catalog->'relationshipCapacity'->>'followers')::INTEGER
           AND p_source.admission_target_following_count
                <= (v_catalog->'relationshipCapacity'->>'following')::INTEGER THEN
            v_source_capacity_rank := v_plan_rank;
            v_source_capacity := v_plan_id;
        END IF;
        IF v_current_capacity_rank IS NULL
           AND p_current.target_followers_count
                <= (v_catalog->'relationshipCapacity'->>'followers')::INTEGER
           AND p_current.target_following_count
                <= (v_catalog->'relationshipCapacity'->>'following')::INTEGER THEN
            v_current_capacity_rank := v_plan_rank;
            v_current_capacity := v_plan_id;
        END IF;
        IF v_order_capacity_rank IS NULL
           AND p_order.target_followers_count
                <= (v_catalog->'relationshipCapacity'->>'followers')::INTEGER
           AND p_order.target_following_count
                <= (v_catalog->'relationshipCapacity'->>'following')::INTEGER THEN
            v_order_capacity_rank := v_plan_rank;
            v_order_capacity := v_plan_id;
        END IF;
    END LOOP;
    IF v_source_capacity_rank IS NULL OR v_current_capacity_rank IS NULL
       OR v_order_capacity_rank IS NULL THEN
        RETURN FALSE;
    END IF;

    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        IF v_source_required_rank IS NULL AND v_plan_rank >= v_source_capacity_rank
           AND p_recovery.launch_status_snapshot->>v_plan_id = 'production' THEN
            v_source_required_rank := v_plan_rank; v_source_required := v_plan_id;
        END IF;
        IF v_current_required_rank IS NULL AND v_plan_rank >= v_current_capacity_rank
           AND p_recovery.launch_status_snapshot->>v_plan_id = 'production' THEN
            v_current_required_rank := v_plan_rank; v_current_required := v_plan_id;
        END IF;
        IF v_order_required_rank IS NULL AND v_plan_rank >= v_order_capacity_rank
           AND p_recovery.launch_status_snapshot->>v_plan_id = 'production' THEN
            v_order_required_rank := v_plan_rank;
        END IF;
    END LOOP;
    v_selected_rank := CASE p_order.plan_id WHEN 'basic' THEN 1 ELSE 2 END;
    IF v_source_required_rank IS NULL OR v_current_required_rank IS NULL
       OR v_order_required_rank IS NULL
       OR v_selected_rank < v_source_required_rank
       OR v_selected_rank < v_current_required_rank
       OR v_selected_rank < v_order_required_rank
       OR p_recovery.launch_status_snapshot->>p_order.plan_id <> 'production' THEN
        RETURN FALSE;
    END IF;

    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog := p_recovery.plan_catalog_snapshot->v_plan_id;
        v_launch := p_recovery.launch_status_snapshot->>v_plan_id;
        IF v_plan_rank < v_source_capacity_rank THEN
            v_state := 'unavailable'; v_reason := 'below_required_plan';
        ELSIF v_launch <> 'production' THEN
            v_state := 'unavailable'; v_reason := 'launch_gate';
        ELSIF v_plan_id = v_source_required THEN
            v_state := 'required'; v_reason := NULL;
        ELSE
            v_state := 'available_upgrade'; v_reason := NULL;
        END IF;
        v_source_cards := v_source_cards || pg_catalog.jsonb_build_object(
            v_plan_id, pg_catalog.jsonb_build_object(
                'launchStatus', v_launch,
                'relationshipCapacity', v_catalog->'relationshipCapacity',
                'detailedMutualLimit', v_catalog->'detailedMutualLimit',
                'selectionState', v_state, 'unavailableReason', v_reason
            )
        );
        IF v_plan_rank < v_current_capacity_rank THEN
            v_state := 'unavailable'; v_reason := 'below_required_plan';
        ELSIF v_launch <> 'production' THEN
            v_state := 'unavailable'; v_reason := 'launch_gate';
        ELSIF v_plan_id = v_current_required THEN
            v_state := 'required'; v_reason := NULL;
        ELSE
            v_state := 'available_upgrade'; v_reason := NULL;
        END IF;
        v_current_cards := v_current_cards || pg_catalog.jsonb_build_object(
            v_plan_id, pg_catalog.jsonb_build_object(
                'launchStatus', v_launch,
                'relationshipCapacity', v_catalog->'relationshipCapacity',
                'detailedMutualLimit', v_catalog->'detailedMutualLimit',
                'selectionState', v_state, 'unavailableReason', v_reason
            )
        );
    END LOOP;

    RETURN public.analysis_v2_valid_plan_cards_snapshot(v_source_cards)
       AND public.analysis_v2_valid_plan_cards_snapshot(v_current_cards)
       AND p_source.capacity_required_plan_id = v_source_capacity
       AND p_source.required_plan_id = v_source_required
       AND p_source.plan_cards_snapshot = v_source_cards
       AND p_source.admission_capacity_required_plan_id = v_source_capacity
       AND p_source.admission_required_plan_id = v_source_required
       AND p_source.admission_plan_cards_snapshot = v_source_cards
       AND p_current.capacity_required_plan_id = v_current_capacity
       AND p_current.required_plan_id = v_current_required
       AND p_current.plan_cards_snapshot = v_current_cards
       AND p_current.admission_capacity_required_plan_id = v_current_capacity
       AND p_current.admission_required_plan_id = v_current_required
       AND p_current.admission_plan_cards_snapshot = v_current_cards
       AND p_source.admission_plan_cards_snapshot->p_order.plan_id->>'selectionState'
            IN ('required', 'available_upgrade')
       AND p_current.plan_cards_snapshot->p_order.plan_id->>'selectionState'
            IN ('required', 'available_upgrade')
       AND p_order.target_followers_count <=
            (p_recovery.plan_catalog_snapshot->p_order.plan_id
                ->'relationshipCapacity'->>'followers')::INTEGER
       AND p_order.target_following_count <=
            (p_recovery.plan_catalog_snapshot->p_order.plan_id
                ->'relationshipCapacity'->>'following')::INTEGER;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_source_adoption_preflights(
    public.earlybird_orders, public.analysis_preflights,
    public.analysis_preflights, public.analysis_preflights, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

DO $source_validator_guard$
DECLARE
    v_definition TEXT;
    v_signature TEXT :=
        'public.analysis_v2_valid_source_adoption_preflights('
        || 'public.earlybird_orders,public.analysis_preflights,'
        || 'public.analysis_preflights,public.analysis_preflights,uuid,uuid)';
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.strpos(v_definition, 'v_source_capacity_rank') = 0
       OR pg_catalog.strpos(v_definition, 'v_current_capacity_rank') = 0
       OR pg_catalog.strpos(v_definition, 'v_order_capacity_rank') = 0
       OR pg_catalog.strpos(
            v_definition,
            'p_source.admission_entitlement_jti_hash IS DISTINCT FROM v_entitlement_hash'
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'p_current.admission_plan_cards_snapshot = v_current_cards'
       ) = 0
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc AS proc
            CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                proc.proacl,
                pg_catalog.acldefault('f', proc.proowner)
            )) AS privilege
            WHERE proc.oid = v_signature::pg_catalog.regprocedure
              AND privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'EARLYBIRD_SOURCE_ADOPTION_VALIDATOR_GUARD_MISMATCH';
    END IF;
END;
$source_validator_guard$;

DO $migration$
DECLARE
    v_resolver_definition TEXT;
    v_resolver_rewritten TEXT;
    v_rearm_definition TEXT;
    v_rearm_rewritten TEXT;
BEGIN
    v_resolver_definition := pg_catalog.pg_get_functiondef(
        'public.resolve_analysis_v2_recovery_provider_run(uuid,text,uuid,text,text,text,text,text,numeric)'::pg_catalog.regprocedure
    );
    IF pg_catalog.strpos(v_resolver_definition, 'v_source_preflight public.analysis_preflights%ROWTYPE') > 0
       AND pg_catalog.strpos(v_resolver_definition, 'WHERE preflight.id = v_failed_request.preflight_id FOR UPDATE') > 0
       AND pg_catalog.strpos(v_resolver_definition, 'v_source_preflight.consumed_request_id IS DISTINCT FROM v_failed_request.id') > 0
       AND pg_catalog.strpos(v_resolver_definition, 'v_source_preflight.admission_target_followers_count') > 0
       AND pg_catalog.strpos(v_resolver_definition, 'v_source_preflight.admission_target_following_count') > 0
       AND pg_catalog.strpos(v_resolver_definition, 'public.analysis_v2_valid_recovery_adoption_preflights(') > 0
       AND pg_catalog.strpos(v_resolver_definition, 'public.analysis_v2_valid_source_adoption_preflights(') > 0
       AND pg_catalog.strpos(v_resolver_definition, 'v_failed_request.id, p_request_id') > 0
       AND pg_catalog.strpos(v_resolver_definition, 'WHEN ''followers'' THEN v_source_preflight.admission_target_followers_count') > 0
       AND pg_catalog.strpos(v_resolver_definition, 'source_run.max_charge_usd = p_max_charge_usd') > 0
       AND pg_catalog.strpos(v_resolver_definition, 'initial_run.max_charge_usd = p_max_charge_usd') > 0 THEN
        v_resolver_rewritten := v_resolver_definition;
    ELSE
        v_resolver_rewritten := pg_catalog.regexp_replace(v_resolver_definition,
            $pattern$v_recovery_preflight public[.]analysis_preflights%ROWTYPE;[[:space:]]+v_job public[.]analysis_pipeline_jobs%ROWTYPE;$pattern$,
            'v_recovery_preflight public.analysis_preflights%ROWTYPE;' || chr(10) || '    v_source_preflight public.analysis_preflights%ROWTYPE;' || chr(10) || '    v_job public.analysis_pipeline_jobs%ROWTYPE;'
        );
        v_resolver_rewritten := pg_catalog.regexp_replace(v_resolver_rewritten,
            $pattern$FOR UPDATE;[[:space:]]+-- Repeat every mutable lineage fence after reacquiring canonical row locks;$pattern$,
            'FOR UPDATE;' || chr(10) || '    SELECT preflight.* INTO v_source_preflight FROM public.analysis_preflights AS preflight WHERE preflight.id = v_failed_request.preflight_id FOR UPDATE;' || chr(10) || chr(10) || '    -- Repeat every mutable lineage fence after reacquiring canonical row locks;'
        );
        v_resolver_rewritten := pg_catalog.replace(v_resolver_rewritten,
            '       ) THEN' || chr(10) || '        RAISE EXCEPTION USING' || chr(10) || '            MESSAGE = ''ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT'',',
            '       )' || chr(10) || '       OR v_source_preflight.id IS DISTINCT FROM v_failed_request.preflight_id' || chr(10) || '       OR v_source_preflight.user_id IS DISTINCT FROM v_order.user_id' || chr(10) || '       OR v_source_preflight.access_mode <> ''production''' || chr(10) || '       OR v_source_preflight.status <> ''consumed''' || chr(10) || '       OR v_source_preflight.consumed_request_id IS DISTINCT FROM v_failed_request.id' || chr(10) || '       OR v_source_preflight.admission_status <> ''ready''' || chr(10) || '       OR v_source_preflight.admission_selected_plan_id IS DISTINCT FROM v_order.plan_id' || chr(10) || '       OR v_source_preflight.admission_target_followers_count IS NULL OR v_source_preflight.admission_target_followers_count < 0' || chr(10) || '       OR v_source_preflight.admission_target_following_count IS NULL OR v_source_preflight.admission_target_following_count < 0 THEN' || chr(10) || '        RAISE EXCEPTION USING' || chr(10) || '            MESSAGE = ''ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT'', '
        );
        v_resolver_rewritten := pg_catalog.regexp_replace(v_resolver_rewritten,
            $pattern$WHEN 'followers' THEN v_order[.]target_followers_count[[:space:]]+ELSE v_order[.]target_following_count$pattern$,
            'WHEN ''followers'' THEN v_source_preflight.admission_target_followers_count' || chr(10) || '        ELSE v_source_preflight.admission_target_following_count'
        );
        v_resolver_rewritten := pg_catalog.replace(v_resolver_rewritten,
            'AND source_run.credential_slot = p_credential_slot;',
            'AND source_run.credential_slot = p_credential_slot' || chr(10) || '      AND source_run.max_charge_usd = p_max_charge_usd;'
        );
        v_resolver_rewritten := pg_catalog.replace(v_resolver_rewritten,
            'AND initial_run.credential_slot = p_credential_slot',
            'AND initial_run.credential_slot = p_credential_slot' || chr(10) || '              AND initial_run.max_charge_usd = p_max_charge_usd'
        );
        v_resolver_rewritten := pg_catalog.regexp_replace(v_resolver_rewritten,
            $pattern$OR[[:space:]]+NOT public[.]analysis_v2_valid_recovery_adoption_preflights[(][[:space:]]+v_order,[[:space:]]+v_recovery_preflight,[[:space:]]+v_current[[:space:]]+[)]$pattern$,
            'OR NOT public.analysis_v2_valid_recovery_adoption_preflights(' || chr(10) || '            v_order, v_recovery_preflight, v_current' || chr(10) || '       )' || chr(10) || '       OR NOT public.analysis_v2_valid_source_adoption_preflights(' || chr(10) || '            v_order, v_recovery_preflight, v_source_preflight, v_current,' || chr(10) || '            v_failed_request.id, p_request_id' || chr(10) || '       )'
        );
        IF v_resolver_rewritten = v_resolver_definition
           OR pg_catalog.strpos(v_resolver_rewritten, 'v_source_preflight.consumed_request_id IS DISTINCT FROM v_failed_request.id') = 0
           OR pg_catalog.strpos(v_resolver_rewritten, 'WHERE preflight.id = v_failed_request.preflight_id FOR UPDATE') = 0
           OR pg_catalog.strpos(v_resolver_rewritten, 'public.analysis_v2_valid_source_adoption_preflights(') = 0
           OR pg_catalog.strpos(v_resolver_rewritten, 'v_failed_request.id, p_request_id') = 0
           OR pg_catalog.strpos(v_resolver_rewritten, 'source_run.max_charge_usd = p_max_charge_usd') = 0
           OR pg_catalog.strpos(v_resolver_rewritten, 'initial_run.max_charge_usd = p_max_charge_usd') = 0
           OR pg_catalog.strpos(v_resolver_rewritten, 'v_source_preflight.admission_capacity_required_plan_id IS DISTINCT FROM v_current.capacity_required_plan_id') > 0
           OR pg_catalog.strpos(v_resolver_rewritten, 'v_source_preflight.admission_required_plan_id IS DISTINCT FROM v_current.required_plan_id') > 0
           OR pg_catalog.strpos(v_resolver_rewritten, 'WHEN ''followers'' THEN v_order.target_followers_count') > 0
           OR pg_catalog.strpos(v_resolver_rewritten, 'v_order, v_recovery_preflight, v_current') = 0 THEN
            RAISE EXCEPTION 'EARLYBIRD_SOURCE_PREFLIGHT_PARTIAL_ADOPTION_RESOLVER_PATCH_MISMATCH';
        END IF;
    END IF;

    v_rearm_definition := pg_catalog.pg_get_functiondef(
        'public.rearm_earlybird_zero_spend_adoption_policy_failure(uuid,uuid,timestamp with time zone)'::pg_catalog.regprocedure
    );
    IF pg_catalog.strpos(v_rearm_definition, 'v_partial_adoption_variant BOOLEAN') > 0
       AND pg_catalog.strpos(v_rearm_definition, 'v_fulfillment.attempt_count <> 5 AND NOT v_partial_adoption_variant') > 0
       AND pg_catalog.strpos(v_rearm_definition, 'ANALYSIS_V2_PROGRESS_CONFLICT') > 0
       AND pg_catalog.strpos(v_rearm_definition, 'v_fulfillment.attempt_count = 2') > 0
       AND pg_catalog.strpos(v_rearm_definition, 'v_preflight.idempotency_key IS NOT DISTINCT FROM (v_base_preflight_key || ''.r1'')') > 0
       AND pg_catalog.strpos(v_rearm_definition, 'adoption.source_request_id IS DISTINCT FROM v_lineage.failed_request_id') > 0
       AND pg_catalog.strpos(v_rearm_definition, 'NOT v_partial_adoption_variant AND job.attempt_count = 0') > 0
       AND pg_catalog.strpos(v_rearm_definition, 'NOT v_partial_adoption_variant AND EXISTS') > 0 THEN
        v_rearm_rewritten := v_rearm_definition;
    ELSE
        v_rearm_rewritten := pg_catalog.replace(v_rearm_definition,
            '    v_preflight_generation INTEGER;',
            '    v_preflight_generation INTEGER;' || chr(10) || '    v_partial_adoption_variant BOOLEAN;'
        );
        v_rearm_rewritten := pg_catalog.replace(v_rearm_rewritten,
            '    v_normalized_preflight.excluded_instagram_id := v_order.excluded_instagram_id;',
            '    v_normalized_preflight.excluded_instagram_id := v_order.excluded_instagram_id;' || chr(10) || '    v_partial_adoption_variant := v_fulfillment.attempt_count = 2' || chr(10) || '       AND v_preflight.idempotency_key IS NOT DISTINCT FROM (v_base_preflight_key || ''.r1'')' || chr(10) || '       AND EXISTS (SELECT 1 FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption WHERE adoption.request_id = v_request.id)' || chr(10) || '       AND NOT EXISTS (SELECT 1 FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption WHERE adoption.request_id = v_request.id AND adoption.source_request_id IS DISTINCT FROM v_lineage.failed_request_id);'
        );
        v_rearm_rewritten := pg_catalog.replace(v_rearm_rewritten,
            'OR v_fulfillment.attempt_count <> 5',
            'OR (v_fulfillment.attempt_count <> 5 AND NOT v_partial_adoption_variant)'
        );
        v_rearm_rewritten := pg_catalog.replace(v_rearm_rewritten,
            'AND job.attempt_count = 0' || chr(10) || '              AND job.last_error_code = ''REQUEST_TERMINATED''',
            'AND ((NOT v_partial_adoption_variant AND job.attempt_count = 0 AND job.last_error_code = ''REQUEST_TERMINATED'') OR (v_partial_adoption_variant AND job.attempt_count = 1 AND job.last_error_code = ''ANALYSIS_V2_PROGRESS_CONFLICT''))'
        );
        v_rearm_rewritten := pg_catalog.replace(v_rearm_rewritten,
            'OR EXISTS (' || chr(10) || '            SELECT 1 FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption' || chr(10) || '            WHERE adoption.request_id = v_request.id' || chr(10) || '       )',
            'OR (NOT v_partial_adoption_variant AND EXISTS (' || chr(10) || '            SELECT 1 FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption' || chr(10) || '            WHERE adoption.request_id = v_request.id' || chr(10) || '       ))'
        );
        IF v_rearm_rewritten = v_rearm_definition
           OR pg_catalog.strpos(v_rearm_rewritten, 'v_partial_adoption_variant BOOLEAN') = 0
           OR pg_catalog.strpos(v_rearm_rewritten, 'v_fulfillment.attempt_count <> 5 AND NOT v_partial_adoption_variant') = 0
           OR pg_catalog.strpos(v_rearm_rewritten, 'ANALYSIS_V2_PROGRESS_CONFLICT') = 0
           OR pg_catalog.strpos(v_rearm_rewritten, 'v_fulfillment.attempt_count = 2') = 0
           OR pg_catalog.strpos(v_rearm_rewritten, 'v_preflight.idempotency_key IS NOT DISTINCT FROM (v_base_preflight_key || ''.r1'')') = 0
           OR pg_catalog.strpos(v_rearm_rewritten, 'adoption.source_request_id IS DISTINCT FROM v_lineage.failed_request_id') = 0
           OR pg_catalog.strpos(v_rearm_rewritten, 'NOT v_partial_adoption_variant AND job.attempt_count = 0') = 0
           OR pg_catalog.strpos(v_rearm_rewritten, 'NOT v_partial_adoption_variant AND EXISTS') = 0 THEN
            RAISE EXCEPTION 'EARLYBIRD_SOURCE_PREFLIGHT_PARTIAL_ADOPTION_REARM_PATCH_MISMATCH';
        END IF;
    END IF;

    -- Each expected definition was fully transformed before any EXECUTE;
    -- reapplication sees the complete new shape and is a no-op.
    EXECUTE v_resolver_rewritten;
    EXECUTE v_rearm_rewritten;
END;
$migration$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC) TO service_role;
REVOKE ALL ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(UUID, UUID, TIMESTAMP WITH TIME ZONE) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(UUID, UUID, TIMESTAMP WITH TIME ZONE) TO service_role;
