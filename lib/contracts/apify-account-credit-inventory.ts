import { z } from 'zod';
import { APIFY_CREDENTIAL_SLOTS } from '@/lib/services/instagram/providers/types';

const MAX_USD = 100_000;
const TIMESTAMP = z.string().datetime({ offset: true });
const nullableUsd = z.number().finite().min(0).max(MAX_USD).nullable();

export const apifyCredentialSlotSchema = z.enum(APIFY_CREDENTIAL_SLOTS);

/** A single sanitized, provider-independent Apify account credit row. */
export const apifyAccountCreditInventoryRowSchema = z.object({
    credentialSlot: apifyCredentialSlotSchema,
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
    } else if (row.freshnessState === 'fresh' && row.effectiveRemainingUsd === null) {
        context.addIssue({
            code: 'custom',
            path: ['effectiveRemainingUsd'],
            message: 'Fresh credit data must include current remaining capacity.',
        });
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

/** Strict all-ten projection with canonical ordering and slot roles. */
export const apifyAccountCreditInventorySchema = z.array(apifyAccountCreditInventoryRowSchema)
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

export type ApifyAccountCreditInventoryRow = z.infer<
    typeof apifyAccountCreditInventoryRowSchema
>;
