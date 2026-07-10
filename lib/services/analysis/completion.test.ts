import { describe, expect, it, vi } from 'vitest';
import {
    completeAnalysisRequest,
    type CompletionRpcClient,
} from './completion';

describe('analysis completion transaction', () => {
    it('passes only compact state to the atomic completion RPC', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
        await completeAnalysisRequest({ rpc } as CompletionRpcClient, {
            requestId: 'request-id',
            userId: 'user-id',
            compactStepData: {
                mutualFollows: ['newest'],
                targetProfileImage: 'https://example.com/profile.jpg',
            },
        });

        expect(rpc).toHaveBeenCalledWith(
            'complete_analysis_request_and_purge_staging',
            {
                p_request_id: 'request-id',
                p_user_id: 'user-id',
                p_step_data: {
                    mutualFollows: ['newest'],
                    targetProfileImage: 'https://example.com/profile.jpg',
                },
            }
        );
    });

    it('fails closed on RPC errors and zero-row completion', async () => {
        await expect(completeAnalysisRequest({
            rpc: vi.fn().mockResolvedValue({ data: null, error: { code: '42501' } }),
        }, {
            requestId: 'request-id',
            userId: 'user-id',
            compactStepData: {},
        })).rejects.toThrow('(42501)');

        await expect(completeAnalysisRequest({
            rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
        }, {
            requestId: 'request-id',
            userId: 'user-id',
            compactStepData: {},
        })).rejects.toThrow('did not update');
    });

    it.each([
        { followers: ['unexpected'] },
        { mutualFollows: Array.from({ length: 11 }, (_, index) => `user${index}`) },
        { mutualFollows: ['Uppercase'] },
        { mutualFollows: [42] },
        { targetProfileImage: 42 },
        { targetProfileImage: 'x'.repeat(8_193) },
    ])('rejects noncompact terminal state before making an RPC', async compactStepData => {
        const rpc = vi.fn();
        await expect(completeAnalysisRequest({ rpc } as CompletionRpcClient, {
            requestId: 'request-id',
            userId: 'user-id',
            compactStepData,
        })).rejects.toThrow('invalid compact completion state');
        expect(rpc).not.toHaveBeenCalled();
    });
});
