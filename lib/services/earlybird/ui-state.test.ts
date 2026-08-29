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
    isSafeEarlybirdCheckoutContinuationUrl,
    parseEarlybirdPlanParam,
    pendingEarlybirdCheckoutStatusPath,
    resolveAvailableEarlybirdPlan,
    resolveEarlybirdPricingBoundary,
} from './ui-state';
import * as earlybirdUiState from './ui-state';
import { EARLYBIRD_DISCLOSURE_TEXT } from '@/lib/domain/earlybird/catalog';
import {
    buildEarlybirdCheckoutContinuationUrl,
    isSafeEarlybirdDemoProgressUrl,
} from '@/lib/services/earlybird/checkout-continuation';
import type { PreflightStatusV1 } from '@/lib/contracts/analysis-v2';
import { earlybirdCheckoutRecoveryRequestSchema } from './contracts';

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
    it('accepts only the bounded same-origin continuation payload for recovery', async () => {
        const recover = (
            earlybirdUiState as unknown as {
                recoverPendingEarlybirdCheckout?: (
                    preflightId: string,
                    planId: 'basic' | 'standard',
                    guard: { inFlight: boolean },
                    dependencies: Record<string, unknown>
                ) => Promise<string>;
            }
        ).recoverPendingEarlybirdCheckout;
        expect(recover).toBeTypeOf('function');

        const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            orderId: '20000000-0000-4000-8000-000000000001',
            nextUrl: '/api/earlybird/checkout/redirect?orderId=20000000-0000-4000-8000-000000000001&planId=basic',
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        const redirectCheckout = vi.fn();
        const dependencies = {
            request,
            redirectCheckout,
            setPending: vi.fn(),
            showError: vi.fn(),
        };

        await expect(recover!(
            '10000000-0000-4000-8000-000000000001',
            'basic',
            { inFlight: false },
            dependencies,
        )).resolves.toBe('checkout_recovered');
        expect(redirectCheckout).toHaveBeenCalledWith(
            '/api/earlybird/checkout/redirect?orderId=20000000-0000-4000-8000-000000000001&planId=basic'
        );
        expect(dependencies.showError).not.toHaveBeenCalled();
    });

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
            '결제 확인 후 판독이 자동으로 시작됩니다.'
        );
        expect(canSubmitEarlybirdSelection('basic', false, true)).toBe(false);
        expect(canSubmitEarlybirdSelection('basic', true, true)).toBe(true);
        expect(canSubmitEarlybirdSelection('standard', true, false)).toBe(false);
        expect(canSubmitEarlybirdSelection('plus', false, true)).toBe(true);
    });

    it('presents reference, earlybird, and waitlist pricing without invented wording', () => {
        expect(buildEarlybirdPlanPresentation('basic')).toEqual({
            referencePriceLabel: '19,900원',
            priceLabel: '9,900원',
            discountLabel: '50% OFF',
            actionLabel: '지금 분석하기',
        });
        expect(buildEarlybirdPlanPresentation('standard')).toMatchObject({
            referencePriceLabel: '39,900원',
            priceLabel: '19,900원',
            discountLabel: '50% OFF',
        });
        expect(buildEarlybirdPlanPresentation('plus')).toEqual({
            referencePriceLabel: null,
            priceLabel: '대기 신청',
            discountLabel: null,
            actionLabel: 'Plus 대기 신청하기',
        });
    });

    it('allows browser navigation only to a server-owned Basic or Standard continuation', () => {
        expect(isSafeEarlybirdCheckoutContinuationUrl(buildEarlybirdCheckoutContinuationUrl({
            orderId: '10000000-0000-4000-8000-000000000001',
            planId: 'basic',
        }))).toBe(true);
        expect(isSafeEarlybirdCheckoutContinuationUrl(buildEarlybirdCheckoutContinuationUrl({
            orderId: '20000000-0000-4000-8000-000000000001',
            planId: 'standard',
        }))).toBe(true);
    });

    it.each([
        ['a missing order id', '/api/earlybird/checkout/redirect?planId=basic'],
        ['a duplicate order id', '/api/earlybird/checkout/redirect?orderId=10000000-0000-4000-8000-000000000001&orderId=20000000-0000-4000-8000-000000000001&planId=basic'],
        ['an extra query parameter', '/api/earlybird/checkout/redirect?orderId=10000000-0000-4000-8000-000000000001&planId=basic&utm_source=test'],
        ['the wrong query key casing', '/api/earlybird/checkout/redirect?orderId=10000000-0000-4000-8000-000000000001&PlanId=basic'],
        ['an encoded query key', '/api/earlybird/checkout/redirect?%6frderId=10000000-0000-4000-8000-000000000001&planId=basic'],
        ['an encoded order id', '/api/earlybird/checkout/redirect?orderId=10000000-0000-4000-8000-00000000000%31&planId=basic'],
        ['a trailing query separator', '/api/earlybird/checkout/redirect?orderId=10000000-0000-4000-8000-000000000001&planId=basic&'],
        ['a malformed order id', '/api/earlybird/checkout/redirect?orderId=not-an-id&planId=basic'],
        ['an unsupported plan', '/api/earlybird/checkout/redirect?orderId=10000000-0000-4000-8000-000000000001&planId=plus'],
        ['an uppercase order id', '/api/earlybird/checkout/redirect?orderId=10000000-0000-4000-8000-00000000000A&planId=basic'],
        ['an absolute URL', 'https://provider.example/checkout?orderId=10000000-0000-4000-8000-000000000001&planId=basic'],
        ['a wrong path', '/earlybird?orderId=10000000-0000-4000-8000-000000000001&planId=basic'],
        ['a hash', '/api/earlybird/checkout/redirect?orderId=10000000-0000-4000-8000-000000000001&planId=basic#receipt'],
        ['a non-URL protocol', 'javascript:alert(1)'],
    ])('rejects a checkout continuation URL with %s', (_case, url) => {
        expect(isSafeEarlybirdCheckoutContinuationUrl(url)).toBe(false);
    });

    it('removes the old automatic-analysis action and banned copy from the purchase page', () => {
        const source = readFileSync(new URL('../../../app/analyze/page.tsx', import.meta.url), 'utf8');
        expect(source).not.toContain('startAnalysis(');
        expect(source).not.toContain('판독 시작하기');
        expect(source).not.toContain('결제 접수 준비 중');
        expect(source).not.toContain(['정식 출시', ' 예정가'].join(''));
        expect(source).not.toContain(['예약', '금'].join(''));
        /* The 24-hour delay is gone, and with it the checkbox that made anyone
           accept it. The sentence recorded against the order is still shown —
           storing a statement nobody is shown is its own problem — but as
           information, so no input and no blocking modal may come back. */
        expect(source).toContain('EARLYBIRD_DISCLOSURE_TEXT');
        expect(source).not.toContain('24시간');
        expect(source).not.toContain('disclosureAccepted}');
        expect(source).not.toContain('setDisclosureAccepted');
        expect(source).not.toContain('disclosureModalOpen');
        expect(source).not.toContain('{presentation.discountLabel}↓');
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
                    planId: 'basic' | 'standard',
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
        const request = vi.fn(async (
            _input: RequestInfo | URL,
            init?: RequestInit,
        ): Promise<Response> => {
            const body = typeof init?.body === 'string'
                ? JSON.parse(init.body) as unknown
                : null;
            if (!earlybirdCheckoutRecoveryRequestSchema.safeParse(body).success) {
                return new Response(JSON.stringify({ code: 'INVALID_REQUEST' }), { status: 400 });
            }
            return new Response(JSON.stringify({
                orderId: '20000000-0000-4000-8000-000000000001',
                nextUrl: '/api/earlybird/checkout/redirect?orderId=20000000-0000-4000-8000-000000000001&planId=basic',
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        const redirectCheckout = vi.fn();
        const refreshActions = {
            reset: vi.fn(),
            clearGirlfriendInstagramId: vi.fn(),
            clearSelectedPlan: vi.fn(),
            clearWaitlistComplete: vi.fn(),
            replaceAnalyzeRoute: vi.fn(),
            showRefreshError: vi.fn(),
        };

        await expect(recover!(stale.preflightId, 'basic', {
            request,
            redirectCheckout,
            refreshActions,
        })).resolves.toBe('checkout_recovered');
        expect(request).toHaveBeenCalledWith('/api/earlybird/checkout', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preflightId: stale.preflightId, planId: 'basic' }),
        });
        expect(redirectCheckout).toHaveBeenCalledWith(
            '/api/earlybird/checkout/redirect?orderId=20000000-0000-4000-8000-000000000001&planId=basic'
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
                    planId: 'basic' | 'standard',
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

        await expect(recover('10000000-0000-4000-8000-000000000001', 'standard', {
            request,
            redirectCheckout,
            refreshActions,
        })).resolves.toBe('pricing_refresh_required');
        expect(redirectCheckout).not.toHaveBeenCalled();
        for (const action of Object.values(refreshActions)) {
            expect(action).toHaveBeenCalledTimes(1);
        }
    });

    it('emits zero pricing events for stale v1 and current 9,900/19,900 prices for fresh v5', () => {
        const stale = readyPreflight('earlybird-2026-07-v1', 14_900, 19_900);
        const fresh = readyPreflight('earlybird-2026-08-v5', 9_900, 19_900);
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
            ['basic', 9_900],
            ['standard', 19_900],
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
        expect(source).toMatch(
            /redirectCheckout: nextUrl => \{[\s\S]*?window\.location\.assign\(nextUrl\)/
        );
    });

    it('attempts stale checkout recovery only for a paid effective selection', () => {
        const source = readFileSync(new URL('../../../app/analyze/page.tsx', import.meta.url), 'utf8');
        const staleEffectStart = source.indexOf('stalePricingRefreshHandledRef.current = stalePricingPreflightId;');
        const staleEffectEnd = source.indexOf('    }, [', staleEffectStart);
        const staleEffect = source.slice(staleEffectStart, staleEffectEnd);
        expect(staleEffect).toMatch(
            /if \(!effectiveSelectedPlan \|\| !isPaidEarlybirdPlanId\(effectiveSelectedPlan\)\)[\s\S]*?applyEarlybirdPricingRefreshBoundary\(stalePricingPreflightId, refreshActions\)[\s\S]*?return;/
        );
        expect(staleEffect).toContain(
            'recoverOrRefreshStaleEarlybirdPricing(stalePricingPreflightId, effectiveSelectedPlan,'
        );
    });

    it('continues one pending checkout at a time and redirects only to the safe server URL', async () => {
        const recover = (
            earlybirdUiState as unknown as {
                recoverPendingEarlybirdCheckout?: (
                    preflightId: string,
                    planId: 'basic' | 'standard',
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

        const first = recover!(preflightId, 'basic', guard, dependencies);
        await expect(recover!(preflightId, 'basic', guard, dependencies)).resolves.toBe(
            'already_in_progress'
        );
        expect(request).toHaveBeenCalledTimes(1);
        expect(setPending).toHaveBeenCalledTimes(1);
        expect(setPending).toHaveBeenCalledWith(true);

        resolveRequest(new Response(JSON.stringify({
            orderId: '20000000-0000-4000-8000-000000000001',
            nextUrl: '/api/earlybird/checkout/redirect?orderId=20000000-0000-4000-8000-000000000001&planId=basic',
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));

        await expect(first).resolves.toBe('checkout_recovered');
        expect(request).toHaveBeenCalledWith('/api/earlybird/checkout', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preflightId, planId: 'basic' }),
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
            code: 'EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE',
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
            path: '/earlybird?plan=basic&resume=0',
            kind: 'status_only',
        });
        expect(earlybirdCheckoutLineageStatusAction(409, {
            code: 'EARLYBIRD_CHECKOUT_CANCELLED_UNRESOLVED_LINEAGE',
            subreason: 'STALE_PRICING_LINEAGE',
        }, 'basic')).toEqual({
            path: '/earlybird?plan=basic&resume=0',
            kind: 'status_only',
        });
        expect(earlybirdCheckoutLineageStatusAction(409, {
            code: 'EARLYBIRD_CHECKOUT_CANCELLED_UNRESOLVED_LINEAGE',
        }, 'basic')).toBeNull();
    });

    it('gates the status-page recovery button on the server capability DTO', () => {
        const source = readFileSync(new URL('../../../app/earlybird/earlybird-status.tsx', import.meta.url), 'utf8');
        expect(source).toContain('currentOrder.checkoutRecoverable');
        expect(source).toContain('redirectCheckout: nextUrl =>');
        expect(source).not.toContain('redirectCheckout: checkoutUrl => window.location.assign(checkoutUrl)');
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

    it('preserves the strict operator demo progress continuation without payment telemetry', () => {
        expect(isSafeEarlybirdDemoProgressUrl(
            '/progress/10000000-0000-4000-8000-000000000001',
        )).toBe(true);
        expect(isSafeEarlybirdDemoProgressUrl(
            'https://provider.example/progress/10000000-0000-4000-8000-000000000001',
        )).toBe(false);
        expect(isSafeEarlybirdDemoProgressUrl(
            '/progress/10000000-0000-4000-8000-000000000001?checkout=1',
        )).toBe(false);

        const source = readFileSync(new URL('../../../app/analyze/page.tsx', import.meta.url), 'utf8');
        const demoBranch = source.indexOf('isSafeEarlybirdDemoProgressUrl(payload.nextUrl)');
        const checkoutEvent = source.indexOf('EVENTS.CHECKOUT_REDIRECTED', demoBranch);
        const continuationBranch = source.indexOf('isSafeEarlybirdCheckoutContinuationUrl(payload.nextUrl)');
        expect(demoBranch).toBeGreaterThan(-1);
        expect(demoBranch).toBeLessThan(continuationBranch);
        expect(checkoutEvent).toBeGreaterThan(continuationBranch);
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
                    planId: 'basic' | 'standard',
                    guard: { inFlight: boolean },
                    dependencies: Record<string, unknown>
                ) => Promise<string>;
            }
        ).recoverPendingEarlybirdCheckout;
        const showError = vi.fn();

        await expect(recover(
            '10000000-0000-4000-8000-000000000001',
            'basic',
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
        expect(source).toContain("currentOrder.systemStatus === 'payment_pending'");
        expect(source).toContain('currentOrder.preflightId');
        expect(source).toContain('recoverPendingEarlybirdCheckout(');
        expect(source).toContain('disabled={checkoutRecoveryPending}');
        expect(source).toContain('결제 계속하기');
    });

    it('auto-recovers an active pending lineage after OAuth, while keeping manual recovery owner-bound', () => {
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
        expect(source).toContain('recoverPendingEarlybirdCheckout(');
        expect(source).toContain("lineageStatusAction.kind === 'active_pending'");
        expect(source).toContain('autoCheckoutAttempt');
        expect(source).toContain('checkoutRecoveryGuardRef.current');
        expect(source).toContain('setPending: setPurchaseSubmitting');
    });

    it('keeps the plan screen hidden while OAuth checkout continuation is redirecting', () => {
        const source = readFileSync(
            new URL('../../../app/analyze/page.tsx', import.meta.url),
            'utf8'
        );
        expect(source).toContain(
            'const [autoCheckoutUiPending, setAutoCheckoutUiPending] = useState(false);'
        );
        expect(source).toContain('useHydrationSafeCheckoutPlanQuery');
        expect(source).toContain('const autoCheckoutTransitionVisible = Boolean(user)');
        expect(source).toContain('결제창으로 이동하고 있어요');
        expect(source).toContain(
            "{autoCheckoutTransitionVisible && preflight?.status !== 'blocked' ? ("
        );
        expect(source).toContain('setAutoCheckoutUiPending(false);');
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
