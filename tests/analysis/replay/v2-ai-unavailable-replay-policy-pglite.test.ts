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
const rateLimitFallbackMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260717160000_allow_analysis_v2_rate_limit_exhaustion_fallback.sql',
        import.meta.url
    ),
    'utf8'
);

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const FINALIZE_REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const CLAIM_TOKEN = '33333333-3333-4333-8333-333333333333';
const PRIVATE_OPERATION = `private-account-name:${'1'.repeat(64)}`;
const NARRATIVE_OPERATION = `high-risk-narrative:${'2'.repeat(64)}`;
const PARTNER_OPERATION = `partner-safety:${'3'.repeat(64)}`;

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
        request_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000000',
        job_key TEXT NOT NULL DEFAULT 'track:test:batch:0',
        operation_key TEXT NOT NULL DEFAULT 'private-account-name:0000000000000000000000000000000000000000000000000000000000000000',
        attempt SMALLINT NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        model_name TEXT NOT NULL DEFAULT 'gemini-test',
        location TEXT NOT NULL DEFAULT 'global',
        stage TEXT NOT NULL DEFAULT 'privateAccountName',
        thinking_level TEXT,
        media_count SMALLINT NOT NULL DEFAULT 0,
        media_resolution TEXT,
        prompt_version TEXT NOT NULL DEFAULT 'test-v1',
        schema_version SMALLINT NOT NULL DEFAULT 1,
        max_output_tokens INTEGER NOT NULL DEFAULT 512,
        retry_count SMALLINT NOT NULL DEFAULT 0,
        terminalized_at TIMESTAMP WITH TIME ZONE,
        PRIMARY KEY (request_id, operation_key, attempt),
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
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_job_input_hash TEXT,
    p_batch INTEGER, p_source TEXT, p_operation_key TEXT, p_ai_result_hash TEXT,
    p_rows JSONB
)
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    IF p_source = 'safe_fallback' AND NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_ai_attempts AS ai_attempt
        WHERE ai_attempt.request_id = p_request_id
          AND ai_attempt.job_key = p_job_key
          AND ai_attempt.operation_key = p_operation_key
          AND ai_attempt.stage = 'privateAccountName'
          AND ai_attempt.status = 'rejected'
    ) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_RESULT_NOT_READY';
    END IF;
    RETURN '{}'::JSONB;
END;
$$;
CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_narratives(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_job_input_hash TEXT,
    p_rows JSONB
)
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
        WHERE item.value->>'source' = 'safe_fallback'
          AND NOT EXISTS (
            SELECT 1 FROM public.analysis_v2_ai_attempts AS ai_attempt
            WHERE ai_attempt.request_id = p_request_id
              AND ai_attempt.job_key = p_job_key
              AND ai_attempt.operation_key = item.value->>'operationKey'
              AND ai_attempt.stage = 'highRiskNarrative'
              AND ai_attempt.status = 'rejected'
          )
    ) THEN
        RAISE EXCEPTION 'ANALYSIS_V2_RESULT_NOT_READY';
    END IF;
    RETURN '{}'::JSONB;
END;
$$;
CREATE OR REPLACE FUNCTION public.analysis_v2_result_partner_safety_row_matches(
    p_request_id UUID, p_partner_job_key TEXT, p_value JSONB
)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.analysis_v2_ai_attempts AS ai_attempt
        WHERE ai_attempt.request_id = p_request_id
          AND ai_attempt.job_key = p_partner_job_key
          AND ai_attempt.operation_key = p_value->>'operationKey'
          AND ai_attempt.stage = 'partnerSafety'
          AND ai_attempt.status = 'rejected'
    );
END;
$$;
`;

interface ReasonRow {
    instagram_id: string;
    unavailable_reason: string | null;
}

let db: PGlite;

interface AttemptHistoryOptions {
    count?: number;
    driftAttempt?: number;
    nonRateLimitedAttempt?: number;
    unterminatedAttempt?: number;
}

async function seedRateLimitedHistory(input: {
    jobKey: string;
    operationKey: string;
    stage: 'privateAccountName' | 'highRiskNarrative' | 'partnerSafety';
    options?: AttemptHistoryOptions;
}): Promise<void> {
    const count = input.options?.count ?? 4;
    for (let attempt = 1; attempt <= count; attempt += 1) {
        await db.query(
            `INSERT INTO public.analysis_v2_ai_attempts (
                request_id, job_key, operation_key, attempt, status, model_name,
                location, stage, thinking_level, media_count, media_resolution,
                prompt_version, schema_version, max_output_tokens, retry_count,
                terminalized_at
             ) VALUES (
                $1, $2, $3, $4, $5, 'gemini-test', $6, $7,
                'MINIMAL', 1, 'LOW', 'test-v1', 1, 512, $8, $9
             )`,
            [
                REQUEST_ID,
                input.jobKey,
                input.operationKey,
                attempt,
                input.options?.nonRateLimitedAttempt === attempt
                    ? 'ambiguous'
                    : 'rate_limited',
                input.options?.driftAttempt === attempt ? 'us-central1' : 'global',
                input.stage,
                attempt - 1,
                input.options?.unterminatedAttempt === attempt
                    ? null
                    : '2026-07-17T10:00:00Z',
            ]
        );
    }
}

async function seedAllFallbackHistories(options: AttemptHistoryOptions = {}): Promise<void> {
    for (const input of [
        {
            jobKey: 'track:private-names:batch:0',
            operationKey: PRIVATE_OPERATION,
            stage: 'privateAccountName' as const,
        },
        {
            jobKey: 'track:narratives:batch:0',
            operationKey: NARRATIVE_OPERATION,
            stage: 'highRiskNarrative' as const,
        },
        {
            jobKey: 'track:partner-safety:batch:0',
            operationKey: PARTNER_OPERATION,
            stage: 'partnerSafety' as const,
        },
    ]) {
        await seedRateLimitedHistory({ ...input, options });
    }
}

async function seedAllResponseRejectedHistories(): Promise<void> {
    for (const input of [
        ['track:private-names:batch:0', PRIVATE_OPERATION, 'privateAccountName'],
        ['track:narratives:batch:0', NARRATIVE_OPERATION, 'highRiskNarrative'],
        ['track:partner-safety:batch:0', PARTNER_OPERATION, 'partnerSafety'],
    ] as const) {
        await db.query(
            `INSERT INTO public.analysis_v2_ai_attempts (
                request_id, job_key, operation_key, attempt, status, model_name,
                location, stage, thinking_level, media_count, media_resolution,
                prompt_version, schema_version, max_output_tokens, retry_count,
                terminalized_at
             ) VALUES (
                $1, $2, $3, 1, 'response_rejected', 'gemini-test', 'global', $4,
                'MINIMAL', 1, 'LOW', 'test-v1', 1, 512, 0,
                '2026-07-17T10:00:00Z'
             )`,
            [REQUEST_ID, input[0], input[1], input[2]]
        );
    }
}

async function checkpointPrivateFallback() {
    return db.query(
        `SELECT public.checkpoint_analysis_v2_private_names(
            $1, 'track:private-names:batch:0', $2, 'input-hash', 0,
            'safe_fallback', $3, NULL, '[]'::JSONB
         )`,
        [REQUEST_ID, CLAIM_TOKEN, PRIVATE_OPERATION]
    );
}

async function checkpointNarrativeFallback() {
    return db.query(
        `SELECT public.checkpoint_analysis_v2_narratives(
            $1, 'track:narratives:batch:0', $2, 'input-hash', $3::JSONB
         )`,
        [
            REQUEST_ID,
            CLAIM_TOKEN,
            JSON.stringify([{
                source: 'safe_fallback',
                operationKey: NARRATIVE_OPERATION,
            }]),
        ]
    );
}

async function partnerFallbackMatches(): Promise<boolean> {
    const result = await db.query<{ matches: boolean }>(
        `SELECT public.analysis_v2_result_partner_safety_row_matches(
            $1, 'track:partner-safety:batch:0', $2::JSONB
         ) AS matches`,
        [REQUEST_ID, JSON.stringify({ operationKey: PARTNER_OPERATION })]
    );
    return result.rows[0]?.matches ?? false;
}

describe('analysis V2 unavailable, replay, and policy PGlite migration', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(bootstrap);
        await db.exec(migration);
        await db.exec(rateLimitFallbackMigration);
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
                    'analysis_v2_ai_fallback_evidence_matches',
                    'checkpoint_analysis_v2_private_names',
                    'checkpoint_analysis_v2_narratives',
                    'analysis_v2_result_partner_safety_row_matches'
               )`
        );
        expect(definitions.rows).toHaveLength(5);
        for (const row of definitions.rows) {
            if (row.name === 'analysis_v2_terminalize_ai_attempt_internal'
                || row.name === 'analysis_v2_ai_fallback_evidence_matches') {
                expect(row.definition, row.name).toContain('response_rejected');
            } else {
                expect(row.definition, row.name).toContain(
                    'analysis_v2_ai_fallback_evidence_matches'
                );
            }
        }
        await expect(db.exec(
            "INSERT INTO public.analysis_v2_ai_attempts (status) VALUES ('response_rejected')"
        )).resolves.toBeDefined();
    });

    it('preserves response-rejected evidence in every deterministic fallback gate', async () => {
        await db.exec('DELETE FROM public.analysis_v2_ai_attempts');
        await seedAllResponseRejectedHistories();

        await expect(checkpointPrivateFallback()).resolves.toBeDefined();
        await expect(checkpointNarrativeFallback()).resolves.toBeDefined();
        await expect(partnerFallbackMatches()).resolves.toBe(true);
    });

    it('accepts four contiguous terminal rate limits in every deterministic fallback gate', async () => {
        await db.exec('DELETE FROM public.analysis_v2_ai_attempts');
        await seedAllFallbackHistories();

        await expect(checkpointPrivateFallback()).resolves.toBeDefined();
        await expect(checkpointNarrativeFallback()).resolves.toBeDefined();
        await expect(partnerFallbackMatches()).resolves.toBe(true);
    });

    it.each([
        ['only three attempts', { count: 3 }],
        ['a mixed terminal status', { nonRateLimitedAttempt: 3 }],
        ['metadata drift', { driftAttempt: 4 }],
        ['an unterminated attempt', { unterminatedAttempt: 4 }],
    ] satisfies Array<[string, AttemptHistoryOptions]>) (
        'rejects %s in every deterministic fallback gate',
        async (_label, options) => {
            await db.exec('DELETE FROM public.analysis_v2_ai_attempts');
            await seedAllFallbackHistories(options);

            await expect(checkpointPrivateFallback()).rejects.toThrow(
                /ANALYSIS_V2_RESULT_NOT_READY/
            );
            await expect(checkpointNarrativeFallback()).rejects.toThrow(
                /ANALYSIS_V2_RESULT_NOT_READY/
            );
            await expect(partnerFallbackMatches()).resolves.toBe(false);
        }
    );

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
