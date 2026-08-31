import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    analysisProviderAdmissionId,
    type AnalysisProviderAdmissionInput,
} from './provider-admission-store';

const databaseUrl = process.env.ANALYSIS_PROVIDER_ADMISSION_POSTGRES_TEST_URL;
const suppliedMarker = process.env.ANALYSIS_PROVIDER_ADMISSION_POSTGRES_TEST_MARKER;
const marker = 'analysis-provider-admission-local-ephemeral-v1';

export function isSafeAnalysisProviderAdmissionPostgresTarget(
    connectionString: string | undefined,
    markerValue: string | undefined,
): boolean {
    if (markerValue !== marker || !connectionString) return false;
    try {
        const url = new URL(connectionString);
        return url.protocol === 'postgresql:'
            && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
            && url.pathname === '/analysis_provider_admission_test';
    } catch {
        return false;
    }
}

const describePostgres = isSafeAnalysisProviderAdmissionPostgresTarget(
    databaseUrl,
    suppliedMarker,
) ? describe : describe.skip;

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260831100000_add_analysis_provider_admission_leases.sql',
    import.meta.url,
), 'utf8');

// gitleaks:allow -- deterministic local integration fixtures, not user identities
const jobKey = 'track:relationships:collect';
const operationKey = `target-profile:${'a'.repeat(64)}`;

function input(index: number): AnalysisProviderAdmissionInput {
    const suffix = String(index + 1).padStart(12, '0');
    return {
        workloadRole: 'paid',
        logicalProvider: 'apify',
        credentialSlot: 'secondary',
        budgetKey: 'paid:apify:secondary',
        requestId: `11111111-1111-4111-8111-${suffix}`,
        jobKey,
        operationKey,
        // Apify's provider-run ledger is reserved immediately after the
        // admission callback, so its claim is the same durable task claim.
        claimToken: `33333333-3333-4333-8333-${suffix}`,
        jobClaimToken: `33333333-3333-4333-8333-${suffix}`,
        leaseSeconds: 120,
    };
}

async function asService<T>(
    client: PoolClient,
    sql: string,
    values: unknown[] = [],
): Promise<T> {
    await client.query('BEGIN');
    try {
        await client.query('SET LOCAL ROLE service_role');
        const result = await client.query<{ result: T }>(sql, values);
        await client.query('COMMIT');
        if (!result.rows[0]) throw new Error('ANALYSIS_PROVIDER_ADMISSION_EMPTY_RESULT');
        return result.rows[0].result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    }
}

function acquireSql(functionName = 'public.acquire_analysis_provider_admission'): string {
    return `SELECT ${functionName}(
        $1::text,$2::text,$3::text,$4::text,$5::text,$6::uuid,$7::text,$8::text,
        $9::uuid,$10::uuid,$11::bigint,$12::uuid,$13::integer
    ) AS result`;
}

function acquireValues(value: AnalysisProviderAdmissionInput, leaseToken: string): unknown[] {
    return [
        analysisProviderAdmissionId(value),
        value.workloadRole,
        value.logicalProvider,
        value.credentialSlot,
        value.budgetKey,
        value.requestId,
        value.jobKey,
        value.operationKey,
        value.jobClaimToken,
        value.claimToken,
        value.providerFence ?? null,
        leaseToken,
        value.leaseSeconds,
    ];
}

async function bootstrap(pool: Pool): Promise<void> {
    await pool.query(`
        DROP SCHEMA IF EXISTS public CASCADE;
        DROP SCHEMA IF EXISTS extensions CASCADE;
        CREATE SCHEMA public;
        CREATE SCHEMA extensions;
        DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        GRANT USAGE ON SCHEMA public TO service_role;
        CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY,
            pipeline_version TEXT NOT NULL,
            status TEXT NOT NULL,
            preflight_id UUID,
            analysis_entry_channel TEXT NOT NULL DEFAULT 'standard'
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
            idempotency_key TEXT,
            target_instagram_id TEXT,
            expires_at TIMESTAMPTZ NOT NULL,
            status TEXT NOT NULL,
            exclusion_decision TEXT,
            access_mode TEXT,
            launch_status_snapshot JSONB,
            plan_catalog_snapshot JSONB,
            plan_cards_snapshot JSONB,
            pricing_version TEXT,
            pricing_snapshot JSONB,
            policy_versions_snapshot JSONB,
            target_full_name TEXT,
            target_bio TEXT,
            target_profile_image_url TEXT,
            target_followers_count INTEGER,
            target_following_count INTEGER,
            target_is_private BOOLEAN,
            capacity_required_plan_id TEXT,
            required_plan_id TEXT,
            error_code TEXT,
            worker_attempt_count INTEGER NOT NULL DEFAULT 0,
            analysis_entry_channel TEXT NOT NULL DEFAULT 'standard',
            order_scoped_apify_credential_slot TEXT,
            precheckout_blite_cohort BOOLEAN NOT NULL DEFAULT FALSE,
            pii_scrubbed_at TIMESTAMPTZ,
            lease_token UUID,
            lease_expires_at TIMESTAMPTZ,
            dispatch_generation INTEGER NOT NULL DEFAULT 0,
            dispatch_state TEXT NOT NULL DEFAULT 'unreserved',
            dispatch_token UUID,
            dispatch_reserved_at TIMESTAMPTZ,
            dispatched_at TIMESTAMPTZ,
            last_dispatch_token UUID,
            consumed_request_id UUID,
            admission_status TEXT,
            admission_claim_token UUID,
            admission_lease_expires_at TIMESTAMPTZ,
            admission_generation INTEGER NOT NULL DEFAULT 0,
            admission_dispatch_state TEXT NOT NULL DEFAULT 'unreserved',
            admission_dispatch_token UUID,
            admission_dispatch_reserved_at TIMESTAMPTZ,
            admission_dispatch_workload_role TEXT,
            admission_dispatch_contract_version SMALLINT,
            admission_claim_workload_role TEXT,
            admission_claim_contract_version SMALLINT,
            beta_prepare_state TEXT,
            beta_prepare_dispatch_state TEXT,
            beta_prepare_dispatch_token UUID,
            beta_prepare_lease_token UUID,
            beta_prepare_lease_expires_at TIMESTAMPTZ,
            beta_prepare_workload_role TEXT,
            beta_prepare_contract_version SMALLINT,
            claim_token_hash TEXT,
            claim_workload_role TEXT,
            claim_contract_version SMALLINT,
            dispatch_workload_role TEXT,
            dispatch_contract_version SMALLINT,
            submitted_at TIMESTAMPTZ,
            deadline_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
            ready_at TIMESTAMPTZ,
            consumed_at TIMESTAMPTZ,
            blocked_at TIMESTAMPTZ,
            claimed_at TIMESTAMPTZ,
            exclusion_decided_at TIMESTAMPTZ,
            CONSTRAINT analysis_preflights_dispatch_check CHECK (
                dispatch_generation BETWEEN 0 AND 100
                AND dispatch_state IN ('unreserved', 'reserved', 'enqueued')
                AND (
                    (dispatch_state = 'unreserved' AND dispatch_generation = 0
                        AND dispatch_token IS NULL AND dispatch_reserved_at IS NULL
                        AND dispatched_at IS NULL)
                    OR (dispatch_state = 'reserved' AND dispatch_generation > 0
                        AND dispatch_token IS NOT NULL AND dispatch_reserved_at IS NOT NULL
                        AND dispatched_at IS NULL)
                    OR (dispatch_state = 'enqueued' AND dispatch_generation > 0
                        AND dispatch_token IS NULL AND dispatch_reserved_at IS NOT NULL
                        AND dispatched_at IS NOT NULL)
                )
            )
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
            terminalized_at TIMESTAMPTZ
        );
        CREATE TABLE public.analysis_v2_provider_runs (
            request_id UUID NOT NULL,
            job_key TEXT NOT NULL,
            operation_key TEXT NOT NULL,
            logical_provider TEXT NOT NULL,
            credential_slot TEXT NOT NULL,
            status TEXT NOT NULL,
            run_id TEXT,
            terminalized_at TIMESTAMPTZ,
            usage_reconciled_at TIMESTAMPTZ,
            job_claim_token UUID
        );
        CREATE TABLE public.analysis_provider_runs (
            request_id UUID NOT NULL,
            operation_key TEXT NOT NULL,
            logical_provider TEXT NOT NULL,
            actor_id TEXT,
            status TEXT NOT NULL,
            run_id TEXT,
            terminalized_at TIMESTAMPTZ,
            usage_reconciled_at TIMESTAMPTZ
        );
        CREATE TABLE public.analysis_v2_profile_provider_canary_runs (
            source_request_id UUID NOT NULL,
            state TEXT NOT NULL,
            usage_reconciled_at TIMESTAMPTZ
        );
        CREATE TABLE public.precheckout_blite_cache (
            preflight_id UUID PRIMARY KEY,
            state TEXT NOT NULL DEFAULT 'pending',
            lease_token UUID NOT NULL,
            lease_expires_at TIMESTAMPTZ NOT NULL,
            dto JSONB,
            attempt_count SMALLINT NOT NULL DEFAULT 0,
            failure_reason TEXT,
            failed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
            completed_at TIMESTAMPTZ,
            CONSTRAINT precheckout_blite_cache_state_check CHECK (state IN ('pending', 'complete')),
            CONSTRAINT precheckout_blite_cache_payload_check CHECK (TRUE),
            CONSTRAINT precheckout_blite_cache_timestamp_check CHECK (updated_at >= created_at)
        );
        CREATE TABLE public.precheckout_blite_sources (
            preflight_id UUID PRIMARY KEY,
            provider_operation_key TEXT,
            payload JSONB
        );
        CREATE TABLE public.precheckout_blite_dispatches (
            preflight_id UUID PRIMARY KEY,
            state TEXT NOT NULL DEFAULT 'idle',
            attempt_count SMALLINT NOT NULL DEFAULT 0,
            dispatch_token UUID,
            lease_expires_at TIMESTAMPTZ,
            failure_reason TEXT,
            dispatch_generation INTEGER NOT NULL DEFAULT 1,
            last_dispatch_token UUID,
            dispatch_workload_role TEXT,
            dispatch_contract_version SMALLINT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT precheckout_blite_dispatch_state_check CHECK (state IN ('idle', 'enqueuing', 'enqueued')),
            CONSTRAINT precheckout_blite_dispatch_attempt_check CHECK (attempt_count BETWEEN 0 AND 32767),
            CONSTRAINT precheckout_blite_dispatch_failure_check CHECK (failure_reason IS NULL OR failure_reason = 'dispatch_failed'),
            CONSTRAINT precheckout_blite_dispatch_token_check CHECK (
                (state = 'enqueuing' AND dispatch_token IS NOT NULL AND lease_expires_at IS NOT NULL)
                OR (state IN ('idle', 'enqueued') AND dispatch_token IS NULL AND lease_expires_at IS NULL)
            ),
            CONSTRAINT precheckout_blite_dispatch_timestamp_check CHECK (updated_at >= created_at)
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
        -- Historical dispatch RPCs are supplied as inert fixtures so the additive migration can
        -- revoke and wrap their exact signatures without applying the complete production schema.
        CREATE FUNCTION public.reserve_analysis_v2_preflight_dispatch(
            p_preflight_id UUID, p_user_id UUID, p_dispatch_token UUID
        ) RETURNS TABLE(
            should_enqueue BOOLEAN,
            dispatch_generation INTEGER,
            reservation_token UUID,
            preflight_status TEXT
        ) LANGUAGE SQL AS $$
            SELECT FALSE, 0, NULL::UUID, 'fixture'::TEXT
        $$;
        CREATE FUNCTION public.mark_analysis_v2_preflight_dispatched(
            p_preflight_id UUID, p_user_id UUID,
            p_dispatch_generation INTEGER, p_dispatch_token UUID
        ) RETURNS BOOLEAN LANGUAGE SQL AS $$ SELECT FALSE $$;
    `);
    await pool.query(migration);
    await pool.query(`
        INSERT INTO public.analysis_v2_gemini_leases(slot, state)
        SELECT slot, 'available' FROM generate_series(1, 8) AS slots(slot);
    `);
    await pool.query(`
        CREATE FUNCTION public.test_hold_provider_admission(
            p_admission_id TEXT, p_workload_role TEXT, p_logical_provider TEXT,
            p_credential_slot TEXT, p_budget_key TEXT, p_request_id UUID,
            p_job_key TEXT, p_operation_key TEXT, p_job_claim_token UUID,
            p_claim_token UUID, p_provider_fence BIGINT, p_lease_token UUID, p_lease_seconds INTEGER
        ) RETURNS JSONB
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
        AS $$
        DECLARE v_result JSONB;
        BEGIN
            v_result := public.acquire_analysis_provider_admission(
                p_admission_id, p_workload_role, p_logical_provider,
                p_credential_slot, p_budget_key, p_request_id, p_job_key,
                p_operation_key, p_job_claim_token, p_claim_token, p_provider_fence, p_lease_token,
                p_lease_seconds
            );
            PERFORM pg_catalog.pg_sleep(0.75);
            RETURN v_result;
        END;
        $$;
        GRANT EXECUTE ON FUNCTION public.test_hold_provider_admission(
            TEXT,TEXT,TEXT,TEXT,TEXT,UUID,TEXT,TEXT,UUID,UUID,BIGINT,UUID,INTEGER
        ) TO service_role;
    `);
    for (let index = 0; index < 9; index += 1) {
        const value = input(index);
        await pool.query(
            `INSERT INTO public.analysis_requests(id, pipeline_version, status)
             VALUES ($1, 'v2', 'processing')`,
            [value.requestId],
        );
        await pool.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, status, lease_token, lease_expires_at
             ) VALUES ($1, $2, 'processing', $3, clock_timestamp() + interval '10 minutes')`,
            [value.requestId, value.jobKey, value.jobClaimToken],
        );
    }
}

describe('provider admission PostgreSQL target guard', () => {
    it('accepts only a marked loopback disposable database', () => {
        expect(isSafeAnalysisProviderAdmissionPostgresTarget(
            'postgresql://tester@127.0.0.1:55432/analysis_provider_admission_test',
            marker,
        )).toBe(true);
    });

    it.each([
        ['postgresql://tester@db.example.com/analysis_provider_admission_test', marker],
        ['postgresql://tester@127.0.0.1:55432/postgres', marker],
        ['postgresql://tester@127.0.0.1:55432/analysis_provider_admission_test', undefined],
    ])('rejects unsafe or unmarked targets', (url, markerValue) => {
        expect(isSafeAnalysisProviderAdmissionPostgresTarget(url, markerValue)).toBe(false);
    });
});

describePostgres('provider admission true-session concurrency', () => {
    let pool: Pool;

    beforeAll(async () => {
        if (!databaseUrl) throw new Error('ANALYSIS_PROVIDER_ADMISSION_POSTGRES_URL_MISSING');
        pool = new Pool({ connectionString: databaseUrl, max: 8 });
        await bootstrap(pool);
    }, 30_000);

    afterAll(async () => {
        await pool?.end();
    });

    it('serializes competing sessions and never returns a secret to a changed claim', async () => {
        const first = await pool.connect();
        const second = await pool.connect();
        try {
            const value = input(0);
            const args = acquireValues(value, '33333333-3333-4333-8333-333333333333');
            const firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            expect(firstPid).not.toBe(secondPid);
            const firstResult = asService<{ outcome: string }>(
                first,
                acquireSql('public.test_hold_provider_admission').replace(
                    '::integer\n    )',
                    '::integer\n    )',
                ),
                args,
            );
            await new Promise(resolve => setTimeout(resolve, 100));
            const secondResult = asService<{ outcome: string }>(
                second,
                acquireSql(),
                acquireValues(value, '44444444-4444-4444-8444-444444444444'),
            );
            await expect(firstResult).resolves.toMatchObject({ outcome: 'acquired' });
            await expect(secondResult).resolves.toMatchObject({ outcome: 'already_acquired' });

            await pool.query(
                `UPDATE public.analysis_pipeline_jobs
                 SET lease_token = $2
                 WHERE request_id = $1 AND job_key = $3`,
                [value.requestId, '55555555-5555-4555-8555-555555555555', value.jobKey],
            );
            await expect(asService(
                second,
                acquireSql(),
                acquireValues({
                    ...value,
                    claimToken: '55555555-5555-4555-8555-555555555555',
                    jobClaimToken: '55555555-5555-4555-8555-555555555555',
                }, '66666666-6666-4666-8666-666666666666'),
            )).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT');
        } finally {
            first.release();
            second.release();
        }
    });

    it('retains expired-running capacity until a ledger-proven adoption', async () => {
        const value = input(0);
        for (let index = 1; index < 8; index += 1) {
            const client = await pool.connect();
            try {
                await asService(client, acquireSql(), acquireValues(
                    input(index),
                    `33333333-3333-4333-8333-${String(index + 10).padStart(12, '0')}`,
                ));
            } finally {
                client.release();
            }
        }
        const pendingClient = await pool.connect();
        try {
            await expect(asService(
                pendingClient,
                acquireSql(),
                acquireValues(input(8), '44444444-4444-4444-8444-444444444444'),
            )).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING');
        } finally {
            pendingClient.release();
        }
        const maintenance = await pool.connect();
        try {
            await maintenance.query(
                `UPDATE public.analysis_provider_admission_leases
                 SET expires_at = clock_timestamp() - interval '1 second'
                 WHERE admission_id = $1`,
                [analysisProviderAdmissionId(value)],
            );
            await asService(
                maintenance,
                `SELECT public.recover_expired_analysis_provider_admission($1,$2) AS result`,
                [
                    analysisProviderAdmissionId(value),
                    '77777777-7777-4777-8777-777777777777',
                ],
            );
            await expect(asService(
                maintenance,
                acquireSql(),
                acquireValues(input(8), '88888888-8888-4888-8888-888888888888'),
            )).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING');
            await maintenance.query(
                `INSERT INTO public.analysis_v2_provider_runs(
                    request_id, job_key, operation_key, logical_provider,
                    credential_slot, status, run_id
                 ) VALUES ($1,$2,$3,'apify','secondary','running','RunAbcd12345678')`,
                [value.requestId, value.jobKey, value.operationKey],
            );
            await maintenance.query(
                `UPDATE public.analysis_pipeline_jobs
                 SET lease_token = $2
                 WHERE request_id = $1 AND job_key = $3`,
                [value.requestId, '99999999-9999-4999-8999-999999999999', value.jobKey],
            );
            await expect(asService(
                maintenance,
                acquireSql(),
                acquireValues({
                    ...value,
                    claimToken: '99999999-9999-4999-8999-999999999999',
                    jobClaimToken: '99999999-9999-4999-8999-999999999999',
                }, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
            )).resolves.toMatchObject({ outcome: 'adopted' });
            const active = await maintenance.query<{ count: string }>(
                `SELECT count(*)::text AS count
                 FROM public.analysis_provider_admission_leases
                 WHERE state IN ('leased', 'recovery_required')
                   AND workload_role = 'paid'
                   AND logical_provider = 'apify'`,
            );
            expect(Number(active.rows[0]?.count)).toBe(8);
        } finally {
            maintenance.release();
        }
    });

    it('uses the preflight ledger for paid beta-held lifecycle recovery', async () => {
        const maintenance = await pool.connect();
        try {
            await maintenance.query(`
                UPDATE public.analysis_provider_admission_leases
                SET state = 'released', released_at = clock_timestamp(),
                    expires_at = clock_timestamp(), release_reason = 'terminal',
                    updated_at = clock_timestamp()
                WHERE state IN ('leased', 'recovery_required')
            `);
            await maintenance.query(`
                UPDATE public.analysis_provider_admission_budgets
                SET window_count = 0, window_started_at = clock_timestamp(),
                    updated_at = clock_timestamp()
            `);
            const value = {
                ...input(20),
                requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0021',
                jobKey: 'preflight:provider',
                operationKey: 'target-profile-fallback',
                credentialSlot: 'septenary',
                budgetKey: 'paid:apify:septenary',
            } satisfies AnalysisProviderAdmissionInput;
            const allocationId = '12121212-1212-4121-8121-121212121212';
            await maintenance.query(
                `INSERT INTO public.analysis_preflights(
                    id, expires_at, status, analysis_entry_channel,
                    lease_token, lease_expires_at
                 ) VALUES ($1, clock_timestamp() + interval '10 minutes', 'processing', 'betatest',
                           $2, clock_timestamp() + interval '10 minutes')`,
                [value.requestId, value.jobClaimToken],
            );
            await maintenance.query(
                `INSERT INTO public.analysis_beta_pool_allocations(
                    id, preflight_id, lifecycle_state
                 ) VALUES ($1, $2, 'preflight_held')`,
                [allocationId, value.requestId],
            );
            await maintenance.query(
                `INSERT INTO public.analysis_beta_pool_reservations(
                    allocation_id, operation_family, credential_slot, lifecycle_state
                 ) VALUES ($1, 'target-profile', 'septenary', 'preflight_held')`,
                [allocationId],
            );
            const acquired = await asService<{ outcome: string; admissionId: string }>(
                maintenance,
                acquireSql(),
                acquireValues(value, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0022'),
            );
            await maintenance.query(
                `INSERT INTO public.analysis_preflight_provider_runs(
                    preflight_id, operation_key, logical_provider, credential_slot,
                    status, run_id
                 ) VALUES ($1, $2, 'apify', 'septenary', 'starting', 'RunBetaAmbiguous123')`,
                [value.requestId, value.operationKey],
            );
            await expect(asService(
                maintenance,
                `SELECT public.release_analysis_provider_admission($1,$2,$3) AS result`,
                [acquired.admissionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0022', 1],
            )).rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT');

            await maintenance.query(
                `UPDATE public.analysis_provider_admission_leases
                 SET expires_at = clock_timestamp() - interval '1 second'
                 WHERE admission_id = $1`,
                [acquired.admissionId],
            );
            await asService(
                maintenance,
                `SELECT public.recover_expired_analysis_provider_admission($1,$2) AS result`,
                [acquired.admissionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0023'],
            );
            const startingResolution = await asService<{ resolved: boolean }>(
                maintenance,
                `SELECT public.resolve_analysis_provider_admission($1,$2) AS result`,
                [acquired.admissionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0024'],
            );
            expect(startingResolution.resolved).toBe(false);

            await maintenance.query(
                `UPDATE public.analysis_preflight_provider_runs
                 SET status = 'running', run_id = 'RunBetaRunning123'
                 WHERE preflight_id = $1 AND operation_key = $2`,
                [value.requestId, value.operationKey],
            );
            const runningResolution = await asService<{ resolved: boolean }>(
                maintenance,
                `SELECT public.resolve_analysis_provider_admission($1,$2) AS result`,
                [acquired.admissionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0025'],
            );
            expect(runningResolution.resolved).toBe(false);

            await maintenance.query(
                `UPDATE public.analysis_preflight_provider_runs
                 SET status = 'succeeded', terminalized_at = clock_timestamp()
                 WHERE preflight_id = $1 AND operation_key = $2`,
                [value.requestId, value.operationKey],
            );
            const terminalResolution = await asService<{ resolved: boolean }>(
                maintenance,
                `SELECT public.resolve_analysis_provider_admission($1,$2) AS result`,
                [acquired.admissionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0026'],
            );
            expect(terminalResolution.resolved).toBe(true);
            const source = await maintenance.query<{ resolution_source: string }>(
                `SELECT resolution_source
                 FROM public.analysis_provider_admission_leases
                 WHERE admission_id = $1`,
                [acquired.admissionId],
            );
            expect(source.rows[0]?.resolution_source).toBe('provider_ledger_terminal');
        } finally {
            maintenance.release();
        }
    });

    it('proves active-count and expiry recovery queries use their partial indexes', async () => {
        const maintenance = await pool.connect();
        try {
            await maintenance.query(`
                INSERT INTO public.analysis_provider_admission_leases(
                    admission_id, workload_role, logical_provider, credential_slot,
                    budget_key, request_id, job_key, operation_key,
                    claim_token, job_claim_token, lease_token, fence,
                    state, acquired_at, expires_at, released_at, release_reason,
                    created_at, updated_at
                )
                SELECT
                    repeat(md5('plan-admission-' || series::text), 2),
                    'paid', 'apify', 'secondary', 'paid:apify:secondary',
                    (
                        substr(md5('plan-request-' || series::text), 1, 8) || '-' ||
                        substr(md5('plan-request-' || series::text), 9, 4) || '-4' ||
                        substr(md5('plan-request-' || series::text), 14, 3) || '-8' ||
                        substr(md5('plan-request-' || series::text), 18, 3) || '-' ||
                        substr(md5('plan-request-' || series::text), 21, 12)
                    )::uuid,
                    'track:relationships:collect',
                    CASE WHEN series <= 512
                        THEN 'plan-evidence:' || series::text
                        ELSE 'plan-released:' || series::text
                    END,
                    extensions.gen_random_uuid(), extensions.gen_random_uuid(),
                    extensions.gen_random_uuid(), 1,
                    CASE WHEN series <= 512 THEN 'leased' ELSE 'released' END,
                    clock_timestamp(),
                    CASE
                        WHEN series > 512 THEN clock_timestamp()
                        WHEN series <= 16 THEN clock_timestamp() - interval '1 minute'
                        ELSE clock_timestamp() + interval '10 minutes'
                    END,
                    CASE WHEN series <= 512 THEN NULL ELSE clock_timestamp() END,
                    CASE WHEN series <= 512 THEN NULL ELSE 'terminal' END,
                    clock_timestamp(), clock_timestamp()
                FROM generate_series(1, 20512) AS generated(series)
            `);
            await maintenance.query('ANALYZE public.analysis_provider_admission_leases');

            const activePlan = await maintenance.query<{
                'QUERY PLAN': Array<{ Plan: Record<string, unknown> }>;
            }>(`
                EXPLAIN (FORMAT JSON)
                SELECT count(*)
                FROM public.analysis_provider_admission_leases AS lease
                WHERE lease.state IN ('leased', 'recovery_required')
                  AND lease.workload_role = 'paid'
                  AND lease.logical_provider = 'apify'
                  AND lease.credential_slot = 'secondary'
            `);
            const expiryPlan = await maintenance.query<{
                'QUERY PLAN': Array<{ Plan: Record<string, unknown> }>;
            }>(`
                EXPLAIN (FORMAT JSON)
                SELECT lease.admission_id, lease.fence, lease.expires_at
                FROM public.analysis_provider_admission_leases AS lease
                WHERE lease.state IN ('leased', 'recovery_required')
                  AND lease.expires_at <= clock_timestamp()
                ORDER BY lease.expires_at, lease.fence, lease.admission_id
                LIMIT 16
            `);
            const activePlanJson = JSON.stringify(activePlan.rows[0]?.['QUERY PLAN'] ?? []);
            const expiryPlanJson = JSON.stringify(expiryPlan.rows[0]?.['QUERY PLAN'] ?? []);
            expect(activePlanJson).toContain('analysis_provider_admission_leases_active_claim_idx');
            expect(expiryPlanJson).toContain('analysis_provider_admission_leases_expiry_recovery_idx');
            // The evidence is intentionally limited to planner metadata and index names;
            // no lease claims, credentials, or provider payloads are emitted.
            console.log(JSON.stringify({
                explainFormat: 'JSON',
                activeCountPlan: activePlan.rows[0]?.['QUERY PLAN'] ?? [],
                expiryRecoveryPlan: expiryPlan.rows[0]?.['QUERY PLAN'] ?? [],
                activeCountPlanIndex: 'analysis_provider_admission_leases_active_claim_idx',
                expiryRecoveryPlanIndex: 'analysis_provider_admission_leases_expiry_recovery_idx',
            }));
        } finally {
            await maintenance.query(
                `DELETE FROM public.analysis_provider_admission_leases
                 WHERE operation_key LIKE 'plan-evidence:%'
                    OR operation_key LIKE 'plan-released:%'`,
            );
            maintenance.release();
        }
    });
});
