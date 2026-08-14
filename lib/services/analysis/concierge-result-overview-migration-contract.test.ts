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
        expect(correctionScript).toContain("from('earlybird_v211_concierge_replays')");
        expect(correctionScript).toContain("select('original_failed_request_id')");
        expect(correctionScript).toContain("eq('order_id', order.id)");
        expect(correctionScript).toContain('selectConciergeSourceRequest');
    });
});
