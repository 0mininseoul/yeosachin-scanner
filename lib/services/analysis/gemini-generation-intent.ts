import type { StepData } from './steps';

export type GeminiGenerationKind = 'private_names' | 'combined' | 'deep_risk';

const OPERATION_KEY_PATTERN = /^[a-z0-9:_-]{1,128}$/;
const MAX_GENERATION_INPUT_IDS = 10_000;

export function beginGeminiGeneration(
    stepData: StepData,
    input: {
        kind: GeminiGenerationKind;
        operationKey: string;
        inputIds: readonly string[];
        now?: Date;
    }
): StepData {
    if (
        !OPERATION_KEY_PATTERN.test(input.operationKey)
        || input.inputIds.length === 0
        || input.inputIds.length > MAX_GENERATION_INPUT_IDS
        || input.inputIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 128)
        || new Set(input.inputIds).size !== input.inputIds.length
    ) {
        throw new Error('AI_GENERATION_INTENT_CONFIG_ERROR: invalid generation intent.');
    }

    return {
        ...stepData,
        geminiGenerationIntent: {
            kind: input.kind,
            operationKey: input.operationKey,
            inputIds: [...input.inputIds],
            createdAt: (input.now ?? new Date()).toISOString(),
        },
    };
}

export function clearGeminiGeneration(stepData: StepData): StepData {
    const cleared = { ...stepData };
    delete cleared.geminiGenerationIntent;
    return cleared;
}

export function rejectUnresolvedGeminiGeneration(stepData: StepData): void {
    if (stepData.geminiGenerationIntent !== undefined) {
        throw new Error(
            'AI_GENERATION_INTERRUPTED_ERROR: a prior Gemini request may have been charged and will not be replayed.'
        );
    }
}
