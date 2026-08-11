import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
    FreshProvenanceStore,
    type FreshProvenanceRpcClient,
} from './fresh-provenance-store';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260810090000_add_revenue_e2e_observability_ledgers.sql', import.meta.url),
    'utf8'
);
const freshMigration = migration.slice(
    migration.indexOf('CREATE TABLE public.analysis_revenue_run_ledgers'),
    migration.indexOf('-- Trusted fresh Apify profile checkpoint.')
);
const freshProfileMigration = migration.slice(
    migration.indexOf('-- Trusted fresh Apify profile checkpoint.'),
    migration.indexOf('CREATE TABLE public.analysis_result_share_observations')
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

const bootstrap = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE EXTENSION pgcrypto;
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql AS $$ SELECT public.digest($1, $2) $$;
CREATE FUNCTION extensions.digest(bytea, text) RETURNS bytea LANGUAGE sql AS $$ SELECT public.digest($1, $2) $$;
CREATE FUNCTION public.analysis_v2_valid_provider_operation_key(p_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT p_key ~ '^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[a-f0-9]{64}$'
$$;
CREATE TABLE public.analysis_requests (
    id uuid PRIMARY KEY,
    preflight_id uuid NOT NULL,
    user_id uuid NOT NULL,
    pipeline_version text NOT NULL,
    plan_access_mode_snapshot text NOT NULL,
    selected_plan_id_snapshot text NOT NULL,
    status text NOT NULL,
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
    lease_token uuid,
    lease_expires_at timestamptz,
    PRIMARY KEY (request_id, job_key)
);
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
`;

const profileBootstrap = `
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
              OR (
                  outcome.value->>'status' = 'failed'
                  AND (
                      outcome.value->>'failure_category' NOT IN (
                          'auth', 'rate_limit', 'timeout', 'incomplete', 'schema',
                          'transport', 'http', 'unknown'
                      )
                      OR outcome.value->'profile' <> 'null'::jsonb
                  )
              )
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
`;

async function createDb(): Promise<PGlite> {
    const db = await PGlite.create({ extensions: { pgcrypto } });
    databases.push(db);
    await db.exec(bootstrap);
    await db.exec(freshMigration);
    await db.exec(`
        CREATE TABLE public.analysis_revenue_cost_operations (
            request_id uuid NOT NULL REFERENCES public.analysis_revenue_run_ledgers(request_id) ON DELETE CASCADE,
            source_operation_key text NOT NULL,
            PRIMARY KEY (request_id, source_operation_key)
        );
    `);
    return db;
}

async function createProfileDb(): Promise<PGlite> {
    const db = await createDb();
    await db.exec(profileBootstrap);
    await db.exec(freshProfileMigration);
    return db;
}

async function query<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<Results<T>> {
    return db.query<T>(sql, params);
}

function rpcClient(db: PGlite): FreshProvenanceRpcClient {
    const calls: Record<string, readonly [string, readonly string[]]> = {
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
        read_analysis_revenue_fresh_provider_evidence_summary_v1: [
            'SELECT public.read_analysis_revenue_fresh_provider_evidence_summary_v1($1::uuid,$2::text,$3::uuid,$4::text,$5::text) AS result',
            ['p_request_id', 'p_job_key', 'p_job_claim_token', 'p_job_input_hash', 'p_operation_key'],
        ],
    };
    return {
        async rpc(name, params) {
            const call = calls[name];
            if (!call) return { data: null, error: { code: 'PGRST202', message: 'unknown RPC' } };
            try {
                const result = await db.query<{ result: unknown }>(
                    call[0],
                    call[1].map(key => params[key])
                );
                return { data: result.rows[0]?.result ?? null, error: null };
            } catch (error) {
                return {
                    data: null,
                    error: {
                        code: 'P0001',
                        message: error instanceof Error ? error.message.match(/FRESH_PROVENANCE_[A-Z_]+/)?.[0] ?? error.message : 'unknown',
                    },
                };
            }
        },
    };
}

async function seed(db: PGlite): Promise<void> {
    await db.exec(`
        INSERT INTO public.analysis_requests(
            id,preflight_id,user_id,pipeline_version,plan_access_mode_snapshot,selected_plan_id_snapshot,status,created_at
        ) VALUES (
            '${requestId}','${preflightId}','${userId}','v2','test_entitlement','basic','processing','2026-08-10T00:01:00Z'
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
            request_id,job_key,input_hash,status,lease_token,lease_expires_at
        ) VALUES (
            '${requestId}','${jobKey}','${jobInputHash}','processing','${claimToken}','2099-01-01T00:00:00Z'
        );
        INSERT INTO public.analysis_v2_provider_runs(
            request_id,job_key,operation_key,input_hash,job_claim_token,logical_provider,status,
            run_id,reserved_at,run_started_at
        ) VALUES (
            '${requestId}','${jobKey}','${operationKey}','${providerInputHash}','${claimToken}','apify','running',
            '${runId}','2026-08-10T00:02:00Z','2026-08-10T00:03:00Z'
        );
        INSERT INTO public.analysis_revenue_cost_operations(request_id,source_operation_key)
        VALUES ('${requestId}','${operationKey}');
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
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(db => db.close()));
});

describe('fresh revenue provenance SQL contract', () => {
    it('records exact live evidence, replays it idempotently, and binds one opaque dataset', async () => {
        const db = await createDb();
        await seed(db);
        const fresh = store(db);

        await expect(fresh.assertProviderAdmission(identity())).resolves.toEqual({
            disposition: 'admitted', created: false, replayed: true,
        });
        await expect(fresh.recordProviderRun(identity())).resolves.toEqual({
            disposition: 'recorded', created: true, replayed: false,
        });
        await expect(fresh.recordProviderRun(identity())).resolves.toEqual({
            disposition: 'recorded', created: false, replayed: true,
        });
        await expect(fresh.bindProviderDataset({ ...identity(), datasetId })).resolves.toEqual({
            disposition: 'bound', created: true, replayed: false,
        });
        await expect(fresh.bindProviderDataset({ ...identity(), datasetId })).resolves.toEqual({
            disposition: 'bound', created: false, replayed: true,
        });
        await expect(fresh.readBoundedSummary(identity())).resolves.toEqual({
            providerRunCount: 1, datasetBoundCount: 1, allLive: true,
        });
    });

    it('fails closed on preflight timing, wrong lineage, non-Apify source drift, and a conflicting dataset binding', async () => {
        const db = await createDb();
        await seed(db);
        const fresh = store(db);

        await query(db,
            'UPDATE public.analysis_v2_provider_runs SET reserved_at=$1::timestamptz WHERE request_id=$2::uuid',
            ['2026-08-09T23:59:59Z', requestId]
        );
        await expect(fresh.assertProviderAdmission(identity())).rejects.toThrow('FRESH_PROVENANCE_NOT_FRESH');

        await query(db,
            'UPDATE public.analysis_v2_provider_runs SET reserved_at=$1::timestamptz WHERE request_id=$2::uuid',
            ['2026-08-10T00:02:00Z', requestId]
        );
        await query(db,
            "UPDATE public.analysis_v2_provider_runs SET logical_provider='coderx' WHERE request_id=$1::uuid",
            [requestId]
        );
        await expect(fresh.assertProviderAdmission(identity())).rejects.toThrow('FRESH_PROVENANCE_NOT_FRESH');
        await query(db,
            "UPDATE public.analysis_v2_provider_runs SET logical_provider='apify' WHERE request_id=$1::uuid",
            [requestId]
        );
        await query(db,
            'UPDATE public.analysis_preflights SET target_input_hash=$1 WHERE id=$2::uuid',
            [hash('e'), preflightId]
        );
        await expect(fresh.assertProviderAdmission(identity())).rejects.toThrow('FRESH_PROVENANCE_FENCE');
        await query(db,
            'UPDATE public.analysis_preflights SET target_input_hash=$1 WHERE id=$2::uuid',
            [hash('d'), preflightId]
        );
        await fresh.recordProviderRun(identity());
        await expect(fresh.bindProviderDataset({ ...identity(), datasetId })).resolves.toMatchObject({
            disposition: 'bound', created: true,
        });
        await expect(fresh.bindProviderDataset({ ...identity(), datasetId: 'OtherDataset1234' }))
            .rejects.toThrow('FRESH_PROVENANCE_DRIFT');

        await expect(query(db, `
            INSERT INTO public.analysis_revenue_fresh_provider_evidence(
                request_id,job_key,job_input_hash,operation_key_hash,provider,provider_input_hash,
                provider_run_hash,provider_run_started_at,no_reuse,no_adoption,no_cache
            ) VALUES ($1::uuid,$2,$3,$4,'apify',$5,$6,clock_timestamp(),FALSE,TRUE,TRUE)
        `, [requestId, 'track:other:collect', jobInputHash, hash('f'), providerInputHash, hash('0')]))
            .rejects.toThrow();
    });

    it('fails closed when the exact durable provider source is absent', async () => {
        const db = await createDb();
        await seed(db);
        const fresh = store(db);

        await query(db, `
            DELETE FROM public.analysis_v2_provider_runs
            WHERE request_id=$1::uuid AND job_key=$2::text AND operation_key=$3::text
        `, [requestId, jobKey, operationKey]);

        await expect(fresh.assertProviderAdmission(identity()))
            .rejects.toThrow('FRESH_PROVENANCE_NOT_FRESH');
    });

    it('retains the non-FK parent, opaque evidence, and cost child after request cleanup', async () => {
        const db = await createDb();
        await seed(db);
        const fresh = store(db);
        await fresh.recordProviderRun(identity());

        await query(db, 'DELETE FROM public.analysis_requests WHERE id=$1::uuid', [requestId]);
        const retained = await query<{
            parent_count: number;
            evidence_count: number;
            cost_count: number;
            raw_id_leak: number;
        }>(db, `
            SELECT
                (SELECT count(*)::int FROM public.analysis_revenue_run_ledgers WHERE request_id=$1::uuid) AS parent_count,
                (SELECT count(*)::int FROM public.analysis_revenue_fresh_provider_evidence WHERE request_id=$1::uuid) AS evidence_count,
                (SELECT count(*)::int FROM public.analysis_revenue_cost_operations WHERE request_id=$1::uuid) AS cost_count,
                (SELECT count(*)::int FROM public.analysis_revenue_fresh_provider_evidence
                  WHERE provider_run_hash = $2::text OR provider_dataset_hash = $3::text) AS raw_id_leak
        `, [requestId, runId, datasetId]);

        expect(retained.rows[0]).toEqual({
            parent_count: 1, evidence_count: 1, cost_count: 1, raw_id_leak: 0,
        });
    });

    it('rejects mutable parent lineage while allowing non-lineage terminal bookkeeping', async () => {
        const db = await createDb();
        await seed(db);

        await expect(query(
            db,
            'UPDATE public.analysis_revenue_run_ledgers SET preflight_id=$1::uuid WHERE request_id=$2::uuid',
            ['55555555-5555-4555-8555-555555555555', requestId]
        )).rejects.toThrow('REVENUE_COST_LEDGER_DRIFT');
        await expect(query(
            db,
            "UPDATE public.analysis_revenue_run_ledgers SET status='manual_review' WHERE request_id=$1::uuid",
            [requestId]
        )).resolves.toBeDefined();
    });

    it('persists and exactly replays a direct Apify profile checkpoint only after opaque Dataset proof', async () => {
        const db = await createProfileDb();
        await seed(db);
        const fresh = store(db);
        await query(
            db,
            "UPDATE public.analysis_v2_provider_runs SET status='succeeded' WHERE request_id=$1::uuid",
            [requestId]
        );
        await fresh.recordProviderRun(identity());

        await expect(checkpointFreshProfile(db)).rejects.toThrow('FRESH_PROVENANCE_NOT_FRESH');

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
    });

    it('rejects a stale legacy-shaped profile marker rather than treating it as a fresh replay', async () => {
        const db = await createProfileDb();
        await seed(db);
        const fresh = store(db);
        await query(
            db,
            "UPDATE public.analysis_v2_provider_runs SET status='succeeded' WHERE request_id=$1::uuid",
            [requestId]
        );
        await fresh.recordProviderRun(identity());
        await fresh.bindProviderDataset({ ...identity(), datasetId });
        await checkpointFreshProfile(db);

        await query(db, `
            UPDATE public.analysis_v2_profile_fetch_outcomes
            SET attempt='primary', source='cache'
            WHERE request_id=$1::uuid AND job_key=$2::text
        `, [requestId, jobKey]);

        await expect(checkpointFreshProfile(db)).rejects.toThrow('FRESH_PROVENANCE_NOT_FRESH');
    });
});
