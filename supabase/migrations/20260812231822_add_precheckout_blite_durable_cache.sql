SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.precheckout_blite_cache (
    preflight_id UUID PRIMARY KEY REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete')),
    lease_token UUID NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    dto JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT precheckout_blite_cache_payload_check CHECK (
        (state = 'pending' AND dto IS NULL AND completed_at IS NULL)
        OR (state = 'complete' AND dto IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CONSTRAINT precheckout_blite_cache_timestamp_check CHECK (
        updated_at >= created_at
        AND lease_expires_at >= created_at
        AND (completed_at IS NULL OR completed_at >= created_at)
    )
);

ALTER TABLE public.precheckout_blite_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.precheckout_blite_cache FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.precheckout_blite_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.precheckout_blite_cache TO service_role;

CREATE OR REPLACE FUNCTION public.claim_precheckout_blite_v1(p_preflight_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_lease UUID := extensions.gen_random_uuid();
    v_cache public.precheckout_blite_cache%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM public.analysis_preflights AS preflight
         WHERE preflight.id = p_preflight_id
           AND preflight.status = 'ready'
           AND preflight.ready_at IS NOT NULL
           AND preflight.expires_at > v_now
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.precheckout_blite_cache (
        preflight_id, state, lease_token, lease_expires_at, created_at, updated_at
    ) VALUES (
        p_preflight_id, 'pending', v_lease, v_now + INTERVAL '2 minutes', v_now, v_now
    ) ON CONFLICT (preflight_id) DO NOTHING;

    SELECT * INTO v_cache
      FROM public.precheckout_blite_cache
     WHERE preflight_id = p_preflight_id
     FOR UPDATE;

    IF v_cache.state = 'complete' THEN
        RETURN pg_catalog.jsonb_build_object('disposition', 'complete', 'dto', v_cache.dto);
    END IF;

    IF v_cache.lease_token = v_lease THEN
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'claimed', 'leaseToken', v_cache.lease_token
        );
    END IF;

    IF v_cache.lease_expires_at <= v_now THEN
        UPDATE public.precheckout_blite_cache
           SET lease_token = v_lease,
               lease_expires_at = v_now + INTERVAL '2 minutes',
               updated_at = v_now
         WHERE preflight_id = p_preflight_id;
        RETURN pg_catalog.jsonb_build_object('disposition', 'claimed', 'leaseToken', v_lease);
    END IF;

    RETURN pg_catalog.jsonb_build_object('disposition', 'pending');
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_precheckout_blite_v1(
    p_preflight_id UUID,
    p_lease_token UUID,
    p_dto JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF p_dto IS NULL OR pg_catalog.jsonb_typeof(p_dto) <> 'object' THEN
        RETURN FALSE;
    END IF;
    UPDATE public.precheckout_blite_cache
       SET state = 'complete', dto = p_dto, completed_at = v_now, updated_at = v_now
     WHERE preflight_id = p_preflight_id
       AND state = 'pending'
       AND lease_token = p_lease_token
       AND lease_expires_at > v_now;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_precheckout_blite_v1(
    p_preflight_id UUID,
    p_lease_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    DELETE FROM public.precheckout_blite_cache
     WHERE preflight_id = p_preflight_id
       AND state = 'pending'
       AND lease_token = p_lease_token;
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_precheckout_blite_v1(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_precheckout_blite_v1(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_precheckout_blite_v1(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_precheckout_blite_v1(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_precheckout_blite_v1(UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_precheckout_blite_v1(UUID, UUID) TO service_role;
