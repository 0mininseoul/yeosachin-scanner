import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from './providers/selfhosted/__fixtures__/web-profile-info.json';
import { makeSelfHostedProvider } from './providers/selfhosted';
import type {
    ProfileAttemptResult,
    ProviderCallContext,
    ScraperProvider,
} from './providers/types';
import {
    failedProfileAttempt,
    successfulProfileAttempt,
} from './providers/profile-attempt';
import {
    __resetProvidersForTest,
    __setProvidersForTest,
    getProfilesBatchV2,
    type ProfilesBatchV2AttemptSnapshot,
} from './scraper';
import type { InstagramProfile } from '@/lib/types/instagram';

const fixtureUser = (fixture as { data: { user: Record<string, unknown> } }).data.user;

function rawUser(username: string): Record<string, unknown> {
    const timeline = fixtureUser.edge_owner_to_timeline_media as {
        count: number;
        edges: unknown[];
    };
    return {
        ...fixtureUser,
        username,
        edge_owner_to_timeline_media: {
            ...timeline,
            count: timeline.edges.length,
        },
    };
}

function profile(username: string): InstagramProfile {
    return {
        username,
        followersCount: 0,
        followingCount: 0,
        postsCount: 0,
        isPrivate: false,
        isVerified: false,
    };
}

function provider(overrides: Partial<ScraperProvider>): ScraperProvider {
    return { name: 'selfhosted', ...overrides } as ScraperProvider;
}

function durablePaidStart() {
    return {
        onBeforeRunStart: vi.fn(),
        onRunStarted: vi.fn(),
    };
}

afterEach(() => __resetProvidersForTest());

describe('getProfilesBatchV2', () => {
    it('preserves reject, null, and schema failures then sends only unresolved usernames once', async () => {
        const fetchUser = vi.fn(async (username: string) => {
            if (username === 'alice') return rawUser('alice');
            if (username === 'bob') throw new Error('connection exploded');
            if (username === 'carol') return null;
            return { ...rawUser('dave'), edge_followed_by: {} };
        });
        const fallback = vi.fn(async () => [profile('bob'), profile('dave')]);
        __setProvidersForTest({}, {
            selfhosted: makeSelfHostedProvider({ fetchUser, concurrency: 1, retries: 0 }),
            apify: provider({
                name: 'apify',
                paid: true,
                getProfilesBatch: fallback,
            }),
        });
        const snapshots: ProfilesBatchV2AttemptSnapshot[] = [];

        const result = await getProfilesBatchV2(
            ['Alice', 'Bob', 'Carol', 'Dave'],
            {
                providerRun: durablePaidStart(),
                persistAttemptOutcomes: async snapshot => { snapshots.push(snapshot); },
            }
        );

        expect(snapshots).toHaveLength(2);
        expect(snapshots[0].requestedUsernames).toEqual(['alice', 'bob', 'carol', 'dave']);
        expect(snapshots[0].results.map(item => [
            item.outcome.requestedUsername,
            item.outcome.status,
            item.outcome.failureCategory,
        ])).toEqual([
            ['alice', 'success', null],
            ['bob', 'failed', 'unknown'],
            ['carol', 'unavailable', 'empty_user'],
            ['dave', 'failed', 'schema'],
        ]);
        expect(result.frozenUnresolvedUsernames).toEqual(['bob', 'carol', 'dave']);
        expect(fallback).toHaveBeenCalledOnce();
        expect(fallback).toHaveBeenCalledWith(
            ['bob', 'carol', 'dave'],
            3,
            expect.objectContaining({ recordUsage: expect.any(Function) })
        );
        expect(snapshots[1].results.map(item => [
            item.outcome.requestedUsername,
            item.outcome.status,
        ])).toEqual([
            ['bob', 'success'],
            ['carol', 'failed'],
            ['dave', 'success'],
        ]);
        expect(result.results.map(item => [
            item.outcome.requestedUsername,
            item.outcome.status,
            item.outcome.source,
        ])).toEqual([
            ['alice', 'success', 'selfhosted'],
            ['bob', 'success', 'apify'],
            ['carol', 'failed', 'apify'],
            ['dave', 'success', 'apify'],
        ]);
    });

    it('turns a full primary transport failure into one failed outcome per username', async () => {
        const primary = vi.fn().mockRejectedValue(
            new Error('SCRAPING_ERROR: selfhosted transport request failed.')
        );
        const fallback = vi.fn(async (usernames: string[]) => usernames.map(profile));
        const snapshots: ProfilesBatchV2AttemptSnapshot[] = [];
        __setProvidersForTest({}, {
            selfhosted: provider({
                name: 'selfhosted',
                paid: false,
                getProfilesBatchOutcomes: primary,
            }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        const result = await getProfilesBatchV2(['alice', 'bob'], {
            providerRun: durablePaidStart(),
            persistAttemptOutcomes: async snapshot => { snapshots.push(snapshot); },
        });

        expect(snapshots[0].results).toHaveLength(2);
        expect(snapshots[0].results.every(item =>
            item.outcome.status === 'failed'
            && item.outcome.failureCategory === 'transport'
        )).toBe(true);
        expect(fallback).toHaveBeenCalledWith(['alice', 'bob'], 2, expect.any(Object));
        expect(result.profiles).toHaveLength(2);
    });

    it('records every fallback input as failed when the paid provider errors', async () => {
        const fallback = vi.fn().mockRejectedValue(
            new Error('SCRAPING_ERROR: Apify actor transport request failed.')
        );
        const snapshots: ProfilesBatchV2AttemptSnapshot[] = [];
        __setProvidersForTest({}, {
            selfhosted: provider({
                name: 'selfhosted',
                paid: false,
                getProfilesBatchOutcomes: vi.fn().mockRejectedValue(new Error('primary failed')),
            }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        const result = await getProfilesBatchV2(['alice', 'bob'], {
            providerRun: durablePaidStart(),
            persistAttemptOutcomes: async snapshot => { snapshots.push(snapshot); },
        });

        expect(snapshots[1].results).toHaveLength(2);
        expect(snapshots[1].results.every(item =>
            item.outcome.status === 'failed'
            && item.outcome.failureCategory === 'transport'
        )).toBe(true);
        expect(result.results.every(item => item.outcome.status === 'failed')).toBe(true);
    });

    it('does not seal synthetic outcomes for a paid-run checkpoint barrier', async () => {
        const snapshots: ProfilesBatchV2AttemptSnapshot[] = [];
        __setProvidersForTest({}, {
            selfhosted: provider({
                name: 'selfhosted',
                paid: false,
                getProfilesBatchOutcomes: vi.fn().mockRejectedValue(new Error('primary failed')),
            }),
            apify: provider({
                name: 'apify',
                paid: true,
                getProfilesBatch: vi.fn().mockRejectedValue(
                    new Error('SCRAPING_RUN_CHECKPOINT_ERROR: run id was not stored.')
                ),
            }),
        });

        await expect(getProfilesBatchV2(['alice', 'bob'], {
            providerRun: durablePaidStart(),
            persistAttemptOutcomes: async snapshot => { snapshots.push(snapshot); },
        })).rejects.toThrow('SCRAPING_RUN_CHECKPOINT_ERROR');

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].attempt).toBe('primary');
    });

    it('does not start the paid fallback when primary outcome persistence fails', async () => {
        const fallback = vi.fn();
        __setProvidersForTest({}, {
            selfhosted: makeSelfHostedProvider({
                fetchUser: vi.fn().mockResolvedValue(null),
                concurrency: 1,
                retries: 0,
            }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        await expect(getProfilesBatchV2(['alice'], {
            persistAttemptOutcomes: vi.fn().mockRejectedValue(new Error('database unavailable')),
        })).rejects.toThrow('PROFILE_FETCH_PERSISTENCE_ERROR: primary');
        expect(fallback).not.toHaveBeenCalled();
    });

    it('propagates a start-heartbeat persistence failure before any paid fallback', async () => {
        const fetchUser = vi.fn(async username => rawUser(username));
        const fallback = vi.fn();
        const persistAttemptOutcomes = vi.fn();
        __setProvidersForTest({}, {
            selfhosted: makeSelfHostedProvider({ fetchUser, concurrency: 1, retries: 0 }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        await expect(getProfilesBatchV2(['alice'], {
            providerRun: durablePaidStart(),
            onProfileStart: async () => {
                throw new Error('database unavailable');
            },
            persistAttemptOutcomes,
        })).rejects.toThrow(
            'ANALYSIS_PERSISTENCE_ERROR: active profile heartbeat failed.'
        );

        expect(fetchUser).not.toHaveBeenCalled();
        expect(persistAttemptOutcomes).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
    });

    it('preserves an exact progress fence failure without persisting or starting fallback', async () => {
        const fetchUser = vi.fn(async username => rawUser(username));
        const fallback = vi.fn();
        const persistAttemptOutcomes = vi.fn();
        __setProvidersForTest({}, {
            selfhosted: makeSelfHostedProvider({ fetchUser, concurrency: 1, retries: 0 }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        await expect(getProfilesBatchV2(['alice'], {
            providerRun: durablePaidStart(),
            onProfileStart: async () => {
                throw new Error('ANALYSIS_V2_PROGRESS_FENCE_MISMATCH');
            },
            persistAttemptOutcomes,
        })).rejects.toThrow('ANALYSIS_V2_PROGRESS_FENCE_MISMATCH');

        expect(fetchUser).not.toHaveBeenCalled();
        expect(persistAttemptOutcomes).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
    });

    it('never converts a selfhosted configuration error into a paid fallback call', async () => {
        const fallback = vi.fn();
        const persistAttemptOutcomes = vi.fn();
        __setProvidersForTest({}, {
            selfhosted: makeSelfHostedProvider({
                fetchUser: vi.fn().mockRejectedValue(
                    new Error('SCRAPING_CONFIG_ERROR: SELFHOSTED_TRANSPORT_BASE_URL is missing.')
                ),
                concurrency: 1,
                retries: 0,
            }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        await expect(getProfilesBatchV2(['alice'], {
            providerRun: durablePaidStart(),
            persistAttemptOutcomes,
        })).rejects.toThrow('SCRAPING_CONFIG_ERROR');

        expect(fallback).not.toHaveBeenCalled();
        expect(persistAttemptOutcomes).not.toHaveBeenCalled();
    });

    it('falls back only the public account whose selfhosted media is unusable', async () => {
        const brokenMediaUser = {
            ...rawUser('bob'),
            edge_owner_to_timeline_media: {
                count: 1,
                edges: [{
                    node: {
                        id: 'video-1',
                        shortcode: 'VIDEO1',
                        __typename: 'GraphVideo',
                        is_video: true,
                        display_url: 'https://cdn.example.com/opaque-video',
                        video_url: 'https://cdn.example.com/opaque-video',
                        edge_media_to_caption: { edges: [] },
                        edge_media_to_tagged_user: { edges: [] },
                    },
                }],
            },
        };
        const fallback = vi.fn().mockResolvedValue([profile('bob')]);
        __setProvidersForTest({}, {
            selfhosted: makeSelfHostedProvider({
                fetchUser: vi.fn(async username => (
                    username === 'bob' ? brokenMediaUser : rawUser(username)
                )),
                concurrency: 1,
                retries: 0,
            }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        const result = await getProfilesBatchV2(['alice', 'bob'], {
            providerRun: durablePaidStart(),
            persistAttemptOutcomes: async () => undefined,
        });

        expect(result.primaryResults.map(item => [
            item.outcome.requestedUsername,
            item.outcome.status,
            item.outcome.failureCategory,
        ])).toEqual([
            ['alice', 'success', null],
            ['bob', 'failed', 'incomplete'],
        ]);
        expect(fallback).toHaveBeenCalledWith(['bob'], 1, expect.any(Object));
    });

    it('does not start paid work without a durable provider-run checkpoint', async () => {
        const fallback = vi.fn();
        const persistAttemptOutcomes = vi.fn().mockResolvedValue(undefined);
        __setProvidersForTest({}, {
            selfhosted: makeSelfHostedProvider({
                fetchUser: vi.fn().mockResolvedValue(null),
                concurrency: 1,
                retries: 0,
            }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        await expect(getProfilesBatchV2(['alice'], {
            persistAttemptOutcomes,
        })).rejects.toThrow('durable provider-run checkpoint');

        expect(persistAttemptOutcomes).toHaveBeenCalledOnce();
        expect(fallback).not.toHaveBeenCalled();
    });

    it('never sends a primary success to the paid fallback', async () => {
        const fallback = vi.fn();
        __setProvidersForTest({}, {
            selfhosted: makeSelfHostedProvider({
                fetchUser: vi.fn(async username => rawUser(username)),
                concurrency: 1,
                retries: 0,
            }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        const result = await getProfilesBatchV2(['alice', 'bob'], {
            persistAttemptOutcomes: async () => undefined,
        });

        expect(result.frozenUnresolvedUsernames).toEqual([]);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('resumes the exact frozen set without rerunning free successes', async () => {
        const primaryResults: ProfileAttemptResult[] = [
            successfulProfileAttempt({
                requestedUsername: 'alice',
                source: 'selfhosted',
                profile: profile('alice'),
                requestCount: 1,
                latencyMs: 10,
            }),
            failedProfileAttempt({
                requestedUsername: 'bob',
                source: 'selfhosted',
                error: new Error('temporary primary failure'),
                requestCount: 1,
                latencyMs: 10,
            }),
        ];
        const primary = vi.fn().mockResolvedValue(primaryResults);
        const fallback = vi.fn<(
            usernames: string[],
            batchSize?: number,
            context?: ProviderCallContext
        ) => Promise<InstagramProfile[]>>().mockResolvedValue([profile('bob')]);
        __setProvidersForTest({}, {
            selfhosted: provider({
                name: 'selfhosted',
                paid: false,
                getProfilesBatchOutcomes: primary,
            }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        const first = await getProfilesBatchV2(['alice', 'bob'], {
            providerRun: durablePaidStart(),
            persistAttemptOutcomes: async () => undefined,
        });
        await getProfilesBatchV2(['alice', 'bob'], {
            resume: {
                primaryResults: first.primaryResults,
                frozenUnresolvedUsernames: first.frozenUnresolvedUsernames,
            },
            providerRun: {
                resumeRunId: 'ExistingRun123456',
                logicalProvider: 'apify',
            },
            persistAttemptOutcomes: async () => undefined,
        });

        expect(primary).toHaveBeenCalledOnce();
        expect(fallback).toHaveBeenCalledTimes(2);
        expect(fallback.mock.calls.map(call => call[0])).toEqual([['bob'], ['bob']]);
        expect(fallback.mock.calls[1][2]).toEqual(expect.objectContaining({
            resumeRunId: 'ExistingRun123456',
            logicalProvider: 'apify',
        }));
    });

    it('requires the frozen primary snapshot for a reserved but unconfirmed paid start', async () => {
        const primary = vi.fn();
        const fallback = vi.fn();
        __setProvidersForTest({}, {
            selfhosted: provider({
                name: 'selfhosted',
                paid: false,
                getProfilesBatchOutcomes: primary,
            }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        await expect(getProfilesBatchV2(['bob'], {
            providerRun: {
                startReserved: true,
                logicalProvider: 'apify',
                actorId: 'apify/instagram-profile-scraper',
                credentialSlot: 'primary',
                maxChargeUsd: 0.0026,
            },
            persistAttemptOutcomes: async () => undefined,
        })).rejects.toThrow('frozen primary snapshot');

        expect(primary).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
    });

    it('uses a frozen primary snapshot for startReserved and never reruns free work', async () => {
        const primary = vi.fn();
        const fallback = vi.fn().mockRejectedValue(
            new Error('SCRAPING_AMBIGUOUS_START_ERROR: reserved start has no run id.')
        );
        const primaryResults: ProfileAttemptResult[] = [
            failedProfileAttempt({
                requestedUsername: 'bob',
                source: 'selfhosted',
                error: new Error('primary transport failed'),
                requestCount: 1,
                latencyMs: 1,
            }),
        ];
        __setProvidersForTest({}, {
            selfhosted: provider({
                name: 'selfhosted',
                paid: false,
                getProfilesBatchOutcomes: primary,
            }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        await expect(getProfilesBatchV2(['bob'], {
            resume: {
                primaryResults,
                frozenUnresolvedUsernames: ['bob'],
            },
            providerRun: {
                startReserved: true,
                logicalProvider: 'apify',
                actorId: 'apify/instagram-profile-scraper',
                credentialSlot: 'primary',
                maxChargeUsd: 0.0026,
            },
            persistAttemptOutcomes: async () => undefined,
        })).rejects.toThrow('SCRAPING_AMBIGUOUS_START_ERROR');

        expect(primary).not.toHaveBeenCalled();
        expect(fallback).toHaveBeenCalledWith(
            ['bob'],
            1,
            expect.objectContaining({ startReserved: true })
        );
    });

    it('leaves the fallback checkpoint open for a resumable paid-run barrier', async () => {
        const snapshots: ProfilesBatchV2AttemptSnapshot[] = [];
        __setProvidersForTest({}, {
            selfhosted: provider({
                name: 'selfhosted',
                paid: false,
                getProfilesBatchOutcomes: vi.fn().mockRejectedValue(new Error('primary failed')),
            }),
            apify: provider({
                name: 'apify',
                paid: true,
                getProfilesBatch: vi.fn().mockRejectedValue(
                    new Error('SCRAPING_RUN_PENDING_ERROR: run is still active.')
                ),
            }),
        });

        await expect(getProfilesBatchV2(['bob'], {
            providerRun: durablePaidStart(),
            persistAttemptOutcomes: async snapshot => { snapshots.push(snapshot); },
        })).rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].attempt).toBe('primary');
    });

    it('rejects duplicate usernames before either provider runs', async () => {
        const primary = vi.fn();
        const fallback = vi.fn();
        __setProvidersForTest({}, {
            selfhosted: provider({
                name: 'selfhosted',
                paid: false,
                getProfilesBatchOutcomes: primary,
            }),
            apify: provider({ name: 'apify', paid: true, getProfilesBatch: fallback }),
        });

        await expect(getProfilesBatchV2(['Alice', 'alice'], {
            persistAttemptOutcomes: async () => undefined,
        })).rejects.toThrow('duplicated');
        expect(primary).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
    });
});
