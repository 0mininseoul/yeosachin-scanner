'use client';

import { useEffect, use, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAnalysisProgress } from '@/hooks/useAnalysisProgress';
import { TopBar, BrandMark, Eyebrow, CaseCard, PrimaryButton } from '@/components/case-ui';

interface PageProps {
    params: Promise<{ requestId: string }>;
}

export default function ProgressPage({ params }: PageProps) {
    const { requestId } = use(params);
    const { data, loading, error } = useAnalysisProgress(requestId);
    const router = useRouter();
    const isRunningStep = useRef(false);
    const abortControllerRef = useRef<AbortController | null>(null);
    const retryCountRef = useRef(0);
    const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stepTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const runNextStepRef = useRef<() => void>(() => undefined);

    const MAX_RETRIES = 3;

    // 단계별 분석 실행 함수
    const runNextStep = useCallback(async () => {
        if (isRunningStep.current) return;
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

                // 서버가 파이프라인 실패를 기록한 경우 (500 + step 존재) → 재시도 불필요
                if (response.status === 500 && result.step) {
                    console.error('Pipeline failed at step:', result.step, result.error);
                    isRunningStep.current = false;
                    return;
                }

                // 504/네트워크 에러 등 일시적 에러 → 재시도
                if (retryCountRef.current < MAX_RETRIES) {
                    const delay = Math.pow(2, retryCountRef.current + 1) * 1000; // 2s, 4s, 8s
                    retryCountRef.current += 1;
                    console.warn(`Step failed (${response.status}), retrying in ${delay}ms (${retryCountRef.current}/${MAX_RETRIES})`);
                    isRunningStep.current = false;
                    retryTimeoutRef.current = setTimeout(() => {
                        retryTimeoutRef.current = null;
                        runNextStepRef.current();
                    }, delay);
                    return;
                }

                console.error('Step failed after max retries:', result.error);
                isRunningStep.current = false;
                return;
            }

            const result = await response.json();

            // 성공 시 retryCount 리셋
            retryCountRef.current = 0;

            // 완료되지 않았으면 다음 단계 실행
            if (!result.done) {
                isRunningStep.current = false;
                stepTimeoutRef.current = setTimeout(() => {
                    stepTimeoutRef.current = null;
                    runNextStepRef.current();
                }, 500);
            }
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                console.log('Step aborted');
                isRunningStep.current = false;
                return;
            }

            console.error('Failed to run step:', err);
            isRunningStep.current = false;

            // 네트워크 에러 재시도
            if (retryCountRef.current < MAX_RETRIES) {
                const delay = Math.pow(2, retryCountRef.current + 1) * 1000;
                retryCountRef.current += 1;
                console.warn(`Network error, retrying in ${delay}ms (${retryCountRef.current}/${MAX_RETRIES})`);
                retryTimeoutRef.current = setTimeout(() => {
                    retryTimeoutRef.current = null;
                    runNextStepRef.current();
                }, delay);
            }
        }
    }, [requestId]);

    useEffect(() => {
        runNextStepRef.current = runNextStep;
    }, [runNextStep]);

    // pending 또는 processing 상태이면 분석 단계 실행
    useEffect(() => {
        if (
            (data?.status === 'pending' || data?.status === 'processing') &&
            !isRunningStep.current
        ) {
            runNextStep();
        }
    }, [data?.status, runNextStep]);

    // 탭 복귀 시 파이프라인 재개
    useEffect(() => {
        const handleVisibility = () => {
            if (document.visibilityState !== 'visible') return;

            // 이미 타이머가 예약되어 있으면 무시
            if (retryTimeoutRef.current || stepTimeoutRef.current) return;

            // 분석 진행 중이고 step이 안 돌고 있으면 재개
            if (
                (data?.status === 'pending' || data?.status === 'processing') &&
                !isRunningStep.current
            ) {
                retryCountRef.current = 0; // 탭 복귀는 fresh start
                runNextStep();
            }
        };

        document.addEventListener('visibilitychange', handleVisibility);
        return () => document.removeEventListener('visibilitychange', handleVisibility);
    }, [data?.status, runNextStep]);

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
        if (data?.status === 'completed') {
            router.push(`/result/${requestId}`);
        }
    }, [data?.status, requestId, router]);

    const handleLogout = async () => {
        try {
            const response = await fetch('/api/auth/signout', { method: 'POST' });
            if (response.ok) {
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

    // 진행 단계
    const steps = [
        { label: '팔로워 수집', threshold: 15 },
        { label: '맞팔 확인', threshold: 30 },
        { label: '성별 판단', threshold: 50 },
        { label: '상호작용 분석', threshold: 75 },
        { label: '점수 계산', threshold: 95 },
    ];

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

            <main className="mx-auto flex max-w-[460px] flex-col items-center px-5 pt-12">
                <Eyebrow>판독 진행 중</Eyebrow>

                {/* radar scope focal */}
                <div className="relative mt-8 h-44 w-44">
                    <div
                        className="anim-radar absolute inset-0 rounded-full"
                        style={{
                            background:
                                'conic-gradient(from 0deg, transparent 0deg, rgba(228,19,42,0.30) 46deg, transparent 64deg)',
                        }}
                    />
                    <div className="absolute inset-0 rounded-full border border-line" />
                    <div className="absolute inset-[22px] rounded-full border border-line" />
                    <div className="absolute inset-[44px] rounded-full border border-line/70" />
                    <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-line" />
                    <div className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-line" />
                    <div className="absolute inset-0 flex items-center justify-center">
                        <BrandMark size={40} className="anim-blink text-blood" />
                    </div>
                </div>

                <h1 className="mt-8 text-[22px] font-extrabold tracking-tight text-fg">판독 중…</h1>
                <p className="mt-2 text-center text-[13px] text-fg-dim">
                    {data.progressStep || '판독을 준비하고 있습니다.'}
                </p>

                {/* progress bar */}
                <div className="mt-7 w-full">
                    <div className="h-1.5 w-full overflow-hidden bg-line">
                        <div
                            className="h-full bg-blood transition-[width] duration-500 ease-out"
                            style={{ width: `${data.progress}%`, boxShadow: '0 0 12px var(--color-blood)' }}
                        />
                    </div>
                    <div className="mt-2 flex justify-between text-[12px] text-fg-mute">
                        <span className="num font-bold text-blood">{data.progress}%</span>
                        <span>약 5분 소요</span>
                    </div>
                </div>

                {/* step log */}
                <div className="mt-7 w-full border border-line bg-ink-2">
                    {steps.map((step, index) => {
                        const isComplete = data.progress >= step.threshold;
                        const isCurrent =
                            data.progress >= (steps[index - 1]?.threshold || 0) &&
                            data.progress < step.threshold;

                        return (
                            <div
                                key={step.label}
                                className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
                            >
                                <span
                                    className={`num flex h-5 w-5 items-center justify-center text-[12px] font-bold ${
                                        isComplete
                                            ? 'bg-blood text-white'
                                            : isCurrent
                                              ? 'border border-blood text-blood'
                                              : 'border border-line-2 text-fg-mute'
                                    }`}
                                >
                                    {isComplete ? '✓' : isCurrent ? '' : index + 1}
                                    {isCurrent && <span className="anim-blink h-1.5 w-1.5 bg-blood" />}
                                </span>
                                <span
                                    className={`text-[14px] ${
                                        isComplete
                                            ? 'font-medium text-fg'
                                            : isCurrent
                                              ? 'font-semibold text-fg'
                                              : 'text-fg-mute'
                                    }`}
                                >
                                    {step.label}
                                </span>
                                <span className="num ml-auto text-[11px] tracking-widest text-fg-mute">
                                    {step.threshold}%
                                </span>
                            </div>
                        );
                    })}
                </div>

                {/* leave warning */}
                <div className="mt-7 w-full border border-blood/35 bg-blood/[0.07] px-4 py-3.5">
                    <p className="flex items-start gap-2.5 text-[13px] leading-relaxed text-blood">
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 bg-blood" />
                        <span>
                            판독이 끝날 때까지 이 페이지를 닫지 마세요.
                            <br />
                            <span className="text-fg-dim">페이지를 닫으면 판독이 중단됩니다.</span>
                        </span>
                    </p>
                </div>
            </main>
        </div>
    );
}
