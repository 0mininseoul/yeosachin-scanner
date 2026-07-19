import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import { supabaseAdmin } from '@/lib/supabase/admin';

import { fetchEarlybirdRemainingSlots } from './inventory';

describe('fetchEarlybirdRemainingSlots', () => {
    afterEach(() => {
        delete (supabaseAdmin as { from?: unknown }).from;
    });

    it('computes remaining slots from sale_limit minus sold_count', async () => {
        (supabaseAdmin as unknown as { from: ReturnType<typeof vi.fn> }).from = vi.fn(() => ({
            select: vi.fn(() => ({
                in: vi.fn(() => ({
                    abortSignal: vi.fn(async () => ({
                        data: [
                            { plan_id: 'basic', sale_limit: 10, sold_count: 7 },
                            { plan_id: 'standard', sale_limit: 10, sold_count: 10 },
                        ],
                        error: null,
                    })),
                })),
            })),
        }));

        await expect(fetchEarlybirdRemainingSlots()).resolves.toEqual({
            basic: 3,
            standard: 0,
        });
    });

    it('returns an empty map when the query reports an error', async () => {
        (supabaseAdmin as unknown as { from: ReturnType<typeof vi.fn> }).from = vi.fn(() => ({
            select: vi.fn(() => ({
                in: vi.fn(() => ({
                    abortSignal: vi.fn(async () => ({ data: null, error: { message: 'boom' } })),
                })),
            })),
        }));

        await expect(fetchEarlybirdRemainingSlots()).resolves.toEqual({});
    });

    it('fails open to an empty map when the query throws', async () => {
        (supabaseAdmin as unknown as { from: ReturnType<typeof vi.fn> }).from = vi.fn(() => {
            throw new Error('network down');
        });

        await expect(fetchEarlybirdRemainingSlots()).resolves.toEqual({});
    });

    it('ignores rows with unsafe counts while keeping the rest', async () => {
        (supabaseAdmin as unknown as { from: ReturnType<typeof vi.fn> }).from = vi.fn(() => ({
            select: vi.fn(() => ({
                in: vi.fn(() => ({
                    abortSignal: vi.fn(async () => ({
                        data: [
                            { plan_id: 'basic', sale_limit: 10, sold_count: 12 },
                            { plan_id: 'standard', sale_limit: 10, sold_count: Number.NaN },
                        ],
                        error: null,
                    })),
                })),
            })),
        }));

        await expect(fetchEarlybirdRemainingSlots()).resolves.toEqual({ basic: 0 });
    });

    it('defaults to an empty map when supabaseAdmin has no from method (existing test mock shape)', async () => {
        await expect(fetchEarlybirdRemainingSlots()).resolves.toEqual({});
    });

    it('fails open to an empty map when the abort signal fires (query timeout)', async () => {
        // Node's AbortSignal.timeout runs on internal timers that vi's fake
        // timers cannot advance, so we stub AbortSignal.timeout itself to
        // return a signal we control, and prove the query builder actually
        // wires it in via .abortSignal() (mirroring how postgrest-js passes
        // the signal to fetch, which rejects the request when aborted).
        const controller = new AbortController();
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
        const abortSignalMock = vi.fn((signal: AbortSignal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }));
        try {
            (supabaseAdmin as unknown as { from: ReturnType<typeof vi.fn> }).from = vi.fn(() => ({
                select: vi.fn(() => ({
                    in: vi.fn(() => ({ abortSignal: abortSignalMock })),
                })),
            }));

            const resultPromise = fetchEarlybirdRemainingSlots();
            controller.abort();
            await expect(resultPromise).resolves.toEqual({});
            expect(timeoutSpy).toHaveBeenCalledWith(1_500);
            expect(abortSignalMock).toHaveBeenCalledWith(controller.signal);
        } finally {
            timeoutSpy.mockRestore();
        }
    });
});
