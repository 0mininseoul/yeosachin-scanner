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
       AND pg_catalog.strpos(v_resolver_definition, 'v_source_preflight.admission_target_followers_count') > 0 THEN
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
            '       )' || chr(10) || '       OR v_source_preflight.id IS DISTINCT FROM v_failed_request.preflight_id' || chr(10) || '       OR v_source_preflight.user_id IS DISTINCT FROM v_order.user_id' || chr(10) || '       OR v_source_preflight.access_mode <> ''production''' || chr(10) || '       OR v_source_preflight.status <> ''consumed''' || chr(10) || '       OR v_source_preflight.consumed_request_id IS DISTINCT FROM v_failed_request.id' || chr(10) || '       OR v_source_preflight.admission_status <> ''ready''' || chr(10) || '       OR v_source_preflight.admission_selected_plan_id IS DISTINCT FROM v_order.plan_id' || chr(10) || '       OR v_source_preflight.admission_target_followers_count IS NULL OR v_source_preflight.admission_target_followers_count < 0' || chr(10) || '       OR v_source_preflight.admission_target_following_count IS NULL OR v_source_preflight.admission_target_following_count < 0' || chr(10) || '       OR v_source_preflight.admission_capacity_required_plan_id IS DISTINCT FROM v_current.capacity_required_plan_id' || chr(10) || '       OR v_source_preflight.admission_required_plan_id IS DISTINCT FROM v_current.required_plan_id' || chr(10) || '       OR COALESCE(v_source_preflight.admission_plan_cards_snapshot->v_order.plan_id->''relationshipCapacity''->>''followers'', '''') !~ ''^[0-9]+$''' || chr(10) || '       OR COALESCE(v_source_preflight.admission_plan_cards_snapshot->v_order.plan_id->''relationshipCapacity''->>''following'', '''') !~ ''^[0-9]+$''' || chr(10) || '       OR v_source_preflight.admission_target_followers_count > (v_source_preflight.admission_plan_cards_snapshot->v_order.plan_id->''relationshipCapacity''->>''followers'')::INTEGER' || chr(10) || '       OR v_source_preflight.admission_target_following_count > (v_source_preflight.admission_plan_cards_snapshot->v_order.plan_id->''relationshipCapacity''->>''following'')::INTEGER THEN' || chr(10) || '        RAISE EXCEPTION USING' || chr(10) || '            MESSAGE = ''ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT'', '
        );
        v_resolver_rewritten := pg_catalog.regexp_replace(v_resolver_rewritten,
            $pattern$WHEN 'followers' THEN v_order[.]target_followers_count[[:space:]]+ELSE v_order[.]target_following_count$pattern$,
            'WHEN ''followers'' THEN v_source_preflight.admission_target_followers_count' || chr(10) || '        ELSE v_source_preflight.admission_target_following_count'
        );
        IF v_resolver_rewritten = v_resolver_definition
           OR pg_catalog.strpos(v_resolver_rewritten, 'v_source_preflight.consumed_request_id IS DISTINCT FROM v_failed_request.id') = 0
           OR pg_catalog.strpos(v_resolver_rewritten, 'WHEN ''followers'' THEN v_order.target_followers_count') > 0 THEN
            RAISE EXCEPTION 'EARLYBIRD_SOURCE_PREFLIGHT_PARTIAL_ADOPTION_RESOLVER_PATCH_MISMATCH';
        END IF;
    END IF;

    v_rearm_definition := pg_catalog.pg_get_functiondef(
        'public.rearm_earlybird_zero_spend_adoption_policy_failure(uuid,uuid,timestamp with time zone)'::pg_catalog.regprocedure
    );
    IF pg_catalog.strpos(v_rearm_definition, 'adoption.source_request_id IS DISTINCT FROM v_lineage.failed_request_id') > 0
       AND pg_catalog.strpos(v_rearm_definition, 'v_fulfillment.attempt_count NOT BETWEEN 1 AND 5') > 0
       AND pg_catalog.strpos(v_rearm_definition, 'ANALYSIS_V2_PROGRESS_CONFLICT') > 0 THEN
        v_rearm_rewritten := v_rearm_definition;
    ELSE
        v_rearm_rewritten := pg_catalog.replace(v_rearm_definition,
            'OR v_fulfillment.attempt_count <> 5',
            'OR v_fulfillment.attempt_count NOT BETWEEN 1 AND 5'
        );
        v_rearm_rewritten := pg_catalog.replace(v_rearm_rewritten,
            'AND job.attempt_count = 0' || chr(10) || '              AND job.last_error_code = ''REQUEST_TERMINATED''',
            'AND ((job.attempt_count = 0 AND job.last_error_code = ''REQUEST_TERMINATED'') OR (job.attempt_count = 1 AND job.last_error_code = ''ANALYSIS_V2_PROGRESS_CONFLICT''))'
        );
        v_rearm_rewritten := pg_catalog.replace(v_rearm_rewritten,
            'OR EXISTS (' || chr(10) || '            SELECT 1 FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption' || chr(10) || '            WHERE adoption.request_id = v_request.id' || chr(10) || '       )',
            'OR NOT EXISTS (' || chr(10) || '            SELECT 1' || chr(10) || '            FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption' || chr(10) || '            WHERE adoption.request_id = v_request.id' || chr(10) || '       )' || chr(10) || '       OR EXISTS (' || chr(10) || '            SELECT 1' || chr(10) || '            FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption' || chr(10) || '            WHERE adoption.request_id = v_request.id' || chr(10) || '              AND adoption.source_request_id IS DISTINCT FROM v_lineage.failed_request_id' || chr(10) || '       )'
        );
        v_rearm_rewritten := pg_catalog.replace(v_rearm_rewritten,
            'OR v_audit.expected_manual_review_at' || chr(10) || '                IS DISTINCT FROM p_expected_manual_review_at THEN',
            'OR v_audit.expected_manual_review_at' || chr(10) || '                IS DISTINCT FROM p_expected_manual_review_at' || chr(10) || '           OR v_audit.expected_fulfillment_attempt_count NOT BETWEEN 1 AND 5 THEN'
        );
        IF v_rearm_rewritten = v_rearm_definition
           OR pg_catalog.strpos(v_rearm_rewritten, 'v_fulfillment.attempt_count NOT BETWEEN 1 AND 5') = 0
           OR pg_catalog.strpos(v_rearm_rewritten, 'ANALYSIS_V2_PROGRESS_CONFLICT') = 0
           OR pg_catalog.strpos(v_rearm_rewritten, 'adoption.source_request_id IS DISTINCT FROM v_lineage.failed_request_id') = 0 THEN
            RAISE EXCEPTION 'EARLYBIRD_SOURCE_PREFLIGHT_PARTIAL_ADOPTION_REARM_PATCH_MISMATCH';
        END IF;
    END IF;

    -- Each expected definition was fully transformed before either EXECUTE;
    -- reapplication sees the complete new shape and is a no-op.
    EXECUTE v_resolver_rewritten;
    EXECUTE v_rearm_rewritten;
END;
$migration$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC) TO service_role;
REVOKE ALL ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(UUID, UUID, TIMESTAMP WITH TIME ZONE) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(UUID, UUID, TIMESTAMP WITH TIME ZONE) TO service_role;
