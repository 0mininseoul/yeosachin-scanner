import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migrationUrls = [
    new URL(
        '../../../supabase/migrations/20260802010000_add_betatest_apify_credit_pool.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802010100_validate_betatest_entry_channel_constraints.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802020000_add_betatest_apify_credit_reservations.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802030000_bind_betatest_provider_policy.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802030100_validate_betatest_provider_policy.sql',
        import.meta.url
    ),
];
const migrations = migrationUrls.map(url => readFileSync(url, 'utf8'));

const USER_ID = '10000000-0000-4000-8000-000000000001';
const PREFLIGHT_ID = '20000000-0000-4000-8000-000000000001';
const REQUEST_ID = '30000000-0000-4000-8000-000000000001';
const CLAIM_TOKEN = '40000000-0000-4000-8000-000000000001';
const RESERVATION_TOKEN = '50000000-0000-4000-8000-000000000001';
const TARGET = 'target.user';
const INPUT_HASH = 'a'.repeat(64);
const OTHER_INPUT_HASH = 'b'.repeat(64);
const DIGEST = 'c'.repeat(64);
const AUDIT_HASH = 'd'.repeat(64);
const JTI_HASH = 'e'.repeat(64);
const BETA_SLOTS = [
    'primary',
    'tertiary',
    'quaternary',
    'quinary',
    'senary',
    'septenary',
] as const;
const OPERATIONS = [
    'target-profile',
    'relationship-followers',
    'relationship-following',
    'profile-fallback',
    'profile-repair',
    'target-likers',
    'target-comments',
    'candidate-likers',
] as const;

const betaSlots: Record<string, string> = {
    'target-profile': 'primary',
    'relationship-followers': 'tertiary',
    'relationship-following': 'quaternary',
    'profile-fallback': 'quinary',
    'profile-repair': 'septenary',
    'target-likers': 'senary',
    'target-comments': 'tertiary',
    'candidate-likers': 'quaternary',
};
const betaBudgets: Record<string, number> = Object.fromEntries(
    OPERATIONS.map(operation => [
        operation,
        operation === 'target-profile' ? 0.0052 : 0.02,
    ])
);
const legacySlots = {
    'target-profile': 'primary',
    'relationship-followers': 'senary',
    'relationship-following': 'secondary',
    'profile-fallback': 'primary',
    'target-likers': 'quaternary',
    'target-comments': 'primary',
    'candidate-likers': 'quinary',
};

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid()
RETURNS UUID LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', TRUE), '')::UUID
$$;

CREATE FUNCTION public.analysis_v2_valid_apify_credential_slot(p_slot TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT COALESCE(p_slot IN (
        'primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary'
    ), FALSE)
$$;

CREATE FUNCTION public.analysis_v2_valid_test_operation_slot_map(p_map JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT COALESCE(
        pg_catalog.jsonb_typeof(p_map) = 'object'
        AND p_map ?& ARRAY[
            'target-profile', 'relationship-followers', 'relationship-following',
            'profile-fallback', 'target-likers', 'target-comments', 'candidate-likers'
        ]
        AND p_map - ARRAY[
            'target-profile', 'relationship-followers', 'relationship-following',
            'profile-fallback', 'target-likers', 'target-comments', 'candidate-likers'
        ] = '{}'::JSONB
        AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_each_text(p_map) AS entry(key, value)
            WHERE NOT public.analysis_v2_valid_apify_credential_slot(entry.value)
        ), FALSE
    )
$$;

CREATE FUNCTION public.analysis_v2_valid_provider_operation_key(p_key TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE STRICT SET search_path = ''
AS $$
    SELECT p_key ~ '^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[0-9a-f]{64}$'
$$;

CREATE TABLE public.users (id UUID PRIMARY KEY);

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    target_instagram_id TEXT NOT NULL,
    excluded_instagram_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    background_processing BOOLEAN NOT NULL DEFAULT FALSE,
    pipeline_version TEXT,
    preflight_id UUID,
    plan_access_mode_snapshot TEXT,
    test_entitlement_jti_hash TEXT,
    selected_plan_id_snapshot TEXT,
    analysis_scope_snapshot JSONB
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    status TEXT NOT NULL DEFAULT 'pending',
    access_mode TEXT NOT NULL CHECK (access_mode IN ('production', 'test_entitlement')),
    target_instagram_id TEXT,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    excluded_instagram_id TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    admission_status TEXT,
    admission_generation INTEGER,
    admission_requested_at TIMESTAMPTZ,
    admission_claim_token UUID,
    admission_lease_expires_at TIMESTAMPTZ,
    dispatch_generation INTEGER NOT NULL DEFAULT 0,
    dispatch_state TEXT NOT NULL DEFAULT 'unreserved',
    dispatch_token UUID,
    dispatch_reserved_at TIMESTAMPTZ,
    dispatched_at TIMESTAMPTZ,
    consumed_request_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    dispatch_state TEXT NOT NULL DEFAULT 'pending',
    dispatch_generation INTEGER NOT NULL DEFAULT 0,
    dispatch_reservation_token UUID,
    dispatch_reserved_at TIMESTAMPTZ,
    dispatched_at TIMESTAMPTZ,
    dispatch_task_name TEXT,
    delivered_at TIMESTAMPTZ,
    first_started_at TIMESTAMPTZ,
    input_hash TEXT NOT NULL DEFAULT '${INPUT_HASH}',
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    PRIMARY KEY (request_id, job_key)
);

CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id),
    operation_key TEXT NOT NULL DEFAULT 'target-profile-fallback',
    input_hash TEXT NOT NULL,
    logical_provider TEXT NOT NULL DEFAULT 'apify',
    actor_id TEXT NOT NULL DEFAULT 'apify/instagram-profile-scraper',
    credential_slot TEXT NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (preflight_id, operation_key)
);

CREATE FUNCTION public.analysis_preflight_provider_run_json(
    p_run public.analysis_preflight_provider_runs
)
RETURNS JSONB LANGUAGE sql STABLE STRICT SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'preflightId', p_run.preflight_id,
        'operationKey', p_run.operation_key,
        'inputHash', p_run.input_hash,
        'logicalProvider', p_run.logical_provider,
        'actorId', p_run.actor_id,
        'credentialSlot', p_run.credential_slot,
        'maxChargeUsd', p_run.max_charge_usd,
        'status', p_run.status
    )
$$;

CREATE FUNCTION public.adopt_legacy_fresh_admission_provider_run(
    p_preflight_id UUID,
    p_operation_key TEXT,
    p_admission_requested_at TIMESTAMPTZ
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    UPDATE public.analysis_preflight_provider_runs AS provider_run
    SET operation_key = p_operation_key,
        updated_at = pg_catalog.clock_timestamp()
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fallback'
      AND provider_run.reserved_at >= p_admission_requested_at
      AND NOT EXISTS (
          SELECT 1 FROM public.analysis_preflight_provider_runs AS current_generation
          WHERE current_generation.preflight_id = p_preflight_id
            AND current_generation.operation_key = p_operation_key
      );
END
$$;

CREATE TABLE public.analysis_v2_provider_runs (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    job_claim_token UUID NOT NULL,
    reservation_token UUID NOT NULL UNIQUE,
    logical_provider TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    credential_slot TEXT NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, operation_key),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);

CREATE FUNCTION public.analysis_v2_provider_run_json(p_run public.analysis_v2_provider_runs)
RETURNS JSONB LANGUAGE sql STABLE STRICT SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', p_run.request_id,
        'jobKey', p_run.job_key,
        'operationKey', p_run.operation_key,
        'inputHash', p_run.input_hash,
        'reservationToken', p_run.reservation_token,
        'logicalProvider', p_run.logical_provider,
        'actorId', p_run.actor_id,
        'credentialSlot', p_run.credential_slot,
        'maxChargeUsd', p_run.max_charge_usd,
        'status', p_run.status
    )
$$;

CREATE FUNCTION public.analysis_v2_reserve_provider_run_internal(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_reservation_token UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_existing public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF NOT public.analysis_v2_valid_provider_operation_key(p_operation_key)
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd NOT BETWEEN 0 AND 100000
       OR p_max_charge_usd <> pg_catalog.round(p_max_charge_usd, 12) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT provider_run.* INTO v_existing
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.input_hash IS DISTINCT FROM p_input_hash
           OR v_existing.logical_provider IS DISTINCT FROM p_logical_provider
           OR v_existing.actor_id IS DISTINCT FROM p_actor_id
           OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot
           OR v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'created', FALSE, 'run', public.analysis_v2_provider_run_json(v_existing)
        );
    END IF;
    INSERT INTO public.analysis_v2_provider_runs (
        request_id, job_key, operation_key, input_hash, job_claim_token,
        reservation_token, logical_provider, actor_id, credential_slot,
        max_charge_usd
    ) VALUES (
        p_request_id, p_job_key, p_operation_key, p_input_hash, p_claim_token,
        p_reservation_token, p_logical_provider, p_actor_id, p_credential_slot,
        p_max_charge_usd
    ) RETURNING * INTO v_existing;
    RETURN pg_catalog.jsonb_build_object(
        'created', TRUE, 'run', public.analysis_v2_provider_run_json(v_existing)
    );
END
$$;

CREATE TABLE public.analysis_v2_provider_cleanup_intents (
    request_id UUID PRIMARY KEY,
    completed_at TIMESTAMPTZ
);

CREATE TABLE public.analysis_v2_provider_execution_policies (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    mode VARCHAR(32) NOT NULL CHECK (mode = 'test_operation_split'),
    policy_version VARCHAR(64) NOT NULL CHECK (policy_version = 'authorized-free-e2e-v1'),
    entitlement_jti_hash VARCHAR(64) NOT NULL CHECK (entitlement_jti_hash ~ '^[a-f0-9]{64}$'),
    target_instagram_id VARCHAR(30) NOT NULL CHECK (target_instagram_id ~ '^[a-z0-9._]{1,30}$'),
    operation_slot_map JSONB NOT NULL CHECK (
        public.analysis_v2_valid_test_operation_slot_map(operation_slot_map)
    ),
    policy_hash VARCHAR(64) NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.analysis_v2_provider_execution_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_provider_execution_policies FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_provider_execution_policies
    FROM PUBLIC, anon, authenticated, service_role;
`;

interface JsonRow<T> {
    result: T;
}

interface AllocationJson {
    allocationId: string;
    lifecycleState: string;
    operationSlotMap: Record<string, string> | null;
}

interface ReservationJson {
    created: boolean;
    run: {
        operationKey: string;
        credentialSlot: string;
        maxChargeUsd: number;
    };
}

let db: PGlite;

async function serviceQuery<T>(
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

function snapshots(): unknown[] {
    const now = Date.now();
    return BETA_SLOTS.map(credentialSlot => ({
        credentialSlot,
        monthlyLimitUsd: 1,
        monthlyUsageUsd: 0,
        billingCycleStartAt: new Date(now - 60_000).toISOString(),
        billingCycleEndAt: new Date(now + 86_400_000).toISOString(),
        observedAt: new Date(now - 1_000).toISOString(),
        healthState: 'healthy',
    }));
}

async function seedPendingBetaPreflight(): Promise<void> {
    await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, status, access_mode, target_instagram_id,
            target_followers_count, target_following_count, expires_at
         ) VALUES (
            $1, $2, 'pending', 'production', $3, 120, 140,
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
         )`,
        [PREFLIGHT_ID, USER_ID, TARGET]
    );
    await serviceQuery(
        `SELECT public.upsert_analysis_beta_access_grant(
            $1, TRUE, pg_catalog.clock_timestamp() + INTERVAL '1 hour', $2
        )`,
        [USER_ID, AUDIT_HASH]
    );
    await serviceQuery(
        'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
        [JSON.stringify(snapshots())]
    );
    await serviceQuery(
        `SELECT public.hold_analysis_beta_apify_preflight_credit(
            $1, $2, 'primary', 0.005200000000, 300
        )`,
        [PREFLIGHT_ID, USER_ID]
    );
}

async function seedPendingBetaRequest(): Promise<void> {
    await seedPendingBetaPreflight();
    await db.query(
        `INSERT INTO public.analysis_requests (
            id, user_id, target_instagram_id, status, background_processing,
            pipeline_version, preflight_id, plan_access_mode_snapshot,
            test_entitlement_jti_hash, selected_plan_id_snapshot,
            analysis_scope_snapshot
         ) VALUES (
            $1, $2, $3, 'pending', FALSE, 'v2', $4, 'production', NULL,
            'standard', $5::JSONB
         )`,
        [
            REQUEST_ID,
            USER_ID,
            TARGET,
            PREFLIGHT_ID,
            JSON.stringify({
                relationshipCapacity: { followers: 300, following: 300 },
                detailedMutualLimit: 300,
            }),
        ]
    );
    await db.query(
        `UPDATE public.analysis_preflights
         SET status = 'consumed', consumed_request_id = $2
         WHERE id = $1`,
        [PREFLIGHT_ID, REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs (request_id, job_key)
         VALUES ($1, 'collect')`,
        [REQUEST_ID]
    );
}

async function activateBeta(
    slots: Record<string, string> = betaSlots,
    budgets: Record<string, number> = betaBudgets
): Promise<AllocationJson> {
    const result = await serviceQuery<JsonRow<AllocationJson>>(
        `SELECT public.activate_analysis_beta_apify_request_credit(
            $1, $2, $3, 'standard', $4::JSONB, $5::JSONB, 300
        ) AS result`,
        [
            PREFLIGHT_ID,
            REQUEST_ID,
            USER_ID,
            JSON.stringify(slots),
            JSON.stringify(budgets),
        ]
    );
    return result.rows[0].result;
}

async function makeJobLive(jobKey = 'collect'): Promise<void> {
    await db.query(
        `UPDATE public.analysis_pipeline_jobs
         SET status = 'processing', dispatch_state = 'dispatched',
             dispatch_generation = 1, dispatched_at = pg_catalog.clock_timestamp(),
             lease_token = $2,
             lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
         WHERE request_id = $1 AND job_key = $3`,
        [REQUEST_ID, CLAIM_TOKEN, jobKey]
    );
}

async function reserveProvider(input: {
    family?: string;
    digest?: string;
    slot?: string;
    max?: number;
    inputHash?: string;
    reservationToken?: string;
    requestId?: string;
    jobKey?: string;
} = {}): Promise<ReservationJson> {
    const family = input.family ?? 'relationship-followers';
    const result = await serviceQuery<JsonRow<ReservationJson>>(
        `SELECT public.reserve_analysis_v2_provider_run(
            $1, $2, $3, $4, $5, 'apify', 'actor/test', $6, $7, $8
        ) AS result`,
        [
            input.requestId ?? REQUEST_ID,
            input.jobKey ?? 'collect',
            CLAIM_TOKEN,
            `${family}:${input.digest ?? DIGEST}`,
            input.inputHash ?? INPUT_HASH,
            input.slot ?? betaSlots[family] ?? 'primary',
            input.max ?? 0.01,
            input.reservationToken ?? RESERVATION_TOKEN,
        ]
    );
    return result.rows[0].result;
}

async function reserveInitial(
    slot = 'primary',
    inputHash = INPUT_HASH
): Promise<ReservationJson> {
    const result = await serviceQuery<JsonRow<ReservationJson>>(
        `SELECT public.reserve_analysis_preflight_provider_run(
            $1, $2, $3, $4, 0.002600000000
        ) AS result`,
        [PREFLIGHT_ID, CLAIM_TOKEN, inputHash, slot]
    );
    return result.rows[0].result;
}

async function reserveFresh(
    generation: number,
    slot = 'primary',
    inputHash = OTHER_INPUT_HASH
): Promise<ReservationJson> {
    const result = await serviceQuery<JsonRow<ReservationJson>>(
        `SELECT public.reserve_analysis_v2_fresh_admission_provider_run(
            $1, $2, $3, $4, $5, 0.002600000000
        ) AS result`,
        [PREFLIGHT_ID, generation, CLAIM_TOKEN, inputHash, slot]
    );
    return result.rows[0].result;
}

beforeAll(async () => {
    db = await PGlite.create({ extensions: { pgcrypto } });
    await db.exec(bootstrap);
    for (const migration of migrations) {
        await db.exec(migration);
    }
});

beforeEach(async () => {
    await db.exec(`
        DELETE FROM public.analysis_v2_provider_runs;
        DELETE FROM public.analysis_v2_provider_execution_policies;
        DELETE FROM public.analysis_beta_pool_reservations;
        DELETE FROM public.analysis_beta_pool_allocations;
        DELETE FROM public.analysis_pipeline_jobs;
        DELETE FROM public.analysis_preflight_provider_runs;
        DELETE FROM public.analysis_beta_access_grants;
        DELETE FROM public.analysis_preflights;
        DELETE FROM public.analysis_requests;
        DELETE FROM public.users;
        UPDATE public.analysis_apify_credit_snapshots
        SET monthly_limit_usd = NULL, monthly_usage_usd = NULL,
            billing_cycle_start_at = NULL, billing_cycle_end_at = NULL,
            observed_at = NULL, health_state = 'unhealthy';
    `);
});

afterAll(async () => {
    await db?.close();
});

describe('betatest provider policy/guard migration PGlite', () => {
    it('applies after Task 2A/2B1 and validates the policy branch separately', async () => {
        expect(migrationUrls.map(url => url.pathname.split('/').at(-1))).toEqual([
            '20260802010000_add_betatest_apify_credit_pool.sql',
            '20260802010100_validate_betatest_entry_channel_constraints.sql',
            '20260802020000_add_betatest_apify_credit_reservations.sql',
            '20260802030000_bind_betatest_provider_policy.sql',
            '20260802030100_validate_betatest_provider_policy.sql',
        ]);
        const constraint = await db.query<{ validated: boolean }>(
            `SELECT convalidated AS validated
             FROM pg_catalog.pg_constraint
             WHERE conname = 'analysis_v2_provider_execution_policies_branch_check'`
        );
        expect(constraint.rows).toEqual([{ validated: true }]);
    });

    it('keeps legacy senary valid, septenary invalid, and beta secondary invalid', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version,
                plan_access_mode_snapshot, test_entitlement_jti_hash
             ) VALUES ($1, $2, $3, 'pending', 'v2', 'test_entitlement', $4)`,
            [REQUEST_ID, USER_ID, TARGET, JTI_HASH]
        );
        await expect(db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, mode, policy_version, entitlement_jti_hash,
                target_instagram_id, operation_slot_map, policy_hash
             ) VALUES (
                $1, 'test_operation_split', 'authorized-free-e2e-v1', $2,
                $3, $4::JSONB, $5
             )`,
            [REQUEST_ID, JTI_HASH, TARGET, JSON.stringify(legacySlots), 'f'.repeat(64)]
        )).resolves.toBeDefined();

        await db.query('DELETE FROM public.analysis_v2_provider_execution_policies');
        await expect(db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, mode, policy_version, entitlement_jti_hash,
                target_instagram_id, operation_slot_map, policy_hash
             ) VALUES (
                $1, 'test_operation_split', 'authorized-free-e2e-v1', $2,
                $3, $4::JSONB, $5
             )`,
            [
                REQUEST_ID,
                JTI_HASH,
                TARGET,
                JSON.stringify({ ...legacySlots, 'target-comments': 'septenary' }),
                'f'.repeat(64),
            ]
        )).rejects.toThrow(/branch_check/);

        await expect(db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, mode, policy_version, entitlement_jti_hash,
                target_instagram_id, operation_slot_map, policy_hash
             ) VALUES (
                $1, 'betatest_free_pool', 'betatest-free-pool-v1', NULL,
                $2, $3::JSONB, $4
             )`,
            [
                REQUEST_ID,
                TARGET,
                JSON.stringify({ ...betaSlots, 'target-comments': 'secondary' }),
                'f'.repeat(64),
            ]
        )).rejects.toThrow(/branch_check/);
    });

    it('atomically binds beta policy before the first activation completes', async () => {
        await seedPendingBetaRequest();
        const active = await activateBeta();
        expect(active).toMatchObject({
            lifecycleState: 'active',
            operationSlotMap: betaSlots,
        });
        const state = await db.query<{
            channel: string;
            mode: string;
            version: string;
            entitlement: string | null;
            slots: Record<string, string>;
        }>(
            `SELECT request.analysis_entry_channel AS channel,
                    policy.mode, policy.policy_version AS version,
                    policy.entitlement_jti_hash AS entitlement,
                    policy.operation_slot_map AS slots
             FROM public.analysis_requests AS request
             JOIN public.analysis_v2_provider_execution_policies AS policy
               ON policy.request_id = request.id
             WHERE request.id = $1`,
            [REQUEST_ID]
        );
        expect(state.rows).toEqual([{
            channel: 'betatest',
            mode: 'betatest_free_pool',
            version: 'betatest-free-pool-v1',
            entitlement: null,
            slots: betaSlots,
        }]);
    });

    it('rolls back policy/state/channel together when binding conflicts', async () => {
        await seedPendingBetaRequest();
        await db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, mode, policy_version, entitlement_jti_hash,
                target_instagram_id, operation_slot_map, policy_hash
             ) VALUES (
                $1, 'betatest_free_pool', 'betatest-free-pool-v1', NULL,
                $2, $3::JSONB, $4
             )`,
            [REQUEST_ID, TARGET, JSON.stringify(betaSlots), 'f'.repeat(64)]
        );
        await expect(activateBeta()).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT/
        );
        const state = await db.query<{
            lifecycle: string;
            request_id: string | null;
            channel: string;
            reservation_count: number;
        }>(
            `SELECT allocation.lifecycle_state AS lifecycle,
                    allocation.request_id,
                    request.analysis_entry_channel AS channel,
                    (SELECT pg_catalog.count(*)::INTEGER
                     FROM public.analysis_beta_pool_reservations) AS reservation_count
             FROM public.analysis_beta_pool_allocations AS allocation
             JOIN public.analysis_requests AS request ON request.id = $1`,
            [REQUEST_ID]
        );
        expect(state.rows).toEqual([{
            lifecycle: 'preflight_held',
            request_id: null,
            channel: 'standard',
            reservation_count: 1,
        }]);
    });

    it('permits exact active replay after dispatch and rejects missing/corrupt policy', async () => {
        await seedPendingBetaRequest();
        const active = await activateBeta();
        await makeJobLive();
        await expect(activateBeta()).resolves.toEqual(active);

        await db.query(
            `UPDATE public.analysis_v2_provider_execution_policies
             SET policy_hash = $2 WHERE request_id = $1`,
            [REQUEST_ID, 'f'.repeat(64)]
        );
        await expect(activateBeta()).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT/
        );
        await db.query(
            'DELETE FROM public.analysis_v2_provider_execution_policies WHERE request_id = $1',
            [REQUEST_ID]
        );
        await expect(activateBeta()).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT/
        );
    });

    it('accepts beta profile-repair as its own exact reserved family', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await makeJobLive();
        const reserved = await reserveProvider({
            family: 'profile-repair',
            slot: 'septenary',
            max: 0.01,
        });
        expect(reserved).toMatchObject({
            created: true,
            run: {
                operationKey: `profile-repair:${DIGEST}`,
                credentialSlot: 'septenary',
                maxChargeUsd: 0.01,
            },
        });
    });

    it('rejects beta secondary, unknown family, wrong slot, and budget overflow', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await makeJobLive();
        await expect(reserveProvider({ slot: 'secondary' })).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_RUN_SLOT_MISMATCH/
        );
        await expect(reserveProvider({ family: 'unknown' })).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_RUN_OPERATION_INVALID/
        );
        await expect(reserveProvider({ slot: 'quinary' })).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_RUN_SLOT_MISMATCH/
        );
        await expect(reserveProvider({ max: 0.020000000001 })).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_RUN_BUDGET_EXCEEDED/
        );
    });

    it('does not double count exact provider replay but rejects changed identity', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await makeJobLive();
        const first = await reserveProvider({ max: 0.02 });
        await expect(reserveProvider({ max: 0.02 })).resolves.toMatchObject({
            created: false,
            run: first.run,
        });
        await expect(reserveProvider({ max: 0.02, inputHash: OTHER_INPUT_HASH }))
            .rejects.toThrow(/ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT/);
    });

    it('serializes cumulative family headroom so a second operation cannot oversubscribe', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await makeJobLive();
        await reserveProvider({ max: 0.012 });
        await expect(reserveProvider({
            digest: 'f'.repeat(64),
            max: 0.009,
            reservationToken: '50000000-0000-4000-8000-000000000002',
        })).rejects.toThrow(/ANALYSIS_BETA_PROVIDER_RUN_BUDGET_EXCEEDED/);
        const count = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_provider_runs
             WHERE request_id = $1`,
            [REQUEST_ID]
        );
        expect(count.rows).toEqual([{ count: 1 }]);
    });

    it('keeps standard provider reserve and legacy profile-repair alias compatible', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version,
                plan_access_mode_snapshot, test_entitlement_jti_hash
             ) VALUES ($1, $2, $3, 'processing', 'v2', 'test_entitlement', $4)`,
            [REQUEST_ID, USER_ID, TARGET, JTI_HASH]
        );
        await db.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, status, access_mode, consumed_request_id, expires_at
             ) VALUES (
                $1, $2, 'consumed', 'test_entitlement', $3,
                pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
             )`,
            [PREFLIGHT_ID, USER_ID, REQUEST_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs (
                request_id, job_key, status, dispatch_state, lease_token,
                lease_expires_at
             ) VALUES (
                $1, 'collect', 'processing', 'dispatched', $2,
                pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             )`,
            [REQUEST_ID, CLAIM_TOKEN]
        );
        const policyHash = await db.query<{ hash: string }>(
            `SELECT pg_catalog.encode(extensions.digest(
                pg_catalog.convert_to($1 || E'\\n' || $2 || E'\\n' || $3::JSONB::TEXT, 'UTF8'),
                'sha256'
             ), 'hex') AS hash`,
            ['authorized-free-e2e-v1', TARGET, JSON.stringify(legacySlots)]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, mode, policy_version, entitlement_jti_hash,
                target_instagram_id, operation_slot_map, policy_hash
             ) VALUES (
                $1, 'test_operation_split', 'authorized-free-e2e-v1', $2,
                $3, $4::JSONB, $5
             )`,
            [REQUEST_ID, JTI_HASH, TARGET, JSON.stringify(legacySlots), policyHash.rows[0].hash]
        );
        await expect(reserveProvider({
            family: 'profile-repair',
            slot: 'primary',
            max: 0.01,
        })).resolves.toMatchObject({ created: true });
    });

    it('allows only initial plus fresh generation one within the held .0052', async () => {
        await seedPendingBetaPreflight();
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'processing', lease_token = $2,
                 lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             WHERE id = $1`,
            [PREFLIGHT_ID, CLAIM_TOKEN]
        );
        await expect(reserveInitial()).resolves.toMatchObject({ created: true });
        await expect(reserveInitial()).resolves.toMatchObject({ created: false });

        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'ready', lease_token = NULL, lease_expires_at = NULL,
                 admission_status = 'processing', admission_generation = 1,
                 admission_requested_at = pg_catalog.clock_timestamp(),
                 admission_claim_token = $2,
                 admission_lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             WHERE id = $1`,
            [PREFLIGHT_ID, CLAIM_TOKEN]
        );
        await expect(reserveFresh(1)).resolves.toMatchObject({ created: true });
        await expect(reserveFresh(1)).resolves.toMatchObject({ created: false });

        await db.query(
            `UPDATE public.analysis_preflights
             SET admission_generation = 2,
                 admission_requested_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [PREFLIGHT_ID]
        );
        await expect(reserveFresh(2)).rejects.toThrow(
            /ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_GENERATION_INVALID/
        );
        const total = await db.query<{ total: string; count: number }>(
            `SELECT pg_catalog.sum(max_charge_usd) AS total,
                    pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_preflight_provider_runs
             WHERE preflight_id = $1`,
            [PREFLIGHT_ID]
        );
        expect(total.rows).toEqual([{ total: '0.005200000000', count: 2 }]);
    });

    it('rejects a beta preflight wrong/free-ineligible slot without a ledger row', async () => {
        await seedPendingBetaPreflight();
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'processing', lease_token = $2,
                 lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             WHERE id = $1`,
            [PREFLIGHT_ID, CLAIM_TOKEN]
        );
        await expect(reserveInitial('secondary')).rejects.toThrow(
            /ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_SLOT_MISMATCH/
        );
        const count = await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_preflight_provider_runs'
        );
        expect(count.rows).toEqual([{ count: 0 }]);
    });

    it('returns beta policy in collection context and rejects ordinary production policy', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await makeJobLive();
        const context = await serviceQuery<JsonRow<{
            accessMode: string;
            providerExecutionPolicy: { mode: string; policyVersion: string };
        }>>(
            `SELECT public.load_analysis_v2_collection_context_with_policy(
                $1, 'collect', $2, $3
            ) AS result`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH]
        );
        expect(context.rows[0].result).toMatchObject({
            accessMode: 'production',
            providerExecutionPolicy: {
                mode: 'betatest_free_pool',
                policyVersion: 'betatest-free-pool-v1',
            },
        });

        await db.query(
            `UPDATE public.analysis_requests SET analysis_entry_channel = 'standard'
             WHERE id = $1`,
            [REQUEST_ID]
        );
        await expect(serviceQuery(
            `SELECT public.load_analysis_v2_collection_context_with_policy(
                $1, 'collect', $2, $3
            )`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH]
        )).rejects.toThrow(/ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH/);

        await db.query(
            `UPDATE public.analysis_requests SET analysis_entry_channel = 'betatest'
             WHERE id = $1`,
            [REQUEST_ID]
        );
        await db.query(
            'DELETE FROM public.analysis_v2_provider_execution_policies WHERE request_id = $1',
            [REQUEST_ID]
        );
        await expect(serviceQuery(
            `SELECT public.load_analysis_v2_collection_context_with_policy(
                $1, 'collect', $2, $3
            )`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH]
        )).rejects.toThrow(/ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH/);
    });

    it('denies direct policy and beta-credit DML without changing state', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        const allocation = await db.query<{
            id: string;
            lifecycle: string;
            policy_hash: string;
            reservation_count: number;
        }>(
            `SELECT allocation.id,
                    allocation.lifecycle_state AS lifecycle,
                    policy.policy_hash,
                    (SELECT pg_catalog.count(*)::INTEGER
                     FROM public.analysis_beta_pool_reservations AS reservation
                     WHERE reservation.allocation_id = allocation.id) AS reservation_count
             FROM public.analysis_beta_pool_allocations AS allocation
             JOIN public.analysis_v2_provider_execution_policies AS policy
               ON policy.request_id = allocation.request_id
             WHERE allocation.request_id = $1`,
            [REQUEST_ID]
        );
        const before = allocation.rows[0];
        expect(before).toBeDefined();

        const attempts: Array<{ sql: string; params: unknown[] }> = [
            {
                sql: `INSERT INTO public.analysis_v2_provider_execution_policies (
                    request_id, mode, policy_version, entitlement_jti_hash,
                    target_instagram_id, operation_slot_map, policy_hash
                ) VALUES ($1, 'betatest_free_pool', 'betatest-free-pool-v1',
                    NULL, $2, $3::JSONB, $4)`,
                params: [REQUEST_ID, TARGET, JSON.stringify(betaSlots), 'f'.repeat(64)],
            },
            {
                sql: `UPDATE public.analysis_v2_provider_execution_policies
                      SET policy_hash = $2 WHERE request_id = $1`,
                params: [REQUEST_ID, 'f'.repeat(64)],
            },
            {
                sql: 'DELETE FROM public.analysis_v2_provider_execution_policies WHERE request_id = $1',
                params: [REQUEST_ID],
            },
            {
                sql: `INSERT INTO public.analysis_beta_pool_allocations (
                    id, preflight_id, user_id, lifecycle_state, expires_at
                ) VALUES ($1, $2, $3, 'preflight_held',
                    pg_catalog.clock_timestamp() + INTERVAL '1 hour')`,
                params: [
                    '60000000-0000-4000-8000-000000000001',
                    PREFLIGHT_ID,
                    USER_ID,
                ],
            },
            {
                sql: `UPDATE public.analysis_beta_pool_allocations
                      SET lifecycle_state = 'preflight_held' WHERE id = $1`,
                params: [before.id],
            },
            {
                sql: 'DELETE FROM public.analysis_beta_pool_allocations WHERE id = $1',
                params: [before.id],
            },
            {
                sql: `INSERT INTO public.analysis_beta_pool_reservations (
                    allocation_id, operation_family, credential_slot,
                    reserved_usd, lifecycle_state
                ) VALUES ($1, 'target-profile', 'primary',
                    0.005200000000, 'active')`,
                params: [before.id],
            },
            {
                sql: `UPDATE public.analysis_beta_pool_reservations
                      SET reserved_usd = 0.005100000000
                      WHERE allocation_id = $1 AND operation_family = 'target-profile'`,
                params: [before.id],
            },
            {
                sql: `DELETE FROM public.analysis_beta_pool_reservations
                      WHERE allocation_id = $1 AND operation_family = 'target-profile'`,
                params: [before.id],
            },
        ];

        for (const role of ['service_role', 'authenticated'] as const) {
            for (const attempt of attempts) {
                await db.exec(`SET ROLE ${role}`);
                try {
                    await expect(db.query(attempt.sql, attempt.params))
                        .rejects.toThrow(/permission denied/i);
                } finally {
                    await db.exec('RESET ROLE');
                }
            }
        }

        const after = await db.query<{
            id: string;
            lifecycle: string;
            policy_hash: string;
            reservation_count: number;
        }>(
            `SELECT allocation.id,
                    allocation.lifecycle_state AS lifecycle,
                    policy.policy_hash,
                    (SELECT pg_catalog.count(*)::INTEGER
                     FROM public.analysis_beta_pool_reservations AS reservation
                     WHERE reservation.allocation_id = allocation.id) AS reservation_count
             FROM public.analysis_beta_pool_allocations AS allocation
             JOIN public.analysis_v2_provider_execution_policies AS policy
               ON policy.request_id = allocation.request_id
             WHERE allocation.request_id = $1`,
            [REQUEST_ID]
        );
        expect(after.rows).toEqual([before]);

        for (const table of [
            'analysis_v2_provider_execution_policies',
            'analysis_beta_pool_allocations',
            'analysis_beta_pool_reservations',
        ]) {
            await expect(serviceQuery(`SELECT * FROM public.${table}`))
                .rejects.toThrow(/permission denied/i);
        }
        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(
                `SELECT public.activate_analysis_beta_apify_request_credit(
                    $1, $2, $3, 'standard', $4::JSONB, $5::JSONB, 300
                )`,
                [
                    PREFLIGHT_ID,
                    REQUEST_ID,
                    USER_ID,
                    JSON.stringify(betaSlots),
                    JSON.stringify(betaBudgets),
                ]
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });
});
