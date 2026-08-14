import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260814210000_add_legacy_result_overview.sql', import.meta.url),
    'utf8',
);
const correctionScript = readFileSync(
    new URL('../../../scripts/correct-concierge-basic-result.ts', import.meta.url),
    'utf8',
);
const sourceAccessorMigration = readFileSync(
    new URL('../../../supabase/migrations/20260814220000_add_concierge_source_accessor.sql', import.meta.url),
    'utf8',
);
const reviewedSourceMigration = readFileSync(
    new URL('../../../supabase/migrations/20260814223000_register_concierge_reviewed_source.sql', import.meta.url),
    'utf8',
);

describe('legacy concierge result overview persistence contract', () => {
    it('adds an additive bounded overview column without changing the narrative field', () => {
        expect(migration).toContain(
            'ADD COLUMN IF NOT EXISTS one_line_overview VARCHAR(180)',
        );
        expect(migration).toContain(
            'CHECK (one_line_overview IS NULL OR char_length(one_line_overview) BETWEEN 1 AND 180)',
        );
        expect(migration).toContain('COMMENT ON COLUMN public.analysis_results.one_line_overview');
        expect(migration).not.toContain('DROP COLUMN');
        expect(migration).not.toContain('risk_analysis');
    });

    it('publishes and verifies the overview through the legacy row contract', () => {
        expect(correctionScript).toContain(
            'likes_count, intimate_comments_count, one_line_overview, risk_analysis',
        );
        expect(correctionScript).toContain(
            'intimate_comments_count integer, one_line_overview varchar(180), risk_analysis jsonb',
        );
        expect(correctionScript).toContain(
            'select(\'rank,risk_score,risk_grade,one_line_overview,risk_analysis,gender_status\')',
        );
        expect(correctionScript).toContain('CONCIERGE_PUBLICATION_OVERVIEW_VERIFY_FAILED');
    });

    it('keeps operator output free of request and result identifiers', () => {
        expect(correctionScript).toContain("state: 'completed'");
        expect(correctionScript).not.toContain('resultPath: `/result/${order.result_request_id}`');
        expect(correctionScript).not.toContain('semanticInputFingerprint:');
    });

    it('binds the correction source through the order-scoped replay lineage', () => {
        expect(correctionScript).toContain('read_earlybird_v211_concierge_result_source');
        expect(correctionScript).toContain('selectConciergeSourceRequest');
        expect(sourceAccessorMigration).toContain(
            'CREATE FUNCTION public.read_earlybird_v211_concierge_result_source(',
        );
        expect(sourceAccessorMigration).toContain('SECURITY DEFINER');
        expect(sourceAccessorMigration).toContain("SET search_path = ''");
        expect(sourceAccessorMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.read_earlybird_v211_concierge_result_source\(UUID\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
        );
        expect(sourceAccessorMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.read_earlybird_v211_concierge_result_source\(UUID\)[\s\S]*?TO service_role;/,
        );
        expect(sourceAccessorMigration).not.toMatch(/GRANT .* ON TABLE public\.earlybird_v211_concierge_replays/);
        expect(sourceAccessorMigration).not.toContain(
            'source_request.target_instagram_id = earlybird_order.target_instagram_id',
        );
        expect(sourceAccessorMigration).toContain('source_preflight.target_instagram_id');
        expect(correctionScript).not.toContain("load_analysis_v2_target_evidence");
        expect(correctionScript.indexOf('await verifyAuthorization')).toBeLessThan(
            correctionScript.indexOf('applyAtomicPublication({'),
        );
        expect(correctionScript).toContain('lower(btrim(v_request_target))');
    });

    it('uses the reviewed live snapshot and existing replay row instead of terminal V2 staging', () => {
        expect(correctionScript).toContain('collectReviewedTargetSnapshot');
        expect(correctionScript).not.toContain('sourceRequest.step_data');
        expect(correctionScript).not.toContain('load_analysis_v2_target_evidence');
        expect(correctionScript).toContain('register_earlybird_v211_concierge_reviewed_source');
        expect(reviewedSourceMigration).toContain(
            'ALTER TABLE public.earlybird_v211_concierge_replays',
        );
        expect(reviewedSourceMigration).not.toContain(
            'CREATE TABLE public.earlybird_v211_concierge',
        );
        expect(reviewedSourceMigration).toContain('reviewed_source_target_posts');
        expect(reviewedSourceMigration).toContain('reviewed_source_target_evidence');
        expect(reviewedSourceMigration).toContain(
            'GRANT EXECUTE ON FUNCTION public.register_earlybird_v211_concierge_reviewed_source(',
        );
        expect(reviewedSourceMigration).not.toMatch(/GRANT .* ON TABLE public\.earlybird_v211_concierge_replays/);
    });

    it('binds publication writes to a persisted fingerprint and result hash CAS marker', () => {
        expect(correctionScript).toContain('CONCIERGE_PUBLICATION_CAS_CONFLICT');
        expect(correctionScript).toContain('published_source_fingerprint');
        expect(correctionScript).toContain('published_result_hash');
        expect(correctionScript).toContain('publication_skip');
        expect(correctionScript).toContain(
            'FROM public.earlybird_v211_concierge_replays\n   WHERE order_id =',
        );
        expect(correctionScript).toContain('FOR UPDATE');
        expect(reviewedSourceMigration).toContain('published_source_fingerprint');
        expect(reviewedSourceMigration).toContain('published_result_hash');
    });
});
