import { calculateWeightedProgress } from '@/lib/domain/analysis/progress-policy';
import type { ClaimedAnalysisV2Job } from './v2-job-store';
import type { AnalysisV2DagState } from './v2-dag-planner';
import {
    AnalysisV2ProgressConflictError,
    analysisV2ProgressStore,
    maskAnalysisV2ProgressUsername,
    type AnalysisV2ProgressCheckpointResult,
    type AnalysisV2ProgressStore,
    type AnalysisV2ProgressTracksInput,
} from './v2-progress-store';
import {
    projectAnalysisV2Progress,
    type AnalysisV2ProjectedProgress,
} from './v2-progress-projector';
import type { AnalysisV2StageId } from './v2-worker';

const TARGET_LATENCY_SECONDS = 300;

export interface AnalysisV2ProgressReportInput {
    claim: ClaimedAnalysisV2Job;
    state: AnalysisV2DagState;
    stage: AnalysisV2StageId;
    includeStageEvent?: boolean;
}

export interface AnalysisV2ProgressReporter {
    initialize(input: {
        claim: ClaimedAnalysisV2Job;
        state: AnalysisV2DagState;
    }): Promise<AnalysisV2ProgressCheckpointResult>;
    report(input: AnalysisV2ProgressReportInput): Promise<AnalysisV2ProgressCheckpointResult>;
    heartbeat?(input: {
        claim: ClaimedAnalysisV2Job;
        stage: Extract<AnalysisV2StageId, 'profile_fetch' | 'profile_ai'>;
        username: string;
        startedAt: string;
        totalCount: number;
    }): Promise<boolean>;
}

function workMap(tracks: AnalysisV2ProgressTracksInput) {
    return {
        relationshipAi: {
            done: tracks.relationshipAi.done,
            total: tracks.relationshipAi.total,
        },
        interactions: {
            done: tracks.interactions.done,
            total: tracks.interactions.total,
        },
        finalization: {
            done: tracks.finalization.done,
            total: tracks.finalization.total,
        },
    };
}

function etaRange(tracks: AnalysisV2ProgressTracksInput) {
    const progressBp = calculateWeightedProgress(workMap(tracks), 'processing')
        .overallProgressBp;
    const remainingSeconds = Math.ceil(
        TARGET_LATENCY_SECONDS * (1 - progressBp / 10_000)
    );
    return {
        lowSeconds: Math.max(0, Math.floor(remainingSeconds * 0.7)),
        highSeconds: Math.max(10, Math.ceil(remainingSeconds * 1.25)),
    };
}

function bootstrapProjection(state: AnalysisV2DagState): AnalysisV2ProjectedProgress {
    const projected = projectAnalysisV2Progress({
        state,
        activeStage: 'relationships',
        includeStageEvent: false,
    });
    return {
        tracks: projected.tracks,
        event: {
            state: 'confirmed',
            eventCode: 'TARGET_PROFILE_READY',
            copyCode: 'TARGET_PROFILE_READY',
            aggregateCount: null,
        },
    };
}

function checkpointInput(
    claim: ClaimedAnalysisV2Job,
    projected: AnalysisV2ProjectedProgress
) {
    return {
        requestId: claim.requestId,
        jobKey: claim.jobKey,
        claimToken: claim.claimToken,
        jobInputHash: claim.inputHash,
        status: 'processing' as const,
        backgroundProcessing: true,
        tracks: projected.tracks,
        activeProfile: null,
        etaRange: etaRange(projected.tracks),
        event: projected.event,
    };
}

export function createAnalysisV2ProgressReporter(input: {
    store?: AnalysisV2ProgressStore;
    reloadState?: (requestId: string) => Promise<AnalysisV2DagState | null>;
} = {}): AnalysisV2ProgressReporter {
    const store = input.store ?? analysisV2ProgressStore;

    async function checkpointWithConflictRecovery(
        report: AnalysisV2ProgressReportInput,
        projected: AnalysisV2ProjectedProgress
    ): Promise<AnalysisV2ProgressCheckpointResult> {
        try {
            return await store.checkpoint(checkpointInput(report.claim, projected));
        } catch (error) {
            if (!(error instanceof AnalysisV2ProgressConflictError) || !input.reloadState) {
                throw error;
            }
            const current = await input.reloadState(report.claim.requestId);
            if (!current) throw error;
            const recovered = projectAnalysisV2Progress({
                state: current,
                activeStage: report.stage,
                includeStageEvent: report.includeStageEvent,
            });
            return store.checkpoint(checkpointInput(report.claim, recovered));
        }
    }

    return {
        async heartbeat({ claim, username, startedAt, totalCount }) {
            if (!store.heartbeatActiveProfile) {
                throw new Error('ANALYSIS_V2_ACTIVE_PROFILE_HEARTBEAT_UNAVAILABLE');
            }
            return store.heartbeatActiveProfile({
                requestId: claim.requestId,
                jobKey: claim.jobKey,
                claimToken: claim.claimToken,
                jobInputHash: claim.inputHash,
                startedAt,
                totalCount,
                maskedUsername: maskAnalysisV2ProgressUsername(username),
                imageUrl: null,
            });
        },

        async initialize({ claim, state }) {
            return store.checkpoint(checkpointInput(claim, bootstrapProjection(state)));
        },

        async report(report) {
            const projected = projectAnalysisV2Progress({
                state: report.state,
                activeStage: report.stage,
                includeStageEvent: report.includeStageEvent,
            });
            return checkpointWithConflictRecovery(report, projected);
        },
    };
}

export const analysisV2ProgressReporter = createAnalysisV2ProgressReporter();
