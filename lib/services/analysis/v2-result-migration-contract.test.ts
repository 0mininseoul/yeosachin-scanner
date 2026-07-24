import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713185711_add_analysis_v2_result_finalization.sql',
        import.meta.url
    ),
    'utf8'
);
const relativeRiskMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123400_add_relative_risk_policy_v23.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string, last = false): string {
    const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const start = last ? migration.lastIndexOf(marker) : migration.indexOf(marker);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function tableDefinition(name: string): string {
    const start = migration.indexOf(`CREATE TABLE public.${name} (`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n);', start);
    expect(end, `${name} must have a bounded definition`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    for (const fragment of fragments) {
        const index = source.indexOf(fragment, previous + 1);
        expect(index, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = index;
    }
}

const resultTables = [
    'analysis_v2_candidate_feature_manifests',
    'analysis_v2_candidate_feature_rows',
    'analysis_v2_preliminary_score_manifests',
    'analysis_v2_preliminary_score_rows',
    'analysis_v2_reverse_like_manifests',
    'analysis_v2_reverse_like_rows',
    'analysis_v2_partner_safety_manifests',
    'analysis_v2_partner_safety_rows',
    'analysis_v2_candidate_score_manifests',
    'analysis_v2_candidate_score_rows',
    'analysis_v2_private_name_manifests',
    'analysis_v2_private_name_rows',
    'analysis_v2_narrative_manifests',
    'analysis_v2_narrative_rows',
    'analysis_v2_result_summaries',
    'analysis_v2_female_results',
    'analysis_v2_private_results',
    'analysis_v2_failure_receipts',
] as const;

describe('analysis V2 result migration contract', () => {
    it('upgrades final-score replay to deterministic relative policy v2.3', () => {
        expect(relativeRiskMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.analysis_v2_expected_relative_risk_rows('
        );
        expect(relativeRiskMigration).toContain('eligible.eligible_count < 3');
        expect(relativeRiskMigration).toContain('eligible.eligible_count - 2');
        expect(relativeRiskMigration).toContain('natural_row.natural_risk_band <> \'normal\'');
        expect(relativeRiskMigration).toContain('WHERE NOT natural_row.strong_partner');
        expect(relativeRiskMigration).toContain(
            'partner.has_strong_partner_evidence'
        );
        expect(relativeRiskMigration).toContain(
            "(item.value->>'displayScore')::NUMERIC - expected.display_score"
        );
        expect(relativeRiskMigration).toContain(
            "item.value->>'riskBand' IS DISTINCT FROM expected.risk_band"
        );
        expect(relativeRiskMigration).toContain(
            "'risk-policy-v2.2',\n        'risk-policy-v2.3'"
        );
        expect(relativeRiskMigration).toContain(
            'public.analysis_v2_relative_overview_fallback('
        );
        expect(relativeRiskMigration).not.toContain(
            "|| ' · ' || feature.instagram_id"
        );
        expect(relativeRiskMigration).not.toContain(
            "pg_catalog.round(score.display_score)::INTEGER::TEXT"
        );
        expect(relativeRiskMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_expected_relative_risk_rows\(JSONB, TEXT\[\]\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(relativeRiskMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.checkpoint_analysis_v2_candidate_scores\([\s\S]*?\) TO service_role/
        );
    });

    it('keeps every staging and final table RPC-only behind forced RLS', () => {
        for (const table of resultTables) {
            expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
            expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON TABLE public\\.${table}\\s+FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).not.toMatch(new RegExp(
                `GRANT (?:ALL|SELECT|INSERT|UPDATE|DELETE)[^;]*public\\.${table}`
            ));
        }
        expect(migration).not.toContain('CREATE POLICY');
    });

    it('retains canonical service-only image URLs and exposes them only through an owner check', () => {
        expect(tableDefinition('analysis_v2_candidate_feature_rows'))
            .toContain('profile_image_url TEXT');
        expect(tableDefinition('analysis_v2_private_name_rows'))
            .toContain('profile_image_url TEXT');
        expect(tableDefinition('analysis_v2_result_summaries'))
            .toContain('target_profile_image_url TEXT');
        expect(tableDefinition('analysis_v2_female_results'))
            .toContain('profile_image_url TEXT');
        expect(migration).not.toContain('/api/image-proxy?');

        const loader = functionDefinition('load_analysis_v2_result_snapshot');
        expect(loader).toContain('analysis_request.user_id = p_user_id');
        expect(loader).toContain("analysis_request.status = 'completed'");
        expect(loader).toContain("'profileImageUrl'");
        expect(functionDefinition('analysis_v2_result_summary_json'))
            .toContain("'targetProfileImageUrl'");
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_result_snapshot\(UUID, UUID\)\s+TO service_role/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_result_snapshot\(UUID, UUID\)[\s\S]*?TO (?:anon|authenticated)/
        );
    });

    it('checkpoints every terminal profile classification with exact media and AI lineage', () => {
        const checkpoint = functionDefinition(
            'analysis_v2_checkpoint_candidate_features_complete'
        );
        for (const terminal of [
            'verified_female',
            'verified_non_female',
            'unresolved',
            'unresolved_stage_conflict',
            'media_unavailable',
            'unavailable',
        ]) {
            expect(checkpoint).toContain(`'${terminal}'`);
        }
        const mediaValidator = functionDefinition('analysis_v2_result_valid_media_context');
        for (const field of [
            'bundleId', 'selectionIds', 'triageAnalyzedSelectionIds',
            'featureAnalyzedSelectionIds', 'captions', 'posts',
        ]) {
            expect(mediaValidator).toContain(`'${field}'`);
        }
        for (const field of [
            'genderOperationKey',
            'genderResultHash',
            'featureOperationKey',
            'featureResultHash',
        ]) {
            expect(checkpoint).toContain(`'${field}'`);
        }
        expect(checkpoint).toContain('pg_catalog.jsonb_array_length(p_rows) <> p_analyzed_count');
        expect(checkpoint).toContain("pg_catalog.count(DISTINCT item.value->>'candidateId')");
        expect(checkpoint).toContain('public.analysis_v2_ai_result_checkpoints');
        expect(checkpoint).toContain('public.analysis_v2_media_artifacts');
        expect(checkpoint).toContain("item.value->>'instagramId' = v_request.excluded_instagram_id");

        const featureTable = tableDefinition('analysis_v2_candidate_feature_rows');
        expect(featureTable).toContain('media_context JSONB');
        expect(featureTable).toContain('gender_operation_key VARCHAR(86)');
        expect(featureTable).toContain('feature_operation_key VARCHAR(86)');
        expect(featureTable).toContain("terminal_classification IN ('unavailable', 'media_unavailable')");
    });

    it('durably separates preliminary, reverse-like, partner-safety, and final score stages', () => {
        for (const [rpc, table] of [
            ['checkpoint_analysis_v2_preliminary_scores', 'analysis_v2_preliminary_score_rows'],
            ['checkpoint_analysis_v2_reverse_likes', 'analysis_v2_reverse_like_rows'],
            ['checkpoint_analysis_v2_partner_safety', 'analysis_v2_partner_safety_rows'],
            ['checkpoint_analysis_v2_candidate_scores', 'analysis_v2_candidate_score_rows'],
        ] as const) {
            expect(functionDefinition(rpc, true)).toContain(`public.${table}`);
        }

        const finalScore = functionDefinition('checkpoint_analysis_v2_candidate_scores', true);
        expectInOrder(finalScore, [
            'public.analysis_v2_preliminary_score_rows',
            'public.analysis_v2_reverse_like_rows',
            'public.analysis_v2_partner_safety_rows',
            "item.value->'components' IS DISTINCT FROM pg_catalog.jsonb_set(",
            "ARRAY['targetToCandidateLike']",
            "item.value->>'rawScore'",
            "item.value->>'publicScore'",
            "item.value->>'riskBand'",
        ]);
        expect(finalScore).toContain("WHEN (item.value->>'publicScore')::NUMERIC < 4.2 THEN 'normal'");
        expect(finalScore).toContain("WHEN (item.value->>'publicScore')::NUMERIC < 6.8 THEN 'caution'");
        expect(finalScore).toContain("ranked.risk_band = 'high_risk' AND ranked.expected_rank <= 3");
        expect(finalScore).toContain("ranked.risk_band = 'caution' AND ranked.expected_rank <= 15");
        expect(finalScore).toContain("p_risk_policy_version IS DISTINCT FROM 'risk-policy-v2.2'");
        expect(finalScore).toContain("item.value->>'weakPartnerAdjustment'");
        expect(finalScore).toContain('partner.has_weak_partner_evidence');
        expect(finalScore).toContain('component_sum.preliminary_component_total');
        expect(finalScore).toContain('expected_score.expected_pre_score');
        expect(finalScore).toContain('expected_score.expected_raw_score');
        expect(finalScore).not.toContain(
            "(item.value->>'rawScore')::NUMERIC\n                - (preliminary.pre_score + reverse_like.component_score)"
        );

        const preliminary = functionDefinition('checkpoint_analysis_v2_preliminary_scores');
        expect(preliminary).toContain(
            "(item.value->'components'->>'candidateToTargetLikes')::NUMERIC"
        );
        expect(preliminary).toContain(
            "LEAST((item.value->>'preScore')::NUMERIC + 3, 100)"
        );
        expect(tableDefinition('analysis_v2_partner_safety_rows'))
            .toContain('has_weak_partner_evidence BOOLEAN NOT NULL');
        expect(tableDefinition('analysis_v2_candidate_score_rows'))
            .toContain('weak_partner_adjustment NUMERIC(3, 1) NOT NULL');

        const reverse = functionDefinition('checkpoint_analysis_v2_reverse_likes', true);
        expect(reverse).not.toContain(
            "preliminary.verification_shortlist_rank IS NOT NULL\n                AND item.value->>'status' = 'not_collected'"
        );
        const finalizer = functionDefinition('complete_analysis_v2_result_and_purge');
        expect(finalizer).toContain('FROM public.analysis_v2_preliminary_score_rows AS preliminary');
        expect(finalizer).toContain('preliminary.verification_shortlist_rank IS NOT NULL');
        const partner = functionDefinition('checkpoint_analysis_v2_partner_safety', true);
        expect(partner).toContain(
            "preliminary.verification_shortlist_rank IS NOT NULL\n                AND item.value->>'source' = 'not_collected'"
        );
        expect(partner).toContain(
            'public.analysis_v2_result_partner_safety_row_matches('
        );

        const partnerBinding = functionDefinition(
            'analysis_v2_result_partner_safety_row_matches'
        );
        expectInOrder(partnerBinding, [
            'public.analysis_v2_candidate_feature_rows',
            'public.analysis_v2_ai_result_checkpoints AS ai_result',
            "ai_result.stage = 'featureAnalysis'",
            "v_features->>'partnerExclusionContext'",
            "v_features->>'marriageEvidence'",
            "v_features->>'partnerEvidence'",
            "v_source = 'gemini'",
            "ai_result.stage = 'partnerSafety'",
            "v_assessment->>'partnerEvidence'",
            'v_expected_strong := v_feature_strong OR v_contact_strong',
            'v_expected_weak := v_expected_weak_raw AND NOT v_expected_strong',
            'FROM pg_catalog.unnest(v_feature_evidence)',
            'FROM pg_catalog.unnest(v_contact_evidence)',
            'GROUP BY combined.value',
            'LIMIT 8',
            'v_row_evidence IS NOT DISTINCT FROM v_expected_evidence',
        ]);
        expect(partnerBinding).toContain(
            "v_partner_ai.result_json->>'hasWeakNonExcludedMalePairEvidence'"
        );
        expect(partnerBinding).toContain(
            "v_partner_ai.result_json->>'hasStrongPartnerEvidence'"
        );
        expect(partnerBinding).toContain(
            "v_partner_ai.result_json->>'strongEvidenceBasis'"
        );
        expect(partnerBinding).toContain(
            "ai_attempt.status = 'rejected'"
        );
    });

    it('stores narrative provenance per candidate instead of trusting a batch-level AI claim', () => {
        const table = tableDefinition('analysis_v2_narrative_rows');
        expect(table).toContain('candidate_id VARCHAR(128) NOT NULL');
        expect(table).toContain('source VARCHAR(16) NOT NULL');
        expect(table).toContain('operation_key VARCHAR(86)');
        expect(table).toContain('ai_result_hash VARCHAR(64)');
        expect(table).toContain('PRIMARY KEY (request_id, candidate_id)');

        const checkpoint = functionDefinition('checkpoint_analysis_v2_narratives');
        expect(checkpoint).toContain("item.value->>'source' NOT IN ('checkpoint', 'safe_fallback')");
        expect(checkpoint).toContain("item.value->>'operationKey'");
        expect(checkpoint).toContain("item.value->>'aiResultHash'");
        expect(checkpoint).toContain('public.analysis_v2_ai_result_checkpoints');
        expect(checkpoint).toContain('ai_result.stage = \'highRiskNarrative\'');
    });

    it('atomically completes the finalizer, progress, one event, scrub, and working-set purge', () => {
        const finalizer = functionDefinition('complete_analysis_v2_result_and_purge');
        expectInOrder(finalizer, [
            "p_job_key IS DISTINCT FROM 'coordinator:finalize'",
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            "v_job.status <> 'processing'",
            'v_job.input_hash IS DISTINCT FROM p_job_input_hash',
            'v_job.lease_token IS DISTINCT FROM p_claim_token',
            'public.analysis_v2_relationship_manifests',
            'public.analysis_v2_target_evidence_manifests',
            'public.analysis_v2_ai_scoring_stage_checkpoints',
            'INSERT INTO public.analysis_v2_result_summaries',
            'INSERT INTO public.analysis_v2_female_results',
            'INSERT INTO public.analysis_v2_private_results',
            'UPDATE public.analysis_progress_state',
            'INSERT INTO public.analysis_progress_events',
            'UPDATE public.analysis_pipeline_jobs AS job',
            'UPDATE public.analysis_requests AS analysis_request',
            'public.analysis_v2_scrub_terminal_request_pii',
            'public.analysis_v2_purge_result_working_set',
        ]);
        expect(finalizer).toContain("event_code = 'ANALYSIS_COMPLETED'");
        expect(finalizer).toContain("'confirmed', 'ANALYSIS_COMPLETED', 'ANALYSIS_COMPLETED'");
        expect(finalizer).toContain("status = 'completed', progress_bp = 10000");
        expect(finalizer).toContain('completion_token = p_claim_token');
        expect(finalizer).toContain("completion_fanout_hash = pg_catalog.md5('[]')");
        expect(finalizer).toContain('v_job.completion_token IS DISTINCT FROM p_claim_token');
        expect(finalizer).toContain("'finalized', FALSE");
    });

    it('distinguishes fetch failure from successful fetch with no normalized media', () => {
        const summary = tableDefinition('analysis_v2_result_summaries');
        expect(summary).toContain('fetch_unavailable_count SMALLINT NOT NULL');
        expect(summary).toContain('media_unavailable_count SMALLINT NOT NULL');

        const finalizer = functionDefinition('complete_analysis_v2_result_and_purge');
        expect(finalizer).toContain("feature.terminal_classification = 'unavailable'");
        expect(finalizer).toContain('AND outcome.status <> \'success\'');
        expect(finalizer).toContain("feature.terminal_classification = 'media_unavailable'");
        expect(finalizer).toContain("AND outcome.status = 'success'");
        expect(finalizer).toContain("feature.terminal_classification NOT IN (");
        expect(finalizer).toContain("'unavailable', 'media_unavailable'");

        const publicSummary = functionDefinition('analysis_v2_result_summary_json');
        expect(publicSummary).toContain("'successfullyScreenedMutuals'");
        expect(publicSummary).toContain(
            'p_summary.screened_mutuals\n            - p_summary.fetch_unavailable_count - p_summary.media_unavailable_count'
        );
        expect(publicSummary).toContain("'fetchUnavailableMutuals'");
        expect(publicSummary).toContain("'mediaUnavailableMutuals'");
    });

    it('allows any exact live job to atomically fail, cancel siblings, and purge without findings', () => {
        const failure = functionDefinition('fail_analysis_v2_result_and_purge');
        expect(failure).toContain('v_job.input_hash IS DISTINCT FROM p_job_input_hash');
        expect(failure).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(failure).toContain('v_job.lease_expires_at <= v_now');
        expect(failure).toContain('INSERT INTO public.analysis_v2_failure_receipts');
        expect(failure).toContain('public.fail_analysis_v2_request_from_job');
        expect(failure).toContain("v_request.status = 'failed'");
        expect(failure).toContain("'finalized', FALSE");

        const convergence = functionDefinition('fail_analysis_v2_request_from_job');
        expect(convergence).toContain("SET status = 'failed'");
        expect(convergence).toContain("SET status = 'cancelled'");
        expect(convergence).toContain("job.status IN ('pending', 'processing')");
        expect(convergence).toContain("status = 'failed', background_processing = FALSE");
        expect(convergence).toContain("THEN 'completed' ELSE 'failed' END::TEXT");
        expect(convergence).toContain('public.analysis_v2_purge_result_working_set');
        expect(convergence).toContain('public.analysis_v2_scrub_terminal_request_pii');
        expect(convergence).not.toContain('INSERT INTO public.analysis_progress_events');
        expect(convergence).not.toContain('ANALYSIS_COMPLETED');
    });

    it('purges PII staging but preserves ledger, DAG, progress, and media cleanup coordinates', () => {
        const purge = functionDefinition('analysis_v2_purge_result_working_set');
        for (const table of [
            'analysis_v2_narrative_manifests',
            'analysis_v2_candidate_score_manifests',
            'analysis_v2_partner_safety_manifests',
            'analysis_v2_reverse_like_manifests',
            'analysis_v2_preliminary_score_manifests',
            'analysis_v2_private_name_manifests',
            'analysis_v2_candidate_feature_manifests',
            'analysis_v2_ai_result_checkpoints',
            'analysis_v2_ai_scoring_stage_checkpoints',
            'analysis_v2_profile_fetch_batches',
            'analysis_v2_target_evidence_manifests',
            'analysis_v2_relationship_manifests',
            'analysis_v2_relationship_sides',
        ]) {
            expect(purge).toContain(`DELETE FROM public.${table}`);
        }
        for (const retained of [
            'analysis_v2_media_artifacts',
            'analysis_v2_ai_attempts',
            'analysis_v2_provider_runs',
            'analysis_pipeline_jobs',
            'analysis_v2_dag_stage_manifests',
            'analysis_progress_events',
        ]) {
            expect(purge).not.toContain(`DELETE FROM public.${retained}`);
        }

        const scrub = functionDefinition('analysis_v2_scrub_terminal_request_pii');
        expect(scrub).toContain("target_instagram_id = 'retained.'");
        expect(scrub).toContain('target_full_name = NULL');
        expect(scrub).toContain('target_bio = NULL');
        expect(scrub).toContain('target_profile_image_url = NULL');
        expect(scrub).toContain("exclusion_decision = 'skip'");
        expect(scrub).toContain('excluded_instagram_id = NULL');
    });

    it('grants only bounded service-role RPCs and revokes every helper', () => {
        for (const rpc of [
            'checkpoint_analysis_v2_candidate_features',
            'checkpoint_analysis_v2_preliminary_scores',
            'checkpoint_analysis_v2_reverse_likes',
            'checkpoint_analysis_v2_partner_safety',
            'checkpoint_analysis_v2_candidate_scores',
            'checkpoint_analysis_v2_private_names',
            'checkpoint_analysis_v2_narratives',
            'load_analysis_v2_result_stage_snapshot',
            'complete_analysis_v2_result_and_purge',
            'fail_analysis_v2_result_and_purge',
            'load_analysis_v2_result_snapshot',
            'load_analysis_v2_result_page',
            'load_analysis_v2_result_image_url',
        ]) {
            const definition = functionDefinition(rpc, true);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${rpc}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`
            ));
        }

        const page = functionDefinition('load_analysis_v2_result_page');
        expect(page).toContain('analysis_request.user_id = p_user_id');
        expect(page).toContain('LIMIT p_page_size + 1');
        expect(page).toContain('female.sort_ordinal > p_female_after_ordinal');
        expect(page).toContain('private_result.sort_ordinal > p_private_after_ordinal');

        const image = functionDefinition('load_analysis_v2_result_image_url');
        expect(image).toContain("analysis_request.status = 'completed'");
        expect(image).toContain('female.candidate_id = p_candidate_id');
        expect(image).toContain('private_result.candidate_id = p_candidate_id');

        for (const helper of [
            'analysis_v2_result_valid_image_path',
            'analysis_v2_result_valid_public_copy',
            'analysis_v2_result_staging_hash',
            'analysis_v2_result_valid_media_context',
            'analysis_v2_result_valid_score_components',
            'analysis_v2_result_valid_ref_list',
            'analysis_v2_result_candidate_id',
            'analysis_v2_assert_result_job_fence',
            'analysis_v2_result_checkpoint_json',
            'analysis_v2_checkpoint_candidate_features_complete',
            'analysis_v2_purge_result_working_set',
            'analysis_v2_scrub_terminal_request_pii',
            'analysis_v2_result_summary_json',
            'fail_analysis_v2_request_from_job',
        ]) {
            expect(migration).not.toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${helper}\\(`
            ));
        }
    });
});
