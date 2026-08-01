import { describe, expect, it, vi } from 'vitest';
import {
    BETA_APIFY_RUNTIME_CONFIG_ERROR,
    BETA_APIFY_POOL_CAPACITY_ERROR,
    BETA_APIFY_POOL_PERSISTENCE_ERROR,
    BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
    BETA_APIFY_OPERATION_FAMILIES,
    createBetaApifyCreditPoolStore,
    getBetaApifyOperationBudgetCatalog,
    getBetaApifyCreditPoolRuntimeConfig,
    planBetaApifyCreditAllocation,
    type BetaApifyPoolStoreClient,
} from './beta-apify-credit-runtime';
import { BETA_APIFY_FREE_CREDENTIAL_SLOTS } from './beta-apify-credit-pool';
import {
    interactionMaximumCharge,
    profileMaximumCharge,
    relationshipMaximumCharge,
} from './v2-collection-executors';
import { profileRepairMaximumCharge } from './v2-profile-repair';
import {
    MAX_REVERSE_CANDIDATES,
    reverseLikeMaximumCharge,
} from './v2-ai-scoring-runtime-deps';
import { getAnalysisPlan, PLAN_IDS } from '@/lib/domain/analysis/plan-catalog';

const UUID = '974247fa-8d0e-4ab7-b6d2-ddf256ad6bdd';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174001';
const timestamps = {
    billingCycleStartAt: '2026-08-01T00:00:00.000Z',
    billingCycleEndAt: '2026-09-01T00:00:00.000Z',
    observedAt: '2026-08-02T00:00:00.000Z',
} as const;

function slots(headroomUsd = 1) {
    return BETA_APIFY_FREE_CREDENTIAL_SLOTS.map(credentialSlot => ({
        credentialSlot,
        monthlyLimitUsd: 10,
        monthlyUsageUsd: 2,
        healthState: 'healthy' as const,
        effectiveHeadroomUsd: headroomUsd,
        ...timestamps,
    }));
}

function rpcClient(result: unknown, error: { message?: string } | null = null) {
    return { rpc: vi.fn().mockResolvedValue({ data: result, error }) } satisfies BetaApifyPoolStoreClient;
}

describe('beta Apify runtime foundation', () => {
    it('is disabled by default and rejects invalid bounded settings without exposing env values', () => {
        expect(getBetaApifyCreditPoolRuntimeConfig({})).toEqual({
            enabled: false,
            maxSnapshotAgeSeconds: 300,
            refreshIntervalSeconds: 60,
        });
        expect(() => getBetaApifyCreditPoolRuntimeConfig({
            BETATEST_FREE_POOL_ENABLED: 'sometimes',
        })).toThrow(BETA_APIFY_RUNTIME_CONFIG_ERROR);
        expect(() => getBetaApifyCreditPoolRuntimeConfig({
            BETATEST_FREE_POOL_MAX_SNAPSHOT_AGE_SECONDS: '901',
        })).toThrow(BETA_APIFY_RUNTIME_CONFIG_ERROR);
    });

    it('serializes only exact-six sanitized snapshots and validates the final RPC response', async () => {
        const client = rpcClient(slots());
        const store = createBetaApifyCreditPoolStore(client);
        await expect(store.upsertSnapshots(slots())).resolves.toEqual(slots());
        expect(client.rpc).toHaveBeenCalledWith(
            'upsert_analysis_beta_apify_credit_snapshots',
            { p_snapshots: slots().map(snapshot => ({
                credentialSlot: snapshot.credentialSlot,
                monthlyLimitUsd: snapshot.monthlyLimitUsd,
                monthlyUsageUsd: snapshot.monthlyUsageUsd,
                billingCycleStartAt: snapshot.billingCycleStartAt,
                billingCycleEndAt: snapshot.billingCycleEndAt,
                observedAt: snapshot.observedAt,
                healthState: snapshot.healthState,
            })) }
        );

        const invalid = rpcClient([{ ...slots()[0], credentialSlot: 'secondary' }]);
        await expect(createBetaApifyCreditPoolStore(invalid).loadSnapshots(300))
            .rejects.toThrow(BETA_APIFY_POOL_PERSISTENCE_ERROR);
    });

    it('maps known persistence capacity/staleness errors to a stable sanitized domain error', async () => {
        const client = rpcClient(null, {
            message: 'ANALYSIS_BETA_POOL_SNAPSHOT_STALE provider-account-id secret-token',
        });
        await expect(createBetaApifyCreditPoolStore(client).loadSnapshots(300))
            .rejects.toThrow(BETA_APIFY_POOL_CAPACITY_ERROR);
    });

    it('plans an immutable deterministic complete map, preserving target-profile hold', () => {
        const input = slots(10);
        const planned = planBetaApifyCreditAllocation({
            effectiveHeadrooms: input,
            targetProfileSlot: 'primary',
            selectedPlanId: 'basic',
        });
        expect(planned.operationSlotMap['target-profile']).toBe('primary');
        expect(Object.keys(planned.operationSlotMap).sort()).toEqual([...BETA_APIFY_OPERATION_FAMILIES].sort());
        expect(Object.values(planned.operationSlotMap)).not.toContain('secondary');
        expect(planned.perSlotReservedUsd.primary).toBeGreaterThanOrEqual(
            BETA_APIFY_TARGET_PROFILE_BUDGET_USD
        );
        expect(Object.isFrozen(planned.operationSlotMap)).toBe(true);
        expect(input).toEqual(slots(10));
    });

    it('fails closed on missing slots or exhausted capacity', () => {
        expect(() => planBetaApifyCreditAllocation({
            effectiveHeadrooms: slots().slice(1),
            targetProfileSlot: 'primary',
            selectedPlanId: 'basic',
        })).toThrow(BETA_APIFY_POOL_CAPACITY_ERROR);
        expect(() => planBetaApifyCreditAllocation({
            effectiveHeadrooms: slots(0),
            targetProfileSlot: 'primary',
            selectedPlanId: 'plus',
        })).toThrow(BETA_APIFY_POOL_CAPACITY_ERROR);
    });

    it('sends immutable identity and exact map/budget activation parameters only', async () => {
        const client = rpcClient({
            allocationId: UUID,
            preflightId: UUID,
            requestId: REQUEST_ID,
            lifecycleState: 'active',
            policyVersion: 'betatest-free-pool-v1',
            selectedPlanId: 'basic',
            operationSlotMap: Object.fromEntries(BETA_APIFY_OPERATION_FAMILIES.map(key => [key, 'primary'])),
            operationBudgetMap: Object.fromEntries(BETA_APIFY_OPERATION_FAMILIES.map(key => [key, 0.0052])),
            expiresAt: '2026-08-02T01:00:00.000Z',
        });
        const store = createBetaApifyCreditPoolStore(client);
        const plan = planBetaApifyCreditAllocation({
            effectiveHeadrooms: slots(10), targetProfileSlot: 'primary', selectedPlanId: 'basic',
        });
        await store.activateRequest({
            preflightId: UUID, requestId: REQUEST_ID, userId: UUID, selectedPlanId: 'basic',
            ...plan, maxSnapshotAgeSeconds: 300,
        });
        expect(client.rpc.mock.calls[0]?.[0]).toBe('activate_analysis_beta_apify_request_credit');
        expect(JSON.stringify(client.rpc.mock.calls[0]?.[1])).not.toMatch(/token|account|userId/i);
    });

    it('rejects malformed settlement and recovery RPC results', async () => {
        const store = createBetaApifyCreditPoolStore(rpcClient({ rawProviderPayload: 'secret' }));
        await expect(store.settle(UUID, 'request_terminal'))
            .rejects.toThrow(BETA_APIFY_POOL_PERSISTENCE_ERROR);
        await expect(store.recover()).rejects.toThrow(BETA_APIFY_POOL_PERSISTENCE_ERROR);
    });

    it.each(PLAN_IDS)('reserves at least every bounded executor start for %s', planId => {
        const plan = getAnalysisPlan(planId);
        const catalog = getBetaApifyOperationBudgetCatalog(planId);
        const batches = Math.ceil(plan.detailedMutualLimit / 30);
        expect(catalog['target-profile']).toBe(BETA_APIFY_TARGET_PROFILE_BUDGET_USD);
        expect(catalog['relationship-followers']).toBeGreaterThanOrEqual(
            relationshipMaximumCharge(plan.relationshipCapacity.followers, {}) * 2
        );
        expect(catalog['relationship-following']).toBeGreaterThanOrEqual(
            relationshipMaximumCharge(plan.relationshipCapacity.following, {}) * 2
        );
        expect(catalog['profile-fallback']).toBeGreaterThanOrEqual(
            profileMaximumCharge(30, {}) * batches
        );
        expect(catalog['profile-repair']).toBeGreaterThanOrEqual(
            profileRepairMaximumCharge(30) * batches
        );
        expect(catalog['target-likers']).toBeGreaterThanOrEqual(
            interactionMaximumCharge('likers', 4, 150, {})
        );
        expect(catalog['target-comments']).toBeGreaterThanOrEqual(
            interactionMaximumCharge('comments', 6, 15, {})
        );
        expect(catalog['candidate-likers']).toBeGreaterThanOrEqual(
            reverseLikeMaximumCharge(MAX_REVERSE_CANDIDATES, {})
        );
        for (const value of Object.values(catalog)) {
            expect(value).toBeGreaterThan(0);
            expect(Number(value.toFixed(12))).toBe(value);
        }
    });
});
