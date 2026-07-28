-- The Service Hook body is intentionally never stored. These are only the
-- allowlisted presentation fields and an irreversible delivery fingerprint.
CREATE TABLE public.sentry_discord_alert_outbox (
    id uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    dedupe_key char(64) NOT NULL UNIQUE CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
    project_slug text CHECK (project_slug IS NULL OR project_slug ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$'),
    occurred_at timestamptz NOT NULL,
    issue_url text,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'ambiguous_failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    claim_token uuid,
    claimed_at timestamptz,
    -- Written before the first Discord request. Recovery treats it as an
    -- at-most-once fence because a post may have succeeded before completion.
    delivery_started_at timestamptz,
    sent_at timestamptz,
    failure_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX sentry_discord_alert_outbox_pending_idx
    ON public.sentry_discord_alert_outbox (next_attempt_at, created_at)
    WHERE status = 'pending';

ALTER TABLE public.sentry_discord_alert_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sentry_discord_alert_outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sentry_discord_alert_outbox FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enqueue_sentry_discord_alert_outbox(
    p_dedupe_key char(64),
    p_project_slug text,
    p_occurred_at timestamptz,
    p_issue_url text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO public.sentry_discord_alert_outbox (dedupe_key, project_slug, occurred_at, issue_url)
    VALUES (
        lower(p_dedupe_key),
        CASE WHEN p_project_slug ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$' THEN p_project_slug ELSE NULL END,
        p_occurred_at,
        p_issue_url
    )
    ON CONFLICT (dedupe_key) DO NOTHING;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_sentry_discord_alert_outbox(
    p_limit integer DEFAULT 10,
    p_dedupe_key text DEFAULT NULL
)
RETURNS TABLE (
    id uuid,
    claim_token uuid,
    project_slug text,
    occurred_at timestamptz,
    issue_url text,
    attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    WITH candidates AS (
        SELECT outbox.id
        FROM public.sentry_discord_alert_outbox AS outbox
        WHERE outbox.status = 'pending'
          AND outbox.next_attempt_at <= clock_timestamp()
          AND (p_dedupe_key IS NULL OR outbox.dedupe_key = p_dedupe_key)
        ORDER BY outbox.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 10)
    ), claimed AS (
        UPDATE public.sentry_discord_alert_outbox AS outbox
        SET status = 'sending',
            attempts = outbox.attempts + 1,
            claim_token = public.uuid_generate_v4(),
            claimed_at = clock_timestamp(),
            delivery_started_at = NULL,
            updated_at = clock_timestamp()
        FROM candidates
        WHERE outbox.id = candidates.id
        RETURNING outbox.*
    )
    SELECT claimed.id, claimed.claim_token, claimed.project_slug, claimed.occurred_at,
           claimed.issue_url, claimed.attempts
    FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_sentry_discord_alert_delivery_started(
    p_outbox_id uuid,
    p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    UPDATE public.sentry_discord_alert_outbox
    SET delivery_started_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE id = p_outbox_id
      AND status = 'sending'
      AND claim_token = p_claim_token
      AND delivery_started_at IS NULL;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_sentry_discord_alert_outbox(
    p_outbox_id uuid,
    p_claim_token uuid,
    p_outcome text,
    p_failure_code text DEFAULT NULL,
    p_retry_after_seconds integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_attempts integer;
BEGIN
    IF p_outcome NOT IN ('sent', 'retry', 'failed', 'ambiguous_failed') THEN
        RAISE EXCEPTION 'SENTRY_DISCORD_OUTBOX_INVALID_OUTCOME';
    END IF;

    SELECT attempts INTO v_attempts
    FROM public.sentry_discord_alert_outbox
    WHERE id = p_outbox_id AND status = 'sending' AND claim_token = p_claim_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'SENTRY_DISCORD_OUTBOX_CLAIM_NOT_FOUND';
    END IF;

    UPDATE public.sentry_discord_alert_outbox
    SET status = CASE
            WHEN p_outcome = 'sent' THEN 'sent'
            WHEN p_outcome = 'retry' AND v_attempts < 3 THEN 'pending'
            WHEN p_outcome = 'ambiguous_failed' THEN 'ambiguous_failed'
            ELSE 'failed'
        END,
        next_attempt_at = CASE
            WHEN p_outcome = 'retry' AND v_attempts < 3 THEN clock_timestamp()
                + make_interval(secs => LEAST(GREATEST(COALESCE(p_retry_after_seconds, 1), 1), 900))
            ELSE next_attempt_at
        END,
        sent_at = CASE WHEN p_outcome = 'sent' THEN clock_timestamp() ELSE sent_at END,
        failure_code = CASE WHEN p_outcome = 'sent' THEN NULL ELSE p_failure_code END,
        claim_token = NULL,
        updated_at = clock_timestamp()
    WHERE id = p_outbox_id;
END;
$$;

-- Only a claim that never reached the pre-send fence can be requeued. A stale
-- fenced claim is terminally ambiguous: the Discord post may have succeeded
-- before a worker/deployment/complete-RPC failure.
CREATE OR REPLACE FUNCTION public.reconcile_stale_sentry_discord_alert_claims(
    p_lease_seconds integer DEFAULT 300
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_count integer;
BEGIN
    UPDATE public.sentry_discord_alert_outbox
    SET status = CASE
            WHEN delivery_started_at IS NULL AND attempts < 3 THEN 'pending'
            WHEN delivery_started_at IS NULL THEN 'failed'
            ELSE 'ambiguous_failed'
        END,
        next_attempt_at = CASE
            WHEN delivery_started_at IS NULL AND attempts < 3 THEN clock_timestamp()
            ELSE next_attempt_at
        END,
        failure_code = CASE
            WHEN delivery_started_at IS NULL AND attempts < 3 THEN 'DISCORD_CLAIM_LEASE_RECOVERED_BEFORE_SEND'
            WHEN delivery_started_at IS NULL THEN 'DISCORD_CLAIM_LEASE_EXPIRED_RETRY_EXHAUSTED'
            ELSE 'DISCORD_CLAIM_LEASE_EXPIRED_AMBIGUOUS'
        END,
        claim_token = NULL,
        claimed_at = NULL,
        updated_at = clock_timestamp()
    WHERE status = 'sending'
      AND claimed_at < clock_timestamp()
            - make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 300), 60), 900));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_sentry_discord_alert_outbox(char, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_sentry_discord_alert_outbox(integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_sentry_discord_alert_outbox(uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_sentry_discord_alert_delivery_started(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_stale_sentry_discord_alert_claims(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_sentry_discord_alert_outbox(char, text, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_sentry_discord_alert_outbox(integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_sentry_discord_alert_outbox(uuid, uuid, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_sentry_discord_alert_delivery_started(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_sentry_discord_alert_claims(integer) TO service_role;
