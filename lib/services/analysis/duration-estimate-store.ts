import type { AnalysisV2DagState } from './v2-dag-planner';
import {
    estimatePersistedAnalysisDuration,
    type AnalysisDurationEstimate,
    type PersistedAnalysisWorkload,
} from '@/lib/domain/analysis/duration-estimate';

export interface HydratedAnalysisDurationEstimate {
    readonly source: 'workload';
    readonly estimate: AnalysisDurationEstimate;
}

/**
 * Converts persisted DAG state into an internal workload input. This intentionally
 * stays outside of the route response: counts and batch topology are not owner UI data.
 */
export function persistedAnalysisWorkload(
    state: AnalysisV2DagState,
): PersistedAnalysisWorkload | null {
    if (!state.relationships) return null;
    const completedStageOperations = [
        state.targetEvidence,
        state.primaryJoin,
        state.screening,
        state.reverseLikes,
        state.partnerSafety,
        state.finalScore,
        state.narrative,
    ].filter(Boolean).length
        + (state.profileFetchBatches?.length ?? 0)
        + (state.profileAiBatches?.length ?? 0)
        + (state.privateNameBatches?.length ?? 0);

    return Object.freeze({
        mutualCount: state.relationships.detectedMutualCount,
        publicCount: state.relationships.publicCount,
        privateCount: state.relationships.privateCount,
        profileBatchCount: state.relationships.profileBatches.length,
        privateNameBatchCount: state.relationships.privateNameBatches.length,
        completedStageOperations,
    });
}

export function hydratePersistedAnalysisDurationEstimate(
    state: AnalysisV2DagState,
): HydratedAnalysisDurationEstimate | null {
    const workload = persistedAnalysisWorkload(state);
    if (!workload) return null;
    return Object.freeze({
        source: 'workload',
        estimate: estimatePersistedAnalysisDuration(workload),
    });
}
