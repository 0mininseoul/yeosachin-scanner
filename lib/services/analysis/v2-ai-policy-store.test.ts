import { describe, expect, it, vi } from 'vitest';
import { AI_STAGE_POLICY_VERSION } from '@/lib/services/ai/stage-policy';
import { createSupabaseAnalysisV2AiPolicyStore } from './v2-ai-policy-store';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

const requestId = '123e4567-e89b-42d3-a456-426614174000';

describe('analysis V2 AI policy store', () => {
    it('loads only the request AI-stage policy version through the bounded RPC', async () => {
        const rpc = vi.fn(async () => ({ data: AI_STAGE_POLICY_VERSION, error: null }));
        const store = createSupabaseAnalysisV2AiPolicyStore({ rpc });

        await expect(store.loadAiStagePolicyVersion(requestId))
            .resolves.toBe(AI_STAGE_POLICY_VERSION);
        expect(rpc).toHaveBeenCalledWith('load_analysis_v2_ai_stage_policy_version', {
            p_request_id: requestId,
        });
    });

    it('rejects invalid input and malformed policy values without leaking database details', async () => {
        const rpc = vi.fn(async () => ({ data: 'invalid policy value', error: null }));
        const store = createSupabaseAnalysisV2AiPolicyStore({ rpc });

        await expect(store.loadAiStagePolicyVersion('not-a-uuid'))
            .rejects.toThrow('ANALYSIS_V2_AI_STAGE_POLICY_VALIDATION_ERROR');
        expect(rpc).not.toHaveBeenCalled();
        await expect(store.loadAiStagePolicyVersion(requestId))
            .rejects.toThrow('ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR');
    });

    it('maps an absent V2 request to null and sanitizes RPC failures', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({
                data: null,
                error: { code: 'XX999', message: 'secret database detail' },
            })
            .mockRejectedValueOnce(new Error('secret transport detail'));
        const store = createSupabaseAnalysisV2AiPolicyStore({ rpc });

        await expect(store.loadAiStagePolicyVersion(requestId)).resolves.toBeNull();
        const failure = store.loadAiStagePolicyVersion(requestId);
        await expect(failure).rejects.toThrow(
            'ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR: policy load failed (XX999).'
        );
        await expect(failure).rejects.not.toThrow(
            'secret database detail'
        );

        const transportFailure = store.loadAiStagePolicyVersion(requestId);
        await expect(transportFailure).rejects.toThrow(
            'ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR: policy load failed (transport).'
        );
        await expect(transportFailure).rejects.not.toThrow('secret transport detail');
    });
});
