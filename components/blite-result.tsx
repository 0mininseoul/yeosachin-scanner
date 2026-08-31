'use client';

import type { CSSProperties } from 'react';
import { CaseCard, Eyebrow, PrimaryButton } from '@/components/case-ui';
import type {
    PrecheckoutBliteSignalBand,
    PrecheckoutBliteV1,
} from '@/lib/services/precheckout/blite-contract';

/**
 * B-lite 판독 결과 — one filed sheet.
 *
 * The screen this replaced was four bracketed CaseCards stacked vertically, which spent the
 * brand's loudest device four times in a row and left every block reading at the same weight.
 * Here the containers drop to Tier 0 and hierarchy is carried by type, a left margin rail, and
 * ruling; the bracket budget for the whole screen is one, spent on the conclusion.
 *
 * The one new device: an evidence row's bottom rule *is* its measurement. The rule that
 * separates one row from the next is filled from the left to that row's own confidence, so the
 * document's ruling carries the reading instead of a second bar sitting beside it. That gives a
 * per-row measure without drawing a shared axis, a scale, or any derived summary statistic —
 * all of which were explicitly rejected for this screen.
 *
 * Nothing here is bound to a post, a thumbnail, or a profile picture. Every element is driven by
 * `persona`, `signals`, `candidateRange` and `targetUsername` — the fields
 * `precheckoutBliteV1Schema` always requires — so there is no element that could render as an
 * empty frame if a media-backed field were absent, and no copy that names one as its evidence.
 *
 * That is a property of this component, and the tests prove it at this level only. It is not a
 * claim that a zero-post target reaches this screen: `blite-inference.ts` returns null for a
 * digest with `postCount === 0`, so today the backend never produces such a DTO at all. The
 * guard is here so the screen cannot acquire a media dependency that the contract does not
 * actually promise — not because that path is currently reachable.
 *
 * Presentation only: the parent owns fetching, deadlines, the gender gate, and every analytics
 * emission. `onContinue` is the sole outward edge.
 */

/**
 * The band survives as colour, never as a label. `신뢰도 높음`-style wording was rejected;
 * the classification scale the rest of the product already uses is not.
 */
const SIGNAL_BAND_BAR_COLOR: Record<PrecheckoutBliteSignalBand, string> = {
    high: 'var(--color-blood)',
    medium: 'var(--color-amber)',
    low: 'var(--color-fg-mute)',
};

/**
 * Reading order, taught once on arrival.
 *
 * These are applied as inline `animationDelay`, and the animations they drive run with `both`,
 * so each delay is also a window in which the element is held at its from-state — invisible, or
 * a measure at zero width. Under `prefers-reduced-motion: reduce` that window is not motion the
 * reader opted out of, it is content arriving late, so `app/globals.css` zeroes the delay for
 * `.reveal`, `.reveal-rail` and `.meter-fill` inside that media query. Any new staggered class
 * used here has to be added to that rule; `blite-result.test.tsx` fails if it is not.
 */
const REVEAL_SUBJECT_MS = 0;
const REVEAL_PERSONA_MS = 70;
const REVEAL_LEDGER_MS = 150;
const REVEAL_LEDGER_STEP_MS = 60;
const REVEAL_MEASURE_OFFSET_MS = 170;
const REVEAL_VERDICT_MS = 420;

export interface BliteResultScreenProps {
    /** Normalized safe handle. Null/blank falls back to the neutral subject wording. */
    targetUsername: string | null;
    dto: PrecheckoutBliteV1;
    onContinue: () => void;
}

export function BliteResultScreen({ targetUsername, dto, onContinue }: BliteResultScreenProps) {
    const target = targetUsername?.trim() || '판독 대상';

    return (
        <section
            data-precheckout-result
            aria-label="B-lite 판독 요약"
            className="mt-7"
        >
            {/* Subject. The page's own heading directly above already says the target was
                confirmed, so the handle needs a rail and a size, not a second label. The rail
                sits in a 14px gutter that the persona and the ledger then share, so the whole
                sheet reads down one text column with a single mark in its margin. */}
            <div className="reveal flex gap-3" style={{ animationDelay: `${REVEAL_SUBJECT_MS}ms` }}>
                <span
                    aria-hidden="true"
                    className="reveal-rail w-0.5 shrink-0 self-stretch bg-blood"
                    style={{ animationDelay: `${REVEAL_SUBJECT_MS}ms` }}
                />
                <p className="min-w-0 break-all text-[22px] font-extrabold leading-tight text-fg">
                    @{target}
                </p>
            </div>

            {/* Persona lead. No eyebrow: the headline is visibly a headline. */}
            <div
                className="reveal mt-3.5 pl-3.5"
                style={{ animationDelay: `${REVEAL_PERSONA_MS}ms` }}
            >
                <h2
                    data-amp-block
                    className="text-[17px] font-extrabold leading-snug text-fg"
                >
                    {dto.persona.headline}
                </h2>
                <p
                    data-amp-block
                    className="mt-2 text-[13px] leading-[1.75] text-fg-dim"
                >
                    {dto.persona.summary}
                </p>
            </div>

            {/* Evidence ledger. The ordered list carries the sequence; the printed 01–04 are
                decoration for it. No header: the categories label their own rows, and the
                persona above already frames what they are evidence for. */}
            <ol className="mt-6 border-t border-line pl-3.5">
                {dto.signals.map((signal, index) => {
                    const rowDelayMs = REVEAL_LEDGER_MS + index * REVEAL_LEDGER_STEP_MS;
                    const bandColor = SIGNAL_BAND_BAR_COLOR[signal.band];
                    return (
                        <li
                            key={`${index}:${signal.category}`}
                            className="reveal pt-3.5"
                            style={{ animationDelay: `${rowDelayMs}ms` }}
                        >
                            <div className="flex items-baseline gap-2.5">
                                <span
                                    aria-hidden="true"
                                    className="num shrink-0 text-[11px] font-bold text-fg-mute"
                                >
                                    {String(index + 1).padStart(2, '0')}
                                </span>
                                <span className="min-w-0 flex-1 text-[11.5px] font-bold leading-snug tracking-[0.04em] text-fg-dim">
                                    {signal.category}
                                </span>
                                <span
                                    className="num shrink-0 text-[13px] font-extrabold leading-none"
                                    style={{ color: bandColor }}
                                >
                                    {signal.confidence.toFixed(2)}
                                </span>
                            </div>
                            <p
                                data-amp-block
                                className="mt-1.5 text-[13px] leading-[1.7] text-fg"
                            >
                                {signal.claim}
                            </p>
                            {/* The row's closing rule and its measurement are the same object. */}
                            <div
                                data-blite-measure={signal.confidence.toFixed(2)}
                                aria-hidden="true"
                                className="relative mt-3 h-px bg-line"
                            >
                                <span
                                    className="meter-fill absolute inset-y-0 left-0"
                                    style={{
                                        '--meter-width': `${signal.confidence * 100}%`,
                                        background: bandColor,
                                        animationDelay: `${rowDelayMs + REVEAL_MEASURE_OFFSET_MS}ms`,
                                    } as CSSProperties}
                                />
                            </div>
                        </li>
                    );
                })}
            </ol>

            {/* The conclusion, and the only Tier 2 block on the screen. The range is drawn as a
                dimension between the two values the DTO actually holds — no invented total to
                measure them against. */}
            <CaseCard
                data-precheckout-result-card
                bracket="var(--color-blood)"
                className="reveal mt-6 p-5"
                style={{ animationDelay: `${REVEAL_VERDICT_MS}ms` }}
            >
                <Eyebrow>관계 판독 범위</Eyebrow>
                <p className="label-ko mt-3.5">분석 후보 예상 범위</p>
                <p className="sr-only">
                    {dto.candidateRange.min}~{dto.candidateRange.max}명
                </p>

                <div aria-hidden="true" className="mt-2.5 flex items-end gap-3">
                    <span
                        className="num shrink-0 font-black leading-none text-fg"
                        style={{ fontSize: 'clamp(30px, 9.5vw, 40px)' }}
                    >
                        {dto.candidateRange.min}
                    </span>
                    <span className="relative mb-[9px] h-[9px] min-w-[22px] flex-1">
                        <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-blood-dim" />
                        <span className="absolute left-0 top-0 h-full w-px bg-blood" />
                        <span className="absolute right-0 top-0 h-full w-px bg-blood" />
                    </span>
                    <span
                        className="num shrink-0 font-black leading-none text-fg"
                        style={{ fontSize: 'clamp(30px, 9.5vw, 40px)' }}
                    >
                        {dto.candidateRange.max}
                    </span>
                    <span className="mb-[3px] shrink-0 text-[14px] font-bold text-fg-dim">명</span>
                </div>

                {/* Source-agnostic on purpose. This line used to read
                    `공개 피드와 계정 규모를 바탕으로 한 1차 범위예요`, which names public posts and
                    account scale as the evidence. The screen itself is built to stand up without
                    any media-backed field, so naming one would be a claim the sheet cannot keep
                    for every DTO it renders. It now points at what is demonstrably above it —
                    the signals in the ledger — which is true of every valid `PrecheckoutBliteV1`. */}
                <p className="mt-4 text-[12px] leading-relaxed text-fg-mute">
                    이번 판독에서 확인한 내용을 바탕으로 좁힌 1차 범위예요. 전체 판독에서 후보별 관계 신호를 확인할 수 있어요.
                </p>
                <PrimaryButton size="lg" onClick={onContinue} className="mt-5">
                    상세 분석 보기
                </PrimaryButton>
            </CaseCard>
        </section>
    );
}
