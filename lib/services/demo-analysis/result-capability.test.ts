import { describe, expect, it } from 'vitest';
import { mapV2Result } from '@/app/result/[requestId]/page';
import { demoResultPage } from './demo-analysis';

const requestId = '223e4567-e89b-42d3-a456-426614174000';

describe('result capability mapping', () => {
    it('keeps local avatars and removes every external profile link when disabled on later pages', () => {
        const first = demoResultPage({ requestId, femaleCursor: null, privateCursor: null, pageSize: 1 });
        const second = demoResultPage({ requestId, femaleCursor: first.femaleNextCursor, privateCursor: first.privateNextCursor, pageSize: 1 });
        for (const page of [first, second]) {
            const mapped = mapV2Result(page, false);
            expect(mapped.femaleAccounts[0]?.profileImage).toMatch(/^\/demo-avatars\//);
            expect(mapped.femaleAccounts[0]?.instagramUrl).toBeUndefined();
            expect(JSON.stringify(mapped)).not.toContain('instagram.com');
        }
        expect(mapV2Result(first, true).femaleAccounts[0]?.instagramUrl).toContain('instagram.com');
    });
});
