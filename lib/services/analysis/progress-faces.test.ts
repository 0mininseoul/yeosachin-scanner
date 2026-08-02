import { describe, expect, it } from 'vitest';
import {
    activeCandidateMediaKey,
    appendScreenedCandidate,
    candidateCopyKey,
    candidateTileKey,
    MAX_SCREENED_CANDIDATES,
    nextDriftOffset,
    progressCopyDistance,
    signedProgressCandidateMedia,
    type ScreenedCandidate,
} from './progress-faces';

function candidate(n: number): ScreenedCandidate {
    return {
        username: `u${n}***`,
        occurrence: n,
        imageUrl: `/api/image-proxy?token=${n}`,
        feedImageUrls: [],
    };
}

describe('screened candidate accumulation', () => {
    it('exposes only signed proxy media for the progress rail', () => {
        expect(signedProgressCandidateMedia({
            imageUrl: 'https://cdn.example/profile.jpg',
            feedImageUrls: [
                '/api/image-proxy?token=feed',
                '/demo-avatars/demo-v3-female-001.webp',
            ],
        })).toEqual(['/api/image-proxy?token=feed']);
    });

    it('adds an active candidate as one profile-plus-feed bundle', () => {
        const next = appendScreenedCandidate([], {
            maskedUsername: 'a***',
            imageUrl: '/profile',
            feedImageUrls: ['/feed-1', '/feed-2'],
        });
        expect(next).toEqual([{
            username: 'a***',
            occurrence: 1,
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
            occurrence: 1,
            imageUrl: '/profile',
            feedImageUrls: ['/feed-1', '/feed-2', '/feed-3'],
        }]);
    });

    it('appends same-mask candidates when their opaque candidate keys differ', () => {
        const first = appendScreenedCandidate([], {
            candidateKey: 'candidate-a',
            maskedUsername: 'same***',
            imageUrl: '/profile-a',
        });
        const second = appendScreenedCandidate(first, {
            candidateKey: 'candidate-b',
            maskedUsername: 'same***',
            imageUrl: '/profile-b',
        });

        expect(second.map(item => ({ key: item.candidateKey, occurrence: item.occurrence })))
            .toEqual([
                { key: 'candidate-a', occurrence: 1 },
                { key: 'candidate-b', occurrence: 2 },
            ]);
    });

    it('merges media updates for the same opaque candidate key', () => {
        const first = appendScreenedCandidate([], {
            candidateKey: 'candidate-a',
            maskedUsername: 'same***',
            imageUrl: null,
        });
        const updated = appendScreenedCandidate(first, {
            candidateKey: 'candidate-a',
            maskedUsername: 'same***',
            imageUrl: '/profile-a',
            feedImageUrls: ['/feed-a'],
        });

        expect(updated).toEqual([{
            candidateKey: 'candidate-a',
            username: 'same***',
            occurrence: 1,
            imageUrl: '/profile-a',
            feedImageUrls: ['/feed-a'],
        }]);
    });

    it('moves a nonadjacent keyed candidate to newest while enriching its occurrence', () => {
        let list = appendScreenedCandidate([], {
            candidateKey: 'candidate-a',
            maskedUsername: 'same***',
            imageUrl: null,
        });
        list = appendScreenedCandidate(list, {
            candidateKey: 'candidate-b',
            maskedUsername: 'same***',
            imageUrl: '/profile-b',
        });
        list = appendScreenedCandidate(list, {
            candidateKey: 'candidate-a',
            maskedUsername: 'same***',
            imageUrl: '/profile-a',
            feedImageUrls: ['/feed-a-1', '/feed-a-2'],
        });

        expect(list).toEqual([
            {
                candidateKey: 'candidate-b',
                username: 'same***',
                occurrence: 2,
                imageUrl: '/profile-b',
                feedImageUrls: [],
            },
            {
                candidateKey: 'candidate-a',
                username: 'same***',
                occurrence: 1,
                imageUrl: '/profile-a',
                feedImageUrls: ['/feed-a-1', '/feed-a-2'],
            },
        ]);
    });

    it('moves an exact nonadjacent keyed heartbeat without changing its occurrence', () => {
        const activeA = {
            candidateKey: 'candidate-a',
            maskedUsername: 'a***',
            imageUrl: '/profile-a',
            feedImageUrls: ['/feed-a'],
        };
        let list = appendScreenedCandidate([], activeA);
        list = appendScreenedCandidate(list, {
            candidateKey: 'candidate-b',
            maskedUsername: 'b***',
            imageUrl: '/profile-b',
        });
        list = appendScreenedCandidate(list, activeA);

        expect(list.map(item => ({ key: item.candidateKey, occurrence: item.occurrence })))
            .toEqual([
                { key: 'candidate-b', occurrence: 2 },
                { key: 'candidate-a', occurrence: 1 },
            ]);
    });

    it('includes the opaque candidate key in the heartbeat snapshot identity', () => {
        const shared = { maskedUsername: 'same***', imageUrl: '/profile' };

        expect(activeCandidateMediaKey({ ...shared, candidateKey: 'candidate-a' }))
            .not.toBe(activeCandidateMediaKey({ ...shared, candidateKey: 'candidate-b' }));
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

    it('accepts a refreshed profile while preserving richer existing feeds', () => {
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

        expect(partialRetry).toEqual([{
            username: 'a***',
            occurrence: 1,
            imageUrl: '/profile-refreshed',
            feedImageUrls: ['/feed-1', '/feed-2', '/feed-3'],
        }]);
    });

    it('accepts richer feeds while preserving an existing profile', () => {
        const profileOnly = appendScreenedCandidate([], {
            maskedUsername: 'a***',
            imageUrl: '/profile',
        });
        const richerFeeds = appendScreenedCandidate(profileOnly, {
            maskedUsername: 'a***',
            imageUrl: null,
            feedImageUrls: ['/feed-1', '/feed-2'],
        });

        expect(richerFeeds).toEqual([{
            username: 'a***',
            occurrence: 1,
            imageUrl: '/profile',
            feedImageUrls: ['/feed-1', '/feed-2'],
        }]);
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
            occurrence: 1,
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
        expect(list.map(f => f.occurrence)).toEqual([1, 2, 3]);
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
        expect(list.at(0)?.occurrence).toBe(6);
        expect(list.at(-1)?.occurrence).toBe(MAX_SCREENED_CANDIDATES + 5);
    });

    it('keeps survivor occurrences and object identity stable across cap eviction', () => {
        let list: readonly ScreenedCandidate[] = [];
        for (let n = 1; n <= MAX_SCREENED_CANDIDATES; n += 1) {
            list = appendScreenedCandidate(list, {
                candidateKey: `candidate-${n}`,
                maskedUsername: 'same***',
                imageUrl: `/profile-${n}`,
            });
        }
        const survivor = list[1];
        list = appendScreenedCandidate(list, {
            candidateKey: 'candidate-revisit',
            maskedUsername: 'same***',
            imageUrl: '/profile-revisit',
        });

        expect(list[0]).toBe(survivor);
        expect(list[0]?.occurrence).toBe(2);
        expect(list.at(-1)?.occurrence).toBe(MAX_SCREENED_CANDIDATES + 1);
    });

    it('keeps a profile fallback before feed images when the profile image is absent', () => {
        const list = appendScreenedCandidate([], {
            maskedUsername: 'a***',
            imageUrl: null,
            feedImageUrls: ['/feed-1', '/feed-2', '/feed-3', '/feed-4'],
        });
        expect(list).toEqual([{
            username: 'a***',
            occurrence: 1,
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
            occurrence: 1,
            imageUrl: null,
            feedImageUrls: [],
        }]);
    });
});

describe('screened candidate presentation keys and drift', () => {
    it('separates rail copies and nonadjacent occurrences without changing survivor keys', () => {
        const survivorKey = candidateCopyKey(7, 0);

        expect(candidateCopyKey(7, 0)).toBe(survivorKey);
        expect(candidateCopyKey(7, 1)).not.toBe(survivorKey);
        expect(candidateCopyKey(8, 0)).not.toBe(survivorKey);
    });

    it('changes a tile key when its safe image source is refreshed', () => {
        const oldKey = candidateTileKey(7, 1, 0, '/api/image-proxy?token=old');
        const newKey = candidateTileKey(7, 1, 0, '/api/image-proxy?token=new');

        expect(newKey).not.toBe(oldKey);
        expect(candidateTileKey(7, 1, 0, '/api/image-proxy?token=old')).toBe(oldKey);
    });

    it('measures copy starts and wraps without relying on total scroll width', () => {
        const distance = progressCopyDistance(20, 300);

        expect(distance).toBe(280);
        expect(nextDriftOffset(270, 26, distance)).toBe(16);
        expect(nextDriftOffset(20, 10, 0)).toBe(20);
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
