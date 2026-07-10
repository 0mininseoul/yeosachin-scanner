import { describe, expect, it, vi } from 'vitest';
import {
    AnalysisAlreadyInProgressError,
    AnalysisIdempotencyConflictError,
    AnalysisLimitExceededError,
    consumeQuotaAndCreateAnalysisRequest,
    type AnalysisStartRpcClient,
} from './start-request';

const input = {
    userId: '00000000-0000-4000-8000-000000000001',
    email: 'user@example.com',
    authProvider: 'google' as const,
    targetInstagramId: 'target.user',
    targetGender: 'male' as const,
    scraperOptions: {},
    idempotencyKey: '00000000-0000-4000-8000-000000000002',
    freeAnalysisLimit: 1,
};

function clientWith(data: unknown, error: { code?: string; message?: string } | null = null) {
    const rpc = vi.fn().mockResolvedValue({ data, error });
    return { client: { rpc } as AnalysisStartRpcClient, rpc };
}

describe('transactional analysis request creation', () => {
    it('returns one newly created request and forwards the idempotency key', async () => {
        const { client, rpc } = clientWith([{
            request_id: '00000000-0000-4000-8000-000000000003',
            created: true,
        }]);

        await expect(consumeQuotaAndCreateAnalysisRequest(client, input)).resolves.toEqual({
            requestId: '00000000-0000-4000-8000-000000000003',
            created: true,
        });
        expect(rpc).toHaveBeenCalledWith(
            'consume_analysis_quota_and_create_request',
            expect.objectContaining({
                p_user_id: input.userId,
                p_idempotency_key: input.idempotencyKey,
                p_free_analysis_limit: 1,
            })
        );
    });

    it('returns the existing request for an idempotent replay', async () => {
        const { client } = clientWith([{
            request_id: '00000000-0000-4000-8000-000000000003',
            created: false,
        }]);
        await expect(consumeQuotaAndCreateAnalysisRequest(client, input)).resolves.toMatchObject({
            created: false,
        });
    });

    it('maps the transactional quota error and fails closed on missing RPC', async () => {
        const limited = clientWith(null, {
            code: 'P0001',
            message: 'ANALYSIS_LIMIT_EXCEEDED',
        });
        await expect(consumeQuotaAndCreateAnalysisRequest(limited.client, input))
            .rejects.toBeInstanceOf(AnalysisLimitExceededError);

        const missing = clientWith(null, { code: 'PGRST202', message: 'function missing' });
        await expect(consumeQuotaAndCreateAnalysisRequest(missing.client, input))
            .rejects.toThrow('PGRST202');
    });

    it('maps a same-key, different-payload replay to an idempotency conflict', async () => {
        const conflict = clientWith(null, {
            code: 'P0001',
            message: 'ANALYSIS_IDEMPOTENCY_CONFLICT',
        });

        await expect(consumeQuotaAndCreateAnalysisRequest(conflict.client, input))
            .rejects.toBeInstanceOf(AnalysisIdempotencyConflictError);
    });

    it('maps the database active-request guard to a typed conflict', async () => {
        const active = clientWith(null, {
            code: 'P0001',
            message: 'ANALYSIS_ALREADY_IN_PROGRESS',
        });

        await expect(consumeQuotaAndCreateAnalysisRequest(active.client, input))
            .rejects.toBeInstanceOf(AnalysisAlreadyInProgressError);
    });
});
