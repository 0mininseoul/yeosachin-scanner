import {
    createBetaApifyCreditPoolStore,
    type BetaApifyPoolStoreClient,
} from './beta-apify-credit-runtime';
import {
    createServerBetaApifyCreditClientFactory,
} from './beta-apify-preflight-coordinator';
import { refreshBetaApifyCreditPool } from './beta-apify-credit-pool';

/** Fixed messages only: provider responses and account identities are never logged. */
export const BETA_APIFY_SETTLEMENT_LOG = 'BETATEST_APIFY_CREDIT_SETTLEMENT_DEFERRED';
export const BETA_APIFY_REFRESH_LOG = 'BETATEST_APIFY_CREDIT_REFRESH_DEFERRED';

function uuid(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        throw new Error('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR');
    }
    return value.toLowerCase();
}

async function targeted(client: BetaApifyPoolStoreClient, name: string, field: string, id: string): Promise<void> {
    const result = await client.rpc(name, { [field]: uuid(id) });
    if (result.error) throw new Error('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR');
}

export async function settleBetaApifyRequestCredit(client: BetaApifyPoolStoreClient, requestId: string): Promise<void> {
    await targeted(client, 'settle_analysis_beta_apify_request_credit', 'p_request_id', requestId);
}

export async function settleBetaApifyPreflightCredit(client: BetaApifyPoolStoreClient, preflightId: string): Promise<void> {
    await targeted(client, 'settle_analysis_beta_apify_preflight_credit', 'p_preflight_id', preflightId);
}

export async function recoverBetaApifyCredit(client: BetaApifyPoolStoreClient, limit = 100): Promise<void> {
    await createBetaApifyCreditPoolStore(client).recover(limit);
}

export async function archiveSettledBetaApifyCredit(client: BetaApifyPoolStoreClient, limit = 100): Promise<void> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR');
    }
    const result = await client.rpc(
        'archive_fully_settled_analysis_beta_apify_credit_allocations',
        { p_limit: limit },
    );
    if (result.error || !Number.isSafeInteger(result.data) || Number(result.data) < 0) {
        throw new Error('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR');
    }
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
    const refreshed = await refreshBetaApifyCreditPool({
        clientForSlot: dependencies.clientForSlot
            ?? createServerBetaApifyCreditClientFactory(dependencies.env),
        observedAt: new Date(now()),
    }, { now });
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
