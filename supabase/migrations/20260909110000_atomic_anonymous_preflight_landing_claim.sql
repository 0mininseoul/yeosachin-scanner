-- Keep the anonymous preflight owner claim and landing journey claim in one
-- transaction. If the landing claim fails, the preflight claim is rolled back
-- and the same signed capability remains retryable.
CREATE OR REPLACE FUNCTION public.claim_anonymous_analysis_v2_preflight_with_landing(
    p_preflight_id UUID,
    p_claim_token_hash VARCHAR(64),
    p_user_id UUID
)
RETURNS TABLE(
    claimed BOOLEAN,
    preflight_status TEXT,
    owner_preflight_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_claimed BOOLEAN;
    v_preflight_status TEXT;
    v_owner_preflight_id UUID;
BEGIN
    SELECT result.claimed, result.preflight_status, result.owner_preflight_id
    INTO v_claimed, v_preflight_status, v_owner_preflight_id
    FROM private.claim_anonymous_analysis_v2_preflight(
        p_preflight_id,
        p_claim_token_hash,
        p_user_id
    ) AS result;

    IF v_claimed IS TRUE
       AND NOT public.claim_landing_lead_journey(p_preflight_id, p_user_id) THEN
        RAISE EXCEPTION 'LANDING_LEAD_JOURNEY_CLAIM_FAILED';
    END IF;

    RETURN QUERY SELECT
        COALESCE(v_claimed, FALSE),
        v_preflight_status,
        v_owner_preflight_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_anonymous_analysis_v2_preflight_with_landing(UUID, VARCHAR, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_anonymous_analysis_v2_preflight_with_landing(UUID, VARCHAR, UUID)
    TO authenticated;
