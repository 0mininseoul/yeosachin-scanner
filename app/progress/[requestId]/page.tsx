'use client';

import { useEffect, use, useRef, useCallback } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useAnalysisProgress } from '@/hooks/useAnalysisProgress';

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
            <div className="min-h-screen bg-black flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
                <p className="text-red-400 mb-4">{error || '분석 요청을 찾을 수 없습니다.'}</p>
                <button
                    onClick={() => router.push('/analyze')}
                    className="text-emerald-400 underline"
                >
                    다시 시도하기
                </button>
            </div>
        );
    }

    if (data.status === 'failed') {
        return (
            <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
                <div className="text-center max-w-sm">
                    <div className="text-4xl mb-4">❌</div>
                    <h1 className="text-xl font-bold text-white mb-2">분석 실패</h1>
                    <p className="text-gray-400 mb-6">
                        {data.errorMessage || '분석 중 오류가 발생했습니다.'}
                    </p>
                    <button
                        onClick={() => router.push('/analyze')}
                        className="bg-emerald-400 text-black font-bold py-3 px-6 rounded-xl"
                    >
                        다시 시도하기
                    </button>
                </div>
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
        <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
            {/* 로그아웃 버튼 */}
            <div className="absolute top-4 right-4">
                <button
                    onClick={handleLogout}
                    className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                    로그아웃
                </button>
            </div>

            {/* 로고 */}
            <div className="w-16 h-16 mb-6">
                <Image
                    src="/logo.png"
                    alt="AI 바람감지기"
                    width={64}
                    height={64}
                    className="w-full h-full animate-pulse"
                    priority
                />
            </div>

            {/* 제목 */}
            <h1 className="text-xl font-bold text-white mb-2">분석 중...</h1>
            <p className="text-gray-400 mb-8">{data.progressStep || '분석을 준비하고 있습니다.'}</p>

            {/* 프로그레스 바 */}
            <div className="w-full max-w-sm mb-8">
                <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-emerald-400 transition-all duration-500 ease-out"
                        style={{ width: `${data.progress}%` }}
                    />
                </div>
                <div className="flex justify-between mt-2 text-sm text-gray-500">
                    <span>{data.progress}%</span>
                    <span>약 5분 소요</span>
                </div>
            </div>

            {/* 단계 체크리스트 */}
            <div className="w-full max-w-sm space-y-3">
                {steps.map((step, index) => {
                    const isComplete = data.progress >= step.threshold;
                    const isCurrent =
                        data.progress >= (steps[index - 1]?.threshold || 0) &&
                        data.progress < step.threshold;

                    return (
                        <div
                            key={step.label}
                            className={`flex items-center gap-3 p-3 rounded-xl ${isComplete
                                ? 'bg-emerald-400/10 border border-emerald-400/30'
                                : isCurrent
                                    ? 'bg-gray-800 border border-gray-700'
                                    : 'bg-gray-900/50 border border-gray-800'
                                }`}
                        >
                            <div
                                className={`w-6 h-6 rounded-full flex items-center justify-center ${isComplete
                                    ? 'bg-emerald-400 text-black'
                                    : isCurrent
                                        ? 'bg-gray-700 border-2 border-emerald-400'
                                        : 'bg-gray-800 border border-gray-600'
                                    }`}
                            >
                                {isComplete ? '✓' : isCurrent ? '⋯' : index + 1}
                            </div>
                            <span
                                className={
                                    isComplete
                                        ? 'text-emerald-400 font-medium'
                                        : isCurrent
                                            ? 'text-white'
                                            : 'text-gray-500'
                                }
                            >
                                {step.label}
                            </span>
                        </div>
                    );
                })}
            </div>

            {/* 이탈 주의 안내 */}
            <div className="mt-8 p-4 bg-red-900/20 rounded-xl border border-red-500/30 max-w-sm">
                <p className="text-sm text-red-300 text-center">
                    ⚠️ 분석이 완료될 때까지 이 페이지를 닫지 마세요!
                    <br />
                    <span className="text-gray-400">페이지를 닫으면 분석이 중단됩니다.</span>
                </p>
            </div>
        </div>
    );
}
