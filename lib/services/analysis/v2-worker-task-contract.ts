/**
 * The Cloud Tasks OIDC boundary authenticates this private header. It freezes execution timing
 * without changing the strict task body accepted by an older worker during a rolling deploy.
 */
export const ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT_VERSION = 2 as const;
export const ANALYSIS_V2_WORKER_TASK_CONTRACT_HEADER =
    'X-Analysis-V2-Worker-Contract';

export const ANALYSIS_V2_LEGACY_WORKER_TASK_CONTRACT = Object.freeze({
    dispatchDeadlineSeconds: 300,
    handlerWindowMs: 300_000,
    jobLeaseSeconds: 360,
});

export const ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT = Object.freeze({
    dispatchDeadlineSeconds: 600,
    handlerWindowMs: 540_000,
    jobLeaseSeconds: 600,
});

export function analysisV2WorkerTaskContractFromHeader(
    header: string | null | undefined,
): Readonly<{
    handlerWindowMs: number;
    jobLeaseSeconds: number;
}> {
    return header === String(ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT_VERSION)
        ? ANALYSIS_V2_CURRENT_WORKER_TASK_CONTRACT
        : ANALYSIS_V2_LEGACY_WORKER_TASK_CONTRACT;
}
