# B-lite 판독 결과 화면 재설계 — A(증거 편철) + B(관계 판독 범위) 하이브리드

## Decision

Rebuild only the B-lite **result** screen inside the precheckout immersive surface as a
single filed document. Direction **A (증거 편철 / The Filed Sheet)** owns the information
hierarchy; the **관계 판독 범위** module is rebuilt with Direction **B**'s "range as a measured
interval, CTA attached to it" treatment. Nothing else on the precheckout flow changes.

The user has already approved this hybrid. This spec exists to fix exactly what is in and
out of it before any code is written, not to reopen the direction.

Scope of the change:

- Extract the current inline `BliteResultScreen` from `components/precheckout-immersive.tsx`
  into a focused, prop-only component `components/blite-result.tsx`.
- Replace the four stacked `CaseCard`s with one Tier 0 document plus exactly one Tier 2 block.
- Withdraw the page heading's own eyebrow on `/analyze` **for the B-lite result state only**,
  so the finished screen carries one eyebrow rather than two. Every other state on that page
  (본인 제외, 대상 확인 before the result, demo, confirmation, fallback) keeps it unchanged.
- Keep the DTO/API contract, gating state machine, analytics vocabulary, gender confirmation,
  fallback screen, and `data-amp` masking bit-for-bit.

Explicitly **not** in scope: `app/page.tsx` marketing copy, the four-stage waiting demo, the
gender-confirmation screen's own layout, the fallback screen, the B-lite API route, the
inference prompt, capacity/backend/migration work.

## Rejected by the user — must be absent from the shipped screen

These come straight from the approval and are treated as hard exclusions, each with a test:

1. **Case-file metadata line.** No `CASE YS-26-0830-1147`, no `표본 47건`, no `1차 판독`
   slug. Prototype A's `.slug` row is dropped entirely. `dto.postCount` therefore stays
   unrendered, exactly as it is today.
2. **Qualitative confidence labels.** No `신뢰도 높음`, `신뢰도 보통`, `신뢰도 낮음`, and no
   `표본 부족`. The `SIGNAL_BAND_LABEL` map is deleted from the UI. The band survives only as
   the measure's *colour*, which is the product's existing classification scale, not a label.
3. **Decorative eyebrow labels.** The `공개 피드 신호` + `4건 · 표본 47건 기준` header is
   removed, and so are the `판독 대상` and `AI 1차 페르소나` eyebrows. The screen carries exactly
   **one** `Eyebrow` (`관계 판독 범위`) and exactly **one** quiet `.label-ko`
   (`분석 후보 예상 범위`, inside the verdict block). The ledger gets no header at all.
   This is counted across the whole screen, not just this component: the `/analyze` heading
   above it also renders `판독 의뢰서 · 대상 확인` through the same `Eyebrow` primitive, so the
   page withdraws that one while the result sheet is up (see §Parent contract).
4. **Every shared-axis or spectrum graph.** No `0 / 0.50 / 1.00` axis drawn once above the
   signals, no tick rail, no diamond plot, no `0.70 고신뢰` shaded band, no derived
   `평균 신뢰도 / 고신뢰 3/4 / 표본 47` stat row. Prototype A's move 03 and prototype B's
   entire console header are dropped.

### Also excluded by the "no post/media-backed visualization" rule

No thumbnail strip, no post grid, no profile picture, no follower/following counts, no
"n개의 게시물" counters, no example/placeholder posts, and no empty chart shell that could render
as a blank frame if a media-backed field were absent. The entire screen is driven by `persona`,
`signals`, `candidateRange`, and `targetUsername`, all of which `precheckoutBliteV1Schema`
always requires, and no copy on the screen names a post, a feed, a picture or a follower count
as its evidence.

**Scope of that guarantee.** It is a property of the component, and the tests prove it at that
level: a schema-valid DTO with `postCount: 0` renders the same complete screen. It is *not* a
claim that such a target reaches this screen. `lib/services/precheckout/blite-inference.ts`
returns `null` when the digest has `postCount === 0`, so the backend produces no B-lite DTO at
all for a zero-post target today. Earlier drafts of this spec and of the test fixtures described
that shape as "what a preflight target with no posts still produces", which was false. The guard
exists so the screen cannot quietly acquire a media dependency the contract never promised —
not because the zero-post path is currently reachable end to end.

## Preserved

- All four `signals[]`: `claim` text, `category` text, and `confidence` as a two-decimal number.
- `persona.headline` and `persona.summary` in full.
- `candidateRange.min`/`max` and the `min~max명` reading.
- Target identity (`@username`), with the existing `판독 대상` fallback string when the prop
  is null or blank.
- `data-amp-block` on the persona headline, the persona summary, and every signal claim —
  the same three content classes marked today. (`data-amp-block` is Amplitude's *block*
  selector: this content must never reach session replay.)
- CTA label `상세 분석 보기`, and its `BLITE_PREVIEW_CTA_CLICKED` → `PLAN_GATE_REACHED`
  → `onGoToPlans()` sequence, still fired from the parent.
- Gender confirmation gate, rejection path, fallback screen, polling/deadline behaviour,
  and `data-precheckout-result-card` as the "a B-lite result card is on screen" marker.

## Aesthetic direction

The product's language is a dark warm-ink forensic dossier: one crimson accent, Paperlogy,
hairlines, tabular numerals, and corner brackets reserved as the loudest device. The current
result screen spends that vocabulary four times in a row — four bracketed cards stacked
vertically — so the brackets stop meaning anything and the screen reads as a carousel of
equal-weight boxes.

The redesign is **one sheet, ruled**. Containers drop to Tier 0; hierarchy is carried by
type size, a left margin rail, and horizontal rules. The bracket budget for the whole screen
is **one**, spent on the conclusion.

The single new idea, and the thing that makes this screen memorable: **the ledger's ruling
is the measurement.** Each evidence row is separated from the next by a hairline, and that
hairline is filled from the left to the row's own confidence in the band's colour. There is
no separate bar and no separate divider — the document's own ruling carries the reading. It
gives per-row measure without inventing a shared axis, and it is the reason the screen can
drop four cards without feeling empty.

## Layout — top to bottom

Rendered inside `app/analyze` (`max-w-[500px] px-5`, so ~460px of content on mobile).

### 0. Root

`<section data-precheckout-result aria-label="B-lite 판독 요약" class="mt-7">`.
`data-precheckout-result` is the new stable "the result screen is showing" hook; it replaces
counting cards in tests.

### 1. Subject masthead — Tier 0

A 2px crimson rail in the left margin, then `@{handle}` at 22px extrabold. No card, no
eyebrow, and deliberately **no `판독 대상` label**: the page's own `<h1>` immediately above
this component already reads `판독 대상을 확인했어요`, so a label here would repeat the page.
Long handles wrap with `break-all`; identity never truncates to an ambiguous prefix. When
`targetUsername` is null or blank the existing `@판독 대상` fallback string is kept unchanged.

### 2. Persona lead — Tier 0

The headline as an `<h2>` at 17px extrabold leading-snug, then the summary at 13px / 1.75 in
`fg-dim`. Both carry `data-amp-block`. No eyebrow: the headline is visibly a headline.

The first pass gave this block its own `line-2` rail. On the rendered screen that rail was
effectively invisible against the ink, so the persona just looked arbitrarily indented. There
is now **one rail on the screen**, on the subject, and the 14px gutter it opens is shared by
the persona and the ledger — one text column, one mark in its margin.

### 3. Evidence ledger — Tier 0

An `<ol>` of exactly four `<li>` rows, opened by a top hairline. No section header.
The ordered list is the semantics; the printed `01`–`04` are `aria-hidden` decoration.

Row anatomy:

```
01  관계 노출 성향                                        0.82
    태그된 사람과의 관계를 자주 드러내는 편이에요.
────────────────────────────────────────────────·············      ← rule filled to 0.82
```

- Line 1: index (`11px`, `fg-mute`, tabular) · category (`11.5px` bold, `fg-dim`, tracking
  `0.04em`, `min-w-0` so it wraps rather than pushing the value off-screen) · confidence
  (`13px` extrabold, tabular, band colour, `shrink-0`, right-aligned in a shared column).
- Line 2: the claim at `13px` / `1.7` in `fg`, `data-amp-block`.
- The row's closing rule: **1px**, `bg-line` track, filled `0 → confidence×100%` in the band
  colour, `aria-hidden`, animated once with the existing `.meter-fill` keyframe. It was 2px in
  the first pass; on the rendered screen a 0.94 fill at that weight read as a crimson underline
  and put four hot rules on a page whose accent is meant to be spent once. At 1px it reads as
  ruling that happens to be measured, which is the intent.

Comparability across rows comes from the rows sharing a left edge and a track width and from
tabular numerals lining the values into a column — not from a drawn axis. Nothing on this
block states a scale, a maximum, a mean, or a count.

### 4. Verdict — the screen's only Tier 2

One `CaseCard` with crimson brackets, `data-precheckout-result-card`.

- `Eyebrow` `관계 판독 범위` — the only eyebrow on the screen.
- `.label-ko` `분석 후보 예상 범위`, above the figure it names. The first pass put it
  underneath; read that way the numerals arrive before anything says what they count, and the
  caliper stops being a caption for the label and becomes an unannounced statistic.
- The caliper: `28 ├────────────┤ 64명`. Min and max set at
  `clamp(30px, 9.5vw, 40px)` extrabold tabular, joined by a 1px crimson-dim dimension rule
  with 9px crimson end ticks, `명` trailing at 14px `fg-dim`. The rule flexes and the numbers
  never shrink, so a four-digit range still fits at 320px.
- The explanatory copy, **source-agnostic**:
  `이번 판독에서 확인한 내용을 바탕으로 좁힌 1차 범위예요. 전체 판독에서 후보별 관계 신호를 확인할 수 있어요.`
  The inherited first sentence read `공개 피드와 계정 규모를 바탕으로 한 1차 범위예요`, which names
  public posts and account scale as the evidence behind the number. That is a provenance claim
  the sheet cannot keep for every DTO it renders — the screen is deliberately built to stand up
  with no media-backed field at all — so it was replaced with wording that points at what is
  demonstrably above it. The second sentence is unchanged.
- `PrimaryButton size="lg"` `상세 분석 보기`.

Accessibility: the visual caliper is `aria-hidden`; a `sr-only` sibling carries
`{min}~{max}명`, which is also what keeps the tilde reading in the DOM. The label is not
repeated inside that sibling — the visible `.label-ko` immediately above it is already in the
accessibility tree, so the screen-reader order is `분석 후보 예상 범위` then `28~64명`,
with the reading assembled once rather than announced twice.

### 5. No footnote

Prototype A closes with `1차 판독은 공개 게시물만 사용합니다.` That line is dropped. It carries
the rejected `1차 판독` wording, and it names public posts as the sole source — the same
provenance claim the verdict copy had to give up. The verdict line already frames the number
(`이번 판독에서 확인한 내용을 바탕으로 좁힌 1차 범위예요.`) without naming a source, so the
footnote was only chrome, and a less truthful version of it.

## Parent contract — `onBliteResultShown`

`PrecheckoutImmersive` gains one optional prop, `onBliteResultShown?: () => void`, fired once
when the result sheet reaches the screen. `/analyze` uses it to withdraw its heading eyebrow
for that state, and resets the flag in `handleReset` so a new target restores it. Nothing else
about the parent changes: no analytics property, no gating, no copy on any other state.

The announcement is **ref-guarded inside the component**, not at the call site. A
caller-supplied callback's identity is not something this component controls — an inline arrow
in the parent re-runs the effect on every parent render, which fired the callback three times
in review. `emitPrecheckoutEvent` already dedupes per preflight, so the analytics event was
never at risk, but the callback was. The page also wraps its handler in `useCallback` so the
effect does not churn in the first place; the ref is what makes the contract correct for any
caller.

The announcement fires from a **layout effect**, and it is the only thing in that effect.
Originally it shared one passive effect with `BLITE_RESULT_VIEWED`, and that put the
withdrawal a frame late: React hands the commit that mounts the sheet to the browser before it
flushes passive effects, so the page's eyebrow and the sheet's own eyebrow could be painted
together once on arrival — a visible double-eyebrow flash. A layout effect runs before that
commit is handed over, and the parent state update it schedules is flushed in the same pass,
so the two eyebrows never share a frame. The component is only ever mounted behind client
state — `/analyze` has no preflight to render during a prerender — so the layout effect never
runs on the server.

`BLITE_RESULT_VIEWED` stays in a passive effect with a **second ref of its own**
(`resultViewedRef`), so its exactly-once guarantee does not depend on the announcement's.
Analytics is not something the first frame should wait on, and moving an Amplitude call onto
the pre-paint path would buy nothing.

This split is asserted against the component's **source**, not by rendering it. Under jsdom,
`act()` drains layout effects, passive effects, and the resulting re-render into a single
synchronous flush, which erases exactly the task boundary a real browser paints at: both
spellings produce a byte-identical DOM timeline, verified by instrumenting one with a
`MutationObserver` and comparing. A render-based assertion would therefore have passed just as
happily on the bug. `app/analyze/page.test.ts` already pins its half of this contract the same
way.

## Deliberate deviation from prototype B

Prototype B draws the range as a segment on a `0 – 120명` number line. That axis maximum is
**not in the DTO** — the prototype hard-codes it. Deriving one would put an invented
account-scale number on a real result, which the brief forbids ("do not manufacture counts").

So B's module is taken as: *the range is a measured interval, drawn, with the CTA attached to
it* — and rebuilt as a dimension line between the two values the DTO actually contains. What
is dropped from B is only the invented total, its shared axis, and its sticky CTA bar (a
fixed bar would overlap the surrounding `/analyze` flow, which owns its own scroll).

## Motion

One staggered reveal on arrival, using the existing `.reveal` / `.reveal-rail` / `.meter-fill`
utilities and `animationDelay` — no new keyframes. Blocks land in reading order
(subject → persona → ledger rows → verdict), which teaches the order instead of decorating it.
`@media (prefers-reduced-motion: reduce)` in `app/globals.css` collapses every animation to
0.001ms. **That alone did not make the reduced-motion screen the final frame**, and this
paragraph originally claimed it did.

`both` fill is the reason. It holds the *from*-state for the whole of `animation-delay`, not
just the duration, and the delays here are set per element as inline `animationDelay` — up to
330ms on the ledger rows, 500ms on the last measure, 420ms on the verdict card. Collapsing the
duration therefore left every one of those elements at `opacity: 0` / `scaleY(0)` / `width: 0`
for its full delay, so a reader who asked for less motion got blank rows and empty measures
that popped in up to half a second late. Less motion, but also less content.

The media query now also resets `animation-delay: 0s !important` for `.reveal`, `.reveal-rail`,
`.reveal-wipe`, `.reveal-sweep` and `.meter-fill`. `!important` is load-bearing rather than
defensive: the delays are inline styles, and an important author declaration is the only thing
in the cascade that outranks one. With duration and delay both collapsed, the reduced-motion
screen is the finished frame from its first paint. See the plan's 2026-09-01 follow-up, §2.

## Component structure

- `components/blite-result.tsx` — new. Exports `BliteResultScreen({ targetUsername, dto,
  onContinue })`. Pure presentation: no fetching, no timers, no analytics; the parent still
  owns every event emission. This is the smallest extraction that makes the screen testable
  without the 20-second demo clock.
- `components/blite-result.test.tsx` — new. Focused DOM/contract tests for inclusions,
  exclusions, the media-free DTO, and the CTA callback.
- `components/precheckout-immersive.tsx` — deletes the inline `BliteResultScreen` and
  `SIGNAL_BAND_LABEL`, imports the new component, and adds nothing else.
- `components/precheckout-immersive.test.tsx` — existing behaviour tests keep their meaning;
  the `toHaveLength(4)` card counts become the `data-precheckout-result` presence check.

No DTO change, no API change, no new dependency.

`app/globals.css` carries **one narrow, reviewed exception** and nothing more: the
`animation-delay` reset inside the existing `@media (prefers-reduced-motion: reduce)` block
(§Motion). It adds no keyframe, no utility and no new styling — it corrects an existing rule
that under-specified what "reduce motion" has to collapse. Every other part of that stylesheet
is out of bounds for this work.

## Self-review against the brief

| Requirement | Where it is satisfied |
| --- | --- |
| A as primary hierarchy | §Layout 1–3: Tier 0 sheet, masthead, lead, numbered ledger |
| B's relationship-range treatment | §Layout 4: drawn interval + attached CTA |
| No CASE/표본/1차 판독 metadata | §Rejected 1; `postCount` still unrendered |
| No 신뢰도 높음/보통 labels | §Rejected 2; `SIGNAL_BAND_LABEL` deleted |
| No 공개 피드 신호 / 4건 header, fewer eyebrows | §Rejected 3; 1 eyebrow + 1 label-ko total, no ledger header, no footnote |
| No shared-axis/spectrum graph | §Rejected 4; per-row rule only, no axis/scale/stats |
| No posts/profile_pic-dependent visual, no empty shell | §"Also excluded"; every element is text/number-driven |
| Signals, categories, numeric confidence kept | §Preserved; §Layout 3 |
| Candidate range kept | §Layout 4 |
| Target identity, persona, CTA kept | §Layout 1, 2, 4 |
| Gating, analytics, amp masking, gender confirm, fallback, DTO/API | §Preserved; parent untouched |
| Mobile-first, forensic language, less chrome, no nested card stack | §Aesthetic direction; 4 cards → 0 + 1 |
| No `app/page.tsx` copy, no backend/migration work | §Decision scope |

## Verification record — 2026-08-31

Focused DOM/contract suites, typecheck, lint, full suite, and a production build all run; the
screen was then driven in a real browser against deterministic fixtures through a temporary
`/blite-preview-tmp` route (created, screenshotted, deleted — never committed).

Fixtures: `rich` (posts + profile picture, bands high/high/medium/low), `media` (postCount 0,
`evidenceFields: ['post.caption']` only, four-digit `4~1200` range, two-character handle), and
`stress` (25-character handle, three-line persona, two-line claims, `106~348`).

Measured, not eyeballed:

- **Overflow.** `scrollWidth === clientWidth` at 320, 390, and 1280. Widest descendant of the
  sheet at 320px is 300px against a 300px column.
- **Eyebrow budget.** One `.eyebrow` on the whole screen — header plus main — in every fixture,
  after the page heading's eyebrow is withdrawn.
- **Bracket budget.** One `[data-precheckout-result-card]`.
- **Missing media.** Zero `img/picture/video/canvas/svg/figure` *inside* `[data-precheckout-result]`
  for both the rich and the media-free fixture. (A document-wide count returns 1 — the header
  wordmark's reticle, outside the sheet.) The media-free screen is complete: persona, four
  claims, four categories, the range, and the CTA, with no blank frame anywhere.
- **Measures bind to data.** Every `[data-blite-measure]` equals its signal's
  `confidence.toFixed(2)`, and its fill width divided by the track equals that value
  (315.8/336 = 0.94, 305.8/336 = 0.91, 194.9/336 = 0.58, 141.1/336 = 0.42).
- **Reduced motion — this reading was taken at the wrong instant and is superseded.** It
  recorded that every `.reveal`/`.reveal-rail` computes to `opacity: 1`, no transform,
  `animation-duration: 1e-06s`, with the measures at their final widths. All of that is true,
  and none of it was evidence for the claim it was used to support: the screen was sampled
  after every `animation-delay` had already elapsed, which is exactly the window the defect
  lived in. With `both` fill and the delay left intact, the same screen at first paint had
  blank ledger rows and zero-width measures for up to half a second. Corrected in §Motion and
  in the plan's 2026-09-01 follow-up, §2; the delay is now reset in the media query, and the
  claim holds from first paint.
- **Focus.** The CTA matches `:focus-visible` with the global `2px solid var(--color-blood)`
  ring at 2px offset.
- **Not a shared axis.** Confirmed visually at all three widths: the rules carry no scale, no
  tick marks, no axis labels, no aggregate, and no shaded band. The verdict's dimension line
  stays visually distinct from them — different weight, different colour role, end ticks, and
  numerals at 30–40px instead of 13px.

Screenshots (evidence path, intentionally uncommitted — `reports/` carries no binaries in this
repo): `reports/blite-result-a-hybrid-20260831/01-mobile-390-rich-full.png`,
`02-mobile-390-media-free.png`, `03-mobile-390-long-content.png`,
`04-mobile-320-media-free-overflow.png`, `05-desktop-1280-rich-cta-focus.png`,
`06-mobile-390-reduced-motion.png`.
