import type { PlanId } from '@/lib/domain/analysis/plan-catalog';

export const EARLYBIRD_PRICING_VERSION = 'earlybird-2026-07-v1' as const;
export const EARLYBIRD_DISCLOSURE_VERSION = 'earlybird-48h-v1' as const;
export const EARLYBIRD_DISCLOSURE_TEXT =
    '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 48시간 이내 판독 결과를 제공합니다.' as const;

export const PAID_EARLYBIRD_PLAN_IDS = ['basic', 'standard'] as const;
export type PaidEarlybirdPlanId = (typeof PAID_EARLYBIRD_PLAN_IDS)[number];

type PaidEarlybirdPlan = Readonly<{
    planId: PaidEarlybirdPlanId;
    referenceAmountKrw: number;
    earlybirdAmountKrw: number;
    serverLimit: 10;
    fulfillment: 'groble_payment';
}>;

type WaitlistEarlybirdPlan = Readonly<{
    planId: 'plus';
    referenceAmountKrw: null;
    earlybirdAmountKrw: null;
    serverLimit: null;
    fulfillment: 'waitlist';
}>;

export const EARLYBIRD_PLAN_CATALOG = Object.freeze({
    basic: Object.freeze({
        planId: 'basic',
        referenceAmountKrw: 39_900,
        earlybirdAmountKrw: 14_900,
        serverLimit: 10,
        fulfillment: 'groble_payment',
    } satisfies PaidEarlybirdPlan),
    standard: Object.freeze({
        planId: 'standard',
        referenceAmountKrw: 69_900,
        earlybirdAmountKrw: 19_900,
        serverLimit: 10,
        fulfillment: 'groble_payment',
    } satisfies PaidEarlybirdPlan),
    plus: Object.freeze({
        planId: 'plus',
        referenceAmountKrw: null,
        earlybirdAmountKrw: null,
        serverLimit: null,
        fulfillment: 'waitlist',
    } satisfies WaitlistEarlybirdPlan),
} satisfies Readonly<Record<PlanId, PaidEarlybirdPlan | WaitlistEarlybirdPlan>>);

export function isPaidEarlybirdPlanId(planId: PlanId): planId is PaidEarlybirdPlanId {
    return planId === 'basic' || planId === 'standard';
}
