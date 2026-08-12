-- Add a v2 claim contract rather than replacing v1: already-running workers
-- retain their strict v1 result shape during a migration-first rollout.
-- Test-entitlement admissions receive the immutable preflight access mode and
-- require a durable paid profile source; ordinary production keeps its path.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE FUNCTION public.claim_analysis_v2_preflight_admission_v2(
    p_preflight_id UUID, p_admission_generation INTEGER, p_dispatch_generation INTEGER,
    p_dispatch_token UUID, p_claim_token UUID, p_lease_seconds INTEGER
)
RETURNS TABLE(claimed BOOLEAN, admission_status TEXT, target_instagram_id TEXT, analysis_entry_channel TEXT, access_mode TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp(); v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL OR p_admission_generation IS NULL OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_dispatch_generation IS NULL OR p_dispatch_generation NOT BETWEEN 1 AND 100 OR p_dispatch_token IS NULL
       OR p_claim_token IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_V2_FRESH_ADMISSION_INVALID', ERRCODE='P0001';
    END IF;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight WHERE preflight.id=p_preflight_id FOR UPDATE;
    IF NOT FOUND OR v_preflight.status <> 'ready' OR v_preflight.consumed_request_id IS NOT NULL OR v_preflight.expires_at <= v_now
       OR v_preflight.admission_generation <> p_admission_generation
       OR v_preflight.admission_dispatch_generation <> p_dispatch_generation
       OR v_preflight.admission_dispatch_token IS DISTINCT FROM p_dispatch_token
       OR v_preflight.admission_dispatch_state NOT IN ('reserved','enqueued') THEN
        RETURN QUERY SELECT FALSE,'blocked'::TEXT,NULL::TEXT,COALESCE(v_preflight.analysis_entry_channel::TEXT,'standard'::TEXT),v_preflight.access_mode::TEXT; RETURN;
    END IF;
    IF v_preflight.admission_status IN ('idle','ready','blocked') THEN
        RETURN QUERY SELECT FALSE,CASE WHEN v_preflight.admission_status='idle' THEN 'blocked' ELSE v_preflight.admission_status END,
            NULL::TEXT,v_preflight.analysis_entry_channel::TEXT,v_preflight.access_mode::TEXT; RETURN;
    END IF;
    IF v_preflight.admission_status='processing' AND v_preflight.admission_lease_expires_at > v_now THEN
        RETURN QUERY SELECT FALSE,'processing'::TEXT,NULL::TEXT,v_preflight.analysis_entry_channel::TEXT,v_preflight.access_mode::TEXT; RETURN;
    END IF;
    UPDATE public.analysis_preflights AS preflight SET admission_status='processing',admission_claim_token=p_claim_token,
        admission_lease_expires_at=v_now+pg_catalog.make_interval(secs=>p_lease_seconds),admission_dispatch_state='enqueued',
        admission_dispatched_at=COALESCE(preflight.admission_dispatched_at,v_now),updated_at=v_now WHERE preflight.id=v_preflight.id;
    RETURN QUERY SELECT TRUE,'processing'::TEXT,v_preflight.target_instagram_id::TEXT,v_preflight.analysis_entry_channel::TEXT,v_preflight.access_mode::TEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_analysis_v2_preflight_admission_v2(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_preflight_admission_v2(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER) TO service_role;
