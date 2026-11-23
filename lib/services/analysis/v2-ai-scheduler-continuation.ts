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
