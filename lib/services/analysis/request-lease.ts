import { randomUUID } from 'node:crypto';

// Vercel terminates a step after 300 seconds. The short crash margin lets the current
// Cloud Tasks retry schedule reacquire before its bounded attempts are exhausted.
export const ANALYSIS_STEP_LEASE_SECONDS = 330;

interface RpcError {
    code?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisLeaseRpcClient {
    rpc(
        functionName: string,
        params: Record<string, unknown>
    ): PromiseLike<RpcResult>;
}

export interface AnalysisRequestLease {
    requestId: string;
    token: string;
}

interface AcquireLeaseInput {
    requestId: string;
    userId: string;
    expectedStep: string;
    leaseSeconds: number;
}

function safeErrorCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

export function isAnalysisRequestOwner(userId: string, ownerId: unknown): boolean {
    return typeof ownerId === 'string' && ownerId === userId;
}

export async function acquireAnalysisRequestLease(
    client: AnalysisLeaseRpcClient,
    input: AcquireLeaseInput,
    createToken: () => string = randomUUID
): Promise<AnalysisRequestLease | null> {
    const token = createToken();
    const { data, error } = await client.rpc('acquire_analysis_request_lease', {
        p_request_id: input.requestId,
        p_user_id: input.userId,
        p_expected_step: input.expectedStep,
        p_lease_token: token,
        p_lease_seconds: input.leaseSeconds,
    });

    if (error) {
        throw new Error(
            `ANALYSIS_LEASE_ERROR: lease acquisition failed (${safeErrorCode(error)}).`
        );
    }
    if (typeof data !== 'boolean') {
        throw new Error('ANALYSIS_LEASE_ERROR: lease RPC returned an invalid result.');
    }
    return data ? { requestId: input.requestId, token } : null;
}

export async function releaseAnalysisRequestLease(
    client: AnalysisLeaseRpcClient,
    lease: AnalysisRequestLease
): Promise<void> {
    try {
        const { error } = await client.rpc('release_analysis_request_lease', {
            p_request_id: lease.requestId,
            p_lease_token: lease.token,
        });
        if (error) {
            console.warn(
                `[analysis.lease] release failed (${safeErrorCode(error)}).`
            );
        }
    } catch {
        console.warn('[analysis.lease] release failed (transport).');
    }
}
