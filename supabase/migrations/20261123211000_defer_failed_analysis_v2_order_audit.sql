BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.analysis_order_audit_enqueue_from_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ;
BEGIN
    IF NEW.pipeline_version = 'v2' AND NEW.status = 'failed' THEN
        IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
            RETURN NEW;
        END IF;
        v_now := pg_catalog.clock_timestamp();
        -- Commit only the durable outbox on failure. Keep the source working set
        -- fenced until a later transaction assembles a finalized immutable bundle.
        INSERT INTO public.analysis_order_audit_assembly_queue (
            request_id, status, attempt_count, next_attempt_at,
            purge_fenced_at, purge_fence_reason, updated_at
        ) VALUES (
            NEW.id, 'queued', 0, v_now,
            v_now, 'ANALYSIS_ORDER_AUDIT_FAILURE_DEFERRED', v_now
        )
        ON CONFLICT (request_id) DO UPDATE SET
            status = 'queued',
            next_attempt_at = EXCLUDED.next_attempt_at,
            lease_token = NULL,
            lease_expires_at = NULL,
            purge_fenced_at = EXCLUDED.purge_fenced_at,
            purge_fence_reason = EXCLUDED.purge_fence_reason,
            purged_at = NULL,
            updated_at = EXCLUDED.updated_at;
    ELSIF NEW.pipeline_version = 'v2' AND NEW.status = 'completed' THEN
        -- Preserve the successful publication path and its current audit/purge boundary.
        BEGIN
            PERFORM public.enqueue_analysis_order_audit_bundle(NEW.id);
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING USING MESSAGE = 'ANALYSIS_ORDER_AUDIT_ENQUEUE_FAILED';
        END;
        BEGIN
            PERFORM public.assemble_analysis_order_audit_bundle(NEW.id);
            PERFORM public.analysis_v2_purge_result_working_set(NEW.id, TRUE);
        EXCEPTION WHEN OTHERS THEN
            BEGIN
                PERFORM public.analysis_order_audit_purge_fence(
                    NEW.id, 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED'
                );
            EXCEPTION WHEN OTHERS THEN
                NULL;
            END;
            RAISE WARNING USING MESSAGE = 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED';
        END;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_order_audit_enqueue_from_request()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.analysis_order_audit_finish_fenced_purge(
    p_request_id UUID, p_request_status TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    PERFORM public.analysis_v2_purge_result_working_set(
        p_request_id, p_request_status <> 'failed'
    );
    IF p_request_status = 'failed'
       AND EXISTS (
           SELECT 1 FROM public.analysis_order_audit_assembly_queue AS queue
           WHERE queue.request_id = p_request_id AND queue.purged_at IS NOT NULL
       ) THEN
        -- Scrub only after the immutable audit has captured the original
        -- failure lineage and the purge fence has been satisfied.
        PERFORM public.analysis_v2_scrub_terminal_request_pii(
            p_request_id, pg_catalog.clock_timestamp()
        );
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_order_audit_finish_fenced_purge(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

DO $migration$
DECLARE
    v_fail CONSTANT REGPROCEDURE := 'public.fail_analysis_v2_request_from_job(uuid,text,text)';
    v_assemble CONSTANT REGPROCEDURE := 'public.assemble_analysis_order_audit_bundle(uuid)';
    v_purge_wrapper CONSTANT REGPROCEDURE := 'public.analysis_v2_purge_result_working_set(uuid,boolean)';
    v_fail_cleanup CONSTANT TEXT := E'    PERFORM public.analysis_v2_purge_result_working_set(p_request_id, FALSE);\n'
        || E'    PERFORM public.analysis_v2_scrub_terminal_request_pii(p_request_id, v_now);\n';
    v_purge CONSTANT TEXT := 'PERFORM public.analysis_v2_purge_result_working_set(p_request_id, TRUE);';
    v_async_purge CONSTANT TEXT :=
        'PERFORM public.analysis_order_audit_finish_fenced_purge(p_request_id, v_request.status);';
    v_finalize_guard CONSTANT TEXT := 'IF v_queue_fenced AND v_finalized THEN';
    v_finalized_request_guard CONSTANT TEXT :=
        'IF v_queue_fenced AND v_finalized AND v_request.status IN (''completed'', ''failed'') THEN';
    v_audit_declaration CONSTANT TEXT := E'    v_purge_fenced_at TIMESTAMPTZ;\n';
    v_audit_lock_anchor CONSTANT TEXT :=
        '    -- One request lock covers queue state, source reads, append, and the retry purge fence.';
    v_failure_parent_locks CONSTANT TEXT := $lock$    -- Failed audits may scrub the terminal preflight after assembly. Preserve
    -- the parent lock order of late receipts before the audit lock or queue.
    IF EXISTS (
        SELECT 1 FROM public.analysis_requests AS request
        WHERE request.id = p_request_id AND request.pipeline_version = 'v2'
          AND request.status = 'failed'
    ) THEN
        PERFORM 1 FROM public.analysis_preflights AS preflight
        WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
        PERFORM 1 FROM public.analysis_requests AS request
        WHERE request.id = p_request_id AND request.pipeline_version = 'v2'
          AND request.status = 'failed' FOR UPDATE;
        v_failed_parents_locked := FOUND;
    END IF;

$lock$;
    v_initial_read_end CONSTANT TEXT := E'    IF NOT FOUND THEN\n        RETURN NULL;\n    END IF;\n\n    SELECT bundle.* INTO v_latest';
    v_raced_failure_guard CONSTANT TEXT := $lock$    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF v_request.status = 'failed' AND NOT v_failed_parents_locked THEN
        -- A failure committed between the probe and the audit lock. Let
        -- recovery retry in canonical parent order without upgrading locks.
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_ORDER_AUDIT_FAILURE_REQUEUED', ERRCODE = 'P0001';
    END IF;

    SELECT bundle.* INTO v_latest$lock$;
    v_audit_mutex CONSTANT TEXT := $lock$    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_request_id::TEXT, 0)
    );

$lock$;
    v_purge_status_guard CONSTANT TEXT := $guard$    IF NOT FOUND OR v_request_status NOT IN ('completed', 'failed') THEN
        RETURN;
    END IF;

$guard$;
    v_definition TEXT;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(v_fail);
    IF pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_fail_cleanup, ''))
       <> pg_catalog.length(v_fail_cleanup) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_FAILED_AUDIT_CLEANUP_DRIFT';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_fail_cleanup, '');

    -- Standalone purge callers must take the terminal request lock before
    -- waiting on the same advisory lock as failed audit assembly.
    v_definition := pg_catalog.pg_get_functiondef(v_purge_wrapper);
    IF pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_audit_mutex, ''))
           <> pg_catalog.length(v_audit_mutex)
       OR pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_purge_status_guard, ''))
           <> pg_catalog.length(v_purge_status_guard) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_FAILED_AUDIT_PURGE_LOCK_DRIFT';
    END IF;
    EXECUTE pg_catalog.replace(
        pg_catalog.replace(v_definition, v_audit_mutex, ''),
        v_purge_status_guard,
        v_purge_status_guard || v_audit_mutex
    );

    v_definition := pg_catalog.pg_get_functiondef(v_assemble);
    -- The source-set replay, insert-race, and fresh bundle branches must all
    -- honor the failed working-set purge, with identical immutable identities.
    IF pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_purge, ''))
           <> 3 * pg_catalog.length(v_purge)
       OR pg_catalog.length(v_definition) - pg_catalog.length(pg_catalog.replace(v_definition, v_finalize_guard, ''))
           <> 3 * pg_catalog.length(v_finalize_guard)
       OR pg_catalog.strpos(v_definition, v_audit_declaration) = 0
       OR pg_catalog.strpos(v_definition, v_audit_lock_anchor) = 0
       OR pg_catalog.strpos(v_definition, v_initial_read_end) = 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_FAILED_AUDIT_ASSEMBLER_DRIFT';
    END IF;
    v_definition := pg_catalog.replace(v_definition, v_purge, v_async_purge);
    v_definition := pg_catalog.replace(v_definition, v_finalize_guard, v_finalized_request_guard);
    v_definition := pg_catalog.replace(
        v_definition,
        v_audit_declaration,
        v_audit_declaration || E'    v_failed_parents_locked BOOLEAN := FALSE;\n'
    );
    v_definition := pg_catalog.replace(v_definition, v_audit_lock_anchor, v_failure_parent_locks || v_audit_lock_anchor);
    EXECUTE pg_catalog.replace(v_definition, v_initial_read_end, v_raced_failure_guard);
END;
$migration$;

COMMIT;
