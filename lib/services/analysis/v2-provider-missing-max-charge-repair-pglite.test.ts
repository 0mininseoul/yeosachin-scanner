import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260903020000_add_analysis_v2_conservative_max_charge_resolution.sql',
        import.meta.url
    ),
    'utf8'
);

type Candidate = {
    requestId: string;
    jobKey: string;
    operationKey: string;
    inputHash: string;
    jobClaimToken: string;
    reservationToken: string;
    runId: string;
    logicalProvider: string;
    actorId: string;
    credentialSlot: string;
    maxChargeUsd: number;
    reservedAt: string;
    runStartedAt: string;
    terminalizedAt: string;
    status: string;
};

type ResolvePayload = {
    manualResolutionKind: string;
    actualUsageUsd: number;
    revenueCostSettlement: string;
    replayed: boolean;
    [key: string]: unknown;
};

const EVIDENCE_HASH = 'c'.repeat(64);
let db: PGlite;

const UUID = (index: number): string =>
    `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

async function listCandidates(limit = 64): Promise<Candidate[]> {
    const result = await db.query<{ candidates: Candidate[] }>(
        `SELECT public.list_analysis_v2_conservative_max_charge_candidates($1) AS candidates`,
        [limit]
    );
    return result.rows[0].candidates;
}

async function resolve(candidate: Candidate, evidenceHash = EVIDENCE_HASH) {
    return db.query<{ result: ResolvePayload }>(
        `SELECT public.resolve_analysis_v2_provider_run_conservative_max_charge(
            $1::UUID, $2::TEXT, $3::TEXT, $4::TEXT, $5::UUID, $6::UUID,
            $7::TEXT, $8::TEXT, $9::TEXT, $10::TEXT, $11::NUMERIC,
            $12::TIMESTAMPTZ, $13::TIMESTAMPTZ, $14::TIMESTAMPTZ,
            $15::TEXT, $16::TEXT, $17::TEXT
        ) AS result`,
        [
            candidate.requestId,
            candidate.jobKey,
            candidate.operationKey,
            candidate.inputHash,
            candidate.jobClaimToken,
            candidate.reservationToken,
            candidate.runId,
            candidate.logicalProvider,
            candidate.actorId,
            candidate.credentialSlot,
            candidate.maxChargeUsd,
            candidate.reservedAt,
            candidate.runStartedAt,
            candidate.terminalizedAt,
            candidate.status,
            'conservative_max_charge',
            evidenceHash,
        ]
    );
}

async function seedCandidate(index: number, options: {
    terminalAge?: string;
    liveJobLease?: boolean;
    liveRequestLease?: boolean;
    provider?: string;
    credentialSlot?: string;
} = {}): Promise<void> {
    const requestId = UUID(index);
    const jobKey = `track:profiles:batch:${index}`;
    const operationKey = `target-profile:${'a'.repeat(63)}${index % 10}`;
    await db.query(
        `INSERT INTO public.analysis_requests(
            id, pipeline_version, processing_lease_token, processing_lease_expires_at
        ) VALUES ($1, 'v2', $2::UUID, $3::TIMESTAMPTZ)`,
        [
            requestId,
            options.liveRequestLease ? UUID(index + 100) : null,
            options.liveRequestLease ? '2099-01-01T00:00:00.000Z' : null,
        ]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs(
            request_id, job_key, lease_token, lease_expires_at
        ) VALUES ($1, $2, $3::UUID, $4::TIMESTAMPTZ)`,
        [
            requestId,
            jobKey,
            options.liveJobLease ? UUID(index + 200) : null,
            options.liveJobLease ? '2099-01-01T00:00:00.000Z' : null,
        ]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_provider_runs(
            request_id, job_key, operation_key, input_hash, job_claim_token,
            reservation_token, logical_provider, actor_id, credential_slot,
            max_charge_usd, status, run_id, reserved_at, run_started_at,
            terminalized_at, usage_reconciled_at, updated_at
        ) VALUES (
            $1, $2, $3, $4, $5::UUID, $6::UUID, $7, 'apify/instagram-profile-scraper',
            $8, 0.0026, 'succeeded', $9,
            pg_catalog.clock_timestamp() - INTERVAL '8 days',
            pg_catalog.clock_timestamp() - INTERVAL '8 days' + INTERVAL '1 minute',
            pg_catalog.clock_timestamp() - ($10::TEXT)::INTERVAL + INTERVAL '2 minutes',
            NULL, pg_catalog.clock_timestamp()
        )`,
        [
            requestId,
            jobKey,
            operationKey,
            'b'.repeat(64),
            UUID(index + 300),
            UUID(index + 400),
            options.provider ?? 'apify',
            options.credentialSlot ?? 'tertiary',
            `run-${String(index).padStart(8, '0')}`,
            options.terminalAge ?? '8 days',
        ]
    );
}

describe('V2 provider missing max-charge repair', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE SCHEMA extensions;
            CREATE FUNCTION extensions.digest(data BYTEA, type TEXT)
            RETURNS BYTEA LANGUAGE SQL IMMUTABLE AS $$
                SELECT decode(md5(encode(data, 'hex')), 'hex')
            $$;
            CREATE TABLE public.analysis_requests (
                id UUID PRIMARY KEY,
                pipeline_version TEXT NOT NULL,
                processing_lease_token UUID,
                processing_lease_expires_at TIMESTAMPTZ
            );
            CREATE TABLE public.analysis_pipeline_jobs (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                lease_token UUID,
                lease_expires_at TIMESTAMPTZ,
                PRIMARY KEY(request_id, job_key)
            );
            CREATE TABLE public.analysis_v2_provider_runs (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                operation_key TEXT NOT NULL,
                input_hash TEXT NOT NULL,
                job_claim_token UUID NOT NULL,
                reservation_token UUID NOT NULL,
                logical_provider TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                credential_slot TEXT NOT NULL,
                max_charge_usd NUMERIC NOT NULL,
                status TEXT NOT NULL,
                run_id TEXT,
                actual_usage_usd NUMERIC,
                reserved_at TIMESTAMPTZ NOT NULL,
                run_started_at TIMESTAMPTZ,
                terminalized_at TIMESTAMPTZ,
                usage_reconciled_at TIMESTAMPTZ,
                updated_at TIMESTAMPTZ NOT NULL,
                usage_reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0,
                usage_reconciliation_attempted_at TIMESTAMPTZ,
                PRIMARY KEY(request_id, job_key, operation_key)
            );
            CREATE TABLE public.analysis_provider_admission_leases (
                admission_id TEXT PRIMARY KEY,
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                operation_key TEXT NOT NULL,
                logical_provider TEXT NOT NULL,
                credential_slot TEXT NOT NULL,
                state TEXT NOT NULL,
                expires_at TIMESTAMPTZ
            );
            CREATE TABLE public.analysis_revenue_cost_operations (
                id BIGSERIAL PRIMARY KEY,
                request_id UUID NOT NULL,
                owner_kind TEXT NOT NULL,
                source_job_key TEXT NOT NULL,
                source_operation_key_hash TEXT NOT NULL,
                source_attempt SMALLINT NOT NULL,
                status TEXT NOT NULL,
                economic_actual_usd NUMERIC,
                billed_actual_usd NUMERIC,
                economic_actual_krw INTEGER,
                billed_actual_krw INTEGER,
                started_at TIMESTAMPTZ,
                terminal_at TIMESTAMPTZ
            );
            CREATE FUNCTION public.analysis_v2_valid_provider_operation_key(value TEXT)
            RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
                SELECT value ~ '^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[0-9a-f]{64}$'
            $$;
            CREATE FUNCTION public.settle_analysis_revenue_cost_operation_v2(
                p_request_id UUID, p_job_key TEXT, p_source_kind TEXT,
                p_source_operation_key TEXT, p_source_attempt SMALLINT
            ) RETURNS JSONB LANGUAGE plpgsql AS $$
            DECLARE
                v_hash TEXT;
            BEGIN
                v_hash := encode(extensions.digest(convert_to(p_source_operation_key, 'UTF8'), 'sha256'), 'hex');
                UPDATE public.analysis_revenue_cost_operations
                SET status = 'settled'
                WHERE request_id = p_request_id AND owner_kind = p_source_kind
                  AND source_job_key = p_job_key AND source_operation_key_hash = v_hash
                  AND source_attempt = p_source_attempt;
                RETURN jsonb_build_object('disposition', 'settled');
            END;
            $$;
        `);
        await db.exec(migration);
    });

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE public.analysis_revenue_cost_operations,
                public.analysis_provider_admission_leases,
                public.analysis_v2_provider_runs,
                public.analysis_pipeline_jobs,
                public.analysis_requests;
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    it('lists exactly the five authoritative rows behind the seven-day fence', async () => {
        for (let index = 1; index <= 5; index += 1) await seedCandidate(index);
        await seedCandidate(20, { terminalAge: '6 days 23 hours' });
        await seedCandidate(21, { liveJobLease: true });
        expect(await listCandidates(6)).toHaveLength(5);
    });

    it('fills only conservative accounting metadata and leaves provider truth untouched', async () => {
        await seedCandidate(1);
        const candidate = (await listCandidates(6))[0];
        const first = await resolve(candidate);
        expect(first.rows[0].result).toMatchObject({
            manualResolutionKind: 'conservative_max_charge',
            actualUsageUsd: 0.0026,
            revenueCostSettlement: 'absent',
            replayed: false,
        });
        const row = (await db.query<{
            status: string;
            run_id: string;
            actual_usage_usd: string;
            manual_resolution_kind: string;
            manual_resolution_evidence_hash: string;
        }>(`SELECT status, run_id, actual_usage_usd, manual_resolution_kind,
                    manual_resolution_evidence_hash
             FROM public.analysis_v2_provider_runs`)).rows[0];
        expect(row).toMatchObject({
            status: 'succeeded',
            run_id: 'run-00000001',
            actual_usage_usd: '0.0026',
            manual_resolution_kind: 'conservative_max_charge',
            manual_resolution_evidence_hash: EVIDENCE_HASH,
        });
        expect(await listCandidates()).toHaveLength(0);
        expect((await db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count FROM public.analysis_revenue_cost_operations`
        )).rows[0].count).toBe(0);
    });

    it('replays the exact resolution, rejects drift, and settles an exact active child', async () => {
        await seedCandidate(1);
        const candidate = (await listCandidates())[0];
        const first = (await resolve(candidate)).rows[0].result;
        const replay = (await resolve(candidate)).rows[0].result;
        expect(replay).toEqual({ ...first, replayed: true });
        await expect(resolve(candidate, 'd'.repeat(64))).rejects.toThrow(/CONSERVATIVE_RESOLUTION_CONFLICT/);

        await seedCandidate(2);
        const childCandidate = (await listCandidates())[0];
        const childHash = (await db.query<{ hash: string }>(
            `SELECT encode(extensions.digest(convert_to($1, 'UTF8'), 'sha256'), 'hex') AS hash`,
            [childCandidate.operationKey]
        )).rows[0].hash;
        await db.query(
            `INSERT INTO public.analysis_revenue_cost_operations(
                request_id, owner_kind, source_job_key, source_operation_key_hash,
                source_attempt, status
            ) VALUES ($1, 'provider_run', $2, $3, 0, 'reserved')`,
            [childCandidate.requestId, childCandidate.jobKey, childHash]
        );
        const firstChildResult = (await resolve(childCandidate)).rows[0].result;
        expect(firstChildResult).toMatchObject({
            revenueCostSettlement: 'settled',
        });
        expect((await resolve(childCandidate)).rows[0].result).toEqual({
            ...firstChildResult,
            replayed: true,
        });
        expect((await db.query<{ status: string }>(
            `SELECT status FROM public.analysis_revenue_cost_operations`
        )).rows[0].status).toBe('settled');
    });

    it('prevents post-resolution drift of accounting meaning fields', async () => {
        await seedCandidate(1);
        const candidate = (await listCandidates())[0];
        await resolve(candidate);
        for (const statement of [
            `UPDATE public.analysis_v2_provider_runs SET actual_usage_usd = 0.001`,
            `UPDATE public.analysis_v2_provider_runs SET usage_reconciled_at = pg_catalog.clock_timestamp()`,
            `UPDATE public.analysis_v2_provider_runs SET max_charge_usd = 0.001`,
            `UPDATE public.analysis_v2_provider_runs SET input_hash = '${'d'.repeat(64)}'`,
            `UPDATE public.analysis_v2_provider_runs SET actor_id = 'apify/other-actor'`,
            `UPDATE public.analysis_v2_provider_runs SET reserved_at = pg_catalog.clock_timestamp()`,
        ]) {
            await expect(db.exec(statement)).rejects.toThrow(/MANUAL_RESOLUTION_IMMUTABLE/);
        }
    });

    it('serializes concurrent calls into one accounting write and fails closed on live leases', async () => {
        await seedCandidate(1);
        const candidate = (await listCandidates())[0];
        const outcomes = await Promise.allSettled([resolve(candidate), resolve(candidate)]);
        expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
        expect((await db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count FROM public.analysis_v2_provider_runs
             WHERE actual_usage_usd = max_charge_usd`
        )).rows[0].count).toBe(1);

        await seedCandidate(2, { liveRequestLease: true });
        const liveCandidate = {
            ...(await db.query<Candidate>(
                `SELECT request_id AS "requestId", job_key AS "jobKey",
                        operation_key AS "operationKey", input_hash AS "inputHash",
                        job_claim_token AS "jobClaimToken", reservation_token AS "reservationToken",
                        run_id AS "runId", logical_provider AS "logicalProvider", actor_id AS "actorId",
                        credential_slot AS "credentialSlot", max_charge_usd AS "maxChargeUsd",
                        reserved_at AS "reservedAt", run_started_at AS "runStartedAt",
                        terminalized_at AS "terminalizedAt", status
                 FROM public.analysis_v2_provider_runs WHERE request_id = $1`,
                [UUID(2)]
            )).rows[0],
        };
        await expect(resolve(liveCandidate)).rejects.toThrow(/CONSERVATIVE_RESOLUTION_NOT_READY/);
    });

    it('denies the owner-only candidate and resolver functions to service_role', async () => {
        await db.exec('SET ROLE service_role');
        try {
            await expect(listCandidates()).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });
});
