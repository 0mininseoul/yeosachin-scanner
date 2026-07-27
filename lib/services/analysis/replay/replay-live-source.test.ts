import { describe, expect, it, vi } from 'vitest';
import { APIFY_PROFILE_ACTOR_ID, APIFY_RELATIONSHIP_ACTOR_ID } from '@/lib/services/instagram/providers/apify';
import { APIFY_COMMENTS_ACTOR_ID, APIFY_LIKERS_ACTOR_ID } from '@/lib/services/instagram/providers/apify-interactions';
import { loadReplaySourceFromExistingRuns } from './replay-live-source';
import type { ReplayReadonlyApifyClient } from './replay-readonly-apify';
import type { ReplayCaptureDescriptor } from './replay-supabase-repository';

function posts(prefix: string) {
    return Array.from({ length: 8 }, (_, index) => ({
        id: `${prefix}-id-${index}`, shortCode: `${prefix}${String(index).padStart(5, '0')}`,
        caption: `caption ${index}`, displayUrl: `https://scontent.cdninstagram.com/${prefix}-${index}.jpg`,
        type: 'Image', likesCount: 1, commentsCount: 0,
        timestamp: `2026-07-${String(20 - index).padStart(2, '0')}T00:00:00.000Z`,
        mentions: [], taggedUsers: [],
    }));
}

function profile(username: string, prefix: string) {
    return {
        username, fullName: username, biography: 'bio', externalUrl: null,
        profilePicUrl: `https://scontent.cdninstagram.com/${prefix}-profile.jpg`,
        followersCount: 10, followsCount: 10, postsCount: 8, private: false,
        verified: false, latestPosts: posts(prefix),
    };
}

function run(operationKey: string, runId: string, actorId = 'actor/name') {
    return { actorId, credentialSlot: 'secondary', runId, status: 'succeeded' as const, operationKey };
}

describe('live replay source mapping', () => {
    it('maps every paginated existing Actor dataset with shared duplicate-read state', async () => {
        const targetPosts = posts('target');
        const candidatePosts = posts('canddd');
        const datasets: Record<string, unknown[]> = {
            RUNPROF1: [profile('target', 'target')],
            RUNPROF2: [profile('candidate', 'canddd')],
            RUNFOLL1: [{ username_scrape: 'target', type: 'Followers', id: '1', username: 'candidate', full_name: 'Candidate', is_private: false, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/candidate.jpg' }],
            RUNFOLL2: [{ username_scrape: 'target', type: 'Following', id: '1', username: 'candidate', full_name: 'Candidate', is_private: false, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/candidate.jpg' }],
            RUNLIKE1: [{ full_name: 'Candidate', id: '11', is_private: false, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/candidate.jpg', username: 'candidate', liked_post: `https://www.instagram.com/p/${targetPosts[0]!.shortCode}/`, total_likes: 1 }],
            RUNCOMM1: [{
                postUrl: `https://www.instagram.com/p/${targetPosts[0]!.shortCode}/`,
                commentUrl: `https://www.instagram.com/p/${targetPosts[0]!.shortCode}/c/comment-1/`,
                id: 'comment-1',
                text: '  <b>hello</b> \u0000 replay  ',
                ownerUsername: 'candidate',
                ownerProfilePicUrl: 'https://scontent.cdninstagram.com/candidate.jpg',
                timestamp: '2026-07-20T01:02:03.000Z',
                likesCount: 0,
                replies: [],
            }],
            RUNREVR1: [{ full_name: 'Target', id: '12', is_private: false, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/target.jpg', username: 'target', liked_post: `https://www.instagram.com/p/${candidatePosts[0]!.shortCode}/`, total_likes: 1 }],
        };
        const runActor: Record<string, string> = {};
        const descriptor: ReplayCaptureDescriptor = {
            requestId: '10000000-0000-4000-8000-000000000001',
            preflightId: '20000000-0000-4000-8000-000000000001',
            requestFingerprint: 'a'.repeat(64), targetUsername: 'replay_0123456789abcdef0123456',
            sourceLineage: {
                selectedPlanId: 'standard',
                policyVersions: {
                    pipeline: 'v2',
                    risk: 'risk-policy-v2.3',
                    aiStage: 'ai-stage-policy-v2.7',
                },
            },
            target: { fullName: null, bio: null, profileImageUrl: null, followersCount: 10, followingCount: 10 },
            preflightRuns: [run('target-profile-fallback', 'RUNPROF1', APIFY_PROFILE_ACTOR_ID)],
            providerRuns: [
                run(`profile-fallback:${'a'.repeat(64)}`, 'RUNPROF2', APIFY_PROFILE_ACTOR_ID),
                run(`relationship-followers:${'b'.repeat(64)}`, 'RUNFOLL1', APIFY_RELATIONSHIP_ACTOR_ID),
                run(`relationship-following:${'c'.repeat(64)}`, 'RUNFOLL2', APIFY_RELATIONSHIP_ACTOR_ID),
                run(`target-likers:${'d'.repeat(64)}`, 'RUNLIKE1', APIFY_LIKERS_ACTOR_ID),
                run(`target-comments:${'e'.repeat(64)}`, 'RUNCOMM1', APIFY_COMMENTS_ACTOR_ID),
                run(`candidate-likers:${'f'.repeat(64)}`, 'RUNREVR1', APIFY_LIKERS_ACTOR_ID),
            ],
        };
        for (const item of [...descriptor.preflightRuns, ...descriptor.providerRuns]) runActor[item.runId] = 'canonicalActorId';
        const listItems = vi.fn(async (datasetId: string, input: { offset: number; limit: number }) => {
            const items = datasets[datasetId.slice(1)] ?? [];
            const page = items.slice(input.offset, input.offset + 1);
            return { offset: input.offset, count: page.length, total: items.length, items: page };
        });
        const client: ReplayReadonlyApifyClient = {
            resolveActorId: async () => 'canonicalActorId',
            run: runId => ({ get: async () => ({ id: runId, actId: runActor[runId], status: 'SUCCEEDED', defaultDatasetId: `D${runId}` }) }),
            dataset: datasetId => ({ listItems: input => listItems(datasetId, input) }),
        };

        const source = await loadReplaySourceFromExistingRuns({ descriptor, clientForSlot: () => client });
        expect(source.profiles).toHaveLength(1);
        expect(source.profiles[0]?.username).toBe('candidate');
        expect(source.evidence.targetInteractions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                actorUsername: 'candidate',
                postId: targetPosts[0]!.id,
                signal: 'target_post_like',
            }),
            expect.objectContaining({
                actorUsername: 'candidate',
                postId: targetPosts[0]!.id,
                signal: 'target_post_comment',
                content: 'hello replay',
            }),
        ]));
        expect(source.evidence.reverseInteractions).toEqual([
            expect.objectContaining({ candidateUsername: 'candidate', status: 'observed' }),
        ]);
        expect(listItems).toHaveBeenCalled();
    });

    it('fails before reading a dataset when an operation or Actor identity is not production-exact', async () => {
        const descriptor = {
            requestId: '10000000-0000-4000-8000-000000000001',
            preflightId: '20000000-0000-4000-8000-000000000001',
            requestFingerprint: 'a'.repeat(64),
            targetUsername: 'target',
            sourceLineage: {
                selectedPlanId: 'standard' as const,
                policyVersions: {
                    pipeline: 'v2' as const,
                    risk: 'risk-policy-v2.4' as const,
                    aiStage: 'ai-stage-policy-v2.7' as const,
                },
            },
            target: {
                fullName: null,
                bio: null,
                profileImageUrl: null,
                followersCount: 1,
                followingCount: 1,
            },
            preflightRuns: [],
            providerRuns: [run(`unexpected-operation:${'a'.repeat(64)}`, 'RUNBAD01', APIFY_PROFILE_ACTOR_ID)],
        };
        const get = vi.fn();
        const client: ReplayReadonlyApifyClient = {
            resolveActorId: async () => 'canonicalActorId',
            run: () => ({ get }),
            dataset: () => ({ listItems: vi.fn() }),
        };

        await expect(loadReplaySourceFromExistingRuns({
            descriptor,
            clientForSlot: () => client,
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_PROVIDER_IDENTITY_MISMATCH');
        expect(get).not.toHaveBeenCalled();
    });

    it('fails closed instead of benchmarking only the Apify fallback subset', async () => {
        const datasets: Record<string, unknown[]> = {
            RUNPROF1: [profile('target', 'target')],
            RUNPROF2: [profile('fallback_only', 'fallbk')],
            RUNFOLL1: [
                { username_scrape: 'target', type: 'Followers', id: '1', username: 'fallback_only', full_name: 'Fallback', is_private: false, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/fallback.jpg' },
                { username_scrape: 'target', type: 'Followers', id: '2', username: 'selfhosted_only', full_name: 'Selfhosted', is_private: false, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/selfhosted.jpg' },
            ],
            RUNFOLL2: [
                { username_scrape: 'target', type: 'Following', id: '1', username: 'fallback_only', full_name: 'Fallback', is_private: false, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/fallback.jpg' },
                { username_scrape: 'target', type: 'Following', id: '2', username: 'selfhosted_only', full_name: 'Selfhosted', is_private: false, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/selfhosted.jpg' },
            ],
            RUNLIKE1: [],
            RUNCOMM1: [],
        };
        const descriptor: ReplayCaptureDescriptor = {
            requestId: '10000000-0000-4000-8000-000000000001',
            preflightId: '20000000-0000-4000-8000-000000000001',
            requestFingerprint: 'a'.repeat(64),
            targetUsername: 'target',
            sourceLineage: {
                selectedPlanId: 'standard',
                policyVersions: {
                    pipeline: 'v2',
                    risk: 'risk-policy-v2.4',
                    aiStage: 'ai-stage-policy-v2.7',
                },
            },
            target: {
                fullName: null,
                bio: null,
                profileImageUrl: null,
                followersCount: 2,
                followingCount: 2,
            },
            preflightRuns: [run('target-profile-fallback', 'RUNPROF1', APIFY_PROFILE_ACTOR_ID)],
            providerRuns: [
                run(`profile-fallback:${'a'.repeat(64)}`, 'RUNPROF2', APIFY_PROFILE_ACTOR_ID),
                run(`relationship-followers:${'b'.repeat(64)}`, 'RUNFOLL1', APIFY_RELATIONSHIP_ACTOR_ID),
                run(`relationship-following:${'c'.repeat(64)}`, 'RUNFOLL2', APIFY_RELATIONSHIP_ACTOR_ID),
                run(`target-likers:${'d'.repeat(64)}`, 'RUNLIKE1', APIFY_LIKERS_ACTOR_ID),
                run(`target-comments:${'e'.repeat(64)}`, 'RUNCOMM1', APIFY_COMMENTS_ACTOR_ID),
            ],
        };
        const actors = new Map(
            [...descriptor.preflightRuns, ...descriptor.providerRuns]
                .map(item => [item.runId, 'canonicalActorId']),
        );
        const client: ReplayReadonlyApifyClient = {
            resolveActorId: async () => 'canonicalActorId',
            run: runId => ({
                get: async () => ({
                    id: runId,
                    actId: actors.get(runId),
                    status: 'SUCCEEDED',
                    defaultDatasetId: `D${runId}`,
                }),
            }),
            dataset: datasetId => ({
                listItems: async ({ offset, limit }) => {
                    const items = datasets[datasetId.slice(1)] ?? [];
                    const page = items.slice(offset, offset + limit);
                    return {
                        offset,
                        count: page.length,
                        total: items.length,
                        items: page,
                    };
                },
            }),
        };

        await expect(loadReplaySourceFromExistingRuns({
            descriptor,
            clientForSlot: () => client,
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_EXACT_PUBLIC_COVERAGE_INCOMPLETE');
    });
});
