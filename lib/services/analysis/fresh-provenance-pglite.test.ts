import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
    FreshProvenanceStore,
    type FreshProvenanceRpcClient,
} from './fresh-provenance-store';

// This is intentionally the complete forward migration, not a copied SQL
// fragment. The predecessor fixture only supplies the already-migrated schema
// dependencies that existed immediately before this migration.
const forwardMigration = readFileSync(
    new URL('../../../supabase/migrations/20260811090000_harden_fresh_provenance.sql', import.meta.url),
    'utf8',
);

const requestId = '11111111-1111-4111-8111-111111111111';
const preflightId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const claimToken = '44444444-4444-4444-8444-444444444444';
const jobKey = 'track:relationships:collect';
const jobInputHash = 'a'.repeat(64);
const providerInputHash = 'b'.repeat(64);
const operationKey = `relationship-followers:${'c'.repeat(64)}`;
const runId = 'FreshApifyRun1234';
const datasetId = 'FreshDataset1234';
const hash = (character: string) => character.repeat(64);
const databases: PGlite[] = [];

const predecessorSchema = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE EXTENSION pgcrypto;
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.digest(text, text) RETURNS bytea
LANGUAGE sql AS $$ SELECT public.digest($1, $2) $$;
CREATE FUNCTION extensions.digest(bytea, text) RETURNS bytea
LANGUAGE sql AS $$ SELECT public.digest($1, $2) $$;

CREATE TABLE public.analysis_requests (
    id uuid PRIMARY KEY,
    preflight_id uuid NOT NULL,
    user_id uuid NOT NULL,
    pipeline_version text NOT NULL,
    plan_access_mode_snapshot text NOT NULL,
    selected_plan_id_snapshot text NOT NULL,
    status text NOT NULL,
    background_processing boolean NOT NULL DEFAULT true,
    progress_step text NOT NULL DEFAULT 'running',
    current_step text NOT NULL DEFAULT 'running',
    error_message text,
    completed_at timestamptz,
    created_at timestamptz NOT NULL
);
CREATE TABLE public.analysis_preflights (
    id uuid PRIMARY KEY,
    consumed_request_id uuid UNIQUE,
    status text NOT NULL,
    access_mode text NOT NULL,
    target_input_hash text NOT NULL,
    admission_refreshed_at timestamptz NOT NULL
);
CREATE TABLE public.analysis_pipeline_jobs (
    request_id uuid NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key text NOT NULL,
    input_hash text NOT NULL,
    status text NOT NULL,
    dispatch_state text,
    lease_token uuid,
    lease_expires_at timestamptz,
    PRIMARY KEY (request_id, job_key)
);
GRANT SELECT, UPDATE ON public.analysis_pipeline_jobs TO service_role;
CREATE TABLE public.analysis_v2_provider_runs (
    request_id uuid NOT NULL,
    job_key text NOT NULL,
    operation_key text NOT NULL,
    input_hash text NOT NULL,
    job_claim_token uuid NOT NULL,
    logical_provider text NOT NULL,
    status text NOT NULL,
    run_id text,
    reserved_at timestamptz NOT NULL,
    run_started_at timestamptz,
    PRIMARY KEY (request_id, job_key, operation_key),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE CASCADE
);
CREATE TABLE public.analysis_v2_provider_execution_policies (
    request_id uuid PRIMARY KEY REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    mode text NOT NULL,
    policy_version text NOT NULL,
    operation_slot_map jsonb NOT NULL DEFAULT '{}'::jsonb,
    policy_hash text NOT NULL DEFAULT '${hash('p')}'
);

-- Exact predecessor shape from the published 20260810090000 migration plus
-- the later cost-ledger columns consumed by the forward hardening migration.
CREATE TABLE public.analysis_revenue_run_ledgers (
    request_id uuid PRIMARY KEY,
    preflight_id uuid NOT NULL,
    user_id uuid NOT NULL,
    plan_id text NOT NULL CHECK (plan_id IN ('basic', 'standard')),
    access_mode text NOT NULL CHECK (access_mode = 'test_entitlement'),
    target_username_hmac text NOT NULL CHECK (target_username_hmac ~ '^[a-f0-9]{64}$'),
    preflight_refreshed_at timestamptz NOT NULL,
    request_started_at timestamptz NOT NULL,
    fresh_provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
    cost_cap_krw integer NOT NULL CHECK (cost_cap_krw IN (1808, 3634)),
    reserved_cost_krw integer NOT NULL DEFAULT 0,
    actual_cost_krw integer NOT NULL DEFAULT 0,
    public_mutual_count integer,
    screened_count integer,
    not_screened_count integer,
    unknown_burden_count integer,
    result_revision_id uuid,
    image_manifest_id uuid,
    content_hash text,
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'manual_review', 'failed')),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    completed_at timestamptz,
    manual_review_reason text CHECK (manual_review_reason IN (
        'cost_denied', 'cost_overrun', 'ambiguous_external_call', 'routing_failure'
    )),
    CONSTRAINT analysis_revenue_run_ledgers_request_id_fkey
        FOREIGN KEY (request_id) REFERENCES public.analysis_requests(id) ON DELETE CASCADE
);
ALTER TABLE public.analysis_revenue_run_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_run_ledgers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.analysis_revenue_run_ledgers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.analysis_revenue_run_ledgers TO service_role;

CREATE FUNCTION public.analysis_v2_valid_profile_username_list(
    p_usernames text[], p_allow_empty boolean
) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT p_usernames IS NOT NULL
       AND (p_allow_empty OR pg_catalog.cardinality(p_usernames) > 0)
       AND pg_catalog.cardinality(p_usernames) BETWEEN 0 AND 30
       AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.unnest(p_usernames) AS username(value)
           WHERE username.value !~ '^[a-z0-9._]{1,30}$'
       )
       AND pg_catalog.cardinality(p_usernames) = (
           SELECT pg_catalog.count(DISTINCT username.value)
           FROM pg_catalog.unnest(p_usernames) AS username(value)
       )
$$;
CREATE FUNCTION public.analysis_v2_valid_profile_outcomes(
    p_outcomes jsonb, p_expected_usernames text[], p_attempt text
) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT p_attempt = 'fallback'
       AND public.analysis_v2_valid_profile_username_list(p_expected_usernames, FALSE)
       AND pg_catalog.jsonb_typeof(p_outcomes) = 'array'
       AND pg_catalog.jsonb_array_length(p_outcomes) = pg_catalog.cardinality(p_expected_usernames)
       AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_array_elements(p_outcomes)
               WITH ORDINALITY AS outcome(value, ordinal)
           WHERE outcome.value->>'username' IS DISTINCT FROM p_expected_usernames[outcome.ordinal::integer]
              OR outcome.value->>'source' IS DISTINCT FROM 'apify'
              OR outcome.value->>'status' NOT IN ('success', 'unavailable', 'failed')
              OR pg_catalog.jsonb_typeof(outcome.value->'request_count') IS DISTINCT FROM 'number'
              OR pg_catalog.jsonb_typeof(outcome.value->'latency_ms') IS DISTINCT FROM 'number'
              OR pg_catalog.jsonb_typeof(outcome.value->'captured_at') IS DISTINCT FROM 'string'
       )
$$;
CREATE TABLE public.analysis_v2_profile_fetch_batches (
    request_id uuid NOT NULL,
    job_key text NOT NULL,
    requested_usernames text[] NOT NULL,
    frozen_unresolved_usernames text[] NOT NULL,
    primary_payload_hash varchar(64) NOT NULL,
    fallback_payload_hash varchar(64),
    primary_completed_at timestamptz NOT NULL,
    fallback_completed_at timestamptz,
    repair_usernames text[],
    repair_payload_hash varchar(64),
    repair_completed_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (request_id, job_key),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE CASCADE
);
CREATE TABLE public.analysis_v2_profile_fetch_outcomes (
    request_id uuid NOT NULL,
    job_key text NOT NULL,
    attempt varchar(16) NOT NULL,
    ordinal smallint NOT NULL,
    username varchar(30) NOT NULL,
    source varchar(16) NOT NULL,
    status varchar(16) NOT NULL,
    failure_category varchar(32),
    http_status smallint,
    request_count smallint NOT NULL,
    latency_ms integer NOT NULL,
    captured_at timestamptz NOT NULL,
    profile_snapshot jsonb,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, attempt, username),
    CONSTRAINT analysis_v2_profile_outcomes_attempt_check CHECK (
        attempt IN ('primary', 'fallback', 'repair')
    ),
    CONSTRAINT analysis_v2_profile_outcomes_source_check CHECK (
        (attempt = 'primary' AND source IN ('cache', 'selfhosted'))
        OR (attempt IN ('fallback', 'repair') AND source = 'apify')
    )
);

-- These are the published scheduler RPC identities immediately before the
-- forward hardening migration. Their bodies are intentionally inert: PGlite
-- exercises the newly-installed service_role wrappers and their guards, while
-- the production implementation remains supplied by the full predecessor
-- migration chain.
CREATE FUNCTION public.reserve_analysis_v2_job_dispatch(uuid, text, uuid)
RETURNS TABLE(reserved boolean, dispatch_generation integer, reservation_token uuid, job_status text, dispatch_state text, task_name text)
LANGUAGE sql AS $$ SELECT FALSE, 0, NULL::uuid, NULL::text, NULL::text, NULL::text $$;
CREATE FUNCTION public.mark_analysis_v2_job_dispatched(uuid, text, integer, uuid, text)
RETURNS TABLE(marked boolean, job_status text, dispatch_state text, task_name text)
LANGUAGE sql AS $$ SELECT FALSE, NULL::text, NULL::text, NULL::text $$;
CREATE FUNCTION public.rearm_analysis_v2_job_dispatch(uuid, text, integer, uuid, uuid)
RETURNS TABLE(rearmed boolean, dispatch_generation integer, reservation_token uuid, job_status text, dispatch_state text)
LANGUAGE sql AS $$ SELECT FALSE, 0, NULL::uuid, NULL::text, NULL::text $$;
CREATE FUNCTION public.claim_analysis_v2_job(uuid, text, integer, uuid, uuid, integer, integer)
RETURNS TABLE(claimed boolean, job_status text, attempt_count integer, lease_expires_at timestamptz, track text, job_kind text, batch integer, input_hash text)
LANGUAGE sql AS $$ SELECT FALSE, NULL::text, 0, NULL::timestamptz, NULL::text, NULL::text, 0, NULL::text $$;
CREATE FUNCTION public.continue_analysis_v2_scheduler_job(uuid, text, uuid, uuid, text, integer)
RETURNS TABLE(reserved boolean, dispatch_generation integer, reservation_token uuid, job_status text, dispatch_state text, task_name text, attempt_count integer, request_status text)
LANGUAGE sql AS $$ SELECT FALSE, 0, NULL::uuid, NULL::text, NULL::text, NULL::text, 0, NULL::text $$;
`;

async function createDb(): Promise<PGlite> {
    const db = await PGlite.create({ extensions: { pgcrypto } });
    databases.push(db);
    await db.exec(predecessorSchema);
    await db.exec(forwardMigration);
    return db;
}

async function query<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<Results<T>> {
    return db.query<T>(sql, params);
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated' | 'service_role', fn: () => Promise<T>): Promise<T> {
    await db.exec(`SET ROLE ${role}`);
    try {
        return await fn();
    } finally {
        await db.exec('RESET ROLE');
    }
}

type FreshRpcName =
    | 'assert_analysis_revenue_fresh_provider_admission_v1'
    | 'record_analysis_revenue_fresh_provider_evidence_v1'
    | 'bind_analysis_revenue_fresh_provider_dataset_v1';

const freshRpcCalls: Record<FreshRpcName, readonly [string, readonly string[]]> = {
    assert_analysis_revenue_fresh_provider_admission_v1: [
        'SELECT public.assert_analysis_revenue_fresh_provider_admission_v1($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text) AS result',
        ['p_request_id', 'p_job_key', 'p_job_claim_token', 'p_job_input_hash', 'p_operation_key', 'p_provider_input_hash'],
    ],
    record_analysis_revenue_fresh_provider_evidence_v1: [
        'SELECT public.record_analysis_revenue_fresh_provider_evidence_v1($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::text) AS result',
        ['p_request_id', 'p_job_key', 'p_job_claim_token', 'p_job_input_hash', 'p_operation_key', 'p_provider_input_hash', 'p_provider_run_hash'],
    ],
    bind_analysis_revenue_fresh_provider_dataset_v1: [
        'SELECT public.bind_analysis_revenue_fresh_provider_dataset_v1($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::text,$8::text) AS result',
        ['p_request_id', 'p_job_key', 'p_job_claim_token', 'p_job_input_hash', 'p_operation_key', 'p_provider_input_hash', 'p_provider_run_hash', 'p_provider_dataset_hash'],
    ],
};

async function serviceFreshRpc(
    db: PGlite,
    name: FreshRpcName,
    params: Record<string, unknown>,
): Promise<unknown> {
    const [sql, keys] = freshRpcCalls[name];
    return asRole(db, 'service_role', async () => {
        const result = await query<{ result: unknown }>(db, sql, keys.map(key => params[key]));
        return result.rows[0]?.result ?? null;
    });
}

function rpcClient(db: PGlite): FreshProvenanceRpcClient {
    return {
        async rpc(name, params) {
            if (!(name in freshRpcCalls)) {
                return { data: null, error: { code: 'PGRST202', message: 'unknown RPC' } };
            }
            try {
                return {
                    data: await serviceFreshRpc(db, name as FreshRpcName, params),
                    error: null,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : 'unknown';
                return {
                    data: null,
                    error: {
                        code: 'P0001',
                        message: message.match(/FRESH_PROVENANCE_[A-Z_]+/)?.[0] ?? message,
                    },
                };
            }
        },
    };
}

async function seed(db: PGlite): Promise<void> {
    await db.exec(`
        INSERT INTO public.analysis_requests(
            id,preflight_id,user_id,pipeline_version,plan_access_mode_snapshot,
            selected_plan_id_snapshot,status,background_processing,progress_step,current_step,created_at
        ) VALUES (
            '${requestId}','${preflightId}','${userId}','v2','test_entitlement',
            'basic','processing',TRUE,'running','running','2026-08-10T00:01:00Z'
        );
        INSERT INTO public.analysis_preflights(
            id,consumed_request_id,status,access_mode,target_input_hash,admission_refreshed_at
        ) VALUES (
            '${preflightId}','${requestId}','consumed','test_entitlement','${hash('d')}','2026-08-10T00:00:00Z'
        );
        INSERT INTO public.analysis_revenue_run_ledgers(
            request_id,preflight_id,user_id,plan_id,access_mode,target_username_hmac,
            preflight_refreshed_at,request_started_at,cost_cap_krw
        ) VALUES (
            '${requestId}','${preflightId}','${userId}','basic','test_entitlement','${hash('d')}',
            '2026-08-10T00:00:00Z','2026-08-10T00:01:00Z',1808
        );
        INSERT INTO public.analysis_pipeline_jobs(
            request_id,job_key,input_hash,status,dispatch_state,lease_token,lease_expires_at
        ) VALUES (
            '${requestId}','${jobKey}','${jobInputHash}','processing',NULL,'${claimToken}','2099-01-01T00:00:00Z'
        );
        INSERT INTO public.analysis_v2_provider_execution_policies(
            request_id,mode,policy_version
        ) VALUES (
            '${requestId}','test_operation_split','authorized-free-e2e-v1'
        );
        INSERT INTO public.analysis_v2_provider_runs(
            request_id,job_key,operation_key,input_hash,job_claim_token,logical_provider,status,
            run_id,reserved_at,run_started_at
        ) VALUES (
            '${requestId}','${jobKey}','${operationKey}','${providerInputHash}','${claimToken}','apify','running',
            '${runId}','2026-08-10T00:02:00Z','2026-08-10T00:03:00Z'
        );
    `);
}

function store(db: PGlite): FreshProvenanceStore {
    return new FreshProvenanceStore(rpcClient(db));
}

function identity() {
    return {
        requestId,
        jobKey,
        jobClaimToken: claimToken,
        jobInputHash,
        operationKey,
        providerInputHash,
        runId,
    };
}

const directProfileOutcomes = [{
    username: 'alice',
    source: 'apify',
    status: 'failed',
    failure_category: 'timeout',
    http_status: 504,
    request_count: 1,
    latency_ms: 10,
    captured_at: '2026-08-10T00:04:00Z',
    profile: null,
}];

async function checkpointFreshProfile(db: PGlite): Promise<unknown> {
    return asRole(db, 'service_role', async () => {
        const result = await query<{ result: unknown }>(db, `
            SELECT public.checkpoint_analysis_v2_profile_fresh_apify_v1(
                $1::uuid,$2::text,$3::uuid,$4::text,$5::text[],$6::jsonb,$7::text,$8::text
            ) AS result
        `, [
            requestId,
            jobKey,
            claimToken,
            jobInputHash,
            ['alice'],
            JSON.stringify(directProfileOutcomes),
            operationKey,
            providerInputHash,
        ]);
        return result.rows[0]?.result;
    });
}

async function serviceJsonRpc(db: PGlite, sql: string, params: unknown[] = []): Promise<unknown> {
    return asRole(db, 'service_role', async () => {
        const result = await query<{ result: unknown }>(db, sql, params);
        return result.rows[0]?.result ?? null;
    });
}

async function serviceQuery<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<Results<T>> {
    return asRole(db, 'service_role', () => query<T>(db, sql, params));
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(db => db.close()));
});

describe('fresh revenue provenance forward migration PGlite proof', () => {
    it('runs the full forward migration and uses only service_role RPCs for exact crash/resume evidence', async () => {
        const db = await createDb();
        await seed(db);
        const fresh = store(db);

        await expect(fresh.assertProviderAdmission(identity())).resolves.toEqual({
            disposition: 'admitted', created: false, replayed: true,
        });
        await expect(fresh.recordProviderRun(identity())).resolves.toEqual({
            disposition: 'recorded', created: true, replayed: false,
        });
        // Simulated process loss after recording: a new store instance sees an
        // exact replay and no extra evidence row before Dataset binding.
        await expect(store(db).recordProviderRun(identity())).resolves.toEqual({
            disposition: 'recorded', created: false, replayed: true,
        });
        await expect(fresh.bindProviderDataset({ ...identity(), datasetId }))
            .rejects.toThrow('FRESH_PROVENANCE_NOT_FRESH');

        await query(db,
            "UPDATE public.analysis_v2_provider_runs SET status='succeeded' WHERE request_id=$1::uuid",
            [requestId],
        );
        await expect(store(db).bindProviderDataset({ ...identity(), datasetId })).resolves.toEqual({
            disposition: 'bound', created: true, replayed: false,
        });
        await expect(fresh.bindProviderDataset({ ...identity(), datasetId })).resolves.toEqual({
            disposition: 'bound', created: false, replayed: true,
        });
        await expect(fresh.bindProviderDataset({ ...identity(), datasetId: 'OtherDataset1234' }))
            .rejects.toThrow('FRESH_PROVENANCE_DRIFT');
    });

    it('rejects profile-repair and generic operation keys in the storage RPC before any evidence write', async () => {
        const db = await createDb();
        await seed(db);
        await expect(serviceFreshRpc(db, 'assert_analysis_revenue_fresh_provider_admission_v1', {
            p_request_id: requestId,
            p_job_key: jobKey,
            p_job_claim_token: claimToken,
            p_job_input_hash: jobInputHash,
            p_operation_key: `profile-repair:${'c'.repeat(64)}`,
            p_provider_input_hash: providerInputHash,
        })).rejects.toThrow('FRESH_PROVENANCE_FENCE');
        await expect(serviceFreshRpc(db, 'assert_analysis_revenue_fresh_provider_admission_v1', {
            p_request_id: requestId,
            p_job_key: jobKey,
            p_job_claim_token: claimToken,
            p_job_input_hash: jobInputHash,
            p_operation_key: `unapproved-provider:${'c'.repeat(64)}`,
            p_provider_input_hash: providerInputHash,
        })).rejects.toThrow('FRESH_PROVENANCE_FENCE');
        const count = await query<{ count: number }>(db,
            'SELECT count(*)::int AS count FROM public.analysis_revenue_fresh_provider_evidence',
        );
        expect(count.rows[0]?.count).toBe(0);
    });

    it('enforces service-only ACL/RLS and denies anon/authenticated direct access', async () => {
        const db = await createDb();
        await seed(db);

        for (const role of ['anon', 'authenticated'] as const) {
            await expect(asRole(db, role, () => query(
                db,
                'SELECT * FROM public.analysis_revenue_fresh_provider_evidence',
            ))).rejects.toThrow();
            await expect(asRole(db, role, () => query(
                db,
                "SELECT public.assert_analysis_revenue_fresh_provider_admission_v1($1::uuid,$2,$3::uuid,$4,$5,$6)",
                [requestId, jobKey, claimToken, jobInputHash, operationKey, providerInputHash],
            ))).rejects.toThrow();
        }
        await expect(asRole(db, 'service_role', () => query(
            db,
            "UPDATE public.analysis_revenue_run_ledgers SET status='manual_review' WHERE request_id=$1::uuid",
            [requestId],
        ))).rejects.toThrow();
        await expect(asRole(db, 'service_role', () => query(
            db,
            `INSERT INTO public.analysis_revenue_fresh_provider_evidence(
                request_id,job_key,job_input_hash,operation_key_hash,provider,provider_input_hash,
                provider_run_hash,provider_run_started_at,no_reuse,no_adoption,no_cache
            ) VALUES ($1::uuid,$2,$3,$4,'apify',$5,$6,pg_catalog.clock_timestamp(),TRUE,TRUE,TRUE)`,
            [requestId, jobKey, jobInputHash, hash('e'), providerInputHash, hash('f')],
        ))).rejects.toThrow();

        await expect(store(db).assertProviderAdmission(identity())).resolves.toMatchObject({
            disposition: 'admitted',
        });
    });

    it('retains normalized evidence after request deletion and rejects a terminal/manual-review parent', async () => {
        const db = await createDb();
        await seed(db);
        const fresh = store(db);
        await fresh.recordProviderRun(identity());

        await query(db,
            "UPDATE public.analysis_revenue_run_ledgers SET status='manual_review', manual_review_reason='routing_failure' WHERE request_id=$1::uuid",
            [requestId],
        );
        await expect(fresh.assertProviderAdmission(identity())).rejects.toThrow('FRESH_PROVENANCE_FENCE');
        await query(db,
            "UPDATE public.analysis_revenue_run_ledgers SET status='running', manual_review_reason=NULL WHERE request_id=$1::uuid",
            [requestId],
        );

        await query(db, 'DELETE FROM public.analysis_requests WHERE id=$1::uuid', [requestId]);
        const retained = await query<{
            parent_count: number;
            evidence_count: number;
            raw_id_leak: number;
        }>(db, `
            SELECT
                (SELECT count(*)::int FROM public.analysis_revenue_run_ledgers WHERE request_id=$1::uuid) AS parent_count,
                (SELECT count(*)::int FROM public.analysis_revenue_fresh_provider_evidence WHERE request_id=$1::uuid) AS evidence_count,
                (SELECT count(*)::int FROM public.analysis_revenue_fresh_provider_evidence
                  WHERE provider_run_hash=$2 OR provider_dataset_hash=$3) AS raw_id_leak
        `, [requestId, runId, datasetId]);
        expect(retained.rows[0]).toEqual({ parent_count: 1, evidence_count: 1, raw_id_leak: 0 });
    });

    it('requires terminal Dataset proof for the fresh profile checkpoint and exactly replays it', async () => {
        const db = await createDb();
        await seed(db);
        const fresh = store(db);
        await fresh.recordProviderRun(identity());
        await expect(checkpointFreshProfile(db)).rejects.toThrow('FRESH_PROVENANCE_NOT_FRESH');

        await query(db,
            "UPDATE public.analysis_v2_provider_runs SET status='succeeded' WHERE request_id=$1::uuid",
            [requestId],
        );
        await fresh.bindProviderDataset({ ...identity(), datasetId });
        await expect(checkpointFreshProfile(db)).resolves.toMatchObject({
            primaryResults: [expect.objectContaining({
                outcome: expect.objectContaining({ source: 'apify', requestedUsername: 'alice' }),
            })],
            fallbackResults: [],
        });
        await expect(checkpointFreshProfile(db)).resolves.toMatchObject({
            primaryResults: [expect.objectContaining({
                outcome: expect.objectContaining({ source: 'apify' }),
            })],
        });
        await query(db, `
            UPDATE public.analysis_v2_profile_fetch_outcomes
            SET attempt='primary', source='cache'
            WHERE request_id=$1::uuid AND job_key=$2::text AND attempt='fresh_apify'
        `, [requestId, jobKey]);
        await expect(checkpointFreshProfile(db)).rejects.toThrow('FRESH_PROVENANCE_NOT_FRESH');
    });

    it('gates every strict scheduler transition on an active running revenue parent and quarantines begin ambiguity', async () => {
        const db = await createDb();
        await seed(db);
        const dispatchToken = '55555555-5555-4555-8555-555555555555';
        await expect(serviceQuery(
            db,
            'SELECT * FROM public.reserve_analysis_v2_job_dispatch($1::uuid,$2,$3::uuid)',
            [requestId, jobKey, dispatchToken],
        )).rejects.toThrow('ANALYSIS_V2_REVENUE_DISPATCH_FENCE');

        await expect(serviceJsonRpc(db,
            'SELECT public.activate_analysis_revenue_dispatch_guard_v1($1::uuid,$2) AS result',
            [requestId, jobKey],
        )).resolves.toEqual({ disposition: 'active', created: true, replayed: false });
        await expect(serviceQuery(
            db,
            'SELECT * FROM public.reserve_analysis_v2_job_dispatch($1::uuid,$2,$3::uuid)',
            [requestId, jobKey, dispatchToken],
        )).resolves.toMatchObject({ rows: [{ reserved: false }] });

        await expect(serviceJsonRpc(db,
            'SELECT public.quarantine_analysis_revenue_dispatch_v1($1::uuid,$2,$3) AS result',
            [requestId, jobKey, 'begin_failure'],
        )).resolves.toEqual({ disposition: 'quarantined', created: true, replayed: false });
        await expect(serviceQuery(
            db,
            'SELECT * FROM public.reserve_analysis_v2_job_dispatch($1::uuid,$2,$3::uuid)',
            [requestId, jobKey, dispatchToken],
        )).rejects.toThrow('ANALYSIS_V2_REVENUE_DISPATCH_FENCE');
        await expect(store(db).assertProviderAdmission(identity())).rejects.toThrow('FRESH_PROVENANCE_FENCE');
        const quarantined = await query<{ request_status: string; parent_status: string; guard_state: string }>(db, `
            SELECT request.status AS request_status, parent.status AS parent_status, guard.state AS guard_state
            FROM public.analysis_requests AS request
            JOIN public.analysis_revenue_run_ledgers AS parent ON parent.request_id=request.id
            JOIN public.analysis_revenue_dispatch_guards AS guard ON guard.request_id=request.id
            WHERE request.id=$1::uuid
        `, [requestId]);
        expect(quarantined.rows[0]).toEqual({
            request_status: 'failed', parent_status: 'manual_review', guard_state: 'quarantined',
        });
    });
});
