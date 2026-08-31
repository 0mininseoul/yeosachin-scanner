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
import {
    PRECHECKOUT_DEMO_DURATION_MS,
    PRECHECKOUT_WAIT_LOOP_DURATION_MS,
    PRECHECKOUT_WAIT_STAGE_DURATION_MS,
} from '@/components/precheckout-stage-graphs';
import { PRECHECKOUT_EVENTS, trackPrecheckoutEvent } from '@/lib/services/analytics';
import { BLITE_UX_DEADLINE_MS } from '@/lib/services/precheckout/blite-deadline';

const FETCH_DEADLINE_MS = 5_000;
/**
 * The visible grace every mount is guaranteed from its own entry: the initial four-stage pass
 * plus exactly one complete slow waiting loop. It is the only definition of that duration.
 */
const MINIMUM_VISIBLE_GRACE_MS = PRECHECKOUT_DEMO_DURATION_MS + PRECHECKOUT_WAIT_LOOP_DURATION_MS;
const TRANSIENT_STATUS_RETRY_MS = 1_000;
const MAX_ANALYTICS_DURATION_MS = 86_400_000;

type PrecheckoutEventName = typeof PRECHECKOUT_EVENTS[keyof typeof PRECHECKOUT_EVENTS];
type DemoExit = 'result' | 'fallback';
type ImmersiveView = 'demo' | 'genderConfirm' | 'result' | 'fallback' | 'rejected';
type FallbackReason = 'unresolved_at_90' | 'demo_error';

type BrowserBliteStatus =
    | { state: 'pending'; retryAfterMs: number }
    | { state: 'complete'; dto: PrecheckoutBliteV1 }
    | { state: 'failed' }
    | { state: 'unavailable' }
    | { state: 'transient' };

const browserBliteRequests = new Map<string, Promise<BrowserBliteStatus>>();

export function __resetBrowserBliteRequestsForTest(): void {
    browserBliteRequests.clear();
}

function isValidEpoch(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function boundedDemoDurationMs(startedAtMs: number, finishedAtMs: number): number {
    if (!Number.isFinite(finishedAtMs)) return 0;
    return Math.min(MAX_ANALYTICS_DURATION_MS, Math.max(0, Math.floor(finishedAtMs - startedAtMs)));
}

function nextGraphTransitionAt(startedAtMs: number, nowMs: number): number {
    const firstPassEndsAt = startedAtMs + PRECHECKOUT_DEMO_DURATION_MS;
    if (nowMs <= firstPassEndsAt) return firstPassEndsAt;
    return firstPassEndsAt + Math.ceil(
        (nowMs - firstPassEndsAt) / PRECHECKOUT_WAIT_STAGE_DURATION_MS,
    ) * PRECHECKOUT_WAIT_STAGE_DURATION_MS;
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
            if (response.status === 204) return { state: 'unavailable' as const };
            if (response.status === 202) {
                const value = await response.json() as { state?: unknown; retryAfterMs?: unknown };
                return value.state === 'pending'
                    && typeof value.retryAfterMs === 'number'
                    && Number.isInteger(value.retryAfterMs)
                    ? { state: 'pending' as const, retryAfterMs: value.retryAfterMs }
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
            return value.state === 'failed'
                ? { state: 'failed' as const }
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
    submittedAtMs = null,
    targetUsername = null,
    onGoToPlans,
    onDemoError,
    onBliteResultShown,
}: PrecheckoutImmersiveProps) {
    /** The accepted-preflight clock; governs BLITE_UX_DEADLINE_MS only. */
    const [startedAtMs] = useState(() => isValidEpoch(submittedAtMs) ? submittedAtMs : Date.now());
    /** Mount-local clock, always fresh, so every mount/remount/reload plays S1 first. */
    const [visibleEntryAtMs] = useState(() => Date.now());
    const [view, setView] = useState<ImmersiveView>('demo');
    const [dto, setDto] = useState<PrecheckoutBliteV1 | null>(null);
    const dtoRef = useRef<PrecheckoutBliteV1 | null>(null);
    const [exit, setExit] = useState<DemoExit | null>(null);
    const exitRef = useRef<DemoExit | null>(null);
    const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const settledExitRef = useRef(false);
    const emittedEventKeysRef = useRef(new Set<string>());
    const resultAnnouncedRef = useRef(false);
    const resultViewedRef = useRef(false);
    const deadlineAtMs = startedAtMs + BLITE_UX_DEADLINE_MS;
    /**
     * Waiting on the exclusion screen spends the submission-anchored deadline before this screen
     * ever renders, so whatever is left of it can be less than one watchable run. The browser
     * display deadline is therefore never earlier than the guaranteed grace, however little of
     * the submission clock remains. Server, provider, and inference budgets stay anchored to
     * submission and are untouched.
     */
    const visibleFallbackAtMs = Math.max(
        deadlineAtMs,
        visibleEntryAtMs + MINIMUM_VISIBLE_GRACE_MS,
    );
    /** Whether this mount waits past the submission deadline purely to keep a result possible. */
    const hasExtendedVisibleGrace = visibleFallbackAtMs > deadlineAtMs;

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
        fallbackReason: FallbackReason = 'unresolved_at_90',
    ) => {
        if (exitRef.current !== null) return;
        exitRef.current = nextExit;
        if (nextExit === 'fallback') {
            emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_FALLBACK_SELECTED, {
                fallback_reason: fallbackReason,
            });
        }
        setExit(nextExit);
        const targetAtMs = forceImmediate
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
        let deadlineReached = false;
        let finalReadStarted = false;
        let terminalFailureSeen = false;

        const settleFallback = () => {
            if (!active || exitRef.current !== null) return;
            requestExit('fallback');
        };

        const schedulePoll = (delayMs: number) => {
            if (!active || exitRef.current !== null || deadlineReached
                || Date.now() >= visibleFallbackAtMs) return;
            pollTimer = setTimeout(() => { void poll(); }, delayMs);
        };

        function startFinalRead(): void {
            if (!active || exitRef.current !== null || finalReadStarted) return;
            finalReadStarted = true;
            void poll(true);
        }

        async function poll(isFinalRead = false): Promise<void> {
            if (!active || exitRef.current !== null || (deadlineReached && !isFinalRead)) return;
            statusReadInFlight = true;
            const status = await fetchPrecheckoutBlite(preflightId, claimToken);
            statusReadInFlight = false;
            if (!active || exitRef.current !== null) return;
            // A durable result is read before any deadline is applied: once it exists it is the
            // truthful screen, and the graph boundary still decides when it becomes visible.
            if (status.state === 'complete') {
                dtoRef.current = status.dto;
                setDto(status.dto);
                emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_AVAILABLE);
                requestExit('result');
                return;
            }
            if (status.state === 'failed') {
                terminalFailureSeen = true;
                // Nothing is left to poll for, and the extra visible grace exists only for a
                // result that can still arrive, so a terminal failure leaves at the next safe
                // graph boundary instead of playing that loop out.
                if (hasExtendedVisibleGrace || deadlineReached || Date.now() >= visibleFallbackAtMs) {
                    requestExit('fallback');
                }
                return;
            }
            if (deadlineReached || Date.now() >= visibleFallbackAtMs) {
                // Give one last status read a chance to observe a durable completion before the
                // fallback latch emits analytics. A non-complete final read is authoritative.
                if (isFinalRead) settleFallback();
                else startFinalRead();
                return;
            }
            const delayMs = status.state === 'pending'
                ? Math.max(250, Math.min(status.retryAfterMs, 5_000))
                : TRANSIENT_STATUS_RETRY_MS;
            schedulePoll(delayMs);
        }

        const deadlineTimer = setTimeout(() => {
            if (!active || exitRef.current !== null) return;
            deadlineReached = true;
            if (terminalFailureSeen) {
                settleFallback();
                return;
            }
            // A read that crossed the deadline still owns the completion race. Its result is
            // processed above before this effect can lock fallback or emit its event.
            if (statusReadInFlight) return;
            startFinalRead();
        }, Math.max(0, visibleFallbackAtMs - Date.now()));

        void poll();
        return () => {
            active = false;
            if (pollTimer) clearTimeout(pollTimer);
            if (deadlineTimer) clearTimeout(deadlineTimer);
        };
    }, [claimToken, emitPrecheckoutEvent, hasExtendedVisibleGrace, preflightId, requestExit, visibleEntryAtMs, visibleFallbackAtMs]);

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
        requestExit('fallback', false, 'demo_error');
        onDemoError?.();
    }, [emitPrecheckoutEvent, onDemoError, requestExit, visibleEntryAtMs]);

    if (view === 'demo') {
        return (
            <PrecheckoutDemo
                mode="waiting"
                startedAtMs={visibleEntryAtMs}
                finishRequested={exit !== null}
                onComplete={handleDemoComplete}
                onError={handleDemoError}
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
        return <FallbackScreen onContinue={() => {
            emitPrecheckoutEvent(PRECHECKOUT_EVENTS.PLAN_GATE_REACHED, { demo_mode: 'result' });
            onGoToPlans();
        }} />;
    }

    return <FallbackScreen onContinue={() => {
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.PLAN_GATE_REACHED, { demo_mode: 'fallback' });
        onGoToPlans();
    }} />;
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

function FallbackScreen({ onContinue }: { onContinue: () => void }) {
    return (
        <CaseCard data-precheckout-fallback className="mt-7 overflow-hidden p-6">
            <Eyebrow>4단계 관계 판독 완료</Eyebrow>
            <p className="mt-3 text-[14px] font-bold leading-snug text-fg">
                전체 판독에서 계정 규모에 맞는 상세 결과를 확인할 수 있어요.
            </p>
            <PrimaryButton onClick={onContinue} className="mt-6">상세 분석 보기</PrimaryButton>
        </CaseCard>
    );
}
