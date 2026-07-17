import { describe, expect, it } from 'vitest';
import {
    EARLYBIRD_DISCLOSURE_TEXT,
    EARLYBIRD_DISCLOSURE_VERSION,
    EARLYBIRD_PLAN_CATALOG,
    EARLYBIRD_PRICING_VERSION,
    isPaidEarlybirdPlanId,
} from './catalog';

describe('earlybird presale catalog', () => {
    it('owns immutable prices and independent plan limits on the server', () => {
        expect(EARLYBIRD_PRICING_VERSION).toBe('earlybird-2026-07-v1');
        expect(EARLYBIRD_PLAN_CATALOG.basic).toEqual({
            planId: 'basic',
            referenceAmountKrw: 39_900,
            earlybirdAmountKrw: 14_900,
            serverLimit: 10,
            fulfillment: 'groble_payment',
        });
        expect(EARLYBIRD_PLAN_CATALOG.standard).toEqual({
            planId: 'standard',
            referenceAmountKrw: 69_900,
            earlybirdAmountKrw: 19_900,
            serverLimit: 10,
            fulfillment: 'groble_payment',
        });
        expect(EARLYBIRD_PLAN_CATALOG.plus).toEqual({
            planId: 'plus',
            referenceAmountKrw: null,
            earlybirdAmountKrw: null,
            serverLimit: null,
            fulfillment: 'waitlist',
        });
    });

    it('keeps the exact disclosure and version that must be persisted', () => {
        expect(EARLYBIRD_DISCLOSURE_VERSION).toBe('earlybird-48h-v1');
        expect(EARLYBIRD_DISCLOSURE_TEXT).toBe(
            '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 48시간 이내 판독 결과를 제공합니다.'
        );
    });

    it('treats Plus as waitlist-only', () => {
        expect(isPaidEarlybirdPlanId('basic')).toBe(true);
        expect(isPaidEarlybirdPlanId('standard')).toBe(true);
        expect(isPaidEarlybirdPlanId('plus')).toBe(false);
    });
});
