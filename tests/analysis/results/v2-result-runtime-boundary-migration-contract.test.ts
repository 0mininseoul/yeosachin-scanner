import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsUrl = new URL('../../../supabase/migrations/', import.meta.url);
const resultMigrationName = '20260713185711_add_analysis_v2_result_finalization.sql';
const aiStageMigrationName = '20260713202201_add_analysis_v2_ai_scoring_stage_state.sql';
const boundaryMigrationName = '20260713213000_harden_analysis_v2_result_runtime_boundary.sql';
const original = readFileSync(new URL(resultMigrationName, migrationsUrl), 'utf8');
const boundary = readFileSync(new URL(boundaryMigrationName, migrationsUrl), 'utf8');

describe('analysis V2 result runtime boundary migration contract', () => {
    it('keeps the original result migration safe before the later AI stage relation exists', () => {
        expect(original).toContain(
            "pg_catalog.to_regclass(\n        'public.analysis_v2_ai_scoring_stage_checkpoints'"
        );
        expect(original).toContain(
            "EXECUTE 'DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints'"
        );
        const finalizer = original.slice(original.indexOf(
            'CREATE OR REPLACE FUNCTION public.complete_analysis_v2_result_and_purge('
        ));
        expect(finalizer.indexOf("MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY'"))
            .toBeLessThan(finalizer.indexOf(
                'public.analysis_v2_ai_scoring_stage_checkpoints AS rich_stage'
            ));
    });

    it('rebinds cleanup and finalization only after the AI scoring stage migration', () => {
        const names = readdirSync(migrationsUrl).sort();
        expect(names.indexOf(resultMigrationName)).toBeLessThan(names.indexOf(aiStageMigrationName));
        expect(names.indexOf(aiStageMigrationName)).toBeLessThan(names.indexOf(boundaryMigrationName));

        expect(boundary).toContain(
            'DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints WHERE request_id = p_request_id'
        );
        expect(boundary).toContain(
            'CREATE OR REPLACE FUNCTION public.analysis_v2_result_staging_hash('
        );
        expect(boundary).toContain('CALLED ON NULL INPUT');
        expect(boundary).toContain("COALESCE(p_batch::TEXT, '-')");
        expect(boundary).toContain(
            'CREATE OR REPLACE FUNCTION public.analysis_v2_result_checkpoint_json('
        );
        expect(boundary).toContain("'batch', p_batch");
        expect(boundary).toContain(
            ') RENAME TO analysis_v2_complete_result_and_purge_internal'
        );
        expect(boundary).toContain(
            'REVOKE ALL ON FUNCTION public.analysis_v2_complete_result_and_purge_internal('
        );
        expect(boundary).toContain(
            "MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY'"
        );
        expect(boundary).toContain(
            'RETURN public.analysis_v2_complete_result_and_purge_internal('
        );
        expect(boundary).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.complete_analysis_v2_result_and_purge\([\s\S]*?TO service_role/
        );
        expect(boundary).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_complete_result_and_purge_internal/
        );
    });

    it('hands an exact result checkpoint replay to the current live retry claim', () => {
        const fenceStart = boundary.indexOf(
            'CREATE OR REPLACE FUNCTION public.analysis_v2_assert_result_job_fence('
        );
        const fenceEnd = boundary.indexOf(
            'REVOKE ALL ON FUNCTION public.analysis_v2_assert_result_job_fence(',
            fenceStart
        );
        const fence = boundary.slice(fenceStart, fenceEnd);
        const liveLeaseCheck = fence.indexOf(
            'v_job.lease_token IS DISTINCT FROM p_claim_token'
        );

        expect(fenceStart).toBeGreaterThan(-1);
        expect(liveLeaseCheck).toBeGreaterThan(-1);
        for (const table of [
            'analysis_v2_candidate_feature_manifests',
            'analysis_v2_preliminary_score_manifests',
            'analysis_v2_reverse_like_manifests',
            'analysis_v2_partner_safety_manifests',
            'analysis_v2_candidate_score_manifests',
            'analysis_v2_private_name_manifests',
            'analysis_v2_narrative_manifests',
        ]) {
            const handoff = fence.indexOf(`UPDATE public.${table}`);
            expect(handoff).toBeGreaterThan(liveLeaseCheck);
        }
        expect(fence.match(/producer_job_key = p_job_key/g)).toHaveLength(7);
        expect(fence.match(/producer_input_hash = p_job_input_hash/g)).toHaveLength(7);
        expect(fence.match(/producer_claim_token IS DISTINCT FROM p_claim_token/g))
            .toHaveLength(7);
    });
});
