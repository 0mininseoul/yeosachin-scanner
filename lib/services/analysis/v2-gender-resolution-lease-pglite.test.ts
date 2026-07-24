import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const baseMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123200_add_analysis_v2_gemini_leases.sql',
        import.meta.url
    ),
    'utf8'
);
const resolverMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260725010000_add_analysis_v2_gender_resolution_stage.sql',
        import.meta.url
    ),
    'utf8'
);

const REQUEST = '123e4567-e89b-42d3-a456-426614174000';
const FEATURE_OPERATION = `feature-analysis:${'a'.repeat(64)}`;
const RESOLVER_OPERATION = `gender-resolution:${'b'.repeat(64)}`;

type AcquireRow = {
    outcome: string;
    slot: number | null;
    lease_claim_token: string | null;
    fence: number | null;
    expires_at: string | null;
};

let db: PGlite;

async function asService<T>(
    sql: string,
    params: unknown[] = []
): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function acquireV2(input: {
    requestId: string;
    jobKey: string;
    operationKey: string;
    stage: string;
    claimToken: string;
}): Promise<AcquireRow> {
    return (await asService<AcquireRow>(
        `SELECT * FROM public.acquire_analysis_v2_gemini_lease_v2(
            $1, $2, $3, $4, 1, $5, 240
        )`,
        [
            input.requestId,
            input.jobKey,
            input.operationKey,
            input.stage,
            input.claimToken,
        ]
    )).rows[0];
}

describe('gender resolver operation-aware lease migration', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE SCHEMA supabase_migrations;
            CREATE TABLE supabase_migrations.schema_migrations(version TEXT PRIMARY KEY);
            INSERT INTO supabase_migrations.schema_migrations(version)
            VALUES ('20260724230000');
            CREATE TABLE public.analysis_requests (
                id UUID PRIMARY KEY,
                pipeline_version TEXT NOT NULL,
                status TEXT NOT NULL
            );
            CREATE TABLE public.analysis_preflights (consumed_request_id UUID);
            CREATE TABLE public.analysis_pipeline_jobs (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                status TEXT NOT NULL,
                lease_token UUID,
                lease_expires_at TIMESTAMP WITH TIME ZONE,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                first_started_at TIMESTAMP WITH TIME ZONE,
                last_error_code TEXT,
                last_error_at TIMESTAMP WITH TIME ZONE,
                updated_at TIMESTAMP WITH TIME ZONE NOT NULL
                    DEFAULT pg_catalog.clock_timestamp(),
                PRIMARY KEY(request_id, job_key)
            );
        `);
        await db.exec(baseMigration);
        await db.exec(`
            CREATE FUNCTION public.analysis_v2_ai_result_cache_key(JSONB)
            RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT SET search_path = ''
            AS $$ SELECT '${'c'.repeat(64)}'::TEXT $$;
            CREATE TABLE public.analysis_v2_ai_attempts (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                job_claim_token UUID NOT NULL,
                operation_key TEXT NOT NULL,
                attempt SMALLINT NOT NULL,
                reservation_token UUID NOT NULL,
                stage TEXT NOT NULL,
                status TEXT NOT NULL,
                model_name TEXT NOT NULL DEFAULT 'gemini-3-flash-preview',
                location TEXT NOT NULL DEFAULT 'global',
                thinking_level TEXT DEFAULT 'LOW',
                media_count SMALLINT NOT NULL DEFAULT 5,
                media_resolution TEXT DEFAULT 'MEDIUM',
                prompt_version TEXT NOT NULL DEFAULT 'gender-resolution-v1',
                schema_version SMALLINT NOT NULL DEFAULT 1,
                max_output_tokens INTEGER NOT NULL DEFAULT 512,
                retry_count SMALLINT NOT NULL DEFAULT 0,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL
                    DEFAULT pg_catalog.clock_timestamp(),
                PRIMARY KEY(request_id, operation_key, attempt),
                CONSTRAINT analysis_v2_ai_attempt_stage_check CHECK (
                    stage IN (
                        'genderTriage', 'featureAnalysis', 'highRiskNarrative',
                        'privateAccountName', 'partnerSafety'
                    )
                ),
                CONSTRAINT analysis_v2_ai_attempt_status_check CHECK (
                    status IN (
                        'reserved', 'success', 'rate_limited', 'ambiguous',
                        'rejected', 'response_rejected'
                    )
                )
            );
            CREATE TABLE public.analysis_v2_ai_result_checkpoints (
                stage TEXT NOT NULL,
                CONSTRAINT analysis_v2_ai_result_checkpoint_stage_check CHECK (
                    stage IN (
                        'genderTriage', 'featureAnalysis', 'highRiskNarrative',
                        'privateAccountName', 'partnerSafety'
                    )
                )
            );
            CREATE FUNCTION public.analysis_v2_terminalize_ai_attempt_internal(
                p_request_id UUID,
                p_job_key TEXT,
                p_claim_token UUID,
                p_operation_key TEXT,
                p_attempt SMALLINT,
                p_reservation_token UUID,
                p_status TEXT,
                p_telemetry JSONB
            )
            RETURNS JSONB LANGUAGE plpgsql SET search_path = ''
            AS $$
            DECLARE
                v_attempt public.analysis_v2_ai_attempts%ROWTYPE;
            BEGIN
                IF p_status NOT IN ('success', 'rate_limited', 'ambiguous', 'rejected', 'response_rejected') THEN
                    RAISE EXCEPTION 'invalid';
                END IF;
                SELECT ai_attempt.*
                INTO v_attempt
                FROM public.analysis_v2_ai_attempts AS ai_attempt
                WHERE ai_attempt.request_id = p_request_id
                  AND ai_attempt.operation_key = p_operation_key
                  AND ai_attempt.attempt = p_attempt
                FOR UPDATE;
                IF NOT FOUND THEN
                    RAISE EXCEPTION USING
                        MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_NOT_READY',
                        ERRCODE = 'P0001';
                END IF;
                IF v_attempt.job_key IS DISTINCT FROM p_job_key
                   OR v_attempt.job_claim_token IS DISTINCT FROM p_claim_token
                   OR v_attempt.reservation_token IS DISTINCT FROM p_reservation_token THEN
                    RAISE EXCEPTION USING
                        MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_FENCE_MISMATCH',
                        ERRCODE = 'P0001';
                END IF;
                IF v_attempt.status <> 'reserved' THEN
                    IF v_attempt.status <> p_status THEN
                        RAISE EXCEPTION USING
                            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_CONFLICT',
                            ERRCODE = 'P0001';
                    END IF;
                    RETURN pg_catalog.jsonb_build_object('status', v_attempt.status);
                END IF;
                UPDATE public.analysis_v2_ai_attempts AS ai_attempt
                SET status = p_status
                WHERE ai_attempt.request_id = p_request_id
                  AND ai_attempt.operation_key = p_operation_key
                  AND ai_attempt.attempt = p_attempt;
                RETURN pg_catalog.jsonb_build_object('status', p_status);
            END;
            $$;
        `);
        await db.exec(resolverMigration);
    });

    beforeEach(async () => {
        await db.exec(`
            DELETE FROM public.analysis_v2_ai_attempts;
            UPDATE public.analysis_v2_gemini_leases
            SET state = 'available',
                fence = 0,
                request_id = NULL,
                job_key = NULL,
                operation_key = NULL,
                stage = NULL,
                attempt = NULL,
                lease_claim_token = NULL,
                acquired_at = NULL,
                expires_at = NULL,
                quarantined_at = NULL;
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    it('allocates feature and resolver independently inside one job identity', async () => {
        const feature = await acquireV2({
            requestId: REQUEST,
            jobKey: 'track:profile-ai:batch:0',
            operationKey: FEATURE_OPERATION,
            stage: 'featureAnalysis',
            claimToken: '223e4567-e89b-42d3-a456-426614174001',
        });
        const resolver = await acquireV2({
            requestId: REQUEST,
            jobKey: 'track:profile-ai:batch:0',
            operationKey: RESOLVER_OPERATION,
            stage: 'genderResolution',
            claimToken: '223e4567-e89b-42d3-a456-426614174002',
        });

        expect(feature).toMatchObject({ outcome: 'acquired', slot: 1 });
        expect(resolver).toMatchObject({ outcome: 'acquired', slot: 2 });
    });

    it('caps resolver leases and quarantines cutoff without blocking a normal stage', async () => {
        const first = await acquireV2({
            requestId: REQUEST,
            jobKey: 'track:profile-ai:batch:0',
            operationKey: RESOLVER_OPERATION,
            stage: 'genderResolution',
            claimToken: '223e4567-e89b-42d3-a456-426614174001',
        });
        await acquireV2({
            requestId: '123e4567-e89b-42d3-a456-426614174002',
            jobKey: 'track:profile-ai:batch:1',
            operationKey: `gender-resolution:${'d'.repeat(64)}`,
            stage: 'genderResolution',
            claimToken: '223e4567-e89b-42d3-a456-426614174002',
        });
        await expect(acquireV2({
            requestId: '123e4567-e89b-42d3-a456-426614174003',
            jobKey: 'track:profile-ai:batch:2',
            operationKey: `gender-resolution:${'e'.repeat(64)}`,
            stage: 'genderResolution',
            claimToken: '223e4567-e89b-42d3-a456-426614174003',
        })).resolves.toMatchObject({ outcome: 'resolver_capacity_pending' });

        const cutoff = (await asService<{
            cutoff: boolean;
            lease_state: string;
        }>(
            `SELECT * FROM public.cutoff_analysis_v2_gemini_lease_v2(
                $1, $2, $3, $4
            )`,
            [
                first.slot,
                '223e4567-e89b-42d3-a456-426614174001',
                first.fence,
                RESOLVER_OPERATION,
            ]
        )).rows[0];
        expect(cutoff).toMatchObject({ cutoff: true, lease_state: 'quarantined' });

        await expect(acquireV2({
            requestId: '123e4567-e89b-42d3-a456-426614174004',
            jobKey: 'track:profile-ai:batch:3',
            operationKey: `feature-analysis:${'f'.repeat(64)}`,
            stage: 'featureAnalysis',
            claimToken: '223e4567-e89b-42d3-a456-426614174004',
        })).resolves.toMatchObject({ outcome: 'acquired', slot: 3 });
    });

    it('atomically terminalizes cutoff with its exact lease and lets success win the race', async () => {
        const jobKey = 'track:profile-ai:batch:0';
        const jobClaim = '323e4567-e89b-42d3-a456-426614174001';
        const reservation = '423e4567-e89b-42d3-a456-426614174001';
        const leaseClaim = '223e4567-e89b-42d3-a456-426614174001';
        const telemetry = {
            stage: 'genderResolution',
            model_name: 'gemini-3-flash-preview',
            location: 'global',
            thinking_level: 'LOW',
            media_count: 5,
            media_resolution: 'MEDIUM',
            prompt_version: 'gender-resolution-v1',
            schema_version: 1,
            max_output_tokens: 512,
            retry_count: 0,
            usage_metadata_status: 'missing',
            usage_complete: false,
            prompt_tokens: null,
            completion_tokens: null,
            total_tokens: null,
            thinking_tokens: null,
            latency_ms: 12,
            estimated_cost_usd: null,
            finish_reason: null,
        };
        await db.query(
            `INSERT INTO public.analysis_v2_ai_attempts(
                request_id, job_key, job_claim_token, operation_key, attempt,
                reservation_token, stage, status
            ) VALUES ($1, $2, $3, $4, 1, $5, 'genderResolution', 'reserved')`,
            [REQUEST, jobKey, jobClaim, RESOLVER_OPERATION, reservation]
        );
        const lease = await acquireV2({
            requestId: REQUEST,
            jobKey,
            operationKey: RESOLVER_OPERATION,
            stage: 'genderResolution',
            claimToken: leaseClaim,
        });
        const cutoff = (await asService<{
            value: {
                outcome: string;
                attempt_status: string;
                lease_state: string;
            };
        }>(
            `SELECT public.cutoff_analysis_v2_gender_resolution_attempt(
                $1, $2, $3, $4, 1::SMALLINT, $5, $6::JSONB, $7, $8, $9
            ) AS value`,
            [
                REQUEST,
                jobKey,
                jobClaim,
                RESOLVER_OPERATION,
                reservation,
                JSON.stringify(telemetry),
                lease.slot,
                leaseClaim,
                lease.fence,
            ]
        )).rows[0].value;
        expect(cutoff).toMatchObject({
            outcome: 'cutoff',
            attempt_status: 'cutoff',
            lease_state: 'quarantined',
        });
        await expect(db.query<{ status: string }>(
            `SELECT status FROM public.analysis_v2_ai_attempts
             WHERE request_id = $1 AND operation_key = $2`,
            [REQUEST, RESOLVER_OPERATION]
        )).resolves.toMatchObject({ rows: [{ status: 'cutoff' }] });

        await db.exec(`
            UPDATE public.analysis_v2_ai_attempts SET status = 'success';
            UPDATE public.analysis_v2_gemini_leases
            SET state = 'leased',
                quarantined_at = NULL
            WHERE slot = 1;
        `);
        const successWon = (await asService<{
            value: {
                outcome: string;
                attempt_status: string;
                lease_state: string;
            };
        }>(
            `SELECT public.cutoff_analysis_v2_gender_resolution_attempt(
                $1, $2, $3, $4, 1::SMALLINT, $5, $6::JSONB, $7, $8, $9
            ) AS value`,
            [
                REQUEST,
                jobKey,
                jobClaim,
                RESOLVER_OPERATION,
                reservation,
                JSON.stringify(telemetry),
                lease.slot,
                leaseClaim,
                lease.fence,
            ]
        )).rows[0].value;
        expect(successWon).toMatchObject({
            outcome: 'already_terminal',
            attempt_status: 'success',
            lease_state: 'leased',
        });
    });

    it('reaps an expired resolver quarantine inside the next acquire lock', async () => {
        const first = await acquireV2({
            requestId: REQUEST,
            jobKey: 'track:profile-ai:batch:0',
            operationKey: RESOLVER_OPERATION,
            stage: 'genderResolution',
            claimToken: '223e4567-e89b-42d3-a456-426614174001',
        });
        await asService(
            `SELECT * FROM public.cutoff_analysis_v2_gemini_lease_v2(
                $1, $2, $3, $4
            )`,
            [
                first.slot,
                '223e4567-e89b-42d3-a456-426614174001',
                first.fence,
                RESOLVER_OPERATION,
            ]
        );
        await db.exec(`
            UPDATE public.analysis_v2_gemini_leases
            SET expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
            WHERE slot = 1;
        `);

        await expect(acquireV2({
            requestId: '123e4567-e89b-42d3-a456-426614174009',
            jobKey: 'track:profile-ai:batch:9',
            operationKey: `gender-resolution:${'9'.repeat(64)}`,
            stage: 'genderResolution',
            claimToken: '223e4567-e89b-42d3-a456-426614174009',
        })).resolves.toMatchObject({ outcome: 'acquired', slot: 1 });
    });

    it('never auto-reaps a predecessor quarantine that requires evidence', async () => {
        const legacy = (await asService<AcquireRow>(
            `SELECT * FROM public.acquire_analysis_v2_gemini_lease(
                $1, $2, 1, $3, 240
            )`,
            [
                REQUEST,
                'track:profile-ai:batch:0',
                '223e4567-e89b-42d3-a456-426614174001',
            ]
        )).rows[0];
        await db.query(
            `UPDATE public.analysis_v2_gemini_leases
             SET state = 'quarantined',
                 expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second',
                 quarantined_at = pg_catalog.clock_timestamp()
             WHERE slot = $1`,
            [legacy.slot]
        );

        await expect(acquireV2({
            requestId: '123e4567-e89b-42d3-a456-426614174008',
            jobKey: 'track:profile-ai:batch:8',
            operationKey: `feature-analysis:${'8'.repeat(64)}`,
            stage: 'featureAnalysis',
            claimToken: '223e4567-e89b-42d3-a456-426614174008',
        })).resolves.toMatchObject({ outcome: 'acquired', slot: 2 });
        await expect(db.query<{
            state: string;
            stage: string | null;
            resolution_evidence_hash: string | null;
        }>(
            `SELECT state, stage, resolution_evidence_hash
             FROM public.analysis_v2_gemini_leases WHERE slot = $1`,
            [legacy.slot]
        )).resolves.toMatchObject({
            rows: [{
                state: 'quarantined',
                stage: null,
                resolution_evidence_hash: null,
            }],
        });
    });

    it('terminalizes an expired reserved resolver before its lease is reaped', async () => {
        const jobKey = 'track:profile-ai:batch:0';
        const jobClaim = '323e4567-e89b-42d3-a456-426614174001';
        const reservation = '423e4567-e89b-42d3-a456-426614174001';
        const leaseClaim = '223e4567-e89b-42d3-a456-426614174001';
        await db.query(
            `INSERT INTO public.analysis_v2_ai_attempts(
                request_id, job_key, job_claim_token, operation_key, attempt,
                reservation_token, stage, status
            ) VALUES ($1, $2, $3, $4, 1, $5, 'genderResolution', 'reserved')`,
            [REQUEST, jobKey, jobClaim, RESOLVER_OPERATION, reservation]
        );
        const lease = await acquireV2({
            requestId: REQUEST,
            jobKey,
            operationKey: RESOLVER_OPERATION,
            stage: 'genderResolution',
            claimToken: leaseClaim,
        });
        await db.query(
            `UPDATE public.analysis_v2_gemini_leases
             SET state = 'quarantined',
                 expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second',
                 quarantined_at = pg_catalog.clock_timestamp()
             WHERE slot = $1`,
            [lease.slot]
        );

        await expect(asService<{ recovered: number }>(
            `SELECT public.recover_analysis_v2_gender_resolution_cutoffs(8)
                AS recovered`
        )).resolves.toMatchObject({ rows: [{ recovered: 1 }] });
        await expect(asService<{ reaped: number }>(
            `SELECT public.reap_analysis_v2_gemini_cutoff_leases_v2(8)
                AS reaped`
        )).resolves.toMatchObject({ rows: [{ reaped: 1 }] });
        await expect(db.query<{ status: string }>(
            `SELECT status FROM public.analysis_v2_ai_attempts
             WHERE request_id = $1 AND operation_key = $2`,
            [REQUEST, RESOLVER_OPERATION]
        )).resolves.toMatchObject({ rows: [{ status: 'cutoff' }] });
        await expect(db.query<{ state: string }>(
            `SELECT state FROM public.analysis_v2_gemini_leases WHERE slot = $1`,
            [lease.slot]
        )).resolves.toMatchObject({ rows: [{ state: 'available' }] });
    });

    it('keeps the v2.6 acquire RPC callable after the additive migration', async () => {
        await expect(asService<AcquireRow>(
            `SELECT * FROM public.acquire_analysis_v2_gemini_lease(
                $1, $2, 1, $3, 240
            )`,
            [
                REQUEST,
                'track:profile-ai:batch:0',
                '223e4567-e89b-42d3-a456-426614174001',
            ]
        )).resolves.toMatchObject({
            rows: [expect.objectContaining({ outcome: 'acquired', slot: 1 })],
        });
    });
});
