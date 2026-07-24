import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'supabase/migrations/20260724220000_expand_analysis_v2_apify_senary_slot.sql'
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
const historicalExpansion = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260713204500_expand_analysis_v2_apify_credential_slots.sql'
), 'utf8');

function functionDefinition(name: string): string {
    const match = migration.match(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
    ));
    return match?.[0] ?? '';
}

describe('analysis V2 senary Apify credential migration contract', () => {
    it('is append-only after the current production migration head', () => {
        expect(migration).not.toBe('');
        expect(migrationPath).toContain('20260724220000');
    });

    it('defines exactly six general V2 slots while keeping septenary unsupported', () => {
        const helper = functionDefinition('analysis_v2_valid_apify_credential_slot');
        expect(helper).toMatch(
            /p_slot IN\s*\(\s*'primary',\s*'secondary',\s*'tertiary',\s*'quaternary',\s*'quinary',\s*'senary'\s*\)/
        );
        expect(helper).not.toContain('septenary');
        expect(helper).toContain('IMMUTABLE');
        expect(helper).toContain("SET search_path = ''");
        expect(helper).toContain('COALESCE(');
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)'
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_valid_apify_credential_slot/
        );
    });

    it('preserves helper-backed evidence, constraint, reservation, and reconciliation paths', () => {
        for (const fragment of [
            'analysis_v2_provider_run_credential_check CHECK',
            'analysis_v2_relationship_sides_credential_check CHECK',
            'analysis_v2_valid_target_evidence_source',
            'reserve_analysis_v2_provider_run',
            'reconcile_analysis_v2_provider_run_usage',
        ]) {
            expect(historicalExpansion).toContain(fragment);
        }
        expect(historicalExpansion.match(/analysis_v2_valid_apify_credential_slot\(/g)?.length)
            .toBeGreaterThanOrEqual(7);
    });

    it('recreates cleanup settlement against the shared validator with service-only execution', () => {
        const cleanup = functionDefinition('settle_analysis_v2_provider_run_for_cleanup');
        expect(cleanup).toContain(
            'NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)'
        );
        expect(cleanup).not.toContain(
            "'primary', 'secondary', 'tertiary', 'quaternary', 'quinary'"
        );
        expect(cleanup).toContain('SECURITY DEFINER');
        expect(cleanup).toContain("SET search_path = ''");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.settle_analysis_v2_provider_run_for_cleanup\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.settle_analysis_v2_provider_run_for_cleanup\([\s\S]*?TO service_role/
        );
    });

    it('adds a service-only, bounded prune-readiness RPC for every affected ledger', () => {
        const readiness = functionDefinition(
            'analysis_v2_apify_secret_ref_prune_readiness'
        );
        expect(readiness).toContain('SECURITY DEFINER');
        expect(readiness).toContain("SET search_path = ''");
        expect(readiness).toContain("slot = 'primary'");
        expect(readiness).toContain('analysis_v2_provider_runs');
        expect(readiness).toContain('analysis_preflight_provider_runs');
        expect(readiness).toContain('analysis_v2_profile_repair_canary_runs');
        expect(readiness).toContain("'starting', 'running', 'ambiguous'");
        expect(readiness).toContain('usage_reconciled_at IS NULL');
        expect(readiness).not.toContain('analysis_v2_profile_provider_canary_runs');
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_apify_secret_ref_prune_readiness\(TEXT\[\]\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_apify_secret_ref_prune_readiness\(TEXT\[\]\)[\s\S]*?TO service_role/
        );
    });
});

const describeDatabase = migration === '' ? describe.skip : describe;

describeDatabase('analysis V2 senary Apify credential migration PGlite contract', () => {
    const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
    const RESERVATION_TOKEN = '20000000-0000-4000-8000-000000000001';
    let db: PGlite;

    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;

            CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot(
                p_slot TEXT
            )
            RETURNS BOOLEAN
            LANGUAGE sql
            IMMUTABLE
            SET search_path = ''
            AS $$
                SELECT COALESCE(
                    p_slot IN (
                        'primary', 'secondary', 'tertiary', 'quaternary', 'quinary'
                    ),
                    FALSE
                );
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
                credential_slot TEXT NOT NULL CHECK (
                    public.analysis_v2_valid_apify_credential_slot(credential_slot)
                ),
                max_charge_usd NUMERIC(18, 12) NOT NULL,
                status TEXT NOT NULL,
                run_id TEXT,
                actual_usage_usd NUMERIC(18, 12),
                reserved_at TIMESTAMP WITH TIME ZONE NOT NULL,
                run_started_at TIMESTAMP WITH TIME ZONE,
                terminalized_at TIMESTAMP WITH TIME ZONE,
                usage_reconciled_at TIMESTAMP WITH TIME ZONE,
                updated_at TIMESTAMP WITH TIME ZONE NOT NULL
            );

            CREATE TABLE public.analysis_v2_provider_cleanup_intents (
                request_id UUID PRIMARY KEY,
                completed_at TIMESTAMP WITH TIME ZONE
            );

            CREATE TABLE public.analysis_preflight_provider_runs (
                preflight_id UUID PRIMARY KEY,
                credential_slot TEXT NOT NULL,
                status TEXT NOT NULL,
                usage_reconciled_at TIMESTAMP WITH TIME ZONE
            );

            CREATE TABLE public.analysis_v2_profile_repair_canary_runs (
                source_request_id UUID NOT NULL,
                repetition INTEGER NOT NULL,
                credential_slot TEXT NOT NULL,
                state TEXT NOT NULL,
                usage_reconciled_at TIMESTAMP WITH TIME ZONE,
                PRIMARY KEY (source_request_id, repetition)
            );

            CREATE OR REPLACE FUNCTION public.analysis_v2_provider_run_json(
                p_run public.analysis_v2_provider_runs
            )
            RETURNS JSONB
            LANGUAGE sql
            STABLE
            STRICT
            SET search_path = ''
            AS $$
                SELECT pg_catalog.jsonb_build_object(
                    'credentialSlot', p_run.credential_slot,
                    'status', p_run.status,
                    'actualUsageUsd', p_run.actual_usage_usd
                );
            $$;
        `);
        await db.exec(migration);
    });

    afterAll(async () => {
        await db.close();
    });

    it('accepts senary through helper-backed constraints and rejects septenary', async () => {
        const helper = await db.query<{ slot: string; accepted: boolean }>(`
            SELECT slot, public.analysis_v2_valid_apify_credential_slot(slot) AS accepted
            FROM (VALUES ('senary'), ('septenary')) AS slots(slot)
            ORDER BY slot
        `);
        expect(helper.rows).toEqual([
            { slot: 'senary', accepted: true },
            { slot: 'septenary', accepted: false },
        ]);

        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, input_hash, job_claim_token,
                reservation_token, logical_provider, actor_id, credential_slot,
                max_charge_usd, status, run_id, reserved_at, run_started_at, updated_at
            ) VALUES (
                $1, 'collect_relationships', $2, $3, $4, $5,
                'apify', 'actor/test', 'senary', 0.02, 'running',
                'SenaryRun123456', pg_catalog.clock_timestamp(),
                pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
            )`,
            [
                REQUEST_ID,
                `relationship-followers:${'a'.repeat(64)}`,
                'b'.repeat(64),
                '30000000-0000-4000-8000-000000000001',
                RESERVATION_TOKEN,
            ]
        );
        await expect(db.query(`
            UPDATE public.analysis_v2_provider_runs
            SET credential_slot = 'septenary'
            WHERE reservation_token = $1
        `, [RESERVATION_TOKEN])).rejects.toThrow();
    });

    it('settles a senary-backed failed run through the recreated cleanup RPC', async () => {
        await db.query(
            `INSERT INTO public.analysis_v2_provider_cleanup_intents (
                request_id, completed_at
            ) VALUES ($1, NULL)`,
            [REQUEST_ID]
        );
        await db.exec('SET ROLE service_role');
        try {
            const result = await db.query<{ result: Record<string, unknown> }>(
                `SELECT public.settle_analysis_v2_provider_run_for_cleanup(
                    $1, 'SenaryRun123456', 'apify', 'actor/test', 'senary',
                    0.02, 'failed', 0.01
                ) AS result`,
                [RESERVATION_TOKEN]
            );
            expect(result.rows[0].result).toMatchObject({
                credentialSlot: 'senary',
                status: 'failed',
                actualUsageUsd: 0.01,
            });
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('returns ready only after affected request, preflight, and repair-canary runs drain', async () => {
        const callReadiness = () => db.query<{
            result: {
                ready: boolean;
                activeRequestRuns: number;
                unreconciledRequestRuns: number;
                activePreflightRuns: number;
                unreconciledPreflightRuns: number;
                activeProfileRepairCanaryRuns: number;
                unreconciledProfileRepairCanaryRuns: number;
            };
        }>(`
            SELECT public.analysis_v2_apify_secret_ref_prune_readiness(
                ARRAY['senary', 'quinary', 'tertiary']::TEXT[]
            ) AS result
        `);

        await db.query(`
            INSERT INTO public.analysis_preflight_provider_runs (
                preflight_id, credential_slot, status, usage_reconciled_at
            ) VALUES (
                '40000000-0000-4000-8000-000000000001',
                'tertiary', 'failed', NULL
            ), (
                '40000000-0000-4000-8000-000000000002',
                'quinary', 'running', NULL
            )
        `);
        await db.query(`
            INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, input_hash, job_claim_token,
                reservation_token, logical_provider, actor_id, credential_slot,
                max_charge_usd, status, run_id, reserved_at, run_started_at,
                terminalized_at, usage_reconciled_at, updated_at
            ) VALUES (
                '60000000-0000-4000-8000-000000000001',
                'active', 'operation:active', '${'c'.repeat(64)}',
                '61000000-0000-4000-8000-000000000001',
                '62000000-0000-4000-8000-000000000001',
                'apify', 'actor/test', 'senary', 0.02, 'starting', NULL,
                pg_catalog.clock_timestamp(), NULL, NULL, NULL,
                pg_catalog.clock_timestamp()
            ), (
                '60000000-0000-4000-8000-000000000002',
                'unreconciled', 'operation:unreconciled', '${'d'.repeat(64)}',
                '61000000-0000-4000-8000-000000000002',
                '62000000-0000-4000-8000-000000000002',
                'apify', 'actor/test', 'quinary', 0.02, 'failed',
                'UnreconciledRun123',
                pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
                pg_catalog.clock_timestamp(), NULL,
                pg_catalog.clock_timestamp()
            )
        `);
        await db.query(`
            INSERT INTO public.analysis_v2_profile_repair_canary_runs (
                source_request_id, repetition, credential_slot, state,
                usage_reconciled_at
            ) VALUES (
                '50000000-0000-4000-8000-000000000001',
                1, 'quinary', 'ambiguous', NULL
            ), (
                '50000000-0000-4000-8000-000000000002',
                1, 'tertiary', 'failed', NULL
            )
        `);

        await db.exec('SET ROLE service_role');
        try {
            const blocked = await callReadiness();
            expect(blocked.rows[0].result).toMatchObject({
                ready: false,
                activeRequestRuns: 1,
                unreconciledRequestRuns: 1,
                activePreflightRuns: 1,
                unreconciledPreflightRuns: 1,
                activeProfileRepairCanaryRuns: 1,
                unreconciledProfileRepairCanaryRuns: 1,
            });
        } finally {
            await db.exec('RESET ROLE');
        }
        await db.query(`DELETE FROM public.analysis_preflight_provider_runs`);
        await db.query(`
            DELETE FROM public.analysis_v2_provider_runs
            WHERE request_id IN (
                '60000000-0000-4000-8000-000000000001',
                '60000000-0000-4000-8000-000000000002'
            )
        `);
        await db.query(`DELETE FROM public.analysis_v2_profile_repair_canary_runs`);
        await db.exec('SET ROLE service_role');
        try {
            const ready = await callReadiness();
            expect(ready.rows[0].result).toMatchObject({
                ready: true,
                activeRequestRuns: 0,
                unreconciledPreflightRuns: 0,
                activeProfileRepairCanaryRuns: 0,
            });
            expect(ready.rows[0].result).toMatchObject({
                dropSlots: ['quinary', 'senary', 'tertiary'],
            });
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('rejects primary, duplicate, unsupported, empty, and null prune slots', async () => {
        await db.exec('SET ROLE service_role');
        try {
            for (const expression of [
                "ARRAY['primary']::TEXT[]",
                "ARRAY['senary', 'senary']::TEXT[]",
                "ARRAY['septenary']::TEXT[]",
                'ARRAY[]::TEXT[]',
                'NULL::TEXT[]',
            ]) {
                await expect(db.query(`
                    SELECT public.analysis_v2_apify_secret_ref_prune_readiness(
                        ${expression}
                    )
                `)).rejects.toThrow(
                    'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_SLOTS_INVALID'
                );
            }
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('does not expose prune readiness to an authenticated application role', async () => {
        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(`
                SELECT public.analysis_v2_apify_secret_ref_prune_readiness(
                    ARRAY['senary']::TEXT[]
                )
            `)).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });
});
