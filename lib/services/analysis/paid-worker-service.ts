/** Service identity checked by the commercial handoff and paid capacity gates. */
export function isPaidWorkerService(env: Readonly<Record<string, string | undefined>>): boolean {
    return env.K_SERVICE === 'analysis-paid-worker';
}
