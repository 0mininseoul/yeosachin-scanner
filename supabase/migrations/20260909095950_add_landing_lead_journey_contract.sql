-- Landing lead identity is deliberately append-only and service mediated.  The
-- existing raw attribution columns remain available to legacy writers, while
-- new journey rows use only the bounded hashes below.
ALTER TABLE public.landing_leads
    ADD COLUMN journey_id UUID NOT NULL DEFAULT extensions.gen_random_uuid(),
    ADD COLUMN anonymous_principal_hash VARCHAR(64),
    ADD COLUMN auth_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS source_preflight_id UUID,
    ADD COLUMN capture_token_hash VARCHAR(64),
    ADD COLUMN mapping_status TEXT NOT NULL DEFAULT 'legacy_unlinked',
    ADD COLUMN mapping_source TEXT,
    ADD COLUMN linked_at TIMESTAMPTZ;

-- The original context check predated preflight attribution and rejected a
-- target row once it was bound to its preflight. Replace only that constraint
-- with a compatible shape check; no table, row, or function is removed.
ALTER TABLE public.landing_leads
    DROP CONSTRAINT landing_leads_context_shape_check;

ALTER TABLE public.landing_leads
    ADD CONSTRAINT landing_leads_context_shape_check CHECK (
        (input_context = 'target')
        OR (
            input_context = 'excluded'
            AND source_preflight_id IS NOT NULL
            AND raw_input IS NULL
            AND utm_source IS NULL
            AND utm_medium IS NULL
            AND utm_campaign IS NULL
            AND utm_content IS NULL
            AND utm_term IS NULL
            AND referrer IS NULL
            AND user_agent IS NULL
        )
    );

ALTER TABLE public.landing_leads
    ADD CONSTRAINT landing_leads_mapping_status_check CHECK (
        mapping_status IN (
            'legacy_unlinked', 'anonymous_device',
            'authenticated_user', 'unlinked_after_deletion'
        )
    ),
    ADD CONSTRAINT landing_leads_mapping_source_check CHECK (
        mapping_source IS NULL OR mapping_source IN (
            'legacy_import_v1', 'capture_v1', 'preflight_v1',
            'account_deletion_v1'
        )
    ),
    ADD CONSTRAINT landing_leads_capture_hash_check CHECK (
        capture_token_hash IS NULL OR capture_token_hash ~ '^[a-f0-9]{64}$'
    ),
    ADD CONSTRAINT landing_leads_anonymous_principal_hash_check CHECK (
        anonymous_principal_hash IS NULL OR anonymous_principal_hash ~ '^[a-f0-9]{64}$'
    );

CREATE INDEX landing_leads_journey_created_idx
    ON public.landing_leads(journey_id, created_at DESC, id DESC);
CREATE INDEX landing_leads_mapping_filter_idx
    ON public.landing_leads(mapping_status, input_context, created_at DESC, id DESC);
CREATE UNIQUE INDEX landing_leads_capture_token_hash_uidx
    ON public.landing_leads(capture_token_hash);

ALTER TABLE public.landing_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_leads FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.landing_leads FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_or_replay_landing_lead_capture(
    p_journey_id UUID,
    p_instagram_id TEXT,
    p_input_context TEXT,
    p_anonymous_principal_hash VARCHAR(64),
    p_capture_token_hash VARCHAR(64)
)
RETURNS TABLE(journey_id UUID, created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_existing public.landing_leads%ROWTYPE;
BEGIN
    -- Exclusions must carry source_preflight_id and are persisted through the
    -- dedicated exclusion RPC below. This capture RPC is target-only so an
    -- omitted source preflight can never violate the context shape contract.
    IF p_input_context <> 'target'
       OR p_instagram_id !~ '^[a-z0-9._]{1,30}$'
       OR p_anonymous_principal_hash !~ '^[a-f0-9]{64}$'
       OR p_capture_token_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'LANDING_LEAD_INPUT_INVALID';
    END IF;
    INSERT INTO public.landing_leads(
        journey_id, instagram_id, input_context,
        anonymous_principal_hash, capture_token_hash,
        mapping_status, mapping_source, created_at
    ) VALUES (
        p_journey_id, lower(p_instagram_id), p_input_context,
        p_anonymous_principal_hash, p_capture_token_hash,
        'anonymous_device', 'capture_v1', pg_catalog.clock_timestamp()
    )
    ON CONFLICT (capture_token_hash) DO NOTHING;
    IF FOUND THEN
        RETURN QUERY SELECT p_journey_id, TRUE;
        RETURN;
    END IF;
    SELECT lead.* INTO v_existing
    FROM public.landing_leads AS lead
    WHERE lead.capture_token_hash = p_capture_token_hash
    LIMIT 1;
    IF NOT FOUND
       OR v_existing.journey_id IS DISTINCT FROM p_journey_id
       OR v_existing.instagram_id IS DISTINCT FROM lower(p_instagram_id)
       OR v_existing.input_context IS DISTINCT FROM p_input_context
       OR v_existing.anonymous_principal_hash IS DISTINCT FROM p_anonymous_principal_hash THEN
        RAISE EXCEPTION 'LANDING_LEAD_CAPTURE_MISMATCH';
    END IF;
    RETURN QUERY SELECT v_existing.journey_id, FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.bind_landing_lead_journey_to_preflight(
    p_journey_id UUID,
    p_source_preflight_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    UPDATE public.landing_leads
    SET source_preflight_id = p_source_preflight_id,
        mapping_source = CASE
            WHEN mapping_source = 'legacy_import_v1' THEN mapping_source
            ELSE 'preflight_v1'
        END
    WHERE journey_id = p_journey_id
      AND input_context = 'target'
      AND (
          source_preflight_id IS NULL
          OR source_preflight_id = p_source_preflight_id
      )
      AND mapping_status <> 'unlinked_after_deletion';
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_or_replay_landing_lead_exclusion(
    p_source_preflight_id UUID,
    p_instagram_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_target public.landing_leads%ROWTYPE;
BEGIN
    IF p_instagram_id !~ '^[a-z0-9._]{1,30}$' THEN
        RAISE EXCEPTION 'LANDING_LEAD_INPUT_INVALID';
    END IF;
    SELECT * INTO v_target
    FROM public.landing_leads
    WHERE source_preflight_id = p_source_preflight_id
      AND input_context = 'target'
    ORDER BY created_at ASC, id ASC
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    INSERT INTO public.landing_leads(
        journey_id, instagram_id, input_context,
        anonymous_principal_hash, auth_user_id,
        source_preflight_id, mapping_status, mapping_source, linked_at, created_at
    ) VALUES (
        v_target.journey_id, p_instagram_id, 'excluded',
        v_target.anonymous_principal_hash, v_target.auth_user_id,
        p_source_preflight_id, v_target.mapping_status, 'preflight_v1', v_target.linked_at,
        pg_catalog.clock_timestamp()
    )
    ON CONFLICT (source_preflight_id) WHERE input_context = 'excluded' DO NOTHING;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_landing_lead_journey(
    p_journey_id UUID,
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_has_rows BOOLEAN;
    v_conflict BOOLEAN;
BEGIN
    SELECT pg_catalog.count(*) > 0,
           pg_catalog.bool_or(auth_user_id IS NOT NULL AND auth_user_id <> p_user_id)
    INTO v_has_rows, v_conflict
    FROM public.landing_leads
    WHERE (journey_id = p_journey_id OR source_preflight_id = p_journey_id)
      AND mapping_status <> 'unlinked_after_deletion';
    IF NOT v_has_rows THEN
        RETURN FALSE;
    END IF;
    IF COALESCE(v_conflict, FALSE) THEN
        RAISE EXCEPTION 'LANDING_LEAD_JOURNEY_CLAIM_CONFLICT';
    END IF;
    UPDATE public.landing_leads
    SET auth_user_id = p_user_id,
        mapping_status = 'authenticated_user',
        mapping_source = 'preflight_v1',
        linked_at = COALESCE(linked_at, pg_catalog.clock_timestamp())
    WHERE (journey_id = p_journey_id OR source_preflight_id = p_journey_id)
      AND auth_user_id IS NULL
      AND mapping_status <> 'unlinked_after_deletion';
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.unlink_landing_lead_journey_after_deletion(
    p_subject_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    UPDATE public.landing_leads
    SET auth_user_id = NULL,
        mapping_status = 'unlinked_after_deletion',
        mapping_source = 'account_deletion_v1',
        linked_at = NULL
    WHERE (journey_id = p_subject_id OR auth_user_id = p_subject_id)
      AND mapping_status = 'authenticated_user';
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.load_landing_lead_admin_projection(
    p_input_context TEXT DEFAULT NULL,
    p_mapping_status TEXT DEFAULT NULL,
    p_instagram_id TEXT DEFAULT NULL,
    p_from TIMESTAMPTZ DEFAULT NULL,
    p_to TIMESTAMPTZ DEFAULT NULL,
    p_cursor_created_at TIMESTAMPTZ DEFAULT NULL,
    p_cursor_id UUID DEFAULT NULL,
    p_page_size INTEGER DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_rows JSONB;
BEGIN
    IF p_page_size < 1 OR p_page_size > 51
       OR (p_input_context IS NOT NULL AND p_input_context NOT IN ('target', 'excluded'))
       OR (p_mapping_status IS NOT NULL AND p_mapping_status NOT IN (
            'legacy_unlinked', 'anonymous_device',
            'authenticated_user', 'unlinked_after_deletion'
       ))
       OR (p_instagram_id IS NOT NULL AND p_instagram_id !~ '^[a-z0-9._]{1,30}$') THEN
        RAISE EXCEPTION 'LANDING_LEAD_FILTER_INVALID';
    END IF;
    WITH journey_stats AS (
        SELECT lead.journey_id,
               pg_catalog.count(*)::INTEGER AS journey_count,
               pg_catalog.min(lead.created_at) AS first_seen_at,
               pg_catalog.max(lead.created_at) AS last_seen_at
        FROM public.landing_leads AS lead
        GROUP BY lead.journey_id
    ), filtered AS (
        SELECT lead.instagram_id,
               lead.input_context,
               lead.mapping_status,
               lead.created_at,
               lead.id,
               stats.journey_count,
               stats.first_seen_at,
               stats.last_seen_at
        FROM public.landing_leads AS lead
        INNER JOIN journey_stats AS stats ON stats.journey_id = lead.journey_id
        WHERE (p_input_context IS NULL OR lead.input_context = p_input_context)
          AND (p_mapping_status IS NULL OR lead.mapping_status = p_mapping_status)
          AND (p_instagram_id IS NULL OR lead.instagram_id = p_instagram_id)
          AND (p_from IS NULL OR lead.created_at >= p_from)
          AND (p_to IS NULL OR lead.created_at < p_to)
          AND (
              p_cursor_created_at IS NULL
              OR (lead.created_at, lead.id) < (p_cursor_created_at, p_cursor_id)
          )
        ORDER BY lead.created_at DESC, lead.id DESC
        LIMIT p_page_size
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'instagramId', instagram_id,
                'inputContext', input_context,
                'mappingStatus', mapping_status,
                'rowCountInJourney', journey_count,
                'firstSeenAt', first_seen_at,
                'lastSeenAt', last_seen_at,
                'cursorCreatedAt', created_at,
                'cursorId', id
            ) ORDER BY created_at DESC, id DESC
        ),
        '[]'::JSONB
    ) INTO v_rows
    FROM filtered;
    RETURN pg_catalog.jsonb_build_object('rows', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.fence_landing_leads_on_account_retirement()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF NEW.lifecycle = 'retired' AND OLD.lifecycle IS DISTINCT FROM NEW.lifecycle THEN
        PERFORM public.unlink_landing_lead_journey_after_deletion(NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger
        WHERE tgname = 'landing_leads_account_retirement_fence'
          AND tgrelid = 'public.users'::pg_catalog.regclass
    ) THEN
        CREATE TRIGGER landing_leads_account_retirement_fence
        AFTER UPDATE OF lifecycle ON public.users
        FOR EACH ROW
        EXECUTE FUNCTION public.fence_landing_leads_on_account_retirement();
    END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_or_replay_landing_lead_capture(UUID, TEXT, TEXT, VARCHAR, VARCHAR) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_or_replay_landing_lead_capture(UUID, TEXT, TEXT, VARCHAR, VARCHAR) TO service_role;
REVOKE ALL ON FUNCTION public.bind_landing_lead_journey_to_preflight(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_landing_lead_journey_to_preflight(UUID, UUID) TO service_role;
REVOKE ALL ON FUNCTION public.create_or_replay_landing_lead_exclusion(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_or_replay_landing_lead_exclusion(UUID, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.claim_landing_lead_journey(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_landing_lead_journey(UUID, UUID) TO service_role;
REVOKE EXECUTE ON FUNCTION public.unlink_landing_lead_journey_after_deletion(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_landing_lead_journey_after_deletion(UUID) TO service_role;
REVOKE EXECUTE ON FUNCTION public.load_landing_lead_admin_projection(TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_landing_lead_admin_projection(TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER) TO service_role;
REVOKE EXECUTE ON FUNCTION public.fence_landing_leads_on_account_retirement() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fence_landing_leads_on_account_retirement() TO service_role;
