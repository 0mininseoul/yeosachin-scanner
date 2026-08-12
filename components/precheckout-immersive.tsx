'use client';

import { useCallback, useEffect, useState } from 'react';
import {
    PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD,
    precheckoutBliteV1Schema,
    type PrecheckoutBliteSignalBand,
    type PrecheckoutBliteV1,
} from '@/lib/services/precheckout/blite-contract';
import { CaseCard, Eyebrow, PrimaryButton } from '@/components/case-ui';
import { PrecheckoutStageGraphs } from '@/components/precheckout-stage-graphs';

/* ============================================================
   Precheckout immersive preview

   Sits between the ready-preflight target card and the plan section on /analyze.
   Fail-open by construction: any missing/invalid/slow DTO renders nothing at all, so
   with the feature flag off (204 from the API) this component is a no-op and /analyze
   looks and behaves exactly as it does today.
   ============================================================ */

// The server bounds profile collection + inference at 75s. The client must not cancel that
// legitimate work first; keep a small response-delivery margin beyond the server deadline.
const FETCH_DEADLINE_MS = 80_000;

type Screen = 'confirm' | 'result' | 'demo';

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
const VERDICT_ROTATE_MS = 4600;

export interface PrecheckoutImmersiveProps {
    preflightId: string;
    /**
     * This screen renders before login, so most real users are anonymous. Mirrors the header
     * name/conditional-inclusion style already used by `hooks/useAnalysisV2Preflight.ts` for the
     * same anonymous-claim mechanism.
     */
    claimToken: string | null;
    onGoToPlans: () => void;
}

export function PrecheckoutImmersive({ preflightId, claimToken, onGoToPlans }: PrecheckoutImmersiveProps) {
    const [dto, setDto] = useState<PrecheckoutBliteV1 | null>(null);
    const [dismissed, setDismissed] = useState(false);
    const [screen, setScreen] = useState<Screen | null>(null);
    const [sequenceComplete, setSequenceComplete] = useState(false);

    useEffect(() => {
        setDto(null);
        setDismissed(false);
        setScreen(null);
        setSequenceComplete(false);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_DEADLINE_MS);

        (async () => {
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
                // 204 (feature unavailable) and any non-200 status both fail open.
                if (res.status !== 200) return;
                const body: unknown = await res.json();
                // Re-validate on the client no matter what the server already checked.
                const parsed = precheckoutBliteV1Schema.safeParse(body);
                if (!parsed.success) return;
                if (controller.signal.aborted) return;
                setDto(parsed.data);
                const showConfirm = parsed.data.genderRead.likelyFemale
                    && parsed.data.genderRead.confidence >= PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD;
                setScreen(showConfirm ? 'confirm' : 'result');
            } catch {
                // Network error, JSON parse failure, or the bounded abort — stay unavailable.
            } finally {
                clearTimeout(timeout);
            }
        })();

        return () => {
            clearTimeout(timeout);
            controller.abort();
        };
    }, [preflightId, claimToken]);

    const handleSequenceComplete = useCallback(() => setSequenceComplete(true), []);

    if (!dto || dismissed || screen === null) return null;

    if (screen === 'confirm') {
        return (
            <GenderConfirmScreen
                dto={dto}
                onYes={() => setScreen('result')}
                onNo={() => setDismissed(true)}
            />
        );
    }

    if (screen === 'result') {
        return <BliteResultScreen dto={dto} onContinue={() => setScreen('demo')} />;
    }

    return (
        <DemoScreen
            sequenceComplete={sequenceComplete}
            onComplete={handleSequenceComplete}
            onGoToPlans={() => {
                setDismissed(true);
                onGoToPlans();
            }}
        />
    );
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
    sequenceComplete,
    onComplete,
    onGoToPlans,
}: {
    sequenceComplete: boolean;
    onComplete: () => void;
    onGoToPlans: () => void;
}) {
    const [verdictIdx] = useState(() => Math.floor(Math.random() * VERDICTS.length));
    const [rotation, setRotation] = useState(0);

    // Rotate the verdict copy every ~4.6s while it is on screen. Reduced motion shows one
    // sentence, chosen once, without cycling.
    useEffect(() => {
        if (!sequenceComplete) return undefined;
        const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced) return undefined;
        const id = setInterval(() => {
            setRotation(r => r + 1);
        }, VERDICT_ROTATE_MS);
        return () => clearInterval(id);
    }, [sequenceComplete]);

    // Mobile-only fullscreen: escape into a fixed 100dvh layer and lock body scroll while it is
    // mounted and the viewport is at/under the mobile breakpoint. Desktop stays inline — no lock.
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
        const mq = window.matchMedia('(max-width: 760px)');
        let locked = false;
        let prevOverflow = '';
        function sync() {
            if (mq.matches && !locked) {
                prevOverflow = document.body.style.overflow;
                document.body.style.overflow = 'hidden';
                locked = true;
            } else if (!mq.matches && locked) {
                document.body.style.overflow = prevOverflow;
                locked = false;
            }
        }
        sync();
        mq.addEventListener('change', sync);
        return () => {
            mq.removeEventListener('change', sync);
            if (locked) document.body.style.overflow = prevOverflow;
        };
    }, []);

    const handleFinalCtaClick = () => {
        // Second layer of the CTA guard, independent of the CSS inertness below: even if the
        // reveal block were somehow hit-testable early, the handler itself refuses to act.
        if (!sequenceComplete) return;
        onGoToPlans();
    };

    const verdict = VERDICTS[(verdictIdx + rotation) % VERDICTS.length];

    return (
        <div className="precheckout-demo-fullscreen mt-7">
            <PrecheckoutStageGraphs onComplete={onComplete} />

            {/* Not-yet-revealed block is genuinely inert (visibility+pointer-events, and
                display:none inside the mobile fullscreen layer via CSS) — not just transparent. */}
            <div className={`precheckout-reveal mt-5${sequenceComplete ? ' is-visible' : ''}`}>
                <div className="border-l-2 border-blood pl-3.5">
                    <h3 className="text-[16px] font-extrabold leading-snug text-fg">
                        {verdict.headline[0]}
                        <br />
                        {verdict.headline[1]}
                    </h3>
                    <p className="mt-2.5 text-[12.5px] leading-[1.8] text-fg-dim">{verdict.body}</p>
                </div>

                <PrimaryButton
                    type="button"
                    onClick={handleFinalCtaClick}
                    disabled={!sequenceComplete}
                    tabIndex={sequenceComplete ? undefined : -1}
                    className="mt-5"
                >
                    분석 결과 확인하기
                </PrimaryButton>
            </div>
        </div>
    );
}
