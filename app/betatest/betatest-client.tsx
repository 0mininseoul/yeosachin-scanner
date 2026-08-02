'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import { useAnalysisV2Preflight } from '@/hooks/useAnalysisV2Preflight';
import {
    BrandMark,
    CaseCard,
    Eyebrow,
    Panel,
    PrimaryButton,
    TopBar,
} from '@/components/case-ui';
import { InstagramLookupLink } from '@/components/instagram-lookup-link';

export function BetaTestClient() {
    const router = useRouter();
    const [instagramId, setInstagramId] = useState('');
    const [excludedInstagramId, setExcludedInstagramId] = useState('');
    const [selectedPlan, setSelectedPlan] = useState<PlanId | null>(null);
    const {
        preflight,
        creating,
        exclusionState,
        starting,
        error,
        setError,
        startPreflight,
        submitExclusion,
        admitBetaAnalysis,
        reset,
    } = useAnalysisV2Preflight({ flow: 'betatest' });

    const exclusionDecided = exclusionState === 'excluded' || exclusionState === 'skipped';
    const capacityUnavailable = preflight?.status === 'blocked'
        && preflight.code === 'BETA_CAPACITY_UNAVAILABLE';
    const queueUnavailable = preflight?.status === 'blocked'
        && preflight.code === 'QUEUE_UNAVAILABLE';
    const retryableBetaPreparation = capacityUnavailable || queueUnavailable;
    const effectivePlan = preflight?.status === 'ready'
        ? selectedPlan ?? preflight.requiredPlan
        : null;

    const start = async () => {
        const accepted = await startPreflight(instagramId);
        if (accepted) setSelectedPlan(null);
    };
    const admit = async () => {
        if (!effectivePlan) return;
        const requestId = await admitBetaAnalysis(effectivePlan);
        if (requestId) router.push(`/progress/${encodeURIComponent(requestId)}`);
    };
    const startOver = () => {
        reset();
        setInstagramId('');
        setExcludedInstagramId('');
        setSelectedPlan(null);
    };
    const retrySameTarget = async () => {
        reset();
        setExcludedInstagramId('');
        setSelectedPlan(null);
        await startPreflight(instagramId);
    };

    return (
        <div className="min-h-dvh">
            <TopBar right={<BrandMark />} />
            <main data-amp-mask className="mx-auto max-w-[500px] px-5 pb-16 pt-7">
                {!preflight ? (
                    <>
                        <Eyebrow>베타 테스트 · 대상 지정</Eyebrow>
                        <h1 className="mt-3 text-[26px] font-extrabold leading-snug text-fg">
                            무료 판독 대상을 입력해주세요
                        </h1>
                        <p className="mt-2 text-[14px] text-fg-dim">
                            현재 이용 가능한 무료 판독 자리를 확인합니다.
                        </p>
                        <Panel className="mt-8 p-5">
                            <label htmlFor="beta-target-instagram" className="eyebrow mb-3 block">
                                대상 인스타그램 아이디
                            </label>
                            <div className="relative">
                                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim">@</span>
                                <input
                                    id="beta-target-instagram"
                                    type="text"
                                    value={instagramId}
                                    onChange={event => {
                                        setInstagramId(event.target.value);
                                        if (error) setError(null);
                                    }}
                                    onKeyDown={event => {
                                        if (event.key === 'Enter' && !creating) void start();
                                    }}
                                    placeholder="username"
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="w-full border border-line bg-ink py-3.5 pl-9 pr-4 text-[15px] text-fg placeholder-fg-mute focus:border-blood focus:outline-none"
                                />
                            </div>
                            <InstagramLookupLink />
                            {error && <p className="mt-4 border-l-2 border-blood pl-3 text-[13px] text-blood-2" role="alert">{error}</p>}
                            <div className="mt-5">
                                <PrimaryButton onClick={() => void start()} disabled={!instagramId.trim() || creating}>
                                    {creating ? '계정 확인 중…' : '무료 판독 가능 여부 확인'}
                                </PrimaryButton>
                            </div>
                        </Panel>
                    </>
                ) : preflight.status === 'blocked' ? (
                    <CaseCard bracket="var(--color-blood)" className="p-7 text-center">
                        <Eyebrow className="justify-center">
                            {capacityUnavailable
                                ? '무료 판독 대기'
                                : queueUnavailable ? '준비 상태 재확인' : '사전 점검 중단'}
                        </Eyebrow>
                        <h1 className="mt-4 text-[22px] font-extrabold text-fg">
                            {capacityUnavailable
                                ? '무료 판독 자리를 다시 확인해주세요'
                                : queueUnavailable
                                    ? '무료 판독 준비를 다시 확인해주세요'
                                    : '판독 대상을 확인해주세요'}
                        </h1>
                        <p className="mt-3 text-[13px] leading-relaxed text-fg-dim">{error ?? '현재 이 계정은 판독할 수 없습니다.'}</p>
                        <div className="mt-7">
                            {retryableBetaPreparation ? (
                                <PrimaryButton onClick={() => void retrySameTarget()} disabled={creating}>
                                    {creating
                                        ? queueUnavailable ? '준비 상태 확인 중…' : '다시 확인 중…'
                                        : queueUnavailable
                                            ? '같은 대상으로 준비 다시 확인'
                                            : '같은 대상으로 다시 확인'}
                                </PrimaryButton>
                            ) : (
                                <PrimaryButton onClick={startOver}>다른 계정 확인하기</PrimaryButton>
                            )}
                        </div>
                    </CaseCard>
                ) : (
                    <>
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <Eyebrow>{exclusionDecided ? '베타 테스트 · 대상 확인' : '베타 테스트 · 본인 제외'}</Eyebrow>
                                <h1 className="mt-3 text-[24px] font-extrabold leading-snug text-fg">
                                    {exclusionDecided
                                        ? '무료 판독을 시작할 수 있어요'
                                        : '본인 계정은 먼저 제외해주세요'}
                                </h1>
                            </div>
                            <button type="button" onClick={startOver} className="shrink-0 text-[12px] font-medium text-fg-mute underline underline-offset-4 hover:text-fg">대상 변경</button>
                        </div>

                        {!exclusionDecided && (
                            <Panel className="mt-6 p-5">
                                <label htmlFor="beta-excluded-instagram" className="eyebrow mb-3 block">본인 인스타그램 아이디</label>
                                <input
                                    id="beta-excluded-instagram"
                                    type="text"
                                    value={excludedInstagramId}
                                    onChange={event => setExcludedInstagramId(event.target.value)}
                                    placeholder="my_username"
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="w-full border border-line bg-ink px-4 py-3.5 text-[15px] text-fg placeholder-fg-mute focus:border-blood focus:outline-none"
                                />
                                {error && <p className="mt-4 border-l-2 border-blood pl-3 text-[13px] text-blood-2" role="alert">{error}</p>}
                                <div className="mt-5 space-y-2.5">
                                    <PrimaryButton onClick={() => void submitExclusion(excludedInstagramId)} disabled={!excludedInstagramId.trim() || exclusionState === 'saving'}>
                                        {exclusionState === 'saving' ? '제외 계정 저장 중…' : '내 계정 제외하기'}
                                    </PrimaryButton>
                                    <button type="button" onClick={() => void submitExclusion()} disabled={exclusionState === 'saving'} className="w-full py-2 text-[13px] text-fg-dim underline underline-offset-4 hover:text-fg">
                                        제외 없이 계속하기
                                    </button>
                                </div>
                            </Panel>
                        )}

                        {exclusionDecided && preflight.status === 'ready' && (
                            <>
                                <div className="mt-7 space-y-2.5">
                                    {preflight.plans.map(plan => {
                                        const selectable = plan.selectionState !== 'unavailable';
                                        const selected = effectivePlan === plan.planId;
                                        return (
                                            <button
                                                key={plan.planId}
                                                type="button"
                                                disabled={!selectable}
                                                onClick={() => setSelectedPlan(plan.planId)}
                                                className={`w-full border p-4 text-left ${selected ? 'border-blood bg-blood/5' : 'border-line'} ${selectable ? 'hover:border-fg-dim' : 'cursor-not-allowed opacity-45'}`}
                                            >
                                                <span className="text-[15px] font-bold text-fg">{plan.planId === 'basic' ? 'Basic' : plan.planId === 'standard' ? 'Standard' : 'Plus'}</span>
                                                <span className="mt-1 block text-[12px] text-fg-dim">맞팔 관계를 최대 {plan.detailedMutualLimit.toLocaleString('ko-KR')}명까지 확인</span>
                                            </button>
                                        );
                                    })}
                                </div>
                                {error && <p className="mt-4 border-l-2 border-blood pl-3 text-[13px] text-blood-2" role="alert">{error}</p>}
                                <div className="mt-5">
                                    <PrimaryButton onClick={() => void admit()} disabled={!effectivePlan || starting}>
                                        {starting ? '무료 판독 배정 중…' : error?.includes('무료 판독 가능 인원이') ? '무료 판독 다시 시도' : '무료 판독 시작하기'}
                                    </PrimaryButton>
                                </div>
                            </>
                        )}
                    </>
                )}
            </main>
        </div>
    );
}
