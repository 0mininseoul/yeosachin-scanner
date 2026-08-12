SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.account_deletion_jobs (
    account_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
    state TEXT NOT NULL DEFAULT 'requested' CHECK (
        state IN ('requested', 'objects_purged', 'database_purged', 'completed')
    ),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    objects_purged_at TIMESTAMPTZ,
    database_purged_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT account_deletion_jobs_state_shape_check CHECK (
        (state = 'requested' AND objects_purged_at IS NULL AND database_purged_at IS NULL AND completed_at IS NULL)
        OR (state = 'objects_purged' AND objects_purged_at IS NOT NULL AND database_purged_at IS NULL AND completed_at IS NULL)
        OR (state = 'database_purged' AND objects_purged_at IS NOT NULL AND database_purged_at IS NOT NULL AND completed_at IS NULL)
        OR (state = 'completed' AND objects_purged_at IS NOT NULL AND database_purged_at IS NOT NULL AND completed_at IS NOT NULL)
    )
);

ALTER TABLE public.account_deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_deletion_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_deletion_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.account_deletion_jobs TO service_role;

CREATE FUNCTION public.begin_account_deletion_v1(p_account_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_account public.users%ROWTYPE;
    v_job public.account_deletion_jobs%ROWTYPE;
    v_object_keys JSONB;
BEGIN
    SELECT * INTO v_account
    FROM public.users AS account
    WHERE account.id = p_account_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ACCOUNT_DELETION_ACCOUNT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_account.account_class <> 'production' OR v_account.traffic_class <> 'external' THEN
        RAISE EXCEPTION USING MESSAGE = 'ACCOUNT_DELETION_NOT_ALLOWED', ERRCODE = 'P0001';
    END IF;

    IF v_account.lifecycle = 'active' THEN
        UPDATE public.users AS account
        SET lifecycle = 'retired', updated_at = pg_catalog.clock_timestamp()
        WHERE account.id = p_account_id;

        INSERT INTO public.account_classification_audit (
            account_id, command_version, reason_code,
            previous_account_class, previous_traffic_class, previous_lifecycle,
            next_account_class, next_traffic_class, next_lifecycle
        ) VALUES (
            p_account_id, 'account_deletion_v1', 'USER_REQUESTED_DELETION',
            v_account.account_class, v_account.traffic_class, v_account.lifecycle,
            v_account.account_class, v_account.traffic_class, 'retired'
        );
    END IF;

    INSERT INTO public.account_deletion_jobs(account_id)
    VALUES (p_account_id)
    ON CONFLICT (account_id) DO NOTHING;

    UPDATE public.analysis_requests AS request
    SET share_enabled = FALSE, share_token = NULL
    WHERE request.user_id = p_account_id;

    SELECT * INTO v_job
    FROM public.account_deletion_jobs AS job
    WHERE job.account_id = p_account_id;

    SELECT COALESCE(pg_catalog.jsonb_agg(image_object.object_key ORDER BY image_object.object_key), '[]'::JSONB)
    INTO v_object_keys
    FROM public.analysis_v2_result_image_objects AS image_object
    JOIN public.analysis_requests AS request ON request.id = image_object.request_id
    WHERE request.user_id = p_account_id AND image_object.object_key IS NOT NULL;

    RETURN pg_catalog.jsonb_build_object('state', v_job.state, 'objectKeys', v_object_keys);
END;
$$;

CREATE FUNCTION public.finalize_account_deletion_database_v1(
    p_account_id UUID,
    p_deleted_object_keys JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.account_deletion_jobs%ROWTYPE;
    v_expected_keys JSONB;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    SELECT * INTO v_job
    FROM public.account_deletion_jobs AS job
    WHERE job.account_id = p_account_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ACCOUNT_DELETION_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_job.state IN ('database_purged', 'completed') THEN
        RETURN pg_catalog.jsonb_build_object('state', v_job.state);
    END IF;
    IF pg_catalog.jsonb_typeof(p_deleted_object_keys) <> 'array' THEN
        RAISE EXCEPTION USING MESSAGE = 'ACCOUNT_DELETION_OBJECT_PROOF_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(image_object.object_key ORDER BY image_object.object_key), '[]'::JSONB)
    INTO v_expected_keys
    FROM public.analysis_v2_result_image_objects AS image_object
    JOIN public.analysis_requests AS request ON request.id = image_object.request_id
    WHERE request.user_id = p_account_id AND image_object.object_key IS NOT NULL;
    IF v_expected_keys <> p_deleted_object_keys THEN
        RAISE EXCEPTION USING MESSAGE = 'ACCOUNT_DELETION_OBJECT_PROOF_MISMATCH', ERRCODE = 'P0001';
    END IF;

    UPDATE public.account_deletion_jobs SET state = 'objects_purged', objects_purged_at = v_now, updated_at = v_now
    WHERE account_id = p_account_id AND state = 'requested';

    DELETE FROM public.analysis_result_share_observations AS observation
    USING public.analysis_requests AS request
    WHERE observation.request_id = request.id AND request.user_id = p_account_id;
    DELETE FROM public.analysis_results AS result
    USING public.analysis_requests AS request
    WHERE result.request_id = request.id AND request.user_id = p_account_id;
    DELETE FROM public.private_accounts AS private_account
    USING public.analysis_requests AS request
    WHERE private_account.request_id = request.id AND request.user_id = p_account_id;
    DELETE FROM public.analysis_v2_result_summaries AS summary
    USING public.analysis_requests AS request
    WHERE summary.request_id = request.id AND request.user_id = p_account_id;
    DELETE FROM public.analysis_v2_result_image_objects AS image_object
    USING public.analysis_requests AS request
    WHERE image_object.request_id = request.id AND request.user_id = p_account_id;
    DELETE FROM public.analysis_v2_result_image_manifests AS manifest
    USING public.analysis_requests AS request
    WHERE manifest.request_id = request.id AND request.user_id = p_account_id;

    UPDATE public.analysis_requests AS request
    SET target_instagram_id = 'deleted', share_enabled = FALSE, share_token = NULL,
        step_data = '{}'::JSONB, gender_stats = '{}'::JSONB,
        error_message = NULL, progress_step = NULL
    WHERE request.user_id = p_account_id;

    UPDATE public.analysis_preflights AS preflight
    SET target_instagram_id = 'deleted', target_full_name = NULL, target_bio = NULL,
        target_profile_image_url = NULL, excluded_instagram_id = NULL,
        exclusion_decision = 'skip', pii_scrubbed_at = COALESCE(preflight.pii_scrubbed_at, v_now)
    WHERE preflight.user_id = p_account_id;

    UPDATE public.earlybird_orders AS earlybird_order
    SET target_instagram_id = 'deleted', target_followers_count = 0, target_following_count = 0,
        exclusion_decision = 'skip', excluded_instagram_id = NULL,
        expected_buyer_phone_number_normalized = NULL,
        expected_buyer_phone_verification_source = NULL,
        expected_buyer_phone_verified_at = NULL,
        buyer_match_policy = 'legacy_email', groble_buyer_email = NULL,
        groble_buyer_phone_number = NULL, groble_buyer_display_name = NULL,
        disclosure_text = 'retained_order_ledger', result_request_id = NULL,
        updated_at = v_now
    WHERE earlybird_order.user_id = p_account_id;

    DELETE FROM public.earlybird_waitlist AS waitlist WHERE waitlist.user_id = p_account_id;

    UPDATE public.users AS account
    SET email = 'retired+' || pg_catalog.replace(account.id::TEXT, '-', '') || '@deleted.invalid',
        provider = 'retired', analysis_count = 0, name = NULL, nickname = NULL,
        profile_image = NULL, phone_number = NULL, phone_number_normalized = NULL,
        phone_number_verification_source = NULL, phone_number_verified_at = NULL,
        gender = NULL, birthyear = NULL, updated_at = v_now
    WHERE account.id = p_account_id AND account.lifecycle = 'retired';

    UPDATE public.account_deletion_jobs
    SET state = 'database_purged', objects_purged_at = COALESCE(objects_purged_at, v_now),
        database_purged_at = v_now, updated_at = v_now
    WHERE account_id = p_account_id;
    RETURN pg_catalog.jsonb_build_object('state', 'database_purged');
END;
$$;

CREATE FUNCTION public.complete_account_deletion_v1(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE public.account_deletion_jobs
    SET state = 'completed', completed_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
    WHERE account_id = p_account_id AND state = 'database_purged';
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_account_deletion_v1(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_account_deletion_database_v1(UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_account_deletion_v1(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_account_deletion_v1(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_account_deletion_database_v1(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_account_deletion_v1(UUID) TO service_role;
