import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    isAnalysisResultOperator,
    resolveAnalysisResultOwner,
} from '@/lib/services/analysis/result-operator-access';

const operatorId = '123e4567-e89b-42d3-a456-426614174000';
const ownerId = '223e4567-e89b-42d3-a456-426614174000';
const requestId = '323e4567-e89b-42d3-a456-426614174000';

describe('analysis result operator access', () => {
    it('recognizes only the exact authenticated administrator email', () => {
        expect(isAnalysisResultOperator({ id: operatorId, email: ' YM1113@KAKAO.COM ' })).toBe(true);
        expect(isAnalysisResultOperator({ id: operatorId, email: 'ym1113+other@kakao.com' })).toBe(false);
        expect(isAnalysisResultOperator({ id: operatorId })).toBe(false);
        expect(isAnalysisResultOperator({ id: 'not-a-uuid', email: 'ym1113@kakao.com' })).toBe(false);
    });

    it('resolves only a completed V2 request owner through the service boundary', async () => {
        const maybeSingle = vi.fn().mockResolvedValue({ data: { user_id: ownerId }, error: null });
        const eqStatus = vi.fn().mockReturnValue({ maybeSingle });
        const eqPipeline = vi.fn().mockReturnValue({ eq: eqStatus });
        const eqId = vi.fn().mockReturnValue({ eq: eqPipeline });
        const select = vi.fn().mockReturnValue({ eq: eqId });
        const from = vi.fn().mockReturnValue({ select });

        await expect(resolveAnalysisResultOwner(requestId, { from } as never)).resolves.toBe(ownerId);
        expect(from).toHaveBeenCalledWith('analysis_requests');
        expect(select).toHaveBeenCalledWith('user_id');
        expect(eqId).toHaveBeenCalledWith('id', requestId);
        expect(eqPipeline).toHaveBeenCalledWith('pipeline_version', 'v2');
        expect(eqStatus).toHaveBeenCalledWith('status', 'completed');
    });

    it('resolves a completed V1 owner only when the caller selects the V1 pipeline', async () => {
        const maybeSingle = vi.fn().mockResolvedValue({ data: { user_id: ownerId }, error: null });
        const eqStatus = vi.fn().mockReturnValue({ maybeSingle });
        const eqPipeline = vi.fn().mockReturnValue({ eq: eqStatus });
        const eqId = vi.fn().mockReturnValue({ eq: eqPipeline });
        const select = vi.fn().mockReturnValue({ eq: eqId });
        const from = vi.fn().mockReturnValue({ select });

        await expect(resolveAnalysisResultOwner(requestId, 'v1', { from } as never)).resolves.toBe(ownerId);
        expect(eqPipeline).toHaveBeenCalledWith('pipeline_version', 'v1');
    });

    it('fails closed for missing or malformed owner rows', async () => {
        const client = (data: unknown, error: unknown = null) => ({
            from: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            eq: vi.fn().mockReturnValue({
                                maybeSingle: vi.fn().mockResolvedValue({ data, error }),
                            }),
                        }),
                    }),
                }),
            }),
        });

        await expect(resolveAnalysisResultOwner(requestId, client(null) as never)).resolves.toBeNull();
        await expect(resolveAnalysisResultOwner(requestId, client({ user_id: 'invalid' }) as never)).resolves.toBeNull();
        await expect(resolveAnalysisResultOwner(requestId, client(null, { message: 'db failed' }) as never))
            .rejects.toThrow('ANALYSIS_RESULT_OPERATOR_LOOKUP_FAILED');
    });
});
