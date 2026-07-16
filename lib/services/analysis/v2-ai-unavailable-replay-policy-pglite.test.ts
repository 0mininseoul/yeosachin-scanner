import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260716162523_harden_analysis_v2_ai_unavailable_replay_policy.sql',
        import.meta.url
    ),
    'utf8'
);

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const FINALIZE_REQUEST_ID = '22222222-2222-4222-8222-222222222222';

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    pipeline_version TEXT,
    policy_versions_snapshot JSONB
);
CREATE TABLE public.analysis_preflights (consumed_request_id UUID);
CREATE TABLE public.analysis_pipeline_jobs (request_id UUID, job_key TEXT);
CREATE TABLE public.analysis_v2_provider_cleanup_intents (
    request_id UUID,
    completed_at TIMESTAMP WITH TIME ZONE
);
CREATE TABLE public.analysis_v2_provider_runs (request_id UUID, status TEXT);

CREATE TABLE public.analysis_v2_profile_fetch_batches (
    request_id UUID,
    job_key TEXT,
    frozen_unresolved_usernames TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE public.analysis_v2_profile_fetch_outcomes (
    request_id UUID,
    job_key TEXT,
    username TEXT,
    attempt TEXT,
    status TEXT
);
CREATE TABLE public.analysis_v2_ai_scoring_stage_checkpoints (
    request_id UUID,
    stage_kind TEXT,
    batch_key INTEGER,
    payload JSONB
);
CREATE TABLE public.analysis_v2_candidate_feature_rows (
    request_id UUID,
    batch INTEGER,
    candidate_id TEXT,
    instagram_id TEXT,
    terminal_classification TEXT
);

CREATE TABLE public.analysis_v2_result_summaries (
    request_id UUID PRIMARY KEY,
    target_instagram_id TEXT NOT NULL,
    target_profile_image_url TEXT,
    plan_id TEXT NOT NULL,
    followers_declared SMALLINT NOT NULL,
    followers_collected SMALLINT NOT NULL,
    following_declared SMALLINT NOT NULL,
    following_collected SMALLINT NOT NULL,
    detected_mutuals SMALLINT NOT NULL,
    public_mutuals SMALLINT NOT NULL,
    private_mutuals SMALLINT NOT NULL,
    screened_mutuals SMALLINT NOT NULL,
    not_screened_mutuals SMALLINT NOT NULL,
    fetch_unavailable_count SMALLINT NOT NULL,
    media_unavailable_count SMALLINT NOT NULL,
    exclusion_applied BOOLEAN NOT NULL,
    score_policy_version TEXT NOT NULL,
    CONSTRAINT analysis_v2_result_summary_count_check CHECK (TRUE)
);
CREATE TABLE public.analysis_v2_result_coverage_telemetry (
    request_id UUID PRIMARY KEY,
    plan_id TEXT NOT NULL,
    followers_declared SMALLINT NOT NULL,
    followers_collected SMALLINT NOT NULL,
    following_declared SMALLINT NOT NULL,
    following_collected SMALLINT NOT NULL,
    detected_mutuals SMALLINT NOT NULL,
    public_mutuals SMALLINT NOT NULL,
    private_mutuals SMALLINT NOT NULL,
    screened_mutuals SMALLINT NOT NULL,
    not_screened_mutuals SMALLINT NOT NULL,
    fetch_unavailable_count SMALLINT NOT NULL,
    media_unavailable_count SMALLINT NOT NULL,
    CONSTRAINT analysis_v2_result_coverage_telemetry_counts_check CHECK (TRUE)
);

CREATE OR REPLACE FUNCTION public.capture_analysis_v2_result_coverage_telemetry()
RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
CREATE TRIGGER analysis_v2_result_coverage_telemetry_capture
AFTER INSERT ON public.analysis_v2_result_summaries
FOR EACH ROW EXECUTE FUNCTION public.capture_analysis_v2_result_coverage_telemetry();

CREATE OR REPLACE FUNCTION public.load_analysis_v2_operational_observability(UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER
AS $$ SELECT '{"summary":{"resultCoverage":null}}'::JSONB; $$;

CREATE OR REPLACE FUNCTION public.analysis_v2_complete_result_and_purge_internal(
    UUID, TEXT, UUID, TEXT, TEXT
)
RETURNS JSONB LANGUAGE sql AS $$ SELECT '{}'::JSONB; $$;

CREATE TABLE public.analysis_v2_ai_attempts (
    status TEXT NOT NULL,
    CONSTRAINT analysis_v2_ai_attempt_status_check CHECK (
        status IN ('reserved', 'success', 'rate_limited', 'ambiguous', 'rejected')
    )
);

CREATE OR REPLACE FUNCTION public.analysis_v2_terminalize_ai_attempt_internal(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_operation_key TEXT,
    p_attempt SMALLINT, p_reservation_token UUID, p_status TEXT, p_telemetry JSONB
)
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    IF p_status NOT IN ('success', 'rate_limited', 'ambiguous', 'rejected') THEN
        RAISE EXCEPTION 'invalid';
    END IF;
    RETURN '{}'::JSONB;
END;
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_private_names(
    UUID, TEXT, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB
)
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM public.analysis_v2_ai_attempts AS ai_attempt
    WHERE ai_attempt.status = 'rejected';
    RETURN '{}'::JSONB;
END;
$$;
CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_narratives(
    UUID, TEXT, UUID, TEXT, JSONB
)
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM public.analysis_v2_ai_attempts AS ai_attempt
    WHERE ai_attempt.status = 'rejected';
    RETURN '{}'::JSONB;
END;
$$;
CREATE OR REPLACE FUNCTION public.analysis_v2_result_partner_safety_row_matches(
    UUID, TEXT, JSONB
)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM public.analysis_v2_ai_attempts AS ai_attempt
    WHERE ai_attempt.status = 'rejected';
    RETURN TRUE;
END;
$$;
`;

interface ReasonRow {
    instagram_id: string;
    unavailable_reason: string | null;
}

let db: PGlite;

describe('analysis V2 unavailable, replay, and policy PGlite migration', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(bootstrap);
        await db.exec(migration);
    }, 30_000);

    afterAll(async () => {
        await db.close();
    });

    it('derives fetch and AI-response unavailable reasons from the selected fetch outcome', async () => {
        await db.query(
            `INSERT INTO public.analysis_v2_profile_fetch_batches (
                request_id, job_key, frozen_unresolved_usernames
             ) VALUES ($1, 'track:profiles:batch:0', ARRAY['fetch.failed'])`,
            [REQUEST_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_profile_fetch_outcomes (
                request_id, job_key, username, attempt, status
             ) VALUES
                ($1, 'track:profiles:batch:0', 'ai.failed', 'primary', 'success'),
                ($1, 'track:profiles:batch:0', 'fetch.failed', 'fallback', 'failed')`,
            [REQUEST_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_candidate_feature_rows (
                request_id, batch, candidate_id, instagram_id, terminal_classification
             ) VALUES
                ($1, 0, 'candidate:ai', 'ai.failed', 'unavailable'),
                ($1, 0, 'candidate:fetch', 'fetch.failed', 'unavailable'),
                ($1, 0, 'candidate:ok', 'ok.account', 'verified_female')`,
            [REQUEST_ID]
        );

        const reasons = await db.query<ReasonRow>(
            `SELECT instagram_id, unavailable_reason
             FROM public.analysis_v2_candidate_feature_rows
             ORDER BY instagram_id`
        );
        expect(reasons.rows).toEqual([
            { instagram_id: 'ai.failed', unavailable_reason: 'ai_response' },
            { instagram_id: 'fetch.failed', unavailable_reason: 'profile_fetch' },
            { instagram_id: 'ok.account', unavailable_reason: null },
        ]);
    });

    it('rewrites only generated-response fallback validators and accepts the new status', async () => {
        const definitions = await db.query<{ name: string; definition: string }>(
            `SELECT routine.proname AS name, pg_catalog.pg_get_functiondef(routine.oid) AS definition
             FROM pg_catalog.pg_proc AS routine
             JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
             WHERE namespace.nspname = 'public'
               AND routine.proname IN (
                    'analysis_v2_terminalize_ai_attempt_internal',
                    'checkpoint_analysis_v2_private_names',
                    'checkpoint_analysis_v2_narratives',
                    'analysis_v2_result_partner_safety_row_matches'
               )`
        );
        expect(definitions.rows).toHaveLength(4);
        for (const row of definitions.rows) {
            expect(row.definition, row.name).toContain('response_rejected');
        }
        await expect(db.exec(
            "INSERT INTO public.analysis_v2_ai_attempts (status) VALUES ('response_rejected')"
        )).resolves.toBeDefined();
    });

    it('rejects an AI-unavailable public row without its matching rich stage outcome', async () => {
        for (const statement of [
            `INSERT INTO public.analysis_requests (
                id, pipeline_version, policy_versions_snapshot
             ) VALUES ($1, 'v2', '{"aiStage":"ai-stage-policy-v2.4"}')`,
            'INSERT INTO public.analysis_preflights (consumed_request_id) VALUES ($1)',
            `INSERT INTO public.analysis_pipeline_jobs (request_id, job_key)
             VALUES ($1, 'coordinator:finalize')`,
            `INSERT INTO public.analysis_v2_profile_fetch_batches (
                request_id, job_key, frozen_unresolved_usernames
             ) VALUES ($1, 'track:profiles:batch:0', '{}')`,
            `INSERT INTO public.analysis_v2_profile_fetch_outcomes (
                request_id, job_key, username, attempt, status
             ) VALUES ($1, 'track:profiles:batch:0', 'missing.rich', 'primary', 'success')`,
            `INSERT INTO public.analysis_v2_candidate_feature_rows (
                request_id, batch, candidate_id, instagram_id, terminal_classification
             ) VALUES ($1, 0, 'candidate:missing-rich', 'missing.rich', 'unavailable')`,
        ]) {
            await db.query(statement, [FINALIZE_REQUEST_ID]);
        }

        await expect(db.query(
            `SELECT public.complete_analysis_v2_result_and_purge(
                $1, 'coordinator:finalize', $2, 'input-hash', NULL
             )`,
            [FINALIZE_REQUEST_ID, '33333333-3333-4333-8333-333333333333']
        )).rejects.toThrow(/ANALYSIS_V2_RESULT_NOT_READY/);

        const row = await db.query<{ classification: string; reason: string }>(
            `SELECT terminal_classification AS classification, unavailable_reason AS reason
             FROM public.analysis_v2_candidate_feature_rows
             WHERE request_id = $1`,
            [FINALIZE_REQUEST_ID]
        );
        expect(row.rows).toEqual([{
            classification: 'unavailable',
            reason: 'ai_response',
        }]);
    });

    it('exposes only the bounded V2 request policy value to service_role', async () => {
        await db.query(
            `INSERT INTO public.analysis_requests (id, pipeline_version, policy_versions_snapshot)
             VALUES ($1, 'v2', '{"aiStage":"ai-stage-policy-v2.4","risk":"secret"}')`,
            [REQUEST_ID]
        );
        await db.exec('SET ROLE service_role');
        const loaded = await db.query<{ version: string }>(
            'SELECT public.load_analysis_v2_ai_stage_policy_version($1) AS version',
            [REQUEST_ID]
        );
        await db.exec('RESET ROLE');
        expect(loaded.rows).toEqual([{ version: 'ai-stage-policy-v2.4' }]);

        await db.exec('SET ROLE authenticated');
        await expect(db.query(
            'SELECT public.load_analysis_v2_ai_stage_policy_version($1)',
            [REQUEST_ID]
        )).rejects.toThrow(/permission denied/);
        await db.exec('RESET ROLE');
    });
});
