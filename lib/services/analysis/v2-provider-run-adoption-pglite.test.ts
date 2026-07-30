import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730220000_adopt_schema_recovery_predecessor_provider_run.sql',
        import.meta.url
    ),
    'utf8'
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const PREDECESSOR_REQUEST_ID = '20000000-0000-4000-8000-000000000001';
const SUCCESSOR_REQUEST_ID = '20000000-0000-4000-8000-000000000002';
const STRANGER_REQUEST_ID = '20000000-0000-4000-8000-000000000003';
const PREDECESSOR_PREFLIGHT_ID = '30000000-0000-4000-8000-000000000001';
const SUCCESSOR_PREFLIGHT_ID = '30000000-0000-4000-8000-000000000002';
const STRANGER_PREFLIGHT_ID = '30000000-0000-4000-8000-000000000003';
const CLAIM_TOKEN = '40000000-0000-4000-8000-000000000001';
const PREDECESSOR_RESERVATION = '50000000-0000-4000-8000-000000000001';
const ORDER_ID = '60000000-0000-4000-8000-000000000001';
const JOB_KEY = 'track:relationships:collect';
const OPERATION_KEY = `relationship-followers:${'c'.repeat(64)}`;
const OTHER_OPERATION_KEY = `relationship-following:${'d'.repeat(64)}`;
const INPUT_HASH = 'a'.repeat(64);
const OTHER_INPUT_HASH = 'b'.repeat(64);
const ACTOR_ID = 'scraping_solutions/instagram-scraper-followers-following-no-cookies';
const OTHER_ACTOR_ID = 'apify/instagram-profile-scraper';
const PAID_RUN_ID = 'PaidRun12345678';
const TARGET = '0_min._.00';
const MAX_CHARGE = 0.40205;

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot(p_slot TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT COALESCE(
        p_slot IN ('primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary'),
        FALSE
    );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_provider_operation_key(p_key TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT COALESCE(
        p_key ~ '^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[0-9a-f]{64}$',
        FALSE
    );
$$;

CREATE TABLE public.users (
    id UUID PRIMARY KEY
);

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    target_instagram_id VARCHAR(100) NOT NULL,
    pipeline_version TEXT,
    status TEXT NOT NULL,
    preflight_id UUID
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    target_instagram_id VARCHAR(30) NOT NULL,
    status TEXT NOT NULL,
    consumed_request_id UUID UNIQUE REFERENCES public.analysis_requests(id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key VARCHAR(160) NOT NULL,
    status TEXT NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, job_key)
);

CREATE TABLE public.analysis_v2_provider_runs (
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key VARCHAR(160) NOT NULL,
    operation_key VARCHAR(87) NOT NULL,
    input_hash VARCHAR(64) NOT NULL,
    job_claim_token UUID NOT NULL,
    reservation_token UUID NOT NULL,
    logical_provider VARCHAR(16) NOT NULL,
    actor_id VARCHAR(200) NOT NULL,
    credential_slot VARCHAR(16) NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'starting',
    run_id VARCHAR(64),
    actual_usage_usd NUMERIC(18, 12),
    reserved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    run_started_at TIMESTAMP WITH TIME ZONE,
    terminalized_at TIMESTAMP WITH TIME ZONE,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE,
    usage_reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0,
    usage_reconciliation_attempted_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, operation_key),
    UNIQUE (reservation_token),
    UNIQUE (run_id),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE CASCADE,
    CONSTRAINT analysis_v2_provider_run_operation_key_check CHECK (
        public.analysis_v2_valid_provider_operation_key(operation_key)
    ),
    CONSTRAINT analysis_v2_provider_run_input_hash_check CHECK (
        input_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_v2_provider_run_provider_check CHECK (
        logical_provider IN ('apify', 'coderx')
    ),
    CONSTRAINT analysis_v2_provider_run_credential_check CHECK (
        public.analysis_v2_valid_apify_credential_slot(credential_slot)
    ),
    CONSTRAINT analysis_v2_provider_run_run_id_check CHECK (
        run_id IS NULL OR run_id ~ '^[A-Za-z0-9]{8,64}$'
    ),
    CONSTRAINT analysis_v2_provider_run_cost_check CHECK (
        max_charge_usd BETWEEN 0 AND 100000
        AND (actual_usage_usd IS NULL OR actual_usage_usd BETWEEN 0 AND 100000)
    ),
    CONSTRAINT analysis_v2_provider_run_status_check CHECK (
        status IN ('starting', 'running', 'rejected', 'succeeded', 'failed', 'aborted', 'timed_out')
    ),
    CONSTRAINT analysis_v2_provider_run_state_check CHECK (
        (status = 'starting' AND run_id IS NULL AND run_started_at IS NULL
            AND terminalized_at IS NULL AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL)
        OR (status = 'running' AND run_id IS NOT NULL AND run_started_at IS NOT NULL
            AND terminalized_at IS NULL AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL)
        OR (status = 'rejected' AND run_id IS NULL AND run_started_at IS NULL
            AND terminalized_at IS NOT NULL AND actual_usage_usd = 0
            AND usage_reconciled_at IS NOT NULL)
        OR (status IN ('succeeded', 'failed', 'aborted', 'timed_out')
            AND run_id IS NOT NULL AND run_started_at IS NOT NULL
            AND terminalized_at IS NOT NULL
            AND ((actual_usage_usd IS NULL AND usage_reconciled_at IS NULL)
                OR (actual_usage_usd IS NOT NULL AND usage_reconciled_at IS NOT NULL)))
    ),
    CONSTRAINT analysis_v2_provider_run_time_check CHECK (
        updated_at >= reserved_at
        AND (run_started_at IS NULL OR run_started_at >= reserved_at)
        AND (terminalized_at IS NULL OR terminalized_at >= run_started_at)
        AND (usage_reconciled_at IS NULL OR usage_reconciled_at >= terminalized_at)
    ),
    CONSTRAINT analysis_v2_provider_usage_attempt_time_check CHECK (
        usage_reconciliation_attempted_at IS NULL
        OR usage_reconciliation_attempted_at >= terminalized_at
    )
);

ALTER TABLE public.analysis_v2_provider_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_provider_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_provider_runs
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_provider_run_json(
    p_run public.analysis_v2_provider_runs
) RETURNS JSONB LANGUAGE sql STABLE STRICT SET search_path = '' AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', p_run.request_id, 'jobKey', p_run.job_key,
        'operationKey', p_run.operation_key, 'inputHash', p_run.input_hash,
        'reservationToken', p_run.reservation_token,
        'logicalProvider', p_run.logical_provider, 'actorId', p_run.actor_id,
        'credentialSlot', p_run.credential_slot, 'maxChargeUsd', p_run.max_charge_usd,
        'status', p_run.status, 'runId', p_run.run_id,
        'actualUsageUsd', p_run.actual_usage_usd, 'reservedAt', p_run.reserved_at,
        'runStartedAt', p_run.run_started_at, 'terminalizedAt', p_run.terminalized_at,
        'usageReconciledAt', p_run.usage_reconciled_at
    );
$$;

CREATE TABLE public.earlybird_schema_failure_recoveries (
    order_id UUID PRIMARY KEY,
    failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    recovery_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    prior_attempt_count SMALLINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
`;

interface JsonRow<T> { result: T }

interface AdoptedRun {
    requestId: string;
    jobKey: string;
    operationKey: string;
    reservationToken: string;
    status: string;
    runId: string | null;
    actualUsageUsd: number;
    terminalizedAt: string;
    usageReconciledAt: string;
    adoptedFromRequestId: string;
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

const ADOPT_SQL = `SELECT public.adopt_analysis_v2_predecessor_provider_run(
    $1, $2, $3, $4, $5, 'apify', $6, $7, $8, $9
) AS result`;

function adoptParams(overrides: {
    requestId?: string;
    jobKey?: string;
    claimToken?: string;
    operationKey?: string;
    inputHash?: string;
    actorId?: string;
    credentialSlot?: string;
    maxChargeUsd?: number;
    reservationToken?: string;
} = {}): unknown[] {
    return [
        overrides.requestId ?? SUCCESSOR_REQUEST_ID,
        overrides.jobKey ?? JOB_KEY,
        overrides.claimToken ?? CLAIM_TOKEN,
        overrides.operationKey ?? OPERATION_KEY,
        overrides.inputHash ?? INPUT_HASH,
        overrides.actorId ?? ACTOR_ID,
        overrides.credentialSlot ?? 'primary',
        overrides.maxChargeUsd ?? MAX_CHARGE,
        overrides.reservationToken ?? '70000000-0000-4000-8000-000000000001',
    ];
}

async function adopt(overrides: Parameters<typeof adoptParams>[0] = {}) {
    const result = await serviceQuery<JsonRow<AdoptedRun | null>>(
        ADOPT_SQL,
        adoptParams(overrides)
    );
    return result.rows[0]!.result;
}

async function seedUsers(): Promise<void> {
    await db.query(
        'INSERT INTO public.users (id) VALUES ($1), ($2)',
        [USER_ID, OTHER_USER_ID]
    );
}

/** Inserts a request plus its consumed preflight and, for the successor, a claimed job. */
async function seedRequest(input: {
    requestId: string;
    preflightId: string;
    userId?: string;
    target?: string;
    preflightTarget?: string;
    status?: string;
    withJob?: boolean;
    jobStatus?: string;
    leaseToken?: string;
    leaseExpired?: boolean;
}): Promise<void> {
    const target = input.target ?? TARGET;
    await db.query(
        `INSERT INTO public.analysis_requests (
            id, user_id, target_instagram_id, pipeline_version, status, preflight_id
        ) VALUES ($1, $2, $3, 'v2', $4, $5)`,
        [
            input.requestId,
            input.userId ?? USER_ID,
            target,
            input.status ?? 'processing',
            input.preflightId,
        ]
    );
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, target_instagram_id, status, consumed_request_id
        ) VALUES ($1, $2, $3, 'consumed', $4)`,
        [
            input.preflightId,
            input.userId ?? USER_ID,
            input.preflightTarget ?? target,
            input.requestId,
        ]
    );
    if (input.withJob) {
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs (
                request_id, job_key, status, lease_token, lease_expires_at
            ) VALUES ($1, $2, $3, $4, pg_catalog.clock_timestamp() + $5::INTERVAL)`,
            [
                input.requestId,
                JOB_KEY,
                input.jobStatus ?? 'processing',
                input.leaseToken ?? CLAIM_TOKEN,
                input.leaseExpired ? '-1 minute' : '5 minutes',
            ]
        );
    }
}

async function seedPredecessorRun(overrides: {
    operationKey?: string;
    inputHash?: string;
    actorId?: string;
    credentialSlot?: string;
    status?: string;
    runId?: string | null;
    requestId?: string;
    actualUsageUsd?: number | null;
} = {}): Promise<void> {
    const status = overrides.status ?? 'succeeded';
    const runId = overrides.runId === undefined ? PAID_RUN_ID : overrides.runId;
    const terminal = ['succeeded', 'failed', 'aborted', 'timed_out'].includes(status);
    const actualUsageUsd = overrides.actualUsageUsd === undefined ? 0.38 : overrides.actualUsageUsd;
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs (
            request_id, job_key, status, lease_token, lease_expires_at
        ) VALUES ($1, $2, 'succeeded', NULL, NULL)
        ON CONFLICT DO NOTHING`,
        [overrides.requestId ?? PREDECESSOR_REQUEST_ID, JOB_KEY]
    );
    const usage = runId === null ? null : actualUsageUsd;
    // Timestamp columns are literal SQL so PGlite never has to unify one placeholder's type.
    const now = 'pg_catalog.clock_timestamp()';
    const runStartedAt = runId === null ? 'NULL' : now;
    const terminalizedAt = terminal ? now : 'NULL';
    const usageReconciledAt = terminal && usage !== null ? now : 'NULL';
    await db.query(
        `INSERT INTO public.analysis_v2_provider_runs (
            request_id, job_key, operation_key, input_hash, job_claim_token,
            reservation_token, logical_provider, actor_id, credential_slot,
            max_charge_usd, status, run_id, actual_usage_usd,
            run_started_at, terminalized_at, usage_reconciled_at
        ) VALUES (
            $1, $2, $3, $4, $5, $6, 'apify', $7, $8, $9, $10, $11, $12,
            ${runStartedAt}, ${terminalizedAt}, ${usageReconciledAt}
        )`,
        [
            overrides.requestId ?? PREDECESSOR_REQUEST_ID,
            JOB_KEY,
            overrides.operationKey ?? OPERATION_KEY,
            overrides.inputHash ?? INPUT_HASH,
            CLAIM_TOKEN,
            PREDECESSOR_RESERVATION,
            overrides.actorId ?? ACTOR_ID,
            overrides.credentialSlot ?? 'primary',
            MAX_CHARGE,
            status,
            runId,
            usage,
        ]
    );
}

async function seedLineage(
    reason = 'earlybird_schema_failure_recovery',
    successorPreflightId = SUCCESSOR_PREFLIGHT_ID,
    predecessorRequestId = PREDECESSOR_REQUEST_ID
): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_request_retry_lineage (
            successor_preflight_id, predecessor_request_id, reason
        ) VALUES ($1, $2, $3)`,
        [successorPreflightId, predecessorRequestId, reason]
    );
}

/** Predecessor paid + successor claimed + lineage recorded: the one adoptable shape. */
async function seedAdoptableWorld(): Promise<void> {
    await seedUsers();
    await seedRequest({
        requestId: PREDECESSOR_REQUEST_ID,
        preflightId: PREDECESSOR_PREFLIGHT_ID,
        status: 'failed',
    });
    await seedRequest({
        requestId: SUCCESSOR_REQUEST_ID,
        preflightId: SUCCESSOR_PREFLIGHT_ID,
        withJob: true,
    });
    await seedPredecessorRun();
    await seedLineage();
}

describe('analysis V2 predecessor provider run adoption PGlite', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(bootstrap);
        await db.exec(migration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`TRUNCATE
            public.earlybird_schema_failure_recoveries,
            public.analysis_request_retry_lineage,
            public.analysis_v2_provider_runs,
            public.analysis_pipeline_jobs,
            public.analysis_preflights,
            public.analysis_requests,
            public.users CASCADE`);
    });

    afterAll(async () => {
        await db.close();
    });

    it('exposes the adoption RPC only to service_role', async () => {
        await seedAdoptableWorld();
        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(ADOPT_SQL, adoptParams()))
                .rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
        await expect(adopt()).resolves.not.toBeNull();
    });

    it('adopts the predecessor run once, free, and marked with the paying request', async () => {
        await seedAdoptableWorld();

        const adopted = await adopt();

        expect(adopted).toMatchObject({
            requestId: SUCCESSOR_REQUEST_ID,
            jobKey: JOB_KEY,
            operationKey: OPERATION_KEY,
            status: 'succeeded',
            runId: PAID_RUN_ID,
            actualUsageUsd: 0,
            adoptedFromRequestId: PREDECESSOR_REQUEST_ID,
        });
        expect(adopted?.terminalizedAt).toEqual(expect.any(String));
        expect(adopted?.usageReconciledAt).toEqual(expect.any(String));

        // Replaying returns the same row and never creates a second one.
        const replay = await adopt({ reservationToken: '70000000-0000-4000-8000-000000000002' });
        expect(replay).toEqual(adopted);
        const rows = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_provider_runs
             WHERE request_id = $1`,
            [SUCCESSOR_REQUEST_ID]
        );
        expect(rows.rows[0]!.count).toBe(1);
    });

    it('adopts through a lineage edge recorded for any retry reason', async () => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
        });
        await seedPredecessorRun();
        await seedLineage('operator_ai_stage_retry');

        await expect(adopt()).resolves.toMatchObject({
            runId: PAID_RUN_ID,
            actualUsageUsd: 0,
        });
    });

    it('adopts when the predecessor target was already PII-scrubbed', async () => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            status: 'failed',
        });
        await db.query(
            `UPDATE public.analysis_requests
             SET target_instagram_id = 'retained.' || pg_catalog.substr(
                 pg_catalog.replace(id::TEXT, '-', ''), 1, 20
             )
             WHERE id = $1`,
            [PREDECESSOR_REQUEST_ID]
        );
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
        });
        await seedPredecessorRun();
        await seedLineage();

        await expect(adopt()).resolves.toMatchObject({ runId: PAID_RUN_ID });
    });

    it('refuses adoption without a recorded lineage edge even on an exact identity match', async () => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
        });
        await seedPredecessorRun();

        await expect(adopt()).resolves.toBeNull();
        const rows = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_provider_runs WHERE request_id = $1`,
            [SUCCESSOR_REQUEST_ID]
        );
        expect(rows.rows[0]!.count).toBe(0);
    });

    it('refuses a lineage edge that points at an unrelated request', async () => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: STRANGER_REQUEST_ID,
            preflightId: STRANGER_PREFLIGHT_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
        });
        // The paid run belongs to a request the lineage does not name.
        await seedPredecessorRun();
        await seedLineage('operator_retry', SUCCESSOR_PREFLIGHT_ID, STRANGER_REQUEST_ID);

        await expect(adopt()).resolves.toBeNull();
    });

    it('refuses a predecessor owned by a different user', async () => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            userId: OTHER_USER_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
        });
        await seedPredecessorRun();
        await seedLineage();

        await expect(adopt()).resolves.toBeNull();
    });

    it('refuses a predecessor analysing a different Instagram target', async () => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            target: 'someone.else',
            status: 'failed',
        });
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
        });
        await seedPredecessorRun();
        await seedLineage();

        await expect(adopt()).resolves.toBeNull();
    });

    it.each([
        ['a different operation key', { operationKey: OTHER_OPERATION_KEY }],
        ['a different input hash', { inputHash: OTHER_INPUT_HASH }],
        ['a different credential slot', { credentialSlot: 'secondary' }],
        ['a different actor id', { actorId: OTHER_ACTOR_ID }],
    ])('refuses %s', async (_label, overrides) => {
        await seedAdoptableWorld();

        await expect(adopt(overrides)).resolves.toBeNull();
    });

    it.each([
        ['is not succeeded', { status: 'failed' }],
        ['still has no run id', { status: 'starting', runId: null, actualUsageUsd: null }],
    ])('refuses a predecessor run that %s', async (_label, overrides) => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
        });
        await seedPredecessorRun(overrides);
        await seedLineage();

        await expect(adopt()).resolves.toBeNull();
    });

    it.each([
        ['the claim token does not match', { claimToken: '40000000-0000-4000-8000-000000000009' }],
        ['the job key was never claimed', { jobKey: 'track:target-evidence:collect' }],
    ])('refuses adoption when %s', async (_label, overrides) => {
        await seedAdoptableWorld();

        await expect(adopt(overrides)).resolves.toBeNull();
    });

    it('refuses adoption once the job lease expired', async () => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
            leaseExpired: true,
        });
        await seedPredecessorRun();
        await seedLineage();

        await expect(adopt()).resolves.toBeNull();
    });

    it('refuses adoption for a request that is no longer active', async () => {
        await seedAdoptableWorld();
        await db.query(
            `UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1`,
            [SUCCESSOR_REQUEST_ID]
        );

        await expect(adopt()).resolves.toBeNull();
    });

    it('still rejects two non-adopted rows that claim the same Apify run', async () => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
        });
        await seedPredecessorRun();

        await expect(db.query(
            `INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, input_hash, job_claim_token,
                reservation_token, logical_provider, actor_id, credential_slot,
                max_charge_usd, status, run_id, actual_usage_usd,
                run_started_at, terminalized_at, usage_reconciled_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, 'apify', $7, 'primary', $8, 'succeeded', $9, 0.22,
                pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
                pg_catalog.clock_timestamp()
            )`,
            [
                SUCCESSOR_REQUEST_ID, JOB_KEY, OPERATION_KEY, INPUT_HASH, CLAIM_TOKEN,
                '50000000-0000-4000-8000-000000000002', ACTOR_ID, MAX_CHARGE, PAID_RUN_ID,
            ]
        )).rejects.toThrow(/analysis_v2_provider_runs_unadopted_run_id_key/);
    });

    it('lets exactly one adopted row share the run of its non-adopted owner', async () => {
        await seedAdoptableWorld();
        await adopt();

        const rows = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_provider_runs WHERE run_id = $1`,
            [PAID_RUN_ID]
        );
        expect(rows.rows[0]!.count).toBe(2);
        const owners = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_provider_runs
             WHERE run_id = $1 AND adopted_from_request_id IS NULL`,
            [PAID_RUN_ID]
        );
        expect(owners.rows[0]!.count).toBe(1);
    });

    it('refuses an adopted row that carries any usage cost', async () => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
        });

        await expect(db.query(
            `INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, input_hash, job_claim_token,
                reservation_token, logical_provider, actor_id, credential_slot,
                max_charge_usd, status, run_id, actual_usage_usd,
                run_started_at, terminalized_at, usage_reconciled_at,
                adopted_from_request_id
            ) VALUES (
                $1, $2, $3, $4, $5, $6, 'apify', $7, 'primary', $8, 'succeeded', $9, 0.38,
                pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
                pg_catalog.clock_timestamp(), $10
            )`,
            [
                SUCCESSOR_REQUEST_ID, JOB_KEY, OPERATION_KEY, INPUT_HASH, CLAIM_TOKEN,
                '50000000-0000-4000-8000-000000000003', ACTOR_ID, MAX_CHARGE, PAID_RUN_ID,
                PREDECESSOR_REQUEST_ID,
            ]
        )).rejects.toThrow(/analysis_v2_provider_run_adoption_check/);
    });

    it('counts the real Apify charge exactly once across both rows', async () => {
        await seedAdoptableWorld();
        await adopt();

        const totals = await db.query<{ actual: string; conservative: string }>(
            `SELECT
                COALESCE(pg_catalog.sum(actual_usage_usd), 0)::TEXT AS actual,
                COALESCE(pg_catalog.sum(
                    COALESCE(actual_usage_usd, max_charge_usd)
                ), 0)::TEXT AS conservative
             FROM public.analysis_v2_provider_runs
             WHERE run_id = $1`,
            [PAID_RUN_ID]
        );
        expect(Number(totals.rows[0]!.actual)).toBeCloseTo(0.38, 12);
        expect(Number(totals.rows[0]!.conservative)).toBeCloseTo(0.38, 12);
    });

    it('keeps adopted rows out of Apify usage reconciliation', async () => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
        });
        // The predecessor is still awaiting its authenticated Apify usage read.
        await seedPredecessorRun({ actualUsageUsd: null });
        await seedLineage();
        const adopted = await adopt();
        await db.query(
            `UPDATE public.analysis_v2_provider_runs
             SET reserved_at = reserved_at - INTERVAL '10 minutes',
                 run_started_at = run_started_at - INTERVAL '10 minutes',
                 terminalized_at = terminalized_at - INTERVAL '10 minutes',
                 usage_reconciled_at = usage_reconciled_at - INTERVAL '10 minutes'`
        );

        const listed = await serviceQuery<JsonRow<Array<{ requestId: string }>>>(
            'SELECT public.list_analysis_v2_unreconciled_provider_runs(64) AS result'
        );
        expect(listed.rows[0]!.result.map(run => run.requestId))
            .toEqual([PREDECESSOR_REQUEST_ID]);

        await expect(serviceQuery(
            `SELECT public.reconcile_analysis_v2_provider_run_usage(
                $1, $2, 'apify', $3, 'primary', $4, 'succeeded', 0.38
            )`,
            [adopted!.reservationToken, PAID_RUN_ID, ACTOR_ID, MAX_CHARGE]
        )).rejects.toThrow(/RECONCILIATION_CONFLICT/);
    });

    it('records a lineage edge whenever an earlybird schema recovery receipt is written', async () => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
        });
        await db.query(
            `INSERT INTO public.earlybird_schema_failure_recoveries (
                order_id, failed_request_id, recovery_preflight_id, prior_attempt_count
            ) VALUES ($1, $2, $3, 1)`,
            [ORDER_ID, PREDECESSOR_REQUEST_ID, SUCCESSOR_PREFLIGHT_ID]
        );

        const lineage = await db.query<{
            successor_preflight_id: string;
            predecessor_request_id: string;
            reason: string;
        }>(`SELECT successor_preflight_id, predecessor_request_id, reason
            FROM public.analysis_request_retry_lineage`);
        expect(lineage.rows).toEqual([{
            successor_preflight_id: SUCCESSOR_PREFLIGHT_ID,
            predecessor_request_id: PREDECESSOR_REQUEST_ID,
            reason: 'earlybird_schema_failure_recovery',
        }]);

        await seedPredecessorRun();
        await expect(adopt()).resolves.toMatchObject({ runId: PAID_RUN_ID });
    });

    it('keeps at most one predecessor per retry preflight', async () => {
        await seedUsers();
        await seedRequest({
            requestId: PREDECESSOR_REQUEST_ID,
            preflightId: PREDECESSOR_PREFLIGHT_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: STRANGER_REQUEST_ID,
            preflightId: STRANGER_PREFLIGHT_ID,
            status: 'failed',
        });
        await seedRequest({
            requestId: SUCCESSOR_REQUEST_ID,
            preflightId: SUCCESSOR_PREFLIGHT_ID,
            withJob: true,
        });
        await seedLineage();

        await expect(seedLineage(
            'operator_retry', SUCCESSOR_PREFLIGHT_ID, STRANGER_REQUEST_ID
        )).rejects.toThrow(/analysis_request_retry_lineage_pkey/);
    });
});

describe('earlybird schema recovery lineage backfill PGlite', () => {
    it('backfills lineage for recovery receipts written before this migration', async () => {
        const backfillDb = await PGlite.create();
        try {
            await backfillDb.exec(bootstrap);
            await backfillDb.query(
                'INSERT INTO public.users (id) VALUES ($1)',
                [USER_ID]
            );
            for (const [requestId, preflightId] of [
                [PREDECESSOR_REQUEST_ID, PREDECESSOR_PREFLIGHT_ID],
                [SUCCESSOR_REQUEST_ID, SUCCESSOR_PREFLIGHT_ID],
            ]) {
                await backfillDb.query(
                    `INSERT INTO public.analysis_requests (
                        id, user_id, target_instagram_id, pipeline_version, status, preflight_id
                    ) VALUES ($1, $2, $3, 'v2', 'failed', $4)`,
                    [requestId, USER_ID, TARGET, preflightId]
                );
                await backfillDb.query(
                    `INSERT INTO public.analysis_preflights (
                        id, user_id, target_instagram_id, status, consumed_request_id
                    ) VALUES ($1, $2, $3, 'consumed', $4)`,
                    [preflightId, USER_ID, TARGET, requestId]
                );
            }
            await backfillDb.query(
                `INSERT INTO public.earlybird_schema_failure_recoveries (
                    order_id, failed_request_id, recovery_preflight_id, prior_attempt_count
                ) VALUES ($1, $2, $3, 2)`,
                [ORDER_ID, PREDECESSOR_REQUEST_ID, SUCCESSOR_PREFLIGHT_ID]
            );

            await backfillDb.exec(migration);

            const lineage = await backfillDb.query<{
                successor_preflight_id: string;
                predecessor_request_id: string;
                reason: string;
            }>(`SELECT successor_preflight_id, predecessor_request_id, reason
                FROM public.analysis_request_retry_lineage`);
            expect(lineage.rows).toEqual([{
                successor_preflight_id: SUCCESSOR_PREFLIGHT_ID,
                predecessor_request_id: PREDECESSOR_REQUEST_ID,
                reason: 'earlybird_schema_failure_recovery',
            }]);
        } finally {
            await backfillDb.close();
        }
    }, 30_000);
});
