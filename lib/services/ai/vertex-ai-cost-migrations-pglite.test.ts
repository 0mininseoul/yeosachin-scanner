import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite, type Results } from '@electric-sql/pglite';

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const budgetMigration = readFileSync(new URL(
    '20260902090000_add_vertex_ai_cost_budget_reservations.sql',
    migrationsDirectory,
), 'utf8');
const fenceMigration = readFileSync(new URL(
    '20260902091000_add_vertex_ai_cost_policy_fences.sql',
    migrationsDirectory,
), 'utf8');

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID_V24 = '55555555-5555-4555-8555-555555555555';
const CLAIM_TOKEN = '22222222-2222-4222-8222-222222222222';
const TEST_MODEL = 'gemini-3.1-flash-lite';
const ESTIMATE = 0.00175;

/**
 * This is deliberately a small representative of the current production definitions. The test
 * applies both migrations to a real PostgreSQL-compatible engine, rather than asserting SQL
 * substrings only; the fence migration must discover and rewrite these live definitions.
 */
const currentDefinitions = `
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.gen_random_uuid()
RETURNS UUID
LANGUAGE sql VOLATILE
AS $$
    SELECT (
        substr(md5(random()::text || clock_timestamp()::text), 1, 8) || '-' ||
        substr(md5(random()::text || clock_timestamp()::text), 9, 4) || '-4' ||
        substr(md5(random()::text || clock_timestamp()::text), 14, 3) || '-8' ||
        substr(md5(random()::text || clock_timestamp()::text), 18, 3) || '-' ||
        substr(md5(random()::text || clock_timestamp()::text), 21, 12)
    )::uuid
$$;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY,
    result_request_id UUID
);

CREATE TABLE public.analysis_v2_candidate_feature_rows (
    id UUID PRIMARY KEY,
    ai_stage_policy TEXT NOT NULL,
    classification_policy TEXT NOT NULL,
    CONSTRAINT analysis_v2_candidate_feature_pre_feature_admission_check CHECK (
        ai_stage_policy = ANY (ARRAY['ai-stage-policy-v2.11'])
    ),
    CONSTRAINT analysis_v2_candidate_feature_classification_check CHECK (
        classification_policy = ANY (ARRAY['ai-stage-policy-v2.11'])
    )
);

CREATE TABLE public.test_v2_policy_requests (
    id UUID PRIMARY KEY,
    policy_versions_snapshot JSONB NOT NULL
);

CREATE FUNCTION public.analysis_v2_checkpoint_candidate_features_complete(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_input_hash TEXT,
    p_expected_count INTEGER,
    p_completed_count INTEGER,
    p_features JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_features->>'aiStage' IN ('ai-stage-policy-v2.11') THEN
        RETURN TRUE;
    END IF;
    RETURN FALSE;
END;
$$;

CREATE FUNCTION public.claim_analysis_v2_scheduler_operation(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_input_hash TEXT,
    p_operation_kind TEXT,
    p_operation_id UUID,
    p_attempt INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_request RECORD;
BEGIN
    SELECT policy_versions_snapshot INTO v_request
      FROM public.test_v2_policy_requests WHERE id = p_request_id;
    IF v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.11', 'scheduler', 'ai-scheduler-v1') THEN
        RETURN TRUE;
    END IF;
    RETURN FALSE;
END;
$$;

CREATE FUNCTION public.acquire_analysis_v2_scheduler_gemini_lease_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_attempt INTEGER,
    p_claim_token UUID,
    p_lease_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_request RECORD;
BEGIN
    SELECT policy_versions_snapshot INTO v_request
      FROM public.test_v2_policy_requests WHERE id = p_request_id;
    IF FALSE OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.11', 'scheduler', 'ai-scheduler-v1') THEN
        RETURN TRUE;
    END IF;
    RETURN FALSE;
END;
$$;

CREATE FUNCTION public.analysis_v2_apply_v211_summary_tone(p_request_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    request RECORD;
BEGIN
    SELECT policy_versions_snapshot INTO request
      FROM public.test_v2_policy_requests WHERE id = p_request_id;
    IF TRUE AND request.policy_versions_snapshot->>'aiStage' = 'ai-stage-policy-v2.11' THEN
        RETURN TRUE;
    END IF;
    RETURN FALSE;
END;
$$;
`;

const v212Snapshot = {
    pipeline: 'v2',
    risk: 'risk-policy-v2.5',
    aiStage: 'ai-stage-policy-v2.12',
    scheduler: 'ai-scheduler-v1',
};
const v212RiskV24Snapshot = {
    ...v212Snapshot,
    risk: 'risk-policy-v2.4',
};

let db: PGlite;

async function query<T>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    return db.query<T>(sql, params);
}

async function asService<T>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

interface ReservationRow {
    reservation_id: string;
    reservation_key: string;
    run_id: string;
    order_id: string;
    day_key: string | Date;
    estimated_cost_usd: number;
    actual_cost_usd: number | null;
}

function dayKeyValue(value: string | Date): string {
    return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

async function reserve(
    reservationKey: string,
    options: {
        runId?: string;
        operationKey?: string;
        dayKey?: string | null;
        estimatedCost?: number;
        perRun?: number;
        perOrder?: number;
        daily?: number;
    } = {},
): Promise<ReservationRow> {
    const result = await asService<ReservationRow>(
        `SELECT * FROM public.reserve_vertex_ai_budget(
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
        )`,
        [
            reservationKey,
            options.runId ?? `run-${reservationKey}`,
            `order-${reservationKey}`,
            options.operationKey ?? 'operation-1',
            1,
            'default',
            TEST_MODEL,
            'global',
            1_000,
            1_000,
            options.estimatedCost ?? ESTIMATE,
            options.dayKey ?? null,
            options.perRun ?? 1,
            options.perOrder ?? 2,
            options.daily ?? 3,
        ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('VERTEX_AI_PGLITE_RESERVATION_MISSING');
    return row;
}

describe('Vertex AI cost migrations in PGlite', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(currentDefinitions);
        await db.exec(budgetMigration);
        await db.exec(fenceMigration);
        await query(
            `INSERT INTO public.test_v2_policy_requests(id, policy_versions_snapshot)
             VALUES ($1, $2::jsonb), ($3, $4::jsonb)`,
            [
                REQUEST_ID,
                JSON.stringify(v212Snapshot),
                REQUEST_ID_V24,
                JSON.stringify(v212RiskV24Snapshot),
            ],
        );
    }, 30_000);

    afterAll(async () => {
        await db?.close();
    });

    it('applies both migrations and exercises ACL/RLS plus dynamic v2.12 fence rewrites', async () => {
        const relation = await query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
            `SELECT relrowsecurity, relforcerowsecurity
               FROM pg_catalog.pg_class
              WHERE oid = 'public.vertex_ai_budget_reservations'::pg_catalog.regclass`,
        );
        expect(relation.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

        for (const role of ['anon', 'authenticated', 'service_role'] as const) {
            await db.exec(`SET ROLE ${role}`);
            try {
                await expect(query('SELECT * FROM public.vertex_ai_budget_reservations'))
                    .rejects.toThrow(/permission denied/i);
            } finally {
                await db.exec('RESET ROLE');
            }
        }

        const constraints = await query<{ conname: string; definition: string }>(
            `SELECT conname, pg_catalog.pg_get_constraintdef(oid, TRUE) AS definition
               FROM pg_catalog.pg_constraint
              WHERE conrelid = 'public.analysis_v2_candidate_feature_rows'::pg_catalog.regclass
                AND conname IN (
                    'analysis_v2_candidate_feature_pre_feature_admission_check',
                    'analysis_v2_candidate_feature_classification_check'
                )
              ORDER BY conname`,
        );
        expect(constraints.rows).toHaveLength(2);
        expect(constraints.rows.every(row => row.definition.includes('ai-stage-policy-v2.12')))
            .toBe(true);
        await query(
            `INSERT INTO public.analysis_v2_candidate_feature_rows(
                id, ai_stage_policy, classification_policy
            ) VALUES ($1, 'ai-stage-policy-v2.12', 'ai-stage-policy-v2.12')`,
            ['33333333-3333-4333-8333-333333333333'],
        );

        for (const [requestId, snapshot] of [
            [REQUEST_ID, v212Snapshot],
            [REQUEST_ID_V24, v212RiskV24Snapshot],
        ] as const) {
            expect((await query<{ admitted: boolean }>(
                `SELECT public.analysis_v2_checkpoint_candidate_features_complete(
                    $1, 'job', $2, 'hash', 1, 1, $3::jsonb
                ) AS admitted`,
                [requestId, CLAIM_TOKEN, JSON.stringify(snapshot)],
            )).rows[0]?.admitted).toBe(true);
            expect((await query<{ admitted: boolean }>(
                `SELECT public.claim_analysis_v2_scheduler_operation(
                    $1, 'job', $2, 'hash', 'stage', $3, 1
                ) AS admitted`,
                [requestId, CLAIM_TOKEN, '44444444-4444-4444-8444-444444444444'],
            )).rows[0]?.admitted).toBe(true);
            expect((await query<{ admitted: boolean }>(
                `SELECT public.acquire_analysis_v2_scheduler_gemini_lease_v1(
                    $1, 'job', 'operation', 'hash', 1, $2, 240
                ) AS admitted`,
                [requestId, CLAIM_TOKEN],
            )).rows[0]?.admitted).toBe(true);
            expect((await query<{ admitted: boolean }>(
                'SELECT public.analysis_v2_apply_v211_summary_tone($1) AS admitted',
                [requestId],
            )).rows[0]?.admitted).toBe(true);
        }
    });

    it('atomically admits only one concurrent reservation under a shared limit', async () => {
        await db.exec('SET ROLE service_role');
        const attempts = await Promise.allSettled([
            query<ReservationRow>(
                `SELECT * FROM public.reserve_vertex_ai_budget(
                    $1,$2,$3,'operation-a',1,'default',$4,'global',1000,1000,$5,NULL,$6,$7,$8
                )`,
                ['atomic-a', 'atomic-run', 'atomic-order', TEST_MODEL, ESTIMATE, ESTIMATE, 2, ESTIMATE],
            ),
            query<ReservationRow>(
                `SELECT * FROM public.reserve_vertex_ai_budget(
                    $1,$2,$3,'operation-b',1,'default',$4,'global',1000,1000,$5,NULL,$6,$7,$8
                )`,
                ['atomic-b', 'atomic-run', 'atomic-order', TEST_MODEL, ESTIMATE, ESTIMATE, 2, ESTIMATE],
            ),
        ]);
        await db.exec('RESET ROLE');

        expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
        expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1);
        const rejection = attempts.find(attempt => attempt.status === 'rejected');
        expect(rejection?.status === 'rejected' && String(rejection.reason)).toContain(
            'VERTEX_AI_BUDGET_EXCEEDED',
        );
    });

    it('settles usage, preserves reserved/settled identity across UTC-day recovery, and re-admits cancelled work', async () => {
        const reserved = await reserve('cross-day-reserved', { dayKey: '2000-01-01' });
        const recoveredReserved = await reserve('cross-day-reserved', { dayKey: null });
        expect(recoveredReserved.reservation_id).toBe(reserved.reservation_id);
        expect(dayKeyValue(recoveredReserved.day_key)).toBe('2000-01-01');

        const settled = await reserve('cross-day-settled', { dayKey: '2000-01-01' });
        const settledResult = await asService<ReservationRow>(
            'SELECT * FROM public.settle_vertex_ai_budget($1,$2,$3)',
            [settled.reservation_key, settled.reservation_id, 0.001],
        );
        expect(settledResult.rows[0]?.actual_cost_usd).toBe('0.001000000000');

        const recoveredSettled = await reserve('cross-day-settled', { dayKey: null });
        expect(recoveredSettled.reservation_id).toBe(settled.reservation_id);
        expect(dayKeyValue(recoveredSettled.day_key)).toBe('2000-01-01');

        const cancelled = await reserve('cross-day-cancelled', { dayKey: '2000-01-01' });
        await asService(
            'SELECT public.cancel_vertex_ai_budget($1,$2)',
            [cancelled.reservation_key, cancelled.reservation_id],
        );
        const retried = await reserve('cross-day-cancelled', { dayKey: null });
        expect(retried.reservation_id).not.toBe(cancelled.reservation_id);
        expect(dayKeyValue(retried.day_key)).not.toBe('2000-01-01');
    });
});
