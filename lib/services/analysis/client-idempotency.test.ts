import { describe, expect, it, vi } from 'vitest';
import { getAnalysisStartIdempotency } from './client-idempotency';

describe('analysis start client idempotency', () => {
    it('reuses a key for retries of the same normalized request', () => {
        const createKey = vi.fn(() => 'first-key');
        const first = getAnalysisStartIdempotency(null, '@Target.User', 'male', createKey);
        const retry = getAnalysisStartIdempotency(first, 'target.user', 'male', createKey);

        expect(retry).toBe(first);
        expect(createKey).toHaveBeenCalledTimes(1);
    });

    it('rotates the key when the target or gender changes', () => {
        const keys = ['first-key', 'second-key', 'third-key'];
        const createKey = vi.fn(() => keys.shift() as string);
        const first = getAnalysisStartIdempotency(null, 'target', 'male', createKey);
        const second = getAnalysisStartIdempotency(first, 'other', 'male', createKey);
        const third = getAnalysisStartIdempotency(second, 'other', 'female', createKey);

        expect([first.key, second.key, third.key]).toEqual([
            'first-key',
            'second-key',
            'third-key',
        ]);
    });
});
