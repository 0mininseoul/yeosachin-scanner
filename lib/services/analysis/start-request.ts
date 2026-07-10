interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisStartRpcClient {
    rpc(
        functionName: string,
        params: Record<string, unknown>
    ): PromiseLike<RpcResult>;
}

export interface CreateAnalysisRequestInput {
    userId: string;
    email: string;
    authProvider: 'google' | 'kakao';
    targetInstagramId: string;
    targetGender: 'male' | 'female';
    scraperOptions: Record<string, unknown>;
    idempotencyKey: string;
    freeAnalysisLimit: number;
}

export interface CreatedAnalysisRequest {
    requestId: string;
    created: boolean;
}

export class AnalysisLimitExceededError extends Error {
    constructor() {
        super('ANALYSIS_LIMIT_EXCEEDED');
        this.name = 'AnalysisLimitExceededError';
    }
}

export class AnalysisIdempotencyConflictError extends Error {
    constructor() {
        super('ANALYSIS_IDEMPOTENCY_CONFLICT');
        this.name = 'AnalysisIdempotencyConflictError';
    }
}

export class AnalysisAlreadyInProgressError extends Error {
    constructor() {
        super('ANALYSIS_ALREADY_IN_PROGRESS');
        this.name = 'AnalysisAlreadyInProgressError';
    }
}

function safeErrorCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

export async function consumeQuotaAndCreateAnalysisRequest(
    client: AnalysisStartRpcClient,
    input: CreateAnalysisRequestInput
): Promise<CreatedAnalysisRequest> {
    const { data, error } = await client.rpc('consume_analysis_quota_and_create_request', {
        p_user_id: input.userId,
        p_email: input.email,
        p_auth_provider: input.authProvider,
        p_target_instagram_id: input.targetInstagramId,
        p_target_gender: input.targetGender,
        p_scraper_options: input.scraperOptions,
        p_idempotency_key: input.idempotencyKey,
        p_free_analysis_limit: input.freeAnalysisLimit,
    });

    if (error) {
        if (error.message === 'ANALYSIS_LIMIT_EXCEEDED') {
            throw new AnalysisLimitExceededError();
        }
        if (error.message === 'ANALYSIS_IDEMPOTENCY_CONFLICT') {
            throw new AnalysisIdempotencyConflictError();
        }
        if (error.message === 'ANALYSIS_ALREADY_IN_PROGRESS') {
            throw new AnalysisAlreadyInProgressError();
        }
        throw new Error(
            `ANALYSIS_START_TRANSACTION_ERROR: request creation failed (${safeErrorCode(error)}).`
        );
    }
    if (!Array.isArray(data) || data.length !== 1) {
        throw new Error('ANALYSIS_START_TRANSACTION_ERROR: RPC returned an invalid result.');
    }
    const row = data[0] as Record<string, unknown>;
    if (
        typeof row.request_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            row.request_id
        ) ||
        typeof row.created !== 'boolean'
    ) {
        throw new Error('ANALYSIS_START_TRANSACTION_ERROR: RPC result schema is invalid.');
    }
    return { requestId: row.request_id, created: row.created };
}
