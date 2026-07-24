import {
    PLAN_PRICING_VERSION,
    type PlanId,
} from '@/lib/domain/analysis/plan-catalog';
import {
    EARLYBIRD_PLAN_CATALOG,
    isPaidEarlybirdPlanId,
} from '@/lib/domain/earlybird/catalog';
import { parseGrobleSellerReference } from '@/lib/services/earlybird/seller-reference';
import type { PreflightStatusV1 } from '@/lib/contracts/analysis-v2';

type ReadyPreflight = Extract<PreflightStatusV1, { status: 'ready' }>;
type EarlybirdPricingEvent =
    | 'plan_viewed'
    | 'plan_selected'
    | 'checkout_started';

export interface EarlybirdPricingEventProperties extends Record<string, unknown> {
    plan_id: PlanId;
    preflight_id: string;
    required_plan_id?: PlanId;
    amount_krw?: number;
}

export interface EarlybirdPricingRefreshActions {
    reset: () => void;
    clearGirlfriendInstagramId: () => void;
    clearSelectedPlan: () => void;
    clearDisclosureAccepted: () => void;
    clearWaitlistComplete: () => void;
    replaceAnalyzeRoute: () => void;
    showRefreshError: () => void;
}

interface StaleEarlybirdRecoveryDependencies {
    request: (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => Promise<Response>;
    redirectCheckout: (checkoutUrl: string) => void;
    refreshActions: EarlybirdPricingRefreshActions;
}

interface PlanCardAvailability {
    planId: PlanId;
    selectionState: 'required' | 'available_upgrade' | 'unavailable';
    remainingSlots?: number | null;
}

export function resolveEarlybirdPricingBoundary(
    preflight: PreflightStatusV1 | null | undefined
): {
    readyPreflight: ReadyPreflight | null;
    stalePricingPreflightId: string | null;
} {
    if (!preflight || preflight.status !== 'ready') {
        return { readyPreflight: null, stalePricingPreflightId: null };
    }
    if (
        preflight.pricingVersion !== PLAN_PRICING_VERSION
        || preflight.plans.some(plan => plan.pricingVersion !== PLAN_PRICING_VERSION)
    ) {
        return {
            readyPreflight: null,
            stalePricingPreflightId: preflight.preflightId,
        };
    }
    return { readyPreflight: preflight, stalePricingPreflightId: null };
}

export function applyEarlybirdPricingRefreshBoundary(
    stalePricingPreflightId: string | null,
    actions: EarlybirdPricingRefreshActions
): boolean {
    if (!stalePricingPreflightId) return false;
    actions.reset();
    actions.clearGirlfriendInstagramId();
    actions.clearSelectedPlan();
    actions.clearDisclosureAccepted();
    actions.clearWaitlistComplete();
    actions.replaceAnalyzeRoute();
    actions.showRefreshError();
    return true;
}

export async function recoverOrRefreshStaleEarlybirdPricing(
    stalePricingPreflightId: string,
    dependencies: StaleEarlybirdRecoveryDependencies
): Promise<'checkout_recovered' | 'pricing_refresh_required'> {
    try {
        const response = await dependencies.request('/api/earlybird/checkout', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preflightId: stalePricingPreflightId }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (
            response.ok
            && payload
            && typeof payload === 'object'
            && 'checkoutUrl' in payload
            && typeof payload.checkoutUrl === 'string'
            && isSafeGrobleCheckoutUrl(payload.checkoutUrl)
        ) {
            dependencies.redirectCheckout(payload.checkoutUrl);
            return 'checkout_recovered';
        }
    } catch {
        // A stale quote must fall back to the bounded reset path when recovery
        // is unavailable; it must never render or submit the stale snapshot.
    }

    applyEarlybirdPricingRefreshBoundary(
        stalePricingPreflightId,
        dependencies.refreshActions
    );
    return 'pricing_refresh_required';
}

export function emitCurrentEarlybirdPricingEvent(
    event: EarlybirdPricingEvent,
    preflight: PreflightStatusV1 | null | undefined,
    planId: PlanId,
    emit: (properties: EarlybirdPricingEventProperties) => void
): boolean {
    const { readyPreflight } = resolveEarlybirdPricingBoundary(preflight);
    if (!readyPreflight) return false;

    const plan = readyPreflight.plans.find(candidate => candidate.planId === planId);
    if (!plan || plan.selectionState === 'unavailable') return false;
    if (event !== 'plan_selected' && !isPaidEarlybirdPlanId(planId)) return false;
    if (event !== 'plan_selected' && plan.price.status !== 'quoted') return false;

    emit({
        plan_id: planId,
        preflight_id: readyPreflight.preflightId,
        ...(event === 'checkout_started'
            ? {}
            : { required_plan_id: readyPreflight.requiredPlan }),
        ...(plan.price.status === 'quoted'
            ? { amount_krw: plan.price.amountKrw }
            : {}),
    });
    return true;
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
