BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Sibling jobs on an active request can commit independent attempts and
-- checkpoints together. Shared parent locks still fence status changes and
-- deletion. We continue to serialize late telemetry for closed requests:
-- their cost rollup recomputes the entire request before upserting.
DO $migration$
DECLARE
    v_reserve CONSTANT REGPROCEDURE :=
        'public.reserve_analysis_v2_ai_attempt(uuid,text,uuid,text,smallint,uuid,jsonb)';
    v_inner CONSTANT REGPROCEDURE :=
        'public.analysis_v2_terminalize_ai_attempt_internal(uuid,text,uuid,text,smallint,uuid,text,jsonb)';
    v_outer CONSTANT REGPROCEDURE :=
        'public.terminalize_analysis_v2_ai_attempt_with_result(uuid,text,uuid,text,smallint,uuid,jsonb,jsonb,jsonb,text,text)';
    v_old_parents CONSTANT TEXT := $parents$    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND OR v_request.pipeline_version IS DISTINCT FROM 'v2' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_INVALID',
            ERRCODE = 'P0001';
    END IF;$parents$;
    v_new_parents CONSTANT TEXT := $parents$    -- Probe without locks. An active request can close before we acquire
    -- the shared locks. In that case roll back the subtransaction before
    -- entering the original exclusive path, so siblings never upgrade locks.
    IF EXISTS (
        SELECT 1 FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.pipeline_version = 'v2'
          AND analysis_request.status IN ('pending', 'processing')
    ) THEN
        BEGIN
            PERFORM 1
            FROM public.analysis_preflights AS preflight
            WHERE preflight.consumed_request_id = p_request_id
            FOR SHARE;

            SELECT analysis_request.*
            INTO v_request
            FROM public.analysis_requests AS analysis_request
            WHERE analysis_request.id = p_request_id
            FOR SHARE;
            IF NOT FOUND
               OR v_request.pipeline_version IS DISTINCT FROM 'v2'
               OR v_request.status NOT IN ('pending', 'processing') THEN
                RAISE SQLSTATE 'PVA01';
            END IF;
            v_shared_parents_locked := TRUE;
        EXCEPTION WHEN SQLSTATE 'PVA01' THEN
            NULL;
        END;
    END IF;

    IF NOT v_shared_parents_locked THEN
        PERFORM 1
        FROM public.analysis_preflights AS preflight
        WHERE preflight.consumed_request_id = p_request_id
        FOR UPDATE;

        SELECT analysis_request.*
        INTO v_request
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
        FOR UPDATE;
        IF NOT FOUND OR v_request.pipeline_version IS DISTINCT FROM 'v2' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_INVALID',
                ERRCODE = 'P0001';
        END IF;
    END IF;$parents$;
    v_job_lock CONSTANT TEXT :=
        E'      AND job.job_key = p_job_key\n    FOR UPDATE;';
    v_attempt_lock CONSTANT TEXT :=
        E'      AND ai_attempt.attempt = p_attempt\n    FOR UPDATE;';
    v_previous_attempt_lock CONSTANT TEXT :=
        E'          AND ai_attempt.attempt = p_attempt - 1\n        FOR UPDATE;';
    v_reservation_insert CONSTANT TEXT := $insert$    RETURNING * INTO v_existing;

    RETURN public.analysis_v2_ai_attempt_json(v_existing)
        || pg_catalog.jsonb_build_object('created', TRUE);$insert$;
    v_reservation_unique_insert CONSTANT TEXT := $insert$    ON CONFLICT (request_id, operation_key, attempt) DO NOTHING
    RETURNING * INTO v_existing;
    IF NOT FOUND THEN
        -- Independent jobs can race for the request-wide operation key. The
        -- existing job fence serialized same-job redelivery before this insert.
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    RETURN public.analysis_v2_ai_attempt_json(v_existing)
        || pg_catalog.jsonb_build_object('created', TRUE);$insert$;
    v_outer_request_lock CONSTANT TEXT :=
        E'    WHERE analysis_request.id = p_request_id\n    FOR UPDATE;';
    v_body TEXT;
    v_definition TEXT;
BEGIN
    SELECT prosrc INTO STRICT v_body FROM pg_catalog.pg_proc WHERE oid = v_reserve;
    IF pg_catalog.md5(v_body) = 'a6c4d0bb9ddfc48b7da576e587fb548d' THEN
        v_definition := pg_catalog.pg_get_functiondef(v_reserve);
        -- Replay of an existing intent is read-only. A new intent can only
        -- be inserted for an active parent, so late rollups need no fallback.
        v_definition := pg_catalog.replace(
            v_definition, v_old_parents, pg_catalog.replace(v_old_parents, 'FOR UPDATE', 'FOR SHARE')
        );
        v_definition := pg_catalog.replace(
            v_definition, v_job_lock, pg_catalog.replace(v_job_lock, 'FOR UPDATE', 'FOR NO KEY UPDATE')
        );
        v_definition := pg_catalog.replace(
            v_definition, v_attempt_lock, pg_catalog.replace(v_attempt_lock, 'FOR UPDATE', 'FOR NO KEY UPDATE')
        );
        v_definition := pg_catalog.replace(
            v_definition, v_previous_attempt_lock, pg_catalog.replace(v_previous_attempt_lock, 'FOR UPDATE', 'FOR NO KEY UPDATE')
        );
        v_definition := pg_catalog.replace(v_definition, v_reservation_insert, v_reservation_unique_insert);
        EXECUTE v_definition;
        SELECT prosrc INTO STRICT v_body FROM pg_catalog.pg_proc WHERE oid = v_reserve;
    END IF;
    IF pg_catalog.md5(v_body) <> 'e08470267e1a5de42874547f795a5ab0' THEN
        RAISE EXCEPTION 'ANALYSIS_V2_AI_RESULT_PARENT_LOCK_DRIFT: %', v_reserve;
    END IF;

    SELECT prosrc INTO STRICT v_body FROM pg_catalog.pg_proc WHERE oid = v_inner;
    IF pg_catalog.md5(v_body) = '51bb7936a3faf6714785ace5495ef958' THEN
        v_definition := pg_catalog.pg_get_functiondef(v_inner);
        v_definition := pg_catalog.replace(v_definition, v_old_parents, v_new_parents);
        v_definition := pg_catalog.replace(
            v_definition,
            E'    v_terminalized_at TIMESTAMP WITH TIME ZONE;\nBEGIN',
            E'    v_terminalized_at TIMESTAMP WITH TIME ZONE;\n    v_shared_parents_locked BOOLEAN := FALSE;\nBEGIN'
        );
        v_definition := pg_catalog.replace(
            v_definition, v_job_lock, pg_catalog.replace(v_job_lock, 'FOR UPDATE', 'FOR NO KEY UPDATE')
        );
        v_definition := pg_catalog.replace(
            v_definition, v_attempt_lock, pg_catalog.replace(v_attempt_lock, 'FOR UPDATE', 'FOR NO KEY UPDATE')
        );
        EXECUTE v_definition;
        SELECT prosrc INTO STRICT v_body FROM pg_catalog.pg_proc WHERE oid = v_inner;
    END IF;
    IF pg_catalog.md5(v_body) <> 'a9365caa2f1a6592ae365057a34f3c7e' THEN
        RAISE EXCEPTION 'ANALYSIS_V2_AI_RESULT_PARENT_LOCK_DRIFT: %', v_inner;
    END IF;

    SELECT prosrc INTO STRICT v_body FROM pg_catalog.pg_proc WHERE oid = v_outer;
    IF pg_catalog.md5(v_body) = '8db025dbfe934b48b43230d5d85406e3' THEN
        -- The inner call keeps its parent and job locks through this write.
        v_definition := pg_catalog.pg_get_functiondef(v_outer);
        v_definition := pg_catalog.replace(
            v_definition, v_outer_request_lock, pg_catalog.replace(v_outer_request_lock, 'FOR UPDATE', 'FOR SHARE')
        );
        v_definition := pg_catalog.replace(
            v_definition, v_job_lock, pg_catalog.replace(v_job_lock, 'FOR UPDATE', 'FOR NO KEY UPDATE')
        );
        EXECUTE v_definition;
        SELECT prosrc INTO STRICT v_body FROM pg_catalog.pg_proc WHERE oid = v_outer;
    END IF;
    IF pg_catalog.md5(v_body) <> '3713f5d27ce1667afa48c157a179ce53' THEN
        RAISE EXCEPTION 'ANALYSIS_V2_AI_RESULT_PARENT_LOCK_DRIFT: %', v_outer;
    END IF;
END;
$migration$;

COMMIT;
