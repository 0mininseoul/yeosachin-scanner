// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pageMocks = vi.hoisted(() => {
    const router = {
        replace: vi.fn(),
        push: vi.fn(),
    };
    const storage = {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
    };
    const startPreflight = vi.fn();
    const reset = vi.fn();
    const clearPreflightDisplayTarget = vi.fn();
    const clearPendingAnalysisTarget = vi.fn();
    const bindPendingAnalysisTarget = vi.fn();
    const preflight = {
        schemaVersion: 1 as const,
        preflightId: '11111111-1111-4111-8111-111111111111',
        expiresAt: '2099-01-01T00:00:00.000Z',
        status: 'pending' as const,
        exclusionDecision: 'skip' as const,
    };
    return {
        router,
        storage,
        startPreflight,
        reset,
        clearPreflightDisplayTarget,
        clearPendingAnalysisTarget,
        bindPendingAnalysisTarget,
        preflight,
        hook: {
            targetInstagramId: 'old_target',
            preflightStartedAt: 1_000,
            preflight,
            creating: false,
            exclusionState: 'skipped' as const,
            error: null,
            setError: vi.fn(),
            startPreflight,
            resumePreflight: vi.fn().mockResolvedValue(true),
            submitExclusion: vi.fn().mockResolvedValue(true),
            refreshPreflight: vi.fn(),
            reset,
            analyticsEligible: true,
            claimToken: 'old-claim-token',
            loginFallbackRequired: false,
        },
        auth: {
            user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
            loading: false,
        },
    };
});

vi.mock('next/image', () => ({
    default: (props: Record<string, unknown>) => createElement('img', props),
}));

vi.mock('next/navigation', () => ({
    useRouter: () => pageMocks.router,
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => pageMocks.auth,
}));

vi.mock('@/hooks/useAnalysisV2Preflight', () => ({
    useAnalysisV2Preflight: () => pageMocks.hook,
}));

vi.mock('@/hooks/useHydrationSafePlanQuery', () => ({
    HydrationSafePlanQueryObserver: () => null,
    useHydrationSafeCheckoutPlanQuery: () => null,
    useHydrationSafePlanQuery: () => null,
}));

vi.mock('@/lib/domain/earlybird/catalog', () => ({
    EARLYBIRD_DISCLOSURE_TEXT: 'fixture disclosure',
    isPaidEarlybirdPlanId: () => true,
}));

vi.mock('@/lib/services/earlybird/ui-state', () => ({
    buildEarlybirdPlanPresentation: () => ({ title: 'fixture' }),
    canSubmitEarlybirdSelection: () => false,
    emitCurrentEarlybirdPricingEvent: vi.fn(),
    earlybirdCheckoutLineageStatusAction: () => null,
    applyEarlybirdPricingRefreshBoundary: vi.fn(),
    isEarlybirdPlanSelectable: () => false,
    isEarlybirdPlanSoldOut: () => false,
    isCurrentEarlybirdCheckoutStatusCta: () => false,
    recoverPendingEarlybirdCheckout: vi.fn(),
    recoverOrRefreshStaleEarlybirdPricing: vi.fn(),
    resolveEarlybirdPricingBoundary: () => ({
        readyPreflight: null,
        stalePricingPreflightId: null,
    }),
    parseEarlybirdPlanParam: () => null,
}));

vi.mock('@/lib/services/earlybird/checkout-continuation', () => ({
    isSafeEarlybirdDemoProgressUrl: () => true,
    isSafeEarlybirdCheckoutContinuationUrl: () => true,
}));

vi.mock('@/lib/services/pending-analysis-target', () => ({
    availablePendingTargetStorage: () => pageMocks.storage,
    bindPendingAnalysisTarget: pageMocks.bindPendingAnalysisTarget,
    clearPendingAnalysisTarget: pageMocks.clearPendingAnalysisTarget,
    clearPendingAnalysisTargetForTerminalState: vi.fn(),
    clearPreflightDisplayTarget: pageMocks.clearPreflightDisplayTarget,
    clearPreflightDisplayTargetForTerminalState: vi.fn(),
    readPreflightDisplayTarget: () => null,
    readPendingAnalysisTargetForAutostart: () => null,
    readPendingAnalysisTargetForPreflight: () => null,
    signOutAndClearPendingAnalysisTarget: vi.fn().mockResolvedValue(true),
    storePendingAnalysisTarget: vi.fn(),
}));

vi.mock('@/lib/services/analytics', () => ({
    EVENTS: new Proxy({}, { get: (_target, property) => String(property) }),
    trackEvent: vi.fn(),
}));

vi.mock('@/lib/services/analytics-funnel', () => ({
    availableAnalyticsStorage: () => undefined,
    currentAttributionSource: () => null,
    tryClaimAnalyticsEvent: () => true,
}));

vi.mock('@/lib/services/earlybird/analytics-state', () => ({
    planSelectedEventKey: () => 'plan-selected',
    planViewEventKey: () => 'plan-viewed',
}));

vi.mock('@/lib/services/earlybird/post-login-checkout', () => ({
    AUTO_CHECKOUT_QUERY_PARAM: 'checkout',
    checkoutContinuationKey: () => 'checkout-key',
    checkoutContinuationPlan: () => null,
    hasCheckoutContinuationIntent: () => false,
    shouldClearAutoCheckoutUiPending: () => false,
    shouldAutoSubmitEarlybirdAction: () => false,
}));

function Box({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) {
    return createElement('div', props, children);
}

vi.mock('@/components/case-ui', () => ({
    TopBar: Box,
    BrandMark: () => null,
    Eyebrow: Box,
    CaseCard: Box,
    Panel: Box,
    PrimaryButton: (props: Record<string, unknown>) => createElement('button', props),
}));

vi.mock('@/components/instagram-lookup-link', () => ({
    InstagramLookupLink: () => null,
}));

vi.mock('@/components/login-modal', () => ({
    LoginModal: () => null,
}));

vi.mock('@/components/preflight-pending-status', () => ({
    PreflightPendingStatus: () => null,
}));

vi.mock('@/components/precheckout-immersive', () => ({
    PrecheckoutImmersive: ({ onRetry }: { onRetry?: () => void }) => createElement(
        'button',
        { type: 'button', 'data-precheckout-retry': true, onClick: onRetry },
        'retry',
    ),
}));

import AnalyzePage from './page';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const NEW_PREFLIGHT_ID = '22222222-2222-4222-8222-222222222222';
const NEW_CLAIM_TOKEN = 'new-claim-token-abcdefghijklmnopqrstuvwxyz';

function acceptedPreflight(extra: Record<string, unknown> = {}) {
    return {
        schemaVersion: 1,
        preflightId: NEW_PREFLIGHT_ID,
        expiresAt: '2099-01-01T00:00:00.000Z',
        status: 'pending',
        exclusionDecision: 'pending',
        claimToken: NEW_CLAIM_TOKEN,
        ...extra,
    };
}

describe('explicit terminal/expiry retry acceptance', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        window.history.replaceState({}, '', '/analyze');
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        pageMocks.router.replace.mockReset();
        pageMocks.startPreflight.mockReset();
        pageMocks.reset.mockReset();
        pageMocks.clearPreflightDisplayTarget.mockReset();
        pageMocks.clearPendingAnalysisTarget.mockReset();
        pageMocks.bindPendingAnalysisTarget.mockReset();
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    async function renderAndClickRetry(): Promise<void> {
        await act(async () => root.render(createElement(AnalyzePage)));
        const retry = container.querySelector('[data-precheckout-retry]');
        expect(retry).not.toBeNull();
        await act(async () => {
            (retry as HTMLButtonElement).click();
            await Promise.resolve();
        });
    }

    it('clears the old display target, resets before exactly one start, and clears the authenticated pending target on null acceptance', async () => {
        const order: string[] = [];
        pageMocks.clearPreflightDisplayTarget.mockImplementation(() => order.push('clear-display'));
        pageMocks.reset.mockImplementation(() => order.push('reset'));
        pageMocks.startPreflight.mockImplementation(async () => {
            order.push('start');
            return null;
        });

        await act(async () => root.render(createElement(AnalyzePage)));
        pageMocks.clearPendingAnalysisTarget.mockReset();
        const retry = container.querySelector('[data-precheckout-retry]');
        expect(retry).not.toBeNull();
        await act(async () => {
            (retry as HTMLButtonElement).click();
            await Promise.resolve();
        });

        expect(pageMocks.clearPreflightDisplayTarget).toHaveBeenCalledWith(
            pageMocks.storage,
            pageMocks.preflight.preflightId,
        );
        expect(pageMocks.reset).toHaveBeenCalledOnce();
        expect(pageMocks.startPreflight).toHaveBeenCalledOnce();
        expect(pageMocks.clearPendingAnalysisTarget).toHaveBeenCalledWith(window.sessionStorage);
        expect(order).toEqual(['clear-display', 'reset', 'start']);
    });

    it('routes an accepted demo retry to its new result without carrying the old claim', async () => {
        pageMocks.startPreflight.mockResolvedValue(acceptedPreflight({ demo: true }));

        await renderAndClickRetry();

        expect(pageMocks.startPreflight).toHaveBeenCalledOnce();
        expect(pageMocks.router.replace).toHaveBeenCalledOnce();
        expect(pageMocks.router.replace).toHaveBeenCalledWith(
            `/result/${NEW_PREFLIGHT_ID}?pipeline=v2`,
        );
        expect(pageMocks.bindPendingAnalysisTarget).not.toHaveBeenCalled();
    });

    it('binds an accepted authenticated standard retry and replaces with only its id and claim', async () => {
        pageMocks.startPreflight.mockResolvedValue(acceptedPreflight());

        await renderAndClickRetry();

        expect(pageMocks.startPreflight).toHaveBeenCalledOnce();
        expect(pageMocks.bindPendingAnalysisTarget).toHaveBeenCalledOnce();
        expect(pageMocks.bindPendingAnalysisTarget).toHaveBeenCalledWith(window.sessionStorage, {
            ownerId: pageMocks.auth.user.id,
            preflightId: NEW_PREFLIGHT_ID,
            target: pageMocks.hook.targetInstagramId,
        });
        expect(pageMocks.router.replace).toHaveBeenCalledOnce();
        expect(pageMocks.router.replace).toHaveBeenCalledWith(
            `/analyze?preflight=${NEW_PREFLIGHT_ID}&claim=${NEW_CLAIM_TOKEN}`,
        );
    });
});
