import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import {
    analysisProviderAdmissionId,
    type AnalysisProviderAdmissionInput,
} from './provider-admission-store';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260831100000_add_analysis_provider_admission_leases.sql',
    import.meta.url,
), 'utf8');

// gitleaks:allow -- deterministic UUID fixtures
const requestId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';

let db: PGlite;

async function asService<T>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('SET ROLE postgres');
    }
}

function paidInput(index = 0): AnalysisProviderAdmissionInput {
    const suffix = String(index + 1).padStart(12, '0');
    return {
        workloadRole: 'paid',
        logicalProvider: 'apify',
        credentialSlot: 'secondary',
        budgetKey: 'paid:apify:secondary',
        requestId: `11111111-1111-4111-8111-${suffix}`,
        jobKey: 'track:relationships:collect',
        operationKey: `target-profile:${'a'.repeat(64)}`,
        claimToken: `22222222-2222-4222-8222-${suffix}`,
        jobClaimToken: `22222222-2222-4222-8222-${suffix}`,
        leaseSeconds: 120,
    };
}

function preflightInput(index = 0): AnalysisProviderAdmissionInput {
    const suffix = String(index + 101).padStart(12, '0');
    return {
        workloadRole: 'preflight',
        logicalProvider: 'apify',
        credentialSlot: 'primary',
        budgetKey: 'preflight:apify:primary',
        requestId: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
        jobKey: 'preflight:provider',
        operationKey: 'target-profile-fallback',
        claimToken: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
        jobClaimToken: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
        leaseSeconds: 120,
    };
}

function freshAdmissionInput(
    index = 0,
    credentialSlot: 'primary' | 'secondary' | 'quinary' | 'septenary' = 'secondary',
): AnalysisProviderAdmissionInput {
    const suffix = String(index + 201).padStart(12, '0');
    return {
        workloadRole: 'paid',
        logicalProvider: 'apify',
        credentialSlot,
        budgetKey: `paid:apify:${credentialSlot}`,
        requestId: `cccccccc-cccc-4ccc-8ccc-${suffix}`,
        jobKey: 'paid:target-profile',
        operationKey: `target-profile-fresh-admission:g${index + 1}`,
        claimToken: `dddddddd-dddd-4ddd-8ddd-${suffix}`,
        jobClaimToken: `dddddddd-dddd-4ddd-8ddd-${suffix}`,
        leaseSeconds: 120,
    };
}

function betaPreflightAdmissionInput(index = 0): AnalysisProviderAdmissionInput {
    const suffix = String(index + 301).padStart(12, '0');
    return {
        workloadRole: 'paid',
        logicalProvider: 'apify',
        credentialSlot: 'septenary',
        budgetKey: 'paid:apify:septenary',
        requestId: `abababab-abab-4bab-8bab-${suffix}`,
        jobKey: 'preflight:provider',
        operationKey: 'target-profile-fallback',
        claimToken: `cdcdcdcd-cdcd-4dcd-8dcd-${suffix}`,
        jobClaimToken: `cdcdcdcd-cdcd-4dcd-8dcd-${suffix}`,
        leaseSeconds: 120,
    };
}

function geminiInput(): AnalysisProviderAdmissionInput {
    return {
        workloadRole: 'paid',
        logicalProvider: 'gemini',
        credentialSlot: 'gemini-1',
        budgetKey: 'paid:gemini:gemini-1',
        requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        jobKey: 'track:profile-ai:batch:0',
        operationKey: `feature-analysis:${'c'.repeat(64)}:attempt:1`,
        claimToken: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        jobClaimToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        providerFence: 4,
        leaseSeconds: 120,
    };
}

function bliteGeminiInput(): AnalysisProviderAdmissionInput {
    return {
        workloadRole: 'paid',
        logicalProvider: 'gemini',
        credentialSlot: 'gemini-3',
        budgetKey: 'paid:gemini:gemini-3',
        requestId: '12121212-1212-4121-8121-121212121212',
        jobKey: 'preflight:blite',
        operationKey: 'gemini:legacy:unknown:attempt:1',
        claimToken: '13131313-1313-4131-8131-131313131313',
        jobClaimToken: '14141414-1414-4141-8141-141414141414',
        providerFence: 11,
        leaseSeconds: 240,
    };
}

async function acquireWithLeaseToken(
    input: AnalysisProviderAdmissionInput,
    leaseToken: string,
): Promise<Record<string, unknown>> {
    const result = await db.query<{ payload: Record<string, unknown> }>(
        `SELECT public.acquire_analysis_provider_admission(
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
        ) AS payload`,
        [
            analysisProviderAdmissionId(input),
            input.workloadRole,
            input.logicalProvider,
            input.credentialSlot,
            input.budgetKey,
            input.requestId,
            input.jobKey,
            input.operationKey,
            input.jobClaimToken,
            input.claimToken,
            input.providerFence ?? null,
            leaseToken,
            input.leaseSeconds,
        ],
    );
    return result.rows[0]?.payload ?? {};
}

async function acquire(input: AnalysisProviderAdmissionInput): Promise<Record<string, unknown>> {
    return acquireWithLeaseToken(input, '33333333-3333-4333-8333-333333333333');
}

describe('provider admission migration PGlite contract', () => {
    beforeAll(async () => {
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE SCHEMA extensions;
            CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
            CREATE TABLE public.analysis_requests (
                id UUID PRIMARY KEY,
                pipeline_version TEXT NOT NULL,
                status TEXT NOT NULL,
                preflight_id UUID,
                processing_lease_token UUID,
                processing_lease_expires_at TIMESTAMPTZ
            );
            CREATE TABLE public.analysis_v2_provider_execution_policies (
                request_id UUID PRIMARY KEY,
                mode TEXT NOT NULL,
                policy_version TEXT NOT NULL,
                operation_slot_map JSONB NOT NULL
            );
            CREATE TABLE public.analysis_pipeline_jobs (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                status TEXT NOT NULL,
                lease_token UUID,
                lease_expires_at TIMESTAMPTZ,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                first_started_at TIMESTAMPTZ,
                ai_capacity_deferral_count INTEGER NOT NULL DEFAULT 0,
                last_error_code TEXT,
                last_error_at TIMESTAMPTZ,
                dispatch_generation INTEGER NOT NULL DEFAULT 0,
                dispatch_state TEXT NOT NULL DEFAULT 'pending',
                dispatch_reservation_token UUID,
                dispatch_task_name TEXT,
                dispatch_reserved_at TIMESTAMPTZ,
                dispatched_at TIMESTAMPTZ,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
            );
            CREATE TABLE public.analysis_preflights (
                id UUID PRIMARY KEY,
                user_id UUID,
                expires_at TIMESTAMPTZ NOT NULL,
                status TEXT NOT NULL,
                lease_token UUID,
                lease_expires_at TIMESTAMPTZ,
                submitted_at TIMESTAMPTZ,
                deadline_at TIMESTAMPTZ,
                ready_at TIMESTAMPTZ,
                pii_scrubbed_at TIMESTAMPTZ,
                precheckout_blite_cohort BOOLEAN NOT NULL DEFAULT FALSE,
                target_followers_count INTEGER,
                target_following_count INTEGER,
                consumed_request_id UUID,
                admission_status TEXT,
                admission_generation INTEGER NOT NULL DEFAULT 0,
                admission_claim_token UUID,
                admission_lease_expires_at TIMESTAMPTZ,
                admission_dispatch_generation INTEGER NOT NULL DEFAULT 0,
                admission_dispatch_token UUID,
                admission_dispatch_state TEXT NOT NULL DEFAULT 'idle',
                admission_dispatch_reserved_at TIMESTAMPTZ,
                admission_dispatched_at TIMESTAMPTZ,
                order_scoped_apify_credential_slot TEXT,
                analysis_entry_channel TEXT,
                beta_entry_provenance TEXT,
                beta_prepare_state TEXT,
                beta_prepare_dispatch_state TEXT,
                beta_prepare_lease_token UUID,
                beta_prepare_lease_expires_at TIMESTAMPTZ,
                dispatch_generation INTEGER NOT NULL DEFAULT 0,
                dispatch_state TEXT NOT NULL DEFAULT 'unreserved',
                dispatch_token UUID,
                dispatch_reserved_at TIMESTAMPTZ,
                dispatched_at TIMESTAMPTZ,
                worker_attempt_count INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
            );
            CREATE TABLE public.analysis_beta_pool_allocations (
                id UUID PRIMARY KEY,
                preflight_id UUID NOT NULL,
                lifecycle_state TEXT NOT NULL
            );
            CREATE TABLE public.analysis_beta_pool_reservations (
                allocation_id UUID NOT NULL,
                operation_family TEXT NOT NULL,
                credential_slot TEXT NOT NULL,
                lifecycle_state TEXT NOT NULL,
                PRIMARY KEY (allocation_id, operation_family)
            );
            CREATE TABLE public.analysis_preflight_provider_runs (
                preflight_id UUID NOT NULL,
                operation_key TEXT NOT NULL,
                logical_provider TEXT NOT NULL,
                credential_slot TEXT NOT NULL,
                status TEXT NOT NULL,
                run_id TEXT,
                terminalized_at TIMESTAMPTZ,
                usage_reconciled_at TIMESTAMPTZ
            );
            CREATE TABLE public.analysis_v2_provider_runs (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                operation_key TEXT NOT NULL,
                logical_provider TEXT NOT NULL,
                credential_slot TEXT NOT NULL,
                job_claim_token UUID,
                status TEXT NOT NULL,
                run_id TEXT,
                terminalized_at TIMESTAMPTZ,
                usage_reconciled_at TIMESTAMPTZ
            );
            CREATE TABLE public.analysis_v2_profile_repair_canary_runs (
                state TEXT NOT NULL,
                usage_reconciled_at TIMESTAMPTZ
            );
            CREATE TABLE public.analysis_provider_runs (
                status TEXT NOT NULL
            );
            CREATE TABLE public.analysis_v2_profile_provider_canary_runs (
                state TEXT NOT NULL,
                usage_reconciled_at TIMESTAMPTZ
            );
            CREATE TABLE public.analysis_v2_gemini_leases (
                slot SMALLINT PRIMARY KEY,
                state TEXT NOT NULL,
                fence BIGINT NOT NULL DEFAULT 0,
                request_id UUID,
                job_key TEXT,
                attempt INTEGER,
                lease_claim_token UUID,
                acquired_at TIMESTAMPTZ,
                expires_at TIMESTAMPTZ
            );
            CREATE TABLE public.precheckout_blite_cache (
                preflight_id UUID PRIMARY KEY,
                state TEXT NOT NULL,
                lease_token UUID NOT NULL,
                lease_expires_at TIMESTAMPTZ NOT NULL,
                attempt_count SMALLINT NOT NULL DEFAULT 0,
                dto JSONB,
                failure_reason TEXT,
                failed_at TIMESTAMPTZ,
                completed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
            );
            CREATE TABLE public.precheckout_blite_dispatches (
                preflight_id UUID PRIMARY KEY,
                state TEXT NOT NULL DEFAULT 'idle',
                attempt_count SMALLINT NOT NULL DEFAULT 0,
                dispatch_token UUID,
                lease_expires_at TIMESTAMPTZ,
                failure_reason TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
            );
            -- Minimal predecessor used by the additive 20260831 dispatch wrapper.  The real
            -- migration history supplies this function from the V2 preflight migrations; this
            -- contract fixture supplies the same reservation shape without loading every prior
            -- application migration.
            CREATE FUNCTION public.reserve_analysis_v2_preflight_dispatch(
                p_preflight_id UUID,
                p_user_id UUID,
                p_dispatch_token UUID
            ) RETURNS TABLE(
                should_enqueue BOOLEAN,
                dispatch_generation INTEGER,
                reservation_token UUID,
                preflight_status TEXT
            ) LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
            DECLARE
                v_generation INTEGER;
                v_status TEXT;
            BEGIN
                SELECT preflight.status, preflight.dispatch_generation
                INTO v_status, v_generation
                FROM public.analysis_preflights AS preflight
                WHERE preflight.id = p_preflight_id AND preflight.status = 'pending'
                FOR UPDATE;
                IF NOT FOUND OR v_generation >= 100 THEN
                    RETURN QUERY SELECT FALSE, COALESCE(v_generation, 0), NULL::UUID,
                        COALESCE(v_status, 'pending');
                    RETURN;
                END IF;
                IF EXISTS (
                    SELECT 1
                    FROM public.analysis_preflights AS beta
                    WHERE beta.id = p_preflight_id
                      AND beta.beta_entry_provenance = 'betatest_service_v1'
                      AND beta.beta_prepare_state IS DISTINCT FROM 'prepared'
                ) THEN
                    RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PREPARE_REQUIRED';
                END IF;
                v_generation := v_generation + 1;
                UPDATE public.analysis_preflights AS preflight
                SET dispatch_generation = v_generation,
                    dispatch_state = 'reserved',
                    dispatch_token = p_dispatch_token,
                    dispatch_reserved_at = clock_timestamp(),
                    dispatched_at = NULL,
                    updated_at = clock_timestamp()
                WHERE preflight.id = p_preflight_id;
                RETURN QUERY SELECT TRUE, v_generation, p_dispatch_token, v_status;
            END;
            $$;
            CREATE FUNCTION public.mark_analysis_v2_preflight_dispatched(
                p_preflight_id UUID,
                p_user_id UUID,
                p_dispatch_generation INTEGER,
                p_dispatch_token UUID
            ) RETURNS BOOLEAN
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
            BEGIN
                UPDATE public.analysis_preflights AS preflight
                SET dispatch_state = 'enqueued',
                    dispatch_token = NULL,
                    dispatched_at = clock_timestamp(),
                    updated_at = clock_timestamp()
                WHERE preflight.id = p_preflight_id
                  AND preflight.user_id = p_user_id
                  AND preflight.dispatch_state = 'reserved'
                  AND preflight.dispatch_generation = p_dispatch_generation
                  AND preflight.dispatch_token = p_dispatch_token;
                RETURN FOUND;
            END;
            $$;
            CREATE FUNCTION public.claim_analysis_v2_preflight(
                p_preflight_id UUID,
                p_claim_token UUID,
                p_lease_seconds INTEGER DEFAULT 300
            ) RETURNS TABLE(
                preflight_id UUID,
                user_id UUID,
                claimed BOOLEAN,
                target_instagram_id TEXT,
                access_mode TEXT,
                analysis_entry_channel TEXT,
                plan_catalog_snapshot JSONB,
                pricing_version TEXT,
                pricing_snapshot JSONB,
                worker_attempt_count INTEGER,
                lease_expires_at TIMESTAMPTZ,
                preflight_status TEXT
            ) LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
            BEGIN
                UPDATE public.analysis_preflights AS preflight
                SET status = 'processing',
                    lease_token = p_claim_token,
                    lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
                    worker_attempt_count = preflight.worker_attempt_count + 1,
                    updated_at = clock_timestamp()
                WHERE preflight.id = p_preflight_id
                  AND preflight.status = 'pending';
                RETURN QUERY
                SELECT preflight.id, preflight.user_id, TRUE,
                    'example_target'::TEXT, 'standard'::TEXT,
                    preflight.analysis_entry_channel, '{}'::JSONB,
                    'test-pricing'::TEXT, '{}'::JSONB, preflight.worker_attempt_count,
                    preflight.lease_expires_at, preflight.status
                FROM public.analysis_preflights AS preflight
                WHERE preflight.id = p_preflight_id
                  AND preflight.lease_token = p_claim_token;
                IF NOT FOUND THEN
                    RETURN QUERY SELECT p_preflight_id, NULL::UUID, FALSE,
                        NULL::TEXT, NULL::TEXT, NULL::JSONB, NULL::TEXT, NULL::JSONB,
                        0, NULL::TIMESTAMPTZ, 'pending'::TEXT;
                END IF;
            END;
            $$;
        `);
        await db.exec(migration);
        await db.exec(`
            INSERT INTO public.analysis_v2_gemini_leases(slot, state)
            SELECT slot, 'available' FROM generate_series(1, 8) AS slots(slot);
        `);
        for (let index = 0; index < 10; index += 1) {
            const input = paidInput(index);
            await db.query(
                `INSERT INTO public.analysis_requests(id, pipeline_version, status)
                 VALUES ($1, 'v2', 'processing')`,
                [input.requestId],
            );
            await db.query(
                `INSERT INTO public.analysis_pipeline_jobs(
                    request_id, job_key, status, lease_token, lease_expires_at
                 ) VALUES ($1, $2, 'processing', $3, clock_timestamp() + interval '10 minutes')`,
                [input.requestId, input.jobKey, input.jobClaimToken],
            );
        }
    });

    afterAll(async () => {
        await db.close();
    });

    it('keeps privileged admission RPCs closed to API roles and exposes the recovery index', async () => {
        const privileges = await db.query<{ table_privilege: boolean; function_privilege: boolean }>(`
            SELECT
                has_table_privilege('anon', 'public.analysis_provider_admission_leases', 'SELECT')
                    AS table_privilege,
                has_function_privilege(
                    'anon',
                    'public.acquire_analysis_provider_admission(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)',
                    'EXECUTE'
                ) AS function_privilege
        `);
        expect(privileges.rows[0]).toEqual({ table_privilege: false, function_privilege: false });

        const rls = await db.query<{ relforcerowsecurity: boolean }>(`
            SELECT relforcerowsecurity
            FROM pg_class
            WHERE oid = 'public.analysis_provider_admission_leases'::regclass
        `);
        expect(rls.rows[0]?.relforcerowsecurity).toBe(true);

        await db.exec('SET enable_seqscan = off');
        const plan = await db.query<Record<string, unknown>>(`
            EXPLAIN (FORMAT JSON)
            SELECT admission_id
            FROM public.analysis_provider_admission_leases
            WHERE state IN ('leased', 'recovery_required')
              AND expires_at <= clock_timestamp()
            ORDER BY expires_at, fence, admission_id
            LIMIT 16
        `);
        await db.exec('RESET enable_seqscan');
        expect(JSON.stringify(plan.rows)).toMatch(
            /analysis_provider_admission_leases_(expiry_recovery|active_claim)_idx/,
        );

        const listPrivileges = await db.query<{ function_privilege: boolean }>(`
            SELECT has_function_privilege(
                'anon',
                'public.list_expired_analysis_provider_admissions(integer)',
                'EXECUTE'
            ) AS function_privilege
        `);
        expect(listPrivileges.rows[0]?.function_privilege).toBe(false);
    });

    it('fences idempotent acquisition, global/relationship capacity, release, and expiry recovery', async () => {
        const first = paidInput(0);
        const initial = await acquire(first);
        expect(initial.outcome).toBe('acquired');
        const replay = await acquire(first);
        expect(replay.outcome).toBe('already_acquired');
        expect(replay.admissionId).toBe(initial.admissionId);

        // The durable operation identity excludes the credential slot. A slot
        // or budget drift therefore must be classified before the alternate
        // admission id can reach the unique identity constraint.
        await expect(acquire({
            ...first,
            credentialSlot: 'primary',
            budgetKey: 'paid:apify:primary',
        })).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT');

        // A live row must not disclose its lease secret to a replay whose task
        // claim has changed, even when the deterministic admission identity is
        // otherwise identical.
        const replacementClaim = '99999999-9999-4999-8999-999999999999';
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET lease_token = $2
             WHERE request_id = $1 AND job_key = $3`,
            [first.requestId, replacementClaim, first.jobKey],
        );
        await expect(acquireWithLeaseToken({
            ...first,
            claimToken: replacementClaim,
            jobClaimToken: replacementClaim,
        }, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
            .rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT');
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET lease_token = $2
             WHERE request_id = $1 AND job_key = $3`,
            [first.requestId, first.jobClaimToken, first.jobKey],
        );

        for (let index = 1; index < 8; index += 1) {
            expect((await acquire(paidInput(index))).outcome).toBe('acquired');
        }
        await expect(acquire(paidInput(8))).rejects.toThrow(
            'ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING',
        );

        const firstId = String(initial.admissionId);
        const staleRelease = await asService<{ payload: Record<string, unknown> }>(
            `SELECT public.release_analysis_provider_admission($1,$2,$3) AS payload`,
            [firstId, '44444444-4444-4444-8444-444444444444', 1],
        ).catch(error => ({ rows: [{ payload: { error: String(error) } }] } as unknown as Results<{ payload: Record<string, unknown> }>));
        expect(JSON.stringify(staleRelease.rows)).toContain(
            'ANALYSIS_PROVIDER_ADMISSION_FENCE_MISMATCH',
        );

        // The admission is acquired before its provider reservation. A live
        // job claim keeps a missing ledger pending, so expire this synthetic
        // claim before exercising the safe pre-start release path.
        await db.exec('SET ROLE postgres');
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET lease_expires_at = clock_timestamp() - interval '1 second'
             WHERE request_id = $1 AND job_key = $2`,
            [first.requestId, first.jobKey],
        );
        await asService(
            `SELECT public.release_analysis_provider_admission($1,$2,$3)`,
            [firstId, initial.leaseToken, initial.fence],
        );
        expect((await acquire(paidInput(8))).outcome).toBe('acquired');

        const recoverable = paidInput(7);
        const recoverableId = analysisProviderAdmissionId(recoverable);
        await db.exec('SET ROLE postgres');
        await db.query(
            `UPDATE public.analysis_provider_admission_leases
             SET expires_at = clock_timestamp() - interval '1 second'
             WHERE admission_id = $1`,
            [recoverableId],
        );
        const expired = await asService<{
            payload: {
                candidates: Array<Record<string, unknown>>;
                hasMore: boolean;
            };
        }>(
            `SELECT public.list_expired_analysis_provider_admissions($1) AS payload`,
            [16],
        );
        expect(expired.rows[0]?.payload).toEqual({
            candidates: [expect.objectContaining({ admissionId: recoverableId, fence: 1 })],
            hasMore: false,
        });
        const recovered = await asService<{ payload: { recovered: boolean } }>(
            `SELECT public.recover_expired_analysis_provider_admission($1,$2) AS payload`,
            [recoverableId, '55555555-5555-4555-8555-555555555555'],
        );
        expect(recovered.rows[0]?.payload.recovered).toBe(true);
        const replayRecovery = await asService<{ payload: { recovered: boolean } }>(
            `SELECT public.recover_expired_analysis_provider_admission($1,$2) AS payload`,
            [recoverableId, '66666666-6666-4666-8666-666666666666'],
        );
        expect(replayRecovery.rows[0]?.payload.recovered).toBe(true);
        const liveClaimResolution = await asService<{ payload: { resolved: boolean } }>(
            `SELECT public.resolve_analysis_provider_admission($1,$2) AS payload`,
            [recoverableId, '66666666-6666-4666-8666-666666666666'],
        );
        expect(liveClaimResolution.rows[0]?.payload.resolved).toBe(false);
        await db.exec('SET ROLE postgres');
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET lease_expires_at = clock_timestamp() - interval '1 second'
             WHERE request_id = $1 AND job_key = $2`,
            [recoverable.requestId, recoverable.jobKey],
        );
        const absentResolution = await asService<{ payload: { resolved: boolean } }>(
            `SELECT public.resolve_analysis_provider_admission($1,$2) AS payload`,
            [recoverableId, '77777777-7777-4777-8777-777777777777'],
        );
        expect(absentResolution.rows[0]?.payload.resolved).toBe(true);
        const absentResolutionSource = await db.query<{ resolution_source: string }>(
            `SELECT resolution_source
             FROM public.analysis_provider_admission_leases
             WHERE admission_id = $1`,
            [recoverableId],
        );
        expect(absentResolutionSource.rows[0]?.resolution_source).toBe('provider_ledger_absent');

        const runningRecovery = paidInput(6);
        const runningRecoveryId = analysisProviderAdmissionId(runningRecovery);
        await db.exec('SET ROLE postgres');
        await db.query(
            `UPDATE public.analysis_provider_admission_leases
             SET expires_at = clock_timestamp() - interval '1 second'
             WHERE admission_id = $1`,
            [runningRecoveryId],
        );
        await asService(
            `SELECT public.recover_expired_analysis_provider_admission($1,$2)`,
            [runningRecoveryId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, logical_provider, credential_slot,
                status, run_id
             ) VALUES ($1, $2, $3, 'apify', 'secondary', 'running', 'RunAbcd1234567890')`,
            [runningRecovery.requestId, runningRecovery.jobKey, runningRecovery.operationKey],
        );
        await expect(asService(
            `SELECT public.release_analysis_provider_admission($1,$2,$3)`,
            [runningRecoveryId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2],
        )).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_FENCE_MISMATCH');
        await db.query(
            `UPDATE public.analysis_v2_provider_runs
             SET status = 'succeeded', terminalized_at = clock_timestamp()
             WHERE request_id = $1 AND job_key = $2 AND operation_key = $3`,
            [runningRecovery.requestId, runningRecovery.jobKey, runningRecovery.operationKey],
        );

        const runningDirect = paidInput(5);
        const runningDirectId = analysisProviderAdmissionId(runningDirect);
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, logical_provider, credential_slot,
                status, run_id
             ) VALUES ($1, $2, $3, 'apify', 'secondary', 'running', 'RunDirect12345678')`,
            [runningDirect.requestId, runningDirect.jobKey, runningDirect.operationKey],
        );
        const runningDirectLease = await db.query<{ lease_token: string; fence: number }>(
            `SELECT lease_token, fence
             FROM public.analysis_provider_admission_leases
             WHERE admission_id = $1`,
            [runningDirectId],
        );
        await expect(asService(
            `SELECT public.release_analysis_provider_admission($1,$2,$3)`,
            [
                runningDirectId,
                runningDirectLease.rows[0]!.lease_token,
                runningDirectLease.rows[0]!.fence,
            ],
        )).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT');
        await db.query(
            `UPDATE public.analysis_v2_provider_runs
             SET status = 'succeeded', terminalized_at = clock_timestamp()
             WHERE request_id = $1 AND job_key = $2 AND operation_key = $3`,
            [runningDirect.requestId, runningDirect.jobKey, runningDirect.operationKey],
        );
        await asService(
            `SELECT public.release_analysis_provider_admission($1,$2,$3)`,
            [
                runningDirectId,
                runningDirectLease.rows[0]!.lease_token,
                runningDirectLease.rows[0]!.fence,
            ],
        );
        const resolved = await asService<{ payload: { resolved: boolean } }>(
            `SELECT public.resolve_analysis_provider_admission($1,$2) AS payload`,
            [runningRecoveryId, '88888888-8888-4888-8888-888888888888'],
        );
        expect(resolved.rows[0]?.payload.resolved).toBe(true);
    });

    it('validates the durable preflight claim and rejects credential drift before replay', async () => {
        const value = preflightInput();
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, expires_at, status, lease_token, lease_expires_at
             ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'processing', $2,
                       clock_timestamp() + interval '10 minutes')`,
            [value.requestId, value.claimToken],
        );
        const initial = await acquire(value);
        expect(initial.outcome).toBe('acquired');
        await db.query(
            `INSERT INTO public.analysis_preflight_provider_runs(
                preflight_id, operation_key, logical_provider, credential_slot, status
             ) VALUES ($1, $2, 'apify', 'quinary', 'starting')`,
            [value.requestId, value.operationKey],
        );
        await expect(acquire(value)).rejects.toThrow(
            'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT',
        );
    });

    it('uses durable fresh-admission lineage for order-scoped and betatest slots', async () => {
        await db.exec(`
            SET ROLE postgres;
            UPDATE public.analysis_provider_admission_leases
            SET state = 'released', released_at = clock_timestamp(),
                expires_at = clock_timestamp(), release_reason = 'terminal',
                updated_at = clock_timestamp()
            WHERE state IN ('leased', 'recovery_required');
            UPDATE public.analysis_provider_admission_budgets
            SET window_count = 0, window_started_at = clock_timestamp();
        `);
        const ordered = freshAdmissionInput(0, 'quinary');
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, expires_at, status, admission_status, admission_claim_token,
                admission_lease_expires_at, order_scoped_apify_credential_slot,
                analysis_entry_channel
             ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'ready',
                       'processing', $2, clock_timestamp() + interval '10 minutes',
                       'quinary', 'standard')`,
            [ordered.requestId, ordered.jobClaimToken],
        );
        const orderedAdmission = await acquire(ordered);
        expect(orderedAdmission.outcome).toBe('acquired');
        await expect(acquire({
            ...ordered,
            credentialSlot: 'primary',
            budgetKey: 'paid:apify:primary',
        })).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT');

        const beta = freshAdmissionInput(1, 'septenary');
        const betaAllocationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, expires_at, status, admission_status, admission_claim_token,
                admission_lease_expires_at, analysis_entry_channel
             ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'ready',
                       'processing', $2, clock_timestamp() + interval '10 minutes',
                       'betatest')`,
            [beta.requestId, beta.jobClaimToken],
        );
        await db.query(
            `INSERT INTO public.analysis_beta_pool_allocations(id, preflight_id, lifecycle_state)
             VALUES ($1, $2, 'preflight_held')`,
            [betaAllocationId, beta.requestId],
        );
        await db.query(
            `INSERT INTO public.analysis_beta_pool_reservations(
                allocation_id, operation_family, credential_slot, lifecycle_state
             ) VALUES ($1, 'target-profile', 'septenary', 'preflight_held')`,
            [betaAllocationId],
        );
        const betaAdmission = await acquire(beta);
        expect(betaAdmission.outcome).toBe('acquired');
        await expect(acquire({
            ...beta,
            workloadRole: 'preflight',
            credentialSlot: 'primary',
            budgetKey: 'preflight:apify:primary',
            jobKey: 'preflight:provider',
            operationKey: 'target-profile-fallback',
        })).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT');
        await expect(acquire({
            ...beta,
            credentialSlot: 'secondary',
            budgetKey: 'paid:apify:secondary',
        })).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT');
    });

    it('charges only a held betatest preflight target profile to the paid slot budget', async () => {
        await db.exec(`
            SET ROLE postgres;
            UPDATE public.analysis_provider_admission_leases
            SET state = 'released', released_at = clock_timestamp(),
                expires_at = clock_timestamp(), release_reason = 'terminal',
                updated_at = clock_timestamp()
            WHERE state IN ('leased', 'recovery_required');
            UPDATE public.analysis_provider_admission_budgets
            SET window_count = 0, window_started_at = clock_timestamp();
        `);
        const held = betaPreflightAdmissionInput();
        const heldAllocationId = 'abababab-abab-4bab-8bab-abababababab';
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, expires_at, status, lease_token, lease_expires_at,
                analysis_entry_channel
             ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'processing', $2,
                       clock_timestamp() + interval '10 minutes', 'betatest')`,
            [held.requestId, held.jobClaimToken],
        );
        await db.query(
            `INSERT INTO public.analysis_beta_pool_allocations(id, preflight_id, lifecycle_state)
             VALUES ($1, $2, 'preflight_held')`,
            [heldAllocationId, held.requestId],
        );
        await db.query(
            `INSERT INTO public.analysis_beta_pool_reservations(
                allocation_id, operation_family, credential_slot, lifecycle_state
             ) VALUES ($1, 'target-profile', 'septenary', 'preflight_held')`,
            [heldAllocationId],
        );
        await expect(acquire(held)).resolves.toEqual(
            expect.objectContaining({ outcome: 'acquired', credentialSlot: 'septenary' }),
        );

        const unheld = betaPreflightAdmissionInput(1);
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, expires_at, status, lease_token, lease_expires_at,
                analysis_entry_channel
             ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'processing', $2,
                       clock_timestamp() + interval '10 minutes', 'betatest')`,
            [unheld.requestId, unheld.jobClaimToken],
        );
        await expect(acquire(unheld)).rejects.toThrow(
            'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT',
        );
    });

    it('keeps beta preflight provider runs fenced through starting, running, and terminal recovery', async () => {
        const value = betaPreflightAdmissionInput(2);
        const allocationId = '12121212-1212-4121-8121-121212121212';
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, expires_at, status, analysis_entry_channel, lease_token, lease_expires_at
             ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'processing', 'betatest', $2,
                       clock_timestamp() + interval '10 minutes')`,
            [value.requestId, value.jobClaimToken],
        );
        await db.query(
            `INSERT INTO public.analysis_beta_pool_allocations(id, preflight_id, lifecycle_state)
             VALUES ($1, $2, 'preflight_held')`,
            [allocationId, value.requestId],
        );
        await db.query(
            `INSERT INTO public.analysis_beta_pool_reservations(
                allocation_id, operation_family, credential_slot, lifecycle_state
             ) VALUES ($1, 'target-profile', 'septenary', 'preflight_held')`,
            [allocationId],
        );
        const acquired = await acquire(value);
        const admissionId = String(acquired.admissionId);
        await db.query(
            `INSERT INTO public.analysis_preflight_provider_runs(
                preflight_id, operation_key, logical_provider, credential_slot, status, run_id
             ) VALUES ($1, $2, 'apify', 'septenary', 'starting', 'RunBetaAmbiguous123')`,
            [value.requestId, value.operationKey],
        );
        await expect(asService(
            `SELECT public.release_analysis_provider_admission($1,$2,$3)`,
            [admissionId, acquired.leaseToken, acquired.fence],
        )).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT');

        await db.exec('SET ROLE postgres');
        await db.query(
            `UPDATE public.analysis_provider_admission_leases
             SET expires_at = clock_timestamp() - interval '1 second'
             WHERE admission_id = $1`,
            [admissionId],
        );
        await asService(
            `SELECT public.recover_expired_analysis_provider_admission($1,$2)`,
            [admissionId, '13131313-1313-4131-8131-131313131313'],
        );
        await expect(asService(
            `SELECT public.resolve_analysis_provider_admission($1,$2)`,
            [admissionId, '14141414-1414-4141-8141-141414141414'],
        )).resolves.toBeDefined();
        const pending = await db.query<{ payload: { resolved: boolean } }>(
            `SELECT public.resolve_analysis_provider_admission($1,$2) AS payload`,
            [admissionId, '15151515-1515-4151-8151-151515151515'],
        );
        expect(pending.rows[0]?.payload.resolved).toBe(false);

        await db.query(
            `UPDATE public.analysis_preflight_provider_runs
             SET status = 'running', run_id = 'RunBetaRunning123'
             WHERE preflight_id = $1 AND operation_key = $2`,
            [value.requestId, value.operationKey],
        );
        const running = await db.query<{ state: string }>(
            `SELECT public.analysis_provider_admission_ledger_state(lease) AS state
             FROM public.analysis_provider_admission_leases AS lease
             WHERE admission_id = $1`,
            [admissionId],
        );
        expect(running.rows[0]?.state).toBe('running');
        const runningResolution = await db.query<{ payload: { resolved: boolean } }>(
            `SELECT public.resolve_analysis_provider_admission($1,$2) AS payload`,
            [admissionId, '16161616-1616-4161-8161-161616161616'],
        );
        expect(runningResolution.rows[0]?.payload.resolved).toBe(false);

        await db.query(
            `UPDATE public.analysis_preflight_provider_runs
             SET status = 'succeeded', terminalized_at = clock_timestamp()
             WHERE preflight_id = $1 AND operation_key = $2`,
            [value.requestId, value.operationKey],
        );
        const terminalResolution = await db.query<{ payload: { resolved: boolean } }>(
            `SELECT public.resolve_analysis_provider_admission($1,$2) AS payload`,
            [admissionId, '17171717-1717-4171-8171-171717171717'],
        );
        expect(terminalResolution.rows[0]?.payload.resolved).toBe(true);
        const source = await db.query<{ resolution_source: string }>(
            `SELECT resolution_source
             FROM public.analysis_provider_admission_leases
             WHERE admission_id = $1`,
            [admissionId],
        );
        expect(source.rows[0]?.resolution_source).toBe('provider_ledger_terminal');
    });

    it('keeps missing preflight and beta-held claims pending until their processing leases expire', async () => {
        await db.exec(`
            SET ROLE postgres;
            UPDATE public.analysis_provider_admission_leases
            SET state = 'released', released_at = clock_timestamp(),
                expires_at = clock_timestamp(), release_reason = 'terminal',
                updated_at = clock_timestamp()
            WHERE state IN ('leased', 'recovery_required');
            UPDATE public.analysis_provider_admission_budgets
            SET window_count = 0, window_started_at = clock_timestamp();
        `);

        const ordinary = preflightInput(3);
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, expires_at, status, lease_token, lease_expires_at
             ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'processing', $2,
                       clock_timestamp() + interval '10 minutes')`,
            [ordinary.requestId, ordinary.jobClaimToken],
        );
        const ordinaryAdmission = await acquire(ordinary);
        const ordinaryId = String(ordinaryAdmission.admissionId);
        await db.query(
            `UPDATE public.analysis_provider_admission_leases
             SET expires_at = clock_timestamp() - interval '1 second'
             WHERE admission_id = $1`,
            [ordinaryId],
        );
        await asService(
            `SELECT public.recover_expired_analysis_provider_admission($1,$2)`,
            [ordinaryId, '18181818-1818-4181-8181-181818181818'],
        );
        const ordinaryPending = await asService<{ payload: { resolved: boolean } }>(
            `SELECT public.resolve_analysis_provider_admission($1,$2) AS payload`,
            [ordinaryId, '19191919-1919-4191-8191-191919191919'],
        );
        expect(ordinaryPending.rows[0]?.payload.resolved).toBe(false);
        await db.exec('SET ROLE postgres');
        await db.query(
            `UPDATE public.analysis_preflights
             SET lease_expires_at = clock_timestamp() - interval '1 second'
             WHERE id = $1`,
            [ordinary.requestId],
        );
        const ordinaryResolved = await asService<{ payload: { resolved: boolean } }>(
            `SELECT public.resolve_analysis_provider_admission($1,$2) AS payload`,
            [ordinaryId, '20202020-2020-4202-8202-202020202020'],
        );
        expect(ordinaryResolved.rows[0]?.payload.resolved).toBe(true);

        const beta = betaPreflightAdmissionInput(4);
        const allocationId = '21212121-2121-4121-8121-212121212121';
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, expires_at, status, analysis_entry_channel, lease_token, lease_expires_at
             ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'processing', 'betatest', $2,
                       clock_timestamp() + interval '10 minutes')`,
            [beta.requestId, beta.jobClaimToken],
        );
        await db.query(
            `INSERT INTO public.analysis_beta_pool_allocations(id, preflight_id, lifecycle_state)
             VALUES ($1, $2, 'preflight_held')`,
            [allocationId, beta.requestId],
        );
        await db.query(
            `INSERT INTO public.analysis_beta_pool_reservations(
                allocation_id, operation_family, credential_slot, lifecycle_state
             ) VALUES ($1, 'target-profile', 'septenary', 'preflight_held')`,
            [allocationId],
        );
        const betaAdmission = await acquire(beta);
        const betaId = String(betaAdmission.admissionId);
        await db.query(
            `UPDATE public.analysis_provider_admission_leases
             SET expires_at = clock_timestamp() - interval '1 second'
             WHERE admission_id = $1`,
            [betaId],
        );
        await asService(
            `SELECT public.recover_expired_analysis_provider_admission($1,$2)`,
            [betaId, '22222222-2222-4222-8222-222222222222'],
        );
        const betaPending = await asService<{ payload: { resolved: boolean } }>(
            `SELECT public.resolve_analysis_provider_admission($1,$2) AS payload`,
            [betaId, '23232323-2323-4232-8232-232323232323'],
        );
        expect(betaPending.rows[0]?.payload.resolved).toBe(false);
        await db.exec('SET ROLE postgres');
        await db.query(
            `UPDATE public.analysis_preflights
             SET lease_expires_at = clock_timestamp() - interval '1 second'
             WHERE id = $1`,
            [beta.requestId],
        );
        const betaResolved = await asService<{ payload: { resolved: boolean } }>(
            `SELECT public.resolve_analysis_provider_admission($1,$2) AS payload`,
            [betaId, '24242424-2424-4242-8242-242424242424'],
        );
        expect(betaResolved.rows[0]?.payload.resolved).toBe(true);
    });

    it('keeps a missing fresh paid admission pending while the admission processing claim is live', async () => {
        await db.exec(`
            SET ROLE postgres;
            UPDATE public.analysis_provider_admission_leases
            SET state = 'released', released_at = clock_timestamp(),
                expires_at = clock_timestamp(), release_reason = 'terminal',
                updated_at = clock_timestamp()
            WHERE state IN ('leased', 'recovery_required');
            UPDATE public.analysis_provider_admission_budgets
            SET window_count = 0, window_started_at = clock_timestamp();
        `);
        const fresh = freshAdmissionInput(5, 'secondary');
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, expires_at, status, admission_status, admission_claim_token,
                admission_lease_expires_at
             ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'ready', 'processing', $2,
                       clock_timestamp() + interval '10 minutes')`,
            [fresh.requestId, fresh.jobClaimToken],
        );
        const admission = await acquire(fresh);
        const admissionId = String(admission.admissionId);
        await db.query(
            `UPDATE public.analysis_provider_admission_leases
             SET expires_at = clock_timestamp() - interval '1 second'
             WHERE admission_id = $1`,
            [admissionId],
        );
        await asService(
            `SELECT public.recover_expired_analysis_provider_admission($1,$2)`,
            [admissionId, '25252525-2525-4252-8252-252525252525'],
        );
        const pending = await asService<{ payload: { resolved: boolean } }>(
            `SELECT public.resolve_analysis_provider_admission($1,$2) AS payload`,
            [admissionId, '26262626-2626-4262-8262-262626262626'],
        );
        expect(pending.rows[0]?.payload.resolved).toBe(false);
        await db.exec('SET ROLE postgres');
        await db.query(
            `UPDATE public.analysis_preflights
             SET admission_lease_expires_at = clock_timestamp() - interval '1 second'
             WHERE id = $1`,
            [fresh.requestId],
        );
        const resolved = await asService<{ payload: { resolved: boolean } }>(
            `SELECT public.resolve_analysis_provider_admission($1,$2) AS payload`,
            [admissionId, '27272727-2727-4272-8272-272727272727'],
        );
        expect(resolved.rows[0]?.payload.resolved).toBe(true);
    });

    it('does not consult a V2 policy while claiming an ordinary preflight', async () => {
        const value = preflightInput(1);
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, expires_at, status, lease_token, lease_expires_at,
                analysis_entry_channel
             ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'processing', $2,
                       clock_timestamp() + interval '10 minutes', 'standard')`,
            [value.requestId, value.claimToken],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies(
                request_id, mode, policy_version, operation_slot_map
             ) VALUES ($1, 'test_operation_split', 'authorized-free-e2e-v1',
                      '{"target-profile":"tertiary"}')`,
            [value.requestId],
        );
        await expect(acquire(value)).resolves.toEqual(
            expect.objectContaining({ outcome: 'acquired' }),
        );
    });

    it('returns the beta channel in the legacy ordinary claim position through v2 fencing', async () => {
        const value = preflightInput(4);
        const dispatchToken = 'abababab-abab-4bab-8bab-bbbbbbbbbbbb';
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, user_id, expires_at, status, analysis_entry_channel,
                dispatch_state, dispatch_generation, last_dispatch_token,
                dispatch_workload_role, dispatch_contract_version
             ) VALUES ($1, $2, clock_timestamp() + interval '10 minutes', 'pending', 'betatest',
                       'enqueued', 1, $3, 'preflight', 2)`,
            [value.requestId, 'cdcdcdcd-cdcd-4dcd-8dcd-cccccccccccc', dispatchToken],
        );
        const claimed = await asService<{
            analysis_entry_channel: string;
            claimed: boolean;
        }>(
            `SELECT analysis_entry_channel, claimed
             FROM public.claim_analysis_v2_preflight_v2(
                 $1::uuid, 1, $2::uuid, $3::uuid, 120, 'preflight'::text, 2::smallint
             )`,
            [value.requestId, dispatchToken, value.claimToken],
        );
        expect(claimed.rows[0]).toEqual({
            analysis_entry_channel: 'betatest',
            claimed: true,
        });
    });

    it('honors a consumed preflight order slot before the ordinary relationship default', async () => {
        const input = {
            ...paidInput(11),
            credentialSlot: 'tertiary' as const,
            budgetKey: 'paid:apify:tertiary:relationship',
            operationKey: `relationship-followers:${'e'.repeat(64)}`,
        };
        const preflightId = '99999999-9999-4999-8999-999999999999';
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, expires_at, status, consumed_request_id,
                order_scoped_apify_credential_slot, analysis_entry_channel
             ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'consumed',
                       $2, 'tertiary', 'standard')`,
            [preflightId, input.requestId],
        );
        await db.query(
            `INSERT INTO public.analysis_requests(id, pipeline_version, status, preflight_id)
             VALUES ($1, 'v2', 'processing', $2)`,
            [input.requestId, preflightId],
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, status, lease_token, lease_expires_at
             ) VALUES ($1, $2, 'processing', $3, clock_timestamp() + interval '10 minutes')`,
            [input.requestId, input.jobKey, input.jobClaimToken],
        );
        await expect(acquire(input)).resolves.toEqual(
            expect.objectContaining({ outcome: 'acquired' }),
        );
        await expect(acquire({
            ...input,
            credentialSlot: 'secondary',
            budgetKey: 'paid:apify:secondary:relationship',
        })).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT');
    });

    it('aliases authorized test profile-repair to its frozen profile-fallback slot only', async () => {
        const input = {
            ...paidInput(12),
            credentialSlot: 'tertiary' as const,
            budgetKey: 'paid:apify:tertiary',
            operationKey: `profile-repair:${'f'.repeat(64)}`,
        };
        await db.query(
            `INSERT INTO public.analysis_requests(id, pipeline_version, status)
             VALUES ($1, 'v2', 'processing')`,
            [input.requestId],
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, status, lease_token, lease_expires_at
             ) VALUES ($1, $2, 'processing', $3, clock_timestamp() + interval '10 minutes')`,
            [input.requestId, input.jobKey, input.jobClaimToken],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies(
                request_id, mode, policy_version, operation_slot_map
             ) VALUES ($1, 'test_operation_split', 'authorized-free-e2e-v1',
                       '{"profile-fallback":"tertiary"}')`,
            [input.requestId],
        );
        await expect(acquire(input)).resolves.toEqual(
            expect.objectContaining({ outcome: 'acquired' }),
        );
    });

    it('keeps the explicit betatest profile-repair policy key unchanged', async () => {
        const input = {
            ...paidInput(13),
            credentialSlot: 'septenary' as const,
            budgetKey: 'paid:apify:septenary',
            operationKey: `profile-repair:${'e'.repeat(64)}`,
        };
        await db.query(
            `INSERT INTO public.analysis_requests(id, pipeline_version, status)
             VALUES ($1, 'v2', 'processing')`,
            [input.requestId],
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, status, lease_token, lease_expires_at
             ) VALUES ($1, $2, 'processing', $3, clock_timestamp() + interval '10 minutes')`,
            [input.requestId, input.jobKey, input.jobClaimToken],
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies(
                request_id, mode, policy_version, operation_slot_map
             ) VALUES ($1, 'betatest_free_pool', 'betatest-free-pool-v1',
                       '{"profile-repair":"septenary"}')`,
            [input.requestId],
        );
        await expect(acquire(input)).resolves.toEqual(
            expect.objectContaining({ outcome: 'acquired' }),
        );
    });

    it('serializes concurrent duplicate deliveries into one acquisition and one replay', async () => {
        await db.exec(`
            UPDATE public.analysis_provider_admission_leases
            SET state = 'released', released_at = clock_timestamp(),
                expires_at = clock_timestamp(), release_reason = 'terminal',
                updated_at = clock_timestamp()
            WHERE state IN ('leased', 'recovery_required')
        `);
        const input = paidInput(9);
        const results = await Promise.all([
            acquireWithLeaseToken(input, '77777777-7777-4777-8777-777777777777'),
            acquireWithLeaseToken(input, '88888888-8888-4888-8888-888888888888'),
        ]);
        expect(results.map(result => result.outcome).sort()).toEqual([
            'acquired',
            'already_acquired',
        ]);
    });

    it('retains expired-running capacity until a ledger-proven adoption', async () => {
        const input = paidInput(10);
        await db.query(
            `INSERT INTO public.analysis_requests(id, pipeline_version, status)
             VALUES ($1, 'v2', 'processing')`,
            [input.requestId],
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, status, lease_token, lease_expires_at
             ) VALUES ($1, $2, 'processing', $3, clock_timestamp() + interval '10 minutes')`,
                [input.requestId, input.jobKey, input.jobClaimToken],
        );
        const initial = await acquireWithLeaseToken(
            input,
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        );
        const inputId = String(initial.admissionId);
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, logical_provider, credential_slot,
                status, run_id
             ) VALUES ($1, $2, $3, 'apify', 'secondary', 'running', 'RunAbcd12345678')`,
            [input.requestId, input.jobKey, input.operationKey],
        );
        await db.query(
            `UPDATE public.analysis_provider_admission_leases
             SET expires_at = clock_timestamp() - interval '1 second'
             WHERE admission_id = $1`,
            [inputId],
        );
        await asService(
            `SELECT public.recover_expired_analysis_provider_admission($1,$2)`,
            [inputId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
        );
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET lease_token = $2
             WHERE request_id = $1 AND job_key = $3`,
            [input.requestId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', input.jobKey],
        );
        await expect(acquireWithLeaseToken({
            ...input,
            claimToken: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            jobClaimToken: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        }, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')).resolves.toEqual(
            expect.objectContaining({ outcome: 'adopted' }),
        );
        const active = await db.query<{ count: string }>(`
            SELECT count(*)::TEXT AS count
            FROM public.analysis_provider_admission_leases
            WHERE state IN ('leased', 'recovery_required')
              AND workload_role = 'paid' AND logical_provider = 'apify'
        `);
        expect(Number(active.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    });

    it('splits Gemini slot and job ownership, rotates on takeover, and retires fenced admissions', async () => {
        const value = geminiInput();
        await db.query(
            `INSERT INTO public.analysis_requests(id, pipeline_version, status)
             VALUES ($1, 'v2', 'processing')`,
            [value.requestId],
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, status, lease_token, lease_expires_at
             ) VALUES ($1, $2, 'processing', $3, clock_timestamp() + interval '10 minutes')`,
            [value.requestId, value.jobKey, value.jobClaimToken],
        );
        await db.query(
            `UPDATE public.analysis_v2_gemini_leases
             SET state = 'leased', fence = 4, request_id = $1, job_key = $2,
                 attempt = 1, lease_claim_token = $3,
                 acquired_at = clock_timestamp(),
                 expires_at = clock_timestamp() + interval '10 minutes'
             WHERE slot = 1`,
            [value.requestId, value.jobKey, value.claimToken],
        );
        const initial = await acquireWithLeaseToken(
            value,
            '11111111-1111-4111-8111-111111111112',
        );
        expect(initial.outcome).toBe('acquired');
        const replay = await acquireWithLeaseToken(
            value,
            '11111111-1111-4111-8111-111111111113',
        );
        expect(replay.outcome).toBe('already_acquired');
        await db.query(
            `UPDATE public.analysis_pipeline_jobs SET lease_token = $2
             WHERE request_id = $1 AND job_key = $3`,
            [value.requestId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', value.jobKey],
        );
        const takeover = {
            ...value,
            jobClaimToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        };
        const adopted = await acquireWithLeaseToken(
            takeover,
            '22222222-2222-4222-8222-222222222222',
        );
        expect(adopted).toEqual(expect.objectContaining({
            outcome: 'adopted',
            leaseToken: '22222222-2222-4222-8222-222222222222',
            fence: 2,
        }));
        await expect(asService(
            `SELECT public.renew_analysis_provider_admission($1,$2,$3,120)`,
            [adopted.admissionId, initial.leaseToken, initial.fence],
        )).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_FENCE_MISMATCH');
        await expect(asService(
            `SELECT public.release_analysis_provider_admission($1,$2,$3)`,
            [adopted.admissionId, initial.leaseToken, initial.fence],
        )).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_FENCE_MISMATCH');
        await asService(
            `SELECT public.renew_analysis_provider_admission($1,$2,$3,120)`,
            [adopted.admissionId, adopted.leaseToken, adopted.fence],
        );
        await expect(acquireWithLeaseToken({
            ...takeover,
            claimToken: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        }, '33333333-3333-4333-8333-333333333333')).rejects.toThrow(
            'ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT',
        );

        await db.exec('SET ROLE postgres');
        await db.query(
            `UPDATE public.analysis_provider_admission_leases
             SET expires_at = clock_timestamp() - interval '1 second'
             WHERE admission_id = $1`,
            [adopted.admissionId],
        );
        await asService(
            `SELECT public.recover_expired_analysis_provider_admission($1,$2)`,
            [adopted.admissionId, '44444444-4444-4444-8444-444444444444'],
        );
        await db.exec('SET ROLE postgres');
        await db.query(
            `UPDATE public.analysis_v2_gemini_leases
             SET state = 'available', request_id = NULL, job_key = NULL,
                 attempt = NULL, lease_claim_token = NULL,
                 acquired_at = NULL, expires_at = NULL
             WHERE slot = 1`,
        );
        const fenced = await db.query<{ state: string }>(
            `SELECT public.analysis_provider_admission_ledger_state(lease) AS state
             FROM public.analysis_provider_admission_leases AS lease
             WHERE admission_id = $1`,
            [adopted.admissionId],
        );
        // The slot fence was already 4; reuse increments it before the resolver
        // is allowed to retire the old provider admission.
        await db.query(
            `UPDATE public.analysis_v2_gemini_leases
             SET fence = 5
             WHERE slot = 1`,
        );
        expect(fenced.rows[0]?.state).toBe('available');
        const fencedAfterReuse = await db.query<{ state: string }>(
            `SELECT public.analysis_provider_admission_ledger_state(lease) AS state
             FROM public.analysis_provider_admission_leases AS lease
             WHERE admission_id = $1`,
            [adopted.admissionId],
        );
        expect(fencedAfterReuse.rows[0]?.state).toBe('fenced_out');
        await expect(asService(
            `SELECT public.resolve_analysis_provider_admission($1,$2)`,
            [adopted.admissionId, '55555555-5555-4555-8555-555555555555'],
        )).resolves.toBeDefined();
        await db.exec('RESET ROLE');
        const resolved = await db.query<{ state: string; resolution_source: string }>(
            `SELECT state, resolution_source
             FROM public.analysis_provider_admission_leases WHERE admission_id = $1`,
            [adopted.admissionId],
        );
        expect(resolved.rows[0]).toEqual({
            state: 'released',
            resolution_source: 'gemini_lease_fenced',
        });
    });

    it('requires the exact shared Gemini B-lite slot lease and rejects stale provider claims', async () => {
        await db.exec(`
            UPDATE public.analysis_provider_admission_leases
            SET state = 'released', released_at = clock_timestamp(),
                expires_at = clock_timestamp(), release_reason = 'terminal',
                updated_at = clock_timestamp();
            UPDATE public.analysis_provider_admission_budgets
            SET window_count = 0, window_started_at = clock_timestamp();
        `);
        const input = bliteGeminiInput();
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, expires_at, status, lease_token, lease_expires_at,
                precheckout_blite_cohort
             ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'ready', $2,
                       clock_timestamp() + interval '10 minutes', TRUE)`,
            [input.requestId, input.jobClaimToken],
        );
        await db.query(
            `INSERT INTO public.precheckout_blite_cache(
                preflight_id, state, lease_token, lease_expires_at,
                attempt_count
             ) VALUES ($1, 'pending', $2, clock_timestamp() + interval '2 minutes', 0)`,
            [input.requestId, input.jobClaimToken],
        );
        await db.query(
            `UPDATE public.analysis_v2_gemini_leases
             SET state = 'leased', fence = $1, request_id = $2, job_key = $3,
                 attempt = 1, lease_claim_token = $4,
                 acquired_at = clock_timestamp(),
                 expires_at = clock_timestamp() + interval '10 minutes'
             WHERE slot = 3`,
            [input.providerFence!, input.requestId, input.jobKey, input.claimToken],
        );

        await db.query(
            `UPDATE public.analysis_v2_gemini_leases
             SET lease_claim_token = $1
             WHERE slot = 3`,
            ['15151515-1515-4151-8151-151515151515'],
        );
        await expect(acquire(input)).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT');

        await db.query(
            `UPDATE public.analysis_v2_gemini_leases
             SET fence = $1
             WHERE slot = 3`,
            [input.providerFence! + 1],
        );
        await expect(acquire(input)).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT');

        await db.query(
            `UPDATE public.analysis_v2_gemini_leases
             SET fence = $1, lease_claim_token = $2
             WHERE slot = 3`,
            [input.providerFence!, input.claimToken],
        );
        await expect(acquire({
            ...input,
            credentialSlot: 'gemini-4',
            budgetKey: 'paid:gemini:gemini-4',
        })).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT');

        await expect(acquire(input)).resolves.toEqual(
            expect.objectContaining({ outcome: 'acquired', credentialSlot: 'gemini-3' }),
        );
        await db.query(
            `UPDATE public.analysis_v2_gemini_leases
             SET expires_at = clock_timestamp() - interval '1 second'
             WHERE slot = 3`,
        );
        await expect(acquire(input)).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT');
    });

    it('preserves the beta dispatch guard and rotates ordinary preflight last-dispatch fences', async () => {
        const preflightId = 'abababab-abab-4bab-8bab-aaaaaaaaaaaa';
        const userId = 'cdcdcdcd-cdcd-4dcd-8dcd-cccccccccccc';
        const firstToken = 'dededede-dede-4ded-8ded-dddddddddddd';
        const claim = 'efefefef-efef-4efe-8efe-eeeeeeeeeeee';
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, user_id, expires_at, status, beta_entry_provenance, beta_prepare_state
             ) VALUES ($1, $2, clock_timestamp() + interval '10 minutes', 'pending',
                       'betatest_service_v1', 'pending')`,
            [preflightId, userId],
        );
        await expect(asService(
            `SELECT * FROM public.reserve_analysis_v2_preflight_dispatch($1,$2,$3)`,
            [preflightId, userId, firstToken],
        )).rejects.toThrow('ANALYSIS_BETA_PREPARE_REQUIRED');

        await db.query(
            `UPDATE public.analysis_preflights SET beta_prepare_state = 'prepared' WHERE id = $1`,
            [preflightId],
        );
        const reserved = await asService<{
            should_enqueue: boolean;
            dispatch_generation: number;
            reservation_token: string;
        }>(
            `SELECT * FROM public.reserve_analysis_v2_preflight_dispatch_v2($1::uuid,$2::uuid,$3::uuid,'preflight'::text,2::smallint)`,
            [preflightId, userId, firstToken],
        );
        expect(reserved.rows[0]).toEqual({
            should_enqueue: true,
            dispatch_generation: 1,
            reservation_token: firstToken,
            preflight_status: 'pending',
        });

        const marked = await asService<{ result: boolean }>(
            `SELECT public.mark_analysis_v2_preflight_dispatched_v2($1::uuid,$2::uuid,$3::integer,$4::uuid,'preflight'::text,2::smallint) AS result`,
            [preflightId, userId, 1, firstToken],
        );
        expect(marked.rows[0]?.result).toBe(true);
        const firstEnqueued = await db.query<{
            dispatch_state: string;
            dispatch_token: string | null;
            last_dispatch_token: string | null;
            dispatch_reserved_at: string | null;
        }>(
            `SELECT dispatch_state, dispatch_token, last_dispatch_token, dispatch_reserved_at
             FROM public.analysis_preflights WHERE id = $1`,
            [preflightId],
        );
        expect(firstEnqueued.rows[0]).toEqual({
            dispatch_state: 'enqueued',
            dispatch_token: null,
            last_dispatch_token: firstToken,
            dispatch_reserved_at: expect.any(Date),
        });

        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'processing', lease_token = $2,
                 lease_expires_at = clock_timestamp() + interval '5 minutes',
                 worker_attempt_count = 1
             WHERE id = $1`,
            [preflightId, claim],
        );
        const deferred = await asService<{ result: boolean }>(
            `SELECT public.defer_analysis_preflight_for_provider_capacity($1,$2) AS result`,
            [preflightId, claim],
        );
        expect(deferred.rows[0]?.result).toBe(true);
        const attempt = await db.query<{ worker_attempt_count: number; status: string }>(
            `SELECT worker_attempt_count, status FROM public.analysis_preflights WHERE id = $1`,
            [preflightId],
        );
        expect(attempt.rows[0]).toEqual({ worker_attempt_count: 0, status: 'pending' });

        const rearmed = await asService<{ payload: {
            should_enqueue: boolean;
            dispatch_generation: number;
            reservation_token: string;
        } }>(
            `SELECT public.rearm_analysis_preflight_dispatch_for_provider_capacity_v2($1,$2,$3)
                AS payload`,
            [preflightId, 1, firstToken],
        );
        expect(rearmed.rows[0]?.payload).toMatchObject({
            should_enqueue: true,
            dispatch_generation: 2,
        });
        const successorToken = rearmed.rows[0]?.payload.reservation_token;
        expect(successorToken).toMatch(/^[0-9a-f-]{36}$/);
        const stale = await asService<{ payload: { should_enqueue: boolean } }>(
            `SELECT public.rearm_analysis_preflight_dispatch_for_provider_capacity_v2($1,$2,$3)
                AS payload`,
            [preflightId, 1, firstToken],
        );
        expect(stale.rows[0]?.payload.should_enqueue).toBe(false);

        const successorMarked = await asService<{ result: boolean }>(
            `SELECT public.mark_analysis_preflight_rearmed_dispatch_for_provider_capacity_v2($1,$2,$3)
                AS result`,
            [preflightId, 2, successorToken],
        );
        expect(successorMarked.rows[0]?.result).toBe(true);
        const successor = await db.query<{
            dispatch_state: string;
            dispatch_token: string | null;
            last_dispatch_token: string | null;
            dispatch_reserved_at: string | null;
        }>(
            `SELECT dispatch_state, dispatch_token, last_dispatch_token, dispatch_reserved_at
             FROM public.analysis_preflights WHERE id = $1`,
            [preflightId],
        );
        expect(successor.rows[0]).toEqual({
            dispatch_state: 'enqueued',
            dispatch_token: null,
            last_dispatch_token: successorToken,
            dispatch_reserved_at: expect.any(Date),
        });
        const replayedMark = await asService<{ result: boolean }>(
            `SELECT public.mark_analysis_preflight_rearmed_dispatch_for_provider_capacity_v2($1,$2,$3)
                AS result`,
            [preflightId, 2, successorToken],
        );
        expect(replayedMark.rows[0]?.result).toBe(true);
    });

    it('keeps fresh and ordinary rearmed mark idempotency in separate domains', async () => {
        const freshId = 'abababab-abab-4bab-8bab-bbbbbbbbbbbb';
        const ordinaryId = 'cdcdcdcd-cdcd-4dcd-8dcd-dddddddddddd';
        const freshToken = 'efefefef-efef-4efe-8efe-eeeeeeeeeeee';
        const ordinaryToken = 'fefefefe-fefe-4fef-8fef-ffffffffffff';
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, user_id, expires_at, status, dispatch_state, dispatch_generation,
                dispatch_token, last_dispatch_token, dispatch_workload_role,
                dispatch_contract_version, admission_status, admission_generation,
                admission_dispatch_state, admission_dispatch_generation, admission_dispatch_token,
                admission_dispatch_workload_role, admission_dispatch_contract_version
             ) VALUES
                ($1, $3, clock_timestamp() + interval '10 minutes', 'ready', 'enqueued', 44,
                 NULL, $5, 'preflight', 2, 'pending', 7, 'reserved', 3, $4,
                 'paid', 2),
                ($2, $3, clock_timestamp() + interval '10 minutes', 'pending', 'reserved', 9,
                 $5, NULL, 'preflight', 2, 'pending', 8, 'reserved', 4, $4,
                 'paid', 2)`,
            [freshId, ordinaryId, 'abababab-abab-4bab-8bab-aaaaaaaaaaaa', freshToken, ordinaryToken],
        );

        // Fresh replay must use only admission_* columns.  The row intentionally has an
        // ordinary status/dispatch shape that would fail an accidental ordinary-domain guard.
        const freshWrongDomain = await asService<{ result: boolean }>(
            `SELECT public.mark_analysis_v2_preflight_admission_rearmed_dispatch_v2($1,7,3,$2)
                AS result`,
            [freshId, ordinaryToken],
        );
        expect(freshWrongDomain.rows[0]?.result).toBe(false);
        const freshMarked = await asService<{ result: boolean }>(
            `SELECT public.mark_analysis_v2_preflight_admission_rearmed_dispatch_v2($1,7,3,$2)
                AS result`,
            [freshId, freshToken],
        );
        expect(freshMarked.rows[0]?.result).toBe(true);
        const freshReplay = await asService<{ result: boolean }>(
            `SELECT public.mark_analysis_v2_preflight_admission_rearmed_dispatch_v2($1,7,3,$2)
                AS result`,
            [freshId, freshToken],
        );
        expect(freshReplay.rows[0]?.result).toBe(true);

        // Ordinary replay must use only ordinary dispatch columns.  The fresh token is a
        // different domain fence and must never settle this row.
        const ordinaryWrongDomain = await asService<{ result: boolean }>(
            `SELECT public.mark_analysis_preflight_rearmed_dispatch_for_provider_capacity_v2($1,9,$2)
                AS result`,
            [ordinaryId, freshToken],
        );
        expect(ordinaryWrongDomain.rows[0]?.result).toBe(false);
        const ordinaryMarked = await asService<{ result: boolean }>(
            `SELECT public.mark_analysis_preflight_rearmed_dispatch_for_provider_capacity_v2($1,9,$2)
                AS result`,
            [ordinaryId, ordinaryToken],
        );
        expect(ordinaryMarked.rows[0]?.result).toBe(true);
        const ordinaryReplay = await asService<{ result: boolean }>(
            `SELECT public.mark_analysis_preflight_rearmed_dispatch_for_provider_capacity_v2($1,9,$2)
                AS result`,
            [ordinaryId, ordinaryToken],
        );
        expect(ordinaryReplay.rows[0]?.result).toBe(true);
    });

    it('does not upgrade roleless V2 or roleless B-lite predecessors', async () => {
        const v2 = paidInput(9);
        const v2Token = '12121212-1212-4121-8121-aaaaaaaaaaaa';
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET dispatch_state = 'enqueued', dispatch_generation = 3,
                 dispatch_reservation_token = $2, dispatch_reserved_at = clock_timestamp(),
                 dispatched_at = clock_timestamp(), dispatch_workload_role = NULL,
                 dispatch_contract_version = NULL
             WHERE request_id = $1 AND job_key = $3`,
            [v2.requestId, v2Token, v2.jobKey],
        );
        await expect(asService(
            `SELECT * FROM public.reserve_analysis_v2_job_dispatch_v2(
                $1,$2,$3,'paid'::text,2::smallint
            )`,
            [v2.requestId, v2.jobKey, '13131313-1313-4131-8131-aaaaaaaaaaaa'],
        )).rejects.toThrow('ANALYSIS_V2_LEGACY_DISPATCH_ROLELESS');

        const bliteId = 'abababab-abab-4bab-8bab-777777777777';
        await db.query(
            `INSERT INTO public.analysis_preflights(id, expires_at, status)
             VALUES ($1, clock_timestamp() + interval '10 minutes', 'ready')`,
            [bliteId],
        );
        await db.query(
            `INSERT INTO public.precheckout_blite_dispatches(preflight_id, state, dispatch_token)
             VALUES ($1, 'enqueuing', '14141414-1414-4141-8141-aaaaaaaaaaaa')`,
            [bliteId],
        );
        await expect(asService(
            `SELECT public.reserve_precheckout_blite_dispatch_v2(
                'abababab-abab-4bab-8bab-777777777777'::uuid, 'preflight'::text, 2::smallint
            )`,
        )).rejects.toThrow('ANALYSIS_V2_LEGACY_DISPATCH_ROLELESS');
    });

    it('readiness permits exact role/fence traffic but blocks legacy and unsafe fresh claims', async () => {
        // Earlier cases intentionally leave provider-admission fixtures behind.  Readiness is
        // tested against a fresh preflight universe so a previous capacity case cannot masquerade
        // as an unsafe fresh claim.
        await db.exec('DELETE FROM public.analysis_preflights');
        await db.exec(`
            DELETE FROM public.analysis_provider_admission_leases;
            DELETE FROM public.analysis_v2_provider_runs;
            DELETE FROM public.analysis_preflight_provider_runs;
            DELETE FROM public.analysis_provider_runs;
            DELETE FROM public.analysis_v2_profile_repair_canary_runs;
            DELETE FROM public.analysis_v2_profile_provider_canary_runs;
        `);
        await db.query(`
            UPDATE public.analysis_pipeline_jobs
            SET dispatch_state = 'delivered',
                dispatch_generation = 1,
                dispatch_reservation_token = '12121212-1212-4121-8121-121212121212',
                dispatch_task_name = 'projects/example/locations/test/queues/paid/tasks/job',
                dispatch_reserved_at = clock_timestamp(),
                dispatched_at = clock_timestamp(),
                dispatch_workload_role = 'paid',
                dispatch_contract_version = 2,
                claim_workload_role = 'paid',
                claim_contract_version = 2
        `);
        const healthy = await asService<{ payload: Record<string, unknown> }>(
            `SELECT public.analysis_capacity_activation_readiness() AS payload`,
        );
        expect(healthy.rows[0]?.payload).toMatchObject({
            ready: true,
            legacyActiveQueuedV2Tasks: 0,
            legacyActiveV2JobClaims: 0,
            legacyActiveFreshAdmissions: 0,
        });

        const legacyFreshId = 'abababab-abab-4bab-8bab-888888888888';
        await db.query(`
            INSERT INTO public.analysis_preflights(
                id, expires_at, status, admission_status, admission_generation,
                admission_dispatch_state, admission_dispatch_generation,
                admission_dispatch_token, admission_dispatch_reserved_at,
                admission_dispatched_at
            ) VALUES (
                $1, clock_timestamp() + interval '10 minutes', 'ready', 'ready', 1,
                'enqueued', 1, 'cdcdcdcd-cdcd-4dcd-8dcd-888888888888',
                clock_timestamp(), clock_timestamp()
            )
        `, [legacyFreshId]);
        const legacyFresh = await asService<{ payload: Record<string, unknown> }>(
            `SELECT public.analysis_capacity_activation_readiness() AS payload`,
        );
        expect(legacyFresh.rows[0]?.payload).toMatchObject({ ready: false });
        expect(Number(legacyFresh.rows[0]?.payload.legacyActiveFreshAdmissions)).toBeGreaterThan(0);
        await db.query(`DELETE FROM public.analysis_preflights WHERE id = $1`, [legacyFreshId]);

        await db.query(`
            UPDATE public.analysis_pipeline_jobs
            SET dispatch_workload_role = NULL,
                dispatch_contract_version = NULL
            WHERE request_id = $1 AND job_key = $2
        `, [paidInput(0).requestId, paidInput(0).jobKey]);
        const legacy = await asService<{ payload: Record<string, unknown> }>(
            `SELECT public.analysis_capacity_activation_readiness() AS payload`,
        );
        expect(legacy.rows[0]?.payload).toMatchObject({
            ready: false,
        });
        expect(Number(legacy.rows[0]?.payload.legacyActiveQueuedV2Tasks)).toBeGreaterThan(0);

        const freshId = 'abababab-abab-4bab-8bab-999999999999';
        const freshClaim = 'cdcdcdcd-cdcd-4dcd-8dcd-999999999999';
        await db.query(`
            INSERT INTO public.analysis_preflights(
                id, expires_at, status, admission_status, admission_generation,
                admission_claim_token, admission_lease_expires_at,
                dispatch_workload_role, dispatch_contract_version,
                claim_workload_role, claim_contract_version
            ) VALUES (
                $1, clock_timestamp() + interval '10 minutes', 'processing', 'processing', 1,
                $2, clock_timestamp() + interval '5 minutes', 'preflight', 2, 'preflight', 2
            )
        `, [freshId, freshClaim]);
        const unsafeFresh = await asService<{ payload: Record<string, unknown> }>(
            `SELECT public.analysis_capacity_activation_readiness() AS payload`,
        );
        expect(unsafeFresh.rows[0]?.payload).toMatchObject({
            ready: false,
        });
        expect(Number(unsafeFresh.rows[0]?.payload.legacyActiveFreshAdmissions)).toBeGreaterThan(0);
    });
});
