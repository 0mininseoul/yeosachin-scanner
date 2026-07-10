-- Atomically create one idempotent analysis request and consume the user's quota.
ALTER TABLE analysis_requests
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_requests_user_idempotency
    ON analysis_requests(user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION consume_analysis_quota_and_create_request(
    p_user_id UUID,
    p_email TEXT,
    p_auth_provider TEXT,
    p_target_instagram_id TEXT,
    p_target_gender TEXT,
    p_scraper_options JSONB,
    p_idempotency_key TEXT,
    p_free_analysis_limit INTEGER
)
RETURNS TABLE(request_id UUID, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    account users%ROWTYPE;
    existing_request_id UUID;
    existing_target_instagram_id TEXT;
    existing_target_gender TEXT;
    existing_scraper_options JSONB;
    new_request_id UUID;
BEGIN
    IF p_email IS NULL OR p_email = '' THEN
        RAISE EXCEPTION 'invalid authenticated email';
    END IF;
    IF p_auth_provider NOT IN ('google', 'kakao') THEN
        RAISE EXCEPTION 'invalid auth provider';
    END IF;
    IF p_target_instagram_id !~ '^[a-z0-9._]{1,30}$' THEN
        RAISE EXCEPTION 'invalid Instagram username';
    END IF;
    IF p_target_gender NOT IN ('male', 'female') THEN
        RAISE EXCEPTION 'invalid target gender';
    END IF;
    IF p_scraper_options IS NULL OR jsonb_typeof(p_scraper_options) <> 'object' THEN
        RAISE EXCEPTION 'invalid scraper options';
    END IF;
    IF p_idempotency_key IS NULL
       OR length(p_idempotency_key) < 16
       OR length(p_idempotency_key) > 128
       OR p_idempotency_key !~ '^[A-Za-z0-9._:-]+$' THEN
        RAISE EXCEPTION 'invalid idempotency key';
    END IF;
    IF p_free_analysis_limit < 0 OR p_free_analysis_limit > 100 THEN
        RAISE EXCEPTION 'invalid free analysis limit';
    END IF;

    INSERT INTO users (id, email, provider, analysis_count, is_paid_user)
    VALUES (p_user_id, p_email, p_auth_provider, 0, FALSE)
    ON CONFLICT (id) DO NOTHING;

    SELECT *
    INTO account
    FROM users
    WHERE id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'authenticated user row unavailable';
    END IF;

    SELECT
        id,
        target_instagram_id,
        target_gender,
        COALESCE(step_data->'scraperOptions', '{}'::JSONB)
    INTO
        existing_request_id,
        existing_target_instagram_id,
        existing_target_gender,
        existing_scraper_options
    FROM analysis_requests
    WHERE user_id = p_user_id
      AND idempotency_key = p_idempotency_key;

    IF existing_request_id IS NOT NULL THEN
        IF existing_target_instagram_id IS DISTINCT FROM p_target_instagram_id
           OR existing_target_gender IS DISTINCT FROM p_target_gender
           OR existing_scraper_options IS DISTINCT FROM p_scraper_options THEN
            RAISE EXCEPTION 'ANALYSIS_IDEMPOTENCY_CONFLICT';
        END IF;
        RETURN QUERY SELECT existing_request_id, FALSE;
        RETURN;
    END IF;

    IF NOT (COALESCE(account.is_unlimited, FALSE) OR COALESCE(account.is_paid_user, FALSE))
       AND COALESCE(account.analysis_count, 0) >= p_free_analysis_limit THEN
        RAISE EXCEPTION 'ANALYSIS_LIMIT_EXCEEDED';
    END IF;

    UPDATE users
    SET analysis_count = COALESCE(analysis_count, 0) + 1
    WHERE id = p_user_id;

    INSERT INTO analysis_requests (
        user_id,
        target_instagram_id,
        target_gender,
        status,
        progress,
        progress_step,
        step_data,
        idempotency_key
    ) VALUES (
        p_user_id,
        p_target_instagram_id,
        p_target_gender,
        'pending',
        0,
        '분석 대기 중...',
        CASE
            WHEN p_scraper_options = '{}'::JSONB THEN '{}'::JSONB
            ELSE jsonb_build_object('scraperOptions', p_scraper_options)
        END,
        p_idempotency_key
    )
    RETURNING id INTO new_request_id;

    RETURN QUERY SELECT new_request_id, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION consume_analysis_quota_and_create_request(
    UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_analysis_quota_and_create_request(
    UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, INTEGER
) TO service_role;

COMMENT ON COLUMN analysis_requests.idempotency_key IS
    'Client-supplied key that makes analysis-start retries return the original request.';
