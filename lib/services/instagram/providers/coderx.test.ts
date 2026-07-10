import { describe, expect, it, vi } from 'vitest';
import {
    CODERX_RELATIONSHIP_ACTOR_ID,
    coderXProvider,
    makeCoderXProvider,
} from './coderx';
import type { ApifyClientLike } from './apify-relationship';

function item(username: string) {
    return {
        pk: '123',
        id: '123',
        username,
        full_name: `${username} name`,
        profile_pic_url: 'https://example.com/p.jpg',
        is_private: false,
        is_verified: false,
    };
}

function mockClient(items: Array<Record<string, unknown>>) {
    const call = vi.fn().mockResolvedValue({ id: 'CoderxRun12345678' });
    const waitForFinish = vi.fn().mockResolvedValue({
        status: 'SUCCEEDED',
        defaultDatasetId: 'dataset',
    });
    const listItems = vi.fn(async ({ offset = 0, limit = items.length }: { offset?: number; limit?: number } = {}) => ({
        items: items.slice(offset, offset + limit),
        total: items.length,
        offset,
        count: Math.min(limit, Math.max(0, items.length - offset)),
        limit,
    }));
    const client = {
        actor: vi.fn(() => ({ start: call })),
        run: vi.fn(() => ({ waitForFinish, abort: vi.fn() })),
        dataset: vi.fn(() => ({ listItems })),
    } as unknown as ApifyClientLike;
    return { client, call, listItems };
}

describe('CoderX manual provider', () => {
    it('exposes both relationship methods but no profile capabilities', () => {
        expect(coderXProvider.name).toBe('coderx');
        expect(typeof coderXProvider.getFollowers).toBe('function');
        expect(typeof coderXProvider.getFollowing).toBe('function');
        expect(coderXProvider.getProfile).toBeUndefined();
        expect(coderXProvider.getProfilesBatch).toBeUndefined();
    });

    it('uses documented input and validates the final cursor record', async () => {
        const { client, call } = mockClient([
            item('alice'),
            item('bob'),
            { cursor: 'resume', total_scraped: 2 },
        ]);
        const provider = makeCoderXProvider({
            client,
            env: { APIFY_API_TOKEN_SLOT: 'secondary' },
        });
        let estimatedCost = 0;
        const onCostRunStarted = vi.fn();

        const result = await provider.getFollowers!('target', 2, {
            onCostRunStarted,
            recordUsage(delta) {
                estimatedCost += delta.estimated_cost_usd ?? 0;
            },
        });

        expect(result).toHaveLength(2);
        expect(client.actor).toHaveBeenCalledWith(CODERX_RELATIONSHIP_ACTOR_ID);
        expect(call).toHaveBeenCalledWith(
            { username: 'target', scrape_type: 'followers', max_items: 2 },
            expect.objectContaining({
                maxItems: 3,
                timeout: 300,
                restartOnError: false,
            })
        );
        expect(call.mock.calls[0]?.[1]).not.toHaveProperty('build');
        expect(estimatedCost).toBeCloseTo(3 * 0.0013);
        expect(onCostRunStarted).toHaveBeenCalledWith(expect.objectContaining({
            logicalProvider: 'coderx',
            actorId: CODERX_RELATIONSHIP_ACTOR_ID,
            credentialSlot: 'secondary',
            maxChargeUsd: 0.0039,
        }));
    });

    it('resumes only the stored CoderX Actor identity without starting a new run', async () => {
        const { client, call } = mockClient([item('alice')]);
        const provider = makeCoderXProvider({ client, env: {} });
        const onCostRunStarted = vi.fn();

        await expect(provider.getFollowers!('target', 1, {
            logicalProvider: 'coderx',
            actorId: CODERX_RELATIONSHIP_ACTOR_ID,
            credentialSlot: 'secondary',
            maxChargeUsd: 0.0039,
            resumeRunId: 'CoderxRun12345678',
            onCostRunStarted,
            recordUsage: vi.fn(),
        })).resolves.toHaveLength(1);

        expect(call).not.toHaveBeenCalled();
        expect(client.run).toHaveBeenCalledWith('CoderxRun12345678');
        expect(onCostRunStarted).toHaveBeenCalledWith(expect.objectContaining({
            credentialSlot: 'secondary',
            maxChargeUsd: 0.0039,
        }));
    });

    it('rejects cursor totals that do not match delivered users', async () => {
        const { client } = mockClient([
            item('alice'),
            { cursor: 'resume', total_scraped: 2 },
        ]);
        const provider = makeCoderXProvider({ client, env: {} });
        await expect(provider.getFollowers!('target', 2)).rejects.toThrow('total_scraped');
    });

    it('paginates a 1,000-user dataset plus metadata record', async () => {
        const users = Array.from({ length: 1_000 }, (_, index) => ({
            ...item(`u${index}`),
            pk: String(index + 1),
            id: String(index + 1),
        }));
        const { client, listItems } = mockClient([
            ...users,
            { cursor: 'resume', total_scraped: 1_000 },
        ]);
        const provider = makeCoderXProvider({ client, env: {} });

        await expect(provider.getFollowing!('target', 1_000)).resolves.toHaveLength(1_000);
        expect(listItems).toHaveBeenCalledTimes(2);
        expect(listItems).toHaveBeenNthCalledWith(1, { offset: 0, limit: 1_000 });
        expect(listItems).toHaveBeenNthCalledWith(2, { offset: 1_000, limit: 2 });
    });

    it('rejects result and estimated-cost ceilings before starting the actor', async () => {
        const overLimit = mockClient([]);
        await expect(makeCoderXProvider({ client: overLimit.client, env: {} })
            .getFollowers!('target', 1_001)).rejects.toThrow('limit');
        expect(overLimit.call).not.toHaveBeenCalled();

        const overCost = mockClient([]);
        await expect(makeCoderXProvider({
            client: overCost.client,
            env: {
                CODERX_MAX_RESULTS_PER_OPERATION: '2000',
                CODERX_MAX_ESTIMATED_COST_USD_PER_OPERATION: '1',
            },
        }).getFollowers!('target', 1_000)).rejects.toThrow('BUDGET');
        expect(overCost.call).not.toHaveBeenCalled();
    });
});
