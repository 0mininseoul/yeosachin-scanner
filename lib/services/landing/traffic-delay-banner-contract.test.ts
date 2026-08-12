import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const landingPage = readFileSync(
    new URL('../../../components/landing-page.tsx', import.meta.url),
    'utf8'
).replace(/\s+/g, ' ');

describe('landing traffic delay banner', () => {
    it('shows a non-sticky status banner immediately after the top bar', () => {
        const topBar = landingPage.indexOf('<TopBar');
        const banner = landingPage.indexOf('data-testid="traffic-delay-banner"');
        const main = landingPage.indexOf('<main');

        expect(landingPage).toContain(
            '현재 접속자가 많아 분석 대기 시간이 평소보다 길어지고 있습니다.'
        );
        expect(landingPage).toContain('role="status"');
        expect(banner).toBeGreaterThan(topBar);
        expect(banner).toBeLessThan(main);
        expect(landingPage).not.toMatch(
            /data-testid="traffic-delay-banner"[^>]*className="[^"]*(?:fixed|sticky)/
        );
    });
});
