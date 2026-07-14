import { describe, expect, it, vi } from 'vitest';
import {
    APIFY_COMMENTS_ACTOR_ID,
    APIFY_LIKERS_ACTOR_ID,
    makeApifyInteractionAdapter,
} from './apify-interactions';
import type { ApifyClientLike } from './apify-relationship';
import type { ProviderUsageDelta } from './types';

const BASE_ENV = {
    APIFY_DATASET_READ_RETRIES: '0',
    APIFY_DATASET_RETRY_BASE_DELAY_MS: '0',
};

function liker(username: string, postUrl: string, id = '123') {
    return {
        full_name: `${username} name`,
        id,
        is_private: false,
        is_verified: false,
        profile_pic_url: 'https://example.com/profile.jpg',
        username,
        liked_post: postUrl,
        total_likes: 321,
        is_new: true,
        ignored_future_field: 'allowed by explicit projection',
    };
}

function comment(id: string, postUrl?: string) {
    return {
        postUrl,
        commentUrl: `https://www.instagram.com/p/PostA/c/${id}/`,
        id,
        text: `comment ${id}`,
        ownerUsername: `user_${id}`,
        ownerProfilePicUrl: 'https://example.com/profile.jpg',
        timestamp: '2026-07-10T01:02:03.000Z',
        likesCount: 2,
        replies: [],
        ignored_future_field: 'allowed by explicit projection',
    };
}

function mockClient(
    items: Array<Record<string, unknown>>,
    options: { status?: string; total?: number; usageTotalUsd?: number } = {}
) {
    const call = vi.fn().mockResolvedValue({ id: 'RunAbcd1234567890' });
    const waitForFinish = vi.fn().mockResolvedValue({
        status: options.status ?? 'SUCCEEDED',
        defaultDatasetId: 'dataset',
        ...(options.usageTotalUsd === undefined
            ? {}
            : { usageTotalUsd: options.usageTotalUsd }),
    });
    const total = options.total ?? items.length;
    const listItems = vi.fn(async (
        { offset = 0, limit = items.length || 1 }: { offset?: number; limit?: number } = {}
    ) => {
        const pageItems = items.slice(offset, offset + limit);
        return {
            items: pageItems,
            total,
            offset,
            count: pageItems.length,
            limit,
        };
    });
    const client = {
        actor: vi.fn(() => ({ start: call })),
        run: vi.fn(() => ({ waitForFinish, abort: vi.fn() })),
        dataset: vi.fn(() => ({ listItems })),
    } as unknown as ApifyClientLike;
    return { client, call, waitForFinish, listItems };
}

describe('Apify interaction adapter', () => {
    it('batches DataDoping liker URLs with per-post limits and preserves attribution', async () => {
        const postA = 'https://www.instagram.com/p/PostA/';
        const postB = 'https://instagram.com/reels/PostB/?utm_source=test';
        const { client, call } = mockClient([
            liker('same_user', postA, '1'),
            liker('same_user', 'https://www.instagram.com/reel/PostB/', '1'),
        ]);
        const adapter = makeApifyInteractionAdapter({ client, env: BASE_ENV });

        const result = await adapter.getPostLikers([postA, postB], 150);

        expect(result).toHaveLength(2);
        expect(result.map((item) => item.postUrl)).toEqual([
            'https://www.instagram.com/p/PostA/',
            'https://www.instagram.com/reel/PostB/',
        ]);
        expect(client.actor).toHaveBeenCalledWith(APIFY_LIKERS_ACTOR_ID);
        expect(call).toHaveBeenCalledWith(
            {
                posts: [
                    'https://www.instagram.com/p/PostA/',
                    'https://www.instagram.com/reel/PostB/',
                ],
                max_count: 150,
            },
            expect.objectContaining({
                build: '0.0.9',
                maxItems: 300,
                maxTotalChargeUsd: 0.465,
                timeout: 300,
                restartOnError: false,
            })
        );
    });

    it('forwards the credential while deferring preliminary usage finalization', async () => {
        const post = 'https://www.instagram.com/p/PostA/';
        const { client } = mockClient([liker('alice', post)], { usageTotalUsd: 0.0014 });
        const adapter = makeApifyInteractionAdapter({
            client,
            env: { ...BASE_ENV, APIFY_API_TOKEN_SLOT: 'secondary' },
        });
        const onCostRunStarted = vi.fn();
        const onCostRunFinished = vi.fn();

        await expect(adapter.getPostLikers([post], 1, {
            onCostRunStarted,
            onCostRunFinished,
            recordUsage: vi.fn(),
        })).resolves.toHaveLength(1);

        expect(onCostRunStarted).toHaveBeenCalledWith(expect.objectContaining({
            actorId: APIFY_LIKERS_ACTOR_ID,
            credentialSlot: 'secondary',
            maxChargeUsd: 0.00155,
        }));
        expect(onCostRunFinished).toHaveBeenCalledWith(expect.objectContaining({
            status: 'succeeded',
            usageTotalUsd: null,
        }));
    });

    it('resumes interactions with the stored credential slot and charge cap', async () => {
        const post = 'https://www.instagram.com/p/PostA/';
        const { client, call } = mockClient([liker('alice', post)]);
        const adapter = makeApifyInteractionAdapter({ client, env: BASE_ENV });
        const onCostRunStarted = vi.fn();

        await expect(adapter.getPostLikers([post], 1, {
            logicalProvider: 'apify',
            actorId: APIFY_LIKERS_ACTOR_ID,
            credentialSlot: 'secondary',
            maxChargeUsd: 0.009,
            resumeRunId: 'StoredRun12345678',
            onCostRunStarted,
            recordUsage: vi.fn(),
        })).resolves.toHaveLength(1);

        expect(call).not.toHaveBeenCalled();
        expect(client.run).toHaveBeenCalledWith('StoredRun12345678');
        expect(onCostRunStarted).toHaveBeenCalledWith(expect.objectContaining({
            credentialSlot: 'secondary',
            maxChargeUsd: 0.009,
        }));
    });

    it('retries pending and temporarily unreadable interaction runs without a second start', async () => {
        const post = 'https://www.instagram.com/p/PostA/';
        const pending = mockClient([liker('alice', post)], { status: 'RUNNING' });
        const adapter = makeApifyInteractionAdapter({ client: pending.client, env: BASE_ENV });
        const checkpoint = {
            resumeRunId: 'StoredRun12345678',
            logicalProvider: 'apify' as const,
            actorId: APIFY_LIKERS_ACTOR_ID,
            credentialSlot: 'primary' as const,
            maxChargeUsd: 0.00155,
            recordUsage: vi.fn(),
        };

        await expect(adapter.getPostLikers([post], 1, checkpoint))
            .rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');
        expect(pending.call).not.toHaveBeenCalled();

        const unreadable = mockClient([liker('alice', post)]);
        unreadable.listItems.mockRejectedValueOnce(new Error('dataset unavailable'));
        await expect(makeApifyInteractionAdapter({
            client: unreadable.client,
            env: BASE_ENV,
        }).getPostLikers([post], 1, checkpoint))
            .rejects.toThrow('SCRAPING_DATASET_TRANSIENT_ERROR');
        expect(unreadable.call).not.toHaveBeenCalled();
    });

    it('supports the ten URL x one hundred candidate-liker product ceiling', async () => {
        const urls = Array.from(
            { length: 10 },
            (_, index) => `https://www.instagram.com/p/Candidate${index}/`
        );
        const { client, call } = mockClient([]);
        const adapter = makeApifyInteractionAdapter({ client, env: BASE_ENV });

        await expect(adapter.getPostLikers(urls, 100)).resolves.toEqual([]);
        expect(call).toHaveBeenCalledWith(
            expect.objectContaining({ max_count: 100 }),
            expect.objectContaining({
                maxItems: 1_000,
                maxTotalChargeUsd: 1.55,
            })
        );
    });

    it('rejects URL, per-post, total-result, and estimated-cost overruns before actor start', async () => {
        const tooManyUrls = Array.from(
            { length: 11 },
            (_, index) => `https://www.instagram.com/p/Candidate${index}/`
        );
        const tenUrls = tooManyUrls.slice(0, 10);
        const { client, call } = mockClient([]);
        const adapter = makeApifyInteractionAdapter({ client, env: BASE_ENV });

        await expect(adapter.getPostLikers(tooManyUrls, 100)).rejects.toThrow('1 to 10');
        await expect(adapter.getPostLikers(tenUrls, 151)).rejects.toThrow(
            'limitPerPost'
        );
        const totalBounded = makeApifyInteractionAdapter({
            client,
            env: {
                ...BASE_ENV,
                APIFY_LIKERS_MAX_TOTAL_RESULTS_PER_OPERATION: '1000',
            },
        });
        await expect(totalBounded.getPostLikers(tenUrls, 150)).rejects.toThrow(
            '1000 total results'
        );

        const costBounded = makeApifyInteractionAdapter({
            client,
            env: {
                ...BASE_ENV,
                APIFY_LIKERS_MAX_ESTIMATED_COST_USD_PER_OPERATION: '0.20',
            },
        });
        await expect(costBounded.getPostLikers(
            ['https://www.instagram.com/p/PostA/'],
            150
        )).rejects.toThrow('BUDGET');
        expect(call).not.toHaveBeenCalled();
    });

    it('deduplicates likers within a post but not across different posts', async () => {
        const postA = 'https://www.instagram.com/p/PostA/';
        const postB = 'https://www.instagram.com/p/PostB/';
        const { client } = mockClient([
            liker('Alice', postA, '1'),
            liker('alice', postA, '1'),
            liker('alice', postB, '1'),
        ]);
        const adapter = makeApifyInteractionAdapter({
            client,
            env: { ...BASE_ENV, APIFY_LIKERS_MIN_UNIQUE_RATIO: '0.5' },
        });

        await expect(adapter.getPostLikers([postA, postB], 2)).resolves.toHaveLength(2);
    });

    it('rejects liker rows with an invalid schema or another post attribution', async () => {
        const post = 'https://www.instagram.com/p/PostA/';
        const invalid = mockClient([{ ...liker('alice', post), username: 'bad username' }]);
        await expect(makeApifyInteractionAdapter({
            client: invalid.client,
            env: BASE_ENV,
        }).getPostLikers([post], 1)).rejects.toThrow('APIFY_LIKER_ROW_INVALID');

        const mismatched = mockClient([
            liker('alice', 'https://www.instagram.com/p/AnotherPost/'),
        ]);
        await expect(makeApifyInteractionAdapter({
            client: mismatched.client,
            env: BASE_ENV,
        }).getPostLikers([post], 1)).rejects.toThrow('APIFY_LIKER_POST_MISMATCH');
    });

    it('batches official comments, disables replies, and caps the full batch charge', async () => {
        const postA = 'https://www.instagram.com/p/PostA/';
        const postB = 'https://www.instagram.com/reel/PostB/';
        const { client, call } = mockClient([
            comment('1', postA),
            { ...comment('2', postB), commentUrl: 'https://www.instagram.com/reel/PostB/c/2/' },
        ]);
        const adapter = makeApifyInteractionAdapter({ client, env: BASE_ENV });

        const result = await adapter.getPostComments([postA, postB], 15);

        expect(result.map((item) => item.postUrl)).toEqual([postA, postB]);
        expect(client.actor).toHaveBeenCalledWith(APIFY_COMMENTS_ACTOR_ID);
        expect(call).toHaveBeenCalledWith(
            {
                directUrls: [postA, postB],
                resultsLimit: 15,
                includeNestedComments: false,
            },
            expect.objectContaining({
                build: '0.0.498',
                maxItems: 30,
                maxTotalChargeUsd: 0.078,
                timeout: 300,
                restartOnError: false,
            })
        );
    });

    it('supports 6 URLs x 15 comments and rejects any larger comment batch', async () => {
        const urls = Array.from(
            { length: 6 },
            (_, index) => `https://www.instagram.com/p/Comment${index}/`
        );
        const { client, call } = mockClient([]);
        const adapter = makeApifyInteractionAdapter({ client, env: BASE_ENV });

        await expect(adapter.getPostComments(urls, 15)).resolves.toEqual([]);
        expect(call).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ maxItems: 90, maxTotalChargeUsd: 0.234 })
        );
        await expect(adapter.getPostComments(
            [...urls, 'https://www.instagram.com/p/Comment6/'],
            15
        )).rejects.toThrow('1 to 6');
        await expect(adapter.getPostComments(urls, 16)).rejects.toThrow('limitPerPost');
    });

    it('requires explicit comment attribution for batches but infers it for a single URL', async () => {
        const postA = 'https://www.instagram.com/p/PostA/';
        const postB = 'https://www.instagram.com/p/PostB/';
        const missingBatchAttribution = mockClient([comment('1')]);
        await expect(makeApifyInteractionAdapter({
            client: missingBatchAttribution.client,
            env: BASE_ENV,
        }).getPostComments([postA, postB], 1)).rejects.toThrow(
            'APIFY_COMMENT_POST_URL_MISSING'
        );

        const single = mockClient([comment('1')]);
        await expect(makeApifyInteractionAdapter({
            client: single.client,
            env: BASE_ENV,
        }).getPostComments([postA], 1)).resolves.toEqual([
            expect.objectContaining({ id: '1', postUrl: postA }),
        ]);
    });

    it('rejects comment error rows, nested replies, schema drift, and wrong post attribution', async () => {
        const post = 'https://www.instagram.com/p/PostA/';
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ error: 'private post' }, 'APIFY_COMMENT_ACTOR_ERROR'],
            [
                { ...comment('1', post), requestErrorMessages: [123] },
                'APIFY_COMMENT_ERROR_ROW_INVALID',
            ],
            [{ ...comment('1', post), replies: [{ id: 'reply' }] }, 'REPLIES_UNEXPECTED'],
            [{ ...comment('1', post), timestamp: 'not-a-date' }, 'APIFY_COMMENT_ROW_INVALID'],
            [comment('1', 'https://www.instagram.com/p/Other/'), 'APIFY_COMMENT_POST_MISMATCH'],
        ];

        for (const [row, message] of cases) {
            const { client } = mockClient([row]);
            await expect(makeApifyInteractionAdapter({
                client,
                env: BASE_ENV,
            }).getPostComments([post], 1)).rejects.toThrow(message);
        }
    });

    it('deduplicates comments by post and comment id and records bounded usage', async () => {
        const post = 'https://www.instagram.com/p/PostA/';
        const { client } = mockClient([comment('1', post), comment('1', post)]);
        const deltas: ProviderUsageDelta[] = [];
        const adapter = makeApifyInteractionAdapter({
            client,
            env: { ...BASE_ENV, APIFY_COMMENTS_MIN_UNIQUE_RATIO: '0.5' },
        });

        const result = await adapter.getPostComments([post], 2, {
            recordUsage(delta) {
                deltas.push(delta);
            },
        });

        expect(result).toHaveLength(1);
        expect(deltas).toContainEqual({ request_count: 1 });
        expect(deltas).toContainEqual({ estimated_cost_usd: 2 * 0.0026 });
        expect(deltas).toContainEqual({
            result_count: 1,
            raw_result_count: 2,
            unique_result_count: 1,
        });
    });

    it('pins exact builds and rejects invalid build settings before actor start', async () => {
        const { client, call } = mockClient([]);
        const adapter = makeApifyInteractionAdapter({
            client,
            env: { ...BASE_ENV, APIFY_LIKERS_BUILD: 'latest' },
        });

        await expect(adapter.getPostLikers(
            ['https://www.instagram.com/p/PostA/'],
            1
        )).rejects.toThrow('exact x.y.z');
        expect(call).not.toHaveBeenCalled();
    });

    it('rejects duplicate input URLs and datasets beyond the paid result cap', async () => {
        const post = 'https://www.instagram.com/p/PostA/';
        const duplicate = mockClient([]);
        await expect(makeApifyInteractionAdapter({
            client: duplicate.client,
            env: BASE_ENV,
        }).getPostLikers([post, `${post}?duplicate=true`], 1)).rejects.toThrow('duplicates');
        expect(duplicate.call).not.toHaveBeenCalled();

        const overDatasetLimit = mockClient([liker('alice', post)], { total: 2 });
        await expect(makeApifyInteractionAdapter({
            client: overDatasetLimit.client,
            env: BASE_ENV,
        }).getPostLikers([post], 1)).rejects.toThrow('DATASET_LIMIT_EXCEEDED');
    });

    it('rejects a batch that shifts another post allocation above its per-post cap', async () => {
        const postA = 'https://www.instagram.com/p/PostA/';
        const postB = 'https://www.instagram.com/p/PostB/';
        const { client } = mockClient([
            liker('alice', postA, '1'),
            liker('bob', postA, '2'),
        ]);

        await expect(makeApifyInteractionAdapter({
            client,
            env: BASE_ENV,
        }).getPostLikers([postA, postB], 1)).rejects.toThrow(
            'APIFY_INTERACTION_PER_POST_LIMIT_EXCEEDED'
        );
    });
});
