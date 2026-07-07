import { describe, it, expect } from 'vitest';
import { fetchWebProfileUser } from './web-client';
import { mapUserToProfile } from './mappers';

// 실제 인스타 호출. 기본 skip.
// 실행: RUN_SMOKE=1 IG_TRANSPORT=direct npx vitest run **/web-client.smoke.test.ts
const run = process.env.RUN_SMOKE === '1';

describe.skipIf(!run)('web-client 스모크 (실네트워크)', () => {
    it('공개 계정 프로필을 가져와 매핑한다', async () => {
        const user = await fetchWebProfileUser('instagram');
        expect(user).not.toBeNull();
        const profile = mapUserToProfile(user!);
        expect(profile.username).toBe('instagram');
        expect(profile.followersCount).toBeGreaterThan(0);
    }, 30_000);
});
