'use client';

import { useEffect, use, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ProgressFaces } from '@/components/progress-faces';
import { useAnalysisProgress } from '@/hooks/useAnalysisProgress';
import { TopBar, Eyebrow, CaseCard, PrimaryButton } from '@/components/case-ui';
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
    const { data, loading, error, refetch } = useAnalysisProgress(requestId);
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
            data?.pipelineVersion === 'v2'
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
            <div className="flex min-h-dvh items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-blood border-t-transparent" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="flex min-h-dvh flex-col items-center justify-center px-5">
                <p className="mb-5 text-[14px] text-blood">{error || '판독 요청을 찾을 수 없습니다.'}</p>
                <button
                    onClick={() => router.push('/analyze')}
                    className="border border-line-2 px-5 py-2.5 text-[13px] font-bold text-fg transition-colors hover:border-fg-dim hover:bg-panel"
                >
                    다시 시도하기
                </button>
            </div>
        );
    }

    if (data.status === 'failed') {
        return (
            <div className="flex min-h-dvh flex-col items-center justify-center px-5">
                <CaseCard bracket="var(--color-blood)" className="w-full max-w-[400px] p-8 text-center">
                    <Eyebrow className="justify-center">판독 중단</Eyebrow>
                    <h1 className="mt-4 text-[22px] font-extrabold tracking-tight text-fg">판독에 실패했습니다</h1>
                    <p className="mt-3 text-[13px] leading-relaxed text-fg-dim">
                        {data.errorMessage || '판독 중 오류가 발생했습니다.'}
                    </p>
                    <div className="mt-7">
                        <PrimaryButton onClick={() => router.push('/analyze')}>다시 시도하기</PrimaryButton>
                    </div>
                </CaseCard>
            </div>
        );
    }

    /* The ring already carries the number, so the words under it name the stage
       rather than repeating the percentage in prose. */
    const runningTrack = data.tracks
        ? V2_TRACK_PRESENTATION.find(({ key }) => data.tracks![key].state === 'running')
        : undefined;
    const activeTrackLabel = runningTrack?.label ?? '판독 준비 중';
    /* done/total of whatever is running: the one count that answers "how much
       is left" without the reader having to translate a percentage. */
    const runningCounts = runningTrack ? data.tracks![runningTrack.key] : null;
    const screenedCount = runningCounts && runningCounts.total > 0 ? runningCounts : null;
    const latestEventCopy = data.events.length > 0
        ? analysisV2EventCopy(data.events.at(-1)!.copyCode)
        : null;

    return (
        <div className="min-h-dvh">
            <TopBar
                right={
                    <button
                        onClick={handleLogout}
                        className="text-[13px] font-medium text-fg-dim transition-colors hover:text-fg"
                    >
                        로그아웃
                    </button>
                }
            />

            <main data-amp-mask className="mx-auto flex max-w-[460px] flex-col px-5 pt-4">
                <Eyebrow className="self-start">판독 진행 중</Eyebrow>

                {/* The scope is the gauge.
                    It used to sweep decoratively above a separate progress bar,
                    so the screen spent two blocks saying one thing. The ring now
                    carries the number it was hovering over, and the sweep keeps
                    the reading feeling live. */}
                <div className="relative mt-3.5 h-44 w-44 self-center">
                    <div
                        className="anim-radar absolute inset-0 rounded-full"
                        style={{
                            background:
                                'conic-gradient(from 0deg, transparent 0deg, rgba(228,19,42,0.30) 46deg, transparent 64deg)',
                        }}
                    />
                    <div
                        className="absolute inset-0 rounded-full transition-[background] duration-500"
                        style={{
                            background: `conic-gradient(var(--color-blood) 0 ${data.progress}%, var(--color-line) ${data.progress}% 100%)`,
                            WebkitMask: 'radial-gradient(circle, transparent 0 76px, #000 76px)',
                            mask: 'radial-gradient(circle, transparent 0 76px, #000 76px)',
                        }}
                    />
                    <div className="absolute inset-[24px] rounded-full border border-line" />
                    <div className="absolute inset-[48px] rounded-full border border-line/70" />
                    {/* Two lines, not three, and the number is whole.
                        A tenth of a percent is noise at this size, and it made
                        the digits jitter; three stacked lines also pushed the
                        block's optical centre below the ring's. */}
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="num flex items-baseline text-fg">
                            {/* Lighter than the report's verdict number on
                                purpose: this one is a status while you wait, not
                                a finding, and at black it shouted over a screen
                                whose job is to be calm. */}
                            <span className="text-[44px] font-bold leading-none tracking-[-0.03em]">
                                {Math.round(data.progress)}
                            </span>
                            <span className="ml-0.5 text-[17px] font-semibold leading-none text-fg-dim">%</span>
                        </span>
                        <span className="mt-2 text-[11.5px] font-semibold leading-none text-fg-dim">
                            {activeTrackLabel}
                        </span>
                    </div>
                </div>

                {/* "How long" is the question anyone waiting actually has, so it
                    stays even though the copy is vague. */}
                <p className="mt-2.5 text-center text-[11px] text-fg-mute">
                    {analysisDurationProgressCopy(data.demo)}
                </p>

                {/* Who is being read right now, and how far in. */}
                {data.pipelineVersion === 'v2' && (
                    <ProgressFaces active={data.activeProfile} />
                )}

                <p className="mt-3.5 text-center text-[12px] leading-relaxed text-fg-dim" aria-live="polite">
                    {latestEventCopy ?? data.progressStep ?? '판독을 준비하고 있습니다.'}
                    {screenedCount && (
                        <span className="num text-fg-mute">
                            {' · '}{screenedCount.done} / {screenedCount.total}
                        </span>
                    )}
                </p>

                {/* Stage list as rails rather than four competing meters. A
                    finished stage says so; repeating 100% next to it adds a
                    number without adding an answer. */}
                <div className="mt-4 w-full">
                    {data.pipelineVersion === 'v2' && data.tracks
                        ? V2_TRACK_PRESENTATION.map(({ key, label }, index) => {
                            const track = data.tracks![key];
                            const isComplete = track.state === 'completed';
                            const isRunning = track.state === 'running';
                            return (
                                <div
                                    key={key}
                                    className={`flex items-center gap-3 py-2.5 ${
                                        index === V2_TRACK_PRESENTATION.length - 1
                                            ? ''
                                            : 'border-b border-line'
                                    }`}
                                >
                                    <span
                                        aria-hidden="true"
                                        className={`w-0.5 self-stretch ${
                                            isComplete
                                                ? 'bg-blood'
                                                : isRunning ? 'bg-blood-2' : 'bg-line-2'
                                        }`}
                                    />
                                    <span className={`text-[13.5px] ${
                                        isComplete || isRunning
                                            ? 'font-semibold text-fg'
                                            : 'text-fg-mute'
                                    }`}>
                                        {label}
                                    </span>
                                    <span className={`num ml-auto text-[11.5px] font-bold ${
                                        isComplete
                                            ? 'text-jade'
                                            : isRunning ? 'text-blood-2' : 'text-fg-mute'
                                    }`}>
                                        {isComplete
                                            ? '완료'
                                            : isRunning
                                                ? `${Math.round(track.progressBp / 100)}%`
                                                : '대기'}
                                    </span>
                                </div>
                            );
                        })
                        : ANALYSIS_PROGRESS_STEPS.map((step, index) => {
                            const isComplete = data.progress >= step.threshold;
                            const isCurrent =
                                data.progress >= (ANALYSIS_PROGRESS_STEPS[index - 1]?.threshold || 0)
                                && data.progress < step.threshold;
                            return (
                                <div
                                    key={step.label}
                                    className={`flex items-center gap-3 py-2.5 ${
                                        index === ANALYSIS_PROGRESS_STEPS.length - 1
                                            ? ''
                                            : 'border-b border-line'
                                    }`}
                                >
                                    <span
                                        aria-hidden="true"
                                        className={`w-0.5 self-stretch ${
                                            isComplete ? 'bg-blood' : isCurrent ? 'bg-blood-2' : 'bg-line-2'
                                        }`}
                                    />
                                    <span className={`text-[13.5px] ${
                                        isComplete || isCurrent ? 'font-semibold text-fg' : 'text-fg-mute'
                                    }`}>
                                        {step.label}
                                    </span>
                                    <span className={`num ml-auto text-[11.5px] font-bold ${
                                        isComplete ? 'text-jade' : isCurrent ? 'text-blood-2' : 'text-fg-mute'
                                    }`}>
                                        {isComplete ? '완료' : isCurrent ? '진행 중' : '대기'}
                                    </span>
                                </div>
                            );
                        })}
                </div>

                {/* Not quiet. Waiting several minutes on a screen you believe you
                    must not leave is the worst version of this page, and a grey
                    11px line at the bottom was not going to tell anyone
                    otherwise. */}
                {data.backgroundProcessing ? (
                    <p className="mt-6 flex items-center justify-center gap-2 border border-jade/35 bg-jade/[0.07] px-4 py-3 text-[13px] font-bold text-jade">
                        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" aria-hidden="true">
                            <path d="m4.5 12.5 5 5 10-11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" />
                        </svg>
                        이 화면을 나가셔도 판독은 계속됩니다
                    </p>
                ) : (
                    <p className="mt-6 border border-blood/45 bg-blood/[0.09] px-4 py-3 text-center text-[13px] font-bold text-blood">
                        판독이 끝날 때까지 이 페이지를 닫지 마세요
                    </p>
                )}
            </main>
        </div>
    );
}
