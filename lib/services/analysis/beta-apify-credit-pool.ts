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

export interface ApifyUserCreditClient {
    limits(): Promise<unknown>;
    monthlyUsage(): Promise<unknown>;
}

export interface BetaApifyAccountCreditReading {
    credentialSlot: BetaApifyFreeCredentialSlot;
    monthlyLimitUsd: number;
    monthlyUsageUsd: number;
    billingCycleStartAt: string;
    billingCycleEndAt: string;
    observedAt: string;
}

export interface BetaApifyEffectiveCredit extends BetaApifyAccountCreditReading {
    activeReservationsUsd: number;
    localPostSnapshotDebitUsd: number;
    effectiveHeadroomUsd: number;
}

type SlotAmounts = Partial<Record<BetaApifyFreeCredentialSlot, number>>;
type UnknownRecord = Record<string, unknown>;

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

export async function readBetaApifyAccountCredit(input: {
    credentialSlot: BetaApifyFreeCredentialSlot;
    client: ApifyUserCreditClient;
    observedAt?: Date;
}): Promise<BetaApifyAccountCreditReading> {
    try {
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

        if (
            limitsCycleStartAt !== usageCycleStartAt
            || limitsCycleEndAt !== usageCycleEndAt
            || Date.parse(limitsCycleStartAt) >= Date.parse(limitsCycleEndAt)
        ) {
            throw new Error(BETA_APIFY_CREDIT_INPUT_ERROR);
        }

        return Object.freeze({
            credentialSlot: input.credentialSlot,
            monthlyLimitUsd,
            monthlyUsageUsd,
            billingCycleStartAt: limitsCycleStartAt,
            billingCycleEndAt: limitsCycleEndAt,
            observedAt: requireTimestamp(input.observedAt ?? new Date()),
        });
    } catch {
        throw new Error(BETA_APIFY_CREDIT_READ_ERROR);
    }
}

export function calculateBetaApifyEffectiveHeadroom(input: {
    monthlyLimitUsd: number;
    monthlyUsageUsd: number;
    activeReservationsUsd: number;
    localPostSnapshotDebitUsd: number;
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
    clientForSlot(slot: BetaApifyFreeCredentialSlot): ApifyUserCreditClient;
    activeReservationsUsdBySlot?: SlotAmounts;
    localPostSnapshotDebitUsdBySlot?: SlotAmounts;
    observedAt?: Date;
}): Promise<readonly BetaApifyEffectiveCredit[]> {
    const observedAt = input.observedAt ?? new Date();
    try {
        const readings = await Promise.all(
            BETA_APIFY_FREE_CREDENTIAL_SLOTS.map(async credentialSlot => {
                const reading = await readBetaApifyAccountCredit({
                    credentialSlot,
                    client: input.clientForSlot(credentialSlot),
                    observedAt,
                });
                const activeReservationsUsd = requireNonNegativeFinite(
                    input.activeReservationsUsdBySlot?.[credentialSlot] ?? 0
                );
                const localPostSnapshotDebitUsd = requireNonNegativeFinite(
                    input.localPostSnapshotDebitUsdBySlot?.[credentialSlot] ?? 0
                );

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
