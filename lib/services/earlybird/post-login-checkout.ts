import type { PlanId } from '@/lib/domain/analysis/plan-catalog';

export const AUTO_CHECKOUT_QUERY_PARAM = 'checkout';

export function isCheckoutContinuationRequested(params: URLSearchParams): boolean {
    return params.get(AUTO_CHECKOUT_QUERY_PARAM) === '1';
}

export function checkoutContinuationPlan(params: URLSearchParams): PlanId | null {
    if (!isCheckoutContinuationRequested(params)) return null;
    const plan = params.get('plan');
    return plan === 'basic' || plan === 'standard' || plan === 'plus' ? plan : null;
}

export function checkoutContinuationKey(preflightId: string, planId: PlanId): string {
    return `${preflightId}:${planId}`;
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
