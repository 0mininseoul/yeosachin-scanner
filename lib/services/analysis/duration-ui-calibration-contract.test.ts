import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analysisDurationProgressCopy } from './owner-view-presentation';

function source(relativePath: string): string {
    return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8');
}

describe('analysis duration UI calibration contract', () => {
    it('keeps the real analyze estimate honest while calibration is incomplete', () => {
        const analyze = source('app/analyze/page.tsx');

        expect(analyze).toContain('<p className="eyebrow">예상 소요 시간</p>');
        expect(analyze).toContain('계정 규모와 수집 상황에 따라 달라집니다. 정확한 완료 시간은 현재 측정 중이에요.');
        expect(analyze).not.toContain('analysisDurationRangeLabel');
        expect(analyze).not.toContain('estimatePreflightAnalysisDuration');
        expect(analyze).not.toContain('preflightDurationEstimate');
    });

    it('shows no real-workload numeric range or delay claim on progress', () => {
        const progress = source('app/progress/[requestId]/page.tsx');
        const hook = source('hooks/useAnalysisProgress.ts');

        expect(progress).toContain('analysisDurationProgressCopy(data.demo)');
        expect(progress).not.toContain('useAnalysisDurationEstimate');
        expect(progress).not.toContain('analysisDurationRangeLabel');
        expect(progress).not.toContain('hasAnalysisDurationExceeded');
        expect(progress).not.toContain('예상보다 지연 중');
        expect(progress).not.toContain('ANALYSIS_DURATION_ESTIMATE_SHOWN');
        expect(progress).not.toContain('setNowMs');
        expect(hook).toContain("demo: response.headers.get('x-analytics-eligible') === '0'");
    });

    it('keeps demo timing distinct from the real calibration status', () => {
        expect(analysisDurationProgressCopy(true)).toBe('약 60~90초');
        expect(analysisDurationProgressCopy(false)).toBe('완료 시간 측정 중');
    });
});
