export type AnalysisWorkloadRole = 'preflight' | 'paid';

export const ANALYSIS_WORKLOAD_ROLES = Object.freeze([
    'preflight',
    'paid',
] as const);

export function parseAnalysisWorkloadRole(value: unknown): AnalysisWorkloadRole {
    if (value === 'preflight' || value === 'paid') return value;
    if (value === undefined || value === null || value === '') {
        throw new Error('ANALYSIS_WORKLOAD_ROLE_REQUIRED');
    }
    throw new Error('ANALYSIS_WORKLOAD_ROLE_INVALID');
}

/** Runtime role is mandatory; no production fallback is allowed. */
export function getAnalysisWorkloadRole(
    env: Record<string, string | undefined> = process.env,
): AnalysisWorkloadRole {
    return parseAnalysisWorkloadRole(env.ANALYSIS_WORKLOAD_ROLE);
}

export function assertAnalysisWorkloadRole(
    actual: unknown,
    expected: AnalysisWorkloadRole,
    options: { allowLegacyTestPayload?: boolean } = {},
): void {
    if (actual === undefined && options.allowLegacyTestPayload === true) return;
    if (actual !== expected) throw new Error('ANALYSIS_WORKLOAD_ROLE_MISMATCH');
}

/**
 * Worker routes use this gate before dispatching any claimed work. During unit tests the
 * legacy route fixtures intentionally omit deployment-only role env, but every non-test
 * process must declare its role explicitly so a single service cannot consume both queues.
 */
export function assertAnalysisWorkerWorkloadRole(
    expected: AnalysisWorkloadRole,
    env: Record<string, string | undefined> = process.env,
): AnalysisWorkloadRole {
    try {
        const actual = getAnalysisWorkloadRole(env);
        if (actual !== expected) throw new Error('ANALYSIS_WORKLOAD_ROLE_MISMATCH');
        return actual;
    } catch (error) {
        if (
            env.NODE_ENV === 'test'
            && error instanceof Error
            && error.message === 'ANALYSIS_WORKLOAD_ROLE_REQUIRED'
        ) {
            return expected;
        }
        throw error;
    }
}

export function assertAnalysisTaskWorkloadRole(
    actual: unknown,
    expected: AnalysisWorkloadRole,
): void {
    // Payloads emitted before role isolation intentionally omit this field and
    // must drain during the mixed-version rollout. A declared role is always
    // checked, so a payload cannot cross the worker boundary silently.
    if (actual === undefined || actual === null || actual === '') return;
    assertAnalysisWorkloadRole(actual, expected);
}

export function isAnalysisWorkloadRole(value: unknown): value is AnalysisWorkloadRole {
    return value === 'preflight' || value === 'paid';
}
