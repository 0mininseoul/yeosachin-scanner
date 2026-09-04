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
const prepareFence = {
    prepareGeneration: 1,
    prepareToken: preflightId.replace(/^1/, '4'),
    claimToken: preflightId.replace(/^1/, '5'),
} as const;
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
            effectiveHeadroomUsd: (snapshot.monthlyLimitUsd ?? 0)
                - (snapshot.monthlyUsageUsd ?? 0),
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
    it('maps only the nine named free-pool token keys to lazy Apify user clients', () => {
        const created: string[] = [];
        const options: unknown[] = [];
        const factory = createServerBetaApifyCreditClientFactory({
            APIFY_PRIMARY_API_TOKEN: 'p', APIFY_TERTIARY_API_TOKEN: 't',
            APIFY_QUATERNARY_API_TOKEN: 'q4', APIFY_QUINARY_API_TOKEN: 'q5',
            APIFY_SENARY_API_TOKEN: 's', APIFY_SEPTENARY_API_TOKEN: 's7',
            APIFY_OCTONARY_API_TOKEN: 'o8', APIFY_NONARY_API_TOKEN: 'n9',
            APIFY_TENTH_API_TOKEN: 't10',
            APIFY_SECONDARY_API_TOKEN: 'must-never-be-selected',
        }, (token, option) => {
            created.push(token);
            options.push(option);
            return { user: () => ({ limits: async () => ({}), monthlyUsage: async () => ({}) }) };
        });
        for (const slot of BETA_APIFY_FREE_CREDENTIAL_SLOTS) factory(slot);
        expect(created).toEqual(['p', 't', 'q4', 'q5', 's', 's7', 'o8', 'n9', 't10']);
        expect(created).not.toContain('must-never-be-selected');
        expect(options).toEqual(Array(9).fill({ maxRetries: 0, timeoutSecs: 10 }));
    });

    it('refreshes all exact-nine accounts before atomically holding the deterministic fitting target slot', async () => {
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

        await expect(coordinator.prepare({ preflightId, userId, ...prepareFence }))
            .resolves.toMatchObject({
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
            preflightId, userId, ...prepareFence, credentialSlot: 'tertiary',
        }));
    });

    it('chooses the eligible slot with the least positive residual headroom', async () => {
        const pool = store();
        pool.loadSnapshots = vi.fn(async () => BETA_APIFY_FREE_CREDENTIAL_SLOTS.map((credentialSlot, index) => ({
            credentialSlot,
            monthlyLimitUsd: 10,
            monthlyUsageUsd: 1,
            billingCycleStartAt: '2026-08-01T00:00:00.000Z',
            billingCycleEndAt: '2026-09-01T00:00:00.000Z',
            observedAt: now.toISOString(),
            healthState: 'healthy' as const,
            effectiveHeadroomUsd: index === 1 ? 0.25 : index === 2 ? 0.01 : 0.004,
        })));
        const clientForSlot = vi.fn(() => ({
            limits: vi.fn(async () => providerReply()),
            monthlyUsage: vi.fn(async () => ({
                totalUsageCreditsUsdAfterVolumeDiscount: 1,
                usageCycle: providerReply().monthlyUsageCycle,
            })),
        }));
        const coordinator = createBetaApifyPreflightCoordinator({
            store: pool,
            clientForSlot,
            env: { BETATEST_FREE_POOL_ENABLED: 'true' },
            now: () => now.getTime(),
        });

        await expect(coordinator.prepare({ preflightId, userId, ...prepareFence }))
            .resolves.toMatchObject({ credentialSlot: 'quaternary', existing: false });
    });

    it('atomically promotes a stored frozen target hold without calling Apify', async () => {
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
            env: { BETATEST_FREE_POOL_ENABLED: 'true' },
        });

        await expect(coordinator.prepare({ preflightId, userId, ...prepareFence }))
            .resolves.toMatchObject({
            credentialSlot: 'quinary', existing: true,
        });
        expect(clientForSlot).not.toHaveBeenCalled();
        expect(pool.upsertSnapshots).not.toHaveBeenCalled();
        expect(pool.holdPreflight).toHaveBeenCalledWith(expect.objectContaining({
            preflightId, userId, ...prepareFence, credentialSlot: 'quinary',
        }));
    });

    it.each([
        ['disabled', { BETATEST_FREE_POOL_ENABLED: 'false' }],
        ['invalid', { BETATEST_FREE_POOL_ENABLED: 'not-a-boolean' }],
    ] as const)('fails closed for an existing hold when the worker env gate is %s', async (
        _label,
        env
    ) => {
        const pool = store();
        pool.loadPreflightHold = vi.fn(async () => ({
            allocationId: '323e4567-e89b-42d3-a456-426614174000',
            preflightId,
            credentialSlot: 'quinary' as const,
            targetProfileBudgetUsd: 0.0052,
        }));
        const clientForSlot = vi.fn();
        const coordinator = createBetaApifyPreflightCoordinator({
            store: pool, clientForSlot, env,
        });

        await expect(coordinator.reuse(preflightId))
            .rejects.toEqual(new Error(BETA_APIFY_POOL_CAPACITY_ERROR));
        await expect(coordinator.prepare({ preflightId, userId, ...prepareFence }))
            .rejects.toEqual(new Error(BETA_APIFY_POOL_CAPACITY_ERROR));
        expect(pool.loadPreflightHold).not.toHaveBeenCalled();
        expect(pool.holdPreflight).not.toHaveBeenCalled();
        expect(clientForSlot).not.toHaveBeenCalled();
    });

    it('keeps healthy accounts allocatable when one exact-nine refresh fails', async () => {
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

        await expect(coordinator.prepare({ preflightId, userId, ...prepareFence }))
            .resolves.toMatchObject({ existing: false });
        expect(pool.upsertSnapshots).toHaveBeenCalledOnce();
        expect(pool.holdPreflight).toHaveBeenCalledOnce();
        expect(pool.holdPreflight).toHaveBeenCalledWith(expect.objectContaining({
            credentialSlot: expect.any(String),
        }));
    });

    it('persists an exact-nine unhealthy refresh and reports capacity pending when all reads fail', async () => {
        const pool = store();
        let persisted: readonly BetaApifyPoolSnapshot[] = [];
        pool.upsertSnapshots = vi.fn(async snapshots => {
            persisted = snapshots;
            return snapshots;
        });
        pool.loadSnapshots = vi.fn(async () => persisted);
        const coordinator = createBetaApifyPreflightCoordinator({
            store: pool,
            clientForSlot: () => ({
                limits: async () => { throw new Error('provider-secret-must-not-escape'); },
                monthlyUsage: async () => { throw new Error('account-id-must-not-escape'); },
            }),
            env: { BETATEST_FREE_POOL_ENABLED: 'true' },
            now: () => now.getTime(),
        });

        await expect(coordinator.prepare({ preflightId, userId, ...prepareFence }))
            .rejects.toEqual(new Error(BETA_APIFY_POOL_CAPACITY_ERROR));
        expect(pool.upsertSnapshots).toHaveBeenCalledOnce();
        const snapshots = vi.mocked(pool.upsertSnapshots).mock.calls[0]?.[0] ?? [];
        expect(snapshots).toHaveLength(BETA_APIFY_FREE_CREDENTIAL_SLOTS.length);
        expect(snapshots.every(snapshot => snapshot.healthState === 'unhealthy'))
            .toBe(true);
        expect(pool.holdPreflight).not.toHaveBeenCalled();
    });
});
