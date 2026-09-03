import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260904110000_add_analysis_v2_cost_attribution.sql',
        import.meta.url,
    ),
    'utf8',
);

const REQUEST_ID = '80000000-0000-4000-8000-000000000001';
const LEGACY_REQUEST_ID = '80000000-0000-4000-8000-000000000002';
const SELFHOSTED_ZERO_REQUEST_ID = '80000000-0000-4000-8000-000000000003';
const ANONYMOUS_ZERO_REQUEST_ID = '80000000-0000-4000-8000-000000000004';
const PREFLIGHT_ID = '70000000-0000-4000-8000-000000000001';
const SELFHOSTED_ZERO_PREFLIGHT_ID = '70000000-0000-4000-8000-000000000003';
const ANONYMOUS_ZERO_PREFLIGHT_ID = '70000000-0000-4000-8000-000000000004';
const ORDER_ID = '90000000-0000-4000-8000-000000000001';
const OPERATION_KEY = `gender-triage:${'a'.repeat(64)}`;
const PREFLIGHT_OPERATION_KEY = 'target-profile-fallback';
const MODEL_NAME = 'gemini-3.1-flash-lite-preview-001';
const RESOURCE_MODEL_NAME =
    'projects/demo/locations/global/publishers/google/models/gemini-3.1-flash-lite-preview-001';
const MODEL_LOCATION = 'global';
const NOW = '2026-09-03T00:00:00Z';

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version TEXT PRIMARY KEY);
INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('20260904100000');
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    preflight_id UUID,
    pipeline_version TEXT NOT NULL DEFAULT 'v2',
    selected_plan_id_snapshot TEXT NOT NULL,
    plan_access_mode_snapshot TEXT NOT NULL,
    status TEXT NOT NULL,
    policy_versions_snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    status TEXT NOT NULL,
    consumed_request_id UUID,
    provider_selector TEXT NOT NULL DEFAULT 'selfhosted_auth',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY,
    preflight_id UUID NOT NULL,
    result_request_id UUID REFERENCES public.analysis_requests(id) ON DELETE SET NULL
);

CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID NOT NULL,
    operation_key TEXT NOT NULL,
    logical_provider TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    credential_slot TEXT NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    max_charge_usd NUMERIC,
    actual_usage_usd NUMERIC,
    terminalized_at TIMESTAMPTZ,
    usage_reconciled_at TIMESTAMPTZ,
    manual_resolution_evidence_hash TEXT,
    manual_resolved_at TIMESTAMPTZ
);

CREATE TABLE public.analysis_v2_provider_runs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    operation_key TEXT NOT NULL,
    logical_provider TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    credential_slot TEXT NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    max_charge_usd NUMERIC,
    actual_usage_usd NUMERIC,
    usage_reconciled_at TIMESTAMPTZ,
    manual_resolution_kind TEXT,
    manual_resolution_evidence_hash TEXT,
    manual_resolved_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.analysis_v2_ai_attempts (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    operation_key TEXT NOT NULL,
    attempt SMALLINT NOT NULL,
    status TEXT NOT NULL,
    model_name TEXT NOT NULL,
    location TEXT NOT NULL,
    usage_metadata_status TEXT,
    usage_complete BOOLEAN,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    thinking_tokens INTEGER,
    estimated_cost_usd NUMERIC,
    pricing_version TEXT,
    canonical_model_name TEXT,
    cache_read_tokens INTEGER,
    metered_estimated_cost_usd NUMERIC
);

CREATE TABLE public.analysis_v2_ai_result_checkpoints (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    attempt SMALLINT,
    reservation_token UUID
);

CREATE TABLE public.analysis_v2_selfhosted_auth_runs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    operation_key TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.vertex_ai_budget_reservations (
    run_id TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    attempt SMALLINT NOT NULL,
    model_name TEXT NOT NULL,
    model_location TEXT NOT NULL,
    estimated_cost_usd NUMERIC,
    state TEXT NOT NULL,
    actual_cost_usd NUMERIC,
    usage_unknown BOOLEAN NOT NULL
);

-- The migration must install against the already-created predecessor schema, not silently run
-- against an arbitrary empty database.
SET check_function_bodies = off;
`;

async function query<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<Results<T>> {
    return db.query<T>(sql, params);
}

describe('analysis V2 per-order cost attribution migration', () => {
    let db: PGlite;

    beforeAll(async () => {
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(bootstrap);
        await db.query(`
            INSERT INTO public.analysis_requests(
                id, selected_plan_id_snapshot, plan_access_mode_snapshot,
                status, policy_versions_snapshot, created_at
            ) VALUES ($1, 'plus', 'test_entitlement', 'pending',
                '{"aiStage":"ai-stage-policy-v2.12"}'::jsonb, $2)
        `, [LEGACY_REQUEST_ID, NOW]);
        // A pre-migration row intentionally remains null: no historical provenance is invented.
        await db.query(
            `INSERT INTO public.analysis_v2_ai_attempts(
                request_id, operation_key, attempt, status, model_name, location
            ) VALUES ($1, $2, 1, 'success', $3, $4)`,
            [LEGACY_REQUEST_ID, OPERATION_KEY, MODEL_NAME, MODEL_LOCATION],
        );
        await db.exec(migration);
    });

    afterAll(async () => {
        await db?.close();
    });

    it('derives new provenance in the internal columns while preserving the RPC wire and legacy unknowns', async () => {
        const legacy = await query<{
            pricing_version: string | null;
            canonical_model_name: string | null;
            cache_read_tokens: number | null;
            metered_estimated_cost_usd: string | null;
        }>(db, `
            SELECT pricing_version, canonical_model_name, cache_read_tokens,
                   metered_estimated_cost_usd
              FROM public.analysis_v2_ai_attempts
             WHERE request_id = $1
        `, [LEGACY_REQUEST_ID]);
        expect(legacy.rows[0]).toEqual({
            pricing_version: null,
            canonical_model_name: null,
            cache_read_tokens: null,
            metered_estimated_cost_usd: null,
        });

        await db.query(`
            INSERT INTO public.analysis_v2_ai_attempts(
                request_id, operation_key, attempt, status, model_name, location
            ) VALUES ($1, $2, 1, 'reserved', $3, $4)
        `, [LEGACY_REQUEST_ID, `${OPERATION_KEY.slice(0, -64)}${'b'.repeat(64)}`, MODEL_NAME, MODEL_LOCATION]);
        const reserved = await query<{
            pricing_version: string;
            canonical_model_name: string;
            cache_read_tokens: number | null;
            metered_estimated_cost_usd: string | null;
        }>(db, `
            SELECT pricing_version, canonical_model_name, cache_read_tokens,
                   metered_estimated_cost_usd
              FROM public.analysis_v2_ai_attempts
             WHERE request_id = $1 AND operation_key <> $2
        `, [LEGACY_REQUEST_ID, OPERATION_KEY]);
        expect(reserved.rows[0]).toMatchObject({
            pricing_version: 'vertex-ai-cost-v1',
            canonical_model_name: 'gemini-3.1-flash-lite',
            cache_read_tokens: null,
            metered_estimated_cost_usd: null,
        });

        const resourceModel = await query<{
            canonical_model_name: string;
        }>(db, `
            SELECT public.analysis_v2_canonical_gemini_model($1)
                AS canonical_model_name
        `, [RESOURCE_MODEL_NAME]);
        expect(resourceModel.rows[0]).toEqual({
            canonical_model_name: 'gemini-3.1-flash-lite',
        });

        await db.query(`
            UPDATE public.analysis_v2_ai_attempts
               SET status = 'success', usage_metadata_status = 'complete', usage_complete = TRUE,
                   prompt_tokens = 10, completion_tokens = 4, thinking_tokens = 0,
                   estimated_cost_usd = 0.012345
             WHERE request_id = $1 AND operation_key <> $2
        `, [LEGACY_REQUEST_ID, OPERATION_KEY]);
        const complete = await query<{
            pricing_version: string;
            canonical_model_name: string;
            cache_read_tokens: number;
            metered_estimated_cost_usd: string;
        }>(db, `
            SELECT pricing_version, canonical_model_name, cache_read_tokens,
                   metered_estimated_cost_usd
              FROM public.analysis_v2_ai_attempts
             WHERE request_id = $1 AND operation_key <> $2
        `, [LEGACY_REQUEST_ID, OPERATION_KEY]);
        expect(complete.rows[0]).toMatchObject({
            pricing_version: 'vertex-ai-cost-v1',
            canonical_model_name: 'gemini-3.1-flash-lite',
            cache_read_tokens: 0,
            metered_estimated_cost_usd: '0.012345',
        });

        await expect(db.query(`
            UPDATE public.analysis_v2_ai_attempts
               SET location = 'us-central1'
             WHERE request_id = $1 AND operation_key <> $2
        `, [LEGACY_REQUEST_ID, OPERATION_KEY])).rejects.toThrow(
            'ANALYSIS_V2_AI_ATTEMPT_MODEL_PROVENANCE_IMMUTABLE',
        );
        await expect(db.query(`
            UPDATE public.analysis_v2_ai_attempts
               SET estimated_cost_usd = 0.02
             WHERE request_id = $1 AND operation_key <> $2
        `, [LEGACY_REQUEST_ID, OPERATION_KEY])).rejects.toThrow(
            'ANALYSIS_V2_AI_ATTEMPT_METERED_COST_IMMUTABLE',
        );
    });

    it('records a fresh Vertex reservation, joins it to the attempt, refreshes late, and survives purge', async () => {
        await db.query(`
            INSERT INTO public.analysis_requests(
                id, preflight_id, selected_plan_id_snapshot, plan_access_mode_snapshot,
                status, policy_versions_snapshot, created_at
            ) VALUES ($1, $2, 'plus', 'test_entitlement', 'pending',
                '{"aiStage":"ai-stage-policy-v2.12"}'::jsonb, $3)
        `, [REQUEST_ID, PREFLIGHT_ID, NOW]);
        await db.query(`
            INSERT INTO public.analysis_preflights(id, status, consumed_request_id)
            VALUES ($1, 'consumed', $2)
        `, [PREFLIGHT_ID, REQUEST_ID]);
        await db.query(`
            INSERT INTO public.analysis_preflight_provider_runs(
                preflight_id, operation_key, logical_provider, actor_id, credential_slot,
                status, run_id, max_charge_usd, actual_usage_usd, terminalized_at,
                usage_reconciled_at
            ) VALUES ($1, $2, 'apify', 'apify/instagram-profile-scraper', 'primary',
                'succeeded', 'APIFY12345', 0.0026, 0.0011, $3, $3)
        `, [PREFLIGHT_ID, PREFLIGHT_OPERATION_KEY, NOW]);
        await db.query(`
            INSERT INTO public.earlybird_orders(id, preflight_id)
            VALUES ($1, $2)
        `, [ORDER_ID, PREFLIGHT_ID]);
        await db.query(`
            UPDATE public.earlybird_orders SET result_request_id = $1 WHERE id = $2
        `, [REQUEST_ID, ORDER_ID]);

        const mapping = await query<{ count: string; order_id: string }>(db, `
            SELECT count(*)::text, (array_agg(order_id ORDER BY order_id))[1]::text AS order_id
              FROM public.analysis_v2_cost_attributions
             WHERE request_id = $1
        `, [REQUEST_ID]);
        expect(mapping.rows[0]).toEqual({ count: '1', order_id: ORDER_ID });

        const completeOperationKey = `${OPERATION_KEY.slice(0, -64)}${'b'.repeat(64)}`;
        await db.query(`
            INSERT INTO public.analysis_v2_ai_attempts(
                request_id, operation_key, attempt, status, model_name, location,
                usage_metadata_status, usage_complete, prompt_tokens, completion_tokens,
                total_tokens, thinking_tokens, estimated_cost_usd
            ) VALUES ($1, $2, 1, 'success', $3, $4, 'complete', TRUE,
                10, 4, 14, 0, 0.012345)
        `, [REQUEST_ID, completeOperationKey, MODEL_NAME, MODEL_LOCATION]);
        await db.query(`
            INSERT INTO public.analysis_v2_provider_runs(
                request_id, operation_key, logical_provider, actor_id, credential_slot,
                status, run_id, max_charge_usd, actual_usage_usd, usage_reconciled_at
            ) VALUES ($1, 'target-profile:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                'apify', 'apify/instagram-profile-scraper', 'primary', 'succeeded',
                'DIRECT123', 0.01, 0.004, $2)
        `, [REQUEST_ID, NOW]);
        await db.query(`
            INSERT INTO public.vertex_ai_budget_reservations(
                run_id, operation_key, attempt, model_name, model_location,
                estimated_cost_usd, state, actual_cost_usd, usage_unknown
            ) VALUES ($1, $2, 1, $3, $4, 0.020000, 'reserved', NULL, TRUE)
        `, [REQUEST_ID, completeOperationKey, MODEL_NAME, MODEL_LOCATION]);
        const reservedBudget = await query<{
            reservation_count: number;
            matched_count: number;
            usage_unknown_count: number;
            conservative_fallback_usd: string;
            total_conservative_cost_usd: string;
        }>(db, `
            SELECT vertex_budget_reservation_count AS reservation_count,
                   vertex_budget_matched_count AS matched_count,
                   vertex_budget_usage_unknown_count AS usage_unknown_count,
                   vertex_budget_conservative_fallback_usd::NUMERIC(18, 12)
                       AS conservative_fallback_usd,
                   total_conservative_cost_usd::NUMERIC(18, 12)
              FROM public.analysis_v2_cost_rollups
             WHERE request_id = $1
        `, [REQUEST_ID]);
        expect(reservedBudget.rows[0]).toEqual({
            reservation_count: 1,
            matched_count: 1,
            usage_unknown_count: 1,
            conservative_fallback_usd: '0.007655000000',
            total_conservative_cost_usd: '0.025100000000',
        });

        await db.query(`
            UPDATE public.vertex_ai_budget_reservations
               SET state = 'settled', actual_cost_usd = 0.012345, usage_unknown = FALSE
             WHERE run_id = $1 AND operation_key = $2
        `, [REQUEST_ID, completeOperationKey]);
        await db.query(`
            UPDATE public.analysis_requests
               SET status = 'completed', completed_at = $2
             WHERE id = $1
        `, [REQUEST_ID, NOW]);

        const firstSnapshot = await query<{
            directly_attributable_cost_complete: boolean;
            usage_unknown: boolean;
            provider_actual_total_usd: string;
            metered_estimated_cost_usd: string;
            infrastructure_included: boolean;
            order_id: string;
        }>(db, `
            SELECT directly_attributable_cost_complete, usage_unknown, provider_actual_total_usd,
                   metered_estimated_cost_usd, infrastructure_included, order_id,
                   total_conservative_cost_usd
              FROM public.analysis_v2_cost_rollup_snapshots
             WHERE request_id = $1
        `, [REQUEST_ID]);
        expect(firstSnapshot.rows[0]).toMatchObject({
            directly_attributable_cost_complete: true,
            usage_unknown: false,
            provider_actual_total_usd: '0.005100000000',
            metered_estimated_cost_usd: '0.012345000000',
            infrastructure_included: false,
            order_id: ORDER_ID,
            total_conservative_cost_usd: '0.017445000000',
        });

        const loadedLive = await query<{
            request_id: string;
            cost_scope: string;
            infrastructure_included: string;
        }>(db, `
            SELECT payload->>'request_id' AS request_id,
                   payload->>'cost_scope' AS cost_scope,
                   payload->>'infrastructure_included' AS infrastructure_included
              FROM (
                  SELECT public.load_analysis_v2_cost_rollup($1) AS payload
              ) AS loaded
        `, [REQUEST_ID]);
        expect(loadedLive.rows[0]).toEqual({
            request_id: REQUEST_ID,
            cost_scope: 'analysis-v2-direct-provider-and-vertex-metered-v1',
            infrastructure_included: 'false',
        });

        await db.query(`
            UPDATE public.analysis_v2_provider_runs
               SET actual_usage_usd = 0.005
             WHERE request_id = $1
        `, [REQUEST_ID]);
        const lateSnapshot = await query<{ provider_actual_total_usd: string }>(db, `
            SELECT provider_actual_total_usd
              FROM public.analysis_v2_cost_rollup_snapshots
             WHERE request_id = $1
        `, [REQUEST_ID]);
        expect(lateSnapshot.rows[0]).toEqual({ provider_actual_total_usd: '0.006100000000' });

        await db.query(`
            INSERT INTO public.analysis_v2_selfhosted_auth_runs(request_id, operation_key)
            VALUES ($1, 'relationship-followers:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')
        `, [REQUEST_ID]);
        const provenance = await query<{ cost_provenance: unknown }>(db, `
            SELECT cost_provenance FROM public.analysis_v2_cost_rollup_snapshots WHERE request_id = $1
        `, [REQUEST_ID]);
        expect(JSON.stringify(provenance.rows[0].cost_provenance)).toContain('selfhosted_auth');
        expect(JSON.stringify(provenance.rows[0].cost_provenance)).not.toContain('accountSlot');
        expect(JSON.stringify(provenance.rows[0].cost_provenance)).not.toContain('items');

        // The request delete cascades working-set rows, but the no-FK snapshot remains and is
        // refreshed by the BEFORE DELETE fence while source rows still exist.
        await db.query('DELETE FROM public.analysis_requests WHERE id = $1', [REQUEST_ID]);
        const retained = await query<{
            count: string;
            directly_attributable_cost_complete: boolean;
        }>(db, `
            SELECT count(*)::text,
                   bool_and(directly_attributable_cost_complete)
                       AS directly_attributable_cost_complete
              FROM public.analysis_v2_cost_rollup_history
             WHERE request_id = $1
        `, [REQUEST_ID]);
        expect(retained.rows[0]).toEqual({
            count: '1',
            directly_attributable_cost_complete: true,
        });

        const loadedSnapshot = await query<{
            directly_attributable_cost_complete: string;
        }>(db, `
            SELECT public.load_analysis_v2_cost_rollup($1)
                ->>'directly_attributable_cost_complete'
                AS directly_attributable_cost_complete
        `, [REQUEST_ID]);
        expect(loadedSnapshot.rows[0]).toEqual({
            directly_attributable_cost_complete: 'true',
        });
    });

    it('distinguishes proven selfhosted preflight no-call from anonymous zero-source unknown', async () => {
        await db.query(`
            INSERT INTO public.analysis_requests(
                id, preflight_id, selected_plan_id_snapshot, plan_access_mode_snapshot,
                status, policy_versions_snapshot, created_at
            ) VALUES
                ($1, $3, 'basic', 'production', 'pending', '{}'::jsonb, $5),
                ($2, $4, 'standard', 'test_entitlement', 'pending', '{}'::jsonb, $5)
        `, [
            SELFHOSTED_ZERO_REQUEST_ID,
            ANONYMOUS_ZERO_REQUEST_ID,
            SELFHOSTED_ZERO_PREFLIGHT_ID,
            ANONYMOUS_ZERO_PREFLIGHT_ID,
            NOW,
        ]);
        await db.query(`
            INSERT INTO public.analysis_preflights(
                id, status, consumed_request_id, provider_selector
            ) VALUES
                ($1, 'consumed', $3, 'selfhosted_auth'),
                ($2, 'consumed', $4, 'anonymous_apify')
        `, [
            SELFHOSTED_ZERO_PREFLIGHT_ID,
            ANONYMOUS_ZERO_PREFLIGHT_ID,
            SELFHOSTED_ZERO_REQUEST_ID,
            ANONYMOUS_ZERO_REQUEST_ID,
        ]);
        await db.query(`
            UPDATE public.analysis_requests
               SET status = 'completed', completed_at = $3
             WHERE id IN ($1, $2)
        `, [SELFHOSTED_ZERO_REQUEST_ID, ANONYMOUS_ZERO_REQUEST_ID, NOW]);

        const zeroSources = await query<{
            request_id: string;
            preflight_provider_run_count: number;
            preflight_coverage_unknown: boolean;
            preflight_usage_unknown_count: number;
            preflight_no_paid_provider_count: number;
            preflight_no_call_count: number;
            ai_coverage_gap_count: number;
            directly_attributable_cost_complete: boolean;
        }>(db, `
            SELECT request_id, preflight_provider_run_count, preflight_coverage_unknown,
                   preflight_usage_unknown_count, preflight_no_paid_provider_count,
                   preflight_no_call_count, ai_coverage_gap_count,
                   directly_attributable_cost_complete
              FROM public.analysis_v2_cost_rollups
             WHERE request_id IN ($1, $2)
             ORDER BY request_id
        `, [SELFHOSTED_ZERO_REQUEST_ID, ANONYMOUS_ZERO_REQUEST_ID]);
        expect(zeroSources.rows).toEqual([
            {
                request_id: SELFHOSTED_ZERO_REQUEST_ID,
                preflight_provider_run_count: 0,
                preflight_coverage_unknown: false,
                preflight_usage_unknown_count: 0,
                preflight_no_paid_provider_count: 1,
                preflight_no_call_count: 1,
                ai_coverage_gap_count: 1,
                directly_attributable_cost_complete: false,
            },
            {
                request_id: ANONYMOUS_ZERO_REQUEST_ID,
                preflight_provider_run_count: 0,
                preflight_coverage_unknown: true,
                preflight_usage_unknown_count: 1,
                preflight_no_paid_provider_count: 0,
                preflight_no_call_count: 0,
                ai_coverage_gap_count: 1,
                directly_attributable_cost_complete: false,
            },
        ]);
    });

    it('denies rollup and history reads to authenticated roles', async () => {
        for (const role of ['anon', 'authenticated']) {
            await db.query(`SET ROLE ${role}`);
            try {
                await expect(db.query(
                    'SELECT 1 FROM public.analysis_v2_cost_rollups LIMIT 1',
                )).rejects.toThrow();
                await expect(db.query(
                    'SELECT 1 FROM public.analysis_v2_cost_rollup_history LIMIT 1',
                )).rejects.toThrow();
            } finally {
                await db.query('RESET ROLE');
            }
        }

        await db.query('SET ROLE service_role');
        try {
            await expect(db.query(
                'SELECT 1 FROM public.analysis_v2_cost_rollups LIMIT 1',
            )).resolves.toBeDefined();
            await expect(db.query(
                'SELECT 1 FROM public.analysis_v2_cost_rollup_history LIMIT 1',
            )).resolves.toBeDefined();
            await expect(db.query(
                'SELECT public.load_analysis_v2_cost_rollup($1)',
                [LEGACY_REQUEST_ID],
            )).resolves.toBeDefined();
        } finally {
            await db.query('RESET ROLE');
        }
    });
});
