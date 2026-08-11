import 'server-only';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    RevenueCostOperationStore,
    type RevenueCostOperationRpcClient,
} from './revenue-cost-operation-store';
import type {
    AnalysisV2ProviderUsageRevenueCostSettlement,
} from './v2-provider-lifecycle';
import type { StoredAnalysisV2ProviderRun } from './v2-provider-run-store';

type RevenueCostOperationStatus =
    | 'reserved'
    | 'started'
    | 'settled'
    | 'released'
    | 'ambiguous'
    | 'denied';

interface RevenueCostProviderRunSettlementQuery {
    eq(
        column: 'request_id' | 'owner_kind' | 'source_job_key'
            | 'source_operation_key_hash' | 'source_attempt',
        value: string | number,
    ): RevenueCostProviderRunSettlementQuery;
    maybeSingle(): PromiseLike<{
        data: unknown;
        error: { code?: string; message?: string } | null;
    }>;
}

export interface RevenueCostProviderRunSettlementClient
    extends RevenueCostOperationRpcClient {
    from(table: 'analysis_revenue_cost_operations'): {
        select(columns: 'status'): RevenueCostProviderRunSettlementQuery;
    };
}

const SETTLABLE_CHILD_STATUSES = new Set<RevenueCostOperationStatus>([
    'reserved',
    'started',
    'settled',
    'ambiguous',
]);

function sourceOperationHash(operationKey: string): string {
    return createHash('sha256').update(operationKey, 'utf8').digest('hex');
}

function isSettledProviderUsage(run: StoredAnalysisV2ProviderRun): boolean {
    return (run.status === 'succeeded'
            || run.status === 'failed'
            || run.status === 'aborted'
            || run.status === 'timed_out')
        && run.runId !== null
        && run.runStartedAt !== null
        && run.terminalizedAt !== null
        && run.actualUsageUsd !== null
        && run.usageReconciledAt !== null;
}

function childStatus(data: unknown): RevenueCostOperationStatus | null {
    if (data === null) return null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('ANALYSIS_V2_REVENUE_COST_SCOPE_INVALID');
    }
    const status = (data as { status?: unknown }).status;
    if (
        status !== 'reserved'
        && status !== 'started'
        && status !== 'settled'
        && status !== 'released'
        && status !== 'ambiguous'
        && status !== 'denied'
    ) {
        throw new Error('ANALYSIS_V2_REVENUE_COST_SCOPE_INVALID');
    }
    return status;
}

/**
 * Gates delayed settlement on the exact source child that reserveV2 created.
 * A no-row result is the ordinary production path and never invokes a revenue RPC.
 */
export function createRevenueCostProviderRunSettlement(
    client: RevenueCostProviderRunSettlementClient =
        supabaseAdmin as unknown as RevenueCostProviderRunSettlementClient,
    revenueCostOperationStore = new RevenueCostOperationStore(client),
): AnalysisV2ProviderUsageRevenueCostSettlement {
    return {
        async settleAfterUsageReconciliation(run) {
            if (!isSettledProviderUsage(run)) {
                throw new Error('ANALYSIS_V2_REVENUE_COST_SETTLEMENT_NOT_READY');
            }
            const { data, error } = await client
                .from('analysis_revenue_cost_operations')
                .select('status')
                .eq('request_id', run.requestId)
                .eq('owner_kind', 'provider_run')
                .eq('source_job_key', run.jobKey)
                .eq('source_operation_key_hash', sourceOperationHash(run.operationKey))
                .eq('source_attempt', 0)
                .maybeSingle();
            if (error) {
                throw new Error('ANALYSIS_V2_REVENUE_COST_SCOPE_LOOKUP_FAILED');
            }
            const status = childStatus(data);
            if (status === null || !SETTLABLE_CHILD_STATUSES.has(status)) return;

            try {
                const settled = await revenueCostOperationStore.settleV2({
                    requestId: run.requestId,
                    jobKey: run.jobKey,
                    sourceKind: 'provider_run',
                    sourceOperationKey: run.operationKey,
                    sourceAttempt: 0,
                });
                if (settled.disposition !== 'settled') {
                    throw new Error('ANALYSIS_V2_REVENUE_COST_SETTLEMENT_CONFLICT');
                }
            } catch {
                try {
                    const reviewed = await revenueCostOperationStore.manualReview({
                        requestId: run.requestId,
                        reasonCode: 'ambiguous_external_call',
                    });
                    if (reviewed.disposition !== 'manual_review') {
                        throw new Error('ANALYSIS_V2_REVENUE_COST_MANUAL_REVIEW_CONFLICT');
                    }
                } catch {
                    throw new Error(
                        'ANALYSIS_V2_REVENUE_COST_SETTLEMENT_MANUAL_REVIEW_REQUIRED'
                    );
                }
                throw new Error('ANALYSIS_V2_REVENUE_COST_SETTLEMENT_MANUAL_REVIEW');
            }
        },
    };
}

export const analysisV2RevenueCostProviderRunSettlement =
    createRevenueCostProviderRunSettlement();
