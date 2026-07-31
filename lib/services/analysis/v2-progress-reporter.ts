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
import type { AnalysisV2ProgressCandidateMediaPreview } from './progress-candidate-media';
import { createImageProxyPath } from '@/lib/services/media/image-proxy-token';
import { analysisV2ProgressCandidateKey } from './preflight-identity';

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
        preview?: AnalysisV2ProgressCandidateMediaPreview;
    }): Promise<boolean>;
}

type ImageProxySigner = (rawUrl: string | undefined) => string | undefined;
type CandidateKeyDeriver = (requestId: string, rawUsername: string) => string;

const EMPTY_HEARTBEAT_MEDIA = Object.freeze({
    imageUrl: null as string | null,
    feedImageUrls: [] as string[],
});

function signedProxyPath(rawUrl: string, sign: ImageProxySigner): string {
    if (!rawUrl || rawUrl.length > 8_192) {
        throw new Error('Invalid progress preview image URL.');
    }
    const path = sign(rawUrl);
    if (
        typeof path !== 'string'
        || path.length === 0
        || path.length > 2_048
        || !path.startsWith('/api/image-proxy?')
    ) {
        throw new Error('Unable to sign progress preview image URL.');
    }
    return path;
}

function prepareHeartbeatMedia(
    preview: AnalysisV2ProgressCandidateMediaPreview | undefined,
    sign: ImageProxySigner
): { imageUrl: string | null; feedImageUrls: string[] } {
    if (!preview) return { imageUrl: null, feedImageUrls: [] };
    if (!Array.isArray(preview.feedImageUrls) || preview.feedImageUrls.length > 3) {
        throw new Error('Invalid progress preview feed images.');
    }
    if (
        preview.profilePicUrl !== undefined
        && (typeof preview.profilePicUrl !== 'string' || preview.profilePicUrl.length === 0)
    ) {
        throw new Error('Invalid progress preview profile image.');
    }
    if (preview.feedImageUrls.some(url => typeof url !== 'string' || url.length === 0)) {
        throw new Error('Invalid progress preview feed image.');
    }
    if (new Set(preview.feedImageUrls).size !== preview.feedImageUrls.length) {
        throw new Error('Duplicate progress preview feed image.');
    }

    const feedImageUrls = preview.feedImageUrls.map(url => signedProxyPath(url, sign));
    if (new Set(feedImageUrls).size !== feedImageUrls.length) {
        throw new Error('Duplicate signed progress preview feed image.');
    }
    return {
        imageUrl: preview.profilePicUrl
            ? signedProxyPath(preview.profilePicUrl, sign)
            : null,
        feedImageUrls,
    };
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
    imageProxySigner?: ImageProxySigner;
    candidateKeyDeriver?: CandidateKeyDeriver;
} = {}): AnalysisV2ProgressReporter {
    const store = input.store ?? analysisV2ProgressStore;
    const imageProxySigner = input.imageProxySigner ?? createImageProxyPath;
    const candidateKeyDeriver = input.candidateKeyDeriver
        ?? analysisV2ProgressCandidateKey;

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
        async heartbeat({ claim, username, startedAt, totalCount, preview }) {
            if (!store.heartbeatActiveProfile) {
                throw new Error('ANALYSIS_V2_ACTIVE_PROFILE_HEARTBEAT_UNAVAILABLE');
            }
            let media = EMPTY_HEARTBEAT_MEDIA;
            try {
                media = prepareHeartbeatMedia(preview, imageProxySigner);
            } catch {
                media = EMPTY_HEARTBEAT_MEDIA;
            }
            let candidateKey: string | undefined;
            try {
                const derived = candidateKeyDeriver(claim.requestId, username);
                if (!/^[0-9a-f]{64}$/.test(derived)) {
                    throw new Error('Invalid progress candidate key.');
                }
                candidateKey = derived;
            } catch {
                candidateKey = undefined;
            }
            return store.heartbeatActiveProfile({
                requestId: claim.requestId,
                jobKey: claim.jobKey,
                claimToken: claim.claimToken,
                jobInputHash: claim.inputHash,
                startedAt,
                totalCount,
                maskedUsername: maskAnalysisV2ProgressUsername(username),
                imageUrl: media.imageUrl,
                feedImageUrls: media.feedImageUrls,
                ...(candidateKey ? { candidateKey } : {}),
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
