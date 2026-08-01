-- Correct the audited partial-adoption rearm to the exact production incident.
-- 1600 is immutable migration history; this forward patch only accepts its
-- reviewed replacement-identity shape or this migration's complete final shape.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_signature TEXT :=
        'public.rearm_earlybird_zero_spend_adoption_policy_failure('
        || 'uuid,uuid,timestamp with time zone)';
    v_definition TEXT;
    v_rewritten TEXT;
    v_block_start INTEGER;
    v_block_end INTEGER;
    v_security_definer BOOLEAN;
    v_safe_search_path BOOLEAN;
    v_fulfillment_lock_marker TEXT :=
        'WHERE fulfillment.order_id = p_order_id FOR UPDATE;';
    v_audit_replay_marker TEXT := $marker$    SELECT audit.* INTO v_audit
    FROM public.earlybird_adoption_policy_failure_rearms AS audit
    WHERE audit.order_id = p_order_id;
    IF FOUND THEN$marker$;
    v_audit_return_marker TEXT := $marker$        RETURN QUERY SELECT p_order_id, v_fulfillment.status,
            v_audit.rearmed_preflight_id, v_audit.policy_failed_request_id;
        RETURN;$marker$;
    v_old_declarations TEXT := $old$    v_partial_source_preflight public.analysis_preflights%ROWTYPE;
    v_partial_source_initial_operation TEXT;
    v_partial_source_initial_input TEXT;
    v_partial_source_operation TEXT;
    v_partial_source_input TEXT;
    v_partial_current_operation TEXT;
    v_partial_current_input TEXT;$old$;
    v_new_declarations TEXT := $new$    v_partial_source_preflight public.analysis_preflights%ROWTYPE;
    v_partial_source_followers_operation TEXT;
    v_partial_source_followers_input TEXT;
    v_partial_source_following_operation TEXT;
    v_partial_source_following_input TEXT;
    v_partial_current_followers_operation TEXT;
    v_partial_current_followers_input TEXT;
    v_partial_current_following_operation TEXT;
    v_partial_current_following_input TEXT;$new$;
    v_new_block TEXT := $new$    SELECT source_preflight.* INTO v_partial_source_preflight
    FROM public.analysis_requests AS source_request
    JOIN public.analysis_preflights AS source_preflight
      ON source_preflight.id = source_request.preflight_id
    WHERE source_request.id = v_lineage.failed_request_id;
    SELECT identity.operation_key, identity.input_hash
    INTO v_partial_source_followers_operation, v_partial_source_followers_input
    FROM public.analysis_v2_relationship_provider_identity(
        'followers', v_order.target_instagram_id,
        v_partial_source_preflight.admission_target_followers_count,
        v_order.plan_id, FALSE
    ) AS identity;
    SELECT identity.operation_key, identity.input_hash
    INTO v_partial_source_following_operation, v_partial_source_following_input
    FROM public.analysis_v2_relationship_provider_identity(
        'following', v_order.target_instagram_id,
        v_partial_source_preflight.admission_target_following_count,
        v_order.plan_id, FALSE
    ) AS identity;
    SELECT identity.operation_key, identity.input_hash
    INTO v_partial_current_followers_operation, v_partial_current_followers_input
    FROM public.analysis_v2_relationship_provider_identity(
        'followers', v_order.target_instagram_id,
        v_preflight.target_followers_count, v_order.plan_id, FALSE
    ) AS identity;
    SELECT identity.operation_key, identity.input_hash
    INTO v_partial_current_following_operation, v_partial_current_following_input
    FROM public.analysis_v2_relationship_provider_identity(
        'following', v_order.target_instagram_id,
        v_preflight.target_following_count, v_order.plan_id, FALSE
    ) AS identity;
    SELECT pg_catalog.count(*) = 8
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key = 'track:relationships:collect'
              AND source_run.operation_key = v_partial_source_followers_operation
              AND source_run.input_hash = v_partial_source_followers_input
       ) = 1
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key = 'track:relationships:collect'
              AND source_run.operation_key = v_partial_source_following_operation
              AND source_run.input_hash = v_partial_source_following_input
       ) = 1
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key ~ '^track:profiles:batch:[0-3]$'
              AND source_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$'
       ) = 4
       AND pg_catalog.count(DISTINCT source_run.job_key) FILTER (
            WHERE source_run.job_key ~ '^track:profiles:batch:[0-3]$'
              AND source_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$'
       ) = 4
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key = 'track:target-evidence:collect'
              AND source_run.operation_key ~ '^target-likers:[0-9a-f]{64}$'
       ) = 1
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key = 'track:target-evidence:collect'
              AND source_run.operation_key ~ '^target-comments:[0-9a-f]{64}$'
       ) = 1
       AND pg_catalog.bool_and(
            source_run.status = 'succeeded'
            AND source_run.run_id IS NOT NULL
            AND source_run.actual_usage_usd IS NOT NULL
            AND source_run.usage_reconciled_at IS NOT NULL
       )
    INTO v_partial_source_topology_valid
    FROM public.analysis_v2_provider_runs AS source_run
    WHERE source_run.request_id = v_lineage.failed_request_id;
    SELECT pg_catalog.count(*) = 3
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key = 'track:relationships:collect'
              AND source_run.operation_key = v_partial_source_following_operation
              AND source_run.input_hash = v_partial_source_following_input
              AND adoption.operation_key = v_partial_current_following_operation
              AND adoption.destination_input_hash = v_partial_current_following_input
       ) = 1
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key = 'track:target-evidence:collect'
              AND source_run.operation_key ~ '^target-likers:[0-9a-f]{64}$'
       ) = 1
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key = 'track:target-evidence:collect'
              AND source_run.operation_key ~ '^target-comments:[0-9a-f]{64}$'
       ) = 1
       AND pg_catalog.count(source_run.request_id) = 3
       AND pg_catalog.bool_and(adoption.job_key = source_run.job_key)
       AND pg_catalog.bool_and(
            CASE
                WHEN source_run.operation_key = v_partial_source_following_operation
                    THEN adoption.operation_key = v_partial_current_following_operation
                     AND adoption.destination_input_hash = v_partial_current_following_input
                ELSE adoption.operation_key = source_run.operation_key
                 AND adoption.destination_input_hash = source_run.input_hash
            END
       )
    INTO v_partial_adoption_topology_valid
    FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
    LEFT JOIN public.analysis_v2_provider_runs AS source_run
      ON source_run.request_id = adoption.source_request_id
     AND source_run.job_key = adoption.source_job_key
     AND source_run.operation_key = adoption.source_operation_key
     AND source_run.run_id = adoption.source_run_id
    WHERE adoption.request_id = v_request.id
      AND adoption.source_request_id = v_lineage.failed_request_id;
$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(v_signature::pg_catalog.regprocedure);
    SELECT
        proc.prosecdef,
        COALESCE('search_path=""' = ANY(proc.proconfig), FALSE)
    INTO v_security_definer, v_safe_search_path
    FROM pg_catalog.pg_proc AS proc
    WHERE proc.oid = v_signature::pg_catalog.regprocedure;
    IF NOT COALESCE(v_security_definer, FALSE)
       OR NOT COALESCE(v_safe_search_path, FALSE)
       OR pg_catalog.strpos(v_definition, 'SECURITY DEFINER') = 0
       OR pg_catalog.strpos(v_definition, 'SET search_path TO ''''') = 0
       OR pg_catalog.strpos(
            v_definition,
            'WHERE earlybird_order.id = p_order_id FOR UPDATE;'
       ) = 0
       OR (
            pg_catalog.length(v_definition)
            - pg_catalog.length(pg_catalog.replace(
                v_definition, v_fulfillment_lock_marker, ''
            ))
       ) <> 2 * pg_catalog.length(v_fulfillment_lock_marker)
       OR pg_catalog.strpos(
            v_definition,
            'WHERE request.id = p_expected_failed_request_id FOR UPDATE;'
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'WHERE preflight.id = v_order.preflight_id FOR UPDATE;'
       ) = 0
       OR pg_catalog.strpos(v_definition, v_audit_replay_marker) = 0
       OR pg_catalog.strpos(
            v_definition,
            'v_audit.policy_failed_request_id IS DISTINCT FROM p_expected_failed_request_id'
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'v_audit.expected_manual_review_at'
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'v_order.preflight_id IS DISTINCT FROM v_audit.rearmed_preflight_id'
       ) = 0
       OR pg_catalog.strpos(v_definition, v_audit_return_marker) = 0
       OR pg_catalog.strpos(
            v_definition,
            'INSERT INTO public.earlybird_adoption_policy_failure_rearms('
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'v_request.idempotency_key IS DISTINCT FROM'
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            '(''earlybird:'' || pg_catalog.lower(v_order.id::TEXT) || ''.r1'')'
       ) = 0
       OR pg_catalog.strpos(v_definition, 'family_preflight.idempotency_key') = 0
       OR pg_catalog.strpos(
            v_definition,
            'v_base_preflight_key || ''.r'' || (v_preflight_generation + 1)::TEXT'
       ) = 0 THEN
        RAISE EXCEPTION
            'EARLYBIRD_PARTIAL_ADOPTION_TOPOLOGY_SAFETY_SHAPE_MISMATCH';
    END IF;
    v_block_start := pg_catalog.strpos(
        v_definition,
        '    SELECT source_preflight.* INTO v_partial_source_preflight'
    );
    v_block_end := pg_catalog.strpos(
        v_definition,
        '    v_partial_adoption_variant :='
    );

    IF v_block_start > 0
       AND v_block_end > v_block_start
       AND pg_catalog.md5(pg_catalog.substr(
            v_definition, v_block_start, v_block_end - v_block_start
       )) = pg_catalog.md5(v_new_block)
       AND pg_catalog.strpos(v_definition, 'v_partial_source_followers_operation TEXT') > 0
       AND pg_catalog.strpos(v_definition, 'v_partial_source_following_operation TEXT') > 0
       AND pg_catalog.strpos(v_definition, 'v_partial_current_followers_operation TEXT') > 0
       AND pg_catalog.strpos(v_definition, 'v_partial_current_following_operation TEXT') > 0
       AND pg_catalog.strpos(v_definition, 'v_partial_source_preflight.admission_target_followers_count') > 0
       AND pg_catalog.strpos(v_definition, 'v_partial_source_preflight.admission_target_following_count') > 0
       AND pg_catalog.strpos(v_definition, 'v_preflight.target_followers_count, v_order.plan_id, FALSE') > 0
       AND pg_catalog.strpos(v_definition, 'v_preflight.target_following_count, v_order.plan_id, FALSE') > 0
       AND pg_catalog.strpos(v_definition, 'source_run.input_hash = v_partial_source_followers_input') > 0
       AND pg_catalog.strpos(v_definition, 'source_run.input_hash = v_partial_source_following_input') > 0
       AND pg_catalog.strpos(v_definition, 'adoption.operation_key = v_partial_current_following_operation') > 0
       AND pg_catalog.strpos(v_definition, 'adoption.destination_input_hash = v_partial_current_following_input') > 0
       AND pg_catalog.strpos(v_definition, 'pg_catalog.count(*) = 8') > 0
       AND pg_catalog.strpos(v_definition, 'pg_catalog.count(*) = 3') > 0
       AND pg_catalog.strpos(v_definition, 'v_fulfillment.attempt_count = 2') > 0
       AND pg_catalog.strpos(v_definition, 'v_preflight.idempotency_key IS NOT DISTINCT FROM (v_base_preflight_key || ''.r1'')') > 0
       AND pg_catalog.strpos(v_definition, 'COALESCE(v_partial_source_topology_valid') > 0
       AND pg_catalog.strpos(v_definition, 'COALESCE(v_partial_adoption_topology_valid') > 0
       AND pg_catalog.strpos(v_definition, 'adoption.source_request_id IS DISTINCT FROM v_lineage.failed_request_id') > 0
       AND pg_catalog.strpos(v_definition, 'public.analysis_v2_valid_recovery_adoption_preflights(') > 0
       AND pg_catalog.strpos(v_definition, 'v_fulfillment.attempt_count <> 5 AND NOT v_partial_adoption_variant') > 0
       AND pg_catalog.strpos(v_definition, 'run.request_id = v_request.id') > 0
       AND pg_catalog.strpos(v_definition, 'public.analysis_provider_cost_ledger AS cost') > 0
       AND pg_catalog.strpos(v_definition, 'public.analysis_v2_ai_attempts AS attempt') > 0
       AND pg_catalog.strpos(v_definition, 'public.analysis_v2_relationship_sides AS evidence') > 0
       AND pg_catalog.strpos(v_definition, 'public.analysis_v2_target_evidence_manifests AS evidence') > 0 THEN
        v_rewritten := v_definition;
    ELSE
        IF pg_catalog.strpos(v_definition, v_old_declarations) = 0
           OR pg_catalog.strpos(v_definition, 'v_order.plan_id, TRUE') = 0
           OR pg_catalog.strpos(v_definition, 'v_partial_source_initial_operation') = 0
           OR pg_catalog.strpos(v_definition, 'v_partial_source_operation') = 0
           OR pg_catalog.strpos(v_definition, 'v_partial_current_operation') = 0
           OR pg_catalog.strpos(v_definition, 'pg_catalog.count(*) = 8') = 0
           OR pg_catalog.strpos(v_definition, 'pg_catalog.count(*) = 3') = 0
           OR pg_catalog.strpos(v_definition, 'v_fulfillment.attempt_count = 2') = 0
           OR pg_catalog.strpos(v_definition, 'v_preflight.idempotency_key IS NOT DISTINCT FROM (v_base_preflight_key || ''.r1'')') = 0
           OR pg_catalog.strpos(v_definition, 'COALESCE(v_partial_source_topology_valid') = 0
           OR pg_catalog.strpos(v_definition, 'COALESCE(v_partial_adoption_topology_valid') = 0
           OR pg_catalog.strpos(v_definition, 'adoption.source_request_id IS DISTINCT FROM v_lineage.failed_request_id') = 0
           OR pg_catalog.strpos(v_definition, 'public.analysis_v2_valid_recovery_adoption_preflights(') = 0
           OR pg_catalog.strpos(v_definition, 'v_fulfillment.attempt_count <> 5 AND NOT v_partial_adoption_variant') = 0
           OR pg_catalog.strpos(v_definition, 'NOT v_partial_adoption_variant AND job.attempt_count = 0') = 0
           OR pg_catalog.strpos(v_definition, 'run.request_id = v_request.id') = 0 THEN
            RAISE EXCEPTION 'EARLYBIRD_PARTIAL_ADOPTION_TOPOLOGY_OLD_SHAPE_MISMATCH';
        END IF;
        IF v_block_start = 0 OR v_block_end <= v_block_start
           OR pg_catalog.md5(pg_catalog.substr(
                v_definition, v_block_start, v_block_end - v_block_start
           )) <> '2994a37e90c99d26aabd2a75a44c70a1' THEN
            RAISE EXCEPTION 'EARLYBIRD_PARTIAL_ADOPTION_TOPOLOGY_BLOCK_MISMATCH';
        END IF;
        v_rewritten := pg_catalog.replace(
            v_definition, v_old_declarations, v_new_declarations
        );
        v_block_start := pg_catalog.strpos(
            v_rewritten,
            '    SELECT source_preflight.* INTO v_partial_source_preflight'
        );
        v_block_end := pg_catalog.strpos(
            v_rewritten,
            '    v_partial_adoption_variant :='
        );
        v_rewritten := pg_catalog.substr(v_rewritten, 1, v_block_start - 1)
            || v_new_block
            || pg_catalog.substr(v_rewritten, v_block_end);
        IF v_rewritten = v_definition
           OR pg_catalog.strpos(v_rewritten, 'v_partial_source_followers_operation TEXT') = 0
           OR pg_catalog.strpos(v_rewritten, 'v_partial_source_following_operation TEXT') = 0
           OR pg_catalog.strpos(v_rewritten, 'v_partial_current_followers_operation TEXT') = 0
           OR pg_catalog.strpos(v_rewritten, 'v_partial_current_following_operation TEXT') = 0
           OR pg_catalog.strpos(v_rewritten, 'source_run.input_hash = v_partial_source_followers_input') = 0
           OR pg_catalog.strpos(v_rewritten, 'source_run.input_hash = v_partial_source_following_input') = 0
           OR pg_catalog.strpos(v_rewritten, 'adoption.operation_key = v_partial_current_following_operation') = 0
           OR pg_catalog.strpos(v_rewritten, 'adoption.destination_input_hash = v_partial_current_following_input') = 0
           OR pg_catalog.strpos(v_rewritten, 'v_fulfillment.attempt_count = 2') = 0
           OR pg_catalog.strpos(v_rewritten, 'v_preflight.idempotency_key IS NOT DISTINCT FROM (v_base_preflight_key || ''.r1'')') = 0
           OR pg_catalog.strpos(v_rewritten, 'COALESCE(v_partial_source_topology_valid') = 0
           OR pg_catalog.strpos(v_rewritten, 'COALESCE(v_partial_adoption_topology_valid') = 0
           OR pg_catalog.strpos(v_rewritten, 'adoption.source_request_id IS DISTINCT FROM v_lineage.failed_request_id') = 0
           OR pg_catalog.strpos(v_rewritten, 'public.analysis_v2_valid_recovery_adoption_preflights(') = 0
           OR pg_catalog.strpos(v_rewritten, 'v_fulfillment.attempt_count <> 5 AND NOT v_partial_adoption_variant') = 0
           OR pg_catalog.strpos(v_rewritten, 'run.request_id = v_request.id') = 0
           OR pg_catalog.strpos(
                v_rewritten,
                'WHERE earlybird_order.id = p_order_id FOR UPDATE;'
           ) = 0
           OR (
                pg_catalog.length(v_rewritten)
                - pg_catalog.length(pg_catalog.replace(
                    v_rewritten, v_fulfillment_lock_marker, ''
                ))
           ) <> 2 * pg_catalog.length(v_fulfillment_lock_marker)
           OR pg_catalog.strpos(
                v_rewritten,
                'WHERE request.id = p_expected_failed_request_id FOR UPDATE;'
           ) = 0
           OR pg_catalog.strpos(
                v_rewritten,
                'WHERE preflight.id = v_order.preflight_id FOR UPDATE;'
           ) = 0
           OR pg_catalog.strpos(v_rewritten, v_audit_replay_marker) = 0
           OR pg_catalog.strpos(v_rewritten, v_audit_return_marker) = 0
           OR pg_catalog.strpos(
                v_rewritten,
                'INSERT INTO public.earlybird_adoption_policy_failure_rearms('
           ) = 0
           OR pg_catalog.strpos(
                v_rewritten,
                'v_request.idempotency_key IS DISTINCT FROM'
           ) = 0
           OR pg_catalog.strpos(v_rewritten, 'family_preflight.idempotency_key') = 0
           OR pg_catalog.md5(pg_catalog.substr(
                v_rewritten, v_block_start, pg_catalog.length(v_new_block)
           )) <> pg_catalog.md5(v_new_block) THEN
            RAISE EXCEPTION 'EARLYBIRD_PARTIAL_ADOPTION_TOPOLOGY_REWRITE_MISMATCH';
        END IF;
    END IF;

    EXECUTE v_rewritten;
    SELECT
        proc.prosecdef,
        COALESCE('search_path=""' = ANY(proc.proconfig), FALSE)
    INTO v_security_definer, v_safe_search_path
    FROM pg_catalog.pg_proc AS proc
    WHERE proc.oid = v_signature::pg_catalog.regprocedure;
    IF NOT COALESCE(v_security_definer, FALSE)
       OR NOT COALESCE(v_safe_search_path, FALSE) THEN
        RAISE EXCEPTION
            'EARLYBIRD_PARTIAL_ADOPTION_TOPOLOGY_SAFETY_SHAPE_MISMATCH';
    END IF;
END;
$migration$;

REVOKE ALL ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

DO $guard$
DECLARE
    v_signature TEXT :=
        'public.rearm_earlybird_zero_spend_adoption_policy_failure('
        || 'uuid,uuid,timestamp with time zone)';
BEGIN
    IF EXISTS (
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
       OR NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'EARLYBIRD_PARTIAL_ADOPTION_TOPOLOGY_ACL_MISMATCH';
    END IF;
END;
$guard$;

COMMIT;
