import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import {
    publishConciergeManualOverride,
    type ConciergeManualPublicationInput,
} from './concierge-batch-publication';

/**
 * The fallback runner is intentionally only an execution fence.  Collection,
 * Gemini classification/copy, and the reviewed PR431 CAS publisher are injected
 * as stages so this path cannot accidentally call Earlybird admission helpers.
 */
export const CONCIERGE_BATCH_MAX_ORDERS = 7;
export const CONCIERGE_BATCH_ACTOR_CONCURRENCY = 2;
export const CONCIERGE_BATCH_TOKEN_PRIORITY = Object.freeze([
    'octonary',
    'quaternary',
    'primary',
    'quinary',
    'secondary',
    'tenth',
] as const satisfies readonly ApifyCredentialSlot[]);
export const CONCIERGE_BATCH_RELATIONSHIP_TOKEN_PRIORITY = Object.freeze([
    'nonary',
    'secondary',
] as const satisfies readonly ApifyCredentialSlot[]);

export type ConciergeBatchTokenSlot = typeof CONCIERGE_BATCH_TOKEN_PRIORITY[number];

export interface ConciergeBatchOrder {
    orderId: string;
    ownerId: string;
    targetUsername: string;
    planId: 'basic' | 'standard';
    cohort: 'awaiting_operator' | 'failed_canary';
}

export type ConciergeBatchRetryOrder = ConciergeBatchOrder & {
    retryCode?: string | null;
};

/**
 * Selects a reviewed retry class from the immutable cohort.  Missing retry
 * evidence is intentionally excluded so an operator cannot accidentally turn
 * a whole-cohort rerun into the default behavior.
 */
export function selectConciergeBatchRetryOrders<T extends ConciergeBatchRetryOrder>(
    orders: readonly T[],
    allowlist: ReadonlySet<string>,
): T[] {
    return orders.filter(order => (
        typeof order.retryCode === 'string' && allowlist.has(order.retryCode)
    ));
}

export function assertConciergeRelationshipCoverage(
    side: 'followers' | 'following',
    declaredCount: number,
    collectedCount: number,
): void {
    if (declaredCount > 0 && collectedCount === 0) {
        throw new Error(`CONCIERGE_RELATIONSHIP_${side.toUpperCase()}_EMPTY`);
    }
}

export function isConciergeBatchRelationshipCoverageError(error: unknown): boolean {
    return error instanceof Error
        && (
            error.message === 'CONCIERGE_RELATIONSHIP_FOLLOWERS_EMPTY'
            || error.message === 'CONCIERGE_RELATIONSHIP_FOLLOWING_EMPTY'
        );
}

export interface ConciergeBatchStageContext {
    readonly actorConcurrency: typeof CONCIERGE_BATCH_ACTOR_CONCURRENCY;
    readonly tokenPriority: readonly ConciergeBatchTokenSlot[];
    /** Provider callers must wrap each actor operation with this gate. */
    withActorSlot<T>(operation: () => Promise<T>): Promise<T>;
}

export interface ConciergeBatchPreparedOrder {
    readonly sourceRequestId: string;
    readonly requestId: string;
    readonly preflightId?: string | null;
}

export type ConciergeBatchFailureStage = 'prepare' | 'collect' | 'classify' | 'publish';

export type ConciergeBatchCasPublisher = (
    input: ConciergeManualPublicationInput,
) => ReturnType<typeof publishConciergeManualOverride>;

/**
 * Binds the batch publication stage to the reviewed PR431 CAS publisher.  The
 * caller still assembles and validates the frozen replay/classification input;
 * this adapter only fixes the durable publication boundary and never admits or
 * advances Earlybird fulfillment.
 */
export function createConciergeBatchCasPublisher(
    publish: typeof publishConciergeManualOverride = publishConciergeManualOverride,
): ConciergeBatchCasPublisher {
    return input => publish(input);
}

export interface ConciergeBatchPipeline<Collected, Classified, Published extends { status: 'completed' }> {
    prepare?(order: ConciergeBatchOrder): Promise<ConciergeBatchPreparedOrder>;
    collect(order: ConciergeBatchOrder, context: ConciergeBatchStageContext, prepared?: ConciergeBatchPreparedOrder): Promise<Collected>;
    classify(collected: Collected, order: ConciergeBatchOrder, context: ConciergeBatchStageContext): Promise<Classified>;
    publish(classified: Classified, order: ConciergeBatchOrder, context: ConciergeBatchStageContext): Promise<Published>;
    /** Persist a retry-eligible terminal failure before the order leaves the window. */
    onFailure?(
        order: ConciergeBatchOrder,
        error: unknown,
        stage?: ConciergeBatchFailureStage,
    ): Promise<void>;
}

export interface ConciergeBatchRunSummary {
    readonly total: number;
    readonly completed: number;
    readonly failed: number;
    readonly running: 0;
}

const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;

function scopeConflict(): never {
    throw new Error('CONCIERGE_BATCH_SCOPE_CONFLICT');
}

function assertOrderScope(orders: readonly ConciergeBatchOrder[]): void {
    const seen = new Set<string>();
    for (const order of orders) {
        if (!ORDER_ID_PATTERN.test(order.orderId)
            || !ORDER_ID_PATTERN.test(order.ownerId)
            || !USERNAME_PATTERN.test(order.targetUsername)
            || !['basic', 'standard'].includes(order.planId)
            || !['awaiting_operator', 'failed_canary'].includes(order.cohort)
            || seen.has(order.orderId)) {
            scopeConflict();
        }
        seen.add(order.orderId);
    }
}

function createActorGate(limit: number): ConciergeBatchStageContext['withActorSlot'] {
    let active = 0;
    const waiters: Array<() => void> = [];
    const acquire = async (): Promise<void> => {
        if (active < limit) {
            active += 1;
            return;
        }
        await new Promise<void>(resolve => waiters.push(resolve));
    };
    const release = (): void => {
        const next = waiters.shift();
        // Keep the slot counted while handing it directly to the waiter. If
        // active were decremented before resolving, a racing caller could
        // observe spare capacity and acquire the same slot a second time.
        if (next) {
            next();
            return;
        }
        active -= 1;
    };
    return async <T>(operation: () => Promise<T>): Promise<T> => {
        await acquire();
        try {
            return await operation();
        } finally {
            release();
        }
    };
}

/**
 * Selects only an approved token slot by presence; token values are never
 * returned or logged.  SECONDARY is the paid fallback after the approved
 * free-token priority; all other slots remain excluded.
 */
export function selectConciergeApifyTokenSlot(
    env: Readonly<Record<string, string | undefined>> = process.env,
): ConciergeBatchTokenSlot | null {
    for (const slot of CONCIERGE_BATCH_TOKEN_PRIORITY) {
        const key = `APIFY_${slot.toUpperCase()}_API_TOKEN`;
        if (typeof env[key] === 'string' && env[key]!.trim().length > 0) return slot;
    }
    return null;
}

export interface ConciergeBatchBootstrapRpc {
    rpc(
        name: 'prepare_concierge_batch_order',
        args: { p_order_id: string },
    ): PromiseLike<{
        data: unknown;
        error: { code?: string | null; message?: string | null } | null;
    }>;
}

function parsePreparedOrder(value: unknown, order: ConciergeBatchOrder): ConciergeBatchPreparedOrder {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('CONCIERGE_BATCH_BOOTSTRAP_FAILED');
    }
    const row = value as Record<string, unknown>;
    if (row.orderId !== order.orderId
        || row.ownerId !== order.ownerId
        || row.targetUsername !== order.targetUsername
        || row.planId !== order.planId
        || typeof row.sourceRequestId !== 'string'
        || row.sourceRequestId.length === 0
        || typeof row.requestId !== 'string'
        || row.requestId.length === 0
        || (row.preflightId !== null && row.preflightId !== undefined && typeof row.preflightId !== 'string')) {
        throw new Error('CONCIERGE_BATCH_BOOTSTRAP_SCOPE_CONFLICT');
    }
    return Object.freeze({
        sourceRequestId: row.sourceRequestId,
        requestId: row.requestId,
        preflightId: row.preflightId === undefined ? null : row.preflightId,
    });
}

/** Service-role RPC adapter; it returns identifiers only and never logs payloads. */
export function createConciergeBatchBootstrap(
    client: ConciergeBatchBootstrapRpc,
): NonNullable<ConciergeBatchPipeline<unknown, unknown, { status: 'completed' }>['prepare']> {
    return async order => {
        const response = await client.rpc('prepare_concierge_batch_order', {
            p_order_id: order.orderId,
        });
        if (response.error) throw new Error('CONCIERGE_BATCH_BOOTSTRAP_FAILED');
        return parsePreparedOrder(response.data, order);
    };
}

/**
 * Runs the injected collection → Gemini/copy → CAS publication stages with a
 * true sliding window.  A terminal failure is isolated to its order and never
 * causes another order's provider work to be duplicated.
 */
export async function runConciergeBatch<Collected, Classified, Published extends { status: 'completed' }>(
    orders: readonly ConciergeBatchOrder[],
    pipeline: ConciergeBatchPipeline<Collected, Classified, Published>,
): Promise<ConciergeBatchRunSummary> {
    assertOrderScope(orders);
    const context: ConciergeBatchStageContext = Object.freeze({
        actorConcurrency: CONCIERGE_BATCH_ACTOR_CONCURRENCY,
        tokenPriority: CONCIERGE_BATCH_TOKEN_PRIORITY,
        withActorSlot: createActorGate(CONCIERGE_BATCH_ACTOR_CONCURRENCY),
    });
    let nextIndex = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    let persistenceError: unknown = null;

    await new Promise<void>((resolve, reject) => {
        const launch = (): void => {
            if (persistenceError) {
                if (running === 0) reject(persistenceError);
                return;
            }
            while (running < CONCIERGE_BATCH_MAX_ORDERS && nextIndex < orders.length) {
                const order = orders[nextIndex++]!;
                running += 1;
                void (async () => {
                    let stage: ConciergeBatchFailureStage = pipeline.prepare ? 'prepare' : 'collect';
                    try {
                        const prepared = pipeline.prepare
                            ? await pipeline.prepare(order)
                            : undefined;
                        stage = 'collect';
                        // Collection callers acquire the shared gate around
                        // each provider Actor operation. This keeps the
                        // physical Apify start/read concurrency at the same
                        // bound even when one order runs independent stages
                        // in parallel.
                        const collected = await pipeline.collect(order, context, prepared);
                        stage = 'classify';
                        const classified = await pipeline.classify(collected, order, context);
                        stage = 'publish';
                        const published = await pipeline.publish(classified, order, context);
                        if (published.status !== 'completed') throw new Error('CONCIERGE_BATCH_PUBLICATION_NOT_TERMINAL');
                        completed += 1;
                    } catch (error) {
                        failed += 1;
                        if (pipeline.onFailure) {
                            try {
                                await pipeline.onFailure(order, error, stage);
                            } catch (persistError) {
                                persistenceError ??= persistError;
                            }
                        }
                    } finally {
                        running -= 1;
                        if (persistenceError && running === 0) reject(persistenceError);
                        else if (!persistenceError && nextIndex >= orders.length && running === 0) resolve();
                        else launch();
                    }
                })();
            }
            if (!persistenceError && orders.length === 0) resolve();
        };
        launch();
    });

    return Object.freeze({
        total: orders.length,
        completed,
        failed,
        running: 0 as const,
    });
}
