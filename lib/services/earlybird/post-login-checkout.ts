import type { PlanId } from '@/lib/domain/analysis/plan-catalog';

export const AUTO_CHECKOUT_QUERY_PARAM = 'checkout';

const PREFLIGHT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCheckoutContinuationRequested(params: URLSearchParams): boolean {
    return params.get(AUTO_CHECKOUT_QUERY_PARAM) === '1';
}

export function checkoutContinuationPlan(params: URLSearchParams): PlanId | null {
    if (!isCheckoutContinuationRequested(params)) return null;
    const plan = params.get('plan');
    return plan === 'basic' || plan === 'standard' || plan === 'plus' ? plan : null;
}

/**
 * Identifies the complete browser-bound checkout intent before React has
 * restored the preflight snapshot. This is a rendering gate only; the server
 * still authenticates the user and validates the preflight before checkout.
 */
export function hasCheckoutContinuationIntent(params: URLSearchParams): boolean {
    const preflightId = params.get('preflight');
    return Boolean(
        preflightId
        && PREFLIGHT_ID_PATTERN.test(preflightId)
        && checkoutContinuationPlan(params)
    );
}

export function checkoutContinuationKey(preflightId: string, planId: PlanId): string {
    return `${preflightId}:${planId}`;
}

export function shouldClearAutoCheckoutUiPending(input: {
    autoCheckoutAttempt: boolean;
    checkoutRedirectStarted: boolean;
}): boolean {
    return input.autoCheckoutAttempt && !input.checkoutRedirectStarted;
}

export function shouldAutoSubmitEarlybirdAction(input: {
    requested: boolean;
    authenticated: boolean;
    ready: boolean;
    preflightId: string | null;
    requestedPreflightId: string | null;
    requestedPlanId: PlanId | null;
    planId: PlanId | null;
    exclusionDecided: boolean;
    planAvailable: boolean;
    submitting: boolean;
    attemptedKey: string | null;
}): boolean {
    if (
        !input.requested
        || !input.authenticated
        || !input.ready
        || !input.preflightId
        || !input.requestedPreflightId
        || !input.requestedPlanId
        || !input.planId
        || input.requestedPreflightId !== input.preflightId
        || input.requestedPlanId !== input.planId
        || !input.exclusionDecided
        || !input.planAvailable
        || input.submitting
    ) return false;

    return input.attemptedKey !== checkoutContinuationKey(input.preflightId, input.planId);
}
