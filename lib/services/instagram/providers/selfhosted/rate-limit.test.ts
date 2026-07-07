import { describe, it, expect, vi } from 'vitest';
import { pLimit, withRetry } from './rate-limit';

describe('pLimit', () => {
    it('동시 실행 수를 제한한다', async () => {
        const limit = pLimit(2);
        let active = 0;
        let maxActive = 0;
        const task = () =>
            limit(async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await new Promise((r) => setTimeout(r, 10));
                active--;
            });
        await Promise.all(Array.from({ length: 6 }, task));
        expect(maxActive).toBeLessThanOrEqual(2);
    });
});

describe('withRetry', () => {
    it('실패 후 재시도하여 성공하면 값을 반환한다', async () => {
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce('ok');
        const result = await withRetry(fn, { retries: 2, baseDelayMs: 1 });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('재시도 소진 시 마지막 에러를 throw한다', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('always'));
        await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow('always');
        expect(fn).toHaveBeenCalledTimes(3);
    });
});
