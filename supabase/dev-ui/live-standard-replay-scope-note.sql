-- Registered Dev only. Install after live-standard-archive-evidence.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF pg_catalog.to_regclass('dev_live_budget.standard_archive_replay_grants') IS NULL
       OR pg_catalog.to_regprocedure('dev_live_budget.standard_archive_source_request(uuid)') IS NULL
       OR pg_catalog.to_regprocedure('public.analysis_v2_assert_result_job_fence(uuid,text,uuid,text)') IS NULL THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_WRONG_DATABASE';
    END IF;
END;
$$;

-- The normal AI working set is purged at publication. Retain only the three
-- aggregate counts with the owned result and cascade when the request is deleted.
CREATE TABLE IF NOT EXISTS dev_live_budget.standard_replay_scope_notes (
    request_id uuid PRIMARY KEY REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    added smallint NOT NULL CHECK (added BETWEEN 0 AND 10),
    removed smallint NOT NULL CHECK (removed BETWEEN 0 AND 10),
    unverified smallint NOT NULL CHECK (unverified BETWEEN 0 AND 10),
    CHECK (added + unverified <= 10 AND removed + unverified <= 10)
);
REVOKE ALL ON dev_live_budget.standard_replay_scope_notes FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_dev_standard_replay_scope_note_v1(
    p_request_id uuid, p_claim_token uuid, p_job_input_hash text,
    p_added integer, p_removed integer, p_unverified integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    previous dev_live_budget.standard_replay_scope_notes%ROWTYPE;
BEGIN
    PERFORM public.analysis_v2_assert_result_job_fence(
        p_request_id, 'track:reverse-likes:collect', p_claim_token, p_job_input_hash
    );
    IF dev_live_budget.standard_archive_source_request(p_request_id) IS NULL
       OR p_added IS NULL OR p_removed IS NULL OR p_unverified IS NULL
       OR p_added NOT BETWEEN 0 AND 10 OR p_removed NOT BETWEEN 0 AND 10 OR p_unverified NOT BETWEEN 0 AND 10
       OR p_added + p_unverified > 10 OR p_removed + p_unverified > 10 THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_UNAVAILABLE';
    END IF;
    SELECT * INTO previous FROM dev_live_budget.standard_replay_scope_notes WHERE request_id = p_request_id;
    IF FOUND THEN
        IF ROW(previous.added, previous.removed, previous.unverified) IS DISTINCT FROM ROW(p_added, p_removed, p_unverified) THEN
            RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_UNAVAILABLE';
        END IF;
    ELSE
        -- Pin an exact match as well: a redelivery cannot replace it with a different scope.
        INSERT INTO dev_live_budget.standard_replay_scope_notes (request_id, added, removed, unverified)
        VALUES (p_request_id, p_added, p_removed, p_unverified);
    END IF;
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.read_dev_standard_replay_scope_note_v1(p_request_id uuid, p_user_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT pg_catalog.jsonb_build_object('added', note.added, 'removed', note.removed, 'unverified', note.unverified)
    FROM dev_live_budget.standard_replay_scope_notes AS note
    JOIN public.analysis_requests AS request ON request.id = note.request_id
    WHERE note.added + note.removed + note.unverified > 0
      AND request.id = p_request_id AND request.user_id = p_user_id
      AND request.status = 'completed' AND request.pipeline_version = 'v2'
      AND request.selected_plan_id_snapshot = 'standard' AND request.plan_access_mode_snapshot = 'test_entitlement';
$$;
REVOKE ALL ON FUNCTION public.checkpoint_dev_standard_replay_scope_note_v1(uuid,uuid,text,integer,integer,integer),
    public.read_dev_standard_replay_scope_note_v1(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_dev_standard_replay_scope_note_v1(uuid,uuid,text,integer,integer,integer),
    public.read_dev_standard_replay_scope_note_v1(uuid,uuid) TO service_role;
COMMIT;
