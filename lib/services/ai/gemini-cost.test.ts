import { describe, expect, it } from 'vitest';
import {
    DEFAULT_COST_SENSITIVE_VERTEX_AI_MODEL,
    DEFAULT_VERTEX_AI_MODEL,
    estimateGeminiRequestCost,
    isVertexAICostOptimized,
    resolveVertexAIModel,
} from './gemini-cost';

describe('resolveVertexAIModel', () => {
    it('uses the quality-first model by default', () => {
        expect(resolveVertexAIModel(undefined, false)).toBe(DEFAULT_VERTEX_AI_MODEL);
        expect(resolveVertexAIModel('  ', false)).toBe(DEFAULT_VERTEX_AI_MODEL);
    });

    it('uses Flash-Lite only when cost optimization is enabled', () => {
        expect(resolveVertexAIModel(undefined, true)).toBe(DEFAULT_COST_SENSITIVE_VERTEX_AI_MODEL);
    });

    it('preserves an explicit model override', () => {
        expect(resolveVertexAIModel(' custom-model ', false)).toBe('custom-model');
        expect(resolveVertexAIModel(' custom-model ', true)).toBe('custom-model');
    });
});

describe('isVertexAICostOptimized', () => {
    it('is opt-in and accepts explicit truthy values only', () => {
        expect(isVertexAICostOptimized(undefined)).toBe(false);
        expect(isVertexAICostOptimized('false')).toBe(false);
        expect(isVertexAICostOptimized('true')).toBe(true);
        expect(isVertexAICostOptimized('1')).toBe(true);
    });
});

describe('estimateGeminiRequestCost', () => {
    it('prices global Flash-Lite input, visible output, and thinking tokens', () => {
        const estimate = estimateGeminiRequestCost({
            promptTokens: 1_000_000,
            completionTokens: 750_000,
            thinkingTokens: 250_000,
            totalTokens: 2_000_000,
        }, 'gemini-3.1-flash-lite', 'global');

        expect(estimate).toMatchObject({
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            inputCostUsd: 0.25,
            outputCostUsd: 1.5,
            totalCostUsd: 1.75,
        });
    });

    it('infers billable reasoning output from total tokens for stored usage rows', () => {
        const estimate = estimateGeminiRequestCost({
            promptTokens: 1_000,
            completionTokens: 200,
            totalTokens: 1_500,
        }, 'gemini-3.1-flash-lite');

        expect(estimate?.outputTokens).toBe(500);
        expect(estimate?.totalCostUsd).toBe(0.001);
    });

    it('applies current non-global Vertex AI rates', () => {
        const estimate = estimateGeminiRequestCost({
            promptTokens: 1_000_000,
            completionTokens: 1_000_000,
            totalTokens: 2_000_000,
        }, 'gemini-3.1-flash-lite', 'asia-northeast3');

        expect(estimate?.inputCostUsd).toBe(0.275);
        expect(estimate?.outputCostUsd).toBe(1.65);
        expect(estimate?.totalCostUsd).toBe(1.925);
    });

    it('prices the previous configured model independently', () => {
        const estimate = estimateGeminiRequestCost({
            promptTokens: 1_000_000,
            completionTokens: 1_000_000,
            totalTokens: 2_000_000,
        }, 'gemini-3-flash-preview');

        expect(estimate?.totalCostUsd).toBe(3.5);
    });

    it('supports Vertex resource names and returns null for unknown pricing', () => {
        const known = estimateGeminiRequestCost({
            promptTokens: 1_000,
            completionTokens: 100,
            totalTokens: 1_100,
        }, 'projects/p/locations/global/publishers/google/models/gemini-3.1-flash-lite-001');

        expect(known?.canonicalModelName).toBe('gemini-3.1-flash-lite');
        expect(estimateGeminiRequestCost({
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
        }, 'unpriced-model')).toBeNull();
    });
});
