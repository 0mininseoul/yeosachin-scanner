import type { AnalysisStep, StepData } from './steps';

export const MAX_PERSISTED_SEMANTIC_RETRY_COUNT = 1000;

const ACTIVE_ANALYSIS_STEPS = new Set<AnalysisStep>([
    'pending',
    'collect',
    'profiles',
    'analyze',
    'interactions',
    'deep_analysis',
    'finalize',
    'gender',
    'features',
]);
const STATE_KEY_PATTERN = /^v1:[a-z0-9:_=-]{1,125}$/;

type SemanticRetryStep = Exclude<AnalysisStep, 'completed' | 'failed'>;

interface SemanticRetryRpcResult {
    data: unknown;
    error: { code?: string } | null;
}

export interface SemanticRetryRpcClient {
    rpc(
        functionName: string,
        params: Record<string, unknown>
    ): PromiseLike<SemanticRetryRpcResult>;
}

function boundedCursor(value: unknown): number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0
        && value <= 1_000_000
        ? value
        : 0;
}

function checkpointExists(value: unknown): boolean {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function relationshipListExists(value: unknown): boolean {
    return Array.isArray(value);
}

function assertActiveStep(value: unknown): asserts value is SemanticRetryStep {
    if (typeof value !== 'string' || !ACTIVE_ANALYSIS_STEPS.has(value as AnalysisStep)) {
        throw new Error('ANALYSIS_RETRY_ERROR: invalid pipeline step.');
    }
}

function stateKeyBelongsToStep(stateKey: string, step: SemanticRetryStep): boolean {
    const prefix = `v1:${step}`;
    return stateKey === prefix || stateKey.startsWith(`${prefix}:`);
}

function assertStateKey(stateKey: unknown, step: SemanticRetryStep): asserts stateKey is string {
    if (
        typeof stateKey !== 'string'
        || !STATE_KEY_PATTERN.test(stateKey)
        || !stateKeyBelongsToStep(stateKey, step)
    ) {
        throw new Error('ANALYSIS_RETRY_ERROR: invalid semantic state key.');
    }
}

function safeErrorCode(error: { code?: string }): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

/**
 * Builds a PII-free key for one logical pipeline cursor. A successful checkpoint
 * changes the key, so the next operation starts with a fresh failure budget.
 */
export function analysisSemanticRetryStateKey(
    step: SemanticRetryStep,
    stepData: Readonly<StepData> = {}
): string {
    assertActiveStep(step);

    switch (step) {
        case 'collect': {
            const relationship = checkpointExists(stepData.relationshipCheckpoint)
                ? stepData.relationshipCheckpoint
                : undefined;
            return [
                'v1:collect',
                `p=${Number(checkpointExists(stepData.targetProfileCheckpoint))}`,
                `f=${Number(relationshipListExists(relationship?.followers))}`,
                `g=${Number(relationshipListExists(relationship?.following))}`,
            ].join(':');
        }
        case 'profiles':
            return `v1:profiles:b=${boundedCursor(stepData.profileBatchIndex)}`;
        case 'analyze':
            return `v1:analyze:b=${boundedCursor(stepData.analyzeBatchIndex)}`;
        case 'interactions': {
            const stage = stepData.interactionStage ?? 'target';
            return `v1:interactions:s=${stage}:b=${boundedCursor(
                stepData.interactionCandidateBatchIndex
            )}`;
        }
        case 'deep_analysis':
            return `v1:deep_analysis:s=${stepData.deepAnalysisStage ?? 'pending'}`;
        case 'gender':
            return `v1:gender:b=${boundedCursor(stepData.genderBatchIndex)}`;
        case 'features':
            return `v1:features:b=${boundedCursor(stepData.featureBatchIndex)}`;
        case 'pending':
        case 'finalize':
            return `v1:${step}`;
    }
}

/**
 * Returns null when the request is no longer active at the expected step. That is
 * a CAS miss, not permission to retry stale work.
 */
export async function incrementAnalysisSemanticRetry(
    client: SemanticRetryRpcClient,
    input: {
        requestId: string;
        userId: string;
        expectedStep: SemanticRetryStep;
        stateKey: string;
    }
): Promise<number | null> {
    assertActiveStep(input.expectedStep);
    assertStateKey(input.stateKey, input.expectedStep);

    const { data, error } = await client.rpc('increment_analysis_semantic_retry', {
        p_request_id: input.requestId,
        p_user_id: input.userId,
        p_expected_step: input.expectedStep,
        p_state_key: input.stateKey,
    });
    if (error) {
        throw new Error(
            `ANALYSIS_PERSISTENCE_ERROR: semantic retry update failed (${safeErrorCode(error)}).`
        );
    }
    if (data === null) return null;
    if (
        typeof data !== 'number'
        || !Number.isSafeInteger(data)
        || data < 1
        || data > MAX_PERSISTED_SEMANTIC_RETRY_COUNT
    ) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: semantic retry update returned invalid data.');
    }
    return data;
}
