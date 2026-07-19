import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    buildEarlybirdPlanPresentation,
    canSubmitEarlybirdSelection,
    isEarlybirdPlanSelectable,
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
});
