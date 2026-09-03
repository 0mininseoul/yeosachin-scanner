import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260904130000_add_permanent_order_audit_bundle.sql',
    import.meta.url,
), 'utf8');

const REQUEST_ID = '80000000-0000-4000-8000-000000000001';
const PREVIOUS_REQUEST_ID = '80000000-0000-4000-8000-000000000002';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const NOW = '2026-09-04T00:00:00Z';

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version TEXT PRIMARY KEY);
INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('20260904110000');
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
    consumed_request_id UUID,
    status TEXT NOT NULL,
    provider_selector TEXT NOT NULL DEFAULT 'selfhosted_auth',
    target_instagram_id TEXT,
    target_profile_image_url TEXT
);
CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY,
    preflight_id UUID,
    result_request_id UUID
);
CREATE TABLE public.analysis_v2_relationship_sides (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL DEFAULT 'coordinator:relationships',
    side TEXT NOT NULL,
    declared_count INTEGER NOT NULL,
    collected_count INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_run_id TEXT NOT NULL,
    provider_operation_key TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.analysis_v2_relationship_manifests (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    mutual_count INTEGER NOT NULL,
    public_count INTEGER NOT NULL,
    private_count INTEGER NOT NULL,
    detailed_public_count INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.analysis_v2_mutual_rows (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    mutual_ordinal INTEGER NOT NULL,
    following_ordinal INTEGER NOT NULL,
    username TEXT NOT NULL,
    is_private BOOLEAN NOT NULL,
    is_verified BOOLEAN NOT NULL,
    full_name TEXT,
    profile_pic_url TEXT,
    detailed_ordinal INTEGER
);
CREATE TABLE public.analysis_v2_ai_result_checkpoints (
    request_id UUID NOT NULL,
    operation_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    model_name TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    result_json JSONB NOT NULL
);
CREATE TABLE public.analysis_v2_target_evidence_manifests (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL DEFAULT 'track:target-evidence:collect',
    result_hash TEXT NOT NULL,
    interactor_count INTEGER NOT NULL,
    liker_count INTEGER NOT NULL,
    comment_count INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.analysis_v2_candidate_feature_rows (
    request_id UUID NOT NULL,
    candidate_id TEXT NOT NULL,
    instagram_id TEXT NOT NULL,
    full_name TEXT,
    profile_image_url TEXT,
    terminal_classification TEXT NOT NULL,
    baseline_classification TEXT,
    classification_source TEXT,
    gender_resolution_status TEXT,
    gender_resolution_operation_key TEXT,
    gender_resolution_result_hash TEXT,
    gender_operation_key TEXT,
    gender_result_hash TEXT,
    media_context JSONB,
    appearance_grade INTEGER,
    exposure_score INTEGER,
    feature_partner_evidence_strong BOOLEAN,
    feature_operation_key TEXT,
    feature_result_hash TEXT
);
CREATE TABLE public.analysis_v2_private_name_rows (
    request_id UUID NOT NULL,
    candidate_id TEXT NOT NULL,
    instagram_id TEXT NOT NULL,
    full_name TEXT,
    profile_image_url TEXT
);
CREATE TABLE public.analysis_v2_candidate_score_manifests (
    request_id UUID NOT NULL,
    risk_policy_version TEXT
);
CREATE TABLE public.analysis_v2_candidate_score_rows (
    request_id UUID NOT NULL,
    candidate_id TEXT NOT NULL,
    display_score NUMERIC NOT NULL,
    public_score NUMERIC,
    risk_band TEXT NOT NULL,
    featured_rank INTEGER,
    recent_mutual_rank INTEGER,
    components JSONB NOT NULL,
    weak_partner_adjustment NUMERIC NOT NULL,
    pre_score NUMERIC NOT NULL,
    raw_score NUMERIC NOT NULL,
    partner_cap_applied BOOLEAN NOT NULL,
    partner_safety_operation_key TEXT,
    partner_safety_result_hash TEXT
);
CREATE TABLE public.analysis_v2_female_results (
    request_id UUID NOT NULL,
    candidate_id TEXT NOT NULL,
    sort_ordinal INTEGER NOT NULL,
    instagram_id TEXT NOT NULL,
    display_score NUMERIC NOT NULL,
    risk_band TEXT NOT NULL,
    featured_rank INTEGER,
    recent_mutual_rank INTEGER
);
CREATE TABLE public.analysis_v2_result_summaries (
    request_id UUID PRIMARY KEY,
    target_instagram_id TEXT,
    target_profile_image_url TEXT,
    plan_id TEXT,
    score_policy_version TEXT,
    finalizer_input_hash TEXT,
    female_count INTEGER
);
CREATE TABLE public.analysis_v2_reverse_like_rows (
    request_id UUID NOT NULL,
    candidate_id TEXT NOT NULL,
    evidence_ref_ids TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE public.analysis_target_interactors (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    actor_username TEXT NOT NULL,
    post_id TEXT NOT NULL,
    signal TEXT NOT NULL,
    source_interaction_id TEXT NOT NULL,
    occurred_at TEXT,
    comment_text TEXT,
    details JSONB
);
CREATE TABLE public.analysis_v2_cost_attributions (
    request_id UUID NOT NULL,
    preflight_id UUID NOT NULL,
    order_id UUID,
    source_kind TEXT NOT NULL,
    source_operation_key TEXT NOT NULL
);
CREATE TABLE public.analysis_v2_cost_rollup_snapshots (
    request_id UUID PRIMARY KEY,
    total_known_cost_usd NUMERIC,
    total_conservative_cost_usd NUMERIC,
    directly_attributable_cost_complete BOOLEAN,
    usage_unknown BOOLEAN,
    cost_provenance JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE VIEW public.analysis_v2_cost_rollups AS
SELECT
    request.id AS request_id,
    request.preflight_id,
    NULL::UUID AS order_id,
    request.selected_plan_id_snapshot AS plan_id,
    request.plan_access_mode_snapshot AS access_mode,
    request.status AS request_status,
    request.created_at,
    request.completed_at,
    0::INTEGER AS preflight_provider_run_count,
    0::INTEGER AS preflight_attributed_provider_run_count,
    0::INTEGER AS preflight_attribution_gap_count,
    TRUE AS preflight_coverage_unknown,
    0::INTEGER AS preflight_usage_unknown_count,
    0::INTEGER AS preflight_no_call_count,
    0::INTEGER AS preflight_no_paid_provider_count,
    0::INTEGER AS preflight_apify_actual_count,
    0::NUMERIC AS preflight_provider_actual_usd,
    0::NUMERIC AS preflight_apify_actual_charge_usd,
    0::NUMERIC AS preflight_provider_conservative_usd,
    0::INTEGER AS provider_run_count,
    0::INTEGER AS provider_active_count,
    1::INTEGER AS provider_usage_unknown_count,
    0::INTEGER AS provider_no_call_count,
    1::INTEGER AS provider_coverage_gap_count,
    0::INTEGER AS provider_actual_count,
    0::INTEGER AS provider_apify_actual_count,
    0::NUMERIC AS provider_actual_usd,
    0::NUMERIC AS apify_actual_charge_usd,
    0::NUMERIC AS provider_conservative_usd,
    0::INTEGER AS ai_attempt_count,
    0::INTEGER AS ai_reserved_count,
    1::INTEGER AS ai_usage_unknown_count,
    0::INTEGER AS ai_metered_cost_count,
    0::NUMERIC AS metered_estimated_cost_usd,
    0::BIGINT AS ai_input_tokens,
    0::BIGINT AS ai_output_tokens,
    0::BIGINT AS ai_cache_tokens,
    0::INTEGER AS cache_hit_count,
    1::INTEGER AS ai_coverage_gap_count,
    0::INTEGER AS selfhosted_no_paid_provider_count,
    0::INTEGER AS vertex_budget_reservation_count,
    0::INTEGER AS vertex_budget_matched_count,
    0::INTEGER AS vertex_budget_unmatched_count,
    0::INTEGER AS vertex_budget_usage_unknown_count,
    0::INTEGER AS vertex_budget_duplicate_count,
    0::INTEGER AS vertex_budget_mismatch_count,
    0::NUMERIC AS vertex_budget_conservative_fallback_usd,
    0::INTEGER AS vertex_budget_coverage_gap_count,
    0::INTEGER AS provider_no_call_count_total,
    0::INTEGER AS no_call_count,
    0::NUMERIC AS provider_actual_total_usd,
    0::NUMERIC AS provider_conservative_total_usd,
    snapshot.total_known_cost_usd,
    COALESCE(snapshot.total_conservative_cost_usd, 1::NUMERIC) AS total_conservative_cost_usd,
    COALESCE(snapshot.cost_provenance, '{}'::JSONB) AS cost_provenance,
    COALESCE(snapshot.directly_attributable_cost_complete, FALSE) AS directly_attributable_cost_complete,
    COALESCE(snapshot.usage_unknown, TRUE) AS usage_unknown
FROM public.analysis_requests AS request
LEFT JOIN public.analysis_v2_cost_rollup_snapshots AS snapshot
  ON snapshot.request_id = request.id;
`;

describe('permanent order audit bundle SQL behavior', () => {
    let db: PGlite;

    beforeAll(async () => {
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(bootstrap);
        await db.query(`
            INSERT INTO public.analysis_requests(
                id, selected_plan_id_snapshot, plan_access_mode_snapshot,
                status, policy_versions_snapshot, created_at
            ) VALUES
                ($1, 'basic', 'production', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $3),
                ($2, 'standard', 'test_entitlement', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $3)
        `, [REQUEST_ID, PREVIOUS_REQUEST_ID, NOW]);
        await db.exec(migration);
    });

    afterAll(async () => {
        await db?.close();
    });

    it('creates an explicit partial bundle when profile/posts/cost evidence is missing', async () => {
        await db.query('SELECT public.enqueue_analysis_order_audit_bundle($1)', [REQUEST_ID]);
        const assembled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [REQUEST_ID],
        );
        const payload = assembled.rows[0]?.payload as Record<string, unknown>;
        expect(payload.status).toBe('partial');
        expect(payload.version).toBe(1);
        expect(payload.cost).toMatchObject({ usageUnknown: true, status: 'unknown' });
        expect(payload.gapCodes).toEqual(expect.arrayContaining([
            'TARGET_PROFILE_MISSING',
            'TARGET_POSTS_MISSING',
            'MUTUAL_ROWS_MISSING',
            'COST_USAGE_UNKNOWN',
        ]));
        const count = await db.query<{ count: string }>(
            'SELECT count(*) FROM public.analysis_order_audit_bundles WHERE request_id = $1',
            [REQUEST_ID],
        );
        expect(count.rows[0]?.count).toBe(1);
    });

    it('appends a new version on source change, is idempotent for the same source set, and rejects mutation', async () => {
        await db.query(`
            INSERT INTO public.analysis_v2_relationship_sides(
                request_id, side, declared_count, collected_count, provider,
                provider_run_id, provider_operation_key, result_hash
            ) VALUES
                ($1, 'followers', 1, 1, 'apify', 'run-follower', 'relationship-followers:aaaa', $2),
                ($1, 'following', 1, 1, 'apify', 'run-following', 'relationship-following:bbbb', $3)
        `, [REQUEST_ID, HASH_A, HASH_B]);
        await db.query(`
            INSERT INTO public.analysis_v2_relationship_manifests(
                request_id, job_key, result_hash, mutual_count, public_count,
                private_count, detailed_public_count
            ) VALUES ($1, 'coordinator:relationships', $2, 1, 1, 0, 1)
        `, [REQUEST_ID, HASH_C]);
        await db.query(`
            INSERT INTO public.analysis_v2_mutual_rows(
                request_id, job_key, mutual_ordinal, following_ordinal, username,
                is_private, is_verified, detailed_ordinal
            ) VALUES ($1, 'coordinator:relationships', 1, 1, 'candidate.one', FALSE, FALSE, 1)
        `, [REQUEST_ID]);
        await db.query(`
            INSERT INTO public.analysis_v2_candidate_feature_rows(
                request_id, candidate_id, instagram_id, terminal_classification,
                baseline_classification, classification_source, media_context,
                gender_operation_key, gender_result_hash
            ) VALUES ($1, 'candidate:one', 'candidate.one', 'verified_female',
                'verified_female', 'feature', '{"accountContext":"personal"}',
                'gender-triage:aaaa', $2)
        `, [REQUEST_ID, HASH_A]);
        await db.query(`
            INSERT INTO public.analysis_v2_candidate_score_rows(
                request_id, candidate_id, display_score, risk_band, components,
                weak_partner_adjustment, pre_score, raw_score, partner_cap_applied
            ) VALUES ($1, 'candidate:one', 5.4, 'caution',
                '{"candidateToTargetLikes":1}', 0, 40, 40, FALSE)
        `, [REQUEST_ID]);
        await db.query(`
            INSERT INTO public.analysis_v2_female_results(
                request_id, candidate_id, sort_ordinal, instagram_id,
                display_score, risk_band
            ) VALUES ($1, 'candidate:one', 1, 'candidate.one', 5.4, 'caution')
        `, [REQUEST_ID]);
        await db.query(`
            INSERT INTO public.analysis_target_interactors(
                request_id, job_key, ordinal, actor_username, post_id, signal,
                source_interaction_id, comment_text, details
            ) VALUES ($1, 'track:target-evidence:collect', 1, 'candidate.one',
                'target-post-1', 'target_post_comment', 'comment-1', 'hello', '{"confidence":"high"}')
        `, [REQUEST_ID]);

        const second = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [REQUEST_ID],
        );
        const secondPayload = second.rows[0]?.payload as Record<string, unknown>;
        expect(secondPayload.version).toBe(2);
        expect(secondPayload.previousVersionHash).toBeTruthy();

        const repeat = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [REQUEST_ID],
        );
        expect((repeat.rows[0]?.payload as Record<string, unknown>).version).toBe(2);

        await db.query(`
            INSERT INTO public.analysis_v2_cost_rollup_snapshots(
                request_id, total_known_cost_usd, total_conservative_cost_usd,
                directly_attributable_cost_complete, usage_unknown, cost_provenance
            ) VALUES ($1, 0.42, 0.42, TRUE, FALSE, '{"source":"reconciled"}'::jsonb)
        `, [REQUEST_ID]);
        const reconciled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [REQUEST_ID],
        );
        const reconciledPayload = reconciled.rows[0]?.payload as Record<string, unknown>;
        expect(reconciledPayload.version).toBe(3);
        expect(reconciledPayload.cost).toMatchObject({
            knownUsd: 0.42,
            conservativeUsd: 0.42,
            usageUnknown: false,
            status: 'complete',
        });

        await expect(db.query(
            `UPDATE public.analysis_order_audit_bundles
                SET gap_codes = '{}' WHERE request_id = $1`,
            [REQUEST_ID],
        )).rejects.toThrow('ANALYSIS_ORDER_AUDIT_IMMUTABLE');
        await expect(db.query(
            'DELETE FROM public.analysis_order_audit_bundles WHERE request_id = $1',
            [REQUEST_ID],
        )).rejects.toThrow('ANALYSIS_ORDER_AUDIT_IMMUTABLE');
    });

    it('loads bounded redacted sections with retained comment detail', async () => {
        const loaded = await db.query<{ payload: unknown }>(
            `SELECT public.load_analysis_order_audit_bundle(
                $1, 'interactions', 0, 10, 'comments'
            ) AS payload`,
            [REQUEST_ID],
        );
        const payload = loaded.rows[0]?.payload as Record<string, unknown>;
        expect(payload.section).toBe('interactions');
        expect(payload.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                username: 'candidate.one',
                commentText: 'hello',
                details: { confidence: 'high' },
            }),
        ]));
        expect(payload).not.toHaveProperty('userId');
        expect(payload).not.toHaveProperty('providerToken');
    });

    it('assembles at the terminal request boundary before working-set cleanup', async () => {
        await db.query(
            `UPDATE public.analysis_requests
                SET status = 'completed'
              WHERE id = $1`,
            [REQUEST_ID],
        );
        const queue = await db.query<{ status: string }>(
            'SELECT status FROM public.analysis_order_audit_assembly_queue WHERE request_id = $1',
            [REQUEST_ID],
        );
        expect(queue.rows[0]?.status).toBe('completed');

        await db.query(
            'DELETE FROM public.analysis_target_interactors WHERE request_id = $1',
            [REQUEST_ID],
        );
        const loadedAfterCleanup = await db.query<{ payload: unknown }>(
            `SELECT public.load_analysis_order_audit_bundle(
                $1, 'interactions', 0, 10, 'comments'
            ) AS payload`,
            [REQUEST_ID],
        );
        const payload = loadedAfterCleanup.rows[0]?.payload as Record<string, unknown>;
        expect(payload.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({ commentText: 'hello' }),
        ]));
    });

    it('keeps request and cost DML committed when enqueue trigger queue writes fail', async () => {
        await db.exec('BEGIN');
        try {
            await db.exec('DROP TABLE public.analysis_order_audit_assembly_queue');

            const requestUpdate = await db.query<{ id: string }>(
                `UPDATE public.analysis_requests
                    SET status = 'completed'
                  WHERE id = $1
                RETURNING id`,
                [REQUEST_ID],
            );
            expect(requestUpdate.rows).toHaveLength(1);

            const summaryInsert = await db.query<{ request_id: string }>(
                `INSERT INTO public.analysis_v2_result_summaries(request_id)
                 VALUES ($1)
                 RETURNING request_id`,
                [PREVIOUS_REQUEST_ID],
            );
            expect(summaryInsert.rows).toHaveLength(1);
        } finally {
            await db.exec('ROLLBACK');
        }
    });
});
