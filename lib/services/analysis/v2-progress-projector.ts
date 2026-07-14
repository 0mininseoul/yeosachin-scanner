import type { ProgressTrackId } from '@/lib/domain/analysis/progress-policy';
import type { AnalysisV2DagState } from './v2-dag-planner';
import type {
    AnalysisV2ProgressEventInput,
    AnalysisV2ProgressTracksInput,
    AnalysisV2ProgressTrackInput,
} from './v2-progress-store';
import type { AnalysisV2StageId } from './v2-worker';

const TRACK_BY_STAGE: Readonly<Record<AnalysisV2StageId, ProgressTrackId>> = Object.freeze({
    relationships: 'relationshipAi',
    target_evidence: 'interactions',
    profile_fetch: 'relationshipAi',
    profile_ai: 'relationshipAi',
    private_names: 'finalization',
    primary_join: 'relationshipAi',
    screening: 'relationshipAi',
    reverse_likes: 'interactions',
    partner_safety: 'relationshipAi',
    final_score: 'finalization',
    narrative: 'finalization',
    finalize: 'finalization',
});

const ACTIVE_STAGE_CODES: Readonly<Record<AnalysisV2StageId, string>> = Object.freeze({
    relationships: 'RELATIONSHIPS_COLLECTING',
    target_evidence: 'TARGET_INTERACTIONS_COLLECTING',
    profile_fetch: 'PUBLIC_PROFILES_COLLECTING',
    profile_ai: 'PROFILE_SCREENING',
    private_names: 'PRIVATE_NAMES_SCREENING',
    primary_join: 'EVIDENCE_JOINING',
    screening: 'CANDIDATES_RANKING',
    reverse_likes: 'SHORTLIST_INTERACTIONS_COLLECTING',
    partner_safety: 'PARTNER_CONTEXT_CHECKING',
    final_score: 'FINAL_SCORE_CALCULATING',
    narrative: 'HIGH_RISK_NARRATIVES_WRITING',
    finalize: 'RESULT_FINALIZING',
});

const TRACK_QUEUED_CODES: Readonly<Record<ProgressTrackId, string>> = Object.freeze({
    relationshipAi: 'RELATIONSHIP_AI_QUEUED',
    interactions: 'INTERACTIONS_QUEUED',
    finalization: 'FINALIZATION_QUEUED',
});

const TRACK_RUNNING_CODES: Readonly<Record<ProgressTrackId, string>> = Object.freeze({
    relationshipAi: 'RELATIONSHIP_AI_RUNNING',
    interactions: 'INTERACTIONS_RUNNING',
    finalization: 'FINALIZATION_RUNNING',
});

const TRACK_COMPLETE_CODES: Readonly<Record<ProgressTrackId, string>> = Object.freeze({
    relationshipAi: 'RELATIONSHIP_AI_COMPLETE',
    interactions: 'INTERACTIONS_COMPLETE',
    finalization: 'FINALIZATION_COMPLETE',
});

export interface AnalysisV2ProgressWorkTotals {
    relationshipAi: number;
    interactions: number;
    finalization: number;
}

export interface AnalysisV2ProjectedProgress {
    tracks: AnalysisV2ProgressTracksInput;
    event: AnalysisV2ProgressEventInput | null;
}

export function getAnalysisV2ProgressWorkTotals(
    state: AnalysisV2DagState
): AnalysisV2ProgressWorkTotals {
    const profileBatches = state.relationships?.profileBatches.length ?? 0;
    const privateNameBatches = state.relationships?.privateNameBatches.length ?? 0;
    return Object.freeze({
        relationshipAi: profileBatches * 2 + 4,
        interactions: 2,
        finalization: privateNameBatches + 3,
    });
}

function completedRelationshipTrack(state: AnalysisV2DagState): boolean {
    return state.relationships !== undefined
        && (state.profileFetchBatches?.length ?? 0) === state.relationships.profileBatches.length
        && (state.profileAiBatches?.length ?? 0) === state.relationships.profileBatches.length
        && state.primaryJoin !== undefined
        && state.screening !== undefined
        && state.partnerSafety !== undefined;
}

function completedInteractionTrack(state: AnalysisV2DagState): boolean {
    return state.targetEvidence !== undefined && state.reverseLikes !== undefined;
}

function boundedDone(done: number, total: number): number {
    return Math.max(0, Math.min(total, done));
}

function track(input: {
    id: ProgressTrackId;
    activeStage: AnalysisV2StageId;
    done: number;
    total: number;
    completed: boolean;
}): AnalysisV2ProgressTrackInput {
    if (input.completed) {
        return Object.freeze({
            state: 'completed',
            stageCode: TRACK_COMPLETE_CODES[input.id],
            done: input.total,
            total: input.total,
        });
    }
    const active = TRACK_BY_STAGE[input.activeStage] === input.id;
    const done = boundedDone(input.done, input.total);
    const running = active || done > 0;
    return Object.freeze({
        state: running ? 'running' : 'pending',
        stageCode: active
            ? ACTIVE_STAGE_CODES[input.activeStage]
            : running
                ? TRACK_RUNNING_CODES[input.id]
                : TRACK_QUEUED_CODES[input.id],
        done,
        total: input.total,
    });
}

function progressEvent(
    stage: AnalysisV2StageId,
    state: AnalysisV2DagState
): AnalysisV2ProgressEventInput | null {
    switch (stage) {
        case 'relationships':
            return state.relationships ? {
                state: 'confirmed',
                eventCode: 'RELATIONSHIP_PROGRESS',
                copyCode: 'RELATIONSHIPS_COLLECTED',
                aggregateCount: state.relationships.detectedMutualCount,
            } : null;
        case 'profile_ai':
            return {
                state: 'confirmed',
                eventCode: 'PROFILE_SCREENED',
                copyCode: 'PROFILES_SCREENED',
                aggregateCount: (state.profileAiBatches ?? [])
                    .reduce((sum, batch) => sum + batch.itemCount, 0),
            };
        case 'screening':
            return state.screening ? {
                state: 'confirmed',
                eventCode: 'SHORTLIST_READY',
                copyCode: 'SHORTLIST_READY',
                aggregateCount: state.screening.shortlistCount,
            } : null;
        case 'final_score':
            return state.finalScore ? {
                state: 'confirmed',
                eventCode: 'FINDING_CONFIRMED',
                copyCode: 'HIGH_RISK_CONFIRMED',
                aggregateCount: state.finalScore.featuredHighRiskCount,
            } : null;
        default:
            return null;
    }
}

/** Projects only sanitized, monotonic work counters from the PII-free DAG state. */
export function projectAnalysisV2Progress(input: {
    state: AnalysisV2DagState;
    activeStage: AnalysisV2StageId;
    includeStageEvent?: boolean;
}): AnalysisV2ProjectedProgress {
    const totals = getAnalysisV2ProgressWorkTotals(input.state);
    const relationshipDone = (input.state.relationships ? 1 : 0)
        + (input.state.profileFetchBatches?.length ?? 0)
        + (input.state.profileAiBatches?.length ?? 0)
        + (input.state.primaryJoin ? 1 : 0)
        + (input.state.screening ? 1 : 0)
        + (input.state.partnerSafety ? 1 : 0);
    const interactionDone = (input.state.targetEvidence ? 1 : 0)
        + (input.state.reverseLikes ? 1 : 0);
    const finalizationDone = (input.state.privateNameBatches?.length ?? 0)
        + (input.state.finalScore ? 1 : 0)
        + (input.state.narrative ? 1 : 0);

    return Object.freeze({
        tracks: Object.freeze({
            relationshipAi: track({
                id: 'relationshipAi',
                activeStage: input.activeStage,
                done: relationshipDone,
                total: totals.relationshipAi,
                completed: completedRelationshipTrack(input.state),
            }),
            interactions: track({
                id: 'interactions',
                activeStage: input.activeStage,
                done: interactionDone,
                total: totals.interactions,
                completed: completedInteractionTrack(input.state),
            }),
            finalization: track({
                id: 'finalization',
                activeStage: input.activeStage,
                done: finalizationDone,
                total: totals.finalization,
                completed: false,
            }),
        }),
        event: input.includeStageEvent === false
            ? null
            : progressEvent(input.activeStage, input.state),
    });
}
