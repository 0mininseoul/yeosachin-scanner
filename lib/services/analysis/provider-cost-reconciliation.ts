import type { SupabaseClient } from '@supabase/supabase-js';
import { getApifyClient } from '@/lib/services/instagram/providers/apify-relationship';
import {
    isApifyCredentialSlot,
    type ApifyCredentialSlot,
    type ProviderCostTerminalStatus,
} from '@/lib/services/instagram/providers/types';
import {
    enqueueAnalysisOrderAuditBundle,
    enqueueFinalizedAnalysisOrderAuditBundle,
} from './order-audit-bundle';

const SETTLEMENT_DELAY_MS = 30_000;
const MAX_RECONCILIATION_ROWS = 64;
const RECONCILIATION_CONCURRENCY = 4;
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReconciliationClient = Pick<SupabaseClient, 'from' | 'rpc'>;

interface StoredCostRun {
    requestId?: string;
    runId: string;
    logicalProvider: 'apify' | 'coderx';
    actorId: string;
    credentialSlot: ApifyCredentialSlot;
    status: ProviderCostTerminalStatus;
    maxChargeUsd: number;
}

interface ReconciliationApifyClient {
    run(runId: string): {
        get(): Promise<{ status?: unknown; usageTotalUsd?: unknown } | undefined>;
    };
}

export interface ProviderCostReconciliationResult {
    eligible: number;
    finalized: number;
    failed: number;
    hasMore: boolean;
}

function terminalStatus(value: unknown): ProviderCostTerminalStatus | undefined {
    switch (value) {
        case 'SUCCEEDED': return 'succeeded';
        case 'FAILED': return 'failed';
        case 'ABORTED': return 'aborted';
        case 'TIMED-OUT': return 'timed_out';
        default: return undefined;
    }
}

function parseRun(value: unknown): StoredCostRun {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('invalid provider cost row');
    }
    const row = value as Record<string, unknown>;
    const maxChargeUsd = Number(row.max_charge_usd);
    const requestId = row.request_id === undefined
        ? undefined
        : typeof row.request_id === 'string' && UUID_PATTERN.test(row.request_id)
            ? row.request_id
            : null;
    if (
        requestId === null
        || typeof row.run_id !== 'string'
        || !RUN_ID_PATTERN.test(row.run_id)
        || (row.logical_provider !== 'apify' && row.logical_provider !== 'coderx')
        || typeof row.actor_id !== 'string'
        || !ACTOR_ID_PATTERN.test(row.actor_id)
        || !isApifyCredentialSlot(row.credential_slot)
        || !['succeeded', 'failed', 'aborted', 'timed_out'].includes(String(row.status))
        || !Number.isFinite(maxChargeUsd)
        || maxChargeUsd < 0
        || maxChargeUsd > 100_000
    ) {
        throw new Error('invalid provider cost row');
    }
    return {
        requestId,
        runId: row.run_id,
        logicalProvider: row.logical_provider,
        actorId: row.actor_id,
        credentialSlot: row.credential_slot,
        status: row.status as ProviderCostTerminalStatus,
        maxChargeUsd,
    };
}

export async function reconcileSettledAnalysisProviderCosts(
    client: ReconciliationClient,
    requestId?: string,
    deps: {
        now?: Date;
        clientForSlot?: (slot: ApifyCredentialSlot) => ReconciliationApifyClient;
        env?: Record<string, string | undefined>;
    } = {}
): Promise<ProviderCostReconciliationResult> {
    const cutoff = new Date(
        (deps.now?.getTime() ?? Date.now()) - SETTLEMENT_DELAY_MS
    ).toISOString();
    let query = client
        .from('analysis_provider_cost_ledger')
        .select('request_id, run_id, logical_provider, actor_id, credential_slot, status, max_charge_usd')
        .neq('status', 'running')
        .is('cost_finalized_at', null)
        .lte('terminal_at', cutoff);
    if (requestId) {
        query = query.eq('request_id', requestId);
    }
    const { data, error } = await query
        .order('terminal_at', { ascending: true })
        .limit(MAX_RECONCILIATION_ROWS + 1);
    if (error || !Array.isArray(data)) {
        return { eligible: 0, finalized: 0, failed: 1, hasMore: false };
    }

    const rows = data.slice(0, MAX_RECONCILIATION_ROWS);
    const outcomes = await runWithConcurrency(rows, RECONCILIATION_CONCURRENCY, async (value) => {
        try {
            const stored = parseRun(value);
            const apify = deps.clientForSlot?.(stored.credentialSlot)
                ?? getApifyClient(deps.env ?? process.env, stored.credentialSlot);
            const snapshot = await apify.run(stored.runId).get();
            const usageTotalUsd = snapshot?.usageTotalUsd;
            if (
                terminalStatus(snapshot?.status) !== stored.status
                || typeof usageTotalUsd !== 'number'
                || !Number.isFinite(usageTotalUsd)
                || usageTotalUsd < 0
                || usageTotalUsd > stored.maxChargeUsd + 0.000000001
            ) {
                throw new Error('provider cost is not stable');
            }
            const result = await client.rpc('finalize_analysis_provider_cost', {
                p_run_id: stored.runId,
                p_logical_provider: stored.logicalProvider,
                p_actor_id: stored.actorId,
                p_credential_slot: stored.credentialSlot,
                p_status: stored.status,
                p_usage_total_usd: usageTotalUsd,
            });
            if (result.error || result.data !== true) {
                throw new Error('provider cost finalization failed');
            }
            await enqueueFinalizedAnalysisOrderAuditBundle(
                stored.requestId
                    ? request => enqueueAnalysisOrderAuditBundle(client, request)
                    : undefined,
                stored.requestId ?? '',
            );
            return true;
        } catch {
            return false;
        }
    });
    const finalized = outcomes.filter(Boolean).length;
    const failed = outcomes.length - finalized;
    return {
        eligible: rows.length,
        finalized,
        failed,
        hasMore: data.length > MAX_RECONCILIATION_ROWS,
    };
}

async function runWithConcurrency<T, R>(
    values: T[],
    concurrency: number,
    task: (value: T) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    await Promise.all(Array.from(
        { length: Math.min(concurrency, values.length) },
        async () => {
            while (nextIndex < values.length) {
                const index = nextIndex++;
                results[index] = await task(values[index]);
            }
        }
    ));
    return results;
}
