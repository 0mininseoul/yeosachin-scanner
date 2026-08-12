import type { PlanId } from '@/lib/domain/analysis/plan-catalog';

export const EARLYBIRD_PRICING_VERSION = 'earlybird-2026-08-v5' as const;
export const EARLYBIRD_DISCLOSURE_VERSION = 'earlybird-auto-start-v2' as const;
export const EARLYBIRD_DISCLOSURE_TEXT =
    '결제 확인 후 판독이 자동으로 시작됩니다.' as const;

export const PAID_EARLYBIRD_PLAN_IDS = ['basic', 'standard'] as const;
export type PaidEarlybirdPlanId = (typeof PAID_EARLYBIRD_PLAN_IDS)[number];

type PaidEarlybirdPlan = Readonly<{
    planId: PaidEarlybirdPlanId;
    referenceAmountKrw: number;
    earlybirdAmountKrw: number;
    displayDiscountPercent: number;
    serverLimit: 10;
    fulfillment: 'groble_payment';
}>;

type WaitlistEarlybirdPlan = Readonly<{
    planId: 'plus';
    referenceAmountKrw: null;
    earlybirdAmountKrw: null;
    displayDiscountPercent: null;
    serverLimit: null;
    fulfillment: 'waitlist';
}>;

export const EARLYBIRD_PLAN_CATALOG = Object.freeze({
    basic: Object.freeze({
        planId: 'basic',
        referenceAmountKrw: 19_900,
        earlybirdAmountKrw: 9_900,
        displayDiscountPercent: 50,
        serverLimit: 10,
        fulfillment: 'groble_payment',
    } satisfies PaidEarlybirdPlan),
    standard: Object.freeze({
        planId: 'standard',
        referenceAmountKrw: 39_900,
        earlybirdAmountKrw: 19_900,
        displayDiscountPercent: 50,
        serverLimit: 10,
        fulfillment: 'groble_payment',
    } satisfies PaidEarlybirdPlan),
    plus: Object.freeze({
        planId: 'plus',
        referenceAmountKrw: null,
        earlybirdAmountKrw: null,
        displayDiscountPercent: null,
        serverLimit: null,
        fulfillment: 'waitlist',
    } satisfies WaitlistEarlybirdPlan),
} satisfies Readonly<Record<PlanId, PaidEarlybirdPlan | WaitlistEarlybirdPlan>>);

export function isPaidEarlybirdPlanId(planId: PlanId): planId is PaidEarlybirdPlanId {
    return planId === 'basic' || planId === 'standard';
}
