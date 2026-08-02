/**
 * Minimal authenticated-user boundary for the dedicated betatest routes.
 * The authenticated self-check returns only a boolean. Dedicated beta routes
 * use the separately named service-owned enrollment RPC after server auth.
 */
export interface BetaTestAccessClient {
    rpc(name: string, params?: Record<string, unknown>): PromiseLike<{
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

/**
 * Establishes the caller's server-owned betatest grant when the database policy
 * permits automatic enrollment. The RPC also answers existing operator grants,
 * so beta routes never create a preflight before the downstream grant fences
 * can observe a current row.
 */
export async function ensureBetaTestAccess(
    client: BetaTestAccessClient,
    userId: string
): Promise<boolean> {
    try {
        const result = await client.rpc('enroll_analysis_beta_user', {
            p_user_id: userId,
        });
        return result.error === null && result.data === true;
    } catch {
        return false;
    }
}
