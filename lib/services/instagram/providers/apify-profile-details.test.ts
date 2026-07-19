import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    REPLACEMENT_PROFILE_ACTOR,
    buildReplacementProfileInput,
    runReplacementProfileDetails,
} from './apify-profile-details';
import type { ApifyClientLike } from './apify-relationship';
import type { ProviderCallContext } from './types';

function profileItem(username: string, overrides: Record<string, unknown> = {}) {
    return {
        username,
        fullName: `${username} name`,
        biography: '',
        followersCount: 1,
        followsCount: 1,
        postsCount: 0,
        private: false,
        verified: false,
        latestPosts: [],
        ...overrides,
    };
}

function mockClient(input: {
    items?: Array<Record<string, unknown>>;
    run?: Record<string, unknown>;
    updatedRun?: Record<string, unknown>;
    listItems?: ReturnType<typeof vi.fn>;
    rejectRestrictionUpdate?: 'keyValueStore' | 'dataset' | 'requestQueue';
} = {}) {
    const items = input.items ?? [];
    const start = vi.fn().mockResolvedValue({ id: 'ReplacementRun1234' });
    const waitForFinish = vi.fn().mockResolvedValue({
        status: 'SUCCEEDED',
        buildNumber: '0.0.692',
        generalAccess: 'RESTRICTED',
        defaultDatasetId: 'replacement-dataset',
        usageTotalUsd: 0.01,
        ...input.run,
    });
    const update = vi.fn().mockResolvedValue({
        generalAccess: 'RESTRICTED',
        ...input.updatedRun,
    });
    const updateKeyValueStore = vi.fn().mockResolvedValue({
        generalAccess: 'RESTRICTED',
    });
    const updateDataset = vi.fn().mockResolvedValue({
        generalAccess: 'RESTRICTED',
    });
    const updateRequestQueue = vi.fn().mockResolvedValue({
        generalAccess: 'RESTRICTED',
    });
    if (input.rejectRestrictionUpdate === 'keyValueStore') {
        updateKeyValueStore.mockRejectedValueOnce(new Error('restriction update failed'));
    }
    if (input.rejectRestrictionUpdate === 'dataset') {
        updateDataset.mockRejectedValueOnce(new Error('restriction update failed'));
    }
    if (input.rejectRestrictionUpdate === 'requestQueue') {
        updateRequestQueue.mockRejectedValueOnce(new Error('restriction update failed'));
    }
    const abort = vi.fn().mockResolvedValue(undefined);
    const listItems = input.listItems ?? vi.fn().mockResolvedValue({
        items,
        total: items.length,
        offset: 0,
        count: items.length,
        limit: items.length + 1,
    });
    const client = {
        actor: vi.fn(() => ({ start })),
        run: vi.fn(() => ({
            waitForFinish,
            update,
            abort,
            keyValueStore: () => ({ update: updateKeyValueStore }),
            dataset: () => ({ update: updateDataset }),
            requestQueue: () => ({ update: updateRequestQueue }),
        })),
        dataset: vi.fn(() => ({ listItems })),
    } as unknown as ApifyClientLike;
    return {
        client,
        start,
        waitForFinish,
        update,
        updateKeyValueStore,
        updateDataset,
        updateRequestQueue,
        abort,
        listItems,
    };
}

function context(overrides: Partial<ProviderCallContext> = {}): ProviderCallContext {
    return {
        recordUsage: vi.fn(),
        ...overrides,
    };
}

describe('replacement Apify profile details adapter', () => {
    it('pins the official Actor and builds the minimal ordered details input', () => {
        expect(REPLACEMENT_PROFILE_ACTOR).toEqual({
            actorId: 'apify/instagram-scraper',
            build: '0.0.692',
            inputContractVersion: 1,
            outputContractVersion: 1,
            estimatedResultCostUsd: 0.0027,
        });

        expect(buildReplacementProfileInput(['alice', 'bob'])).toEqual({
            directUrls: [
                'https://www.instagram.com/alice/',
                'https://www.instagram.com/bob/',
            ],
            resultsType: 'details',
        });
        expect(buildReplacementProfileInput(['alice', 'bob']))
            .not.toHaveProperty('resultsLimit');
    });

    it('starts the exact build with fixed safety options and verifies accounting', async () => {
        const { client, start, waitForFinish, listItems } = mockClient({
            items: [profileItem('alice'), profileItem('bob')],
        });
        const callContext = context();

        const results = await runReplacementProfileDetails({
            client,
            usernames: ['alice', 'bob'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
            context: callContext,
        });

        expect(client.actor).toHaveBeenCalledWith('apify/instagram-scraper');
        expect(start).toHaveBeenCalledWith({
            directUrls: [
                'https://www.instagram.com/alice/',
                'https://www.instagram.com/bob/',
            ],
            resultsType: 'details',
        }, {
            build: '0.0.692',
            timeout: 60,
            maxItems: 2,
            maxTotalChargeUsd: 0.05,
            restartOnError: false,
        });
        expect(waitForFinish).toHaveBeenCalledWith({ waitSecs: 60 });
        expect(listItems).toHaveBeenCalledWith({ limit: 3 });
        expect(callContext.recordUsage).toHaveBeenNthCalledWith(1, { request_count: 1 });
        expect(callContext.recordUsage).toHaveBeenNthCalledWith(2, {
            raw_result_count: 2,
            estimated_cost_usd: 0.0054,
        });
        expect(callContext.recordUsage).toHaveBeenNthCalledWith(3, { result_count: 2 });
        expect(results.map(result => result.outcome.status)).toEqual(['success', 'success']);
    });

    it('rejects a terminal run when explicit resource restriction cannot be verified', async () => {
        const { client, listItems } = mockClient({
            items: [profileItem('alice')],
            run: { generalAccess: 'FOLLOW_USER_SETTING' },
            updatedRun: { generalAccess: 'ANYONE_WITH_ID_CAN_READ' },
        });

        await expect(runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
        })).rejects.toThrow('SCRAPING_ACCESS_ERROR');
        expect(listItems).not.toHaveBeenCalled();
    });

    it('pins an inherited replacement run to restricted access before reading its Dataset', async () => {
        const {
            client,
            update,
            updateKeyValueStore,
            updateDataset,
            updateRequestQueue,
            waitForFinish,
            listItems,
        } = mockClient({
            items: [profileItem('alice')],
            run: { generalAccess: 'FOLLOW_USER_SETTING' },
            updatedRun: { generalAccess: 'RESTRICTED' },
        });

        await expect(runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
        })).resolves.toMatchObject([{
            outcome: { requestedUsername: 'alice', status: 'success' },
        }]);

        expect(update).toHaveBeenCalledWith({ generalAccess: 'RESTRICTED' });
        expect(updateKeyValueStore).toHaveBeenCalledWith({ generalAccess: 'RESTRICTED' });
        expect(updateDataset).toHaveBeenCalledWith({ generalAccess: 'RESTRICTED' });
        expect(updateRequestQueue).toHaveBeenCalledWith({ generalAccess: 'RESTRICTED' });
        expect(update.mock.invocationCallOrder[0])
            .toBeLessThan(waitForFinish.mock.invocationCallOrder[0]);
        expect(update.mock.invocationCallOrder[0])
            .toBeLessThan(listItems.mock.invocationCallOrder[0]);
    });

    it.each([
        'keyValueStore',
        'dataset',
        'requestQueue',
    ] as const)(
        'does not wait or read when the %s restriction update fails, then resumes the checkpointed run',
        async (rejectRestrictionUpdate) => {
            const {
                client,
                start,
                waitForFinish,
                listItems,
            } = mockClient({
                items: [profileItem('alice')],
                rejectRestrictionUpdate,
            });
            const onRunStarted = vi.fn().mockResolvedValue(undefined);

            await expect(runReplacementProfileDetails({
                client,
                usernames: ['alice'],
                credentialSlot: 'primary',
                maxTotalChargeUsd: 0.05,
                context: context({ onRunStarted }),
            })).rejects.toThrow('SCRAPING_ACCESS_ERROR');

            expect(onRunStarted).toHaveBeenCalledOnce();
            expect(waitForFinish).not.toHaveBeenCalled();
            expect(listItems).not.toHaveBeenCalled();

            await expect(runReplacementProfileDetails({
                client,
                usernames: ['alice'],
                credentialSlot: 'primary',
                maxTotalChargeUsd: 0.05,
                context: context({
                    resumeRunId: 'ReplacementRun1234',
                    credentialSlot: 'primary',
                    maxChargeUsd: 0.05,
                }),
            })).resolves.toMatchObject([{
                outcome: { requestedUsername: 'alice', status: 'success' },
            }]);

            expect(start).toHaveBeenCalledOnce();
        }
    );

    it('preserves requested order while attributing reverse-ordered rows', async () => {
        const { client } = mockClient({
            items: [profileItem('bob'), profileItem('alice')],
        });

        const results = await runReplacementProfileDetails({
            client,
            usernames: ['alice', 'bob'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
        });

        expect(results.map(result => result.outcome.requestedUsername))
            .toEqual(['alice', 'bob']);
        expect(results.map(result => 'profile' in result ? result.profile.username : null))
            .toEqual(['alice', 'bob']);
    });

    it('bounded-rereads a transient 0/0 Dataset and accepts the complete second read', async () => {
        const row = profileItem('alice');
        const listItems = vi.fn()
            .mockResolvedValueOnce({
                items: [], total: 0, offset: 0, count: 0, limit: 2,
            })
            .mockResolvedValueOnce({
                items: [row], total: 1, offset: 0, count: 1, limit: 2,
            });
        const { client, start } = mockClient({ listItems });

        await expect(runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
        })).resolves.toMatchObject([{
            outcome: { requestedUsername: 'alice', status: 'success' },
        }]);

        expect(listItems).toHaveBeenCalledTimes(2);
        expect(start).toHaveBeenCalledOnce();
    });

    it('stops Dataset rereads at the invocation deadline without starting another run', async () => {
        const listItems = vi.fn().mockResolvedValue({
            items: [], total: 0, offset: 0, count: 0, limit: 2,
        });
        const { client, start } = mockClient({ listItems });
        const callContext = context({
            invocationDeadlineAtMs: Date.now() + 100,
            onRunStarted: vi.fn().mockResolvedValue(undefined),
        });

        await expect(runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
            context: callContext,
        })).rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');

        expect(listItems).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
    });

    it.each([
        {
            label: 'non-array items',
            page: { items: null, total: 0, offset: 0, count: 0, limit: 2 },
        },
        {
            label: 'non-integer total',
            page: { items: [], total: 0.5, offset: 0, count: 0, limit: 2 },
        },
        {
            label: 'negative total',
            page: { items: [], total: -1, offset: 0, count: 0, limit: 2 },
        },
        {
            label: 'total above the requested maximum',
            page: { items: [profileItem('alice')], total: 2, offset: 0, count: 1, limit: 2 },
        },
        {
            label: 'items-to-total mismatch',
            page: { items: [profileItem('alice')], total: 0, offset: 0, count: 1, limit: 2 },
        },
        {
            label: 'count mismatch',
            page: { items: [profileItem('alice')], total: 1, offset: 0, count: 0, limit: 2 },
        },
    ])('keeps a terminal malformed Dataset envelope as schema: $label', async ({ page }) => {
        const listItems = vi.fn().mockResolvedValue(page);
        const { client, start } = mockClient({ listItems });

        await expect(runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
            context: context({
                onRunStarted: vi.fn().mockResolvedValue(undefined),
            }),
        })).rejects.toThrow('SCRAPING_SCHEMA_ERROR');

        expect(listItems).toHaveBeenCalledTimes(3);
        expect(start).toHaveBeenCalledOnce();
    });

    it('keeps exhausted Dataset transport retryable on the same durable run', async () => {
        const listItems = vi.fn().mockRejectedValue(new Error('private transport detail'));
        const { client, start } = mockClient({ listItems });

        await expect(runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
            context: context({
                onRunStarted: vi.fn().mockResolvedValue(undefined),
            }),
        })).rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');

        expect(listItems).toHaveBeenCalledTimes(3);
        expect(start).toHaveBeenCalledOnce();
    });

    it.each([
        {
            label: 'duplicate row',
            requested: ['alice', 'bob'],
            items: [profileItem('alice'), profileItem('alice')],
            expectedStatuses: ['failed:schema', 'failed:schema'],
        },
        {
            label: 'unexpected row',
            requested: ['alice', 'bob'],
            items: [profileItem('alice'), profileItem('carol')],
            expectedStatuses: ['success', 'failed:schema'],
        },
        {
            label: 'cross-batch Actor error row',
            requested: ['alice'],
            items: [{
                inputUrl: 'https://www.instagram.com/bob/',
                error: 'private upstream detail',
            }],
            expectedStatuses: ['failed:schema'],
        },
    ])('rejects contaminated attribution: $label', async ({
        requested,
        items,
        expectedStatuses,
    }) => {
        const { client } = mockClient({ items });

        const results = await runReplacementProfileDetails({
            client,
            usernames: requested,
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
        });

        expect(results.map(result => result.outcome.status === 'failed'
            ? `${result.outcome.status}:${result.outcome.failureCategory}`
            : result.outcome.status)).toEqual(expectedStatuses);
        expect(results.some(result => (
            result.outcome.status === 'failed'
            && result.outcome.failureCategory === 'schema'
        ))).toBe(true);
        expect(JSON.stringify(results)).not.toContain('private upstream detail');
    });

    it('accepts unavailable only for an explicit matching not-found row', async () => {
        const explicit = mockClient({
            items: [profileItem('alice'), { username: 'bob', statusCode: 404 }],
        });
        const omitted = mockClient({ items: [profileItem('alice')] });

        const explicitResults = await runReplacementProfileDetails({
            client: explicit.client,
            usernames: ['alice', 'bob'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
        });
        const omittedResults = await runReplacementProfileDetails({
            client: omitted.client,
            usernames: ['alice', 'bob'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
        });

        expect(explicitResults[1]?.outcome).toMatchObject({
            status: 'unavailable',
            failureCategory: 'not_found',
        });
        expect(omittedResults[1]?.outcome).toMatchObject({
            status: 'failed',
            failureCategory: 'incomplete',
        });
    });

    it.each([
        {
            label: 'missing postsCount',
            row: (() => {
                const row: Record<string, unknown> = profileItem('alice');
                Reflect.deleteProperty(row, 'postsCount');
                return row;
            })(),
            category: 'schema',
        },
        {
            label: 'malformed profile field',
            row: profileItem('alice', { private: 'false' }),
            category: 'schema',
        },
        {
            label: 'short recent-post snapshot',
            row: profileItem('alice', {
                postsCount: 2,
                latestPosts: [{
                    id: 'post-1',
                    shortCode: 'post1',
                    type: 'Image',
                    displayUrl: 'https://example.com/post-1.jpg',
                }],
            }),
            category: 'incomplete',
        },
    ])('keeps strict failure categories for $label', async ({ row, category }) => {
        const { client } = mockClient({ items: [row] });

        const [result] = await runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
        });

        expect(result?.outcome).toMatchObject({
            status: 'failed',
            failureCategory: category,
        });
    });

    it('reuses strict reel and carousel media mapping with slide-caption alignment', async () => {
        const { client } = mockClient({
            items: [profileItem('alice', {
                postsCount: 2,
                latestPosts: [{
                    id: 'reel-1',
                    shortCode: 'reel1',
                    type: 'Video',
                    productType: 'clips',
                    displayUrl: 'https://example.com/reel-thumb.jpg',
                    videoUrl: 'https://example.com/reel.mp4',
                }, {
                    id: 'carousel-1',
                    shortCode: 'carousel1',
                    type: 'Sidecar',
                    displayUrl: 'https://example.com/carousel-cover.jpg',
                    images: [
                        'https://example.com/slide-1.jpg',
                        'https://example.com/slide-2.jpg',
                    ],
                    childPosts: [{
                        id: 'slide-1',
                        type: 'Image',
                        displayUrl: 'https://example.com/slide-1.jpg',
                        caption: ' First caption ',
                    }, {
                        id: 'slide-2',
                        type: 'Video',
                        displayUrl: 'https://example.com/slide-2.jpg',
                        videoUrl: 'https://example.com/slide-2.mp4',
                        caption: ' Second caption ',
                    }],
                }],
            })],
        });

        const [result] = await runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
        });

        expect(result).toMatchObject({
            outcome: { status: 'success' },
            profile: {
                latestPosts: [{
                    type: 'reel',
                    imageUrl: 'https://example.com/reel-thumb.jpg',
                    thumbnailUrl: 'https://example.com/reel-thumb.jpg',
                    videoUrl: 'https://example.com/reel.mp4',
                }, {
                    type: 'carousel',
                    declaredMediaCount: 2,
                    childrenComplete: true,
                    mediaItems: [{
                        id: 'slide-1',
                        caption: 'First caption',
                        imageUrl: 'https://example.com/slide-1.jpg',
                    }, {
                        id: 'slide-2',
                        caption: 'Second caption',
                        thumbnailUrl: 'https://example.com/slide-2.jpg',
                        videoUrl: 'https://example.com/slide-2.mp4',
                    }],
                }],
            },
        });
    });

    it('resumes only the confirmed run and never starts a replacement run', async () => {
        const { client, start } = mockClient({ items: [profileItem('alice')] });

        await expect(runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
            context: context({
                resumeRunId: 'ConfirmedRun1234',
                logicalProvider: 'apify',
                actorId: 'apify/instagram-scraper',
                credentialSlot: 'primary',
                maxChargeUsd: 0.05,
            }),
        })).resolves.toMatchObject([{ outcome: { status: 'success' } }]);

        expect(start).not.toHaveBeenCalled();
        expect(client.run).toHaveBeenCalledWith('ConfirmedRun1234');
    });

    it('fails a reserved start without a run id and does not create another run', async () => {
        const { client, start } = mockClient({ items: [profileItem('alice')] });

        await expect(runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
            context: context({
                startReserved: true,
                logicalProvider: 'apify',
                actorId: 'apify/instagram-scraper',
                credentialSlot: 'primary',
                maxChargeUsd: 0.05,
            }),
        })).rejects.toThrow('SCRAPING_AMBIGUOUS_START_ERROR');

        expect(start).not.toHaveBeenCalled();
    });

    it.each([
        {
            label: 'build drift',
            run: { buildNumber: '0.0.693' },
            expected: 'SCRAPING_SCHEMA_ERROR',
        },
        {
            label: 'cost above the hard cap',
            run: { usageTotalUsd: 0.050001 },
            expected: 'SCRAPING_BUDGET_ERROR',
        },
    ])('fails closed on $label before reading the dataset', async ({ run, expected }) => {
        const { client, listItems } = mockClient({
            items: [profileItem('alice')],
            run,
        });

        await expect(runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
        })).rejects.toThrow(expected);

        expect(listItems).not.toHaveBeenCalled();
    });

    it('rejects invalid or duplicate input and insufficient cost fences before start', async () => {
        const { client, start } = mockClient();

        expect(() => buildReplacementProfileInput(['alice', 'ALICE']))
            .toThrow('duplicate');
        await expect(runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.001,
        })).rejects.toThrow('SCRAPING_BUDGET_ERROR');
        await expect(runReplacementProfileDetails({
            client,
            usernames: ['not/a/user'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
        })).rejects.toThrow('SCRAPING_CONFIG_ERROR');

        expect(start).not.toHaveBeenCalled();
    });

    it('bounds one replacement operation at 30 profiles and $0.09 before start', async () => {
        const tooMany = mockClient();
        const tooExpensive = mockClient();

        await expect(runReplacementProfileDetails({
            client: tooMany.client,
            usernames: Array.from({ length: 31 }, (_, index) => `user${index}`),
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.09,
        })).rejects.toThrow('SCRAPING_CONFIG_ERROR');
        await expect(runReplacementProfileDetails({
            client: tooExpensive.client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.090001,
        })).rejects.toThrow('SCRAPING_BUDGET_ERROR');

        expect(tooMany.start).not.toHaveBeenCalled();
        expect(tooExpensive.start).not.toHaveBeenCalled();
    });

    it('does not reserve or start after the invocation deadline', async () => {
        const { client, start } = mockClient({ items: [profileItem('alice')] });
        const onBeforeRunStart = vi.fn();
        const callContext = context({
            invocationDeadlineAtMs: Date.now() - 1,
            onBeforeRunStart,
        });

        await expect(runReplacementProfileDetails({
            client,
            usernames: ['alice'],
            credentialSlot: 'primary',
            maxTotalChargeUsd: 0.05,
            context: callContext,
        })).rejects.toThrow('SCRAPING_INVOCATION_DEADLINE_ERROR');

        expect(onBeforeRunStart).not.toHaveBeenCalled();
        expect(callContext.recordUsage).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
    });
});
