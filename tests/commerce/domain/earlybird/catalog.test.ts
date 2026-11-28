import { describe, expect, it } from 'vitest';
import {
    EARLYBIRD_DISCLOSURE_TEXT,
    EARLYBIRD_DISCLOSURE_VERSION,
    EARLYBIRD_PLAN_CATALOG,
    EARLYBIRD_PRICING_VERSION,
    isPaidEarlybirdPlanId,
} from '../../../../lib/domain/earlybird/catalog';
import {
    ANALYSIS_PLAN_CATALOG,
    PLAN_PRICING_VERSION,
} from '@/lib/domain/analysis/plan-catalog';

describe('earlybird presale catalog', () => {
    it('owns immutable prices and independent plan limits on the server', () => {
        expect(EARLYBIRD_PRICING_VERSION).toBe('earlybird-2026-11-v6');
        expect(EARLYBIRD_PLAN_CATALOG.basic).toEqual({
            planId: 'basic',
            referenceAmountKrw: 10_900,
            earlybirdAmountKrw: 3_900,
            displayDiscountPercent: 64,
            serverLimit: 10,
            fulfillment: 'groble_payment',
        });
        expect(EARLYBIRD_PLAN_CATALOG.standard).toEqual({
            planId: 'standard',
            referenceAmountKrw: 20_900,
            earlybirdAmountKrw: 6_900,
            displayDiscountPercent: 67,
            serverLimit: 10,
            fulfillment: 'groble_payment',
        });
        expect(EARLYBIRD_PLAN_CATALOG.plus).toEqual({
            planId: 'plus',
            referenceAmountKrw: 34_900,
            earlybirdAmountKrw: 10_900,
            displayDiscountPercent: 69,
            serverLimit: 10,
            fulfillment: 'groble_payment',
        });
    });

    it('keeps the exact disclosure and version that must be persisted', () => {
        expect(EARLYBIRD_DISCLOSURE_VERSION).toBe('earlybird-auto-start-v2');
        expect(EARLYBIRD_DISCLOSURE_TEXT).toBe(
            '결제 확인 후 판독이 자동으로 시작됩니다.'
        );
    });

    it('matches the preflight pricing snapshot catalog exactly', () => {
        expect(EARLYBIRD_PRICING_VERSION).toBe(PLAN_PRICING_VERSION);
        expect(EARLYBIRD_PLAN_CATALOG.basic.earlybirdAmountKrw).toBe(
            ANALYSIS_PLAN_CATALOG.basic.price.amountKrw
        );
        expect(EARLYBIRD_PLAN_CATALOG.standard.earlybirdAmountKrw).toBe(
            ANALYSIS_PLAN_CATALOG.standard.price.amountKrw
        );
        expect(EARLYBIRD_PLAN_CATALOG.plus.earlybirdAmountKrw).toBe(
            ANALYSIS_PLAN_CATALOG.plus.price.amountKrw
        );
    });

    it('recognizes all three checkout plan IDs', () => {
        expect(isPaidEarlybirdPlanId('basic')).toBe(true);
        expect(isPaidEarlybirdPlanId('standard')).toBe(true);
        expect(isPaidEarlybirdPlanId('plus')).toBe(true);
    });
});
