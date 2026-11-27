BEGIN;
SET LOCAL lock_timeout = '5s';

-- Collection workers read the same preflight and request while writing separate jobs.
-- Only the retry reader also pins its order and fulfillment before rebinding a provider run.
-- Keep job, provider run, batch and beta-budget locks in their original modes and order.
DO $collection$
DECLARE
    fn record;
    definition text;
    body_hash text;
BEGIN
    FOR fn IN SELECT * FROM (VALUES
        ('public.checkpoint_analysis_v2_provider_run_started(uuid,text,uuid,text,uuid,text)',
            '075dc4d8a90d76a7af50acd2647f1d0b', 'd5f20e6925108b356c42e8127779d00f'),
        ('public.checkpoint_analysis_v2_provider_run_terminal(uuid,text,uuid,text,uuid,text,text,numeric)',
            '5318c35265ce2c0370417bffb7ba7e64', 'd8b5ab617c07fac7a41e8aab77d96b18'),
        ('public.load_analysis_v2_collection_context_with_policy_v2(uuid,text,uuid,text)',
            '606465be332439b35ba41cc10d3347d8', 'c836342a2e427f6abb44bdcc234a76a3'),
        ('public.load_analysis_v2_profile_fetch_checkpoint(uuid,text,uuid,text)',
            '32108f082d5eb4447ef4451a24e57f16', 'f9420edc254fa174fbcd290e76e6cfec'),
        ('public.load_analysis_v2_profile_fetch_checkpoint_for_retry(uuid,text,uuid,text,text,text)',
            '130b5ae08d7a7cdce89c4f7d4ce3c305', '70e6120ed8661e86c772d7680b78379b')
    ) AS expected(signature, before_hash, after_hash)
    LOOP
        SELECT pg_get_functiondef(oid), md5(prosrc) INTO STRICT definition, body_hash
        FROM pg_proc WHERE oid = fn.signature::regprocedure;
        -- Dev also has a separate owner-grant path with no paid order. Preserve that path's lock.
        IF fn.signature = 'public.load_analysis_v2_profile_fetch_checkpoint_for_retry(uuid,text,uuid,text,text,text)'
           AND body_hash IN ('b7d23df4ba3afdefa07f67e5cd98f1b1', '686706f272053ee40afa5b0cfa296611') THEN
            fn.before_hash := 'b7d23df4ba3afdefa07f67e5cd98f1b1';
            fn.after_hash := '686706f272053ee40afa5b0cfa296611';
        END IF;
        IF body_hash = fn.after_hash THEN CONTINUE; END IF;
        IF body_hash <> fn.before_hash THEN RAISE EXCEPTION 'Unexpected collection checkpoint definition for %', fn.signature; END IF;

        IF fn.before_hash <> 'b7d23df4ba3afdefa07f67e5cd98f1b1' THEN
            definition := regexp_replace(definition,
            '(WHERE preflight[.]consumed_request_id = p_request_id[[:space:]]+)FOR UPDATE', '\1FOR SHARE');
        END IF;
        definition := regexp_replace(definition,
            '(WHERE analysis_request[.]id = p_request_id([[:space:]]+AND analysis_request[.]pipeline_version = ''v2'')?[[:space:]]+)FOR UPDATE', '\1FOR SHARE');
        definition := regexp_replace(definition,
            '(WHERE (fulfillment[.]order_id = v_order_id|earlybird_order[.]id = v_order_id|preflight[.]id = v_order[.]preflight_id)[[:space:]]+)FOR UPDATE', '\1FOR SHARE', 'g');
        EXECUTE definition;
        IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = fn.signature::regprocedure)
            IS DISTINCT FROM fn.after_hash THEN RAISE EXCEPTION 'Unexpected collection lock change for %', fn.signature; END IF;
    END LOOP;
END;
$collection$;
COMMIT;
