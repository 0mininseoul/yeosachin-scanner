import { describe, expect, it, vi } from 'vitest';
import {
    PREFLIGHT_RETENTION_BATCH_LIMIT,
    runPreflightRetention,
} from './preflight-retention';

describe('preflight retention maintenance', () => {
    it('runs both bounded service-role RPCs in order', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: 12, error: null })
            .mockResolvedValueOnce({ data: 4, error: null });
        await expect(runPreflightRetention({ rpc })).resolves.toEqual({
            expiredPurged: 12,
            terminalScrubbed: 4,
        });
        expect(rpc.mock.calls).toEqual([
            ['purge_expired_analysis_v2_preflights', {
                p_limit: PREFLIGHT_RETENTION_BATCH_LIMIT,
            }],
            ['scrub_terminal_analysis_v2_preflights', {
                p_limit: PREFLIGHT_RETENTION_BATCH_LIMIT,
            }],
        ]);
    });

    it('fails closed on an RPC error or an impossible count', async () => {
        await expect(runPreflightRetention({
            rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'no' } }),
        })).rejects.toThrow('PREFLIGHT_RETENTION_ERROR');

        await expect(runPreflightRetention({
            rpc: vi.fn().mockResolvedValue({ data: 9999, error: null }),
        })).rejects.toThrow('invalid purge_expired_analysis_v2_preflights result');
    });
});
