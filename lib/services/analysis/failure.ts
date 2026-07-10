const MAX_FAILURE_MESSAGE_LENGTH = 1000;
export const ANALYSIS_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

interface FailureRpcResult {
    data: unknown;
    error: { code?: string } | null;
}

export interface FailureRpcClient {
    rpc(
        functionName: string,
        params: Record<string, unknown>
    ): PromiseLike<FailureRpcResult>;
}

function safeErrorCode(error: { code?: string }): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

export function normalizeAnalysisFailureMessage(message: unknown): string {
    const normalized = typeof message === 'string'
        ? message.replace(/\0/g, '').trim()
        : '';
    const fallback = normalized || 'Analysis failed.';
    return Array.from(fallback).slice(0, MAX_FAILURE_MESSAGE_LENGTH).join('');
}

export function isAnalysisRequestStale(
    createdAt: string | null | undefined,
    nowMs = Date.now()
): boolean {
    if (typeof createdAt !== 'string' || !Number.isFinite(nowMs)) {
        return false;
    }
    const createdAtMs = Date.parse(createdAt);
    return Number.isFinite(createdAtMs)
        && nowMs - createdAtMs >= ANALYSIS_STALE_AFTER_MS;
}

export async function failAnalysisRequest(
    client: FailureRpcClient,
    input: {
        requestId: string;
        userId: string;
        expectedStep: string;
        errorMessage: unknown;
        compactStepData?: object;
    }
): Promise<boolean> {
    const { data, error } = await client.rpc(
        'fail_analysis_request_and_purge_staging',
        {
            p_request_id: input.requestId,
            p_user_id: input.userId,
            p_expected_step: input.expectedStep,
            p_error_message: normalizeAnalysisFailureMessage(input.errorMessage),
            p_step_data: input.compactStepData ?? {},
        }
    );
    if (error) {
        throw new Error(
            `ANALYSIS_PERSISTENCE_ERROR: failure transaction failed (${safeErrorCode(error)}).`
        );
    }
    if (typeof data !== 'boolean') {
        throw new Error(
            'ANALYSIS_PERSISTENCE_ERROR: failure transaction returned an invalid result.'
        );
    }
    return data;
}
