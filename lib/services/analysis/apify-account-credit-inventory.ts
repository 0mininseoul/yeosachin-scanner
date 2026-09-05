import { ApifyClient } from 'apify-client';
import { z } from 'zod';
import {
    apifyAccountCreditInventorySchema,
    type ApifyAccountCreditInventoryRow,
} from '@/lib/contracts/apify-account-credit-inventory';
import {
    APIFY_CREDENTIAL_TOKEN_ENV,
    APIFY_FREE_CREDENTIAL_SLOTS,
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
export const APIFY_ACCOUNT_EXCLUSION_RPC =
    'set_analysis_apify_account_exclusion';
export const APIFY_ACCOUNT_CREDIT_INVENTORY_VALIDATION_ERROR =
    'ANALYSIS_APIFY_ACCOUNT_INVENTORY_VALIDATION_ERROR';
export const APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR =
    'ANALYSIS_APIFY_ACCOUNT_INVENTORY_PERSISTENCE_ERROR';

const MAX_AGE_SECONDS = 900;
export const APIFY_ACCOUNT_CREDIT_INVENTORY_DEFAULT_MAX_AGE_SECONDS = 300;
const TIMESTAMP = z.string().datetime({ offset: true });
export { apifyAccountCreditInventorySchema };
export type { ApifyAccountCreditInventoryRow };

export const apifyAccountCreditExclusionInputSchema = z.object({
    credentialSlot: z.enum(APIFY_FREE_CREDENTIAL_SLOTS),
    excluded: z.boolean(),
}).strict();

export type ApifyAccountCreditExclusionInput = z.infer<
    typeof apifyAccountCreditExclusionInputSchema
>;

const exclusionResultSchema = z.object({
    credentialSlot: z.enum(APIFY_FREE_CREDENTIAL_SLOTS),
    excluded: z.boolean(),
    updatedAt: TIMESTAMP,
}).strict();

export interface ApifyAccountCreditInventoryClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: null | { code?: string; message?: string };
    }>;
}

export interface ApifyAccountCreditInventoryStore {
    load(maxSnapshotAgeSeconds?: number): Promise<readonly ApifyAccountCreditInventoryRow[]>;
    setManualExclusion(input: unknown): Promise<void>;
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

function rpcScalarData(data: unknown): unknown {
    // PostgREST can represent a scalar JSONB result as one row. Unlike the
    // inventory reader, a mutation result cannot be confused with a row set.
    if (Array.isArray(data) && data.length === 1) return data[0];
    return data;
}

function parseInventory(data: unknown): readonly ApifyAccountCreditInventoryRow[] {
    const parsed = apifyAccountCreditInventorySchema.safeParse(rpcData(data));
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
        async load(
            maxSnapshotAgeSeconds = APIFY_ACCOUNT_CREDIT_INVENTORY_DEFAULT_MAX_AGE_SECONDS,
        ) {
            validateMaxAge(maxSnapshotAgeSeconds);
            return parseInventory(await callRpc(
                client,
                APIFY_ACCOUNT_CREDIT_INVENTORY_RPC,
                { p_max_age_seconds: maxSnapshotAgeSeconds },
            ));
        },
        async setManualExclusion(input: unknown) {
            const parsed = apifyAccountCreditExclusionInputSchema.safeParse(input);
            if (!parsed.success) {
                throw new Error(APIFY_ACCOUNT_CREDIT_INVENTORY_VALIDATION_ERROR);
            }
            const result = await callRpc(
                client,
                APIFY_ACCOUNT_EXCLUSION_RPC,
                {
                    p_credential_slot: parsed.data.credentialSlot,
                    p_excluded: parsed.data.excluded,
                },
            );
            if (!exclusionResultSchema.safeParse(rpcScalarData(result)).success) {
                throw new Error(APIFY_ACCOUNT_CREDIT_INVENTORY_PERSISTENCE_ERROR);
            }
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
