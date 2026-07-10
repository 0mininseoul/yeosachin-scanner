export const ANALYSIS_LEASE_RETRY_DELAY_MS = 5_000;
export const ANALYSIS_STEP_RECOVERY_DELAY_MS = 30_000;
export const MAX_ANALYSIS_STEP_TRANSIENT_RETRIES = 3;
export const ANALYSIS_PROGRESS_STEPS = [
    { label: '팔로워·팔로잉 수집', threshold: 25 },
    { label: '맞팔 계정 확인', threshold: 30 },
    { label: '공개 프로필 수집', threshold: 50 },
    { label: 'AI 계정 분석', threshold: 82 },
    { label: '좋아요·댓글 상호작용', threshold: 92 },
    { label: '위험 계정 심층 분석', threshold: 97 },
    { label: '결과 정리', threshold: 100 },
] as const;

export type AnalysisStepFailureDecision =
    | { kind: 'lease_wait'; delayMs: number; nextRetryCount: number }
    | { kind: 'terminal' }
    | { kind: 'persisted_failure' }
    | { kind: 'transient_retry'; delayMs: number; nextRetryCount: number }
    | { kind: 'exhausted' };

export function shouldClientDriveAnalysis(
    status: 'pending' | 'processing' | 'completed' | 'failed' | undefined,
    backgroundProcessing: boolean | undefined
): boolean {
    return backgroundProcessing !== true && (status === 'pending' || status === 'processing');
}

export function decideAnalysisStepFailure(
    status: number,
    hasPersistedStep: boolean,
    retryCount: number,
    maxRetries: number = MAX_ANALYSIS_STEP_TRANSIENT_RETRIES
): AnalysisStepFailureDecision {
    if (!Number.isSafeInteger(retryCount) || retryCount < 0) {
        throw new Error('ANALYSIS_PROGRESS_CONFIG_ERROR: retry count is invalid.');
    }
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
        throw new Error('ANALYSIS_PROGRESS_CONFIG_ERROR: max retries is invalid.');
    }
    if (status === 409) {
        return {
            kind: 'lease_wait',
            delayMs: ANALYSIS_LEASE_RETRY_DELAY_MS,
            nextRetryCount: retryCount,
        };
    }
    if (status === 401 || status === 403 || status === 404) {
        return { kind: 'terminal' };
    }
    if (status === 500 && hasPersistedStep) {
        return { kind: 'persisted_failure' };
    }
    if (retryCount < maxRetries) {
        return {
            kind: 'transient_retry',
            delayMs: 2 ** (retryCount + 1) * 1_000,
            nextRetryCount: retryCount + 1,
        };
    }
    return { kind: 'exhausted' };
}
