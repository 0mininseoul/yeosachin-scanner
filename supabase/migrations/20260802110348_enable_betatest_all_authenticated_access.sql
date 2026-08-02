-- Dedicated server-owned enrollment for the all-authenticated betatest policy.
-- The durable grant row stays the downstream authorization witness so existing
-- service-only grant locks and rechecks remain unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_beta_access_grants
    ADD COLUMN grant_source TEXT NOT NULL DEFAULT 'operator',
    ADD CONSTRAINT analysis_beta_access_grants_source_check
        CHECK (grant_source IN ('operator', 'automatic'));

CREATE TABLE public.analysis_beta_access_policy (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    mode TEXT NOT NULL DEFAULT 'all_authenticated'
        CHECK (mode IN ('grant_only', 'all_authenticated')),
    generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
INSERT INTO public.analysis_beta_access_policy(singleton, mode, generation)
VALUES (TRUE, 'all_authenticated', 1);
ALTER TABLE public.analysis_beta_access_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_beta_access_policy FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_beta_access_policy
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.upsert_analysis_beta_access_grant(
    p_user_id UUID, p_enabled BOOLEAN, p_expires_at TIMESTAMP WITH TIME ZONE,
    p_audit_reference_hash TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min'
AS $$
DECLARE v_now TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_user_id IS NULL OR p_enabled IS NULL OR p_audit_reference_hash IS NULL
       OR p_audit_reference_hash !~ '^[a-f0-9]{64}$'
       OR (p_expires_at IS NOT NULL AND NOT pg_catalog.isfinite(p_expires_at)) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_GRANT_INVALID', ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'analysis-beta-grant:' || pg_catalog.lower(p_user_id::TEXT), 0));
    PERFORM users.id FROM public.users AS users WHERE users.id = p_user_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_GRANT_INVALID', ERRCODE = 'P0001'; END IF;
    v_now := pg_catalog.clock_timestamp();
    IF p_enabled AND p_expires_at IS NOT NULL AND p_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_GRANT_INVALID', ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.analysis_beta_access_grants(
        user_id, enabled, expires_at, audit_reference_hash, grant_source, granted_at, updated_at
    ) VALUES (p_user_id,p_enabled,p_expires_at,p_audit_reference_hash,'operator',v_now,v_now)
    ON CONFLICT (user_id) DO UPDATE SET
        enabled=EXCLUDED.enabled, expires_at=EXCLUDED.expires_at,
        audit_reference_hash=EXCLUDED.audit_reference_hash, grant_source='operator', updated_at=v_now;
    RETURN p_enabled;
END; $$;
REVOKE ALL ON FUNCTION public.upsert_analysis_beta_access_grant(UUID,BOOLEAN,TIMESTAMP WITH TIME ZONE,TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_analysis_beta_access_grant(UUID,BOOLEAN,TIMESTAMP WITH TIME ZONE,TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.set_analysis_beta_access_policy(p_mode TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min'
AS $$
DECLARE v_mode TEXT;
BEGIN
    IF p_mode IS NULL OR p_mode NOT IN ('grant_only','all_authenticated') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POLICY_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT policy_row.mode INTO v_mode FROM public.analysis_beta_access_policy AS policy_row
    WHERE policy_row.singleton=TRUE FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_POLICY_INVALID', ERRCODE = 'P0001'; END IF;
    IF v_mode = p_mode THEN RETURN p_mode; END IF;
    UPDATE public.analysis_beta_access_policy AS policy_row
    SET mode=p_mode, generation=policy_row.generation+1, updated_at=pg_catalog.clock_timestamp()
    WHERE policy_row.singleton=TRUE;
    IF p_mode='grant_only' THEN
        UPDATE public.analysis_beta_access_grants AS grant_row
        SET enabled=FALSE, updated_at=pg_catalog.clock_timestamp()
        WHERE grant_row.grant_source='automatic' AND grant_row.enabled=TRUE;
    END IF;
    RETURN p_mode;
END; $$;
REVOKE ALL ON FUNCTION public.set_analysis_beta_access_policy(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_analysis_beta_access_policy(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.enroll_analysis_beta_user(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
SET lock_timeout = '5s' SET statement_timeout = '2min'
AS $$
DECLARE
    v_gate_enabled BOOLEAN; v_policy_mode TEXT; v_now TIMESTAMP WITH TIME ZONE;
    v_grant public.analysis_beta_access_grants%ROWTYPE;
BEGIN
    IF p_user_id IS NULL THEN RETURN FALSE; END IF;
    SELECT gate_row.enabled INTO v_gate_enabled FROM public.analysis_beta_runtime_gate AS gate_row
    WHERE gate_row.singleton=TRUE FOR SHARE;
    SELECT policy_row.mode INTO v_policy_mode FROM public.analysis_beta_access_policy AS policy_row
    WHERE policy_row.singleton=TRUE FOR SHARE;
    IF v_gate_enabled IS DISTINCT FROM TRUE THEN RETURN FALSE; END IF;
    IF v_policy_mode='grant_only' THEN
        RETURN EXISTS(SELECT 1 FROM public.analysis_beta_access_grants AS grant_row
            WHERE grant_row.user_id=p_user_id AND grant_row.grant_source='operator'
              AND grant_row.enabled=TRUE
              AND (grant_row.expires_at IS NULL OR grant_row.expires_at>pg_catalog.clock_timestamp()));
    END IF;
    IF v_policy_mode IS DISTINCT FROM 'all_authenticated' THEN RETURN FALSE; END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'analysis-beta-grant:' || pg_catalog.lower(p_user_id::TEXT),0));
    PERFORM users.id FROM public.users AS users WHERE users.id=p_user_id FOR KEY SHARE;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    SELECT grant_row.* INTO v_grant FROM public.analysis_beta_access_grants AS grant_row
    WHERE grant_row.user_id=p_user_id FOR UPDATE;
    v_now:=pg_catalog.clock_timestamp();
    IF NOT FOUND THEN
        INSERT INTO public.analysis_beta_access_grants(
            user_id,enabled,expires_at,audit_reference_hash,grant_source,granted_at,updated_at
        ) VALUES (p_user_id,TRUE,NULL,pg_catalog.encode(extensions.digest(
            'automatic-betatest-enrollment-v1:' || p_user_id::TEXT,'sha256'),'hex'),
            'automatic',v_now,v_now);
        RETURN TRUE;
    END IF;
    IF v_grant.grant_source='automatic' AND v_grant.enabled=TRUE AND v_grant.expires_at IS NULL THEN
        RETURN TRUE;
    END IF;
    IF v_grant.enabled IS DISTINCT FROM TRUE
       OR (v_grant.expires_at IS NOT NULL AND v_grant.expires_at<=v_now) THEN
        UPDATE public.analysis_beta_access_grants AS grant_row SET
            enabled=TRUE, expires_at=NULL, grant_source='automatic',
            audit_reference_hash=pg_catalog.encode(extensions.digest(
                'automatic-betatest-enrollment-v1:' || p_user_id::TEXT,'sha256'),'hex'),
            updated_at=v_now
        WHERE grant_row.user_id=p_user_id;
        RETURN TRUE;
    END IF;
    IF v_grant.grant_source='automatic' THEN
        UPDATE public.analysis_beta_access_grants AS grant_row SET
            enabled=TRUE, expires_at=NULL,
            audit_reference_hash=pg_catalog.encode(extensions.digest(
                'automatic-betatest-enrollment-v1:' || p_user_id::TEXT,'sha256'),'hex'),
            updated_at=v_now
        WHERE grant_row.user_id=p_user_id;
    END IF;
    RETURN TRUE;
END; $$;
REVOKE ALL ON FUNCTION public.enroll_analysis_beta_user(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enroll_analysis_beta_user(UUID) TO service_role;
COMMENT ON FUNCTION public.enroll_analysis_beta_user(UUID) IS
    'Service-only dedicated beta enrollment. The server supplies the authenticated caller user id; direct clients cannot invoke it.';
