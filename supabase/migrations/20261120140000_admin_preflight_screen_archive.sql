-- Operator-only permanent archive of the preflight result screen.
--
-- Users keep the existing retention: the live preflight is PII-scrubbed and
-- purged after expiry, so /analyze can no longer show it.  The operator
-- console keeps a separate copy of the ready snapshot (target profile, counts,
-- plan cards and pricing) captured the moment the preflight first becomes
-- ready, so /admin0min/preflight/[id] can replay what the user saw forever.
-- service_role only; never exposed to users.
--
-- Note: target_profile_image_url is the Instagram CDN URL; those URLs expire,
-- so an old archived screen may show the placeholder avatar instead of the photo.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE IF NOT EXISTS public.admin_preflight_screen_archive (
    preflight_id UUID PRIMARY KEY,
    user_id UUID,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    ready_at TIMESTAMPTZ,
    target_instagram_id TEXT NOT NULL,
    target_full_name TEXT,
    target_bio TEXT,
    target_profile_image_url TEXT,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    target_is_private BOOLEAN,
    access_mode TEXT,
    capacity_required_plan_id TEXT,
    required_plan_id TEXT,
    exclusion_decision TEXT,
    expires_at TIMESTAMPTZ,
    launch_status_snapshot JSONB,
    plan_cards_snapshot JSONB,
    pricing_snapshot JSONB,
    pricing_version TEXT
);

ALTER TABLE public.admin_preflight_screen_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_preflight_screen_archive FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.admin_preflight_screen_archive TO service_role;

COMMENT ON TABLE public.admin_preflight_screen_archive IS
    'Operator-only permanent copy of the ready preflight screen; users keep the normal scrub/purge retention.';

CREATE OR REPLACE FUNCTION public.admin_console_archive_preflight_screen(p_preflight public.analysis_preflights)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF p_preflight.status NOT IN ('ready', 'consumed', 'expired')
       OR p_preflight.ready_at IS NULL
       OR p_preflight.pii_scrubbed_at IS NOT NULL
       OR p_preflight.target_instagram_id IS NULL
       OR p_preflight.plan_cards_snapshot IS NULL
       OR p_preflight.pricing_snapshot IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO public.admin_preflight_screen_archive (
        preflight_id, user_id, ready_at,
        target_instagram_id,
        target_full_name,
        target_bio,
        target_profile_image_url,
        target_followers_count,
        target_following_count,
        target_is_private,
        access_mode,
        capacity_required_plan_id,
        required_plan_id,
        exclusion_decision,
        expires_at,
        launch_status_snapshot,
        plan_cards_snapshot,
        pricing_snapshot,
        pricing_version
    ) VALUES (
        p_preflight.id, p_preflight.user_id, p_preflight.ready_at,
        p_preflight.target_instagram_id,
        p_preflight.target_full_name,
        p_preflight.target_bio,
        p_preflight.target_profile_image_url,
        p_preflight.target_followers_count,
        p_preflight.target_following_count,
        p_preflight.target_is_private,
        p_preflight.access_mode,
        p_preflight.capacity_required_plan_id,
        p_preflight.required_plan_id,
        p_preflight.exclusion_decision,
        p_preflight.expires_at,
        p_preflight.launch_status_snapshot,
        p_preflight.plan_cards_snapshot,
        p_preflight.pricing_snapshot,
        p_preflight.pricing_version
    )
    ON CONFLICT (preflight_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_console_archive_preflight_screen_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    BEGIN
        PERFORM public.admin_console_archive_preflight_screen(NEW);
    EXCEPTION WHEN OTHERS THEN
        -- Reporting only: never block the preflight lifecycle.
        NULL;
    END;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admin_console_archive_preflight_screen ON public.analysis_preflights;
CREATE TRIGGER admin_console_archive_preflight_screen
    AFTER INSERT OR UPDATE OF status, ready_at ON public.analysis_preflights
    FOR EACH ROW
    WHEN (NEW.ready_at IS NOT NULL AND NEW.pii_scrubbed_at IS NULL)
    EXECUTE FUNCTION public.admin_console_archive_preflight_screen_trigger();

-- Capture every snapshot that is still intact today.
DO $backfill$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    FOR v_preflight IN
        SELECT * FROM public.analysis_preflights
        WHERE ready_at IS NOT NULL AND pii_scrubbed_at IS NULL
    LOOP
        PERFORM public.admin_console_archive_preflight_screen(v_preflight);
    END LOOP;
END;
$backfill$;

DROP FUNCTION IF EXISTS public.load_admin_lead_inputs(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER, TEXT);

CREATE OR REPLACE FUNCTION public.load_admin_lead_inputs(
    p_mapping_status TEXT DEFAULT NULL,
    p_instagram_id TEXT DEFAULT NULL,
    p_from TIMESTAMPTZ DEFAULT NULL,
    p_to TIMESTAMPTZ DEFAULT NULL,
    p_cursor_created_at TIMESTAMPTZ DEFAULT NULL,
    p_cursor_id UUID DEFAULT NULL,
    p_page_size INTEGER DEFAULT 25,
    p_preflight_status TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_rows JSONB;
BEGIN
    IF p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 51
       OR (p_mapping_status IS NOT NULL AND p_mapping_status NOT IN (
            'legacy_unlinked', 'anonymous_device',
            'authenticated_user', 'unlinked_after_deletion'
       ))
       OR (p_instagram_id IS NOT NULL AND p_instagram_id !~ '^[a-z0-9._]{1,30}$')
       OR ((p_cursor_created_at IS NULL) <> (p_cursor_id IS NULL))
       OR (p_preflight_status IS NOT NULL AND p_preflight_status NOT IN (
            'processing', 'completed', 'failed', 'not_requested', 'unknown'
       )) THEN
        RAISE EXCEPTION 'ADMIN_LEAD_INPUT_FILTER_INVALID';
    END IF;

    WITH page AS (
        SELECT target.id,
               target.instagram_id,
               target.mapping_status,
               target.auth_user_id,
               target.attribution_label,
               target.created_at,
               target.source_preflight_id,
               target.preflight_status,
               target.preflight_stage,
               target.preflight_error_code,
               target.preflight_outcome_at,
               target.preflight_followers_count,
               target.preflight_following_count,
               target.preflight_is_private,
               target.preflight_required_plan_id,
               (
                   (live.id IS NOT NULL AND live.pii_scrubbed_at IS NULL
                    AND live.status IN ('ready', 'consumed', 'expired') AND live.ready_at IS NOT NULL)
                   OR EXISTS (
                       SELECT 1 FROM public.admin_preflight_screen_archive AS archive
                       WHERE archive.preflight_id = target.source_preflight_id
                   )
               ) AS preflight_screen_available,
               excluded.instagram_id AS excluded_instagram_id
        FROM public.landing_leads AS target
        LEFT JOIN LATERAL (
            SELECT candidate.instagram_id
            FROM public.landing_leads AS candidate
            WHERE candidate.input_context = 'excluded'
              AND (
                  candidate.journey_id = target.journey_id
                  OR (
                      target.source_preflight_id IS NOT NULL
                      AND candidate.source_preflight_id = target.source_preflight_id
                  )
              )
            ORDER BY candidate.created_at ASC, candidate.id ASC
            LIMIT 1
        ) AS excluded ON TRUE
        LEFT JOIN public.analysis_preflights AS live ON live.id = target.source_preflight_id
        WHERE target.input_context = 'target'
          AND (p_mapping_status IS NULL OR target.mapping_status = p_mapping_status)
          AND (
              p_preflight_status IS NULL
              OR (p_preflight_status = 'not_requested' AND target.source_preflight_id IS NULL AND target.preflight_status IS NULL)
              OR (p_preflight_status = 'unknown' AND target.source_preflight_id IS NOT NULL AND target.preflight_status IS NULL)
              OR target.preflight_status = p_preflight_status
          )
          AND (p_from IS NULL OR target.created_at >= p_from)
          AND (p_to IS NULL OR target.created_at < p_to)
          AND (
              p_instagram_id IS NULL
              OR target.instagram_id = p_instagram_id
              OR excluded.instagram_id = p_instagram_id
          )
          AND (
              p_cursor_created_at IS NULL
              OR (target.created_at, target.id) < (p_cursor_created_at, p_cursor_id)
          )
        ORDER BY target.created_at DESC, target.id DESC
        LIMIT p_page_size
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'inputAt', page.created_at,
                'mappingStatus', page.mapping_status,
                'userName', account.name,
                'attributionLabel', COALESCE(account.signup_attribution_label, page.attribution_label),
                'targetInstagramId', page.instagram_id,
                'excludedInstagramId', page.excluded_instagram_id,
                'preflightId', page.source_preflight_id,
                'preflightStatus', page.preflight_status,
                'preflightStage', page.preflight_stage,
                'preflightErrorCode', page.preflight_error_code,
                'preflightOutcomeAt', page.preflight_outcome_at,
                'preflightFollowersCount', page.preflight_followers_count,
                'preflightFollowingCount', page.preflight_following_count,
                'preflightIsPrivate', page.preflight_is_private,
                'preflightRequiredPlanId', page.preflight_required_plan_id,
                'preflightScreenAvailable', page.preflight_screen_available,
                'cursorCreatedAt', page.created_at,
                'cursorId', page.id
            )
            ORDER BY page.created_at DESC, page.id DESC
        ),
        '[]'::JSONB
    )
    INTO v_rows
    FROM page
    LEFT JOIN public.users AS account ON account.id = page.auth_user_id;

    RETURN pg_catalog.jsonb_build_object('rows', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_console_archive_preflight_screen(public.analysis_preflights) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_console_archive_preflight_screen_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_admin_lead_inputs(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_admin_lead_inputs(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INTEGER, TEXT) TO service_role;

COMMIT;
