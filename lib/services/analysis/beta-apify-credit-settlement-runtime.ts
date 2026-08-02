import {
    createBetaApifyCreditPoolStore,
    type BetaApifyPoolStoreClient,
} from './beta-apify-credit-runtime';
import {
    createServerBetaApifyCreditClientFactory,
} from './beta-apify-preflight-coordinator';
import { refreshBetaApifyCreditPool } from './beta-apify-credit-pool';
import { z } from 'zod';

/** Fixed messages only: provider responses and account identities are never logged. */
export const BETA_APIFY_SETTLEMENT_LOG = 'BETATEST_APIFY_CREDIT_SETTLEMENT_DEFERRED';
export const BETA_APIFY_REFRESH_LOG = 'BETATEST_APIFY_CREDIT_REFRESH_DEFERRED';
const BETA_APIFY_MAINTENANCE_RPC_TIMEOUT_MS = 5_000;

type PoolRpcResult = Awaited<ReturnType<BetaApifyPoolStoreClient['rpc']>>;
type AbortablePoolRpc = ReturnType<BetaApifyPoolStoreClient['rpc']> & {
    abortSignal?: (signal: AbortSignal) => PromiseLike<PoolRpcResult>;
};

function uuid(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        throw new Error('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR');
    }
    return value.toLowerCase();
}

const targetedSettlementSchema = z.object({
    allocationId: z.string().uuid(),
    lifecycleState: z.enum(['preflight_held', 'active', 'settled']),
    settledFamilies: z.number().int().min(0).max(8),
    heldFamilies: z.number().int().min(0).max(8),
    actualUsd: z.number().finite().nonnegative(),
    releasedUsd: z.number().finite().nonnegative(),
}).strict();

async function boundedRpc(
    client: BetaApifyPoolStoreClient,
    name: string,
    params: Record<string, unknown>,
): Promise<PoolRpcResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const invocation = client.rpc(name, params) as AbortablePoolRpc;
        const pending = typeof invocation.abortSignal === 'function'
            ? invocation.abortSignal(controller.signal)
            : invocation;
        return await Promise.race([
            Promise.resolve(pending),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new Error('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR'));
                }, BETA_APIFY_MAINTENANCE_RPC_TIMEOUT_MS);
            }),
        ]);
    } catch {
        throw new Error('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR');
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function boundedClient(client: BetaApifyPoolStoreClient): BetaApifyPoolStoreClient {
    return Object.freeze({
        rpc: (name: string, params: Record<string, unknown>) => (
            boundedRpc(client, name, params)
        ),
    });
}

async function targeted(client: BetaApifyPoolStoreClient, name: string, field: string, id: string): Promise<boolean> {
    const result = await boundedRpc(client, name, { [field]: uuid(id) });
    if (result.error) throw new Error('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR');
    const data = Array.isArray(result.data) && result.data.length === 1
        ? result.data[0]
        : result.data;
    if (data === null) return false;
    if (!targetedSettlementSchema.safeParse(data).success) {
        throw new Error('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR');
    }
    return true;
}

export async function settleBetaApifyRequestCredit(client: BetaApifyPoolStoreClient, requestId: string): Promise<boolean> {
    return targeted(client, 'settle_analysis_beta_apify_request_credit', 'p_request_id', requestId);
}

export async function settleBetaApifyPreflightCredit(client: BetaApifyPoolStoreClient, preflightId: string): Promise<boolean> {
    return targeted(client, 'settle_analysis_beta_apify_preflight_credit', 'p_preflight_id', preflightId);
}

export async function recoverBetaApifyCredit(client: BetaApifyPoolStoreClient, limit = 100): Promise<number> {
    return (await createBetaApifyCreditPoolStore(boundedClient(client)).recover(limit)).length;
}

export async function archiveSettledBetaApifyCredit(client: BetaApifyPoolStoreClient, limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR');
    }
    const result = await boundedRpc(
        client,
        'archive_fully_settled_analysis_beta_apify_credit_allocations',
        { p_limit: limit },
    );
    if (result.error || !Number.isSafeInteger(result.data) || Number(result.data) < 0) {
        throw new Error('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR');
    }
    return Number(result.data);
}

/** Best-effort only; a failure must never replace a conservative local hold/debit. */
export async function refreshBetaApifyCreditSnapshots(
    client: BetaApifyPoolStoreClient,
    dependencies: {
        env?: Record<string, string | undefined>;
        now?: () => number;
        clientForSlot?: ReturnType<typeof createServerBetaApifyCreditClientFactory>;
    } = {}
): Promise<void> {
    const now = dependencies.now ?? Date.now;
    const timeoutMs = 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = refreshBetaApifyCreditPool({
        clientForSlot: dependencies.clientForSlot
            ?? createServerBetaApifyCreditClientFactory(dependencies.env),
        observedAt: new Date(now()),
    }, { now });
    const refreshed = await Promise.race([
        refresh,
        new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error('ANALYSIS_BETA_APIFY_CREDIT_REFRESH_TIMEOUT')),
                timeoutMs,
            );
        }),
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });
    await createBetaApifyCreditPoolStore(client).upsertSnapshots(refreshed.map(snapshot => ({
        ...snapshot,
        healthState: 'healthy' as const,
    })));
}

export async function bestEffortBetaApifySettlement(operation: () => Promise<void>): Promise<boolean> {
    try {
        await operation();
        return true;
    } catch {
        console.error(BETA_APIFY_SETTLEMENT_LOG);
        return false;
    }
}

export async function bestEffortBetaApifyRefresh(operation: () => Promise<void>): Promise<boolean> {
    try {
        await operation();
        return true;
    } catch {
        console.error(BETA_APIFY_REFRESH_LOG);
        return false;
    }
}
