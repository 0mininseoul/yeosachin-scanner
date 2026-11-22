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
    request_read CONSTANT text := $read$    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id
      AND request.pipeline_version = 'v2'
    FOR SHARE;$read$;
    guarded_read CONSTANT text := $guard$    BEGIN
        SELECT request.* INTO v_request
        FROM public.analysis_requests AS request
        WHERE request.id = p_request_id
          AND request.pipeline_version = 'v2'
        FOR SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
        RETURN QUERY SELECT 'capacity_pending'::TEXT, NULL::SMALLINT, NULL::UUID,
                            NULL::BIGINT, NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END;$guard$;
    body text;
    normalized text;
BEGIN
    -- Both DDL installers transform this same definition. Read the committed
    -- function only after the concurrent installer releases the shared lock.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-v2-gemini-leases', 0)
    );
    SELECT prosrc INTO STRICT body FROM pg_catalog.pg_proc WHERE oid = scheduler;
    -- The approved Dev override changes exactly one stage ceiling (3 -> 6).
    -- Normalize it only for drift detection; execute the original definition.
    normalized := pg_catalog.replace(body, 'WHEN ''featureAnalysis'' THEN 6', 'WHEN ''featureAnalysis'' THEN 3');
    IF pg_catalog.md5(normalized) = 'e365d24e0a9d8f446d660934177e01ec' THEN
        RETURN;
    END IF;
    IF pg_catalog.md5(normalized) <> '5e2f12647cca736508cb156103430a18' THEN
        RAISE EXCEPTION 'ANALYSIS_V2_SCHEDULER_GEMINI_LOCK_ORDER_DRIFT';
    END IF;
    EXECUTE pg_catalog.replace(
        pg_catalog.replace(pg_catalog.pg_get_functiondef(scheduler), pool_lock, ''),
        request_read, pool_lock || guarded_read
    );
END;
$migration$;
