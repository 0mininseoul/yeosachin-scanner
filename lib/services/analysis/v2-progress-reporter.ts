import { calculateWeightedProgress } from '@/lib/domain/analysis/progress-policy';
import type { ProgressCallPhase } from '@/lib/contracts/analysis-v2';
import type { ClaimedAnalysisV2Job } from './v2-job-store';
import type { AnalysisV2DagState } from './v2-dag-planner';
import {
    AnalysisV2ProgressConflictError,
    AnalysisV2ProgressFenceError,
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
import {
    operationalLogger,
    type OperationalLogger,
} from '@/lib/observability/server';

const TARGET_LATENCY_SECONDS = 300;

export const ANALYSIS_V2_PROGRESS_REPORT_FAIL_OPEN_CODE =
    'ANALYSIS_V2_PROGRESS_REPORT_FAIL_OPEN';
export const ANALYSIS_V2_PROGRESS_HEARTBEAT_FAIL_OPEN_CODE =
    'ANALYSIS_V2_PROGRESS_HEARTBEAT_FAIL_OPEN';
export const ANALYSIS_V2_PROGRESS_INITIALIZE_FAIL_OPEN_CODE =
    'ANALYSIS_V2_PROGRESS_INITIALIZE_FAIL_OPEN';

type ProgressFailOpenOperation = 'initialize' | 'report' | 'heartbeat';
type ProgressFailOpenCorrelation =
    | 'conflict'
    | 'persistence'
    | 'transport'
    | 'unavailable';

export interface AnalysisV2ProgressFailOpenNotice {
    operation: ProgressFailOpenOperation;
    code: string;
    correlation: ProgressFailOpenCorrelation;
}

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
    }): Promise<AnalysisV2ProgressCheckpointResult | null>;
    report(input: AnalysisV2ProgressReportInput): Promise<AnalysisV2ProgressCheckpointResult | null>;
    heartbeat?(input: {
        claim: ClaimedAnalysisV2Job;
        stage: Extract<AnalysisV2StageId, 'profile_fetch' | 'profile_ai'>;
        username: string;
        startedAt: string;
        totalCount: number;
        preview?: AnalysisV2ProgressCandidateMediaPreview;
        currentOrdinal?: number;
        callPhase?: ProgressCallPhase;
    }): Promise<boolean>;
}

type ImageProxySigner = (rawUrl: string | undefined) => string | undefined;
type CandidateKeyDeriver = (requestId: string, rawUsername: string) => string;

function nestedErrorMessage(error: unknown, depth = 0): string {
    if (depth > 2 || !error || typeof error !== 'object') return '';
    const candidate = error as {
        code?: unknown;
        name?: unknown;
        message?: unknown;
        cause?: unknown;
    };
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    const cause = nestedErrorMessage(candidate.cause, depth + 1);
    return [code, name, message, cause].filter(Boolean).join(' ');
}

/** A job/request fence is correctness state, never progress telemetry. */
export function isAnalysisV2ProgressFenceFailure(error: unknown): boolean {
    if (error instanceof AnalysisV2ProgressFenceError) return true;
    const message = nestedErrorMessage(error);
    return /(?:ANALYSIS_V2_)?(?:PROGRESS_)?FENCE_MISMATCH\b/i.test(message)
        || /\b(?:ANALYSIS_V2_JOB_LEASE_LOST|ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH)\b/i.test(message)
        || /\b(?:JOB|CLAIM|LEASE)[ _]FENCE\b/i.test(message);
}

/**
 * Progress is an owner-facing projection of durable DAG state. Persistence,
 * drift, and transport failures must not turn a successfully completed
 * provider stage into a terminal analysis failure. Validation and config
 * failures remain loud so a malformed producer cannot be hidden.
 */
export function isAnalysisV2ProgressNonFenceFailure(error: unknown): boolean {
    if (isAnalysisV2ProgressFenceFailure(error)) return false;
    if (error instanceof AnalysisV2ProgressConflictError) return true;

    const message = nestedErrorMessage(error);
    if (!message) return false;
    if (/\b(?:PROGRESS|HEARTBEAT)_[A-Z_]*(?:VALIDATION|INVALID|CONFIG)\b/i.test(message)) {
        return false;
    }
    return /\b(?:ANALYSIS_V2_PROGRESS_(?:PERSISTENCE_ERROR|CONFLICT|REGRESSION|EVENT_CONFLICT)|ANALYSIS_V2_DAG_STATE_(?:PERSISTENCE_ERROR|CONFLICT))\b/i.test(message)
        || /\b(?:PROGRESS|HEARTBEAT)\b[^\n]*(?:PERSISTENCE|DRIFT|TRANSPORT|NETWORK|FETCH(?:\s+FAILED)?|TIMEOUT|TIMED\s*OUT|UNAVAILABLE|FAILED)\b/i.test(message)
        || /\b(?:ECONN[A-Z_]+|EPIPE|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_[A-Z_]+|FETCH\s+FAILED|NETWORK|SOCKET|TIMEOUT|TIMED\s*OUT|DEADLINE\s+EXCEEDED|ABORT(?:ED|ERROR)?)\b/i.test(message);
}

function progressFailOpenCode(operation: ProgressFailOpenOperation): string {
    if (operation === 'heartbeat') return ANALYSIS_V2_PROGRESS_HEARTBEAT_FAIL_OPEN_CODE;
    if (operation === 'initialize') return ANALYSIS_V2_PROGRESS_INITIALIZE_FAIL_OPEN_CODE;
    return ANALYSIS_V2_PROGRESS_REPORT_FAIL_OPEN_CODE;
}

function progressFailOpenCorrelation(error: unknown): ProgressFailOpenCorrelation {
    const message = nestedErrorMessage(error);
    if (/(?:^|_)(?:CONFLICT|REGRESSION|EVENT_CONFLICT)\b/i.test(message)) return 'conflict';
    if (/\b(?:UNAVAILABLE|NOT_IMPLEMENTED)\b/i.test(message)) return 'unavailable';
    if (/\b(?:NETWORK|FETCH|SOCKET|TIMEOUT|TIMED\s*OUT|DEADLINE|ECONN|EAI_|ENOTFOUND|ABORT)/i.test(message)) {
        return 'transport';
    }
    return 'persistence';
}

export function emitAnalysisV2ProgressFailOpen(input: {
    claim: ClaimedAnalysisV2Job;
    operation: ProgressFailOpenOperation;
    error: unknown;
    logger?: Pick<OperationalLogger, 'emit'>;
    onFailOpen?: (notice: AnalysisV2ProgressFailOpenNotice) => void;
}): AnalysisV2ProgressFailOpenNotice {
    const notice = {
        operation: input.operation,
        code: progressFailOpenCode(input.operation),
        correlation: progressFailOpenCorrelation(input.error),
    } satisfies AnalysisV2ProgressFailOpenNotice;
    try {
        (input.logger ?? operationalLogger).emit({
            event: 'analysis_v2.progress_fail_open',
            severity: 'warn',
            fields: {
                request_id: input.claim.requestId,
                job_key: input.claim.jobKey,
                operation: 'worker',
                phase: 'progress',
                error_code: notice.code,
                correlation: notice.correlation,
                disposition: 'fallback',
                retryable: true,
            },
        });
    } catch {
        // Progress observability must be as fail-open as progress itself.
    }
    try {
        input.onFailOpen?.(notice);
    } catch {
        // A test/diagnostic hook cannot change worker behavior.
    }
    return notice;
}

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
    logger?: Pick<OperationalLogger, 'emit'>;
    onFailOpen?: (notice: AnalysisV2ProgressFailOpenNotice) => void;
} = {}): AnalysisV2ProgressReporter {
    const store = input.store ?? analysisV2ProgressStore;
    const imageProxySigner = input.imageProxySigner ?? createImageProxyPath;
    const candidateKeyDeriver = input.candidateKeyDeriver
        ?? analysisV2ProgressCandidateKey;

    function noOpCheckpointResult(): null {
        return null;
    }

    async function checkpointWithConflictRecovery(
        claim: ClaimedAnalysisV2Job,
        projected: AnalysisV2ProjectedProgress,
        operation: ProgressFailOpenOperation,
        reloadProjection: (state: AnalysisV2DagState) => AnalysisV2ProjectedProgress,
    ): Promise<AnalysisV2ProgressCheckpointResult | null> {
        try {
            return await store.checkpoint(checkpointInput(claim, projected));
        } catch (error) {
            if (isAnalysisV2ProgressFenceFailure(error)) throw error;
            if (!isAnalysisV2ProgressNonFenceFailure(error)) throw error;

            if (input.reloadState) {
                let current: AnalysisV2DagState | null;
                try {
                    current = await input.reloadState(claim.requestId);
                } catch (reloadError) {
                    if (!isAnalysisV2ProgressNonFenceFailure(reloadError)) {
                        throw reloadError;
                    }
                    emitAnalysisV2ProgressFailOpen({
                        claim,
                        operation,
                        error: reloadError,
                        logger: input.logger,
                        onFailOpen: input.onFailOpen,
                    });
                    return noOpCheckpointResult();
                }
                if (current) {
                    try {
                        return await store.checkpoint(
                            checkpointInput(claim, reloadProjection(current))
                        );
                    } catch (retryError) {
                        if (isAnalysisV2ProgressFenceFailure(retryError)) {
                            throw retryError;
                        }
                        if (!isAnalysisV2ProgressNonFenceFailure(retryError)) {
                            throw retryError;
                        }
                        emitAnalysisV2ProgressFailOpen({
                            claim,
                            operation,
                            error: retryError,
                            logger: input.logger,
                            onFailOpen: input.onFailOpen,
                        });
                        return noOpCheckpointResult();
                    }
                }
            }
            emitAnalysisV2ProgressFailOpen({
                claim,
                operation,
                error,
                logger: input.logger,
                onFailOpen: input.onFailOpen,
            });
            return noOpCheckpointResult();
        }
    }

    return {
        async heartbeat({
            claim,
            username,
            startedAt,
            totalCount,
            preview,
            currentOrdinal,
            callPhase,
        }) {
            if (!store.heartbeatActiveProfile) {
                emitAnalysisV2ProgressFailOpen({
                    claim,
                    operation: 'heartbeat',
                    error: new Error('ANALYSIS_V2_ACTIVE_PROFILE_HEARTBEAT_UNAVAILABLE'),
                    logger: input.logger,
                    onFailOpen: input.onFailOpen,
                });
                return false;
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
            const ordinal = Number.isInteger(currentOrdinal)
                ? Math.max(0, Math.min(totalCount, currentOrdinal ?? 0))
                : 0;
            try {
                return await store.heartbeatActiveProfile({
                    requestId: claim.requestId,
                    jobKey: claim.jobKey,
                    claimToken: claim.claimToken,
                    jobInputHash: claim.inputHash,
                    startedAt,
                    totalCount,
                    maskedUsername: maskAnalysisV2ProgressUsername(username),
                    imageUrl: media.imageUrl,
                    feedImageUrls: media.feedImageUrls,
                    currentOrdinal: ordinal,
                    callPhase: callPhase ?? 'fetching',
                    ...(candidateKey ? { candidateKey } : {}),
                });
            } catch (error) {
                if (isAnalysisV2ProgressFenceFailure(error)) throw error;
                if (!isAnalysisV2ProgressNonFenceFailure(error)) throw error;
                emitAnalysisV2ProgressFailOpen({
                    claim,
                    operation: 'heartbeat',
                    error,
                    logger: input.logger,
                    onFailOpen: input.onFailOpen,
                });
                return false;
            }
        },

        async initialize({ claim, state }) {
            return checkpointWithConflictRecovery(
                claim,
                bootstrapProjection(state),
                'initialize',
                bootstrapProjection,
            );
        },

        async report(report) {
            const projected = projectAnalysisV2Progress({
                state: report.state,
                activeStage: report.stage,
                includeStageEvent: report.includeStageEvent,
            });
            return checkpointWithConflictRecovery(
                report.claim,
                projected,
                'report',
                current => projectAnalysisV2Progress({
                    state: current,
                    activeStage: report.stage,
                    includeStageEvent: report.includeStageEvent,
                }),
            );
        },
    };
}

export const analysisV2ProgressReporter = createAnalysisV2ProgressReporter();
