-- The cutoff RPC (including its multi-request recovery caller) takes the pool
-- lock before locking a request. Do not hold a request lock while waiting for
-- that same pool: progress, dispatch and operation claims also lock this row.
DO $migration$
DECLARE
    scheduler regprocedure := 'public.acquire_analysis_v2_scheduler_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)'::regprocedure;
    pool_lock CONSTANT text := $lock$    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-v2-gemini-leases', 0)
    );

$lock$;
    request_read CONSTANT text := '    SELECT request.* INTO v_request';
    body text;
    normalized text;
BEGIN
    SELECT prosrc INTO STRICT body FROM pg_catalog.pg_proc WHERE oid = scheduler;
    -- The approved Dev override changes exactly one stage ceiling (3 -> 6).
    -- Normalize it only for drift detection; execute the original definition.
    normalized := pg_catalog.replace(body, 'WHEN ''featureAnalysis'' THEN 6', 'WHEN ''featureAnalysis'' THEN 3');
    IF pg_catalog.md5(normalized) = 'a0d76e8c1b98358f8fe637bd67f41fc0' THEN
        RETURN;
    END IF;
    IF pg_catalog.md5(normalized) <> '5e2f12647cca736508cb156103430a18' THEN
        RAISE EXCEPTION 'ANALYSIS_V2_SCHEDULER_GEMINI_LOCK_ORDER_DRIFT';
    END IF;
    EXECUTE pg_catalog.replace(
        pg_catalog.replace(pg_catalog.pg_get_functiondef(scheduler), pool_lock, ''),
        request_read, pool_lock || request_read
    );
END;
$migration$;
