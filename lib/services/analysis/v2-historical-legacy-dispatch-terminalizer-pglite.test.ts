import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260904000000_analysis_v2_historical_legacy_dispatch_terminalizer.sql',
        import.meta.url
    ),
    'utf8'
);

type Candidate = {
    requestId: string;
    jobKey: string;
    inputHash: string;
    priorStatus: 'pending' | 'processing';
    priorDispatchState: 'delivered';
    priorDispatchGeneration: number;
    priorDispatchReservationToken: string;
    priorDispatchReservedAt: string;
    priorDispatchedAt: string;
    priorDeliveredAt: string;
    priorDispatchTaskName: string;
    priorDispatchWorkloadRole: null;
    priorDispatchContractVersion: null;
    priorClaimWorkloadRole: null;
    priorClaimContractVersion: null;
    priorLeaseToken: string | null;
    priorLeaseExpiresAt: string | null;
    manualResolutionOperationKey: string | null;
    manualResolutionEvidenceHash: string | null;
};

type Resolution = {
    requestId: string;
    jobKey: string;
    status: string;
    errorCode: string;
    auditEvidenceHash: string;
    replayed: boolean;
};

const AUDIT_HASH = 'd'.repeat(64);
const MANUAL_HASH = 'c'.repeat(64);
let db: PGlite;

const UUID = (index: number): string =>
    `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

async function listCandidates(limit = 64): Promise<Candidate[]> {
    const result = await db.query<{ candidates: Candidate[] }>(
        `SELECT public.list_analysis_v2_historical_legacy_dispatch_candidates($1) AS candidates`,
        [limit]
    );
    return result.rows[0].candidates ?? [];
}

async function resolve(candidate: Candidate, overrides: Partial<Candidate> = {}, terminalStatus = 'failed', auditHash = AUDIT_HASH) {
    const value = { ...candidate, ...overrides };
    return db.query<{ result: Resolution }>(
        `SELECT public.resolve_analysis_v2_historical_legacy_dispatch(
            $1::UUID, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT, $6::INTEGER,
            $7::UUID, $8::TIMESTAMPTZ, $9::TIMESTAMPTZ, $10::TIMESTAMPTZ,
            $11::TEXT, $12::TEXT, $13::SMALLINT, $14::TEXT, $15::SMALLINT,
            $16::UUID, $17::TIMESTAMPTZ, $18::TEXT, $19::TEXT, $20::TEXT, $21::TEXT
        ) AS result`,
        [
            value.requestId,
            value.jobKey,
            value.inputHash,
            value.priorStatus,
            value.priorDispatchState,
            value.priorDispatchGeneration,
            value.priorDispatchReservationToken,
            value.priorDispatchReservedAt,
            value.priorDispatchedAt,
            value.priorDeliveredAt,
            value.priorDispatchTaskName,
            value.priorDispatchWorkloadRole,
            value.priorDispatchContractVersion,
            value.priorClaimWorkloadRole,
            value.priorClaimContractVersion,
            value.priorLeaseToken,
            value.priorLeaseExpiresAt,
            value.manualResolutionOperationKey,
            value.manualResolutionEvidenceHash,
            terminalStatus,
            auditHash,
        ]
    );
}

type SeedOptions = {
    requestPipeline?: string;
    requestStatus?: string;
    requestLease?: 'none' | 'expired' | 'live';
    jobStatus?: string;
    jobDispatchState?: string;
    jobWorkloadRole?: string | null;
    jobDispatchContractVersion?: number | null;
    jobClaimWorkloadRole?: string | null;
    jobClaimContractVersion?: number | null;
    jobLease?: 'none' | 'expired' | 'live' | 'malformed';
    age?: 'old' | 'young';
    providerStatus?: string;
    providerReconciled?: boolean;
    manualEvidence?: string | null;
    manualKind?: string | null;
    admission?: 'none' | 'live' | 'expired';
    aiAttempt?: 'none' | 'reserved' | 'ambiguous';
    geminiLease?: boolean;
    budgetReservation?: boolean;
    revenueChild?: boolean;
    cleanupIntent?: boolean;
    schedulerClaim?: boolean;
    providerRunCount?: number;
    extraRejectedProviderRun?: boolean;
};

async function seedCandidate(index: number, options: SeedOptions = {}): Promise<void> {
    const requestId = UUID(index);
    const jobKey = `track:profiles:batch:${index}`;
    const dispatchReservationToken = UUID(index + 100);
    const priorLeaseToken = UUID(index + 200);
    const dispatchReservedAt = '2026-07-01T00:00:00.000Z';
    const dispatchedAt = '2026-07-01T00:01:00.000Z';
    const deliveredAt = '2026-07-01T00:02:00.000Z';
    const updatedAt = options.age === 'young'
        ? '2026-09-01T00:00:00.000Z'
        : '2026-07-01T00:02:00.000Z';
    const requestLeaseToken = UUID(index + 300);
    const requestLeaseExpiry = options.requestLease === 'live'
        ? '2099-01-01T00:00:00.000Z'
        : options.requestLease === 'expired'
            ? '2026-07-02T00:00:00.000Z'
            : null;
    const jobLeaseToken = options.jobLease === 'live'
        || options.jobLease === 'expired'
        || options.jobLease === 'malformed'
        ? priorLeaseToken
        : null;
    const jobLeaseExpiry = options.jobLease === 'live'
        ? '2099-01-01T00:00:00.000Z'
        : options.jobLease === 'expired'
            ? '2026-07-02T00:00:00.000Z'
            : options.jobLease === 'malformed'
                ? null
                : null;
    await db.query(
        `INSERT INTO public.analysis_requests(
            id, pipeline_version, status, processing_lease_token, processing_lease_expires_at
        ) VALUES ($1, $2, $3, $4::UUID, $5::TIMESTAMPTZ)`,
        [
            requestId,
            options.requestPipeline ?? 'v2',
            options.requestStatus ?? 'failed',
            options.requestLease === undefined || options.requestLease === 'none' ? null : requestLeaseToken,
            requestLeaseExpiry,
        ]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs(
            request_id, job_key, input_hash, status, dispatch_state,
            dispatch_generation, dispatch_reservation_token, dispatch_reserved_at,
            dispatched_at, dispatch_task_name, delivered_at,
            dispatch_workload_role, dispatch_contract_version,
            claim_workload_role, claim_contract_version,
            lease_token, lease_expires_at, created_at, updated_at
        ) VALUES (
            $1, $2, $3, $4, $5, 1, $6::UUID, $7::TIMESTAMPTZ,
            $8::TIMESTAMPTZ, $9, $10::TIMESTAMPTZ,
            $11, $12::SMALLINT, $13, $14::SMALLINT,
            $15::UUID, $16::TIMESTAMPTZ, $17::TIMESTAMPTZ, $18::TIMESTAMPTZ
        )`,
        [
            requestId,
            jobKey,
            'a'.repeat(64),
            options.jobStatus ?? (options.jobLease === 'expired' ? 'processing' : 'pending'),
            options.jobDispatchState ?? 'delivered',
            dispatchReservationToken,
            dispatchReservedAt,
            dispatchedAt,
            `analysis-v2-${index}`,
            deliveredAt,
            options.jobWorkloadRole ?? null,
            options.jobDispatchContractVersion ?? null,
            options.jobClaimWorkloadRole ?? null,
            options.jobClaimContractVersion ?? null,
            jobLeaseToken,
            jobLeaseExpiry,
            '2026-07-01T00:00:00.000Z',
            updatedAt,
        ]
    );
    const providerCount = options.providerRunCount ?? 1;
    for (let runIndex = 0; runIndex < providerCount; runIndex += 1) {
        const operationKey = runIndex === 0
            ? `target-profile:${'b'.repeat(64)}`
            : `target-profile:${String(runIndex).padStart(2, '0')}${'b'.repeat(62)}`;
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, input_hash,
                logical_provider, credential_slot, max_charge_usd, status,
                run_id, run_started_at, terminalized_at, actual_usage_usd,
                usage_reconciled_at, manual_resolution_kind,
                manual_resolution_evidence_hash, manual_resolved_at
            ) VALUES (
                $1, $2, $3, $4, 'apify', 'tertiary', 0.0026, $5,
                $6, '2026-07-01T00:03:00.000Z', '2026-07-01T00:04:00.000Z',
                $7::NUMERIC, $8::TIMESTAMPTZ, $9, $10, $11::TIMESTAMPTZ
            )`,
            [
                requestId,
                jobKey,
                operationKey,
                'a'.repeat(64),
                options.providerStatus ?? 'succeeded',
                `Run${String(index).padStart(8, '0')}${runIndex}`,
                options.providerReconciled === false ? null : 0.0026,
                options.providerReconciled === false ? null : '2026-07-01T00:05:00.000Z',
                runIndex === 0 ? (options.manualKind === undefined ? 'conservative_max_charge' : options.manualKind) : null,
                runIndex === 0 ? (options.manualEvidence === undefined ? MANUAL_HASH : options.manualEvidence) : null,
                runIndex === 0 && options.manualKind !== null ? '2026-07-01T00:05:00.000Z' : null,
            ]
        );
    }
    if (options.extraRejectedProviderRun) {
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, input_hash,
                logical_provider, credential_slot, max_charge_usd, status,
                run_id, run_started_at, terminalized_at, actual_usage_usd,
                usage_reconciled_at, manual_resolution_kind,
                manual_resolution_evidence_hash, manual_resolved_at
            ) VALUES (
                $1, $2, $3, $4, 'apify', 'tertiary', 0.0026, 'rejected',
                NULL, NULL, '2026-07-01T00:06:00.000Z', 0,
                '2026-07-01T00:07:00.000Z', NULL, NULL, NULL
            )`,
            [
                requestId,
                jobKey,
                `target-profile:${'e'.repeat(64)}`,
                'a'.repeat(64),
            ]
        );
    }
    if (options.admission !== 'none' && options.admission !== undefined) {
        await db.query(
            `INSERT INTO public.analysis_provider_admission_leases(
                admission_id, request_id, job_key, state, expires_at
            ) VALUES ($1, $2, $3, 'leased', $4::TIMESTAMPTZ)`,
            [UUID(index + 400), requestId, jobKey, options.admission === 'live' ? '2099-01-01T00:00:00.000Z' : '2026-07-02T00:00:00.000Z']
        );
    }
    if (options.aiAttempt !== 'none' && options.aiAttempt !== undefined) {
        await db.query(
            `INSERT INTO public.analysis_v2_ai_attempts(request_id, job_key, status)
             VALUES ($1, $2, $3)`,
            [requestId, jobKey, options.aiAttempt]
        );
    }
    if (options.geminiLease) {
        await db.query(
            `INSERT INTO public.analysis_v2_gemini_leases(request_id, job_key, state)
             VALUES ($1, $2, 'leased')`,
            [requestId, jobKey]
        );
    }
    if (options.budgetReservation) {
        await db.query(
            `INSERT INTO public.vertex_ai_budget_reservations(reservation_key, run_id, state)
             VALUES ($1, $2, 'reserved')`,
            [`budget:${index}`, requestId]
        );
    }
    if (options.revenueChild) {
        await db.query(
            `INSERT INTO public.analysis_revenue_cost_operations(request_id, source_job_key, status)
             VALUES ($1, $2, 'started')`,
            [requestId, jobKey]
        );
    }
    if (options.cleanupIntent) {
        await db.query(
            `INSERT INTO public.analysis_v2_provider_cleanup_intents(request_id, failed_job_key, completed_at)
             VALUES ($1, $2, NULL)`,
            [requestId, jobKey]
        );
    }
    if (options.schedulerClaim) {
        await db.query(
            `INSERT INTO public.analysis_v2_scheduler_operations(request_id, job_key, status, completed_at)
             VALUES ($1, $2, 'claimed', NULL)`,
            [requestId, jobKey]
        );
    }
}

describe('V2 historical legacy-dispatch terminalizer', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE SCHEMA extensions;
            CREATE FUNCTION extensions.gen_random_uuid()
            RETURNS UUID LANGUAGE SQL VOLATILE AS $$ SELECT pg_catalog.gen_random_uuid() $$;
            CREATE TABLE public.analysis_requests (
                id UUID PRIMARY KEY,
                pipeline_version TEXT NOT NULL,
                status TEXT NOT NULL,
                processing_lease_token UUID,
                processing_lease_expires_at TIMESTAMPTZ
            );
            CREATE TABLE public.analysis_pipeline_jobs (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                input_hash TEXT NOT NULL,
                status TEXT NOT NULL,
                dispatch_state TEXT NOT NULL,
                dispatch_generation INTEGER NOT NULL,
                dispatch_reservation_token UUID,
                dispatch_reserved_at TIMESTAMPTZ,
                dispatched_at TIMESTAMPTZ,
                dispatch_task_name TEXT,
                delivered_at TIMESTAMPTZ,
                dispatch_workload_role TEXT,
                dispatch_contract_version SMALLINT,
                claim_workload_role TEXT,
                claim_contract_version SMALLINT,
                lease_token UUID,
                lease_expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                completed_at TIMESTAMPTZ,
                last_error_code TEXT,
                last_error_at TIMESTAMPTZ,
                PRIMARY KEY (request_id, job_key)
            );
            CREATE TABLE public.analysis_v2_provider_runs (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                operation_key TEXT NOT NULL,
                input_hash TEXT NOT NULL,
                logical_provider TEXT NOT NULL,
                credential_slot TEXT NOT NULL,
                max_charge_usd NUMERIC NOT NULL,
                status TEXT NOT NULL,
                run_id TEXT,
                run_started_at TIMESTAMPTZ,
                terminalized_at TIMESTAMPTZ,
                actual_usage_usd NUMERIC,
                usage_reconciled_at TIMESTAMPTZ,
                manual_resolution_kind TEXT,
                manual_resolution_evidence_hash TEXT,
                manual_resolved_at TIMESTAMPTZ,
                PRIMARY KEY (request_id, job_key, operation_key)
            );
            CREATE TABLE public.analysis_provider_admission_leases (
                admission_id TEXT PRIMARY KEY,
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                state TEXT NOT NULL,
                expires_at TIMESTAMPTZ
            );
            CREATE TABLE public.analysis_v2_ai_attempts (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                status TEXT NOT NULL
            );
            CREATE TABLE public.analysis_v2_gemini_leases (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                state TEXT NOT NULL
            );
            CREATE TABLE public.vertex_ai_budget_reservations (
                reservation_key TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                state TEXT NOT NULL
            );
            CREATE TABLE public.analysis_revenue_cost_operations (
                request_id UUID NOT NULL,
                source_job_key TEXT NOT NULL,
                status TEXT NOT NULL
            );
            CREATE TABLE public.analysis_v2_provider_cleanup_intents (
                request_id UUID NOT NULL,
                failed_job_key TEXT NOT NULL,
                completed_at TIMESTAMPTZ
            );
            CREATE TABLE public.analysis_v2_scheduler_operations (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                status TEXT NOT NULL,
                completed_at TIMESTAMPTZ
            );
        `);
        await db.exec(migration);
    });

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE public.analysis_v2_historical_legacy_dispatch_terminalization_receipts,
                public.analysis_v2_scheduler_operations,
                public.analysis_v2_provider_cleanup_intents,
                public.analysis_revenue_cost_operations,
                public.vertex_ai_budget_reservations,
                public.analysis_v2_gemini_leases,
                public.analysis_v2_ai_attempts,
                public.analysis_provider_admission_leases,
                public.analysis_v2_provider_runs,
                public.analysis_pipeline_jobs,
                public.analysis_requests;
            RESET ROLE;
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    it('lists only exact safe historical candidates and readiness drops after resolution', async () => {
        for (let index = 1; index <= 5; index += 1) await seedCandidate(index);
        await seedCandidate(20, { age: 'young' });
        await seedCandidate(21, { jobWorkloadRole: 'paid', jobDispatchContractVersion: 2 });
        expect(await listCandidates(64)).toHaveLength(5);
        expect(await listCandidates(3)).toHaveLength(3);
        const readinessBefore = await db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count FROM public.analysis_pipeline_jobs
             WHERE status IN ('pending', 'processing')
               AND dispatch_state IN ('reserved', 'enqueued', 'delivered')
               AND (dispatch_workload_role IS NULL OR dispatch_contract_version IS NULL)`
        );
        expect(readinessBefore.rows[0].count).toBe(6);
        for (const candidate of await listCandidates(64)) await resolve(candidate);
        expect(await listCandidates()).toHaveLength(0);
        const readinessAfter = await db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count FROM public.analysis_pipeline_jobs
             WHERE status IN ('pending', 'processing')
               AND dispatch_state IN ('reserved', 'enqueued', 'delivered')
               AND (dispatch_workload_role IS NULL OR dispatch_contract_version IS NULL)`
        );
        expect(readinessAfter.rows[0].count).toBe(1);
    });

    it('keeps all five jobs eligible with an extra reconciled rejected provider row', async () => {
        await seedCandidate(1, { extraRejectedProviderRun: true });
        for (let index = 2; index <= 5; index += 1) await seedCandidate(index);
        expect(await listCandidates()).toHaveLength(5);
        expect((await db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count
             FROM public.analysis_v2_provider_runs
             WHERE request_id = $1`,
            [UUID(1)]
        )).rows[0].count).toBe(2);
        expect((await db.query<{ run_id: string | null; run_started_at: string | null; actual_usage_usd: string }>(
            `SELECT run_id, run_started_at, actual_usage_usd::TEXT
             FROM public.analysis_v2_provider_runs
             WHERE request_id = $1 AND status = 'rejected'`,
            [UUID(1)]
        )).rows[0]).toEqual({ run_id: null, run_started_at: null, actual_usage_usd: '0' });
    });

    it('terminalizes pending and expired processing jobs without changing request/provider/dispatch evidence', async () => {
        await seedCandidate(1);
        const pending = (await listCandidates())[0];
        const pendingBefore = (await db.query<Record<string, unknown>>(
            `SELECT * FROM public.analysis_pipeline_jobs WHERE request_id = $1`, [pending.requestId]
        )).rows[0];
        const providerBefore = (await db.query<Record<string, unknown>>(
            `SELECT * FROM public.analysis_v2_provider_runs WHERE request_id = $1`, [pending.requestId]
        )).rows[0];
        const requestBefore = (await db.query<Record<string, unknown>>(
            `SELECT * FROM public.analysis_requests WHERE id = $1`, [pending.requestId]
        )).rows[0];
        const result = (await resolve(pending)).rows[0].result;
        expect(result).toMatchObject({ status: 'failed', errorCode: 'HISTORICAL_LEGACY_DISPATCH_TERMINALIZED', replayed: false });
        const pendingAfter = (await db.query<Record<string, unknown>>(
            `SELECT * FROM public.analysis_pipeline_jobs WHERE request_id = $1`, [pending.requestId]
        )).rows[0];
        expect(pendingAfter).toMatchObject({
            input_hash: pendingBefore.input_hash,
            dispatch_state: pendingBefore.dispatch_state,
            dispatch_generation: pendingBefore.dispatch_generation,
            dispatch_reservation_token: pendingBefore.dispatch_reservation_token,
            dispatch_reserved_at: pendingBefore.dispatch_reserved_at,
            dispatched_at: pendingBefore.dispatched_at,
            dispatch_task_name: pendingBefore.dispatch_task_name,
            delivered_at: pendingBefore.delivered_at,
            status: 'failed',
            lease_token: null,
            lease_expires_at: null,
            last_error_code: 'HISTORICAL_LEGACY_DISPATCH_TERMINALIZED',
        });
        expect(pendingAfter.updated_at).not.toBe(pendingBefore.updated_at);
        expect((await db.query<Record<string, unknown>>(
            `SELECT * FROM public.analysis_v2_provider_runs WHERE request_id = $1`, [pending.requestId]
        )).rows[0]).toEqual(providerBefore);
        expect((await db.query<Record<string, unknown>>(
            `SELECT * FROM public.analysis_requests WHERE id = $1`, [pending.requestId]
        )).rows[0]).toEqual(requestBefore);

        await seedCandidate(2, { jobLease: 'expired' });
        const processing = (await listCandidates()).find((row) => row.requestId === UUID(2));
        expect(processing?.priorStatus).toBe('processing');
        expect((await resolve(processing!)).rows[0].result.status).toBe('failed');
    });

    it('allows an expired admission lease and supports the bounded cancelled transition', async () => {
        await seedCandidate(30, { admission: 'expired' });
        const candidate = (await listCandidates())[0];
        expect((await resolve(candidate, {}, 'cancelled')).rows[0].result).toMatchObject({
            status: 'cancelled',
            errorCode: 'HISTORICAL_LEGACY_DISPATCH_TERMINALIZED',
            replayed: false,
        });
        expect((await db.query<{ status: string; last_error_code: string }>(
            `SELECT status, last_error_code FROM public.analysis_pipeline_jobs WHERE request_id = $1`,
            [candidate.requestId]
        )).rows[0]).toEqual({ status: 'cancelled', last_error_code: 'HISTORICAL_LEGACY_DISPATCH_TERMINALIZED' });
    });

    it('allows zero, one, and multiple terminal reconciled provider rows', async () => {
        await seedCandidate(40, { providerRunCount: 0 });
        await seedCandidate(41, { providerRunCount: 1, manualKind: null, manualEvidence: null });
        await seedCandidate(42, { providerRunCount: 2, manualKind: null, manualEvidence: null });
        await seedCandidate(43, { providerRunCount: 2 });
        const candidates = await listCandidates();
        expect(candidates).toHaveLength(4);
        expect(candidates.find((candidate) => candidate.requestId === UUID(40))).toMatchObject({
            manualResolutionOperationKey: null,
            manualResolutionEvidenceHash: null,
        });
        expect(candidates.find((candidate) => candidate.requestId === UUID(41))).toMatchObject({
            manualResolutionOperationKey: null,
            manualResolutionEvidenceHash: null,
        });
        expect(candidates.find((candidate) => candidate.requestId === UUID(42))).toMatchObject({
            manualResolutionOperationKey: null,
            manualResolutionEvidenceHash: null,
        });
        expect(candidates.find((candidate) => candidate.requestId === UUID(43))).toMatchObject({
            manualResolutionOperationKey: `target-profile:${'b'.repeat(64)}`,
            manualResolutionEvidenceHash: MANUAL_HASH,
        });
        for (const candidate of candidates) {
            expect((await resolve(candidate)).rows[0].result.replayed).toBe(false);
        }
        expect(await listCandidates()).toHaveLength(0);
    });

    it('rejects a multiple-row set when any provider row is still active', async () => {
        await seedCandidate(44, { providerRunCount: 2 });
        await db.query(
            `UPDATE public.analysis_v2_provider_runs
             SET status = 'running'
             WHERE request_id = $1
               AND operation_key <> $2`,
            [UUID(44), `target-profile:${'b'.repeat(64)}`]
        );
        expect(await listCandidates()).toHaveLength(0);
    });

    it.each([
        ['request pipeline', { requestPipeline: 'v1' }],
        ['request status', { requestStatus: 'processing' }],
        ['live request lease', { requestLease: 'live' }],
        ['legacy dispatch state', { jobDispatchState: 'enqueued' }],
        ['roleful dispatch provenance', { jobWorkloadRole: 'paid', jobDispatchContractVersion: 2 }],
        ['partial dispatch provenance', { jobWorkloadRole: null, jobDispatchContractVersion: 2 }],
        ['completed job', { jobStatus: 'completed' }],
        ['live job lease', { jobLease: 'live', jobStatus: 'processing' }],
        ['malformed processing lease', { jobLease: 'malformed', jobStatus: 'processing' }],
        ['young job', { age: 'young' }],
        ['starting provider run', { providerStatus: 'starting' }],
        ['unreconciled provider usage', { providerReconciled: false }],
        ['missing manual evidence', { manualEvidence: null }],
        ['manual kind mismatch', { manualKind: 'other' }],
        ['multiple provider rows with an active row', { providerRunCount: 2, providerStatus: 'starting' }],
        ['live admission', { admission: 'live' }],
        ['reserved AI attempt', { aiAttempt: 'reserved' }],
        ['ambiguous AI attempt', { aiAttempt: 'ambiguous' }],
        ['generation lease', { geminiLease: true }],
        ['budget reservation', { budgetReservation: true }],
        ['active revenue child', { revenueChild: true }],
        ['unresolved cleanup intent', { cleanupIntent: true }],
        ['current queue ownership', { schedulerClaim: true }],
    ] as const)('excludes %s', async (_label, options) => {
        await seedCandidate(1, options);
        expect(await listCandidates()).toHaveLength(0);
    });

    it('is owner-only, idempotent, immutable, and concurrency-safe', async () => {
        await seedCandidate(1);
        const candidate = (await listCandidates())[0];
        const [first, second] = await Promise.all([
            resolve(candidate),
            resolve(candidate),
        ]);
        const results = [first.rows[0].result, second.rows[0].result];
        expect(results.filter((result) => result.replayed)).toHaveLength(1);
        expect(results.filter((result) => !result.replayed)).toHaveLength(1);
        expect((await db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count FROM public.analysis_v2_historical_legacy_dispatch_terminalization_receipts`
        )).rows[0].count).toBe(1);
        expect((await resolve(candidate)).rows[0].result.replayed).toBe(true);
        await expect(resolve(candidate, {}, 'failed', 'e'.repeat(64)))
            .rejects.toThrow(/HISTORICAL_LEGACY_DISPATCH.*CONFLICT/);
        await db.exec('SET ROLE service_role');
        await expect(listCandidates()).rejects.toThrow(/permission denied/i);
        await expect(resolve(candidate)).rejects.toThrow(/permission denied/i);
        await db.exec('RESET ROLE');
        await expect(db.exec(
            `UPDATE public.analysis_v2_historical_legacy_dispatch_terminalization_receipts
             SET audit_evidence_hash = '${'e'.repeat(64)}'`
        )).rejects.toThrow(/RECEIPT_IMMUTABLE/);
        await expect(db.exec(
            `DELETE FROM public.analysis_v2_historical_legacy_dispatch_terminalization_receipts`
        )).rejects.toThrow(/RECEIPT_IMMUTABLE/);
    });
});
