import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    applyEarlybirdPricingRefreshBoundary,
    buildEarlybirdPlanPresentation,
    canSubmitEarlybirdSelection,
    emitCurrentEarlybirdPricingEvent,
    isEarlybirdPlanSelectable,
    isEarlybirdPlanSoldOut,
    isSafeGrobleCheckoutUrl,
    parseEarlybirdPlanParam,
    resolveAvailableEarlybirdPlan,
    resolveEarlybirdPricingBoundary,
} from './ui-state';
import { EARLYBIRD_DISCLOSURE_TEXT } from '@/lib/domain/earlybird/catalog';
import { getGrobleCheckoutUrl, readGrobleConfig } from '@/lib/services/groble/config';
import type { PreflightStatusV1 } from '@/lib/contracts/analysis-v2';

const planCards = [
    { planId: 'basic', selectionState: 'unavailable' },
    { planId: 'standard', selectionState: 'required' },
    { planId: 'plus', selectionState: 'available_upgrade' },
] as const;

function readyPreflight(
    pricingVersion: string,
    basicAmount: number,
    standardAmount: number
): Extract<PreflightStatusV1, { status: 'ready' }> {
    return {
        schemaVersion: 1,
        preflightId: '10000000-0000-4000-8000-000000000001',
        expiresAt: '2026-07-25T12:00:00.000Z',
        status: 'ready',
        exclusionDecision: 'skip',
        target: {
            username: 'pricing_target',
            fullName: null,
            bio: null,
            profileImage: null,
            followersCount: 300,
            followingCount: 300,
            isPrivate: false,
        },
        accessMode: 'production',
        capacityRequiredPlan: 'basic',
        requiredPlan: 'basic',
        pricingVersion,
        plans: [
            {
                planId: 'basic',
                launchStatus: 'production',
                relationshipCapacity: { followers: 400, following: 400 },
                detailedMutualLimit: 300,
                selectionState: 'required',
                unavailableReason: null,
                pricingVersion,
                price: { status: 'quoted', currency: 'KRW', amountKrw: basicAmount },
                remainingSlots: 10,
            },
            {
                planId: 'standard',
                launchStatus: 'production',
                relationshipCapacity: { followers: 800, following: 800 },
                detailedMutualLimit: 600,
                selectionState: 'available_upgrade',
                unavailableReason: null,
                pricingVersion,
                price: { status: 'quoted', currency: 'KRW', amountKrw: standardAmount },
                remainingSlots: 10,
            },
            {
                planId: 'plus',
                launchStatus: 'production',
                relationshipCapacity: { followers: 1_200, following: 1_200 },
                detailedMutualLimit: 900,
                selectionState: 'available_upgrade',
                unavailableReason: null,
                pricingVersion,
                price: { status: 'deferred', currency: 'KRW', amountKrw: null },
                remainingSlots: null,
            },
        ],
    };
}

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
            '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 24시간 이내 판독 결과를 제공합니다.'
        );
        expect(canSubmitEarlybirdSelection('basic', false, true)).toBe(false);
        expect(canSubmitEarlybirdSelection('basic', true, true)).toBe(true);
        expect(canSubmitEarlybirdSelection('standard', true, false)).toBe(false);
        expect(canSubmitEarlybirdSelection('plus', false, true)).toBe(true);
    });

    it('presents reference, earlybird, and waitlist pricing without invented wording', () => {
        expect(buildEarlybirdPlanPresentation('basic')).toEqual({
            referencePriceLabel: '13,900원',
            priceLabel: '6,900원',
            discountLabel: '50%',
            actionLabel: '얼리버드 사전 구매하기',
        });
        expect(buildEarlybirdPlanPresentation('standard')).toMatchObject({
            referencePriceLabel: '19,900원',
            priceLabel: '9,900원',
            discountLabel: '50%',
        });
        expect(buildEarlybirdPlanPresentation('plus')).toEqual({
            referencePriceLabel: null,
            priceLabel: '대기 신청',
            discountLabel: null,
            actionLabel: 'Plus 대기 신청하기',
        });
    });

    it('allows browser navigation to Basic and Standard checkout URLs emitted by the server', () => {
        const config = readGrobleConfig({
            GROBLE_BASIC_PRODUCT_ID: 'basic_product-01',
            GROBLE_STANDARD_PRODUCT_ID: 'standard_product-01',
            GROBLE_BASIC_PAYMENT_ADDRESS: 'basic-checkout-a1',
            GROBLE_STANDARD_PAYMENT_ADDRESS: 'standard-checkout-b2',
            GROBLE_WEBHOOK_SECRET: 'test-secret',
        });

        expect(isSafeGrobleCheckoutUrl(getGrobleCheckoutUrl(
            'basic',
            'ord.0123456789abcdef0123456789abcdef',
            config
        ))).toBe(true);
        expect(isSafeGrobleCheckoutUrl(getGrobleCheckoutUrl(
            'standard',
            'ord.fedcba9876543210fedcba9876543210',
            config
        ))).toBe(true);
    });

    it.each([
        ['a missing seller reference', 'https://groble.im/payment/basic-checkout-a1'],
        ['a duplicate seller reference', 'https://groble.im/payment/basic-checkout-a1?ref=ord.0123456789abcdef0123456789abcdef&ref=ord.fedcba9876543210fedcba9876543210'],
        ['an extra query parameter', 'https://groble.im/payment/basic-checkout-a1?ref=ord.0123456789abcdef0123456789abcdef&utm_source=test'],
        ['the wrong query key casing', 'https://groble.im/payment/basic-checkout-a1?Ref=ord.0123456789abcdef0123456789abcdef'],
        ['an encoded query key', 'https://groble.im/payment/basic-checkout-a1?%72ef=ord.0123456789abcdef0123456789abcdef'],
        ['an encoded seller-reference value', 'https://groble.im/payment/basic-checkout-a1?ref=ord.0123456789abcdef0123456789abcde%66'],
        ['a trailing query separator', 'https://groble.im/payment/basic-checkout-a1?ref=ord.0123456789abcdef0123456789abcdef&'],
        ['repeated trailing query separators', 'https://groble.im/payment/basic-checkout-a1?ref=ord.0123456789abcdef0123456789abcdef&&'],
        ['a malformed seller reference', 'https://groble.im/payment/basic-checkout-a1?ref=buyer%40example.com'],
        ['an uppercase seller reference', 'https://groble.im/payment/basic-checkout-a1?ref=ord.0123456789ABCDEF0123456789ABCDEF'],
        ['a short seller reference', 'https://groble.im/payment/basic-checkout-a1?ref=ord.0123456789abcdef'],
        ['the wrong origin', 'https://www.groble.im/payment/basic-checkout-a1?ref=ord.0123456789abcdef0123456789abcdef'],
        ['a deceptive subdomain', 'https://groble.im.evil.example/payment/basic-checkout-a1?ref=ord.0123456789abcdef0123456789abcdef'],
        ['the wrong path', 'https://groble.im/products/basic-checkout-a1?ref=ord.0123456789abcdef0123456789abcdef'],
        ['the wrong protocol', 'http://groble.im/payment/basic-checkout-a1?ref=ord.0123456789abcdef0123456789abcdef'],
        ['embedded credentials', 'https://buyer:secret@groble.im/payment/basic-checkout-a1?ref=ord.0123456789abcdef0123456789abcdef'],
        ['a hash', 'https://groble.im/payment/basic-checkout-a1?ref=ord.0123456789abcdef0123456789abcdef#receipt'],
        ['a non-URL protocol', 'javascript:alert(1)'],
    ])('rejects a Groble checkout URL with %s', (_case, url) => {
        expect(isSafeGrobleCheckoutUrl(url)).toBe(false);
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

    it('clears a stale v1 preflight after the server requires a v2 pricing refresh', () => {
        const source = readFileSync(new URL('../../../app/analyze/page.tsx', import.meta.url), 'utf8');
        const refreshCodeIndex = source.indexOf("'EARLYBIRD_PRICING_REFRESH_REQUIRED'");
        const resetCallIndex = source.indexOf('reset()', refreshCodeIndex);
        expect(refreshCodeIndex).toBeGreaterThan(-1);
        expect(resetCallIndex).toBeGreaterThan(refreshCodeIndex);
        expect(resetCallIndex - refreshCodeIndex).toBeLessThan(800);
        expect(source).toContain(
            '가격이 변경되어 대상 계정을 다시 확인해주세요.'
        );
    });

    it('resets and reroutes a stale v1 preflight before exposing a ready plan snapshot', () => {
        const stale = readyPreflight('earlybird-2026-07-v1', 14_900, 19_900);
        expect(resolveEarlybirdPricingBoundary(stale)).toEqual({
            readyPreflight: null,
            stalePricingPreflightId: stale.preflightId,
        });
        const actions = {
            reset: vi.fn(),
            clearGirlfriendInstagramId: vi.fn(),
            clearSelectedPlan: vi.fn(),
            clearDisclosureAccepted: vi.fn(),
            clearWaitlistComplete: vi.fn(),
            replaceAnalyzeRoute: vi.fn(),
            showRefreshError: vi.fn(),
        };

        expect(applyEarlybirdPricingRefreshBoundary(
            stale.preflightId,
            actions
        )).toBe(true);
        for (const action of Object.values(actions)) {
            expect(action).toHaveBeenCalledTimes(1);
        }
    });

    it('emits zero pricing events for stale v1 and current 6,900/9,900 prices for fresh v2', () => {
        const stale = readyPreflight('earlybird-2026-07-v1', 14_900, 19_900);
        const fresh = readyPreflight('earlybird-2026-07-v2', 6_900, 9_900);
        const emit = vi.fn();

        for (const event of [
            'plan_viewed',
            'plan_selected',
            'checkout_started',
        ] as const) {
            expect(emitCurrentEarlybirdPricingEvent(
                event,
                stale,
                'basic',
                emit
            )).toBe(false);
        }
        expect(emit).not.toHaveBeenCalled();

        for (const [planId, amountKrw] of [
            ['basic', 6_900],
            ['standard', 9_900],
        ] as const) {
            for (const event of [
                'plan_viewed',
                'plan_selected',
                'checkout_started',
            ] as const) {
                expect(emitCurrentEarlybirdPricingEvent(
                    event,
                    fresh,
                    planId,
                    emit
                )).toBe(true);
                expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
                    plan_id: planId,
                    amount_krw: amountKrw,
                    preflight_id: fresh.preflightId,
                }));
            }
        }
        expect(emit).toHaveBeenCalledTimes(6);
    });

    it('guards ready preflights at the client pricing boundary before rendering plans or emitting pricing events', () => {
        const source = readFileSync(new URL('../../../app/analyze/page.tsx', import.meta.url), 'utf8');
        const boundaryIndex = source.indexOf('resolveEarlybirdPricingBoundary(preflight)');
        const planViewIndex = source.indexOf('EVENTS.PLAN_VIEWED');
        expect(boundaryIndex).toBeGreaterThan(-1);
        expect(planViewIndex).toBeGreaterThan(boundaryIndex);
        expect(source).toContain('emitCurrentEarlybirdPricingEvent(');
        expect(source).toContain('stalePricingPreflightId');
    });
});
