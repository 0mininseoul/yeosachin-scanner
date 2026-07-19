import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const analyzePage = readFileSync(
    new URL('../../../app/analyze/page.tsx', import.meta.url),
    'utf8'
).replace(/\s+/g, ' ');

describe('earlybird checkout matching copy', () => {
    it('requires the Kakao account phone while allowing a different Groble email', () => {
        expect(analyzePage).toContain('카카오 로그인 계정과 같은 전화번호');
        expect(analyzePage).toMatch(/Groble 이메일[^<]*?로그인 이메일[^<]*?달라도/);
        expect(analyzePage).not.toContain('현재 로그인한 계정과 같은 이메일');
    });
});
