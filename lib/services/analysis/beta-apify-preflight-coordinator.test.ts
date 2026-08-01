import { describe, expect, it, vi } from 'vitest';
import {
    BETA_APIFY_POOL_CAPACITY_ERROR,
    createBetaApifyPreflightCoordinator,
    createServerBetaApifyCreditClientFactory,
    type BetaApifyPreflightCoordinatorStore,
} from './beta-apify-preflight-coordinator';
import { BETA_APIFY_FREE_CREDENTIAL_SLOTS } from './beta-apify-credit-pool';
import type { BetaApifyPoolSnapshot } from './beta-apify-credit-runtime';

const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
const now = new Date('2026-08-02T00:00:00.000Z');

function providerReply() {
    return {
        limits: {
            maxMonthlyUsageUsd: 10,
        },
        current: { monthlyUsageUsd: 1 },
        monthlyUsageCycle: {
            startAt: '2026-08-01T00:00:00.000Z',
            endAt: '2026-09-01T00:00:00.000Z',
        },
    };
}

function store(): BetaApifyPreflightCoordinatorStore {
    return {
        loadPreflightHold: vi.fn(async () => null),
        upsertSnapshots: vi.fn(async (snapshots: readonly BetaApifyPoolSnapshot[]) => snapshots.map(snapshot => ({
            ...snapshot,
            effectiveHeadroomUsd: snapshot.monthlyLimitUsd - snapshot.monthlyUsageUsd,
        }))),
        loadSnapshots: vi.fn(async () => BETA_APIFY_FREE_CREDENTIAL_SLOTS.map((credentialSlot, index) => ({
            credentialSlot,
            monthlyLimitUsd: 10,
            monthlyUsageUsd: 1,
            billingCycleStartAt: '2026-08-01T00:00:00.000Z',
            billingCycleEndAt: '2026-09-01T00:00:00.000Z',
            observedAt: now.toISOString(),
            healthState: 'healthy' as const,
            effectiveHeadroomUsd: index === 0 ? 0.004 : 1,
        }))),
        holdPreflight: vi.fn(async input => ({
            allocationId: '323e4567-e89b-42d3-a456-426614174000',
            preflightId: input.preflightId,
            requestId: null,
            lifecycleState: 'preflight_held' as const,
            policyVersion: 'betatest-free-pool-v1' as const,
            selectedPlanId: null,
            operationSlotMap: null,
            operationBudgetMap: null,
            expiresAt: '2026-08-02T01:00:00.000Z',
        })),
    };
}

describe('beta preflight credit coordinator', () => {
    it('maps only the six named free-pool token keys to lazy Apify user clients', () => {
        const created: string[] = [];
        const factory = createServerBetaApifyCreditClientFactory({
            APIFY_PRIMARY_API_TOKEN: 'p', APIFY_TERTIARY_API_TOKEN: 't',
            APIFY_QUATERNARY_API_TOKEN: 'q4', APIFY_QUINARY_API_TOKEN: 'q5',
            APIFY_SENARY_API_TOKEN: 's', APIFY_SEPTENARY_API_TOKEN: 's7',
            APIFY_SECONDARY_API_TOKEN: 'must-never-be-selected',
        }, token => {
            created.push(token);
            return { user: () => ({ limits: async () => ({}), monthlyUsage: async () => ({}) }) };
        });
        for (const slot of BETA_APIFY_FREE_CREDENTIAL_SLOTS) factory(slot);
        expect(created).toEqual(['p', 't', 'q4', 'q5', 's', 's7']);
        expect(created).not.toContain('must-never-be-selected');
    });

    it('refreshes all exact-six accounts before atomically holding the deterministic fitting target slot', async () => {
        const pool = store();
        const clients = new Map(BETA_APIFY_FREE_CREDENTIAL_SLOTS.map(slot => [slot, {
            limits: vi.fn(async () => providerReply()),
            monthlyUsage: vi.fn(async () => ({
                totalUsageCreditsUsdAfterVolumeDiscount: 1,
                usageCycle: providerReply().monthlyUsageCycle,
            })),
        }]));
        const coordinator = createBetaApifyPreflightCoordinator({
            store: pool,
            clientForSlot: slot => clients.get(slot)!,
            env: { BETATEST_FREE_POOL_ENABLED: 'true' },
            now: () => now.getTime(),
        });

        await expect(coordinator.prepare({ preflightId, userId })).resolves.toMatchObject({
            credentialSlot: 'tertiary',
            existing: false,
        });
        expect(pool.upsertSnapshots).toHaveBeenCalledBefore(pool.loadSnapshots as ReturnType<typeof vi.fn>);
        expect(pool.loadSnapshots).toHaveBeenCalledBefore(pool.holdPreflight as ReturnType<typeof vi.fn>);
        expect([...clients.keys()]).toEqual(BETA_APIFY_FREE_CREDENTIAL_SLOTS);
        for (const client of clients.values()) {
            expect(client.limits).toHaveBeenCalledOnce();
            expect(client.monthlyUsage).toHaveBeenCalledOnce();
        }
        expect(pool.holdPreflight).toHaveBeenCalledWith(expect.objectContaining({
            preflightId, userId, credentialSlot: 'tertiary',
        }));
    });

    it('reuses a stored frozen target hold without reading config or calling Apify', async () => {
        const pool = store();
        pool.loadPreflightHold = vi.fn(async () => ({
            allocationId: '323e4567-e89b-42d3-a456-426614174000',
            preflightId,
            credentialSlot: 'quinary' as const,
            targetProfileBudgetUsd: 0.0052,
        }));
        const clientForSlot = vi.fn();
        const coordinator = createBetaApifyPreflightCoordinator({
            store: pool,
            clientForSlot,
            env: { BETATEST_FREE_POOL_ENABLED: 'not-a-boolean' },
        });

        await expect(coordinator.prepare({ preflightId, userId })).resolves.toMatchObject({
            credentialSlot: 'quinary', existing: true,
        });
        expect(clientForSlot).not.toHaveBeenCalled();
        expect(pool.upsertSnapshots).not.toHaveBeenCalled();
        expect(pool.holdPreflight).not.toHaveBeenCalled();
    });

    it('fails closed without a hold when any exact-six account refresh fails', async () => {
        const pool = store();
        const coordinator = createBetaApifyPreflightCoordinator({
            store: pool,
            clientForSlot: slot => ({
                limits: async () => slot === 'senary' ? Promise.reject(new Error('token-should-not-escape')) : providerReply(),
                monthlyUsage: async () => ({
                    totalUsageCreditsUsdAfterVolumeDiscount: 1,
                    usageCycle: providerReply().monthlyUsageCycle,
                }),
            }),
            env: { BETATEST_FREE_POOL_ENABLED: 'true' },
            now: () => now.getTime(),
        });

        await expect(coordinator.prepare({ preflightId, userId }))
            .rejects.toEqual(new Error(BETA_APIFY_POOL_CAPACITY_ERROR));
        expect(pool.upsertSnapshots).not.toHaveBeenCalled();
        expect(pool.holdPreflight).not.toHaveBeenCalled();
    });
});
