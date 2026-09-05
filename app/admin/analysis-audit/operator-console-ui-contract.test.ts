import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
const workbench = readFileSync(new URL('./workbench.tsx', import.meta.url), 'utf8');

describe('production operator console UI boundary', () => {
    it('uses the light single-surface console instead of the legacy case-file primitives', () => {
        expect(page).toContain('operator-console');
        expect(page).not.toContain('CaseCard');
        expect(page).not.toContain('Eyebrow');
        expect(page).not.toContain('TopBar');
        expect(workbench).toContain('/api/admin/order-audit');
        expect(workbench).toContain('/api/admin/apify-accounts');
        expect(workbench).toContain('private, no-store');
        expect(workbench).not.toContain('AnalysisAuditPayload');
        expect(workbench).not.toContain('RiskTag');
        expect(workbench).not.toContain('runway');
        expect(workbench).not.toContain('median');
    });

    it('keeps the required evidence stages and semantic controls visible in source', () => {
        for (const label of [
            '맞팔 계정',
            '1차 성별 판정',
            '최종 성별 판정',
            '대상 게시물 좋아요',
            '대상 게시물 댓글',
            '공개 여성 위험 산출',
            '최초 이탈',
            '영구 보관',
        ]) {
            expect(workbench).toContain(label);
        }
        expect(workbench).toContain('aria-expanded');
        expect(workbench).toContain('aria-controls');
    });
});
