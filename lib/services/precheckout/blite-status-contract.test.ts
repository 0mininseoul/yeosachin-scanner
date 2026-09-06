import { describe, expect, it } from 'vitest';
import { bliteBrowserStatusV1Schema } from './blite-status-contract';

describe('B-lite browser status contract', () => {
    it('accepts only bounded parent-pending and terminal browser states', () => {
        expect(bliteBrowserStatusV1Schema.parse({
            state: 'parent_pending',
            parentState: 'processing',
            retryAfterMs: 1_000,
        })).toEqual({
            state: 'parent_pending',
            parentState: 'processing',
            retryAfterMs: 1_000,
        });
        expect(bliteBrowserStatusV1Schema.parse({ state: 'unavailable' }))
            .toEqual({ state: 'unavailable' });
        expect(bliteBrowserStatusV1Schema.parse({ state: 'terminal' }))
            .toEqual({ state: 'terminal' });
        expect(bliteBrowserStatusV1Schema.parse({ state: 'expired' }))
            .toEqual({ state: 'expired' });
        expect(() => bliteBrowserStatusV1Schema.parse({
            state: 'parent_pending',
            parentState: 'pending',
            retryAfterMs: 60_000,
        })).toThrow();
        expect(() => bliteBrowserStatusV1Schema.parse({ state: 'unknown' })).toThrow();
    });
});
