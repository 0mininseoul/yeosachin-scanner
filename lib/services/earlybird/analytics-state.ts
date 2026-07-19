import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import type { EarlybirdOrderSystemStatus } from './order-status';

export function planViewEventKey(
    preflightId: string,
    pricingVersion: string,
    planId: Extract<PlanId, 'basic' | 'standard'>,
): string {
    return `amplitude:plan_viewed:${preflightId}:${pricingVersion}:${planId}`;
}

export function planSelectedEventKey(
    preflightId: string,
    pricingVersion: string,
    planId: PlanId,
): string {
    return `amplitude:plan_selected:${preflightId}:${pricingVersion}:${planId}`;
}

export function earlybirdStatusEventKey(
    orderId: string,
    status: EarlybirdOrderSystemStatus,
): string {
    return `amplitude:earlybird_status_viewed:${orderId}:${status}`;
}

export function paymentConfirmationEventKey(
    orderId: string,
    status: EarlybirdOrderSystemStatus,
): string | null {
    if (status !== 'paid' && status !== 'analysis_in_progress' && status !== 'completed') {
        return null;
    }
    return `amplitude:payment_confirmed_viewed:${orderId}`;
}
