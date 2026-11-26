import type { AnalysisV2AiAdmissionErrorCode } from './v2-job-store';

export const PROFILE_CONSUMER_READ_TIMEOUT = 'ANALYSIS_V2_PROFILE_CONSUMER_READ_TIMEOUT';

export type AnalysisV2SchedulerContinuationReason =
    AnalysisV2AiAdmissionErrorCode | typeof PROFILE_CONSUMER_READ_TIMEOUT;

export class AnalysisV2SchedulerContinuationError extends Error {
    readonly reason: AnalysisV2SchedulerContinuationReason;
    readonly delaySeconds: number;

    constructor(reason: AnalysisV2SchedulerContinuationReason, delaySeconds = 1) {
        if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 300) {
            throw new Error('ANALYSIS_V2_SCHEDULER_CONTINUATION_DELAY_INVALID');
        }
        super('ANALYSIS_V2_SCHEDULER_CONTINUATION_REQUIRED');
        this.name = 'AnalysisV2SchedulerContinuationError';
        this.reason = reason;
        this.delaySeconds = delaySeconds;
    }
}

/** The scheduler durably deferred required work for capacity, after draining its siblings. */
export class AnalysisV2ConfirmedCapacityContinuation extends AnalysisV2SchedulerContinuationError {
    constructor(delaySeconds: number) {
        super('ANALYSIS_V2_AI_CAPACITY_PENDING', delaySeconds);
    }
}

export function localStandardResolverGraceMs(): 0 | 8000 | 50000 {
    if (process.env.NODE_ENV !== 'test') return 0;
    switch (process.env.STANDARD_SHARED_RESOLVER_GRACE_MS) {
    case '8000': return 8000;
    case '50000': return 50000;
    default: return 0;
    }
}

export function schedulerContinuationReason(error: unknown):
AnalysisV2SchedulerContinuationReason | null {
    if (error instanceof AnalysisV2SchedulerContinuationError) return error.reason;
    if (!(error instanceof Error)) return null;
    switch (error.message) {
    case 'ANALYSIS_V2_AI_CAPACITY_PENDING':
    case 'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT':
    case 'ANALYSIS_V2_AI_QUARANTINE_ACTIVE':
    case 'ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING':
        return error.message;
    default:
        return null;
    }
}
