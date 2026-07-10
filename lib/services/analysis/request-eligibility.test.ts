import { describe, expect, it } from 'vitest';
import { hasValidAnalysisRequestIdempotencyKey } from './request-eligibility';

describe('analysis request paid-step eligibility', () => {
    it('accepts only requests carrying the server start contract key', () => {
        expect(hasValidAnalysisRequestIdempotencyKey({
            idempotency_key: 'analysis-key-0000000000000000',
        })).toBe(true);
        expect(hasValidAnalysisRequestIdempotencyKey({ idempotency_key: null })).toBe(false);
        expect(hasValidAnalysisRequestIdempotencyKey({})).toBe(false);
        expect(hasValidAnalysisRequestIdempotencyKey({ idempotency_key: 'short' })).toBe(false);
    });
});
