'use client';

import Image from 'next/image';
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
    isEarlybirdPlanSoldOut,
    isCurrentEarlybirdCheckoutStatusCta,
    isSafeEarlybirdCheckoutContinuationUrl,
    recoverPendingEarlybirdCheckout,
    recoverOrRefreshStaleEarlybirdPricing,
    resolveEarlybirdPricingBoundary,
} from '@/lib/services/earlybird/ui-state';
import { isSafeEarlybirdDemoProgressUrl } from '@/lib/services/earlybird/checkout-continuation';
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
import {
    resolveActivePrecheckoutSurface,
    type PrecheckoutSurfaceState,
} from '@/lib/services/precheckout/blite-page-flow';

const PLAN_NAMES: Readonly<Record<PlanId, string>> = {
    basic: 'Basic',
    standard: 'Standard',
    plus: 'Plus',
};

interface CheckoutStatusCta {
    path: string;
    message: string;
    preflightId: string;
    targetInstagramId: string | null;
    planId: PlanId;
    kind: 'active_pending' | 'status_only';
    navigating: boolean;
}

function relationshipCapacityLabel(
    capacity: { followers: number; following: number },
    lowerBound?: { followers: number; following: number } | null
): string {
    const fmt = (value: number) => value.toLocaleString('ko-KR');
    if (capacity.followers === capacity.following) {
        const upper = capacity.followers;
        if (lowerBound && lowerBound.followers === lowerBound.following && lowerBound.followers > 0) {
            return `팔로워·팔로잉 각 ${fmt(lowerBound.followers)}~${fmt(upper)}명`;
        }
        return `팔로워·팔로잉 각 ${fmt(upper)}명 이하`;
    }
    return `팔로워 ${fmt(capacity.followers)}명 · 팔로잉 ${fmt(capacity.following)}명 이하`;
}

export default function AnalyzePage() {
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
        const accepted = await startPreflight(instagramId);
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
        setPrecheckoutSurface({ preflightId, surface: 'legacy' });
    }, [immersivePreflight?.preflightId]);
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
        // instead of replaying the four-stage demo.
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

    /**
     * The B-lite result sheet carries its own single eyebrow. The page heading above it carries
     * a second one, which put two eyebrow-like labels on the same screen, so the page withdraws
     * its own for that state only.
     */
    const [bliteResultShown, setBliteResultShown] = useState(false);
    const handleBliteResultShown = useCallback(() => setBliteResultShown(true), []);

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
    const loginRedirectTo = `/analyze?${loginRedirectParams.toString()}`;

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
                        <Eyebrow>판독 의뢰서 · 대상 지정</Eyebrow>
                        <h1 className="mt-3 text-[26px] font-extrabold leading-snug text-fg">
                            누구를 판독할까요?
                        </h1>
                        <p className="mt-2 text-[14px] text-fg-dim">
                            남자친구의 인스타그램 아이디를 입력해주세요.
                        </p>

                        <Panel className="mt-8 p-5">
                            <label htmlFor="target-instagram" className="eyebrow mb-3 block">
                                대상 인스타그램 아이디
                            </label>
                            <div className="relative" data-amp-mask>
                                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim">@</span>
                                <input
                                    id="target-instagram"
                                    type="text"
                                    value={instagramId}
                                    onChange={(event) => {
                                        setInstagramId(event.target.value);
                                        if (error) setError(null);
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter' && !creating) void handleStartPreflight();
                                    }}
                                    placeholder="username"
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="w-full border border-line bg-ink py-3.5 pl-9 pr-4 text-[15px] text-fg placeholder-fg-mute transition-colors focus:border-blood focus:outline-none"
                                />
                            </div>
                            <InstagramLookupLink />
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
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                {!bliteResultShown && (
                                    <Eyebrow>{exclusionDecided ? '판독 의뢰서 · 대상 확인' : '판독 의뢰서 · 본인 제외'}</Eyebrow>
                                )}
                                <h1 className={`${bliteResultShown ? '' : 'mt-3 '}text-[24px] font-extrabold leading-snug text-fg`}>
                                    {!exclusionDecided
                                        ? '본인 계정은 먼저 제외해주세요'
                                        : readyPreflight
                                            ? '판독 대상을 확인했어요'
                                            : '대상 계정을 확인하고 있어요'}
                                </h1>
                            </div>
                            <button
                                type="button"
                                onClick={handleReset}
                                className="shrink-0 text-[12px] font-medium text-fg-mute underline underline-offset-4 hover:text-fg"
                            >
                                대상 변경
                            </button>
                        </div>

                        {!exclusionDecided && (
                            <Panel className="mt-6 p-5">
                                <p className="text-[13px] leading-relaxed text-fg-dim">
                                    본인 계정은 위장여사친 후보에서 처음부터 제외합니다.
                                </p>
                                <label htmlFor="girlfriend-instagram" className="eyebrow mb-3 mt-4 block">
                                    본인 인스타그램 아이디
                                </label>
                                <div className="relative" data-amp-mask>
                                    <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim">@</span>
                                    <input
                                        id="girlfriend-instagram"
                                        type="text"
                                        value={girlfriendInstagramId}
                                        onChange={(event) => {
                                            setGirlfriendInstagramId(event.target.value);
                                            if (error) setError(null);
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' && exclusionState !== 'saving') void handleExclusion();
                                        }}
                                        placeholder="my_username"
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        spellCheck={false}
                                        className="w-full border border-line bg-ink py-3.5 pl-9 pr-4 text-[15px] text-fg placeholder-fg-mute transition-colors focus:border-blood focus:outline-none"
                                    />
                                </div>
                                {error && (
                                    <p data-amp-mask className="mt-4 border-l-2 border-blood pl-3 text-[13px] leading-relaxed text-blood-2" role="alert">
                                        {error}
                                    </p>
                                )}
                                <div className="mt-5 space-y-2.5">
                                    <PrimaryButton
                                        onClick={handleExclusion}
                                        disabled={!girlfriendInstagramId.trim() || exclusionState === 'saving'}
                                    >
                                        {exclusionState === 'saving' ? '제외 계정 저장 중…' : '내 계정 제외하기'}
                                    </PrimaryButton>
                                    <button
                                        type="button"
                                        onClick={() => void submitExclusion()}
                                        disabled={exclusionState === 'saving'}
                                        className="w-full border border-line-2 px-4 py-3 text-[13px] font-bold text-fg-dim transition-colors hover:bg-panel hover:text-fg disabled:opacity-50"
                                    >
                                        본인 계정 제외 안 함
                                    </button>
                                </div>
                            </Panel>
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
                                {!autoCheckoutTransitionVisible && (
                                <CaseCard
                                    bracket="var(--color-blood)"
                                    className="mt-7 overflow-hidden"
                                    data-precheckout-target-card
                                >
                                    <div className="flex items-start gap-4 p-5" data-amp-block>
                                        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-line-2 bg-panel">
                                            {readyPreflight.target.profileImage ? (
                                                <Image
                                                    src={readyPreflight.target.profileImage}
                                                    alt={`@${readyPreflight.target.username} 프로필`}
                                                    fill
                                                    sizes="64px"
                                                    unoptimized
                                                    className="object-cover"
                                                />
                                            ) : (
                                                <div className="flex h-full w-full items-center justify-center">
                                                    <BrandMark size={25} className="text-fg-mute" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <span className="eyebrow">판독 대상 확인</span>
                                            <h2 className="mt-1 truncate text-[19px] font-extrabold text-fg">
                                                @{readyPreflight.target.username}
                                            </h2>
                                            {readyPreflight.target.fullName && (
                                                <p className="mt-0.5 truncate text-[13px] text-fg-dim">
                                                    {readyPreflight.target.fullName}
                                                </p>
                                            )}
                                            {readyPreflight.target.bio && (
                                                <p className="mt-1.5 line-clamp-2 whitespace-pre-line text-[12px] leading-relaxed text-fg-mute">
                                                    {readyPreflight.target.bio}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 border-t border-line">
                                        <div className="border-r border-line px-4 py-3 text-center">
                                            <p className="num text-[17px] font-extrabold text-fg">
                                                {readyPreflight.target.followersCount.toLocaleString('ko-KR')}
                                            </p>
                                            <p className="mt-0.5 text-[11px] text-fg-mute">팔로워</p>
                                        </div>
                                        <div className="px-4 py-3 text-center">
                                            <p className="num text-[17px] font-extrabold text-fg">
                                                {readyPreflight.target.followingCount.toLocaleString('ko-KR')}
                                            </p>
                                            <p className="mt-0.5 text-[11px] text-fg-mute">팔로잉</p>
                                        </div>
                                    </div>
                                </CaseCard>
                                )}

                                <section
                                    id="plan-selection"
                                    className="mt-9 scroll-mt-20"
                                    aria-labelledby="plan-heading"
                                >
                                    <Eyebrow>요금제 선택</Eyebrow>
                                    <h2
                                        id="plan-heading"
                                        className="mt-3 text-[22px] font-extrabold text-fg outline-none"
                                    >
                                        계정 규모에 맞는 플랜이에요
                                    </h2>
                                    <p className="mt-2 text-[13px] leading-relaxed text-fg-dim">
                                        전체 플랜을 비교해보고, 계정에 맞는 이용 가능한 플랜으로 진행하세요.
                                    </p>

                                    <fieldset className="mt-5 space-y-3">
                                        <legend className="sr-only">판독 플랜</legend>
                                        {readyPreflight.plans.map((plan, index) => {
                                            const available = isEarlybirdPlanSelectable(
                                                plan,
                                                readyPreflight.requiredPlan
                                            );
                                            const selected = effectiveSelectedPlan === plan.planId;
                                            const presentation = buildEarlybirdPlanPresentation(plan.planId);
                                            const lowerBound = index > 0
                                                ? readyPreflight.plans[index - 1].relationshipCapacity
                                                : null;
                                            return (
                                                <label
                                                    key={plan.planId}
                                                    className={`block cursor-pointer border p-3.5 transition-colors ${
                                                        selected
                                                            ? 'border-blood bg-blood/[0.08]'
                                                            : 'border-line-2 bg-ink-2 hover:border-fg-dim'
                                                    }`}
                                                >
                                                    <input
                                                        type="radio"
                                                        name="analysis-plan"
                                                        value={plan.planId}
                                                        checked={selected}
                                                        onChange={() => handlePlanSelection(plan.planId)}
                                                        className="sr-only"
                                                    />
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div className="min-w-0">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-[16px] font-extrabold text-fg">
                                                                    {PLAN_NAMES[plan.planId]}
                                                                </span>
                                                                {plan.selectionState === 'required' && (
                                                                    <span className="border border-blood/50 bg-blood/10 px-1.5 py-0.5 text-[10px] font-bold text-blood">
                                                                        이용 가능
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <p className="mt-1 text-[12px] text-fg-dim">
                                                                {relationshipCapacityLabel(
                                                                    plan.relationshipCapacity,
                                                                    lowerBound
                                                                )}
                                                            </p>
                                                        </div>
                                                        <span className={`mt-1 block h-[18px] w-[18px] shrink-0 rounded-full border ${
                                                            selected
                                                                ? 'border-[5px] border-blood bg-white'
                                                                : 'border-line-2'
                                                        }`} />
                                                    </div>

                                                    {presentation.referencePriceLabel ? (
                                                        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                                            <span className="num text-[18px] text-fg-mute line-through">
                                                                {presentation.referencePriceLabel}
                                                            </span>
                                                            <span className="text-[15px] text-fg-mute" aria-hidden>→</span>
                                                            <span className="num text-[22px] font-black leading-none tracking-tight text-fg">
                                                                {presentation.priceLabel}
                                                            </span>
                                                            {presentation.discountLabel && (
                                                                <span className="self-center border border-blood bg-blood/10 px-2 py-[3px] text-[13px] font-extrabold leading-none text-blood">
                                                                    {presentation.discountLabel}
                                                                </span>
                                                            )}
                                                        </div>
                                                    ) : (
                                                        <p className="num mt-2.5 text-[15px] font-bold text-fg-dim">
                                                            {presentation.priceLabel}
                                                        </p>
                                                    )}

                                                    {plan.selectionState !== 'unavailable' && isEarlybirdPlanSoldOut(plan) ? (
                                                        <p className="mt-2.5 border-t border-line pt-2.5 text-[11px] font-bold text-fg-mute">
                                                            얼리버드 물량이 모두 소진되었어요.
                                                        </p>
                                                    ) : available && typeof plan.remainingSlots === 'number' ? (
                                                        <p className="mt-2.5 flex items-center gap-1.5 border-t border-line pt-2.5 text-[11px] font-extrabold text-blood">
                                                            <span aria-hidden>🔥</span>
                                                            선착순 마감 임박 · {plan.remainingSlots.toLocaleString('ko-KR')}건 남음
                                                        </p>
                                                    ) : available && presentation.referencePriceLabel ? (
                                                        <p className="mt-2.5 border-t border-line pt-2.5 text-[11px] font-bold text-amber">
                                                            얼리버드 선착순 한정
                                                        </p>
                                                    ) : !available ? (
                                                        <p className="mt-2.5 border-t border-line pt-2.5 text-[11px] font-medium text-fg-mute">
                                                            {plan.unavailableReason === 'below_required_plan'
                                                                ? '이 계정 규모에서는 이용 가능한 플랜이 아니에요.'
                                                                : '아직 오픈 전인 플랜이에요.'}
                                                        </p>
                                                    ) : null}
                                                </label>
                                            );
                                        })}
                                    </fieldset>

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
                                </section>
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
