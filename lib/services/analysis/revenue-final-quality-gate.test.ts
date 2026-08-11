import { describe, expect, it, vi } from 'vitest';
import {
    AnalysisV2RevenueFinalQualityGateError,
    createAnalysisV2RevenueFinalQualityGate,
} from './revenue-final-quality-gate';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const claim = {
    requestId,
    jobKey: 'coordinator:finalize' as const,
    claimToken: '223e4567-e89b-42d3-a456-426614174000',
    jobInputHash: 'a'.repeat(64),
};

const strictContext = {
    requestId,
    targetUsername: 'target.account',
    excludedUsername: null,
    accessMode: 'test_entitlement' as const,
    providerExecutionPolicy: {
        mode: 'test_operation_split' as const,
        policyVersion: 'authorized-free-e2e-v1' as const,
        operationSlots: {
            'target-profile': 'primary' as const,
            'relationship-followers': 'secondary' as const,
            'relationship-following': 'tertiary' as const,
            'profile-fallback': 'primary' as const,
            'target-likers': 'quaternary' as const,
            'target-comments': 'quinary' as const,
            'candidate-likers': 'senary' as const,
        },
    },
    planId: 'basic' as const,
    followersDeclaredCount: 0,
    followingDeclaredCount: 0,
    detailedMutualLimit: 300 as const,
};

describe('revenue final coverage quality gate', () => {
    it('uses the real finalizer claim and persists passing integer coverage only for strict test-entitlement lineage', async () => {
        const rpc = vi.fn(async () => ({
            data: { disposition: 'accepted', created: true, replayed: false },
            error: null,
        }));
        const gate = createAnalysisV2RevenueFinalQualityGate({
            contextStore: { load: vi.fn(async () => strictContext) },
            client: { rpc },
        });

        await expect(gate.evaluate({
            ...claim,
            publicMutualCount: 10,
            screenedCount: 10,
            notScreenedCount: 0,
            unknownBurdenCount: 3,
        })).resolves.toBe('approved');
        expect(rpc).toHaveBeenCalledWith(
            'record_analysis_revenue_coverage_gate_v1',
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: 'coordinator:finalize',
                p_public_mutual_count: 10,
                p_screened_count: 10,
                p_not_screened_count: 0,
                p_unknown_burden_count: 3,
            }),
        );
    });

    it('makes a durable manual-review response block auto-finalization', async () => {
        const gate = createAnalysisV2RevenueFinalQualityGate({
            contextStore: { load: vi.fn(async () => strictContext) },
            client: { rpc: vi.fn(async () => ({
                data: { disposition: 'manual_review', created: true, replayed: false },
                error: null,
            })) },
        });

        await expect(gate.evaluate({
            ...claim,
            publicMutualCount: 10,
            screenedCount: 10,
            notScreenedCount: 0,
            unknownBurdenCount: 4,
        })).rejects.toBeInstanceOf(AnalysisV2RevenueFinalQualityGateError);
    });

    it('does not make a revenue RPC for production or Plus lineage', async () => {
        const rpc = vi.fn();
        const gate = createAnalysisV2RevenueFinalQualityGate({
            contextStore: { load: vi.fn(async () => ({
                ...strictContext,
                accessMode: 'production' as const,
            })) },
            client: { rpc },
        });

        await expect(gate.evaluate({
            ...claim,
            publicMutualCount: 0,
            screenedCount: 0,
            notScreenedCount: 0,
            unknownBurdenCount: 0,
        })).resolves.toBe('not_applicable');
        expect(rpc).not.toHaveBeenCalled();
    });
});
