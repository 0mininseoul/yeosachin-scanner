import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';

export const BETA_APIFY_FREE_CREDENTIAL_SLOTS = Object.freeze([
    'primary',
    'tertiary',
    'quaternary',
    'quinary',
    'senary',
    'septenary',
] as const satisfies readonly ApifyCredentialSlot[]);

export type BetaApifyFreeCredentialSlot =
    typeof BETA_APIFY_FREE_CREDENTIAL_SLOTS[number];

export const BETA_APIFY_CREDIT_INPUT_ERROR =
    'ANALYSIS_BETA_APIFY_CREDIT_INPUT_ERROR';
export const BETA_APIFY_CREDIT_READ_ERROR =
    'ANALYSIS_BETA_APIFY_CREDIT_READ_ERROR';
export const BETA_APIFY_CREDIT_REFRESH_ERROR =
    'ANALYSIS_BETA_APIFY_CREDIT_REFRESH_ERROR';

const MAX_OBSERVED_AT_FUTURE_SKEW_MS = 60_000;

export interface ApifyUserCreditClient {
    limits(): Promise<unknown>;
    monthlyUsage(): Promise<unknown>;
}

export interface BetaApifyCreditClock {
    readonly now: () => number;
}

export interface BetaApifyAccountCreditReading {
    readonly credentialSlot: BetaApifyFreeCredentialSlot;
    readonly monthlyLimitUsd: number;
    readonly monthlyUsageUsd: number;
    readonly billingCycleStartAt: string;
    readonly billingCycleEndAt: string;
    readonly observedAt: string;
}

export interface BetaApifyEffectiveCredit extends BetaApifyAccountCreditReading {
    readonly activeReservationsUsd: number;
    readonly localPostSnapshotDebitUsd: number;
    readonly effectiveHeadroomUsd: number;
}

export type BetaApifySlotAmounts = Readonly<
    Partial<Record<BetaApifyFreeCredentialSlot, number>>
>;
type CompleteSlotAmounts = Readonly<Record<BetaApifyFreeCredentialSlot, number>>;
type UnknownRecord = Record<string, unknown>;

const SYSTEM_CREDIT_CLOCK: BetaApifyCreditClock = Object.freeze({
    now: () => Date.now(),
});

export function isBetaApifyFreeCredentialSlot(
    value: unknown
): value is BetaApifyFreeCredentialSlot {
    return typeof value === 'string'
        && BETA_APIFY_FREE_CREDENTIAL_SLOTS.includes(
            value as BetaApifyFreeCredentialSlot
        );
}

function requireRecord(value: unknown): UnknownRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(BETA_APIFY_CREDIT_INPUT_ERROR);
    }
    return value as UnknownRecord;
}

function requireNonNegativeFinite(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(BETA_APIFY_CREDIT_INPUT_ERROR);
    }
    return value;
}

function requireTimestamp(value: unknown): string {
    if (!(value instanceof Date) && typeof value !== 'string') {
        throw new Error(BETA_APIFY_CREDIT_INPUT_ERROR);
    }
    const timestamp = value instanceof Date
        ? value.getTime()
        : Date.parse(value);
    if (!Number.isFinite(timestamp)) {
        throw new Error(BETA_APIFY_CREDIT_INPUT_ERROR);
    }
    return new Date(timestamp).toISOString();
}

function requireTimestampMilliseconds(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(BETA_APIFY_CREDIT_INPUT_ERROR);
    }
    return value;
}

function snapshotSlotAmounts(amounts?: BetaApifySlotAmounts): CompleteSlotAmounts {
    return Object.freeze(Object.fromEntries(
        BETA_APIFY_FREE_CREDENTIAL_SLOTS.map(credentialSlot => [
            credentialSlot,
            requireNonNegativeFinite(amounts?.[credentialSlot] ?? 0),
        ])
    ) as Record<BetaApifyFreeCredentialSlot, number>);
}

export async function readBetaApifyAccountCredit(input: {
    readonly credentialSlot: BetaApifyFreeCredentialSlot;
    readonly client: ApifyUserCreditClient;
    readonly observedAt?: Date;
}, clock: BetaApifyCreditClock = SYSTEM_CREDIT_CLOCK): Promise<BetaApifyAccountCreditReading> {
    try {
        const trustedNowMs = requireTimestampMilliseconds(clock.now());
        const observedAt = requireTimestamp(
            input.observedAt ?? new Date(trustedNowMs)
        );
        const observedAtMs = Date.parse(observedAt);
        if (observedAtMs > trustedNowMs + MAX_OBSERVED_AT_FUTURE_SKEW_MS) {
            throw new Error(BETA_APIFY_CREDIT_INPUT_ERROR);
        }
        if (!isBetaApifyFreeCredentialSlot(input.credentialSlot)) {
            throw new Error(BETA_APIFY_CREDIT_INPUT_ERROR);
        }
        const [rawLimits, rawMonthlyUsage] = await Promise.all([
            Promise.resolve().then(() => input.client.limits()),
            Promise.resolve().then(() => input.client.monthlyUsage()),
        ]);
        const limits = requireRecord(rawLimits);
        const monthlyUsage = requireRecord(rawMonthlyUsage);
        const limitFields = requireRecord(limits.limits);
        const currentUsage = requireRecord(limits.current);
        const limitsCycle = requireRecord(limits.monthlyUsageCycle);
        const usageCycle = requireRecord(monthlyUsage.usageCycle);

        const monthlyLimitUsd = requireNonNegativeFinite(
            limitFields.maxMonthlyUsageUsd
        );
        const limitsCurrentUsageUsd = requireNonNegativeFinite(
            currentUsage.monthlyUsageUsd
        );
        const detailedMonthlyUsageUsd = requireNonNegativeFinite(
            monthlyUsage.totalUsageCreditsUsdAfterVolumeDiscount
        );
        const monthlyUsageUsd = Math.max(
            limitsCurrentUsageUsd,
            detailedMonthlyUsageUsd
        );
        const limitsCycleStartAt = requireTimestamp(limitsCycle.startAt);
        const limitsCycleEndAt = requireTimestamp(limitsCycle.endAt);
        const usageCycleStartAt = requireTimestamp(usageCycle.startAt);
        const usageCycleEndAt = requireTimestamp(usageCycle.endAt);
        const billingCycleStartMs = Date.parse(limitsCycleStartAt);
        const billingCycleEndMs = Date.parse(limitsCycleEndAt);

        if (
            limitsCycleStartAt !== usageCycleStartAt
            || limitsCycleEndAt !== usageCycleEndAt
            || billingCycleStartMs >= billingCycleEndMs
            || billingCycleStartMs > observedAtMs
            || observedAtMs >= billingCycleEndMs
        ) {
            throw new Error(BETA_APIFY_CREDIT_INPUT_ERROR);
        }

        return Object.freeze({
            credentialSlot: input.credentialSlot,
            monthlyLimitUsd,
            monthlyUsageUsd,
            billingCycleStartAt: limitsCycleStartAt,
            billingCycleEndAt: limitsCycleEndAt,
            observedAt,
        });
    } catch {
        throw new Error(BETA_APIFY_CREDIT_READ_ERROR);
    }
}

export function calculateBetaApifyEffectiveHeadroom(input: {
    readonly monthlyLimitUsd: number;
    readonly monthlyUsageUsd: number;
    readonly activeReservationsUsd: number;
    readonly localPostSnapshotDebitUsd: number;
}): number {
    const monthlyLimitUsd = requireNonNegativeFinite(input.monthlyLimitUsd);
    const monthlyUsageUsd = requireNonNegativeFinite(input.monthlyUsageUsd);
    const activeReservationsUsd = requireNonNegativeFinite(
        input.activeReservationsUsd
    );
    const localPostSnapshotDebitUsd = requireNonNegativeFinite(
        input.localPostSnapshotDebitUsd
    );

    return Math.max(
        0,
        monthlyLimitUsd
            - monthlyUsageUsd
            - activeReservationsUsd
            - localPostSnapshotDebitUsd
    );
}

export async function refreshBetaApifyCreditPool(input: {
    readonly clientForSlot: (
        slot: BetaApifyFreeCredentialSlot
    ) => ApifyUserCreditClient;
    readonly activeReservationsUsdBySlot?: BetaApifySlotAmounts;
    readonly localPostSnapshotDebitUsdBySlot?: BetaApifySlotAmounts;
    readonly observedAt?: Date;
}, clock: BetaApifyCreditClock = SYSTEM_CREDIT_CLOCK): Promise<readonly BetaApifyEffectiveCredit[]> {
    try {
        const activeReservationsUsdBySlot = snapshotSlotAmounts(
            input.activeReservationsUsdBySlot
        );
        const localPostSnapshotDebitUsdBySlot = snapshotSlotAmounts(
            input.localPostSnapshotDebitUsdBySlot
        );
        const observedAt = input.observedAt ?? new Date(clock.now());
        const readings = await Promise.all(
            BETA_APIFY_FREE_CREDENTIAL_SLOTS.map(async credentialSlot => {
                const reading = await readBetaApifyAccountCredit({
                    credentialSlot,
                    client: input.clientForSlot(credentialSlot),
                    observedAt,
                }, clock);
                const activeReservationsUsd =
                    activeReservationsUsdBySlot[credentialSlot];
                const localPostSnapshotDebitUsd =
                    localPostSnapshotDebitUsdBySlot[credentialSlot];

                return Object.freeze({
                    ...reading,
                    activeReservationsUsd,
                    localPostSnapshotDebitUsd,
                    effectiveHeadroomUsd: calculateBetaApifyEffectiveHeadroom({
                        monthlyLimitUsd: reading.monthlyLimitUsd,
                        monthlyUsageUsd: reading.monthlyUsageUsd,
                        activeReservationsUsd,
                        localPostSnapshotDebitUsd,
                    }),
                });
            })
        );
        return Object.freeze(readings);
    } catch {
        throw new Error(BETA_APIFY_CREDIT_REFRESH_ERROR);
    }
}
