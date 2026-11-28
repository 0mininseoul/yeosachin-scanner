BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Paid Plus uses the same dispatch, cancellation and audit fences as Standard.
DO $share_plus$
DECLARE
    definition text := pg_get_functiondef(
        'public.mark_analysis_v2_job_dispatched_v2(uuid,text,integer,uuid,text,text,smallint)'::regprocedure
    );
    standard_only constant text := 'r.selected_plan_id_snapshot = ''standard'' AND r.test_entitlement_jti_hash IS NULL';
    shared_plans constant text := 'r.selected_plan_id_snapshot IN (''standard'', ''plus'') AND r.test_entitlement_jti_hash IS NULL';
BEGIN
    IF cardinality(string_to_array(definition, standard_only)) <> 2
       OR strpos(definition, 'PERFORM public.lock_analysis_v2_dispatch_parents(p_request_id);') = 0
       OR strpos(definition, 'IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(p_request_id::text, 0)) THEN') = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_ACTIVE_PLUS_MARK_FUNCTION_DRIFT';
    END IF;
    EXECUTE replace(definition, standard_only, shared_plans);
END;
$share_plus$;

COMMIT;
