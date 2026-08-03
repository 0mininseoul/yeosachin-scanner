import { describe, expect, it, vi } from 'vitest';
import {
    loadCurrentProductionReplayCaptureDescriptor,
    loadBetatestFreePoolReplayCaptureDescriptor,
    type BetatestFreePoolReplaySourceRpcClient,
    loadReplayCaptureDescriptor,
    type CurrentProductionReplaySourceRpcClient,
    type ReplaySourceRpcClient,
} from './replay-supabase-repository';

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
    it('loads exact beta-free-pool source only through its UUID RPC', async () => {
        const run = {
            actorId: 'apify/instagram-profile-scraper', credentialSlot: 'tertiary',
            runId: 'BetaRun1', status: 'succeeded', operationKey: 'target-profile-fallback',
        } as const;
        const rpc = vi.fn().mockResolvedValue({
            data: {
                requestId, preflightId, targetUsername: `replay_${'b'.repeat(23)}`,
                selectedPlanId: 'standard',
                policyVersions: { pipeline: 'v2', risk: 'risk-policy-v2.5', aiStage: 'ai-stage-policy-v2.10', scheduler: 'ai-scheduler-v1' },
                preflightRuns: [run], providerRuns: [{ ...run, runId: 'BetaRun2', operationKey: `profile-fallback:${'a'.repeat(64)}` }],
            }, error: null,
        });
        const descriptor = await loadBetatestFreePoolReplayCaptureDescriptor(
            { rpc } satisfies BetatestFreePoolReplaySourceRpcClient, requestId,
        );
        expect(rpc).toHaveBeenCalledWith('read_analysis_v2_betatest_free_pool_replay_source', { p_request_id: requestId });
        expect(descriptor).toMatchObject({ sourceKind: 'betatest_free_pool', targetResolution: 'provider_ledger' });
        expect(descriptor).not.toHaveProperty('target');
    });

    it('rejects beta sources that try the explicitly forbidden secondary slot', async () => {
        await expect(loadBetatestFreePoolReplayCaptureDescriptor({
            rpc: vi.fn().mockResolvedValue({
                data: {
                    requestId, preflightId, targetUsername: `replay_${'b'.repeat(23)}`,
                    selectedPlanId: 'standard',
                    policyVersions: { pipeline: 'v2', risk: 'risk-policy-v2.5', aiStage: 'ai-stage-policy-v2.10', scheduler: 'ai-scheduler-v1' },
                    preflightRuns: [{
                        actorId: 'apify/instagram-profile-scraper', credentialSlot: 'secondary',
                        runId: 'BetaRun1', status: 'succeeded', operationKey: 'target-profile-fallback',
                    }], providerRuns: [{
                        actorId: 'apify/instagram-profile-scraper', credentialSlot: 'secondary',
                        runId: 'BetaRun2', status: 'succeeded', operationKey: `profile-fallback:${'a'.repeat(64)}`,
                    }],
                }, error: null,
            }),
        } satisfies BetatestFreePoolReplaySourceRpcClient, requestId)).rejects.toThrow('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    });

    it('loads current production from the UUID RPC without a target object', async () => {
        const run = {
            actorId: 'apify/instagram-profile-scraper',
            credentialSlot: 'primary',
            runId: 'CurrentRun1',
            status: 'succeeded',
            operationKey: 'target-profile-fallback',
        } as const;
        const rpc = vi.fn().mockResolvedValue({
            data: {
                requestId,
                preflightId,
                targetUsername: `replay_${'a'.repeat(23)}`,
                selectedPlanId: 'standard',
                policyVersions: {
                    pipeline: 'v2',
                    risk: 'risk-policy-v2.5',
                    aiStage: 'ai-stage-policy-v2.10',
                    scheduler: 'ai-scheduler-v1',
                },
                preflightRuns: [run],
                providerRuns: [{
                    ...run,
                    runId: 'CurrentRun2',
                    operationKey: `profile-fallback:${'a'.repeat(64)}`,
                }],
            },
            error: null,
        });
        const descriptor = await loadCurrentProductionReplayCaptureDescriptor(
            { rpc } satisfies CurrentProductionReplaySourceRpcClient,
            requestId,
        );

        expect(rpc).toHaveBeenCalledWith(
            'read_analysis_v2_current_production_replay_source',
            { p_request_id: requestId },
        );
        expect(descriptor).toMatchObject({
            requestId,
            targetResolution: 'provider_ledger',
            sourceKind: 'current_paid_production',
            sourceLineage: {
                selectedPlanId: 'standard',
                policyVersions: {
                    risk: 'risk-policy-v2.5',
                    aiStage: 'ai-stage-policy-v2.10',
                },
            },
        });
        expect(descriptor).not.toHaveProperty('target');
    });

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
