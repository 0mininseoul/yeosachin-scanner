-- Source provider identities are authorized by the failed request's admitted
-- preflight, not by an independently immutable checkout count.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

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
       AND pg_catalog.strpos(v_resolver_definition, 'v_order, v_source_preflight, v_current') > 0
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
            'OR NOT public.analysis_v2_valid_recovery_adoption_preflights(' || chr(10) || '            v_order, v_recovery_preflight, v_current' || chr(10) || '       )' || chr(10) || '       OR NOT public.analysis_v2_valid_recovery_adoption_preflights(' || chr(10) || '            v_order, v_source_preflight, v_current' || chr(10) || '       )'
        );
        IF v_resolver_rewritten = v_resolver_definition
           OR pg_catalog.strpos(v_resolver_rewritten, 'v_source_preflight.consumed_request_id IS DISTINCT FROM v_failed_request.id') = 0
           OR pg_catalog.strpos(v_resolver_rewritten, 'WHERE preflight.id = v_failed_request.preflight_id FOR UPDATE') = 0
           OR pg_catalog.strpos(v_resolver_rewritten, 'v_order, v_source_preflight, v_current') = 0
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
            'AND ((job.attempt_count = 0 AND job.last_error_code = ''REQUEST_TERMINATED'') OR (v_partial_adoption_variant AND job.attempt_count = 1 AND job.last_error_code = ''ANALYSIS_V2_PROGRESS_CONFLICT''))'
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
