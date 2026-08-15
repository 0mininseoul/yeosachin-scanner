'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    precheckoutBliteV1Schema,
    type PrecheckoutBliteSignalBand,
    type PrecheckoutBliteV1,
} from '@/lib/services/precheckout/blite-contract';
import { CaseCard, Eyebrow, PrimaryButton } from '@/components/case-ui';
import { PrecheckoutDemo } from '@/components/precheckout-demo';
import {
    PRECHECKOUT_DEMO_DURATION_MS,
    PRECHECKOUT_WAIT_STAGE_DURATION_MS,
} from '@/components/precheckout-stage-graphs';
import { PRECHECKOUT_EVENTS, trackPrecheckoutEvent } from '@/lib/services/analytics';
import { BLITE_UX_DEADLINE_MS } from '@/lib/services/precheckout/blite-deadline';

const FETCH_DEADLINE_MS = 5_000;
const TRANSIENT_STATUS_RETRY_MS = 1_000;
const MAX_ANALYTICS_DURATION_MS = 86_400_000;

type PrecheckoutEventName = typeof PRECHECKOUT_EVENTS[keyof typeof PRECHECKOUT_EVENTS];
type DemoExit = 'result' | 'fallback';
type ImmersiveView = 'demo' | 'result' | 'fallback';

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

const SIGNAL_BAND_LABEL: Record<PrecheckoutBliteSignalBand, string> = {
    high: '신뢰도 높음',
    medium: '신뢰도 보통',
    low: '신뢰도 낮음 · 표본 부족',
};

const SIGNAL_BAND_BAR_COLOR: Record<PrecheckoutBliteSignalBand, string> = {
    high: 'var(--color-blood)',
    medium: 'var(--color-amber)',
    low: 'var(--color-fg-mute)',
};

export interface PrecheckoutImmersiveProps {
    preflightId: string;
    claimToken: string | null;
    /** Persisted when preflight is accepted, and therefore stable on a normal refresh. */
    submittedAtMs?: number | null;
    /** Normalized safe handle; it is available before the ready profile snapshot. */
    targetUsername?: string | null;
    onGoToPlans: () => void;
    onDemoError?: () => void;
}

export function PrecheckoutImmersive({
    preflightId,
    claimToken,
    submittedAtMs = null,
    targetUsername = null,
    onGoToPlans,
    onDemoError,
}: PrecheckoutImmersiveProps) {
    const [startedAtMs] = useState(() => isValidEpoch(submittedAtMs) ? submittedAtMs : Date.now());
    const [view, setView] = useState<ImmersiveView>('demo');
    const [dto, setDto] = useState<PrecheckoutBliteV1 | null>(null);
    const dtoRef = useRef<PrecheckoutBliteV1 | null>(null);
    const [exit, setExit] = useState<DemoExit | null>(null);
    const exitRef = useRef<DemoExit | null>(null);
    const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const settledExitRef = useRef(false);
    const emittedEventKeysRef = useRef(new Set<string>());
    const deadlineAtMs = startedAtMs + BLITE_UX_DEADLINE_MS;

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
            duration_ms: boundedDemoDurationMs(startedAtMs, Date.now()),
        });
        setView(finalExit === 'result' && dtoRef.current ? 'result' : 'fallback');
    }, [emitPrecheckoutEvent, startedAtMs]);

    const requestExit = useCallback((nextExit: DemoExit) => {
        if (exitRef.current !== null) return;
        exitRef.current = nextExit;
        if (nextExit === 'fallback') {
            emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_FALLBACK_SELECTED, {
                fallback_reason: 'unresolved_at_90',
            });
        }
        setExit(nextExit);
        const targetAtMs = nextGraphTransitionAt(startedAtMs, Date.now());
        const settle = () => {
            if (exitRef.current === nextExit) finishExit(nextExit);
        };
        if (targetAtMs <= Date.now()) {
            settle();
        } else {
            exitTimerRef.current = setTimeout(settle, targetAtMs - Date.now());
        }
    }, [emitPrecheckoutEvent, finishExit, startedAtMs]);

    useEffect(() => () => {
        if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    }, []);

    const completeFallbackAtDeadline = useCallback(() => {
        if (exitRef.current === 'result') return;
        requestExit('fallback');
    }, [requestExit]);

    useEffect(() => {
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.DEMO_STARTED, { demo_mode: 'waiting' });
    }, [emitPrecheckoutEvent]);

    useEffect(() => {
        const timeout = setTimeout(
            completeFallbackAtDeadline,
            Math.max(0, deadlineAtMs - Date.now()),
        );
        return () => clearTimeout(timeout);
    }, [completeFallbackAtDeadline, deadlineAtMs]);

    useEffect(() => {
        let active = true;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const schedulePoll = (delayMs: number) => {
            if (!active || exitRef.current !== null || Date.now() >= deadlineAtMs) return;
            pollTimer = setTimeout(() => { void poll(); }, delayMs);
        };
        const poll = async (): Promise<void> => {
            const status = await fetchPrecheckoutBlite(preflightId, claimToken);
            if (!active || exitRef.current !== null) return;
            if (Date.now() >= deadlineAtMs) {
                completeFallbackAtDeadline();
                return;
            }
            if (status.state === 'complete') {
                dtoRef.current = status.dto;
                setDto(status.dto);
                emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_AVAILABLE);
                requestExit('result');
                return;
            }
            if (status.state === 'failed') return;
            const delayMs = status.state === 'pending'
                ? Math.max(250, Math.min(status.retryAfterMs, 5_000))
                : TRANSIENT_STATUS_RETRY_MS;
            schedulePoll(delayMs);
        };
        void poll();
        return () => {
            active = false;
            if (pollTimer) clearTimeout(pollTimer);
        };
    }, [claimToken, completeFallbackAtDeadline, deadlineAtMs, emitPrecheckoutEvent, preflightId, requestExit]);

    useEffect(() => {
        if (view === 'result' && dtoRef.current) {
            emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_RESULT_VIEWED);
        }
    }, [emitPrecheckoutEvent, view]);

    const handleDemoComplete = useCallback(() => {
        finishExit(exitRef.current ?? 'fallback');
    }, [finishExit]);

    const handleDemoError = useCallback(() => {
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.DEMO_FAILED, {
            demo_mode: exitRef.current === 'result' ? 'result' : 'fallback',
            duration_ms: boundedDemoDurationMs(startedAtMs, Date.now()),
        });
        finishExit('fallback');
        onDemoError?.();
    }, [emitPrecheckoutEvent, finishExit, onDemoError, startedAtMs]);

    if (view === 'demo') {
        return (
            <PrecheckoutDemo
                mode="waiting"
                startedAtMs={startedAtMs}
                finishRequested={exit !== null}
                onComplete={handleDemoComplete}
                onError={handleDemoError}
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

    return <FallbackScreen onContinue={() => {
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.PLAN_GATE_REACHED, { demo_mode: 'fallback' });
        onGoToPlans();
    }} />;
}

function BliteResultScreen({
    targetUsername,
    dto,
    onContinue,
}: {
    targetUsername: string | null;
    dto: PrecheckoutBliteV1;
    onContinue: () => void;
}) {
    const target = targetUsername?.trim() || '판독 대상';
    return (
        <section className="mt-7 space-y-3" aria-label="B-lite 판독 요약">
            <CaseCard data-precheckout-result-card bracket="var(--color-blood)" className="p-5">
                <Eyebrow>판독 대상</Eyebrow>
                <p className="mt-2 text-[19px] font-extrabold text-fg">@{target}</p>
            </CaseCard>

            <CaseCard data-precheckout-result-card bracket="var(--color-blood)" className="p-5">
                <Eyebrow>AI 1차 페르소나</Eyebrow>
                <h2 data-amp-block className="mt-2 text-[17px] font-extrabold leading-snug text-fg">
                    {dto.persona.headline}
                </h2>
                <p data-amp-block className="mt-2 text-[12.5px] leading-relaxed text-fg-dim">
                    {dto.persona.summary}
                </p>
            </CaseCard>

            <CaseCard data-precheckout-result-card bracket="var(--color-amber)" className="p-5">
                <Eyebrow>공개 피드 신호</Eyebrow>
                <p className="mt-2 text-[12px] text-fg-dim">최근 공개 게시물 {dto.postCount}개에서 확인한 패턴</p>
                <div className="mt-3 divide-y divide-line border-t border-line">
                    {dto.signals.map(signal => (
                        <div key={signal.claim} className="py-3">
                            <div className="flex items-baseline gap-2">
                                <span data-amp-block className="flex-1 text-[12.5px] font-bold leading-snug text-fg">
                                    {signal.claim}
                                </span>
                                <span className="num shrink-0 text-[12px] font-extrabold text-fg">
                                    {signal.confidence.toFixed(2)}
                                </span>
                            </div>
                            <div className="relative mt-1.5 h-[3px] bg-line">
                                <span
                                    className="absolute inset-y-0 left-0"
                                    style={{
                                        width: `${signal.confidence * 100}%`,
                                        background: SIGNAL_BAND_BAR_COLOR[signal.band],
                                    }}
                                />
                            </div>
                            <div className="mt-1 flex justify-between text-[10px] text-fg-mute">
                                <span>{signal.category}</span>
                                <span>{SIGNAL_BAND_LABEL[signal.band]}</span>
                            </div>
                        </div>
                    ))}
                </div>
            </CaseCard>

            <CaseCard data-precheckout-result-card bracket="var(--color-amber)" className="p-5">
                <Eyebrow>성별 판독 요약</Eyebrow>
                <p className="mt-2 text-[14px] font-bold text-fg">
                    {dto.genderRead.likelyFemale ? '여성 신호가 우세하게 관찰됐어요.' : '성별 신호가 한쪽으로 뚜렷하지 않아요.'}
                </p>
                <p className="num mt-1 text-[12px] text-fg-dim">신뢰도 {dto.genderRead.confidence.toFixed(2)}</p>
                <ul data-amp-block className="mt-3 list-disc space-y-1 pl-4 text-[11.5px] leading-relaxed text-fg-dim">
                    {dto.genderRead.reasons.map(reason => <li key={reason}>{reason}</li>)}
                </ul>
            </CaseCard>

            <CaseCard data-precheckout-result-card bracket="var(--color-blood)" className="p-5">
                <Eyebrow>관계 판독 범위</Eyebrow>
                <p className="num mt-2 text-[18px] font-extrabold text-fg">
                    분석 후보 예상 범위 {dto.candidateRange.min} – {dto.candidateRange.max}명
                </p>
                <p className="mt-2 text-[11.5px] leading-relaxed text-fg-mute">
                    공개 피드와 계정 규모를 바탕으로 한 1차 범위예요. 전체 판독에서 후보별 관계 신호를 확인할 수 있어요.
                </p>
                <PrimaryButton onClick={onContinue} className="mt-5">상세 분석 보기</PrimaryButton>
            </CaseCard>
        </section>
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
