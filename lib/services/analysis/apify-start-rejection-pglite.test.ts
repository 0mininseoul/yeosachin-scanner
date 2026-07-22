import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260722110000_record_definite_apify_start_rejections.sql',
        import.meta.url
    ),
    'utf8'
);

const PREFLIGHT_ID = '70000000-0000-4000-8000-000000000001';
const FRESH_PREFLIGHT_ID = '70000000-0000-4000-8000-000000000002';
const REQUEST_PREFLIGHT_ID = '70000000-0000-4000-8000-000000000003';
const REQUEST_ID = '80000000-0000-4000-8000-000000000001';
const CLAIM_TOKEN = '11111111-1111-4111-8111-111111111111';
const RESERVATION_TOKEN = '22222222-2222-4222-8222-222222222222';
const INPUT_HASH = 'a'.repeat(64);
const OTHER_INPUT_HASH = 'b'.repeat(64);
const OPERATION_KEY = `relationship-followers:${'c'.repeat(64)}`;
const ACTOR_ID = 'scraping_solutions/instagram-scraper-followers-following-no-cookies';

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot(p_slot TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT COALESCE(
        p_slot IN ('primary', 'secondary', 'tertiary', 'quaternary', 'quinary'),
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

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    pipeline_version TEXT NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    status TEXT NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_request_id UUID,
    admission_generation INTEGER,
    admission_status TEXT,
    admission_claim_token UUID,
    admission_lease_expires_at TIMESTAMP WITH TIME ZONE,
    target_instagram_id TEXT,
    target_full_name TEXT,
    target_bio TEXT,
    target_profile_image_url TEXT,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    target_is_private BOOLEAN,
    capacity_required_plan_id TEXT,
    required_plan_id TEXT,
    plan_cards_snapshot JSONB,
    error_code TEXT,
    blocked_at TIMESTAMP WITH TIME ZONE,
    ready_at TIMESTAMP WITH TIME ZONE,
    exclusion_decision TEXT,
    excluded_instagram_id TEXT,
    pii_scrubbed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, job_key)
);

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
    run_id TEXT,
    actual_usage_usd NUMERIC(18, 12),
    reserved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    run_started_at TIMESTAMP WITH TIME ZONE,
    terminalized_at TIMESTAMP WITH TIME ZONE,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, operation_key),
    CONSTRAINT analysis_v2_provider_run_status_check CHECK (
        status IN ('starting', 'running', 'succeeded', 'failed', 'aborted', 'timed_out')
    ),
    CONSTRAINT analysis_v2_provider_run_state_check CHECK (
        (status = 'starting' AND run_id IS NULL AND run_started_at IS NULL
            AND terminalized_at IS NULL AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL)
        OR (status = 'running' AND run_id IS NOT NULL AND run_started_at IS NOT NULL
            AND terminalized_at IS NULL AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL)
        OR (status IN ('succeeded', 'failed', 'aborted', 'timed_out')
            AND run_id IS NOT NULL AND run_started_at IS NOT NULL
            AND terminalized_at IS NOT NULL)
    )
);

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

CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    operation_key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    logical_provider TEXT NOT NULL DEFAULT 'apify',
    actor_id TEXT NOT NULL DEFAULT 'apify/instagram-profile-scraper',
    credential_slot TEXT NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    run_id TEXT,
    actual_usage_usd NUMERIC(18, 12),
    reserved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    run_started_at TIMESTAMP WITH TIME ZONE,
    terminalized_at TIMESTAMP WITH TIME ZONE,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE,
    usage_reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0,
    usage_reconciliation_attempted_at TIMESTAMP WITH TIME ZONE,
    manual_resolution_evidence_hash TEXT,
    manual_resolved_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (preflight_id, operation_key),
    CONSTRAINT analysis_preflight_provider_run_status_check CHECK (
        status IN ('starting', 'running', 'succeeded', 'failed', 'aborted', 'timed_out',
            'resolved_no_run')
    ),
    CONSTRAINT analysis_preflight_provider_run_state_check CHECK (
        (status = 'starting' AND run_id IS NULL AND run_started_at IS NULL
            AND terminalized_at IS NULL AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL AND manual_resolution_evidence_hash IS NULL
            AND manual_resolved_at IS NULL)
        OR (status = 'running' AND run_id IS NOT NULL AND run_started_at IS NOT NULL
            AND terminalized_at IS NULL AND actual_usage_usd IS NULL)
        OR (status IN ('succeeded', 'failed', 'aborted', 'timed_out')
            AND run_id IS NOT NULL AND run_started_at IS NOT NULL
            AND terminalized_at IS NOT NULL)
        OR (status = 'resolved_no_run' AND run_id IS NULL AND run_started_at IS NULL
            AND terminalized_at IS NOT NULL AND actual_usage_usd = 0
            AND usage_reconciled_at IS NOT NULL
            AND manual_resolution_evidence_hash ~ '^[0-9a-f]{64}$'
            AND manual_resolved_at IS NOT NULL)
    )
);

CREATE INDEX idx_analysis_preflight_provider_runs_terminal
ON public.analysis_preflight_provider_runs(status, terminalized_at, preflight_id)
WHERE status IN ('succeeded', 'failed', 'aborted', 'timed_out', 'resolved_no_run');

CREATE OR REPLACE FUNCTION public.analysis_preflight_provider_run_json(
    p_run public.analysis_preflight_provider_runs
) RETURNS JSONB LANGUAGE sql STABLE STRICT SET search_path = '' AS $$
    SELECT pg_catalog.jsonb_build_object(
        'preflightId', p_run.preflight_id, 'operationKey', p_run.operation_key,
        'inputHash', p_run.input_hash, 'logicalProvider', p_run.logical_provider,
        'actorId', p_run.actor_id, 'credentialSlot', p_run.credential_slot,
        'maxChargeUsd', p_run.max_charge_usd, 'status', p_run.status,
        'runId', p_run.run_id, 'actualUsageUsd', p_run.actual_usage_usd,
        'reservedAt', p_run.reserved_at, 'runStartedAt', p_run.run_started_at,
        'terminalizedAt', p_run.terminalized_at,
        'usageReconciledAt', p_run.usage_reconciled_at
    );
$$;

CREATE TABLE public.analysis_preflight_acquisition_cost_events (
    billing_identity_hash TEXT PRIMARY KEY,
    event_kind TEXT NOT NULL,
    logical_provider TEXT,
    actor_id TEXT,
    credential_slot TEXT,
    terminal_status TEXT NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    actual_usage_usd NUMERIC(18, 12) NOT NULL,
    evidence_reference_hash TEXT,
    event_date DATE NOT NULL,
    recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_preflight_acquisition_cost_event_kind_check CHECK (
        event_kind IN ('provider_run', 'manual_no_run')
    ),
    CONSTRAINT analysis_preflight_acquisition_cost_event_state_check CHECK (
        (event_kind = 'provider_run' AND terminal_status IN
            ('succeeded', 'failed', 'aborted', 'timed_out'))
        OR (event_kind = 'manual_no_run' AND terminal_status = 'resolved_no_run'
            AND max_charge_usd = 0 AND actual_usage_usd = 0)
    )
);

CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY,
    preflight_id UUID
);
CREATE TABLE public.earlybird_waitlist (
    id UUID PRIMARY KEY,
    preflight_id UUID
);
`;

interface JsonRow<T> { result: T }

interface RejectedRun {
    status: 'rejected';
    runId: null;
    actualUsageUsd: number;
    terminalizedAt: string;
    usageReconciledAt: string;
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

async function seedInitial(): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, status, lease_token, lease_expires_at, expires_at
        ) VALUES (
            $1, 'processing', $2,
            pg_catalog.clock_timestamp() + INTERVAL '5 minutes',
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        )`,
        [PREFLIGHT_ID, CLAIM_TOKEN]
    );
    await db.query(
        `INSERT INTO public.analysis_preflight_provider_runs (
            preflight_id, operation_key, input_hash, credential_slot, max_charge_usd
        ) VALUES ($1, 'target-profile-fallback', $2, 'secondary', 0.0026)`,
        [PREFLIGHT_ID, INPUT_HASH]
    );
}

describe('definite Apify start rejection PGlite', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(bootstrap);
        await db.exec(migration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`TRUNCATE public.analysis_preflight_acquisition_cost_events,
            public.analysis_v2_provider_runs, public.analysis_pipeline_jobs,
            public.analysis_preflight_provider_runs, public.analysis_preflights,
            public.analysis_requests, public.earlybird_orders, public.earlybird_waitlist`);
    });

    afterAll(async () => {
        await db.close();
    });

    it('exposes rejection RPCs only to service_role', async () => {
        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(
                `SELECT public.reject_analysis_preflight_provider_run_start(
                    $1, $2, $3, 'secondary', 0.0026
                )`,
                [PREFLIGHT_ID, CLAIM_TOKEN, INPUT_HASH]
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }

        await seedInitial();
        await expect(serviceQuery(
            `SELECT public.reject_analysis_preflight_provider_run_start(
                $1, $2, $3, 'secondary', 0.0026
            )`,
            [PREFLIGHT_ID, CLAIM_TOKEN, INPUT_HASH]
        )).resolves.toBeDefined();
    });

    it('terminalizes initial preflight rejection once and records a hashed zero-cost event', async () => {
        await seedInitial();
        const first = await serviceQuery<JsonRow<RejectedRun>>(
            `SELECT public.reject_analysis_preflight_provider_run_start(
                $1, $2, $3, 'secondary', 0.0026
            ) AS result`,
            [PREFLIGHT_ID, CLAIM_TOKEN, INPUT_HASH]
        );
        expect(first.rows[0].result).toMatchObject({
            status: 'rejected',
            runId: null,
            actualUsageUsd: 0,
            terminalizedAt: expect.any(String),
            usageReconciledAt: expect.any(String),
        });

        const replay = await serviceQuery<JsonRow<RejectedRun>>(
            `SELECT public.reject_analysis_preflight_provider_run_start(
                $1, $2, $3, 'secondary', 0.0026
            ) AS result`,
            [PREFLIGHT_ID, CLAIM_TOKEN, INPUT_HASH]
        );
        expect(replay.rows[0].result).toEqual(first.rows[0].result);
        await expect(serviceQuery(
            `SELECT public.reject_analysis_preflight_provider_run_start(
                $1, $2, $3, 'secondary', 0.0026
            )`,
            [PREFLIGHT_ID, CLAIM_TOKEN, OTHER_INPUT_HASH]
        )).rejects.toThrow(/IDENTITY_CONFLICT/);

        const events = await db.query<{
            billing_identity_hash: string;
            event_kind: string;
            terminal_status: string;
            max_charge_usd: string;
            actual_usage_usd: string;
            evidence_reference_hash: string | null;
        }>(`SELECT billing_identity_hash, event_kind, terminal_status,
            max_charge_usd, actual_usage_usd, evidence_reference_hash
            FROM public.analysis_preflight_acquisition_cost_events`);
        const billingInput = [
            'provider_start_rejected:v1', PREFLIGHT_ID, 'target-profile-fallback',
            'apify', 'apify/instagram-profile-scraper', 'secondary',
        ].join(':');
        expect(events.rows).toEqual([{
            billing_identity_hash: createHash('sha256')
                .update(billingInput, 'utf8').digest('hex'),
            event_kind: 'provider_start_rejected',
            terminal_status: 'rejected',
            max_charge_usd: '0.000000000000',
            actual_usage_usd: '0.000000000000',
            evidence_reference_hash: null,
        }]);
    });

    it('uses the fresh admission generation fence and exact operation key', async () => {
        await db.query(
            `INSERT INTO public.analysis_preflights (
                id, status, expires_at, admission_generation, admission_status,
                admission_claim_token, admission_lease_expires_at
            ) VALUES (
                $1, 'ready', pg_catalog.clock_timestamp() + INTERVAL '30 minutes',
                4, 'processing', $2,
                pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
            )`,
            [FRESH_PREFLIGHT_ID, CLAIM_TOKEN]
        );
        await db.query(
            `INSERT INTO public.analysis_preflight_provider_runs (
                preflight_id, operation_key, input_hash, credential_slot, max_charge_usd
            ) VALUES ($1, 'target-profile-fresh-admission:g4', $2, 'secondary', 0.0026)`,
            [FRESH_PREFLIGHT_ID, INPUT_HASH]
        );

        const result = await serviceQuery<JsonRow<RejectedRun>>(
            `SELECT public.reject_analysis_v2_fresh_admission_provider_run_start(
                $1, 4, $2, $3, 'secondary', 0.0026
            ) AS result`,
            [FRESH_PREFLIGHT_ID, CLAIM_TOKEN, INPUT_HASH]
        );
        expect(result.rows[0].result.status).toBe('rejected');
        await expect(serviceQuery(
            `SELECT public.reject_analysis_v2_fresh_admission_provider_run_start(
                $1, 5, $2, $3, 'secondary', 0.0026
            )`,
            [FRESH_PREFLIGHT_ID, CLAIM_TOKEN, INPUT_HASH]
        )).rejects.toThrow(/FENCE_MISMATCH/);
    });

    it('terminalizes a request rejection behind reservation and immutable identity fences', async () => {
        await db.query(
            `INSERT INTO public.analysis_requests (id, pipeline_version, status)
             VALUES ($1, 'v2', 'processing')`,
            [REQUEST_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_preflights (id, status, expires_at, consumed_request_id)
             VALUES ($1, 'consumed', pg_catalog.clock_timestamp() + INTERVAL '30 minutes', $2)`,
            [REQUEST_PREFLIGHT_ID, REQUEST_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs (
                request_id, job_key, status, lease_token, lease_expires_at
             ) VALUES (
                $1, 'track:relationships:collect', 'processing', $2,
                pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             )`,
            [REQUEST_ID, CLAIM_TOKEN]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, input_hash, job_claim_token,
                reservation_token, logical_provider, actor_id, credential_slot,
                max_charge_usd
             ) VALUES (
                $1, 'track:relationships:collect', $2, $3, $4, $5,
                'apify', $6, 'secondary', 0.40205
             )`,
            [REQUEST_ID, OPERATION_KEY, INPUT_HASH, CLAIM_TOKEN, RESERVATION_TOKEN, ACTOR_ID]
        );

        const rejectSql = `SELECT public.reject_analysis_v2_provider_run_start(
            $1, 'track:relationships:collect', $2, $3, $4, $5,
            'apify', $6, 'secondary', 0.40205
        ) AS result`;
        const first = await serviceQuery<JsonRow<RejectedRun>>(rejectSql, [
            REQUEST_ID, CLAIM_TOKEN, OPERATION_KEY, INPUT_HASH, RESERVATION_TOKEN, ACTOR_ID,
        ]);
        expect(first.rows[0].result).toMatchObject({
            status: 'rejected', runId: null, actualUsageUsd: 0,
        });
        const replay = await serviceQuery<JsonRow<RejectedRun>>(rejectSql, [
            REQUEST_ID, CLAIM_TOKEN, OPERATION_KEY, INPUT_HASH, RESERVATION_TOKEN, ACTOR_ID,
        ]);
        expect(replay.rows[0].result).toEqual(first.rows[0].result);
        await expect(serviceQuery(rejectSql, [
            REQUEST_ID, CLAIM_TOKEN, OPERATION_KEY, OTHER_INPUT_HASH,
            RESERVATION_TOKEN, ACTOR_ID,
        ])).rejects.toThrow(/IDENTITY_CONFLICT/);
    });

    it('treats rejected as reconciled for retention while starting remains fenced', async () => {
        await seedInitial();
        await serviceQuery(
            `SELECT public.reject_analysis_preflight_provider_run_start(
                $1, $2, $3, 'secondary', 0.0026
            )`,
            [PREFLIGHT_ID, CLAIM_TOKEN, INPUT_HASH]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'expired', expires_at = pg_catalog.clock_timestamp() - INTERVAL '2 hours',
                 created_at = pg_catalog.clock_timestamp() - INTERVAL '2 hours'
             WHERE id = $1`,
            [PREFLIGHT_ID]
        );
        const purged = await serviceQuery<{ result: number }>(
            'SELECT public.purge_expired_analysis_v2_preflights(10) AS result'
        );
        expect(purged.rows[0].result).toBe(2);
        const count = await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_preflights'
        );
        expect(count.rows[0].count).toBe(0);
        const eventCount = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_preflight_acquisition_cost_events`
        );
        expect(eventCount.rows[0].count).toBe(1);
    });
});
