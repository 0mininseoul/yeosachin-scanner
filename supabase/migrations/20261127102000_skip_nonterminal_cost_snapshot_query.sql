BEGIN;
SET LOCAL lock_timeout = '5s';

-- The snapshot has always captured only completed/failed requests. Avoid planning
-- the multi-ledger rollup for each active receipt; budget enforcement and the
-- original terminal filter, late reconciliation and pre-purge capture stay in place.
DO $migration$
DECLARE
    fn constant regprocedure := 'public.analysis_v2_refresh_cost_rollup_snapshot(uuid)'::regprocedure;
    source_before constant text := 'IF p_request_id IS NULL THEN';
    source_after constant text := $guard$IF p_request_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.analysis_requests AS request
        WHERE request.id = p_request_id AND request.status IN ('completed', 'failed')
    ) THEN$guard$;
    definition text;
    digest text;
BEGIN
    SELECT pg_get_functiondef(oid), md5(prosrc) INTO STRICT definition, digest
    FROM pg_proc WHERE oid=fn;
    IF digest = '41912ba04607ecb311b43b0fb2a084db' THEN RETURN; END IF;
    IF digest <> 'e011bd00321f579c2ab8d473a64dacfd' THEN
        RAISE EXCEPTION 'Unexpected cost snapshot definition';
    END IF;
    EXECUTE replace(definition, source_before, source_after);
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=fn) <> '41912ba04607ecb311b43b0fb2a084db' THEN
        RAISE EXCEPTION 'Unexpected cost snapshot change';
    END IF;
END;
$migration$;
COMMIT;
