import type { OwnerAnalysisHistoryItemV1 } from './owner-history';
import type { AwaitingEarlybirdDelivery } from '@/lib/services/earlybird/awaiting-delivery';

export type ArchiveEntry =
    | { kind: 'analysis'; item: OwnerAnalysisHistoryItemV1 }
    | {
          kind: 'awaiting_delivery';
          orderId: string;
          targetInstagramId: string;
          planId: string;
          createdAt: string | null;
      };

// Kept in sync with the RPC's own allowlist (load_analysis_owner_history_v1
// already excludes 'failed'); re-checked here defensively since callers can
// also merge in demo items that never went through the RPC.
const VISIBLE_ANALYSIS_STATUSES: readonly OwnerAnalysisHistoryItemV1['status'][] = [
    'pending',
    'processing',
    'completed',
];

function archiveEntryCreatedAt(entry: ArchiveEntry): string | null {
    return entry.kind === 'analysis' ? entry.item.createdAt : entry.createdAt;
}

// Merges owner analysis history with earlybird orders still awaiting
// fulfillment. An awaiting order is dropped once its resultRequestId matches
// an existing analysis id, so the moment fulfillment creates the
// analysis_requests row, the duplicate "결과 대기 중" card disappears on its own.
export function buildArchiveEntries(
    analyses: readonly OwnerAnalysisHistoryItemV1[],
    awaiting: readonly AwaitingEarlybirdDelivery[],
): readonly ArchiveEntry[] {
    const analysisIds = new Set(analyses.map((item) => item.id));
    const visibleAnalyses = analyses.filter((item) => VISIBLE_ANALYSIS_STATUSES.includes(item.status));
    const visibleAwaiting = awaiting.filter(
        (order) => order.resultRequestId === null || !analysisIds.has(order.resultRequestId)
    );

    const entries: ArchiveEntry[] = [
        ...visibleAnalyses.map((item) => ({ kind: 'analysis' as const, item })),
        ...visibleAwaiting.map((order) => ({
            kind: 'awaiting_delivery' as const,
            orderId: order.orderId,
            targetInstagramId: order.targetInstagramId,
            planId: order.planId,
            createdAt: order.createdAt,
        })),
    ];

    return entries.sort(
        (left, right) => (archiveEntryCreatedAt(right) ?? '').localeCompare(archiveEntryCreatedAt(left) ?? '')
    );
}
