import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = new URL(
    '../../../supabase/migrations/20260803150000_analysis_v2_v211_result_revisions.sql',
    import.meta.url,
);
const textOnlyRpcRenameMigration = new URL(
    '../../../supabase/migrations/20260803180000_v211_text_only_source_rpc_short_name.sql',
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
        expect(sql).toContain("'public.load_analysis_v2_result_image_url(uuid,uuid,text,text)'::pg_catalog.regprocedure");
        expect(sql).not.toContain("'public.load_analysis_v2_result_image_url(uuid,text,text)'::pg_catalog.regprocedure");
    });

    it('uses transaction-independent session timeouts for the migration entrypoint', async () => {
        const sql = await readFile(migration, 'utf8');
        expect(sql).toContain("SET lock_timeout = '5s';");
        expect(sql).toContain("SET statement_timeout = '2min';");
        expect(sql).not.toContain('SET LOCAL lock_timeout');
    });

    it('requires byte-identical female rows on an idempotency-key replay', async () => {
        const sql = await readFile(migration, 'utf8');
        expect(sql).toContain('OR v_existing.payload_hash IS DISTINCT FROM v_payload_hash THEN');
        expect(sql).toContain("'analysis-v2-v211-revision-payload:v1'");
    });

    it('renames the PostgreSQL-truncated text-only source RPC and reloads PostgREST', async () => {
        const sql = await readFile(textOnlyRpcRenameMigration, 'utf8');
        expect(sql).toContain(
            'ALTER FUNCTION public.read_analysis_v2_test_entitlement_v211_legacy_secondary_text_on(UUID)',
        );
        expect(sql).toContain(
            'RENAME TO read_analysis_v2_test_entitlement_v211_text_only_source;',
        );
        expect(sql).toContain(
            'REVOKE ALL ON FUNCTION public.read_analysis_v2_test_entitlement_v211_text_only_source(UUID)',
        );
        expect(sql).toContain(
            'GRANT EXECUTE ON FUNCTION public.read_analysis_v2_test_entitlement_v211_text_only_source(UUID)\n    TO service_role;',
        );
        expect(sql).toContain(
            'v_source := public.read_analysis_v2_test_entitlement_v211_text_only_source(p_request_id);',
        );
        expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
    });
});
