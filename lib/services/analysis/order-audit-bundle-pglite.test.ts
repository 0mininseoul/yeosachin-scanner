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
const POSTS_REQUEST_ID = '80000000-0000-4000-8000-000000000003';
const ZERO_POST_REQUEST_ID = '80000000-0000-4000-8000-000000000004';
const MISSING_MANIFEST_REQUEST_ID = '80000000-0000-4000-8000-000000000005';
const INCOHERENT_MANIFEST_REQUEST_ID = '80000000-0000-4000-8000-000000000006';
const PREFLIGHT_PROFILE_REQUEST_ID = '80000000-0000-4000-8000-000000000007';
const SUMMARY_PROFILE_REQUEST_ID = '80000000-0000-4000-8000-000000000008';
const UNION_REQUEST_ID = '80000000-0000-4000-8000-000000000009';
const KEY_COVERAGE_REQUEST_ID = '80000000-0000-4000-8000-000000000010';
const LINEAGE_REQUEST_ID = '80000000-0000-4000-8000-000000000011';
const PURGE_FENCE_REQUEST_ID = '80000000-0000-4000-8000-000000000012';
const PREFLIGHT_PROFILE_ID = '81000000-0000-4000-8000-000000000001';
const ORDER_ID = '82000000-0000-4000-8000-000000000001';
const LIST_REQUEST_A = '80000000-0000-4000-8000-000000000013';
const LIST_REQUEST_B = '80000000-0000-4000-8000-000000000014';
const LIST_REQUEST_C = '80000000-0000-4000-8000-000000000015';
const LIST_REQUEST_D = '80000000-0000-4000-8000-000000000016';
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
    target_profile_image_url TEXT,
    target_followers_count INTEGER,
    target_following_count INTEGER
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
    provider_credential_slot TEXT NOT NULL DEFAULT 'primary',
    input_hash TEXT NOT NULL DEFAULT repeat('a', 64),
    result_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.analysis_v2_relationship_rows (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL DEFAULT 'coordinator:relationships',
    side TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    username TEXT NOT NULL,
    is_private BOOLEAN NOT NULL DEFAULT FALSE,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    full_name TEXT,
    profile_pic_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.analysis_v2_relationship_manifests (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    excluded_username TEXT,
    exclusion_decision_hash TEXT NOT NULL DEFAULT repeat('a', 64),
    followers_result_hash TEXT NOT NULL DEFAULT repeat('a', 64),
    following_result_hash TEXT NOT NULL DEFAULT repeat('b', 64),
    detailed_mutual_limit INTEGER NOT NULL DEFAULT 300,
    mutual_count INTEGER NOT NULL,
    public_count INTEGER NOT NULL,
    private_count INTEGER NOT NULL,
    detailed_public_count INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_target_evidence_source(
    p_signal TEXT,
    p_source JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT p_signal IN ('target_post_like', 'target_post_comment')
       AND p_source IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_source) = 'object'
       AND p_source ?& ARRAY[
            'status', 'input_hash', 'provider', 'provider_run_id',
            'provider_operation_key', 'provider_credential_slot', 'coverage'
       ]
       AND p_source - ARRAY[
            'status', 'input_hash', 'provider', 'provider_run_id',
            'provider_operation_key', 'provider_credential_slot', 'coverage'
       ] = '{}'::JSONB
       AND pg_catalog.jsonb_typeof(p_source->'status') = 'string'
       AND p_source->>'status' IN ('collected', 'not_applicable')
       AND pg_catalog.jsonb_typeof(p_source->'input_hash') = 'string'
       AND p_source->>'input_hash' ~ '^[0-9a-f]{64}$'
       AND pg_catalog.jsonb_typeof(p_source->'coverage') = 'array'
       AND pg_catalog.jsonb_array_length(p_source->'coverage') <= CASE p_signal
            WHEN 'target_post_like' THEN 4 ELSE 6
       END
       AND (
            (
                p_source->>'status' = 'not_applicable'
                AND p_source->'provider' = 'null'::JSONB
                AND p_source->'provider_run_id' = 'null'::JSONB
                AND p_source->'provider_operation_key' = 'null'::JSONB
                AND p_source->'provider_credential_slot' = 'null'::JSONB
                AND pg_catalog.jsonb_array_length(p_source->'coverage') = 0
            )
            OR (
                p_source->>'status' = 'collected'
                AND pg_catalog.jsonb_typeof(p_source->'provider') = 'string'
                AND p_source->>'provider' IN ('apify', 'coderx')
                AND pg_catalog.jsonb_typeof(p_source->'provider_run_id') = 'string'
                AND p_source->>'provider_run_id' ~ '^[A-Za-z0-9]{8,64}$'
                AND pg_catalog.jsonb_typeof(p_source->'provider_operation_key') = 'string'
                AND p_source->>'provider_operation_key' ~ CASE p_signal
                    WHEN 'target_post_like' THEN '^target-likers:[0-9a-f]{64}$'
                    ELSE '^target-comments:[0-9a-f]{64}$'
                END
                AND pg_catalog.jsonb_typeof(p_source->'provider_credential_slot') = 'string'
                AND p_source->>'provider_credential_slot' IN ('primary', 'secondary')
                AND pg_catalog.jsonb_array_length(p_source->'coverage') >= 1
            )
       )
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_source->'coverage') AS coverage(value)
            WHERE pg_catalog.jsonb_typeof(coverage.value) <> 'object'
               OR NOT coverage.value ?& ARRAY[
                    'post_id', 'declared_count', 'returned_count', 'requested_limit'
               ]
               OR coverage.value - ARRAY[
                    'post_id', 'declared_count', 'returned_count', 'requested_limit'
               ] <> '{}'::JSONB
               OR pg_catalog.jsonb_typeof(coverage.value->'post_id') <> 'string'
               OR pg_catalog.char_length(coverage.value->>'post_id') NOT BETWEEN 1 AND 255
               OR coverage.value->>'post_id' ~ '[[:cntrl:]]'
               OR pg_catalog.jsonb_typeof(coverage.value->'declared_count') <> 'number'
               OR coverage.value->>'declared_count' !~ '^(0|[1-9][0-9]{0,7})$'
               OR (coverage.value->>'declared_count')::INTEGER > 10000000
               OR pg_catalog.jsonb_typeof(coverage.value->'returned_count') <> 'number'
               OR coverage.value->>'returned_count' !~ '^(0|[1-9][0-9]{0,2})$'
               OR (coverage.value->>'returned_count')::INTEGER > CASE p_signal
                    WHEN 'target_post_like' THEN 150 ELSE 15
               END
               OR pg_catalog.jsonb_typeof(coverage.value->'requested_limit') <> 'number'
               OR coverage.value->>'requested_limit' !~ '^(15|150)$'
               OR (coverage.value->>'requested_limit')::INTEGER <> CASE p_signal
                    WHEN 'target_post_like' THEN 150 ELSE 15
               END
               OR (coverage.value->>'returned_count')::INTEGER
                    > (coverage.value->>'requested_limit')::INTEGER
       )
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_source->'coverage') AS coverage(value)
            GROUP BY coverage.value->>'post_id'
            HAVING pg_catalog.count(*) > 1
       );
$$;
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
    input_hash TEXT NOT NULL DEFAULT repeat('a', 64),
    result_hash TEXT NOT NULL,
    result_json JSONB NOT NULL
);
CREATE TABLE public.analysis_v2_target_evidence_manifests (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL DEFAULT 'track:target-evidence:collect',
    result_hash TEXT NOT NULL,
    input_hash TEXT NOT NULL DEFAULT repeat('a', 64),
    target_username TEXT NOT NULL DEFAULT 'target.account',
    liker_source_hash TEXT NOT NULL DEFAULT repeat('a', 64),
    comment_source_hash TEXT NOT NULL DEFAULT repeat('b', 64),
    interactor_count INTEGER NOT NULL,
    liker_count INTEGER NOT NULL,
    comment_count INTEGER NOT NULL,
    liker_source JSONB,
    comment_source JSONB,
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
    risk_policy_version TEXT,
    producer_input_hash TEXT DEFAULT repeat('a', 64),
    result_hash TEXT DEFAULT repeat('a', 64),
    item_count INTEGER DEFAULT 0
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
    reverse_like_status TEXT NOT NULL DEFAULT 'observed',
    component_score NUMERIC NOT NULL DEFAULT 3,
    evidence_ref_ids TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE public.analysis_v2_reverse_like_manifests (
    request_id UUID PRIMARY KEY,
    producer_input_hash TEXT DEFAULT repeat('a', 64),
    result_hash TEXT DEFAULT repeat('a', 64),
    item_count INTEGER NOT NULL DEFAULT 0
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
    comment_text TEXT
);
CREATE TABLE public.analysis_v2_score_audit_intents (
    request_id UUID PRIMARY KEY,
    source_result_hash TEXT NOT NULL,
    source_generation INTEGER NOT NULL DEFAULT 1,
    checkpoint_item_count INTEGER NOT NULL DEFAULT 0,
    intent_status TEXT NOT NULL DEFAULT 'queued',
    retain_until TIMESTAMPTZ NOT NULL
);
CREATE TABLE public.analysis_v2_score_audit_runs (
    request_id UUID PRIMARY KEY,
    source_result_hash TEXT,
    source_generation INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL
);
CREATE TABLE public.analysis_v2_ai_scoring_stage_checkpoints (
    request_id UUID NOT NULL,
    stage_kind TEXT NOT NULL,
    batch_key INTEGER NOT NULL,
    result_hash TEXT NOT NULL,
    PRIMARY KEY (request_id, stage_kind, batch_key)
);
CREATE TABLE public.analysis_v2_narrative_manifests (request_id UUID NOT NULL);
CREATE TABLE public.analysis_v2_partner_safety_manifests (request_id UUID NOT NULL);
CREATE TABLE public.analysis_v2_preliminary_score_manifests (request_id UUID NOT NULL);
CREATE TABLE public.analysis_v2_private_name_manifests (request_id UUID NOT NULL);
CREATE TABLE public.analysis_v2_candidate_feature_manifests (request_id UUID NOT NULL);
CREATE TABLE public.analysis_v2_profile_fetch_batches (request_id UUID NOT NULL);
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
                id, preflight_id, selected_plan_id_snapshot, plan_access_mode_snapshot,
                status, policy_versions_snapshot, created_at
            ) VALUES
                ($1, NULL, 'basic', 'production', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $3),
                ($2, NULL, 'standard', 'test_entitlement', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $3),
                ($4, NULL, 'basic', 'production', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $3),
                ($5, NULL, 'basic', 'production', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $3),
                ($6, NULL, 'basic', 'production', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $3),
                ($7, NULL, 'basic', 'production', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $3),
                ($8, $11, 'basic', 'production', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $3)
                ,($9, NULL, 'basic', 'production', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $3)
                ,($10, NULL, 'basic', 'production', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $3)
        `, [
            REQUEST_ID, PREVIOUS_REQUEST_ID, NOW, POSTS_REQUEST_ID,
            ZERO_POST_REQUEST_ID, MISSING_MANIFEST_REQUEST_ID,
            INCOHERENT_MANIFEST_REQUEST_ID, PREFLIGHT_PROFILE_REQUEST_ID,
            SUMMARY_PROFILE_REQUEST_ID, UNION_REQUEST_ID, PREFLIGHT_PROFILE_ID,
        ]);
        await db.query(`
            INSERT INTO public.analysis_requests(
                id, preflight_id, selected_plan_id_snapshot, plan_access_mode_snapshot,
                status, policy_versions_snapshot, created_at
            ) VALUES
                ($1, NULL, 'basic', 'production', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $2),
                ($3, NULL, 'basic', 'production', 'completed',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $2),
                ($4, NULL, 'basic', 'production', 'processing',
                    '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.12","scheduler":"ai-scheduler-v1"}'::jsonb, $2)
        `, [KEY_COVERAGE_REQUEST_ID, NOW, LINEAGE_REQUEST_ID, PURGE_FENCE_REQUEST_ID]);
        await db.query(`
            INSERT INTO public.analysis_preflights(
                id, consumed_request_id, status, target_instagram_id,
                target_profile_image_url, target_followers_count, target_following_count
            ) VALUES ($1, $2, 'consumed', 'profile.noimage', NULL, 0, 0)
        `, [PREFLIGHT_PROFILE_ID, PREFLIGHT_PROFILE_REQUEST_ID]);
        await db.query(`
            INSERT INTO public.analysis_v2_result_summaries(
                request_id, target_instagram_id, target_profile_image_url, plan_id
            ) VALUES ($1, 'summary.noimage', NULL, 'basic')
        `, [SUMMARY_PROFILE_REQUEST_ID]);
        await db.query(`
            INSERT INTO public.earlybird_orders(id, result_request_id)
            VALUES ($1, $2)
        `, [ORDER_ID, REQUEST_ID]);
        await db.exec(migration);
    });

    afterAll(async () => {
        await db?.close();
    });

    it('keeps the purge wrapper service-only and the exact implementation private', async () => {
        const privileges = await db.query<{
            wrapper_anon: boolean;
            wrapper_authenticated: boolean;
            wrapper_service: boolean;
            exact_service: boolean;
            fence_service: boolean;
        }>(`
            SELECT
                has_function_privilege(
                    'anon',
                    'public.analysis_v2_purge_result_working_set(uuid,boolean)',
                    'EXECUTE'
                ) AS wrapper_anon,
                has_function_privilege(
                    'authenticated',
                    'public.analysis_v2_purge_result_working_set(uuid,boolean)',
                    'EXECUTE'
                ) AS wrapper_authenticated,
                has_function_privilege(
                    'service_role',
                    'public.analysis_v2_purge_result_working_set(uuid,boolean)',
                    'EXECUTE'
                ) AS wrapper_service,
                has_function_privilege(
                    'service_role',
                    'public.analysis_v2_purge_result_working_set_exact(uuid,boolean)',
                    'EXECUTE'
                ) AS exact_service,
                has_function_privilege(
                    'service_role',
                    'public.analysis_order_audit_purge_fence(uuid,text)',
                    'EXECUTE'
                ) AS fence_service
        `);
        expect(privileges.rows[0]).toEqual({
            wrapper_anon: false,
            wrapper_authenticated: false,
            wrapper_service: true,
            exact_service: false,
            fence_service: false,
        });
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
        expect(payload).toMatchObject({ orderId: ORDER_ID });
        expect(payload).not.toHaveProperty('user_id');
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

    it('counts distinct manifest coverage posts even when interactions are zero', async () => {
        const likerSource = {
            status: 'collected',
            input_hash: HASH_A,
            provider: 'apify',
            provider_run_id: 'likerrun01',
            provider_operation_key: `target-likers:${HASH_A}`,
            provider_credential_slot: 'primary',
            coverage: [{
                post_id: 'post-without-interactions',
                declared_count: 1,
                returned_count: 0,
                requested_limit: 150,
            }],
        };
        const commentSource = {
            status: 'not_applicable',
            input_hash: HASH_B,
            provider: null,
            provider_run_id: null,
            provider_operation_key: null,
            provider_credential_slot: null,
            coverage: [],
        };
        await db.query(`
            INSERT INTO public.analysis_v2_target_evidence_manifests(
                request_id, result_hash, interactor_count, liker_count, comment_count,
                liker_source, comment_source
            ) VALUES ($1, $2, 0, 0, 0, $3::jsonb, $4::jsonb)
        `, [POSTS_REQUEST_ID, HASH_C, JSON.stringify(likerSource), JSON.stringify(commentSource)]);

        const assembled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [POSTS_REQUEST_ID],
        );
        const payload = assembled.rows[0]?.payload as Record<string, unknown>;
        expect(payload).toMatchObject({
            targetPostsAvailable: true,
            targetPostCount: 1,
            interactions: { declared: 0, collected: 0 },
            stageStatus: { targetEvidence: true },
        });
        expect(payload.gapCodes).not.toContain('TARGET_POSTS_MISSING');
    });

    it('publishes a valid zero-post manifest without inventing a missing gap', async () => {
        const notApplicable = {
            status: 'not_applicable',
            input_hash: HASH_A,
            provider: null,
            provider_run_id: null,
            provider_operation_key: null,
            provider_credential_slot: null,
            coverage: [],
        };
        await db.query(`
            INSERT INTO public.analysis_v2_target_evidence_manifests(
                request_id, result_hash, interactor_count, liker_count, comment_count,
                liker_source, comment_source
            ) VALUES ($1, $2, 0, 0, 0, $3::jsonb, $3::jsonb)
        `, [ZERO_POST_REQUEST_ID, HASH_C, JSON.stringify(notApplicable)]);

        const assembled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [ZERO_POST_REQUEST_ID],
        );
        const payload = assembled.rows[0]?.payload as Record<string, unknown>;
        expect(payload).toMatchObject({
            targetPostsAvailable: false,
            targetPostCount: 0,
            interactions: { declared: 0, collected: 0 },
            stageStatus: { targetEvidence: true },
        });
        expect(payload.gapCodes).not.toContain('TARGET_POSTS_MISSING');
    });

    it('treats a missing target evidence manifest as a target-post gap', async () => {
        const assembled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [MISSING_MANIFEST_REQUEST_ID],
        );
        const payload = assembled.rows[0]?.payload as Record<string, unknown>;
        expect(payload).toMatchObject({
            targetPostsAvailable: false,
            targetPostCount: null,
            interactions: {
                targetLikes: { declared: null, collected: null },
                targetComments: { declared: null, collected: null },
            },
            stageStatus: { targetEvidence: false },
        });
        expect(payload.gapCodes).toContain('TARGET_POSTS_MISSING');
    });

    it('treats an incoherent target evidence manifest as a target-post gap', async () => {
        await db.query(`
            INSERT INTO public.analysis_v2_target_evidence_manifests(
                request_id, result_hash, interactor_count, liker_count, comment_count,
                liker_source, comment_source
            ) VALUES ($1, $2, 0, 0, 0, '{"status":"collected","coverage":[]}'::jsonb,
                '{"status":"not_applicable","coverage":[]}'::jsonb)
        `, [INCOHERENT_MANIFEST_REQUEST_ID, HASH_C]);

        const assembled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [INCOHERENT_MANIFEST_REQUEST_ID],
        );
        const payload = assembled.rows[0]?.payload as Record<string, unknown>;
        expect(payload).toMatchObject({
            targetPostsAvailable: false,
            targetPostCount: null,
            stageStatus: { targetEvidence: false },
        });
        expect(payload.gapCodes).toContain('TARGET_POSTS_MISSING');
    });

    it('deduplicates post ids across liker and comment coverage', async () => {
        const source = (signal: 'liker' | 'comment', postIds: string[]) => ({
            status: 'collected',
            input_hash: signal === 'liker' ? HASH_A : HASH_B,
            provider: 'apify',
            provider_run_id: `${signal}run01`,
            provider_operation_key: `${signal === 'liker' ? 'target-likers' : 'target-comments'}:${signal === 'liker' ? HASH_A : HASH_B}`,
            provider_credential_slot: 'primary',
            coverage: postIds.map(post_id => ({
                post_id,
                declared_count: 1,
                returned_count: 0,
                requested_limit: signal === 'liker' ? 150 : 15,
            })),
        });
        await db.query(`
            INSERT INTO public.analysis_v2_target_evidence_manifests(
                request_id, result_hash, interactor_count, liker_count, comment_count,
                liker_source, comment_source
            ) VALUES ($1, $2, 2, 1, 1, $3::jsonb, $4::jsonb)
        `, [
            UNION_REQUEST_ID,
            HASH_C,
            JSON.stringify(source('liker', ['shared-post', 'liker-only'])),
            JSON.stringify(source('comment', ['shared-post', 'comment-only'])),
        ]);

        const assembled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [UNION_REQUEST_ID],
        );
        const payload = assembled.rows[0]?.payload as Record<string, unknown>;
        expect(payload).toMatchObject({
            targetPostsAvailable: true,
            targetPostCount: 3,
            interactions: { declared: 2 },
            stageStatus: { targetEvidence: true },
        });
        expect(payload.gapCodes).not.toContain('TARGET_POSTS_MISSING');
    });

    it('accepts a profile proven by preflight counts when its image is null', async () => {
        const assembled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [PREFLIGHT_PROFILE_REQUEST_ID],
        );
        const payload = assembled.rows[0]?.payload as Record<string, unknown>;
        expect(payload).toMatchObject({
            targetInstagramId: 'profile.noimage',
            targetProfileAvailable: true,
        });
        expect(payload.gapCodes).not.toContain('TARGET_PROFILE_MISSING');
    });

    it('accepts a completed result summary as profile evidence without an image', async () => {
        const assembled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [SUMMARY_PROFILE_REQUEST_ID],
        );
        const payload = assembled.rows[0]?.payload as Record<string, unknown>;
        expect(payload).toMatchObject({
            targetInstagramId: 'summary.noimage',
            targetProfileAvailable: true,
        });
        expect(payload.gapCodes).not.toContain('TARGET_PROFILE_MISSING');
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
                source_interaction_id, comment_text
            ) VALUES ($1, 'track:target-evidence:collect', 1, 'candidate.one',
                'target-post-1', 'target_post_comment', 'comment-1', 'hello')
        `, [REQUEST_ID]);
        await db.query(`
            INSERT INTO public.analysis_target_interactors(
                request_id, job_key, ordinal, actor_username, post_id, signal,
                source_interaction_id
            )
            SELECT $1, 'track:target-evidence:collect', item.ordinal, 'candidate.one',
                'target-post-' || item.ordinal::TEXT, 'target_post_like',
                'target-interaction-' || item.ordinal::TEXT
              FROM generate_series(2, 1001) AS item(ordinal)
        `, [REQUEST_ID]);
        await db.query(`
            INSERT INTO public.analysis_v2_reverse_like_rows(
                request_id, candidate_id, evidence_ref_ids
            ) VALUES ($1, 'candidate:one', ARRAY['candidate-post-1'])
        `, [REQUEST_ID]);

        const second = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [REQUEST_ID],
        );
        const secondPayload = second.rows[0]?.payload as Record<string, unknown>;
        expect(secondPayload.version).toBe(2);
        expect(secondPayload.previousVersionHash).toBeTruthy();
        expect(secondPayload.providerRuns).toEqual(expect.arrayContaining([
            expect.objectContaining({
                stage: 'followers',
                logicalProvider: 'apify',
                credentialSlot: 'primary',
                runId: 'run-follower',
                operationKey: 'relationship-followers:aaaa',
                resultHash: HASH_A,
            }),
            expect.objectContaining({
                stage: 'following',
                logicalProvider: 'apify',
                credentialSlot: 'primary',
                runId: 'run-following',
                operationKey: 'relationship-following:bbbb',
                resultHash: HASH_B,
            }),
        ]));
        const secondCounts = await db.query<{
            candidate_declared: number;
            candidate_collected: number;
            interaction_collected: number;
        }>(
            `SELECT candidate_declared, candidate_collected, interaction_collected
               FROM public.analysis_order_audit_bundles
              WHERE request_id = $1 AND version = 2`,
            [REQUEST_ID],
        );
        expect(secondCounts.rows[0]).toMatchObject({
            candidate_declared: 1,
            candidate_collected: 1,
            interaction_collected: 1002,
        });
        const secondInteractionOrdinals = await db.query<{
            count: string;
            distinct_count: string;
            max_ordinal: string;
        }>(
            `SELECT count(*)::TEXT AS count,
                    count(DISTINCT ordinal)::TEXT AS distinct_count,
                    max(ordinal)::TEXT AS max_ordinal
               FROM public.analysis_order_audit_interactions
              WHERE request_id = $1 AND version = 2`,
            [REQUEST_ID],
        );
        expect(secondInteractionOrdinals.rows[0]).toEqual({
            count: '1002',
            distinct_count: '1002',
            max_ordinal: '1002',
        });
        const reverseOrdinal = await db.query<{ min_ordinal: string; max_ordinal: string }>(
            `SELECT min(ordinal)::TEXT AS min_ordinal, max(ordinal)::TEXT AS max_ordinal
               FROM public.analysis_order_audit_interactions
              WHERE request_id = $1 AND version = 2
                AND signal = 'candidate_post_like'`,
            [REQUEST_ID],
        );
        expect(reverseOrdinal.rows[0]).toEqual({ min_ordinal: '1002', max_ordinal: '1002' });
        expect(String(secondCounts.rows[0]?.interaction_collected))
            .toBe(secondInteractionOrdinals.rows[0]?.count);

        const repeat = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [REQUEST_ID],
        );
        expect((repeat.rows[0]?.payload as Record<string, unknown>).version).toBe(2);

        await db.query(
            `UPDATE public.analysis_target_interactors
                SET comment_text = 'changed immutable evidence'
              WHERE request_id = $1 AND source_interaction_id = 'comment-1'`,
            [REQUEST_ID],
        );
        const changedInteraction = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [REQUEST_ID],
        );
        const changedInteractionPayload = changedInteraction.rows[0]?.payload as Record<string, unknown>;
        expect(changedInteractionPayload.version).toBe(3);
        expect(changedInteractionPayload.sourceSetHash)
            .not.toBe(secondPayload.sourceSetHash);

        await db.query(`
            INSERT INTO public.analysis_v2_cost_rollup_snapshots(
                request_id, total_known_cost_usd, total_conservative_cost_usd,
                directly_attributable_cost_complete, usage_unknown, cost_provenance
            ) VALUES ($1, 0.42, 0.42, TRUE, FALSE,
                '{"source":"reconciled","provider":{"actualUsd":0.12},"ai":{"estimatedUsd":0.30},"user_id":"redacted"}'::jsonb)
        `, [REQUEST_ID]);
        const reconciled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [REQUEST_ID],
        );
        const reconciledPayload = reconciled.rows[0]?.payload as Record<string, unknown>;
        expect(reconciledPayload.version).toBe(4);
        expect(reconciledPayload.cost).toMatchObject({
            knownUsd: 0.42,
            conservativeUsd: 0.42,
            usageUnknown: false,
            status: 'complete',
        });
        expect((reconciledPayload.cost as Record<string, unknown>).provenance).toMatchObject({
            source: 'reconciled',
            provider: { actualUsd: 0.12 },
            ai: { estimatedUsd: 0.3 },
        });
        expect(reconciledPayload.cost).not.toHaveProperty('provenance.user_id');

        const duplicateEnqueue = await db.query<{ payload: Record<string, unknown> }>(
            'SELECT public.enqueue_analysis_order_audit_bundle($1) AS payload',
            [REQUEST_ID],
        );
        expect(duplicateEnqueue.rows[0]?.payload).toMatchObject({
            status: 'queued',
            requestId: REQUEST_ID,
        });
        const queueAfterDuplicate = await db.query<{ status: string }>(
            'SELECT status FROM public.analysis_order_audit_assembly_queue WHERE request_id = $1',
            [REQUEST_ID],
        );
        expect(queueAfterDuplicate.rows[0]?.status).toBe('completed');

        await db.query(
            `UPDATE public.analysis_v2_cost_rollup_snapshots
                SET cost_provenance = '{"source":"reconciled-late"}'::jsonb
              WHERE request_id = $1`,
            [REQUEST_ID],
        );
        const queueAfterCostRefresh = await db.query<{ status: string }>(
            'SELECT status FROM public.analysis_order_audit_assembly_queue WHERE request_id = $1',
            [REQUEST_ID],
        );
        expect(queueAfterCostRefresh.rows[0]?.status).toBe('queued');

        await db.query(
            'SELECT public.assemble_analysis_order_audit_bundle($1)',
            [REQUEST_ID],
        );
        await db.query(
            `UPDATE public.analysis_v2_cost_rollup_snapshots
                SET cost_provenance = '{"source":"reconciled-late"}'::jsonb
              WHERE request_id = $1`,
            [REQUEST_ID],
        );
        const queueAfterUnchangedCost = await db.query<{ status: string }>(
            'SELECT status FROM public.analysis_order_audit_assembly_queue WHERE request_id = $1',
            [REQUEST_ID],
        );
        expect(queueAfterUnchangedCost.rows[0]?.status).toBe('completed');

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
                commentText: 'changed immutable evidence',
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
            expect.objectContaining({ commentText: 'changed immutable evidence' }),
        ]));

        await db.exec(`
            DELETE FROM public.analysis_v2_relationship_sides WHERE request_id = '${REQUEST_ID}';
            DELETE FROM public.analysis_v2_relationship_manifests WHERE request_id = '${REQUEST_ID}';
            DELETE FROM public.analysis_v2_mutual_rows WHERE request_id = '${REQUEST_ID}';
            DELETE FROM public.analysis_v2_candidate_feature_rows WHERE request_id = '${REQUEST_ID}';
            DELETE FROM public.analysis_v2_candidate_score_rows WHERE request_id = '${REQUEST_ID}';
        `);
        await db.query(
            `UPDATE public.analysis_v2_cost_rollup_snapshots
                SET total_known_cost_usd = 0.55,
                    total_conservative_cost_usd = 0.55,
                    cost_provenance = '{"source":"post-purge-reconciliation"}'::jsonb
              WHERE request_id = $1`,
            [REQUEST_ID],
        );
        const late = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [REQUEST_ID],
        );
        const latePayload = late.rows[0]?.payload as Record<string, unknown>;
        expect(latePayload.cost).toMatchObject({ knownUsd: 0.55, usageUnknown: false });
        const lateCounts = await db.query<{
            candidate_declared: number;
            candidate_collected: number;
            interaction_collected: number;
        }>(
            `SELECT candidate_declared, candidate_collected, interaction_collected
               FROM public.analysis_order_audit_bundles
              WHERE request_id = $1
              ORDER BY version DESC
              LIMIT 1`,
            [REQUEST_ID],
        );
        expect(lateCounts.rows[0]).toMatchObject({
            candidate_declared: 1,
            candidate_collected: 1,
            interaction_collected: 1002,
        });
        const lateChildCount = await db.query<{ count: string }>(
            `SELECT count(*)::TEXT AS count
               FROM public.analysis_order_audit_interactions
              WHERE request_id = $1
                AND version = (SELECT max(version)
                                 FROM public.analysis_order_audit_bundles
                                WHERE request_id = $1)`,
            [REQUEST_ID],
        );
        expect(lateChildCount.rows[0]?.count).toBe('1002');
        const lateInteractions = await db.query<{ payload: unknown }>(
            `SELECT public.load_analysis_order_audit_bundle(
                $1, 'interactions', 0, 10, 'comments'
            ) AS payload`,
            [REQUEST_ID],
        );
        expect((lateInteractions.rows[0]?.payload as Record<string, unknown>).rows)
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ commentText: 'changed immutable evidence' }),
            ]));
    });

    it('keeps request and cost DML committed when enqueue trigger queue writes fail', async () => {
        await db.exec('BEGIN');
        let committed = false;
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

            const costAttributionInsert = await db.query<{ request_id: string }>(
                `INSERT INTO public.analysis_v2_cost_attributions(
                    request_id, preflight_id, source_kind, source_operation_key
                 ) VALUES ($1, $2, 'provider', 'provider:queue-outage')
                 RETURNING request_id`,
                [REQUEST_ID, PREFLIGHT_PROFILE_ID],
            );
            expect(costAttributionInsert.rows).toHaveLength(1);

            const costUpdate = await db.query<{ request_id: string }>(
                `UPDATE public.analysis_v2_cost_rollup_snapshots
                    SET total_known_cost_usd = 0.77,
                        total_conservative_cost_usd = 0.77,
                        directly_attributable_cost_complete = TRUE,
                        usage_unknown = FALSE,
                        cost_provenance = '{"source":"queue-outage"}'::jsonb
                  WHERE request_id = $1
                RETURNING request_id`,
                [REQUEST_ID],
            );
            expect(costUpdate.rows).toHaveLength(1);
            await db.exec('COMMIT');
            committed = true;
        } finally {
            if (!committed) {
                await db.exec('ROLLBACK');
            }
        }

        const committedRequest = await db.query<{ status: string }>(
            'SELECT status FROM public.analysis_requests WHERE id = $1',
            [REQUEST_ID],
        );
        expect(committedRequest.rows[0]?.status).toBe('completed');
        const committedSummary = await db.query<{ request_id: string }>(
            'SELECT request_id FROM public.analysis_v2_result_summaries WHERE request_id = $1',
            [PREVIOUS_REQUEST_ID],
        );
        expect(committedSummary.rows).toHaveLength(1);
        const committedCostAttribution = await db.query<{ request_id: string }>(
            `SELECT request_id
               FROM public.analysis_v2_cost_attributions
              WHERE request_id = $1 AND source_operation_key = 'provider:queue-outage'`,
            [REQUEST_ID],
        );
        expect(committedCostAttribution.rows).toHaveLength(1);
        const committedCost = await db.query<{
            request_id: string;
            total_known_cost_usd: string;
            usage_unknown: boolean;
        }>(
            `SELECT request_id, total_known_cost_usd, usage_unknown
               FROM public.analysis_v2_cost_rollup_snapshots
              WHERE request_id = $1`,
            [REQUEST_ID],
        );
        expect(committedCost.rows[0]).toMatchObject({
            request_id: REQUEST_ID,
            total_known_cost_usd: '0.77',
            usage_unknown: false,
        });
        await db.exec(`
            CREATE TABLE public.analysis_order_audit_assembly_queue (
                request_id UUID PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'queued',
                attempt_count SMALLINT NOT NULL DEFAULT 0,
                next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                lease_token UUID,
                lease_expires_at TIMESTAMPTZ,
                last_error_code TEXT,
                last_error_at TIMESTAMPTZ,
                purge_fenced_at TIMESTAMPTZ,
                purge_fence_reason TEXT,
                purged_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
            )
        `);
    });

    it('records a durable purge fence when the queue row is missing', async () => {
        await db.query(
            'SELECT public.analysis_v2_purge_result_working_set($1, TRUE)',
            [PREVIOUS_REQUEST_ID],
        );
        const fenced = await db.query<{
            status: string;
            purge_fenced_at: string | null;
            purge_fence_reason: string | null;
        }>(
            `SELECT status, purge_fenced_at::TEXT, purge_fence_reason
               FROM public.analysis_order_audit_assembly_queue WHERE request_id = $1`,
            [PREVIOUS_REQUEST_ID],
        );
        expect(fenced.rows[0]).toMatchObject({
            status: 'failed',
            purge_fence_reason: 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED',
        });
        expect(fenced.rows[0]?.purge_fenced_at).toBeTruthy();
    });

    it('preserves provider lineage for target liker/comment sources without raw identities', async () => {
        const likerSource = {
            status: 'collected',
            input_hash: HASH_A,
            provider: 'apify',
            provider_run_id: 'likerrun01',
            provider_operation_key: `target-likers:${HASH_A}`,
            provider_credential_slot: 'primary',
            coverage: [{
                post_id: 'target-post-lineage',
                declared_count: 1,
                returned_count: 0,
                requested_limit: 150,
            }],
        };
        const commentSource = {
            status: 'collected',
            input_hash: HASH_B,
            provider: 'coderx',
            provider_run_id: 'commentrun01',
            provider_operation_key: `target-comments:${HASH_B}`,
            provider_credential_slot: 'secondary',
            coverage: [{
                post_id: 'target-post-lineage',
                declared_count: 1,
                returned_count: 0,
                requested_limit: 15,
            }],
        };
        await db.query(`
            INSERT INTO public.analysis_v2_target_evidence_manifests(
                request_id, result_hash, input_hash, target_username,
                liker_source_hash, comment_source_hash,
                interactor_count, liker_count, comment_count,
                liker_source, comment_source
            ) VALUES ($1, $2, $3, 'lineage.target', $4, $5, 0, 0, 0, $6::jsonb, $7::jsonb)
        `, [
            LINEAGE_REQUEST_ID, HASH_C, HASH_A, HASH_A, HASH_B,
            JSON.stringify(likerSource), JSON.stringify(commentSource),
        ]);

        const assembled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [LINEAGE_REQUEST_ID],
        );
        const payload = assembled.rows[0]?.payload as Record<string, unknown>;
        expect(payload.providerRuns).toEqual(expect.arrayContaining([
            expect.objectContaining({
                stage: 'target_likers',
                logicalProvider: 'apify',
                credentialSlot: 'primary',
                runId: 'likerrun01',
                operationKey: `target-likers:${HASH_A}`,
                resultHash: HASH_A,
            }),
            expect.objectContaining({
                stage: 'target_comments',
                logicalProvider: 'coderx',
                credentialSlot: 'secondary',
                runId: 'commentrun01',
                operationKey: `target-comments:${HASH_B}`,
                resultHash: HASH_B,
            }),
        ]));
        expect(JSON.stringify(payload)).not.toContain('actorId');
        expect(JSON.stringify(payload)).not.toContain('userUuid');
    });

    it('marks a missing-one plus extra-one candidate key set as inconsistent', async () => {
        await db.query(`
            INSERT INTO public.analysis_v2_relationship_sides(
                request_id, side, declared_count, collected_count, provider,
                provider_run_id, provider_operation_key, result_hash
            ) VALUES
                ($1, 'followers', 2, 2, 'apify', 'run-key-follower', 'relationship-followers:aaaa', $2),
                ($1, 'following', 2, 2, 'apify', 'run-key-following', 'relationship-following:bbbb', $3)
        `, [KEY_COVERAGE_REQUEST_ID, HASH_A, HASH_B]);
        await db.query(`
            INSERT INTO public.analysis_v2_relationship_manifests(
                request_id, job_key, result_hash, mutual_count, public_count,
                private_count, detailed_public_count
            ) VALUES ($1, 'coordinator:relationships', $2, 2, 2, 0, 2)
        `, [KEY_COVERAGE_REQUEST_ID, HASH_C]);
        await db.query(`
            INSERT INTO public.analysis_v2_relationship_rows(
                request_id, side, ordinal, username
            ) VALUES
                ($1, 'followers', 1, 'candidate.one'),
                ($1, 'followers', 2, 'candidate.two'),
                ($1, 'following', 1, 'candidate.one'),
                ($1, 'following', 2, 'candidate.two')
        `, [KEY_COVERAGE_REQUEST_ID]);
        await db.query(`
            INSERT INTO public.analysis_v2_mutual_rows(
                request_id, job_key, mutual_ordinal, following_ordinal, username,
                is_private, is_verified, detailed_ordinal
            ) VALUES
                ($1, 'coordinator:relationships', 1, 1, 'candidate.one', FALSE, FALSE, 1),
                ($1, 'coordinator:relationships', 2, 2, 'candidate.two', FALSE, FALSE, 2)
        `, [KEY_COVERAGE_REQUEST_ID]);
        await db.query(`
            INSERT INTO public.analysis_v2_candidate_feature_rows(
                request_id, candidate_id, instagram_id, terminal_classification,
                baseline_classification, classification_source, media_context,
                gender_operation_key, gender_result_hash
            ) VALUES
                ($1, 'candidate:one', 'candidate.one', 'verified_female',
                    'verified_female', 'feature', '{"accountContext":"personal"}',
                    'gender-triage:aaaa', $2),
                ($1, 'candidate:extra', 'candidate.extra', 'verified_female',
                    'verified_female', 'feature', '{"accountContext":"personal"}',
                    'gender-triage:bbbb', $3)
        `, [KEY_COVERAGE_REQUEST_ID, HASH_A, HASH_B]);

        const assembled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [KEY_COVERAGE_REQUEST_ID],
        );
        const payload = assembled.rows[0]?.payload as Record<string, unknown>;
        expect(payload.status).toBe('inconsistent');
        expect(payload.gapCodes).toEqual(expect.arrayContaining(['CANDIDATE_KEY_SET_GAP']));
        expect(payload.mutuals).toMatchObject({ declared: 2, collected: 2 });
    });

    it('keeps target interaction totals explicit and records tag/mention source gaps', async () => {
        const likerSource = {
            status: 'collected', input_hash: HASH_A, provider: 'apify',
            provider_run_id: 'likerrun02', provider_operation_key: `target-likers:${HASH_A}`,
            provider_credential_slot: 'primary', coverage: [{
                post_id: 'target-post-interactions', declared_count: 1,
                returned_count: 1, requested_limit: 150,
            }],
        };
        const commentSource = {
            status: 'collected', input_hash: HASH_B, provider: 'apify',
            provider_run_id: 'commentrun02', provider_operation_key: `target-comments:${HASH_B}`,
            provider_credential_slot: 'primary', coverage: [{
                post_id: 'target-post-interactions', declared_count: 1,
                returned_count: 1, requested_limit: 15,
            }],
        };
        await db.query(`
            INSERT INTO public.analysis_v2_target_evidence_manifests(
                request_id, result_hash, interactor_count, liker_count, comment_count,
                liker_source, comment_source
            ) VALUES ($1, $2, 2, 1, 1, $3::jsonb, $4::jsonb)
        `, [UNION_REQUEST_ID, HASH_A, JSON.stringify(likerSource), JSON.stringify(commentSource)]);
        await db.query(`
            INSERT INTO public.analysis_target_interactors(
                request_id, job_key, ordinal, actor_username, post_id, signal,
                source_interaction_id, comment_text
            ) VALUES
                ($1, 'track:target-evidence:collect', 1, 'candidate.one',
                    'target-post-interactions', 'target_post_like', 'interaction-like', NULL),
                ($1, 'track:target-evidence:collect', 2, 'candidate.one',
                    'target-post-interactions', 'target_post_comment', 'interaction-comment', 'hello')
        `, [UNION_REQUEST_ID]);

        const assembled = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [UNION_REQUEST_ID],
        );
        const payload = assembled.rows[0]?.payload as Record<string, unknown>;
        expect(payload.interactions).toMatchObject({
            declared: 2,
            collected: 2,
            targetLikes: { declared: 1, collected: 1 },
            targetComments: { declared: 1, collected: 1 },
            candidateLikes: { declared: null, collected: null, evidenceCollected: null },
        });
        expect(payload.gapCodes).toEqual(expect.arrayContaining([
            'CANDIDATE_LIKES_SOURCE_MISSING',
            'TAGS_SOURCE_MISSING',
            'MENTIONS_SOURCE_MISSING',
        ]));
    });

    it('retains rich evidence behind a purge fence after forced assembly failure, then purges after retry', async () => {
        await db.query(`
            INSERT INTO public.analysis_v2_relationship_sides(
                request_id, side, declared_count, collected_count, provider,
                provider_run_id, provider_operation_key, result_hash
            ) VALUES
                ($1, 'followers', 1, 1, 'apify', 'run-purge-1', 'relationship-followers:aaaa', $2),
                ($1, 'following', 1, 1, 'apify', 'run-purge-2', 'relationship-following:bbbb', $3)
        `, [PURGE_FENCE_REQUEST_ID, HASH_A, HASH_B]);
        await db.query(`
            INSERT INTO public.analysis_v2_relationship_manifests(
                request_id, job_key, result_hash, mutual_count, public_count,
                private_count, detailed_public_count
            ) VALUES ($1, 'coordinator:relationships', $2, 1, 1, 0, 1)
        `, [PURGE_FENCE_REQUEST_ID, HASH_C]);
        await db.query(`
            INSERT INTO public.analysis_v2_mutual_rows(
                request_id, job_key, mutual_ordinal, following_ordinal, username,
                is_private, is_verified, detailed_ordinal
            ) VALUES ($1, 'coordinator:relationships', 1, 1, 'purge.candidate', FALSE, FALSE, 1)
        `, [PURGE_FENCE_REQUEST_ID]);
        await db.query(`
            INSERT INTO public.analysis_v2_candidate_feature_rows(
                request_id, candidate_id, instagram_id, terminal_classification,
                baseline_classification, classification_source, media_context,
                gender_operation_key, gender_result_hash
            ) VALUES ($1, 'candidate:purge', 'purge.candidate', 'verified_female',
                'verified_female', 'feature', '{"accountContext":"personal"}',
                'gender-triage:aaaa', $2)
        `, [PURGE_FENCE_REQUEST_ID, HASH_A]);

        const initialBundle = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [PURGE_FENCE_REQUEST_ID],
        );
        expect((initialBundle.rows[0]?.payload as Record<string, unknown>).version).toBe(1);

        await db.query(
            `UPDATE public.analysis_v2_candidate_feature_rows
                SET candidate_id = 'invalid/id'
              WHERE request_id = $1`,
            [PURGE_FENCE_REQUEST_ID],
        );
        await db.query(
            `UPDATE public.analysis_requests SET status = 'completed' WHERE id = $1`,
            [PURGE_FENCE_REQUEST_ID],
        );
        const retained = await db.query<{ count: string }>(
            'SELECT count(*)::TEXT AS count FROM public.analysis_v2_candidate_feature_rows WHERE request_id = $1',
            [PURGE_FENCE_REQUEST_ID],
        );
        const fenced = await db.query<{ purge_fenced_at: string; purge_fence_reason: string }>(
            `SELECT purge_fenced_at::TEXT, purge_fence_reason
               FROM public.analysis_order_audit_assembly_queue WHERE request_id = $1`,
            [PURGE_FENCE_REQUEST_ID],
        );
        expect(retained.rows[0]?.count).toBe('1');
        expect(fenced.rows[0]?.purge_fenced_at).toBeTruthy();
        expect(fenced.rows[0]?.purge_fence_reason).toBe('ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED');

        await db.query(
            'SELECT public.analysis_v2_purge_result_working_set($1, TRUE)',
            [PURGE_FENCE_REQUEST_ID],
        );
        const blockedPurge = await db.query<{ count: string }>(
            'SELECT count(*)::TEXT AS count FROM public.analysis_v2_candidate_feature_rows WHERE request_id = $1',
            [PURGE_FENCE_REQUEST_ID],
        );
        expect(blockedPurge.rows[0]?.count).toBe('1');

        await db.query(`
            INSERT INTO public.analysis_v2_cost_rollup_snapshots(
                request_id, total_known_cost_usd, total_conservative_cost_usd,
                directly_attributable_cost_complete, usage_unknown, cost_provenance
            ) VALUES ($1, 0.21, 0.21, TRUE, FALSE,
                '{"source":"late-purge-fence-cost"}'::jsonb)
        `, [PURGE_FENCE_REQUEST_ID]);
        const reopenedFence = await db.query<{
            status: string;
            purge_fenced_at: string | null;
        }>(
            `SELECT status, purge_fenced_at::TEXT
               FROM public.analysis_order_audit_assembly_queue WHERE request_id = $1`,
            [PURGE_FENCE_REQUEST_ID],
        );
        expect(reopenedFence.rows[0]?.status).toBe('queued');
        expect(reopenedFence.rows[0]?.purge_fenced_at).toBeTruthy();

        await db.query(
            `UPDATE public.analysis_v2_candidate_feature_rows
                SET candidate_id = 'candidate:purge-retry'
              WHERE request_id = $1`,
            [PURGE_FENCE_REQUEST_ID],
        );
        const retried = await db.query<{ payload: unknown }>(
            'SELECT public.assemble_analysis_order_audit_bundle($1) AS payload',
            [PURGE_FENCE_REQUEST_ID],
        );
        expect((retried.rows[0]?.payload as Record<string, unknown>).version).toBe(2);
        const purged = await db.query<{ count: string }>(
            'SELECT count(*)::TEXT AS count FROM public.analysis_v2_candidate_feature_rows WHERE request_id = $1',
            [PURGE_FENCE_REQUEST_ID],
        );
        const completedFence = await db.query<{ purged_at: string; purge_fenced_at: string | null }>(
            `SELECT purged_at::TEXT, purge_fenced_at::TEXT
               FROM public.analysis_order_audit_assembly_queue WHERE request_id = $1`,
            [PURGE_FENCE_REQUEST_ID],
        );
        expect(purged.rows[0]?.count).toBe('0');
        expect(completedFence.rows[0]?.purged_at).toBeTruthy();
        expect(completedFence.rows[0]?.purge_fenced_at).toBeNull();
    });

    it('keeps the active queued final-score checkpoint while purging other scoring checkpoints', async () => {
        await db.query(`
            INSERT INTO public.analysis_v2_score_audit_intents(
                request_id, source_result_hash, source_generation,
                checkpoint_item_count, intent_status, retain_until
            ) VALUES ($1, $2, 1, 1, 'queued', clock_timestamp() + INTERVAL '1 hour')
        `, [PURGE_FENCE_REQUEST_ID, HASH_A]);
        await db.query(`
            INSERT INTO public.analysis_v2_score_audit_runs(
                request_id, source_result_hash, source_generation, status
            ) VALUES ($1, $2, 1, 'queued')
        `, [PURGE_FENCE_REQUEST_ID, HASH_A]);
        await db.query(`
            INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints(
                request_id, stage_kind, batch_key, result_hash
            ) VALUES
                ($1, 'final_score', -1, $2),
                ($1, 'screening', -1, $3)
        `, [PURGE_FENCE_REQUEST_ID, HASH_A, HASH_B]);

        await db.query(
            'SELECT public.analysis_v2_purge_result_working_set($1, TRUE)',
            [PURGE_FENCE_REQUEST_ID],
        );

        const checkpoints = await db.query<{
            stage_kind: string;
            batch_key: number;
            result_hash: string;
        }>(
            `SELECT stage_kind, batch_key, result_hash
               FROM public.analysis_v2_ai_scoring_stage_checkpoints
              WHERE request_id = $1`,
            [PURGE_FENCE_REQUEST_ID],
        );
        expect(checkpoints.rows).toEqual([{
            stage_kind: 'final_score',
            batch_key: -1,
            result_hash: HASH_A,
        }]);
    });

    it('lists one latest bundle per request with stable assembledAt/requestId keyset pages', async () => {
        const insertBundle = async (
            requestId: string,
            version: number,
            bundleHash: string,
            sourceHash: string,
            assembledAt: string,
        ) => {
            await db.query(`
                INSERT INTO public.analysis_order_audit_bundles(
                    request_id, version, bundle_hash, source_set_hash,
                    pipeline_version, plan_id, access_mode,
                    target_instagram_id, target_profile_available, target_posts_available,
                    mutual_total, mutual_list_hash, public_total, private_total,
                    screened_total, candidate_declared, candidate_collected,
                    interaction_declared, interaction_collected,
                    completeness_status, gap_codes, cost_status,
                    cost_known_usd, cost_conservative_usd, cost_usage_unknown,
                    usage_unknown, stage_status, assembled_at
                ) VALUES (
                    $1, $2, $3, $4, 'v2', 'basic', 'production',
                    'target.account', TRUE, FALSE,
                    0, $5, 0, 0, 0, 0, 0, 0, 0,
                    'partial', ARRAY['COST_USAGE_UNKNOWN']::TEXT[], 'unknown',
                    NULL, NULL, TRUE, TRUE,
                    '{"relationships":true,"targetEvidence":false,"candidateFeatures":false,"riskScores":false,"finalized":true,"costSourceHash":"secret","candidateKeyCoverage":{"secret":true}}'::JSONB,
                    $6::TIMESTAMPTZ
                )
            `, [requestId, version, bundleHash, sourceHash, HASH_A, assembledAt]);
        };

        await insertBundle(
            LIST_REQUEST_A, 1, 'a'.repeat(64), '1'.repeat(64), '2099-09-04T00:05:00Z',
        );
        await insertBundle(
            LIST_REQUEST_A, 2, 'b'.repeat(64), '2'.repeat(64), '2099-09-04T00:01:00Z',
        );
        await insertBundle(
            LIST_REQUEST_B, 1, 'c'.repeat(64), '3'.repeat(64), '2099-09-04T00:04:00Z',
        );
        await insertBundle(
            LIST_REQUEST_C, 1, 'd'.repeat(64), '4'.repeat(64), '2099-09-04T00:04:00Z',
        );
        await insertBundle(
            LIST_REQUEST_D, 1, 'e'.repeat(64), '5'.repeat(64), '2099-09-04T00:03:00Z',
        );

        const loadPage = async (
            cursor: { assembledAt: string; requestId: string } | null,
        ) => {
            const result = await db.query<{ payload: Record<string, unknown> }>(
                `SELECT public.list_analysis_order_audit_bundles($1, $2, 2) AS payload`,
                [cursor?.assembledAt ?? null, cursor?.requestId ?? null],
            );
            return result.rows[0]?.payload as {
                rows: Array<Record<string, unknown>>;
                nextCursor: { assembledAt: string; requestId: string } | null;
            };
        };

        const first = await loadPage(null);
        expect(first.rows.map(row => row.requestId)).toEqual([LIST_REQUEST_C, LIST_REQUEST_B]);
        expect(first.rows.map(row => row.version)).toEqual([1, 1]);
        expect(first.nextCursor).toMatchObject({ requestId: LIST_REQUEST_B });
        expect(first.rows[0]).toEqual(expect.objectContaining({
            orderId: null,
            targetInstagramId: 'target.account',
            planId: 'basic',
            completenessStatus: 'partial',
            gapCodes: ['COST_USAGE_UNKNOWN'],
            cost: {
                status: 'unknown',
                knownUsd: null,
                conservativeUsd: null,
                usageUnknown: true,
            },
            stageStatus: {
                relationships: true,
                targetEvidence: false,
                candidateFeatures: false,
                riskScores: false,
                finalized: true,
            },
        }));
        expect(first.rows[0]).not.toHaveProperty('providerRuns');
        expect(first.rows[0]).not.toHaveProperty('costProvenance');
        expect(first.rows[0]).not.toHaveProperty('candidateKeyCoverage');

        const second = await loadPage(first.nextCursor);
        expect(second.rows.map(row => row.requestId)).toEqual([LIST_REQUEST_D, LIST_REQUEST_A]);
        expect(second.rows.find(row => row.requestId === LIST_REQUEST_A)?.version).toBe(2);
        expect(second.nextCursor).toBeTruthy();

        const seen = [...first.rows, ...second.rows].map(row => row.requestId);
        expect(new Set(seen)).toEqual(new Set([
            LIST_REQUEST_A, LIST_REQUEST_B, LIST_REQUEST_C, LIST_REQUEST_D,
        ]));
        expect(seen).toHaveLength(4);

        const allRows = [...first.rows, ...second.rows];
        let cursor = second.nextCursor;
        while (cursor && allRows.length < 100) {
            const page = await loadPage(cursor);
            allRows.push(...page.rows);
            cursor = page.nextCursor;
        }
        expect(cursor).toBeNull();
        const allIds = allRows.map(row => row.requestId);
        expect(new Set(allIds).size).toBe(allIds.length);
        const distinctRequestCount = await db.query<{ count: string }>(
            'SELECT count(DISTINCT request_id)::TEXT AS count FROM public.analysis_order_audit_bundles',
        );
        expect(allIds).toHaveLength(Number(distinctRequestCount.rows[0]?.count));

        await expect(db.query(
            `SELECT public.list_analysis_order_audit_bundles(NULL, $1, 2)`,
            [LIST_REQUEST_B],
        )).rejects.toThrow('ANALYSIS_ORDER_AUDIT_INVALID_QUERY');
        await expect(db.query(
            `SELECT public.list_analysis_order_audit_bundles(NULL, NULL, 51)`,
        )).rejects.toThrow('ANALYSIS_ORDER_AUDIT_INVALID_QUERY');

        const privileges = await db.query<{
            anon_execute: boolean;
            authenticated_execute: boolean;
            service_execute: boolean;
            service_select: boolean;
        }>(`
            SELECT
                has_function_privilege(
                    'anon',
                    'public.list_analysis_order_audit_bundles(timestamptz,uuid,integer)',
                    'EXECUTE'
                ) AS anon_execute,
                has_function_privilege(
                    'authenticated',
                    'public.list_analysis_order_audit_bundles(timestamptz,uuid,integer)',
                    'EXECUTE'
                ) AS authenticated_execute,
                has_function_privilege(
                    'service_role',
                    'public.list_analysis_order_audit_bundles(timestamptz,uuid,integer)',
                    'EXECUTE'
                ) AS service_execute,
                has_table_privilege(
                    'service_role', 'public.analysis_order_audit_bundles', 'SELECT'
                ) AS service_select
        `);
        expect(privileges.rows[0]).toEqual({
            anon_execute: false,
            authenticated_execute: false,
            service_execute: true,
            service_select: false,
        });
    });
});
