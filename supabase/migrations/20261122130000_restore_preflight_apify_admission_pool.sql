-- Use the allocator's free-account policy at the preflight admission boundary.
-- Keep the paid path and the lease recovery logic of the installed RPC intact.
DO $migration$
DECLARE
    admission CONSTANT regprocedure :=
        'public.acquire_analysis_provider_admission(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)'::regprocedure;
    legacy_guard CONSTANT text := $old$IF p_workload_role = 'preflight'
       AND (p_logical_provider <> 'apify'
            OR p_credential_slot NOT IN ('primary', 'quinary', 'senary')) THEN$old$;
    pool_guard CONSTANT text := $new$IF p_workload_role = 'preflight'
       AND (p_logical_provider <> 'apify'
            OR NOT public.analysis_beta_valid_apify_credential_slot(p_credential_slot)) THEN$new$;
    definition text := pg_catalog.pg_get_functiondef(admission);
    legacy_matches integer := pg_catalog.cardinality(pg_catalog.string_to_array(definition, legacy_guard)) - 1;
    pool_matches integer := pg_catalog.cardinality(pg_catalog.string_to_array(definition, pool_guard)) - 1;
BEGIN
    IF legacy_matches = 1 AND pool_matches = 0 THEN
        EXECUTE pg_catalog.replace(definition, legacy_guard, pool_guard);
    ELSIF legacy_matches <> 0 OR pool_matches <> 1 THEN
        RAISE EXCEPTION 'ANALYSIS_PREFLIGHT_APIFY_ADMISSION_GUARD_DRIFT';
    END IF;
END;
$migration$;
