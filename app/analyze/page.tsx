'use client';

import Link from 'next/link';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useAnalysisV2Preflight } from '@/hooks/useAnalysisV2Preflight';
import {
    HydrationSafePlanQueryObserver,
    useHydrationSafeCheckoutPlanQuery,
    useHydrationSafePlanQuery,
} from '@/hooks/useHydrationSafePlanQuery';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import {
    EARLYBIRD_DISCLOSURE_TEXT,
    isPaidEarlybirdPlanId,
} from '@/lib/domain/earlybird/catalog';
import {
    buildEarlybirdPlanPresentation,
    canSubmitEarlybirdSelection,
    emitCurrentEarlybirdPricingEvent,
    earlybirdCheckoutLineageStatusAction,
    applyEarlybirdPricingRefreshBoundary,
    isEarlybirdPlanSelectable,
    isCurrentEarlybirdCheckoutStatusCta,
    isSafeEarlybirdCheckoutContinuationUrl,
    recoverPendingEarlybirdCheckout,
    recoverOrRefreshStaleEarlybirdPricing,
    resolveEarlybirdPricingBoundary,
} from '@/lib/services/earlybird/ui-state';
import { isSafeDevUiCheckoutUrl, isSafeEarlybirdDemoProgressUrl } from '@/lib/services/earlybird/checkout-continuation';
import { isDevUiPresentation } from '@/lib/constants/dev-ui';
import { DEV_UI_SCENARIO_LABELS } from '@/lib/services/dev-ui/client';
import type { DevFixtureScenario } from '@/lib/services/dev-ui/contracts';
import {
    availablePendingTargetStorage,
    bindPendingAnalysisTarget,
    clearPendingAnalysisTarget,
    clearPendingAnalysisTargetForTerminalState,
    clearPreflightDisplayTarget,
    readPreflightDisplayTarget,
    readPendingAnalysisTargetForAutostart,
    readPendingAnalysisTargetForPreflight,
    signOutAndClearPendingAnalysisTarget,
    storePendingAnalysisTarget,
} from '@/lib/services/pending-analysis-target';
import { EVENTS, trackEvent } from '@/lib/services/analytics';
import {
    availableAnalyticsStorage,
    currentAttributionSource,
    tryClaimAnalyticsEvent,
} from '@/lib/services/analytics-funnel';
import {
    planSelectedEventKey,
    planViewEventKey,
} from '@/lib/services/earlybird/analytics-state';
import {
    AUTO_CHECKOUT_QUERY_PARAM,
    checkoutContinuationKey,
    checkoutContinuationPlan,
    hasCheckoutContinuationIntent,
    shouldClearAutoCheckoutUiPending,
    shouldAutoSubmitEarlybirdAction,
} from '@/lib/services/earlybird/post-login-checkout';
import { TopBar, BrandMark, Eyebrow, CaseCard, Panel, PrimaryButton } from '@/components/case-ui';
import { InstagramLookupLink } from '@/components/instagram-lookup-link';
import { LoginModal } from '@/components/login-modal';
import { PreflightPendingStatus } from '@/components/preflight-pending-status';
import { PrecheckoutImmersive } from '@/components/precheckout-immersive';
import { AnalysisPlanCards, AnalysisPlanSection } from '@/components/analysis-plan-selection';
import {
    AnalysisExclusionPanel,
    AnalysisInstagramInput,
    AnalysisPreflightHeading,
    AnalysisTargetCard,
    AnalysisTargetHeading,
} from '@/components/analysis-preflight-presentation';
import {
    resolveActivePrecheckoutSurface,
    type PrecheckoutSurfaceState,
} from '@/lib/services/precheckout/blite-page-flow';

interface CheckoutStatusCta {
    path: string;
    message: string;
    preflightId: string;
    targetInstagramId: string | null;
    planId: PlanId;
    kind: 'active_pending' | 'status_only';
    navigating: boolean;
}

export default function AnalyzePage() {
    const devPresentation = isDevUiPresentation();
    const [fixtureScenario, setFixtureScenario] = useState<DevFixtureScenario>('complete');
    const [instagramId, setInstagramId] = useState('');
    const [girlfriendInstagramId, setGirlfriendInstagramId] = useState('');
    const [selectedPlan, setSelectedPlan] = useState<PlanId | null>(null);
/* Auto-analysis is live, so there is no longer a delay to disclose and no
   checkbox in front of the button. The checkout contract still records a
   disclosure, and the recorded text now matches what the screen actually says. */
const DISCLOSURE_ACCEPTED = true;

    const [purchaseSubmitting, setPurchaseSubmitting] = useState(false);
    const [waitlistComplete, setWaitlistComplete] = useState(false);
    const [checkoutStatusCta, setCheckoutStatusCta] = useState<CheckoutStatusCta | null>(null);
    const [loginPromptOpen, setLoginPromptOpen] = useState(false);
    const [autoCheckoutRequested, setAutoCheckoutRequested] = useState(false);
    const [autoCheckoutPreflightId, setAutoCheckoutPreflightId] = useState<string | null>(null);
    const [autoCheckoutPlan, setAutoCheckoutPlan] = useState<PlanId | null>(null);
    const [autoCheckoutUiPending, setAutoCheckoutUiPending] = useState(false);
    const [precheckoutSurface, setPrecheckoutSurface] = useState<PrecheckoutSurfaceState>({
        preflightId: null,
        surface: 'awaiting',
    });
    /**
     * The B-lite result sheet carries its own single eyebrow. The page heading above it carries
     * a second one, which put two eyebrow-like labels on the same screen, so the page withdraws
     * its own while that sheet is up.
     *
     * It lives next to `precheckoutSurface` because it is bound to it: the sheet only exists on
     * a non-legacy surface, so every transition that leaves that surface has to hand the eyebrow
     * back. Kept as state rather than derived so the withdrawal is committed in the same pass as
     * the announcement (see `PrecheckoutImmersive`'s layout effect).
     */
    const [bliteResultShown, setBliteResultShown] = useState(false);
    const handleBliteResultShown = useCallback(() => setBliteResultShown(true), []);
    const querySelectedPlan = useHydrationSafePlanQuery();
    const queryCheckoutPlan = useHydrationSafeCheckoutPlanQuery();
    const router = useRouter();
    const { user, loading: authLoading } = useAuth();
    const initializedRef = useRef(false);
    const planViewsTrackedRef = useRef(new Set<string>());
    const planSelectionsTrackedRef = useRef(new Set<string>());
    const stalePricingRefreshHandledRef = useRef<string | null>(null);
    const autoCheckoutAttemptedRef = useRef<string | null>(null);
    const autoCheckoutRecoveryRequestedRef = useRef(false);
    const checkoutRecoveryGuardRef = useRef({ inFlight: false });
    const {
        targetInstagramId,
        preflightStartedAt,
        preflight,
        creating,
        exclusionState,
        error,
        setError,
        startPreflight,
        resumePreflight,
        submitExclusion,
        refreshPreflight,
        reset,
        analyticsEligible,
        claimToken,
        loginFallbackRequired,
    } = useAnalysisV2Preflight();

    const {
        readyPreflight,
        stalePricingPreflightId,
    } = resolveEarlybirdPricingBoundary(preflight);
    const exclusionDecided = exclusionState === 'excluded' || exclusionState === 'skipped';
    // B-lite reads the same preflight source that produces the ready pricing snapshot, but its
    // visual gate must start as soon as this already-accepted preflight has an exclusion decision.
    // This avoids another provider/Gemini request while removing the old ready-state display wait.
    const immersivePreflight = exclusionDecided
        && preflight
        && (preflight?.status === 'pending' || preflight?.status === 'ready')
        ? preflight
        : null;
    const activePrecheckoutSurface = resolveActivePrecheckoutSurface(
        precheckoutSurface,
        immersivePreflight?.preflightId,
    );
    // Query-plan selection is a hydration-safe rendering fallback, not a state
    // transition. It therefore cannot race the preflight resume effect.
    const selectedPlanWithQueryFallback = selectedPlan ?? querySelectedPlan;
    // 모든 플랜을 선택(비교)할 수 있게 하되, 아무것도 안 고르면 적격 플랜을 기본 선택.
    // 부적격 플랜을 골라도 선택 상태는 유지하고, 구매 버튼만 비활성화한다.
    const effectiveSelectedPlan = readyPreflight
        ? (selectedPlanWithQueryFallback ?? readyPreflight.requiredPlan)
        : selectedPlanWithQueryFallback;
    const effectiveSelectedCard = readyPreflight && effectiveSelectedPlan
        ? readyPreflight.plans.find(plan => plan.planId === effectiveSelectedPlan) ?? null
        : null;
    const selectedPlanAvailable = readyPreflight && effectiveSelectedCard
        ? isEarlybirdPlanSelectable(effectiveSelectedCard, readyPreflight.requiredPlan)
        : false;
    const noPlanSelectable = readyPreflight
        ? !readyPreflight.plans.some(
            plan => isEarlybirdPlanSelectable(plan, readyPreflight.requiredPlan)
        )
        : false;
    const activeCheckoutStatusCta = isCurrentEarlybirdCheckoutStatusCta(checkoutStatusCta, {
        preflightId: readyPreflight?.preflightId,
        targetInstagramId,
        planId: effectiveSelectedPlan,
    })
        ? checkoutStatusCta
        : null;
    // The pending-checkout copy belongs to the same submission binding as its
    // CTA. A late 409 must not leave this message behind after the user has
    // selected another plan or started a new preflight.
    const visibleError = activeCheckoutStatusCta?.message ?? error;
    // Must not wait on activePrecheckoutSurface: on the very first hydration
    // after an OAuth reload the surface is still 'awaiting', and gating on
    // 'legacy' here is exactly what let the initial form and the four-stage
    // demo flash before this transition screen could take over.
    const autoCheckoutTransitionVisible = Boolean(user)
        && (autoCheckoutUiPending || queryCheckoutPlan !== null);

    const removeAutoCheckoutQuery = useCallback(() => {
        if (typeof window === 'undefined') return;
        const nextUrl = new URL(window.location.href);
        if (!nextUrl.searchParams.has(AUTO_CHECKOUT_QUERY_PARAM)) return;
        nextUrl.searchParams.delete(AUTO_CHECKOUT_QUERY_PARAM);
        router.replace(`${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    }, [router]);

    const clearAutoCheckoutContinuation = useCallback(() => {
        setAutoCheckoutRequested(false);
        setAutoCheckoutPreflightId(null);
        setAutoCheckoutPlan(null);
        setAutoCheckoutUiPending(false);
        autoCheckoutAttemptedRef.current = null;
        autoCheckoutRecoveryRequestedRef.current = false;
        removeAutoCheckoutQuery();
    }, [removeAutoCheckoutQuery]);

    const consumeAutoCheckoutContinuation = useCallback(() => {
        setAutoCheckoutRequested(false);
        setAutoCheckoutPreflightId(null);
        setAutoCheckoutPlan(null);
        removeAutoCheckoutQuery();
    }, [removeAutoCheckoutQuery]);

    useEffect(() => {
        if (
            !stalePricingPreflightId
            || stalePricingRefreshHandledRef.current === stalePricingPreflightId
        ) return;
        stalePricingRefreshHandledRef.current = stalePricingPreflightId;
        clearAutoCheckoutContinuation();
        const refreshActions = {
            reset,
            clearGirlfriendInstagramId: () => setGirlfriendInstagramId(''),
            clearSelectedPlan: () => setSelectedPlan(null),
            clearWaitlistComplete: () => setWaitlistComplete(false),
            replaceAnalyzeRoute: () => router.replace('/analyze'),
            showRefreshError: () => setError(
                '가격이 변경되어 대상 계정을 다시 확인해주세요.'
            ),
        };
        if (!effectiveSelectedPlan || !isPaidEarlybirdPlanId(effectiveSelectedPlan)) {
            applyEarlybirdPricingRefreshBoundary(stalePricingPreflightId, refreshActions);
            return;
        }
        void recoverOrRefreshStaleEarlybirdPricing(stalePricingPreflightId, effectiveSelectedPlan, {
            request: fetch,
            redirectCheckout: nextUrl => {
                if (
                    analyticsEligible
                    && effectiveSelectedPlan
                    && isPaidEarlybirdPlanId(effectiveSelectedPlan)
                ) {
                    trackEvent(EVENTS.CHECKOUT_REDIRECTED, {
                        plan_id: effectiveSelectedPlan,
                        preflight_id: stalePricingPreflightId,
                    });
                }
                window.location.assign(nextUrl);
            },
            refreshActions,
        });
    }, [
        analyticsEligible,
        clearAutoCheckoutContinuation,
        effectiveSelectedPlan,
        reset,
        router,
        setError,
        stalePricingPreflightId,
    ]);

    useEffect(() => {
        if (
            !readyPreflight
            || !exclusionDecided
            || !analyticsEligible
            || autoCheckoutUiPending
            || activePrecheckoutSurface !== 'legacy'
        ) return;
        for (const plan of readyPreflight.plans) {
            if (
                plan.planId === 'plus'
                || plan.selectionState === 'unavailable'
                || plan.price.status !== 'quoted'
            ) continue;
            const key = planViewEventKey(
                readyPreflight.preflightId,
                readyPreflight.pricingVersion,
                plan.planId,
            );
            if (planViewsTrackedRef.current.has(key)) continue;
            planViewsTrackedRef.current.add(key);
            if (!tryClaimAnalyticsEvent(availableAnalyticsStorage(), key)) continue;
            emitCurrentEarlybirdPricingEvent(
                'plan_viewed',
                readyPreflight,
                plan.planId,
                properties => trackEvent(EVENTS.PLAN_VIEWED, properties)
            );
        }
    }, [
        activePrecheckoutSurface,
        analyticsEligible,
        autoCheckoutUiPending,
        exclusionDecided,
        readyPreflight,
    ]);

    useEffect(() => {
        if (authLoading || initializedRef.current || typeof window === 'undefined') return;
        initializedRef.current = true;

        const params = new URLSearchParams(window.location.search);
        const resumablePreflightId = params.get('preflight');
        const shouldAutostart = params.get('autostart') === '1';
        const requestedCheckoutPlan = checkoutContinuationPlan(params);
        setAutoCheckoutRequested(requestedCheckoutPlan !== null);
        setAutoCheckoutPreflightId(
            requestedCheckoutPlan && resumablePreflightId ? resumablePreflightId : null,
        );
        setAutoCheckoutPlan(requestedCheckoutPlan);
        setAutoCheckoutUiPending(hasCheckoutContinuationIntent(params));

        const resumableClaimToken = params.get('claim');
        const storage = availablePendingTargetStorage();
        if (resumablePreflightId && (user || resumableClaimToken)) {
            let boundTarget: string | null = null;
            if (user && storage) {
                try {
                    boundTarget = readPendingAnalysisTargetForPreflight(storage, {
                        ownerId: user.id,
                        preflightId: resumablePreflightId,
                    });
                } catch {
                    boundTarget = null;
                }
            }
            const displayTarget = storage
                ? readPreflightDisplayTarget(storage, { preflightId: resumablePreflightId })
                : null;
            const resumeTarget = user
                ? boundTarget ?? displayTarget
                : displayTarget;
            void resumePreflight(
                resumablePreflightId,
                resumeTarget ?? undefined,
                resumableClaimToken ?? undefined,
            ).then((resumed) => {
                if (!resumed) {
                    clearAutoCheckoutContinuation();
                    if (storage) clearPendingAnalysisTarget(storage);
                }
            });
            return;
        }

        // PREFILL_ONLY_NO_AUTOSTART: 로그인 후 아이디를 입력창에 채우기만 하고, 유료 preflight
        // 조회는 유저가 "대상 계정 확인하기"를 눌러 handleStartPreflight 가 실행될 때만 시작한다.
        let pending: string | null = null;
        if (shouldAutostart) {
            try {
                pending = readPendingAnalysisTargetForAutostart(sessionStorage);
            } catch {
                pending = null;
            }
        } else {
            clearPendingAnalysisTarget(sessionStorage);
        }
        if (pending) {
            window.setTimeout(() => setInstagramId(pending), 0);
        }

        if (!shouldAutostart || !pending) return;
    }, [authLoading, clearAutoCheckoutContinuation, resumePreflight, router, user]);

    useEffect(() => {
        if (user || !loginFallbackRequired || !instagramId.trim()) return;
        if (!storePendingAnalysisTarget(sessionStorage, instagramId)) return;
        setLoginPromptOpen(true);
    }, [instagramId, loginFallbackRequired, user]);

    const handleStartPreflight = async () => {
        clearAutoCheckoutContinuation();
        if (devPresentation && !user) {
            storePendingAnalysisTarget(sessionStorage, instagramId);
            setLoginPromptOpen(true);
            return;
        }
        const accepted = devPresentation ? await startPreflight(instagramId, fixtureScenario) : await startPreflight(instagramId);
        if (!accepted) {
            if (user) clearPendingAnalysisTarget(sessionStorage);
            return;
        }
        if (accepted.demo === true) {
            // The server-issued demo marker is schema-validated by the hook;
            // derive a fixed owner result path from its UUID, never a URL field.
            router.replace(`/result/${encodeURIComponent(accepted.preflightId)}?pipeline=v2`);
            return;
        }
        if (user) {
            bindPendingAnalysisTarget(sessionStorage, {
                ownerId: user.id,
                preflightId: accepted.preflightId,
                target: instagramId,
            });
        }
        const next = new URLSearchParams({ preflight: accepted.preflightId });
        if (accepted.claimToken) next.set('claim', accepted.claimToken);
        router.replace(`/analyze?${next.toString()}`);
    };

    const handleExclusion = async () => {
        await submitExclusion(girlfriendInstagramId);
    };

    const trackPlanSelection = useCallback((planId: PlanId) => {
        if (!readyPreflight || !analyticsEligible) return;
        const plan = readyPreflight.plans.find(candidate => candidate.planId === planId);
        if (!plan || plan.selectionState === 'unavailable') return;
        const key = planSelectedEventKey(
            readyPreflight.preflightId,
            readyPreflight.pricingVersion,
            planId,
        );
        if (planSelectionsTrackedRef.current.has(key)) return;
        planSelectionsTrackedRef.current.add(key);
        if (!tryClaimAnalyticsEvent(availableAnalyticsStorage(), key)) return;
        emitCurrentEarlybirdPricingEvent(
            'plan_selected',
            readyPreflight,
            planId,
            properties => trackEvent(EVENTS.PLAN_SELECTED, properties)
        );
    }, [analyticsEligible, readyPreflight]);

    const handlePlanSelection = (planId: PlanId) => {
        if (autoCheckoutRequested && autoCheckoutPlan !== planId) {
            clearAutoCheckoutContinuation();
        }
        setCheckoutStatusCta(null);
        setSelectedPlan(planId);
        trackPlanSelection(planId);
    };

    // Precheckout immersive preview's CTA opens this legacy surface, then resets the viewport
    // to its top — it must not select a plan, start checkout, trigger login, or scroll to plans.
    const planGateRequestedRef = useRef(false);
    useEffect(() => {
        setPrecheckoutSurface({
            preflightId: immersivePreflight?.preflightId ?? null,
            surface: 'awaiting',
        });
        planGateRequestedRef.current = false;
    }, [immersivePreflight?.preflightId]);
    const handleGoToPlans = useCallback(() => {
        const preflightId = immersivePreflight?.preflightId;
        if (!preflightId) return;
        planGateRequestedRef.current = true;
        // The legacy surface unmounts the result sheet, so the heading takes its own eyebrow
        // back. Without this the withdrawal outlived the sheet and the plan screen rendered
        // permanently unlabelled.
        setBliteResultShown(false);
        setPrecheckoutSurface({ preflightId, surface: 'legacy' });
    }, [immersivePreflight?.preflightId]);
    const handleRetryPreflight = useCallback(async () => {
        clearAutoCheckoutContinuation();
        const retryTarget = targetInstagramId;
        if (!retryTarget) return;
        const activePreflightId = preflight?.preflightId;
        const storage = availablePendingTargetStorage();
        if (storage && activePreflightId) {
            clearPreflightDisplayTarget(storage, activePreflightId);
        }
        setBliteResultShown(false);
        setPrecheckoutSurface({ preflightId: null, surface: 'awaiting' });
        reset();
        const accepted = devPresentation ? await startPreflight(retryTarget, fixtureScenario) : await startPreflight(retryTarget);
        if (!accepted) {
            if (user) clearPendingAnalysisTarget(sessionStorage);
            return;
        }
        if (accepted.demo === true) {
            router.replace(`/result/${encodeURIComponent(accepted.preflightId)}?pipeline=v2`);
            return;
        }
        if (user) {
            bindPendingAnalysisTarget(sessionStorage, {
                ownerId: user.id,
                preflightId: accepted.preflightId,
                target: retryTarget,
            });
        }
        const next = new URLSearchParams({ preflight: accepted.preflightId });
        if (accepted.claimToken) next.set('claim', accepted.claimToken);
        router.replace(`/analyze?${next.toString()}`);
    }, [clearAutoCheckoutContinuation, devPresentation, fixtureScenario, preflight?.preflightId, reset, router, startPreflight, targetInstagramId, user]);
    useEffect(() => {
        // Fires once, exactly on the explicit CTA transition — whether the legacy surface
        // initially renders the pending status or the ready target/plans. A later readiness
        // change must not trigger a second, delayed scroll to plans.
        if (!planGateRequestedRef.current || activePrecheckoutSurface !== 'legacy') return;
        planGateRequestedRef.current = false;
        requestAnimationFrame(() => {
            window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        });
    }, [activePrecheckoutSurface]);

    const handleCheckoutStatusNavigation = () => {
        if (!activeCheckoutStatusCta || activeCheckoutStatusCta.navigating) return;
        setCheckoutStatusCta(current => current === activeCheckoutStatusCta
            ? { ...current, navigating: true }
            : current);
        router.push(activeCheckoutStatusCta.path);
    };

    const handleEarlybirdAction = useCallback(async () => {
        const autoCheckoutAttempt = autoCheckoutRecoveryRequestedRef.current;
        if (!effectiveSelectedPlan || !readyPreflight || !selectedPlanAvailable) {
            if (autoCheckoutAttempt) setAutoCheckoutUiPending(false);
            return;
        }
        if (!canSubmitEarlybirdSelection(
            effectiveSelectedPlan,
            DISCLOSURE_ACCEPTED,
            selectedPlanAvailable
        )) {
            if (autoCheckoutAttempt) setAutoCheckoutUiPending(false);
            return;
        }

        autoCheckoutRecoveryRequestedRef.current = false;

        trackPlanSelection(effectiveSelectedPlan);
        if (!user) {
            if (autoCheckoutAttempt) setAutoCheckoutUiPending(false);
            if (analyticsEligible && isPaidEarlybirdPlanId(effectiveSelectedPlan)) {
                // The checkout flow begins at the click that opens the auth
                // prompt. This keeps the anonymous pricing funnel measurable;
                // the actual order remains server-gated until OAuth claim.
                emitCurrentEarlybirdPricingEvent(
                    'checkout_started',
                    readyPreflight,
                    effectiveSelectedPlan,
                    properties => trackEvent(EVENTS.CHECKOUT_STARTED, properties),
                );
            }
            const loginProperties = {
                plan_id: effectiveSelectedPlan,
                ...(effectiveSelectedCard?.price.status === 'quoted'
                    ? { amount_krw: effectiveSelectedCard.price.amountKrw }
                    : {}),
                preflight_id: readyPreflight.preflightId,
                ...(currentAttributionSource(availableAnalyticsStorage())
                    ? { source: 'shared' as const }
                    : {}),
            };
            if (analyticsEligible) trackEvent(EVENTS.LOGIN_PROMPTED, loginProperties);
            setLoginPromptOpen(true);
            return;
        }

        setPurchaseSubmitting(true);
        setWaitlistComplete(false);
        setCheckoutStatusCta(null);
        setError(null);
        let checkoutRedirectStarted = false;
        try {
            const paidPlan = isPaidEarlybirdPlanId(effectiveSelectedPlan);
            const analyticsProperties = {
                plan_id: effectiveSelectedPlan,
                ...(effectiveSelectedCard?.price.status === 'quoted'
                    ? { amount_krw: effectiveSelectedCard.price.amountKrw }
                    : {}),
                preflight_id: readyPreflight.preflightId,
            };
            if (paidPlan) {
                if (analyticsEligible) emitCurrentEarlybirdPricingEvent(
                    'checkout_started',
                    readyPreflight,
                    effectiveSelectedPlan,
                    properties => trackEvent(EVENTS.CHECKOUT_STARTED, properties)
                );
            }
            const response = await fetch(
                paidPlan ? '/api/earlybird/checkout' : '/api/earlybird/waitlist',
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(paidPlan ? {
                        preflightId: readyPreflight.preflightId,
                        planId: effectiveSelectedPlan,
                        disclosureAccepted: DISCLOSURE_ACCEPTED,
                    } : {
                        preflightId: readyPreflight.preflightId,
                        planId: 'plus',
                    }),
                }
            );
            const payload: unknown = await response.json().catch(() => null);
            if (!response.ok) {
                const lineageStatusAction = earlybirdCheckoutLineageStatusAction(
                    response.status,
                    payload,
                    effectiveSelectedPlan
                );
                if (lineageStatusAction) {
                    if (
                        lineageStatusAction.kind === 'active_pending'
                        && autoCheckoutAttempt
                        && isPaidEarlybirdPlanId(effectiveSelectedPlan)
                    ) {
                        const recoveryResult = await recoverPendingEarlybirdCheckout(
                            readyPreflight.preflightId,
                            effectiveSelectedPlan,
                            checkoutRecoveryGuardRef.current,
                            {
                                request: fetch,
                                redirectCheckout: nextUrl => {
                                    checkoutRedirectStarted = true;
                                    if (analyticsEligible) {
                                        trackEvent(EVENTS.CHECKOUT_REDIRECTED, analyticsProperties);
                                    }
                                    window.location.assign(nextUrl);
                                },
                                setPending: setPurchaseSubmitting,
                                showError: setError,
                            },
                        );
                        if (recoveryResult === 'checkout_recovered') return;
                    }
                    const lineageMessage = payload && typeof payload === 'object'
                        && 'error' in payload && typeof payload.error === 'string'
                        && payload.error.length <= 200
                        ? payload.error
                        : '기존 결제 처리 상태를 먼저 확인해주세요.';
                    setCheckoutStatusCta({
                        path: lineageStatusAction.path,
                        message: lineageMessage,
                        preflightId: readyPreflight.preflightId,
                        targetInstagramId,
                        planId: effectiveSelectedPlan,
                        kind: lineageStatusAction.kind,
                        navigating: false,
                    });
                    return;
                }
                const message = payload && typeof payload === 'object' && 'error' in payload
                    && typeof payload.error === 'string' && payload.error.length <= 200
                    ? payload.error
                    : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.';
                if (
                    payload && typeof payload === 'object' && 'code' in payload
                    && payload.code === 'EARLYBIRD_SOLD_OUT'
                ) {
                    // Show the error immediately so a slow refresh below can't leave the
                    // user staring at a disabled button with no feedback.
                    setError(message);
                    // The one-shot preflight snapshot is now stale; refresh it so the
                    // plan card flips to sold-out copy instead of contradicting this error.
                    await refreshPreflight();
                }
                if (
                    payload && typeof payload === 'object' && 'code' in payload
                    && payload.code === 'EARLYBIRD_PRICING_REFRESH_REQUIRED'
                ) {
                    reset();
                    setGirlfriendInstagramId('');
                    setSelectedPlan(null);
                                setWaitlistComplete(false);
                    router.replace('/analyze');
                    setError('가격이 변경되어 대상 계정을 다시 확인해주세요.');
                    return;
                }
                setError(message);
                return;
            }
            if (!paidPlan) {
                setWaitlistComplete(true);
                return;
            }
            // The operator-only synthetic checkout is the one compatibility
            // response that intentionally points at local progress. Keep it
            // strictly same-origin and do not count it as a payment redirect.
            if (devPresentation && payload && typeof payload === 'object' && 'nextUrl' in payload
                && typeof payload.nextUrl === 'string' && isSafeDevUiCheckoutUrl(payload.nextUrl)) {
                checkoutRedirectStarted = true;
                window.location.assign(payload.nextUrl);
                return;
            }
            if (
                payload
                && typeof payload === 'object'
                && 'nextUrl' in payload
                && typeof payload.nextUrl === 'string'
                && isSafeEarlybirdDemoProgressUrl(payload.nextUrl)
            ) {
                checkoutRedirectStarted = true;
                window.location.assign(payload.nextUrl);
                return;
            }
            if (!payload || typeof payload !== 'object'
                || !('nextUrl' in payload)
                || typeof payload.nextUrl !== 'string'
                || !isSafeEarlybirdCheckoutContinuationUrl(payload.nextUrl)) {
                setError('결제창 주소를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.');
                return;
            }
            if (analyticsEligible) trackEvent(EVENTS.CHECKOUT_REDIRECTED, analyticsProperties);
            checkoutRedirectStarted = true;
            window.location.assign(payload.nextUrl);
        } catch {
            setError('요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.');
        } finally {
            setPurchaseSubmitting(false);
            if (shouldClearAutoCheckoutUiPending({
                autoCheckoutAttempt,
                checkoutRedirectStarted,
            })) setAutoCheckoutUiPending(false);
        }
    }, [
        DISCLOSURE_ACCEPTED,
        devPresentation,
        analyticsEligible,
        effectiveSelectedCard,
        effectiveSelectedPlan,
        readyPreflight,
        refreshPreflight,
        reset,
        router,
        selectedPlanAvailable,
        setError,
        targetInstagramId,
        trackPlanSelection,
        user,
    ]);

    useEffect(() => {
        if (
            autoCheckoutUiPending
            && autoCheckoutRequested
            && readyPreflight
            && exclusionDecided
            && autoCheckoutPlan
            && (
                autoCheckoutPreflightId !== readyPreflight.preflightId
                || autoCheckoutPlan !== effectiveSelectedPlan
                || !selectedPlanAvailable
            )
        ) {
            clearAutoCheckoutContinuation();
            return;
        }

        const preflightId = readyPreflight?.preflightId ?? null;
        if (!shouldAutoSubmitEarlybirdAction({
            requested: autoCheckoutRequested,
            authenticated: Boolean(user),
            ready: readyPreflight !== null,
            preflightId,
            requestedPreflightId: autoCheckoutPreflightId,
            requestedPlanId: autoCheckoutPlan,
            planId: effectiveSelectedPlan,
            exclusionDecided,
            planAvailable: selectedPlanAvailable,
            submitting: purchaseSubmitting,
            attemptedKey: autoCheckoutAttemptedRef.current,
        })) return;
        if (!preflightId || !effectiveSelectedPlan) return;

        autoCheckoutAttemptedRef.current = checkoutContinuationKey(
            preflightId,
            effectiveSelectedPlan,
        );
        // Only after every exact check above has passed: release the legacy
        // surface so a failed submission still lands on the plan/error screen
        // instead of replaying the four-stage demo. Same rule as the CTA path:
        // the sheet is gone, so the heading's eyebrow comes back.
        setBliteResultShown(false);
        setPrecheckoutSurface({ preflightId, surface: 'legacy' });
        consumeAutoCheckoutContinuation();
        autoCheckoutRecoveryRequestedRef.current = true;
        void handleEarlybirdAction();
    }, [
        autoCheckoutRequested,
        autoCheckoutPlan,
        autoCheckoutPreflightId,
        autoCheckoutUiPending,
        clearAutoCheckoutContinuation,
        consumeAutoCheckoutContinuation,
        effectiveSelectedPlan,
        exclusionDecided,
        handleEarlybirdAction,
        purchaseSubmitting,
        readyPreflight,
        router,
        selectedPlanAvailable,
        user,
    ]);

    const handleReset = () => {
        const activePreflightId = preflight?.preflightId;
        const storage = availablePendingTargetStorage();
        if (storage && activePreflightId) {
            clearPreflightDisplayTarget(storage, activePreflightId);
        }
        clearAutoCheckoutContinuation();
        try {
            clearPendingAnalysisTarget(sessionStorage);
        } catch {
            /* ignore */
        }
        reset();
        setPrecheckoutSurface({ preflightId: null, surface: 'awaiting' });
        setInstagramId('');
        setGirlfriendInstagramId('');
        setSelectedPlan(null);
        setPurchaseSubmitting(false);
        setWaitlistComplete(false);
        setCheckoutStatusCta(null);
        setBliteResultShown(false);
        initializedRef.current = true;
        router.replace('/analyze');
    };

    useEffect(() => {
        const storage = availablePendingTargetStorage();
        if (storage) {
            clearPendingAnalysisTargetForTerminalState(storage, preflight?.status);
        }
    }, [preflight?.status]);

    const handleLogout = async () => {
        try {
            const signedOut = await signOutAndClearPendingAnalysisTarget(
                availablePendingTargetStorage(),
            );
            if (signedOut) router.push('/');
        } catch (cause) {
            console.error('Logout failed:', cause);
        }
    };

    const loginRedirectParams = loginFallbackRequired
        ? new URLSearchParams({
            autostart: '1',
            ...(effectiveSelectedPlan ? { plan: effectiveSelectedPlan } : {}),
        })
        : new URLSearchParams({
            preflight: readyPreflight?.preflightId ?? '',
            plan: effectiveSelectedPlan ?? '',
        });
    if (!loginFallbackRequired && claimToken) loginRedirectParams.set('claim', claimToken);
    if (!loginFallbackRequired && readyPreflight && effectiveSelectedPlan && selectedPlanAvailable) {
        loginRedirectParams.set(AUTO_CHECKOUT_QUERY_PARAM, '1');
    }
    const loginRedirectTo = devPresentation && !user ? '/analyze?autostart=1' : `/analyze?${loginRedirectParams.toString()}`;

    if (authLoading) {
        return (
            <div className="flex min-h-dvh items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-blood border-t-transparent" />
            </div>
        );
    }

    return (
        <div className="min-h-dvh">
            <Suspense fallback={null}>
                <HydrationSafePlanQueryObserver />
            </Suspense>
            <TopBar
                right={user ? (
                    <button
                        onClick={handleLogout}
                        className="text-[13px] font-medium text-fg-dim transition-colors hover:text-fg"
                    >
                        로그아웃
                    </button>
                ) : undefined}
            />

            <main className="mx-auto max-w-[500px] px-5 pb-16 pt-7">
                {devPresentation && <p className="mb-5 border-l-2 border-amber pl-3 text-[13px] text-fg-dim">Dev UI 검증 · 입력한 이름의 합성 프로필을 사용합니다. 모의 결제 후 더미 분석이 진행됩니다.</p>}
                {autoCheckoutTransitionVisible && preflight?.status !== 'blocked' ? (
                    <CaseCard bracket="var(--color-blood)" className="mt-7 p-7 text-center">
                        <div role="status" aria-live="polite">
                            <div className="mx-auto flex h-14 w-14 items-center justify-center border border-line bg-ink">
                                <BrandMark size={26} className="anim-blink text-blood" />
                            </div>
                            <h1 className="mt-5 text-[22px] font-extrabold text-fg">
                                결제창으로 이동하고 있어요
                            </h1>
                            <p className="mt-2 text-[13px] text-fg-dim">
                                잠시만 기다려주세요.
                            </p>
                        </div>
                    </CaseCard>
                ) : !preflight ? (
                    <>
                        <AnalysisTargetHeading />

                        <Panel className="mt-8 p-5">
                            <AnalysisInstagramInput
                                id="target-instagram"
                                label="대상 인스타그램 아이디"
                                value={instagramId}
                                onChange={value => {
                                    setInstagramId(value);
                                    if (error) setError(null);
                                }}
                                onEnter={() => {
                                    if (!creating) void handleStartPreflight();
                                }}
                                placeholder="username"
                            />
                            {!devPresentation && <InstagramLookupLink />}
                            {devPresentation && <div className="mt-5">
                                <Link href="/dev-ui/live" className="mb-4 inline-block text-sm underline">실제 분석 · 카드 결제 없음</Link>
                                <label htmlFor="dev-fixture-scenario" className="eyebrow mb-3 block">합성 분석 시나리오</label>
                                <select id="dev-fixture-scenario" value={fixtureScenario} disabled={creating} onChange={event => setFixtureScenario(event.target.value as DevFixtureScenario)} className="min-h-12 w-full border border-line bg-ink px-3 text-[14px] text-fg">
                                    {(Object.keys(DEV_UI_SCENARIO_LABELS) as DevFixtureScenario[]).map(scenario => <option key={scenario} value={scenario}>{DEV_UI_SCENARIO_LABELS[scenario]}</option>)}
                                </select>
                            </div>}
                            {/* Rails rather than nested boxes: a notice inside a panel
                                is an annotation, not another surface. */}
                            <p className="mt-4 border-l-2 border-amber pl-3 text-[12px] leading-relaxed text-fg-dim">
                                <span className="font-semibold text-amber">공개 계정</span>만 판독 가능합니다.
                            </p>
                            {error && (
                                <p data-amp-mask className="mt-4 border-l-2 border-blood pl-3 text-[13px] leading-relaxed text-blood-2" role="alert">
                                    {error}
                                </p>
                            )}
                            <div className="mt-5">
                                <PrimaryButton
                                    onClick={handleStartPreflight}
                                    disabled={!instagramId.trim() || creating}
                                >
                                    {creating ? '계정 확인 중…' : '대상 계정 확인하기'}
                                </PrimaryButton>
                            </div>
                        </Panel>
                    </>
                ) : preflight.status === 'blocked' ? (
                    <CaseCard bracket="var(--color-blood)" className="p-7 text-center">
                        <Eyebrow className="justify-center">사전 점검 중단</Eyebrow>
                        <h1 className="mt-4 text-[22px] font-extrabold text-fg">판독 대상을 확인해주세요</h1>
                        <p data-amp-mask className="mt-3 text-[13px] leading-relaxed text-fg-dim">
                            {error ?? '현재 이 계정은 판독할 수 없습니다.'}
                        </p>
                        <div className="mt-7">
                            <PrimaryButton onClick={handleReset}>다른 계정 확인하기</PrimaryButton>
                        </div>
                    </CaseCard>
                ) : (
                    <>
                        <AnalysisPreflightHeading
                            exclusionDecided={exclusionDecided}
                            ready={!!readyPreflight}
                            bliteResultShown={bliteResultShown}
                            onChangeTarget={handleReset}
                        />

                        {!exclusionDecided && !devPresentation && (
                            <AnalysisExclusionPanel
                                value={girlfriendInstagramId}
                                onChange={value => {
                                    setGirlfriendInstagramId(value);
                                    if (error) setError(null);
                                }}
                                onExclude={handleExclusion}
                                onSkip={() => void submitExclusion()}
                                saving={exclusionState === 'saving'}
                                error={error}
                            />
                        )}

                        {immersivePreflight
                            && !autoCheckoutTransitionVisible
                            && activePrecheckoutSurface !== 'legacy' && (
                            <PrecheckoutImmersive
                                key={`${immersivePreflight.preflightId}:${claimToken ?? ''}`}
                                preflightId={immersivePreflight.preflightId}
                                claimToken={claimToken}
                                submittedAtMs={preflightStartedAt}
                                targetUsername={targetInstagramId}
                                onGoToPlans={handleGoToPlans}
                                onRetry={handleRetryPreflight}
                                onBliteResultShown={handleBliteResultShown}
                            />
                        )}

                        {exclusionDecided && activePrecheckoutSurface === 'legacy' && !readyPreflight && (
                            <PreflightPendingStatus
                                targetInstagramId={targetInstagramId}
                                startedAt={preflightStartedAt}
                            />
                        )}

                        {exclusionDecided && activePrecheckoutSurface === 'legacy' && readyPreflight && (
                            <>
                                {!autoCheckoutTransitionVisible && <AnalysisTargetCard target={readyPreflight.target} />}

                                <AnalysisPlanSection>
                                    <AnalysisPlanCards
                                        plans={readyPreflight.plans}
                                        requiredPlan={readyPreflight.requiredPlan}
                                        selectedPlan={effectiveSelectedPlan}
                                        onPlanSelection={handlePlanSelection}
                                    />

                                    {readyPreflight
                                        && effectiveSelectedCard
                                        && isPaidEarlybirdPlanId(effectiveSelectedCard.planId) && (
                                        <p className="mt-4 text-[11.5px] leading-relaxed text-fg-dim">
                                            {EARLYBIRD_DISCLOSURE_TEXT}
                                        </p>
                                    )}

                                    {visibleError && (
                                        <div
                                            id="checkout-recovery-message"
                                            data-amp-mask
                                            className="mt-4 border border-blood/45 bg-blood/10 px-3 py-2.5 text-[13px] text-blood"
                                            role="alert"
                                        >
                                            {visibleError}
                                        </div>
                                    )}
                                    {activeCheckoutStatusCta && (
                                        <div className="mt-3">
                                            <PrimaryButton
                                                type="button"
                                                onClick={handleCheckoutStatusNavigation}
                                                disabled={activeCheckoutStatusCta.navigating}
                                                aria-describedby={visibleError
                                                    ? 'checkout-recovery-message'
                                                    : undefined}
                                            >
                                                {activeCheckoutStatusCta.navigating
                                                    ? '결제 상태 불러오는 중…'
                                                    : activeCheckoutStatusCta.kind === 'active_pending'
                                                        ? '기존 결제창 확인하기'
                                                        : '결제 상태 확인하기'}
                                            </PrimaryButton>
                                        </div>
                                    )}
                                    {waitlistComplete && (
                                        <div className="mt-4 border border-amber/45 bg-amber/10 px-3 py-2.5 text-[13px] text-amber" role="status">
                                            Plus 대기 신청이 완료되었습니다.
                                        </div>
                                    )}
                                    <div className="mt-5">
                                        <PrimaryButton
                                            onClick={handleEarlybirdAction}
                                            size="lg"
                                            disabled={
                                                !effectiveSelectedPlan
                                                || purchaseSubmitting
                                                || waitlistComplete
                                                || !selectedPlanAvailable
                                            }
                                        >
                                            {purchaseSubmitting
                                                ? '요청 처리 중…'
                                                : waitlistComplete
                                                    ? '대기 신청 완료'
                                                    : !effectiveSelectedPlan
                                                        ? '플랜을 선택해주세요'
                                                        : !selectedPlanAvailable
                                                            ? (noPlanSelectable
                                                                ? '얼리버드 물량이 모두 소진되었어요'
                                                                : '이용 가능한 플랜을 선택해주세요')
                                                            : buildEarlybirdPlanPresentation(
                                                                effectiveSelectedPlan
                                                            ).actionLabel}
                                        </PrimaryButton>
                                    </div>
                                </AnalysisPlanSection>
                            </>
                        )}
                    </>
                )}
            </main>

            <LoginModal
                open={loginPromptOpen}
                onClose={() => setLoginPromptOpen(false)}
                redirectTo={loginRedirectTo}
            />

        </div>
    );
}
