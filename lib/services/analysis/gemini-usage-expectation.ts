import type { AnalysisStep } from './steps';

export type GeminiUsageExpectationKind = 'private_names' | 'combined' | 'deep_risk';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_KEY_PATTERN =
    /^(private-names|combined:(0|[1-9][0-9]{0,6}):(0|[1-9][0-9]{0,6})|deep-risk:0)$/;
const EXPECTED_STEP: Record<GeminiUsageExpectationKind, AnalysisStep> = {
    private_names: 'collect',
    combined: 'analyze',
    deep_risk: 'deep_analysis',
};

interface RpcResult {
    data: unknown;
    error: { code?: string } | null;
}

export interface GeminiUsageExpectationClient {
    rpc(
        functionName: 'record_analysis_gemini_usage_expectation',
        params: Record<string, unknown>
    ): PromiseLike<RpcResult>;
}

function safeErrorCode(error: { code?: string }): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

export async function recordGeminiUsageExpectation(
    client: GeminiUsageExpectationClient,
    input: {
        requestId: string;
        userId: string;
        expectedStep: AnalysisStep;
        operationKey: string;
        generationKind: GeminiUsageExpectationKind;
        expectedRecordCount: number;
    }
): Promise<void> {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !UUID_PATTERN.test(input.userId)
        || !OPERATION_KEY_PATTERN.test(input.operationKey)
        || EXPECTED_STEP[input.generationKind] !== input.expectedStep
        || !Number.isSafeInteger(input.expectedRecordCount)
        || input.expectedRecordCount < 1
        || input.expectedRecordCount > 10_000
    ) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: invalid Gemini usage expectation.');
    }

    const { data, error } = await client.rpc(
        'record_analysis_gemini_usage_expectation',
        {
            p_request_id: input.requestId,
            p_user_id: input.userId,
            p_expected_step: input.expectedStep,
            p_operation_key: input.operationKey,
            p_generation_kind: input.generationKind,
            p_expected_record_count: input.expectedRecordCount,
        }
    );
    if (error) {
        throw new Error(
            `ANALYSIS_PERSISTENCE_ERROR: Gemini usage expectation failed (${safeErrorCode(error)}).`
        );
    }
    if (data !== true) {
        throw new Error(
            'ANALYSIS_PERSISTENCE_ERROR: Gemini usage expectation request state did not match.'
        );
    }
}
