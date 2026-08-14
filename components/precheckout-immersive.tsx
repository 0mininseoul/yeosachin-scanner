'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD,
    precheckoutBliteV1Schema,
    type PrecheckoutBliteSignalBand,
    type PrecheckoutBliteV1,
} from '@/lib/services/precheckout/blite-contract';
import { CaseCard, Eyebrow, PrimaryButton } from '@/components/case-ui';
import { PrecheckoutDemo } from '@/components/precheckout-demo';
import {
    PRECHECKOUT_EVENTS,
    trackPrecheckoutEvent,
} from '@/lib/services/analytics';
import {
    beginBlitePage,
    BLITE_FALLBACK_LATCH_MS,
    initialBlitePageState,
    reduceBlitePage,
    type BlitePageEvent,
    type BlitePageState,
} from '@/lib/services/precheckout/blite-page-flow';

/* ============================================================
   Precheckout immersive preview

   Sits between the ready-preflight target card and the plan section on /analyze.
   It reads the durable status route only. The reducer keeps the first accepted submission
   clock through polling, so a late durable result can never replace the fallback path.
   ============================================================ */

const FETCH_DEADLINE_MS = 5_000;
const TRANSIENT_STATUS_RETRY_MS = 1_000;
const MAX_ANALYTICS_DURATION_MS = 86_400_000;

type PrecheckoutFallbackReason = 'terminal_before_48' | 'unresolved_at_48' | 'demo_error';
type PrecheckoutDemoMode = 'success' | 'fallback';
type PrecheckoutEventName = typeof PRECHECKOUT_EVENTS[keyof typeof PRECHECKOUT_EVENTS];

function boundedDemoDurationMs(startedAtMs: number | null, finishedAtMs: number): number {
    if (
        typeof startedAtMs !== 'number'
        || !Number.isFinite(startedAtMs)
        || !Number.isFinite(finishedAtMs)
    ) return 0;
    return Math.min(MAX_ANALYTICS_DURATION_MS, Math.max(0, Math.floor(finishedAtMs - startedAtMs)));
}

type BrowserBliteStatus =
    | { state: 'pending'; submittedAt: string; fallbackAt: string; retryAfterMs: number }
    | { state: 'complete'; submittedAt: string; fallbackAt: string; dto: PrecheckoutBliteV1 }
    | { state: 'failed'; submittedAt: string; fallbackAt: string }
    | { state: 'unavailable' }
    | { state: 'transient' };

const browserBliteRequests = new Map<string, Promise<BrowserBliteStatus>>();

export function __resetBrowserBliteRequestsForTest(): void {
    browserBliteRequests.clear();
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
            const res = await fetch('/api/analysis/precheckout-blite', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(claimToken ? { 'x-preflight-claim-token': claimToken } : {}),
                },
                body: JSON.stringify({ preflightId }),
                signal: controller.signal,
                cache: 'no-store',
            });
            if (res.status === 202) {
                const value = await res.json() as { state?: unknown; submittedAt?: unknown; fallbackAt?: unknown; retryAfterMs?: unknown };
                return value.state === 'pending'
                    && typeof value.submittedAt === 'string'
                    && typeof value.fallbackAt === 'string'
                    && typeof value.retryAfterMs === 'number'
                    && Number.isInteger(value.retryAfterMs)
                    ? { state: 'pending' as const, submittedAt: value.submittedAt, fallbackAt: value.fallbackAt, retryAfterMs: value.retryAfterMs }
                    : { state: 'transient' as const };
            }
            if (res.status === 204) return { state: 'unavailable' as const };
            if (res.status !== 200) return { state: 'transient' as const };
            const value = await res.json() as { state?: unknown; submittedAt?: unknown; fallbackAt?: unknown; dto?: unknown };
            if (value.state === 'complete' && typeof value.submittedAt === 'string') {
                const parsed = precheckoutBliteV1Schema.safeParse(value.dto);
                return parsed.success
                    && typeof value.fallbackAt === 'string'
                    ? { state: 'complete' as const, submittedAt: value.submittedAt, fallbackAt: value.fallbackAt, dto: parsed.data }
                    : { state: 'transient' as const };
            }
            if (value.state === 'failed' && typeof value.submittedAt === 'string' && typeof value.fallbackAt === 'string') {
                return { state: 'failed' as const, submittedAt: value.submittedAt, fallbackAt: value.fallbackAt };
            }
            return { state: 'transient' as const };
        } catch {
            return { state: 'transient' as const };
        } finally {
            clearTimeout(timeout);
        }
    })();
    browserBliteRequests.set(key, pending);
    void pending.then(result => {
        // Only a terminal success is a useful browser cache. Pending/failed states must be
        // fetched again; retaining a resolved pending promise would stall the T+78 timeline.
        if (result.state !== 'complete' && browserBliteRequests.get(key) === pending) {
            browserBliteRequests.delete(key);
        }
    });
    return pending;
}

type Screen = 'confirm' | 'result';

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

/**
 * Reused verbatim from the approved prototype
 * (.superpowers/brainstorm/27823-1786421000/content/precheckout-immersive-samples.html).
 * Every subject reference is "이 남자", never "이 계정". A different sentence plays each run and
 * they rotate while the reveal is on screen — never a single fixed verdict.
 */
const VERDICTS: ReadonlyArray<{ headline: readonly [string, string]; body: string }> = [
    {
        headline: ['이 남자는 모두에게 친절합니다.', '단 한 명에게만, 조금 다릅니다.'],
        body: '좋아요는 대체로 여러 계정에 흩어져 있는데, 이 한 계정으로 향한 흔적만 유독 한 방향으로 몰립니다. 댓글에서 쓰는 말투도 다른 사람에게 쓸 때와 미묘하게 다릅니다.',
    },
    {
        headline: ['이 남자가 남긴 흔적은 대부분 흩어져 있습니다.', '딱 한 곳만 빼고.'],
        body: '반응의 분포를 보면 특별히 치우친 데가 없어 보입니다. 그런데 한 계정만 빼놓고 세면 그 분포가 갑자기 자연스러워집니다.',
    },
    {
        headline: ['우연이라기엔, 이 남자의 반응이', '같은 사람에게 너무 자주 겹칩니다.'],
        body: '한두 번이면 우연입니다. 다만 겹치는 지점이 시기와 종류를 바꿔가며 반복되면 우연으로 설명되는 폭이 좁아집니다.',
    },
    {
        headline: ['이 남자는 조용한 편입니다.', '한 계정 앞에서만 말이 길어집니다.'],
        body: '평소 댓글은 짧고 건조합니다. 그런데 특정 상대에게는 문장이 길어지고 말투가 바뀝니다. 길이는 관심의 가장 정직한 지표입니다.',
    },
    {
        headline: ['이 남자의 좋아요는 골고루 흩어져 있지만,', '시선은 한 방향입니다.'],
        body: '넓게 반응하는 계정일수록 편중이 잘 보이지 않습니다. 분포를 걷어내고 방향만 남기면 남는 이름은 많지 않습니다.',
    },
];
export interface PrecheckoutImmersiveProps {
    preflightId: string;
    /**
     * This screen renders before login, so most real users are anonymous. Mirrors the header
     * name/conditional-inclusion style already used by `hooks/useAnalysisV2Preflight.ts` for the
     * same anonymous-claim mechanism.
     */
    claimToken: string | null;
    /** The original accepted preflight clock held by /analyze, used before status responds. */
    submittedAtMs?: number | null;
    onGoToPlans: () => void;
    onAvailabilityChange?: (available: boolean) => void;
    onDemoError?: () => void;
}

export function PrecheckoutImmersive({
    preflightId,
    claimToken,
    submittedAtMs = null,
    onGoToPlans,
    onAvailabilityChange,
    onDemoError,
}: PrecheckoutImmersiveProps) {
    const [dto, setDto] = useState<PrecheckoutBliteV1 | null>(null);
    const [dismissed, setDismissed] = useState(false);
    const [screen, setScreen] = useState<Screen | null>(null);
    // Anonymous resumes can lack the persisted accepted-preflight timestamp (for example,
    // when browser storage is unavailable). Start a local deadline clock in that case so
    // repeated transient status responses cannot leave the plan gate pending forever.
    const [flow, setFlow] = useState<BlitePageState>(() => (
        beginBlitePage(submittedAtMs ?? Date.now()) ?? initialBlitePageState
    ));
    const flowRef = useRef<BlitePageState>(flow);
    // A missing parent timestamp starts a provisional local deadline only. The first durable
    // status timestamp replaces it, including after a remount, so T+78 remains submission-bound.
    const authoritativeSubmissionAtMsRef = useRef<number | null>(
        typeof submittedAtMs === 'number' && Number.isFinite(submittedAtMs) && submittedAtMs >= 0
            ? submittedAtMs
            : null,
    );
    const emittedEventKeysRef = useRef(new Set<string>());

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

    const transition = useCallback((
        event: BlitePageEvent,
        fallbackReason?: PrecheckoutFallbackReason,
    ): BlitePageState => {
        const previous = flowRef.current;
        const next = reduceBlitePage(previous, event);
        if (next !== previous) {
            const enteredFallback = next.pathLatch === 'fallback' && previous.pathLatch !== 'fallback';
            if (enteredFallback) {
                emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_FALLBACK_SELECTED, {
                    fallback_reason: fallbackReason
                        ?? (event.type === 'FALLBACK_AT_48' ? 'unresolved_at_48' : 'terminal_before_48'),
                });
            }
            const enteredDemo = (
                (next.view === 'success_demo' || next.view === 'fallback_demo')
                && next.demoStartedAtMs !== null
                && previous.demoStartedAtMs === null
            );
            if (enteredDemo) {
                emitPrecheckoutEvent(PRECHECKOUT_EVENTS.DEMO_STARTED, {
                    demo_mode: next.pathLatch === 'fallback' ? 'fallback' : 'success',
                });
            }
            if (event.type === 'DEMO_ERROR') {
                emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_FALLBACK_SELECTED, {
                    fallback_reason: 'demo_error',
                });
            }
            flowRef.current = next;
            setFlow(next);
        }
        return next;
    }, [emitPrecheckoutEvent]);

    useEffect(() => {
        let active = true;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
        const scheduleFallback = (fallbackAtMs: number) => {
            if (!Number.isFinite(fallbackAtMs)) return;
            if (fallbackTimer) clearTimeout(fallbackTimer);
            if (fallbackAtMs <= Date.now()) {
                transition({ type: 'FALLBACK_AT_48', atMs: Date.now() }, 'unresolved_at_48');
                return;
            }
            fallbackTimer = setTimeout(() => {
                if (!active) return;
                transition({ type: 'FALLBACK_AT_48', atMs: Date.now() }, 'unresolved_at_48');
            }, Math.max(0, fallbackAtMs - Date.now()));
        };
        if (flowRef.current.submittedAtMs !== null) {
            scheduleFallback(flowRef.current.submittedAtMs + BLITE_FALLBACK_LATCH_MS);
        }
        const acceptAuthoritativeSubmission = (submittedAt: string): boolean => {
            const authoritativeSubmittedAtMs = Date.parse(submittedAt);
            if (!Number.isFinite(authoritativeSubmittedAtMs)) return false;
            if (authoritativeSubmissionAtMsRef.current !== null) return true;
            const pending = beginBlitePage(authoritativeSubmittedAtMs);
            if (!pending || flowRef.current.pathLatch !== null) return false;
            authoritativeSubmissionAtMsRef.current = authoritativeSubmittedAtMs;
            flowRef.current = pending;
            setFlow(pending);
            return true;
        };
        (async () => {
            const poll = async (): Promise<void> => {
                const status = await fetchPrecheckoutBlite(preflightId, claimToken);
                if (!active) return;
                // Once the fallback demo owns the gate, every late durable status is stale.
                // Ignore it atomically so pending/failed/complete cannot revoke the fallback.
                if (flowRef.current.pathLatch === 'fallback') return;
                if (status.state === 'unavailable') {
                    // 204 is a terminal no-preview outcome (feature-off, non-cohort, or a
                    // missing durable record), never permission to reveal the legacy plan
                    // gate. It must use the same four-stage fallback as an explicit failure.
                    transition({ type: 'BLITE_FAILED', atMs: Date.now() }, 'terminal_before_48');
                    return;
                }
                if (status.state === 'transient') {
                    // A network or status-route hiccup is not an authoritative feature-off
                    // decision. Keep the awaiting surface mounted and retry until the durable
                    // pending/terminal response provides the original T+78 clock.
                    pollTimer = setTimeout(() => { void poll(); }, TRANSIENT_STATUS_RETRY_MS);
                    return;
                }

                if (status.state === 'pending') {
                    if (!acceptAuthoritativeSubmission(status.submittedAt)) {
                        transition({ type: 'BLITE_FAILED', atMs: Date.now() }, 'terminal_before_48');
                        return;
                    }
                    const fallbackAtMs = Math.min(
                        Date.parse(status.fallbackAt),
                        (flowRef.current.submittedAtMs ?? Date.parse(status.submittedAt))
                            + BLITE_FALLBACK_LATCH_MS,
                    );
                    scheduleFallback(fallbackAtMs);
                    const retryAfterMs = Math.max(250, Math.min(status.retryAfterMs, 5_000));
                    pollTimer = setTimeout(() => { void poll(); }, retryAfterMs);
                    return;
                }

                if (!acceptAuthoritativeSubmission(status.submittedAt)) {
                    transition({ type: 'BLITE_FAILED', atMs: Date.now() }, 'terminal_before_48');
                    return;
                }

                if (status.state === 'failed') {
                    transition({
                        type: 'BLITE_FAILED',
                        atMs: Date.now(),
                        fallbackAtMs: Date.parse(status.fallbackAt),
                    }, 'terminal_before_48');
                    return;
                }

                const next = transition({
                    type: 'BLITE_COMPLETE',
                    atMs: Date.now(),
                    fallbackAtMs: Date.parse(status.fallbackAt),
                }, 'unresolved_at_48');
                if (next.view !== 'blite_ready') return;
                setDto(status.dto);
                const showConfirm = status.dto.genderRead.likelyFemale
                    && status.dto.genderRead.confidence >= PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD;
                setScreen(showConfirm ? 'confirm' : 'result');
                emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_AVAILABLE);
                onAvailabilityChange?.(true);
            }
            await poll();
        })();

        return () => {
            active = false;
            if (pollTimer) clearTimeout(pollTimer);
            if (fallbackTimer) clearTimeout(fallbackTimer);
        };
    }, [claimToken, emitPrecheckoutEvent, onAvailabilityChange, preflightId, submittedAtMs, transition]);

    useEffect(() => {
        if (screen === 'result' && dto) {
            emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_RESULT_VIEWED);
        }
    }, [dto, emitPrecheckoutEvent, screen]);

    const completeDemo = useCallback(() => {
        const current = flowRef.current;
        const demoMode: PrecheckoutDemoMode = current.pathLatch === 'fallback' ? 'fallback' : 'success';
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.DEMO_COMPLETED, {
            demo_mode: demoMode,
            duration_ms: boundedDemoDurationMs(current.demoStartedAtMs, Date.now()),
        });
        transition({ type: 'DEMO_COMPLETE' });
    }, [emitPrecheckoutEvent, transition]);

    const revealPlans = useCallback(() => {
        const current = flowRef.current;
        if (
            current.view !== 'demo_reveal'
            || (current.demoStatus !== 'complete' && current.demoStatus !== 'error')
        ) return;
        const demoMode: PrecheckoutDemoMode = current.pathLatch === 'fallback' ? 'fallback' : 'success';
        transition({ type: 'PLAN_CTA' });
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.PLAN_GATE_REACHED, { demo_mode: demoMode });
        setDismissed(true);
        onGoToPlans();
    }, [emitPrecheckoutEvent, onGoToPlans, transition]);

    const failDemoOpen = useCallback(() => {
        const current = flowRef.current;
        const demoMode: PrecheckoutDemoMode = current.pathLatch === 'fallback' ? 'fallback' : 'success';
        emitPrecheckoutEvent(PRECHECKOUT_EVENTS.DEMO_FAILED, {
            demo_mode: demoMode,
            duration_ms: boundedDemoDurationMs(current.demoStartedAtMs, Date.now()),
        });
        transition({ type: 'DEMO_ERROR' });
        onDemoError?.();
    }, [emitPrecheckoutEvent, onDemoError, transition]);

    if (dismissed || flow.view === 'legacy' || flow.view === 'fallback_legacy') return null;

    if (flow.view === 'fallback_demo' && flow.demoStartedAtMs !== null) {
        return (
            <PrecheckoutDemo
                mode="fallback"
                startedAtMs={flow.demoStartedAtMs}
                onComplete={completeDemo}
                onError={failDemoOpen}
            />
        );
    }

    if (flow.view === 'success_demo' && flow.demoStartedAtMs !== null) {
        return <DemoScreen
            startedAtMs={flow.demoStartedAtMs}
            onDemoComplete={completeDemo}
            onDemoError={failDemoOpen}
        />;
    }

    if (flow.view === 'demo_reveal') {
        return <DemoRevealScreen
            demoStatus={flow.demoStatus === 'error' ? 'error' : 'complete'}
            onContinue={revealPlans}
        />;
    }

    if (flow.view !== 'blite_ready' || !dto || screen === null) return null;

    if (screen === 'confirm') {
        return (
            <GenderConfirmScreen
                dto={dto}
                onYes={() => {
                    emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_GENDER_CONFIRMATION_COMPLETED, {
                        gender_confirmation_outcome: 'confirmed',
                    });
                    setScreen('result');
                }}
                onNo={() => {
                    emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_GENDER_CONFIRMATION_COMPLETED, {
                        gender_confirmation_outcome: 'rejected',
                    });
                    transition({ type: 'SUCCESS_CTA', atMs: Date.now() });
                }}
            />
        );
    }

    if (screen === 'result') {
        return (
            <BliteResultScreen
                dto={dto}
                onContinue={() => {
                    emitPrecheckoutEvent(PRECHECKOUT_EVENTS.BLITE_PREVIEW_CTA_CLICKED);
                    transition({ type: 'SUCCESS_CTA', atMs: Date.now() });
                }}
            />
        );
    }

    return null;
}

/* ---------------- screen 1: gender confirmation ---------------- */

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

/* ---------------- screen 2: B-lite result ---------------- */

function BliteResultScreen({
    dto,
    onContinue,
}: {
    dto: PrecheckoutBliteV1;
    onContinue: () => void;
}) {
    return (
        <CaseCard bracket="var(--color-blood)" className="mt-7 overflow-hidden p-6">
            <Eyebrow>AI 1차 추론 · 공개 피드 패턴</Eyebrow>
            <h2 data-amp-block className="mt-3 text-[17px] font-extrabold leading-snug text-fg">
                {dto.persona.headline}
            </h2>
            <p data-amp-block className="mt-2.5 text-[12.5px] leading-relaxed text-fg-dim">
                {dto.persona.summary}
            </p>

            <p className="label-ko mt-6">추론된 행동·성향 신호</p>
            <div className="mt-2 divide-y divide-line border-t border-line">
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
            <p className="mt-2.5 text-[11px] leading-relaxed text-fg-mute">
                신뢰도는 사용한 게시물 수와 신호 일관성으로 보정한 값입니다. 표본이 적으면 그대로 낮게 나옵니다.
            </p>

            <div className="mt-5 border border-line-2 bg-panel p-4">
                <p className="text-[10.5px] font-bold text-fg-dim">추정치 · 확정 아님</p>
                <p className="num mt-1 text-[15px] font-extrabold leading-snug text-fg">
                    분석 후보 예상 범위 {dto.candidateRange.min} – {dto.candidateRange.max}명
                </p>
                <p className="mt-1.5 text-[10.5px] leading-relaxed text-fg-mute">
                    팔로워·팔로잉 규모로 계산한 예상 범위이며, 확정된 수치가 아닙니다. 실제 판독 결과는 이 범위와 다를 수 있어요.
                </p>
            </div>

            <PrimaryButton onClick={onContinue} className="mt-6">
                관계 판독 미리보기
            </PrimaryButton>
        </CaseCard>
    );
}

/* ---------------- screen 3: four-stage demo + verdict + CTA ---------------- */

function DemoScreen({
    startedAtMs,
    onDemoComplete,
    onDemoError,
}: {
    startedAtMs: number;
    onDemoComplete: () => void;
    onDemoError?: () => void;
}) {
    return (
        <PrecheckoutDemo
            mode="success"
            startedAtMs={startedAtMs}
            onComplete={onDemoComplete}
            onError={() => { onDemoError?.(); }}
        />
    );
}

function DemoRevealScreen({
    demoStatus,
    onContinue,
}: {
    demoStatus: 'complete' | 'error';
    onContinue: () => void;
}) {
    const [verdictIdx] = useState(() => Math.floor(Math.random() * VERDICTS.length));
    const verdict = VERDICTS[verdictIdx];

    return (
        <CaseCard data-precheckout-demo-reveal className="mt-7 overflow-hidden p-6">
            <div className="precheckout-reveal is-visible">
                {demoStatus === 'complete' ? (
                    <>
                        <Eyebrow>4단계 관계 판독 완료</Eyebrow>
                        <div className="mt-4 border-l-2 border-blood pl-3.5">
                            <h3 className="text-[16px] font-extrabold leading-snug text-fg">
                                {verdict.headline[0]}
                                <br />
                                {verdict.headline[1]}
                            </h3>
                            <p className="mt-2.5 text-[12.5px] leading-[1.8] text-fg-dim">{verdict.body}</p>
                        </div>
                    </>
                ) : (
                    <>
                        <Eyebrow>미리보기를 계속할 수 없어요</Eyebrow>
                        <p className="mt-4 text-[13px] leading-[1.8] text-fg-dim">
                            요금제를 확인하고 전체 판독을 계속할 수 있어요.
                        </p>
                    </>
                )}
                <PrimaryButton onClick={onContinue} className="mt-6">
                    상세 분석 보기
                </PrimaryButton>
            </div>
        </CaseCard>
    );
}
