export const MAX_CLOUD_TASK_PIPELINE_RETRIES = 3;
export const CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING = 6;

const RETRYABLE_PIPELINE_ERROR_PREFIXES = [
    'ANALYSIS_PERSISTENCE_ERROR:',
    'INTERACTION_PROVIDER_ERROR:',
    'SCRAPING_ERROR:',
    'SCRAPING_TIMEOUT_ERROR:',
] as const;

/**
 * Cloud Tasks adds this header itself. It is trusted only after OIDC verification
 * identified the caller as the configured task service account.
 */
export function trustedCloudTasksRetryCount(
    headers: Headers,
    isVerifiedBackgroundTask: boolean
): number | null {
    if (!isVerifiedBackgroundTask) return null;

    const value = headers.get('x-cloudtasks-taskretrycount');
    if (!value || !/^\d+$/.test(value)) return null;

    const retryCount = Number(value);
    return Number.isSafeInteger(retryCount) ? retryCount : null;
}

/**
 * Leave at least one queue attempt for terminal-state persistence. Once this
 * transport ceiling is reached the route must not execute another paid step,
 * regardless of the semantic retry cursor stored in Postgres.
 */
export function shouldAbortPipelineBeforeExecution(
    trustedRetryCount: number | null,
    ceiling = CLOUD_TASK_DELIVERY_RETRY_SAFETY_CEILING
): boolean {
    if (!Number.isSafeInteger(ceiling) || ceiling < 1) {
        throw new Error('ANALYSIS_RETRY_ERROR: invalid delivery retry ceiling.');
    }
    return trustedRetryCount !== null && trustedRetryCount >= ceiling;
}

export function isRetryablePipelineError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : '';
    return RETRYABLE_PIPELINE_ERROR_PREFIXES.some(prefix => message.startsWith(prefix));
}

export function shouldRetryPipelineError(
    error: unknown,
    trustedRetryCount: number | null,
    maximumRetries = MAX_CLOUD_TASK_PIPELINE_RETRIES
): boolean {
    return trustedRetryCount !== null
        && trustedRetryCount < maximumRetries
        && isRetryablePipelineError(error);
}
