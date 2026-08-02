/**
 * Minimal authenticated-user boundary for the dedicated betatest routes.
 * The database function deliberately returns only a boolean and is never
 * invoked through service-role credentials.
 */
export interface BetaTestAccessClient {
    rpc(name: string, params?: Record<string, never>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export const BETA_TEST_ACCESS_UNAVAILABLE = 'BETA_ACCESS_UNAVAILABLE' as const;

export function betaTestFreePoolEnabled(
    env: Record<string, string | undefined> = process.env
): boolean {
    return env.BETATEST_FREE_POOL_ENABLED === 'true';
}

/** Returns false for transport, database, and malformed-result failures. */
export async function hasBetaTestAccess(client: BetaTestAccessClient): Promise<boolean> {
    try {
        const result = await client.rpc('analysis_beta_has_access');
        return result.error === null && result.data === true;
    } catch {
        return false;
    }
}
