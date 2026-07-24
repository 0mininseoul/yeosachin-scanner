import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123200_add_analysis_v2_gemini_leases.sql',
        import.meta.url
    ),
    'utf8'
);
const REQUEST = '123e4567-e89b-42d3-a456-426614174000';
const CLAIM = '223e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow

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

async function acquire(input: {
    requestId?: string;
    jobKey?: string;
    attempt?: number;
    claimToken?: string;
} = {}): Promise<AcquireRow> {
    return (await asService<AcquireRow>(
        `SELECT * FROM public.acquire_analysis_v2_gemini_lease(
            $1, $2, $3, $4, 240
        )`,
        [
            input.requestId ?? REQUEST,
            input.jobKey ?? 'track:profile-ai:batch:0',
            input.attempt ?? 1,
            input.claimToken ?? CLAIM,
        ]
    )).rows[0];
}

describe('deployment-wide Gemini lease migration', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE TABLE public.analysis_requests (
                id UUID PRIMARY KEY,
                pipeline_version TEXT NOT NULL,
                status TEXT NOT NULL
            );
            CREATE TABLE public.analysis_preflights (
                consumed_request_id UUID
            );
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
        await db.exec(migration);
    });

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE public.analysis_pipeline_jobs,
                public.analysis_preflights,
                public.analysis_requests;
            UPDATE public.analysis_v2_gemini_leases
            SET state = 'available',
                fence = 0,
                request_id = NULL,
                job_key = NULL,
                attempt = NULL,
                lease_claim_token = NULL,
                acquired_at = NULL,
                expires_at = NULL,
                quarantined_at = NULL,
                resolution_evidence_hash = NULL,
                resolved_at = NULL;
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    it('seeds exactly eight slots and reports deployment-wide capacity', async () => {
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_gemini_leases`
        )).rows[0].count).toBe(8);

        const leases: AcquireRow[] = [];
        for (let index = 1; index <= 8; index += 1) {
            leases.push(await acquire({
                requestId: `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`,
                jobKey: `track:profile-ai:batch:${index}`,
                claimToken: `223e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`,
            }));
        }
        expect(leases.map(lease => lease.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        await expect(acquire({
            requestId: '123e4567-e89b-42d3-a456-426614174099',
            claimToken: '223e4567-e89b-42d3-a456-426614174099',
        })).resolves.toMatchObject({
            outcome: 'capacity_pending',
            slot: null,
        });
    });

    it('replays an exact acquisition and increments the fence only after release', async () => {
        const first = await acquire();
        const replay = await acquire();
        expect(replay).toEqual(first);

        const released = (await asService<{
            released: boolean;
            lease_state: string;
            fence: number;
        }>(
            `SELECT * FROM public.release_analysis_v2_gemini_lease(
                $1, $2, $3
            )`,
            [first.slot, CLAIM, first.fence]
        )).rows[0];
        expect(released).toEqual({
            released: true,
            lease_state: 'available',
            fence: 1,
        });
        const next = await acquire({
            requestId: '123e4567-e89b-42d3-a456-426614174001',
            claimToken: '223e4567-e89b-42d3-a456-426614174001',
        });
        expect(next).toMatchObject({ slot: 1, fence: 2 });
    });

    it('quarantines a conflicting acquisition instead of allocating twice', async () => {
        const first = await acquire();
        const conflict = await acquire({
            claimToken: '223e4567-e89b-42d3-a456-426614174001',
        });
        expect(conflict).toMatchObject({
            outcome: 'quarantine_active',
            slot: first.slot,
            fence: first.fence,
        });
        expect((await db.query<{ state: string }>(
            `SELECT state FROM public.analysis_v2_gemini_leases WHERE slot = $1`,
            [first.slot]
        )).rows[0].state).toBe('quarantined');
    });

    it('rejects stale renewal and release without freeing the current owner', async () => {
        const lease = await acquire();
        const renewed = (await asService<{ renewed: boolean; lease_state: string }>(
            `SELECT * FROM public.renew_analysis_v2_gemini_lease(
                $1, $2, $3, 240
            )`,
            [
                lease.slot,
                '223e4567-e89b-42d3-a456-426614174001',
                lease.fence,
            ]
        )).rows[0];
        expect(renewed).toMatchObject({ renewed: false, lease_state: 'leased' });
        const released = (await asService<{ released: boolean; lease_state: string }>(
            `SELECT * FROM public.release_analysis_v2_gemini_lease(
                $1, $2, $3
            )`,
            [lease.slot, CLAIM, Number(lease.fence) + 1]
        )).rows[0];
        expect(released).toMatchObject({ released: false, lease_state: 'leased' });
    });

    it('requires DB-owner evidence to resolve a quarantine', async () => {
        const lease = await acquire();
        await acquire({
            claimToken: '223e4567-e89b-42d3-a456-426614174001',
        });
        await db.exec('SET ROLE service_role');
        try {
            await expect(db.query(
                `SELECT public.resolve_analysis_v2_gemini_lease_quarantine(
                    $1, $2, $3
                )`,
                [lease.slot, lease.fence, 'a'.repeat(64)]
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
        await expect(db.query(
            `SELECT public.resolve_analysis_v2_gemini_lease_quarantine(
                $1, $2, $3
            )`,
            [lease.slot, lease.fence, 'a'.repeat(64)]
        )).resolves.toMatchObject({ rows: [{ resolve_analysis_v2_gemini_lease_quarantine: true }] });
        expect((await db.query<{
            state: string;
            resolution_evidence_hash: string;
        }>(
            `SELECT state, resolution_evidence_hash
             FROM public.analysis_v2_gemini_leases WHERE slot = $1`,
            [lease.slot]
        )).rows[0]).toEqual({
            state: 'available',
            resolution_evidence_hash: 'a'.repeat(64),
        });
    });

    it('returns an AI capacity claim to pending without consuming an attempt', async () => {
        await db.query(
            `INSERT INTO public.analysis_requests(id, pipeline_version, status)
             VALUES ($1, 'v2', 'processing')`,
            [REQUEST]
        );
        await db.query(
            `INSERT INTO public.analysis_preflights(consumed_request_id)
             VALUES ($1)`,
            [REQUEST]
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id, job_key, status, lease_token, lease_expires_at,
                attempt_count, first_started_at
             ) VALUES (
                $1, 'track:profile-ai:batch:0', 'processing', $2,
                pg_catalog.clock_timestamp() + INTERVAL '5 minutes',
                1, pg_catalog.clock_timestamp()
             )`,
            [REQUEST, CLAIM]
        );
        const deferred = (await asService<{
            released: boolean;
            job_status: string;
            attempt_count: number;
            request_status: string;
            ai_capacity_deferral_count: number;
        }>(
            `SELECT * FROM public.defer_analysis_v2_job_for_ai_capacity(
                $1, 'track:profile-ai:batch:0', $2,
                'ANALYSIS_V2_AI_CAPACITY_PENDING'
            )`,
            [REQUEST, CLAIM]
        )).rows[0];
        expect(deferred).toEqual({
            released: true,
            job_status: 'pending',
            attempt_count: 0,
            request_status: 'processing',
            ai_capacity_deferral_count: 1,
        });
        expect((await db.query<{
            lease_token: string | null;
            first_started_at: string | null;
        }>(
            `SELECT lease_token, first_started_at
             FROM public.analysis_pipeline_jobs
             WHERE request_id = $1`,
            [REQUEST]
        )).rows[0]).toEqual({
            lease_token: null,
            first_started_at: null,
        });
    });
});
