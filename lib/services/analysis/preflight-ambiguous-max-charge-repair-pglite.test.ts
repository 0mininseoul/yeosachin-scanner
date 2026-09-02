import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260902100000_ambiguous_max_charge_identity_drift_repair.sql',
        import.meta.url
    ),
    'utf8'
);

const CANDIDATE_ID = '00000000-0000-4000-8000-000000000001';
const TOO_NEW_ID = '00000000-0000-4000-8000-000000000002';
const LIVE_LEASE_ID = '00000000-0000-4000-8000-000000000003';
const INPUT_HASH = 'a'.repeat(64);
const TARGET_HASH = 'b'.repeat(64);
const EVIDENCE_HASH = 'c'.repeat(64);
const DIFFERENT_EVIDENCE_HASH = 'd'.repeat(64);
const ACTOR_ID = 'apify/instagram-profile-scraper';

const bootstrap = `
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
GRANT USAGE ON SCHEMA public, extensions TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot(p_slot TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_slot IN (
            'primary', 'secondary', 'tertiary', 'quaternary', 'quinary',
            'senary', 'septenary', 'tenth'
        ),
        FALSE
    );
$$;

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID,
    status TEXT NOT NULL,
    provider_selector TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    pii_scrubbed_at TIMESTAMP WITH TIME ZONE,
    target_input_hash VARCHAR(64),
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    admission_lease_expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
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
    excluded_instagram_id TEXT
);

CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID PRIMARY KEY,
    operation_key TEXT NOT NULL,
    input_hash VARCHAR(64) NOT NULL,
    logical_provider TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    credential_slot TEXT NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    status TEXT NOT NULL,
    run_id VARCHAR(64),
    actual_usage_usd NUMERIC(18, 12),
    reserved_at TIMESTAMP WITH TIME ZONE NOT NULL,
    run_started_at TIMESTAMP WITH TIME ZONE,
    terminalized_at TIMESTAMP WITH TIME ZONE,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE,
    usage_reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0,
    usage_reconciliation_attempted_at TIMESTAMP WITH TIME ZONE,
    manual_resolution_evidence_hash VARCHAR(64),
    manual_resolved_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT analysis_preflight_provider_run_status_check CHECK (
        status IN (
            'starting', 'running', 'rejected', 'succeeded', 'failed', 'aborted',
            'timed_out', 'resolved_no_run'
        )
    ),
    CONSTRAINT analysis_preflight_provider_run_state_check CHECK (status IS NOT NULL)
);

CREATE TABLE public.analysis_preflight_acquisition_cost_events (
    billing_identity_hash VARCHAR(64) PRIMARY KEY,
    event_kind TEXT NOT NULL,
    logical_provider TEXT,
    actor_id TEXT,
    credential_slot TEXT,
    terminal_status TEXT NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    actual_usage_usd NUMERIC(18, 12) NOT NULL,
    evidence_reference_hash VARCHAR(64),
    event_date DATE NOT NULL,
    recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_preflight_acquisition_cost_event_kind_check CHECK (
        event_kind IN ('provider_run', 'manual_no_run', 'provider_start_rejected')
    ),
    CONSTRAINT analysis_preflight_acquisition_cost_event_state_check CHECK (TRUE)
);

CREATE TABLE public.analysis_preflight_failures (
    id UUID PRIMARY KEY,
    preflight_id UUID,
    stage TEXT NOT NULL,
    error_code TEXT NOT NULL
);

CREATE TABLE public.analysis_provider_admission_leases (
    admission_id TEXT PRIMARY KEY,
    request_id UUID NOT NULL,
    logical_provider TEXT NOT NULL,
    credential_slot TEXT NOT NULL,
    state TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE FUNCTION public.analysis_preflight_provider_run_json(
    p_run public.analysis_preflight_provider_runs
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'preflightId', p_run.preflight_id,
        'operationKey', p_run.operation_key,
        'inputHash', p_run.input_hash,
        'logicalProvider', p_run.logical_provider,
        'actorId', p_run.actor_id,
        'credentialSlot', p_run.credential_slot,
        'maxChargeUsd', p_run.max_charge_usd,
        'status', p_run.status,
        'runId', p_run.run_id,
        'actualUsageUsd', p_run.actual_usage_usd,
        'reservedAt', p_run.reserved_at,
        'terminalizedAt', p_run.terminalized_at,
        'usageReconciledAt', p_run.usage_reconciled_at,
        'evidenceReferenceHash', p_run.manual_resolution_evidence_hash,
        'manualResolvedAt', p_run.manual_resolved_at
    );
$$;

CREATE FUNCTION public.list_analysis_preflight_ambiguous_start_candidates(INTEGER)
RETURNS JSONB LANGUAGE sql AS $$ SELECT '[]'::JSONB $$;
CREATE FUNCTION public.resolve_analysis_preflight_provider_run_no_run(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TIMESTAMP WITH TIME ZONE, TEXT
)
RETURNS JSONB LANGUAGE sql AS $$ SELECT '{}'::JSONB $$;
CREATE FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER DEFAULT 100)
RETURNS INTEGER LANGUAGE sql AS $$ SELECT 417 $$;
`;

interface JsonResult<T> {
    result: T;
}

interface ProviderRow {
    status: string;
    run_id: string | null;
    actual_usage_usd: number;
    manual_resolution_evidence_hash: string;
    usage_reconciled_at: string;
}

let db: PGlite;

async function query<T>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    return db.query<T>(sql, params);
}

async function seedPreflight(id: string, age: string): Promise<void> {
    await query(
        `INSERT INTO public.analysis_preflights (
            id, status, provider_selector, expires_at, updated_at,
            pii_scrubbed_at, target_input_hash, created_at
        ) VALUES (
            $1, 'expired', 'anonymous_apify',
            pg_catalog.clock_timestamp() - $2::INTERVAL,
            pg_catalog.clock_timestamp() - $2::INTERVAL,
            pg_catalog.clock_timestamp() - $2::INTERVAL, $3,
            pg_catalog.clock_timestamp() - $2::INTERVAL
        )`,
        [id, age, TARGET_HASH]
    );
    await query(
        `INSERT INTO public.analysis_preflight_provider_runs (
            preflight_id, operation_key, input_hash, logical_provider, actor_id,
            credential_slot, max_charge_usd, status, reserved_at, updated_at
        ) VALUES (
            $1, 'target-profile-fallback', $2, 'apify', $3,
            'primary', 0.002600000000, 'starting',
            pg_catalog.clock_timestamp() - $4::INTERVAL,
            pg_catalog.clock_timestamp() - $4::INTERVAL
        )`,
        [id, INPUT_HASH, ACTOR_ID, age]
    );
    await query(
        `INSERT INTO public.analysis_preflight_failures (id, preflight_id, stage, error_code)
         VALUES ($1, $2, 'profile', 'INTERNAL_ERROR')`,
        [id.replace(/1$/, '9'), id]
    );
}

async function resolverArgs(
    preflightId: string,
    evidenceHash = EVIDENCE_HASH
): Promise<unknown[]> {
    const reservedAt = (await query<{ reserved_at: string }>(
        'SELECT reserved_at FROM public.analysis_preflight_provider_runs WHERE preflight_id = $1',
        [preflightId]
    )).rows[0]?.reserved_at;
    return [
        preflightId,
        'target-profile-fallback',
        INPUT_HASH,
        'apify',
        ACTOR_ID,
        'primary',
        '0.002600000000',
        reservedAt,
        evidenceHash,
    ];
}

describe('retained anonymous identity-drift max-charge repair migration', () => {
    beforeAll(async () => {
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(bootstrap);
        await db.exec(migration);
        await seedPreflight(CANDIDATE_ID, '8 days');
        await seedPreflight(TOO_NEW_ID, '2 days');
        await seedPreflight(LIVE_LEASE_ID, '8 days');
        await query(
            `INSERT INTO public.analysis_provider_admission_leases (
                admission_id, request_id, logical_provider, credential_slot,
                state, expires_at
            ) VALUES ('admission-live', $1, 'apify', 'primary', 'leased',
                      pg_catalog.clock_timestamp() + INTERVAL '1 hour')`,
            [LIVE_LEASE_ID]
        );
    }, 30_000);

    afterAll(async () => {
        await db?.close();
    });

    it('applies the migration without changing the existing purge function', async () => {
        const result = await query<{ purge: number }>(
            'SELECT public.purge_expired_analysis_v2_preflights(1) AS purge'
        );
        expect(result.rows[0]?.purge).toBe(417);
    });

    it('lists only old, scrubbed, failed, drifted rows without a live admission', async () => {
        const result = await query<JsonResult<unknown>>(
            'SELECT public.list_analysis_preflight_ambiguous_identity_drift_candidates(20) AS result'
        );
        expect(result.rows[0]?.result).toEqual([
            expect.objectContaining({
                preflightId: CANDIDATE_ID,
                operationKey: 'target-profile-fallback',
                inputHash: INPUT_HASH,
                logicalProvider: 'apify',
                actorId: ACTOR_ID,
                credentialSlot: 'primary',
                maxChargeUsd: 0.0026,
            }),
        ]);
    });

    it('direct resolver rejects a short age fence and a live admission lease', async () => {
        await expect(query(
            `SELECT public.resolve_analysis_preflight_provider_run_identity_drift(
                $1,$2,$3,$4,$5,$6,$7,$8,$9
            )`,
            await resolverArgs(TOO_NEW_ID)
        )).rejects.toThrow(/ANALYSIS_PREFLIGHT_IDENTITY_DRIFT_NOT_READY/);
        await expect(query(
            `SELECT public.resolve_analysis_preflight_provider_run_identity_drift(
                $1,$2,$3,$4,$5,$6,$7,$8,$9
            )`,
            await resolverArgs(LIVE_LEASE_ID)
        )).rejects.toThrow(/ANALYSIS_PREFLIGHT_IDENTITY_DRIFT_NOT_READY/);
    });

    it('keeps the legacy no-run resolver from resolving an identity-drift row', async () => {
        await expect(query(
            `SELECT public.resolve_analysis_preflight_provider_run_no_run(
                $1,$2,$3,$4,$5,$6,$7,$8,$9
            )`,
            await resolverArgs(CANDIDATE_ID)
        )).rejects.toThrow(/ANALYSIS_PREFLIGHT_AMBIGUOUS_START_IDENTITY_DRIFT/);
    });

    it('resolves without a run id, retains the receipt, and replays idempotently', async () => {
        const args = await resolverArgs(CANDIDATE_ID);
        await query(
            `SELECT public.resolve_analysis_preflight_provider_run_identity_drift(
                $1,$2,$3,$4,$5,$6,$7,$8,$9
            )`,
            args
        );
        const afterFirst = await query<ProviderRow>(
            `SELECT status, run_id, actual_usage_usd, manual_resolution_evidence_hash,
                    usage_reconciled_at
             FROM public.analysis_preflight_provider_runs WHERE preflight_id = $1`,
            [CANDIDATE_ID]
        );
        expect(afterFirst.rows[0]).toMatchObject({
            status: 'resolved_identity_drift',
            run_id: null,
            actual_usage_usd: '0.002600000000',
            manual_resolution_evidence_hash: EVIDENCE_HASH,
        });
        expect(afterFirst.rows[0]?.usage_reconciled_at).not.toBeNull();

        const receipt = await query<{ count: number; error_code: string }>(
            `SELECT count(*)::INTEGER AS count,
                    min(error_code) AS error_code
             FROM public.analysis_preflight_failures WHERE preflight_id = $1`,
            [CANDIDATE_ID]
        );
        expect(receipt.rows[0]).toEqual({ count: 1, error_code: 'INTERNAL_ERROR' });
        const events = await query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count
             FROM public.analysis_preflight_acquisition_cost_events
             WHERE event_kind = 'provider_start_identity_drift'`,
        );
        expect(events.rows[0]?.count).toBe(1);

        const eventFields = await query<{
            event_kind: string;
            terminal_status: string;
            max_charge_usd: string;
            actual_usage_usd: string;
            evidence_reference_hash: string;
        }>(
            `SELECT event_kind, terminal_status, max_charge_usd,
                    actual_usage_usd, evidence_reference_hash
             FROM public.analysis_preflight_acquisition_cost_events
             WHERE event_kind = 'provider_start_identity_drift'`
        );
        expect(eventFields.rows[0]).toEqual({
            event_kind: 'provider_start_identity_drift',
            terminal_status: 'resolved_identity_drift',
            max_charge_usd: '0.002600000000',
            actual_usage_usd: '0.002600000000',
            evidence_reference_hash: EVIDENCE_HASH,
        });

        await Promise.all([
            query(
                `SELECT public.resolve_analysis_preflight_provider_run_identity_drift(
                    $1,$2,$3,$4,$5,$6,$7,$8,$9
                )`,
                args
            ),
            query(
                `SELECT public.resolve_analysis_preflight_provider_run_identity_drift(
                    $1,$2,$3,$4,$5,$6,$7,$8,$9
                )`,
                args
            ),
        ]);
        const replayEvents = await query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count
             FROM public.analysis_preflight_acquisition_cost_events
             WHERE event_kind = 'provider_start_identity_drift'`,
        );
        expect(replayEvents.rows[0]?.count).toBe(1);

        await expect(query(
            `SELECT public.resolve_analysis_preflight_provider_run_identity_drift(
                $1,$2,$3,$4,$5,$6,$7,$8,$9
            )`,
            await resolverArgs(CANDIDATE_ID, DIFFERENT_EVIDENCE_HASH)
        )).rejects.toThrow(/ANALYSIS_PREFLIGHT_IDENTITY_DRIFT_RESOLUTION_CONFLICT/);
    });

    it('rejects an event semantic conflict after ON CONFLICT DO NOTHING', async () => {
        const event = await query<{ billing_identity_hash: string; event_date: string }>(
            `SELECT billing_identity_hash, event_date
             FROM public.analysis_preflight_acquisition_cost_events
             WHERE event_kind = 'provider_start_identity_drift'`
        );
        expect(event.rows[0]).toBeDefined();
        await query(
            `UPDATE public.analysis_preflight_acquisition_cost_events
             SET event_date = event_date + 1
             WHERE billing_identity_hash = $1`,
            [event.rows[0]?.billing_identity_hash]
        );
        const reservedAt = (await query<{ reserved_at: string }>(
            'SELECT reserved_at FROM public.analysis_preflight_provider_runs WHERE preflight_id = $1',
            [CANDIDATE_ID]
        )).rows[0]?.reserved_at;
        await expect(query(
            `SELECT public.resolve_analysis_preflight_provider_run_identity_drift(
                $1,$2,$3,$4,$5,$6,$7,$8,$9
            )`,
            [
                CANDIDATE_ID, 'target-profile-fallback', INPUT_HASH, 'apify', ACTOR_ID,
                'primary', '0.002600000000', reservedAt, EVIDENCE_HASH,
            ]
        )).rejects.toThrow(/ANALYSIS_PREFLIGHT_ACQUISITION_COST_EVENT_CONFLICT/);
    });

    it('keeps the new recovery functions owner-only', async () => {
        const result = await query<{
            function_name: string;
            public_execute: boolean;
            anon_execute: boolean;
            authenticated_execute: boolean;
            service_role_execute: boolean;
        }>(`
            SELECT p.proname AS function_name,
                COALESCE(bool_or(acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'), FALSE)
                    AS public_execute,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute
            FROM pg_proc AS p
            JOIN pg_namespace AS n ON n.oid = p.pronamespace
            LEFT JOIN LATERAL aclexplode(
                COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
            ) AS acl ON TRUE
            WHERE n.nspname = 'public'
              AND p.proname IN (
                  'list_analysis_preflight_ambiguous_identity_drift_candidates',
                  'resolve_analysis_preflight_provider_run_identity_drift',
                  'record_analysis_preflight_identity_drift_cost_event'
              )
            GROUP BY p.oid, p.proname
            ORDER BY p.proname
        `);
        expect(result.rows).toHaveLength(3);
        for (const row of result.rows) {
            expect(row.public_execute).toBe(false);
            expect(row.anon_execute).toBe(false);
            expect(row.authenticated_execute).toBe(false);
            expect(row.service_role_execute).toBe(false);
        }
    });
});
