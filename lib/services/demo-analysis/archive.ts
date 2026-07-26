import type { DemoAnalysisRun } from './store';
import type { OwnerAnalysisHistoryItemV1 } from '@/lib/services/analysis/owner-history';

export function demoArchiveItems(runs: readonly DemoAnalysisRun[], now: Date): OwnerAnalysisHistoryItemV1[] {
    return runs
        .filter((run): run is DemoAnalysisRun & { started_at: string } => run.started_at !== null)
        .map(run => ({
            id: run.id,
            targetInstagramId: run.target_instagram_id,
            status: now.getTime() >= new Date(run.started_at).getTime() + run.duration_seconds * 1_000
                ? 'completed' as const
                : 'processing' as const,
            createdAt: run.created_at,
            planType: 'standard',
            pipelineVersion: 'v2' as const,
        }))
        .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));
}
