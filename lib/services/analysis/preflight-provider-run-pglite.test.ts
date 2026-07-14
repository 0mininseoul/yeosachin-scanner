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

const INPUT_HASH = 'a'.repeat(64);
const OTHER_INPUT_HASH = 'b'.repeat(64);
const CLAIM_TOKEN = '11111111-1111-4111-8111-111111111111';
const OTHER_CLAIM_TOKEN = '22222222-2222-4222-8222-222222222222';
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

interface ProviderRunJson {
    preflightId: string;
    operationKey: string;
    inputHash: string;
    logicalProvider: string;
    actorId: string;
    credentialSlot: string;
    maxChargeUsd: number;
    status: string;
    runId: string | null;
    actualUsageUsd: number | null;
    terminalizedAt: string | null;
}

interface ReservationJson {
    created: boolean;
    run: ProviderRunJson;
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

async function seedPreflight(
    preflightId: string,
    claimToken = CLAIM_TOKEN,
    leaseInterval = '5 minutes'
): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, status, lease_token, lease_expires_at, expires_at
        ) VALUES (
            $1, 'processing', $2,
            pg_catalog.clock_timestamp() + $3::INTERVAL,
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        )`,
        [preflightId, claimToken, leaseInterval]
    );
}

async function reserve(
    preflightId: string,
    credentialSlot = 'primary',
    inputHash = INPUT_HASH,
    claimToken = CLAIM_TOKEN
): Promise<ReservationJson> {
    const result = await serviceQuery<JsonRow<ReservationJson>>(
        `SELECT public.reserve_analysis_preflight_provider_run(
            $1, $2, $3, $4, $5
        ) AS result`,
        [preflightId, claimToken, inputHash, credentialSlot, '0.002600000000']
    );
    return result.rows[0].result;
}

async function terminalizeWithoutUsage(
    preflightId: string,
    credentialSlot = 'primary',
    status = 'succeeded'
): Promise<void> {
    await reserve(preflightId, credentialSlot);
    await serviceQuery(
        `SELECT public.checkpoint_analysis_preflight_provider_run_started(
            $1, $2, $3, $4, $5, $6
        )`,
        [preflightId, CLAIM_TOKEN, INPUT_HASH, credentialSlot, '0.0026', RUN_ID]
    );
    await serviceQuery(
        `SELECT public.checkpoint_analysis_preflight_provider_run_terminal(
            $1, $2, $3, $4, $5, $6, $7, $8
        )`,
        [
            preflightId,
            CLAIM_TOKEN,
            INPUT_HASH,
            credentialSlot,
            '0.0026',
            RUN_ID,
            status,
            null,
        ]
    );
}

describe('preflight Apify provider-run PGlite contract', () => {
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

    it('reserves all five credential slots without exposing direct service-role DML', async () => {
        const slots = ['primary', 'secondary', 'tertiary', 'quaternary', 'quinary'];

        for (const [index, slot] of slots.entries()) {
            const preflightId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
            await seedPreflight(preflightId);
            const reservation = await reserve(preflightId, slot);

            expect(reservation.created).toBe(true);
            expect(reservation.run).toMatchObject({
                preflightId,
                operationKey: 'target-profile-fallback',
                inputHash: INPUT_HASH,
                logicalProvider: 'apify',
                actorId: 'apify/instagram-profile-scraper',
                credentialSlot: slot,
                status: 'starting',
                runId: null,
            });
        }

        await expect(serviceQuery(
            'SELECT * FROM public.analysis_preflight_provider_runs'
        )).rejects.toThrow(/permission denied/i);
        await expect(serviceQuery(
            'SELECT * FROM public.analysis_preflight_acquisition_cost_events'
        )).rejects.toThrow(/permission denied/i);
        await expect(serviceQuery(
            `SELECT public.record_analysis_preflight_provider_cost_event(
                $1, 'apify', 'apify/instagram-profile-scraper', 'primary',
                'succeeded', 0.0026, 0.0025, CURRENT_DATE
            )`,
            [RUN_ID]
        )).rejects.toThrow(/permission denied/i);
    });

    it('exposes global usage reconciliation only to the service role', async () => {
        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(
                'SELECT public.list_analysis_preflight_unreconciled_provider_runs(1)'
            )).rejects.toThrow(/permission denied/i);
            await expect(db.query(
                `SELECT public.reconcile_analysis_preflight_provider_run_usage(
                    $1, $2, $3, $4, $5, $6, $7, $8, $9,
                    pg_catalog.clock_timestamp() - INTERVAL '45 seconds'
                )`,
                [
                    '00000000-0000-4000-8000-000000000001',
                    INPUT_HASH,
                    RUN_ID,
                    'apify',
                    'apify/instagram-profile-scraper',
                    'primary',
                    '0.0026',
                    'succeeded',
                    '0.0025',
                ]
            )).rejects.toThrow(/permission denied/i);
            await expect(db.query(
                `SELECT public.aggregate_analysis_preflight_acquisition_costs(
                    CURRENT_DATE, CURRENT_DATE + 1
                )`
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('marks the period aggregate STABLE so all reads use one statement snapshot', async () => {
        const volatility = await db.query<{ provolatile: string }>(
            `SELECT procedure.provolatile::TEXT
             FROM pg_catalog.pg_proc AS procedure
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid = procedure.pronamespace
             WHERE namespace.nspname = 'public'
               AND procedure.proname = 'aggregate_analysis_preflight_acquisition_costs'`
        );
        expect(volatility.rows).toEqual([{ provolatile: 's' }]);
    });

    it('returns an ambiguous starting replay and never creates a second intent', async () => {
        const preflightId = '10000000-0000-4000-8000-000000000001';
        await seedPreflight(preflightId);

        expect((await reserve(preflightId)).created).toBe(true);
        const replay = await reserve(preflightId);
        expect(replay).toMatchObject({
            created: false,
            run: { status: 'starting', runId: null },
        });

        const loaded = await serviceQuery<JsonRow<ProviderRunJson>>(
            'SELECT public.load_analysis_preflight_provider_run($1, $2, $3) AS result',
            [preflightId, CLAIM_TOKEN, INPUT_HASH]
        );
        expect(loaded.rows[0].result).toMatchObject({ status: 'starting', runId: null });

        const count = await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_preflight_provider_runs'
        );
        expect(count.rows[0].count).toBe(1);
    });

    it('rejects replay identity drift without changing the original row', async () => {
        const preflightId = '20000000-0000-4000-8000-000000000001';
        await seedPreflight(preflightId);
        await reserve(preflightId);

        await expect(reserve(preflightId, 'primary', OTHER_INPUT_HASH)).rejects.toThrow(
            /ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT/
        );
        await expect(reserve(preflightId, 'secondary')).rejects.toThrow(
            /ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT/
        );

        const stored = await db.query<{
            input_hash: string;
            credential_slot: string;
            status: string;
            run_id: string | null;
        }>(
            `SELECT input_hash, credential_slot, status, run_id
             FROM public.analysis_preflight_provider_runs
             WHERE preflight_id = $1`,
            [preflightId]
        );
        expect(stored.rows[0]).toEqual({
            input_hash: INPUT_HASH,
            credential_slot: 'primary',
            status: 'starting',
            run_id: null,
        });
    });

    it('retains the run ID after success so the dataset can be reread', async () => {
        const preflightId = '30000000-0000-4000-8000-000000000001';
        await seedPreflight(preflightId);
        await reserve(preflightId, 'quinary');

        const started = await serviceQuery<JsonRow<ProviderRunJson>>(
            `SELECT public.checkpoint_analysis_preflight_provider_run_started(
                $1, $2, $3, $4, $5, $6
            ) AS result`,
            [preflightId, CLAIM_TOKEN, INPUT_HASH, 'quinary', '0.0026', RUN_ID]
        );
        expect(started.rows[0].result).toMatchObject({ status: 'running', runId: RUN_ID });

        const terminal = await serviceQuery<JsonRow<ProviderRunJson>>(
            `SELECT public.checkpoint_analysis_preflight_provider_run_terminal(
                $1, $2, $3, $4, $5, $6, $7, $8
            ) AS result`,
            [
                preflightId,
                CLAIM_TOKEN,
                INPUT_HASH,
                'quinary',
                '0.0026',
                RUN_ID,
                'succeeded',
                '0.0026',
            ]
        );
        expect(terminal.rows[0].result).toMatchObject({
            status: 'succeeded',
            runId: RUN_ID,
            actualUsageUsd: 0.0026,
        });

        await serviceQuery(
            `SELECT public.checkpoint_analysis_preflight_provider_run_terminal(
                $1, $2, $3, $4, $5, $6, $7, $8
            )`,
            [
                preflightId,
                CLAIM_TOKEN,
                INPUT_HASH,
                'quinary',
                '0.0026',
                RUN_ID,
                'succeeded',
                '0.0026',
            ]
        );
        const events = await db.query<{
            billing_identity_hash: string;
            event_kind: string;
            actual_usage_usd: string;
        }>(
            `SELECT billing_identity_hash, event_kind, actual_usage_usd
             FROM public.analysis_preflight_acquisition_cost_events`
        );
        expect(events.rows).toEqual([{
            billing_identity_hash: createHash('sha256')
                .update(`provider_run:${RUN_ID}`, 'utf8')
                .digest('hex'),
            event_kind: 'provider_run',
            actual_usage_usd: '0.002600000000',
        }]);

        const loaded = await serviceQuery<JsonRow<ProviderRunJson>>(
            'SELECT public.load_analysis_preflight_provider_run($1, $2, $3) AS result',
            [preflightId, CLAIM_TOKEN, INPUT_HASH]
        );
        expect(loaded.rows[0].result).toMatchObject({ status: 'succeeded', runId: RUN_ID });
    });

    it('lists only settled terminal rows and reconciles one exact PII-free identity', async () => {
        const preflightId = '35000000-0000-4000-8000-000000000001';
        await seedPreflight(preflightId);
        await terminalizeWithoutUsage(preflightId, 'tertiary');

        const tooFresh = await serviceQuery<JsonRow<ProviderRunJson[]>>(
            'SELECT public.list_analysis_preflight_unreconciled_provider_runs($1) AS result',
            [17]
        );
        expect(tooFresh.rows[0].result).toEqual([]);

        await db.query(
            `UPDATE public.analysis_preflight_provider_runs
             SET reserved_at = pg_catalog.clock_timestamp() - INTERVAL '2 minutes',
                 run_started_at = pg_catalog.clock_timestamp() - INTERVAL '90 seconds',
                 terminalized_at = pg_catalog.clock_timestamp() - INTERVAL '31 seconds'
             WHERE preflight_id = $1`,
            [preflightId]
        );
        const listed = await serviceQuery<JsonRow<ProviderRunJson[]>>(
            'SELECT public.list_analysis_preflight_unreconciled_provider_runs($1) AS result',
            [17]
        );
        expect(listed.rows[0].result).toEqual([
            expect.objectContaining({
                preflightId,
                inputHash: INPUT_HASH,
                credentialSlot: 'tertiary',
                status: 'succeeded',
                runId: RUN_ID,
                actualUsageUsd: null,
            }),
        ]);

        await expect(serviceQuery(
            `SELECT public.reconcile_analysis_preflight_provider_run_usage(
                    $1, $2, $3, $4, $5, $6, $7, $8, $9,
                    pg_catalog.clock_timestamp() - INTERVAL '45 seconds'
            )`,
            [
                preflightId,
                INPUT_HASH,
                RUN_ID,
                'apify',
                'apify/instagram-profile-scraper',
                'tertiary',
                '0.0026',
                'failed',
                '0.0025',
            ]
        )).rejects.toThrow(/RECONCILIATION_CONFLICT/);

        const reconciled = await serviceQuery<JsonRow<ProviderRunJson>>(
            `SELECT public.reconcile_analysis_preflight_provider_run_usage(
                    $1, $2, $3, $4, $5, $6, $7, $8, $9,
                    pg_catalog.statement_timestamp() - INTERVAL '30 seconds'
            ) AS result`,
            [
                preflightId,
                INPUT_HASH,
                RUN_ID,
                'apify',
                'apify/instagram-profile-scraper',
                'tertiary',
                '0.0026',
                'succeeded',
                '0.0025',
            ]
        );
        expect(reconciled.rows[0].result).toMatchObject({
            preflightId,
            status: 'succeeded',
            actualUsageUsd: 0.0025,
        });

        const noneLeft = await serviceQuery<JsonRow<ProviderRunJson[]>>(
            'SELECT public.list_analysis_preflight_unreconciled_provider_runs($1) AS result',
            [17]
        );
        expect(noneLeft.rows[0].result).toEqual([]);
    });

    it('reports live unsettled exposure and moves it to the provider UTC finish date', async () => {
        const preflightId = '35500000-0000-4000-8000-000000000001';
        await seedPreflight(preflightId);
        await terminalizeWithoutUsage(preflightId, 'secondary');
        await db.query(
            `UPDATE public.analysis_preflight_provider_runs
             SET reserved_at = date_trunc('day', pg_catalog.clock_timestamp())
                    - INTERVAL '2 minutes',
                 run_started_at = date_trunc('day', pg_catalog.clock_timestamp())
                    - INTERVAL '90 seconds',
                 terminalized_at = pg_catalog.clock_timestamp() - INTERVAL '31 seconds'
             WHERE preflight_id = $1`,
            [preflightId]
        );

        const before = await serviceQuery<JsonRow<{
            unsettledCount: number;
            unsettledMaximumChargeUsd: number;
            hasUnsettled: boolean;
            isComplete: boolean;
            unsettledRows: Array<{ credentialSlot: string; runCount: number }>;
            rows: unknown[];
        }>>(
            `SELECT public.aggregate_analysis_preflight_acquisition_costs(
                CURRENT_DATE - 1, CURRENT_DATE + 1
            ) AS result`
        );
        expect(before.rows[0].result).toMatchObject({
            unsettledCount: 1,
            unsettledMaximumChargeUsd: 0.0026,
            hasUnsettled: true,
            isComplete: false,
            unsettledRows: [{ credentialSlot: 'secondary', runCount: 1 }],
            rows: [],
        });

        await serviceQuery(
            `SELECT public.reconcile_analysis_preflight_provider_run_usage(
                $1, $2, $3, $4, $5, $6, $7, $8, $9,
                date_trunc('day', pg_catalog.clock_timestamp()) - INTERVAL '30 seconds'
            )`,
            [
                preflightId,
                INPUT_HASH,
                RUN_ID,
                'apify',
                'apify/instagram-profile-scraper',
                'secondary',
                '0.0026',
                'succeeded',
                '0.0025',
            ]
        );

        const after = await serviceQuery<JsonRow<{
            unsettledCount: number;
            unsettledMaximumChargeUsd: number;
            hasUnsettled: boolean;
            isComplete: boolean;
            unsettledRows: unknown[];
            rows: Array<{ eventDate: string; actualUsageUsd: number }>;
        }>>(
            `SELECT public.aggregate_analysis_preflight_acquisition_costs(
                CURRENT_DATE - 1, CURRENT_DATE + 1
            ) AS result`
        );
        expect(after.rows[0].result).toMatchObject({
            unsettledCount: 0,
            unsettledMaximumChargeUsd: 0,
            hasUnsettled: false,
            isComplete: true,
            unsettledRows: [],
            rows: [{
                eventDate: expect.any(String),
                actualUsageUsd: 0.0025,
            }],
        });
        const expectedDate = await db.query<{ event_date: string }>(
            `SELECT (CURRENT_DATE - 1)::TEXT AS event_date`
        );
        expect(after.rows[0].result.rows[0].eventDate).toBe(
            expectedDate.rows[0].event_date
        );
    });

    it('accepts exactly 30-second-old provider finish time and rejects 29.999 seconds', async () => {
        const preflightId = '35700000-0000-4000-8000-000000000001';
        await seedPreflight(preflightId);
        await terminalizeWithoutUsage(preflightId, 'secondary');
        await db.query(
            `UPDATE public.analysis_preflight_provider_runs
             SET reserved_at = pg_catalog.statement_timestamp() - INTERVAL '2 minutes',
                 run_started_at = pg_catalog.statement_timestamp() - INTERVAL '90 seconds',
                 terminalized_at = pg_catalog.statement_timestamp() - INTERVAL '31 seconds'
             WHERE preflight_id = $1`,
            [preflightId]
        );

        const reconcileAtAge = (age: string) => serviceQuery<JsonRow<ProviderRunJson>>(
            `SELECT public.reconcile_analysis_preflight_provider_run_usage(
                $1, $2, $3, $4, $5, $6, $7, $8, $9,
                pg_catalog.statement_timestamp() - $10::INTERVAL
            ) AS result`,
            [
                preflightId,
                INPUT_HASH,
                RUN_ID,
                'apify',
                'apify/instagram-profile-scraper',
                'secondary',
                '0.0026',
                'succeeded',
                '0.0025',
                age,
            ]
        );

        await expect(reconcileAtAge('29.999 seconds')).rejects.toThrow(
            /ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID/
        );
        await expect(reconcileAtAge('30 seconds')).resolves.toMatchObject({
            rows: [{
                result: expect.objectContaining({
                    status: 'succeeded',
                    actualUsageUsd: 0.0025,
                }),
            }],
        });
    });

    it('rejects reconciliation above the fixed charge cap and invalid credential identity', async () => {
        const preflightId = '36000000-0000-4000-8000-000000000001';
        await seedPreflight(preflightId);
        await terminalizeWithoutUsage(preflightId, 'quinary');
        await db.query(
            `UPDATE public.analysis_preflight_provider_runs
             SET reserved_at = pg_catalog.clock_timestamp() - INTERVAL '2 minutes',
                 run_started_at = pg_catalog.clock_timestamp() - INTERVAL '90 seconds',
                 terminalized_at = pg_catalog.clock_timestamp() - INTERVAL '31 seconds'
             WHERE preflight_id = $1`,
            [preflightId]
        );

        const reconcile = (slot: string, usage: string) => serviceQuery(
            `SELECT public.reconcile_analysis_preflight_provider_run_usage(
                    $1, $2, $3, $4, $5, $6, $7, $8, $9,
                    pg_catalog.clock_timestamp() - INTERVAL '45 seconds'
            )`,
            [
                preflightId,
                INPUT_HASH,
                RUN_ID,
                'apify',
                'apify/instagram-profile-scraper',
                slot,
                '0.0026',
                'succeeded',
                usage,
            ]
        );
        await expect(reconcile('quinary', '0.0027')).rejects.toThrow(
            /ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID/
        );
        await expect(reconcile('primary', '0.0025')).rejects.toThrow(
            /RECONCILIATION_CONFLICT/
        );
    });

    it('rolls back ledger cost reconciliation on a hashed billing-event conflict', async () => {
        const preflightId = '36500000-0000-4000-8000-000000000001';
        await seedPreflight(preflightId);
        await terminalizeWithoutUsage(preflightId, 'primary');
        await db.query(
            `UPDATE public.analysis_preflight_provider_runs
             SET reserved_at = pg_catalog.clock_timestamp() - INTERVAL '2 minutes',
                 run_started_at = pg_catalog.clock_timestamp() - INTERVAL '90 seconds',
                 terminalized_at = pg_catalog.clock_timestamp() - INTERVAL '31 seconds'
             WHERE preflight_id = $1`,
            [preflightId]
        );
        await db.query(
            `INSERT INTO public.analysis_preflight_acquisition_cost_events (
                billing_identity_hash,
                event_kind,
                logical_provider,
                actor_id,
                credential_slot,
                terminal_status,
                max_charge_usd,
                actual_usage_usd,
                event_date
            ) VALUES ($1, 'provider_run', 'apify',
                'apify/instagram-profile-scraper', 'primary', 'succeeded',
                0.0026, 0.0010, CURRENT_DATE)`,
            [createHash('sha256').update(`provider_run:${RUN_ID}`, 'utf8').digest('hex')]
        );

        await expect(serviceQuery(
            `SELECT public.reconcile_analysis_preflight_provider_run_usage(
                    $1, $2, $3, $4, $5, $6, $7, $8, $9,
                    pg_catalog.clock_timestamp() - INTERVAL '45 seconds'
            )`,
            [
                preflightId,
                INPUT_HASH,
                RUN_ID,
                'apify',
                'apify/instagram-profile-scraper',
                'primary',
                '0.0026',
                'succeeded',
                '0.0025',
            ]
        )).rejects.toThrow(/ACQUISITION_COST_EVENT_CONFLICT/);

        const ledger = await db.query<{ actual_usage_usd: number | null }>(
            `SELECT actual_usage_usd
             FROM public.analysis_preflight_provider_runs
             WHERE preflight_id = $1`,
            [preflightId]
        );
        expect(ledger.rows[0].actual_usage_usd).toBeNull();
    });

    it('settles a stale running run after its blocked preflight expires, then permits purge', async () => {
        const preflightId = '37000000-0000-4000-8000-000000000001';
        await seedPreflight(preflightId);
        await reserve(preflightId, 'quaternary');
        await serviceQuery(
            `SELECT public.checkpoint_analysis_preflight_provider_run_started(
                $1, $2, $3, $4, $5, $6
            )`,
            [preflightId, CLAIM_TOKEN, INPUT_HASH, 'quaternary', '0.0026', RUN_ID]
        );
        await db.query(
            `UPDATE public.analysis_preflight_provider_runs
             SET reserved_at = pg_catalog.clock_timestamp() - INTERVAL '2 minutes',
                 run_started_at = pg_catalog.clock_timestamp() - INTERVAL '31 seconds',
                 updated_at = pg_catalog.clock_timestamp() - INTERVAL '31 seconds'
             WHERE preflight_id = $1`,
            [preflightId]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'blocked',
                 lease_token = NULL,
                 lease_expires_at = NULL,
                 expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 minute',
                 created_at = pg_catalog.clock_timestamp() - INTERVAL '2 hours'
             WHERE id = $1`,
            [preflightId]
        );

        const firstPurge = await serviceQuery<{ result: number }>(
            'SELECT public.purge_expired_analysis_v2_preflights(10) AS result'
        );
        expect(firstPurge.rows[0].result).toBe(1);
        const retained = await db.query<{ status: string; run_status: string }>(
            `SELECT preflight.status, provider_run.status AS run_status
             FROM public.analysis_preflights AS preflight
             JOIN public.analysis_preflight_provider_runs AS provider_run
               ON provider_run.preflight_id = preflight.id
             WHERE preflight.id = $1`,
            [preflightId]
        );
        expect(retained.rows[0]).toEqual({ status: 'expired', run_status: 'running' });

        const listed = await serviceQuery<JsonRow<ProviderRunJson[]>>(
            'SELECT public.list_analysis_preflight_unreconciled_provider_runs(17) AS result'
        );
        expect(listed.rows[0].result).toEqual([
            expect.objectContaining({
                preflightId,
                status: 'running',
                runId: RUN_ID,
                credentialSlot: 'quaternary',
            }),
        ]);

        const reconciled = await serviceQuery<JsonRow<ProviderRunJson>>(
            `SELECT public.reconcile_analysis_preflight_provider_run_usage(
                    $1, $2, $3, $4, $5, $6, $7, $8, $9,
                    pg_catalog.statement_timestamp() - INTERVAL '30 seconds'
            ) AS result`,
            [
                preflightId,
                INPUT_HASH,
                RUN_ID,
                'apify',
                'apify/instagram-profile-scraper',
                'quaternary',
                '0.0026',
                'succeeded',
                '0.0025',
            ]
        );
        expect(reconciled.rows[0].result).toMatchObject({
            status: 'succeeded',
            runId: RUN_ID,
            actualUsageUsd: 0.0025,
            terminalizedAt: expect.any(String),
        });
        const terminalizedAt = Date.parse(reconciled.rows[0].result.terminalizedAt!);
        expect(Date.now() - terminalizedAt).toBeGreaterThanOrEqual(25_000);
        expect(Date.now() - terminalizedAt).toBeLessThan(40_000);

        const beforePurge = await serviceQuery<JsonRow<{
            rows: Array<{
                eventKind: string;
                eventCount: number;
                actualUsageUsd: number;
            }>;
        }>>(
            `SELECT public.aggregate_analysis_preflight_acquisition_costs(
                CURRENT_DATE - 1, CURRENT_DATE + 2
            ) AS result`
        );
        expect(beforePurge.rows[0].result.rows).toEqual([
            expect.objectContaining({
                eventKind: 'provider_run',
                eventCount: 1,
                actualUsageUsd: 0.0025,
            }),
        ]);

        const secondPurge = await serviceQuery<{ result: number }>(
            'SELECT public.purge_expired_analysis_v2_preflights(10) AS result'
        );
        expect(secondPurge.rows[0].result).toBe(1);
        const counts = await db.query<{ preflights: number; runs: number }>(
            `SELECT
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_preflights)
                    AS preflights,
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_preflight_provider_runs) AS runs`
        );
        expect(counts.rows[0]).toEqual({ preflights: 0, runs: 0 });

        const afterPurge = await serviceQuery<JsonRow<{
            rows: Array<{
                eventKind: string;
                eventCount: number;
                actualUsageUsd: number;
            }>;
        }>>(
            `SELECT public.aggregate_analysis_preflight_acquisition_costs(
                CURRENT_DATE - 1, CURRENT_DATE + 2
            ) AS result`
        );
        expect(afterPurge.rows[0].result).toEqual(beforePurge.rows[0].result);
        const eventCount = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_preflight_acquisition_cost_events`
        );
        expect(eventCount.rows[0].count).toBe(1);
    });

    it('rejects reserve, load, started, and terminal transitions after the lease expires', async () => {
        const preflightId = '40000000-0000-4000-8000-000000000001';
        await seedPreflight(preflightId);
        await reserve(preflightId);
        await db.query(
            `UPDATE public.analysis_preflights
             SET lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
             WHERE id = $1`,
            [preflightId]
        );

        const calls = [
            () => reserve(preflightId),
            () => serviceQuery(
                'SELECT public.load_analysis_preflight_provider_run($1, $2, $3)',
                [preflightId, CLAIM_TOKEN, INPUT_HASH]
            ),
            () => serviceQuery(
                'SELECT public.checkpoint_analysis_preflight_provider_run_started($1, $2, $3, $4, $5, $6)',
                [preflightId, CLAIM_TOKEN, INPUT_HASH, 'primary', '0.0026', RUN_ID]
            ),
            () => serviceQuery(
                'SELECT public.checkpoint_analysis_preflight_provider_run_terminal($1, $2, $3, $4, $5, $6, $7, $8)',
                [
                    preflightId,
                    CLAIM_TOKEN,
                    INPUT_HASH,
                    'primary',
                    '0.0026',
                    RUN_ID,
                    'failed',
                    null,
                ]
            ),
        ];

        for (const call of calls) {
            await expect(call()).rejects.toThrow(
                /ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH/
            );
        }
    });

    it('rejects a stale claim and deletes the ledger when its preflight is deleted', async () => {
        const preflightId = '50000000-0000-4000-8000-000000000001';
        await seedPreflight(preflightId);

        await expect(reserve(
            preflightId,
            'primary',
            INPUT_HASH,
            OTHER_CLAIM_TOKEN
        )).rejects.toThrow(/ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH/);

        await reserve(preflightId);
        await db.query('DELETE FROM public.analysis_preflights WHERE id = $1', [preflightId]);
        const count = await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_preflight_provider_runs'
        );
        expect(count.rows[0].count).toBe(0);
    });
});
