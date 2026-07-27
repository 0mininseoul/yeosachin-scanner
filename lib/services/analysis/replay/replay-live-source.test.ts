import { describe, expect, it, vi } from 'vitest';
import { APIFY_PROFILE_ACTOR_ID, APIFY_RELATIONSHIP_ACTOR_ID } from '@/lib/services/instagram/providers/apify';
import { APIFY_COMMENTS_ACTOR_ID, APIFY_LIKERS_ACTOR_ID } from '@/lib/services/instagram/providers/apify-interactions';
import { REPLACEMENT_PROFILE_ACTOR } from '@/lib/services/instagram/providers/apify-profile-details';
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

function repairReplayScenario(
    repairItems: (input: { repaired: string; unavailable: string }) => unknown[],
) {
    const candidates = Array.from({ length: 10 }, (_, index) => `candidate${index}`);
    const repaired = candidates.at(-2)!;
    const unavailable = candidates.at(-1)!;
    const datasets: Record<string, unknown[]> = {
        RUNPROF1: [profile('target', 'target')],
        RUNPROF2: candidates.map((username, index) => (
            username === repaired || username === unavailable
                ? { ...profile(username, `cand${index}`), latestPosts: [] }
                : profile(username, `cand${index}`)
        )),
        RUNREPAIR: repairItems({ repaired, unavailable }),
        RUNFOLL1: candidates.map((username, index) => ({ username_scrape: 'target', type: 'Followers', id: String(index + 1), username, full_name: username, is_private: false, is_verified: false, profile_pic_url: `https://scontent.cdninstagram.com/${username}.jpg` })),
        RUNFOLL2: candidates.map((username, index) => ({ username_scrape: 'target', type: 'Following', id: String(index + 1), username, full_name: username, is_private: false, is_verified: false, profile_pic_url: `https://scontent.cdninstagram.com/${username}.jpg` })),
        RUNLIKE1: [],
        RUNCOMM1: [],
    };
    const descriptor: ReplayCaptureDescriptor = {
        requestId: '10000000-0000-4000-8000-000000000001',
        preflightId: '20000000-0000-4000-8000-000000000001',
        requestFingerprint: 'a'.repeat(64), targetUsername: 'target',
        sourceLineage: { selectedPlanId: 'standard', policyVersions: { pipeline: 'v2', risk: 'risk-policy-v2.3', aiStage: 'ai-stage-policy-v2.7' } },
        target: { fullName: null, bio: null, profileImageUrl: null, followersCount: 10, followingCount: 10 },
        preflightRuns: [run('target-profile-fallback', 'RUNPROF1', APIFY_PROFILE_ACTOR_ID)],
        providerRuns: [
            run(`profile-fallback:${'a'.repeat(64)}`, 'RUNPROF2', APIFY_PROFILE_ACTOR_ID),
            run(`profile-repair:${'b'.repeat(64)}`, 'RUNREPAIR', REPLACEMENT_PROFILE_ACTOR.actorId),
            run(`relationship-followers:${'c'.repeat(64)}`, 'RUNFOLL1', APIFY_RELATIONSHIP_ACTOR_ID),
            run(`relationship-following:${'d'.repeat(64)}`, 'RUNFOLL2', APIFY_RELATIONSHIP_ACTOR_ID),
            run(`target-likers:${'e'.repeat(64)}`, 'RUNLIKE1', APIFY_LIKERS_ACTOR_ID),
            run(`target-comments:${'f'.repeat(64)}`, 'RUNCOMM1', APIFY_COMMENTS_ACTOR_ID),
        ],
    };
    const actors = new Map([...descriptor.preflightRuns, ...descriptor.providerRuns].map(item => [item.runId, 'canonicalActorId']));
    const client: ReplayReadonlyApifyClient = {
        resolveActorId: async () => 'canonicalActorId',
        run: runId => ({ get: async () => ({ id: runId, actId: actors.get(runId), status: 'SUCCEEDED', defaultDatasetId: `D${runId}` }) }),
        dataset: datasetId => ({ listItems: async ({ offset, limit }) => {
            const items = datasets[datasetId.slice(1)] ?? [];
            const page = items.slice(offset, offset + limit);
            return { offset, count: page.length, total: items.length, items: page };
        } }),
    };
    return { candidates, repaired, unavailable, descriptor, client };
}

describe('live replay source mapping', () => {
    it('maps every paginated existing Actor dataset with shared duplicate-read state', async () => {
        const targetPosts = posts('target');
        const candidatePosts = posts('canddd');
        const datasets: Record<string, unknown[]> = {
            RUNPROF1: [profile('target', 'target'), profile('extra_profile', 'extra')],
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
            requestFingerprint: 'a'.repeat(64), targetUsername: 'target',
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

    it('derives the real target only for an explicit opaque historical descriptor', async () => {
        const datasets: Record<string, unknown[]> = {
            RUNHIST1: [profile('target', 'target')],
            RUNHIST2: [{ username_scrape: 'target', type: 'Followers', id: '1', username: 'private_candidate', full_name: 'Private', is_private: true, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/private.jpg' }],
            RUNHIST3: [{ username_scrape: 'target', type: 'Following', id: '1', username: 'private_candidate', full_name: 'Private', is_private: true, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/private.jpg' }],
            RUNHIST4: [],
            RUNHIST5: [],
        };
        const descriptor = {
            requestId: '10000000-0000-4000-8000-000000000001',
            preflightId: '20000000-0000-4000-8000-000000000001',
            requestFingerprint: 'a'.repeat(64),
            targetUsername: 'replay_0123456789abcdef0123456',
            targetResolution: 'provider_ledger' as const,
            sourceLineage: {
                selectedPlanId: 'standard' as const,
                policyVersions: { pipeline: 'v2' as const, risk: 'risk-policy-v2.3' as const, aiStage: 'ai-stage-policy-v2.7' as const },
            },
            target: { fullName: null, bio: null, profileImageUrl: null, followersCount: 1, followingCount: 1 },
            preflightRuns: [run('target-profile-fallback', 'RUNHIST1', APIFY_PROFILE_ACTOR_ID)],
            providerRuns: [
                run(`relationship-followers:${'a'.repeat(64)}`, 'RUNHIST2', APIFY_RELATIONSHIP_ACTOR_ID),
                run(`relationship-following:${'b'.repeat(64)}`, 'RUNHIST3', APIFY_RELATIONSHIP_ACTOR_ID),
                run(`target-likers:${'c'.repeat(64)}`, 'RUNHIST4', APIFY_LIKERS_ACTOR_ID),
                run(`target-comments:${'d'.repeat(64)}`, 'RUNHIST5', APIFY_COMMENTS_ACTOR_ID),
            ],
        };
        const actors = new Map(
            [...descriptor.preflightRuns, ...descriptor.providerRuns]
                .map(item => [item.runId, 'canonicalActorId']),
        );
        const client: ReplayReadonlyApifyClient = {
            resolveActorId: async () => 'canonicalActorId',
            run: runId => ({ get: async () => ({ id: runId, actId: actors.get(runId), status: 'SUCCEEDED', defaultDatasetId: `D${runId}` }) }),
            dataset: datasetId => ({ listItems: async ({ offset, limit }) => {
                const items = datasets[datasetId.slice(1)] ?? [];
                const page = items.slice(offset, offset + limit);
                return { offset, count: page.length, total: items.length, items: page };
            } }),
        };

        await expect(loadReplaySourceFromExistingRuns({
            descriptor,
            clientForSlot: () => client,
        })).resolves.toMatchObject({
            profiles: [expect.objectContaining({ username: 'private_candidate' })],
        });
    });

    it('uses the latest fresh-admission target snapshot instead of an older fallback snapshot for an opaque historical descriptor', async () => {
        const freshPosts = posts('fresh');
        const datasets: Record<string, unknown[]> = {
            RUNOLD01: [profile('target', 'older')],
            RUNFRESH: [{ ...profile('target', 'fresh'), latestPosts: freshPosts }],
            RUNHIST2: [{ username_scrape: 'target', type: 'Followers', id: '1', username: 'private_candidate', full_name: 'Private', is_private: true, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/private.jpg' }],
            RUNHIST3: [{ username_scrape: 'target', type: 'Following', id: '1', username: 'private_candidate', full_name: 'Private', is_private: true, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/private.jpg' }],
            RUNHIST4: [{ full_name: 'Private', id: '11', is_private: true, is_verified: false, profile_pic_url: 'https://scontent.cdninstagram.com/private.jpg', username: 'private_candidate', liked_post: `https://www.instagram.com/p/${freshPosts[0]!.shortCode}/`, total_likes: 1 }],
            RUNHIST5: [],
        };
        const descriptor = {
            requestId: '10000000-0000-4000-8000-000000000001',
            preflightId: '20000000-0000-4000-8000-000000000001',
            requestFingerprint: 'a'.repeat(64),
            targetUsername: 'replay_0123456789abcdef0123456',
            targetResolution: 'provider_ledger' as const,
            sourceLineage: {
                selectedPlanId: 'standard' as const,
                policyVersions: { pipeline: 'v2' as const, risk: 'risk-policy-v2.3' as const, aiStage: 'ai-stage-policy-v2.7' as const },
            },
            target: { fullName: null, bio: null, profileImageUrl: null, followersCount: 1, followingCount: 1 },
            preflightRuns: [
                run('target-profile-fallback', 'RUNOLD01', APIFY_PROFILE_ACTOR_ID),
                run('target-profile-fresh-admission:g4', 'RUNFRESH', APIFY_PROFILE_ACTOR_ID),
            ],
            providerRuns: [
                run(`relationship-followers:${'a'.repeat(64)}`, 'RUNHIST2', APIFY_RELATIONSHIP_ACTOR_ID),
                run(`relationship-following:${'b'.repeat(64)}`, 'RUNHIST3', APIFY_RELATIONSHIP_ACTOR_ID),
                run(`target-likers:${'c'.repeat(64)}`, 'RUNHIST4', APIFY_LIKERS_ACTOR_ID),
                run(`target-comments:${'d'.repeat(64)}`, 'RUNHIST5', APIFY_COMMENTS_ACTOR_ID),
            ],
        };
        const actors = new Map(
            [...descriptor.preflightRuns, ...descriptor.providerRuns]
                .map(item => [item.runId, 'canonicalActorId']),
        );
        const client: ReplayReadonlyApifyClient = {
            resolveActorId: async () => 'canonicalActorId',
            run: runId => ({ get: async () => ({ id: runId, actId: actors.get(runId), status: 'SUCCEEDED', defaultDatasetId: `D${runId}` }) }),
            dataset: datasetId => ({ listItems: async ({ offset, limit }) => {
                const items = datasets[datasetId.slice(1)] ?? [];
                const page = items.slice(offset, offset + limit);
                return { offset, count: page.length, total: items.length, items: page };
            } }),
        };

        await expect(loadReplaySourceFromExistingRuns({
            descriptor,
            clientForSlot: () => client,
        })).resolves.toMatchObject({
            evidence: {
                targetInteractions: [expect.objectContaining({
                    postId: freshPosts[0]!.id,
                    actorUsername: 'private_candidate',
                })],
            },
        });
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

    it('keeps a production-allowed terminal profile failure out of the replay AI workload', async () => {
        const candidates = Array.from({ length: 10 }, (_, index) => `candidate${index}`);
        const unavailable = candidates.at(-1)!;
        const datasets: Record<string, unknown[]> = {
            RUNPROF1: [profile('target', 'target')],
            RUNPROF2: candidates.map((username, index) => (
                username === unavailable
                    ? { ...profile(username, `cand${index}`), latestPosts: [] }
                    : profile(username, `cand${index}`)
            )),
            RUNFOLL1: candidates.map((username, index) => ({ username_scrape: 'target', type: 'Followers', id: String(index + 1), username, full_name: username, is_private: false, is_verified: false, profile_pic_url: `https://scontent.cdninstagram.com/${username}.jpg` })),
            RUNFOLL2: candidates.map((username, index) => ({ username_scrape: 'target', type: 'Following', id: String(index + 1), username, full_name: username, is_private: false, is_verified: false, profile_pic_url: `https://scontent.cdninstagram.com/${username}.jpg` })),
            RUNLIKE1: [],
            RUNCOMM1: [],
        };
        const descriptor: ReplayCaptureDescriptor = {
            requestId: '10000000-0000-4000-8000-000000000001',
            preflightId: '20000000-0000-4000-8000-000000000001',
            requestFingerprint: 'a'.repeat(64), targetUsername: 'target',
            sourceLineage: { selectedPlanId: 'standard', policyVersions: { pipeline: 'v2', risk: 'risk-policy-v2.3', aiStage: 'ai-stage-policy-v2.7' } },
            target: { fullName: null, bio: null, profileImageUrl: null, followersCount: 10, followingCount: 10 },
            preflightRuns: [run('target-profile-fallback', 'RUNPROF1', APIFY_PROFILE_ACTOR_ID)],
            providerRuns: [
                run(`profile-fallback:${'a'.repeat(64)}`, 'RUNPROF2', APIFY_PROFILE_ACTOR_ID),
                run(`relationship-followers:${'b'.repeat(64)}`, 'RUNFOLL1', APIFY_RELATIONSHIP_ACTOR_ID),
                run(`relationship-following:${'c'.repeat(64)}`, 'RUNFOLL2', APIFY_RELATIONSHIP_ACTOR_ID),
                run(`target-likers:${'d'.repeat(64)}`, 'RUNLIKE1', APIFY_LIKERS_ACTOR_ID),
                run(`target-comments:${'e'.repeat(64)}`, 'RUNCOMM1', APIFY_COMMENTS_ACTOR_ID),
            ],
        };
        const actors = new Map([...descriptor.preflightRuns, ...descriptor.providerRuns].map(item => [item.runId, 'canonicalActorId']));
        const client: ReplayReadonlyApifyClient = {
            resolveActorId: async () => 'canonicalActorId',
            run: runId => ({ get: async () => ({ id: runId, actId: actors.get(runId), status: 'SUCCEEDED', defaultDatasetId: `D${runId}` }) }),
            dataset: datasetId => ({ listItems: async ({ offset, limit }) => {
                const items = datasets[datasetId.slice(1)] ?? [];
                const page = items.slice(offset, offset + limit);
                return { offset, count: page.length, total: items.length, items: page };
            } }),
        };

        await expect(loadReplaySourceFromExistingRuns({ descriptor, clientForSlot: () => client }))
            .resolves.toMatchObject({
                profiles: expect.arrayContaining([
                    expect.objectContaining({ username: candidates[0] }),
                ]),
            });
        const source = await loadReplaySourceFromExistingRuns({ descriptor, clientForSlot: () => client });
        expect(source.profiles).toHaveLength(9);
        expect(source.profiles.some(item => item.username === unavailable)).toBe(false);
    });

    it('reconstructs an omitted repair row as a terminal incomplete outcome before applying the 90 percent floor', async () => {
        const { repaired, unavailable, descriptor, client } = repairReplayScenario(
            input => [profile(input.repaired, 'repair')],
        );

        const source = await loadReplaySourceFromExistingRuns({ descriptor, clientForSlot: () => client });
        expect(source.profiles).toHaveLength(9);
        expect(source.profiles.some(item => item.username === repaired)).toBe(true);
        expect(source.profiles.some(item => item.username === unavailable)).toBe(false);
    });

    it('accepts a canonically attributed Actor-error repair row without a username field', async () => {
        const { unavailable, descriptor, client } = repairReplayScenario(input => [
            profile(input.repaired, 'repair'),
            {
                inputUrl: `https://www.instagram.com/${input.unavailable}/`,
                error: 'Synthetic Actor failure',
            },
        ]);

        const source = await loadReplaySourceFromExistingRuns({ descriptor, clientForSlot: () => client });
        expect(source.profiles).toHaveLength(9);
        expect(source.profiles.some(item => item.username === unavailable)).toBe(false);
    });

    it('maps reversed repair Actor output back to the fallback requested order', async () => {
        const { repaired, unavailable, descriptor, client } = repairReplayScenario(input => [
            profile(input.unavailable, 'repair-unavailable'),
            profile(input.repaired, 'repair-repaired'),
        ]);

        const source = await loadReplaySourceFromExistingRuns({ descriptor, clientForSlot: () => client });
        expect(source.profiles).toHaveLength(10);
        expect(source.profiles.some(item => item.username === repaired)).toBe(true);
        expect(source.profiles.some(item => item.username === unavailable)).toBe(true);
    });

    it('rejects a repair run that mixes failed usernames from two fallback batches', async () => {
        const firstBatch = Array.from({ length: 10 }, (_, index) => `first${index}`);
        const secondBatch = Array.from({ length: 10 }, (_, index) => `second${index}`);
        const firstFailures = firstBatch.slice(-2);
        const secondFailures = secondBatch.slice(-2);
        const invalid = (username: string, prefix: string) => ({
            ...profile(username, prefix), latestPosts: [],
        });
        const relationshipRows = [...firstBatch, ...secondBatch].map((username, index) => ({
            username_scrape: 'target', type: 'Followers', id: String(index + 1), username,
            full_name: username, is_private: false, is_verified: false,
            profile_pic_url: `https://scontent.cdninstagram.com/${username}.jpg`,
        }));
        const datasets: Record<string, unknown[]> = {
            RUNPROF1: [profile('target', 'target')],
            RUNPROFA: firstBatch.map((username, index) => (
                firstFailures.includes(username) ? invalid(username, `first${index}`) : profile(username, `first${index}`)
            )),
            RUNPROFB: secondBatch.map((username, index) => (
                secondFailures.includes(username) ? invalid(username, `second${index}`) : profile(username, `second${index}`)
            )),
            RUNREPAIR: [profile(firstFailures[0]!, 'repair-first'), profile(secondFailures[0]!, 'repair-second')],
            RUNFOLL1: relationshipRows,
            RUNFOLL2: relationshipRows.map(row => ({ ...row, type: 'Following' })),
            RUNLIKE1: [],
            RUNCOMM1: [],
        };
        const descriptor: ReplayCaptureDescriptor = {
            requestId: '10000000-0000-4000-8000-000000000001',
            preflightId: '20000000-0000-4000-8000-000000000001',
            requestFingerprint: 'a'.repeat(64), targetUsername: 'target',
            sourceLineage: { selectedPlanId: 'standard', policyVersions: { pipeline: 'v2', risk: 'risk-policy-v2.3', aiStage: 'ai-stage-policy-v2.7' } },
            target: { fullName: null, bio: null, profileImageUrl: null, followersCount: 20, followingCount: 20 },
            preflightRuns: [run('target-profile-fallback', 'RUNPROF1', APIFY_PROFILE_ACTOR_ID)],
            providerRuns: [
                run(`profile-fallback:${'a'.repeat(64)}`, 'RUNPROFA', APIFY_PROFILE_ACTOR_ID),
                run(`profile-fallback:${'b'.repeat(64)}`, 'RUNPROFB', APIFY_PROFILE_ACTOR_ID),
                run(`profile-repair:${'c'.repeat(64)}`, 'RUNREPAIR', REPLACEMENT_PROFILE_ACTOR.actorId),
                run(`relationship-followers:${'d'.repeat(64)}`, 'RUNFOLL1', APIFY_RELATIONSHIP_ACTOR_ID),
                run(`relationship-following:${'e'.repeat(64)}`, 'RUNFOLL2', APIFY_RELATIONSHIP_ACTOR_ID),
                run(`target-likers:${'f'.repeat(64)}`, 'RUNLIKE1', APIFY_LIKERS_ACTOR_ID),
                run(`target-comments:${'0'.repeat(64)}`, 'RUNCOMM1', APIFY_COMMENTS_ACTOR_ID),
            ],
        };
        const actors = new Map([...descriptor.preflightRuns, ...descriptor.providerRuns].map(item => [item.runId, 'canonicalActorId']));
        const client: ReplayReadonlyApifyClient = {
            resolveActorId: async () => 'canonicalActorId',
            run: runId => ({ get: async () => ({ id: runId, actId: actors.get(runId), status: 'SUCCEEDED', defaultDatasetId: `D${runId}` }) }),
            dataset: datasetId => ({ listItems: async ({ offset, limit }) => {
                const items = datasets[datasetId.slice(1)] ?? [];
                const page = items.slice(offset, offset + limit);
                return { offset, count: page.length, total: items.length, items: page };
            } }),
        };

        await expect(loadReplaySourceFromExistingRuns({ descriptor, clientForSlot: () => client }))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_PROFILE_DATASET_INVALID');
    });
});
