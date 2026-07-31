-- The finalizer still pins the first relative-risk policy even though the
-- scoring checkpoints and final-stage manifest carry the request's immutable
-- risk-policy snapshot. Accept only the deployed policy lineage and persist
-- the exact request policy in the owner-facing result summary.

DO $migration$
DECLARE
    v_function CONSTANT pg_catalog.regprocedure :=
        'public.analysis_v2_complete_result_and_purge_internal(uuid,text,uuid,text,text)'
            ::pg_catalog.regprocedure;
    v_definition TEXT;
    v_function_oid OID;
    v_owner OID;
    v_acl ACLITEM[];
    v_old_gate CONSTANT TEXT :=
        $fragment$v_request.policy_versions_snapshot->>'risk' <> 'risk-policy-v2.3'$fragment$;
    v_new_gate CONSTANT TEXT :=
        $fragment$(v_request.policy_versions_snapshot->>'risk' IS NULL OR v_request.policy_versions_snapshot->>'risk' NOT IN ('risk-policy-v2.3', 'risk-policy-v2.4', 'risk-policy-v2.5'))$fragment$;
    v_old_summary CONSTANT TEXT :=
        $fragment$v_request.exclusion_decision_snapshot = 'exclude', 'risk-policy-v2.3',$fragment$;
    v_new_summary CONSTANT TEXT :=
        $fragment$v_request.exclusion_decision_snapshot = 'exclude',
        v_request.policy_versions_snapshot->>'risk',$fragment$;
    v_count INTEGER;
BEGIN
    SELECT proc.oid, proc.proowner, proc.proacl, pg_catalog.pg_get_functiondef(proc.oid)
    INTO v_function_oid, v_owner, v_acl, v_definition
    FROM pg_catalog.pg_proc AS proc
    WHERE proc.oid = v_function;

    IF v_function_oid IS NULL
       OR pg_catalog.strpos(v_definition, 'SECURITY DEFINER') = 0
       OR pg_catalog.strpos(v_definition, $fragment$SET search_path TO ''$fragment$) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_FINALIZER_RISK_POLICY_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    v_count := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(v_definition, v_old_gate, ''))
    ) / pg_catalog.length(v_old_gate);
    IF v_count <> 1 OR pg_catalog.strpos(v_definition, v_new_gate) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_FINALIZER_RISK_POLICY_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    v_count := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(v_definition, v_old_summary, ''))
    ) / pg_catalog.length(v_old_summary);
    IF v_count <> 1 OR pg_catalog.strpos(v_definition, v_new_summary) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_FINALIZER_RISK_POLICY_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    v_definition := pg_catalog.replace(v_definition, v_old_gate, v_new_gate);
    v_definition := pg_catalog.replace(v_definition, v_old_summary, v_new_summary);
    EXECUTE v_definition;

    SELECT pg_catalog.pg_get_functiondef(proc.oid) INTO v_definition
    FROM pg_catalog.pg_proc AS proc
    WHERE proc.oid = v_function
      AND proc.oid = v_function_oid
      AND proc.proowner = v_owner
      AND proc.prosecdef
      AND proc.proconfig = ARRAY['search_path=""']
      AND proc.proacl IS NOT DISTINCT FROM v_acl;

    IF v_definition IS NULL
       OR pg_catalog.strpos(v_definition, v_old_gate) > 0
       OR pg_catalog.strpos(v_definition, v_old_summary) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_FINALIZER_RISK_POLICY_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    v_count := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(v_definition, v_new_gate, ''))
    ) / pg_catalog.length(v_new_gate);
    IF v_count <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_FINALIZER_RISK_POLICY_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    v_count := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(v_definition, v_new_summary, ''))
    ) / pg_catalog.length(v_new_summary);
    IF v_count <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_FINALIZER_RISK_POLICY_DRIFT',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;
