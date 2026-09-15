import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20260727034000_add_analysis_v2_scheduler_live_operations.sql'
);
const v29ClaimPolicyMigrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20260728100000_allow_scheduler_claim_ai_stage_v29.sql'
);
const v210ClaimPolicyMigrationPath = path.join(
    process.cwd(),
    'supabase/migrations/20260728110000_add_ai_stage_policy_v210.sql'
);
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const jobClaim = '223e4567-e89b-42d3-a456-426614174000';
const operationClaim = '323e4567-e89b-42d3-a456-426614174000';
const operationKey = `gender-triage:${'a'.repeat(64)}`;
let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE ROLE service_role;
        CREATE SCHEMA supabase_migrations;
        CREATE TABLE supabase_migrations.schema_migrations(version TEXT PRIMARY KEY);
        INSERT INTO supabase_migrations.schema_migrations VALUES ('20260727033000');

        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY,
            pipeline_version TEXT NOT NULL,
            status TEXT NOT NULL,
            policy_versions_snapshot JSONB NOT NULL
        );
        CREATE TABLE public.analysis_pipeline_jobs (
            request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
            job_key VARCHAR(160) NOT NULL,
            status TEXT NOT NULL,
            dispatch_state TEXT NOT NULL,
            dispatch_generation INTEGER NOT NULL,
            dispatch_reservation_token UUID,
            dispatch_reserved_at TIMESTAMPTZ,
            dispatched_at TIMESTAMPTZ,
            dispatch_task_name TEXT,
            delivered_at TIMESTAMPTZ,
            lease_token UUID,
            lease_expires_at TIMESTAMPTZ,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            first_started_at TIMESTAMPTZ,
            ai_capacity_deferral_count INTEGER NOT NULL DEFAULT 0,
            last_error_code TEXT,
            last_error_at TIMESTAMPTZ,
            recovery_not_before TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
            PRIMARY KEY (request_id, job_key)
        );
        CREATE TABLE public.analysis_v2_ai_attempts (
            request_id UUID NOT NULL,
            job_key TEXT NOT NULL,
            operation_key TEXT NOT NULL,
            status TEXT NOT NULL,
            job_claim_token UUID NOT NULL DEFAULT '223e4567-e89b-42d3-a456-426614174000',
            attempt SMALLINT NOT NULL DEFAULT 1,
            reservation_token UUID NOT NULL DEFAULT 'd23e4567-e89b-42d3-a456-426614174000',
            model_name TEXT NOT NULL DEFAULT 'gemini-3.1-flash-lite',
            location TEXT NOT NULL DEFAULT 'global',
            stage TEXT NOT NULL DEFAULT 'genderTriage',
            thinking_level TEXT,
            media_count SMALLINT NOT NULL DEFAULT 0,
            media_resolution TEXT,
            prompt_version TEXT NOT NULL DEFAULT 'fixture-v1',
            schema_version SMALLINT NOT NULL DEFAULT 1,
            max_output_tokens INTEGER NOT NULL DEFAULT 512,
            retry_count SMALLINT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        );
        CREATE TABLE public.analysis_v2_gemini_leases (
            slot INTEGER PRIMARY KEY,
            state TEXT NOT NULL,
            fence BIGINT NOT NULL,
            request_id UUID,
            job_key TEXT,
            operation_key TEXT,
            stage TEXT,
            attempt SMALLINT,
            lease_claim_token UUID,
            acquired_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            quarantined_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        );
        CREATE TABLE public.analysis_v2_ai_result_checkpoints (
            request_id UUID NOT NULL,
            job_key TEXT NOT NULL,
            operation_key TEXT NOT NULL,
            stage TEXT NOT NULL
        );
        CREATE TABLE public.analysis_v2_female_results (
            request_id UUID NOT NULL,
            candidate_id TEXT NOT NULL,
            sort_ordinal SMALLINT NOT NULL,
            one_line_overview TEXT NOT NULL,
            narrative_line_one TEXT,
            narrative_line_two TEXT
        );
        CREATE FUNCTION public.analysis_v2_v28_safe_overview_fallback(p_sort_ordinal INTEGER)
        RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = ''
        AS $$ SELECT '안전한 공개 단서만 남긴 총평입니다.'::TEXT $$;
        CREATE FUNCTION public.analysis_v2_valid_ai_operation_key(value TEXT)
        RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = ''
        AS $$ SELECT value ~
            '^(gender-triage|feature-analysis|private-account-name):[0-9a-f]{64}$' $$;
        CREATE FUNCTION public.acquire_analysis_v2_gemini_lease_v2(
            p_request_id UUID,
            p_job_key TEXT,
            p_operation_key TEXT,
            p_stage TEXT,
            p_attempt INTEGER,
            p_claim_token UUID,
            p_lease_seconds INTEGER DEFAULT 240
        )
        RETURNS TABLE(
            outcome TEXT,
            slot SMALLINT,
            lease_claim_token UUID,
            fence BIGINT,
            expires_at TIMESTAMP WITH TIME ZONE
        )
        LANGUAGE sql
        SET search_path = ''
        AS $$
            SELECT
                'capacity_pending'::TEXT,
                NULL::SMALLINT,
                NULL::UUID,
                NULL::BIGINT,
                NULL::TIMESTAMP WITH TIME ZONE
        $$;
        CREATE FUNCTION public.analysis_v2_terminalize_ai_attempt_internal(
            p_request_id UUID,
            p_job_key TEXT,
            p_job_claim_token UUID,
            p_operation_key TEXT,
            p_attempt SMALLINT,
            p_reservation_token UUID,
            p_status TEXT,
            p_telemetry JSONB
        )
        RETURNS VOID LANGUAGE plpgsql SET search_path = ''
        AS $$
        BEGIN
            UPDATE public.analysis_v2_ai_attempts
            SET status = p_status
            WHERE request_id = p_request_id
              AND job_key = p_job_key
              AND job_claim_token = p_job_claim_token
              AND operation_key = p_operation_key
              AND attempt = p_attempt
              AND reservation_token = p_reservation_token
              AND status = 'reserved';
            IF NOT FOUND THEN
                RAISE EXCEPTION 'ANALYSIS_V2_AI_ATTEMPT_CONFLICT'
                    USING ERRCODE = 'P0001';
            END IF;
        END;
        $$;
    `);
    await db.exec(await readFile(migrationPath, 'utf8'));
    await db.exec(await readFile(v29ClaimPolicyMigrationPath, 'utf8'));
    await db.exec(await readFile(v210ClaimPolicyMigrationPath, 'utf8'));
    await db.query(`
        INSERT INTO public.analysis_requests (
            id, pipeline_version, status, policy_versions_snapshot
        ) VALUES (
            $1, 'v2', 'processing',
            '{"pipeline":"v2","risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.8","scheduler":"ai-scheduler-v1"}'
        )
    `, [requestId]);
    await db.query(`
        INSERT INTO public.analysis_pipeline_jobs (
            request_id, job_key, status, dispatch_state, dispatch_generation,
            dispatch_reservation_token, delivered_at, lease_token, lease_expires_at,
            attempt_count
        ) VALUES (
            $1, 'track:profile-ai:batch:0', 'processing', 'delivered', 1,
            '423e4567-e89b-42d3-a456-426614174000', clock_timestamp(), $2,
            clock_timestamp() + interval '10 minutes', 1
        )
    `, [requestId, jobClaim]);
});

afterAll(async () => {
    await db.close();
});

describe('analysis V2 live scheduler migration', () => {
    it('admits v2.10 only after its forward migration while preserving exact scheduler snapshots', async () => {
        const v29RequestId = '133e4567-e89b-42d3-a456-426614174000';
        const v29JobClaim = '143e4567-e89b-42d3-a456-426614174000';
        const v29OperationClaim = '153e4567-e89b-42d3-a456-426614174000';
        const v210RequestId = '113e4567-e89b-42d3-a456-426614174000';
        const v210JobClaim = '123e4567-e89b-42d3-a456-426614174000';
        const v210OperationClaim = '133e4567-e89b-42d3-a456-426614174000';
        const rejectedRequests = [
            {
                id: '163e4567-e89b-42d3-a456-426614174000',
                jobClaim: '193e4567-e89b-42d3-a456-426614174000',
                operationClaim: '223e4567-e89b-42d3-a456-426614174000',
                aiStage: 'ai-stage-policy-v2.7',
                risk: undefined,
                scheduler: undefined,
            },
            {
                id: '173e4567-e89b-42d3-a456-426614174000',
                jobClaim: '203e4567-e89b-42d3-a456-426614174000',
                operationClaim: '233e4567-e89b-42d3-a456-426614174000',
                aiStage: 'ai-stage-policy-v2.9',
                risk: 'risk-policy-v2.3',
                scheduler: undefined,
            },
            {
                id: '183e4567-e89b-42d3-a456-426614174000',
                jobClaim: '213e4567-e89b-42d3-a456-426614174000',
                operationClaim: '243e4567-e89b-42d3-a456-426614174000',
                aiStage: 'ai-stage-policy-v2.9',
                risk: 'risk-policy-v2.4',
                scheduler: 'ai-scheduler-v2',
            },
        ] as const;
        const privateNameOperation = `private-account-name:${'d'.repeat(64)}`;
        const policy = (aiStage: string, risk = 'risk-policy-v2.4', scheduler = 'ai-scheduler-v1') =>
            JSON.stringify({ pipeline: 'v2', risk, aiStage, scheduler });
        const insertClaimableRequest = async (
            id: string,
            snapshot: string,
            claimToken: string
        ) => {
            await db.query(`
                INSERT INTO public.analysis_requests (
                    id, pipeline_version, status, policy_versions_snapshot
                ) VALUES ($1, 'v2', 'processing', $2::jsonb)
            `, [id, snapshot]);
            await db.query(`
                INSERT INTO public.analysis_pipeline_jobs (
                    request_id, job_key, status, dispatch_state, dispatch_generation,
                    dispatch_reservation_token, delivered_at, lease_token, lease_expires_at,
                    attempt_count
                ) VALUES (
                    $1, 'private-names:batch:0', 'processing', 'delivered', 1,
                    '423e4567-e89b-42d3-a456-426614174000', clock_timestamp(), $2,
                    clock_timestamp() + interval '10 minutes', 1
                )
            `, [id, claimToken]);
        };
        const claim = (id: string, claimToken: string, operationClaimToken: string) => db.query<{
            decision: string;
            operation_claim_token: string | null;
        }>(`
            SELECT * FROM public.claim_analysis_v2_scheduler_operation(
                $1, 'private-names:batch:0', $2, $3, 'privateAccountName', $4, 330
            )
        `, [id, claimToken, privateNameOperation, operationClaimToken]);

        try {
            await insertClaimableRequest(
                v29RequestId,
                policy('ai-stage-policy-v2.9'),
                v29JobClaim
            );
            expect((await claim(v29RequestId, v29JobClaim, v29OperationClaim)).rows).toEqual([{
                decision: 'execute',
                operation_claim_token: v29OperationClaim,
                recovery_only: false,
                result_json: null,
                not_before_at: null,
            }]);

            await insertClaimableRequest(
                v210RequestId,
                policy('ai-stage-policy-v2.10'),
                v210JobClaim,
            );
            expect((await claim(v210RequestId, v210JobClaim, v210OperationClaim)).rows).toEqual([{
                decision: 'execute',
                operation_claim_token: v210OperationClaim,
                recovery_only: false,
                result_json: null,
                not_before_at: null,
            }]);

            for (const rejected of rejectedRequests) {
                await insertClaimableRequest(
                    rejected.id,
                    policy(rejected.aiStage, rejected.risk, rejected.scheduler),
                    rejected.jobClaim
                );
                await expect(claim(rejected.id, rejected.jobClaim, rejected.operationClaim))
                    .rejects.toThrow('ANALYSIS_V2_SCHEDULER_OPERATION_POLICY_MISMATCH');
            }
        } finally {
            for (const id of [v29RequestId, v210RequestId, ...rejectedRequests.map(({ id }) => id)]) {
                await db.query(
                    'DELETE FROM public.analysis_v2_scheduler_operations WHERE request_id = $1',
                    [id]
                );
                await db.query(
                    'DELETE FROM public.analysis_pipeline_jobs WHERE request_id = $1',
                    [id]
                );
                await db.query('DELETE FROM public.analysis_requests WHERE id = $1', [id]);
            }
        }
    });

    it('applies the atomic v2.8 presentation guard to v2.10 only', async () => {
        const presentationRequestId = '153e4567-e89b-42d3-a456-426614174000';
        try {
            await db.query(`
                INSERT INTO public.analysis_requests (
                    id, pipeline_version, status, policy_versions_snapshot
                ) VALUES (
                    $1, 'v2', 'processing',
                    '{"pipeline":"v2","risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.10","scheduler":"ai-scheduler-v1"}'::jsonb
                )
            `, [presentationRequestId]);
            await db.query(`
                INSERT INTO public.analysis_v2_female_results (
                    request_id, candidate_id, sort_ordinal, one_line_overview,
                    narrative_line_one, narrative_line_two
                ) VALUES (
                    $1, 'candidate:one', 1,
                    '판독관은 남자친구가 있다고 적힌 소개를 보고 결론을 냈습니다 ㅋㅋ.',
                    '첫 줄 ㅋㅋ.', '둘째 줄 ㅋㅋ.'
                )
            `, [presentationRequestId]);
            await db.query('SELECT public.analysis_v2_apply_v28_summary_tone($1)', [presentationRequestId]);
            const guarded = await db.query<{
                overview: string;
                line_one: string | null;
                line_two: string | null;
            }>(`
                SELECT one_line_overview AS overview,
                    narrative_line_one AS line_one, narrative_line_two AS line_two
                FROM public.analysis_v2_female_results WHERE request_id = $1
            `, [presentationRequestId]);
            expect(guarded.rows).toEqual([{
                overview: '안전한 공개 단서만 남긴 총평입니다.',
                line_one: '첫 줄 .',
                line_two: '둘째 줄 .',
            }]);
        } finally {
            await db.query('DELETE FROM public.analysis_v2_female_results WHERE request_id = $1', [presentationRequestId]);
            await db.query('DELETE FROM public.analysis_requests WHERE id = $1', [presentationRequestId]);
        }
    });

    it('claims, defers without generation churn, recovers from a checkpoint, and commits once', async () => {
        const claim = async (token: string) => db.query<{
            decision: string;
            operation_claim_token: string | null;
            recovery_only: boolean;
            result_json: unknown;
        }>(`
            SELECT * FROM public.claim_analysis_v2_scheduler_operation(
                $1, 'track:profile-ai:batch:0', $2, $3, 'genderTriage', $4, 330
            )
        `, [requestId, jobClaim, operationKey, token]);

        expect((await claim(operationClaim)).rows).toMatchObject([{
            decision: 'execute',
            operation_claim_token: operationClaim,
            recovery_only: false,
            result_json: null,
        }]);
        expect((await claim('523e4567-e89b-42d3-a456-426614174000')).rows)
            .toMatchObject([{
                decision: 'deferred',
                recovery_only: false,
                operation_claim_token: null,
            }]);

        await db.query(`
            INSERT INTO public.analysis_v2_ai_result_checkpoints
                (request_id, job_key, operation_key, stage)
            VALUES ($1, 'track:profile-ai:batch:0', $2, 'genderTriage')
        `, [requestId, operationKey]);
        const recoveryToken = '623e4567-e89b-42d3-a456-426614174000';
        expect((await claim(recoveryToken)).rows).toMatchObject([{
            decision: 'execute',
            operation_claim_token: recoveryToken,
            recovery_only: true,
        }]);

        const committed = await db.query<{ committed: boolean }>(`
            SELECT public.commit_analysis_v2_scheduler_operation(
                $1, 'track:profile-ai:batch:0', $2, $3, 'genderTriage', $4,
                '{"value":"female"}'::jsonb
            ) AS committed
        `, [requestId, jobClaim, operationKey, recoveryToken]);
        expect(committed.rows).toEqual([{ committed: true }]);
        expect((await claim('723e4567-e89b-42d3-a456-426614174000')).rows)
            .toMatchObject([{
                decision: 'ready',
                operation_claim_token: null,
                recovery_only: false,
                result_json: { value: 'female' },
            }]);
    });

    it('reclaims only a fully terminalized rate-limit history for the next retry', async () => {
        const retryOperation = `feature-analysis:${'b'.repeat(64)}`;
        await db.query(`
            SELECT * FROM public.claim_analysis_v2_scheduler_operation(
                $1, 'track:profile-ai:batch:0', $2, $3, 'featureAnalysis',
                '923e4567-e89b-42d3-a456-426614174000', 330
            )
        `, [requestId, jobClaim, retryOperation]);
        await db.query(`
            INSERT INTO public.analysis_v2_ai_attempts
                (request_id, job_key, operation_key, status)
            VALUES ($1, 'track:profile-ai:batch:0', $2, 'rate_limited')
        `, [requestId, retryOperation]);
        const deferred = await db.query<{
            decision: string;
            recovery_only: boolean;
        }>(`
            SELECT * FROM public.claim_analysis_v2_scheduler_operation(
                $1, 'track:profile-ai:batch:0', $2, $3, 'featureAnalysis',
                'a23e4567-e89b-42d3-a456-426614174000', 330
            )
        `, [requestId, jobClaim, retryOperation]);
        expect(deferred.rows).toMatchObject([{
            decision: 'deferred',
            recovery_only: false,
        }]);
        await db.query(`
            UPDATE public.analysis_v2_scheduler_operations
            SET lease_expires_at = clock_timestamp() - interval '1 second'
            WHERE request_id = $1 AND operation_key = $2
        `, [requestId, retryOperation]);
        const reclaimed = await db.query<{
            decision: string;
            recovery_only: boolean;
        }>(`
            SELECT * FROM public.claim_analysis_v2_scheduler_operation(
                $1, 'track:profile-ai:batch:0', $2, $3, 'featureAnalysis',
                'b23e4567-e89b-42d3-a456-426614174000', 330
            )
        `, [requestId, jobClaim, retryOperation]);
        expect(reclaimed.rows).toMatchObject([{
            decision: 'execute',
            recovery_only: false,
        }]);
    });

    it.each([
        { stage: 'genderTriage', prefix: 'gender-triage', limit: 6 },
        { stage: 'featureAnalysis', prefix: 'feature-analysis', limit: 3 },
        { stage: 'privateAccountName', prefix: 'private-account-name', limit: 2 },
    ])(
        'enforces deployment-wide $stage admission while preserving exact replay',
        async ({ stage, prefix, limit }) => {
            const activeOperations = Array.from({ length: limit }, (_, index) => (
                `${prefix}:${String(index + 1).repeat(64)}`
            ));
            for (const [index, activeOperation] of activeOperations.entries()) {
                await db.query(`
                    INSERT INTO public.analysis_v2_gemini_leases (
                        slot, state, fence, request_id, job_key, operation_key, stage,
                        attempt, lease_claim_token, acquired_at, expires_at
                    ) VALUES (
                        $1::INTEGER, 'leased', $1::BIGINT, $2,
                        'track:profile-ai:batch:0', $3, $4,
                        1, $5, clock_timestamp(),
                        clock_timestamp() + interval '4 minutes'
                    )
                `, [
                    index + 1,
                    requestId,
                    activeOperation,
                    stage,
                    `${index + 1}13e4567-e89b-42d3-a456-426614174000`,
                ]);
            }

            const replay = await db.query<{ outcome: string; slot: number }>(`
                SELECT outcome, slot
                FROM public.acquire_analysis_v2_scheduler_gemini_lease_v1(
                    $1, 'track:profile-ai:batch:0', $2, $3, 1,
                    '113e4567-e89b-42d3-a456-426614174000', 240
                )
            `, [requestId, activeOperations[0], stage]);
            expect(replay.rows).toEqual([{ outcome: 'acquired', slot: 1 }]);

            const blocked = await db.query<{ outcome: string; slot: number | null }>(`
                SELECT outcome, slot
                FROM public.acquire_analysis_v2_scheduler_gemini_lease_v1(
                    $1, 'track:profile-ai:batch:0', $2, $3, 1,
                    '713e4567-e89b-42d3-a456-426614174000', 240
                )
            `, [requestId, `${prefix}:${'f'.repeat(64)}`, stage]);
            expect(blocked.rows).toEqual([{
                outcome: 'capacity_pending',
                slot: null,
            }]);

            await db.query('DELETE FROM public.analysis_v2_gemini_leases');
        }
    );

    it('persists continuation delay so enqueue-failure recovery cannot dispatch early', async () => {
        const continued = await db.query<{
            reserved: boolean;
            dispatch_generation: number;
            reservation_token: string;
            job_status: string;
            dispatch_state: string;
            attempt_count: number;
        }>(`
            SELECT * FROM public.continue_analysis_v2_scheduler_job(
                $1, 'track:profile-ai:batch:0', $2,
                '823e4567-e89b-42d3-a456-426614174000',
                'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT',
                30
            )
        `, [requestId, jobClaim]);

        expect(continued.rows).toMatchObject([{
            reserved: true,
            dispatch_generation: 2,
            reservation_token: '823e4567-e89b-42d3-a456-426614174000',
            job_status: 'pending',
            dispatch_state: 'reserved',
            attempt_count: 0,
        }]);
        const persisted = await db.query(`
            SELECT
                status, dispatch_state, dispatch_generation, lease_token, attempt_count,
                scheduler_not_before_at > clock_timestamp() AS scheduler_delayed
            FROM public.analysis_pipeline_jobs
            WHERE request_id = $1 AND job_key = 'track:profile-ai:batch:0'
        `, [requestId]);
        expect(persisted.rows).toEqual([{
            status: 'pending',
            dispatch_state: 'reserved',
            dispatch_generation: 2,
            lease_token: null,
            attempt_count: 0,
            scheduler_delayed: true,
        }]);
        const early = await db.query(`
            SELECT * FROM public.list_analysis_v2_dispatchable_jobs(100)
        `);
        expect(early.rows).toEqual([]);
        await db.query(`
            UPDATE public.analysis_pipeline_jobs
            SET scheduler_not_before_at = clock_timestamp() - interval '1 second'
            WHERE request_id = $1 AND job_key = 'track:profile-ai:batch:0'
        `, [requestId]);
        const ready = await db.query<{ job_key: string }>(`
            SELECT job_key FROM public.list_analysis_v2_dispatchable_jobs(100)
        `);
        expect(ready.rows).toEqual([{ job_key: 'track:profile-ai:batch:0' }]);
    });

    it('terminalizes an expired reserved operation and never re-opens paid execution', async () => {
        const unsafeOperation = `feature-analysis:${'c'.repeat(64)}`;
        await db.query(`
            UPDATE public.analysis_pipeline_jobs
            SET status = 'processing',
                dispatch_state = 'delivered',
                lease_token = $2,
                lease_expires_at = clock_timestamp() + interval '10 minutes',
                attempt_count = 1
            WHERE request_id = $1 AND job_key = 'track:profile-ai:batch:0'
        `, [requestId, jobClaim]);
        await db.query(`
            SELECT * FROM public.claim_analysis_v2_scheduler_operation(
                $1, 'track:profile-ai:batch:0', $2, $3, 'featureAnalysis',
                'c23e4567-e89b-42d3-a456-426614174000', 330
            )
        `, [requestId, jobClaim, unsafeOperation]);
        await db.query(`
            UPDATE public.analysis_v2_scheduler_operations
            SET recovery_deadline_at = clock_timestamp() - interval '1 second',
                lease_expires_at = clock_timestamp() - interval '1 second'
            WHERE request_id = $1 AND operation_key = $2
        `, [requestId, unsafeOperation]);
        await db.query(`
            INSERT INTO public.analysis_v2_ai_attempts (
                request_id, job_key, operation_key, status, stage
            ) VALUES (
                $1, 'track:profile-ai:batch:0', $2, 'reserved', 'featureAnalysis'
            )
        `, [requestId, unsafeOperation]);
        await db.query(`
            INSERT INTO public.analysis_v2_gemini_leases (
                slot, state, fence, request_id, job_key, operation_key, stage, attempt,
                lease_claim_token, acquired_at, expires_at
            ) VALUES (
                1, 'leased', 1, $1, 'track:profile-ai:batch:0', $2,
                'featureAnalysis', 1, 'e23e4567-e89b-42d3-a456-426614174000',
                clock_timestamp() - interval '6 minutes',
                clock_timestamp() - interval '1 second'
            )
        `, [requestId, unsafeOperation]);

        const recovered = await db.query<{ recovered: number }>(`
            SELECT public.recover_analysis_v2_scheduler_operations(8) AS recovered
        `);
        expect(recovered.rows).toEqual([{ recovered: 1 }]);
        const persisted = await db.query(`
            SELECT operation.status, attempt.status AS attempt_status, lease.state AS lease_state
            FROM public.analysis_v2_scheduler_operations AS operation
            JOIN public.analysis_v2_ai_attempts AS attempt
              ON attempt.request_id = operation.request_id
             AND attempt.operation_key = operation.operation_key
            JOIN public.analysis_v2_gemini_leases AS lease ON lease.slot = 1
            WHERE operation.request_id = $1 AND operation.operation_key = $2
        `, [requestId, unsafeOperation]);
        expect(persisted.rows).toEqual([{
            status: 'terminal_unavailable',
            attempt_status: 'cutoff',
            lease_state: 'available',
        }]);
        const terminal = await db.query<{
            decision: string;
            recovery_only: boolean;
        }>(`
            SELECT * FROM public.claim_analysis_v2_scheduler_operation(
                $1, 'track:profile-ai:batch:0', $2, $3, 'featureAnalysis',
                'f23e4567-e89b-42d3-a456-426614174000', 330
            )
        `, [requestId, jobClaim, unsafeOperation]);
        expect(terminal.rows).toMatchObject([{
            decision: 'terminal_unavailable',
            recovery_only: true,
        }]);
    });
});
