import { describe, expect, it } from 'vitest';
import {
    CONCIERGE_BATCH_ACTOR_CONCURRENCY,
    CONCIERGE_BATCH_MAX_ORDERS,
    CONCIERGE_BATCH_TOKEN_PRIORITY,
    assertConciergeRelationshipCoverage,
    isConciergeBatchRelationshipCoverageError,
    createConciergeBatchCasPublisher,
    runConciergeBatch,
    selectConciergeBatchRetryOrders,
    type ConciergeBatchOrder,
} from './concierge-batch-runner';
import type { ConciergeManualPublicationInput } from './concierge-batch-publication';

const ownerId = '00000000-0000-4000-8000-000000000001';

function order(index: number): ConciergeBatchOrder {
    return {
        orderId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        ownerId,
        targetUsername: `target_${index}`,
        planId: index % 2 === 0 ? 'basic' : 'standard',
        cohort: index < 3 ? 'failed_canary' : 'awaiting_operator',
    };
}

describe('concierge batch runner', () => {
    it('fails closed when a declared non-zero relationship list is empty', () => {
        expect(() => assertConciergeRelationshipCoverage('followers', 1, 0))
            .toThrow('CONCIERGE_RELATIONSHIP_FOLLOWERS_EMPTY');
        expect(() => assertConciergeRelationshipCoverage('following', 0, 0))
            .not.toThrow();
    });

    it('marks only the relationship coverage errors as token-fallback retryable', () => {
        expect(isConciergeBatchRelationshipCoverageError(
            new Error('CONCIERGE_RELATIONSHIP_FOLLOWERS_EMPTY'),
        )).toBe(true);
        expect(isConciergeBatchRelationshipCoverageError(
            new Error('CONCIERGE_RELATIONSHIP_FOLLOWING_EMPTY'),
        )).toBe(true);
        expect(isConciergeBatchRelationshipCoverageError(
            new Error('CONCIERGE_TARGET_PROFILE_PRIVATE'),
        )).toBe(false);
    });

    it('selects only the explicitly allowlisted retry classes from the frozen cohort', () => {
        const orders = [
            { ...order(0), retryCode: 'CONCIERGE_BATCH_RETRYABLE' },
            { ...order(1), retryCode: 'CONCIERGE_TARGET_PROFILE_PRIVATE' },
            { ...order(2), retryCode: 'CONCIERGE_PROVIDER_ARTIFACT_INVALID' },
            { ...order(3), retryCode: null },
        ];

        expect(selectConciergeBatchRetryOrders(
            orders,
            new Set(['CONCIERGE_BATCH_RETRYABLE']),
        ).map(value => value.orderId)).toEqual([
            orders[0]!.orderId,
        ]);
    });

    it('keeps the paid secondary slot after the approved free-token priority', () => {
        expect([...CONCIERGE_BATCH_TOKEN_PRIORITY]).toEqual([
            'senary',
            'tertiary',
            'quinary',
            'primary',
            'secondary',
        ]);
    });

    it('delegates publication to the reviewed PR431 CAS publisher boundary', async () => {
        const calls: ConciergeManualPublicationInput[] = [];
        const input = {} as ConciergeManualPublicationInput;
        const publisher = createConciergeBatchCasPublisher(async value => {
            calls.push(value);
            return {
                published: true,
                idempotent: false,
                resultHash: 'a'.repeat(64),
                resultUrl: '/result/request',
                counts: {} as never,
            };
        });

        await publisher(input);

        expect(calls).toEqual([input]);
    });

    it('keeps a true sliding window at seven orders and isolates terminal failures', async () => {
        const orders = Array.from({ length: 12 }, (_, index) => order(index));
        const activeOrders = new Set<string>();
        let peakOrders = 0;
        let activeActors = 0;
        let peakActors = 0;
        const started: string[] = [];
        const terminal: string[] = [];
        const retryable: string[] = [];
        const result = await runConciergeBatch(orders, {
            async collect(current, context) {
                activeOrders.add(current.orderId);
                peakOrders = Math.max(peakOrders, activeOrders.size);
                try {
                    return await context.withActorSlot(async () => {
                        activeActors += 1;
                        peakActors = Math.max(peakActors, activeActors);
                        started.push(current.orderId);
                        await new Promise(resolve => setTimeout(resolve, current.orderId.endsWith('000000000001') ? 15 : 2));
                        activeActors -= 1;
                        if (current.orderId.endsWith('000000000004')) throw new Error('COLLECTION_FAILED');
                        return { order: current };
                    });
                } finally {
                    activeOrders.delete(current.orderId);
                }
            },
            async classify(collected) {
                return collected;
            },
            async publish(classified) {
                terminal.push(classified.order.orderId);
                return { status: 'completed' as const };
            },
            async onFailure(current) {
                retryable.push(current.orderId);
            },
        });

        expect(peakOrders).toBeLessThanOrEqual(CONCIERGE_BATCH_MAX_ORDERS);
        expect(peakActors).toBeLessThanOrEqual(CONCIERGE_BATCH_ACTOR_CONCURRENCY);
        expect(started).toHaveLength(orders.length);
        expect(result.completed).toBe(orders.length - 1);
        expect(result.failed).toBe(1);
        expect(result.running).toBe(0);
        expect(terminal).toHaveLength(orders.length - 1);
        expect(retryable).toEqual([orders[4]!.orderId]);
        expect(started.indexOf(orders[7]!.orderId)).toBeGreaterThan(-1);
    });

    it('passes the approved token order and actor concurrency fence to collection', async () => {
        const orders = Array.from({ length: 8 }, (_, index) => order(index));
        const observed: Array<{ tokens: readonly string[]; actorConcurrency: number }> = [];
        const result = await runConciergeBatch(orders, {
            async collect(_current, context) {
                observed.push({
                    tokens: context.tokenPriority,
                    actorConcurrency: context.actorConcurrency,
                });
                return { order: _current };
            },
            async classify(collected) {
                return collected;
            },
            async publish() {
                return { status: 'completed' as const };
            },
        });

        expect(result.completed).toBe(orders.length);
        expect(observed).toHaveLength(orders.length);
        expect(observed.every(item => item.actorConcurrency === CONCIERGE_BATCH_ACTOR_CONCURRENCY)).toBe(true);
        expect(observed.every(item => [...item.tokens].join(',') === CONCIERGE_BATCH_TOKEN_PRIORITY.join(','))).toBe(true);
    });

    it('enforces the global actor semaphore around collection work', async () => {
        const orders = Array.from({ length: 9 }, (_, index) => order(index));
        let activeCollections = 0;
        let peakCollections = 0;
        const result = await runConciergeBatch(orders, {
            async collect(current, context) {
                return context.withActorSlot(async () => {
                    activeCollections += 1;
                    peakCollections = Math.max(peakCollections, activeCollections);
                    await new Promise(resolve => setTimeout(resolve, 3));
                    activeCollections -= 1;
                    return { order: current };
                });
            },
            async classify(collected) {
                return collected;
            },
            async publish() {
                return { status: 'completed' as const };
            },
        });
        expect(result.completed).toBe(orders.length);
        expect(peakCollections).toBe(CONCIERGE_BATCH_ACTOR_CONCURRENCY);
    });

    it('does not exceed two slots when queued actor work is handed off', async () => {
        const orders = Array.from({ length: 7 }, (_, index) => order(index));
        let activeActors = 0;
        let peakActors = 0;
        const result = await runConciergeBatch(orders, {
            async collect(current) {
                return { order: current };
            },
            async classify(collected, _current, context) {
                await Promise.all(Array.from({ length: 4 }, () => context.withActorSlot(async () => {
                    activeActors += 1;
                    peakActors = Math.max(peakActors, activeActors);
                    await new Promise(resolve => setTimeout(resolve, 2));
                    activeActors -= 1;
                })));
                return collected;
            },
            async publish() {
                return { status: 'completed' as const };
            },
        });
        expect(result.completed).toBe(orders.length);
        expect(peakActors).toBe(CONCIERGE_BATCH_ACTOR_CONCURRENCY);
    });

    it('prepares the exact request pair before collection when a bootstrap is supplied', async () => {
        const current = order(0);
        const calls: string[] = [];
        const result = await runConciergeBatch([current], {
            async prepare(preparedOrder) {
                calls.push(`prepare:${preparedOrder.orderId}`);
                return { sourceRequestId: 'source', requestId: 'request' };
            },
            async collect(preparedOrder, _context, bootstrap) {
                calls.push(`collect:${preparedOrder.orderId}:${bootstrap?.requestId ?? 'missing'}`);
                return { order: preparedOrder };
            },
            async classify(collected) {
                calls.push('classify');
                return collected;
            },
            async publish() {
                calls.push('publish');
                return { status: 'completed' as const };
            },
        });
        expect(result.completed).toBe(1);
        expect(calls).toEqual([
            `prepare:${current.orderId}`,
            `collect:${current.orderId}:request`,
            'classify',
            'publish',
        ]);
    });

    it('rejects duplicate order identities before any provider stage starts', async () => {
        const orders = [order(0), order(0)];
        let invoked = false;
        await expect(runConciergeBatch(orders, {
            async collect() {
                invoked = true;
                return {};
            },
            async classify(value) {
                return value;
            },
            async publish() {
                return { status: 'completed' as const };
            },
        })).rejects.toThrow('CONCIERGE_BATCH_SCOPE_CONFLICT');
        expect(invoked).toBe(false);
    });
});
