import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    buildEarlybirdPlanPresentation,
    canSubmitEarlybirdSelection,
    isEarlybirdPlanSelectable,
    isEarlybirdPlanSoldOut,
    isSafeGrobleCheckoutUrl,
    parseEarlybirdPlanParam,
    resolveAvailableEarlybirdPlan,
} from './ui-state';
import { EARLYBIRD_DISCLOSURE_TEXT } from '@/lib/domain/earlybird/catalog';

const planCards = [
    { planId: 'basic', selectionState: 'unavailable' },
    { planId: 'standard', selectionState: 'required' },
    { planId: 'plus', selectionState: 'available_upgrade' },
] as const;

describe('earlybird analyze UI state', () => {
    it('accepts only known deep-link plan values', () => {
        expect(parseEarlybirdPlanParam('basic')).toBe('basic');
        expect(parseEarlybirdPlanParam('standard')).toBe('standard');
        expect(parseEarlybirdPlanParam('plus')).toBe('plus');
        expect(parseEarlybirdPlanParam('enterprise')).toBeNull();
        expect(parseEarlybirdPlanParam(null)).toBeNull();
    });

    it('falls back from unavailable Basic to the server-required Standard plan', () => {
        expect(resolveAvailableEarlybirdPlan('basic', planCards, 'standard')).toBe('standard');
        expect(resolveAvailableEarlybirdPlan('standard', planCards, 'standard')).toBe('standard');
        expect(resolveAvailableEarlybirdPlan('plus', planCards, 'standard')).toBe('standard');
        expect(isEarlybirdPlanSelectable(planCards[2], 'standard')).toBe(false);
        expect(isEarlybirdPlanSelectable(
            { planId: 'plus', selectionState: 'required' },
            'plus'
        )).toBe(true);
    });

    it('treats a plan with zero remaining slots as sold out, but not one with stock or unset slots', () => {
        expect(isEarlybirdPlanSoldOut({ planId: 'standard', selectionState: 'required', remainingSlots: 0 })).toBe(true);
        expect(isEarlybirdPlanSoldOut({ planId: 'standard', selectionState: 'required', remainingSlots: 1 })).toBe(false);
        expect(isEarlybirdPlanSoldOut({ planId: 'standard', selectionState: 'required', remainingSlots: undefined })).toBe(false);
        expect(isEarlybirdPlanSoldOut({ planId: 'standard', selectionState: 'required', remainingSlots: null })).toBe(false);
        expect(isEarlybirdPlanSoldOut({ planId: 'standard', selectionState: 'required' })).toBe(false);
    });

    it('blocks selection of a sold-out plan even when its selectionState is required', () => {
        expect(isEarlybirdPlanSelectable(
            { planId: 'standard', selectionState: 'required', remainingSlots: 0 },
            'standard'
        )).toBe(false);
        expect(isEarlybirdPlanSelectable(
            { planId: 'standard', selectionState: 'required', remainingSlots: 1 },
            'standard'
        )).toBe(true);
        expect(isEarlybirdPlanSelectable(
            { planId: 'standard', selectionState: 'required' },
            'standard'
        )).toBe(true);
    });

    it('falls back from a sold-out selected upgrade plan to the server-required plan', () => {
        const cardsWithSoldOutUpgrade = [
            { planId: 'basic', selectionState: 'required' },
            { planId: 'standard', selectionState: 'available_upgrade', remainingSlots: 0 },
            { planId: 'plus', selectionState: 'available_upgrade' },
        ] as const;
        expect(resolveAvailableEarlybirdPlan('standard', cardsWithSoldOutUpgrade, 'basic')).toBe('basic');
    });

    it('requires the exact disclosure consent only for paid plans', () => {
        expect(EARLYBIRD_DISCLOSURE_TEXT).toBe(
            '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 48시간 이내 판독 결과를 제공합니다.'
        );
        expect(canSubmitEarlybirdSelection('basic', false, true)).toBe(false);
        expect(canSubmitEarlybirdSelection('basic', true, true)).toBe(true);
        expect(canSubmitEarlybirdSelection('standard', true, false)).toBe(false);
        expect(canSubmitEarlybirdSelection('plus', false, true)).toBe(true);
    });

    it('presents reference, earlybird, and waitlist pricing without invented wording', () => {
        expect(buildEarlybirdPlanPresentation('basic')).toEqual({
            referencePriceLabel: '39,900원',
            priceLabel: '14,900원',
            discountLabel: '63%',
            actionLabel: '얼리버드 사전 구매하기',
        });
        expect(buildEarlybirdPlanPresentation('standard')).toMatchObject({
            referencePriceLabel: '69,900원',
            priceLabel: '19,900원',
            discountLabel: '72%',
        });
        expect(buildEarlybirdPlanPresentation('plus')).toEqual({
            referencePriceLabel: null,
            priceLabel: '대기 신청',
            discountLabel: null,
            actionLabel: 'Plus 대기 신청하기',
        });
    });

    it('allows browser navigation only to Groble payment URLs', () => {
        expect(isSafeGrobleCheckoutUrl('https://groble.im/payment/basic_product-01')).toBe(true);
        expect(isSafeGrobleCheckoutUrl('https://www.groble.im/payment/basic_product-01')).toBe(false);
        expect(isSafeGrobleCheckoutUrl('https://groble.im/products/basic_product-01')).toBe(false);
        expect(isSafeGrobleCheckoutUrl('javascript:alert(1)')).toBe(false);
        expect(isSafeGrobleCheckoutUrl('https://groble.im.evil.example/payment/basic')).toBe(false);
    });

    it('removes the old automatic-analysis action and banned copy from the purchase page', () => {
        const source = readFileSync(new URL('../../../app/analyze/page.tsx', import.meta.url), 'utf8');
        expect(source).not.toContain('startAnalysis(');
        expect(source).not.toContain('판독 시작하기');
        expect(source).not.toContain('결제 접수 준비 중');
        expect(source).not.toContain(['정식 출시', ' 예정가'].join(''));
        expect(source).not.toContain(['예약', '금'].join(''));
        expect(source).toContain('EARLYBIRD_DISCLOSURE_TEXT');
    });

    it('orders the plan card ternary so the sold-out copy branch precedes the not-yet-open branch', () => {
        const source = readFileSync(new URL('../../../app/analyze/page.tsx', import.meta.url), 'utf8');
        const soldOutCardCopyIndex = source.indexOf('얼리버드 물량이 모두 소진되었어요.');
        const notYetOpenCopyIndex = source.indexOf('아직 오픈 전인 플랜이에요.');
        expect(soldOutCardCopyIndex).toBeGreaterThan(-1);
        expect(notYetOpenCopyIndex).toBeGreaterThan(-1);
        expect(soldOutCardCopyIndex).toBeLessThan(notYetOpenCopyIndex);
    });

    // This is a coarse source scan, not a behavioral test (this repo has no
    // jsdom/@testing-library, so the hook can't be exercised directly). It
    // only pins that the stale-preflight refresh after a checkout failure is
    // gated on the exact EARLYBIRD_SOLD_OUT code, and that there is no other,
    // unconditional call site — it fails if that gate is removed or
    // broadened (e.g. to "any error code"), but it cannot verify the runtime
    // ordering of setError vs. the refresh.
    it('gates the post-checkout-failure preflight refresh on the exact EARLYBIRD_SOLD_OUT code', () => {
        const source = readFileSync(new URL('../../../app/analyze/page.tsx', import.meta.url), 'utf8');
        const soldOutCodeIndex = source.indexOf("'EARLYBIRD_SOLD_OUT'");
        const refreshCallToken = 'await refreshPreflight()';
        const refreshCallIndex = source.indexOf(refreshCallToken);
        expect(soldOutCodeIndex).toBeGreaterThan(-1);
        expect(refreshCallIndex).toBeGreaterThan(-1);
        // The exact-code check must precede the refresh call it guards.
        expect(soldOutCodeIndex).toBeLessThan(refreshCallIndex);
        // The two must sit in the same small block (no unrelated code
        // gating the refresh from somewhere else in the file).
        expect(refreshCallIndex - soldOutCodeIndex).toBeLessThan(600);
        // There must be exactly one refresh call site, so it can't be moved
        // outside the gate elsewhere while leaving this occurrence intact.
        expect(source.indexOf(refreshCallToken, refreshCallIndex + 1)).toBe(-1);
    });
});
