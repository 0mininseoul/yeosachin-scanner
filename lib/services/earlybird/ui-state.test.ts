import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    applyEarlybirdPricingRefreshBoundary,
    buildEarlybirdPlanPresentation,
    canSubmitEarlybirdSelection,
    earlybirdCheckoutLineageStatusAction,
    emitCurrentEarlybirdPricingEvent,
    isEarlybirdPlanSelectable,
    isEarlybirdPlanSoldOut,
    isCurrentEarlybirdCheckoutStatusCta,
    isSafeGrobleCheckoutUrl,
    parseEarlybirdPlanParam,
    pendingEarlybirdCheckoutStatusPath,
    resolveAvailableEarlybirdPlan,
    resolveEarlybirdPricingBoundary,
} from './ui-state';
import * as earlybirdUiState from './ui-state';
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
            actionLabel: '지금 분석하기',
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
        // The 24-hour disclosure is gone with the delay it described; the record
        // is still written, but the page no longer puts a checkbox in the way.
        expect(source).not.toContain('EARLYBIRD_DISCLOSURE_TEXT');
        expect(source).not.toContain('24시간');
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

    it('resets and reroutes stale v1 fallback before exposing a ready plan snapshot', () => {
        const stale = readyPreflight('earlybird-2026-07-v1', 14_900, 19_900);
        expect(resolveEarlybirdPricingBoundary(stale)).toEqual({
            readyPreflight: null,
            stalePricingPreflightId: stale.preflightId,
        });
        const actions = {
            reset: vi.fn(),
            clearGirlfriendInstagramId: vi.fn(),
            clearSelectedPlan: vi.fn(),
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

    it('recovers a safe owner checkout for stale v1 without reset or pricing analytics', async () => {
        const recover = (
            earlybirdUiState as unknown as {
                recoverOrRefreshStaleEarlybirdPricing?: (
                    preflightId: string,
                    dependencies: Record<string, unknown>
                ) => Promise<string>;
            }
        ).recoverOrRefreshStaleEarlybirdPricing;
        expect(recover).toBeTypeOf('function');

        const stale = readyPreflight('earlybird-2026-07-v1', 14_900, 19_900);
        const emit = vi.fn();
        for (const event of [
            'plan_viewed',
            'plan_selected',
            'checkout_started',
        ] as const) {
            emitCurrentEarlybirdPricingEvent(event, stale, 'basic', emit);
        }
        const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            orderId: '20000000-0000-4000-8000-000000000001',
            checkoutUrl: 'https://groble.im/payment/basic-checkout-a1'
                + '?ref=ord.0123456789abcdef0123456789abcdef',
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        const redirectCheckout = vi.fn();
        const refreshActions = {
            reset: vi.fn(),
            clearGirlfriendInstagramId: vi.fn(),
            clearSelectedPlan: vi.fn(),
            clearWaitlistComplete: vi.fn(),
            replaceAnalyzeRoute: vi.fn(),
            showRefreshError: vi.fn(),
        };

        await expect(recover!(stale.preflightId, {
            request,
            redirectCheckout,
            refreshActions,
        })).resolves.toBe('checkout_recovered');
        expect(request).toHaveBeenCalledWith('/api/earlybird/checkout', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preflightId: stale.preflightId }),
        });
        expect(redirectCheckout).toHaveBeenCalledWith(
            'https://groble.im/payment/basic-checkout-a1'
                + '?ref=ord.0123456789abcdef0123456789abcdef'
        );
        expect(emit).not.toHaveBeenCalled();
        for (const action of Object.values(refreshActions)) {
            expect(action).not.toHaveBeenCalled();
        }
    });

    it('resets, reroutes, and shows the refresh error when stale v1 has no pending checkout', async () => {
        const recover = (
            earlybirdUiState as unknown as {
                recoverOrRefreshStaleEarlybirdPricing: (
                    preflightId: string,
                    dependencies: Record<string, unknown>
                ) => Promise<string>;
            }
        ).recoverOrRefreshStaleEarlybirdPricing;
        const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            code: 'EARLYBIRD_CHECKOUT_RECOVERY_NOT_FOUND',
            error: '복구할 결제창이 없습니다.',
        }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
        }));
        const redirectCheckout = vi.fn();
        const refreshActions = {
            reset: vi.fn(),
            clearGirlfriendInstagramId: vi.fn(),
            clearSelectedPlan: vi.fn(),
            clearWaitlistComplete: vi.fn(),
            replaceAnalyzeRoute: vi.fn(),
            showRefreshError: vi.fn(),
        };

        await expect(recover('10000000-0000-4000-8000-000000000001', {
            request,
            redirectCheckout,
            refreshActions,
        })).resolves.toBe('pricing_refresh_required');
        expect(redirectCheckout).not.toHaveBeenCalled();
        for (const action of Object.values(refreshActions)) {
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
        expect(source).toContain(
            'recoverOrRefreshStaleEarlybirdPricing(stalePricingPreflightId'
        );
        expect(source).toContain(
            'redirectCheckout: checkoutUrl => window.location.assign(checkoutUrl)'
        );
    });

    it('continues one pending checkout at a time and redirects only to the safe server URL', async () => {
        const recover = (
            earlybirdUiState as unknown as {
                recoverPendingEarlybirdCheckout?: (
                    preflightId: string,
                    guard: { inFlight: boolean },
                    dependencies: Record<string, unknown>
                ) => Promise<string>;
            }
        ).recoverPendingEarlybirdCheckout;
        expect(recover).toBeTypeOf('function');

        let resolveRequest!: (response: Response) => void;
        const request = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
            resolveRequest = resolve;
        }));
        const redirectCheckout = vi.fn();
        const setPending = vi.fn();
        const showError = vi.fn();
        const guard = { inFlight: false };
        const preflightId = '10000000-0000-4000-8000-000000000001';
        const dependencies = {
            request,
            redirectCheckout,
            setPending,
            showError,
        };

        const first = recover!(preflightId, guard, dependencies);
        await expect(recover!(preflightId, guard, dependencies)).resolves.toBe(
            'already_in_progress'
        );
        expect(request).toHaveBeenCalledTimes(1);
        expect(setPending).toHaveBeenCalledTimes(1);
        expect(setPending).toHaveBeenCalledWith(true);

        resolveRequest(new Response(JSON.stringify({
            orderId: '20000000-0000-4000-8000-000000000001',
            checkoutUrl: 'https://groble.im/payment/basic-checkout-a1'
                + '?ref=ord.0123456789abcdef0123456789abcdef',
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));

        await expect(first).resolves.toBe('checkout_recovered');
        expect(request).toHaveBeenCalledWith('/api/earlybird/checkout', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preflightId }),
        });
        expect(redirectCheckout).toHaveBeenCalledOnce();
        expect(showError).not.toHaveBeenCalled();
        expect(setPending).toHaveBeenLastCalledWith(false);
        expect(guard.inFlight).toBe(false);
    });

    it('maps only classified active lineages to a resumable owner status CTA', () => {
        expect(pendingEarlybirdCheckoutStatusPath(409, {
            code: 'EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE',
            subreason: 'STALE_PRICING_LINEAGE',
        }, 'standard')).toBe('/earlybird?plan=standard');

        expect(pendingEarlybirdCheckoutStatusPath(409, {
            code: 'EARLYBIRD_CHECKOUT_CANCELLED_UNRESOLVED_LINEAGE',
            subreason: 'SUPERSEDED_LINEAGE',
        }, 'standard')).toBeNull();
        expect(pendingEarlybirdCheckoutStatusPath(409, {
            code: 'EARLYBIRD_PRICING_REFRESH_REQUIRED',
        }, 'standard')).toBeNull();
        expect(pendingEarlybirdCheckoutStatusPath(409, {
            code: 'EARLYBIRD_ORDER_CONFLICT',
        }, 'standard')).toBeNull();
        expect(pendingEarlybirdCheckoutStatusPath(503, {
            code: 'EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE',
            subreason: 'STALE_PRICING_LINEAGE',
        }, 'standard')).toBeNull();
        expect(pendingEarlybirdCheckoutStatusPath(409, null, 'standard')).toBeNull();
        expect(pendingEarlybirdCheckoutStatusPath(409, {
            code: 'EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE',
            subreason: 'STALE_PRICING_LINEAGE',
        }, 'plus')).toBeNull();
    });

    it('maps both classified lineages to status, but never offers cancelled lineage recovery', () => {
        expect(earlybirdCheckoutLineageStatusAction(409, {
            code: 'EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE',
            subreason: 'SUPERSEDED_LINEAGE',
        }, 'basic')).toEqual({
            path: '/earlybird?plan=basic',
            kind: 'active_pending',
        });
        expect(earlybirdCheckoutLineageStatusAction(409, {
            code: 'EARLYBIRD_CHECKOUT_CANCELLED_UNRESOLVED_LINEAGE',
            subreason: 'STALE_PRICING_LINEAGE',
        }, 'basic')).toEqual({
            path: '/earlybird?plan=basic',
            kind: 'cancelled_unresolved',
        });
        expect(earlybirdCheckoutLineageStatusAction(409, {
            code: 'EARLYBIRD_CHECKOUT_CANCELLED_UNRESOLVED_LINEAGE',
        }, 'basic')).toBeNull();
    });

    it('hides a late Standard pending-checkout CTA and its bound message after selection changes', () => {
        // Submit Standard, select Basic/Plus while its request is pending, then
        // receive the exact 409. Both the stale Standard CTA and its conflict
        // message must disappear under the newer selection.
        const lateStandardCta = {
            preflightId: '10000000-0000-4000-8000-000000000001',
            targetInstagramId: 'pricing_target',
            planId: 'standard' as const,
        };

        expect(isCurrentEarlybirdCheckoutStatusCta(lateStandardCta, {
            preflightId: lateStandardCta.preflightId,
            targetInstagramId: lateStandardCta.targetInstagramId,
            planId: 'basic',
        })).toBe(false);
        expect(isCurrentEarlybirdCheckoutStatusCta(lateStandardCta, {
            preflightId: lateStandardCta.preflightId,
            targetInstagramId: lateStandardCta.targetInstagramId,
            planId: 'plus',
        })).toBe(false);
        expect(isCurrentEarlybirdCheckoutStatusCta(lateStandardCta, {
            preflightId: lateStandardCta.preflightId,
            targetInstagramId: lateStandardCta.targetInstagramId,
            planId: 'standard',
        })).toBe(true);
    });

    it('hides a late Standard pending-checkout CTA and message after target or preflight changes', () => {
        const lateStandardCta = {
            preflightId: '10000000-0000-4000-8000-000000000001',
            targetInstagramId: 'pricing_target',
            planId: 'standard' as const,
        };

        expect(isCurrentEarlybirdCheckoutStatusCta(lateStandardCta, {
            preflightId: lateStandardCta.preflightId,
            targetInstagramId: 'new_target',
            planId: 'standard',
        })).toBe(false);
        expect(isCurrentEarlybirdCheckoutStatusCta(lateStandardCta, {
            preflightId: '20000000-0000-4000-8000-000000000002',
            targetInstagramId: lateStandardCta.targetInstagramId,
            planId: 'standard',
        })).toBe(false);
    });

    it.each([
        [
            409,
            'CHECKOUT_PHONE_REQUIRED',
            '카카오 전화번호 확인이 만료되었습니다. 다시 로그인한 뒤 시도해주세요.',
        ],
        [
            409,
            'EARLYBIRD_CHECKOUT_NOT_RECOVERABLE',
            '현재 주문은 결제를 이어갈 수 없습니다. 새로고침 후 상태를 확인해주세요.',
        ],
        [
            404,
            'EARLYBIRD_CHECKOUT_RECOVERY_NOT_FOUND',
            '이어갈 결제 내역을 찾지 못했습니다. 새로고침 후 다시 확인해주세요.',
        ],
    ])('shows a bounded friendly error for recovery HTTP %i %s', async (
        httpStatus,
        code,
        expectedMessage
    ) => {
        const recover = (
            earlybirdUiState as unknown as {
                recoverPendingEarlybirdCheckout: (
                    preflightId: string,
                    guard: { inFlight: boolean },
                    dependencies: Record<string, unknown>
                ) => Promise<string>;
            }
        ).recoverPendingEarlybirdCheckout;
        const showError = vi.fn();

        await expect(recover(
            '10000000-0000-4000-8000-000000000001',
            { inFlight: false },
            {
                request: vi.fn().mockResolvedValue(new Response(JSON.stringify({
                    code,
                    error: 'internal seller reference ord.secret must never be shown',
                }), {
                    status: httpStatus,
                    headers: { 'content-type': 'application/json' },
                })),
                redirectCheckout: vi.fn(),
                setPending: vi.fn(),
                showError,
            }
        )).resolves.toBe('recovery_failed');
        expect(showError).toHaveBeenCalledWith(expectedMessage);
        expect(JSON.stringify(showError.mock.calls)).not.toContain('ord.secret');
    });

    it('wires the pending-order status to a disabled, owner recovery action', () => {
        const source = readFileSync(
            new URL('../../../app/earlybird/earlybird-status.tsx', import.meta.url),
            'utf8'
        );
        expect(source).toContain("order.systemStatus === 'payment_pending'");
        expect(source).toContain('order.preflightId');
        expect(source).toContain('recoverPendingEarlybirdCheckout(');
        expect(source).toContain('disabled={checkoutRecoveryPending}');
        expect(source).toContain('결제 계속하기');
    });

    it('wires classified checkout lineages to owner status without replaying checkout', () => {
        const source = readFileSync(
            new URL('../../../app/analyze/page.tsx', import.meta.url),
            'utf8'
        );
        expect(source).toContain('earlybirdCheckoutLineageStatusAction(');
        expect(source).toContain('router.push(activeCheckoutStatusCta.path)');
        expect(source).toContain('기존 결제창 확인하기');
        expect(source).toContain('결제 상태 확인하기');
        expect(source).toContain('kind: lineageStatusAction.kind');
        expect(source).toContain('const visibleError = activeCheckoutStatusCta?.message ?? error;');
        expect(source).not.toContain("setError('기존 결제 처리 상태를 먼저 확인해주세요.')");
        expect(source).not.toContain('recoverPendingEarlybirdCheckout(');
        expect(source).not.toContain('checkoutRecoveryPreflightId');
    });

    it('derives stale owner-status CTA visibility without synchronous effect state cleanup', () => {
        const source = readFileSync(
            new URL('../../../app/analyze/page.tsx', import.meta.url),
            'utf8'
        );
        expect(source).toContain('isCurrentEarlybirdCheckoutStatusCta(checkoutStatusCta, {');
        expect(source).toContain('planId: effectiveSelectedPlan');
        expect(source).not.toMatch(
            /useEffect\(\(\) => \{\s*setCheckoutStatus(?:Path|Navigating)/
        );

        const submitIndex = source.indexOf('const handleEarlybirdAction');
        const submitClearIndex = source.indexOf('setCheckoutStatusCta(null)', submitIndex);
        const requestIndex = source.indexOf('const response = await fetch(', submitIndex);
        expect(submitClearIndex).toBeGreaterThan(submitIndex);
        expect(submitClearIndex).toBeLessThan(requestIndex);

        const resetIndex = source.indexOf('const handleReset');
        const resetClearIndex = source.indexOf('setCheckoutStatusCta(null)', resetIndex);
        const resetRouteIndex = source.indexOf("router.replace('/analyze')", resetIndex);
        expect(resetClearIndex).toBeGreaterThan(resetIndex);
        expect(resetClearIndex).toBeLessThan(resetRouteIndex);
    });
});
