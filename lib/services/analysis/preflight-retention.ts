import { supabaseAdmin } from '@/lib/supabase/admin';
import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import {
    createPreflightProviderRunStore,
    reconcileSettledPreflightProviderCosts,
    type PreflightProviderCostReconciliationResult,
    type PreflightProviderRunReconciliationStore,
    type ReconciliationApifyClient,
} from './preflight-provider-run';
import {
    archiveSettledBetaApifyCredit,
    recoverBetaApifyCredit,
    refreshBetaApifyCreditSnapshots,
} from './beta-apify-credit-settlement-runtime';

export const PREFLIGHT_RETENTION_BATCH_LIMIT = 250;

interface RetentionRpcClient {
    rpc(
        name: string,
        params: Record<string, unknown>
    ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface PreflightRetentionSummary {
    providerCosts: PreflightProviderCostReconciliationResult;
    providerCostReconciliationFailures: number;
    expiredPurged: number;
    terminalScrubbed: number;
    betaCreditRecovered: number;
    betaCreditArchived: number;
    betaCreditRecoveryFailures: number;
    betaCreditArchiveFailures: number;
    betaCreditRefreshAttempts: number;
    betaCreditRefreshFailures: number;
}

interface PreflightRetentionDependencies {
    providerRunStore?: PreflightProviderRunReconciliationStore;
    clientForSlot?: (slot: ApifyCredentialSlot) => ReconciliationApifyClient;
    env?: Record<string, string | undefined>;
    recoverBetaCredit?: () => Promise<number>;
    refreshBetaCredit?: () => Promise<void>;
    archiveBetaCredit?: () => Promise<number>;
}

function boundedCount(value: unknown, maximum: number, operation: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
        throw new Error(`PREFLIGHT_RETENTION_ERROR: invalid ${operation} result.`);
    }
    return Number(value);
}

async function runRpc(
    client: RetentionRpcClient,
    name: string,
    maximum: number
): Promise<number> {
    const { data, error } = await client.rpc(name, {
        p_limit: PREFLIGHT_RETENTION_BATCH_LIMIT,
    });
    if (error) throw new Error(`PREFLIGHT_RETENTION_ERROR: ${name} failed.`);
    return boundedCount(data, maximum, name);
}

export async function runPreflightRetention(
    client: RetentionRpcClient = supabaseAdmin,
    dependencies: PreflightRetentionDependencies = {}
): Promise<PreflightRetentionSummary> {
    let providerCosts: PreflightProviderCostReconciliationResult = Object.freeze({
        eligible: 0,
        finalized: 0,
        failed: 0,
        hasMore: false,
    });
    let providerCostReconciliationFailures = 0;
    try {
        providerCosts = await reconcileSettledPreflightProviderCosts(
            dependencies.providerRunStore ?? createPreflightProviderRunStore(client),
            {
                ...(dependencies.clientForSlot
                    ? { clientForSlot: dependencies.clientForSlot }
                    : {}),
                ...(dependencies.env ? { env: dependencies.env } : {}),
            }
        );
    } catch {
        // The SQL purge fence remains authoritative. A provider list failure
        // is retried later and cannot starve beta settlement or PII retention.
        providerCostReconciliationFailures = 1;
    }
    const expiredPurged = await runRpc(
        client,
        'purge_expired_analysis_v2_preflights',
        PREFLIGHT_RETENTION_BATCH_LIMIT * 2
    );
    // Expiry may make held target-profile reservations terminal.  These steps
    // remain independent of the feature flag and a refresh never releases data.
    const maintainBeta = client === supabaseAdmin
        || dependencies.recoverBetaCredit
        || dependencies.refreshBetaCredit
        || dependencies.archiveBetaCredit;
    let betaCreditRecovered = 0;
    let betaCreditArchived = 0;
    let betaCreditRecoveryFailures = 0;
    let betaCreditArchiveFailures = 0;
    let betaCreditRefreshAttempts = 0;
    let betaCreditRefreshFailures = 0;
    if (maintainBeta) {
        try {
            betaCreditRecovered = await (dependencies.recoverBetaCredit
                ?? (() => recoverBetaApifyCredit(client)))();
        } catch {
            betaCreditRecoveryFailures = 1;
        }
        try {
            betaCreditArchived = await (dependencies.archiveBetaCredit
                ?? (() => archiveSettledBetaApifyCredit(client)))();
        } catch {
            betaCreditArchiveFailures = 1;
        }
    }
    const terminalScrubbed = await runRpc(
        client,
        'scrub_terminal_analysis_v2_preflights',
        PREFLIGHT_RETENTION_BATCH_LIMIT
    );
    if (maintainBeta && betaCreditRecovered > 0) {
        betaCreditRefreshAttempts = 1;
        try {
            await (dependencies.refreshBetaCredit
                ?? (() => refreshBetaApifyCreditSnapshots(client, { env: dependencies.env })))();
        } catch {
            betaCreditRefreshFailures = 1;
        }
    }
    return {
        providerCosts,
        providerCostReconciliationFailures,
        expiredPurged,
        terminalScrubbed,
        betaCreditRecovered,
        betaCreditArchived,
        betaCreditRecoveryFailures,
        betaCreditArchiveFailures,
        betaCreditRefreshAttempts,
        betaCreditRefreshFailures,
    };
}
