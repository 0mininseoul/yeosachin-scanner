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

type BrowserBliteStatus =
    | { state: 'pending'; submittedAt: string; fallbackAt: string; retryAfterMs: number }
    | { state: 'complete'; submittedAt: string; dto: PrecheckoutBliteV1 }
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
                    ? { state: 'complete' as const, submittedAt: value.submittedAt, dto: parsed.data }
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
        // fetched again; retaining a resolved pending promise would stall the T+48 timeline.
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
    const initialFlow = submittedAtMs === null
        ? initialBlitePageState
        : beginBlitePage(submittedAtMs) ?? initialBlitePageState;
    const [flow, setFlow] = useState<BlitePageState>(initialFlow);
    const flowRef = useRef<BlitePageState>(initialFlow);

    useEffect(() => {
        let active = true;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
        const transition = (event: BlitePageEvent): BlitePageState => {
            const next = reduceBlitePage(flowRef.current, event);
            if (next !== flowRef.current) {
                flowRef.current = next;
                setFlow(next);
            }
            return next;
        };
        const scheduleFallback = (fallbackAtMs: number) => {
            if (!Number.isFinite(fallbackAtMs)) return;
            if (fallbackTimer) clearTimeout(fallbackTimer);
            if (fallbackAtMs <= Date.now()) {
                transition({ type: 'FALLBACK_AT_48', atMs: Date.now() });
                return;
            }
            fallbackTimer = setTimeout(() => {
                if (!active) return;
                transition({ type: 'FALLBACK_AT_48', atMs: Date.now() });
            }, Math.max(0, fallbackAtMs - Date.now()));
        };
        if (submittedAtMs !== null) {
            scheduleFallback(submittedAtMs + BLITE_FALLBACK_LATCH_MS);
        }
        (async () => {
            const poll = async (): Promise<void> => {
                const status = await fetchPrecheckoutBlite(preflightId, claimToken);
                if (!active) return;
                if (status.state === 'unavailable') {
                    if (fallbackTimer) clearTimeout(fallbackTimer);
                    onAvailabilityChange?.(false);
                    return;
                }
                if (status.state === 'transient') {
                    // A network or status-route hiccup is not an authoritative feature-off
                    // decision. Keep the awaiting surface mounted and retry until the durable
                    // pending/terminal response provides the original T+48 clock.
                    pollTimer = setTimeout(() => { void poll(); }, TRANSIENT_STATUS_RETRY_MS);
                    return;
                }

                if (status.state === 'pending') {
                    const pending = beginBlitePage(Date.parse(status.submittedAt));
                    if (!pending) {
                        onAvailabilityChange?.(false);
                        return;
                    }
                    if (flowRef.current.submittedAtMs === null) {
                        flowRef.current = pending;
                        setFlow(pending);
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

                if (flowRef.current.submittedAtMs === null) {
                    const pending = beginBlitePage(Date.parse(status.submittedAt));
                    if (!pending) {
                        onAvailabilityChange?.(false);
                        return;
                    }
                    flowRef.current = pending;
                    setFlow(pending);
                }

                if (status.state === 'failed') {
                    transition({ type: 'BLITE_FAILED', atMs: Date.now() });
                    return;
                }

                const next = transition({ type: 'BLITE_COMPLETE', atMs: Date.now() });
                if (next.view !== 'blite_ready') return;
                setDto(status.dto);
                const showConfirm = status.dto.genderRead.likelyFemale
                    && status.dto.genderRead.confidence >= PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD;
                setScreen(showConfirm ? 'confirm' : 'result');
                onAvailabilityChange?.(true);
            }
            await poll();
        })();

        return () => {
            active = false;
            if (pollTimer) clearTimeout(pollTimer);
            if (fallbackTimer) clearTimeout(fallbackTimer);
        };
    }, [preflightId, claimToken, onAvailabilityChange, submittedAtMs]);

    const transition = useCallback((event: BlitePageEvent) => {
        const next = reduceBlitePage(flowRef.current, event);
        if (next !== flowRef.current) {
            flowRef.current = next;
            setFlow(next);
        }
        return next;
    }, []);

    const finishDemo = useCallback(() => {
        transition({ type: 'DEMO_COMPLETE' });
        setDismissed(true);
        onGoToPlans();
    }, [onGoToPlans, transition]);

    const failDemoOpen = useCallback(() => {
        transition({ type: 'DEMO_ERROR' });
        onDemoError?.();
        setDismissed(true);
        onGoToPlans();
    }, [onDemoError, onGoToPlans, transition]);

    if (dismissed || flow.view === 'legacy' || flow.view === 'fallback_legacy') return null;

    if (flow.view === 'fallback_demo' && flow.demoStartedAtMs !== null) {
        return (
            <PrecheckoutDemo
                mode="fallback"
                startedAtMs={flow.demoStartedAtMs}
                onComplete={finishDemo}
                onError={failDemoOpen}
            />
        );
    }

    if (flow.view === 'success_demo' && flow.demoStartedAtMs !== null) {
        return <DemoScreen startedAtMs={flow.demoStartedAtMs} onDemoError={failDemoOpen} onGoToPlans={finishDemo} />;
    }

    if (flow.view !== 'blite_ready' || !dto || screen === null) return null;

    if (screen === 'confirm') {
        return (
            <GenderConfirmScreen
                dto={dto}
                onYes={() => setScreen('result')}
                onNo={() => { setDismissed(true); onGoToPlans(); }}
            />
        );
    }

    if (screen === 'result') {
        return <BliteResultScreen dto={dto} onContinue={() => transition({ type: 'SUCCESS_CTA', atMs: Date.now() })} />;
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
    onDemoError,
    onGoToPlans,
}: {
    startedAtMs: number;
    onDemoError?: () => void;
    onGoToPlans: () => void;
}) {
    const [verdictIdx] = useState(() => Math.floor(Math.random() * VERDICTS.length));
    const verdict = VERDICTS[verdictIdx];

    return (
        <PrecheckoutDemo
            mode="success"
            startedAtMs={startedAtMs}
            onComplete={onGoToPlans}
            onError={() => { onDemoError?.(); onGoToPlans(); }}
        >
            {/* Not-yet-revealed block is genuinely inert (visibility+pointer-events, and
                display:none inside the mobile fullscreen layer via CSS) — not just transparent. */}
            <div className="precheckout-reveal mt-5">
                <div className="border-l-2 border-blood pl-3.5">
                    <h3 className="text-[16px] font-extrabold leading-snug text-fg">
                        {verdict.headline[0]}
                        <br />
                        {verdict.headline[1]}
                    </h3>
                    <p className="mt-2.5 text-[12.5px] leading-[1.8] text-fg-dim">{verdict.body}</p>
                </div>

            </div>
        </PrecheckoutDemo>
    );
}
