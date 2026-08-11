import { describe, expect, it, vi } from 'vitest';
import {
    createAnalysisV2RevenueResolverCapacity,
} from './revenue-resolver-capacity';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const claim = {
    requestId,
    jobKey: 'coordinator:join:primary-evidence' as const,
    claimToken: '223e4567-e89b-42d3-a456-426614174000',
    jobInputHash: 'a'.repeat(64),
};
const operationKey = `gender-resolution:${'b'.repeat(64)}`;
const planHash = 'c'.repeat(64);

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

describe('revenue resolver capacity admission', () => {
    it('begins and reserves one durable primary-join identity for exact Basic test-entitlement lineage', async () => {
        const rpc = vi.fn(async () => ({
            data: { disposition: 'accepted', created: true, replayed: false },
            error: null,
        }));
        const capacity = createAnalysisV2RevenueResolverCapacity({
            contextStore: { load: vi.fn(async () => strictContext) },
            client: { rpc },
        });

        const admission = await capacity.bind(claim);
        expect(admission?.capacityLimit).toBe(20);
        await expect(admission?.begin({
            planHash,
            screenedCount: 10,
            unknownBurdenCount: 4,
        })).resolves.toBe('accepted');
        await expect(admission?.reserve(operationKey)).resolves.toBe('accepted');
        expect(rpc).toHaveBeenCalledWith(
            'begin_analysis_revenue_resolver_pass_v1',
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: claim.jobKey,
                p_plan_hash: planHash,
                p_screened_count: 10,
                p_unknown_burden_count: 4,
            }),
        );
        expect(rpc).toHaveBeenCalledWith(
            'reserve_analysis_revenue_resolver_capacity_v1',
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: claim.jobKey,
                p_operation_key: operationKey,
            }),
        );
    });

    it('exposes the immutable Standard 40-slot primary-join ceiling', async () => {
        const capacity = createAnalysisV2RevenueResolverCapacity({
            contextStore: { load: vi.fn(async () => ({
                ...strictContext,
                planId: 'standard' as const,
            })) },
            client: { rpc: vi.fn() },
        });

        await expect(capacity.bind(claim)).resolves.toMatchObject({
            capacityLimit: 40,
        });
    });

    it('does not make new revenue RPCs for production or Plus lineage', async () => {
        const rpc = vi.fn();
        const capacity = createAnalysisV2RevenueResolverCapacity({
            contextStore: { load: vi.fn(async () => ({
                ...strictContext,
                accessMode: 'production' as const,
            })) },
            client: { rpc },
        });

        await expect(capacity.bind(claim)).resolves.toBeNull();
        expect(rpc).not.toHaveBeenCalled();
    });

    it('fails closed on an unrecognized durable capacity disposition', async () => {
        const capacity = createAnalysisV2RevenueResolverCapacity({
            contextStore: { load: vi.fn(async () => strictContext) },
            client: { rpc: vi.fn(async () => ({
                data: { disposition: 'accepted', created: false, replayed: false },
                error: null,
            })) },
        });

        const admission = await capacity.bind(claim);
        await expect(admission!.reserve(operationKey))
            .rejects.toThrow('ANALYSIS_V2_REVENUE_RESOLVER_CAPACITY_PERSISTENCE_ERROR');
    });
});
