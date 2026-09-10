-- Supabase 22 account-deletion contraction wave: additive preparation only.
-- The legacy account_deletion_jobs row remains authoritative. This function is
-- deliberately not called by a migration, backfill, or production canary.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE FUNCTION public.mirror_account_deletion_job_v1(
    p_account_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source public.account_deletion_jobs%ROWTYPE;
    v_existing public.maintenance_jobs%ROWTYPE;
    v_payload JSONB;
    v_target_key_hash TEXT;
    v_content_hash TEXT;
    v_canonical_state TEXT;
    v_final_state TEXT;
    v_final_error_code TEXT;
BEGIN
    IF p_account_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_DELETION_MIRROR_ACCOUNT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT source_job.*
    INTO v_source
    FROM public.account_deletion_jobs AS source_job
    WHERE source_job.account_id = p_account_id
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_DELETION_MIRROR_SOURCE_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    v_target_key_hash := public.canonical_json_hash_v1(
        'account-deletion-target',
        pg_catalog.jsonb_build_object('account_id', p_account_id::TEXT)
    );
    v_canonical_state := CASE
        WHEN v_source.state = 'completed' THEN 'succeeded'
        ELSE 'queued'
    END;
    v_payload := pg_catalog.jsonb_build_object(
        'source_table', 'account_deletion_jobs',
        'source_key_hash', v_target_key_hash,
        'legacy_state', v_source.state,
        'requested_at', pg_catalog.to_char(
            v_source.requested_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'objects_purged_at', CASE
            WHEN v_source.objects_purged_at IS NULL THEN NULL
            ELSE pg_catalog.to_char(
                v_source.objects_purged_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
        END,
        'database_purged_at', CASE
            WHEN v_source.database_purged_at IS NULL THEN NULL
            ELSE pg_catalog.to_char(
                v_source.database_purged_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
        END,
        'completed_at', CASE
            WHEN v_source.completed_at IS NULL THEN NULL
            ELSE pg_catalog.to_char(
                v_source.completed_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
        END,
        'source_updated_at', pg_catalog.to_char(
            v_source.updated_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
    );
    v_content_hash := public.canonical_json_hash_v1(
        'account-deletion-maintenance-content',
        v_payload
    );

    SELECT maintenance_job.*
    INTO v_existing
    FROM public.maintenance_jobs AS maintenance_job
    WHERE maintenance_job.kind = 'purge'
      AND maintenance_job.target_key_hash = v_target_key_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.maintenance_jobs(
            kind,
            target_key_hash,
            state,
            next_attempt_at,
            terminal_at,
            payload,
            content_hash
        ) VALUES (
            'purge',
            v_target_key_hash,
            v_canonical_state,
            v_source.updated_at,
            CASE WHEN v_canonical_state = 'succeeded' THEN v_source.completed_at ELSE NULL END,
            v_payload,
            v_content_hash
        )
        ON CONFLICT (kind, target_key_hash) DO NOTHING;
        IF FOUND THEN
            RETURN pg_catalog.jsonb_build_object(
                'status', 'mirrored',
                'duplicate', FALSE,
                'state', v_source.state
            );
        END IF;
        SELECT maintenance_job.*
        INTO v_existing
        FROM public.maintenance_jobs AS maintenance_job
        WHERE maintenance_job.kind = 'purge'
          AND maintenance_job.target_key_hash = v_target_key_hash
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ACCOUNT_DELETION_MIRROR_CONCURRENCY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    IF v_existing.payload->>'source_table' IS DISTINCT FROM 'account_deletion_jobs' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ACCOUNT_DELETION_MIRROR_CONTENT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_final_error_code := CASE
        WHEN v_existing.state = 'succeeded' AND v_canonical_state = 'queued'
        THEN 'ACCOUNT_DELETION_SOURCE_REGRESSION'
        ELSE NULL
    END;
    v_final_state := CASE
        WHEN v_existing.state = 'blocked' THEN 'blocked'
        WHEN v_final_error_code IS NOT NULL THEN 'blocked'
        WHEN v_canonical_state = 'succeeded' THEN 'succeeded'
        WHEN v_existing.state = 'leased' THEN 'leased'
        ELSE 'queued'
    END;

    UPDATE public.maintenance_jobs
    SET state = v_final_state,
        next_attempt_at = CASE
            WHEN v_final_state = 'queued' THEN v_source.updated_at
            ELSE maintenance_jobs.next_attempt_at
        END,
        terminal_at = CASE
            WHEN v_final_state = 'succeeded' THEN v_source.completed_at
            WHEN v_final_state = 'blocked' THEN COALESCE(
                maintenance_jobs.terminal_at,
                pg_catalog.clock_timestamp()
            )
            ELSE NULL
        END,
        last_error_code = COALESCE(v_final_error_code, maintenance_jobs.last_error_code),
        lease_token = CASE
            WHEN v_final_state IN ('succeeded', 'blocked') THEN NULL
            ELSE maintenance_jobs.lease_token
        END,
        lease_holder_hash = CASE
            WHEN v_final_state IN ('succeeded', 'blocked') THEN NULL
            ELSE maintenance_jobs.lease_holder_hash
        END,
        lease_expires_at = CASE
            WHEN v_final_state IN ('succeeded', 'blocked') THEN NULL
            ELSE maintenance_jobs.lease_expires_at
        END,
        payload = v_payload,
        content_hash = v_content_hash,
        updated_at = pg_catalog.clock_timestamp()
    WHERE maintenance_jobs.id = v_existing.id;

    RETURN pg_catalog.jsonb_build_object(
        'status', 'mirrored',
        'duplicate', TRUE,
        'state', v_source.state
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mirror_account_deletion_job_v1(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mirror_account_deletion_job_v1(UUID)
    TO service_role;
