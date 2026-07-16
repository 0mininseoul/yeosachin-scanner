import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    APIFY_PROFILE_ACTOR_ID,
    APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD,
    APIFY_RELATIONSHIP_ACTOR_ID,
    apifyProvider,
    getApifyProfile,
    makeApifyProvider,
    parseApifyRelationshipDataset,
} from './apify';
import type { ApifyClientLike } from './apify-relationship';
import {
    selectAnalysisV2ApifyCredentialSlot,
    selectApifyApiToken,
    selectApifyCredentialSlot,
    runWithApifyActorSlot,
    startOrResumeApifyActor,
} from './apify-relationship';
import { selectAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import {
    createAnalysisV2ProviderRunStore,
    type AnalysisV2ProviderRunSupabaseClient,
} from '@/lib/services/analysis/v2-provider-run-store';
import type { InstagramProfile } from '@/lib/types/instagram';

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
    usageTotalUsd?: number,
    statusMessage?: string
) {
    const call = vi.fn().mockResolvedValue({ id: 'RunAbcd1234567890' });
    const waitForFinish = vi.fn().mockResolvedValue({
        status,
        defaultDatasetId: 'dataset',
        ...(usageTotalUsd === undefined ? {} : { usageTotalUsd }),
        ...(statusMessage === undefined ? {} : { statusMessage }),
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
            APIFY_PRIMARY_API_TOKEN: 'primary-token',
            APIFY_SECONDARY_API_TOKEN: 'secondary-token',
            APIFY_TERTIARY_API_TOKEN: 'tertiary-token',
            APIFY_QUATERNARY_API_TOKEN: 'quaternary-token',
            APIFY_QUINARY_API_TOKEN: 'quinary-token',
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
        for (const slot of ['tertiary', 'quaternary', 'quinary'] as const) {
            const selected = { ...env, ANALYSIS_V2_APIFY_API_TOKEN_SLOT: slot };
            expect(selectAnalysisV2ApifyCredentialSlot(selected)).toBe(slot);
            expect(selectApifyApiToken(selected, slot)).toBe(`${slot}-token`);
        }
        expect(() => selectAnalysisV2ApifyCredentialSlot({
            ...env,
            ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'pool',
        })).toThrow('ANALYSIS_V2_APIFY_API_TOKEN_SLOT');
        expect(selectApifyApiToken({ APIFY_API_TOKEN: 'legacy-primary-token' }))
            .toBe('legacy-primary-token');
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
            usageTotalUsd: null,
        });
        expect(onCostRunStarted.mock.invocationCallOrder[0])
            .toBeLessThan(waitForFinish.mock.invocationCallOrder[0]);
        expect(waitForFinish.mock.invocationCallOrder[0])
            .toBeLessThan(onCostRunFinished.mock.invocationCallOrder[0]);
        expect(client.run).toHaveBeenCalledWith('RunAbcd1234567890');
        expect(waitForFinish).toHaveBeenCalledWith({ waitSecs: 240 });
    });

    it('treats an Actor start deadline as ambiguous and never starts again', async () => {
        vi.useFakeTimers();
        try {
            const { client, call, waitForFinish } = mockClient([]);
            call.mockImplementation(() => new Promise(() => undefined));
            const onBeforeRunStart = vi.fn().mockResolvedValue(undefined);
            const onRunStarted = vi.fn();

            const pending = startOrResumeApifyActor(
                client,
                APIFY_RELATIONSHIP_ACTOR_ID,
                { Account: ['target'] },
                {
                    logicalProvider: 'apify',
                    credentialSlot: 'primary',
                    timeoutSecs: 300,
                    maxItems: 1,
                    maxTotalChargeUsd: 0.1,
                },
                {
                    invocationDeadlineAtMs: Date.now() + 1_000,
                    onBeforeRunStart,
                    onRunStarted,
                    recordUsage: vi.fn(),
                }
            );
            const rejection = expect(pending).rejects.toThrow(
                'SCRAPING_AMBIGUOUS_START_ERROR'
            );

            await vi.advanceTimersByTimeAsync(1_000);
            await rejection;
            expect(onBeforeRunStart).toHaveBeenCalledOnce();
            expect(call).toHaveBeenCalledOnce();
            expect(onRunStarted).not.toHaveBeenCalled();
            expect(waitForFinish).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
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
            usageTotalUsd: null,
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

    it.each(['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'])(
        'retries persisted Apify state %s against the exact run id',
        async status => {
            const { client, call } = mockClient([], status);
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
                {
                    resumeRunId: 'StoredRun12345678',
                    logicalProvider: 'apify',
                    actorId: APIFY_RELATIONSHIP_ACTOR_ID,
                    credentialSlot: 'primary',
                    maxChargeUsd: 0.1,
                    onCostRunFinished,
                    recordUsage: vi.fn(),
                }
            )).rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');

            expect(call).not.toHaveBeenCalled();
            expect(client.run).toHaveBeenCalledWith('StoredRun12345678');
            expect(onCostRunFinished).not.toHaveBeenCalled();
        }
    );

    it('retries a status-read transport failure only when the run id was persisted', async () => {
        const persisted = mockClient([]);
        persisted.waitForFinish.mockRejectedValueOnce(new Error('socket reset'));

        await expect(startOrResumeApifyActor(
            persisted.client,
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
                resumeRunId: 'StoredRun12345678',
                logicalProvider: 'apify',
                actorId: APIFY_RELATIONSHIP_ACTOR_ID,
                credentialSlot: 'primary',
                maxChargeUsd: 0.1,
                recordUsage: vi.fn(),
            }
        )).rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');
        expect(persisted.call).not.toHaveBeenCalled();

        const ambiguous = mockClient([]);
        ambiguous.waitForFinish.mockRejectedValueOnce(new Error('socket reset'));
        await expect(startOrResumeApifyActor(
            ambiguous.client,
            APIFY_RELATIONSHIP_ACTOR_ID,
            {},
            {
                logicalProvider: 'apify',
                credentialSlot: 'primary',
                timeoutSecs: 120,
                maxItems: 1,
                maxTotalChargeUsd: 0.1,
            },
            { recordUsage: vi.fn() }
        )).rejects.toThrow('SCRAPING_ERROR');
    });

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
            usageTotalUsd: null,
        }));
        expect(waitForFinish.mock.invocationCallOrder[0])
            .toBeLessThan(onCostRunFinished.mock.invocationCallOrder[0]);
    });

    it('fails a terminal free-tier quota run with a stable provider code', async () => {
        const message = [
            'Free API / MCP daily limit reached.',
            'To process larger exports, please upgrade to a paid Apify plan.',
            'Free users can still test manually from the Apify Console / Web UI.',
        ].join(' ');
        const { client } = mockClient([], 'SUCCEEDED', 0, message);
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
            { onCostRunFinished, recordUsage: vi.fn() }
        )).rejects.toThrow('SCRAPING_PROVIDER_QUOTA_ERROR');

        expect(onCostRunFinished).toHaveBeenCalledWith(expect.objectContaining({
            status: 'succeeded',
        }));
    });

    it.each([
        'Delivered 25 items with the Free API. Upgrade to a paid plan for larger batches.',
        'Daily limit reached for a separate integration; delivered requested results.',
        'Free API / MCP daily limit is available. Upgrade to a paid plan for more features.',
    ])('does not mistake a normal delivered status for a quota failure: %s', async message => {
        const { client } = mockClient([], 'SUCCEEDED', 0, message);

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
            { recordUsage: vi.fn() }
        )).resolves.toMatchObject({ status: 'SUCCEEDED', statusMessage: message });
    });

    it('preserves the quota code through the relationship provider wrapper', async () => {
        const message = 'Free API/MCP daily limit has been reached. Upgrade to paid plan now.';
        const { client, listItems } = mockClient([], 'SUCCEEDED', 0, message);

        await expect(makeApifyProvider({ client, env: {} }).getFollowers!('target', 1))
            .rejects.toThrow('SCRAPING_PROVIDER_QUOTA_ERROR');
        expect(listItems).not.toHaveBeenCalled();
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
                onCostRunStarted: vi.fn().mockRejectedValue(new Error(
                    'database unavailable with secret detail'
                )),
                recordUsage: vi.fn(),
            }
        )).rejects.toEqual(new Error(
            'ANALYSIS_V2_PROVIDER_RUN_COST_START_PERSISTENCE_ERROR'
        ));

        expect(abort).not.toHaveBeenCalled();
        expect(waitForFinish).not.toHaveBeenCalled();
    });

    it('preserves a typed conflict from the cost-start callback', async () => {
        const { client, waitForFinish } = mockClient([]);
        const pending = startOrResumeApifyActor(
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
                onCostRunStarted: vi.fn().mockRejectedValue(new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_COST_IDENTITY_CONFLICT: secret detail'
                )),
                recordUsage: vi.fn(),
            }
        );

        await expect(pending).rejects.toEqual(
            new Error('ANALYSIS_V2_PROVIDER_RUN_COST_IDENTITY_CONFLICT')
        );
        expect(waitForFinish).not.toHaveBeenCalled();
    });

    it('maps generic provider persistence from cost-start to its phase code', async () => {
        const { client, waitForFinish } = mockClient([]);
        const pending = startOrResumeApifyActor(
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
                onCostRunStarted: vi.fn().mockRejectedValue(new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: secret detail'
                )),
                recordUsage: vi.fn(),
            }
        );

        await expect(pending).rejects.toEqual(new Error(
            'ANALYSIS_V2_PROVIDER_RUN_COST_START_PERSISTENCE_ERROR'
        ));
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
                onBeforeRunStart: vi.fn().mockRejectedValue(new Error(
                    'database unavailable with secret detail'
                )),
                recordUsage: vi.fn(),
            }
        )).rejects.toEqual(new Error(
            'ANALYSIS_V2_PROVIDER_RUN_RESERVATION_PERSISTENCE_ERROR'
        ));

        expect(call).not.toHaveBeenCalled();
    });

    it('preserves a typed cleanup error from the start-intent callback', async () => {
        const { client, call } = mockClient([]);
        const pending = startOrResumeApifyActor(
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
                onBeforeRunStart: vi.fn().mockRejectedValue(new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED: secret detail'
                )),
                recordUsage: vi.fn(),
            }
        );

        await expect(pending).rejects.toEqual(
            new Error('ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED')
        );
        expect(call).not.toHaveBeenCalled();
    });

    it('maps generic provider persistence from start reservation to its phase code', async () => {
        const { client, call } = mockClient([]);
        const pending = startOrResumeApifyActor(
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
                onBeforeRunStart: vi.fn().mockRejectedValue(new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: secret detail'
                )),
                recordUsage: vi.fn(),
            }
        );

        await expect(pending).rejects.toEqual(new Error(
            'ANALYSIS_V2_PROVIDER_RUN_RESERVATION_PERSISTENCE_ERROR'
        ));
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
                onCostRunFinished: vi.fn().mockRejectedValue(new Error(
                    'database unavailable with secret detail'
                )),
                recordUsage: vi.fn(),
            }
        )).rejects.toEqual(new Error(
            'ANALYSIS_V2_PROVIDER_RUN_COST_TERMINAL_PERSISTENCE_ERROR'
        ));

        expect(abort).not.toHaveBeenCalled();
    });

    it('maps generic provider persistence from terminal cost to its phase code', async () => {
        const { client } = mockClient([], 'SUCCEEDED', 0.02);
        const pending = startOrResumeApifyActor(
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
                onCostRunFinished: vi.fn().mockRejectedValue(new Error(
                    'ANALYSIS_V2_PROVIDER_RUN_PERSISTENCE_ERROR: secret database detail'
                )),
                recordUsage: vi.fn(),
            }
        );

        await expect(pending).rejects.toEqual(
            new Error('ANALYSIS_V2_PROVIDER_RUN_COST_TERMINAL_PERSISTENCE_ERROR')
        );
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
                onRunStarted: vi.fn().mockRejectedValue(new Error(
                    'database unavailable with secret detail'
                )),
                recordUsage: vi.fn(),
            }
        )).rejects.toEqual(new Error(
            'SCRAPING_RUN_CHECKPOINT_ERROR: Apify run id could not be persisted.'
        ));

        expect(abort).toHaveBeenCalledOnce();
    });

    it('maps the real generic run checkpoint persistence error to the permanent checkpoint code', async () => {
        const { client, abort } = mockClient([]);
        const rpc = vi.fn().mockResolvedValue({
            data: null,
            error: {
                code: 'PGRST000',
                message: 'secret database detail',
            },
        });
        const providerRunStore = createAnalysisV2ProviderRunStore({
            rpc,
        } as AnalysisV2ProviderRunSupabaseClient);

        const pending = startOrResumeApifyActor(
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
                onRunStarted: async runId => {
                    await providerRunStore.checkpointStarted({
                        requestId: '11111111-1111-4111-8111-111111111111',
                        jobKey: 'track:relationships:collect',
                        claimToken: '22222222-2222-4222-8222-222222222222',
                        operationKey: `relationship-followers:${'a'.repeat(64)}`,
                        inputHash: 'b'.repeat(64),
                        reservationToken: '33333333-3333-4333-8333-333333333333',
                        runId,
                    });
                },
                recordUsage: vi.fn(),
            }
        );

        const error = await pending.catch(cause => cause as Error);
        expect(error).toEqual(new Error(
            'SCRAPING_RUN_CHECKPOINT_ERROR: Apify run id could not be persisted.'
        ));
        expect((error as Error).message).not.toContain('secret database detail');
        expect(abort).toHaveBeenCalledOnce();
    });

    it.each([
        'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH',
        'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT',
        'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
    ])('preserves typed %s from the run-id checkpoint after aborting the new run', async code => {
        const { client, abort } = mockClient([]);
        const pending = startOrResumeApifyActor(
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
                onRunStarted: vi.fn().mockRejectedValue(new Error(
                    `${code}: secret detail`
                )),
                recordUsage: vi.fn(),
            }
        );

        await expect(pending).rejects.toEqual(
            new Error(code)
        );
        expect(abort).toHaveBeenCalledOnce();
    });

    it('rejects an invalid invocation wait budget before starting an Actor', async () => {
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
                invocationWaitLimitSecs: 0,
            },
            { recordUsage: vi.fn() }
        )).rejects.toThrow('SCRAPING_CONFIG_ERROR');

        expect(call).not.toHaveBeenCalled();
    });

    it('name과 지원 기능이 노출된다', () => {
        expect(apifyProvider.name).toBe('apify');
        expect(typeof apifyProvider.getProfileSummary).toBe('function');
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
            usageTotalUsd: null,
        }));
    });

    it('keeps relationship intent reservation failures retryable through the provider wrapper', async () => {
        const { client, call } = mockClient([relationshipItem('alice')]);
        const provider = makeApifyProvider({ client, env: {} });

        await expect(provider.getFollowers!('target', 1, {
            onBeforeRunStart: vi.fn().mockRejectedValue(new Error(
                'database unavailable with secret detail'
            )),
            recordUsage: vi.fn(),
        })).rejects.toEqual(new Error(
            'ANALYSIS_V2_PROVIDER_RUN_RESERVATION_PERSISTENCE_ERROR'
        ));
        expect(call).not.toHaveBeenCalled();
    });

    it('preserves terminal persistence phase through the profile provider wrapper', async () => {
        const { client } = mockClient([profileItem('alice')]);
        const provider = makeApifyProvider({ client, env: {} });

        await expect(provider.getProfilesBatch!(['alice'], 1, {
            onCostRunFinished: vi.fn().mockRejectedValue(new Error(
                'database unavailable with secret detail'
            )),
            recordUsage: vi.fn(),
        })).rejects.toEqual(new Error(
            'ANALYSIS_V2_PROVIDER_RUN_COST_TERMINAL_PERSISTENCE_ERROR'
        ));
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

    it('reads the Plus 1,200-result boundary completely across dataset pages', async () => {
        const items = Array.from({ length: 1_200 }, (_, index) => relationshipItem(`u${index}`));
        const { client, listItems } = mockClient(items);
        const provider = makeApifyProvider({ client, env: {} });

        await expect(provider.getFollowers!('target', 1_200)).resolves.toHaveLength(1_200);
        expect(listItems).toHaveBeenCalledTimes(2);
        expect(listItems).toHaveBeenNthCalledWith(1, { offset: 0, limit: 1_000 });
        expect(listItems).toHaveBeenNthCalledWith(2, { offset: 1_000, limit: 201 });
    });

    it('rejects result and estimated-cost ceilings before starting the actor', async () => {
        const overLimit = mockClient([]);
        await expect(makeApifyProvider({ client: overLimit.client, env: {} })
            .getFollowers!('target', 1_201)).rejects.toThrow('limit');
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

    it.each([
        'ANALYSIS_V2_PROGRESS_FENCE_MISMATCH',
        'ANALYSIS_V2_PROGRESS_PERSISTENCE_ERROR: heartbeat failed (PGRST000).',
    ])('preserves exact progress error %s and never touches a checkpointed Actor', async message => {
        const { client, call, waitForFinish } = mockClient([profileItem('alice')]);
        const provider = makeApifyProvider({ client, env: {} });
        const progressError = new Error(message);
        const onProfileStart = vi.fn().mockRejectedValue(progressError);

        await expect(provider.getProfilesBatchOutcomes!(['alice'], 1, {
            resumeRunId: 'StoredRun12345678',
            logicalProvider: 'apify',
            actorId: 'apify/instagram-profile-scraper',
            credentialSlot: 'primary',
            maxChargeUsd: 0.0026,
            onProfileStart,
            recordUsage: vi.fn(),
        })).rejects.toBe(progressError);

        expect(onProfileStart).toHaveBeenCalledWith('alice');
        expect(call).not.toHaveBeenCalled();
        expect(client.run).not.toHaveBeenCalled();
        expect(waitForFinish).not.toHaveBeenCalled();
    });

    it('does not expose a queued profile as active before the Actor slot is acquired', async () => {
        let releaseSlot!: () => void;
        let slotAcquired = false;
        const slotReleased = new Promise<void>((resolve) => {
            releaseSlot = resolve;
        });
        const slotHolder = runWithApifyActorSlot(1, async () => {
            slotAcquired = true;
            await slotReleased;
        });
        await vi.waitFor(() => expect(slotAcquired).toBe(true));

        const { client, call } = mockClient([profileItem('alice')]);
        const provider = makeApifyProvider({
            client,
            env: {
                APIFY_ACTOR_CONCURRENCY: '1',
                APIFY_DATASET_RETRY_BASE_DELAY_MS: '0',
            },
        });
        const onProfileStart = vi.fn().mockResolvedValue(undefined);
        const result = provider.getProfilesBatchOutcomes!(['alice'], 1, {
            onProfileStart,
            recordUsage: vi.fn(),
        });

        try {
            await Promise.resolve();
            await Promise.resolve();
            expect(onProfileStart).not.toHaveBeenCalled();
            expect(call).not.toHaveBeenCalled();
        } finally {
            releaseSlot();
            await slotHolder;
        }
        await expect(result).resolves.toMatchObject([{
            outcome: { requestedUsername: 'alice', status: 'success' },
        }]);

        expect(onProfileStart).toHaveBeenCalledWith('alice');
        expect(onProfileStart.mock.invocationCallOrder[0])
            .toBeLessThan(call.mock.invocationCallOrder[0]);
    });

    it('keeps a single unexplained Actor omission retryable instead of claiming not-found', async () => {
        const { client, call } = mockClient([profileItem('alice')]);
        const provider = makeApifyProvider({
            client,
            env: { APIFY_DATASET_RETRY_BASE_DELAY_MS: '0' },
        });

        const results = await provider.getProfilesBatchOutcomes!(['alice', 'bob'], 2);

        expect(results.map(result => [
            result.outcome.requestedUsername,
            result.outcome.status,
            result.outcome.failureCategory,
        ])).toEqual([
            ['alice', 'success', null],
            ['bob', 'failed', 'incomplete'],
        ]);
        expect(call).toHaveBeenCalledOnce();
    });

    it('accepts unavailable only with explicit upstream not-found evidence', async () => {
        const { client } = mockClient([
            profileItem('alice'),
            { username: 'bob', statusCode: 404 },
        ]);
        const provider = makeApifyProvider({ client, env: {} });

        const results = await provider.getProfilesBatchOutcomes!(['alice', 'bob'], 2);

        expect(results.map(result => [
            result.outcome.requestedUsername,
            result.outcome.status,
            result.outcome.failureCategory,
        ])).toEqual([
            ['alice', 'success', null],
            ['bob', 'unavailable', 'not_found'],
        ]);
    });

    it('preserves valid profile outcomes when one attributed dataset row is malformed', async () => {
        const { client } = mockClient([
            profileItem('alice'),
            { ...profileItem('bob'), private: 'false' },
        ]);
        const provider = makeApifyProvider({ client, env: {} });

        const results = await provider.getProfilesBatchOutcomes!(['alice', 'bob'], 2);

        expect(results.map(result => [
            result.outcome.requestedUsername,
            result.outcome.status,
            result.outcome.failureCategory,
        ])).toEqual([
            ['alice', 'success', null],
            ['bob', 'failed', 'schema'],
        ]);
    });

    it('classifies an attributed public row without its declared posts as incomplete', async () => {
        const { client } = mockClient([
            profileItem('alice'),
            { ...profileItem('bob'), postsCount: 43, latestPosts: [] },
        ]);
        const provider = makeApifyProvider({ client, env: {} });

        const results = await provider.getProfilesBatchOutcomes!(['alice', 'bob'], 2);

        expect(results.map(result => [
            result.outcome.requestedUsername,
            result.outcome.status,
            result.outcome.failureCategory,
        ])).toEqual([
            ['alice', 'success', null],
            ['bob', 'failed', 'incomplete'],
        ]);
    });

    it('classifies mass profile omissions as incomplete instead of account-not-found', async () => {
        const usernames = Array.from({ length: 30 }, (_, index) => `user${index}`);
        const { client } = mockClient([profileItem('user0')]);
        const provider = makeApifyProvider({ client, env: {} });

        const results = await provider.getProfilesBatchOutcomes!(usernames, 30);

        expect(results[0]).toMatchObject({
            outcome: { requestedUsername: 'user0', status: 'success' },
        });
        expect(results.slice(1).every(result => (
            result.outcome.status === 'failed'
            && result.outcome.failureCategory === 'incomplete'
        ))).toBe(true);
    });

    it('settles a durable outcome omission as failed incomplete after a succeeded Actor Dataset read', async () => {
        const { client, call, listItems } = mockClient([profileItem('alice')]);
        const provider = makeApifyProvider({ client, env: {} });

        await expect(provider.getProfilesBatchOutcomes!(['alice', 'bob'], 2, {
            resumeRunId: 'StoredRun12345678',
            logicalProvider: 'apify',
            actorId: APIFY_PROFILE_ACTOR_ID,
            credentialSlot: 'primary',
            maxChargeUsd: 0.0052,
            recordUsage: vi.fn(),
        })).resolves.toMatchObject([
            { outcome: { requestedUsername: 'alice', status: 'success' } },
            {
                outcome: {
                    requestedUsername: 'bob',
                    status: 'failed',
                    failureCategory: 'incomplete',
                },
            },
        ]);

        expect(call).not.toHaveBeenCalled();
        expect(client.run).toHaveBeenCalledWith('StoredRun12345678');
        expect(listItems).toHaveBeenCalledOnce();
    });

    it('keeps a durable one-account omission open for exact-run retry', async () => {
        const { client } = mockClient([]);
        const provider = makeApifyProvider({
            client,
            env: { APIFY_DATASET_RETRY_BASE_DELAY_MS: '0' },
        });

        await expect(provider.getProfilesBatch!(['unavailable'], 1, {
            onRunStarted: vi.fn(),
            recordUsage: vi.fn(),
        })).rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');
    });

    it('keeps a durable profile batch with multiple omissions open for exact-run retry', async () => {
        const usernames = Array.from({ length: 30 }, (_, index) => `user${index}`);
        const { client } = mockClient(usernames.slice(0, 28).map(profileItem));
        const provider = makeApifyProvider({ client, env: {} });

        await expect(provider.getProfilesBatch!(usernames, 30, {
            onRunStarted: vi.fn(),
            recordUsage: vi.fn(),
        })).rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');
    });

    it('still rejects malformed rows in a durable partial profile result', async () => {
        const { client } = mockClient([{ username: 'alice' }]);
        const provider = makeApifyProvider({ client, env: {} });

        await expect(provider.getProfilesBatch!(['alice', 'unavailable'], 2, {
            onRunStarted: vi.fn(),
            recordUsage: vi.fn(),
        })).rejects.toThrow('SCHEMA');
    });

    it('rereads a preliminary profile dataset without rerunning the paid actor', async () => {
        const usernames = Array.from({ length: 30 }, (_, index) => `user${index}`);
        const items = usernames.slice(0, 29).map(profileItem);
        const { client, call } = mockClient(items);
        const listItems = vi.fn()
            .mockResolvedValueOnce({
                items: items.slice(0, 17),
                total: 29,
                offset: 0,
                count: 17,
                limit: 31,
            })
            .mockResolvedValueOnce({
                items,
                total: 29,
                offset: 0,
                count: 29,
                limit: 31,
            });
        vi.mocked(client.dataset).mockReturnValue(
            { listItems } as unknown as ReturnType<typeof client.dataset>
        );
        const provider = makeApifyProvider({
            client,
            env: { APIFY_DATASET_RETRY_BASE_DELAY_MS: '0' },
        });

        await expect(provider.getProfilesBatch!(usernames, 30)).rejects.toThrow('INCOMPLETE');
        expect(call).toHaveBeenCalledTimes(1);
        expect(listItems).toHaveBeenCalledTimes(2);
    });

    it('rereads a preliminary empty profile dataset before accepting it', async () => {
        const item = profileItem('alice');
        const { client, call } = mockClient([item]);
        const listItems = vi.fn()
            .mockResolvedValueOnce({ items: [], total: 0, offset: 0, count: 0, limit: 2 })
            .mockResolvedValueOnce({ items: [item], total: 1, offset: 0, count: 1, limit: 2 });
        vi.mocked(client.dataset).mockReturnValue(
            { listItems } as unknown as ReturnType<typeof client.dataset>
        );
        const provider = makeApifyProvider({
            client,
            env: { APIFY_DATASET_RETRY_BASE_DELAY_MS: '0' },
        });

        await expect(provider.getProfile!('alice')).resolves.toMatchObject({ username: 'alice' });
        expect(call).toHaveBeenCalledTimes(1);
        expect(listItems).toHaveBeenCalledTimes(2);
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

    it('cancels a queued unreserved relationship run before usage, reservation, or Actor start', async () => {
        let releaseFirst!: () => void;
        const start = vi.fn().mockResolvedValue({ id: 'FirstRun12345678' });
        const waitForFinish = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => {
                releaseFirst = () => resolve({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
            }))
            .mockResolvedValueOnce({ status: 'SUCCEEDED', defaultDatasetId: 'dataset' });
        const listItems = vi.fn().mockResolvedValue({
            items: [relationshipItem('alice')],
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
        const controller = new AbortController();
        const recordQueuedUsage = vi.fn();
        const onBeforeQueuedStart = vi.fn();
        const onQueuedCostStart = vi.fn();
        const onQueuedCostFinished = vi.fn();

        const active = provider.getFollowers!('target', 1);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        const queued = provider.getFollowing!('target', 1, {
            startCancellationSignal: controller.signal,
            onBeforeRunStart: onBeforeQueuedStart,
            onCostRunStarted: onQueuedCostStart,
            onCostRunFinished: onQueuedCostFinished,
            recordUsage: recordQueuedUsage,
        });
        const queuedRejection = expect(queued).rejects.toThrow(
            'SCRAPING_QUEUED_START_CANCELLED'
        );

        controller.abort();
        releaseFirst();

        await expect(active).resolves.toHaveLength(1);
        await queuedRejection;
        expect(start).toHaveBeenCalledOnce();
        expect(recordQueuedUsage).not.toHaveBeenCalled();
        expect(onBeforeQueuedStart).not.toHaveBeenCalled();
        expect(onQueuedCostStart).not.toHaveBeenCalled();
        expect(onQueuedCostFinished).not.toHaveBeenCalled();
    });

    it('resumes a checkpointed relationship run despite queued-start cancellation', async () => {
        const { client, call } = mockClient([relationshipItem('alice')]);
        const provider = makeApifyProvider({ client, env: {} });
        const controller = new AbortController();
        controller.abort();

        await expect(provider.getFollowers!('target', 1, {
            resumeRunId: 'StoredRun12345678',
            logicalProvider: 'apify',
            actorId: APIFY_RELATIONSHIP_ACTOR_ID,
            credentialSlot: 'primary',
            maxChargeUsd: 0.1,
            startCancellationSignal: controller.signal,
            recordUsage: vi.fn(),
        })).resolves.toHaveLength(1);

        expect(call).not.toHaveBeenCalled();
        expect(client.run).toHaveBeenCalledWith('StoredRun12345678');
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

    it('surfaces exhausted relationship dataset transport as retryable only for a checkpointed run', async () => {
        const exhausted = mockClient([relationshipItem('alice')]);
        const failedRead = vi.fn().mockRejectedValue(new Error('transport failure'));
        vi.mocked(exhausted.client.dataset).mockReturnValue(
            { listItems: failedRead } as unknown as ReturnType<typeof exhausted.client.dataset>
        );
        const provider = makeApifyProvider({
            client: exhausted.client,
            env: { APIFY_DATASET_READ_RETRIES: '0' },
        });

        await expect(provider.getFollowers!('target', 1, {
            resumeRunId: 'StoredRun12345678',
            logicalProvider: 'apify',
            actorId: APIFY_RELATIONSHIP_ACTOR_ID,
            credentialSlot: 'primary',
            maxChargeUsd: 0.1,
            recordUsage: vi.fn(),
        })).rejects.toThrow('SCRAPING_DATASET_TRANSIENT_ERROR');
        expect(exhausted.call).not.toHaveBeenCalled();
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

    it('uses a one-item 75-second bounded Actor run for a timeline-independent summary', async () => {
        const { client, call, waitForFinish } = mockClient([{
            ...profileItem('target'),
            postsCount: 20,
            latestPosts: [{ malformed: 'ignored by summary' }],
        }]);
        const provider = makeApifyProvider({ client, env: {} });
        const onBeforeRunStart = vi.fn().mockResolvedValue(undefined);
        const onRunStarted = vi.fn().mockResolvedValue(undefined);

        await expect(provider.getProfileSummary!('target', {
            credentialSlot: 'quinary',
            maxChargeUsd: APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD,
            onBeforeRunStart,
            onRunStarted,
            recordUsage: vi.fn(),
        })).resolves.toMatchObject({
            username: 'target',
            postsCount: 20,
        });

        expect(client.actor).toHaveBeenCalledWith(APIFY_PROFILE_ACTOR_ID);
        expect(call).toHaveBeenCalledWith(
            { usernames: ['target'] },
            expect.objectContaining({
                maxItems: 1,
                maxTotalChargeUsd: 0.0026,
                restartOnError: false,
            })
        );
        expect(waitForFinish).toHaveBeenCalledWith({ waitSecs: 75 });
        expect(onBeforeRunStart).toHaveBeenCalledWith(expect.objectContaining({
            actorId: APIFY_PROFILE_ACTOR_ID,
            credentialSlot: 'quinary',
            maxChargeUsd: 0.0026,
        }));
    });

    it('preserves queued-start cancellation before a new profile Actor reservation', async () => {
        const { client, call, waitForFinish } = mockClient([profileItem('target')]);
        const provider = makeApifyProvider({ client, env: {} });
        const controller = new AbortController();
        const recordUsage = vi.fn();
        const onBeforeRunStart = vi.fn();
        controller.abort();

        await expect(provider.getProfile!('target', {
            startCancellationSignal: controller.signal,
            onBeforeRunStart,
            recordUsage,
        })).rejects.toThrow('SCRAPING_QUEUED_START_CANCELLED');

        expect(recordUsage).not.toHaveBeenCalled();
        expect(onBeforeRunStart).not.toHaveBeenCalled();
        expect(call).not.toHaveBeenCalled();
        expect(waitForFinish).not.toHaveBeenCalled();
    });

    it('keeps a running summary retryable and resumes without another Actor start', async () => {
        const { client, call, waitForFinish } = mockClient([profileItem('target')], 'RUNNING');
        const provider = makeApifyProvider({ client, env: {} });

        await expect(provider.getProfileSummary!('target', {
            resumeRunId: 'StoredRun12345678',
            logicalProvider: 'apify',
            actorId: APIFY_PROFILE_ACTOR_ID,
            credentialSlot: 'quinary',
            maxChargeUsd: 0.0026,
            recordUsage: vi.fn(),
        })).rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');

        expect(call).not.toHaveBeenCalled();
        expect(waitForFinish).toHaveBeenCalledWith({ waitSecs: 75 });
    });

    it('accepts only explicit matching not-found evidence on a summary row', async () => {
        const missing = mockClient([{ username: 'target', statusCode: 404 }]);
        await expect(makeApifyProvider({ client: missing.client, env: {} })
            .getProfileSummary!('target')).resolves.toBeNull();

        const mismatch = mockClient([{ username: 'other', statusCode: 404 }]);
        await expect(makeApifyProvider({ client: mismatch.client, env: {} })
            .getProfileSummary!('target')).rejects.toThrow('username mismatch');
    });

    it('never converts an ambiguous empty summary dataset into target-not-found', async () => {
        const durable = mockClient([]);
        await expect(makeApifyProvider({
            client: durable.client,
            env: { APIFY_DATASET_READ_RETRIES: '0' },
        }).getProfileSummary!('target', {
            resumeRunId: 'StoredRun12345678',
            logicalProvider: 'apify',
            actorId: APIFY_PROFILE_ACTOR_ID,
            credentialSlot: 'quinary',
            maxChargeUsd: 0.0026,
            recordUsage: vi.fn(),
        })).rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');

        const nonDurable = mockClient([]);
        await expect(makeApifyProvider({
            client: nonDurable.client,
            env: { APIFY_DATASET_READ_RETRIES: '0' },
        }).getProfileSummary!('target', {
            recordUsage: vi.fn(),
        })).rejects.toThrow('SCRAPING_INCOMPLETE_ERROR');
    });

    it('does not reserve or start a paid summary when the end-to-end deadline is too close', async () => {
        const { client, call, waitForFinish } = mockClient([profileItem('target')]);
        const onBeforeRunStart = vi.fn();

        await expect(makeApifyProvider({ client, env: {} }).getProfileSummary!('target', {
            credentialSlot: 'quinary',
            maxChargeUsd: 0.0026,
            invocationDeadlineAtMs: Date.now() + 19_000,
            onBeforeRunStart,
            onRunStarted: vi.fn(),
            recordUsage: vi.fn(),
        })).rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');

        expect(onBeforeRunStart).not.toHaveBeenCalled();
        expect(call).not.toHaveBeenCalled();
        expect(waitForFinish).not.toHaveBeenCalled();
    });

    it('retries a running profile Actor by the same checkpointed run id without another start', async () => {
        const { client, call, waitForFinish } = mockClient([profileItem('target')]);
        waitForFinish
            .mockReset()
            .mockResolvedValueOnce({
                status: 'RUNNING',
                defaultDatasetId: 'dataset',
            })
            .mockResolvedValueOnce({
                status: 'SUCCEEDED',
                defaultDatasetId: 'dataset',
            });
        const provider = makeApifyProvider({ client, env: {} });
        const onRunStarted = vi.fn().mockResolvedValue(undefined);

        await expect(provider.getProfilesBatchOutcomes!(['target'], 1, {
            onBeforeRunStart: vi.fn().mockResolvedValue(undefined),
            onRunStarted,
            recordUsage: vi.fn(),
        })).rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');
        expect(onRunStarted).toHaveBeenCalledWith('RunAbcd1234567890');

        await expect(provider.getProfilesBatchOutcomes!(['target'], 1, {
            resumeRunId: 'RunAbcd1234567890',
            logicalProvider: 'apify',
            credentialSlot: 'primary',
            maxChargeUsd: 0.0026,
            recordUsage: vi.fn(),
        })).resolves.toMatchObject([{
            outcome: { requestedUsername: 'target', status: 'success' },
        }]);

        expect(call).toHaveBeenCalledOnce();
        expect(client.run).toHaveBeenLastCalledWith('RunAbcd1234567890');
    });

    it('retries a profile dataset read through the same run instead of starting again', async () => {
        const { client, call, listItems } = mockClient([profileItem('target')]);
        listItems
            .mockReset()
            .mockRejectedValueOnce(new Error('dataset transport failed'))
            .mockResolvedValueOnce({
                items: [profileItem('target')],
                total: 1,
                offset: 0,
                count: 1,
                limit: 2,
            });
        const provider = makeApifyProvider({
            client,
            env: {
                APIFY_DATASET_READ_RETRIES: '0',
                APIFY_DATASET_RETRY_BASE_DELAY_MS: '0',
            },
        });

        await expect(provider.getProfilesBatchOutcomes!(['target'], 1, {
            onBeforeRunStart: vi.fn().mockResolvedValue(undefined),
            onRunStarted: vi.fn().mockResolvedValue(undefined),
            recordUsage: vi.fn(),
        })).rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');

        await expect(provider.getProfilesBatchOutcomes!(['target'], 1, {
            resumeRunId: 'RunAbcd1234567890',
            logicalProvider: 'apify',
            credentialSlot: 'primary',
            maxChargeUsd: 0.0026,
            recordUsage: vi.fn(),
        })).resolves.toHaveLength(1);

        expect(call).toHaveBeenCalledOnce();
        expect(listItems).toHaveBeenCalledTimes(2);
    });

    it('settles an unexplained profile omission without reopening the paid run', async () => {
        const { client, call, listItems } = mockClient([]);
        listItems
            .mockReset()
            .mockResolvedValueOnce({
                items: [], total: 0, offset: 0, count: 0, limit: 2,
            });
        const provider = makeApifyProvider({
            client,
            env: {
                APIFY_DATASET_READ_RETRIES: '0',
                APIFY_DATASET_RETRY_BASE_DELAY_MS: '0',
            },
        });

        await expect(provider.getProfilesBatchOutcomes!(['target'], 1, {
            onBeforeRunStart: vi.fn().mockResolvedValue(undefined),
            onRunStarted: vi.fn().mockResolvedValue(undefined),
            recordUsage: vi.fn(),
        })).resolves.toMatchObject([{
            outcome: {
                requestedUsername: 'target',
                status: 'failed',
                failureCategory: 'incomplete',
            },
        }]);

        expect(call).toHaveBeenCalledOnce();
        expect(client.run).toHaveBeenCalledOnce();
        expect(client.run).toHaveBeenCalledWith('RunAbcd1234567890');
        expect(listItems).toHaveBeenCalledOnce();
    });

    it('keeps latest posts on the single-profile fallback path', async () => {
        const { client } = mockClient([{
            ...profileItem('target'),
            latestPosts: [{
                id: '1',
                shortCode: 'abcde',
                type: 'Image',
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

    it('exports the full-profile wrapper without stripping latest posts', async () => {
        const expected: InstagramProfile = {
            username: 'target',
            followersCount: 1,
            followingCount: 1,
            postsCount: 1,
            isPrivate: false,
            isVerified: false,
            latestPosts: [{
                id: '1',
                shortCode: 'abcde',
                imageUrl: 'https://example.com/post.jpg',
                type: 'image' as const,
                hashtags: [],
                likesCount: 0,
                commentsCount: 0,
                timestamp: '2026-01-01T00:00:00.000Z',
                taggedUsers: [],
                mentionedUsers: [],
            }],
        };
        const getProfile = vi.fn().mockResolvedValueOnce(expected);
        const originalGetProfile = apifyProvider.getProfile;
        apifyProvider.getProfile = getProfile;
        const context = {
            resumeRunId: 'StoredRun12345678',
            logicalProvider: 'apify' as const,
            actorId: APIFY_PROFILE_ACTOR_ID,
            credentialSlot: 'quinary' as const,
            maxChargeUsd: APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD,
            recordUsage: vi.fn(),
        };

        try {
            await expect(getApifyProfile('target', context)).resolves.toEqual(expected);
            expect(getProfile).toHaveBeenCalledWith('target', context);
        } finally {
            apifyProvider.getProfile = originalGetProfile;
        }
    });

    it('maps latest posts while replaying a full-profile run without another Actor start', async () => {
        const { client, call } = mockClient([{
            ...profileItem('target'),
            postsCount: 1,
            latestPosts: [{
                id: '1',
                shortCode: 'abcde',
                type: 'Image',
                displayUrl: 'https://example.com/post.jpg',
                timestamp: 1_767_225_600,
            }],
        }]);

        await expect(makeApifyProvider({ client, env: {} }).getProfile!('target', {
            resumeRunId: 'StoredRun12345678',
            logicalProvider: 'apify',
            actorId: APIFY_PROFILE_ACTOR_ID,
            credentialSlot: 'quinary',
            maxChargeUsd: APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD,
            recordUsage: vi.fn(),
        })).resolves.toMatchObject({
            latestPosts: [{ shortCode: 'abcde' }],
        });
        expect(call).not.toHaveBeenCalled();
        expect(client.run).toHaveBeenCalledWith('StoredRun12345678');
    });

    it('rejects a public profile whose recent-post snapshot is shorter than min(postsCount, 8)', async () => {
        const { client } = mockClient([{
            ...profileItem('target'),
            postsCount: 9,
            latestPosts: Array.from({ length: 7 }, (_, index) => ({
                id: String(index + 1),
                shortCode: `post${index + 1}`,
                type: 'Image',
                displayUrl: `https://example.com/post-${index + 1}.jpg`,
                timestamp: 1_767_225_600 - index,
            })),
        }]);

        await expect(makeApifyProvider({ client, env: {} }).getProfile!('target'))
            .rejects.toThrow('SCRAPING_INCOMPLETE_ERROR');
    });

    it('proves documented Apify carousel completeness and exposes safety contact frames', async () => {
        const { client } = mockClient([{
            ...profileItem('target'),
            latestPosts: [{
                id: 'sidecar-1',
                shortCode: 'sidecar',
                type: 'Sidecar',
                displayUrl: 'https://example.com/sidecar-cover.jpg',
                timestamp: '2026-01-01T00:00:00.000Z',
                mentions: ['Provider.User', 'TARGET.USER'],
                images: [
                    'https://example.com/child-1.jpg',
                    'https://example.com/child-2.jpg',
                    'https://example.com/child-3.jpg',
                    'https://example.com/child-4.jpg',
                ],
                childPosts: [
                    {
                        id: 'child-1',
                        type: 'Image',
                        displayUrl: 'https://example.com/child-1.jpg',
                        caption: ' First slide with @target.user and plain.user ',
                    },
                    {
                        id: 'child-2',
                        type: 'Video',
                        displayUrl: 'https://example.com/child-2.jpg',
                        videoUrl: 'https://example.com/child-2.mp4',
                        caption: ' Second slide with @Slide.Two and @TARGET.USER ',
                    },
                    {
                        id: 'child-3',
                        type: 'Image',
                        displayUrl: 'https://example.com/child-3.jpg',
                        caption: ` Third slide with @${'a'.repeat(31)} `,
                    },
                    {
                        id: 'child-4',
                        type: 'Image',
                        displayUrl: 'https://example.com/child-4.jpg',
                        caption: null,
                    },
                ],
            }],
        }]);

        const profile = await makeApifyProvider({ client, env: {} }).getProfile!('target');
        if (!profile) throw new Error('expected Apify profile fixture');
        const [post] = profile.latestPosts!;

        expect(post).toMatchObject({
            type: 'carousel',
            imageUrl: 'https://example.com/sidecar-cover.jpg',
            declaredMediaCount: 4,
            childrenComplete: true,
        });
        expect(post.mediaItems).toEqual([
            {
                id: 'child-1',
                type: 'image',
                caption: 'First slide with @target.user and plain.user',
                imageUrl: 'https://example.com/child-1.jpg',
            },
            {
                id: 'child-2',
                type: 'video',
                caption: 'Second slide with @Slide.Two and @TARGET.USER',
                thumbnailUrl: 'https://example.com/child-2.jpg',
                videoUrl: 'https://example.com/child-2.mp4',
            },
            {
                id: 'child-3',
                type: 'image',
                caption: `Third slide with @${'a'.repeat(31)}`,
                imageUrl: 'https://example.com/child-3.jpg',
            },
            {
                id: 'child-4',
                type: 'image',
                imageUrl: 'https://example.com/child-4.jpg',
            },
        ]);
        expect(post.mentionedUsers).toEqual([
            'provider.user',
            'target.user',
            'slide.two',
        ]);
        const selected = selectAnalysisMedia({
            posts: profile.latestPosts!.map(post => ({
                ...post,
                timestamp: post.timestamp ?? 0,
            })),
        });
        expect(selected.feed.media.map(media => media.mediaIndex)).toEqual([0, 2, 3]);
        expect(selected.partnerSafetyContactSheetCandidates.media).toMatchObject([
            { mediaIndex: 1, role: 'partner_safety_contact' },
        ]);
    });

    it('maps documented clips as reels and keeps their display thumbnail separate from video', async () => {
        const { client } = mockClient([{
            ...profileItem('target'),
            latestPosts: [{
                id: 'reel-1',
                shortCode: 'reel',
                type: 'Video',
                productType: 'clips',
                displayUrl: 'https://example.com/reel-thumb.jpg',
                videoUrl: 'https://example.com/reel.mp4',
            }],
        }]);

        await expect(makeApifyProvider({ client, env: {} }).getProfile!('target'))
            .resolves.toMatchObject({
                latestPosts: [{
                    type: 'reel',
                    imageUrl: 'https://example.com/reel-thumb.jpg',
                    thumbnailUrl: 'https://example.com/reel-thumb.jpg',
                    videoUrl: 'https://example.com/reel.mp4',
                }],
            });
    });

    it.each([
        {
            label: 'carousel without childPosts',
            post: {
                id: '1',
                shortCode: 'abc',
                type: 'Sidecar',
                displayUrl: 'https://example.com/p.jpg',
            },
        },
        {
            label: 'childPosts on a non-carousel post',
            post: {
                id: '1',
                shortCode: 'abc',
                type: 'Image',
                displayUrl: 'https://example.com/p.jpg',
                childPosts: [
                    { id: '1', type: 'Image', displayUrl: 'https://example.com/one.jpg' },
                ],
            },
        },
        {
            label: 'raw video as display image',
            post: {
                id: '1',
                shortCode: 'abc',
                type: 'Video',
                displayUrl: 'https://example.com/raw.mp4?token=test',
                videoUrl: 'https://example.com/raw.mp4?token=test',
            },
        },
        {
            label: 'image with video URL',
            post: {
                id: '1',
                shortCode: 'abc',
                type: 'Image',
                displayUrl: 'https://example.com/p.jpg',
                videoUrl: 'https://example.com/raw.mp4',
            },
        },
        {
            label: 'unknown post type',
            post: {
                id: '1',
                shortCode: 'abc',
                type: 'Unknown',
                displayUrl: 'https://example.com/p.jpg',
            },
        },
        {
            label: 'carousel image order mismatch',
            post: {
                id: '1',
                shortCode: 'abc',
                type: 'Sidecar',
                displayUrl: 'https://example.com/p.jpg',
                images: ['https://example.com/two.jpg'],
                childPosts: [
                    { id: '1', type: 'Image', displayUrl: 'https://example.com/one.jpg' },
                ],
            },
        },
        {
            label: 'opaque raw child video as display image',
            post: {
                id: '1',
                shortCode: 'abc',
                type: 'Sidecar',
                displayUrl: 'https://example.com/p.jpg',
                images: ['https://example.com/opaque-video'],
                childPosts: [{
                    id: '1',
                    type: 'Video',
                    displayUrl: 'https://example.com/opaque-video',
                    videoUrl: 'https://example.com/opaque-video',
                }],
            },
        },
    ])('fails closed for malformed or contradictory Apify media: $label', async ({ post }) => {
        const { client } = mockClient([{
            ...profileItem('target'),
            latestPosts: [post],
        }]);

        await expect(makeApifyProvider({ client, env: {} }).getProfile!('target'))
            .rejects.toThrow('SCRAPING_SCHEMA_ERROR');
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
                type: 'Image',
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
