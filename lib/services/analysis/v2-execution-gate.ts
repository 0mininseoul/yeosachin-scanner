export const ANALYSIS_V2_EXECUTION_CAPABILITY = 'jobs' as const;

function strictBoolean(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || ['0', 'false', 'off', 'no'].includes(normalized)) return false;
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    throw new Error('ANALYSIS_V2_EXECUTION_ENABLED must be boolean.');
}

export function isAnalysisV2StartAvailable(
    env: Record<string, string | undefined> = process.env
): boolean {
    return ANALYSIS_V2_EXECUTION_CAPABILITY === ('jobs' as string)
        && strictBoolean(env.ANALYSIS_V2_EXECUTION_ENABLED);
}
