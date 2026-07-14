'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useAnalysisV2Preflight } from '@/hooks/useAnalysisV2Preflight';
import { trackEvent, EVENTS } from '@/lib/services/analytics';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import { TopBar, BrandMark, Eyebrow, CaseCard, PrimaryButton } from '@/components/case-ui';

const PLAN_NAMES: Readonly<Record<PlanId, string>> = {
    basic: 'Basic',
    standard: 'Standard',
    plus: 'Plus',
};

function relationshipCapacityLabel(capacity: { followers: number; following: number }): string {
    if (capacity.followers === capacity.following) {
        return `팔로워·팔로잉 각 ${capacity.followers.toLocaleString('ko-KR')}명 이하`;
    }
    return `팔로워 ${capacity.followers.toLocaleString('ko-KR')}명 · 팔로잉 ${
        capacity.following.toLocaleString('ko-KR')
    }명 이하`;
}

export default function AnalyzePage() {
    const [instagramId, setInstagramId] = useState('');
    const [girlfriendInstagramId, setGirlfriendInstagramId] = useState('');
    const [selectedPlan, setSelectedPlan] = useState<PlanId | null>(null);
    const router = useRouter();
    const { user, loading: authLoading } = useAuth();
    const initializedRef = useRef(false);
    const {
        targetInstagramId,
        preflight,
        creating,
        exclusionState,
        starting,
        error,
        setError,
        startPreflight,
        resumePreflight,
        submitExclusion,
        hasTestEntitlement,
        startAnalysis,
        reset,
    } = useAnalysisV2Preflight();

    const readyPreflight = preflight?.status === 'ready' ? preflight : null;
    const exclusionDecided = exclusionState === 'excluded' || exclusionState === 'skipped';
    const effectiveSelectedPlan = selectedPlan ?? readyPreflight?.requiredPlan ?? null;

    useEffect(() => {
        if (authLoading || initializedRef.current || typeof window === 'undefined') return;
        initializedRef.current = true;

        const params = new URLSearchParams(window.location.search);
        const resumablePreflightId = params.get('preflight');
        const resumableTarget = params.get('target') ?? undefined;
        if (resumablePreflightId && user) {
            void resumePreflight(resumablePreflightId, resumableTarget);
            return;
        }

        let pending = '';
        try {
            pending = sessionStorage.getItem('pending_ig') ?? '';
        } catch {
            pending = '';
        }
        if (pending) {
            window.setTimeout(() => setInstagramId(pending), 0);
        }

        if (params.get('autostart') !== '1' || !pending) return;
        if (!user) {
            router.replace('/login?redirectTo=%2Fanalyze%3Fautostart%3D1');
            return;
        }

        void (async () => {
            const accepted = await startPreflight(pending);
            if (!accepted) return;
            try {
                sessionStorage.removeItem('pending_ig');
            } catch {
                /* ignore */
            }
            router.replace(
                `/analyze?preflight=${encodeURIComponent(accepted.preflightId)}`
                + `&target=${encodeURIComponent(pending.replace(/^@+/, '').trim())}`
            );
        })();
    }, [authLoading, resumePreflight, router, startPreflight, user]);

    const handleStartPreflight = async () => {
        if (!user) {
            try {
                sessionStorage.setItem('pending_ig', instagramId);
            } catch {
                /* ignore */
            }
            router.push('/login?redirectTo=%2Fanalyze%3Fautostart%3D1');
            return;
        }
        const accepted = await startPreflight(instagramId);
        if (!accepted) return;
        router.replace(
            `/analyze?preflight=${encodeURIComponent(accepted.preflightId)}`
            + `&target=${encodeURIComponent(instagramId.replace(/^@+/, '').trim())}`
        );
    };

    const handleExclusion = async () => {
        await submitExclusion(girlfriendInstagramId);
    };

    const handleStartAnalysis = async () => {
        if (!effectiveSelectedPlan) return;
        const requestId = await startAnalysis(effectiveSelectedPlan);
        if (!requestId) return;
        trackEvent(EVENTS.ANALYSIS_START);
        router.push(`/progress/${requestId}`);
    };

    const handleReset = () => {
        reset();
        setInstagramId('');
        setGirlfriendInstagramId('');
        setSelectedPlan(null);
        initializedRef.current = true;
        router.replace('/analyze');
    };

    const handleLogout = async () => {
        try {
            const response = await fetch('/api/auth/signout', { method: 'POST' });
            if (response.ok) router.push('/');
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

            <main className="mx-auto max-w-[500px] px-5 pb-16 pt-10">
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
                            <div className="relative">
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
                        <div className="flex items-center justify-between">
                            <div>
                                <Eyebrow>판독 의뢰서 · 본인 제외</Eyebrow>
                                <h1 className="mt-3 text-[24px] font-extrabold leading-snug text-fg">
                                    내 계정은 먼저 빼둘게요
                                </h1>
                            </div>
                            <button
                                type="button"
                                onClick={handleReset}
                                className="text-[12px] font-medium text-fg-mute underline underline-offset-4 hover:text-fg"
                            >
                                대상 변경
                            </button>
                        </div>

                        {!exclusionDecided && (
                            <CaseCard className="mt-7 p-5">
                                <p className="text-[13px] leading-relaxed text-fg-dim">
                                    본인 계정을 입력하면 맞팔 후보에서 처음부터 제외합니다.
                                    대상 계정 조회는 이미 백그라운드에서 진행 중입니다.
                                </p>
                                <label htmlFor="girlfriend-instagram" className="eyebrow mb-3 mt-5 block">
                                    본인 인스타그램 아이디
                                </label>
                                <div className="relative">
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
                            <CaseCard className="mt-7 p-6 text-center">
                                <div className="mx-auto flex h-14 w-14 items-center justify-center border border-line bg-ink">
                                    <BrandMark size={26} className="anim-blink text-blood" />
                                </div>
                                <h2 className="mt-5 text-[18px] font-extrabold text-fg">
                                    @{targetInstagramId ?? '대상 계정'} 조회 중
                                </h2>
                                <p className="mt-2 text-[13px] text-fg-dim" aria-live="polite">
                                    프로필과 계정 규모를 확인하고 있습니다.
                                </p>
                            </CaseCard>
                        )}

                        {exclusionDecided && readyPreflight && (
                            <>
                                <CaseCard bracket="var(--color-blood)" className="mt-7 overflow-hidden">
                                    <div className="flex items-center gap-4 p-5">
                                        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-line-2 bg-panel">
                                            {readyPreflight.target.profileImage ? (
                                                <Image
                                                    src={readyPreflight.target.profileImage}
                                                    alt={`@${readyPreflight.target.username} 프로필`}
                                                    fill
                                                    sizes="64px"
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
                                        전체 플랜을 비교하고, 현재 계정에서 이용 가능한 플랜만 선택할 수 있습니다.
                                    </p>

                                    <fieldset className="mt-5 space-y-3">
                                        <legend className="sr-only">판독 플랜</legend>
                                        {readyPreflight.plans.map((plan) => {
                                            const available = plan.selectionState !== 'unavailable';
                                            const selected = effectiveSelectedPlan === plan.planId;
                                            return (
                                                <label
                                                    key={plan.planId}
                                                    className={`block border p-4 transition-colors ${
                                                        selected
                                                            ? 'border-blood bg-blood/[0.08]'
                                                            : available
                                                              ? 'border-line-2 bg-ink-2 hover:border-fg-dim'
                                                              : 'cursor-not-allowed border-line bg-ink-2 opacity-45'
                                                    }`}
                                                >
                                                    <input
                                                        type="radio"
                                                        name="analysis-plan"
                                                        value={plan.planId}
                                                        checked={selected}
                                                        disabled={!available}
                                                        onChange={() => setSelectedPlan(plan.planId)}
                                                        className="sr-only"
                                                    />
                                                    <div className="flex items-start justify-between gap-4">
                                                        <div>
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-[17px] font-extrabold text-fg">
                                                                    {PLAN_NAMES[plan.planId]}
                                                                </span>
                                                                {plan.selectionState === 'required' && (
                                                                    <span className="border border-blood/50 bg-blood/10 px-1.5 py-0.5 text-[10px] font-bold text-blood">
                                                                        적격 플랜
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <p className="mt-1 text-[12px] text-fg-dim">
                                                                {relationshipCapacityLabel(
                                                                    plan.relationshipCapacity
                                                                )}
                                                            </p>
                                                            <p className="mt-0.5 text-[12px] text-fg-mute">
                                                                맞팔 최대 {plan.detailedMutualLimit.toLocaleString('ko-KR')}명 정밀 판독
                                                            </p>
                                                        </div>
                                                        <span className={`mt-1 h-4 w-4 shrink-0 rounded-full border ${
                                                            selected
                                                                ? 'border-[5px] border-blood bg-white'
                                                                : 'border-line-2'
                                                        }`} />
                                                    </div>
                                                    {!available && (
                                                        <p className="mt-3 border-t border-line pt-2.5 text-[11px] font-medium text-fg-mute">
                                                            {plan.unavailableReason === 'below_required_plan'
                                                                ? '이 계정 규모에서는 선택할 수 없어요.'
                                                                : '현재 선택할 수 없는 플랜이에요.'}
                                                        </p>
                                                    )}
                                                </label>
                                            );
                                        })}
                                    </fieldset>

                                    {error && (
                                        <div className="mt-4 border border-blood/45 bg-blood/10 px-3 py-2.5 text-[13px] text-blood" role="alert">
                                            {error}
                                        </div>
                                    )}
                                    <div className="mt-5">
                                        <PrimaryButton
                                            onClick={handleStartAnalysis}
                                            disabled={
                                                !effectiveSelectedPlan
                                                || starting
                                                || !hasTestEntitlement(effectiveSelectedPlan)
                                            }
                                        >
                                            {starting
                                                ? '최신 계정 정보 확인 중…'
                                                : effectiveSelectedPlan && hasTestEntitlement(effectiveSelectedPlan)
                                                    ? '판독 시작하기'
                                                    : '결제 접수 준비 중'}
                                        </PrimaryButton>
                                    </div>
                                </section>
                            </>
                        )}
                    </>
                )}

                <p className="mt-7 text-center text-[12px] leading-relaxed text-fg-mute">
                    AI 판독 결과는 100% 정확하지 않으며, 참고용으로만 이용해 주세요.
                </p>
            </main>
        </div>
    );
}
