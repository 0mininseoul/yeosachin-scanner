import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panel = readFileSync(new URL('../../../app/mypage/account-deletion-panel.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../../../app/mypage/page.tsx', import.meta.url), 'utf8');

describe('account deletion mypage contract', () => {
    it('requires the exact typed confirmation and explains permanent result/share deletion', () => {
        expect(panel).toContain("confirmation !== '탈퇴'");
        expect(panel).toContain('분석 결과와 공유 링크가 즉시 영구 삭제됩니다.');
        expect(panel).toContain('영구 삭제하고 탈퇴');
    });

    it('only exposes self-service deletion to production external traffic', () => {
        expect(page).toContain("accountClassification.accountClass === 'production'");
        expect(page).toContain("accountClassification.trafficClass === 'external'");
    });
});
