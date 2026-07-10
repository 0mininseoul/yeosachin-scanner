-- Prevent duplicate client requests from running the same paid analysis step concurrently.
ALTER TABLE analysis_requests
    ADD COLUMN IF NOT EXISTS processing_lease_token UUID,
    ADD COLUMN IF NOT EXISTS processing_lease_expires_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_analysis_requests_processing_lease_expiry
    ON analysis_requests(processing_lease_expires_at)
    WHERE processing_lease_token IS NOT NULL;

CREATE OR REPLACE FUNCTION acquire_analysis_request_lease(
    p_request_id UUID,
    p_user_id UUID,
    p_expected_step TEXT,
    p_lease_token UUID,
    p_lease_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    IF p_lease_seconds < 30 OR p_lease_seconds > 7200 THEN
        RAISE EXCEPTION 'lease duration out of range';
    END IF;

    UPDATE analysis_requests
    SET processing_lease_token = p_lease_token,
        processing_lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    WHERE id = p_request_id
      AND user_id = p_user_id
      AND status IN ('pending', 'processing')
      AND COALESCE(current_step, 'pending') = p_expected_step
      AND (
          processing_lease_token IS NULL
          OR processing_lease_expires_at IS NULL
          OR processing_lease_expires_at <= clock_timestamp()
      );

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION release_analysis_request_lease(
    p_request_id UUID,
    p_lease_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    UPDATE analysis_requests
    SET processing_lease_token = NULL,
        processing_lease_expires_at = NULL
    WHERE id = p_request_id
      AND processing_lease_token = p_lease_token;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION acquire_analysis_request_lease(UUID, UUID, TEXT, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION release_analysis_request_lease(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION acquire_analysis_request_lease(UUID, UUID, TEXT, UUID, INTEGER)
    TO service_role;
GRANT EXECUTE ON FUNCTION release_analysis_request_lease(UUID, UUID)
    TO service_role;

COMMENT ON COLUMN analysis_requests.processing_lease_token IS
    'Opaque server-side token for one in-flight paid analysis step.';
COMMENT ON COLUMN analysis_requests.processing_lease_expires_at IS
    'Crash-recovery deadline for the in-flight analysis lease.';
