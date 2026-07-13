import {
    ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
    ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY,
    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
    analysisV2JobInputHash,
    planAnalysisV2Successors,
    type AnalysisV2FoundationJobKey,
} from './v2-coordinator';
import {
    analysisV2JobStore,
    type AnalysisV2JobStore,
    type AnalysisV2JobSuccessor,
    type AnalysisV2TaskDelivery,
    type ClaimedAnalysisV2Job,
} from './v2-job-store';
import { dispatchAnalysisV2Job } from './v2-tasks';

const FOUNDATION_JOB_KEYS = new Set<string>([
    ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
    ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY,
]);

export type AnalysisV2JobHandler = (
    job: ClaimedAnalysisV2Job
) => Promise<readonly AnalysisV2JobSuccessor[]>;

export type AnalysisV2JobDispatcher = (
    requestId: string,
    jobKey: string
) => Promise<unknown>;

export type AnalysisV2WorkerOutcome =
    | Readonly<{ status: 'already_terminal' }>
    | Readonly<{ status: 'retry'; errorCode: string }>
    | Readonly<{ status: 'failed'; errorCode: string }>
    | Readonly<{
        status: 'completed';
        successorCount: number;
        pendingRecoveryCount: number;
    }>;

export class AnalysisV2JobExecutionError extends Error {
    constructor(
        readonly code: string,
        readonly retryable: boolean
    ) {
        super(code);
        this.name = 'AnalysisV2JobExecutionError';
    }
}

function foundationJobKey(value: string): AnalysisV2FoundationJobKey | null {
    return FOUNDATION_JOB_KEYS.has(value) ? value as AnalysisV2FoundationJobKey : null;
}

function assertFoundationInput(job: ClaimedAnalysisV2Job): AnalysisV2FoundationJobKey {
    const jobKey = foundationJobKey(job.jobKey);
    if (!jobKey) {
        throw new AnalysisV2JobExecutionError(
            'ANALYSIS_V2_JOB_HANDLER_UNAVAILABLE',
            true
        );
    }
    if (job.inputHash !== analysisV2JobInputHash(job.requestId, jobKey)) {
        throw new AnalysisV2JobExecutionError(
            'ANALYSIS_V2_JOB_INPUT_MISMATCH',
            false
        );
    }
    return jobKey;
}

/**
 * Phase C deliberately implements only the PII-free coordinator bootstrap. Track handlers are
 * added by later phases before the execution capability can be opened.
 */
export async function executeAnalysisV2FoundationJob(
    job: ClaimedAnalysisV2Job
): Promise<readonly AnalysisV2JobSuccessor[]> {
    const jobKey = assertFoundationInput(job);
    if (jobKey !== ANALYSIS_V2_BOOTSTRAP_JOB_KEY) {
        throw new AnalysisV2JobExecutionError(
            'ANALYSIS_V2_JOB_HANDLER_UNAVAILABLE',
            true
        );
    }
    return planAnalysisV2Successors(job.requestId, jobKey).map(successor => ({
        jobKey: successor.jobKey,
        track: successor.track,
        kind: successor.kind,
        batch: successor.batch,
        inputHash: successor.inputHash,
        requiredJobKeys: successor.requiredJobKeys,
    }));
}

function executionFailure(error: unknown): AnalysisV2JobExecutionError {
    return error instanceof AnalysisV2JobExecutionError
        ? error
        : new AnalysisV2JobExecutionError('ANALYSIS_V2_JOB_HANDLER_FAILED', true);
}

export async function processAnalysisV2TaskDelivery(
    delivery: AnalysisV2TaskDelivery,
    dependencies: {
        store?: AnalysisV2JobStore;
        handler?: AnalysisV2JobHandler;
        dispatch?: AnalysisV2JobDispatcher;
    } = {}
): Promise<AnalysisV2WorkerOutcome> {
    const store = dependencies.store ?? analysisV2JobStore;
    const handler = dependencies.handler ?? executeAnalysisV2FoundationJob;
    const dispatch = dependencies.dispatch ?? dispatchAnalysisV2Job;
    const claim = await store.claim(delivery);
    if (!claim) return Object.freeze({ status: 'already_terminal' });

    let successors: readonly AnalysisV2JobSuccessor[];
    try {
        successors = await handler(claim);
    } catch (error) {
        const failure = executionFailure(error);
        const released = await store.releaseClaim(claim, {
            errorCode: failure.code,
            retryable: failure.retryable,
        });
        if (released.status === 'failed' || released.status === 'cancelled') {
            return Object.freeze({ status: 'failed', errorCode: failure.code });
        }
        return Object.freeze({ status: 'retry', errorCode: failure.code });
    }

    const dispatchable = await store.completeAndFanout(claim, successors);
    const settled = await Promise.allSettled(
        dispatchable.map(job => dispatch(job.requestId, job.jobKey))
    );
    const pendingRecoveryCount = settled.filter(result => result.status === 'rejected').length;
    return Object.freeze({
        status: 'completed',
        successorCount: dispatchable.length,
        pendingRecoveryCount,
    });
}
