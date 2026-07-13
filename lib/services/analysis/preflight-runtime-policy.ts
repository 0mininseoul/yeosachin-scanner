import { getWebProfileConfig } from '@/lib/services/instagram/providers/selfhosted/web-client';

export const PREFLIGHT_TASK_DISPATCH_DEADLINE_SECONDS = 120;
export const PREFLIGHT_WORKER_LEASE_SECONDS = 120;
export const PREFLIGHT_PROFILE_RUNTIME_BUDGET_MS = 90_000;

export function maximumSelfHostedProfileRuntimeMs(
    env: Record<string, string | undefined> = process.env
): number {
    const config = getWebProfileConfig(env);
    const attempts = config.retries + 1;
    let retryWaitMs = 0;
    for (let attempt = 0; attempt < config.retries; attempt++) {
        retryWaitMs += Math.max(
            config.retryBaseDelayMs * 2 ** attempt,
            config.maxRetryAfterMs
        );
    }

    // The interval term is conservative: a slow response normally consumes the interval,
    // but counting both keeps configuration changes safely inside the worker fence.
    return attempts * (config.timeoutMs + config.minIntervalMs) + retryWaitMs;
}

export function assertPreflightRuntimePolicy(
    env: Record<string, string | undefined> = process.env
): void {
    const maximumRuntimeMs = maximumSelfHostedProfileRuntimeMs(env);
    if (maximumRuntimeMs > PREFLIGHT_PROFILE_RUNTIME_BUDGET_MS) {
        throw new Error(
            'PREFLIGHT_TASKS_CONFIG_ERROR: self-hosted profile retry policy exceeds '
            + 'the preflight worker runtime budget.'
        );
    }
}
