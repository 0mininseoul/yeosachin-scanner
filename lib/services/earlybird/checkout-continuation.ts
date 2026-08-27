import type { PlanId } from '@/lib/domain/analysis/plan-catalog';

export const EARLYBIRD_CHECKOUT_REDIRECT_PATH =
    '/api/earlybird/checkout/redirect';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKOUT_PLAN_PATTERN = /^(?:basic|standard)$/;
const ANALYSIS_PROGRESS_PATH_PATTERN = /^\/progress\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type EarlybirdCheckoutPlanId = Extract<PlanId, 'basic' | 'standard'>;

function isCheckoutPlanId(value: unknown): value is EarlybirdCheckoutPlanId {
    return typeof value === 'string' && CHECKOUT_PLAN_PATTERN.test(value);
}

export function buildEarlybirdCheckoutContinuationUrl(input: {
    orderId: string;
    planId: EarlybirdCheckoutPlanId;
}): string {
    if (!UUID_PATTERN.test(input.orderId) || !isCheckoutPlanId(input.planId)) {
        throw new Error('EARLYBIRD_CHECKOUT_CONTINUATION_INVALID');
    }
    return `${EARLYBIRD_CHECKOUT_REDIRECT_PATH}?orderId=${input.orderId.toLowerCase()}&planId=${input.planId}`;
}

/** Browser-side allowlist: only the exact relative continuation is navigable. */
export function isSafeEarlybirdCheckoutContinuationUrl(value: string): boolean {
    if (typeof value !== 'string' || !value.startsWith('/')) return false;
    try {
        const url = new URL(value, 'https://yeosachin.invalid');
        if (
            url.origin !== 'https://yeosachin.invalid'
            || url.username !== ''
            || url.password !== ''
            || url.hash !== ''
            || url.pathname !== EARLYBIRD_CHECKOUT_REDIRECT_PATH
        ) return false;
        const query = url.search;
        const match = query.match(
            /^\?orderId=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})&planId=(basic|standard)$/
        );
        return Boolean(match)
            && match?.[1] === match?.[1].toLowerCase()
            && UUID_PATTERN.test(match?.[1] ?? '')
            && isCheckoutPlanId(match?.[2]);
    } catch {
        return false;
    }
}

/**
 * The operator-only synthetic checkout returns a local progress path instead
 * of a payment continuation. Keep that compatibility branch exact and local.
 */
export function isSafeEarlybirdDemoProgressUrl(value: string): boolean {
    return typeof value === 'string'
        && ANALYSIS_PROGRESS_PATH_PATTERN.test(value)
        && value === value.toLowerCase();
}

export function parseEarlybirdCheckoutContinuationQuery(
    orderId: string | null,
    planId: string | null,
): { orderId: string; planId: EarlybirdCheckoutPlanId } | null {
    if (!orderId || !UUID_PATTERN.test(orderId) || !isCheckoutPlanId(planId)) {
        return null;
    }
    return {
        orderId: orderId.toLowerCase(),
        planId,
    };
}
