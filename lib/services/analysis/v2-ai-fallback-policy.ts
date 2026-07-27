import {
    isGeminiRateLimitError,
    isRecoverableGeminiResponseError,
} from '@/lib/services/ai/gemini-generation-policy';

export class AnalysisV2AiResultRateLimitExhaustedError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_RESULT_RATE_LIMIT_EXHAUSTED');
        this.name = 'AnalysisV2AiResultRateLimitExhaustedError';
    }
}

export class AnalysisV2AiTerminalUnavailableError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_TERMINAL_UNAVAILABLE');
        this.name = 'AnalysisV2AiTerminalUnavailableError';
    }
}

export function isAnalysisV2AiDeterministicFallbackError(error: unknown): boolean {
    return isRecoverableGeminiResponseError(error)
        || isGeminiRateLimitError(error)
        || error instanceof AnalysisV2AiResultRateLimitExhaustedError
        || error instanceof AnalysisV2AiTerminalUnavailableError;
}
