export const ANALYSIS_V2_EXECUTION_CAPABILITY = 'jobs' as const;

function strictBoolean(
    value: string | undefined,
    key: 'ANALYSIS_V2_ADMISSION_ENABLED'
        | 'ANALYSIS_V2_WORKER_ENABLED'
        | 'ANALYSIS_V2_RECOVERY_ENABLED'
): boolean {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || ['0', 'false', 'off', 'no'].includes(normalized)) return false;
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    throw new Error(`${key} must be boolean.`);
}

export function isAnalysisV2AdmissionAvailable(
    env: Record<string, string | undefined> = process.env
): boolean {
    return ANALYSIS_V2_EXECUTION_CAPABILITY === ('jobs' as string)
        && strictBoolean(env.ANALYSIS_V2_ADMISSION_ENABLED, 'ANALYSIS_V2_ADMISSION_ENABLED');
}

export function isAnalysisV2WorkerAvailable(
    env: Record<string, string | undefined> = process.env
): boolean {
    return ANALYSIS_V2_EXECUTION_CAPABILITY === ('jobs' as string)
        && strictBoolean(env.ANALYSIS_V2_WORKER_ENABLED, 'ANALYSIS_V2_WORKER_ENABLED');
}

export function isAnalysisV2RecoveryAvailable(
    env: Record<string, string | undefined> = process.env
): boolean {
    return ANALYSIS_V2_EXECUTION_CAPABILITY === ('jobs' as string)
        && strictBoolean(env.ANALYSIS_V2_RECOVERY_ENABLED, 'ANALYSIS_V2_RECOVERY_ENABLED');
}
