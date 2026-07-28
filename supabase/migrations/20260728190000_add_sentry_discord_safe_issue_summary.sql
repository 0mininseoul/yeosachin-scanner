-- Only bounded, allowlisted issue summary fields may accompany an outbox row.
ALTER TABLE public.sentry_discord_alert_outbox
    ADD COLUMN issue_short_id text CHECK (issue_short_id IS NULL OR issue_short_id ~ '^[A-Z][A-Z0-9_-]{0,49}-[0-9]{1,12}$'),
    ADD COLUMN error_type text CHECK (error_type IS NULL OR (length(error_type) <= 120 AND error_type ~ '^[A-Za-z_$][A-Za-z0-9_$.]*(::[A-Za-z_$][A-Za-z0-9_$.]*)*$')),
    ADD COLUMN release text CHECK (release IS NULL OR (length(release) <= 80 AND release ~ '^[0-9A-Za-z][0-9A-Za-z._+-]*$' AND release !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));

DROP FUNCTION public.enqueue_sentry_discord_alert_outbox(char, text, timestamptz, text);
CREATE FUNCTION public.enqueue_sentry_discord_alert_outbox(
    p_dedupe_key char(64), p_project_slug text, p_occurred_at timestamptz, p_issue_url text,
    p_issue_short_id text, p_error_type text, p_release text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    INSERT INTO public.sentry_discord_alert_outbox (
        dedupe_key, project_slug, occurred_at, issue_url, issue_short_id, error_type, release
    ) VALUES (
        lower(p_dedupe_key),
        CASE WHEN p_project_slug ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$' THEN p_project_slug ELSE NULL END,
        p_occurred_at, p_issue_url,
        CASE WHEN p_issue_short_id ~ '^[A-Z][A-Z0-9_-]{0,49}-[0-9]{1,12}$' THEN p_issue_short_id ELSE NULL END,
        CASE WHEN length(p_error_type) <= 120 AND p_error_type ~ '^[A-Za-z_$][A-Za-z0-9_$.]*(::[A-Za-z_$][A-Za-z0-9_$.]*)*$' THEN p_error_type ELSE NULL END,
        CASE WHEN length(p_release) <= 80 AND p_release ~ '^[0-9A-Za-z][0-9A-Za-z._+-]*$' AND p_release !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_release ELSE NULL END
    ) ON CONFLICT (dedupe_key) DO NOTHING;
    RETURN FOUND;
END;
$$;

DROP FUNCTION public.claim_sentry_discord_alert_outbox(integer, text);
CREATE FUNCTION public.claim_sentry_discord_alert_outbox(p_limit integer DEFAULT 10, p_dedupe_key text DEFAULT NULL)
RETURNS TABLE (id uuid, claim_token uuid, project_slug text, occurred_at timestamptz, issue_url text, issue_short_id text, error_type text, release text, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    RETURN QUERY WITH candidates AS (
        SELECT outbox.id FROM public.sentry_discord_alert_outbox AS outbox
        WHERE outbox.status = 'pending' AND outbox.next_attempt_at <= clock_timestamp()
          AND (p_dedupe_key IS NULL OR outbox.dedupe_key = p_dedupe_key)
        ORDER BY outbox.created_at FOR UPDATE SKIP LOCKED
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 10)
    ), claimed AS (
        UPDATE public.sentry_discord_alert_outbox AS outbox
        SET status = 'sending', attempts = outbox.attempts + 1, claim_token = public.uuid_generate_v4(),
            claimed_at = clock_timestamp(), delivery_started_at = NULL, updated_at = clock_timestamp()
        FROM candidates WHERE outbox.id = candidates.id RETURNING outbox.*
    ) SELECT claimed.id, claimed.claim_token, claimed.project_slug, claimed.occurred_at, claimed.issue_url,
        claimed.issue_short_id, claimed.error_type, claimed.release, claimed.attempts FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_sentry_discord_alert_outbox(char, text, timestamptz, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_sentry_discord_alert_outbox(integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_sentry_discord_alert_outbox(char, text, timestamptz, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_sentry_discord_alert_outbox(integer, text) TO service_role;
