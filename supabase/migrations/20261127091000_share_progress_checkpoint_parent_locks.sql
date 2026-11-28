BEGIN;
SET LOCAL lock_timeout = '5s';

-- Both layers only read the preflight and request to fence the progress write.
-- Keep the job, snapshot and event locks exclusive, including the bootstrap insert.
DO $progress$
DECLARE
    fn record;
    definition text;
    body_hash text;
BEGIN
    FOR fn IN SELECT * FROM (VALUES
        ('public.checkpoint_analysis_v2_progress', '685d55e4695a78d838da324b918d1497', '86563829dcf171d824a6aaccd0105036'),
        ('public.checkpoint_analysis_v2_progress_v1', '279358a7e8eeb3a1206f32a75c18853a', '733967606144291300a31b4e869ca21a')
    ) AS expected(name, before_hash, after_hash)
    LOOP
        SELECT pg_get_functiondef(p.oid), md5(p.prosrc) INTO STRICT definition, body_hash
        FROM pg_proc p WHERE p.oid = (fn.name || '(uuid,text,uuid,text,text,integer,boolean,jsonb,jsonb,jsonb,text,jsonb,text)')::regprocedure;
        IF body_hash = fn.after_hash THEN CONTINUE; END IF;
        IF body_hash <> fn.before_hash THEN RAISE EXCEPTION 'Unexpected progress function definition for %', fn.name; END IF;
        definition := regexp_replace(definition,
            '(WHERE preflight[.]consumed_request_id = (\$1|p_request_id)[[:space:]]+)FOR UPDATE', '\1FOR SHARE');
        definition := regexp_replace(definition,
            '(WHERE analysis_request[.]id = (\$1|p_request_id)[[:space:]]+)FOR UPDATE', '\1FOR SHARE');
        EXECUTE definition;
        IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = (fn.name || '(uuid,text,uuid,text,text,integer,boolean,jsonb,jsonb,jsonb,text,jsonb,text)')::regprocedure)
            IS DISTINCT FROM fn.after_hash THEN RAISE EXCEPTION 'Unexpected progress lock change for %', fn.name; END IF;
    END LOOP;
END;
$progress$;
COMMIT;
