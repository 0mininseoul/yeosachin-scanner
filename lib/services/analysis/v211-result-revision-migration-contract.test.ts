import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = new URL(
    '../../../supabase/migrations/20260803150000_analysis_v2_v211_result_revisions.sql',
    import.meta.url,
);

describe('v2.11 result revision reader migration contract', () => {
    it('preserves request_id for snapshot/page predicates after replacing the base relation', async () => {
        const sql = await readFile(migration, 'utf8');
        expect(sql).toContain('RETURNS TABLE (\n    request_id UUID, candidate_id VARCHAR');
        expect(sql).toContain('RETURN QUERY SELECT p_request_id, female.candidate_id');
        expect(sql).toContain('FROM public.analysis_v2_effective_female_results(p_request_id) AS female');
        expect(sql).toContain('WHERE female.request_id = p_request_id');
    });

    it('keeps the image reader predicate scoped through the effective relation', async () => {
        const sql = await readFile(migration, 'utf8');
        expect(sql).toContain('FROM public.analysis_v2_effective_female_results(p_request_id) AS female\\n        WHERE female.candidate_id = p_candidate_id;');
        expect(sql).toContain('ANALYSIS_V2_V211_REVISION_IMAGE_QUERY_DRIFT');
    });

    it('requires byte-identical female rows on an idempotency-key replay', async () => {
        const sql = await readFile(migration, 'utf8');
        expect(sql).toContain('OR v_existing.payload_hash IS DISTINCT FROM v_payload_hash THEN');
        expect(sql).toContain("'analysis-v2-v211-revision-payload:v1'");
    });
});
