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
});
