import { describe, it, expect } from 'vitest';
import { fetchFollowers } from './followers-client';
import { parseSessions } from './session';

// 실제 인스타 호출(세션 필요). 기본 skip.
// 실행: RUN_SMOKE=1 IG_SESSIONS='[{"sessionId":"..","csrfToken":"..","userId":".."}]' \
//        npx vitest run **/followers-client.smoke.test.ts
// ⚠️ 버너 계정만 사용할 것. 개인/메인 계정 쿠키 금지.
const run = process.env.RUN_SMOKE === '1' && parseSessions().length > 0;

describe.skipIf(!run)('followers-client 스모크 (실네트워크, 세션 필요)', () => {
    it('공개 계정의 팔로워 일부를 가져온다', async () => {
        const followers = await fetchForSmoke();
        expect(followers.length).toBeGreaterThan(0);
        expect(typeof followers[0].username).toBe('string');
    }, 60_000);
});

// 대상 계정은 env로 바꿀 수 있게 (기본: instagram)
async function fetchForSmoke() {
    const target = process.env.SMOKE_TARGET || 'instagram';
    return fetchFollowers(target, 30);
}
