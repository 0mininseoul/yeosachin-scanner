import { describe, expect, it } from 'vitest';
import {
    DEFAULT_VERTEX_AI_ANALYSIS_CONCURRENCY,
    MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS,
    MAX_VERTEX_AI_CONCURRENT_IMAGE_DECODES,
    MAX_VERTEX_AI_ANALYSIS_CONCURRENCY,
    MAX_VERTEX_AI_IMAGE_PREPARATION_CONCURRENCY,
    getVertexAIAnalysisConcurrency,
    isAnalysisBatchFailureAboveThreshold,
} from './pipeline-config';

describe('getVertexAIAnalysisConcurrency', () => {
    it('uses the quality-safe default for missing or invalid values', () => {
        expect(getVertexAIAnalysisConcurrency(undefined)).toBe(DEFAULT_VERTEX_AI_ANALYSIS_CONCURRENCY);
        expect(getVertexAIAnalysisConcurrency('not-a-number')).toBe(DEFAULT_VERTEX_AI_ANALYSIS_CONCURRENCY);
    });

    it('accepts an explicit bounded concurrency', () => {
        expect(getVertexAIAnalysisConcurrency('8')).toBe(8);
        expect(getVertexAIAnalysisConcurrency('8.9')).toBe(8);
    });

    it('clamps concurrency to the supported range', () => {
        expect(getVertexAIAnalysisConcurrency('0')).toBe(1);
        expect(getVertexAIAnalysisConcurrency('100')).toBe(MAX_VERTEX_AI_ANALYSIS_CONCURRENCY);
        expect(MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS).toBe(8);
        expect(MAX_VERTEX_AI_CONCURRENT_IMAGE_DECODES).toBe(2);
        expect(MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS).toBeLessThan(
            MAX_VERTEX_AI_ANALYSIS_CONCURRENCY * MAX_VERTEX_AI_IMAGE_PREPARATION_CONCURRENCY
        );
    });
});

describe('AI batch failure threshold', () => {
    it('fails closed when at least half of a paid analysis batch cannot be classified', () => {
        expect(isAnalysisBatchFailureAboveThreshold(1, 1)).toBe(true);
        expect(isAnalysisBatchFailureAboveThreshold(10, 5)).toBe(true);
        expect(isAnalysisBatchFailureAboveThreshold(10, 4)).toBe(false);
    });

    it('rejects invalid counters', () => {
        expect(() => isAnalysisBatchFailureAboveThreshold(0, 0)).toThrow('CONFIG');
        expect(() => isAnalysisBatchFailureAboveThreshold(3, 4)).toThrow('CONFIG');
    });
});
