import { ApifyClient } from 'apify-client';
import { z } from 'zod';
import {
    APIFY_CREDENTIAL_SLOTS,
    APIFY_CREDENTIAL_TOKEN_ENV,
    type ApifyCredentialSlot,
} from '@/lib/services/instagram/providers/types';
import {
    readApifyAccountCredit,
    type ApifyAccountCreditReading,
    type ApifyUserCreditClient,
    type BetaApifyCreditClock,
} from './beta-apify-credit-pool';

export const APIFY_ACCOUNT_CREDIT_INVENTORY_RPC =
    'load_analysis_apify_account_credit_inventory';
export const APIFY_PAID_CREDIT_SNAPSHOT_RPC =
    'upsert_analysis_apify_paid_credit_snapshot';
export const APIFY_ACCOUNT_CREDIT_INVENTORY_VALIDATION_ERROR =
    'ANALYSIS_APIFY_ACCOUNT_INVENTORY_VALIDATION_ERROR';
export const APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR =
    'ANALYSIS_APIFY_ACCOUNT_INVENTORY_PERSISTENCE_ERROR';

const MAX_USD = 100_000;
const MAX_AGE_SECONDS = 900;
const TIMESTAMP = z.string().datetime({ offset: true });
const nullableUsd = z.number().finite().min(0).max(MAX_USD).nullable();

const inventoryRowSchema = z.object({
    credentialSlot: z.enum(APIFY_CREDENTIAL_SLOTS),
    workloadRole: z.enum(['free', 'paid']),
    healthState: z.enum(['healthy', 'unhealthy', 'missing']),
    freshnessState: z.enum(['fresh', 'stale', 'missing']),
    monthlyLimitUsd: nullableUsd,
    monthlyUsageUsd: nullableUsd,
    effectiveRemainingUsd: nullableUsd,
    billingCycleStartAt: TIMESTAMP.nullable(),
    billingCycleEndAt: TIMESTAMP.nullable(),
    cycleResetAt: TIMESTAMP.nullable(),
    observedAt: TIMESTAMP.nullable(),
    refreshedAt: TIMESTAMP.nullable(),
    manuallyExcluded: z.boolean(),
}).strict().superRefine((row, context) => {
    const expectedRole = row.credentialSlot === 'secondary' ? 'paid' : 'free';
    if (row.workloadRole !== expectedRole) {
        context.addIssue({
            code: 'custom',
            path: ['workloadRole'],
            message: 'Apify workload role does not match the canonical slot.',
        });
    }
    if (row.credentialSlot === 'secondary' && row.manuallyExcluded) {
        context.addIssue({
            code: 'custom',
            path: ['manuallyExcluded'],
            message: 'Paid secondary cannot be represented as a beta exclusion.',
        });
    }
    const populated = row.monthlyLimitUsd !== null
        && row.monthlyUsageUsd !== null
        && row.billingCycleStartAt !== null
        && row.billingCycleEndAt !== null
        && row.observedAt !== null
        && row.refreshedAt !== null;
    if (row.freshnessState === 'missing') {
        if (row.effectiveRemainingUsd !== null || row.healthState === 'healthy') {
            context.addIssue({
                code: 'custom',
                message: 'Missing credit data must remain explicit and non-numeric.',
            });
        }
    } else if (!populated || row.healthState !== 'healthy') {
        context.addIssue({
            code: 'custom',
            message: 'Fresh or stale credit data must include a healthy snapshot.',
        });
    }
    if (row.freshnessState !== 'fresh' && row.effectiveRemainingUsd !== null) {
        context.addIssue({
            code: 'custom',
            path: ['effectiveRemainingUsd'],
            message: 'Stale credit data cannot be used as current remaining capacity.',
        });
    }
    if (row.billingCycleEndAt !== row.cycleResetAt) {
        context.addIssue({
            code: 'custom',
            path: ['cycleResetAt'],
            message: 'Cycle reset must match the billing cycle end.',
        });
    }
});

const inventorySchema = z.array(inventoryRowSchema)
    .length(APIFY_CREDENTIAL_SLOTS.length)
    .superRefine((rows, context) => {
        const received = rows.map(row => row.credentialSlot);
        if (received.some((slot, index) => slot !== APIFY_CREDENTIAL_SLOTS[index])) {
            context.addIssue({
                code: 'custom',
                message: 'Inventory must contain the canonical all-ten slot order.',
            });
        }
        if (new Set(received).size !== APIFY_CREDENTIAL_SLOTS.length) {
            context.addIssue({
                code: 'custom',
                message: 'Inventory must not contain duplicate slots.',
            });
        }
    });

export type ApifyAccountCreditInventoryRow = z.infer<typeof inventoryRowSchema>;

export interface ApifyAccountCreditInventoryClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: null | { code?: string; message?: string };
    }>;
}

export interface ApifyAccountCreditInventoryStore {
    load(maxSnapshotAgeSeconds?: number): Promise<readonly ApifyAccountCreditInventoryRow[]>;
    /** Paid/operator-only refresh; beta/free callers cannot pass secondary here. */
    refreshPaidSecondary(input: ApifyPaidSecondaryCreditRefreshInput): Promise<ApifyAccountCreditInventoryRow>;
}

export interface ApifyPaidSecondaryCreditRefreshInput {
    client: ApifyUserCreditClient;
    observedAt?: Date;
    clock?: BetaApifyCreditClock;
}

function validateMaxAge(maxSnapshotAgeSeconds: number): void {
    if (!Number.isSafeInteger(maxSnapshotAgeSeconds)
        || maxSnapshotAgeSeconds < 1
        || maxSnapshotAgeSeconds > MAX_AGE_SECONDS) {
        throw new Error(APIFY_ACCOUNT_CREDIT_INVENTORY_VALIDATION_ERROR);
    }
}

function rpcData(data: unknown): unknown {
    // Supabase may wrap a scalar JSONB return in one row. Do not unwrap the
    // actual ten-row inventory array.
    if (Array.isArray(data) && data.length === 1 && Array.isArray(data[0])) {
        return data[0];
    }
    return data;
}

function parseInventory(data: unknown): readonly ApifyAccountCreditInventoryRow[] {
    const parsed = inventorySchema.safeParse(rpcData(data));
    if (!parsed.success) {
        throw new Error(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);
    }
    return Object.freeze(parsed.data.map(row => Object.freeze({ ...row })));
}

async function callRpc(
    client: ApifyAccountCreditInventoryClient,
    name: string,
    params: Record<string, unknown>,
): Promise<unknown> {
    let result: Awaited<ReturnType<ApifyAccountCreditInventoryClient['rpc']>>;
    try {
        result = await client.rpc(name, params);
    } catch {
        throw new Error(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);
    }
    if (result.error) {
        throw new Error(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);
    }
    return result.data;
}

export function createApifyAccountCreditInventoryStore(
    client: ApifyAccountCreditInventoryClient,
): ApifyAccountCreditInventoryStore {
    return Object.freeze({
        async load(maxSnapshotAgeSeconds = 300) {
            validateMaxAge(maxSnapshotAgeSeconds);
            return parseInventory(await callRpc(
                client,
                APIFY_ACCOUNT_CREDIT_INVENTORY_RPC,
                { p_max_age_seconds: maxSnapshotAgeSeconds },
            ));
        },
        async refreshPaidSecondary(input: ApifyPaidSecondaryCreditRefreshInput) {
            let reading: ApifyAccountCreditReading;
            try {
                reading = await readApifyAccountCredit({
                    credentialSlot: 'secondary',
                    client: input.client,
                    observedAt: input.observedAt,
                }, input.clock);
            } catch {
                throw new Error(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);
            }
            const inventory = parseInventory(await callRpc(
                client,
                APIFY_PAID_CREDIT_SNAPSHOT_RPC,
                {
                    p_snapshot: {
                        credentialSlot: reading.credentialSlot,
                        monthlyLimitUsd: reading.monthlyLimitUsd,
                        monthlyUsageUsd: reading.monthlyUsageUsd,
                        billingCycleStartAt: reading.billingCycleStartAt,
                        billingCycleEndAt: reading.billingCycleEndAt,
                        observedAt: reading.observedAt,
                        healthState: 'healthy',
                    },
                },
            ));
            const secondary = inventory.find(row => row.credentialSlot === 'secondary');
            if (!secondary) {
                throw new Error(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);
            }
            return secondary;
        },
    });
}

/**
 * Server-side factory for the operator/paid monitor. The beta factory remains
 * separate and only accepts the nine free slots; this one is only constructed
 * by an explicitly authorized server worker.
 */
export function createServerApifyCreditClientFactory(
    env: Record<string, string | undefined> = process.env,
    createClient: (
        token: string,
        options: Readonly<{ maxRetries: 0; timeoutSecs: number }>,
    ) => { user(): ApifyUserCreditClient } = (token, options) => new ApifyClient({ token, ...options }),
): (slot: ApifyCredentialSlot) => ApifyUserCreditClient {
    const clients = new Map<ApifyCredentialSlot, ApifyUserCreditClient>();
    return slot => {
        const existing = clients.get(slot);
        if (existing) return existing;
        const token = (slot === 'primary'
            ? env[APIFY_CREDENTIAL_TOKEN_ENV[slot]]?.trim() || env.APIFY_API_TOKEN?.trim()
            : env[APIFY_CREDENTIAL_TOKEN_ENV[slot]]?.trim());
        if (!token) {
            throw new Error(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);
        }
        try {
            const client = createClient(token, { maxRetries: 0, timeoutSecs: 10 }).user();
            clients.set(slot, client);
            return client;
        } catch {
            throw new Error(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);
        }
    };
}
