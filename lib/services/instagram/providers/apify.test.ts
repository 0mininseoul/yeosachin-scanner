import { describe, it, expect, vi } from 'vitest';
import {
    APIFY_RELATIONSHIP_ACTOR_ID,
    apifyProvider,
    makeApifyProvider,
    parseApifyRelationshipDataset,
} from './apify';
import type { ApifyClientLike } from './apify-relationship';
import {
    selectApifyApiToken,
    selectApifyCredentialSlot,
    startOrResumeApifyActor,
} from './apify-relationship';

function relationshipItem(username: string, overrides: Record<string, unknown> = {}) {
    return {
        username_scrape: 'target',
        type: 'Followers',
        id: '123',
        username,
        full_name: `${username} name`,
        is_private: false,
        is_verified: false,
        profile_pic_url: 'https://example.com/p.jpg',
        ...overrides,
    };
}

function profileItem(username: string) {
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
    };
}

function mockClient(
    items: Array<Record<string, unknown>>,
    status = 'SUCCEEDED',
    usageTotalUsd?: number
) {
    const call = vi.fn().mockResolvedValue({ id: 'RunAbcd1234567890' });
    const waitForFinish = vi.fn().mockResolvedValue({
        status,
        defaultDatasetId: 'dataset',
        ...(usageTotalUsd === undefined ? {} : { usageTotalUsd }),
    });
    const abort = vi.fn().mockResolvedValue(undefined);
    const listItems = vi.fn(async ({ offset = 0, limit = items.length }: { offset?: number; limit?: number } = {}) => ({
        items: items.slice(offset, offset + limit),
        total: items.length,
        offset,
        count: Math.min(limit, Math.max(0, items.length - offset)),
        limit,
    }));
    const client = {
        actor: vi.fn(() => ({ start: call })),
        run: vi.fn(() => ({ waitForFinish, abort })),
        dataset: vi.fn(() => ({ listItems })),
    } as unknown as ApifyClientLike;
    return { client, call, waitForFinish, abort, listItems };
}

describe('apifyProvider', () => {
    it('selects one explicit credential slot without automatic account pooling', () => {
        const env = {
            APIFY_API_TOKEN: 'primary-token',
            APIFY_SECONDARY_API_TOKEN: 'secondary-token',
        };
        expect(selectApifyApiToken(env)).toBe('primary-token');
        expect(selectApifyCredentialSlot(env)).toBe('primary');
        expect(selectApifyApiToken({ ...env, APIFY_API_TOKEN_SLOT: 'secondary' }))
            .toBe('secondary-token');
        expect(selectApifyCredentialSlot({ ...env, APIFY_API_TOKEN_SLOT: 'secondary' }))
            .toBe('secondary');
        expect(selectApifyApiToken(
            { ...env, APIFY_API_TOKEN_SLOT: 'primary' },
            'secondary'
        )).toBe('secondary-token');
        expect(() => selectApifyApiToken({ ...env, APIFY_API_TOKEN_SLOT: 'pool' }))
            .toThrow('APIFY_API_TOKEN_SLOT');
    });

    it('checkpoints a new Actor run before waiting for its result', async () => {
        const { client, call, waitForFinish } = mockClient([], 'SUCCEEDED', 0.40205);
        const onRunStarted = vi.fn().mockResolvedValue(undefined);
        const onBeforeRunStart = vi.fn().mockResolvedValue(undefined);
        const onCostRunStarted = vi.fn().mockResolvedValue(undefined);
        const onCostRunFinished = vi.fn().mockResolvedValue(undefined);

        await expect(startOrResumeApifyActor(
            client,
            APIFY_RELATIONSHIP_ACTOR_ID,
            { Account: ['target'] },
            {
                logicalProvider: 'apify',
                credentialSlot: 'primary',
                timeoutSecs: 300,
                maxItems: 25,
                maxTotalChargeUsd: 0.1,
            },
            {
                onBeforeRunStart,
                onRunStarted,
                onCostRunStarted,
                onCostRunFinished,
                recordUsage: vi.fn(),
            }
        )).resolves.toMatchObject({ status: 'SUCCEEDED' });

        expect(onBeforeRunStart).toHaveBeenCalledWith({
            logicalProvider: 'apify',
            actorId: APIFY_RELATIONSHIP_ACTOR_ID,
            credentialSlot: 'primary',
            maxChargeUsd: 0.1,
        });
        expect(call).toHaveBeenCalledOnce();
        expect(onRunStarted).toHaveBeenCalledWith('RunAbcd1234567890');
        const costIdentity = {
            logicalProvider: 'apify',
            actorId: APIFY_RELATIONSHIP_ACTOR_ID,
            credentialSlot: 'primary',
            runId: 'RunAbcd1234567890',
            maxChargeUsd: 0.1,
        };
        expect(onCostRunStarted).toHaveBeenCalledWith(costIdentity);
        expect(onCostRunFinished).toHaveBeenCalledWith({
            ...costIdentity,
            status: 'succeeded',
            usageTotalUsd: 0.40205,
        });
        expect(onCostRunStarted.mock.invocationCallOrder[0])
            .toBeLessThan(waitForFinish.mock.invocationCallOrder[0]);
        expect(waitForFinish.mock.invocationCallOrder[0])
            .toBeLessThan(onCostRunFinished.mock.invocationCallOrder[0]);
        expect(client.run).toHaveBeenCalledWith('RunAbcd1234567890');
        expect(waitForFinish).toHaveBeenCalledWith({ waitSecs: 240 });
    });

    it('resumes a checkpointed Actor without starting or checkpointing another run', async () => {
        const { client, call, waitForFinish } = mockClient([], 'SUCCEEDED', 0.25);
        const onRunStarted = vi.fn();
        const onCostRunStarted = vi.fn();
        const onCostRunFinished = vi.fn();

        await expect(startOrResumeApifyActor(
            client,
            APIFY_RELATIONSHIP_ACTOR_ID,
            { Account: ['target'] },
            {
                logicalProvider: 'apify',
                credentialSlot: 'primary',
                timeoutSecs: 120,
                maxItems: 25,
                maxTotalChargeUsd: 0.1,
            },
            {
                resumeRunId: 'StoredRun12345678',
                credentialSlot: 'secondary',
                maxChargeUsd: 0.35,
                onRunStarted,
                onCostRunStarted,
                onCostRunFinished,
                recordUsage: vi.fn(),
            }
        )).resolves.toMatchObject({ status: 'SUCCEEDED' });

        expect(call).not.toHaveBeenCalled();
        expect(onRunStarted).not.toHaveBeenCalled();
        expect(onCostRunStarted).toHaveBeenCalledWith(expect.objectContaining({
            credentialSlot: 'secondary',
            runId: 'StoredRun12345678',
            maxChargeUsd: 0.35,
        }));
        expect(onCostRunFinished).toHaveBeenCalledWith(expect.objectContaining({
            status: 'succeeded',
            usageTotalUsd: 0.25,
        }));
        expect(client.run).toHaveBeenCalledWith('StoredRun12345678');
        expect(waitForFinish).toHaveBeenCalledWith({ waitSecs: 120 });
    });

    it.each(['RUNNING', 'TIMING-OUT']) (
        'does not seal cost for the resumable Apify state %s',
        async status => {
            const { client } = mockClient([], status, 0.03);
            const onCostRunStarted = vi.fn();
            const onCostRunFinished = vi.fn();

            await expect(startOrResumeApifyActor(
                client,
                APIFY_RELATIONSHIP_ACTOR_ID,
                {},
                {
                    logicalProvider: 'apify',
                    credentialSlot: 'primary',
                    timeoutSecs: 120,
                    maxItems: 1,
                    maxTotalChargeUsd: 0.1,
                },
                { onCostRunStarted, onCostRunFinished, recordUsage: vi.fn() }
            )).resolves.toMatchObject({ status });

            expect(onCostRunStarted).toHaveBeenCalledOnce();
            expect(onCostRunFinished).not.toHaveBeenCalled();
        }
    );

    it.each([
        ['FAILED', 'failed'],
        ['ABORTED', 'aborted'],
        ['TIMED-OUT', 'timed_out'],
    ])('records terminal Apify state %s before returning it', async (status, normalized) => {
        const { client, waitForFinish } = mockClient([], status, 0.07);
        const onCostRunFinished = vi.fn();

        await expect(startOrResumeApifyActor(
            client,
            APIFY_RELATIONSHIP_ACTOR_ID,
            {},
            {
                logicalProvider: 'apify',
                credentialSlot: 'secondary',
                timeoutSecs: 120,
                maxItems: 1,
                maxTotalChargeUsd: 0.1,
            },
            { onCostRunFinished, recordUsage: vi.fn() }
        )).resolves.toMatchObject({ status });

        expect(onCostRunFinished).toHaveBeenCalledWith(expect.objectContaining({
            credentialSlot: 'secondary',
            status: normalized,
            usageTotalUsd: 0.07,
        }));
        expect(waitForFinish.mock.invocationCallOrder[0])
            .toBeLessThan(onCostRunFinished.mock.invocationCallOrder[0]);
    });

    it('preserves a checkpointed run for retry when the cost-start write fails', async () => {
        const { client, abort, waitForFinish } = mockClient([]);

        await expect(startOrResumeApifyActor(
            client,
            APIFY_RELATIONSHIP_ACTOR_ID,
            {},
            {
                logicalProvider: 'apify',
                credentialSlot: 'primary',
                timeoutSecs: 120,
                maxItems: 1,
                maxTotalChargeUsd: 0.1,
            },
            {
                onBeforeRunStart: vi.fn().mockResolvedValue(undefined),
                onRunStarted: vi.fn().mockResolvedValue(undefined),
                onCostRunStarted: vi.fn().mockRejectedValue(new Error('database unavailable')),
                recordUsage: vi.fn(),
            }
        )).rejects.toThrow('ANALYSIS_PERSISTENCE_ERROR');

        expect(abort).not.toHaveBeenCalled();
        expect(waitForFinish).not.toHaveBeenCalled();
    });

    it('does not start an Actor when the start-intent reservation fails', async () => {
        const { client, call } = mockClient([]);

        await expect(startOrResumeApifyActor(
            client,
            APIFY_RELATIONSHIP_ACTOR_ID,
            {},
            {
                logicalProvider: 'apify',
                credentialSlot: 'primary',
                timeoutSecs: 120,
                maxItems: 1,
                maxTotalChargeUsd: 0.1,
            },
            {
                onBeforeRunStart: vi.fn().mockRejectedValue(new Error('database unavailable')),
                recordUsage: vi.fn(),
            }
        )).rejects.toThrow('ANALYSIS_PERSISTENCE_ERROR');

        expect(call).not.toHaveBeenCalled();
    });

    it('preserves a terminal checkpoint for retry when its cost write fails', async () => {
        const { client, abort } = mockClient([], 'SUCCEEDED', 0.02);

        await expect(startOrResumeApifyActor(
            client,
            APIFY_RELATIONSHIP_ACTOR_ID,
            {},
            {
                logicalProvider: 'apify',
                credentialSlot: 'primary',
                timeoutSecs: 120,
                maxItems: 1,
                maxTotalChargeUsd: 0.1,
            },
            {
                onBeforeRunStart: vi.fn().mockResolvedValue(undefined),
                onRunStarted: vi.fn().mockResolvedValue(undefined),
                onCostRunStarted: vi.fn().mockResolvedValue(undefined),
                onCostRunFinished: vi.fn().mockRejectedValue(new Error('database unavailable')),
                recordUsage: vi.fn(),
            }
        )).rejects.toThrow('ANALYSIS_PERSISTENCE_ERROR');

        expect(abort).not.toHaveBeenCalled();
    });

    it('never starts again when a prior start intent has no confirmed run id', async () => {
        const { client, call } = mockClient([]);

        await expect(startOrResumeApifyActor(
            client,
            APIFY_RELATIONSHIP_ACTOR_ID,
            {},
            {
                logicalProvider: 'apify',
                credentialSlot: 'primary',
                timeoutSecs: 120,
                maxItems: 1,
                maxTotalChargeUsd: 0.1,
            },
            {
                logicalProvider: 'apify',
                actorId: APIFY_RELATIONSHIP_ACTOR_ID,
                credentialSlot: 'primary',
                maxChargeUsd: 0.1,
                startReserved: true,
                recordUsage: vi.fn(),
            }
        )).rejects.toThrow('SCRAPING_AMBIGUOUS_START_ERROR');

        expect(call).not.toHaveBeenCalled();
    });

    it('aborts a newly started run when its durable checkpoint cannot be stored', async () => {
        const { client, abort } = mockClient([]);

        await expect(startOrResumeApifyActor(
            client,
            APIFY_RELATIONSHIP_ACTOR_ID,
            {},
            {
                logicalProvider: 'apify',
                credentialSlot: 'primary',
                timeoutSecs: 120,
                maxItems: 1,
                maxTotalChargeUsd: 0.1,
            },
            {
                onRunStarted: vi.fn().mockRejectedValue(new Error('database unavailable')),
                recordUsage: vi.fn(),
            }
        )).rejects.toThrow('SCRAPING_RUN_CHECKPOINT_ERROR');

        expect(abort).toHaveBeenCalledOnce();
    });

    it('name과 지원 기능이 노출된다', () => {
        expect(apifyProvider.name).toBe('apify');
        expect(typeof apifyProvider.getProfile).toBe('function');
        expect(typeof apifyProvider.getFollowers).toBe('function');
        expect(typeof apifyProvider.getFollowing).toBe('function');
        expect(typeof apifyProvider.getProfilesBatch).toBe('function');
    });

    it('uses the documented Scraping Solutions input and strict following mapping', async () => {
        const { client, call } = mockClient([
            relationshipItem('alice', { type: 'Followings' }),
            relationshipItem('bob', { type: 'followings' }),
        ]);
        const provider = makeApifyProvider({ client, env: {} });

        const result = await provider.getFollowing!('target', 2);

        expect(result.map((item) => item.username)).toEqual(['alice', 'bob']);
        expect(client.actor).toHaveBeenCalledWith(APIFY_RELATIONSHIP_ACTOR_ID);
        expect(call).toHaveBeenCalledWith(
            { Account: ['target'], resultsLimit: 25, dataToScrape: 'Followings' },
            expect.objectContaining({
                build: '0.0.71',
                maxItems: 25,
                maxTotalChargeUsd: 0.02125,
                timeout: 300,
                restartOnError: false,
            })
        );
    });

    it('reports the credential slot and charge cap actually selected by the provider', async () => {
        const { client } = mockClient([relationshipItem('alice')], 'SUCCEEDED', 0.02);
        const provider = makeApifyProvider({
            client,
            env: { APIFY_API_TOKEN_SLOT: 'secondary' },
        });
        const onCostRunStarted = vi.fn();
        const onCostRunFinished = vi.fn();

        await expect(provider.getFollowers!('target', 1, {
            onCostRunStarted,
            onCostRunFinished,
            recordUsage: vi.fn(),
        })).resolves.toHaveLength(1);

        expect(onCostRunStarted).toHaveBeenCalledWith(expect.objectContaining({
            logicalProvider: 'apify',
            actorId: APIFY_RELATIONSHIP_ACTOR_ID,
            credentialSlot: 'secondary',
            maxChargeUsd: 0.02125,
        }));
        expect(onCostRunFinished).toHaveBeenCalledWith(expect.objectContaining({
            credentialSlot: 'secondary',
            usageTotalUsd: 0.02,
        }));
    });

    it('keeps relationship intent reservation failures retryable through the provider wrapper', async () => {
        const { client, call } = mockClient([relationshipItem('alice')]);
        const provider = makeApifyProvider({ client, env: {} });

        await expect(provider.getFollowers!('target', 1, {
            onBeforeRunStart: vi.fn().mockRejectedValue(new Error('database unavailable')),
            recordUsage: vi.fn(),
        })).rejects.toThrow('ANALYSIS_PERSISTENCE_ERROR');
        expect(call).not.toHaveBeenCalled();
    });

    it('accepts only exact relationship build pins and forwards an override', async () => {
        const overridden = mockClient([relationshipItem('alice')]);
        const provider = makeApifyProvider({
            client: overridden.client,
            env: { APIFY_RELATIONSHIP_BUILD: '1.2.3' },
        });

        await expect(provider.getFollowers!('target', 1)).resolves.toHaveLength(1);
        expect(overridden.call).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ build: '1.2.3' })
        );

        const invalid = mockClient([relationshipItem('alice')]);
        await expect(makeApifyProvider({
            client: invalid.client,
            env: { APIFY_RELATIONSHIP_BUILD: 'latest' },
        }).getFollowers!('target', 1)).rejects.toThrow('APIFY_RELATIONSHIP_BUILD');
        expect(invalid.call).not.toHaveBeenCalled();
    });

    it.each([
        ['followers', 'Followers'],
        ['followers', 'followers'],
        ['following', 'Following'],
        ['following', 'following'],
        ['following', 'Followings'],
        ['following', 'followings'],
    ] as const)('accepts the %s output type variant %s', (kind, type) => {
        expect(parseApifyRelationshipDataset(
            [relationshipItem('alice', { type })],
            'target',
            kind,
            25
        )).toMatchObject([{ username: 'alice' }]);
    });

    it.each([
        { status: 'error' },
        { status: 'daily limit reached' },
    ])('rejects a status-only actor row instead of treating it as data', (row) => {
        expect(() => parseApifyRelationshipDataset([row], 'target', 'followers', 25))
            .toThrow('SCRAPING_SCHEMA_ERROR');
    });

    it('rejects target/type/schema mismatches', async () => {
        const { client } = mockClient([
            relationshipItem('alice', { username_scrape: 'other' }),
        ]);
        const provider = makeApifyProvider({ client, env: {} });
        await expect(provider.getFollowers!('target', 1)).rejects.toThrow('username');

        const malformed = mockClient([
            relationshipItem('alice', { is_private: 'false' }),
        ]);
        await expect(makeApifyProvider({ client: malformed.client, env: {} }).getFollowers!('target', 1))
            .rejects.toThrow('SCRAPING_SCHEMA_ERROR');
    });

    it('reads the 1,000-result boundary completely', async () => {
        const items = Array.from({ length: 1_000 }, (_, index) => relationshipItem(`u${index}`));
        const { client, listItems } = mockClient(items);
        const provider = makeApifyProvider({ client, env: {} });

        await expect(provider.getFollowers!('target', 1_000)).resolves.toHaveLength(1_000);
        expect(listItems).toHaveBeenCalledTimes(1);
        expect(listItems).toHaveBeenCalledWith({ offset: 0, limit: 1_000 });
    });

    it('rejects result and estimated-cost ceilings before starting the actor', async () => {
        const overLimit = mockClient([]);
        await expect(makeApifyProvider({ client: overLimit.client, env: {} })
            .getFollowers!('target', 1_001)).rejects.toThrow('limit');
        expect(overLimit.call).not.toHaveBeenCalled();

        const overCost = mockClient([]);
        await expect(makeApifyProvider({
            client: overCost.client,
            env: {
                APIFY_RELATIONSHIP_MAX_RESULTS_PER_OPERATION: '2000',
                APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION: '0.5',
            },
        }).getFollowers!('target', 1_000)).rejects.toThrow('BUDGET');
        expect(overCost.call).not.toHaveBeenCalled();
    });

    it('enforces the 95% unique ratio', async () => {
        const items = Array.from({ length: 18 }, (_, index) => relationshipItem(`u${index}`));
        items.push(relationshipItem('u0'), relationshipItem('u1'));
        const { client } = mockClient(items);
        const provider = makeApifyProvider({ client, env: {} });
        await expect(provider.getFollowers!('target', 20)).rejects.toThrow('중복 비율');
    });

    it('fails closed when a profile batch has under 95% username coverage', async () => {
        const { client } = mockClient([profileItem('alice')]);
        const provider = makeApifyProvider({ client, env: {} });
        await expect(provider.getProfilesBatch!(['alice', 'bob'], 2)).rejects.toThrow('INCOMPLETE');
    });

    it('does not swallow failed profile actor runs', async () => {
        const { client } = mockClient([], 'FAILED');
        const provider = makeApifyProvider({ client, env: {} });
        await expect(provider.getProfilesBatch!(['alice'], 1)).rejects.toThrow('status=FAILED');
    });

    it('fails closed on an ambiguous Actor start without exposing the response', async () => {
        const { client, call } = mockClient([relationshipItem('alice')]);
        call.mockRejectedValueOnce(Object.assign(new Error('secret response'), {
            statusCode: 429,
            response: { headers: { authorization: 'Bearer secret' } },
        }));

        await expect(makeApifyProvider({ client, env: {} }).getFollowers!('target', 1))
            .rejects.toThrow('SCRAPING_AMBIGUOUS_START_ERROR');
    });

    it('serializes actor runs when shared concurrency is explicitly one', async () => {
        let releaseFirst!: () => void;
        const start = vi.fn()
            .mockResolvedValueOnce({ id: 'FirstRun12345678' })
            .mockResolvedValueOnce({ id: 'SecondRun1234567' });
        const waitForFinish = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => {
                releaseFirst = () => resolve({ status: 'SUCCEEDED', defaultDatasetId: 'first' });
            }))
            .mockResolvedValueOnce({ status: 'SUCCEEDED', defaultDatasetId: 'second' });
        const listItems = vi.fn()
            .mockResolvedValueOnce({
                items: [relationshipItem('alice')],
                total: 1,
                offset: 0,
                count: 1,
                limit: 1,
            })
            .mockResolvedValueOnce({
                items: [relationshipItem('bob', { type: 'Followings' })],
                total: 1,
                offset: 0,
                count: 1,
                limit: 1,
            });
        const client = {
            actor: vi.fn(() => ({ start })),
            run: vi.fn(() => ({ waitForFinish, abort: vi.fn() })),
            dataset: vi.fn(() => ({ listItems })),
        } as unknown as ApifyClientLike;
        const provider = makeApifyProvider({
            client,
            env: {
                APIFY_ACTOR_CONCURRENCY: '1',
                APIFY_DATASET_RETRY_BASE_DELAY_MS: '0',
            },
        });

        const followers = provider.getFollowers!('target', 1);
        await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
        const following = provider.getFollowing!('target', 1);
        await Promise.resolve();
        expect(start).toHaveBeenCalledTimes(1);

        releaseFirst();
        await expect(Promise.all([followers, following])).resolves.toMatchObject([
            [{ username: 'alice' }],
            [{ username: 'bob' }],
        ]);
        expect(start).toHaveBeenCalledTimes(2);
    });

    it('rereads a page after a transient pagination-metadata mismatch without double cost', async () => {
        const { client } = mockClient([relationshipItem('alice')]);
        const listItems = vi.fn()
            .mockResolvedValueOnce({
                items: [relationshipItem('alice')],
                total: 1,
                offset: 0,
                count: 0,
                limit: 1,
            })
            .mockResolvedValueOnce({
                items: [relationshipItem('alice')],
                total: 1,
                offset: 0,
                count: 1,
                limit: 1,
            });
        vi.mocked(client.dataset).mockReturnValue(
            { listItems } as unknown as ReturnType<typeof client.dataset>
        );
        let estimatedCost = 0;
        const provider = makeApifyProvider({
            client,
            env: {
                APIFY_DATASET_READ_RETRIES: '2',
                APIFY_DATASET_RETRY_BASE_DELAY_MS: '0',
            },
        });

        await expect(provider.getFollowers!('target', 1, {
            recordUsage(delta) {
                estimatedCost += delta.estimated_cost_usd ?? 0;
            },
        })).resolves.toHaveLength(1);
        expect(listItems).toHaveBeenCalledTimes(2);
        expect(estimatedCost).toBe(0.00085);
    });

    it('waits for the completed actor dataset to settle without rerunning the actor', async () => {
        const { client, call } = mockClient([relationshipItem('alice')]);
        const unsettledPage = {
            items: [relationshipItem('alice')],
            total: 0,
            offset: 0,
            count: 1,
            limit: 1,
        };
        const listItems = vi.fn()
            .mockResolvedValueOnce(unsettledPage)
            .mockResolvedValueOnce(unsettledPage)
            .mockResolvedValueOnce(unsettledPage)
            .mockResolvedValueOnce(unsettledPage)
            .mockResolvedValueOnce({
                items: [relationshipItem('alice')],
                total: 1,
                offset: 0,
                count: 1,
                limit: 1,
            });
        vi.mocked(client.dataset).mockReturnValue(
            { listItems } as unknown as ReturnType<typeof client.dataset>
        );
        const provider = makeApifyProvider({
            client,
            env: { APIFY_DATASET_RETRY_BASE_DELAY_MS: '0' },
        });

        await expect(provider.getFollowers!('target', 1)).resolves.toHaveLength(1);
        expect(call).toHaveBeenCalledTimes(1);
        expect(listItems).toHaveBeenCalledTimes(5);
    });

    it('rereads an initially empty completed dataset until rows settle', async () => {
        const { client, call } = mockClient([relationshipItem('alice')]);
        const emptyPage = {
            items: [],
            total: 0,
            offset: 0,
            count: 0,
            limit: 25,
        };
        const listItems = vi.fn()
            .mockResolvedValueOnce(emptyPage)
            .mockResolvedValueOnce(emptyPage)
            .mockResolvedValueOnce(emptyPage)
            .mockResolvedValueOnce(emptyPage)
            .mockResolvedValueOnce({
                items: [relationshipItem('alice')],
                total: 1,
                offset: 0,
                count: 1,
                limit: 25,
            });
        vi.mocked(client.dataset).mockReturnValue(
            { listItems } as unknown as ReturnType<typeof client.dataset>
        );
        const provider = makeApifyProvider({
            client,
            env: { APIFY_DATASET_RETRY_BASE_DELAY_MS: '0' },
        });

        await expect(provider.getFollowers!('target', 1)).resolves.toMatchObject([
            { username: 'alice' },
        ]);
        expect(call).toHaveBeenCalledTimes(1);
        expect(listItems).toHaveBeenCalledTimes(5);
    });

    it('preserves a legitimate empty dataset after bounded settlement reads', async () => {
        const { client, call } = mockClient([]);
        const provider = makeApifyProvider({
            client,
            env: {
                APIFY_DATASET_READ_RETRIES: '2',
                APIFY_DATASET_RETRY_BASE_DELAY_MS: '0',
            },
        });

        await expect(provider.getFollowers!('target', 1)).resolves.toEqual([]);
        expect(call).toHaveBeenCalledTimes(1);
        expect(client.dataset('dataset').listItems).toHaveBeenCalledTimes(3);
    });

    it('retries dataset transport reads without rerunning the paid actor', async () => {
        const { client, call } = mockClient([relationshipItem('alice')]);
        const listItems = vi.fn()
            .mockRejectedValueOnce(new Error('temporary transport failure'))
            .mockRejectedValueOnce(new Error('temporary transport failure'))
            .mockResolvedValueOnce({
                items: [relationshipItem('alice')],
                total: 1,
                offset: 0,
                count: 1,
                limit: 1,
            });
        vi.mocked(client.dataset).mockReturnValue(
            { listItems } as unknown as ReturnType<typeof client.dataset>
        );
        const provider = makeApifyProvider({
            client,
            env: { APIFY_DATASET_RETRY_BASE_DELAY_MS: '0' },
        });

        await expect(provider.getFollowers!('target', 1)).resolves.toHaveLength(1);
        expect(call).toHaveBeenCalledTimes(1);
        expect(listItems).toHaveBeenCalledTimes(3);

        const exhausted = mockClient([relationshipItem('alice')]);
        const failedRead = vi.fn().mockRejectedValue(new Error('transport failure'));
        vi.mocked(exhausted.client.dataset).mockReturnValue(
            { listItems: failedRead } as unknown as ReturnType<typeof exhausted.client.dataset>
        );
        await expect(makeApifyProvider({
            client: exhausted.client,
            env: { APIFY_DATASET_READ_RETRIES: '0' },
        }).getFollowers!('target', 1)).rejects.toThrow('APIFY_DATASET_TRANSPORT_EXHAUSTED');
        expect(exhausted.call).toHaveBeenCalledTimes(1);
    });

    it('attributes profile spend per delivered dataset item', async () => {
        const { client, call } = mockClient([profileItem('target')]);
        const provider = makeApifyProvider({ client, env: {} });
        let estimatedCost = 0;

        await expect(provider.getProfile!('target', {
            recordUsage(delta) {
                estimatedCost += delta.estimated_cost_usd ?? 0;
            },
        })).resolves.toMatchObject({ username: 'target' });
        expect(estimatedCost).toBe(0.0026);
        expect(call).toHaveBeenCalledWith(
            { usernames: ['target'] },
            expect.objectContaining({
                timeout: 300,
                maxItems: 1,
                maxTotalChargeUsd: 0.0026,
                restartOnError: false,
            })
        );
    });

    it('keeps latest posts on the single-profile fallback path', async () => {
        const { client } = mockClient([{
            ...profileItem('target'),
            latestPosts: [{
                id: '1',
                shortCode: 'abcde',
                displayUrl: 'https://example.com/post.jpg',
                timestamp: 1_767_225_600,
            }],
        }]);

        await expect(makeApifyProvider({ client, env: {} }).getProfile!('target'))
            .resolves.toMatchObject({
                latestPosts: [{
                    shortCode: 'abcde',
                    timestamp: '2026-01-01T00:00:00.000Z',
                }],
            });
    });

    it('rejects profile calls before startup when their platform charge cap would be exceeded', async () => {
        const { client, call } = mockClient([profileItem('target')]);
        const provider = makeApifyProvider({
            client,
            env: { APIFY_PROFILE_MAX_ESTIMATED_COST_USD_PER_OPERATION: '0.001' },
        });

        await expect(provider.getProfile!('target')).rejects.toThrow('SCRAPING_BUDGET_ERROR');
        expect(call).not.toHaveBeenCalled();
    });

    it('rejects malformed profile booleans, URLs, and latest-post rows', async () => {
        const badBoolean = mockClient([{ ...profileItem('target'), private: 'false' }]);
        await expect(makeApifyProvider({ client: badBoolean.client, env: {} }).getProfile!('target'))
            .rejects.toThrow('SCRAPING_SCHEMA_ERROR');

        const badUrl = mockClient([{ ...profileItem('target'), profilePicUrl: 'not-a-url' }]);
        await expect(makeApifyProvider({ client: badUrl.client, env: {} }).getProfile!('target'))
            .rejects.toThrow('SCRAPING_SCHEMA_ERROR');

        const badPost = mockClient([{
            ...profileItem('target'),
            latestPosts: [{ shortCode: 'abc', displayUrl: 'https://example.com/p.jpg' }],
        }]);
        await expect(makeApifyProvider({ client: badPost.client, env: {} })
            .getProfilesBatch!(['target'], 1)).rejects.toThrow('latestPosts');
    });

    it('accepts the documented -1 hidden engagement-count sentinel', async () => {
        const { client } = mockClient([{
            ...profileItem('target'),
            latestPosts: [{
                id: '1',
                shortCode: 'abc',
                displayUrl: 'https://example.com/p.jpg',
                likesCount: -1,
                commentsCount: -1,
            }],
        }]);
        const provider = makeApifyProvider({ client, env: {} });

        await expect(provider.getProfilesBatch!(['target'], 1)).resolves.toMatchObject([{
            latestPosts: [{ likesCount: -1, commentsCount: -1 }],
        }]);
    });

    it('records item-based spend before rejecting malformed dataset metadata', async () => {
        const { client } = mockClient([relationshipItem('alice')]);
        const listItems = vi.fn().mockResolvedValue({
            items: [relationshipItem('alice')],
            total: Number.NaN,
            offset: 0,
            count: 1,
            limit: 1,
        });
        vi.mocked(client.dataset).mockReturnValue(
            { listItems } as unknown as ReturnType<typeof client.dataset>
        );
        let estimatedCost = 0;
        const provider = makeApifyProvider({
            client,
            env: { APIFY_DATASET_READ_RETRIES: '0' },
        });

        await expect(provider.getFollowers!('target', 1, {
            recordUsage(delta) {
                estimatedCost += delta.estimated_cost_usd ?? 0;
            },
        })).rejects.toThrow('dataset total');
        expect(estimatedCost).toBe(0.00085);
    });
});
