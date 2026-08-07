import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../app/analyze/page.tsx', import.meta.url), 'utf8');

describe('analyze OAuth checkout continuation contract', () => {
    it('preserves the paid action through login and submits it after preflight resume', () => {
        expect(source).toContain("loginRedirectParams.set(AUTO_CHECKOUT_QUERY_PARAM, '1');");
        expect(source).toContain('shouldAutoSubmitEarlybirdAction({');
        expect(source).toContain('void handleEarlybirdAction();');
    });
});
