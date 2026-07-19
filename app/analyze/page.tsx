'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useAnalysisV2Preflight } from '@/hooks/useAnalysisV2Preflight';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import {
    EARLYBIRD_DISCLOSURE_TEXT,
    isPaidEarlybirdPlanId,
} from '@/lib/domain/earlybird/catalog';
import {
    buildEarlybirdPlanPresentation,
    canSubmitEarlybirdSelection,
    isEarlybirdPlanSelectable,
    isEarlybirdPlanSoldOut,
    isSafeGrobleCheckoutUrl,
    parseEarlybirdPlanParam,
} from '@/lib/services/earlybird/ui-state';
import {
    availablePendingTargetStorage,
    bindPendingAnalysisTarget,
    clearPendingAnalysisTarget,
    clearPendingAnalysisTargetForTerminalState,
    readPendingAnalysisTargetForAutostart,
    readPendingAnalysisTargetForPreflight,
    signOutAndClearPendingAnalysisTarget,
    storePendingAnalysisTarget,
} from '@/lib/services/pending-analysis-target';
import { EVENTS, trackEvent } from '@/lib/services/analytics';
import {
    availableAnalyticsStorage,
    tryClaimAnalyticsEvent,
} from '@/lib/services/analytics-funnel';
import {
    planSelectedEventKey,
    planViewEventKey,
} from '@/lib/services/earlybird/analytics-state';
import { TopBar, BrandMark, Eyebrow, CaseCard, PrimaryButton } from '@/components/case-ui';

const PLAN_NAMES: Readonly<Record<PlanId, string>> = {
    basic: 'Basic',
    standard: 'Standard',
    plus: 'Plus',
};

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
    const [disclosureAccepted, setDisclosureAccepted] = useState(false);
    const [disclosureModalOpen, setDisclosureModalOpen] = useState(false);
    const [purchaseSubmitting, setPurchaseSubmitting] = useState(false);
    const [waitlistComplete, setWaitlistComplete] = useState(false);
    const router = useRouter();
    const { user, loading: authLoading } = useAuth();
    const initializedRef = useRef(false);
    const planViewsTrackedRef = useRef(new Set<string>());
    const planSelectionsTrackedRef = useRef(new Set<string>());
    const {
        targetInstagramId,
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
    } = useAnalysisV2Preflight();

    const readyPreflight = preflight?.status === 'ready' ? preflight : null;
    const exclusionDecided = exclusionState === 'excluded' || exclusionState === 'skipped';
    // 모든 플랜을 선택(비교)할 수 있게 하되, 아무것도 안 고르면 적격 플랜을 기본 선택.
    // 부적격 플랜을 골라도 선택 상태는 유지하고, 구매 버튼만 비활성화한다.
    const effectiveSelectedPlan = readyPreflight
        ? (selectedPlan ?? readyPreflight.requiredPlan)
        : selectedPlan;
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

    useEffect(() => {
        if (!disclosureModalOpen) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setDisclosureModalOpen(false);
        };
        document.addEventListener('keydown', onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [disclosureModalOpen]);

    useEffect(() => {
        if (!readyPreflight || !exclusionDecided) return;
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
            trackEvent(EVENTS.PLAN_VIEWED, {
                plan_id: plan.planId,
                required_plan_id: readyPreflight.requiredPlan,
                amount_krw: plan.price.amountKrw,
                preflight_id: readyPreflight.preflightId,
            });
        }
    }, [exclusionDecided, readyPreflight]);

    useEffect(() => {
        if (authLoading || initializedRef.current || typeof window === 'undefined') return;
        initializedRef.current = true;

        const params = new URLSearchParams(window.location.search);
        const linkedPlan = parseEarlybirdPlanParam(params.get('plan'));
        if (linkedPlan) setSelectedPlan(linkedPlan);
        const resumablePreflightId = params.get('preflight');
        const shouldAutostart = params.get('autostart') === '1';

        if (resumablePreflightId && user) {
            let boundTarget: string | null = null;
            try {
                boundTarget = readPendingAnalysisTargetForPreflight(sessionStorage, {
                    ownerId: user.id,
                    preflightId: resumablePreflightId,
                });
            } catch {
                boundTarget = null;
            }
            void resumePreflight(resumablePreflightId, boundTarget ?? undefined).then((resumed) => {
                const storage = availablePendingTargetStorage();
                if (!resumed && storage) clearPendingAnalysisTarget(storage);
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
        if (!user) {
            router.replace('/login?redirectTo=%2Fanalyze%3Fautostart%3D1');
        }
    }, [authLoading, resumePreflight, router, user]);

    const handleStartPreflight = async () => {
        if (!user) {
            try {
                storePendingAnalysisTarget(sessionStorage, instagramId);
            } catch {
                /* ignore */
            }
            router.push('/login?redirectTo=%2Fanalyze%3Fautostart%3D1');
            return;
        }
        const accepted = await startPreflight(instagramId);
        if (!accepted) {
            clearPendingAnalysisTarget(sessionStorage);
            return;
        }
        bindPendingAnalysisTarget(sessionStorage, {
            ownerId: user.id,
            preflightId: accepted.preflightId,
            target: instagramId,
        });
        router.replace('/analyze?preflight=' + encodeURIComponent(accepted.preflightId));
    };

    const handleExclusion = async () => {
        await submitExclusion(girlfriendInstagramId);
    };

    const trackPlanSelection = (planId: PlanId) => {
        if (!readyPreflight) return;
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
        trackEvent(EVENTS.PLAN_SELECTED, {
            plan_id: planId,
            required_plan_id: readyPreflight.requiredPlan,
            ...(plan.price.status === 'quoted' ? { amount_krw: plan.price.amountKrw } : {}),
            preflight_id: readyPreflight.preflightId,
        });
    };

    const handlePlanSelection = (planId: PlanId) => {
        setSelectedPlan(planId);
        trackPlanSelection(planId);
    };

    const handleEarlybirdAction = async () => {
        if (!effectiveSelectedPlan || !readyPreflight || !selectedPlanAvailable) return;
        if (isPaidEarlybirdPlanId(effectiveSelectedPlan) && !disclosureAccepted) {
            setDisclosureModalOpen(true);
            return;
        }
        if (!canSubmitEarlybirdSelection(
            effectiveSelectedPlan,
            disclosureAccepted,
            selectedPlanAvailable
        )) return;

        setPurchaseSubmitting(true);
        setWaitlistComplete(false);
        setError(null);
        try {
            const paidPlan = isPaidEarlybirdPlanId(effectiveSelectedPlan);
            trackPlanSelection(effectiveSelectedPlan);
            const analyticsProperties = {
                plan_id: effectiveSelectedPlan,
                ...(effectiveSelectedCard?.price.status === 'quoted'
                    ? { amount_krw: effectiveSelectedCard.price.amountKrw }
                    : {}),
                preflight_id: readyPreflight.preflightId,
            };
            if (paidPlan) {
                trackEvent(EVENTS.CHECKOUT_STARTED, analyticsProperties);
            }
            const response = await fetch(
                paidPlan ? '/api/earlybird/checkout' : '/api/earlybird/waitlist',
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(paidPlan ? {
                        preflightId: readyPreflight.preflightId,
                        planId: effectiveSelectedPlan,
                        disclosureAccepted,
                    } : {
                        preflightId: readyPreflight.preflightId,
                        planId: 'plus',
                    }),
                }
            );
            const payload: unknown = await response.json().catch(() => null);
            if (!response.ok) {
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
                setError(message);
                return;
            }
            if (!paidPlan) {
                setWaitlistComplete(true);
                return;
            }
            if (!payload || typeof payload !== 'object'
                || !('checkoutUrl' in payload)
                || typeof payload.checkoutUrl !== 'string'
                || !isSafeGrobleCheckoutUrl(payload.checkoutUrl)) {
                setError('결제창 주소를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.');
                return;
            }
            trackEvent(EVENTS.CHECKOUT_REDIRECTED, analyticsProperties);
            window.location.assign(payload.checkoutUrl);
        } catch {
            setError('요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.');
        } finally {
            setPurchaseSubmitting(false);
        }
    };

    const handleReset = () => {
        try {
            clearPendingAnalysisTarget(sessionStorage);
        } catch {
            /* ignore */
        }
        reset();
        setInstagramId('');
        setGirlfriendInstagramId('');
        setSelectedPlan(null);
        setDisclosureAccepted(false);
        setPurchaseSubmitting(false);
        setWaitlistComplete(false);
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

    if (authLoading) {
        return (
            <div className="flex min-h-dvh items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-blood border-t-transparent" />
            </div>
        );
    }

    return (
        <div className="min-h-dvh">
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
                {!preflight ? (
                    <>
                        <Eyebrow>판독 의뢰서 · 대상 지정</Eyebrow>
                        <h1 className="mt-3 text-[26px] font-extrabold leading-snug text-fg">
                            누구를 판독할까요?
                        </h1>
                        <p className="mt-2 text-[14px] text-fg-dim">
                            남자친구의 인스타그램 아이디를 입력해주세요.
                        </p>

                        <CaseCard className="mt-8 p-5">
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
                            <div className="mt-4 border border-amber/30 bg-amber/[0.06] px-3 py-2.5">
                                <p className="text-[12px] leading-relaxed text-fg-dim">
                                    <span className="font-semibold text-amber">공개 계정</span>만 판독 가능합니다.
                                </p>
                            </div>
                            {error && (
                                <div className="mt-4 border border-blood/45 bg-blood/10 px-3 py-2.5 text-[13px] text-blood" role="alert">
                                    {error}
                                </div>
                            )}
                            <div className="mt-5">
                                <PrimaryButton
                                    onClick={handleStartPreflight}
                                    disabled={!instagramId.trim() || creating}
                                >
                                    {creating ? '계정 확인 중…' : '대상 계정 확인하기'}
                                </PrimaryButton>
                            </div>
                        </CaseCard>
                    </>
                ) : preflight.status === 'blocked' ? (
                    <CaseCard bracket="var(--color-blood)" className="p-7 text-center">
                        <Eyebrow className="justify-center">사전 점검 중단</Eyebrow>
                        <h1 className="mt-4 text-[22px] font-extrabold text-fg">판독 대상을 확인해주세요</h1>
                        <p className="mt-3 text-[13px] leading-relaxed text-fg-dim">
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
                                <Eyebrow>{exclusionDecided ? '판독 의뢰서 · 대상 확인' : '판독 의뢰서 · 본인 제외'}</Eyebrow>
                                <h1 className="mt-3 text-[24px] font-extrabold leading-snug text-fg">
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
                            <CaseCard className="mt-6 p-5">
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
                                    <div className="mt-4 border border-blood/45 bg-blood/10 px-3 py-2.5 text-[13px] text-blood" role="alert">
                                        {error}
                                    </div>
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
                            </CaseCard>
                        )}

                        {exclusionDecided && !readyPreflight && (
                            <CaseCard className="mt-7 p-7 text-center">
                                <div className="mx-auto flex h-14 w-14 items-center justify-center border border-line bg-ink">
                                    <BrandMark size={26} className="anim-blink text-blood" />
                                </div>
                                <h2 data-amp-block className="mt-5 text-[18px] font-extrabold text-fg">
                                    @{targetInstagramId ?? '대상 계정'} 조회 중
                                </h2>
                                <p className="mt-2 text-[13px] text-fg-dim" aria-live="polite">
                                    프로필과 계정 규모를 확인하고 있습니다.
                                </p>
                                <div className="mt-6 h-1.5 w-full overflow-hidden bg-line">
                                    <div className="h-full w-1/3 bg-blood anim-indeterminate" />
                                </div>
                                <p className="mt-5 text-[12px] text-fg-mute">
                                    보통 몇 초 이내에 끝나요. 화면을 벗어나도 진행됩니다.
                                </p>
                            </CaseCard>
                        )}

                        {exclusionDecided && readyPreflight && (
                            <>
                                <CaseCard bracket="var(--color-blood)" className="mt-7 overflow-hidden">
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

                                <section className="mt-9" aria-labelledby="plan-heading">
                                    <Eyebrow>요금제 선택</Eyebrow>
                                    <h2 id="plan-heading" className="mt-3 text-[22px] font-extrabold text-fg">
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
                                                                    {presentation.discountLabel}↓
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

                                    {effectiveSelectedPlan
                                        && selectedPlanAvailable
                                        && isPaidEarlybirdPlanId(effectiveSelectedPlan) && (
                                        <div className="mt-5 border border-amber/35 bg-amber/[0.06] p-4">
                                            <label className="flex cursor-pointer items-start gap-3">
                                                <input
                                                    type="checkbox"
                                                    checked={disclosureAccepted}
                                                    onChange={(event) => setDisclosureAccepted(event.target.checked)}
                                                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-blood)]"
                                                />
                                                <span className="text-[12px] leading-relaxed text-fg-dim">
                                                    {EARLYBIRD_DISCLOSURE_TEXT}
                                                </span>
                                            </label>
                                        </div>
                                    )}

                                    {error && (
                                        <div className="mt-4 border border-blood/45 bg-blood/10 px-3 py-2.5 text-[13px] text-blood" role="alert">
                                            {error}
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

            {disclosureModalOpen && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-5"
                    role="dialog"
                    aria-modal="true"
                    aria-label="얼리버드 안내 확인 필요"
                >
                    <div
                        className="absolute inset-0 bg-ink/80 backdrop-blur-sm"
                        onClick={() => setDisclosureModalOpen(false)}
                    />
                    <div className="relative w-full max-w-[380px] border border-line bg-ink-2 px-6 py-8 text-center shadow-2xl">
                        <div className="mx-auto flex h-14 w-14 items-center justify-center border border-line bg-ink">
                            <BrandMark size={26} className="text-amber" />
                        </div>
                        <h2 className="mt-5 text-[19px] font-extrabold tracking-tight text-fg">
                            안내 사항 확인이 필요해요
                        </h2>
                        <p className="mt-2 text-[13px] leading-relaxed text-fg-dim">
                            {EARLYBIRD_DISCLOSURE_TEXT}
                            <br />
                            위 체크박스에 동의 표시를 해주셔야 구매를 진행할 수 있어요.
                        </p>
                        <button
                            onClick={() => setDisclosureModalOpen(false)}
                            className="mt-6 w-full bg-blood px-5 py-3 text-[14px] font-bold text-white transition-opacity hover:opacity-90"
                        >
                            확인
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
