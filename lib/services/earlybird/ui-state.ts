import {
    PLAN_PRICING_VERSION,
    type PlanId,
} from '@/lib/domain/analysis/plan-catalog';
import {
    EARLYBIRD_PLAN_CATALOG,
    isPaidEarlybirdPlanId,
} from '@/lib/domain/earlybird/catalog';
import {
    isSafeEarlybirdCheckoutContinuationUrl,
} from '@/lib/services/earlybird/checkout-continuation';
import type { PreflightStatusV1 } from '@/lib/contracts/analysis-v2';
import {
    availableAnalyticsStorage,
    currentAttributionSource,
} from '@/lib/services/analytics-funnel';

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
    clearWaitlistComplete: () => void;
    replaceAnalyzeRoute: () => void;
    showRefreshError: () => void;
}

interface StaleEarlybirdRecoveryDependencies {
    request: (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => Promise<Response>;
    redirectCheckout: (nextUrl: string) => void;
    refreshActions: EarlybirdPricingRefreshActions;
}

export interface EarlybirdCheckoutRecoveryGuard {
    inFlight: boolean;
}

/**
 * A late checkout response must remain bound to the exact paid-plan selection
 * that submitted it.  Otherwise a stale Standard conflict can offer a resume
 * action after the user has already switched to Basic or Plus.
 */
export interface EarlybirdCheckoutStatusCtaBinding {
    preflightId: string;
    targetInstagramId: string | null;
    planId: PlanId;
}

export function isCurrentEarlybirdCheckoutStatusCta(
    cta: EarlybirdCheckoutStatusCtaBinding | null,
    current: {
        preflightId: string | null | undefined;
        targetInstagramId: string | null;
        planId: PlanId | null;
    }
): boolean {
    return Boolean(
        cta
        && cta.preflightId === current.preflightId
        && cta.targetInstagramId === current.targetInstagramId
        && cta.planId === current.planId
    );
}

interface PendingEarlybirdRecoveryDependencies {
    request: (
        input: RequestInfo | URL,
        init?: RequestInit
    ) => Promise<Response>;
    redirectCheckout: (nextUrl: string) => void;
    setPending: (pending: boolean) => void;
    showError: (message: string) => void;
}

export interface EarlybirdCheckoutLineageStatusAction {
    path: string;
    kind: 'active_pending' | 'status_only';
}

function isEarlybirdCheckoutLineageSubreason(value: unknown): boolean {
    return value === 'STALE_PRICING_LINEAGE' || value === 'SUPERSEDED_LINEAGE';
}

/**
 * Only database-classified blocked lineages get a status CTA. In particular,
 * a cancelled unresolved lineage deliberately has no checkout-recovery action.
 */
export function earlybirdCheckoutLineageStatusAction(
    status: number,
    payload: unknown,
    planId: PlanId
): EarlybirdCheckoutLineageStatusAction | null {
    if (
        status !== 409
        || !isPaidEarlybirdPlanId(planId)
        || !payload
        || typeof payload !== 'object'
        || !('code' in payload)
        || !('subreason' in payload)
        || !isEarlybirdCheckoutLineageSubreason(payload.subreason)
    ) {
        return null;
    }
    if (payload.code === 'EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE') {
        return payload.subreason === 'SUPERSEDED_LINEAGE'
            ? { path: `/earlybird?plan=${planId}&resume=0`, kind: 'status_only' }
            : { path: `/earlybird?plan=${planId}`, kind: 'active_pending' };
    }
    if (payload.code === 'EARLYBIRD_CHECKOUT_CANCELLED_UNRESOLVED_LINEAGE') {
        return { path: `/earlybird?plan=${planId}&resume=0`, kind: 'status_only' };
    }
    return null;
}

export function pendingEarlybirdCheckoutStatusPath(
    status: number,
    payload: unknown,
    planId: PlanId
): string | null {
    const action = earlybirdCheckoutLineageStatusAction(status, payload, planId);
    return action?.kind === 'active_pending' ? action.path : null;
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
    actions.clearWaitlistComplete();
    actions.replaceAnalyzeRoute();
    actions.showRefreshError();
    return true;
}

export async function recoverOrRefreshStaleEarlybirdPricing(
    stalePricingPreflightId: string,
    planId: 'basic' | 'standard',
    dependencies: StaleEarlybirdRecoveryDependencies
): Promise<'checkout_recovered' | 'pricing_refresh_required'> {
    try {
        const response = await dependencies.request('/api/earlybird/checkout', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preflightId: stalePricingPreflightId, planId }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (
            response.ok
            && payload
            && typeof payload === 'object'
            && 'nextUrl' in payload
            && typeof payload.nextUrl === 'string'
            && isSafeEarlybirdCheckoutContinuationUrl(payload.nextUrl)
        ) {
            dependencies.redirectCheckout(payload.nextUrl);
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

function pendingCheckoutRecoveryErrorMessage(code: string | null): string {
    if (code === 'CHECKOUT_PHONE_REQUIRED' || code === 'UNAUTHORIZED') {
        return '카카오 전화번호 확인이 만료되었습니다. 다시 로그인한 뒤 시도해주세요.';
    }
    if (code === 'EARLYBIRD_CHECKOUT_NOT_RECOVERABLE') {
        return '현재 주문은 결제를 이어갈 수 없습니다. 새로고침 후 상태를 확인해주세요.';
    }
    if (code === 'EARLYBIRD_CHECKOUT_RECOVERY_NOT_FOUND') {
        return '이어갈 결제 내역을 찾지 못했습니다. 새로고침 후 다시 확인해주세요.';
    }
    return '결제창을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.';
}

export async function recoverPendingEarlybirdCheckout(
    preflightId: string,
    planId: 'basic' | 'standard',
    guard: EarlybirdCheckoutRecoveryGuard,
    dependencies: PendingEarlybirdRecoveryDependencies
): Promise<'checkout_recovered' | 'already_in_progress' | 'recovery_failed'> {
    if (guard.inFlight) return 'already_in_progress';
    guard.inFlight = true;
    dependencies.setPending(true);
    try {
        const response = await dependencies.request('/api/earlybird/checkout', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preflightId, planId }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (
            response.ok
            && payload
            && typeof payload === 'object'
            && 'nextUrl' in payload
            && typeof payload.nextUrl === 'string'
            && isSafeEarlybirdCheckoutContinuationUrl(payload.nextUrl)
        ) {
            dependencies.redirectCheckout(payload.nextUrl);
            return 'checkout_recovered';
        }
        const code = payload
            && typeof payload === 'object'
            && 'code' in payload
            && typeof payload.code === 'string'
            ? payload.code
            : null;
        dependencies.showError(pendingCheckoutRecoveryErrorMessage(code));
        return 'recovery_failed';
    } catch {
        dependencies.showError(pendingCheckoutRecoveryErrorMessage(null));
        return 'recovery_failed';
    } finally {
        guard.inFlight = false;
        dependencies.setPending(false);
    }
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
        ...(currentAttributionSource(availableAnalyticsStorage())
            ? { source: 'shared' }
            : {}),
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
    return Object.freeze({
        referencePriceLabel: formatKrw(plan.referenceAmountKrw),
        priceLabel: formatKrw(plan.earlybirdAmountKrw),
        discountLabel: `${plan.displayDiscountPercent}% OFF`,
        actionLabel: '지금 분석하기',
    });
}

export { isSafeEarlybirdCheckoutContinuationUrl } from '@/lib/services/earlybird/checkout-continuation';
