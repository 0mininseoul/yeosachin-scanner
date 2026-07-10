import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_STALE_AFTER_MS,
    failAnalysisRequest,
    isAnalysisRequestStale,
    normalizeAnalysisFailureMessage,
    type FailureRpcClient,
} from './failure';

describe('analysis failure transaction', () => {
    it('forwards bounded compact state to the atomic failure RPC', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null });

        await expect(failAnalysisRequest({ rpc } as FailureRpcClient, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'interactions',
            errorMessage: '  provider failed  ',
            compactStepData: { targetProfileImage: 'https://example.com/profile.jpg' },
        })).resolves.toBe(true);

        expect(rpc).toHaveBeenCalledWith(
            'fail_analysis_request_and_purge_staging',
            {
                p_request_id: 'request-id',
                p_user_id: 'user-id',
                p_expected_step: 'interactions',
                p_error_message: 'provider failed',
                p_step_data: { targetProfileImage: 'https://example.com/profile.jpg' },
            }
        );
    });

    it('returns a compare-and-set miss without converting it to an error', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: false, error: null });

        await expect(failAnalysisRequest({ rpc } as FailureRpcClient, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'profiles',
            errorMessage: 'failed',
        })).resolves.toBe(false);
    });

    it('fails closed on RPC errors and malformed results', async () => {
        await expect(failAnalysisRequest({
            rpc: vi.fn().mockResolvedValue({ data: null, error: { code: '42501' } }),
        }, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'collect',
            errorMessage: 'failed',
        })).rejects.toThrow('(42501)');

        await expect(failAnalysisRequest({
            rpc: vi.fn().mockResolvedValue({ data: 'true', error: null }),
        }, {
            requestId: 'request-id',
            userId: 'user-id',
            expectedStep: 'collect',
            errorMessage: 'failed',
        })).rejects.toThrow('invalid result');
    });
});

describe('analysis failure normalization and stale detection', () => {
    it('uses a non-empty fallback and limits persisted messages', () => {
        expect(normalizeAnalysisFailureMessage('   ')).toBe('Analysis failed.');
        expect(normalizeAnalysisFailureMessage('bad\0message')).toBe('badmessage');
        expect(normalizeAnalysisFailureMessage('x'.repeat(1001))).toHaveLength(1000);
    });

    it('expires valid timestamps at the two-hour boundary', () => {
        const now = Date.parse('2026-07-11T12:00:00.000Z');
        expect(isAnalysisRequestStale(
            new Date(now - ANALYSIS_STALE_AFTER_MS).toISOString(),
            now
        )).toBe(true);
        expect(isAnalysisRequestStale(
            new Date(now - ANALYSIS_STALE_AFTER_MS + 1).toISOString(),
            now
        )).toBe(false);
        expect(isAnalysisRequestStale('not-a-date', now)).toBe(false);
        expect(isAnalysisRequestStale(null, now)).toBe(false);
    });
});
