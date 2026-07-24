import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import {
    EARLYBIRD_PLAN_CATALOG,
    isPaidEarlybirdPlanId,
} from '@/lib/domain/earlybird/catalog';
import { parseGrobleSellerReference } from '@/lib/services/earlybird/seller-reference';

interface PlanCardAvailability {
    planId: PlanId;
    selectionState: 'required' | 'available_upgrade' | 'unavailable';
    remainingSlots?: number | null;
}

export function isEarlybirdPlanSoldOut(card: PlanCardAvailability): boolean {
    return typeof card.remainingSlots === 'number' && card.remainingSlots <= 0;
}

export function isEarlybirdPlanSelectable(
    card: PlanCardAvailability,
    requiredPlanId: PlanId
): boolean {
    if (card.selectionState === 'unavailable') return false;
    if (isEarlybirdPlanSoldOut(card)) return false;
    return card.planId !== 'plus' || requiredPlanId === 'plus';
}

function formatKrw(amount: number): string {
    return `${amount.toLocaleString('ko-KR')}원`;
}

export function parseEarlybirdPlanParam(value: string | null): PlanId | null {
    return value === 'basic' || value === 'standard' || value === 'plus' ? value : null;
}

export function resolveAvailableEarlybirdPlan(
    selectedPlanId: PlanId | null,
    planCards: readonly PlanCardAvailability[],
    requiredPlanId: PlanId
): PlanId {
    const selected = planCards.find(card => card.planId === selectedPlanId);
    return selected && isEarlybirdPlanSelectable(selected, requiredPlanId)
        ? selected.planId
        : requiredPlanId;
}

export function canSubmitEarlybirdSelection(
    planId: PlanId,
    disclosureAccepted: boolean,
    available: boolean
): boolean {
    return available && (!isPaidEarlybirdPlanId(planId) || disclosureAccepted);
}

export function buildEarlybirdPlanPresentation(planId: PlanId) {
    const plan = EARLYBIRD_PLAN_CATALOG[planId];
    if (plan.fulfillment === 'waitlist') {
        return Object.freeze({
            referencePriceLabel: null,
            priceLabel: '대기 신청',
            discountLabel: null,
            actionLabel: 'Plus 대기 신청하기',
        });
    }
    const discountRate = Math.round(
        (1 - plan.earlybirdAmountKrw / plan.referenceAmountKrw) * 100
    );
    return Object.freeze({
        referencePriceLabel: formatKrw(plan.referenceAmountKrw),
        priceLabel: formatKrw(plan.earlybirdAmountKrw),
        discountLabel: `${discountRate}%`,
        actionLabel: '얼리버드 사전 구매하기',
    });
}

export function isSafeGrobleCheckoutUrl(value: string): boolean {
    try {
        const url = new URL(value);
        const queryEntries = Array.from(url.searchParams.entries());
        const [queryKey, queryValue] = queryEntries[0] ?? [];
        const canonicalReference = parseGrobleSellerReference(queryValue);
        const rawQuery = url.search.slice(1);

        return url.origin === 'https://groble.im'
            && url.username === ''
            && url.password === ''
            && url.hash === ''
            && /^\/payment\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)
            && queryEntries.length === 1
            && queryKey === 'ref'
            && url.searchParams.getAll('ref').length === 1
            && canonicalReference !== null
            && rawQuery === `ref=${canonicalReference}`;
    } catch {
        return false;
    }
}
