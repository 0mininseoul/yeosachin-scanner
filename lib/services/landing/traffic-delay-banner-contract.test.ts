import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const landingPage = readFileSync(
    new URL('../../../components/landing-page.tsx', import.meta.url),
    'utf8'
).replace(/\s+/g, ' ');

describe('landing traffic delay banner', () => {
    it('does not show the temporary congestion notice', () => {
        expect(landingPage).not.toContain('data-testid="traffic-delay-banner"');
        expect(landingPage).not.toContain(
            '현재 접속자가 많아 분석 대기 시간이 평소보다 길어지고 있습니다.'
        );
    });
});
