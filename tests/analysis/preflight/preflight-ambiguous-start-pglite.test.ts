import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260714175411_add_preflight_apify_provider_run_ledger.sql',
        import.meta.url
    ),
    'utf8'
);

const PREFLIGHT_ID = '70000000-0000-4000-8000-000000000001';
const INPUT_HASH = 'a'.repeat(64);
const OTHER_INPUT_HASH = 'b'.repeat(64);
const EVIDENCE_HASH = 'c'.repeat(64);
const OTHER_EVIDENCE_HASH = 'd'.repeat(64);
const CLAIM_TOKEN = '11111111-1111-4111-8111-111111111111';
const RUN_ID = 'ApifyRun12345678';

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

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

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    status TEXT NOT NULL,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
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
`;

interface JsonRow<T> {
    result: T;
}

interface Candidate {
    preflightId: string;
    operationKey: string;
    inputHash: string;
    logicalProvider: string;
    actorId: string;
    credentialSlot: string;
    maxChargeUsd: number;
    reservedAt: string;
}

interface ResolvedRun extends Candidate {
    status: 'resolved_no_run';
    runId: null;
    actualUsageUsd: number;
    terminalizedAt: string;
    usageReconciledAt: string;
    manualResolvedAt: string;
    evidenceReferenceHash: string;
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

async function seedStarting(preflightId = PREFLIGHT_ID): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, status, lease_token, lease_expires_at, expires_at
        ) VALUES (
            $1, 'processing', $2,
            pg_catalog.clock_timestamp() + INTERVAL '5 minutes',
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        )`,
        [preflightId, CLAIM_TOKEN]
    );
    await serviceQuery(
        `SELECT public.reserve_analysis_preflight_provider_run(
            $1, $2, $3, $4, $5
        )`,
        [preflightId, CLAIM_TOKEN, INPUT_HASH, 'quinary', '0.002600000000']
    );
}

async function ageCandidate(
    preflightId = PREFLIGHT_ID,
    providerAge = '31 minutes'
): Promise<string> {
    await db.query(
        `UPDATE public.analysis_preflight_provider_runs
         SET reserved_at = pg_catalog.clock_timestamp() - $2::INTERVAL,
             updated_at = pg_catalog.clock_timestamp() - $2::INTERVAL
         WHERE preflight_id = $1`,
        [preflightId, providerAge]
    );
    await db.query(
        `UPDATE public.analysis_preflights
         SET expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 minute',
             lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 minute',
             created_at = pg_catalog.clock_timestamp() - INTERVAL '2 hours'
         WHERE id = $1`,
        [preflightId]
    );
    const reserved = await db.query<{ reserved_at: string }>(
        `SELECT reserved_at::TEXT
         FROM public.analysis_preflight_provider_runs
         WHERE preflight_id = $1`,
        [preflightId]
    );
    return reserved.rows[0].reserved_at;
}

async function resolve(
    reservedAt: string,
    overrides: Partial<{
        inputHash: string;
        statusEvidenceHash: string;
        credentialSlot: string;
    }> = {}
): Promise<Results<JsonRow<ResolvedRun>>> {
    return db.query<JsonRow<ResolvedRun>>(
        `SELECT public.resolve_analysis_preflight_provider_run_no_run(
            $1, $2, $3, $4, $5, $6, $7, $8, $9
        ) AS result`,
        [
            PREFLIGHT_ID,
            'target-profile-fallback',
            overrides.inputHash ?? INPUT_HASH,
            'apify',
            'apify/instagram-profile-scraper',
            overrides.credentialSlot ?? 'quinary',
            '0.002600000000',
            reservedAt,
            overrides.statusEvidenceHash ?? EVIDENCE_HASH,
        ]
    );
}

describe('preflight ambiguous Apify start manual resolution PGlite', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(bootstrap);
        await db.exec(migration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(
            `TRUNCATE public.analysis_preflight_acquisition_cost_events,
                public.analysis_preflight_provider_runs,
                public.analysis_preflights`
        );
    });

    afterAll(async () => {
        await db.close();
    });

    it('keeps candidate listing service-only and resolution database-owner-only', async () => {
        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(
                'SELECT public.list_analysis_preflight_ambiguous_start_candidates(1)'
            )).rejects.toThrow(/permission denied/i);
            await expect(db.query(
                `SELECT public.resolve_analysis_preflight_provider_run_no_run(
                    $1, $2, $3, $4, $5, $6, $7, $8, $9
                )`,
                [
                    PREFLIGHT_ID,
                    'target-profile-fallback',
                    INPUT_HASH,
                    'apify',
                    'apify/instagram-profile-scraper',
                    'quinary',
                    '0.002600000000',
                    new Date().toISOString(),
                    EVIDENCE_HASH,
                ]
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }

        await expect(serviceQuery(
            `SELECT public.resolve_analysis_preflight_provider_run_no_run(
                $1, $2, $3, $4, $5, $6, $7, $8, $9
            )`,
            [
                PREFLIGHT_ID,
                'target-profile-fallback',
                INPUT_HASH,
                'apify',
                'apify/instagram-profile-scraper',
                'quinary',
                '0.002600000000',
                new Date().toISOString(),
                EVIDENCE_HASH,
            ]
        )).rejects.toThrow(/permission denied/i);
    });

    it('rejects a row before the full 30-minute quiet period', async () => {
        await seedStarting();
        const reservedAt = await ageCandidate(PREFLIGHT_ID, '29 minutes');
        const candidates = await serviceQuery<JsonRow<Candidate[]>>(
            'SELECT public.list_analysis_preflight_ambiguous_start_candidates(20) AS result'
        );
        expect(candidates.rows[0].result).toEqual([]);
        await expect(resolve(reservedAt)).rejects.toThrow(
            /ANALYSIS_PREFLIGHT_AMBIGUOUS_START_NOT_READY/
        );
    });

    it('returns a bounded PII-free candidate and rejects immutable identity drift', async () => {
        await seedStarting();
        const reservedAt = await ageCandidate();
        const candidates = await serviceQuery<JsonRow<Candidate[]>>(
            'SELECT public.list_analysis_preflight_ambiguous_start_candidates(1) AS result'
        );
        expect(candidates.rows[0].result).toEqual([{
            preflightId: PREFLIGHT_ID,
            operationKey: 'target-profile-fallback',
            inputHash: INPUT_HASH,
            logicalProvider: 'apify',
            actorId: 'apify/instagram-profile-scraper',
            credentialSlot: 'quinary',
            maxChargeUsd: 0.0026,
            reservedAt: expect.any(String),
        }]);
        expect(Date.parse(candidates.rows[0].result[0].reservedAt)).toBe(
            Date.parse(reservedAt)
        );

        await expect(resolve(reservedAt, { inputHash: OTHER_INPUT_HASH }))
            .rejects.toThrow(/ANALYSIS_PREFLIGHT_AMBIGUOUS_START_IDENTITY_CONFLICT/);
        await expect(resolve(reservedAt, { credentialSlot: 'primary' }))
            .rejects.toThrow(/ANALYSIS_PREFLIGHT_AMBIGUOUS_START_IDENTITY_CONFLICT/);
    });

    it('rejects a non-starting provider row', async () => {
        await seedStarting();
        await serviceQuery(
            `SELECT public.checkpoint_analysis_preflight_provider_run_started(
                $1, $2, $3, $4, $5, $6
            )`,
            [PREFLIGHT_ID, CLAIM_TOKEN, INPUT_HASH, 'quinary', '0.0026', RUN_ID]
        );
        const reservedAt = await ageCandidate();
        await expect(resolve(reservedAt)).rejects.toThrow(
            /ANALYSIS_PREFLIGHT_AMBIGUOUS_START_STATE_CONFLICT/
        );
    });

    it('resolves exactly once, permits exact replay, and rejects evidence conflict', async () => {
        await seedStarting();
        const reservedAt = await ageCandidate();
        const first = await resolve(reservedAt);
        expect(first.rows[0].result).toMatchObject({
            preflightId: PREFLIGHT_ID,
            status: 'resolved_no_run',
            runId: null,
            actualUsageUsd: 0,
            evidenceReferenceHash: EVIDENCE_HASH,
        });

        const replay = await resolve(reservedAt);
        expect(replay.rows[0].result).toEqual(first.rows[0].result);
        await expect(resolve(reservedAt, {
            statusEvidenceHash: OTHER_EVIDENCE_HASH,
        })).rejects.toThrow(/ANALYSIS_PREFLIGHT_AMBIGUOUS_START_RESOLUTION_CONFLICT/);

        const events = await db.query<{
            billing_identity_hash: string;
            event_kind: string;
            logical_provider: string;
            actor_id: string;
            credential_slot: string;
            terminal_status: string;
            actual_usage_usd: number | string;
            evidence_reference_hash: string;
        }>(
            `SELECT billing_identity_hash, event_kind, logical_provider, actor_id,
                credential_slot, terminal_status,
                actual_usage_usd, evidence_reference_hash
             FROM public.analysis_preflight_acquisition_cost_events`
        );
        expect(events.rows).toEqual([{
            billing_identity_hash: createHash('sha256')
                .update(`manual_no_run:${PREFLIGHT_ID}:${EVIDENCE_HASH}`, 'utf8')
                .digest('hex'),
            event_kind: 'manual_no_run',
            logical_provider: 'apify',
            actor_id: 'apify/instagram-profile-scraper',
            credential_slot: 'quinary',
            terminal_status: 'resolved_no_run',
            actual_usage_usd: '0.000000000000',
            evidence_reference_hash: EVIDENCE_HASH,
        }]);
    });

    it('releases purge only after resolution while preserving the PII-free event', async () => {
        await seedStarting();
        const reservedAt = await ageCandidate();

        const fencedPurge = await serviceQuery<{ result: number }>(
            'SELECT public.purge_expired_analysis_v2_preflights(10) AS result'
        );
        expect(fencedPurge.rows[0].result).toBe(1);

        await resolve(reservedAt);
        const purged = await serviceQuery<{ result: number }>(
            'SELECT public.purge_expired_analysis_v2_preflights(10) AS result'
        );
        expect(purged.rows[0].result).toBe(1);

        const counts = await db.query<{
            preflights: number;
            provider_runs: number;
            cost_events: number;
        }>(
            `SELECT
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_preflights) AS preflights,
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_preflight_provider_runs) AS provider_runs,
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_preflight_acquisition_cost_events) AS cost_events`
        );
        expect(counts.rows[0]).toEqual({
            preflights: 0,
            provider_runs: 0,
            cost_events: 1,
        });

        const aggregate = await serviceQuery<JsonRow<{
            rows: Array<{
                eventKind: string;
                credentialSlot: string;
                eventCount: number;
                actualUsageUsd: number;
            }>;
        }>>(
            `SELECT public.aggregate_analysis_preflight_acquisition_costs(
                CURRENT_DATE - 1, CURRENT_DATE + 2
            ) AS result`
        );
        expect(aggregate.rows[0].result.rows).toEqual([
            expect.objectContaining({
                eventKind: 'manual_no_run',
                credentialSlot: 'quinary',
                eventCount: 1,
                actualUsageUsd: 0,
            }),
        ]);
    });
});
