import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HighRiskSummary } from './high-risk-summary';

describe('HighRiskSummary', () => {
    it('renders the canonical count accessibly and keeps the mobile-safe layout', () => {
        const markup = renderToStaticMarkup(
            <HighRiskSummary
                count={2}
                context={<>맞팔 <span className="num">20</span>명 중 판독했습니다.</>}
            />,
        );

        expect(markup).toContain('고위험 계정 2건');
        expect(markup).toContain('고위험 계정</p>');
        expect(markup).toContain('맞팔 <span class="num">20</span>명 중 판독했습니다.');
        expect(markup).toContain('relative mt-5 pl-4');
        expect(markup).toContain('text-blood-2');
        expect(markup).toContain('bg-blood');
    });

    it('renders zero as a truthful clean verdict rather than a danger state', () => {
        const markup = renderToStaticMarkup(<HighRiskSummary count={0} />);

        expect(markup).toContain('고위험 계정 0건');
        expect(markup).toContain('text-jade');
        expect(markup).toContain('bg-jade');
        expect(markup).not.toContain('text-blood-2');
        expect(markup).not.toContain('bg-blood');
    });
});
