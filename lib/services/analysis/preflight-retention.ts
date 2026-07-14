import { supabaseAdmin } from '@/lib/supabase/admin';
import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import {
    createPreflightProviderRunStore,
    reconcileSettledPreflightProviderCosts,
    type PreflightProviderCostReconciliationResult,
    type PreflightProviderRunReconciliationStore,
    type ReconciliationApifyClient,
} from './preflight-provider-run';

export const PREFLIGHT_RETENTION_BATCH_LIMIT = 250;

interface RetentionRpcClient {
    rpc(
        name: string,
        params: Record<string, unknown>
    ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface PreflightRetentionSummary {
    providerCosts: PreflightProviderCostReconciliationResult;
    expiredPurged: number;
    terminalScrubbed: number;
}

interface PreflightRetentionDependencies {
    providerRunStore?: PreflightProviderRunReconciliationStore;
    clientForSlot?: (slot: ApifyCredentialSlot) => ReconciliationApifyClient;
    env?: Record<string, string | undefined>;
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
    const providerCosts = await reconcileSettledPreflightProviderCosts(
        dependencies.providerRunStore ?? createPreflightProviderRunStore(client),
        {
            ...(dependencies.clientForSlot
                ? { clientForSlot: dependencies.clientForSlot }
                : {}),
            ...(dependencies.env ? { env: dependencies.env } : {}),
        }
    );
    const expiredPurged = await runRpc(
        client,
        'purge_expired_analysis_v2_preflights',
        PREFLIGHT_RETENTION_BATCH_LIMIT * 2
    );
    const terminalScrubbed = await runRpc(
        client,
        'scrub_terminal_analysis_v2_preflights',
        PREFLIGHT_RETENTION_BATCH_LIMIT
    );
    return { providerCosts, expiredPurged, terminalScrubbed };
}
