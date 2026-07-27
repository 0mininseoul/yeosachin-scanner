import { describe, expect, it, vi } from 'vitest';
import { loadReplayCaptureDescriptor, type ReplaySourceRpcClient } from './replay-supabase-repository';

const requestId = '10000000-0000-4000-8000-000000000001';
const preflightId = '20000000-0000-4000-8000-000000000001';

function source() {
    return {
        requestId,
        preflightId,
        targetUsername: 'target',
        selectedPlanId: 'standard',
        policyVersions: {
            pipeline: 'v2',
            risk: 'risk-policy-v2.4',
            aiStage: 'ai-stage-policy-v2.7',
        },
        target: {
            fullName: 'Target',
            bio: 'bio',
            profileImageUrl: 'https://example.com/profile.jpg',
            followersCount: 10,
            followingCount: 20,
        },
        preflightRuns: [],
        providerRuns: [],
    };
}

describe('replay capture read-only repository', () => {
    it('uses only the narrow service RPC and returns a one-way request fingerprint', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: source(), error: null });
        const descriptor = await loadReplayCaptureDescriptor(
            { rpc } satisfies ReplaySourceRpcClient,
            { targetUsername: '@TARGET', requestId },
        );

        expect(rpc).toHaveBeenCalledOnce();
        expect(rpc).toHaveBeenCalledWith('read_analysis_v2_replay_capture_source', {
            p_target_username: 'target',
            p_request_id: requestId,
        });
        expect(descriptor.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(descriptor.requestFingerprint).not.toContain(requestId);
        expect(descriptor.sourceLineage).toEqual({
            selectedPlanId: 'standard',
            policyVersions: source().policyVersions,
        });
        expect(descriptor).not.toHaveProperty('selectedPlanId');
        expect(descriptor).not.toHaveProperty('policyVersions');
    });

    it('preserves an observed historical Plus source without relabeling it Standard', async () => {
        const historicalPlus = {
            ...source(),
            selectedPlanId: 'plus',
            policyVersions: {
                pipeline: 'v2',
                risk: 'risk-policy-v2.2',
                aiStage: 'ai-stage-policy-v2.4',
            },
        };
        const descriptor = await loadReplayCaptureDescriptor(
            {
                rpc: vi.fn().mockResolvedValue({ data: historicalPlus, error: null }),
            } satisfies ReplaySourceRpcClient,
            { targetUsername: 'target', requestId },
        );

        expect(descriptor.sourceLineage).toEqual({
            selectedPlanId: 'plus',
            policyVersions: historicalPlus.policyVersions,
        });
    });

    it('rejects an unlisted plan-policy cross-product', async () => {
        const invalidCrossProduct = {
            ...source(),
            selectedPlanId: 'plus',
        };

        await expect(loadReplayCaptureDescriptor(
            {
                rpc: vi.fn().mockResolvedValue({
                    data: invalidCrossProduct,
                    error: null,
                }),
            } satisfies ReplaySourceRpcClient,
            { targetUsername: 'target', requestId },
        )).rejects.toThrow('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    });

    it('fails with a stable error and does not expose RPC/provider details', async () => {
        const providerMessage = 'database unavailable key=do-not-print';
        const rpc = vi.fn().mockResolvedValue({
            data: null,
            error: { code: 'XX000', message: providerMessage },
        });

        await expect(loadReplayCaptureDescriptor(
            { rpc } satisfies ReplaySourceRpcClient,
            { targetUsername: 'target' },
        )).rejects.toThrow('ANALYSIS_V2_REPLAY_EXACT_SOURCE_UNAVAILABLE');
        await expect(loadReplayCaptureDescriptor(
            { rpc } satisfies ReplaySourceRpcClient,
            { targetUsername: 'target' },
        )).rejects.not.toThrow(providerMessage);
    });
});
