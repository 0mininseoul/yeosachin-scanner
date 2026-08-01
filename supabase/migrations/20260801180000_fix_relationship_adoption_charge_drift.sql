-- A reconciled provider run's max charge is immutable source audit data. A
-- destination relationship identity may have a different deterministic cap
-- after an admitted count drift, so only the cross-preflight resolver may use
-- the source cap while retaining its reconciled-usage invariant.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $resolver_patch$
DECLARE
    v_signature TEXT :=
        'public.resolve_analysis_v2_recovery_provider_run('
        || 'uuid,text,uuid,text,text,text,text,text,numeric)';
    v_exact_signature TEXT :=
        'public.resolve_analysis_v2_exact_recovery_provider_run('
        || 'uuid,text,uuid,text,text,text,text,text,numeric)';
    v_definition TEXT;
    v_exact_definition TEXT;
    v_rewritten TEXT;
    v_security_definer BOOLEAN;
    v_safe_search_path BOOLEAN;
    v_expected_old_definition_hash CONSTANT TEXT :=
        '046d6ba9df0c23106151db6d5e2afb8d';
    v_expected_new_definition_hash CONSTANT TEXT :=
        '1486eec1954681d6da029172d1976d2e';
    v_old_source_cap TEXT :=
        '      AND source_run.max_charge_usd = p_max_charge_usd';
    v_new_source_cap TEXT :=
        '      AND source_run.actual_usage_usd '
        || '<= source_run.max_charge_usd + 0.000000001' || pg_catalog.chr(10)
        || '      AND source_run.actual_usage_usd '
        || '<= p_max_charge_usd + 0.000000001';
    v_old_initial_cap TEXT :=
        '              AND initial_run.max_charge_usd = p_max_charge_usd';
    v_new_initial_cap TEXT :=
        '              AND initial_run.actual_usage_usd '
        || '<= initial_run.max_charge_usd + 0.000000001' || pg_catalog.chr(10)
        || '              AND initial_run.actual_usage_usd '
        || '<= p_max_charge_usd + 0.000000001';
BEGIN
    SELECT pg_catalog.pg_get_functiondef(proc.oid), proc.prosecdef,
        COALESCE('search_path=""' = ANY(proc.proconfig), FALSE)
    INTO v_definition, v_security_definer, v_safe_search_path
    FROM pg_catalog.pg_proc AS proc
    WHERE proc.oid = v_signature::pg_catalog.regprocedure;
    v_exact_definition := pg_catalog.pg_get_functiondef(
        v_exact_signature::pg_catalog.regprocedure
    );
    IF NOT COALESCE(v_security_definer, FALSE)
       OR NOT COALESCE(v_safe_search_path, FALSE)
       OR pg_catalog.strpos(v_definition, 'SECURITY DEFINER') = 0
       OR pg_catalog.strpos(v_definition, 'SET search_path TO ''''') = 0
       OR pg_catalog.strpos(v_definition, 'FOR UPDATE;') = 0
       OR pg_catalog.strpos(
            v_definition,
            'WHERE preflight.id = v_failed_request.preflight_id FOR UPDATE;'
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'source_run.operation_key = v_source_operation'
       ) = 0
       OR pg_catalog.strpos(v_definition, 'source_run.input_hash = v_source_input') = 0
       OR pg_catalog.strpos(v_definition, 'source_run.status = ''succeeded''') = 0
       OR pg_catalog.strpos(v_definition, 'source_run.run_id IS NOT NULL') = 0
       OR pg_catalog.strpos(v_definition, 'source_run.actual_usage_usd IS NOT NULL') = 0
       OR pg_catalog.strpos(v_definition, 'source_run.usage_reconciled_at IS NOT NULL') = 0
       OR pg_catalog.strpos(v_definition, 'source_run.logical_provider = p_logical_provider') = 0
       OR pg_catalog.strpos(v_definition, 'source_run.actor_id = p_actor_id') = 0
       OR pg_catalog.strpos(v_definition, 'source_run.credential_slot = p_credential_slot') = 0
       OR pg_catalog.strpos(v_definition, '''maxChargeUsd'', v_source.max_charge_usd') = 0
       OR pg_catalog.strpos(v_definition, 'public.analysis_v2_valid_source_adoption_preflights(') = 0
       OR pg_catalog.strpos(v_definition, 'v_source_preflight.consumed_request_id IS DISTINCT FROM v_failed_request.id') = 0
       OR pg_catalog.strpos(v_exact_definition, 'v_source.max_charge_usd IS DISTINCT FROM p_max_charge_usd') = 0
       OR pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'ANALYSIS_V2_RELATIONSHIP_CHARGE_DRIFT_OLD_SHAPE_MISMATCH';
    END IF;

    IF pg_catalog.strpos(v_definition, v_old_source_cap) = 0
       AND pg_catalog.strpos(v_definition, v_old_initial_cap) = 0
       AND pg_catalog.strpos(v_definition, v_new_source_cap) > 0
       AND pg_catalog.strpos(v_definition, v_new_initial_cap) > 0
       AND pg_catalog.md5(v_definition) = v_expected_new_definition_hash THEN
        v_rewritten := v_definition;
    ELSIF pg_catalog.strpos(v_definition, v_old_source_cap) > 0
       AND pg_catalog.strpos(v_definition, v_old_initial_cap) > 0
       AND pg_catalog.strpos(v_definition, v_new_source_cap) = 0
       AND pg_catalog.strpos(v_definition, v_new_initial_cap) = 0
       AND pg_catalog.md5(v_definition) = v_expected_old_definition_hash THEN
        v_rewritten := pg_catalog.replace(
            v_definition, v_old_source_cap, v_new_source_cap
        );
        v_rewritten := pg_catalog.replace(
            v_rewritten, v_old_initial_cap, v_new_initial_cap
        );
    ELSE
        RAISE EXCEPTION 'ANALYSIS_V2_RELATIONSHIP_CHARGE_DRIFT_BLOCK_MISMATCH';
    END IF;
    IF pg_catalog.strpos(v_rewritten, v_old_source_cap) > 0
       OR pg_catalog.strpos(v_rewritten, v_old_initial_cap) > 0
       OR pg_catalog.strpos(v_rewritten, v_new_source_cap) = 0
       OR pg_catalog.strpos(v_rewritten, v_new_initial_cap) = 0
       OR pg_catalog.strpos(v_rewritten, 'source_run.status = ''succeeded''') = 0
       OR pg_catalog.strpos(v_rewritten, 'source_run.actual_usage_usd IS NOT NULL') = 0
       OR pg_catalog.strpos(v_rewritten, 'source_run.usage_reconciled_at IS NOT NULL') = 0
       OR pg_catalog.strpos(v_rewritten, '''maxChargeUsd'', v_source.max_charge_usd') = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_RELATIONSHIP_CHARGE_DRIFT_REWRITE_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$resolver_patch$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) TO service_role;

DO $existing_audit_table_guard$
DECLARE
    v_table REGCLASS := pg_catalog.to_regclass(
        'public.earlybird_partial_adoption_second_rearms'
    );
    v_shape_valid BOOLEAN;
BEGIN
    IF v_table IS NULL THEN
        RETURN;
    END IF;
    SELECT table_row.relkind = 'r'
       AND table_row.relpersistence = 'p'
       AND table_row.relrowsecurity
       AND table_row.relforcerowsecurity
       AND (
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                attribute.attname,
                pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                attribute.attnotnull,
                pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
            ) ORDER BY attribute.attnum)
            FROM pg_catalog.pg_attribute AS attribute
            LEFT JOIN pg_catalog.pg_attrdef AS default_row
              ON default_row.adrelid = attribute.attrelid
             AND default_row.adnum = attribute.attnum
            WHERE attribute.attrelid = v_table
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
       ) = '[
            ["order_id", "uuid", true, null],
            ["original_failed_request_id", "uuid", true, null],
            ["first_policy_failed_request_id", "uuid", true, null],
            ["second_policy_failed_request_id", "uuid", true, null],
            ["rearmed_preflight_id", "uuid", true, null],
            ["expected_fulfillment_attempt_count", "smallint", true, null],
            ["expected_manual_review_at", "timestamp with time zone", true, null],
            ["created_at", "timestamp with time zone", true, "clock_timestamp()"]
       ]'::JSONB
       AND (
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                pg_catalog.pg_get_constraintdef(constraint_row.oid),
                constraint_row.convalidated,
                constraint_row.condeferrable,
                constraint_row.condeferred
            )
                ORDER BY constraint_row.contype,
                    pg_catalog.pg_get_constraintdef(constraint_row.oid)
            )
            FROM pg_catalog.pg_constraint AS constraint_row
            WHERE constraint_row.conrelid = v_table
       ) = '[
            ["CHECK ((expected_fulfillment_attempt_count = 3))", true, false, false],
            ["FOREIGN KEY (first_policy_failed_request_id) REFERENCES analysis_requests(id) ON DELETE RESTRICT", true, false, false],
            ["FOREIGN KEY (order_id) REFERENCES earlybird_orders(id) ON DELETE RESTRICT", true, false, false],
            ["FOREIGN KEY (original_failed_request_id) REFERENCES analysis_requests(id) ON DELETE RESTRICT", true, false, false],
            ["FOREIGN KEY (rearmed_preflight_id) REFERENCES analysis_preflights(id) ON DELETE RESTRICT", true, false, false],
            ["FOREIGN KEY (second_policy_failed_request_id) REFERENCES analysis_requests(id) ON DELETE RESTRICT", true, false, false],
            ["PRIMARY KEY (order_id)", true, false, false],
            ["UNIQUE (rearmed_preflight_id)", true, false, false],
            ["UNIQUE (second_policy_failed_request_id)", true, false, false]
       ]'::JSONB
       AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_policy AS policy
            WHERE policy.polrelid = v_table
       )
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.aclexplode(COALESCE(
                table_row.relacl,
                pg_catalog.acldefault('r', table_row.relowner)
            )) AS privilege
            WHERE privilege.grantee = 0
       )
       AND NOT EXISTS (
            SELECT 1
            FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
                AS app_role(role_name)
            CROSS JOIN (VALUES
                ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                ('REFERENCES'), ('TRIGGER')
            ) AS table_privilege(privilege_name)
            WHERE pg_catalog.has_table_privilege(
                app_role.role_name, v_table, table_privilege.privilege_name
            )
       )
    INTO v_shape_valid
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid = v_table
      AND table_row.relnamespace = 'public'::pg_catalog.regnamespace;
    IF NOT COALESCE(v_shape_valid, FALSE) THEN
        RAISE EXCEPTION
            'EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_TABLE_SHAPE_MISMATCH';
    END IF;
END;
$existing_audit_table_guard$;

CREATE TABLE IF NOT EXISTS public.earlybird_partial_adoption_second_rearms (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    first_policy_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    second_policy_failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL CHECK (
        expected_fulfillment_attempt_count = 3
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.earlybird_partial_adoption_second_rearms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_partial_adoption_second_rearms FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_partial_adoption_second_rearms
    FROM PUBLIC, anon, authenticated, service_role;

DO $existing_trigger_guard$
DECLARE
    v_signature TEXT :=
        'public.prevent_earlybird_partial_adoption_second_rearm_mutation()';
    v_function REGPROCEDURE := pg_catalog.to_regprocedure(v_signature);
    v_trigger_count BIGINT;
    v_shape_valid BOOLEAN;
BEGIN
    SELECT pg_catalog.count(*) INTO v_trigger_count
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'public.earlybird_partial_adoption_second_rearms'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal;
    IF v_function IS NULL AND v_trigger_count = 0 THEN
        RETURN;
    END IF;
    SELECT function_row.prosecdef
       AND COALESCE('search_path=""' = ANY(function_row.proconfig), FALSE)
       AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
       AND pg_catalog.md5(pg_catalog.pg_get_functiondef(function_row.oid)) =
            'c73d0eefa5cb554572f3d2bd52e1e0f6'
       AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
                function_row.proacl,
                pg_catalog.acldefault('f', function_row.proowner)
            )) AS privilege
            WHERE privilege.grantee = 0
       )
       AND NOT pg_catalog.has_function_privilege('anon', function_row.oid, 'EXECUTE')
       AND NOT pg_catalog.has_function_privilege(
            'authenticated', function_row.oid, 'EXECUTE'
       )
       AND NOT pg_catalog.has_function_privilege(
            'service_role', function_row.oid, 'EXECUTE'
       )
       AND 1 = (
            SELECT pg_catalog.count(*)
            FROM pg_catalog.pg_trigger AS trigger_row
            WHERE trigger_row.tgrelid =
                'public.earlybird_partial_adoption_second_rearms'::pg_catalog.regclass
              AND NOT trigger_row.tgisinternal
              AND trigger_row.tgname =
                'prevent_earlybird_partial_adoption_second_rearm_mutation'
              AND trigger_row.tgfoid = function_row.oid
              AND trigger_row.tgtype = (1 | 2 | 8 | 16)
              AND trigger_row.tgenabled = 'O'
              AND trigger_row.tgnargs = 0
              AND trigger_row.tgqual IS NULL
       )
    INTO v_shape_valid
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;
    IF NOT COALESCE(v_shape_valid, FALSE) OR v_trigger_count <> 1 THEN
        RAISE EXCEPTION
            'EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_TRIGGER_SHAPE_MISMATCH';
    END IF;
END;
$existing_trigger_guard$;

CREATE OR REPLACE FUNCTION public.prevent_earlybird_partial_adoption_second_rearm_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION
    public.prevent_earlybird_partial_adoption_second_rearm_mutation()
    FROM PUBLIC, anon, authenticated, service_role;

DO $trigger$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger AS trigger
        WHERE trigger.tgrelid =
            'public.earlybird_partial_adoption_second_rearms'::pg_catalog.regclass
          AND trigger.tgname =
            'prevent_earlybird_partial_adoption_second_rearm_mutation'
          AND NOT trigger.tgisinternal
    ) THEN
        CREATE TRIGGER prevent_earlybird_partial_adoption_second_rearm_mutation
        BEFORE UPDATE OR DELETE
        ON public.earlybird_partial_adoption_second_rearms
        FOR EACH ROW EXECUTE FUNCTION
            public.prevent_earlybird_partial_adoption_second_rearm_mutation();
    END IF;
END;
$trigger$;

DO $existing_rpc_guard$
DECLARE
    v_signature TEXT :=
        'public.rearm_earlybird_partial_adoption_second_failure('
        || 'uuid,uuid,timestamp with time zone)';
    v_definition TEXT;
    v_security_definer BOOLEAN;
    v_safe_search_path BOOLEAN;
BEGIN
    IF pg_catalog.to_regprocedure(v_signature) IS NOT NULL THEN
        SELECT pg_catalog.pg_get_functiondef(proc.oid), proc.prosecdef,
            COALESCE('search_path=""' = ANY(proc.proconfig), FALSE)
        INTO v_definition, v_security_definer, v_safe_search_path
        FROM pg_catalog.pg_proc AS proc
        WHERE proc.oid = v_signature::pg_catalog.regprocedure;
        IF NOT COALESCE(v_security_definer, FALSE)
           OR NOT COALESCE(v_safe_search_path, FALSE)
           OR pg_catalog.strpos(v_definition, 'v_fulfillment.attempt_count <> 3') = 0
           OR pg_catalog.strpos(v_definition, 'pg_catalog.count(*) = 8') = 0
           OR pg_catalog.strpos(v_definition, 'pg_catalog.count(*) = 1') = 0
           OR pg_catalog.strpos(
                v_definition,
                'WHERE earlybird_order.id = p_order_id FOR UPDATE;'
           ) = 0
           OR pg_catalog.strpos(
                v_definition,
                'WHERE audit.order_id = p_order_id FOR UPDATE;'
           ) = 0
           OR pg_catalog.strpos(
                v_definition,
                'WHERE fulfillment.order_id = p_order_id FOR UPDATE;'
           ) = 0
           OR pg_catalog.strpos(
                v_definition,
                'WHERE request.id = p_expected_failed_request_id FOR UPDATE;'
           ) = 0
           OR pg_catalog.strpos(
                v_definition,
                'WHERE preflight.id = v_order.preflight_id FOR UPDATE;'
           ) = 0
           OR pg_catalog.strpos(v_definition, 'family_preflight.idempotency_key') = 0
           OR pg_catalog.strpos(v_definition, 'public.earlybird_partial_adoption_second_rearms') = 0
           OR pg_catalog.md5(v_definition) <>
                'bfa202272672f2b954ad0eaedcb47cc5'
           OR pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
           OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
           OR NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
            RAISE EXCEPTION 'EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_EXISTING_SHAPE_MISMATCH';
        END IF;
    END IF;
END;
$existing_rpc_guard$;

CREATE OR REPLACE FUNCTION public.rearm_earlybird_partial_adoption_second_failure(
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
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_normalized_preflight public.analysis_preflights%ROWTYPE;
    v_lineage public.earlybird_schema_failure_recoveries%ROWTYPE;
    v_first_audit public.earlybird_adoption_policy_failure_rearms%ROWTYPE;
    v_second_audit public.earlybird_partial_adoption_second_rearms%ROWTYPE;
    v_source_preflight public.analysis_preflights%ROWTYPE;
    v_recovery_preflight public.analysis_preflights%ROWTYPE;
    v_new_preflight_id UUID;
    v_base_preflight_key TEXT;
    v_source_followers_operation TEXT;
    v_source_followers_input TEXT;
    v_source_following_operation TEXT;
    v_source_following_input TEXT;
    v_current_following_operation TEXT;
    v_current_following_input TEXT;
    v_source_topology_valid BOOLEAN;
    v_adoption_topology_valid BOOLEAN;
    v_first_adoption_topology_valid BOOLEAN;
BEGIN
    IF p_order_id IS NULL OR p_expected_failed_request_id IS NULL
       OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;
    SELECT audit.* INTO v_second_audit
    FROM public.earlybird_partial_adoption_second_rearms AS audit
    WHERE audit.order_id = p_order_id FOR UPDATE;
    IF FOUND THEN
        IF v_second_audit.second_policy_failed_request_id
                IS DISTINCT FROM p_expected_failed_request_id
           OR v_second_audit.expected_manual_review_at
                IS DISTINCT FROM p_expected_manual_review_at THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        SELECT fulfillment.* INTO v_fulfillment
        FROM public.earlybird_fulfillments AS fulfillment
        WHERE fulfillment.order_id = p_order_id FOR UPDATE;
        IF v_order.preflight_id IS DISTINCT FROM v_second_audit.rearmed_preflight_id
           OR v_order.status <> 'paid'
           OR v_order.result_request_id IS NOT NULL
           OR v_fulfillment.request_id IS NOT NULL
           OR v_fulfillment.status NOT IN ('admission_pending', 'retryable_failure') THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT p_order_id, v_fulfillment.status,
            v_second_audit.rearmed_preflight_id,
            v_second_audit.second_policy_failed_request_id;
        RETURN;
    END IF;

    SELECT audit.* INTO v_first_audit
    FROM public.earlybird_adoption_policy_failure_rearms AS audit
    WHERE audit.order_id = p_order_id FOR UPDATE;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id FOR UPDATE;
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_expected_failed_request_id FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id FOR UPDATE;
    SELECT lineage.* INTO v_lineage
    FROM public.earlybird_schema_failure_recoveries AS lineage
    WHERE lineage.order_id = p_order_id FOR UPDATE;
    SELECT preflight.* INTO v_recovery_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_lineage.recovery_preflight_id FOR UPDATE;
    SELECT source_preflight.* INTO v_source_preflight
    FROM public.analysis_requests AS source_request
    JOIN public.analysis_preflights AS source_preflight
      ON source_preflight.id = source_request.preflight_id
    WHERE source_request.id = v_lineage.failed_request_id
    FOR UPDATE OF source_preflight;

    v_base_preflight_key := 'earlybird.fulfillment.'
        || pg_catalog.replace(v_order.id::TEXT, '-', '');
    v_normalized_preflight := v_preflight;
    v_normalized_preflight.target_instagram_id := v_order.target_instagram_id;
    v_normalized_preflight.exclusion_decision := v_order.exclusion_decision;
    v_normalized_preflight.excluded_instagram_id := v_order.excluded_instagram_id;

    SELECT identity.operation_key, identity.input_hash
    INTO v_source_followers_operation, v_source_followers_input
    FROM public.analysis_v2_relationship_provider_identity(
        'followers', v_order.target_instagram_id,
        v_source_preflight.admission_target_followers_count,
        v_order.plan_id, FALSE
    ) AS identity;
    SELECT identity.operation_key, identity.input_hash
    INTO v_source_following_operation, v_source_following_input
    FROM public.analysis_v2_relationship_provider_identity(
        'following', v_order.target_instagram_id,
        v_source_preflight.admission_target_following_count,
        v_order.plan_id, FALSE
    ) AS identity;
    SELECT identity.operation_key, identity.input_hash
    INTO v_current_following_operation, v_current_following_input
    FROM public.analysis_v2_relationship_provider_identity(
        'following', v_order.target_instagram_id,
        v_preflight.admission_target_following_count,
        v_order.plan_id, FALSE
    ) AS identity;

    SELECT pg_catalog.count(*) = 8
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key = 'track:relationships:collect'
              AND source_run.operation_key = v_source_followers_operation
              AND source_run.input_hash = v_source_followers_input
              AND source_run.max_charge_usd = 0.198050000000
              AND source_run.actual_usage_usd = 0.163100000000
       ) = 1
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key = 'track:relationships:collect'
              AND source_run.operation_key = v_source_following_operation
              AND source_run.input_hash = v_source_following_input
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
            AND source_run.actual_usage_usd
                <= source_run.max_charge_usd + 0.000000001
       )
    INTO v_source_topology_valid
    FROM public.analysis_v2_provider_runs AS source_run
    WHERE source_run.request_id = v_lineage.failed_request_id;

    SELECT pg_catalog.count(*) = 1
       AND pg_catalog.count(source_run.request_id) = 1
       AND pg_catalog.bool_and(
            adoption.job_key = 'track:relationships:collect'
            AND adoption.source_request_id = v_lineage.failed_request_id
            AND adoption.source_job_key = source_run.job_key
            AND adoption.source_operation_key = v_source_following_operation
            AND source_run.operation_key = v_source_following_operation
            AND source_run.input_hash = v_source_following_input
            AND adoption.operation_key = v_current_following_operation
            AND adoption.destination_input_hash = v_current_following_input
       )
    INTO v_adoption_topology_valid
    FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
    LEFT JOIN public.analysis_v2_provider_runs AS source_run
      ON source_run.request_id = adoption.source_request_id
     AND source_run.job_key = adoption.source_job_key
     AND source_run.operation_key = adoption.source_operation_key
     AND source_run.run_id = adoption.source_run_id
    WHERE adoption.request_id = v_request.id;

    SELECT pg_catalog.count(*) = 3
       AND pg_catalog.count(source_run.request_id) = 3
       AND pg_catalog.bool_and(
            adoption.source_request_id = v_lineage.failed_request_id
            AND adoption.job_key = source_run.job_key
       )
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key = 'track:relationships:collect'
              AND source_run.operation_key = v_source_following_operation
              AND source_run.input_hash = v_source_following_input
              AND adoption.operation_key = v_current_following_operation
              AND adoption.destination_input_hash = v_current_following_input
       ) = 1
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key = 'track:target-evidence:collect'
              AND source_run.operation_key ~ '^target-likers:[0-9a-f]{64}$'
              AND adoption.operation_key = source_run.operation_key
              AND adoption.destination_input_hash = source_run.input_hash
       ) = 1
       AND pg_catalog.count(*) FILTER (
            WHERE source_run.job_key = 'track:target-evidence:collect'
              AND source_run.operation_key ~ '^target-comments:[0-9a-f]{64}$'
              AND adoption.operation_key = source_run.operation_key
              AND adoption.destination_input_hash = source_run.input_hash
       ) = 1
    INTO v_first_adoption_topology_valid
    FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
    LEFT JOIN public.analysis_v2_provider_runs AS source_run
      ON source_run.request_id = adoption.source_request_id
     AND source_run.job_key = adoption.source_job_key
     AND source_run.operation_key = adoption.source_operation_key
     AND source_run.run_id = adoption.source_run_id
    WHERE adoption.request_id = v_first_audit.policy_failed_request_id;

    IF v_first_audit.order_id IS NULL
       OR v_first_audit.original_failed_request_id
            IS DISTINCT FROM v_lineage.failed_request_id
       OR v_first_audit.policy_failed_request_id IS NULL
       OR v_first_audit.rearmed_preflight_id IS DISTINCT FROM v_preflight.id
       OR v_first_audit.expected_fulfillment_attempt_count <> 2
       OR NOT COALESCE(v_first_adoption_topology_valid, FALSE)
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_requests AS first_request
            WHERE first_request.id = v_first_audit.policy_failed_request_id
              AND first_request.user_id = v_order.user_id
              AND first_request.pipeline_version = 'v2'
              AND first_request.status = 'failed'
              AND first_request.error_message = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
              AND first_request.idempotency_key IS NOT DISTINCT FROM
                  ('earlybird:' || pg_catalog.lower(v_order.id::TEXT) || '.r1')
       )
       OR v_order.status <> 'analysis_in_progress'
       OR v_order.result_request_id IS DISTINCT FROM v_request.id
       OR v_order.plan_id <> 'standard'
       OR v_order.target_followers_count <> 235
       OR v_order.target_following_count <> 623
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_fulfillment.status <> 'manual_review'
       OR v_fulfillment.request_id IS DISTINCT FROM v_request.id
       OR v_fulfillment.attempt_count <> 3
       OR v_fulfillment.last_error_code <> 'ANALYSIS_FAILED'
       OR v_fulfillment.manual_review_at IS DISTINCT FROM p_expected_manual_review_at
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status <> 'failed'
       OR v_request.error_message <> 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       OR v_request.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_request.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_request.idempotency_key IS DISTINCT FROM
            ('earlybird:' || pg_catalog.lower(v_order.id::TEXT) || '.r2')
       OR v_preflight.status <> 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_preflight.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_preflight.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_preflight.pii_scrubbed_at IS NULL
       OR v_preflight.exclusion_decision IS DISTINCT FROM 'skip'
       OR v_preflight.excluded_instagram_id IS NOT NULL
       OR v_preflight.idempotency_key IS DISTINCT FROM (v_base_preflight_key || '.r2')
       OR v_preflight.target_followers_count <> 232
       OR v_preflight.target_following_count <> 623
       OR v_preflight.admission_target_followers_count <> 232
       OR v_preflight.admission_target_following_count <> 623
       OR NOT COALESCE(v_source_topology_valid, FALSE)
       OR NOT COALESCE(v_adoption_topology_valid, FALSE)
       OR NOT public.analysis_v2_valid_recovery_adoption_preflights(
            v_order, v_recovery_preflight, v_normalized_preflight
       )
       OR NOT public.analysis_v2_valid_source_adoption_preflights(
            v_order, v_recovery_preflight, v_source_preflight,
            v_normalized_preflight, v_lineage.failed_request_id, v_request.id
       )
       OR 1 <> (
            SELECT pg_catalog.count(*) FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
       )
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
              AND receipt.error_code = v_request.error_message
       )
       OR 3 <> (
            SELECT pg_catalog.count(*) FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
       )
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.job_key = 'coordinator:bootstrap'
              AND job.track = 'coordinator'
              AND job.kind = 'bootstrap'
              AND job.status = 'completed' AND job.attempt_count = 1
              AND job.last_error_code IS NULL
       )
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.job_key = 'track:relationships:collect'
              AND job.track = 'relationships'
              AND job.kind = 'collection'
              AND job.status = 'failed' AND job.attempt_count = 1
              AND job.last_error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       )
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.job_key = 'track:target-evidence:collect'
              AND job.track = 'target_evidence'
              AND job.kind = 'collection'
              AND job.status = 'cancelled' AND job.attempt_count = 0
              AND job.last_error_code = 'REQUEST_TERMINATED'
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_provider_runs AS run
            WHERE run.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_provider_cost_ledger AS cost
            WHERE cost.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_ai_attempts AS attempt
            WHERE attempt.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_relationship_sides AS evidence
            WHERE evidence.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_target_evidence_manifests AS evidence
            WHERE evidence.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_preflights AS family_preflight
            WHERE family_preflight.user_id = v_order.user_id
              AND family_preflight.id <> v_preflight.id
              AND family_preflight.idempotency_key = v_base_preflight_key || '.r3'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    v_new_preflight_id := extensions.gen_random_uuid();
    INSERT INTO public.analysis_preflights(
        id, user_id, idempotency_key, target_instagram_id, status,
        exclusion_decision, excluded_instagram_id, access_mode,
        launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
        pricing_version, pricing_snapshot, policy_versions_snapshot,
        target_followers_count, target_following_count, target_is_private,
        capacity_required_plan_id, required_plan_id, created_at, updated_at,
        expires_at, ready_at
    ) VALUES (
        v_new_preflight_id, v_order.user_id, v_base_preflight_key || '.r3',
        v_order.target_instagram_id, 'ready', v_order.exclusion_decision,
        v_order.excluded_instagram_id, 'production',
        v_preflight.launch_status_snapshot, v_preflight.plan_catalog_snapshot,
        v_preflight.plan_cards_snapshot, v_preflight.pricing_version,
        v_preflight.pricing_snapshot, v_preflight.policy_versions_snapshot,
        v_preflight.target_followers_count, v_preflight.target_following_count,
        FALSE, v_preflight.capacity_required_plan_id, v_preflight.required_plan_id,
        v_now, v_now, v_now + INTERVAL '30 minutes', v_now
    );
    INSERT INTO public.earlybird_partial_adoption_second_rearms(
        order_id, original_failed_request_id, first_policy_failed_request_id,
        second_policy_failed_request_id, rearmed_preflight_id,
        expected_fulfillment_attempt_count, expected_manual_review_at
    ) VALUES (
        v_order.id, v_lineage.failed_request_id,
        v_first_audit.policy_failed_request_id, v_request.id,
        v_new_preflight_id, 3, p_expected_manual_review_at
    );
    UPDATE public.earlybird_orders AS earlybird_order
    SET status = 'paid', preflight_id = v_new_preflight_id,
        result_request_id = NULL, updated_at = v_now
    WHERE earlybird_order.id = v_order.id;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending', request_id = NULL,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = v_now,
        last_error_code = NULL, last_error_at = NULL,
        manual_review_at = NULL, completed_at = NULL, updated_at = v_now
    WHERE fulfillment.order_id = v_order.id;
    RETURN QUERY SELECT v_order.id, 'admission_pending'::TEXT,
        v_new_preflight_id, v_request.id;
END;
$$;

REVOKE ALL ON FUNCTION public.rearm_earlybird_partial_adoption_second_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_partial_adoption_second_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;

DO $final_guard$
DECLARE
    v_resolver_signature TEXT :=
        'public.resolve_analysis_v2_recovery_provider_run('
        || 'uuid,text,uuid,text,text,text,text,text,numeric)';
    v_rearm_signature TEXT :=
        'public.rearm_earlybird_partial_adoption_second_failure('
        || 'uuid,uuid,timestamp with time zone)';
    v_trigger_signature TEXT :=
        'public.prevent_earlybird_partial_adoption_second_rearm_mutation()';
    v_audit_table REGCLASS :=
        'public.earlybird_partial_adoption_second_rearms'::pg_catalog.regclass;
    v_definition TEXT;
    v_table_shape_valid BOOLEAN;
    v_trigger_shape_valid BOOLEAN;
BEGIN
    SELECT table_row.relkind = 'r'
       AND table_row.relpersistence = 'p'
       AND table_row.relrowsecurity
       AND table_row.relforcerowsecurity
       AND (
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                attribute.attname,
                pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                attribute.attnotnull,
                pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
            ) ORDER BY attribute.attnum)
            FROM pg_catalog.pg_attribute AS attribute
            LEFT JOIN pg_catalog.pg_attrdef AS default_row
              ON default_row.adrelid = attribute.attrelid
             AND default_row.adnum = attribute.attnum
            WHERE attribute.attrelid = v_audit_table
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
       ) = '[
            ["order_id", "uuid", true, null],
            ["original_failed_request_id", "uuid", true, null],
            ["first_policy_failed_request_id", "uuid", true, null],
            ["second_policy_failed_request_id", "uuid", true, null],
            ["rearmed_preflight_id", "uuid", true, null],
            ["expected_fulfillment_attempt_count", "smallint", true, null],
            ["expected_manual_review_at", "timestamp with time zone", true, null],
            ["created_at", "timestamp with time zone", true, "clock_timestamp()"]
       ]'::JSONB
       AND (
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                pg_catalog.pg_get_constraintdef(constraint_row.oid),
                constraint_row.convalidated,
                constraint_row.condeferrable,
                constraint_row.condeferred
            )
                ORDER BY constraint_row.contype,
                    pg_catalog.pg_get_constraintdef(constraint_row.oid)
            )
            FROM pg_catalog.pg_constraint AS constraint_row
            WHERE constraint_row.conrelid = v_audit_table
       ) = '[
            ["CHECK ((expected_fulfillment_attempt_count = 3))", true, false, false],
            ["FOREIGN KEY (first_policy_failed_request_id) REFERENCES analysis_requests(id) ON DELETE RESTRICT", true, false, false],
            ["FOREIGN KEY (order_id) REFERENCES earlybird_orders(id) ON DELETE RESTRICT", true, false, false],
            ["FOREIGN KEY (original_failed_request_id) REFERENCES analysis_requests(id) ON DELETE RESTRICT", true, false, false],
            ["FOREIGN KEY (rearmed_preflight_id) REFERENCES analysis_preflights(id) ON DELETE RESTRICT", true, false, false],
            ["FOREIGN KEY (second_policy_failed_request_id) REFERENCES analysis_requests(id) ON DELETE RESTRICT", true, false, false],
            ["PRIMARY KEY (order_id)", true, false, false],
            ["UNIQUE (rearmed_preflight_id)", true, false, false],
            ["UNIQUE (second_policy_failed_request_id)", true, false, false]
       ]'::JSONB
       AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_policy AS policy
            WHERE policy.polrelid = v_audit_table
       )
       AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
                table_row.relacl,
                pg_catalog.acldefault('r', table_row.relowner)
            )) AS privilege
            WHERE privilege.grantee = 0
       )
       AND NOT EXISTS (
            SELECT 1
            FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
                AS app_role(role_name)
            CROSS JOIN (VALUES
                ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
                ('REFERENCES'), ('TRIGGER')
            ) AS table_privilege(privilege_name)
            WHERE pg_catalog.has_table_privilege(
                app_role.role_name,
                v_audit_table,
                table_privilege.privilege_name
            )
       )
    INTO v_table_shape_valid
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid = v_audit_table
      AND table_row.relnamespace = 'public'::pg_catalog.regnamespace;

    SELECT function_row.prosecdef
       AND COALESCE('search_path=""' = ANY(function_row.proconfig), FALSE)
       AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
       AND pg_catalog.md5(pg_catalog.pg_get_functiondef(function_row.oid)) =
            'c73d0eefa5cb554572f3d2bd52e1e0f6'
       AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
                function_row.proacl,
                pg_catalog.acldefault('f', function_row.proowner)
            )) AS privilege
            WHERE privilege.grantee = 0
       )
       AND NOT pg_catalog.has_function_privilege('anon', function_row.oid, 'EXECUTE')
       AND NOT pg_catalog.has_function_privilege(
            'authenticated', function_row.oid, 'EXECUTE'
       )
       AND NOT pg_catalog.has_function_privilege(
            'service_role', function_row.oid, 'EXECUTE'
       )
       AND 1 = (
            SELECT pg_catalog.count(*)
            FROM pg_catalog.pg_trigger AS trigger_row
            WHERE trigger_row.tgrelid = v_audit_table
              AND NOT trigger_row.tgisinternal
              AND trigger_row.tgname =
                'prevent_earlybird_partial_adoption_second_rearm_mutation'
              AND trigger_row.tgfoid = function_row.oid
              AND trigger_row.tgtype = (1 | 2 | 8 | 16)
              AND trigger_row.tgenabled = 'O'
              AND trigger_row.tgnargs = 0
              AND trigger_row.tgqual IS NULL
       )
       AND 1 = (
            SELECT pg_catalog.count(*)
            FROM pg_catalog.pg_trigger AS trigger_row
            WHERE trigger_row.tgrelid = v_audit_table
              AND NOT trigger_row.tgisinternal
       )
    INTO v_trigger_shape_valid
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_trigger_signature::pg_catalog.regprocedure;

    v_definition := pg_catalog.pg_get_functiondef(
        v_rearm_signature::pg_catalog.regprocedure
    );
    IF NOT COALESCE(v_table_shape_valid, FALSE)
       OR NOT COALESCE(v_trigger_shape_valid, FALSE)
       OR pg_catalog.strpos(v_definition, 'SECURITY DEFINER') = 0
       OR pg_catalog.strpos(v_definition, 'SET search_path TO ''''') = 0
       OR pg_catalog.strpos(v_definition, 'FOR UPDATE;') = 0
       OR EXISTS (
            SELECT 1 FROM pg_catalog.pg_proc AS proc
            CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
                proc.proacl, pg_catalog.acldefault('f', proc.proowner)
            )) AS privilege
            WHERE proc.oid IN (
                v_resolver_signature::pg_catalog.regprocedure,
                v_rearm_signature::pg_catalog.regprocedure
            )
              AND privilege.grantee = 0
              AND privilege.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_rearm_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_rearm_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_rearm_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('anon', v_resolver_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_resolver_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_resolver_signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'EARLYBIRD_RELATIONSHIP_CHARGE_DRIFT_FINAL_GUARD_MISMATCH';
    END IF;
END;
$final_guard$;

COMMIT;
