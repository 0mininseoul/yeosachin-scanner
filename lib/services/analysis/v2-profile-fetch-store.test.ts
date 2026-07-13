import { describe, expect, it, vi } from 'vitest';
import type { InstagramPost, InstagramProfile } from '@/lib/types/instagram';
import type { ProfileFetchOutcome } from '@/lib/domain/analysis/profile-fetch-outcome';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES,
    analysisV2ProfileFetchResumeSchema,
    createAnalysisV2ProfileFetchCheckpointStore,
    type AnalysisV2ProfileFetchSupabaseClient,
} from './v2-profile-fetch-store';

// gitleaks:allow -- UUID fixture
const requestId = '7df77338-2672-4ef2-93fe-13a0683ec9b4';
// gitleaks:allow -- UUID fixture
const claimToken = '51b42f42-204d-4dfb-86f8-9658d21c78f1';
const jobKey = 'track:profiles:batch:0';
const jobInputHash = 'a'.repeat(64);
const capturedAt = '2026-07-13T07:30:00.000Z';
const checkpointIdentity = { requestId, jobKey, claimToken, jobInputHash } as const;

function post(index: number, overrides: Partial<InstagramPost> = {}): InstagramPost {
    return {
        id: `post-${index}`,
        shortCode: `code${index}`,
        imageUrl: `https://images.example/post-${index}.jpg`,
        type: 'image',
        likesCount: index,
        commentsCount: index,
        timestamp: new Date(Date.UTC(2026, 6, 13, 7, index)).toISOString(),
        taggedUsers: [],
        mentionedUsers: [],
        ...overrides,
    };
}

function profile(username: string, postCount = 2): InstagramProfile {
    return {
        username,
        fullName: `${username} full name`,
        bio: 'bounded bio',
        profilePicUrl: `https://images.example/${username}.jpg`,
        followersCount: 100,
        followingCount: 90,
        postsCount: 20,
        isPrivate: false,
        isVerified: false,
        latestPosts: Array.from({ length: postCount }, (_, index) => post(index)),
    };
}

function outcome(input: {
    username: string;
    source?: ProfileFetchOutcome['source'];
    status: ProfileFetchOutcome['status'];
    failureCategory?: ProfileFetchOutcome['failureCategory'];
    httpStatus?: number | null;
}): ProfileFetchOutcome {
    return {
        requestedUsername: input.username,
        source: input.source ?? 'selfhosted',
        status: input.status,
        failureCategory: input.failureCategory ?? null,
        httpStatus: input.httpStatus ?? null,
        requestCount: 1,
        latencyMs: 123,
        capturedAt,
    } as ProfileFetchOutcome;
}

function primaryResults() {
    return [
        {
            outcome: outcome({ username: 'alice', source: 'cache', status: 'success' }),
            profile: profile('alice', 10),
        },
        {
            outcome: outcome({
                username: 'bob',
                status: 'failed',
                failureCategory: 'timeout',
                httpStatus: 504,
            }),
        },
    ];
}

function resume(overrides: Record<string, unknown> = {}) {
    return {
        requestId,
        jobKey,
        requestedUsernames: ['alice', 'bob'],
        frozenUnresolvedUsernames: ['bob'],
        primaryResults: [
            {
                outcome: outcome({
                    username: 'alice',
                    source: 'cache',
                    status: 'success',
                }),
                profile: profile('alice', 8),
            },
            {
                outcome: outcome({
                    username: 'bob',
                    status: 'failed',
                    failureCategory: 'timeout',
                    httpStatus: 504,
                }),
            },
        ],
        fallbackResults: [],
        primaryCapturedAt: capturedAt,
        fallbackCapturedAt: null,
        ...overrides,
    };
}

function clientWith(...responses: Array<{ data: unknown; error: null | {
    code?: string;
    message?: string;
} }>) {
    const rpc = vi.fn<(
        name: string,
        params: Record<string, unknown>
    ) => Promise<{ data: unknown; error: null | { code?: string; message?: string } }>>(
        async () => responses.shift() ?? { data: null, error: null }
    );
    return {
        rpc,
        client: { rpc } as AnalysisV2ProfileFetchSupabaseClient,
    };
}

describe('analysis V2 profile fetch checkpoint store', () => {
    it('persists one complete canonical primary set and bounds the media snapshot', async () => {
        const fake = clientWith({ data: resume(), error: null });
        const store = createAnalysisV2ProfileFetchCheckpointStore(fake.client);

        const result = await store.checkpointPrimary({
            ...checkpointIdentity,
            requestedUsernames: ['Alice', 'BOB'],
            results: primaryResults(),
        });

        expect(result.frozenUnresolvedUsernames).toEqual(['bob']);
        expect(fake.rpc).toHaveBeenCalledOnce();
        const [rpcName, params] = fake.rpc.mock.calls[0]!;
        expect(rpcName).toBe(ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.primaryRpc);
        expect(params.p_requested_usernames).toEqual(['alice', 'bob']);
        expect(params).toMatchObject({
            p_claim_token: claimToken,
            p_job_input_hash: jobInputHash,
        });
        const persistedOutcomes = params.p_outcomes;
        expect(Array.isArray(persistedOutcomes)).toBe(true);
        if (!Array.isArray(persistedOutcomes)) throw new Error('outcome fixture mismatch');
        expect(persistedOutcomes).toHaveLength(2);
        expect(persistedOutcomes[0]).toMatchObject({
            username: 'alice',
            source: 'cache',
            status: 'success',
            failure_category: null,
            http_status: null,
        });
        expect(persistedOutcomes[0].profile.latestPosts).toHaveLength(8);
        expect(persistedOutcomes[0].profile.latestPosts.map(
            (value: InstagramPost) => value.id
        )).toEqual([
            'post-9', 'post-8', 'post-7', 'post-6',
            'post-5', 'post-4', 'post-3', 'post-2',
        ]);
        expect(persistedOutcomes[1]).toMatchObject({
            username: 'bob',
            source: 'selfhosted',
            status: 'failed',
            failure_category: 'timeout',
            http_status: 504,
            profile: null,
        });
    });

    it('accepts mapper-shaped undefined optionals and preserves carousel child order', async () => {
        const mappedProfile = profile('alice', 10);
        mappedProfile.fullName = undefined;
        mappedProfile.bio = undefined;
        mappedProfile.externalUrl = undefined;
        mappedProfile.latestPosts![9] = post(9, {
            caption: undefined,
            imageUrl: undefined,
            thumbnailUrl: 'https://images.example/carousel.jpg',
            type: 'carousel',
            mediaItems: [
                { id: 'child-a', type: 'image', imageUrl: 'https://images.example/a.jpg' },
                { id: 'child-b', type: 'video', thumbnailUrl: 'https://images.example/b.jpg' },
                { id: 'child-c', type: 'image', imageUrl: 'https://images.example/c.jpg' },
            ],
            declaredMediaCount: 3,
            childrenComplete: true,
        });
        const snapshot = resume({
            requestedUsernames: ['alice'],
            frozenUnresolvedUsernames: [],
            primaryResults: [{
                outcome: outcome({ username: 'alice', status: 'success' }),
                profile: {
                    ...mappedProfile,
                    latestPosts: [mappedProfile.latestPosts![9], ...mappedProfile.latestPosts!
                        .slice(0, 7)
                        .reverse()],
                },
            }],
        });
        const fake = clientWith({ data: snapshot, error: null });
        const store = createAnalysisV2ProfileFetchCheckpointStore(fake.client);

        await store.checkpointPrimary({
            ...checkpointIdentity,
            requestedUsernames: ['alice'],
            results: [{
                outcome: outcome({ username: 'alice', status: 'success' }),
                profile: mappedProfile,
            }],
        });

        const persisted = fake.rpc.mock.calls[0]![1].p_outcomes;
        if (!Array.isArray(persisted)) throw new Error('outcome fixture mismatch');
        expect(persisted[0].profile).not.toHaveProperty('providerPayload');
        expect(persisted[0].profile.latestPosts[0].id).toBe('post-9');
        expect(persisted[0].profile.latestPosts[0].mediaItems.map(
            (item: { id?: string }) => item.id
        )).toEqual(['child-a', 'child-b', 'child-c']);
    });

    it('fails explicitly before persistence when required ordering evidence is missing', async () => {
        const invalidProfile = profile('alice');
        invalidProfile.latestPosts![0] = post(0, { timestamp: '' });
        const fake = clientWith();
        const store = createAnalysisV2ProfileFetchCheckpointStore(fake.client);

        await expect(store.checkpointPrimary({
            ...checkpointIdentity,
            requestedUsernames: ['alice'],
            results: [{
                outcome: outcome({ username: 'alice', status: 'success' }),
                profile: invalidProfile,
            }],
        })).rejects.toThrow('profile evidence is incomplete or invalid');
        expect(fake.rpc).not.toHaveBeenCalled();
    });

    it('rejects partial, duplicate, unexpected, and source-conflicting primary input', async () => {
        const fake = clientWith();
        const store = createAnalysisV2ProfileFetchCheckpointStore(fake.client);

        await expect(store.checkpointPrimary({
            ...checkpointIdentity,
            requestedUsernames: ['alice', 'bob'],
            results: primaryResults().slice(0, 1),
        })).rejects.toThrow('missing terminal outcome');
        await expect(store.checkpointPrimary({
            ...checkpointIdentity,
            requestedUsernames: ['alice', 'Alice'],
            results: primaryResults(),
        })).rejects.toThrow('duplicate requested username');
        await expect(store.checkpointPrimary({
            ...checkpointIdentity,
            requestedUsernames: ['alice'],
            results: [{
                outcome: outcome({ username: 'bob', status: 'success' }),
                profile: profile('bob'),
            }],
        })).rejects.toThrow('unexpected outcome username');
        await expect(store.checkpointPrimary({
            ...checkpointIdentity,
            requestedUsernames: ['alice'],
            results: [{
                outcome: outcome({ username: 'alice', source: 'apify', status: 'success' }),
                profile: profile('alice'),
            }],
        })).rejects.toThrow('invalid attempt source');
        expect(fake.rpc).not.toHaveBeenCalled();
    });

    it('persists incomplete media coverage as a bounded failed category', async () => {
        const incomplete = outcome({
            username: 'alice',
            status: 'failed',
            failureCategory: 'incomplete',
        });
        const snapshot = {
            requestId,
            jobKey,
            requestedUsernames: ['alice'],
            frozenUnresolvedUsernames: ['alice'],
            primaryResults: [{ outcome: incomplete }],
            fallbackResults: [],
            primaryCapturedAt: capturedAt,
            fallbackCapturedAt: null,
        };
        const fake = clientWith({ data: snapshot, error: null });
        const store = createAnalysisV2ProfileFetchCheckpointStore(fake.client);

        await expect(store.checkpointPrimary({
            ...checkpointIdentity,
            requestedUsernames: ['alice'],
            results: [{ outcome: incomplete }],
        })).resolves.toMatchObject(snapshot);
        expect(fake.rpc.mock.calls[0]![1].p_outcomes).toEqual([
            expect.objectContaining({ failure_category: 'incomplete' }),
        ]);
    });

    it('loads the frozen set before sending exactly that set to the fallback RPC', async () => {
        const fallbackResult = {
            outcome: outcome({
                username: 'bob',
                source: 'apify',
                status: 'success',
            }),
            profile: profile('bob'),
        };
        const completed = resume({
            fallbackResults: [fallbackResult],
            fallbackCapturedAt: '2026-07-13T07:31:00.000Z',
        });
        const fake = clientWith(
            { data: resume(), error: null },
            { data: completed, error: null }
        );
        const store = createAnalysisV2ProfileFetchCheckpointStore(fake.client);

        const result = await store.checkpointFallback({
            ...checkpointIdentity,
            results: [fallbackResult],
        });

        expect(result.fallbackResults).toHaveLength(1);
        expect(fake.rpc.mock.calls.map(call => call[0])).toEqual([
            ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.loadRpc,
            ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.fallbackRpc,
        ]);
        expect(fake.rpc.mock.calls[1]![1].p_outcomes).toEqual([
            expect.objectContaining({ username: 'bob', source: 'apify' }),
        ]);
    });

    it('refuses fallback work for anything except the exact frozen unresolved set', async () => {
        const fake = clientWith(
            { data: resume(), error: null },
            { data: resume(), error: null }
        );
        const store = createAnalysisV2ProfileFetchCheckpointStore(fake.client);

        await expect(store.checkpointFallback({
            ...checkpointIdentity,
            results: [{
                outcome: outcome({
                    username: 'alice',
                    source: 'apify',
                    status: 'success',
                }),
                profile: profile('alice'),
            }],
        })).rejects.toThrow('unexpected outcome username');
        await expect(store.checkpointFallback({
            ...checkpointIdentity,
            results: [{
                outcome: outcome({
                    username: 'bob',
                    source: 'selfhosted',
                    status: 'success',
                }),
                profile: profile('bob'),
            }],
        })).rejects.toThrow('invalid attempt source');
        expect(fake.rpc).toHaveBeenCalledTimes(2);
        expect(fake.rpc.mock.calls.every(call => (
            call[0] === ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.loadRpc
        ))).toBe(true);
    });

    it('fails closed on malformed resume data and exposes bounded RPC conflicts', async () => {
        expect(analysisV2ProfileFetchResumeSchema.safeParse(resume({
            frozenUnresolvedUsernames: ['alice'],
        })).success).toBe(false);
        expect(analysisV2ProfileFetchResumeSchema.safeParse(resume({
            fallbackResults: [{
                outcome: outcome({
                    username: 'bob',
                    source: 'selfhosted',
                    status: 'success',
                }),
                profile: profile('bob'),
            }],
            fallbackCapturedAt: '2026-07-13T07:31:00.000Z',
        })).success).toBe(false);

        const malformed = clientWith({ data: { requestId }, error: null });
        await expect(createAnalysisV2ProfileFetchCheckpointStore(malformed.client).load({
            ...checkpointIdentity,
        })).rejects.toThrow('invalid checkpoint load response');

        const conflict = clientWith({
            data: null,
            error: { code: 'P0001', message: 'ANALYSIS_V2_PROFILE_PRIMARY_CONFLICT' },
        });
        await expect(createAnalysisV2ProfileFetchCheckpointStore(conflict.client)
            .checkpointPrimary({
                ...checkpointIdentity,
                requestedUsernames: ['alice', 'bob'],
                results: primaryResults(),
            })).rejects.toThrow('ANALYSIS_V2_PROFILE_PRIMARY_CONFLICT');
    });

    it('does not hide a stale or different claim behind an idempotent replay', async () => {
        const fenced = clientWith({
            data: null,
            error: {
                code: 'P0001',
                message: 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            },
        });
        await expect(createAnalysisV2ProfileFetchCheckpointStore(fenced.client)
            .checkpointPrimary({
                ...checkpointIdentity,
                requestedUsernames: ['alice', 'bob'],
                results: primaryResults(),
            })).rejects.toThrow('ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH');
        expect(fenced.rpc.mock.calls[0]![1]).toMatchObject({
            p_claim_token: claimToken,
            p_job_input_hash: jobInputHash,
        });
    });

    it('purges only through the terminal purge RPC and validates its result', async () => {
        const fake = clientWith({ data: 2, error: null });
        const store = createAnalysisV2ProfileFetchCheckpointStore(fake.client);
        await expect(store.purgeTerminal(requestId)).resolves.toBe(2);
        expect(fake.rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.purgeRpc,
            { p_request_id: requestId }
        );
    });
});
