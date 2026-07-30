import { describe, expect, it } from 'vitest';
import {
    appendScreenedFace,
    MAX_SCREENED_FACES,
    type ScreenedFace,
} from './progress-faces';

function face(n: number): ScreenedFace {
    return { username: `u${n}***`, imageUrl: `/api/image-proxy?token=${n}` };
}

describe('screened face accumulation', () => {
    it('appends a newly active profile', () => {
        const next = appendScreenedFace([], { maskedUsername: 'a***', imageUrl: '/x' });
        expect(next).toEqual([{ username: 'a***', imageUrl: '/x' }]);
    });

    it('ignores the same profile repeated by successive polls', () => {
        const first = appendScreenedFace([], { maskedUsername: 'a***', imageUrl: '/x' });
        const second = appendScreenedFace(first, { maskedUsername: 'a***', imageUrl: '/x' });
        // Identity, not just equality: the caller uses it to skip a re-render.
        expect(second).toBe(first);
    });

    it('keeps a profile that comes back around after another', () => {
        let list = appendScreenedFace([], { maskedUsername: 'a***', imageUrl: '/x' });
        list = appendScreenedFace(list, { maskedUsername: 'b***', imageUrl: '/y' });
        list = appendScreenedFace(list, { maskedUsername: 'a***', imageUrl: '/x' });
        // Dropping this would put the row out of step with the screened count.
        expect(list.map(f => f.username)).toEqual(['a***', 'b***', 'a***']);
    });

    it('holds at the cap by dropping the oldest', () => {
        let list: readonly ScreenedFace[] = [];
        for (let n = 0; n < MAX_SCREENED_FACES + 5; n += 1) {
            list = appendScreenedFace(list, {
                maskedUsername: face(n).username,
                imageUrl: face(n).imageUrl,
            });
        }
        expect(list).toHaveLength(MAX_SCREENED_FACES);
        expect(list.at(0)?.username).toBe('u5***');
        expect(list.at(-1)?.username).toBe(`u${MAX_SCREENED_FACES + 4}***`);
    });

    it('ignores a profile with no image rather than showing a hole', () => {
        const list = appendScreenedFace([], { maskedUsername: 'a***', imageUrl: null });
        expect(list).toEqual([]);
    });

    it('ignores an absent active profile', () => {
        const seeded = appendScreenedFace([], { maskedUsername: 'a***', imageUrl: '/x' });
        expect(appendScreenedFace(seeded, null)).toBe(seeded);
    });
});

describe('owner score as a percentage', () => {
    it('reads off the same ratio the meter fills to', async () => {
        const { ownerScorePercent } = await import('./owner-view-presentation');
        // 3.8 printed as 4/10 while the bar sat at 38%; both are 38 now.
        expect(ownerScorePercent(3.8)).toBe(38);
        expect(ownerScorePercent(9)).toBe(90);
        expect(ownerScorePercent(10)).toBe(100);
    });

    it('never leaves the 0-100 range whatever it is handed', async () => {
        const { ownerScorePercent } = await import('./owner-view-presentation');
        expect(ownerScorePercent(-4)).toBe(0);
        expect(ownerScorePercent(42)).toBe(100);
        expect(ownerScorePercent(Number.NaN)).toBe(0);
    });
});
