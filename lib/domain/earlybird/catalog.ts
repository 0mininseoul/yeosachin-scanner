import type { PlanId } from '@/lib/domain/analysis/plan-catalog';

export const EARLYBIRD_PRICING_VERSION = 'earlybird-2026-11-v6' as const;
export const EARLYBIRD_DISCLOSURE_VERSION = 'earlybird-auto-start-v2' as const;
export const EARLYBIRD_DISCLOSURE_TEXT =
    '결제 확인 후 판독이 자동으로 시작됩니다.' as const;

export const PAID_EARLYBIRD_PLAN_IDS = ['basic', 'standard', 'plus'] as const;
export type PaidEarlybirdPlanId = (typeof PAID_EARLYBIRD_PLAN_IDS)[number];

type PaidEarlybirdPlan = Readonly<{
    planId: PaidEarlybirdPlanId;
    referenceAmountKrw: number;
    earlybirdAmountKrw: number;
    displayDiscountPercent: number;
    serverLimit: 10;
    fulfillment: 'groble_payment';
}>;

export const EARLYBIRD_PLAN_CATALOG = Object.freeze({
    basic: Object.freeze({
        planId: 'basic',
        referenceAmountKrw: 10_900,
        earlybirdAmountKrw: 3_900,
        displayDiscountPercent: 64,
        serverLimit: 10,
        fulfillment: 'groble_payment',
    } satisfies PaidEarlybirdPlan),
    standard: Object.freeze({
        planId: 'standard',
        referenceAmountKrw: 20_900,
        earlybirdAmountKrw: 6_900,
        displayDiscountPercent: 67,
        serverLimit: 10,
        fulfillment: 'groble_payment',
    } satisfies PaidEarlybirdPlan),
    plus: Object.freeze({
        planId: 'plus',
        referenceAmountKrw: 34_900,
        earlybirdAmountKrw: 10_900,
        displayDiscountPercent: 69,
        serverLimit: 10,
        fulfillment: 'groble_payment',
    } satisfies PaidEarlybirdPlan),
} satisfies Readonly<Record<PlanId, PaidEarlybirdPlan>>);

export function isPaidEarlybirdPlanId(planId: PlanId): planId is PaidEarlybirdPlanId {
    return planId === 'basic' || planId === 'standard' || planId === 'plus';
}
