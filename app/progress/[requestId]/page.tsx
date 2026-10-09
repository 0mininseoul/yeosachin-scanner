'use client';

import { useEffect, use, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Archive, Check, ChevronRight } from 'lucide-react';
import { ProgressFaces } from '@/components/progress-faces';
import { useAnalysisProgress } from '@/hooks/useAnalysisProgress';
import { TopBar, Eyebrow, CaseCard, PrimaryButton } from '@/components/case-ui';
import { isDevUiPresentation } from '@/lib/constants/dev-ui';
import {
    ANALYSIS_PROGRESS_STEPS,
    ANALYSIS_STEP_RECOVERY_DELAY_MS,
    decideAnalysisStepFailure,
    shouldClientDriveAnalysis,
} from '@/lib/services/analysis/progress-retry';
import {
    analysisDurationProgressCopy,
    analysisV2EventCopy,
} from '@/lib/services/analysis/owner-view-presentation';
import { preferredProgressNarration } from '@/lib/services/analysis/v2-progress-client-state';
import {
    availablePendingTargetStorage,
    clearPendingAnalysisTargetForTerminalState,
    signOutAndClearPendingAnalysisTarget,
} from '@/lib/services/pending-analysis-target';

interface PageProps {
    params: Promise<{ requestId: string }>;
}

const V2_TRACK_PRESENTATION = [
    { key: 'relationshipAi', label: '맞팔·AI 판독' },
    { key: 'interactions', label: '위험 단서 수집' },
    { key: 'finalization', label: '위험도·총평 정리' },
] as const;

export default function ProgressPage({ params }: PageProps) {
    const { requestId } = use(params);
    const { data, loading, error, errorKind, refreshing, refetch } = useAnalysisProgress(requestId);
    const router = useRouter();
    const isRunningStep = useRef(false);
    const abortControllerRef = useRef<AbortController | null>(null);
    const retryCountRef = useRef(0);
    const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stepTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const runNextStepRef = useRef<() => void>(() => undefined);
    const scheduleNextStep = useCallback((delayMs: number, retry = false) => {
        const targetRef = retry ? retryTimeoutRef : stepTimeoutRef;
        if (targetRef.current) clearTimeout(targetRef.current);
        targetRef.current = setTimeout(() => {
            targetRef.current = null;
            runNextStepRef.current();
        }, delayMs);
    }, []);

    // 단계별 분석 실행 함수
    const runNextStep = useCallback(async () => {
        if (
            isDevUiPresentation()
            || data?.pipelineVersion === 'v2'
            || data?.backgroundProcessing === true
            || isRunningStep.current
        ) return;
        isRunningStep.current = true;

        try {
            abortControllerRef.current = new AbortController();

            const response = await fetch('/api/analysis/step', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId }),
                signal: abortControllerRef.current.signal,
            });

            // 504 등 non-JSON 에러 응답 처리를 위해 ok 체크를 먼저
            if (!response.ok) {
                // JSON 파싱 시도 (500은 JSON 응답일 수 있음)
                let result: { step?: string; error?: string } = {};
                try { result = await response.json(); } catch { /* non-JSON 응답 (504 등) */ }

                const decision = decideAnalysisStepFailure(
                    response.status,
                    Boolean(result.step),
                    retryCountRef.current
                );

                if (decision.kind === 'lease_wait') {
                    retryCountRef.current = decision.nextRetryCount;
                    isRunningStep.current = false;
                    scheduleNextStep(decision.delayMs, true);
                    return;
                }

                if (decision.kind === 'terminal') {
                    isRunningStep.current = false;
                    await refetch();
                    return;
                }

                if (decision.kind === 'persisted_failure') {
                    console.error('Pipeline failed at a persisted step');
                    isRunningStep.current = false;
                    await refetch();
                    return;
                }

                if (decision.kind === 'transient_retry') {
                    retryCountRef.current = decision.nextRetryCount;
                    isRunningStep.current = false;
                    scheduleNextStep(decision.delayMs, true);
                    return;
                }

                console.error('Step failed after max retries');
                isRunningStep.current = false;
                await refetch();
                retryCountRef.current = 0;
                scheduleNextStep(ANALYSIS_STEP_RECOVERY_DELAY_MS, true);
                return;
            }

            const result = await response.json();

            // 성공 시 retryCount 리셋
            retryCountRef.current = 0;
            isRunningStep.current = false;

            // 완료되지 않았으면 다음 단계 실행
            if (!result.done) {
                scheduleNextStep(500);
            } else {
                await refetch();
            }
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                console.log('Step aborted');
                isRunningStep.current = false;
                return;
            }

            console.error('Failed to run step:', err);
            isRunningStep.current = false;

            const decision = decideAnalysisStepFailure(0, false, retryCountRef.current);
            if (decision.kind === 'transient_retry') {
                retryCountRef.current = decision.nextRetryCount;
                scheduleNextStep(decision.delayMs, true);
            } else {
                await refetch();
                retryCountRef.current = 0;
                scheduleNextStep(ANALYSIS_STEP_RECOVERY_DELAY_MS, true);
            }
        }
    }, [data?.backgroundProcessing, data?.pipelineVersion, refetch, requestId, scheduleNextStep]);

    useEffect(() => {
        runNextStepRef.current = runNextStep;
    }, [runNextStep]);

    // pending 또는 processing 상태이면 분석 단계 실행
    useEffect(() => {
        if (
            isDevUiPresentation() ||
            data?.pipelineVersion === 'v2' ||
            data?.backgroundProcessing === true ||
            data?.status === 'completed' ||
            data?.status === 'failed'
        ) {
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
                retryTimeoutRef.current = null;
            }
            if (stepTimeoutRef.current) {
                clearTimeout(stepTimeoutRef.current);
                stepTimeoutRef.current = null;
            }
            return;
        }
        if (shouldClientDriveAnalysis(data?.status, data?.backgroundProcessing) &&
            !isRunningStep.current) {
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
                retryTimeoutRef.current = null;
            }
            if (stepTimeoutRef.current) {
                clearTimeout(stepTimeoutRef.current);
                stepTimeoutRef.current = null;
            }
            runNextStep();
        }
    }, [data?.backgroundProcessing, data?.pipelineVersion, data?.progress, data?.status, runNextStep]);

    // 탭 복귀 시 파이프라인 재개
    useEffect(() => {
        const handleVisibility = () => {
            if (document.visibilityState !== 'visible') return;

            // 이미 타이머가 예약되어 있으면 무시
            if (retryTimeoutRef.current || stepTimeoutRef.current) return;

            // 분석 진행 중이고 step이 안 돌고 있으면 재개
            if (data?.pipelineVersion !== 'v2'
                && shouldClientDriveAnalysis(data?.status, data?.backgroundProcessing) &&
                !isRunningStep.current) {
                retryCountRef.current = 0; // 탭 복귀는 fresh start
                runNextStep();
            }
        };

        document.addEventListener('visibilitychange', handleVisibility);
        return () => document.removeEventListener('visibilitychange', handleVisibility);
    }, [data?.backgroundProcessing, data?.pipelineVersion, data?.status, runNextStep]);

    // 컴포넌트 언마운트 시 정리
    useEffect(() => {
        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
            if (retryTimeoutRef.current) {
                clearTimeout(retryTimeoutRef.current);
            }
            if (stepTimeoutRef.current) {
                clearTimeout(stepTimeoutRef.current);
            }
        };
    }, []);

    // 완료되면 결과 페이지로 이동
    useEffect(() => {
        const storage = availablePendingTargetStorage();
        if (storage) {
            clearPendingAnalysisTargetForTerminalState(storage, data?.status);
        }
        if (data?.status === 'completed') {
            const pipeline = data.pipelineVersion === 'v2' ? '?pipeline=v2' : '';
            router.push(`/result/${requestId}${pipeline}`);
        }
    }, [data?.pipelineVersion, data?.status, requestId, router]);

    const handleLogout = async () => {
        try {
            const signedOut = await signOutAndClearPendingAnalysisTarget(
                availablePendingTargetStorage(),
            );
            if (signedOut) {
                router.push('/');
            }
        } catch (err) {
            console.error('Logout failed:', err);
        }
    };

    if (loading) {
        return (
            <div className="flex min-h-dvh items-center justify-center" role="status">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-blood border-t-transparent" aria-hidden="true" />
                <span className="sr-only">진행 상황을 불러오고 있습니다.</span>
            </div>
        );
    }

    const retryButton = (
        <button
            type="button"
            onClick={() => void refetch()}
            disabled={refreshing}
            className="min-h-11 shrink-0 border border-line-2 px-5 py-2.5 text-[14px] font-bold text-fg transition-colors hover:border-fg-dim hover:bg-panel disabled:cursor-wait disabled:opacity-60"
        >
            {refreshing ? '조회 중…' : '다시 조회'}
        </button>
    );

    if (!data) {
        const transient = errorKind === 'transient';
        const unauthorized = errorKind === 'unauthorized';
        return (
            <div className="flex min-h-dvh flex-col items-center justify-center px-5">
                <CaseCard className="w-full max-w-[400px] p-7 text-center">
                    <h1 className="text-[22px] font-extrabold tracking-tight text-fg">
                        {transient ? '진행 상황을 확인하지 못했어요' : unauthorized ? '다시 로그인해주세요' : '판독 요청을 확인할 수 없어요'}
                    </h1>
                    <p className="mt-3 text-[14px] leading-relaxed text-fg-dim" role="status">
                        {error || '판독 요청을 찾을 수 없습니다.'}
                    </p>
                    <div className="mt-7">
                        {transient ? retryButton : (
                            <PrimaryButton onClick={() => router.push(unauthorized
                                ? `/login?redirectTo=${encodeURIComponent(`/progress/${requestId}`)}`
                                : '/analyze')}>
                                {unauthorized ? '로그인하기' : '새 분석 시작하기'}
                            </PrimaryButton>
                        )}
                    </div>
                </CaseCard>
            </div>
        );
    }

    if (data.status === 'failed') {
        return (
            <div className="flex min-h-dvh flex-col items-center justify-center px-5">
                <CaseCard bracket="var(--color-blood)" className="w-full max-w-[400px] p-8 text-center">
                    <Eyebrow className="justify-center">판독 중단</Eyebrow>
                    <h1 className="mt-4 text-[22px] font-extrabold tracking-tight text-fg">판독에 실패했습니다</h1>
                    <p data-amp-mask className="mt-3 text-[14px] leading-relaxed text-fg-dim">
                        {data.errorMessage || '판독 중 오류가 발생했습니다.'}
                    </p>
                    <div className="mt-7">
                        <PrimaryButton onClick={() => router.push('/analyze')}>새 분석 시작하기</PrimaryButton>
                    </div>
                </CaseCard>
            </div>
        );
    }

    // Track units can be synthetic (for example n/100), so only the explicit
    // active-profile ordinal/total pair is presented as a profile count.
    const activeProfileCount = data.activeProfile
        && data.activeProfile.currentOrdinal !== undefined
        && data.activeProfile.totalCount !== undefined
        ? { ordinal: data.activeProfile.currentOrdinal, total: data.activeProfile.totalCount }
        : null;
    const narration = preferredProgressNarration(data.progressStep, data.events);
    const activity = narration
        ? narration === data.progressStep ? narration : analysisV2EventCopy(narration)
        : '판독을 준비하고 있습니다.';
    const profilePrefix = data.activeProfile ? `@${data.activeProfile.maskedUsername} · ` : '';
    // Profile changes have their own visible label. The live heading announces
    // changes in activity without rereading the same stage on every heartbeat.
    const currentActivity = profilePrefix && activity.startsWith(profilePrefix)
        ? activity.slice(profilePrefix.length)
        : activity;

    return (
        <div className="min-h-dvh">
            <TopBar
                right={
                    <button
                        onClick={handleLogout}
                        className="text-[14px] font-medium text-fg-dim transition-colors hover:text-fg"
                    >
                        로그아웃
                    </button>
                }
            />

            <main className="mx-auto flex max-w-[460px] flex-col px-5 pb-8 pt-4">
                {errorKind === 'transient' && (
                    <div className="mb-5 border border-line-2 bg-panel px-4 py-3">
                        <p role="status" className="text-[14px] leading-relaxed text-fg">
                            {error} 마지막으로 확인한 진행 상황을 표시하고 있어요.
                        </p>
                        <div className="mt-3">{retryButton}</div>
                    </div>
                )}

                <div
                    className="relative h-[184px] w-[184px] self-center"
                    role="progressbar"
                    aria-label="전체 진행률"
                    aria-valuenow={Math.round(data.progress)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                >
                    <div
                        aria-hidden="true"
                        className="anim-radar absolute inset-0 rounded-full motion-reduce:animate-none"
                        style={{ background: 'conic-gradient(from 0deg, transparent 0deg, rgba(228,19,42,0.30) 46deg, transparent 64deg)' }}
                    />
                    <div
                        aria-hidden="true"
                        className="absolute inset-0 rounded-full transition-[background] duration-500"
                        style={{
                            background: `conic-gradient(var(--color-blood) 0 ${data.progress}%, var(--color-line) ${data.progress}% 100%)`,
                            WebkitMask: 'radial-gradient(circle, transparent 0 80px, #000 80px)',
                            mask: 'radial-gradient(circle, transparent 0 80px, #000 80px)',
                        }}
                    />
                    <div aria-hidden="true" className="absolute inset-[24px] rounded-full border border-line" />
                    <div aria-hidden="true" className="absolute inset-[48px] rounded-full border border-line/70" />
                    <div aria-hidden="true" className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="mb-2 text-[14px] font-semibold text-fg-dim">전체 진행률</span>
                        <span className="num flex items-baseline text-fg">
                            <span className="text-[52px] font-bold leading-none tracking-[-0.03em]">{Math.round(data.progress)}</span>
                            <span className="ml-0.5 text-[22px] font-semibold leading-none text-fg-dim">%</span>
                        </span>
                    </div>
                </div>

                <h1 className="mt-4 text-balance break-keep text-center text-[20px] font-extrabold leading-snug tracking-tight text-fg" aria-live="polite" aria-atomic="true">
                    {currentActivity}
                </h1>

                {data.pipelineVersion === 'v2' && (
                    <div data-amp-block>
                        <ProgressFaces
                            allowLocalAssets={isDevUiPresentation()}
                            key={requestId}
                            active={data.activeProfile}
                            candidateMedia={data.candidateMedia}
                            publicationLagReset={data.publicationLagReset}
                        />
                    </div>
                )}
                {data.activeProfile && (
                    <p data-amp-mask className="mt-3 break-all text-center text-[14px] leading-relaxed text-fg-dim">
                        @{data.activeProfile.maskedUsername}
                        {activeProfileCount && (
                            <span className="num block">현재 {activeProfileCount.ordinal}번째 / 대상 {activeProfileCount.total}개</span>
                        )}
                    </p>
                )}
                <p className="mt-4 text-balance text-center text-[14px] leading-relaxed text-fg-dim">
                    {analysisDurationProgressCopy(isDevUiPresentation())}
                </p>

                <ul aria-label="판독 작업 상태" className="mt-4 w-full">
                    {data.pipelineVersion === 'v2' && data.tracks
                        ? V2_TRACK_PRESENTATION.map(({ key, label }, index) => {
                            const track = data.tracks![key];
                            const isComplete = track.state === 'completed';
                            const isRunning = track.state === 'running';
                            return (
                                <li key={key} className={`flex min-h-12 items-center gap-3 py-3 ${index === V2_TRACK_PRESENTATION.length - 1 ? '' : 'border-b border-line'}`}>
                                    <span aria-hidden="true" className={`w-0.5 self-stretch ${isComplete ? 'bg-blood' : isRunning ? 'bg-blood-2' : 'bg-line-2'}`} />
                                    <span className={`text-[15px] ${isComplete || isRunning ? 'font-semibold text-fg' : 'text-fg-dim'}`}>{label}</span>
                                    <span className={`ml-auto whitespace-nowrap text-[14px] font-bold ${isComplete ? 'text-jade' : isRunning ? 'text-blood-2' : 'text-fg-dim'}`}>
                                        {isComplete ? '완료' : isRunning ? '진행 중' : '대기'}
                                    </span>
                                </li>
                            );
                        })
                        : ANALYSIS_PROGRESS_STEPS.map((step, index) => {
                            const isComplete = data.progress >= step.threshold;
                            const isCurrent = data.progress >= (ANALYSIS_PROGRESS_STEPS[index - 1]?.threshold || 0) && data.progress < step.threshold;
                            return (
                                <li key={step.label} className={`flex min-h-12 items-center gap-3 py-3 ${index === ANALYSIS_PROGRESS_STEPS.length - 1 ? '' : 'border-b border-line'}`}>
                                    <span aria-hidden="true" className={`w-0.5 self-stretch ${isComplete ? 'bg-blood' : isCurrent ? 'bg-blood-2' : 'bg-line-2'}`} />
                                    <span className={`text-[15px] ${isComplete || isCurrent ? 'font-semibold text-fg' : 'text-fg-dim'}`}>{step.label}</span>
                                    <span className={`ml-auto whitespace-nowrap text-[14px] font-bold ${isComplete ? 'text-jade' : isCurrent ? 'text-blood-2' : 'text-fg-dim'}`}>
                                        {isComplete ? '완료' : isCurrent ? '진행 중' : '대기'}
                                    </span>
                                </li>
                            );
                        })}
                </ul>

                {data.backgroundProcessing ? (
                    <div className="mt-4 border-t border-line pt-4">
                        <div className="space-y-2 text-[14px] font-semibold leading-relaxed text-jade">
                            <p className="flex items-start gap-2">
                                <Check aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
                                이 화면을 나가셔도 판독은 계속됩니다
                            </p>
                            <p className="flex items-start gap-2">
                                <Check aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
                                보관함에서 진행 상황을 다시 확인할 수 있어요
                            </p>
                        </div>
                        <Link href="/mypage" className="mt-4 flex min-h-12 items-center justify-center gap-3 border border-blood px-4 py-3 text-[16px] font-bold text-blood-2 transition-colors hover:bg-blood/10">
                            <Archive aria-hidden="true" className="h-5 w-5" />
                            보관함으로 이동
                            <ChevronRight aria-hidden="true" className="h-5 w-5" />
                        </Link>
                    </div>
                ) : (
                    <p className="mt-5 border border-blood/45 bg-blood/[0.09] px-4 py-3 text-center text-[14px] font-bold leading-relaxed text-blood-2">
                        판독이 끝날 때까지 이 페이지를 닫지 마세요
                    </p>
                )}
            </main>
        </div>
    );
}
