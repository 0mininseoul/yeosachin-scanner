import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260715103605_expose_v2_access_mode_to_collection_context.sql',
        import.meta.url
    ),
    'utf8'
);

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const REQUEST_ID = '20000000-0000-4000-8000-000000000001';
const PRODUCTION_REQUEST_ID = '20000000-0000-4000-8000-000000000002';
const PREFLIGHT_ID = '30000000-0000-4000-8000-000000000001';
const PRODUCTION_PREFLIGHT_ID = '30000000-0000-4000-8000-000000000002';
const CLAIM_TOKEN = '40000000-0000-4000-8000-000000000001';
const ADMISSION_TOKEN = '50000000-0000-4000-8000-000000000001';
const RESERVATION_TOKEN = '60000000-0000-4000-8000-000000000001';
const INPUT_HASH = 'a'.repeat(64);
const JTI_HASH = 'b'.repeat(64);
const OTHER_JTI_HASH = 'c'.repeat(64);
const OPERATION_DIGEST = 'd'.repeat(64);
const TARGET = '0_min._.00';
const JOB_KEY = 'collect_relationships';
const POLICY_VERSION = 'authorized-free-e2e-v1';

const operationSlots = {
    'target-profile': 'tertiary',
    'relationship-followers': 'primary',
    'relationship-following': 'secondary',
    'profile-fallback': 'tertiary',
    'target-likers': 'quaternary',
    'target-comments': 'tertiary',
    'candidate-likers': 'quinary',
} as const;

const changedOperationSlots = {
    ...operationSlots,
    'target-comments': 'secondary',
} as const;

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot(p_slot TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_slot IN ('primary', 'secondary', 'tertiary', 'quaternary', 'quinary'),
        FALSE
    );
$$;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    target_instagram_id TEXT NOT NULL,
    status TEXT NOT NULL,
    background_processing BOOLEAN NOT NULL DEFAULT FALSE,
    pipeline_version TEXT,
    plan_access_mode_snapshot TEXT,
    test_entitlement_jti_hash VARCHAR(64),
    selected_plan_id_snapshot TEXT,
    analysis_scope_snapshot JSONB,
    excluded_instagram_id TEXT,
    consume_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    consumed_request_id UUID UNIQUE REFERENCES public.analysis_requests(id),
    status TEXT NOT NULL,
    target_instagram_id TEXT,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    excluded_instagram_id TEXT,
    access_mode TEXT
);

CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    dispatch_state TEXT NOT NULL DEFAULT 'pending',
    input_hash VARCHAR(64) NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, job_key)
);

CREATE TABLE public.analysis_v2_provider_runs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    credential_slot TEXT NOT NULL,
    PRIMARY KEY (request_id, job_key, operation_key)
);

CREATE TABLE public.analysis_v2_provider_cleanup_intents (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE OR REPLACE FUNCTION public.consume_analysis_v2_test_entitlement(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT,
    p_admission_token UUID
)
RETURNS TABLE(
    request_id UUID,
    created BOOLEAN,
    initial_job_key TEXT,
    request_status TEXT,
    background_processing BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
BEGIN
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_preflights AS preflight
    JOIN public.analysis_requests AS analysis_request
      ON analysis_request.id = preflight.consumed_request_id
    WHERE preflight.id = p_preflight_id;

    IF NOT FOUND OR p_admission_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'TEST_ENTITLEMENT_STUB_MISMATCH', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_requests
    SET consume_count = consume_count + 1
    WHERE id = v_request.id
    RETURNING * INTO v_request;

    RETURN QUERY SELECT
        v_request.id,
        FALSE,
        'collect_relationships'::TEXT,
        v_request.status,
        v_request.background_processing;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_reserve_provider_run_internal(
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
RETURNS JSONB
LANGUAGE sql
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'jobKey', p_job_key,
        'claimToken', p_claim_token,
        'operationKey', p_operation_key,
        'inputHash', p_input_hash,
        'logicalProvider', p_logical_provider,
        'actorId', p_actor_id,
        'credentialSlot', p_credential_slot,
        'maxChargeUsd', p_max_charge_usd,
        'reservationToken', p_reservation_token
    );
$$;
`;

interface JsonRow<T> {
    result: T;
}

interface ConsumeRow {
    request_id: string;
    created: boolean;
    initial_job_key: string;
    request_status: string;
    background_processing: boolean;
}

interface ProviderPolicyJson {
    mode: string;
    policyVersion: string;
    operationSlots: Record<string, string>;
}

interface CollectionContextJson {
    requestId: string;
    targetUsername: string;
    excludedUsername: string | null;
    accessMode: string;
    providerExecutionPolicy: ProviderPolicyJson | null;
    planId: string;
    followersDeclaredCount: number;
    followingDeclaredCount: number;
    detailedMutualLimit: number;
}

interface ReservationJson {
    requestId: string;
    operationKey: string;
    credentialSlot: string;
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

async function consumeAuthorized(
    preflightId = PREFLIGHT_ID,
    userId = USER_ID,
    jtiHash = JTI_HASH,
    target = TARGET,
    slots: Record<string, string> = operationSlots
): Promise<Results<ConsumeRow>> {
    return serviceQuery<ConsumeRow>(
        `SELECT * FROM public.consume_analysis_v2_authorized_test_entitlement(
            $1, $2, 'standard', $3, $4, $5, $6, $7::JSONB
        )`,
        [
            preflightId,
            userId,
            jtiHash,
            ADMISSION_TOKEN,
            target,
            POLICY_VERSION,
            JSON.stringify(slots),
        ]
    );
}

async function reserve(
    credentialSlot: string,
    operationKind = 'relationship-followers'
): Promise<ReservationJson> {
    const result = await serviceQuery<JsonRow<ReservationJson>>(
        `SELECT public.reserve_analysis_v2_provider_run(
            $1, $2, $3, $4, $5, 'apify', 'actor/test', $6, 0.01, $7
        ) AS result`,
        [
            REQUEST_ID,
            JOB_KEY,
            CLAIM_TOKEN,
            `${operationKind}:${OPERATION_DIGEST}`,
            INPUT_HASH,
            credentialSlot,
            RESERVATION_TOKEN,
        ]
    );
    return result.rows[0].result;
}

async function seedRequests(): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_requests (
            id, user_id, target_instagram_id, status, background_processing,
            pipeline_version, plan_access_mode_snapshot, test_entitlement_jti_hash,
            selected_plan_id_snapshot, analysis_scope_snapshot
        ) VALUES
        (
            $1, $2, $3, 'pending', FALSE, 'v2', 'test_entitlement', $4,
            'standard', $5::JSONB
        ),
        (
            $6, $2, $3, 'pending', FALSE, 'v2', 'production', NULL,
            'standard', $5::JSONB
        )`,
        [
            REQUEST_ID,
            USER_ID,
            TARGET,
            JTI_HASH,
            JSON.stringify({
                relationshipCapacity: { followers: 800, following: 800 },
                detailedMutualLimit: 600,
            }),
            PRODUCTION_REQUEST_ID,
        ]
    );
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, consumed_request_id, status, target_instagram_id,
            target_followers_count, target_following_count, access_mode
        ) VALUES
        ($1, $2, 'consumed', $3, 471, 637, 'test_entitlement'),
        ($4, $5, 'consumed', $3, 471, 637, 'production')`,
        [
            PREFLIGHT_ID,
            REQUEST_ID,
            TARGET,
            PRODUCTION_PREFLIGHT_ID,
            PRODUCTION_REQUEST_ID,
        ]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs (
            request_id, job_key, status, dispatch_state, input_hash
        ) VALUES ($1, $2, 'pending', 'pending', $3)`,
        [REQUEST_ID, JOB_KEY, INPUT_HASH]
    );
}

describe('authorized test provider policy migration PGlite contract', () => {
    beforeAll(async () => {
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(bootstrap);
        await db.exec(migration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE public.analysis_v2_provider_execution_policies,
                public.analysis_v2_provider_cleanup_intents,
                public.analysis_v2_provider_runs,
                public.analysis_pipeline_jobs,
                public.analysis_preflights,
                public.analysis_requests
        `);
        await seedRequests();
    });

    afterAll(async () => {
        await db.close();
    });

    it('atomically binds an exact test entitlement policy and replays it idempotently', async () => {
        const first = await consumeAuthorized();
        expect(first.rows).toEqual([{
            request_id: REQUEST_ID,
            created: false,
            initial_job_key: JOB_KEY,
            request_status: 'pending',
            background_processing: false,
        }]);

        const replay = await consumeAuthorized();
        expect(replay.rows).toEqual(first.rows);

        const stored = await db.query<{
            request_id: string;
            entitlement_jti_hash: string;
            target_instagram_id: string;
            operation_slot_map: Record<string, string>;
        }>(
            `SELECT request_id, entitlement_jti_hash, target_instagram_id,
                    operation_slot_map
             FROM public.analysis_v2_provider_execution_policies`
        );
        expect(stored.rows).toEqual([{
            request_id: REQUEST_ID,
            entitlement_jti_hash: JTI_HASH,
            target_instagram_id: TARGET,
            operation_slot_map: operationSlots,
        }]);

        const consumeCount = await db.query<{ consume_count: number }>(
            'SELECT consume_count FROM public.analysis_requests WHERE id = $1',
            [REQUEST_ID]
        );
        expect(consumeCount.rows).toEqual([{ consume_count: 2 }]);
    });

    it('rejects owner, target, JTI, changed-map, and production scope mismatches atomically', async () => {
        await consumeAuthorized();

        await expect(consumeAuthorized(
            PREFLIGHT_ID,
            OTHER_USER_ID
        )).rejects.toThrow(/ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SCOPE_MISMATCH/);
        await expect(consumeAuthorized(
            PREFLIGHT_ID,
            USER_ID,
            JTI_HASH,
            'different_target'
        )).rejects.toThrow(/ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SCOPE_MISMATCH/);
        await expect(consumeAuthorized(
            PREFLIGHT_ID,
            USER_ID,
            OTHER_JTI_HASH
        )).rejects.toThrow(/ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SCOPE_MISMATCH/);
        await expect(consumeAuthorized(
            PREFLIGHT_ID,
            USER_ID,
            JTI_HASH,
            TARGET,
            changedOperationSlots
        )).rejects.toThrow(/ANALYSIS_V2_AUTHORIZED_TEST_POLICY_CONFLICT/);
        await expect(consumeAuthorized(
            PRODUCTION_PREFLIGHT_ID,
            USER_ID
        )).rejects.toThrow(/ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SCOPE_MISMATCH/);

        const counts = await db.query<{ id: string; consume_count: number }>(
            `SELECT id, consume_count
             FROM public.analysis_requests
             ORDER BY id`
        );
        expect(counts.rows).toEqual([
            { id: REQUEST_ID, consume_count: 1 },
            { id: PRODUCTION_REQUEST_ID, consume_count: 0 },
        ]);
    });

    it('denies service-role direct policy reads', async () => {
        await consumeAuthorized();
        await expect(serviceQuery(
            'SELECT * FROM public.analysis_v2_provider_execution_policies'
        )).rejects.toThrow(/permission denied/i);
    });

    it('returns access mode and the bound policy for an exact live collection claim', async () => {
        await consumeAuthorized();
        await db.query(
            `UPDATE public.analysis_requests
             SET status = 'processing', background_processing = TRUE
             WHERE id = $1`,
            [REQUEST_ID]
        );
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET status = 'processing', dispatch_state = 'delivered',
                 lease_token = $3,
                 lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             WHERE request_id = $1 AND job_key = $2`,
            [REQUEST_ID, JOB_KEY, CLAIM_TOKEN]
        );

        const result = await serviceQuery<JsonRow<CollectionContextJson>>(
            `SELECT public.load_analysis_v2_collection_context_with_policy(
                $1, $2, $3, $4
            ) AS result`,
            [REQUEST_ID, JOB_KEY, CLAIM_TOKEN, INPUT_HASH]
        );
        expect(result.rows[0].result).toEqual({
            requestId: REQUEST_ID,
            targetUsername: TARGET,
            excludedUsername: null,
            accessMode: 'test_entitlement',
            providerExecutionPolicy: {
                mode: 'test_operation_split',
                policyVersion: POLICY_VERSION,
                operationSlots,
            },
            planId: 'standard',
            followersDeclaredCount: 471,
            followingDeclaredCount: 637,
            detailedMutualLimit: 600,
        });
    });

    it('allows only the slot bound to the provider operation prefix', async () => {
        await consumeAuthorized();

        const reservation = await reserve('primary');
        expect(reservation).toMatchObject({
            requestId: REQUEST_ID,
            operationKey: `relationship-followers:${OPERATION_DIGEST}`,
            credentialSlot: 'primary',
        });

        await expect(reserve('secondary')).rejects.toThrow(
            /ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SLOT_MISMATCH/
        );
        await expect(reserve('primary', 'relationship-following')).rejects.toThrow(
            /ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SLOT_MISMATCH/
        );
        expect(await reserve('tertiary', 'target-profile')).toMatchObject({
            credentialSlot: 'tertiary',
        });
    });
});
