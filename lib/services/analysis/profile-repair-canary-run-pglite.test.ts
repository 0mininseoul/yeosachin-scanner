import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260718123000_add_profile_repair_canary_journal.sql',
        import.meta.url
    ),
    'utf8'
);

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const RESERVATION_ONE = '33333333-3333-4333-8333-333333333333';
const RESERVATION_TWO = '44444444-4444-4444-8444-444444444444';
const RUN_ONE = 'CanaryRun12345678';

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL
);

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    target_instagram_id TEXT NOT NULL,
    pipeline_version TEXT,
    status TEXT NOT NULL
);

CREATE TABLE public.analysis_v2_provider_runs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    actor_id TEXT NOT NULL,
    credential_slot TEXT NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    PRIMARY KEY (request_id, job_key, operation_key)
);
`;

interface JsonRow<T> {
    result: T;
}

interface RunJson {
    sourceRequestId: string;
    canaryVersion: string;
    repetition: number;
    credentialSlot: string;
    reservationToken: string;
    state: string;
    runId: string | null;
    successCount: number | null;
    actualUsageUsd: number | null;
    costStatus: string;
}

interface ReservationJson {
    created: boolean;
    run: RunJson;
}

let db: PGlite;

async function serviceQuery<T>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function seedSource(input: {
    status?: string;
    pipelineVersion?: string;
    target?: string;
    userId?: string;
} = {}): Promise<void> {
    await db.query(
        `INSERT INTO public.users (id, email)
         VALUES ($1, 'operator@example.test')
         ON CONFLICT (id) DO NOTHING`,
        [input.userId ?? OWNER_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_requests (
            id, user_id, target_instagram_id, pipeline_version, status
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
            SOURCE_REQUEST_ID,
            input.userId ?? OWNER_ID,
            input.target ?? '0_min._.00',
            input.pipelineVersion ?? 'v2',
            input.status ?? 'failed',
        ]
    );
    for (let index = 0; index < 8; index++) {
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, status, run_id,
                actor_id, credential_slot, max_charge_usd
             ) VALUES ($1, $2, $3, 'succeeded', $4,
                'apify/instagram-profile-scraper', 'tertiary', 0.078)`,
            [
                SOURCE_REQUEST_ID,
                `track:profiles:batch:${index}`,
                `profile-fallback:${String(index).repeat(64)}`,
                `SourceRun${String(index).padStart(8, '0')}`,
            ]
        );
    }
}

async function reserve(
    repetition = 1,
    reservationToken = RESERVATION_ONE,
    credentialSlot = 'tertiary'
): Promise<ReservationJson> {
    const result = await serviceQuery<JsonRow<ReservationJson>>(
        `SELECT public.reserve_analysis_v2_profile_repair_canary_run(
            $1, $2, $3, $4
        ) AS result`,
        [SOURCE_REQUEST_ID, repetition, credentialSlot, reservationToken]
    );
    return result.rows[0].result;
}

async function checkpointStarted(): Promise<RunJson> {
    const result = await serviceQuery<JsonRow<RunJson>>(
        `SELECT public.checkpoint_analysis_v2_profile_repair_canary_run_started(
            $1, 1, $2, $3
        ) AS result`,
        [SOURCE_REQUEST_ID, RESERVATION_ONE, RUN_ONE]
    );
    return result.rows[0].result;
}

async function terminalize(overrides: {
    state?: string;
    success?: number;
    unavailable?: number;
    incomplete?: number;
    other?: number;
    criticalRecovered?: number;
    gatePassed?: boolean;
} = {}): Promise<RunJson> {
    const success = overrides.success ?? 14;
    const unavailable = overrides.unavailable ?? 1;
    const incomplete = overrides.incomplete ?? 0;
    const other = overrides.other ?? 0;
    const result = await serviceQuery<JsonRow<RunJson>>(
        `SELECT public.terminalize_analysis_v2_profile_repair_canary_run(
            $1, 1, $2, $3, $4, 15, $5, $6, $7, $8, $9, 12000, $10
        ) AS result`,
        [
            SOURCE_REQUEST_ID,
            RESERVATION_ONE,
            RUN_ONE,
            overrides.state ?? 'succeeded',
            success,
            unavailable,
            incomplete,
            other,
            overrides.criticalRecovered ?? 1,
            overrides.gatePassed ?? true,
        ]
    );
    return result.rows[0].result;
}

async function reconcile(actualUsageUsd = '0.040000000000'): Promise<RunJson> {
    const result = await serviceQuery<JsonRow<RunJson>>(
        `SELECT public.reconcile_analysis_v2_profile_repair_canary_run_usage(
            $1, 1, $2, $3, $4
        ) AS result`,
        [SOURCE_REQUEST_ID, RESERVATION_ONE, RUN_ONE, actualUsageUsd]
    );
    return result.rows[0].result;
}

describe('profile repair canary journal PGlite contract', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(bootstrap);
        await db.exec(migration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE public.analysis_v2_profile_repair_canary_runs,
                public.analysis_v2_provider_runs,
                public.analysis_requests,
                public.users
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    it('loads only an operator-authorized failed V2 source and ledger-owned runs', async () => {
        await seedSource();
        const result = await serviceQuery<JsonRow<{
            request: { sourceRequestId: string; targetInstagramId: string };
            runs: Array<{ jobKey: string; runId: string }>;
        }>>(
            `SELECT public.load_analysis_v2_profile_repair_canary_source(
                $1, $2, 'operator@example.test'
            ) AS result`,
            [SOURCE_REQUEST_ID, OWNER_ID]
        );
        expect(result.rows[0].result.request).toMatchObject({
            sourceRequestId: SOURCE_REQUEST_ID,
            targetInstagramId: '0_min._.00',
        });
        expect(result.rows[0].result.runs).toHaveLength(8);

        await expect(serviceQuery(
            `SELECT public.load_analysis_v2_profile_repair_canary_source(
                $1, $2, 'wrong@example.test'
            )`,
            [SOURCE_REQUEST_ID, OWNER_ID]
        )).rejects.toThrow('PROFILE_REPAIR_CANARY_SOURCE_NOT_FOUND');
    });

    it('reserves once, checkpoints before waiting, and never replaces the identity', async () => {
        await seedSource();
        expect(await reserve()).toMatchObject({
            created: true,
            run: {
                sourceRequestId: SOURCE_REQUEST_ID,
                canaryVersion: 'profile-repair-canary-v1',
                repetition: 1,
                credentialSlot: 'tertiary',
                reservationToken: RESERVATION_ONE,
                state: 'starting',
                runId: null,
            },
        });
        expect(await reserve()).toMatchObject({ created: false });
        await expect(reserve(1, RESERVATION_TWO, 'secondary'))
            .rejects.toThrow('PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT');
        expect(await checkpointStarted()).toMatchObject({
            state: 'running',
            runId: RUN_ONE,
        });
        expect(await checkpointStarted()).toMatchObject({
            state: 'running',
            runId: RUN_ONE,
        });
    });

    it('retains an unconfirmed reservation as ambiguous and blocks repetition two', async () => {
        await seedSource();
        await reserve();
        const ambiguous = await serviceQuery<JsonRow<RunJson>>(
            `SELECT public.mark_analysis_v2_profile_repair_canary_run_ambiguous(
                $1, 1, $2
            ) AS result`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE]
        );
        expect(ambiguous.rows[0].result).toMatchObject({
            state: 'ambiguous',
            runId: null,
            costStatus: 'unknown',
        });
        await expect(reserve(2, RESERVATION_TWO))
            .rejects.toThrow('PROFILE_REPAIR_CANARY_RUN_STATE_CONFLICT');
    });

    it('terminalizes idempotently, rejects count drift, and gates repetition two on actual cost', async () => {
        await seedSource();
        await reserve();
        await checkpointStarted();
        await expect(terminalize({
            success: 13,
            unavailable: 1,
            incomplete: 1,
            gatePassed: true,
        })).rejects.toThrow('PROFILE_REPAIR_CANARY_RUN_INVALID');
        expect(await terminalize()).toMatchObject({
            state: 'succeeded',
            successCount: 14,
            actualUsageUsd: null,
            costStatus: 'conservative',
        });
        expect(await terminalize()).toMatchObject({ state: 'succeeded' });
        await expect(terminalize({ success: 15, unavailable: 0, incomplete: 0 }))
            .rejects.toThrow('PROFILE_REPAIR_CANARY_RUN_TERMINAL_CONFLICT');
        await expect(reserve(2, RESERVATION_TWO))
            .rejects.toThrow('PROFILE_REPAIR_CANARY_RUN_STATE_CONFLICT');

        expect(await reconcile()).toMatchObject({
            actualUsageUsd: 0.04,
            costStatus: 'actual',
        });
        expect(await reconcile()).toMatchObject({ actualUsageUsd: 0.04 });
        await expect(reconcile('0.030000000000'))
            .rejects.toThrow('PROFILE_REPAIR_CANARY_RUN_RECONCILIATION_CONFLICT');
        await expect(reserve(2, RESERVATION_TWO)).resolves.toMatchObject({
            created: true,
            run: { repetition: 2, state: 'starting' },
        });
    });

    it('denies table access and every journal RPC to anon and authenticated roles', async () => {
        await seedSource();
        for (const role of ['anon', 'authenticated']) {
            await db.exec(`SET ROLE ${role}`);
            try {
                await expect(db.query(
                    'SELECT * FROM public.analysis_v2_profile_repair_canary_runs'
                )).rejects.toThrow(/permission denied/i);
                await expect(db.query(
                    `SELECT public.reserve_analysis_v2_profile_repair_canary_run(
                        $1, 1, 'tertiary', $2
                    )`,
                    [SOURCE_REQUEST_ID, RESERVATION_ONE]
                )).rejects.toThrow(/permission denied/i);
                await expect(db.query(
                    `SELECT public.load_analysis_v2_profile_repair_canary_source(
                        $1, $2, 'operator@example.test'
                    )`,
                    [SOURCE_REQUEST_ID, OWNER_ID]
                )).rejects.toThrow(/permission denied/i);
            } finally {
                await db.exec('RESET ROLE');
            }
        }
        await expect(serviceQuery(
            'SELECT * FROM public.analysis_v2_profile_repair_canary_runs'
        )).rejects.toThrow(/permission denied/i);
    });

    it('preserves the owner deletion cascade after a canary row is journaled', async () => {
        await seedSource();
        await reserve();

        await expect(db.query(
            'DELETE FROM public.users WHERE id = $1',
            [OWNER_ID]
        )).resolves.toBeDefined();
        const remaining = await db.query<{ count: number }>(`
            SELECT count(*)::INTEGER AS count
            FROM public.analysis_v2_profile_repair_canary_runs
        `);
        expect(remaining.rows[0].count).toBe(0);
    });
});
