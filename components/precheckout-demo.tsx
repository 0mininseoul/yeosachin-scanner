'use client';

import {
    Component,
    type ReactNode,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import {
    PRECHECKOUT_DEMO_DURATION_MS,
    PrecheckoutStageGraphs,
} from './precheckout-stage-graphs';

export { PRECHECKOUT_DEMO_DURATION_MS, PRECHECKOUT_DEMO_STAGE_DURATIONS_MS } from './precheckout-stage-graphs';

const STAGE_LABELS = [
    '관계 궤도 정렬',
    '성좌 교차 판독',
    '신호 누적 스캔',
    '군집 분류',
] as const;

type DemoErrorBoundaryProps = Readonly<{
    children: ReactNode;
    onError: () => void;
}>;

type DemoErrorBoundaryState = Readonly<{
    hasError: boolean;
}>;

class DemoErrorBoundary extends Component<DemoErrorBoundaryProps, DemoErrorBoundaryState> {
    state: DemoErrorBoundaryState = { hasError: false };

    static getDerivedStateFromError(): DemoErrorBoundaryState {
        return { hasError: true };
    }

    componentDidCatch(): void {
        this.props.onError();
    }

    render(): ReactNode {
        if (this.state.hasError) {
            return (
                <div
                    className="precheckout-demo-fullscreen mt-7"
                    data-precheckout-demo-error="true"
                    role="alert"
                    aria-live="assertive"
                >
                    분석 준비 화면을 표시할 수 없습니다. 결과 확인을 계속할 수 있도록 준비 중입니다.
                </div>
            );
        }
        return this.props.children;
    }
}

function isValidStartTime(startedAtMs: number): boolean {
    return Number.isFinite(startedAtMs) && startedAtMs >= 0;
}

export function PrecheckoutDemo(props: {
    mode: 'success' | 'fallback';
    startedAtMs: number;
    onComplete: () => void;
    onError: () => void;
    children?: ReactNode;
}): ReactNode {
    const { mode, startedAtMs, onComplete, onError, children } = props;
    const [startAtMs] = useState(() => startedAtMs);
    const onCompleteRef = useRef(onComplete);
    const onErrorRef = useRef(onError);
    const completionSentRef = useRef(false);
    const errorSentRef = useRef(false);
    const [stageIndex, setStageIndex] = useState(0);
    const [demoComplete, setDemoComplete] = useState(false);

    const reportError = useCallback(() => {
        if (errorSentRef.current) return;
        errorSentRef.current = true;
        try {
            onErrorRef.current();
        } catch {
            // The page-level fail-open handler must never turn a demo error into an uncaught error.
        }
    }, []);

    const completeOnce = useCallback(() => {
        if (completionSentRef.current || errorSentRef.current) return;
        completionSentRef.current = true;
        setStageIndex(STAGE_LABELS.length - 1);
        setDemoComplete(true);
        try {
            onCompleteRef.current();
        } catch {
            reportError();
        }
    }, [reportError]);

    useEffect(() => {
        onCompleteRef.current = onComplete;
        onErrorRef.current = onError;
    }, [onComplete, onError]);

    useEffect(() => {
        if (!isValidStartTime(startAtMs)) {
            reportError();
            return undefined;
        }

        let active = true;
        const timeoutIds: Array<ReturnType<typeof setTimeout>> = [];
        const startedAt = startAtMs;

        const scheduleAt = (targetAtMs: number, callback: () => void) => {
            const schedule = () => {
                const delay = Math.max(0, targetAtMs - Date.now());
                const id = setTimeout(() => {
                    if (!active) return;
                    const remaining = targetAtMs - Date.now();
                    if (remaining > 0) {
                        schedule();
                        return;
                    }
                    try {
                        callback();
                    } catch {
                        reportError();
                    }
                }, delay);
                timeoutIds.push(id);
            };

            if (targetAtMs <= Date.now()) {
                try {
                    callback();
                } catch {
                    reportError();
                }
                return;
            }
            try {
                schedule();
            } catch {
                reportError();
            }
        };

        scheduleAt(startedAt + PRECHECKOUT_DEMO_DURATION_MS, completeOnce);

        return () => {
            active = false;
            timeoutIds.forEach(clearTimeout);
        };
    }, [completeOnce, reportError, startAtMs]);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

        let mediaQuery: MediaQueryList;
        try {
            mediaQuery = window.matchMedia('(max-width: 760px)');
        } catch {
            reportError();
            return undefined;
        }

        let locked = false;
        let previousOverflow = '';
        const syncOverflow = () => {
            try {
                if (mediaQuery.matches && !locked) {
                    previousOverflow = document.body.style.overflow;
                    document.body.style.overflow = 'hidden';
                    locked = true;
                } else if (!mediaQuery.matches && locked) {
                    document.body.style.overflow = previousOverflow;
                    locked = false;
                }
            } catch {
                reportError();
            }
        };

        syncOverflow();
        try {
            mediaQuery.addEventListener?.('change', syncOverflow);
        } catch {
            reportError();
        }
        return () => {
            mediaQuery.removeEventListener?.('change', syncOverflow);
            if (locked) document.body.style.overflow = previousOverflow;
        };
    }, [reportError]);

    const handleStageChange = useCallback((index: number) => {
        setStageIndex(index);
    }, []);
    const stageLabel = STAGE_LABELS[stageIndex];
    return (
        <DemoErrorBoundary onError={reportError}>
            <div
                className="precheckout-demo-fullscreen mt-7"
                data-precheckout-demo-mode={mode}
                aria-label="4단계 관계 판독 데모"
            >
                <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                    {stageIndex + 1}/4 단계: {stageLabel} {demoComplete ? '완료' : '진행 중'}
                </div>
                <PrecheckoutStageGraphs
                    startedAtMs={startAtMs}
                    onStageChange={handleStageChange}
                    onError={reportError}
                />
                {children}
            </div>
        </DemoErrorBoundary>
    );
}
