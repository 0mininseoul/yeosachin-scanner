import { describe, expect, it, vi } from 'vitest';
import type { InstagramPost, InstagramProfile } from '@/lib/types/instagram';
import type { ProfileFetchOutcome } from '@/lib/domain/analysis/profile-fetch-outcome';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES,
    analysisV2CheckpointMediaItemSchema,
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
            profile: profile('alice', 12),
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

const fallbackCapturedAt = '2026-07-13T07:31:00.000Z';
const repairCapturedAt = '2026-07-13T07:32:00.000Z';

function apifyFailure(username: string) {
    return {
        outcome: outcome({
            username,
            source: 'apify',
            status: 'failed',
            failureCategory: 'timeout',
            httpStatus: 504,
        }),
    };
}

function apifyUnavailable(username: string) {
    return {
        outcome: outcome({
            username,
            source: 'apify',
            status: 'unavailable',
            failureCategory: 'not_found',
            httpStatus: 404,
        }),
    };
}

function apifySuccess(username: string) {
    return {
        outcome: outcome({ username, source: 'apify', status: 'success' }),
        profile: profile(username),
    };
}

/**
 * Alice resolved on the primary attempt, bob is still failed after the paid fallback and
 * carol merged to unavailable — so the server-derived repair set is exactly ['bob'].
 */
function mergedResume(overrides: Record<string, unknown> = {}) {
    return {
        requestId,
        jobKey,
        requestedUsernames: ['alice', 'bob', 'carol'],
        frozenUnresolvedUsernames: ['bob', 'carol'],
        primaryResults: [
            {
                outcome: outcome({ username: 'alice', source: 'cache', status: 'success' }),
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
            {
                outcome: outcome({
                    username: 'carol',
                    status: 'failed',
                    failureCategory: 'timeout',
                    httpStatus: 504,
                }),
            },
        ],
        fallbackResults: [apifyFailure('bob'), apifyUnavailable('carol')],
        primaryCapturedAt: capturedAt,
        fallbackCapturedAt,
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
    it('accepts a bounded authored carousel child caption', () => {
        expect(analysisV2CheckpointMediaItemSchema.parse({
            type: 'image',
            imageUrl: 'https://images.example/slide.jpg',
            caption: 'slide caption',
        }).caption).toBe('slide caption');
    });

    it('rejects an authored carousel child caption over 2,200 characters', () => {
        const result = analysisV2CheckpointMediaItemSchema.safeParse({
            type: 'image',
            imageUrl: 'https://images.example/slide.jpg',
            caption: 'x'.repeat(2_201),
        });

        expect(result.success).toBe(false);
        if (result.success) throw new Error('expected an overlong caption error');
        expect(result.error.issues).toContainEqual(expect.objectContaining({
            code: 'too_big',
            path: ['caption'],
            maximum: 2_200,
        }));
    });

    it('still rejects unknown carousel child keys', () => {
        expect(analysisV2CheckpointMediaItemSchema.safeParse({
            type: 'image',
            imageUrl: 'https://images.example/slide.jpg',
            caption: 'slide caption',
            accessibilityCaption: 'not authored evidence',
        }).success).toBe(false);
    });

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
            'post-11', 'post-10', 'post-9', 'post-8',
            'post-7', 'post-6', 'post-5', 'post-4',
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

    it('accepts a snapshot carrying the server-derived repair attempt', () => {
        const parsed = analysisV2ProfileFetchResumeSchema.parse(mergedResume({
            repairResults: [apifySuccess('bob')],
            repairUsernames: ['bob'],
            repairCapturedAt,
        }));

        expect(parsed.repairUsernames).toEqual(['bob']);
        expect(parsed.repairCapturedAt).toBe(repairCapturedAt);
        expect(parsed.repairResults).toHaveLength(1);
    });

    it('reads an unrepaired snapshot as an empty repair attempt', () => {
        const parsed = analysisV2ProfileFetchResumeSchema.parse(mergedResume({
            repairResults: [],
            repairUsernames: null,
            repairCapturedAt: null,
        }));

        expect(parsed.repairResults).toEqual([]);
        expect(parsed.repairUsernames).toBeNull();
        expect(parsed.repairCapturedAt).toBeNull();
    });

    it('rejects a repair outcome that was not sourced from the paid provider', () => {
        expect(analysisV2ProfileFetchResumeSchema.safeParse(mergedResume({
            repairResults: [{
                outcome: outcome({ username: 'bob', source: 'selfhosted', status: 'success' }),
                profile: profile('bob'),
            }],
            repairUsernames: ['bob'],
            repairCapturedAt,
        })).success).toBe(false);
    });

    it('rejects a repair set that is not a subset of the frozen unresolved set', () => {
        expect(analysisV2ProfileFetchResumeSchema.safeParse(mergedResume({
            repairResults: [apifySuccess('alice')],
            repairUsernames: ['alice'],
            repairCapturedAt,
        })).success).toBe(false);
    });

    it('rejects a repair set that admits a merged unavailable username', () => {
        // carol merged to `unavailable`, bob to `failed`, so the derived set is ['bob'].
        // Claiming both is the only shape that isolates the exclusion: a set of ['carol']
        // alone would be rejected for not matching ['bob'] even if `unavailable` were
        // wrongly admitted, which would make this test pass for the wrong reason.
        expect(analysisV2ProfileFetchResumeSchema.safeParse(mergedResume({
            repairResults: [apifyFailure('bob'), apifyFailure('carol')],
            repairUsernames: ['bob', 'carol'],
            repairCapturedAt,
        })).success).toBe(false);
    });

    it('rejects repair outcomes that do not follow the repair username order', () => {
        expect(analysisV2ProfileFetchResumeSchema.safeParse(mergedResume({
            fallbackResults: [apifyFailure('bob'), apifyFailure('carol')],
            repairResults: [apifyFailure('carol'), apifyFailure('bob')],
            repairUsernames: ['bob', 'carol'],
            repairCapturedAt,
        })).success).toBe(false);
    });

    it('rejects a repair completion timestamp without any repair outcome', () => {
        expect(analysisV2ProfileFetchResumeSchema.safeParse(mergedResume({
            repairResults: [],
            repairUsernames: null,
            repairCapturedAt,
        })).success).toBe(false);
    });

    it('rejects repair outcomes without a repair completion timestamp', () => {
        expect(analysisV2ProfileFetchResumeSchema.safeParse(mergedResume({
            repairResults: [apifySuccess('bob')],
            repairUsernames: ['bob'],
            repairCapturedAt: null,
        })).success).toBe(false);
    });

    it('rejects repair outcomes on a checkpoint that never completed a fallback', () => {
        // Regression guard for the empty-fallback bypass: repair validation must still run
        // when `fallbackResults` is empty. Here the derived set is ['bob','carol'] while the
        // claimed set is ['bob'], so a skipped repair validator lets this through.
        expect(analysisV2ProfileFetchResumeSchema.safeParse(mergedResume({
            fallbackResults: [],
            fallbackCapturedAt: null,
            repairResults: [apifySuccess('bob')],
            repairUsernames: ['bob'],
            repairCapturedAt,
        })).success).toBe(false);
    });

    it('rejects a repair attempt that overtakes an incomplete fallback', () => {
        // Isolates the "repair needs a completed fallback" invariant on its own. Only bob is
        // frozen and he merges to `failed`, so the derived set is exactly the claimed ['bob']
        // and every other repair check is satisfied — the fallback gate is the only thing
        // left that can reject this.
        expect(analysisV2ProfileFetchResumeSchema.safeParse({
            requestId,
            jobKey,
            requestedUsernames: ['alice', 'bob'],
            frozenUnresolvedUsernames: ['bob'],
            primaryResults: [
                {
                    outcome: outcome({ username: 'alice', source: 'cache', status: 'success' }),
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
            repairResults: [apifySuccess('bob')],
            repairUsernames: ['bob'],
            repairCapturedAt,
        }).success).toBe(false);
    });

    it('rejects a repair username set with no repair outcome behind it', () => {
        expect(analysisV2ProfileFetchResumeSchema.safeParse(mergedResume({
            repairResults: [],
            repairUsernames: ['bob'],
            repairCapturedAt: null,
        })).success).toBe(false);
    });

    it('loads the merged failed set before sending exactly that set to the repair RPC',
        async () => {
            const repaired = mergedResume({
                repairResults: [apifySuccess('bob')],
                repairUsernames: ['bob'],
                repairCapturedAt,
            });
            const fake = clientWith(
                { data: mergedResume(), error: null },
                { data: repaired, error: null }
            );
            const store = createAnalysisV2ProfileFetchCheckpointStore(fake.client);

            const result = await store.checkpointRepair({
                ...checkpointIdentity,
                results: [apifySuccess('bob')],
            });

            expect(result.repairUsernames).toEqual(['bob']);
            expect(fake.rpc.mock.calls.map(call => call[0])).toEqual([
                ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.loadRpc,
                ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.repairRpc,
            ]);
            expect(fake.rpc.mock.calls[1]![1].p_outcomes).toEqual([
                expect.objectContaining({ username: 'bob', source: 'apify', status: 'success' }),
            ]);
        });

    it('refuses repair work for a username the merge already settled', async () => {
        const fake = clientWith(
            { data: mergedResume(), error: null },
            { data: mergedResume(), error: null }
        );
        const store = createAnalysisV2ProfileFetchCheckpointStore(fake.client);

        await expect(store.checkpointRepair({
            ...checkpointIdentity,
            results: [apifySuccess('carol')],
        })).rejects.toThrow('unexpected outcome username');
        await expect(store.checkpointRepair({
            ...checkpointIdentity,
            results: [{
                outcome: outcome({ username: 'bob', source: 'selfhosted', status: 'success' }),
                profile: profile('bob'),
            }],
        })).rejects.toThrow('invalid attempt source');
        expect(fake.rpc.mock.calls.every(call => (
            call[0] === ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.loadRpc
        ))).toBe(true);
    });

    it('never repairs without a durable checkpoint or a completed fallback', async () => {
        const missing = clientWith({ data: null, error: null });
        await expect(createAnalysisV2ProfileFetchCheckpointStore(missing.client)
            .checkpointRepair({
                ...checkpointIdentity,
                results: [apifySuccess('bob')],
            })).rejects.toThrow('ANALYSIS_V2_PROFILE_CHECKPOINT_NOT_READY');

        const unfallen = clientWith({ data: resume(), error: null });
        await expect(createAnalysisV2ProfileFetchCheckpointStore(unfallen.client)
            .checkpointRepair({
                ...checkpointIdentity,
                results: [apifySuccess('bob')],
            })).rejects.toThrow('ANALYSIS_V2_PROFILE_CHECKPOINT_NOT_READY');
        expect(unfallen.rpc).toHaveBeenCalledOnce();
    });

    it('never repairs a merge that left nothing failed', async () => {
        const settled = clientWith({
            data: mergedResume({
                fallbackResults: [apifyUnavailable('bob'), apifyUnavailable('carol')],
            }),
            error: null,
        });
        const store = createAnalysisV2ProfileFetchCheckpointStore(settled.client);

        // Paying for a repair the merge never asked for is a caller bug, not a checkpoint
        // state to record, so the outcome is rejected rather than silently discarded.
        await expect(store.checkpointRepair({
            ...checkpointIdentity,
            results: [apifySuccess('bob')],
        })).rejects.toThrow('unexpected outcome username');
        expect(settled.rpc).toHaveBeenCalledOnce();
    });

    it('settles a merge with nothing left to repair without writing a checkpoint',
        async () => {
            const settled = clientWith({
                data: mergedResume({
                    fallbackResults: [apifyUnavailable('bob'), apifyUnavailable('carol')],
                }),
                error: null,
            });
            const store = createAnalysisV2ProfileFetchCheckpointStore(settled.client);

            // Both inputs to the repair set are write-once and final by now, so an empty set
            // can never become non-empty. Failing here — transiently or otherwise — would
            // burn the job's retry budget on a settled state, so hand the checkpoint back.
            await expect(store.checkpointRepair({
                ...checkpointIdentity,
                results: [],
            })).resolves.toMatchObject({ repairResults: [], repairCapturedAt: null });
            expect(settled.rpc).toHaveBeenCalledOnce();
        });

    it('rejects a repair success without profile evidence before any repair RPC call',
        async () => {
            const fake = clientWith({ data: mergedResume(), error: null });
            const store = createAnalysisV2ProfileFetchCheckpointStore(fake.client);

            await expect(store.checkpointRepair({
                ...checkpointIdentity,
                results: [{
                    outcome: outcome({ username: 'bob', source: 'apify', status: 'success' }),
                }],
            })).rejects.toThrow('success needs a profile');
            expect(fake.rpc).toHaveBeenCalledOnce();
            expect(fake.rpc.mock.calls[0]![0]).toBe(
                ANALYSIS_V2_PROFILE_FETCH_DATABASE_NAMES.loadRpc
            );
        });

    it('surfaces a divergent repair replay conflict verbatim', async () => {
        const fake = clientWith(
            { data: mergedResume(), error: null },
            {
                data: null,
                error: { code: 'P0001', message: 'ANALYSIS_V2_PROFILE_REPAIR_CONFLICT' },
            }
        );
        const store = createAnalysisV2ProfileFetchCheckpointStore(fake.client);

        await expect(store.checkpointRepair({
            ...checkpointIdentity,
            results: [apifySuccess('bob')],
        })).rejects.toThrow('ANALYSIS_V2_PROFILE_REPAIR_CONFLICT');
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
