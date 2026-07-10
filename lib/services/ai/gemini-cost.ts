export const DEFAULT_VERTEX_AI_MODEL = 'gemini-3-flash-preview';
export const DEFAULT_COST_SENSITIVE_VERTEX_AI_MODEL = 'gemini-3.1-flash-lite';
export const VERTEX_AI_PRICING_SOURCE = 'https://cloud.google.com/vertex-ai/generative-ai/pricing';

const TOKENS_PER_MILLION = 1_000_000;

interface ModelPricing {
    canonicalModelName: string;
    globalInputUsdPerMillionTokens: number;
    globalOutputUsdPerMillionTokens: number;
    nonGlobalInputUsdPerMillionTokens: number;
    nonGlobalOutputUsdPerMillionTokens: number;
}

const STANDARD_MODEL_PRICING: Record<string, ModelPricing> = {
    'gemini-3.1-flash-lite': {
        canonicalModelName: 'gemini-3.1-flash-lite',
        globalInputUsdPerMillionTokens: 0.25,
        globalOutputUsdPerMillionTokens: 1.5,
        nonGlobalInputUsdPerMillionTokens: 0.275,
        nonGlobalOutputUsdPerMillionTokens: 1.65,
    },
    'gemini-3.1-flash-lite-preview': {
        canonicalModelName: 'gemini-3.1-flash-lite',
        globalInputUsdPerMillionTokens: 0.25,
        globalOutputUsdPerMillionTokens: 1.5,
        nonGlobalInputUsdPerMillionTokens: 0.275,
        nonGlobalOutputUsdPerMillionTokens: 1.65,
    },
    'gemini-3-flash-preview': {
        canonicalModelName: 'gemini-3-flash-preview',
        globalInputUsdPerMillionTokens: 0.5,
        globalOutputUsdPerMillionTokens: 3,
        nonGlobalInputUsdPerMillionTokens: 0.5,
        nonGlobalOutputUsdPerMillionTokens: 3,
    },
};

export interface GeminiCostTokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    thinkingTokens?: number;
}

export interface GeminiRequestCostEstimate {
    modelName: string;
    canonicalModelName: string;
    location: string;
    inputTokens: number;
    outputTokens: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    inputCostUsd: number;
    outputCostUsd: number;
    totalCostUsd: number;
}

export function isVertexAICostOptimized(
    value: string | undefined = process.env.VERTEX_AI_COST_OPTIMIZED
): boolean {
    return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

export function resolveVertexAIModel(
    override: string | undefined = process.env.VERTEX_AI_MODEL,
    costOptimized: boolean = isVertexAICostOptimized()
): string {
    return override?.trim()
        || (costOptimized ? DEFAULT_COST_SENSITIVE_VERTEX_AI_MODEL : DEFAULT_VERTEX_AI_MODEL);
}

function modelIdFromResourceName(modelName: string): string {
    return modelName.trim().split('/').at(-1) ?? modelName.trim();
}

function getModelPricing(modelName: string): ModelPricing | null {
    const modelId = modelIdFromResourceName(modelName);
    const directMatch = STANDARD_MODEL_PRICING[modelId];
    if (directMatch) {
        return directMatch;
    }

    if (/^gemini-3\.1-flash-lite-\d{3}$/.test(modelId)) {
        return STANDARD_MODEL_PRICING['gemini-3.1-flash-lite'];
    }

    return null;
}

function nonNegativeInteger(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function roundUsd(value: number): number {
    return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

/** Estimate standard, on-demand Vertex AI charges from response usage metadata. */
export function estimateGeminiRequestCost(
    tokenUsage: GeminiCostTokenUsage,
    modelName: string,
    location: string = 'global'
): GeminiRequestCostEstimate | null {
    const pricing = getModelPricing(modelName);
    if (!pricing) {
        return null;
    }

    const inputTokens = nonNegativeInteger(tokenUsage.promptTokens);
    const completionTokens = nonNegativeInteger(tokenUsage.completionTokens);
    const thinkingTokens = nonNegativeInteger(tokenUsage.thinkingTokens ?? 0);
    const totalTokens = nonNegativeInteger(tokenUsage.totalTokens);
    const explicitOutputTokens = completionTokens + thinkingTokens;
    const inferredOutputTokens = Math.max(0, totalTokens - inputTokens);
    const outputTokens = Math.max(explicitOutputTokens, inferredOutputTokens);
    const isGlobal = location.trim().toLowerCase() === 'global';
    const inputRate = isGlobal
        ? pricing.globalInputUsdPerMillionTokens
        : pricing.nonGlobalInputUsdPerMillionTokens;
    const outputRate = isGlobal
        ? pricing.globalOutputUsdPerMillionTokens
        : pricing.nonGlobalOutputUsdPerMillionTokens;
    const inputCostUsd = inputTokens * inputRate / TOKENS_PER_MILLION;
    const outputCostUsd = outputTokens * outputRate / TOKENS_PER_MILLION;

    return {
        modelName,
        canonicalModelName: pricing.canonicalModelName,
        location,
        inputTokens,
        outputTokens,
        inputUsdPerMillionTokens: inputRate,
        outputUsdPerMillionTokens: outputRate,
        inputCostUsd: roundUsd(inputCostUsd),
        outputCostUsd: roundUsd(outputCostUsd),
        totalCostUsd: roundUsd(inputCostUsd + outputCostUsd),
    };
}
