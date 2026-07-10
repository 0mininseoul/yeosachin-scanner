interface CompletionRpcResult {
    data: unknown;
    error: { code?: string } | null;
}

const COMPACT_USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;
const COMPACT_STEP_DATA_KEYS = new Set(['mutualFollows', 'targetProfileImage']);

function assertCompactStepData(value: object): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: invalid compact completion state.');
    }
    const state = value as Record<string, unknown>;
    if (Object.keys(state).some(key => !COMPACT_STEP_DATA_KEYS.has(key))) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: invalid compact completion state.');
    }
    if (state.mutualFollows !== undefined) {
        if (
            !Array.isArray(state.mutualFollows)
            || state.mutualFollows.length > 10
            || state.mutualFollows.some(username => (
                typeof username !== 'string' || !COMPACT_USERNAME_PATTERN.test(username)
            ))
        ) {
            throw new Error('ANALYSIS_PERSISTENCE_ERROR: invalid compact completion state.');
        }
    }
    if (
        state.targetProfileImage !== undefined
        && (
            typeof state.targetProfileImage !== 'string'
            || state.targetProfileImage.length > 8_192
        )
    ) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: invalid compact completion state.');
    }
}

export interface CompletionRpcClient {
    rpc(
        functionName: string,
        params: Record<string, unknown>
    ): PromiseLike<CompletionRpcResult>;
}

function safeErrorCode(error: { code?: string }): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

export async function completeAnalysisRequest(
    client: CompletionRpcClient,
    input: {
        requestId: string;
        userId: string;
        compactStepData: object;
    }
): Promise<void> {
    assertCompactStepData(input.compactStepData);
    const { data, error } = await client.rpc(
        'complete_analysis_request_and_purge_staging',
        {
            p_request_id: input.requestId,
            p_user_id: input.userId,
            p_step_data: input.compactStepData,
        }
    );
    if (error) {
        throw new Error(
            `ANALYSIS_PERSISTENCE_ERROR: completion transaction failed (${safeErrorCode(error)}).`
        );
    }
    if (data !== true) {
        throw new Error(
            'ANALYSIS_PERSISTENCE_ERROR: completion transaction did not update the request.'
        );
    }
}
