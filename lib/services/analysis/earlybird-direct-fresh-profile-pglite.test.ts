import { readdirSync, readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migrationDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const migrationName = readdirSync(migrationDirectory)
    .find(name => name.endsWith('_earlybird_direct_fresh_apify_checkpoint.sql'));
const migration = migrationName
    ? readFileSync(new URL(migrationName, migrationDirectory), 'utf8')
    : '';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PREFLIGHT_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const CLAIM_TOKEN = '55555555-5555-4555-8555-555555555555';
const TARGET_RUN_ID = '66666666-6666-4666-8666-666666666666';
const BATCH_RUN_ID = '77777777-7777-4777-8777-777777777777';
const TARGET_JOB = 'track:target-evidence:collect';
const BATCH_JOB = 'track:profiles:batch:0';
const JOB_HASH = 'a'.repeat(64);
const TARGET_PROVIDER_HASH = 'b'.repeat(64);
const BATCH_PROVIDER_HASH = 'c'.repeat(64);
const TARGET_OPERATION = `target-profile:${'d'.repeat(64)}`;
const BATCH_OPERATION = `profile-fallback:${'e'.repeat(64)}`;
const TARGET = 'target.account';
const PLAN_CARDS = JSON.stringify({
    basic: {
        launchStatus: 'production',
        relationshipCapacity: { followers: 400, following: 400 },
        detailedMutualLimit: 300,
        selectionState: 'required',
        unavailableReason: null,
    },
    standard: {
        launchStatus: 'production',
        relationshipCapacity: { followers: 800, following: 800 },
        detailedMutualLimit: 600,
        selectionState: 'available_upgrade',
        unavailableReason: null,
    },
    plus: {
        launchStatus: 'production',
        relationshipCapacity: { followers: 1200, following: 1200 },
        detailedMutualLimit: 900,
        selectionState: 'available_upgrade',
        unavailableReason: null,
    },
});
const BASIC_SCOPE = JSON.stringify({
    relationshipCapacity: { followers: 400, following: 400 },
    detailedMutualLimit: 300,
});

const profile = (username: string) => ({
    username,
    followersCount: 10,
    followingCount: 10,
    postsCount: 1,
    isPrivate: false,
    isVerified: false,
});

const outcome = (username: string, status: 'success' | 'failed' = 'success') => ({
    username,
    source: 'apify',
    status,
    failure_category: status === 'success' ? null : 'incomplete',
    http_status: null,
    request_count: 1,
    latency_ms: 1,
    captured_at: '2026-08-27T00:00:00.000Z',
    profile: status === 'success' ? profile(username) : null,
});

const bootstrap = `
CREATE SCHEMA extensions;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    status TEXT NOT NULL,
    pipeline_version TEXT NOT NULL,
    target_instagram_id TEXT NOT NULL,
    preflight_id UUID NOT NULL,
    capacity_required_plan_id_snapshot TEXT,
    required_plan_id_snapshot TEXT,
    excluded_instagram_id TEXT,
    exclusion_decision_snapshot TEXT,
    selected_plan_id_snapshot TEXT,
    plan_access_mode_snapshot TEXT,
    analysis_entry_channel TEXT,
    test_entitlement_jti_hash TEXT,
    provider_execution_policy_id UUID,
    plan_cards_snapshot JSONB,
    analysis_scope_snapshot JSONB
);
CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    status TEXT NOT NULL,
    consumed_request_id UUID,
    target_instagram_id TEXT NOT NULL,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    admission_target_followers_count INTEGER,
    admission_target_following_count INTEGER,
    excluded_instagram_id TEXT,
    exclusion_decision TEXT,
    required_plan_id TEXT,
    capacity_required_plan_id TEXT,
    admission_selected_plan_id TEXT,
    admission_required_plan_id TEXT,
    admission_capacity_required_plan_id TEXT,
    access_mode TEXT,
    analysis_entry_channel TEXT,
    order_scoped_apify_credential_slot TEXT,
    plan_cards_snapshot JSONB
);
CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    preflight_id UUID NOT NULL,
    target_instagram_id TEXT NOT NULL,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    exclusion_decision TEXT,
    excluded_instagram_id TEXT,
    plan_id TEXT NOT NULL,
    expected_groble_product_id TEXT NOT NULL,
    expected_amount_krw NUMERIC NOT NULL,
    status TEXT NOT NULL,
    payment_id TEXT,
    actual_groble_product_id TEXT,
    actual_amount_krw NUMERIC,
    paid_at TIMESTAMPTZ,
    seller_reference_confirmed_at TIMESTAMPTZ,
    result_request_id UUID,
    concierge_apify_credential_slot TEXT
);
CREATE TABLE public.earlybird_fulfillments (
    order_id UUID PRIMARY KEY,
    request_id UUID,
    status TEXT NOT NULL,
    manual_review_at TIMESTAMPTZ,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ
);
CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    track TEXT NOT NULL,
    kind TEXT NOT NULL,
    batch INTEGER,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    PRIMARY KEY (request_id, job_key)
);
CREATE TABLE public.analysis_v2_provider_runs (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    job_claim_token UUID NOT NULL,
    logical_provider TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    credential_slot TEXT NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    run_started_at TIMESTAMPTZ,
    terminalized_at TIMESTAMPTZ,
    usage_reconciled_at TIMESTAMPTZ,
    PRIMARY KEY (request_id, job_key, operation_key)
);
CREATE TABLE public.analysis_v2_profile_fetch_batches (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    requested_usernames TEXT[] NOT NULL,
    frozen_unresolved_usernames TEXT[] NOT NULL,
    primary_payload_hash TEXT NOT NULL,
    primary_completed_at TIMESTAMPTZ NOT NULL,
    fallback_payload_hash TEXT,
    fallback_completed_at TIMESTAMPTZ,
    repair_usernames TEXT[],
    repair_payload_hash TEXT,
    repair_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (request_id, job_key)
);
CREATE TABLE public.analysis_v2_profile_fetch_outcomes (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    attempt TEXT NOT NULL,
    ordinal SMALLINT NOT NULL,
    username TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    failure_category TEXT,
    http_status SMALLINT,
    request_count SMALLINT NOT NULL,
    latency_ms INTEGER NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    profile_snapshot JSONB,
    PRIMARY KEY (request_id, job_key, attempt, username)
);
CREATE TABLE public.analysis_v2_profile_fetch_telemetry (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    source VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    failure_category VARCHAR(32),
    http_status SMALLINT,
    failure_category_key VARCHAR(32) GENERATED ALWAYS AS (COALESCE(failure_category, 'none')) STORED,
    http_status_key SMALLINT GENERATED ALWAYS AS (COALESCE(http_status, 0)) STORED,
    outcome_count SMALLINT NOT NULL,
    request_count_total INTEGER NOT NULL,
    latency_ms_total BIGINT NOT NULL,
    latency_ms_max INTEGER NOT NULL,
    first_captured_at TIMESTAMPTZ NOT NULL,
    last_captured_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, job_key, source, status, failure_category_key, http_status_key),
    CONSTRAINT analysis_v2_profile_fetch_telemetry_source_check CHECK (
        source IN ('cache', 'selfhosted', 'fallback')
    )
);
CREATE TABLE public.analysis_v2_provider_execution_policies (request_id UUID);
CREATE TABLE public.analysis_v2_test_entitlement_consumptions (request_id UUID);
CREATE TABLE public.analysis_revenue_run_ledgers (request_id UUID);

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_profile_username_list(TEXT[], BOOLEAN DEFAULT FALSE)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT $1 IS NOT NULL
       AND cardinality($1) BETWEEN CASE WHEN $2 THEN 0 ELSE 1 END AND 30
       AND NOT EXISTS (SELECT 1 FROM unnest($1) AS item(value)
           WHERE value IS NULL OR value !~ '^[a-z0-9._]{1,30}$')
       AND cardinality($1) = (SELECT count(DISTINCT value)::INTEGER FROM unnest($1) AS item(value));
$$;
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_profile_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT $1 IS NOT NULL AND jsonb_typeof($1) = 'object' AND $1 ? 'username';
$$;
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_profile_outcomes(JSONB, TEXT[], TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT $1 IS NOT NULL AND jsonb_typeof($1) = 'array'
       AND jsonb_array_length($1) = cardinality($2)
       AND $3 IN ('fallback', 'repair', 'primary')
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements($1) WITH ORDINALITY AS item(value, ordinal)
           WHERE item.value->>'username' IS DISTINCT FROM $2[item.ordinal::INTEGER]
              OR item.value->>'source' IS DISTINCT FROM 'apify'
       );
$$;
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_plan_cards_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT $1 IS NOT NULL
       AND jsonb_typeof($1) = 'object'
       AND $1 ?& ARRAY['basic', 'standard', 'plus'];
$$;
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_scope_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT $1 IS NOT NULL
       AND jsonb_typeof($1) = 'object'
       AND $1 ?& ARRAY['relationshipCapacity', 'detailedMutualLimit'];
$$;
CREATE OR REPLACE FUNCTION public.analysis_v2_profile_checkpoint_snapshot(UUID, TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT jsonb_build_object(
        'requestId', batch.request_id,
        'jobKey', batch.job_key,
        'requestedUsernames', to_jsonb(batch.requested_usernames),
        'frozenUnresolvedUsernames', to_jsonb(batch.frozen_unresolved_usernames),
        'primaryResults', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'outcome', jsonb_build_object('requestedUsername', o.username, 'source', o.source,
                'status', o.status, 'failureCategory', o.failure_category,
                'httpStatus', o.http_status, 'requestCount', o.request_count,
                'latencyMs', o.latency_ms, 'capturedAt', o.captured_at),
            'profile', o.profile_snapshot) ORDER BY o.ordinal)
            FROM public.analysis_v2_profile_fetch_outcomes o
            WHERE o.request_id = batch.request_id AND o.job_key = batch.job_key
              AND o.attempt = 'fresh_apify'), '[]'::jsonb),
        'fallbackResults', '[]'::jsonb,
        'repairResults', '[]'::jsonb,
        'primaryCapturedAt', batch.primary_completed_at,
        'fallbackCapturedAt', batch.fallback_completed_at,
        'repairUsernames', to_jsonb(batch.repair_usernames),
        'repairCapturedAt', batch.repair_completed_at)
    FROM public.analysis_v2_profile_fetch_batches batch
    WHERE batch.request_id = $1 AND batch.job_key = $2;
$$;

CREATE OR REPLACE FUNCTION public.capture_analysis_v2_profile_fetch_telemetry()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    INSERT INTO public.analysis_v2_profile_fetch_telemetry(
        request_id, job_key, source, status, failure_category, http_status,
        outcome_count, request_count_total, latency_ms_total, latency_ms_max,
        first_captured_at, last_captured_at)
    VALUES (NEW.request_id, NEW.job_key, NEW.source, NEW.status, NEW.failure_category,
        NEW.http_status, 1, NEW.request_count, NEW.latency_ms, NEW.latency_ms,
        NEW.captured_at, NEW.captured_at)
    ON CONFLICT (request_id, job_key, source, status, failure_category_key, http_status_key)
    DO UPDATE SET outcome_count = public.analysis_v2_profile_fetch_telemetry.outcome_count + 1;
    RETURN NULL;
END;
$$;
CREATE TRIGGER analysis_v2_profile_fetch_telemetry_capture
AFTER INSERT ON public.analysis_v2_profile_fetch_outcomes
FOR EACH ROW EXECUTE FUNCTION public.capture_analysis_v2_profile_fetch_telemetry();
`;

let db: PGlite;

async function asService<T>(sql: string, params: unknown[] = []) {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

const rpc = 'public.checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1';

async function checkpoint(input: {
    jobKey: string;
    operationKey: string;
    providerInputHash: string;
    requestedUsernames: string[];
    outcomes: unknown[];
}) {
    return asService<{ snapshot: unknown }>(
        `SELECT ${rpc}($1, $2, $3, $4, $5, $6::jsonb, $7, $8) AS snapshot`,
        [REQUEST_ID, input.jobKey, CLAIM_TOKEN, JOB_HASH, input.requestedUsernames,
            JSON.stringify(input.outcomes), input.operationKey, input.providerInputHash],
    );
}

beforeAll(async () => {
    db = await PGlite.create({ extensions: { pgcrypto } });
    await db.exec(bootstrap);
    await db.exec(migration);
});

beforeEach(async () => {
    await db.exec(`
        TRUNCATE public.analysis_v2_profile_fetch_telemetry,
            public.analysis_v2_profile_fetch_outcomes,
            public.analysis_v2_profile_fetch_batches,
            public.analysis_v2_provider_runs,
            public.analysis_pipeline_jobs,
            public.analysis_v2_provider_execution_policies,
            public.analysis_v2_test_entitlement_consumptions,
            public.analysis_revenue_run_ledgers,
            public.earlybird_fulfillments,
            public.earlybird_orders,
            public.analysis_preflights,
            public.analysis_requests;
        INSERT INTO public.analysis_requests(
            id,user_id,status,pipeline_version,target_instagram_id,preflight_id,
            capacity_required_plan_id_snapshot,required_plan_id_snapshot,
            excluded_instagram_id,exclusion_decision_snapshot,selected_plan_id_snapshot,
            plan_access_mode_snapshot,analysis_entry_channel,test_entitlement_jti_hash,
            plan_cards_snapshot,analysis_scope_snapshot)
        VALUES ('${REQUEST_ID}','${USER_ID}','processing','v2','${TARGET}','${PREFLIGHT_ID}',
            'basic','basic',NULL,'none','basic','production','standard',NULL,
            '${PLAN_CARDS}'::jsonb,'${BASIC_SCOPE}'::jsonb);
        INSERT INTO public.analysis_preflights(
            id,user_id,status,consumed_request_id,target_instagram_id,target_followers_count,
            target_following_count,admission_target_followers_count,admission_target_following_count,
            excluded_instagram_id,exclusion_decision,required_plan_id,capacity_required_plan_id,
            admission_selected_plan_id,admission_required_plan_id,admission_capacity_required_plan_id,access_mode,
            analysis_entry_channel,order_scoped_apify_credential_slot,plan_cards_snapshot)
        VALUES ('${PREFLIGHT_ID}','${USER_ID}','consumed','${REQUEST_ID}','${TARGET}',10,10,10,10,
            NULL,'none','basic','basic','basic','basic','basic','production','standard','secondary',
            '${PLAN_CARDS}'::jsonb);
        INSERT INTO public.earlybird_orders(
            id,user_id,preflight_id,target_instagram_id,target_followers_count,target_following_count,
            exclusion_decision,excluded_instagram_id,
            plan_id,expected_groble_product_id,expected_amount_krw,status,payment_id,
            actual_groble_product_id,actual_amount_krw,paid_at,seller_reference_confirmed_at,
            result_request_id,concierge_apify_credential_slot)
        VALUES ('${ORDER_ID}','${USER_ID}','${PREFLIGHT_ID}','${TARGET}',10,10,'none',NULL,'basic','groble-basic',1000,'analysis_in_progress',
            'payment','groble-basic',1000,clock_timestamp(),clock_timestamp(),'${REQUEST_ID}','secondary');
        INSERT INTO public.earlybird_fulfillments(order_id,request_id,status,manual_review_at)
        VALUES ('${ORDER_ID}','${REQUEST_ID}','analysis_in_progress',NULL);
        INSERT INTO public.analysis_pipeline_jobs(
            request_id,job_key,track,kind,batch,input_hash,status,lease_token,lease_expires_at)
        VALUES
            ('${REQUEST_ID}','track:target-evidence:collect','target_evidence','collection',NULL,'${JOB_HASH}','processing','${CLAIM_TOKEN}',clock_timestamp()+interval '10 minutes'),
            ('${REQUEST_ID}','track:profiles:batch:0','profiles','profile_fetch',0,'${JOB_HASH}','processing','${CLAIM_TOKEN}',clock_timestamp()+interval '10 minutes');
        INSERT INTO public.analysis_v2_provider_runs(
            request_id,job_key,operation_key,input_hash,job_claim_token,logical_provider,
            actor_id,credential_slot,status,run_id,run_started_at,terminalized_at)
        VALUES
            ('${REQUEST_ID}','track:target-evidence:collect','${TARGET_OPERATION}','${TARGET_PROVIDER_HASH}','${CLAIM_TOKEN}','apify',
                'apify/instagram-profile-scraper','secondary','succeeded','${TARGET_RUN_ID}',clock_timestamp(),clock_timestamp()),
            ('${REQUEST_ID}','track:profiles:batch:0','${BATCH_OPERATION}','${BATCH_PROVIDER_HASH}','${CLAIM_TOKEN}','apify',
                'apify/instagram-profile-scraper','secondary','succeeded','${BATCH_RUN_ID}',clock_timestamp(),clock_timestamp());
    `);
});

afterAll(async () => {
    await db.close();
});

describe('paid Earlybird direct fresh-Apify checkpoint RPC', () => {
    it('persists and exactly replays target and incomplete batch evidence with fresh telemetry', async () => {
        const target = await checkpoint({
            jobKey: TARGET_JOB,
            operationKey: TARGET_OPERATION,
            providerInputHash: TARGET_PROVIDER_HASH,
            requestedUsernames: [TARGET],
            outcomes: [outcome(TARGET)],
        });
        expect(target.rows[0]?.snapshot).toBeTruthy();

        const batch = await checkpoint({
            jobKey: BATCH_JOB,
            operationKey: BATCH_OPERATION,
            providerInputHash: BATCH_PROVIDER_HASH,
            requestedUsernames: [TARGET, 'missing.account'],
            outcomes: [outcome(TARGET), outcome('missing.account', 'failed')],
        });
        expect(batch.rows[0]?.snapshot).toBeTruthy();

        const replay = await checkpoint({
            jobKey: BATCH_JOB,
            operationKey: BATCH_OPERATION,
            providerInputHash: BATCH_PROVIDER_HASH,
            requestedUsernames: [TARGET, 'missing.account'],
            outcomes: [outcome(TARGET), outcome('missing.account', 'failed')],
        });
        expect(replay.rows).toEqual(batch.rows);
        const rows = await db.query<{ attempt: string; source: string }>(
            `SELECT attempt, source FROM public.analysis_v2_profile_fetch_outcomes
             WHERE request_id = $1 AND job_key = $2`, [REQUEST_ID, BATCH_JOB],
        );
        expect(rows.rows).toHaveLength(2);
        expect(rows.rows.every(row => row.attempt === 'fresh_apify' && row.source === 'apify')).toBe(true);
        const telemetry = await db.query<{ source: string }>(
            `SELECT source FROM public.analysis_v2_profile_fetch_telemetry
             WHERE request_id = $1 AND job_key = $2`, [REQUEST_ID, BATCH_JOB],
        );
        expect(telemetry.rows).toEqual(expect.arrayContaining([{ source: 'fresh_apify' }]));
        const terminal = await db.query<{ attempt: string }>(
            `SELECT public.analysis_v2_profile_terminal_attempt($1,$2,$3,$4) AS attempt`,
            [REQUEST_ID, BATCH_JOB, 'missing.account', ['missing.account']],
        );
        expect(terminal.rows[0]?.attempt).toBe('fresh_apify');
    });

    it('accepts bounded recovered count drift independently from the preflight snapshot', async () => {
        await db.query(
            `UPDATE public.earlybird_orders
             SET target_followers_count = 120, target_following_count = 140
             WHERE id = $1`, [ORDER_ID],
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_followers_count = 200,
                 target_following_count = 220,
                 admission_target_followers_count = 200,
                 admission_target_following_count = 220
             WHERE id = $1`, [PREFLIGHT_ID],
        );

        const persisted = await checkpoint({
            jobKey: BATCH_JOB,
            operationKey: BATCH_OPERATION,
            providerInputHash: BATCH_PROVIDER_HASH,
            requestedUsernames: [TARGET, 'missing.account'],
            outcomes: [outcome(TARGET), outcome('missing.account', 'failed')],
        });
        const replay = await checkpoint({
            jobKey: BATCH_JOB,
            operationKey: BATCH_OPERATION,
            providerInputHash: BATCH_PROVIDER_HASH,
            requestedUsernames: [TARGET, 'missing.account'],
            outcomes: [outcome(TARGET), outcome('missing.account', 'failed')],
        });
        expect(replay.rows).toEqual(persisted.rows);
    });

    it('accepts a Standard available upgrade while required and capacity lineage remains Basic', async () => {
        const standardScope = JSON.stringify({
            relationshipCapacity: { followers: 800, following: 800 },
            detailedMutualLimit: 600,
        });
        await db.query(
            `UPDATE public.earlybird_orders
             SET plan_id = 'standard', expected_groble_product_id = 'groble-standard',
                 actual_groble_product_id = 'groble-standard', expected_amount_krw = 2000,
                 actual_amount_krw = 2000, target_followers_count = 120,
                 target_following_count = 140
             WHERE id = $1`, [ORDER_ID],
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_followers_count = 200,
                 target_following_count = 220,
                 admission_target_followers_count = 200,
                 admission_target_following_count = 220,
                 admission_selected_plan_id = 'standard'
             WHERE id = $1`, [PREFLIGHT_ID],
        );
        await db.query(
            `UPDATE public.analysis_requests
             SET selected_plan_id_snapshot = 'standard', analysis_scope_snapshot = $1
             WHERE id = $2`, [standardScope, REQUEST_ID],
        );

        const persisted = await checkpoint({
            jobKey: TARGET_JOB,
            operationKey: TARGET_OPERATION,
            providerInputHash: TARGET_PROVIDER_HASH,
            requestedUsernames: [TARGET],
            outcomes: [outcome(TARGET)],
        });
        const replay = await checkpoint({
            jobKey: TARGET_JOB,
            operationKey: TARGET_OPERATION,
            providerInputHash: TARGET_PROVIDER_HASH,
            requestedUsernames: [TARGET],
            outcomes: [outcome(TARGET)],
        });
        expect(replay.rows).toEqual(persisted.rows);
    });

    it('rejects order or current preflight counts above the selected plan capacity', async () => {
        await db.query(
            `UPDATE public.earlybird_orders SET target_followers_count = 401
             WHERE id = $1`, [ORDER_ID],
        );
        await expect(checkpoint({
            jobKey: TARGET_JOB,
            operationKey: TARGET_OPERATION,
            providerInputHash: TARGET_PROVIDER_HASH,
            requestedUsernames: [TARGET],
            outcomes: [outcome(TARGET)],
        })).rejects.toThrow();

        await db.query(
            `UPDATE public.earlybird_orders SET target_followers_count = 10
             WHERE id = $1`, [ORDER_ID],
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_followers_count = 401, admission_target_followers_count = 401
             WHERE id = $1`, [PREFLIGHT_ID],
        );
        await expect(checkpoint({
            jobKey: TARGET_JOB,
            operationKey: TARGET_OPERATION,
            providerInputHash: TARGET_PROVIDER_HASH,
            requestedUsernames: [TARGET],
            outcomes: [outcome(TARGET)],
        })).rejects.toThrow();
    });

    it('rejects selected-plan or independent required/capacity lineage drift', async () => {
        await db.query(
            `UPDATE public.earlybird_orders SET plan_id = 'standard'
             WHERE id = $1`, [ORDER_ID],
        );
        await db.query(
            `UPDATE public.analysis_preflights SET admission_selected_plan_id = 'standard'
             WHERE id = $1`, [PREFLIGHT_ID],
        );
        await db.query(
            `UPDATE public.analysis_requests SET selected_plan_id_snapshot = 'standard'
             WHERE id = $1`, [REQUEST_ID],
        );

        await db.query(
            `UPDATE public.analysis_requests SET selected_plan_id_snapshot = 'basic'
             WHERE id = $1`, [REQUEST_ID],
        );
        await expect(checkpoint({
            jobKey: TARGET_JOB,
            operationKey: TARGET_OPERATION,
            providerInputHash: TARGET_PROVIDER_HASH,
            requestedUsernames: [TARGET],
            outcomes: [outcome(TARGET)],
        })).rejects.toThrow();
        await db.query(
            `UPDATE public.analysis_requests SET selected_plan_id_snapshot = 'standard'
             WHERE id = $1`, [REQUEST_ID],
        );

        await db.query(
            `UPDATE public.analysis_requests SET required_plan_id_snapshot = 'standard'
             WHERE id = $1`, [REQUEST_ID],
        );
        await expect(checkpoint({
            jobKey: TARGET_JOB,
            operationKey: TARGET_OPERATION,
            providerInputHash: TARGET_PROVIDER_HASH,
            requestedUsernames: [TARGET],
            outcomes: [outcome(TARGET)],
        })).rejects.toThrow();
        await db.query(
            `UPDATE public.analysis_requests SET required_plan_id_snapshot = 'basic'
             WHERE id = $1`, [REQUEST_ID],
        );

        await db.query(
            `UPDATE public.analysis_requests SET capacity_required_plan_id_snapshot = 'standard'
             WHERE id = $1`, [REQUEST_ID],
        );
        await expect(checkpoint({
            jobKey: TARGET_JOB,
            operationKey: TARGET_OPERATION,
            providerInputHash: TARGET_PROVIDER_HASH,
            requestedUsernames: [TARGET],
            outcomes: [outcome(TARGET)],
        })).rejects.toThrow();
    });

    it('rejects order and preflight slot drift before writing', async () => {
        await db.query(
            `UPDATE public.earlybird_orders SET concierge_apify_credential_slot = 'primary'
             WHERE id = $1`, [ORDER_ID],
        );
        await expect(checkpoint({
            jobKey: BATCH_JOB,
            operationKey: BATCH_OPERATION,
            providerInputHash: BATCH_PROVIDER_HASH,
            requestedUsernames: [TARGET, 'missing.account'],
            outcomes: [outcome(TARGET), outcome('missing.account', 'failed')],
        })).rejects.toThrow();
        const count = await db.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM public.analysis_v2_profile_fetch_batches`,
        );
        expect(count.rows[0]?.count).toBe(0);

        await db.query(
            `UPDATE public.earlybird_orders SET concierge_apify_credential_slot = 'secondary'
             WHERE id = $1`, [ORDER_ID],
        );
        await db.query(
            `UPDATE public.analysis_preflights SET order_scoped_apify_credential_slot = 'primary'
             WHERE id = $1`, [PREFLIGHT_ID],
        );
        await expect(checkpoint({
            jobKey: TARGET_JOB,
            operationKey: TARGET_OPERATION,
            providerInputHash: TARGET_PROVIDER_HASH,
            requestedUsernames: [TARGET],
            outcomes: [outcome(TARGET)],
        })).rejects.toThrow();
    });

    it('rejects test, beta, and non-Earlybird lineage before provider evidence', async () => {
        for (const [table, column] of [
            ['analysis_requests', 'plan_access_mode_snapshot'],
            ['analysis_requests', 'analysis_entry_channel'],
            ['analysis_preflights', 'analysis_entry_channel'],
        ] as const) {
            await db.query(
                `UPDATE public.${table} SET ${column} = $1`,
                [column === 'plan_access_mode_snapshot' ? 'test_entitlement' : 'beta'],
            );
            await expect(checkpoint({
                jobKey: TARGET_JOB,
                operationKey: TARGET_OPERATION,
                providerInputHash: TARGET_PROVIDER_HASH,
                requestedUsernames: [TARGET],
                outcomes: [outcome(TARGET)],
            })).rejects.toThrow();
            await db.query(
                `UPDATE public.${table} SET ${column} = $1`,
                [column === 'plan_access_mode_snapshot' ? 'production' : 'standard'],
            );
        }

        await expect(checkpoint({
            jobKey: 'track:relationships:collect',
            operationKey: TARGET_OPERATION,
            providerInputHash: TARGET_PROVIDER_HASH,
            requestedUsernames: [TARGET],
            outcomes: [outcome(TARGET)],
        })).rejects.toThrow();
    });

    it('rejects missing, adopted, drifted, and stale current provider evidence', async () => {
        const providerMutations = [
            ['actor_id', 'wrong/actor'],
            ['status', 'failed'],
            ['input_hash', 'f'.repeat(64)],
            ['job_claim_token', '88888888-8888-4888-8888-888888888888'],
            ['logical_provider', 'coderx'],
        ] as const;
        for (const [column, value] of providerMutations) {
            await db.query(
                `UPDATE public.analysis_v2_provider_runs SET ${column} = $1
                 WHERE request_id = $2 AND job_key = $3`,
                [value, REQUEST_ID, TARGET_JOB],
            );
            await expect(checkpoint({
                jobKey: TARGET_JOB,
                operationKey: TARGET_OPERATION,
                providerInputHash: TARGET_PROVIDER_HASH,
                requestedUsernames: [TARGET],
                outcomes: [outcome(TARGET)],
            })).rejects.toThrow();
            const original = column === 'actor_id'
                ? 'apify/instagram-profile-scraper'
                : column === 'status'
                    ? 'succeeded'
                    : column === 'input_hash'
                        ? TARGET_PROVIDER_HASH
                        : column === 'job_claim_token'
                            ? CLAIM_TOKEN
                            : 'apify';
            await db.query(
                `UPDATE public.analysis_v2_provider_runs SET ${column} = $1
                 WHERE request_id = $2 AND job_key = $3`,
                [original, REQUEST_ID, TARGET_JOB],
            );
        }

        await db.query(
            `UPDATE public.analysis_pipeline_jobs SET lease_expires_at = clock_timestamp() - interval '1 second'
             WHERE request_id = $1 AND job_key = $2`, [REQUEST_ID, TARGET_JOB],
        );
        await expect(checkpoint({
            jobKey: TARGET_JOB,
            operationKey: TARGET_OPERATION,
            providerInputHash: TARGET_PROVIDER_HASH,
            requestedUsernames: [TARGET],
            outcomes: [outcome(TARGET)],
        })).rejects.toThrow();

        await db.query(
            `DELETE FROM public.analysis_v2_provider_runs WHERE request_id = $1 AND job_key = $2`,
            [REQUEST_ID, TARGET_JOB],
        );
        await expect(checkpoint({
            jobKey: TARGET_JOB,
            operationKey: TARGET_OPERATION,
            providerInputHash: TARGET_PROVIDER_HASH,
            requestedUsernames: [TARGET],
            outcomes: [outcome(TARGET)],
        })).rejects.toThrow();
    });

    it('rejects divergent replay and any mixed fallback/repair rows', async () => {
        await checkpoint({
            jobKey: BATCH_JOB,
            operationKey: BATCH_OPERATION,
            providerInputHash: BATCH_PROVIDER_HASH,
            requestedUsernames: [TARGET, 'missing.account'],
            outcomes: [outcome(TARGET), outcome('missing.account', 'failed')],
        });
        await expect(checkpoint({
            jobKey: BATCH_JOB,
            operationKey: BATCH_OPERATION,
            providerInputHash: BATCH_PROVIDER_HASH,
            requestedUsernames: [TARGET, 'missing.account'],
            outcomes: [outcome(TARGET, 'failed'), outcome('missing.account', 'failed')],
        })).rejects.toThrow('ANALYSIS_V2_PROFILE_FRESH_APIFY_CONFLICT');

        await db.exec(`
            UPDATE public.analysis_v2_profile_fetch_batches
            SET fallback_completed_at = clock_timestamp()
            WHERE request_id = '${REQUEST_ID}' AND job_key = '${BATCH_JOB}';
            INSERT INTO public.analysis_v2_profile_fetch_outcomes(
                request_id,job_key,attempt,ordinal,username,source,status,
                failure_category,http_status,request_count,latency_ms,captured_at,profile_snapshot)
            VALUES ('${REQUEST_ID}','${BATCH_JOB}','fallback',1,'target.account','apify','failed',
                'incomplete',NULL,1,1,'2026-08-27T00:00:00.000Z',NULL);
        `);
        await expect(checkpoint({
            jobKey: BATCH_JOB,
            operationKey: BATCH_OPERATION,
            providerInputHash: BATCH_PROVIDER_HASH,
            requestedUsernames: [TARGET, 'missing.account'],
            outcomes: [outcome(TARGET), outcome('missing.account', 'failed')],
        })).rejects.toThrow('ANALYSIS_V2_PROFILE_FRESH_APIFY_CONFLICT');
    });

    it('allows only service_role to execute the new RPC', async () => {
        const privileges = await db.query<{
            anon_execute: boolean;
            authenticated_execute: boolean;
            service_execute: boolean;
        }>(`SELECT
            has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon_execute,
            has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated_execute,
            has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS service_execute`,
        [`${rpc}(uuid,text,uuid,text,text[],jsonb,text,text)`]);
        expect(privileges.rows).toEqual([{
            anon_execute: false,
            authenticated_execute: false,
            service_execute: true,
        }]);
    });
});
