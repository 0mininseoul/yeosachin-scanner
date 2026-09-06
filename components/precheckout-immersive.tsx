'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD,
    precheckoutBliteV1Schema,
    type PrecheckoutBliteV1,
} from '@/lib/services/precheckout/blite-contract';
import { BliteResultScreen } from '@/components/blite-result';
import { CaseCard, Eyebrow, PrimaryButton } from '@/components/case-ui';
import { PrecheckoutDemo } from '@/components/precheckout-demo';
import { PRECHECKOUT_DEMO_DURATION_MS } from '@/components/precheckout-stage-graphs';
import { PrecheckoutDelayedStatus } from '@/components/preflight-pending-status';
import { PRECHECKOUT_EVENTS, trackPrecheckoutEvent } from '@/lib/services/analytics';
import {
    canRetryPrecheckout,
    resolvePrecheckoutFallbackAction,
} from '@/lib/services/precheckout/blite-page-flow';

const FETCH_DEADLINE_MS = 5_000;
const TRANSIENT_STATUS_RETRY_MS = 1_000;
const PRECHECKOUT_BLITE_SLOW_POLL_INTERVAL_MS = 5_000;
const MAX_ANALYTICS_DURATION_MS = 86_400_000;

type PrecheckoutEventName = typeof PRECHECKOUT_EVENTS[keyof typeof PRECHECKOUT_EVENTS];
type DemoExit = 'result' | 'fallback';
type ImmersiveView = 'demo' | 'delayed' | 'genderConfirm' | 'result' | 'fallback' | 'rejected';
type FallbackAction = 'plans' | 'retry';
type FallbackReason =
    | 'blite_unavailable'
    | 'blite_terminal'
    | 'preflight_expired'
    | 'demo_error';
type ParentState = 'pending' | 'processing' | 'ready' | 'expired' | 'unknown';
type DelayedState = 'parent_pending' | 'pending';

type BrowserBliteStatus =
    | { state: 'parent_pending'; parentState: 'pending' | 'processing'; retryAfterMs: number }
    | { state: 'pending'; retryAfterMs: number }
    | { state: 'complete'; dto: PrecheckoutBliteV1 }
    | { state: 'failed' }
    | { state: 'unavailable' }
    | { state: 'terminal' }
    | { state: 'expired' }
    | { state: 'transient' };

const browserBliteRequests = new Map<string, Promise<BrowserBliteStatus>>();

export function __resetBrowserBliteRequestsForTest(): void {
    browserBliteRequests.clear();
}

function boundedDemoDurationMs(startedAtMs: number, finishedAtMs: number): number {
    if (!Number.isFinite(finishedAtMs)) return 0;
    return Math.min(MAX_ANALYTICS_DURATION_MS, Math.max(0, Math.floor(finishedAtMs - startedAtMs)));
}

function nextGraphTransitionAt(startedAtMs: number, nowMs: number): number {
    const firstPassEndsAt = startedAtMs + PRECHECKOUT_DEMO_DURATION_MS;
    return nowMs <= firstPassEndsAt ? firstPassEndsAt : nowMs;
}

async function fetchPrecheckoutBlite(
    preflightId: string,
    claimToken: string | null,
): Promise<BrowserBliteStatus> {
    const key = `${preflightId}:${claimToken ?? ''}`;
    const existing = browserBliteRequests.get(key);
    if (existing) return existing;

    const pending = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_DEADLINE_MS);
        try {
            const response = await fetch('/api/analysis/precheckout-blite', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(claimToken ? { 'x-preflight-claim-token': claimToken } : {}),
                },
                body: JSON.stringify({ preflightId }),
                signal: controller.signal,
                cache: 'no-store',
            });
            if (response.status === 204) return { state: 'transient' as const };
            if (response.status === 202) {
                const value = await response.json() as {
                    state?: unknown;
                    parentState?: unknown;
                    retryAfterMs?: unknown;
                };
                const retryAfterMs = value.retryAfterMs;
                const boundedRetry = typeof retryAfterMs === 'number'
                    && Number.isInteger(retryAfterMs)
                    && retryAfterMs >= 500
                    && retryAfterMs <= 2_000;
                if (!boundedRetry) return { state: 'transient' as const };
                if (
                    value.state === 'parent_pending'
                    && (value.parentState === 'pending' || value.parentState === 'processing')
                ) {
                    return {
                        state: 'parent_pending' as const,
                        parentState: value.parentState as 'pending' | 'processing',
                        retryAfterMs,
                    };
                }
                return value.state === 'pending'
                    ? { state: 'pending' as const, retryAfterMs }
                    : { state: 'transient' as const };
            }
            if (response.status === 410) {
                const value = await response.json() as { state?: unknown };
                return value.state === 'expired'
                    ? { state: 'expired' as const }
                    : { state: 'transient' as const };
            }
            if (response.status !== 200) return { state: 'transient' as const };
            const value = await response.json() as { state?: unknown; dto?: unknown };
            if (value.state === 'complete') {
                const parsed = precheckoutBliteV1Schema.safeParse(value.dto);
                return parsed.success
                    ? { state: 'complete' as const, dto: parsed.data }
                    : { state: 'transient' as const };
            }
            if (value.state === 'failed') return { state: 'failed' as const };
            if (value.state === 'unavailable') return { state: 'unavailable' as const };
            return value.state === 'terminal'
                ? { state: 'terminal' as const }
                : { state: 'transient' as const };
        } catch {
            return { state: 'transient' as const };
        } finally {
            clearTimeout(timeout);
        }
    })();

    browserBliteRequests.set(key, pending);
    void pending.then(result => {
        // A completed DTO is immutable and useful across a refresh. Every other state must be
        // read again because ordinary preflight readiness can create its B-lite source later.
        if (result.state !== 'complete' && browserBliteRequests.get(key) === pending) {
            browserBliteRequests.delete(key);
        }
    });
    return pending;
}

export interface PrecheckoutImmersiveProps {
    preflightId: string;
    claimToken: string | null;
    /** Persisted when preflight is accepted, and therefore stable on a normal refresh. */
    submittedAtMs?: number | null;
    /** Normalized safe handle; it is available before the ready profile snapshot. */
    targetUsername?: string | null;
    onGoToPlans: () => void;
    /** Starts a new page-owned preflight only after an authoritative terminal/expiry CTA click. */
    onRetry?: () => void;
    onDemoError?: () => void;
    /**
     * Fired once the B-lite result sheet is on screen. The page owns the heading above this
     * surface, and that heading's eyebrow is the second eyebrow-like label on the result
     * screen, so the page needs to know when to withdraw it. Result state only — the demo,
     * confirmation, rejection, and fallback screens never fire it.
     */
    onBliteResultShown?: () => void;
}

export function PrecheckoutImmersive({
    preflightId,
    claimToken,
    targetUsername = null,
    onGoToPlans,
    onRetry,
    onDemoError,
    onBliteResultShown,
}: PrecheckoutImmersiveProps) {
    /** Mount-local clock, always fresh, so every mount/remount/reload plays S1 first. */
    const [visibleEntryAtMs] = useState(() => Date.now());
    const [view, setView] = useState<ImmersiveView>('demo');
    const [dto, setDto] = useState<PrecheckoutBliteV1 | null>(null);
    const dtoRef = useRef<PrecheckoutBliteV1 | null>(null);
    const exitRef = useRef<DemoExit | null>(null);
    const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const settledExitRef = useRef(false);
    const initialPassCompleteRef = useRef(false);
    const [delayedState, setDelayedState] = useState<DelayedState>('pending');
    const [parentState, setParentState] = useState<ParentState>('unknown');
    const parentStateRef = useRef<ParentState>('unknown');
    const fallbackActionRef = useRef<FallbackAction>('plans');
    const fallbackReasonRef = useRef<FallbackReason>('demo_error');
    const fallbackCtaClickedRef = useRef(false);
    const emittedEventKeysRef = useRef(new Set<string>());
    const resultAnnouncedRef = useRef(false);
    const resultViewedRef = useRef(false);

    const emitPrecheckoutEvent = useCallback((
        eventName: PrecheckoutEventName,
        properties?: Record<string, unknown>,
    ): boolean => {
        const key = `${eventName}:${preflightId}`;
        if (emittedEventKeysRef.current.has(key)) return false;
        emittedEventKeysRef.current.add(key);
        return properties === undefined
            ? trackPrecheckoutEvent(eventName, preflightId)
            : trackPrecheckoutEvent(eventName, preflightId, properties);
    }, [preflightId]);

    const finishExit = useCallback((finalExit: DemoExit) => {
        if (settledExitRef.current) return;
        settledExitRef.current = true;
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.DEMO_COMPLETED, {
            demo_mode: finalExit === 'result' ? 'result' : 'fallback',
            duration_ms: boundedDemoDurationMs(visibleEntryAtMs, Date.now()),
        });
        const resultDto = finalExit === 'result' ? dtoRef.current : null;
        if (resultDto) {
            const needsGenderConfirm = resultDto.genderRead.likelyFemale
                && resultDto.genderRead.confidence >= PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD;
            setView(needsGenderConfirm ? 'genderConfirm' : 'result');
            return;
        }
        setView('fallback');
    }, [emitPrecheckoutEvent, visibleEntryAtMs]);

    const requestExit = useCallback((
        nextExit: DemoExit,
        forceImmediate = false,
        fallbackReason: FallbackReason = 'blite_terminal',
        fallbackAction: FallbackAction = 'plans',
        nextParentState: ParentState = parentStateRef.current,
    ) => {
        if (exitRef.current !== null) return;
        exitRef.current = nextExit;
        if (nextExit === 'fallback') {
            fallbackActionRef.current = fallbackAction;
            fallbackReasonRef.current = fallbackReason;
            parentStateRef.current = nextParentState;
            setParentState(nextParentState);
            emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_FALLBACK_SELECTED, {
                fallback_reason: fallbackReason,
            });
        }
        const targetAtMs = forceImmediate || initialPassCompleteRef.current
            ? Date.now()
            : nextGraphTransitionAt(visibleEntryAtMs, Date.now());
        const settle = () => {
            if (exitRef.current === nextExit) finishExit(nextExit);
        };
        if (targetAtMs <= Date.now()) {
            settle();
        } else {
            exitTimerRef.current = setTimeout(settle, targetAtMs - Date.now());
        }
    }, [emitPrecheckoutEvent, finishExit, visibleEntryAtMs]);

    const handleInitialPassComplete = useCallback(() => {
        initialPassCompleteRef.current = true;
        if (exitRef.current !== null) {
            finishExit(exitRef.current);
            return;
        }
        setView('delayed');
    }, [finishExit]);

    useEffect(() => () => {
        if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    }, []);

    useEffect(() => {
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.DEMO_STARTED, { demo_mode: 'waiting' });
    }, [emitPrecheckoutEvent]);

    useEffect(() => {
        let active = true;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        let statusReadInFlight = false;

        const schedulePoll = (delayMs: number) => {
            if (!active || exitRef.current !== null || pollTimer !== undefined) return;
            pollTimer = setTimeout(() => {
                pollTimer = undefined;
                void poll();
            }, delayMs);
        };

        const setAuthoritativeParentState = (next: ParentState) => {
            parentStateRef.current = next;
            setParentState(next);
        };

        const keepDelayed = (nextState: DelayedState, nextParentState: ParentState) => {
            setDelayedState(nextState);
            setAuthoritativeParentState(nextParentState);
            if (initialPassCompleteRef.current && exitRef.current === null) setView('delayed');
        };

        const schedulePendingPoll = (retryAfterMs: number) => {
            const fastDelay = Math.max(250, Math.min(retryAfterMs, 2_000));
            schedulePoll(initialPassCompleteRef.current
                ? PRECHECKOUT_BLITE_SLOW_POLL_INTERVAL_MS
                : fastDelay);
        };

        async function poll(): Promise<void> {
            if (!active || exitRef.current !== null || statusReadInFlight) return;
            statusReadInFlight = true;
            const status = await fetchPrecheckoutBlite(preflightId, claimToken);
            statusReadInFlight = false;
            if (!active || exitRef.current !== null) return;

            switch (status.state) {
                case 'complete':
                    setAuthoritativeParentState('ready');
                    dtoRef.current = status.dto;
                    setDto(status.dto);
                    emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_AVAILABLE);
                    requestExit('result');
                    return;
                case 'failed':
                    {
                        const action = resolvePrecheckoutFallbackAction(status.state);
                        if (action === 'delayed' || (action === 'retry' && !canRetryPrecheckout(status.state))) {
                            return;
                        }
                        requestExit('fallback', false, 'blite_terminal', action, 'ready');
                    }
                    return;
                case 'terminal':
                    {
                        const action = resolvePrecheckoutFallbackAction(status.state);
                        if (action === 'delayed' || (action === 'retry' && !canRetryPrecheckout(status.state))) {
                            return;
                        }
                        requestExit('fallback', false, 'blite_terminal', action, 'unknown');
                    }
                    return;
                case 'expired':
                    {
                        const action = resolvePrecheckoutFallbackAction(status.state);
                        if (action === 'delayed' || (action === 'retry' && !canRetryPrecheckout(status.state))) {
                            return;
                        }
                        requestExit('fallback', false, 'preflight_expired', action, 'expired');
                    }
                    return;
                case 'unavailable':
                    {
                        const action = resolvePrecheckoutFallbackAction(status.state);
                        if (action === 'delayed' || (action === 'retry' && !canRetryPrecheckout(status.state))) {
                            return;
                        }
                        requestExit('fallback', false, 'blite_unavailable', action, 'ready');
                    }
                    return;
                case 'parent_pending':
                    keepDelayed('parent_pending', status.parentState);
                    schedulePendingPoll(status.retryAfterMs);
                    return;
                case 'pending':
                    keepDelayed('pending', 'ready');
                    schedulePendingPoll(status.retryAfterMs);
                    return;
                case 'transient':
                    if (parentStateRef.current === 'pending' || parentStateRef.current === 'processing') {
                        keepDelayed('parent_pending', parentStateRef.current);
                    } else {
                        keepDelayed('pending', 'unknown');
                    }
                    schedulePendingPoll(TRANSIENT_STATUS_RETRY_MS);
                    return;
            }
        }

        void poll();
        return () => {
            active = false;
            if (pollTimer) clearTimeout(pollTimer);
        };
    }, [claimToken, emitPrecheckoutEvent, preflightId, requestExit]);

    /**
     * The page withdraws its own heading eyebrow on this announcement, so the announcement has
     * to land in the same commit the sheet does. As a passive effect it did not: React hands
     * the mounting commit back to the browser before flushing those, so the page eyebrow and
     * the sheet's own eyebrow could share a frame — a visible double-eyebrow flash on arrival.
     * A layout effect runs before the browser is given the commit, and the state update it
     * schedules is flushed in the same pass, so the withdrawal is never a frame late.
     *
     * One shot, guarded here rather than at the call site. `onBliteResultShown` is a
     * caller-supplied callback whose identity this component does not control: an inline arrow
     * in the parent would rerun this effect on every parent render. The ref makes the
     * announcement correct regardless of the caller.
     *
     * This component is only ever mounted behind client state (`/analyze` has no preflight to
     * render on the server), so the layout effect never runs during a prerender.
     */
    useLayoutEffect(() => {
        if (view !== 'result' || !dtoRef.current || resultAnnouncedRef.current) return;
        resultAnnouncedRef.current = true;
        onBliteResultShown?.();
    }, [onBliteResultShown, view]);

    /**
     * Analytics deliberately stays a passive effect: it is not something the first frame waits
     * on, and `emitPrecheckoutEvent` already dedupes per preflight. Its own ref keeps the
     * exactly-once guarantee independent of the announcement above.
     */
    useEffect(() => {
        if (view !== 'result' || !dtoRef.current || resultViewedRef.current) return;
        resultViewedRef.current = true;
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_RESULT_VIEWED);
    }, [emitPrecheckoutEvent, view]);

    const handleDemoComplete = useCallback(() => {
        finishExit(exitRef.current ?? 'fallback');
    }, [finishExit]);

    const handleDemoError = useCallback(() => {
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.DEMO_FAILED, {
            demo_mode: exitRef.current === 'result' ? 'result' : 'fallback',
            duration_ms: boundedDemoDurationMs(visibleEntryAtMs, Date.now()),
        });
        requestExit('fallback', false, 'demo_error', 'plans', parentStateRef.current);
        onDemoError?.();
    }, [emitPrecheckoutEvent, onDemoError, requestExit, visibleEntryAtMs]);

    const handleFallbackCta = useCallback(() => {
        if (fallbackCtaClickedRef.current) return;
        fallbackCtaClickedRef.current = true;
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_FALLBACK_CTA_CLICKED, {
            parent_state: parentStateRef.current,
            fallback_reason: fallbackReasonRef.current,
        });
        if (fallbackActionRef.current === 'retry') {
            onRetry?.();
            return;
        }
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.PLAN_GATE_REACHED, { demo_mode: 'fallback' });
        onGoToPlans();
    }, [emitPrecheckoutEvent, onGoToPlans, onRetry]);

    if (view === 'demo') {
        return (
            <PrecheckoutDemo
                mode="waiting"
                startedAtMs={visibleEntryAtMs}
                onInitialPassComplete={handleInitialPassComplete}
                onComplete={handleDemoComplete}
                onError={handleDemoError}
            />
        );
    }

    if (view === 'delayed') {
        const delayedParentState = parentState === 'processing' || parentState === 'ready'
            ? parentState
            : 'pending';
        return (
            <PrecheckoutDelayedStatus
                targetInstagramId={targetUsername}
                state={delayedState}
                parentState={delayedParentState}
            />
        );
    }

    if (view === 'genderConfirm' && dto) {
        return (
            <GenderConfirmScreen
                dto={dto}
                onYes={() => {
                    emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_GENDER_CONFIRMATION_COMPLETED, {
                        gender_confirmation_outcome: 'confirmed',
                    });
                    setView('result');
                }}
                onNo={() => {
                    emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_GENDER_CONFIRMATION_COMPLETED, {
                        gender_confirmation_outcome: 'rejected',
                    });
                    setView('rejected');
                }}
            />
        );
    }

    if (view === 'result' && dto) {
        return (
            <BliteResultScreen
                targetUsername={targetUsername}
                dto={dto}
                onContinue={() => {
                    emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_PREVIEW_CTA_CLICKED);
                    emitPrecheckoutEvent(PRECHECKOUT_EVENTS.PLAN_GATE_REACHED, { demo_mode: 'result' });
                    onGoToPlans();
                }}
            />
        );
    }

    if (view === 'rejected') {
        // A gender rejection is not a B-lite timeout/failure: the neutral completion CTA is
        // reused as-is, but its analytics still record the already-available `result` demo mode.
        return <FallbackScreen action="plans" onContinue={() => {
            emitPrecheckoutEvent(PRECHECKOUT_EVENTS.PLAN_GATE_REACHED, { demo_mode: 'result' });
            onGoToPlans();
        }} />;
    }

    return <FallbackScreen action={fallbackActionRef.current} onContinue={handleFallbackCta} />;
}

function GenderConfirmScreen({
    dto,
    onYes,
    onNo,
}: {
    dto: PrecheckoutBliteV1;
    onYes: () => void;
    onNo: () => void;
}) {
    return (
        <CaseCard bracket="var(--color-amber)" className="mt-7 p-6 text-center">
            <Eyebrow className="justify-center">판독 방향 확인</Eyebrow>
            <h2 className="mt-3 text-[19px] font-extrabold leading-snug text-fg">
                이 계정의 인물이 남자가 맞나요?
            </h2>
            <p data-amp-block className="mt-2.5 text-[13px] leading-relaxed text-fg-dim">
                공개 게시물과 프로필 신호를 1차로 추론한 결과, 이 계정의 인물이{' '}
                <span className="font-bold text-fg">여성일 가능성이 높다는 고신뢰 판독</span>이 나왔습니다.
                판독 방향이 어긋나지 않도록, 시작 전에 한 번만 확인이 필요해요.
            </p>

            <div data-amp-block className="mt-4 border border-line bg-ink-2 p-3.5 text-left">
                <p className="label-ko">이렇게 본 이유</p>
                <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[12px] leading-relaxed text-fg-dim">
                    {dto.genderRead.reasons.map(reason => (
                        <li key={reason}>{reason}</li>
                    ))}
                </ul>
            </div>

            <div className="mt-5 flex gap-2.5">
                <button
                    type="button"
                    onClick={onNo}
                    className="flex-1 border border-line-2 bg-transparent px-5 py-4 text-[15px] font-bold text-fg transition-colors duration-150 hover:border-fg-dim hover:bg-panel"
                >
                    아니오
                </button>
                <PrimaryButton onClick={onYes} className="flex-1">
                    예
                </PrimaryButton>
            </div>
            <p className="mt-2.5 text-[11px] text-fg-mute">
                &quot;아니오&quot;를 선택하면 이 미리보기는 안전하게 종료돼요.
            </p>
        </CaseCard>
    );
}

function FallbackScreen({
    action,
    onContinue,
}: {
    action: FallbackAction;
    onContinue: () => void;
}) {
    return (
        <CaseCard data-precheckout-fallback className="mt-7 overflow-hidden p-6">
            <Eyebrow>4단계 관계 판독 완료</Eyebrow>
            <p className="mt-3 text-[14px] font-bold leading-snug text-fg">
                전체 판독에서 계정 규모에 맞는 상세 결과를 확인할 수 있어요.
            </p>
            <PrimaryButton onClick={onContinue} className="mt-6">
                {action === 'retry' ? '다시 확인하기' : '상세 분석 보기'}
            </PrimaryButton>
        </CaseCard>
    );
}
