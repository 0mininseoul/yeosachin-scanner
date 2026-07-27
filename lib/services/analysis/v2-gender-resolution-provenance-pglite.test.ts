import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    createSupabaseAnalysisV2ResultStore,
    type AnalysisV2ResultSupabaseClient,
} from './v2-result-store';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260725013000_persist_analysis_v2_gender_resolution_provenance.sql',
        import.meta.url
    ),
    'utf8'
);
const qualityGateV2Migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260727171000_update_gender_resolution_unknown_gate_20_percent.sql',
        import.meta.url
    ),
    'utf8'
);
const resultRuntimeBoundaryMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713213000_harden_analysis_v2_result_runtime_boundary.sql',
        import.meta.url
    ),
    'utf8'
);

function extractFunction(source: string, functionName: string): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${functionName}(`;
    const start = source.indexOf(marker);
    const end = source.indexOf('\n$$;', start);
    if (start < 0 || end < 0) {
        throw new Error(`function not found: ${functionName}`);
    }
    return source.slice(start, end + '\n$$;'.length);
}

const purgeResultWorkingSet = extractFunction(
    resultRuntimeBoundaryMigration,
    'analysis_v2_purge_result_working_set'
);

const REQUEST_V26 = '123e4567-e89b-42d3-a456-426614174000';
const REQUEST_V27 = '123e4567-e89b-42d3-a456-426614174001';
const REQUEST_RECOVERY = '123e4567-e89b-42d3-a456-426614174002';
const REQUEST_PURGED_PASS = '123e4567-e89b-42d3-a456-426614174003';
const REQUEST_PURGED_STALE = '123e4567-e89b-42d3-a456-426614174004';
const REQUEST_PURGED_TAMPER = '123e4567-e89b-42d3-a456-426614174005';
const REQUEST_UNKNOWN_20 = '123e4567-e89b-42d3-a456-426614174006';
const REQUEST_UNKNOWN_25 = '123e4567-e89b-42d3-a456-426614174007';
const RESOLVER_OPERATION = `gender-resolution:${'a'.repeat(64)}`;
const RESOLVER_HASH = 'b'.repeat(64);

let db: PGlite;

async function withRole<T>(role: 'authenticated' | 'service_role', query: () => Promise<T>) {
    await db.exec(`SET ROLE ${role}`);
    try {
        return await query();
    } finally {
        await db.exec('RESET ROLE');
    }
}

function row(overrides: Record<string, unknown> = {}) {
    return {
        candidateId: 'candidate:1',
        instagramId: 'opaque.account',
        fullName: null,
        profileImageUrl: null,
        bio: null,
        classification: 'unresolved',
        mediaContext: { bundleId: `bundle:${'c'.repeat(64)}` },
        genderOperationKey: `gender-triage:${'d'.repeat(64)}`,
        genderResultHash: 'e'.repeat(64),
        featureOperationKey: `feature-analysis:${'f'.repeat(64)}`,
        featureResultHash: '1'.repeat(64),
        feature: null,
        ...overrides,
    };
}

async function checkpoint(requestId: string, rows: unknown[]) {
    return db.query(
        `SELECT public.analysis_v2_checkpoint_candidate_features_complete(
            $1, 'track:profile-ai:batch:0', $2, $3, 0, $4, $5::JSONB
        )`,
        [
            requestId,
            '223e4567-e89b-42d3-a456-426614174000',
            '2'.repeat(64),
            rows.length,
            JSON.stringify(rows),
        ]
    );
}

async function finalizeAndPurgeWithResolverAttempt(requestId: string) {
    const appliedOperation = `gender-resolution:${requestId.replaceAll('-', '').padEnd(64, '0')}`;
    const appliedHash = requestId.replaceAll('-', '').padEnd(64, '1');
    await db.query(
        `INSERT INTO public.analysis_v2_ai_result_checkpoints(
            request_id, job_key, operation_key, stage, cache_scope, result_hash
        ) VALUES ($1, 'track:profile-ai:batch:0', $2, 'genderResolution', 'request', $3)`,
        [requestId, appliedOperation, appliedHash]
    );
    await checkpoint(requestId, [
        row({
            candidateId: 'candidate:resolved',
            classification: 'verified_female',
            baselineClassification: 'unresolved',
            classificationSource: 'gender_resolution',
            genderResolutionStatus: 'ready_applied',
            genderResolutionOperationKey: appliedOperation,
            genderResolutionResultHash: appliedHash,
        }),
        ...[1, 2, 3].map(index => row({
            candidateId: `candidate:baseline:${index}`,
            classification: 'verified_non_female',
            baselineClassification: 'verified_non_female',
            classificationSource: 'feature',
            genderResolutionStatus: 'not_eligible',
            genderResolutionOperationKey: null,
            genderResolutionResultHash: null,
        })),
    ]);
    await db.query(
        `INSERT INTO public.analysis_v2_ai_attempts(
            request_id, stage, status, usage_metadata_status, prompt_tokens,
            completion_tokens, total_tokens, thinking_tokens,
            estimated_cost_usd
        ) VALUES (
            $1, 'genderResolution', 'success', 'complete',
            80, 15, 100, 5, 0.00008
        )`,
        [requestId]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints(
            request_id, stage_kind, payload
        ) VALUES ($1, 'profile_ai_batch', $2::JSONB)`,
        [
            requestId,
            JSON.stringify({
                outcomes: [{
                    status: 'verified_female',
                    baselineClassification: 'unresolved',
                    genderResolutionStatus: 'ready_applied',
                    mediaCoverage: {
                        selectedCount: 1,
                        normalizedCount: 1,
                        failures: [],
                    },
                }, ...Array.from({ length: 3 }, () => ({
                    status: 'verified_non_female',
                    baselineClassification: 'verified_non_female',
                    genderResolutionStatus: 'not_eligible',
                    mediaCoverage: {
                        selectedCount: 1,
                        normalizedCount: 1,
                        failures: [],
                    },
                }))],
            }),
        ]
    );

    // This is the production finalizer's durable ordering: summary insert (which seals
    // resolver metrics), request completion, then the real terminal working-set purge.
    await db.query(
        `INSERT INTO public.analysis_v2_result_summaries(request_id, plan_id)
         VALUES ($1, 'standard')`,
        [requestId]
    );
    await db.query(
        `UPDATE public.analysis_requests SET status = 'completed' WHERE id = $1`,
        [requestId]
    );
    await db.query(
        `SELECT public.analysis_v2_purge_result_working_set($1, TRUE)`,
        [requestId]
    );
}

async function loadQuality(requestId: string): Promise<Record<string, unknown>> {
    return withRole('service_role', async () => (
        await db.query<{ quality: Record<string, unknown> }>(
            `SELECT public.load_analysis_v2_gender_resolution_quality($1) AS quality`,
            [requestId]
        )
    ).rows[0].quality);
}

describe('gender resolver provenance migration', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE SCHEMA supabase_migrations;
            CREATE TABLE supabase_migrations.schema_migrations(version TEXT PRIMARY KEY);
            INSERT INTO supabase_migrations.schema_migrations(version)
            VALUES ('20260724230000');

            CREATE TABLE public.analysis_requests(
                id UUID PRIMARY KEY,
                pipeline_version TEXT,
                status TEXT,
                selected_plan_id_snapshot TEXT
            );
            INSERT INTO public.analysis_requests(
                id, pipeline_version, status, selected_plan_id_snapshot
            ) VALUES
                ('${REQUEST_V26}', 'v2', 'completed', 'basic'),
                ('${REQUEST_V27}', 'v2', 'processing', 'standard'),
                ('${REQUEST_RECOVERY}', 'v2', 'processing', 'standard'),
                ('${REQUEST_PURGED_PASS}', 'v2', 'processing', 'standard'),
                ('${REQUEST_PURGED_STALE}', 'v2', 'processing', 'standard'),
                ('${REQUEST_PURGED_TAMPER}', 'v2', 'processing', 'standard'),
                ('${REQUEST_UNKNOWN_20}', 'v2', 'processing', 'standard'),
                ('${REQUEST_UNKNOWN_25}', 'v2', 'processing', 'standard');

            CREATE TABLE public.analysis_v2_candidate_feature_manifests (
                request_id UUID NOT NULL,
                batch INTEGER NOT NULL,
                producer_job_key TEXT NOT NULL,
                PRIMARY KEY(request_id, batch)
            );
            CREATE TABLE public.analysis_v2_candidate_feature_rows (
                request_id UUID NOT NULL,
                batch INTEGER NOT NULL,
                candidate_id TEXT NOT NULL,
                terminal_classification TEXT NOT NULL,
                feature_operation_key TEXT,
                PRIMARY KEY(request_id, candidate_id),
                FOREIGN KEY(request_id, batch)
                    REFERENCES public.analysis_v2_candidate_feature_manifests(
                        request_id, batch
                    )
                    ON DELETE CASCADE
            );
            CREATE TABLE public.analysis_v2_narrative_manifests (request_id UUID);
            CREATE TABLE public.analysis_v2_candidate_score_manifests (request_id UUID);
            CREATE TABLE public.analysis_v2_partner_safety_manifests (request_id UUID);
            CREATE TABLE public.analysis_v2_reverse_like_manifests (request_id UUID);
            CREATE TABLE public.analysis_v2_preliminary_score_manifests (request_id UUID);
            CREATE TABLE public.analysis_v2_private_name_manifests (request_id UUID);
            CREATE TABLE public.analysis_v2_profile_fetch_batches (request_id UUID);
            CREATE TABLE public.analysis_v2_target_evidence_manifests (request_id UUID);
            CREATE TABLE public.analysis_v2_relationship_manifests (request_id UUID);
            CREATE TABLE public.analysis_v2_relationship_sides (request_id UUID);
            CREATE TABLE public.analysis_v2_ai_result_checkpoints (
                request_id UUID NOT NULL,
                job_key TEXT NOT NULL,
                operation_key TEXT NOT NULL,
                stage TEXT NOT NULL,
                cache_scope TEXT NOT NULL,
                result_hash TEXT NOT NULL
            );
            CREATE TABLE public.analysis_v2_ai_attempts (
                request_id UUID NOT NULL,
                stage TEXT NOT NULL,
                status TEXT NOT NULL,
                usage_metadata_status TEXT,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                total_tokens INTEGER,
                thinking_tokens INTEGER,
                estimated_cost_usd NUMERIC
            );
            CREATE TABLE public.analysis_v2_ai_scoring_stage_checkpoints (
                request_id UUID NOT NULL,
                stage_kind TEXT NOT NULL,
                payload JSONB NOT NULL
            );
            CREATE TABLE public.analysis_v2_result_summaries (
                request_id UUID,
                target_instagram_id TEXT,
                target_profile_image_url TEXT,
                plan_id TEXT,
                followers_declared INTEGER,
                followers_collected INTEGER,
                following_declared INTEGER,
                following_collected INTEGER,
                detected_mutuals INTEGER,
                public_mutuals INTEGER,
                private_mutuals INTEGER,
                screened_mutuals INTEGER,
                male_count INTEGER,
                female_count INTEGER,
                unknown_count INTEGER,
                fetch_unavailable_count INTEGER,
                media_unavailable_count INTEGER,
                analysis_unavailable_count INTEGER,
                not_screened_mutuals INTEGER,
                exclusion_applied BOOLEAN,
                score_policy_version TEXT
            );
            CREATE FUNCTION public.analysis_v2_checkpoint_candidate_features_complete(
                p_request_id UUID,
                p_job_key TEXT,
                p_claim_token UUID,
                p_job_input_hash TEXT,
                p_batch INTEGER,
                p_analyzed_count INTEGER,
                p_rows JSONB
            )
            RETURNS JSONB
            LANGUAGE plpgsql
            SET search_path = ''
            AS $$
            BEGIN
                INSERT INTO public.analysis_v2_candidate_feature_manifests(
                    request_id, batch, producer_job_key
                ) VALUES (p_request_id, p_batch, p_job_key);
                INSERT INTO public.analysis_v2_candidate_feature_rows(
                    request_id, batch, candidate_id, terminal_classification,
                    feature_operation_key
                )
                SELECT
                    p_request_id,
                    p_batch,
                    item.value->>'candidateId',
                    item.value->>'classification',
                    NULLIF(item.value->>'featureOperationKey', '')
                FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);
                RETURN pg_catalog.jsonb_build_object('rowCount', p_analyzed_count);
            END;
            $$;
            CREATE FUNCTION public.load_analysis_v2_ai_stage_policy_version(UUID)
            RETURNS TEXT LANGUAGE sql STABLE SET search_path = ''
            AS $$ SELECT 'ai-stage-policy-v2.7'::TEXT $$;
        `);
        await db.exec(migration);
        await db.exec(qualityGateV2Migration);
        await db.exec(purgeResultWorkingSet);
    });

    afterAll(async () => {
        await db.close();
    });

    it('normalizes legacy rows to baseline equals classification with resolver disabled', async () => {
        await checkpoint(REQUEST_V26, [row()]);
        const stored = (await db.query<{
            terminal_classification: string;
            baseline_classification: string;
            classification_source: string;
            gender_resolution_status: string;
        }>(
            `SELECT terminal_classification, baseline_classification,
                    classification_source, gender_resolution_status
             FROM public.analysis_v2_candidate_feature_rows
             WHERE request_id = $1`,
            [REQUEST_V26]
        )).rows[0];

        expect(stored).toEqual({
            terminal_classification: 'unresolved',
            baseline_classification: 'unresolved',
            classification_source: 'unknown',
            gender_resolution_status: 'disabled',
        });
    });

    it('persists only a same-job resolver result fence for changed classification', async () => {
        await db.query(
            `INSERT INTO public.analysis_v2_ai_result_checkpoints(
                request_id, job_key, operation_key, stage, cache_scope, result_hash
            ) VALUES ($1, 'track:profile-ai:batch:0', $2, 'genderResolution', 'request', $3)`,
            [REQUEST_V27, RESOLVER_OPERATION, RESOLVER_HASH]
        );
        await checkpoint(REQUEST_V27, [row({
            classification: 'verified_female',
            feature: {
                appearanceGrade: 3,
                exposureScore: 2,
                isBusinessAccount: false,
                featurePartnerEvidenceStrong: false,
                oneLineOverview: 'opaque',
            },
            baselineClassification: 'unresolved',
            classificationSource: 'gender_resolution',
            genderResolutionStatus: 'ready_applied',
            genderResolutionOperationKey: RESOLVER_OPERATION,
            genderResolutionResultHash: RESOLVER_HASH,
        })]);

        await expect(db.query(
            `UPDATE public.analysis_v2_candidate_feature_rows
             SET gender_resolution_result_hash = $1
             WHERE request_id = $2`,
            ['9'.repeat(64), REQUEST_V27]
        )).rejects.toThrow(/ANALYSIS_V2_GENDER_RESOLUTION_RESULT_FENCE_MISMATCH/);
    });

    it('keeps rolling DB summary fields while the owner projection strips failure aggregates', async () => {
        const result = (await db.query<{ summary: Record<string, unknown> }>(
            `SELECT public.analysis_v2_result_summary_json(summary) AS summary
             FROM (
                SELECT (
                    NULL, 'target', NULL, 'standard',
                    10, 10, 10, 10, 5, 4, 1, 4,
                    1, 2, 1, 0, 0, 0, 0, FALSE, 'risk-policy-v2.3'
                )::public.analysis_v2_result_summaries AS summary
             ) AS source`
        )).rows[0].summary;

        expect(result.genderStats).toEqual({ male: 1, female: 2, unknown: 1 });
        expect(result).toMatchObject({
            successfullyScreenedMutuals: 4,
            fetchUnavailableMutuals: 0,
            mediaUnavailableMutuals: 0,
            analysisUnavailableMutuals: 0,
        });

        const store = createSupabaseAnalysisV2ResultStore({
            rpc: vi.fn(async () => ({
                data: {
                    finalized: true,
                    requestStatus: 'completed',
                    summary: result,
                },
                error: null,
            })),
        } as AnalysisV2ResultSupabaseClient);
        const finalized = await store.finalize({
            requestId: REQUEST_V27,
            jobKey: 'coordinator:finalize',
            claimToken: '223e4567-e89b-42d3-a456-426614174000',
            jobInputHash: '2'.repeat(64),
            targetProfileImageUrl: null,
        });
        expect(finalized.summary).not.toHaveProperty('fetchUnavailableMutuals');
        expect(finalized.summary).not.toHaveProperty('mediaUnavailableMutuals');
        expect(finalized.summary).not.toHaveProperty('analysisUnavailableMutuals');
        expect(finalized.summary).not.toHaveProperty('successfullyScreenedMutuals');
    });

    it('refreshes request-level resolver and partial-media metrics idempotently', async () => {
        await db.query(
            `INSERT INTO public.analysis_v2_ai_attempts(
                request_id, stage, status, usage_metadata_status, prompt_tokens,
                completion_tokens, total_tokens, thinking_tokens,
                estimated_cost_usd
            ) VALUES
                ($1, 'genderResolution', 'success', 'complete',
                    100, 20, 125, 5, 0.0001),
                ($1, 'genderResolution', 'cutoff', 'missing',
                    NULL, NULL, NULL, NULL, NULL)`,
            [REQUEST_V27]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_candidate_feature_rows(
                request_id, batch, candidate_id, terminal_classification,
                feature_operation_key, baseline_classification,
                classification_source, gender_resolution_status,
                gender_resolution_operation_key, gender_resolution_result_hash
            ) VALUES (
                $1, 0, 'candidate:2', 'unresolved', NULL, 'unresolved',
                'unknown', 'cutoff', NULL, NULL
            )`,
            [REQUEST_V27]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints(
                request_id, stage_kind, payload
            ) VALUES ($1, 'profile_ai_batch', $2::JSONB)`,
            [
                REQUEST_V27,
                JSON.stringify({
                    outcomes: [{
                        status: 'verified_female',
                        baselineClassification: 'unresolved',
                        genderResolutionStatus: 'ready_applied',
                        mediaCoverage: {
                            selectedCount: 5,
                            normalizedCount: 4,
                            failures: [{ selectionId: 'opaque', reason: 'fetch', disposition: 'permanent' }],
                        },
                    }, {
                        status: 'unresolved',
                        baselineClassification: 'unresolved',
                        genderResolutionStatus: 'cutoff',
                        mediaCoverage: {
                            selectedCount: 2,
                            normalizedCount: 2,
                            failures: [],
                        },
                    }],
                }),
            ]
        );

        const metrics = (await db.query<{
            screened_count: number;
            baseline_unknown_count: number;
            final_unknown_count: number;
            applied_count: number;
            applied_with_fenced_result_count: number;
            verified_baseline_mutation_count: number;
            cutoff_count: number;
            partial_media_accepted_candidate_count: number;
            selected_media_total: number;
            normalized_media_total: number;
            failed_media_total: number;
            resolver_attempt_count: number;
            resolver_usage_complete_count: number;
            resolver_usage_missing_count: number;
            resolver_estimated_cost_usd: number;
            resolver_cost_known_count: number;
        }>(
            `SELECT screened_count, baseline_unknown_count, final_unknown_count,
                    applied_count, applied_with_fenced_result_count,
                    verified_baseline_mutation_count, cutoff_count,
                    partial_media_accepted_candidate_count,
                    selected_media_total, normalized_media_total, failed_media_total,
                    resolver_attempt_count, resolver_usage_complete_count,
                    resolver_usage_missing_count,
                    resolver_estimated_cost_usd::DOUBLE PRECISION,
                    resolver_cost_known_count
             FROM public.analysis_v2_gender_resolution_metrics
             WHERE request_id = $1`,
            [REQUEST_V27]
        )).rows[0];
        expect(metrics).toEqual({
            screened_count: 2,
            baseline_unknown_count: 2,
            final_unknown_count: 1,
            applied_count: 1,
            applied_with_fenced_result_count: 1,
            verified_baseline_mutation_count: 0,
            cutoff_count: 1,
            partial_media_accepted_candidate_count: 1,
            selected_media_total: 7,
            normalized_media_total: 6,
            failed_media_total: 1,
            resolver_attempt_count: 2,
            resolver_usage_complete_count: 1,
            resolver_usage_missing_count: 1,
            resolver_estimated_cost_usd: 0.0001,
            resolver_cost_known_count: 1,
        });

        const staging = await withRole('service_role', async () => (
            await db.query<{ quality: Record<string, unknown> }>(
                `SELECT public.load_analysis_v2_gender_resolution_quality($1)
                    AS quality`,
                [REQUEST_V27]
            )
        ).rows[0].quality);
        expect(staging).toMatchObject({
            requestCompleted: false,
            standardPlan: true,
            resultArchivePresent: false,
            requestGatePassed: false,
            allResolverAttemptsTerminal: false,
            metricsFinalized: false,
            metricsFresh: false,
            unknownGatePassed: false,
            qualityGatePassed: false,
        });
        await db.query(
            `UPDATE public.analysis_requests
             SET status = 'completed'
             WHERE id = $1`,
            [REQUEST_V27]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries(request_id, plan_id)
             VALUES ($1, 'standard')`,
            [REQUEST_V27]
        );

        for (const table of [
            'analysis_v2_candidate_feature_rows',
            'analysis_v2_candidate_feature_manifests',
            'analysis_v2_ai_scoring_stage_checkpoints',
            'analysis_v2_ai_result_checkpoints',
        ]) {
            await db.query(
                `DELETE FROM public.${table} WHERE request_id = $1`,
                [REQUEST_V27]
            );
        }

        const durable = await withRole('service_role', async () => (
            await db.query<{ quality: Record<string, unknown> }>(
                `SELECT public.load_analysis_v2_gender_resolution_quality($1)
                    AS quality`,
                [REQUEST_V27]
            )
        ).rows[0].quality);
        expect(durable).toMatchObject({
            screenedCount: 2,
            baselineUnknownCount: 2,
            finalUnknownCount: 1,
            finalUnknownRatio: 0.5,
            appliedCount: 1,
            appliedWithFencedResultCount: 1,
            verifiedBaselineMutationCount: 0,
            resolverAttemptCount: 2,
            resolverUsageCompleteCount: 1,
            resolverUsageMissingCount: 1,
            resolverEstimatedCostUsd: 0.0001,
            resolverCostKnownCount: 1,
            resolverConcurrencyLimit: 2,
            sharedConcurrencyLimit: 8,
            requestCompleted: true,
            standardPlan: true,
            resultArchivePresent: true,
            requestGatePassed: true,
            resolverNonterminalAttemptCount: 0,
            allResolverAttemptsTerminal: true,
            metricsFinalized: true,
            metricsFresh: true,
            unknownGateEvaluable: true,
            unknownGatePassed: false,
            provenanceGatePassed: true,
            immutabilityGatePassed: true,
            qualityGatePassed: false,
        });
        expect(durable).not.toHaveProperty('requestId');
        expect(durable).not.toHaveProperty('resolverTokenUsage');

        await expect(withRole('service_role', () => db.query(
            `SELECT * FROM public.analysis_v2_gender_resolution_metrics`
        ))).rejects.toThrow(/permission denied/);
        await expect(withRole('authenticated', () => db.query(
            `SELECT public.load_analysis_v2_gender_resolution_quality($1)`,
            [REQUEST_V27]
        ))).rejects.toThrow(/permission denied/);
    });

    it('passes the quality gate after finalizer sealing and the production working-set purge', async () => {
        await finalizeAndPurgeWithResolverAttempt(REQUEST_PURGED_PASS);

        const retained = (await db.query<{
            feature_rows: number;
            feature_manifests: number;
            scoring_checkpoints: number;
            resolver_attempts: number;
        }>(
            `SELECT
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_v2_candidate_feature_rows
                 WHERE request_id = $1) AS feature_rows,
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_v2_candidate_feature_manifests
                 WHERE request_id = $1) AS feature_manifests,
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_v2_ai_scoring_stage_checkpoints
                 WHERE request_id = $1) AS scoring_checkpoints,
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_v2_ai_attempts
                 WHERE request_id = $1 AND stage = 'genderResolution')
                    AS resolver_attempts`,
            [REQUEST_PURGED_PASS]
        )).rows[0];
        expect(retained).toEqual({
            feature_rows: 0,
            feature_manifests: 0,
            scoring_checkpoints: 0,
            resolver_attempts: 1,
        });

        await expect(loadQuality(REQUEST_PURGED_PASS)).resolves.toMatchObject({
            screenedCount: 4,
            finalUnknownCount: 0,
            resolverAttemptCount: 1,
            resolverNonterminalAttemptCount: 0,
            allResolverAttemptsTerminal: true,
            metricsFinalized: true,
            metricsFresh: true,
            unknownGatePassed: true,
            qualityGatePassed: true,
        });
    });

    it('derives the 20 percent boundary from retained historical metrics at query time', async () => {
        await finalizeAndPurgeWithResolverAttempt(REQUEST_UNKNOWN_20);
        await db.query(
            `UPDATE public.analysis_v2_gender_resolution_metrics
             SET screened_count = 5,
                 baseline_unknown_count = 1,
                 final_unknown_count = 1
             WHERE request_id = $1`,
            [REQUEST_UNKNOWN_20]
        );
        await expect(loadQuality(REQUEST_UNKNOWN_20)).resolves.toMatchObject({
            screenedCount: 5,
            finalUnknownCount: 1,
            finalUnknownRatio: 0.2,
            unknownGatePassed: true,
            qualityGatePassed: true,
        });

        await finalizeAndPurgeWithResolverAttempt(REQUEST_UNKNOWN_25);
        await db.query(
            `UPDATE public.analysis_v2_gender_resolution_metrics
             SET baseline_unknown_count = 1,
                 final_unknown_count = 1
             WHERE request_id = $1`,
            [REQUEST_UNKNOWN_25]
        );
        await expect(loadQuality(REQUEST_UNKNOWN_25)).resolves.toMatchObject({
            screenedCount: 4,
            finalUnknownCount: 1,
            finalUnknownRatio: 0.25,
            unknownGatePassed: false,
            qualityGatePassed: false,
        });
    });

    it('fails closed when purgeable staging reappears after metrics were finalized', async () => {
        await finalizeAndPurgeWithResolverAttempt(REQUEST_PURGED_STALE);
        await db.query(
            `INSERT INTO public.analysis_v2_candidate_feature_manifests(
                request_id, batch, producer_job_key
             ) VALUES ($1, 99, 'track:profile-ai:batch:99')`,
            [REQUEST_PURGED_STALE]
        );

        await expect(loadQuality(REQUEST_PURGED_STALE)).resolves.toMatchObject({
            allResolverAttemptsTerminal: true,
            metricsFinalized: true,
            metricsFresh: false,
            qualityGatePassed: false,
        });
    });

    it('fails closed when the retained resolver attempt ledger is tampered nonterminal', async () => {
        await finalizeAndPurgeWithResolverAttempt(REQUEST_PURGED_TAMPER);
        await db.query(
            `UPDATE public.analysis_v2_ai_attempts
             SET status = 'reserved'
             WHERE request_id = $1 AND stage = 'genderResolution'`,
            [REQUEST_PURGED_TAMPER]
        );

        await expect(loadQuality(REQUEST_PURGED_TAMPER)).resolves.toMatchObject({
            resolverAttemptCount: 1,
            allResolverAttemptsTerminal: false,
            metricsFinalized: true,
            metricsFresh: false,
            qualityGatePassed: false,
        });
    });

    it('blocks finalization until recovery terminalizes the exact resolver attempt', async () => {
        await checkpoint(REQUEST_RECOVERY, [row({
            genderResolutionStatus: 'cutoff',
            baselineClassification: 'unresolved',
            classificationSource: 'unknown',
            genderResolutionOperationKey: null,
            genderResolutionResultHash: null,
        })]);
        await db.query(
            `INSERT INTO public.analysis_v2_ai_attempts(
                request_id, stage, status, usage_metadata_status, prompt_tokens,
                completion_tokens, total_tokens, thinking_tokens,
                estimated_cost_usd
            ) VALUES (
                $1, 'genderResolution', 'reserved', NULL,
                NULL, NULL, NULL, NULL, NULL
            )`,
            [REQUEST_RECOVERY]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints(
                request_id, stage_kind, payload
            ) VALUES ($1, 'profile_ai_batch', $2::JSONB)`,
            [
                REQUEST_RECOVERY,
                JSON.stringify({
                    outcomes: [{
                        status: 'unresolved',
                        baselineClassification: 'unresolved',
                        genderResolutionStatus: 'cutoff',
                        mediaCoverage: {
                            selectedCount: 1,
                            normalizedCount: 1,
                            failures: [],
                        },
                    }],
                }),
            ]
        );

        await expect(db.query(
            `INSERT INTO public.analysis_v2_result_summaries(request_id, plan_id)
             VALUES ($1, 'standard')`,
            [REQUEST_RECOVERY]
        )).rejects.toThrow(/ANALYSIS_V2_RESULT_NOT_READY/);
        const pendingQuality = await withRole('service_role', async () => (
            await db.query<{ quality: Record<string, unknown> }>(
                `SELECT public.load_analysis_v2_gender_resolution_quality($1)
                    AS quality`,
                [REQUEST_RECOVERY]
            )
        ).rows[0].quality);
        expect(pendingQuality).toMatchObject({
            resolverNonterminalAttemptCount: 1,
            allResolverAttemptsTerminal: false,
            metricsFinalized: false,
            metricsFresh: false,
            qualityGatePassed: false,
        });

        await db.query(
            `UPDATE public.analysis_v2_ai_attempts
             SET status = 'cutoff', usage_metadata_status = 'missing'
             WHERE request_id = $1 AND stage = 'genderResolution'`,
            [REQUEST_RECOVERY]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries(request_id, plan_id)
             VALUES ($1, 'standard')`,
            [REQUEST_RECOVERY]
        );

        const sealed = (await db.query<{
            cutoff_count: number;
            terminal_unavailable_count: number;
            resolver_nonterminal_attempt_count: number;
            metrics_finalized: boolean;
        }>(
            `SELECT cutoff_count, terminal_unavailable_count,
                    resolver_nonterminal_attempt_count,
                    metrics_finalized_at IS NOT NULL AS metrics_finalized
             FROM public.analysis_v2_gender_resolution_metrics
             WHERE request_id = $1`,
            [REQUEST_RECOVERY]
        )).rows[0];
        expect(sealed).toEqual({
            cutoff_count: 1,
            terminal_unavailable_count: 0,
            resolver_nonterminal_attempt_count: 0,
            metrics_finalized: true,
        });

        await db.query(
            `UPDATE public.analysis_requests
             SET status = 'completed'
             WHERE id = $1`,
            [REQUEST_RECOVERY]
        );
        const recoveredQuality = await withRole('service_role', async () => (
            await db.query<{ quality: Record<string, unknown> }>(
                `SELECT public.load_analysis_v2_gender_resolution_quality($1)
                    AS quality`,
                [REQUEST_RECOVERY]
            )
        ).rows[0].quality);
        expect(recoveredQuality).toMatchObject({
            cutoffCount: 1,
            terminalUnavailableCount: 0,
            resolverNonterminalAttemptCount: 0,
            allResolverAttemptsTerminal: true,
            metricsFinalized: true,
            metricsFresh: true,
        });
        for (const forbidden of [
            'requestId',
            'operationKey',
            'reservationToken',
            'providerMessage',
        ]) {
            expect(recoveredQuality).not.toHaveProperty(forbidden);
        }
    });
});
