-- Extend the submission-anchored B-lite envelope for new preflights only.
-- Existing cohort rows retain their immutable T+60 clock; no deadline row is rewritten here.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_preflights
    ADD COLUMN IF NOT EXISTS precheckout_blite_deadline_seconds SMALLINT NOT NULL DEFAULT 60;

ALTER TABLE public.analysis_preflights
    DROP CONSTRAINT IF EXISTS analysis_preflights_blite_cohort_clock_check;

ALTER TABLE public.analysis_preflights
    ADD CONSTRAINT analysis_preflights_blite_cohort_clock_check CHECK (
        (NOT precheckout_blite_cohort AND submitted_at IS NULL AND deadline_at IS NULL)
        OR (
            precheckout_blite_cohort
            AND precheckout_blite_deadline_seconds IN (60, 90)
            AND submitted_at = created_at
            AND (
                (precheckout_blite_deadline_seconds = 60
                    AND deadline_at = created_at + INTERVAL '60 seconds')
                OR (precheckout_blite_deadline_seconds = 90
                    AND deadline_at = created_at + INTERVAL '90 seconds')
            )
        )
    );

CREATE OR REPLACE FUNCTION public.enforce_precheckout_blite_preflight_clock_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PRECHECKOUT_BLITE_CREATED_AT_IMMUTABLE', ERRCODE = 'P0001';
        END IF;
        IF NEW.precheckout_blite_deadline_seconds IS DISTINCT FROM OLD.precheckout_blite_deadline_seconds THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PRECHECKOUT_BLITE_CLOCK_IMMUTABLE', ERRCODE = 'P0001';
        END IF;
        IF OLD.precheckout_blite_cohort THEN
            IF NEW.precheckout_blite_cohort IS DISTINCT FROM TRUE
               OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
               OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'PRECHECKOUT_BLITE_CLOCK_IMMUTABLE', ERRCODE = 'P0001';
            END IF;
            -- A legacy T+60 row is immutable. Do not normalize it to T+90 on an update.
            RETURN NEW;
        END IF;
    END IF;

    IF TG_OP = 'INSERT' THEN
        -- Every row created after this migration carries the new deadline version, even while
        -- it is still outside the cohort. Existing rows retain the additive default of 60.
        NEW.precheckout_blite_deadline_seconds := 90;
    END IF;

    IF NEW.precheckout_blite_cohort THEN
        IF NEW.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM NEW.created_at THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PRECHECKOUT_BLITE_CLOCK_ORIGIN_FORBIDDEN', ERRCODE = 'P0001';
        END IF;
        NEW.submitted_at := NEW.created_at;
        IF NEW.precheckout_blite_deadline_seconds = 90 THEN
            IF NEW.deadline_at IS NOT NULL
               AND NEW.deadline_at IS DISTINCT FROM NEW.created_at + INTERVAL '90 seconds' THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'PRECHECKOUT_BLITE_CLOCK_ORIGIN_FORBIDDEN', ERRCODE = 'P0001';
            END IF;
            NEW.deadline_at := NEW.created_at + INTERVAL '90 seconds';
        ELSE
            IF NEW.deadline_at IS NOT NULL
               AND NEW.deadline_at IS DISTINCT FROM NEW.created_at + INTERVAL '60 seconds' THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'PRECHECKOUT_BLITE_CLOCK_ORIGIN_FORBIDDEN', ERRCODE = 'P0001';
            END IF;
            IF NEW.precheckout_blite_deadline_seconds <> 60 THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'PRECHECKOUT_BLITE_CLOCK_ORIGIN_FORBIDDEN', ERRCODE = 'P0001';
            END IF;
            NEW.deadline_at := NEW.created_at + INTERVAL '60 seconds';
        END IF;
    ELSIF NEW.submitted_at IS NOT NULL OR NEW.deadline_at IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_NON_COHORT_CLOCK_FORBIDDEN', ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_precheckout_blite_preflight_clock ON public.analysis_preflights;
CREATE TRIGGER enforce_precheckout_blite_preflight_clock
BEFORE INSERT OR UPDATE OF precheckout_blite_cohort, submitted_at, deadline_at, created_at,
    precheckout_blite_deadline_seconds
ON public.analysis_preflights
FOR EACH ROW
EXECUTE FUNCTION public.enforce_precheckout_blite_preflight_clock_v1();

REVOKE ALL ON FUNCTION public.enforce_precheckout_blite_preflight_clock_v1()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.activate_precheckout_blite_cohort_v1(
    p_preflight_id UUID,
    p_claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_deadline_at TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_preflight_id IS NULL OR p_claim_token IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_preflight.status <> 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at IS NULL
       OR v_preflight.lease_expires_at <= v_now
       OR v_preflight.expires_at <= v_now
       OR v_preflight.pii_scrubbed_at IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST', ERRCODE = 'P0001';
    END IF;

    v_deadline_at := COALESCE(
        v_preflight.deadline_at,
        v_preflight.created_at + CASE
            WHEN v_preflight.precheckout_blite_deadline_seconds = 90
                THEN INTERVAL '90 seconds'
            ELSE INTERVAL '60 seconds'
        END
    );
    IF v_deadline_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST', ERRCODE = 'P0001';
    END IF;

    IF NOT v_preflight.precheckout_blite_cohort THEN
        UPDATE public.analysis_preflights
        SET precheckout_blite_cohort = TRUE,
            updated_at = v_now
        WHERE id = v_preflight.id
        RETURNING * INTO v_preflight;
    END IF;

    IF v_preflight.submitted_at IS NULL
       OR v_preflight.deadline_at IS NULL
       OR v_preflight.deadline_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST', ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'submittedAt', v_preflight.submitted_at,
        'deadlineAt', v_preflight.deadline_at,
        'expiresAt', v_preflight.expires_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.activate_precheckout_blite_cohort_v1(UUID, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.activate_precheckout_blite_cohort_v1(UUID, UUID)
    TO service_role;

NOTIFY pgrst, 'reload schema';
