import { ApifyClient } from 'apify-client';
import {
    BETA_APIFY_CREDIT_REFRESH_ERROR,
    BETA_APIFY_FREE_CREDENTIAL_SLOTS,
    refreshBetaApifyCreditPool,
    type ApifyUserCreditClient,
    type BetaApifyFreeCredentialSlot,
} from './beta-apify-credit-pool';
import {
    BETA_APIFY_POOL_CAPACITY_ERROR,
    BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
    getBetaApifyCreditPoolRuntimeConfig,
    type BetaApifyPoolAllocation,
    type BetaApifyPoolSnapshot,
} from './beta-apify-credit-runtime';

export { BETA_APIFY_POOL_CAPACITY_ERROR } from './beta-apify-credit-runtime';

export interface StoredBetaApifyPreflightHold {
    readonly allocationId: string;
    readonly preflightId: string;
    readonly credentialSlot: BetaApifyFreeCredentialSlot;
    readonly targetProfileBudgetUsd: number;
}

export interface BetaApifyPreflightCoordinatorStore {
    loadPreflightHold(preflightId: string): Promise<StoredBetaApifyPreflightHold | null>;
    upsertSnapshots(snapshots: readonly BetaApifyPoolSnapshot[]): Promise<readonly BetaApifyPoolSnapshot[]>;
    loadSnapshots(maxSnapshotAgeSeconds: number): Promise<readonly BetaApifyPoolSnapshot[]>;
    holdPreflight(input: {
        preflightId: string;
        userId: string;
        prepareGeneration: number;
        prepareToken: string;
        claimToken: string;
        credentialSlot: BetaApifyFreeCredentialSlot;
        maxSnapshotAgeSeconds: number;
    }): Promise<BetaApifyPoolAllocation>;
}

export interface BetaApifyPreflightCoordinator {
    reuse(preflightId: string): Promise<Readonly<{
        allocationId: string;
        credentialSlot: BetaApifyFreeCredentialSlot;
    }>>;
    prepare(input: {
        preflightId: string;
        userId: string;
        prepareGeneration: number;
        prepareToken: string;
        claimToken: string;
    }): Promise<Readonly<{
        allocationId: string;
        credentialSlot: BetaApifyFreeCredentialSlot;
        existing: boolean;
    }>>;
}

function sanitizedCapacityError(): Error {
    return new Error(BETA_APIFY_POOL_CAPACITY_ERROR);
}

function targetSlot(snapshots: readonly BetaApifyPoolSnapshot[]): BetaApifyFreeCredentialSlot {
    // Fit the frozen target-profile budget as tightly as possible. The
    // canonical slot order is the deterministic tie-break for equal residuals.
    const candidates = BETA_APIFY_FREE_CREDENTIAL_SLOTS.map((slot, order) => {
        const snapshot = snapshots.find(candidate => candidate.credentialSlot === slot);
        if (
            !snapshot
            || snapshot.healthState !== 'healthy'
            || snapshot.effectiveHeadroomUsd === null
            || snapshot.manuallyExcluded === true
            || snapshot.freshnessState === 'stale'
            || snapshot.freshnessState === 'missing'
            || snapshot.effectiveHeadroomUsd + Number.EPSILON < BETA_APIFY_TARGET_PROFILE_BUDGET_USD
        ) {
            return null;
        }
        return {
            slot,
            order,
            residual: snapshot.effectiveHeadroomUsd - BETA_APIFY_TARGET_PROFILE_BUDGET_USD,
        };
    }).filter((candidate): candidate is {
        slot: BetaApifyFreeCredentialSlot;
        order: number;
        residual: number;
    } => candidate !== null)
        .sort((left, right) => left.residual - right.residual || left.order - right.order);
    if (candidates[0]) return candidates[0].slot;
    throw sanitizedCapacityError();
}

function isExactHold(value: StoredBetaApifyPreflightHold): boolean {
    return value.targetProfileBudgetUsd === BETA_APIFY_TARGET_PROFILE_BUDGET_USD
        && BETA_APIFY_FREE_CREDENTIAL_SLOTS.includes(value.credentialSlot)
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.allocationId);
}

/**
 * Server-only admission coordinator. It intentionally has no module-time env reads,
 * token selection, or network calls; the worker creates it after request authentication.
 */
export function createBetaApifyPreflightCoordinator(input: {
    store: BetaApifyPreflightCoordinatorStore;
    clientForSlot: (slot: BetaApifyFreeCredentialSlot) => ApifyUserCreditClient;
    env?: Record<string, string | undefined>;
    now?: () => number;
}): BetaApifyPreflightCoordinator {
    const coordinator: BetaApifyPreflightCoordinator = {
        async reuse(preflightId) {
            try {
                if (!getBetaApifyCreditPoolRuntimeConfig(input.env).enabled) {
                    throw sanitizedCapacityError();
                }
            } catch {
                throw sanitizedCapacityError();
            }
            try {
                const existing = await input.store.loadPreflightHold(preflightId);
                if (!existing || !isExactHold(existing) || existing.preflightId.toLowerCase() !== preflightId.toLowerCase()) {
                    throw sanitizedCapacityError();
                }
                return Object.freeze({
                    allocationId: existing.allocationId,
                    credentialSlot: existing.credentialSlot,
                });
            } catch {
                throw sanitizedCapacityError();
            }
        },
        async prepare({
            preflightId,
            userId,
            prepareGeneration,
            prepareToken,
            claimToken,
        }) {
            let config;
            try {
                config = getBetaApifyCreditPoolRuntimeConfig(input.env);
            } catch {
                throw sanitizedCapacityError();
            }
            if (!config.enabled) throw sanitizedCapacityError();

            let existing: StoredBetaApifyPreflightHold | null;
            try {
                existing = await input.store.loadPreflightHold(preflightId);
            } catch {
                throw sanitizedCapacityError();
            }
            if (existing) {
                if (!isExactHold(existing) || existing.preflightId.toLowerCase() !== preflightId.toLowerCase()) throw sanitizedCapacityError();
                try {
                    await input.store.holdPreflight({
                        preflightId,
                        userId,
                        prepareGeneration,
                        prepareToken,
                        claimToken,
                        credentialSlot: existing.credentialSlot,
                        maxSnapshotAgeSeconds: config.maxSnapshotAgeSeconds,
                    });
                } catch {
                    throw sanitizedCapacityError();
                }
                return Object.freeze({
                    allocationId: existing.allocationId,
                    credentialSlot: existing.credentialSlot,
                    existing: true,
                });
            }

            try {
                const observedAt = new Date((input.now ?? Date.now)());
                const refreshed = await refreshBetaApifyCreditPool({
                    clientForSlot: input.clientForSlot,
                    observedAt,
                }, { now: input.now ?? Date.now });
                // One exact-nine write is intentionally completed before any pool read/hold.
                await input.store.upsertSnapshots(refreshed.map(snapshot => ({
                    credentialSlot: snapshot.credentialSlot,
                    monthlyLimitUsd: snapshot.monthlyLimitUsd,
                    monthlyUsageUsd: snapshot.monthlyUsageUsd,
                    billingCycleStartAt: snapshot.billingCycleStartAt,
                    billingCycleEndAt: snapshot.billingCycleEndAt,
                    observedAt: snapshot.observedAt,
                    healthState: snapshot.healthState,
                    effectiveHeadroomUsd: snapshot.effectiveHeadroomUsd,
                })));
                const snapshots = await input.store.loadSnapshots(config.maxSnapshotAgeSeconds);
                const credentialSlot = targetSlot(snapshots);
                const allocation = await input.store.holdPreflight({
                    preflightId,
                    userId,
                    prepareGeneration,
                    prepareToken,
                    claimToken,
                    credentialSlot,
                    maxSnapshotAgeSeconds: config.maxSnapshotAgeSeconds,
                });
                if (
                    allocation.preflightId.toLowerCase() !== preflightId.toLowerCase()
                    || allocation.lifecycleState !== 'preflight_held'
                    || allocation.operationSlotMap !== null
                    || allocation.operationBudgetMap !== null
                ) throw sanitizedCapacityError();
                return Object.freeze({
                    allocationId: allocation.allocationId,
                    credentialSlot,
                    existing: false,
                });
            } catch (error) {
                // All provider, payload and storage faults deliberately collapse to capacity.
                if (error instanceof Error && error.message === BETA_APIFY_POOL_CAPACITY_ERROR) throw error;
                if (error instanceof Error && error.message === BETA_APIFY_CREDIT_REFRESH_ERROR) {
                    throw sanitizedCapacityError();
                }
                throw sanitizedCapacityError();
            }
        },
    };
    return Object.freeze(coordinator);
}

/** Lazily constructs exactly the free-pool user endpoints; secondary is unrepresentable. */
export function createServerBetaApifyCreditClientFactory(
    env: Record<string, string | undefined> = process.env,
    createClient: (
        token: string,
        options: Readonly<{ maxRetries: 0; timeoutSecs: number }>,
    ) => { user(): ApifyUserCreditClient } = (token, options) => new ApifyClient({ token, ...options })
): (slot: BetaApifyFreeCredentialSlot) => ApifyUserCreditClient {
    const tokenKey: Readonly<Record<BetaApifyFreeCredentialSlot, string>> = Object.freeze({
        primary: 'APIFY_PRIMARY_API_TOKEN',
        tertiary: 'APIFY_TERTIARY_API_TOKEN',
        quaternary: 'APIFY_QUATERNARY_API_TOKEN',
        quinary: 'APIFY_QUINARY_API_TOKEN',
        senary: 'APIFY_SENARY_API_TOKEN',
        septenary: 'APIFY_SEPTENARY_API_TOKEN',
        octonary: 'APIFY_OCTONARY_API_TOKEN',
        nonary: 'APIFY_NONARY_API_TOKEN',
        tenth: 'APIFY_TENTH_API_TOKEN',
    });
    const clients = new Map<BetaApifyFreeCredentialSlot, ApifyUserCreditClient>();
    return slot => {
        const existing = clients.get(slot);
        if (existing) return existing;
        const token = (slot === 'primary'
            ? env[tokenKey[slot]]?.trim() || env.APIFY_API_TOKEN?.trim()
            : env[tokenKey[slot]]?.trim());
        if (!token) throw sanitizedCapacityError();
        try {
            const client = createClient(token, { maxRetries: 0, timeoutSecs: 10 }).user();
            clients.set(slot, client);
            return client;
        } catch {
            throw sanitizedCapacityError();
        }
    };
}
