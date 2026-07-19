import { describe, expect, it } from 'vitest';
import {
    earlybirdStatusEventKey,
    paymentConfirmationEventKey,
    planSelectedEventKey,
    planViewEventKey,
} from './analytics-state';

const PREFLIGHT_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';

describe('earlybird analytics state', () => {
    it('keys each selectable plan view by preflight and pricing snapshot', () => {
        expect(planViewEventKey(PREFLIGHT_ID, 'earlybird-2026-07-v1', 'basic')).toBe(
            `amplitude:plan_viewed:${PREFLIGHT_ID}:earlybird-2026-07-v1:basic`,
        );
        expect(planViewEventKey(PREFLIGHT_ID, 'earlybird-2026-07-v1', 'standard')).toBe(
            `amplitude:plan_viewed:${PREFLIGHT_ID}:earlybird-2026-07-v1:standard`,
        );
    });

    it('keys explicit plan selection independently from visibility', () => {
        expect(planSelectedEventKey(PREFLIGHT_ID, 'earlybird-2026-07-v1', 'standard')).toBe(
            `amplitude:plan_selected:${PREFLIGHT_ID}:earlybird-2026-07-v1:standard`,
        );
    });

    it('keys status visibility per durable order state', () => {
        expect(earlybirdStatusEventKey(ORDER_ID, 'payment_pending')).toBe(
            `amplitude:earlybird_status_viewed:${ORDER_ID}:payment_pending`,
        );
    });

    it.each(['paid', 'analysis_in_progress', 'completed'] as const)(
        'allows a payment confirmation key for %s',
        (status) => {
            expect(paymentConfirmationEventKey(ORDER_ID, status)).toBe(
                `amplitude:payment_confirmed_viewed:${ORDER_ID}`,
            );
        },
    );

    it.each([
        'payment_pending',
        'payment_failed',
        'overflow_refund_required',
        'cancelled',
        'refund_pending',
        'refunded',
    ] as const)('does not treat %s as payment confirmation', (status) => {
        expect(paymentConfirmationEventKey(ORDER_ID, status)).toBeNull();
    });
});
