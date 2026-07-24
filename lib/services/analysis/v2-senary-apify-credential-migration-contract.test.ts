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
const PRUNE_OWNER_SHA = 'a'.repeat(40);
const OTHER_PRUNE_OWNER_SHA = 'b'.repeat(40);

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
        expect(migration).toContain("requested.slot = 'primary'");
        expect(readiness).toContain('analysis_v2_provider_runs');
        expect(readiness).toContain('analysis_preflight_provider_runs');
        expect(readiness).toContain('analysis_v2_profile_repair_canary_runs');
        expect(readiness).toContain('analysis_v2_provider_execution_policies');
        expect(readiness).toContain('analysis_requests');
        expect(readiness).toContain('analysis_preflights');
        expect(readiness).toContain('analysis_v2_profile_provider_canary_experiments');
        expect(readiness).toContain('jsonb_each_text');
        expect(readiness).toContain(
            "source_run.actor_id = 'apify/instagram-profile-scraper'"
        );
        expect(readiness).toContain(
            "source_run.job_key ~ '^track:profiles:batch:(?:0|[1-7])$'"
        );
        expect(readiness).toContain(
            "source_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$'"
        );
        expect(readiness).toMatch(
            /execution_policy\.operation_slot_map->>'profile-fallback'\s+= source_run\.credential_slot/
        );
        expect(readiness).toContain("analysis_request.status IN ('pending', 'processing')");
        expect(readiness).toMatch(
            /preflight\.status IN \('pending', 'processing'\)[\s\S]*?OR \([\s\S]*?preflight\.status = 'ready'[\s\S]*?preflight\.admission_status IN \('pending', 'processing'\)/
        );
        expect(readiness).toContain(
            "experiment.source_kvs_cleanup_state IS DISTINCT FROM 'verified_absent'"
        );
        expect(readiness).toContain(
            "experiment.source_dataset_cleanup_state IS DISTINCT FROM 'verified_absent'"
        );
        expect(readiness).toMatch(
            /experiment\.source_request_queue_cleanup_state\s+IS DISTINCT FROM 'verified_absent'/
        );
        expect(readiness).toContain("'starting', 'running', 'ambiguous'");
        expect(readiness).toContain('usage_reconciled_at IS NULL');
        expect(readiness).toContain('analysis_v2_apify_secret_ref_prune_guard');
        expect(readiness).toContain('FOR UPDATE');
        expect(readiness).toContain('p_owner_source_commit_sha');
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_apify_secret_ref_prune_readiness\(\s*TEXT\[\], TEXT\s*\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_apify_secret_ref_prune_readiness\(\s*TEXT\[\], TEXT\s*\)[\s\S]*?TO service_role/
        );
    });

    it('adds a durable singleton prune fence and serializes both canary reserves', () => {
        expect(migration).toContain(
            'CREATE TABLE public.analysis_v2_apify_secret_ref_prune_guard'
        );
        expect(migration).toMatch(
            /ALTER TABLE public\.analysis_v2_apify_secret_ref_prune_guard\s+FORCE ROW LEVEL SECURITY/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_v2_apify_secret_ref_prune_guard[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toContain(
            'acquire_analysis_v2_apify_secret_ref_prune_fence'
        );
        expect(migration).toContain(
            'load_analysis_v2_apify_secret_ref_prune_fence'
        );
        expect(migration).toContain(
            'clear_analysis_v2_apify_secret_ref_prune_fence'
        );
        for (const functionName of [
            'acquire_analysis_v2_apify_secret_ref_prune_fence',
            'load_analysis_v2_apify_secret_ref_prune_fence',
            'clear_analysis_v2_apify_secret_ref_prune_fence',
        ]) {
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${functionName}\\([\\s\\S]*?`
                + 'FROM PUBLIC, anon, authenticated, service_role'
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\([\\s\\S]*?`
                + 'TO service_role'
            ));
        }

        const repairReserve = functionDefinition(
            'reserve_analysis_v2_profile_repair_canary_run'
        );
        const providerReserve = functionDefinition(
            'reserve_analysis_v2_profile_provider_canary_run'
        );
        for (const definition of [repairReserve, providerReserve]) {
            expect(definition).toContain(
                'analysis_v2_apify_secret_ref_prune_guard'
            );
            expect(definition).toContain('FOR UPDATE');
            expect(definition).toContain(
                'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCED'
            );
        }
        expect(repairReserve).toContain('p_credential_slot = ANY');
        expect(providerReserve).toContain(
            'source_run.credential_slot = ANY'
        );
    });
});

const describeDatabase = migration === '' ? describe.skip : describe;

describeDatabase('analysis V2 senary Apify credential migration PGlite contract', () => {
    const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
    const RESERVATION_TOKEN = '20000000-0000-4000-8000-000000000001';
    let db: PGlite;

    const acquirePruneFence = async (
        slots = ['senary', 'quinary', 'tertiary'],
        owner = PRUNE_OWNER_SHA
    ) => {
        await db.exec('SET ROLE service_role');
        try {
            return await db.query<{ result: Record<string, unknown> }>(`
                SELECT public.acquire_analysis_v2_apify_secret_ref_prune_fence(
                    $1::TEXT[],
                    $2
                ) AS result
            `, [slots, owner]);
        } finally {
            await db.exec('RESET ROLE');
        }
    };

    const clearPruneFence = async (
        slots = ['senary', 'quinary', 'tertiary'],
        owner = PRUNE_OWNER_SHA
    ) => {
        await db.exec('SET ROLE service_role');
        try {
            return await db.query<{ result: Record<string, unknown> }>(`
                SELECT public.clear_analysis_v2_apify_secret_ref_prune_fence(
                    $1::TEXT[],
                    $2
                ) AS result
            `, [slots, owner]);
        } finally {
            await db.exec('RESET ROLE');
        }
    };

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

            CREATE TABLE public.analysis_requests (
                id UUID PRIMARY KEY,
                status TEXT NOT NULL
            );

            CREATE TABLE public.analysis_preflights (
                id UUID PRIMARY KEY,
                status TEXT NOT NULL,
                admission_status TEXT NOT NULL DEFAULT 'idle'
            );

            CREATE TABLE public.analysis_v2_provider_execution_policies (
                request_id UUID PRIMARY KEY,
                mode TEXT NOT NULL DEFAULT 'test_operation_split',
                policy_version TEXT NOT NULL DEFAULT 'authorized-free-e2e-v1',
                operation_slot_map JSONB NOT NULL
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

            CREATE TABLE public.analysis_v2_profile_provider_canary_experiments (
                source_request_id UUID NOT NULL,
                canary_version TEXT NOT NULL,
                source_kvs_cleanup_state TEXT NOT NULL,
                source_dataset_cleanup_state TEXT NOT NULL,
                source_request_queue_cleanup_state TEXT NOT NULL,
                PRIMARY KEY (source_request_id, canary_version)
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

            CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_profile_repair_canary_run(
                p_source_request_id UUID,
                p_repetition INTEGER,
                p_credential_slot TEXT,
                p_reservation_token UUID
            )
            RETURNS JSONB
            LANGUAGE sql
            SECURITY DEFINER
            SET search_path = ''
            AS $$
                SELECT pg_catalog.jsonb_build_object(
                    'created', TRUE,
                    'kind', 'profile-repair',
                    'credentialSlot', p_credential_slot
                );
            $$;

            CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_profile_provider_canary_run(
                p_source_request_id UUID,
                p_repetition INTEGER,
                p_source_run_count INTEGER,
                p_candidate_count INTEGER,
                p_unique_candidate_count INTEGER,
                p_public_candidate_count INTEGER,
                p_incomplete_candidate_count INTEGER,
                p_unavailable_candidate_count INTEGER,
                p_primary_success_candidate_count INTEGER,
                p_critical_candidate_count INTEGER,
                p_ordered_set_hmac TEXT,
                p_restricted_access_verified BOOLEAN,
                p_reservation_token UUID
            )
            RETURNS JSONB
            LANGUAGE sql
            SECURITY DEFINER
            SET search_path = ''
            AS $$
                SELECT pg_catalog.jsonb_build_object(
                    'created', TRUE,
                    'kind', 'profile-provider',
                    'sourceRequestId', p_source_request_id
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

    it('keeps one constrained guard row with crash-safe acquire and compare-and-clear', async () => {
        const initial = await db.query<{
            row_count: number;
            drop_slots: string[] | null;
            owner_source_commit_sha: string | null;
            fenced_at: string | null;
        }>(`
            SELECT pg_catalog.count(*) OVER ()::INTEGER AS row_count,
                drop_slots, owner_source_commit_sha, fenced_at
            FROM public.analysis_v2_apify_secret_ref_prune_guard
        `);
        expect(initial.rows).toEqual([{
            row_count: 1,
            drop_slots: null,
            owner_source_commit_sha: null,
            fenced_at: null,
        }]);
        await expect(db.query(`
            UPDATE public.analysis_v2_apify_secret_ref_prune_guard
            SET drop_slots = ARRAY['senary'],
                owner_source_commit_sha = NULL,
                fenced_at = pg_catalog.clock_timestamp()
        `)).rejects.toThrow();

        await db.exec('SET ROLE service_role');
        try {
            await expect(db.query(`
                SELECT public.analysis_v2_apify_secret_ref_prune_readiness(
                    ARRAY['senary', 'quinary', 'tertiary']::TEXT[],
                    '${PRUNE_OWNER_SHA}'
                )
            `)).rejects.toThrow(
                'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCE_CONFLICT'
            );
        } finally {
            await db.exec('RESET ROLE');
        }

        const acquired = await acquirePruneFence();
        expect(acquired.rows[0].result).toMatchObject({
            active: true,
            acquired: true,
            dropSlots: ['quinary', 'senary', 'tertiary'],
        });
        const adopted = await acquirePruneFence([
            'tertiary', 'senary', 'quinary',
        ]);
        expect(adopted.rows[0].result).toMatchObject({
            active: true,
            acquired: false,
            dropSlots: ['quinary', 'senary', 'tertiary'],
        });
        await expect(acquirePruneFence(
            ['senary', 'quinary', 'tertiary'],
            OTHER_PRUNE_OWNER_SHA
        )).rejects.toThrow(
            'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCE_CONFLICT'
        );
        await expect(clearPruneFence(
            ['senary', 'quinary', 'tertiary'],
            OTHER_PRUNE_OWNER_SHA
        )).rejects.toThrow(
            'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCE_CONFLICT'
        );

        const cleared = await clearPruneFence();
        expect(cleared.rows[0].result).toMatchObject({
            active: false,
            cleared: true,
            dropSlots: ['quinary', 'senary', 'tertiary'],
        });
        const retry = await clearPruneFence();
        expect(retry.rows[0].result).toMatchObject({
            active: false,
            cleared: false,
        });

        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(`
                SELECT * FROM public.analysis_v2_apify_secret_ref_prune_guard
            `)).rejects.toThrow(/permission denied/i);
            await expect(db.query(`
                SELECT public.load_analysis_v2_apify_secret_ref_prune_fence()
            `)).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('serializes both canary reserves and blocks only overlapping slots', async () => {
        const sourceRequestId = '90000000-0000-4000-8000-000000000001';
        await db.query(`
            INSERT INTO public.analysis_requests (id, status)
            VALUES ($1, 'failed')
        `, [sourceRequestId]);
        await db.query(`
            INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, operation_slot_map
            ) VALUES (
                $1,
                '{"profile-fallback":"quinary"}'::JSONB
            )
        `, [sourceRequestId]);
        for (let index = 0; index < 8; index += 1) {
            const suffix = String(index + 1).padStart(12, '0');
            await db.query(`
                INSERT INTO public.analysis_v2_provider_runs (
                    request_id, job_key, operation_key, input_hash,
                    job_claim_token, reservation_token, logical_provider,
                    actor_id, credential_slot, max_charge_usd, status, run_id,
                    actual_usage_usd, reserved_at, run_started_at,
                    terminalized_at, usage_reconciled_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, 'apify',
                    'apify/instagram-profile-scraper', 'quinary', 0.02,
                    'succeeded', $7, 0.01, pg_catalog.clock_timestamp(),
                    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
                    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
                )
            `, [
                sourceRequestId,
                `track:profiles:batch:${index}`,
                `profile-fallback:${index.toString(16).repeat(64)}`,
                (index + 1).toString(16).repeat(64),
                `91000000-0000-4000-8000-${suffix}`,
                `92000000-0000-4000-8000-${suffix}`,
                `FenceSourceRun${index}`,
            ]);
        }
        await acquirePruneFence(['quinary']);

        await db.exec('SET ROLE service_role');
        try {
            await expect(db.query(`
                SELECT public.reserve_analysis_v2_profile_repair_canary_run(
                    $1, 1, 'quinary',
                    '93000000-0000-4000-8000-000000000001'
                )
            `, [sourceRequestId])).rejects.toThrow(
                'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCED'
            );
            const repairNonOverlap = await db.query<{
                result: Record<string, unknown>;
            }>(`
                SELECT public.reserve_analysis_v2_profile_repair_canary_run(
                    $1, 1, 'primary',
                    '93000000-0000-4000-8000-000000000002'
                ) AS result
            `, [sourceRequestId]);
            expect(repairNonOverlap.rows[0].result).toMatchObject({
                created: true,
                kind: 'profile-repair',
                credentialSlot: 'primary',
            });

            await expect(db.query(`
                SELECT public.reserve_analysis_v2_profile_provider_canary_run(
                    $1, 1, 8, 15, 15, 15, 15, 0, 0, 3,
                    '${'c'.repeat(64)}', TRUE,
                    '94000000-0000-4000-8000-000000000001'
                )
            `, [sourceRequestId])).rejects.toThrow(
                'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCED'
            );
        } finally {
            await db.exec('RESET ROLE');
        }

        await db.query(`
            UPDATE public.analysis_v2_provider_runs
            SET credential_slot = 'primary'
            WHERE request_id = $1
        `, [sourceRequestId]);
        await db.query(`
            UPDATE public.analysis_v2_provider_execution_policies
            SET operation_slot_map = '{"profile-fallback":"primary"}'::JSONB
            WHERE request_id = $1
        `, [sourceRequestId]);
        await db.exec('SET ROLE service_role');
        try {
            const providerNonOverlap = await db.query<{
                result: Record<string, unknown>;
            }>(`
                SELECT public.reserve_analysis_v2_profile_provider_canary_run(
                    $1, 1, 8, 15, 15, 15, 15, 0, 0, 3,
                    '${'c'.repeat(64)}', TRUE,
                    '94000000-0000-4000-8000-000000000002'
                ) AS result
            `, [sourceRequestId]);
            expect(providerNonOverlap.rows[0].result).toMatchObject({
                created: true,
                kind: 'profile-provider',
                sourceRequestId,
            });
        } finally {
            await db.exec('RESET ROLE');
        }
        await clearPruneFence(['quinary']);
    });

    it('blocks future provider reservations while request or preflight work is active', async () => {
        await acquirePruneFence();
        const callReadiness = () => db.query<{
            result: {
                ready: boolean;
                activeRequests: number;
                activePreflights: number;
                activeDropSlotPolicies: number;
            };
        }>(`
            SELECT public.analysis_v2_apify_secret_ref_prune_readiness(
                ARRAY['senary', 'quinary', 'tertiary']::TEXT[],
                '${PRUNE_OWNER_SHA}'
            ) AS result
        `);

        await db.query(`
            INSERT INTO public.analysis_requests (id, status) VALUES
                ('70000000-0000-4000-8000-000000000001', 'pending'),
                ('70000000-0000-4000-8000-000000000002', 'processing'),
                ('70000000-0000-4000-8000-000000000003', 'failed')
        `);
        await db.query(`
            INSERT INTO public.analysis_preflights (
                id, status, admission_status
            ) VALUES
                ('71000000-0000-4000-8000-000000000001', 'pending', 'idle'),
                ('71000000-0000-4000-8000-000000000002', 'processing', 'idle'),
                ('71000000-0000-4000-8000-000000000003', 'consumed', 'idle'),
                ('71000000-0000-4000-8000-000000000004', 'ready', 'processing'),
                ('71000000-0000-4000-8000-000000000005', 'ready', 'idle'),
                ('71000000-0000-4000-8000-000000000006', 'ready', 'ready')
        `);
        await db.query(`
            INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, operation_slot_map
            ) VALUES (
                '70000000-0000-4000-8000-000000000001',
                '{"target-profile":"primary","profile-fallback":"senary"}'::JSONB
            ), (
                '70000000-0000-4000-8000-000000000003',
                '{"target-profile":"primary","profile-fallback":"quinary"}'::JSONB
            )
        `);

        await db.exec('SET ROLE service_role');
        try {
            const blocked = await callReadiness();
            expect(blocked.rows[0].result).toMatchObject({
                ready: false,
                activeRequests: 2,
                activePreflights: 3,
                activeDropSlotPolicies: 1,
            });
        } finally {
            await db.exec('RESET ROLE');
        }

        await db.query(`
            UPDATE public.analysis_requests
            SET status = 'failed'
            WHERE status IN ('pending', 'processing')
        `);
        await db.query(`
            UPDATE public.analysis_preflights
            SET status = 'consumed'
            WHERE status IN ('pending', 'processing')
        `);
        await db.query(`
            UPDATE public.analysis_preflights
            SET admission_status = 'ready'
            WHERE admission_status = 'processing'
        `);

        await db.exec('SET ROLE service_role');
        try {
            const ready = await callReadiness();
            expect(ready.rows[0].result).toMatchObject({
                ready: true,
                activeRequests: 0,
                activePreflights: 0,
                activeDropSlotPolicies: 0,
            });
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('blocks incomplete official-canary source cleanup on a dropped source slot', async () => {
        await acquirePruneFence();
        const sourceRequestId = '80000000-0000-4000-8000-000000000001';
        await db.query(`
            INSERT INTO public.analysis_requests (id, status)
            VALUES ($1, 'failed')
        `, [sourceRequestId]);
        await db.query(`
            INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, operation_slot_map
            ) VALUES (
                $1,
                '{"profile-fallback":"primary"}'::JSONB
            )
        `, [sourceRequestId]);
        for (let index = 0; index < 8; index += 1) {
            const suffix = String(index + 1).padStart(12, '0');
            await db.query(`
                INSERT INTO public.analysis_v2_provider_runs (
                    request_id, job_key, operation_key, input_hash, job_claim_token,
                    reservation_token, logical_provider, actor_id, credential_slot,
                    max_charge_usd, status, run_id, actual_usage_usd, reserved_at,
                    run_started_at, terminalized_at, usage_reconciled_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    'apify', 'apify/instagram-profile-scraper', 'primary',
                    0.02, 'succeeded', $7, 0.01,
                    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
                    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
                    pg_catalog.clock_timestamp()
                )
            `, [
                sourceRequestId,
                `track:profiles:batch:${index}`,
                `profile-fallback:${index.toString(16).repeat(64)}`,
                (index + 1).toString(16).repeat(64),
                `81000000-0000-4000-8000-${suffix}`,
                `82000000-0000-4000-8000-${suffix}`,
                `SourceRun12345${index}`,
            ]);
        }
        await db.query(`
            INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, input_hash, job_claim_token,
                reservation_token, logical_provider, actor_id, credential_slot,
                max_charge_usd, status, run_id, actual_usage_usd, reserved_at,
                run_started_at, terminalized_at, usage_reconciled_at, updated_at
            ) VALUES (
                $1, 'target-likers',
                'target-likers:${'e'.repeat(64)}', '${'f'.repeat(64)}',
                '83000000-0000-4000-8000-000000000001',
                '84000000-0000-4000-8000-000000000001',
                'apify', 'apify/instagram-post-likers-scraper', 'senary',
                0.02, 'succeeded', 'UnrelatedRun123', 0.01,
                pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
                pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
                pg_catalog.clock_timestamp()
            )
        `, [sourceRequestId]);
        await db.query(`
            INSERT INTO public.analysis_v2_profile_provider_canary_experiments (
                source_request_id, canary_version, source_kvs_cleanup_state,
                source_dataset_cleanup_state, source_request_queue_cleanup_state
            ) VALUES (
                $1, 'profile-fallback-replacement-canary-v1',
                'pending', 'pending', 'pending'
            )
        `, [sourceRequestId]);

        const callReadiness = () => db.query<{
            result: {
                ready: boolean;
                incompleteProfileProviderCanaryCleanups: number;
            };
        }>(`
            SELECT public.analysis_v2_apify_secret_ref_prune_readiness(
                ARRAY['senary', 'quinary', 'tertiary']::TEXT[],
                '${PRUNE_OWNER_SHA}'
            ) AS result
        `);

        await db.exec('SET ROLE service_role');
        try {
            const unrelated = await callReadiness();
            expect(unrelated.rows[0].result).toMatchObject({
                ready: true,
                incompleteProfileProviderCanaryCleanups: 0,
            });
        } finally {
            await db.exec('RESET ROLE');
        }

        await db.query(`
            UPDATE public.analysis_v2_provider_runs
            SET credential_slot = 'senary'
            WHERE request_id = $1
              AND job_key = 'track:profiles:batch:0'
        `, [sourceRequestId]);
        await db.query(`
            UPDATE public.analysis_v2_provider_execution_policies
            SET operation_slot_map = '{"profile-fallback":"senary"}'::JSONB
            WHERE request_id = $1
        `, [sourceRequestId]);

        await db.exec('SET ROLE service_role');
        try {
            const blocked = await callReadiness();
            expect(blocked.rows[0].result).toMatchObject({
                ready: false,
                incompleteProfileProviderCanaryCleanups: 1,
            });
        } finally {
            await db.exec('RESET ROLE');
        }

        await db.query(`
            UPDATE public.analysis_v2_profile_provider_canary_experiments
            SET source_kvs_cleanup_state = 'verified_absent',
                source_dataset_cleanup_state = 'verified_absent',
                source_request_queue_cleanup_state = 'verified_absent'
            WHERE source_request_id = $1
        `, [sourceRequestId]);

        await db.exec('SET ROLE service_role');
        try {
            const ready = await callReadiness();
            expect(ready.rows[0].result).toMatchObject({
                ready: true,
                incompleteProfileProviderCanaryCleanups: 0,
            });
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('returns ready only after affected request, preflight, and repair-canary runs drain', async () => {
        await acquirePruneFence();
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
                ARRAY['senary', 'quinary', 'tertiary']::TEXT[],
                '${PRUNE_OWNER_SHA}'
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
                        ${expression},
                        '${PRUNE_OWNER_SHA}'
                    )
                `)).rejects.toThrow(
                    'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCE_INVALID'
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
                    ARRAY['senary']::TEXT[],
                    '${PRUNE_OWNER_SHA}'
                )
            `)).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });
});
