import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260816161000_result_publication_pending_guard.sql', import.meta.url),
    'utf8',
);

const source = (relativePath: string) => readFileSync(
    new URL(`../../../${relativePath}`, import.meta.url),
    'utf8',
);

describe('paid result publication guard migration contract', () => {
    it('defines one fail-closed authority predicate for paid publication', () => {
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.analysis_result_publication_authorized('
        );
        expect(migration).toContain('earlybird_orders');
        expect(migration).toContain('earlybird_fulfillments');
        expect(migration).toContain("payment_id IS NOT NULL");
        expect(migration).toContain("status = 'completed'");
        expect(migration).toContain("status = 'completed'");
        expect(migration).toMatch(/step_data[\s\S]{0,120}\?\s*'conciergeBootstrap'/);
    });

    it('reprojects owner history and restores only the incomplete batch cohort', () => {
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.load_analysis_owner_history_v1()'
        );
        expect(migration).toContain('analysis_result_publication_authorized');
        expect(migration).toContain("status = 'pending'");
        expect(migration).toMatch(/step_data[\s\S]{0,120}\?\s*'conciergeBatchBootstrap'/);
        expect(migration).toContain("status = 'analysis_in_progress'");
        expect(migration).toContain("progress_step = '분석 대기 중...'");
        expect(migration).not.toContain('payment_id = NULL');
        expect(migration).not.toContain("status = 'refunded'");
    });

    it('updates the batch publisher to complete fulfillment before exposing completion', () => {
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.publish_concierge_batch_manual_override('
        );
        expect(migration).toContain('earlybird_fulfillments');
        expect(migration).toContain("status = 'completed'");
        expect(migration).toContain('request_id = p_request_id');
    });

    it('puts every result and share boundary behind the same authority helper', () => {
        for (const relativePath of [
            'app/api/analysis/result/[requestId]/route.ts',
            'app/api/analysis/v2/result/[requestId]/route.ts',
            'app/api/share/[token]/route.ts',
            'app/api/share/[token]/image/route.ts',
            'app/api/share/[token]/opengraph-image/route.tsx',
            'app/api/share/enable/route.ts',
            'app/share/[token]/layout.tsx',
            'app/api/image-proxy/route.ts',
            'app/api/analysis/status/[requestId]/route.ts',
            'app/api/analysis/progress/[requestId]/route.ts',
            'lib/services/earlybird/order-status.ts',
        ]) {
            expect(source(relativePath), relativePath).toContain(
                'isAnalysisResultAuthoritativelyPublished'
            );
        }
    });
});
