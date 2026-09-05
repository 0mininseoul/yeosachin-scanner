import { describe, expect, it, vi } from 'vitest';
import {
    APIFY_ACCOUNT_EXCLUSION_RPC,
    APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR,
    APIFY_ACCOUNT_CREDIT_INVENTORY_VALIDATION_ERROR,
    APIFY_ACCOUNT_CREDIT_INVENTORY_RPC,
    APIFY_PAID_CREDIT_SNAPSHOT_RPC,
    createApifyAccountCreditInventoryStore,
    createServerApifyCreditClientFactory,
} from './apify-account-credit-inventory';
import {
    APIFY_CREDENTIAL_SLOTS,
    APIFY_CREDENTIAL_TOKEN_ENV,
    APIFY_FREE_CREDENTIAL_SLOTS,
    type ApifyCredentialSlot,
} from '@/lib/services/instagram/providers/types';
import type {
    ApifyAccountCreditInventoryClient,
    ApifyAccountCreditInventoryRow,
} from './apify-account-credit-inventory';
import type { ApifyUserCreditClient } from './beta-apify-credit-pool';

const CYCLE_START = '2026-08-01T00:00:00.000Z';
const CYCLE_END = '2026-09-01T00:00:00.000Z';
const OBSERVED_AT = '2026-08-02T01:02:03.000Z';
const REFETCHED_AT = '2026-08-02T01:02:04.000Z';
const TEST_CLOCK = Object.freeze({ now: Date.parse(OBSERVED_AT) });

function freshRow(credentialSlot: ApifyCredentialSlot): ApifyAccountCreditInventoryRow {
    return {
        credentialSlot,
        workloadRole: credentialSlot === 'secondary' ? 'paid' as const : 'free' as const,
        healthState: 'healthy' as const,
        freshnessState: 'fresh' as const,
        monthlyLimitUsd: 10,
        monthlyUsageUsd: 2,
        effectiveRemainingUsd: 8,
        billingCycleStartAt: CYCLE_START,
        billingCycleEndAt: CYCLE_END,
        cycleResetAt: CYCLE_END,
        observedAt: OBSERVED_AT,
        refreshedAt: REFETCHED_AT,
        manuallyExcluded: false,
    };
}

function inventoryRows() {
    return APIFY_CREDENTIAL_SLOTS.map(freshRow);
}

function rpcClient(data: unknown): ApifyAccountCreditInventoryClient {
    return {
        rpc: vi.fn().mockResolvedValue({ data, error: null }),
    };
}

function providerReply() {
    return {
        id: 'provider-id-must-not-escape',
        token: 'provider-token-must-not-escape',
        monthlyUsageCycle: { startAt: new Date(CYCLE_START), endAt: new Date(CYCLE_END) },
        limits: { maxMonthlyUsageUsd: 10 },
        current: { monthlyUsageUsd: 2 },
    };
}

describe('all-account Apify credit inventory', () => {
    it('exports the strict all-ten inventory schema for client response validation', async () => {
        const loaded = await import('./apify-account-credit-inventory') as unknown as {
            apifyAccountCreditInventorySchema?: {
                safeParse(value: unknown): { success: boolean };
            };
        };
        expect(loaded.apifyAccountCreditInventorySchema).toBeDefined();
    });

    it('sets exclusion only for a free slot and rejects secondary before the RPC', async () => {
        const client = rpcClient({
            credentialSlot: 'octonary',
            excluded: true,
            updatedAt: REFETCHED_AT,
        });
        const store = createApifyAccountCreditInventoryStore(client);

        await store.setManualExclusion({ credentialSlot: 'octonary', excluded: true });
        expect(client.rpc).toHaveBeenCalledWith(
            APIFY_ACCOUNT_EXCLUSION_RPC,
            { p_credential_slot: 'octonary', p_excluded: true },
        );

        (client.rpc as ReturnType<typeof vi.fn>).mockClear();
        await expect(store.setManualExclusion({
            credentialSlot: 'secondary',
            excluded: true,
        }))
            .rejects.toThrow(APIFY_ACCOUNT_CREDIT_INVENTORY_VALIDATION_ERROR);
        expect(client.rpc).not.toHaveBeenCalled();
    });

    it('accepts a one-row wrapper around the sanitized exclusion RPC result', async () => {
        const client = rpcClient([{
            credentialSlot: 'octonary',
            excluded: false,
            updatedAt: REFETCHED_AT,
        }]);

        await expect(createApifyAccountCreditInventoryStore(client).setManualExclusion({
            credentialSlot: 'octonary',
            excluded: false,
        })).resolves.toBeUndefined();
    });

    it('fails closed when the exclusion RPC returns an unexpected payload', async () => {
        const client = rpcClient({ credentialSlot: 'octonary', excluded: true });

        await expect(createApifyAccountCreditInventoryStore(client).setManualExclusion({
            credentialSlot: 'octonary',
            excluded: true,
        })).rejects.toThrow(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);
    });

    it('fails closed when a fresh row omits remaining capacity', async () => {
        const rows = inventoryRows();
        rows[0] = { ...rows[0]!, effectiveRemainingUsd: null };

        await expect(createApifyAccountCreditInventoryStore(rpcClient(rows)).load())
            .rejects.toThrow(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);
    });

    it('requires canonical ten aliases, role labels, and explicit missing secondary state', async () => {
        const rows = inventoryRows();
        rows[1] = {
            ...rows[1]!,
            healthState: 'unhealthy',
            freshnessState: 'missing',
            monthlyLimitUsd: null,
            monthlyUsageUsd: null,
            effectiveRemainingUsd: null,
            billingCycleStartAt: null,
            billingCycleEndAt: null,
            cycleResetAt: null,
            observedAt: null,
        };
        const client = rpcClient(rows);
        const result = await createApifyAccountCreditInventoryStore(client).load();

        expect(result.map(row => row.credentialSlot)).toEqual([...APIFY_CREDENTIAL_SLOTS]);
        expect(result.map(row => row.workloadRole)).toEqual([
            'free', 'paid', ...APIFY_FREE_CREDENTIAL_SLOTS.slice(1).map(() => 'free' as const),
        ]);
        expect(result[1]).toMatchObject({
            credentialSlot: 'secondary',
            workloadRole: 'paid',
            healthState: 'unhealthy',
            freshnessState: 'missing',
            effectiveRemainingUsd: null,
        });
        expect(JSON.stringify(result)).not.toMatch(/provider-id|provider-token|apiToken|userId/i);
    });

    it('rejects role drift, duplicate aliases, and stale numeric remaining capacity', async () => {
        const rows = inventoryRows();
        rows[1] = { ...rows[1]!, workloadRole: 'free' };
        const client = rpcClient(rows);
        await expect(createApifyAccountCreditInventoryStore(client).load())
            .rejects.toThrow(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);

        const duplicateRows = inventoryRows();
        duplicateRows[9] = { ...duplicateRows[9]!, credentialSlot: 'nonary' };
        await expect(createApifyAccountCreditInventoryStore(rpcClient(duplicateRows)).load())
            .rejects.toThrow(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);

        const staleRows = inventoryRows();
        staleRows[1] = {
            ...staleRows[1]!,
            freshnessState: 'stale',
            effectiveRemainingUsd: null,
        };
        await expect(createApifyAccountCreditInventoryStore(rpcClient(staleRows)).load())
            .resolves.toHaveLength(APIFY_CREDENTIAL_SLOTS.length);
    });

    it('refreshes paid secondary independently with sanitized balance/cycle fields', async () => {
        const rows = inventoryRows();
        const client = rpcClient(rows);
        const provider = {
            limits: vi.fn().mockResolvedValue(providerReply()),
            monthlyUsage: vi.fn().mockResolvedValue({
                userId: 'provider-id-must-not-escape',
                apiToken: 'provider-token-must-not-escape',
                usageCycle: { startAt: CYCLE_START, endAt: CYCLE_END },
                totalUsageCreditsUsdAfterVolumeDiscount: 2,
            }),
        };

        const refreshed = await createApifyAccountCreditInventoryStore(client)
            .refreshPaidSecondary({
                client: provider,
                observedAt: new Date(OBSERVED_AT),
                clock: { now: () => TEST_CLOCK.now },
            });

        expect(refreshed).toMatchObject({ credentialSlot: 'secondary', workloadRole: 'paid' });
        const rpc = client.rpc as ReturnType<typeof vi.fn>;
        expect(rpc).toHaveBeenCalledWith(
            APIFY_PAID_CREDIT_SNAPSHOT_RPC,
            {
                p_snapshot: {
                    credentialSlot: 'secondary',
                    monthlyLimitUsd: 10,
                    monthlyUsageUsd: 2,
                    billingCycleStartAt: CYCLE_START,
                    billingCycleEndAt: CYCLE_END,
                    observedAt: OBSERVED_AT,
                    healthState: 'healthy',
                },
            },
        );
        expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/provider-id|provider-token|apiToken|userId/i);
    });

    it('loads the service-only RPC with an explicit bounded age', async () => {
        const client = rpcClient(inventoryRows());
        await createApifyAccountCreditInventoryStore(client).load(17);
        expect(client.rpc).toHaveBeenCalledWith(
            APIFY_ACCOUNT_CREDIT_INVENTORY_RPC,
            { p_max_age_seconds: 17 },
        );
    });

    it('constructs all-ten server clients without making secondary part of the beta factory', () => {
        const createClient = vi.fn((...args: [
            string,
            Readonly<{ maxRetries: 0; timeoutSecs: number }>,
        ]) => {
            void args;
            return {
                user: (): ApifyUserCreditClient => ({ limits: vi.fn(), monthlyUsage: vi.fn() }),
            };
        });
        const env = Object.fromEntries(
            APIFY_CREDENTIAL_SLOTS.map(slot => [APIFY_CREDENTIAL_TOKEN_ENV[slot], `fixture-${slot}`]),
        );
        const factory = createServerApifyCreditClientFactory(env, createClient);
        for (const slot of APIFY_CREDENTIAL_SLOTS) factory(slot);

        expect(createClient.mock.calls.map(([token]) => token)).toEqual(
            APIFY_CREDENTIAL_SLOTS.map(slot => `fixture-${slot}`),
        );
        expect(() => createServerApifyCreditClientFactory(
            { [APIFY_CREDENTIAL_TOKEN_ENV.secondary]: '' },
            createClient,
        )('secondary')).toThrow(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);
    });
});
