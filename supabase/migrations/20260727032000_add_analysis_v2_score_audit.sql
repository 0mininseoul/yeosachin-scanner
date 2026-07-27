-- MIGRATION_PREDECESSOR=20260727031000
-- Operator-only score audit. A constant-size trigger stores only a checkpoint locator;
-- recovery reads and expands the retained final-score checkpoint after completion.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.analysis_v2_score_audit_intents (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    source_result_hash VARCHAR(64) NOT NULL CHECK (
        source_result_hash ~ '^[a-f0-9]{64}$'
    ),
    source_generation INTEGER NOT NULL DEFAULT 1 CHECK (
        source_generation BETWEEN 1 AND 1000
    ),
    checkpoint_item_count SMALLINT NOT NULL CHECK (
        checkpoint_item_count BETWEEN 0 AND 900
    ),
    intent_status VARCHAR(16) NOT NULL DEFAULT 'queued' CHECK (
        intent_status IN ('queued','released')
    ),
    retain_until TIMESTAMPTZ NOT NULL DEFAULT (
        pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.analysis_v2_score_audit_sources (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    source_result_hash VARCHAR(64) NOT NULL CHECK (source_result_hash ~ '^[a-f0-9]{64}$'),
    risk_policy_version VARCHAR(64) NOT NULL,
    ai_policy_version VARCHAR(64),
    source_status VARCHAR(16) NOT NULL CHECK (source_status IN ('queued','ready','partial')),
    reason VARCHAR(160),
    captured_count SMALLINT NOT NULL CHECK (captured_count BETWEEN 0 AND 900),
    source_generation INTEGER NOT NULL DEFAULT 1
        CHECK (source_generation BETWEEN 1 AND 1000),
    source_payload JSONB CHECK (
        source_payload IS NULL OR (
            pg_catalog.jsonb_typeof(source_payload) = 'object'
            AND pg_catalog.octet_length(source_payload::TEXT) <= 4194304
        )
    ),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, source_result_hash),
    UNIQUE (request_id, source_generation)
);

CREATE TABLE public.analysis_v2_score_audit_source_rows (
    request_id UUID NOT NULL,
    source_result_hash VARCHAR(64) NOT NULL,
    candidate_id VARCHAR(128) NOT NULL CHECK (candidate_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    instagram_id VARCHAR(30) NOT NULL CHECK (instagram_id ~ '^[a-z0-9._]{1,30}$'),
    gender_provenance VARCHAR(24) NOT NULL CHECK (
        gender_provenance IN ('triage','feature','gender_resolution','unknown','unavailable')
    ),
    account_context VARCHAR(32) NOT NULL CHECK (
        account_context IN ('personal','individual_creator','official_group_or_brand','uncertain')
    ),
    components JSONB NOT NULL,
    signals JSONB NOT NULL,
    weak_partner_adjustment NUMERIC(5,1) NOT NULL CHECK (weak_partner_adjustment IN (-5,0)),
    pre_score NUMERIC(8,4) NOT NULL CHECK (pre_score BETWEEN 0 AND 95),
    raw_score NUMERIC(8,4) NOT NULL CHECK (raw_score BETWEEN 0 AND 100),
    public_score NUMERIC(8,4) NOT NULL CHECK (public_score BETWEEN 1 AND 10),
    natural_display_score NUMERIC(3,1) NOT NULL CHECK (natural_display_score BETWEEN 1 AND 10),
    natural_risk_band VARCHAR(16) NOT NULL CHECK (natural_risk_band IN ('normal','caution','high_risk')),
    final_display_score NUMERIC(3,1) NOT NULL CHECK (final_display_score BETWEEN 1 AND 10),
    final_risk_band VARCHAR(16) NOT NULL CHECK (final_risk_band IN ('normal','caution','high_risk')),
    featured_rank SMALLINT,
    relative_tier_applied BOOLEAN NOT NULL,
    partner_cap_applied BOOLEAN NOT NULL,
    strong_partner_evidence BOOLEAN NOT NULL,
    PRIMARY KEY (request_id, source_result_hash, candidate_id),
    UNIQUE (request_id, source_result_hash, instagram_id),
    FOREIGN KEY (request_id, source_result_hash)
        REFERENCES public.analysis_v2_score_audit_sources(request_id, source_result_hash)
        ON DELETE CASCADE
);

CREATE TABLE public.analysis_v2_score_audit_runs (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_v2_result_summaries(request_id) ON DELETE CASCADE,
    source_result_hash VARCHAR(64),
    risk_policy_version VARCHAR(64),
    ai_policy_version VARCHAR(64),
    source_generation INTEGER NOT NULL DEFAULT 0 CHECK (source_generation BETWEEN 0 AND 1000),
    status VARCHAR(16) NOT NULL CHECK (
        status IN ('queued','processing','ready','partial','inconsistent','failed')
    ),
    reason VARCHAR(160),
    attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE TABLE public.analysis_v2_score_audit_scan_locators (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    locator_class VARCHAR(32) NOT NULL CHECK (
        locator_class IN (
            'missing_intent','unbound_intent','queued_run',
            'retryable_partial','expired_lease','terminal'
        )
    ),
    active BOOLEAN NOT NULL,
    eligible_at TIMESTAMPTZ NOT NULL,
    sort_at TIMESTAMPTZ NOT NULL,
    retain_until TIMESTAMPTZ,
    retention_deadline_epoch BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.analysis_v2_score_audit_rows (
    request_id UUID NOT NULL REFERENCES public.analysis_v2_score_audit_runs(request_id) ON DELETE CASCADE,
    source_result_hash VARCHAR(64) NOT NULL CHECK (source_result_hash ~ '^[a-f0-9]{64}$'),
    candidate_id VARCHAR(128) NOT NULL,
    actual_rank SMALLINT NOT NULL CHECK (actual_rank BETWEEN 1 AND 900),
    instagram_id VARCHAR(30) NOT NULL,
    gender_provenance VARCHAR(24) NOT NULL,
    account_context VARCHAR(32) NOT NULL,
    official_group_excluded BOOLEAN NOT NULL,
    official_group_reason VARCHAR(120),
    components JSONB NOT NULL CHECK (pg_catalog.jsonb_typeof(components) = 'array'),
    signals JSONB NOT NULL CHECK (pg_catalog.jsonb_typeof(signals) = 'object'),
    raw_score_units INTEGER NOT NULL CHECK (raw_score_units BETWEEN 0 AND 1000),
    natural_display_score NUMERIC(3,1) NOT NULL CHECK (natural_display_score BETWEEN 1 AND 10),
    display_score NUMERIC(3,1) NOT NULL CHECK (display_score BETWEEN 1 AND 10),
    risk_band VARCHAR(16) NOT NULL CHECK (risk_band IN ('normal','caution','high_risk')),
    featured_rank SMALLINT,
    relative_tier_applied BOOLEAN NOT NULL,
    partner_cap_applied BOOLEAN NOT NULL,
    strong_partner_evidence BOOLEAN NOT NULL,
    score_consistent BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, source_result_hash, candidate_id),
    UNIQUE (request_id, source_result_hash, actual_rank)
);

CREATE INDEX analysis_v2_score_audit_sources_queue_idx
    ON public.analysis_v2_score_audit_sources(source_status, captured_at, request_id);
CREATE INDEX analysis_v2_score_audit_intents_expiry_idx
    ON public.analysis_v2_score_audit_intents(
        retain_until, request_id
    ) WHERE intent_status = 'queued';
CREATE INDEX analysis_v2_score_audit_scan_locators_ready_unretained_idx
    ON public.analysis_v2_score_audit_scan_locators(
        eligible_at, sort_at, request_id
    ) WHERE active AND retain_until IS NULL;
CREATE INDEX analysis_v2_score_audit_scan_locators_ready_retained_idx
    ON public.analysis_v2_score_audit_scan_locators(
        retention_deadline_epoch, eligible_at, sort_at, request_id
    ) WHERE active AND retain_until IS NOT NULL;
CREATE INDEX analysis_v2_score_audit_scan_locators_expiry_idx
    ON public.analysis_v2_score_audit_scan_locators(
        retain_until, request_id
    ) WHERE active AND retain_until IS NOT NULL;
CREATE INDEX analysis_v2_result_summaries_audit_scan_idx
    ON public.analysis_v2_result_summaries(
        score_policy_version, created_at, request_id
    );

ALTER TABLE public.analysis_v2_score_audit_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_score_audit_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_score_audit_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_score_audit_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_score_audit_source_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_score_audit_source_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_score_audit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_score_audit_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_score_audit_scan_locators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_score_audit_scan_locators FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_score_audit_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_score_audit_rows FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_score_audit_intents,
    public.analysis_v2_score_audit_sources,
    public.analysis_v2_score_audit_source_rows, public.analysis_v2_score_audit_runs,
    public.analysis_v2_score_audit_scan_locators,
    public.analysis_v2_score_audit_rows FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_score_audit_valid_components(p_value JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
    RETURN pg_catalog.jsonb_typeof(p_value) = 'object'
       AND p_value ?& ARRAY[
            'candidateToTargetLikes','candidateToTargetComments',
            'candidateToTargetTagOrCaptionMention','targetToCandidateTagOrCaptionMention',
            'targetToCandidateLike','recentMutual','appearanceExposure'
       ]
       AND p_value - ARRAY[
            'candidateToTargetLikes','candidateToTargetComments',
            'candidateToTargetTagOrCaptionMention','targetToCandidateTagOrCaptionMention',
            'targetToCandidateLike','recentMutual','appearanceExposure'
       ] = '{}'::JSONB
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_each(p_value) AS component(key, value)
            WHERE pg_catalog.jsonb_typeof(component.value) <> 'number'
       );
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

-- Versioned SQL mirror of risk-policy-v2.4 signal-to-component math. The PGlite
-- contract suite compares this function against the canonical TypeScript policy.
CREATE OR REPLACE FUNCTION public.analysis_v2_score_audit_expected_v24_components(
    p_signals JSONB, p_account_context TEXT
)
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT pg_catalog.jsonb_build_object(
        'candidateToTargetLikes',
            LEAST((p_signals->>'candidateLikes')::NUMERIC * 6, 24),
        'candidateToTargetComments',
            LEAST((p_signals->>'candidateComments')::NUMERIC * 2.5, 30),
        'candidateToTargetTagOrCaptionMention',
            CASE WHEN (p_signals->>'candidateTagsTarget')::BOOLEAN THEN 12 ELSE 0 END,
        'targetToCandidateTagOrCaptionMention',
            CASE WHEN (p_signals->>'targetTagsCandidate')::BOOLEAN THEN 8 ELSE 0 END,
        'targetToCandidateLike',
            CASE WHEN p_signals->>'targetLikedCandidate' = 'observed' THEN 5 ELSE 0 END,
        'recentMutual',
            (CASE (p_signals->>'recentMutualRank')::INTEGER
                WHEN 1 THEN 5 WHEN 2 THEN 4.5 WHEN 3 THEN 4 WHEN 4 THEN 3.5
                WHEN 5 THEN 3 WHEN 6 THEN 2.5 WHEN 7 THEN 2 WHEN 8 THEN 1.5
                WHEN 9 THEN 1 WHEN 10 THEN 0.5 ELSE 0
            END) * (CASE p_account_context
                WHEN 'individual_creator' THEN 0.5
                WHEN 'official_group_or_brand' THEN 0
                ELSE 1
            END),
        'appearanceExposure',
            LEAST((
                CASE (p_signals->>'appearanceGrade')::INTEGER
                    WHEN 1 THEN 0 WHEN 2 THEN 3 WHEN 3 THEN 7
                    WHEN 4 THEN 10 WHEN 5 THEN 13
                END + (p_signals->>'exposureScore')::NUMERIC
            ) * 16 / 18, 16) * (CASE p_account_context
                WHEN 'individual_creator' THEN 0.5
                WHEN 'official_group_or_brand' THEN 0
                ELSE 1
            END)
    )
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_score_audit_valid_candidate(p_value JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
    RETURN pg_catalog.jsonb_typeof(p_value) = 'object'
       AND p_value->>'candidateId' ~ '^[A-Za-z0-9._:-]{1,128}$'
       AND p_value->>'username' ~ '^[a-z0-9._]{1,30}$'
       AND p_value->>'accountContext' IN (
            'personal','individual_creator','official_group_or_brand','uncertain'
       )
       AND p_value->>'reverseLikeStatus' IN ('observed','not_observed','not_collected')
       AND pg_catalog.jsonb_typeof(p_value->'uniqueTargetPostsLikedByCandidate') = 'number'
       AND (p_value->>'uniqueTargetPostsLikedByCandidate')::NUMERIC BETWEEN 0 AND 4
       AND pg_catalog.jsonb_typeof(p_value->'boundedCandidateCommentsOnTarget') = 'number'
       AND (p_value->>'boundedCandidateCommentsOnTarget')::NUMERIC BETWEEN 0 AND 12
       AND (p_value->>'boundedCandidateCommentsOnTarget')::NUMERIC
            = pg_catalog.trunc((p_value->>'boundedCandidateCommentsOnTarget')::NUMERIC)
       AND pg_catalog.jsonb_typeof(p_value->'hasCandidateToTargetTagOrCaptionMention') = 'boolean'
       AND pg_catalog.jsonb_typeof(p_value->'hasTargetToCandidateTagOrCaptionMention') = 'boolean'
       AND (p_value->>'uniqueTargetPostsLikedByCandidate')::NUMERIC
            = pg_catalog.trunc((p_value->>'uniqueTargetPostsLikedByCandidate')::NUMERIC)
       AND (p_value->'recentFemaleMutualRank' = 'null'::JSONB
            OR (p_value->>'recentFemaleMutualRank') ~ '^(?:[1-9]|10)$')
       AND pg_catalog.jsonb_typeof(p_value->'appearanceGrade') = 'number'
       AND (p_value->>'appearanceGrade') ~ '^[1-5]$'
       AND pg_catalog.jsonb_typeof(p_value->'exposureScore') = 'number'
       AND (p_value->>'exposureScore')::NUMERIC BETWEEN 0 AND 5
       AND pg_catalog.jsonb_typeof(p_value->'hasWeakPartnerEvidence') = 'boolean'
       AND pg_catalog.jsonb_typeof(p_value->'hasStrongPartnerEvidence') = 'boolean'
       AND NOT (
            (p_value->>'hasWeakPartnerEvidence')::BOOLEAN
            AND (p_value->>'hasStrongPartnerEvidence')::BOOLEAN
       )
       AND pg_catalog.jsonb_typeof(p_value->'relativeTierApplied') = 'boolean'
       AND p_value->>'riskBand' IN ('normal','caution','high_risk')
       AND pg_catalog.jsonb_typeof(p_value->'displayScore') = 'number'
       AND (p_value->>'displayScore')::NUMERIC BETWEEN 1 AND 10
       AND public.analysis_v2_score_audit_valid_components(p_value->'risk'->'components')
       AND p_value->'risk'->>'policyVersion' = 'risk-policy-v2.4'
       AND pg_catalog.jsonb_typeof(p_value->'risk'->'preScore') = 'number'
       AND pg_catalog.jsonb_typeof(p_value->'risk'->'rawScore') = 'number'
       AND pg_catalog.jsonb_typeof(p_value->'risk'->'publicScore') = 'number'
       AND pg_catalog.jsonb_typeof(p_value->'risk'->'displayScore') = 'number'
       AND p_value->'risk'->>'riskBand' IN ('normal','caution','high_risk')
       AND (p_value->'risk'->>'weakPartnerAdjustment') ~ '^(?:-5|0)$'
       AND pg_catalog.jsonb_typeof(p_value->'risk'->'partnerCapApplied') = 'boolean'
       AND pg_catalog.jsonb_typeof(p_value->'hasStrongPartnerEvidence') = 'boolean';
EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_analysis_v2_score_audit_from_stage()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '' SET lock_timeout = '100ms' AS $$
BEGIN
    IF NEW.stage_kind = 'final_score' AND NEW.batch_key = -1 THEN
        BEGIN
            INSERT INTO public.analysis_v2_score_audit_intents (
                request_id, source_result_hash, source_generation,
                checkpoint_item_count
            ) VALUES (
                NEW.request_id, NEW.result_hash, 1, NEW.item_count
            )
            ON CONFLICT (request_id) DO UPDATE SET
                source_result_hash = EXCLUDED.source_result_hash,
                source_generation = CASE
                    WHEN analysis_v2_score_audit_intents.source_result_hash
                            IS DISTINCT FROM EXCLUDED.source_result_hash
                      OR analysis_v2_score_audit_intents.checkpoint_item_count
                            IS DISTINCT FROM EXCLUDED.checkpoint_item_count
                    THEN analysis_v2_score_audit_intents.source_generation + 1
                    ELSE analysis_v2_score_audit_intents.source_generation
                END,
                checkpoint_item_count = EXCLUDED.checkpoint_item_count,
                intent_status = 'queued',
                retain_until = CASE
                    WHEN analysis_v2_score_audit_intents.source_result_hash
                            IS DISTINCT FROM EXCLUDED.source_result_hash
                      OR analysis_v2_score_audit_intents.checkpoint_item_count
                            IS DISTINCT FROM EXCLUDED.checkpoint_item_count
                    THEN pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
                    ELSE analysis_v2_score_audit_intents.retain_until
                END,
                updated_at = CASE
                    WHEN analysis_v2_score_audit_intents.source_result_hash
                            IS DISTINCT FROM EXCLUDED.source_result_hash
                      OR analysis_v2_score_audit_intents.checkpoint_item_count
                            IS DISTINCT FROM EXCLUDED.checkpoint_item_count
                    THEN pg_catalog.clock_timestamp()
                    ELSE analysis_v2_score_audit_intents.updated_at
                END;
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER enqueue_analysis_v2_score_audit_from_stage
AFTER INSERT OR UPDATE ON public.analysis_v2_ai_scoring_stage_checkpoints
FOR EACH ROW EXECUTE FUNCTION public.enqueue_analysis_v2_score_audit_from_stage();

CREATE OR REPLACE FUNCTION public.refresh_analysis_v2_score_audit_scan_locator(
    p_request_id UUID
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_summary public.analysis_v2_result_summaries%ROWTYPE;
    v_intent public.analysis_v2_score_audit_intents%ROWTYPE;
    v_run public.analysis_v2_score_audit_runs%ROWTYPE;
    v_request_status TEXT;
    v_class TEXT := 'terminal';
    v_active BOOLEAN := FALSE;
    v_eligible_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_sort_at TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_retain_until TIMESTAMPTZ;
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_request_id::TEXT, 0)
    );
    SELECT summary.* INTO v_summary
    FROM public.analysis_v2_result_summaries AS summary
    WHERE summary.request_id = p_request_id;
    IF NOT FOUND THEN
        DELETE FROM public.analysis_v2_score_audit_scan_locators
        WHERE request_id = p_request_id;
        RETURN;
    END IF;
    SELECT request.status INTO v_request_status
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id;
    SELECT intent.* INTO v_intent
    FROM public.analysis_v2_score_audit_intents AS intent
    WHERE intent.request_id = p_request_id;
    SELECT run.* INTO v_run
    FROM public.analysis_v2_score_audit_runs AS run
    WHERE run.request_id = p_request_id;

    IF v_request_status = 'completed'
       AND v_summary.score_policy_version = 'risk-policy-v2.4' THEN
        IF v_intent.request_id IS NULL AND v_run.request_id IS NULL THEN
            v_class := 'missing_intent';
            v_active := TRUE;
            v_eligible_at := v_summary.created_at + INTERVAL '5 minutes';
            v_sort_at := v_summary.created_at;
        ELSIF v_intent.intent_status = 'queued' THEN
            v_retain_until := v_intent.retain_until;
            IF v_run.request_id IS NULL
               OR v_run.source_result_hash IS DISTINCT FROM v_intent.source_result_hash
               OR v_run.source_generation IS DISTINCT FROM v_intent.source_generation THEN
                v_class := 'unbound_intent';
                v_active := TRUE;
                v_eligible_at := LEAST(
                    pg_catalog.clock_timestamp(), v_intent.retain_until
                );
                v_sort_at := v_intent.updated_at;
            ELSIF v_run.status = 'queued' THEN
                v_class := 'queued_run';
                v_active := TRUE;
                v_eligible_at := LEAST(
                    pg_catalog.clock_timestamp(), v_intent.retain_until
                );
                v_sort_at := v_run.updated_at;
            ELSIF v_run.status = 'partial'
              AND v_run.reason IN (
                  'SOURCE_EVIDENCE_UNAVAILABLE','SOURCE_CAPTURE_FAILED'
              ) THEN
                v_class := 'retryable_partial';
                v_active := TRUE;
                v_eligible_at := LEAST(
                    pg_catalog.clock_timestamp(), v_intent.retain_until
                );
                v_sort_at := v_run.updated_at;
            ELSIF v_run.status = 'processing' THEN
                v_class := 'expired_lease';
                v_active := TRUE;
                v_eligible_at := LEAST(
                    v_run.lease_expires_at, v_intent.retain_until
                );
                v_sort_at := LEAST(
                    v_run.lease_expires_at, v_intent.retain_until
                );
            END IF;
        END IF;
    END IF;

    INSERT INTO public.analysis_v2_score_audit_scan_locators (
        request_id, locator_class, active, eligible_at, sort_at, retain_until,
        retention_deadline_epoch
    ) VALUES (
        p_request_id, v_class, v_active, v_eligible_at, v_sort_at, v_retain_until,
        CASE WHEN v_retain_until IS NULL THEN NULL ELSE
            pg_catalog.floor(EXTRACT(EPOCH FROM v_retain_until))::BIGINT
        END
    ) ON CONFLICT (request_id) DO UPDATE SET
        locator_class = EXCLUDED.locator_class,
        active = EXCLUDED.active,
        eligible_at = EXCLUDED.eligible_at,
        sort_at = EXCLUDED.sort_at,
        retain_until = EXCLUDED.retain_until,
        retention_deadline_epoch = EXCLUDED.retention_deadline_epoch,
        updated_at = pg_catalog.clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_analysis_v2_score_audit_scan_locator_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM public.refresh_analysis_v2_score_audit_scan_locator(
        CASE WHEN TG_OP = 'DELETE' THEN OLD.request_id ELSE NEW.request_id END
    );
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_analysis_v2_score_audit_scan_locator_request_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM public.refresh_analysis_v2_score_audit_scan_locator(
        CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END
    );
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER refresh_analysis_v2_score_audit_locator_from_summary
AFTER INSERT OR UPDATE OR DELETE ON public.analysis_v2_result_summaries
FOR EACH ROW EXECUTE FUNCTION public.refresh_analysis_v2_score_audit_scan_locator_trigger();
CREATE TRIGGER refresh_analysis_v2_score_audit_locator_from_intent
AFTER INSERT OR UPDATE OR DELETE ON public.analysis_v2_score_audit_intents
FOR EACH ROW EXECUTE FUNCTION public.refresh_analysis_v2_score_audit_scan_locator_trigger();
CREATE TRIGGER refresh_analysis_v2_score_audit_locator_from_run
AFTER INSERT OR UPDATE OR DELETE ON public.analysis_v2_score_audit_runs
FOR EACH ROW EXECUTE FUNCTION public.refresh_analysis_v2_score_audit_scan_locator_trigger();
CREATE TRIGGER refresh_analysis_v2_score_audit_locator_from_request
AFTER UPDATE OF status ON public.analysis_requests
FOR EACH ROW EXECUTE FUNCTION public.refresh_analysis_v2_score_audit_scan_locator_request_trigger();

-- Audit tables are new, so every pre-migration v2.4 completion starts in the
-- missing-intent grace/terminalization state. This set-based backfill makes
-- those rows visible without scanning historical summaries at worker runtime.
INSERT INTO public.analysis_v2_score_audit_scan_locators (
    request_id, locator_class, active, eligible_at, sort_at, retain_until,
    retention_deadline_epoch
)
SELECT summary.request_id, 'missing_intent', TRUE,
       summary.created_at + INTERVAL '5 minutes', summary.created_at, NULL, NULL
FROM public.analysis_v2_result_summaries AS summary
JOIN public.analysis_requests AS request ON request.id = summary.request_id
WHERE request.status = 'completed'
  AND summary.score_policy_version = 'risk-policy-v2.4'
ON CONFLICT (request_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.capture_analysis_v2_score_audit_source(p_request_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_intent public.analysis_v2_score_audit_intents%ROWTYPE;
    v_stage public.analysis_v2_ai_scoring_stage_checkpoints%ROWTYPE;
    v_existing public.analysis_v2_score_audit_sources%ROWTYPE;
    v_policy TEXT;
    v_ai_policy TEXT;
    v_safe_candidates JSONB := '[]'::JSONB;
    v_safe_payload JSONB;
    v_status TEXT := 'queued';
    v_reason TEXT;
    v_count INTEGER := 0;
BEGIN
    SELECT intent.* INTO v_intent
    FROM public.analysis_v2_score_audit_intents AS intent
    WHERE intent.request_id = p_request_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT source.* INTO v_existing
    FROM public.analysis_v2_score_audit_sources AS source
    WHERE source.request_id = p_request_id
      AND source.source_result_hash = v_intent.source_result_hash
      AND source.source_generation = v_intent.source_generation;
    IF FOUND THEN
        RETURN pg_catalog.jsonb_build_object(
            'status', v_existing.source_status,
            'generation', v_intent.source_generation,
            'count', v_existing.captured_count, 'reason', v_existing.reason
        );
    END IF;
    SELECT stage.* INTO v_stage
    FROM public.analysis_v2_ai_scoring_stage_checkpoints AS stage
    WHERE stage.request_id = p_request_id
      AND stage.stage_kind = 'final_score' AND stage.batch_key = -1
      AND stage.result_hash = v_intent.source_result_hash;
    SELECT request.policy_versions_snapshot->>'risk',
           request.policy_versions_snapshot->>'aiStage'
    INTO v_policy, v_ai_policy
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id AND request.pipeline_version = 'v2';
    IF v_stage.request_id IS NULL THEN
        v_status := 'partial';
        v_reason := 'FINAL_SCORE_CHECKPOINT_MISSING';
    ELSIF v_policy IS DISTINCT FROM 'risk-policy-v2.4'
       OR v_stage.payload->>'riskPolicyVersion'
            IS DISTINCT FROM 'risk-policy-v2.4'
       OR pg_catalog.jsonb_typeof(v_stage.payload->'candidates') <> 'array'
       OR pg_catalog.jsonb_array_length(v_stage.payload->'candidates') > 900
       OR pg_catalog.jsonb_array_length(v_stage.payload->'candidates')
            <> v_intent.checkpoint_item_count THEN
        v_status := 'partial';
        v_reason := 'UNSUPPORTED_OR_MALFORMED_POLICY_SNAPSHOT';
    ELSE
        v_count := pg_catalog.jsonb_array_length(v_stage.payload->'candidates');
        SELECT COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'candidateId', item.value->'candidateId',
                'username', item.value->'username',
                'accountContext', item.value->'accountContext',
                'uniqueTargetPostsLikedByCandidate',
                    item.value->'uniqueTargetPostsLikedByCandidate',
                'boundedCandidateCommentsOnTarget',
                    item.value->'boundedCandidateCommentsOnTarget',
                'hasCandidateToTargetTagOrCaptionMention',
                    item.value->'hasCandidateToTargetTagOrCaptionMention',
                'hasTargetToCandidateTagOrCaptionMention',
                    item.value->'hasTargetToCandidateTagOrCaptionMention',
                'reverseLikeStatus', item.value->'reverseLikeStatus',
                'recentFemaleMutualRank', item.value->'recentFemaleMutualRank',
                'appearanceGrade', item.value->'appearanceGrade',
                'exposureScore', item.value->'exposureScore',
                'hasWeakPartnerEvidence', item.value->'hasWeakPartnerEvidence',
                'hasStrongPartnerEvidence', item.value->'hasStrongPartnerEvidence',
                'relativeTierApplied', item.value->'relativeTierApplied',
                'displayScore', item.value->'displayScore',
                'riskBand', item.value->'riskBand',
                'featuredRank', item.value->'featuredRank',
                'risk', pg_catalog.jsonb_build_object(
                    'policyVersion', item.value->'risk'->'policyVersion',
                    'components', item.value->'risk'->'components',
                    'weakPartnerAdjustment',
                        item.value->'risk'->'weakPartnerAdjustment',
                    'preScore', item.value->'risk'->'preScore',
                    'rawScore', item.value->'risk'->'rawScore',
                    'publicScore', item.value->'risk'->'publicScore',
                    'displayScore', item.value->'risk'->'displayScore',
                    'riskBand', item.value->'risk'->'riskBand',
                    'partnerCapApplied', item.value->'risk'->'partnerCapApplied'
                ),
                'genderProvenance', 'unavailable'
            ) ORDER BY item.ordinality
        ), '[]'::JSONB) INTO v_safe_candidates
        FROM pg_catalog.jsonb_array_elements(v_stage.payload->'candidates')
            WITH ORDINALITY AS item(value, ordinality);
        v_safe_payload := pg_catalog.jsonb_build_object(
            'riskPolicyVersion', 'risk-policy-v2.4',
            'candidates', v_safe_candidates
        );
        IF pg_catalog.octet_length(v_safe_payload::TEXT) > 4194304 THEN
            v_status := 'partial';
            v_reason := 'SAFE_SOURCE_PAYLOAD_TOO_LARGE';
            v_count := 0;
            v_safe_payload := NULL;
        END IF;
    END IF;
    INSERT INTO public.analysis_v2_score_audit_sources (
        request_id, source_result_hash, risk_policy_version, ai_policy_version,
        source_status, reason, captured_count, source_generation, source_payload
    ) VALUES (
        p_request_id, v_intent.source_result_hash,
        COALESCE(v_policy, 'unknown'), v_ai_policy, v_status, v_reason,
        CASE WHEN v_status = 'queued' THEN v_count ELSE 0 END,
        v_intent.source_generation,
        CASE WHEN v_status = 'queued' THEN v_safe_payload ELSE NULL END
    ) ON CONFLICT (request_id, source_result_hash) DO NOTHING;
    RETURN pg_catalog.jsonb_build_object(
        'status', v_status, 'generation', v_intent.source_generation,
        'count', CASE WHEN v_status = 'queued' THEN v_count ELSE 0 END,
        'reason', v_reason
    );
EXCEPTION WHEN OTHERS THEN
    RETURN pg_catalog.jsonb_build_object(
        'status','partial','reason','SOURCE_CAPTURE_FAILED'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_analysis_v2_score_audit_source(
    p_request_id UUID, p_result_hash TEXT, p_generation INTEGER
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_source public.analysis_v2_score_audit_sources%ROWTYPE;
    v_count INTEGER;
    v_invalid BOOLEAN;
BEGIN
    SELECT source.* INTO v_source
    FROM public.analysis_v2_score_audit_sources AS source
    WHERE source.request_id = p_request_id
      AND source.source_result_hash = p_result_hash
      AND source.source_generation = p_generation
    FOR UPDATE;
    IF NOT FOUND OR v_source.source_status <> 'queued' THEN
        RETURN pg_catalog.jsonb_build_object(
            'status', COALESCE(v_source.source_status, 'missing')
        );
    END IF;
    v_count := pg_catalog.jsonb_array_length(v_source.source_payload->'candidates');
    SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_source.source_payload->'candidates') AS item(value)
        WHERE public.analysis_v2_score_audit_valid_candidate(item.value)
                IS DISTINCT FROM TRUE
           OR item.value->>'genderProvenance' NOT IN (
                'triage','feature','gender_resolution','unknown','unavailable'
           )
    ) OR (
        SELECT pg_catalog.count(DISTINCT item.value->>'candidateId') <> v_count
            OR pg_catalog.count(DISTINCT item.value->>'username') <> v_count
        FROM pg_catalog.jsonb_array_elements(v_source.source_payload->'candidates') AS item(value)
    ) INTO v_invalid;
    IF v_invalid THEN
        UPDATE public.analysis_v2_score_audit_sources
        SET source_status = 'partial', reason = 'MALFORMED_OR_DUPLICATE_SCORE_SOURCE',
            captured_count = 0, source_payload = NULL
        WHERE request_id = p_request_id AND source_result_hash = p_result_hash
          AND source_generation = p_generation;
        RETURN pg_catalog.jsonb_build_object('status','partial');
    END IF;
    INSERT INTO public.analysis_v2_score_audit_source_rows (
        request_id, source_result_hash, candidate_id, instagram_id, gender_provenance,
        account_context, components, signals, weak_partner_adjustment, pre_score,
        raw_score, public_score, natural_display_score, natural_risk_band,
        final_display_score, final_risk_band, featured_rank, relative_tier_applied,
        partner_cap_applied, strong_partner_evidence
    )
    SELECT p_request_id, p_result_hash, item.value->>'candidateId',
        item.value->>'username', item.value->>'genderProvenance',
        item.value->>'accountContext', item.value->'risk'->'components',
        pg_catalog.jsonb_build_object(
            'candidateLikes', (item.value->>'uniqueTargetPostsLikedByCandidate')::INTEGER,
            'candidateComments', (item.value->>'boundedCandidateCommentsOnTarget')::INTEGER,
            'candidateTagsTarget', (item.value->>'hasCandidateToTargetTagOrCaptionMention')::BOOLEAN,
            'targetTagsCandidate', (item.value->>'hasTargetToCandidateTagOrCaptionMention')::BOOLEAN,
            'targetLikedCandidate', item.value->>'reverseLikeStatus',
            'recentMutualRank', CASE WHEN item.value->'recentFemaleMutualRank' = 'null'::JSONB
                THEN NULL ELSE (item.value->>'recentFemaleMutualRank')::INTEGER END,
            'appearanceGrade', (item.value->>'appearanceGrade')::INTEGER,
            'exposureScore', (item.value->>'exposureScore')::NUMERIC,
            'hasWeakPartnerEvidence', (item.value->>'hasWeakPartnerEvidence')::BOOLEAN,
            'hasStrongPartnerEvidence', (item.value->>'hasStrongPartnerEvidence')::BOOLEAN
        ),
        (item.value->'risk'->>'weakPartnerAdjustment')::NUMERIC,
        (item.value->'risk'->>'preScore')::NUMERIC,
        (item.value->'risk'->>'rawScore')::NUMERIC,
        (item.value->'risk'->>'publicScore')::NUMERIC,
        (item.value->'risk'->>'displayScore')::NUMERIC,
        item.value->'risk'->>'riskBand',
        (item.value->>'displayScore')::NUMERIC, item.value->>'riskBand',
        CASE WHEN item.value->'featuredRank' = 'null'::JSONB THEN NULL
            ELSE (item.value->>'featuredRank')::SMALLINT END,
        (item.value->>'relativeTierApplied')::BOOLEAN,
        (item.value->'risk'->>'partnerCapApplied')::BOOLEAN,
        (item.value->>'hasStrongPartnerEvidence')::BOOLEAN
    FROM pg_catalog.jsonb_array_elements(v_source.source_payload->'candidates') AS item(value)
    ON CONFLICT (request_id, source_result_hash, candidate_id) DO NOTHING;
    IF (
        SELECT pg_catalog.count(*) FROM public.analysis_v2_score_audit_source_rows AS source
        WHERE source.request_id = p_request_id
          AND source.source_result_hash = p_result_hash
    ) <> v_count THEN
        DELETE FROM public.analysis_v2_score_audit_source_rows
        WHERE request_id = p_request_id AND source_result_hash = p_result_hash;
        UPDATE public.analysis_v2_score_audit_sources
        SET source_status = 'partial', reason = 'PUBLIC_CANDIDATE_SOURCE_INCOMPLETE',
            captured_count = 0, source_payload = NULL
        WHERE request_id = p_request_id AND source_result_hash = p_result_hash
          AND source_generation = p_generation;
        RETURN pg_catalog.jsonb_build_object('status','partial');
    END IF;
    UPDATE public.analysis_v2_score_audit_sources
    SET source_status = 'ready', reason = NULL, source_payload = NULL
    WHERE request_id = p_request_id AND source_result_hash = p_result_hash
      AND source_generation = p_generation AND source_status = 'queued';
    RETURN pg_catalog.jsonb_build_object('status','ready','count',v_count);
END;
$$;


-- Final scanner definition: the locator is maintained by point-update triggers,
-- so scans never walk historical summary/run/intent prefixes. One slot is
-- reserved for retention expiry and the remaining slots are globally oldest-first.
CREATE OR REPLACE FUNCTION public.list_analysis_v2_score_audit_candidates(
    p_limit INTEGER DEFAULT 5
)
RETURNS TABLE (request_id UUID) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    WITH params AS MATERIALIZED (
        SELECT LEAST(GREATEST(p_limit, 1), 20) AS take,
               pg_catalog.clock_timestamp() AS scanned_at,
               pg_catalog.floor(EXTRACT(
                   EPOCH FROM pg_catalog.clock_timestamp()
               ))::BIGINT AS scanned_epoch
    ),
    reserved_expiry AS MATERIALIZED (
        SELECT locator.request_id, locator.retain_until AS sort_at, TRUE AS reserved
        FROM public.analysis_v2_score_audit_scan_locators AS locator
        CROSS JOIN params
        WHERE locator.active
          AND locator.retain_until <= params.scanned_at
        ORDER BY locator.retain_until, locator.request_id
        LIMIT (
            SELECT LEAST(5, GREATEST(1, (take + 2) / 3)) FROM params
        )
    ),
    capacity AS MATERIALIZED (
        SELECT GREATEST(params.take - (SELECT count(*) FROM reserved_expiry), 0)
                   AS remaining
        FROM params
    ),
    regular_retained AS MATERIALIZED (
        SELECT locator.request_id, locator.sort_at, FALSE AS reserved
        FROM public.analysis_v2_score_audit_scan_locators AS locator
        CROSS JOIN params
        WHERE locator.active
          AND locator.eligible_at <= params.scanned_at
          AND locator.retain_until > params.scanned_at
          AND locator.retention_deadline_epoch >= params.scanned_epoch
        ORDER BY locator.retention_deadline_epoch, locator.eligible_at,
                 locator.sort_at, locator.request_id
        LIMIT (SELECT remaining FROM capacity)
    ),
    regular_unretained AS MATERIALIZED (
        SELECT locator.request_id, locator.sort_at, FALSE AS reserved
        FROM public.analysis_v2_score_audit_scan_locators AS locator
        CROSS JOIN params
        WHERE locator.active
          AND locator.retain_until IS NULL
          AND locator.eligible_at <= params.scanned_at
        ORDER BY locator.eligible_at, locator.sort_at, locator.request_id
        LIMIT (SELECT remaining FROM capacity)
    )
    SELECT candidate.request_id
    FROM (
        SELECT * FROM reserved_expiry
        UNION ALL
        SELECT * FROM regular_retained
        UNION ALL
        SELECT * FROM regular_unretained
    ) AS candidate
    ORDER BY candidate.reserved DESC, candidate.sort_at, candidate.request_id
    LIMIT (SELECT take FROM params)
$$;

CREATE OR REPLACE FUNCTION public.claim_analysis_v2_score_audit(p_request_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_intent public.analysis_v2_score_audit_intents%ROWTYPE;
    v_run public.analysis_v2_score_audit_runs%ROWTYPE;
    v_source public.analysis_v2_score_audit_sources%ROWTYPE;
    v_summary public.analysis_v2_result_summaries%ROWTYPE;
    v_token UUID := extensions.gen_random_uuid();
BEGIN
    -- Global audit lock order: intent -> summary -> run -> checkpoint.
    -- The hard-TTL purge starts from the same intent-row lock.
    SELECT intent.* INTO v_intent
    FROM public.analysis_v2_score_audit_intents AS intent
    WHERE intent.request_id = p_request_id
    FOR UPDATE;
    SELECT summary.* INTO v_summary
    FROM public.analysis_v2_result_summaries AS summary
    JOIN public.analysis_requests AS request ON request.id = summary.request_id
    WHERE summary.request_id = p_request_id AND request.status = 'completed'
    FOR UPDATE OF summary;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT source.* INTO v_source
    FROM public.analysis_v2_score_audit_sources AS source
    WHERE source.request_id = p_request_id
      AND source.source_result_hash = v_intent.source_result_hash
      AND source.source_generation = v_intent.source_generation;
    IF v_intent.request_id IS NOT NULL
       AND v_intent.retain_until <= pg_catalog.clock_timestamp() THEN
        INSERT INTO public.analysis_v2_score_audit_runs (
            request_id, source_result_hash, source_generation,
            risk_policy_version, ai_policy_version, status, reason
        ) VALUES (
            p_request_id, v_intent.source_result_hash, v_intent.source_generation,
            v_summary.score_policy_version, v_source.ai_policy_version,
            'partial', 'SOURCE_EVIDENCE_EXPIRED'
        ) ON CONFLICT (request_id) DO UPDATE SET
            source_result_hash = EXCLUDED.source_result_hash,
            source_generation = EXCLUDED.source_generation,
            risk_policy_version = EXCLUDED.risk_policy_version,
            ai_policy_version = EXCLUDED.ai_policy_version,
            status = 'partial', reason = 'SOURCE_EVIDENCE_EXPIRED',
            lease_token = NULL, lease_expires_at = NULL,
            updated_at = pg_catalog.clock_timestamp();
        UPDATE public.analysis_v2_score_audit_intents
        SET intent_status = 'released', updated_at = pg_catalog.clock_timestamp()
        WHERE request_id = p_request_id
          AND source_result_hash = v_intent.source_result_hash
          AND source_generation = v_intent.source_generation;
        DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints
        WHERE request_id = p_request_id AND stage_kind = 'final_score'
          AND batch_key = -1 AND result_hash = v_intent.source_result_hash;
        RETURN NULL;
    END IF;
    IF v_intent.request_id IS NULL THEN
        IF v_summary.created_at > pg_catalog.clock_timestamp() - INTERVAL '5 minutes' THEN
            RETURN NULL;
        END IF;
        INSERT INTO public.analysis_v2_score_audit_runs (
            request_id, source_generation, risk_policy_version, status, reason
        ) VALUES (
            p_request_id, 0, v_summary.score_policy_version,
            'partial', 'SOURCE_EVIDENCE_EXPIRED'
        ) ON CONFLICT (request_id) DO UPDATE SET
            status = 'partial', reason = 'SOURCE_EVIDENCE_EXPIRED',
            lease_token = NULL, lease_expires_at = NULL,
            updated_at = pg_catalog.clock_timestamp();
        RETURN NULL;
    END IF;
    IF v_source.request_id IS NOT NULL AND v_source.source_status = 'partial' THEN
        INSERT INTO public.analysis_v2_score_audit_runs (
            request_id, source_result_hash, source_generation,
            risk_policy_version, ai_policy_version, status, reason
        ) VALUES (
            p_request_id, v_intent.source_result_hash, v_intent.source_generation,
            COALESCE(v_source.risk_policy_version, v_summary.score_policy_version),
            v_source.ai_policy_version, 'partial',
            COALESCE(v_source.reason, 'SOURCE_EVIDENCE_UNAVAILABLE')
        ) ON CONFLICT (request_id) DO UPDATE SET
            source_result_hash = EXCLUDED.source_result_hash,
            source_generation = EXCLUDED.source_generation,
            risk_policy_version = EXCLUDED.risk_policy_version,
            ai_policy_version = EXCLUDED.ai_policy_version,
            status = 'partial', reason = EXCLUDED.reason,
            lease_token = NULL, lease_expires_at = NULL,
            updated_at = pg_catalog.clock_timestamp();
        UPDATE public.analysis_v2_score_audit_intents
        SET intent_status = 'released', updated_at = pg_catalog.clock_timestamp()
        WHERE request_id = p_request_id
          AND source_result_hash = v_intent.source_result_hash
          AND source_generation = v_intent.source_generation;
        DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints
        WHERE request_id = p_request_id AND stage_kind = 'final_score'
          AND batch_key = -1 AND result_hash = v_intent.source_result_hash;
        RETURN NULL;
    END IF;
    IF v_summary.score_policy_version IS DISTINCT FROM 'risk-policy-v2.4'
       OR (
            v_source.request_id IS NOT NULL
            AND v_source.risk_policy_version IS DISTINCT FROM 'risk-policy-v2.4'
       ) THEN
        INSERT INTO public.analysis_v2_score_audit_runs (
            request_id, source_result_hash, source_generation, risk_policy_version,
            ai_policy_version, status, reason
        ) VALUES (
            p_request_id, v_intent.source_result_hash, v_intent.source_generation,
            COALESCE(v_source.risk_policy_version, v_summary.score_policy_version),
            v_source.ai_policy_version, 'partial', 'UNSUPPORTED_SCORE_POLICY_VERSION'
        ) ON CONFLICT (request_id) DO UPDATE SET
            source_result_hash = EXCLUDED.source_result_hash,
            source_generation = EXCLUDED.source_generation,
            risk_policy_version = EXCLUDED.risk_policy_version,
            ai_policy_version = EXCLUDED.ai_policy_version,
            status = 'partial', reason = 'UNSUPPORTED_SCORE_POLICY_VERSION',
            lease_token = NULL, lease_expires_at = NULL,
            updated_at = pg_catalog.clock_timestamp();
        UPDATE public.analysis_v2_score_audit_intents
        SET intent_status = 'released', updated_at = pg_catalog.clock_timestamp()
        WHERE request_id = p_request_id
          AND source_result_hash = v_intent.source_result_hash
          AND source_generation = v_intent.source_generation;
        DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints
        WHERE request_id = p_request_id AND stage_kind = 'final_score'
          AND batch_key = -1 AND result_hash = v_intent.source_result_hash;
        RETURN NULL;
    END IF;
    INSERT INTO public.analysis_v2_score_audit_runs (
        request_id, source_result_hash, source_generation,
        risk_policy_version, ai_policy_version, status
    ) VALUES (
        p_request_id, v_intent.source_result_hash, v_intent.source_generation,
        COALESCE(v_source.risk_policy_version, v_summary.score_policy_version),
        v_source.ai_policy_version, 'queued'
    ) ON CONFLICT (request_id) DO UPDATE SET
        source_result_hash = EXCLUDED.source_result_hash,
        source_generation = EXCLUDED.source_generation,
        risk_policy_version = EXCLUDED.risk_policy_version,
        ai_policy_version = EXCLUDED.ai_policy_version,
        status = 'queued', reason = NULL,
        attempt_count = CASE
            WHEN analysis_v2_score_audit_runs.source_result_hash
                    IS DISTINCT FROM EXCLUDED.source_result_hash
              OR analysis_v2_score_audit_runs.source_generation
                    IS DISTINCT FROM EXCLUDED.source_generation
            THEN 0
            ELSE analysis_v2_score_audit_runs.attempt_count
        END,
        lease_token = NULL, lease_expires_at = NULL,
        updated_at = pg_catalog.clock_timestamp()
    WHERE analysis_v2_score_audit_runs.source_result_hash
                IS DISTINCT FROM EXCLUDED.source_result_hash
       OR analysis_v2_score_audit_runs.source_generation
                IS DISTINCT FROM EXCLUDED.source_generation
       OR (
            analysis_v2_score_audit_runs.status = 'partial'
            AND analysis_v2_score_audit_runs.reason IN (
                'SOURCE_EVIDENCE_UNAVAILABLE','SOURCE_EVIDENCE_EXPIRED',
                'SOURCE_CAPTURE_FAILED'
            )
       );
    SELECT * INTO v_run FROM public.analysis_v2_score_audit_runs
    WHERE request_id = p_request_id FOR UPDATE;
    IF v_run.status NOT IN ('queued','processing')
       OR (v_run.status = 'processing' AND v_run.lease_expires_at > pg_catalog.clock_timestamp())
       THEN RETURN NULL; END IF;
    IF v_run.attempt_count >= 20 THEN
        UPDATE public.analysis_v2_score_audit_runs SET status = 'partial',
            reason = 'RETRY_LIMIT_REACHED', lease_token = NULL,
            lease_expires_at = NULL, updated_at = pg_catalog.clock_timestamp()
        WHERE request_id = p_request_id;
        UPDATE public.analysis_v2_score_audit_intents
        SET intent_status = 'released', updated_at = pg_catalog.clock_timestamp()
        WHERE request_id = p_request_id
          AND source_result_hash = v_run.source_result_hash
          AND source_generation = v_run.source_generation;
        DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints
        WHERE request_id = p_request_id AND stage_kind = 'final_score'
          AND batch_key = -1 AND result_hash = v_run.source_result_hash;
        RETURN NULL;
    END IF;
    UPDATE public.analysis_v2_score_audit_runs
    SET status = 'processing', attempt_count = attempt_count + 1,
        lease_token = v_token, lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '2 minutes',
        updated_at = pg_catalog.clock_timestamp()
    WHERE request_id = p_request_id;
    RETURN pg_catalog.jsonb_build_object(
        'leaseToken', v_token::TEXT,
        'sourceResultHash', v_run.source_result_hash,
        'sourceGeneration', v_run.source_generation
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.materialize_analysis_v2_score_audit(
    p_request_id UUID, p_lease_token UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_intent public.analysis_v2_score_audit_intents%ROWTYPE;
    v_run public.analysis_v2_score_audit_runs%ROWTYPE;
    v_source public.analysis_v2_score_audit_sources%ROWTYPE;
    v_summary public.analysis_v2_result_summaries%ROWTYPE;
    v_source_count INTEGER;
    v_result_count INTEGER;
    v_mismatch BOOLEAN;
    v_capture JSONB;
BEGIN
    SELECT * INTO v_intent FROM public.analysis_v2_score_audit_intents
    WHERE request_id = p_request_id FOR UPDATE;
    SELECT * INTO v_run FROM public.analysis_v2_score_audit_runs
    WHERE request_id = p_request_id FOR UPDATE;
    IF NOT FOUND OR v_run.status <> 'processing'
       OR v_run.lease_token IS DISTINCT FROM p_lease_token
       OR v_run.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_SCORE_AUDIT_LEASE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_summary FROM public.analysis_v2_result_summaries
    WHERE request_id = p_request_id;
    SELECT * INTO v_source FROM public.analysis_v2_score_audit_sources
    WHERE request_id = p_request_id
      AND source_result_hash = v_run.source_result_hash
      AND source_generation = v_run.source_generation;
    IF v_source.request_id IS NULL THEN
        v_capture := public.capture_analysis_v2_score_audit_source(p_request_id);
        SELECT * INTO v_source FROM public.analysis_v2_score_audit_sources
        WHERE request_id = p_request_id
          AND source_result_hash = v_run.source_result_hash
          AND source_generation = v_run.source_generation;
    END IF;
    IF v_source.source_status = 'queued' THEN
        PERFORM public.prepare_analysis_v2_score_audit_source(
            p_request_id, v_run.source_result_hash, v_run.source_generation
        );
        SELECT * INTO v_source FROM public.analysis_v2_score_audit_sources
        WHERE request_id = p_request_id
          AND source_result_hash = v_run.source_result_hash
          AND source_generation = v_run.source_generation;
    END IF;
    IF v_source.request_id IS NULL OR v_source.source_status <> 'ready' THEN
        UPDATE public.analysis_v2_score_audit_runs SET status = 'partial',
            reason = COALESCE(
                v_source.reason, v_capture->>'reason', 'SOURCE_EVIDENCE_UNAVAILABLE'
            ),
            lease_token = NULL, lease_expires_at = NULL,
            updated_at = pg_catalog.clock_timestamp()
        WHERE request_id = p_request_id;
        UPDATE public.analysis_v2_score_audit_intents
        SET intent_status = 'released', updated_at = pg_catalog.clock_timestamp()
        WHERE request_id = p_request_id
          AND source_result_hash = v_run.source_result_hash
          AND source_generation = v_run.source_generation;
        DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints
        WHERE request_id = p_request_id AND stage_kind = 'final_score'
          AND batch_key = -1 AND result_hash = v_run.source_result_hash;
        RETURN pg_catalog.jsonb_build_object('status','partial');
    END IF;
    IF v_run.risk_policy_version IS DISTINCT FROM 'risk-policy-v2.4'
       OR v_source.risk_policy_version IS DISTINCT FROM 'risk-policy-v2.4'
       OR v_summary.score_policy_version IS DISTINCT FROM 'risk-policy-v2.4' THEN
        UPDATE public.analysis_v2_score_audit_runs SET status = 'partial',
            reason = 'UNSUPPORTED_SCORE_POLICY_VERSION',
            lease_token = NULL, lease_expires_at = NULL,
            updated_at = pg_catalog.clock_timestamp()
        WHERE request_id = p_request_id;
        UPDATE public.analysis_v2_score_audit_intents
        SET intent_status = 'released', updated_at = pg_catalog.clock_timestamp()
        WHERE request_id = p_request_id
          AND source_result_hash = v_run.source_result_hash
          AND source_generation = v_run.source_generation;
        DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints
        WHERE request_id = p_request_id AND stage_kind = 'final_score'
          AND batch_key = -1 AND result_hash = v_run.source_result_hash;
        RETURN pg_catalog.jsonb_build_object('status','partial');
    END IF;
    SELECT pg_catalog.count(*) INTO v_source_count
    FROM public.analysis_v2_score_audit_source_rows
    WHERE request_id = p_request_id AND source_result_hash = v_run.source_result_hash;
    SELECT pg_catalog.count(*) INTO v_result_count
    FROM public.analysis_v2_female_results WHERE request_id = p_request_id;
    IF v_source_count <> v_source.captured_count
       OR v_result_count <> v_summary.female_count
       OR v_source_count <> v_summary.female_count
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_female_results AS result
            FULL JOIN (
                SELECT * FROM public.analysis_v2_score_audit_source_rows
                WHERE request_id = p_request_id
                  AND source_result_hash = v_run.source_result_hash
            ) AS source
              ON source.request_id = result.request_id
             AND source.candidate_id = result.candidate_id
            WHERE COALESCE(result.request_id, source.request_id) = p_request_id
              AND (result.candidate_id IS NULL OR source.candidate_id IS NULL
                   OR result.instagram_id IS DISTINCT FROM source.instagram_id)
       ) THEN
        UPDATE public.analysis_v2_score_audit_runs SET status = 'partial',
            reason = 'PUBLIC_CANDIDATE_COMPLETENESS_MISMATCH',
            lease_token = NULL, lease_expires_at = NULL,
            updated_at = pg_catalog.clock_timestamp()
        WHERE request_id = p_request_id;
        UPDATE public.analysis_v2_score_audit_intents
        SET intent_status = 'released', updated_at = pg_catalog.clock_timestamp()
        WHERE request_id = p_request_id
          AND source_result_hash = v_run.source_result_hash
          AND source_generation = v_run.source_generation;
        DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints
        WHERE request_id = p_request_id AND stage_kind = 'final_score'
          AND batch_key = -1 AND result_hash = v_run.source_result_hash;
        RETURN pg_catalog.jsonb_build_object('status','partial');
    END IF;

    DELETE FROM public.analysis_v2_score_audit_rows
    WHERE request_id = p_request_id AND source_result_hash = v_run.source_result_hash;
    INSERT INTO public.analysis_v2_score_audit_rows (
        request_id, source_result_hash, candidate_id, actual_rank, instagram_id,
        gender_provenance, account_context, official_group_excluded,
        official_group_reason, components, signals, raw_score_units,
        natural_display_score, display_score, risk_band, featured_rank,
        relative_tier_applied, partner_cap_applied, strong_partner_evidence,
        score_consistent
    )
    SELECT source.request_id, source.source_result_hash, source.candidate_id,
        result.sort_ordinal, source.instagram_id, source.gender_provenance,
        source.account_context, source.account_context = 'official_group_or_brand',
        CASE WHEN source.account_context = 'official_group_or_brand'
            THEN 'OFFICIAL_GROUP_OR_BRAND' ELSE NULL END,
        pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('key','candidateToTargetLikes','contributionUnits',pg_catalog.round((source.components->>'candidateToTargetLikes')::NUMERIC*10)::INTEGER),
            pg_catalog.jsonb_build_object('key','candidateToTargetComments','contributionUnits',pg_catalog.round((source.components->>'candidateToTargetComments')::NUMERIC*10)::INTEGER),
            pg_catalog.jsonb_build_object('key','candidateToTargetTagOrCaptionMention','contributionUnits',pg_catalog.round((source.components->>'candidateToTargetTagOrCaptionMention')::NUMERIC*10)::INTEGER),
            pg_catalog.jsonb_build_object('key','targetToCandidateTagOrCaptionMention','contributionUnits',pg_catalog.round((source.components->>'targetToCandidateTagOrCaptionMention')::NUMERIC*10)::INTEGER),
            pg_catalog.jsonb_build_object('key','targetToCandidateLike','contributionUnits',pg_catalog.round((source.components->>'targetToCandidateLike')::NUMERIC*10)::INTEGER),
            pg_catalog.jsonb_build_object('key','recentMutual','contributionUnits',pg_catalog.round((source.components->>'recentMutual')::NUMERIC*10)::INTEGER),
            pg_catalog.jsonb_build_object('key','appearanceExposure','contributionUnits',pg_catalog.round((source.components->>'appearanceExposure')::NUMERIC*10)::INTEGER),
            pg_catalog.jsonb_build_object('key','weakPartnerAdjustment','contributionUnits',pg_catalog.round(source.weak_partner_adjustment*10)::INTEGER)
        ), source.signals, pg_catalog.round(source.raw_score*10)::INTEGER,
        source.natural_display_score, pg_catalog.round(result.display_score, 1),
        result.risk_band, result.featured_rank, source.relative_tier_applied,
        source.partner_cap_applied, source.strong_partner_evidence,
        FALSE
    FROM public.analysis_v2_score_audit_source_rows AS source
    JOIN public.analysis_v2_female_results AS result
      ON result.request_id = source.request_id AND result.candidate_id = source.candidate_id
    WHERE source.request_id = p_request_id
      AND source.source_result_hash = v_run.source_result_hash
    ORDER BY result.sort_ordinal;

    WITH source_json AS (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'candidateId', source.candidate_id, 'publicScore', source.public_score,
            'accountContext', source.account_context, 'components', source.components
        ) ORDER BY source.candidate_id) AS rows,
        ARRAY_AGG(source.candidate_id ORDER BY source.candidate_id)
            FILTER (WHERE source.strong_partner_evidence) AS strong_ids
        FROM public.analysis_v2_score_audit_source_rows AS source
        WHERE source.request_id = p_request_id
          AND source.source_result_hash = v_run.source_result_hash
    ), expected_relative AS (
        SELECT expected.*
        FROM source_json
        CROSS JOIN LATERAL public.analysis_v2_expected_relative_risk_rows(
            COALESCE(source_json.rows, '[]'::JSONB),
            COALESCE(source_json.strong_ids, ARRAY[]::TEXT[]),
            'risk-policy-v2.4'
        ) AS expected
    ), expected_ranked AS (
        SELECT expected.*,
            pg_catalog.row_number() OVER (
                ORDER BY expected.display_score DESC, expected.candidate_id
            )::SMALLINT AS expected_sort_ordinal,
            pg_catalog.row_number() OVER (
                PARTITION BY expected.risk_band
                ORDER BY expected.display_score DESC, expected.candidate_id
            )::SMALLINT AS expected_band_rank
        FROM expected_relative AS expected
    ), checked AS (
        SELECT source.candidate_id,
            (
                NOT EXISTS (
                    SELECT 1
                    FROM pg_catalog.jsonb_each_text(expected_components.value)
                        AS expected_component(key, value)
                    WHERE pg_catalog.abs(
                        (source.components->>expected_component.key)::NUMERIC
                        - expected_component.value::NUMERIC
                    ) > 0.000000001
                )
                AND source.weak_partner_adjustment = CASE
                    WHEN (source.signals->>'hasWeakPartnerEvidence')::BOOLEAN THEN -5 ELSE 0
                END
                AND source.strong_partner_evidence
                    = (source.signals->>'hasStrongPartnerEvidence')::BOOLEAN
                AND source.pre_score = GREATEST(0, LEAST(
                    (source.components->>'candidateToTargetLikes')::NUMERIC
                    + (source.components->>'candidateToTargetComments')::NUMERIC
                    + (source.components->>'candidateToTargetTagOrCaptionMention')::NUMERIC
                    + (source.components->>'targetToCandidateTagOrCaptionMention')::NUMERIC
                    + (source.components->>'recentMutual')::NUMERIC
                    + (source.components->>'appearanceExposure')::NUMERIC
                    + source.weak_partner_adjustment, 95
                ))
                AND (source.components->>'targetToCandidateLike')::NUMERIC
                    = CASE WHEN source.signals->>'targetLikedCandidate' = 'observed' THEN 5 ELSE 0 END
                AND source.raw_score = GREATEST(0, LEAST(
                    source.pre_score + (source.components->>'targetToCandidateLike')::NUMERIC, 100
                ))
                AND pg_catalog.abs(
                    source.public_score - LEAST(
                        CASE WHEN source.strong_partner_evidence THEN 3.4 ELSE 10 END,
                        1 + 9 * source.raw_score / 100
                    )
                ) <= 0.0001
                AND source.partner_cap_applied = (
                    source.strong_partner_evidence AND (1 + 9 * source.raw_score / 100) > 3.4
                )
                AND source.natural_display_score = pg_catalog.round(source.public_score, 1)
                AND source.natural_risk_band = CASE
                    WHEN source.public_score < 4.2 THEN 'normal'
                    WHEN source.public_score < 6.8 THEN 'caution'
                    ELSE 'high_risk'
                END
                AND result.display_score = expected.display_score
                AND result.risk_band = expected.risk_band
                AND source.relative_tier_applied = expected.relative_tier_applied
                AND result.sort_ordinal = expected.expected_sort_ordinal
                AND result.display_score = source.final_display_score
                AND result.risk_band = source.final_risk_band
                AND source.featured_rank IS NOT DISTINCT FROM CASE
                    WHEN expected.risk_band = 'high_risk'
                         AND expected.expected_band_rank <= 3
                        THEN expected.expected_band_rank
                    WHEN expected.risk_band = 'caution'
                         AND expected.expected_band_rank <= 10
                        THEN expected.expected_band_rank
                    ELSE NULL
                END
                AND result.featured_rank IS NOT DISTINCT FROM CASE
                    WHEN expected.risk_band = 'high_risk'
                         AND expected.expected_band_rank <= 3
                        THEN expected.expected_band_rank
                    WHEN expected.risk_band = 'caution'
                         AND expected.expected_band_rank <= 10
                        THEN expected.expected_band_rank
                    ELSE NULL
                END
            ) AS consistent
        FROM public.analysis_v2_score_audit_source_rows AS source
        JOIN public.analysis_v2_female_results AS result
          ON result.request_id = source.request_id AND result.candidate_id = source.candidate_id
        JOIN expected_ranked AS expected ON expected.candidate_id = source.candidate_id
        CROSS JOIN LATERAL (
            SELECT public.analysis_v2_score_audit_expected_v24_components(
                source.signals, source.account_context
            ) AS value
        ) AS expected_components
        WHERE source.request_id = p_request_id
          AND source.source_result_hash = v_run.source_result_hash
    )
    UPDATE public.analysis_v2_score_audit_rows AS audit
    SET score_consistent = checked.consistent
    FROM checked
    WHERE audit.request_id = p_request_id
      AND audit.source_result_hash = v_run.source_result_hash
      AND audit.candidate_id = checked.candidate_id;

    SELECT EXISTS (
        SELECT 1 FROM public.analysis_v2_score_audit_rows
        WHERE request_id = p_request_id
          AND source_result_hash = v_run.source_result_hash
          AND NOT score_consistent
    ) INTO v_mismatch;
    UPDATE public.analysis_v2_score_audit_runs
    SET status = CASE WHEN v_mismatch THEN 'inconsistent' ELSE 'ready' END,
        reason = CASE WHEN v_mismatch THEN 'EXACT_SCORE_POLICY_MISMATCH' ELSE NULL END,
        lease_token = NULL, lease_expires_at = NULL,
        updated_at = pg_catalog.clock_timestamp()
    WHERE request_id = p_request_id
      AND source_result_hash = v_run.source_result_hash
      AND source_generation = v_run.source_generation
      AND lease_token = p_lease_token;
    UPDATE public.analysis_v2_score_audit_intents
    SET intent_status = 'released', updated_at = pg_catalog.clock_timestamp()
    WHERE request_id = p_request_id
      AND source_result_hash = v_run.source_result_hash
      AND source_generation = v_run.source_generation;
    DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints
    WHERE request_id = p_request_id AND stage_kind = 'final_score'
      AND batch_key = -1 AND result_hash = v_run.source_result_hash;
    RETURN pg_catalog.jsonb_build_object(
        'status', CASE WHEN v_mismatch THEN 'inconsistent' ELSE 'ready' END
    );
END;
$$;

-- Terminal finalization retains only the exact final-score checkpoint named by
-- a nonterminal audit intent. Every other rich staging row is still purged.
CREATE OR REPLACE FUNCTION public.analysis_v2_purge_result_working_set(
    p_request_id UUID,
    p_keep_final BOOLEAN
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF p_request_id IS NULL OR p_keep_final IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    DELETE FROM public.analysis_v2_narrative_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_candidate_score_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_partner_safety_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_reverse_like_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_preliminary_score_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_private_name_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_candidate_feature_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_ai_result_checkpoints WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints AS stage
    WHERE stage.request_id = p_request_id
      AND NOT (
        p_keep_final
        AND stage.stage_kind = 'final_score' AND stage.batch_key = -1
        AND EXISTS (
            SELECT 1
            FROM public.analysis_v2_score_audit_intents AS intent
            LEFT JOIN public.analysis_v2_score_audit_runs AS run
              ON run.request_id = intent.request_id
             AND run.source_result_hash = intent.source_result_hash
             AND run.source_generation = intent.source_generation
            WHERE intent.request_id = p_request_id
              AND intent.source_result_hash = stage.result_hash
              AND intent.intent_status = 'queued'
              AND intent.retain_until > pg_catalog.clock_timestamp()
              AND (
                run.request_id IS NULL
                OR run.status IN ('queued','processing')
              )
        )
      );
    DELETE FROM public.analysis_v2_profile_fetch_batches WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_target_evidence_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_relationship_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_relationship_sides WHERE request_id = p_request_id;
    IF NOT p_keep_final THEN
        DELETE FROM public.analysis_v2_result_summaries WHERE request_id = p_request_id;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_analysis_v2_ai_scoring_stage(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_deleted INTEGER;
BEGIN
    IF p_job_key <> 'coordinator:finalize' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_SCORING_STAGE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    JOIN public.analysis_requests AS request ON request.id = job.request_id
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
      AND job.status = 'completed'
      AND job.input_hash = p_job_input_hash
      AND job.completion_token = p_claim_token
      AND request.pipeline_version = 'v2'
      AND request.status = 'completed'
    FOR UPDATE OF job;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_SCORING_STAGE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints AS stage
    WHERE stage.request_id = p_request_id
      AND NOT (
        stage.stage_kind = 'final_score' AND stage.batch_key = -1
        AND EXISTS (
            SELECT 1
            FROM public.analysis_v2_score_audit_intents AS intent
            LEFT JOIN public.analysis_v2_score_audit_runs AS run
              ON run.request_id = intent.request_id
             AND run.source_result_hash = intent.source_result_hash
             AND run.source_generation = intent.source_generation
            WHERE intent.request_id = p_request_id
              AND intent.source_result_hash = stage.result_hash
              AND intent.intent_status = 'queued'
              AND intent.retain_until > pg_catalog.clock_timestamp()
              AND (
                run.request_id IS NULL
                OR run.status IN ('queued','processing')
              )
        )
      );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_failed_analysis_v2_score_audit_sources(
    p_limit INTEGER DEFAULT 5
)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count INTEGER;
BEGIN
    WITH doomed AS (
        SELECT source.request_id, source.source_result_hash
        FROM public.analysis_v2_score_audit_sources AS source
        JOIN public.analysis_requests AS request ON request.id = source.request_id
        WHERE request.status = 'failed'
        ORDER BY source.captured_at
        LIMIT LEAST(GREATEST(p_limit, 1), 20)
    )
    DELETE FROM public.analysis_v2_score_audit_sources AS source
    USING doomed
    WHERE source.request_id = doomed.request_id
      AND source.source_result_hash = doomed.source_result_hash;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Privacy TTL drain is independent of audit materialization/output capacity.
-- At the hard maximum of 100 requests per invocation, the supported 500-request
-- expiry surge is terminalized and stripped of rich checkpoints within 5 calls.
CREATE OR REPLACE FUNCTION public.purge_expired_analysis_v2_score_audit_evidence(
    p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count INTEGER;
BEGIN
    WITH expired AS MATERIALIZED (
        SELECT intent.request_id, intent.source_result_hash,
               intent.source_generation
        FROM public.analysis_v2_score_audit_intents AS intent
        WHERE intent.intent_status = 'queued'
          AND intent.retain_until <= pg_catalog.clock_timestamp()
        ORDER BY intent.retain_until, intent.request_id
        LIMIT LEAST(GREATEST(p_limit, 1), 100)
        FOR UPDATE SKIP LOCKED
    ),
    terminalized AS (
        INSERT INTO public.analysis_v2_score_audit_runs (
            request_id, source_result_hash, source_generation,
            risk_policy_version, status, reason
        )
        SELECT expired.request_id, expired.source_result_hash,
               expired.source_generation, 'risk-policy-v2.4',
               'partial', 'SOURCE_EVIDENCE_EXPIRED'
        FROM expired
        ON CONFLICT (request_id) DO UPDATE SET
            source_result_hash = EXCLUDED.source_result_hash,
            source_generation = EXCLUDED.source_generation,
            risk_policy_version = EXCLUDED.risk_policy_version,
            status = 'partial', reason = 'SOURCE_EVIDENCE_EXPIRED',
            lease_token = NULL, lease_expires_at = NULL,
            updated_at = pg_catalog.clock_timestamp()
        RETURNING request_id, source_result_hash, source_generation
    ),
    released AS (
        UPDATE public.analysis_v2_score_audit_intents AS intent
        SET intent_status = 'released',
            updated_at = pg_catalog.clock_timestamp()
        FROM terminalized
        WHERE intent.request_id = terminalized.request_id
          AND intent.source_result_hash = terminalized.source_result_hash
          AND intent.source_generation = terminalized.source_generation
        RETURNING intent.request_id, intent.source_result_hash
    ),
    deleted AS (
        DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints AS stage
        USING released
        WHERE stage.request_id = released.request_id
          AND stage.stage_kind = 'final_score'
          AND stage.batch_key = -1
          AND stage.result_hash = released.source_result_hash
        RETURNING stage.request_id
    )
    SELECT pg_catalog.count(*)::INTEGER INTO v_count FROM released;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_score_audit(
    p_request_id UUID, p_cursor INTEGER DEFAULT 0, p_page_size INTEGER DEFAULT 25
)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_run public.analysis_v2_score_audit_runs%ROWTYPE;
    v_rows JSONB;
    v_next INTEGER;
    v_total INTEGER;
BEGIN
    IF p_cursor < 0 OR p_cursor > 100000 OR p_page_size NOT BETWEEN 1 AND 50 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_SCORE_AUDIT_INVALID_PAGE', ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_run FROM public.analysis_v2_score_audit_runs
    WHERE request_id = p_request_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT pg_catalog.count(*) INTO v_total
    FROM public.analysis_v2_score_audit_rows
    WHERE request_id = p_request_id AND source_result_hash = v_run.source_result_hash;
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'candidateId', audit.candidate_id, 'rank', audit.actual_rank,
        'instagramId', audit.instagram_id, 'genderProvenance', audit.gender_provenance,
        'accountContext', audit.account_context,
        'officialGroupExcluded', audit.official_group_excluded,
        'officialGroupReason', audit.official_group_reason,
        'components', audit.components, 'signals', audit.signals,
        'rawScoreUnits', audit.raw_score_units,
        'naturalDisplayScore', audit.natural_display_score,
        'displayScore', audit.display_score, 'riskBand', audit.risk_band,
        'featuredRank', audit.featured_rank,
        'relativeTierApplied', audit.relative_tier_applied,
        'partnerCapApplied', audit.partner_cap_applied,
        'strongPartnerEvidence', audit.strong_partner_evidence,
        'scoreConsistent', audit.score_consistent
    ) ORDER BY audit.actual_rank), '[]'::JSONB) INTO v_rows
    FROM (
        SELECT * FROM public.analysis_v2_score_audit_rows
        WHERE request_id = p_request_id AND source_result_hash = v_run.source_result_hash
        ORDER BY actual_rank OFFSET p_cursor LIMIT p_page_size
    ) AS audit;
    v_next := CASE WHEN p_cursor + p_page_size < v_total
        THEN p_cursor + p_page_size ELSE NULL END;
    RETURN pg_catalog.jsonb_build_object(
        'request', pg_catalog.jsonb_build_object(
            'requestId', v_run.request_id::TEXT, 'status', v_run.status,
            'riskPolicyVersion', v_run.risk_policy_version,
            'aiPolicyVersion', v_run.ai_policy_version,
            'resultHash', v_run.source_result_hash, 'reason', v_run.reason,
            'updatedAt', v_run.updated_at
        ),
        'rows', v_rows, 'nextCursor', v_next,
        'officialGroupCount', (
            SELECT pg_catalog.count(*) FROM public.analysis_v2_score_audit_rows
            WHERE request_id = p_request_id
              AND source_result_hash = v_run.source_result_hash
              AND official_group_excluded
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_score_audit_valid_components(JSONB),
    public.analysis_v2_score_audit_expected_v24_components(JSONB, TEXT),
    public.analysis_v2_score_audit_valid_candidate(JSONB),
    public.enqueue_analysis_v2_score_audit_from_stage(),
    public.refresh_analysis_v2_score_audit_scan_locator(UUID),
    public.refresh_analysis_v2_score_audit_scan_locator_trigger(),
    public.refresh_analysis_v2_score_audit_scan_locator_request_trigger(),
    public.capture_analysis_v2_score_audit_source(UUID),
    public.prepare_analysis_v2_score_audit_source(UUID, TEXT, INTEGER),
    public.list_analysis_v2_score_audit_candidates(INTEGER),
    public.claim_analysis_v2_score_audit(UUID),
    public.materialize_analysis_v2_score_audit(UUID, UUID),
    public.purge_failed_analysis_v2_score_audit_sources(INTEGER),
    public.purge_expired_analysis_v2_score_audit_evidence(INTEGER),
    public.load_analysis_v2_score_audit(UUID, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.capture_analysis_v2_score_audit_source(UUID),
    public.list_analysis_v2_score_audit_candidates(INTEGER),
    public.claim_analysis_v2_score_audit(UUID),
    public.materialize_analysis_v2_score_audit(UUID, UUID),
    public.purge_failed_analysis_v2_score_audit_sources(INTEGER),
    public.purge_expired_analysis_v2_score_audit_evidence(INTEGER),
    public.load_analysis_v2_score_audit(UUID, INTEGER, INTEGER)
    TO service_role;
