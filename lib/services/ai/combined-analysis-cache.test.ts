import { describe, expect, it, vi } from 'vitest';
import {
    COMBINED_ANALYSIS_CACHE_TTL_DAYS,
    createCombinedAnalysisCacheEntry,
    createCombinedProfileSnapshot,
} from './combined-cache';
import { getCachedCombinedProfileSnapshots } from './combined-analysis';

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: vi.fn() },
}));

const capturedAt = '2026-07-10T00:00:00.000Z';
const cacheEntry = createCombinedAnalysisCacheEntry(
    'test-version',
    {
        gender: 'male',
        genderConfidence: 0.9,
        genderReasoning: 'evidence',
    },
    createCombinedProfileSnapshot({
        profile: {
            username: 'alice',
            isPrivate: false,
        },
        recentPosts: [{
            id: 'alice-post-id',
            shortCode: 'Alice_123',
            type: 'image',
            likesCount: 12,
            commentsCount: 3,
            timestamp: '2026-07-09T00:00:00.000Z',
            taggedUsers: ['target.user'],
            mentionedUsers: ['mentioned.user'],
        }],
    }, capturedAt)
);

describe('combined profile snapshot batch reader', () => {
    it('returns current, fresh, username-matched snapshots from one bounded read', async () => {
        const loadRows = vi.fn(async () => [
            { instagram_username: 'alice', analysis_result: cacheEntry },
            { instagram_username: 'not-requested', analysis_result: cacheEntry },
        ]);

        const snapshots = await getCachedCombinedProfileSnapshots(['ALICE', 'bob'], {
            cacheVersion: 'test-version',
            nowMs: Date.parse(capturedAt) + 60_000,
            ttlHours: 12,
            loadRows,
        });

        expect(loadRows).toHaveBeenCalledWith(
            ['alice', 'bob'],
            new Date(
                Date.parse(capturedAt) + 60_000
                - COMBINED_ANALYSIS_CACHE_TTL_DAYS * 24 * 60 * 60 * 1_000
            ).toISOString()
        );
        expect([...snapshots.keys()]).toEqual(['alice']);
        expect(snapshots.get('alice')?.recentPosts[0]).toMatchObject({
            taggedUsers: ['target.user'],
            mentionedUsers: ['mentioned.user'],
        });
    });

    it('turns a cache database failure into a full miss', async () => {
        const snapshots = await getCachedCombinedProfileSnapshots(['alice', 'bob'], {
            cacheVersion: 'test-version',
            nowMs: Date.parse(capturedAt),
            ttlHours: 12,
            loadRows: async () => {
                throw new Error('database unavailable');
            },
        });

        expect(snapshots.size).toBe(0);
    });

    it('rejects batches over the profiles-stage limit before reading the database', async () => {
        const loadRows = vi.fn(async () => []);
        await expect(getCachedCombinedProfileSnapshots(
            Array.from({ length: 31 }, (_, index) => `user${index}`),
            { loadRows }
        )).rejects.toThrow('limited to 30');
        expect(loadRows).not.toHaveBeenCalled();
    });
});
