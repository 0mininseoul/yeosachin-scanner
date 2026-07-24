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
                stage TEXT NOT NULL,
                status TEXT NOT NULL,
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
            BEGIN
                IF p_status NOT IN ('success', 'rate_limited', 'ambiguous', 'rejected', 'response_rejected') THEN
                    RAISE EXCEPTION 'invalid';
                END IF;
                RETURN '{}'::JSONB;
            END;
            $$;
        `);
        await db.exec(resolverMigration);
    });

    beforeEach(async () => {
        await db.exec(`
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
