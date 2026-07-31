import { describe, expect, it } from 'vitest';
import {
    appendScreenedCandidate,
    MAX_SCREENED_CANDIDATES,
    type ScreenedCandidate,
} from './progress-faces';

function candidate(n: number): ScreenedCandidate {
    return {
        username: `u${n}***`,
        imageUrl: `/api/image-proxy?token=${n}`,
        feedImageUrls: [],
    };
}

describe('screened candidate accumulation', () => {
    it('adds an active candidate as one profile-plus-feed bundle', () => {
        const next = appendScreenedCandidate([], {
            maskedUsername: 'a***',
            imageUrl: '/profile',
            feedImageUrls: ['/feed-1', '/feed-2'],
        });
        expect(next).toEqual([{
            username: 'a***',
            imageUrl: '/profile',
            feedImageUrls: ['/feed-1', '/feed-2'],
        }]);
    });

    it('is a no-op for an exact repeated heartbeat', () => {
        const active = {
            maskedUsername: 'a***',
            imageUrl: '/profile',
            feedImageUrls: ['/feed-1'],
        };
        const first = appendScreenedCandidate([], active);
        const second = appendScreenedCandidate(first, active);
        // Identity, not just equality: the caller uses it to skip a re-render.
        expect(second).toBe(first);
    });

    it('updates the adjacent username when a later heartbeat has richer media', () => {
        const usernameOnly = appendScreenedCandidate([], {
            maskedUsername: 'a***',
            imageUrl: null,
        });
        const richPreview = appendScreenedCandidate(usernameOnly, {
            maskedUsername: 'a***',
            imageUrl: '/profile',
            feedImageUrls: ['/feed-1', '/feed-2', '/feed-3'],
        });

        expect(richPreview).toEqual([{
            username: 'a***',
            imageUrl: '/profile',
            feedImageUrls: ['/feed-1', '/feed-2', '/feed-3'],
        }]);
    });

    it('preserves a rich adjacent bundle when a retry falls back to username-only', () => {
        const richPreview = appendScreenedCandidate([], {
            maskedUsername: 'a***',
            imageUrl: '/profile',
            feedImageUrls: ['/feed-1', '/feed-2', '/feed-3'],
        });
        const usernameOnly = appendScreenedCandidate(richPreview, {
            maskedUsername: 'a***',
            imageUrl: null,
        });

        expect(usernameOnly).toBe(richPreview);
    });

    it('preserves a rich adjacent bundle when a retry has fewer feed images', () => {
        const richPreview = appendScreenedCandidate([], {
            maskedUsername: 'a***',
            imageUrl: '/profile',
            feedImageUrls: ['/feed-1', '/feed-2', '/feed-3'],
        });
        const partialRetry = appendScreenedCandidate(richPreview, {
            maskedUsername: 'a***',
            imageUrl: '/profile-refreshed',
            feedImageUrls: ['/feed-refreshed'],
        });

        expect(partialRetry).toBe(richPreview);
    });

    it('updates refreshed profile and feed media when neither dimension regresses', () => {
        const first = appendScreenedCandidate([], {
            maskedUsername: 'a***',
            imageUrl: '/profile-v1',
            feedImageUrls: ['/feed-v1-1', '/feed-v1-2'],
        });
        const refreshed = appendScreenedCandidate(first, {
            maskedUsername: 'a***',
            imageUrl: '/profile-v2',
            feedImageUrls: ['/feed-v2-1', '/feed-v2-2'],
        });

        expect(refreshed).not.toBe(first);
        expect(refreshed).toEqual([{
            username: 'a***',
            imageUrl: '/profile-v2',
            feedImageUrls: ['/feed-v2-1', '/feed-v2-2'],
        }]);
    });

    it('keeps a candidate that comes back around after another', () => {
        let list = appendScreenedCandidate([], { maskedUsername: 'a***', imageUrl: '/x' });
        list = appendScreenedCandidate(list, { maskedUsername: 'b***', imageUrl: '/y' });
        list = appendScreenedCandidate(list, { maskedUsername: 'a***', imageUrl: '/x' });
        // Dropping this would put the row out of step with the screened count.
        expect(list.map(f => f.username)).toEqual(['a***', 'b***', 'a***']);
    });

    it('holds at the cap by dropping the oldest', () => {
        let list: readonly ScreenedCandidate[] = [];
        for (let n = 0; n < MAX_SCREENED_CANDIDATES + 5; n += 1) {
            list = appendScreenedCandidate(list, {
                maskedUsername: candidate(n).username,
                imageUrl: candidate(n).imageUrl,
            });
        }
        expect(list).toHaveLength(MAX_SCREENED_CANDIDATES);
        expect(list.at(0)?.username).toBe('u5***');
        expect(list.at(-1)?.username).toBe(`u${MAX_SCREENED_CANDIDATES + 4}***`);
    });

    it('keeps a profile fallback before feed images when the profile image is absent', () => {
        const list = appendScreenedCandidate([], {
            maskedUsername: 'a***',
            imageUrl: null,
            feedImageUrls: ['/feed-1', '/feed-2', '/feed-3', '/feed-4'],
        });
        expect(list).toEqual([{
            username: 'a***',
            imageUrl: null,
            feedImageUrls: ['/feed-1', '/feed-2', '/feed-3'],
        }]);
    });

    it('ignores an absent active profile', () => {
        const seeded = appendScreenedCandidate([], { maskedUsername: 'a***', imageUrl: '/x' });
        expect(appendScreenedCandidate(seeded, null)).toBe(seeded);
    });

    it('keeps a no-media candidate so the renderer can use its profile fallback', () => {
        const list = appendScreenedCandidate([], { maskedUsername: 'a***', imageUrl: null });
        expect(list).toEqual([{
            username: 'a***',
            imageUrl: null,
            feedImageUrls: [],
        }]);
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
