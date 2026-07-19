import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const analyzePage = readFileSync(
    new URL('../../../app/analyze/page.tsx', import.meta.url),
    'utf8'
).replace(/\s+/g, ' ');

describe('earlybird checkout matching copy', () => {
    // 프론트 결정: 결제 화면 하단의 Groble 매칭 안내(전화번호/이메일)를 노출하지 않는다.
    // (결제↔계정 매칭 안내가 필요해지면 별도 위치/방식으로 재검토)
    it('does not surface Groble checkout matching guidance on the analyze page', () => {
        expect(analyzePage).not.toContain('Groble 결제창');
        expect(analyzePage).not.toContain('카카오 로그인 계정과 같은 전화번호');
        expect(analyzePage).not.toContain('현재 로그인한 계정과 같은 이메일');
    });
});
