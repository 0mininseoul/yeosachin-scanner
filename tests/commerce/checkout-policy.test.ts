import { describe, expect, it } from "vitest";
import { earlybirdStatusEventKey, paymentConfirmationEventKey, planSelectedEventKey, planViewEventKey } from "../../lib/services/earlybird/analytics-state";
import { isEarlybirdAutoAdmissionEligible, readEarlybirdAutoAdmissionConfig } from "../../lib/services/earlybird/auto-admission-config";
import { GROBLE_SELLER_REFERENCE_PATTERN, parseGrobleSellerReference } from "../../lib/services/earlybird/seller-reference";

describe("analytics-state", () => {
    const PREFLIGHT_ID = '11111111-1111-4111-8111-111111111111';
    const ORDER_ID = '22222222-2222-4222-8222-222222222222';

    describe('earlybird analytics state', () => {
        it('keys each selectable plan view by preflight and pricing snapshot', () => {
            expect(planViewEventKey(PREFLIGHT_ID, 'earlybird-2026-07-v2', 'basic')).toBe(
                `amplitude:plan_viewed:${PREFLIGHT_ID}:earlybird-2026-07-v2:basic`,
            );
            expect(planViewEventKey(PREFLIGHT_ID, 'earlybird-2026-07-v2', 'standard')).toBe(
                `amplitude:plan_viewed:${PREFLIGHT_ID}:earlybird-2026-07-v2:standard`,
            );
        });

        it('keys explicit plan selection independently from visibility', () => {
            expect(planSelectedEventKey(PREFLIGHT_ID, 'earlybird-2026-07-v2', 'standard')).toBe(
                `amplitude:plan_selected:${PREFLIGHT_ID}:earlybird-2026-07-v2:standard`,
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
});

describe("auto-admission-config", () => {
    describe('earlybird webhook auto-admission config', () => {
        it('treats an unset or explicitly disabled gate as concierge-only', () => {
            expect(readEarlybirdAutoAdmissionConfig({})).toEqual({
                enabled: false,
                notBeforeMs: null,
            });
            expect(readEarlybirdAutoAdmissionConfig({
                EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'false',
                EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE: 'not-a-timestamp',
            })).toEqual({
                enabled: false,
                notBeforeMs: null,
            });
        });

        it('requires an exact true gate and an offset-bearing cutoff', () => {
            expect(() => readEarlybirdAutoAdmissionConfig({
                EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'yes',
            })).toThrow('EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED_INVALID');
            expect(() => readEarlybirdAutoAdmissionConfig({
                EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'true',
            })).toThrow('EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE_INVALID');
            expect(() => readEarlybirdAutoAdmissionConfig({
                EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'true',
                EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE: '2026-08-27T04:40:00',
            })).toThrow('EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE_INVALID');
        });

        it('uses paid-at at or after the configured cutoff and rejects malformed timestamps', () => {
            const config = readEarlybirdAutoAdmissionConfig({
                EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'true',
                EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE: '2026-08-27T04:40:00Z',
            });

            expect(isEarlybirdAutoAdmissionEligible('2026-08-27T04:40:00Z', config)).toBe(true);
            expect(isEarlybirdAutoAdmissionEligible('2026-08-27T04:39:59.999Z', config)).toBe(false);
            expect(isEarlybirdAutoAdmissionEligible('not-a-timestamp', config)).toBe(false);
            expect(isEarlybirdAutoAdmissionEligible('2026-08-27T04:40:00', config)).toBe(false);
            expect(isEarlybirdAutoAdmissionEligible(null, config)).toBe(false);
        });
    });
});

describe("seller-reference", () => {
    const VALID_REFERENCE = `ord.${'a1'.repeat(16)}`;

    describe('Groble seller references', () => {
        it('accepts only the opaque order reference issued by the application', () => {
            expect(GROBLE_SELLER_REFERENCE_PATTERN.test(VALID_REFERENCE)).toBe(true);
            expect(parseGrobleSellerReference(VALID_REFERENCE)).toBe(VALID_REFERENCE);
        });

        it.each([
            null,
            undefined,
            123,
            '',
            ` ${VALID_REFERENCE}`,
            `${VALID_REFERENCE} `,
            `ORD.${'a1'.repeat(16)}`,
            `ord.${'A1'.repeat(16)}`,
            `ord.${'a1'.repeat(15)}`,
            `ord.${'a1'.repeat(17)}`,
            `ord-${'a1'.repeat(16)}`,
            'ord.customer@example.com',
            'ord.01012345678',
            'ord.한글',
            'ord.a+b',
            'ord.a/b',
            'ord.a=b',
            'ord.a_b',
            'ord.a:b',
            'ord.a~b',
        ])('rejects non-opaque or malformed value %#', value => {
            expect(parseGrobleSellerReference(value)).toBeNull();
        });
    });
});
