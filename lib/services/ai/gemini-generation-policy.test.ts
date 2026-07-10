import { describe, expect, it } from 'vitest';
import {
    classifyGeminiGenerationError,
    isAmbiguousGeminiGenerationError,
} from './gemini-generation-policy';

describe('classifyGeminiGenerationError', () => {
    it('only marks an explicit rate-limit rejection as retryable', () => {
        expect(classifyGeminiGenerationError({ status: 429, message: 'RESOURCE_EXHAUSTED' }))
            .toBe('rate_limited');
        expect(classifyGeminiGenerationError(new Error('rate limit exceeded')))
            .toBe('rate_limited');
    });

    it('treats server and transport failures as ambiguous', () => {
        expect(classifyGeminiGenerationError({ status: 503, message: 'unavailable' }))
            .toBe('ambiguous');
        expect(classifyGeminiGenerationError(new Error('fetch failed: ECONNRESET')))
            .toBe('ambiguous');
        expect(classifyGeminiGenerationError(new Error('request timeout')))
            .toBe('ambiguous');
    });

    it('distinguishes definite client rejection from unknown failures', () => {
        expect(classifyGeminiGenerationError({ statusCode: 400, message: 'bad request' }))
            .toBe('rejected');
        expect(classifyGeminiGenerationError(new Error('unexpected SDK state')))
            .toBe('ambiguous');
        expect(isAmbiguousGeminiGenerationError(
            new Error('AI_AMBIGUOUS_GENERATION_ERROR: sanitized')
        )).toBe(true);
    });
});
