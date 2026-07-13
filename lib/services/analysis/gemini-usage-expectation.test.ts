import { describe, expect, it, vi } from 'vitest';
import {
    recordGeminiUsageExpectation,
    type GeminiUsageExpectationClient,
} from './gemini-usage-expectation';

const baseInput = {
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    userId: '123e4567-e89b-42d3-a456-426614174001',
    expectedStep: 'analyze' as const,
    operationKey: 'combined:0:0',
    generationKind: 'combined' as const,
    expectedRecordCount: 5,
};

function rpcClient(result: { data: unknown; error: { code?: string } | null }) {
    const rpc = vi.fn().mockResolvedValue(result);
    return { client: { rpc } as GeminiUsageExpectationClient, rpc };
}

describe('Gemini usage expectations', () => {
    it('records a PII-free expected token-log count before generation', async () => {
        const { client, rpc } = rpcClient({ data: true, error: null });
        await recordGeminiUsageExpectation(client, baseInput);
        expect(rpc).toHaveBeenCalledWith('record_analysis_gemini_usage_expectation', {
            p_request_id: baseInput.requestId,
            p_user_id: baseInput.userId,
            p_expected_step: 'analyze',
            p_operation_key: 'combined:0:0',
            p_generation_kind: 'combined',
            p_expected_record_count: 5,
        });
    });

    it('rejects an operation attached to the wrong pipeline step', async () => {
        const { client, rpc } = rpcClient({ data: true, error: null });
        await expect(recordGeminiUsageExpectation(client, {
            ...baseInput,
            expectedStep: 'collect',
        })).rejects.toThrow('invalid Gemini usage expectation');
        expect(rpc).not.toHaveBeenCalled();
    });

    it.each(['combined:0:0:username', '../secret', 'deep-risk:1'])(
        'rejects unsafe operation key %s',
        async operationKey => {
            const { client, rpc } = rpcClient({ data: true, error: null });
            await expect(recordGeminiUsageExpectation(client, {
                ...baseInput,
                operationKey,
            })).rejects.toThrow('invalid Gemini usage expectation');
            expect(rpc).not.toHaveBeenCalled();
        }
    );

    it('fails closed before model execution when persistence fails', async () => {
        const { client } = rpcClient({ data: null, error: { code: '08006' } });
        await expect(recordGeminiUsageExpectation(client, baseInput))
            .rejects.toThrow('Gemini usage expectation failed (08006)');
    });

    it('does not expose unsafe database error codes', async () => {
        const { client } = rpcClient({ data: null, error: { code: 'bad private code' } });
        await expect(recordGeminiUsageExpectation(client, baseInput))
            .rejects.toThrow('Gemini usage expectation failed (unknown)');
    });

    it('fails closed when the request state does not match', async () => {
        const { client } = rpcClient({ data: false, error: null });
        await expect(recordGeminiUsageExpectation(client, baseInput))
            .rejects.toThrow('request state did not match');
    });
});
