/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { APIFY_CREDENTIAL_SLOTS } from '@/lib/services/instagram/providers/types';

const timestamp = '2026-09-05T08:00:00.000Z';

function validRows() {
    return APIFY_CREDENTIAL_SLOTS.map(credentialSlot => ({
        credentialSlot,
        workloadRole: credentialSlot === 'secondary' ? 'paid' as const : 'free' as const,
        healthState: 'healthy' as const,
        freshnessState: 'fresh' as const,
        monthlyLimitUsd: 10,
        monthlyUsageUsd: 2,
        effectiveRemainingUsd: 8,
        billingCycleStartAt: timestamp,
        billingCycleEndAt: timestamp,
        cycleResetAt: timestamp,
        observedAt: timestamp,
        refreshedAt: timestamp,
        manuallyExcluded: false,
    }));
}

async function clientInventorySchema(): Promise<{
    safeParse(value: unknown): { success: boolean };
} | undefined> {
    const loaded = await import('./workbench') as unknown as {
        inventoryEnvelopeSchema?: {
            safeParse(value: unknown): { success: boolean };
        };
    };
    expect(loaded.inventoryEnvelopeSchema).toBeDefined();
    return loaded.inventoryEnvelopeSchema;
}

describe('operator console inventory response contract', () => {
    it('rejects malformed rows before rendering', async () => {
        const schema = await clientInventorySchema();
        if (!schema) return;
        const rows = validRows();
        rows[0] = { ...rows[0]!, effectiveRemainingUsd: '8' as unknown as number };
        expect(schema.safeParse({ inventory: rows }).success).toBe(false);
    });

    it('rejects missing canonical slots', async () => {
        const schema = await clientInventorySchema();
        if (!schema) return;
        expect(schema.safeParse({ inventory: validRows().slice(0, -1) }).success).toBe(false);
    });

    it('rejects duplicate canonical slots', async () => {
        const schema = await clientInventorySchema();
        if (!schema) return;
        const rows = validRows();
        rows[9] = { ...rows[9]!, credentialSlot: rows[8]!.credentialSlot };
        expect(schema.safeParse({ inventory: rows }).success).toBe(false);
    });

    it('rejects noncanonical slot order', async () => {
        const schema = await clientInventorySchema();
        if (!schema) return;
        const rows = validRows();
        [rows[0], rows[1]] = [rows[1]!, rows[0]!];
        expect(schema.safeParse({ inventory: rows }).success).toBe(false);
    });

    it('rejects a paid/free role mismatch for secondary', async () => {
        const schema = await clientInventorySchema();
        if (!schema) return;
        const rows = validRows();
        rows[1] = { ...rows[1]!, workloadRole: 'free' };
        expect(schema.safeParse({ inventory: rows }).success).toBe(false);
    });
});
