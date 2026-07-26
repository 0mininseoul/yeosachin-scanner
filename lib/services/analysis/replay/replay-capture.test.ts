import { describe, expect, it, vi } from 'vitest';
import { captureAnalysisV2ReplayBundle } from './replay-capture';

const profile = {
    username: 'target', fullName: 'Target', bio: 'bio', followersCount: 1, followingCount: 1, postsCount: 1,
    isPrivate: false, isVerified: false, profilePicUrl: 'https://cdninstagram.com/profile.jpg',
    latestPosts: [{ id: 'post1', shortCode: 'post1', type: 'image' as const, imageUrl: 'https://cdninstagram.com/post.jpg', likesCount: 0, commentsCount: 0, timestamp: '2026-07-27T00:00:00.000Z', taggedUsers: [], mentionedUsers: [] }],
};

describe('analysis V2 replay capture', () => {
    it('requires an exact completed Standard V2 request and canonical current media selection with no missing JPEG', async () => {
        const normalize = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        const bundle = await captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedStandardV2Exact: async () => ({ requestFingerprint: 'a'.repeat(64), plan: 'standard', pipelineVersion: 'v2', completed: true }),
                loadReplaySource: async () => ({ profiles: [profile], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] }, providerRuns: [] }),
            },
            normalizeMedia: normalize,
            now: Date.parse('2026-07-27T00:00:00.000Z'),
        });
        expect(bundle.profiles[0]?.media.map(item => item.selectionId)).toEqual(expect.arrayContaining([
            expect.stringMatching(/^profile:/), expect.stringMatching(/^post:/),
        ]));
        expect(normalize).toHaveBeenCalledTimes(2);
    });

    it('fails closed rather than silently downgrading incomplete media or an ineligible request', async () => {
        await expect(captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedStandardV2Exact: async () => ({ requestFingerprint: 'a'.repeat(64), plan: 'basic', pipelineVersion: 'v2', completed: true }),
                loadReplaySource: async () => { throw new Error('must not load'); },
            }, normalizeMedia: async () => Buffer.alloc(0),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_REQUEST_INELIGIBLE');
        await expect(captureAnalysisV2ReplayBundle({
            selector: { targetUsername: 'target' },
            repository: {
                findCompletedStandardV2Exact: async () => ({ requestFingerprint: 'a'.repeat(64), plan: 'standard', pipelineVersion: 'v2', completed: true }),
                loadReplaySource: async () => ({ profiles: [profile], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] }, providerRuns: [] }),
            }, normalizeMedia: async () => Buffer.alloc(0),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_MEDIA_INVALID');
    });
});
