# B-lite 결과 화면 A+B 하이브리드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `test-driven-development`. Every task writes
> a failing test first, watches it fail for the right reason, then implements. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved A+B hybrid B-lite result screen — one Tier 0 filed sheet with
exactly one bracketed verdict block — while proving by test that the four user-rejected
elements are gone, that every real DTO field still renders, and that the component itself has
no media dependency: a schema-valid DTO carrying no post- or profile-picture-backed evidence
renders the same complete screen, with no empty visualization. That is a component-level
property. It is not a claim that such a target reaches this screen — see the 2026-09-01
follow-up, §3b.

**Architecture:** `BliteResultScreen` moves out of `components/precheckout-immersive.tsx` into
a prop-only `components/blite-result.tsx`. The parent keeps 100% of the fetch/deadline/gating/
analytics state machine and simply renders the extracted component. Presentation tests run
against the extracted component directly (no fake demo clock); the existing behaviour suite
keeps driving the parent.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind CSS 4, TypeScript, Vitest 3 + jsdom,
existing `precheckoutBliteV1Schema` DTO and `PRECHECKOUT_EVENTS` analytics vocabulary.

---

## File structure and boundaries

- `components/blite-result.tsx` — **new.** Owns only the result screen's markup. No fetch, no
  timers, no analytics calls, no DTO parsing. Props: `{ targetUsername: string | null; dto:
  PrecheckoutBliteV1; onContinue: () => void }`.
- `components/blite-result.test.tsx` — **new.** Focused DOM/contract suite: inclusions,
  exclusions, media-free DTO, CTA callback, accessibility hooks.
- `components/precheckout-immersive.tsx` — **modify.** Delete the inline `BliteResultScreen`
  and `SIGNAL_BAND_LABEL`; import the new component. Do not touch polling, deadlines, the
  gender gate, the fallback screen, or event emission.
- `components/precheckout-immersive.test.tsx` — **modify assertions only**, plus the two new
  `onBliteResultShown` tests. Replace card-count assertions with the `data-precheckout-result`
  presence hook. Do not weaken or delete any behavioural test.
- `app/analyze/page.tsx` / `app/analyze/page.test.ts` — **one narrow change**: withdraw the page
  heading's eyebrow while the B-lite result sheet is up, driven by the new
  `onBliteResultShown` callback. No other state, no landing copy.

Out of bounds for this plan: `app/page.tsx`, everything on `app/analyze/page.tsx` except the
one eyebrow gate above, the B-lite API route, `lib/services/precheckout/*`, migrations, any
backend or capacity work.

`app/globals.css` was out of bounds as originally written, and is now **in bounds for exactly
one reviewed exception**: the `animation-delay` reset inside the existing
`@media (prefers-reduced-motion: reduce)` block, added on 2026-09-01 (§2 of the follow-up).
Nothing else in that stylesheet may be touched by this work — no new keyframes, no new
utilities, no changes to the reveal animations themselves. The exception exists because the
defect is only fixable there: the delays are inline styles on this component, and an important
author declaration in that media query is the only thing that outranks them.

---

## Task 1: Lock the redesign contract with a failing focused test suite

**Files:**

- Create: `components/blite-result.test.tsx`

- [x] **Step 1: Write the fixture module.**

Two deterministic DTOs built to satisfy `precheckoutBliteV1Schema` exactly (4 signals, at
least one not `high`, band derived from confidence, `min < max`, 3 gender reasons):

- `richDto()` — realistic Korean claims, `candidateRange: { min: 28, max: 64 }`,
  `postCount: 47`, evidence fields including `post.caption`.
- `mediaFreeDto()` — a schema-valid DTO carrying **none of the optional media-backed
  evidence**: `postCount: 0`, `evidenceFields: ['post.caption']` only, a wide
  `candidateRange: { min: 4, max: 1200 }` to also exercise 4-digit overflow. All four signals,
  the persona, and the range are still present, because the contract requires them.

  This fixture proves the **component** has no media dependency. It is not a claim about
  backend reachability, and the first draft of this line — "the shape a preflight target with
  no posts and no profile picture still produces" — was wrong:
  `lib/services/precheckout/blite-inference.ts` returns `null` for a digest with
  `postCount === 0`, so no such DTO reaches the UI today. See the 2026-09-01 follow-up.

Render with `createRoot` + `act`, mirroring the harness already used in
`components/precheckout-immersive.test.tsx` (no new test dependency).

- [x] **Step 2: Add the inclusion tests (must fail: module does not exist yet).**

```
it('renders the target handle, persona, and all four signal claims and categories')
it('renders every signal confidence as a two-decimal number')
it('renders the candidate range as min~max명 in the accessible reading')
it('calls onContinue exactly once when the 상세 분석 보기 CTA is clicked')
it('falls back to 판독 대상 when no target username is supplied')
it('blocks persona and claim text from session replay with data-amp-block')
```

The `data-amp-block` test asserts the marker is present on the persona headline, the persona
summary, and each of the four claims — this is a privacy contract, not styling.

- [x] **Step 3: Add the exclusion tests (the four user rejections).**

```
it('never renders case-file metadata: no CASE slug, no 표본, no 1차 판독 line, no postCount')
it('never renders a qualitative confidence label (신뢰도 높음/보통/낮음, 표본 부족)')
it('renders at most one eyebrow and no 공개 피드 신호 header')
it('draws no shared axis or spectrum: no 0.50/1.00 scale ticks, no 고신뢰 band, no derived stats')
```

Concretely: `textContent` must not match `/CASE|표본|1차 판독|신뢰도 (높음|보통|낮음)|공개 피드 신호|평균 신뢰도|고신뢰/`,
must not contain the raw `postCount` rendered as `47개`/`47건`, and `.eyebrow` elements must
number exactly one.

- [x] **Step 4: Add the structural and media-free tests.**

```
it('spends the bracket budget once: exactly one data-precheckout-result-card on the screen')
it('renders a complete screen for a DTO with no post- or profile-picture-backed data')
it('renders no img, svg chart, canvas, or empty figure placeholder')
```

The media-free test asserts, on `mediaFreeDto()`, that all four claims, the persona, the
range, and the CTA are present, that `container.querySelectorAll('img')` is empty, and that
no element is an empty visualization shell.

- [x] **Step 5: Run the suite and confirm every test fails with "module not found".**

```bash
npx vitest run components/blite-result.test.tsx
```

Failing for the right reason means the import of `./blite-result` cannot resolve — not an
assertion mismatch against some other component.

---

## Task 2: Implement the extracted result screen

**Files:**

- Create: `components/blite-result.tsx`
- Modify: `components/precheckout-immersive.tsx`

- [x] **Step 1: Create `components/blite-result.tsx` with the layout from the design spec.**

Order: root `<section data-precheckout-result>` → subject masthead → persona lead → evidence
ledger `<ol>` → single bracketed verdict `CaseCard`. No footnote. Reuse `CaseCard`, `Eyebrow`,
and `PrimaryButton` from `components/case-ui`; reuse `.eyebrow`, `.label-ko`, `.num`,
`.reveal`, `.reveal-rail`, `.meter-fill` from `app/globals.css`. Add no new global CSS — with
the single later exception recorded in §File structure and boundaries: the reduced-motion
`animation-delay` reset, which is a correction to an existing rule rather than new styling.

Keep `SIGNAL_BAND_BAR_COLOR` (colour encoding survives) and delete `SIGNAL_BAND_LABEL`
(text labels do not).

The confidence rule uses the existing `.meter-fill` contract:

```tsx
<span
    className="absolute inset-y-0 left-0 meter-fill"
    style={{ '--meter-width': `${signal.confidence * 100}%`, background: SIGNAL_BAND_BAR_COLOR[signal.band], animationDelay: `${...}ms` } as CSSProperties}
/>
```

The caliper is `aria-hidden`, sitting under a visible `.label-ko` `분석 후보 예상 범위`
with an `sr-only` sibling carrying `{min}~{max}명`. The label is not repeated in the
`sr-only` node, so the reading is assembled once for a screen reader rather than announced
twice.

- [x] **Step 2: Point the parent at the extracted component.**

Delete the inline `BliteResultScreen` function and the `SIGNAL_BAND_LABEL` /
`SIGNAL_BAND_BAR_COLOR` constants from `components/precheckout-immersive.tsx`, and import
`BliteResultScreen` from `@/components/blite-result`. The `view === 'result' && dto` branch,
its `onContinue` body, and every analytics call stay byte-identical.

- [x] **Step 3: Run the focused suite until green.**

```bash
npx vitest run components/blite-result.test.tsx
```

---

## Task 3: Keep the parent's behaviour suite honest

**Files:**

- Modify: `components/precheckout-immersive.test.tsx`

- [x] **Step 1: Replace card-count assertions with the presence hook.**

`expect(container.querySelectorAll('[data-precheckout-result-card]')).toHaveLength(4)` becomes
`expect(container.querySelector('[data-precheckout-result]')).not.toBeNull()` at every site
(lines around 219, 502, 538, 568, 715, 783). The `toBeNull()` assertions that mean "no result
is showing" keep working unchanged, because the single verdict card still carries
`data-precheckout-result-card`.

- [x] **Step 2: Update the one copy assertion the redesign changes.**

The `renders the candidate range with a tilde…` test asserts
`toContain('최근 게시물들에서 확인한 패턴')` — that caption belonged to the removed
`공개 피드 신호` header. Replace it with an assertion that the caption is **gone**, keeping the
tilde-format and no-`47개` assertions as they are. This test now guards the rejection instead
of the removed copy.

- [x] **Step 3: Run the whole precheckout suite.**

```bash
npx vitest run components/precheckout-immersive.test.tsx components/precheckout-demo.test.tsx components/blite-result.test.tsx
```

Every gating, deadline, gender-confirmation, fallback, caching, and analytics test must pass
without being edited beyond Steps 1–2.

---

## Task 3b: One eyebrow across the whole screen (added after the first visual review)

The component-local eyebrow count was one, but the rendered screen showed two: `/analyze`'s
heading renders `판독 의뢰서 · 대상 확인` through the same `Eyebrow` primitive directly above
the sheet.

**Files:** Modify `components/precheckout-immersive.tsx`, `app/analyze/page.tsx`,
`components/precheckout-immersive.test.tsx`, `app/analyze/page.test.ts`,
`components/blite-result.test.tsx`

- [x] **Step 1: Test first.** In the immersive suite, assert `onBliteResultShown` fires once on
  the result state and never on the fallback; in the page source contract, assert the eyebrow is
  gated and the flag is reset on target reset; in the component suite, assert the sheet itself
  never renders `판독 의뢰서`.
- [x] **Step 2:** Add `onBliteResultShown?: () => void` to `PrecheckoutImmersive`, fired from the
  existing result-view effect.
- [x] **Step 3:** In `/analyze`, hold `bliteResultShown` state, render the `Eyebrow` only when it
  is false, drop the heading's `mt-3` in that case, and reset the flag in `handleReset`.
- [x] **Step 4: Ref-guard the one shot.** The announcement shares an effect with
  `BLITE_RESULT_VIEWED` and now depends on a caller-supplied callback. Guard it with a ref inside
  the component so it fires once for any caller, and wrap the page's handler in `useCallback`.
  Prove the guard: the test must fail (3 calls) with the ref removed.

---

## Task 4: Repository verification

- [x] **Step 1:** `npx tsc --noEmit`
- [x] **Step 2:** `npm run lint`
- [x] **Step 3:** `npm run test` (full suite; confirm no unrelated regression)
- [x] **Step 4:** `npm run build` — see §Verification record, which records the plain run and
  the placeholder-public-env run as two separate results. The plain run's failure is a missing
  build-time public env var in this worktree, not a defect in the change.

---

## Task 5: Real visual verification

**Files:**

- Create (evidence, not committed unless repo convention requires it):
  `reports/blite-result-a-hybrid-20260831/*.png`

- [x] **Step 1:** Build a deterministic static harness that mounts the real component with
  fixture data at mobile (390×844) and desktop (1280×900) widths, plus the media-free DTO and
  a long-claim/4-digit-range stress fixture. Use the project's real `app/globals.css` and
  Paperlogy fonts so what is captured is what ships.
- [x] **Step 2:** Screenshot each case with Playwright/Chrome DevTools MCP.
- [x] **Step 3:** Check and record: horizontal overflow at 320/390/1280, reading order and
  hierarchy, the CTA's `:focus-visible` ring, `prefers-reduced-motion: reduce` rendering the
  final frame with every measure at full width, and the media-free screen having no blank
  frame.

  **This step's reduced-motion check was written wrong and passed wrongly.** "Rendering the
  final frame" is only true once every `animation-delay` has elapsed, and the step never said
  *when* to sample. It was sampled late, so it confirmed the end state and missed the delay
  window entirely. The correct check is stated in the follow-up, §2: with `both` fill and a
  non-zero delay, the element holds its *from*-state — invisible, or a measure at zero width —
  for the whole delay, so the reduced-motion screen has to be sampled at first paint, not after
  it settles.

---

## Task 6: Commit

- [x] Commit exactly these **8** owned paths — 6 code/test plus 2 docs. The first draft of
  this list said "and the two docs" after four files and then called it six, which silently
  dropped the `/analyze` pair; those two are not optional, because the result-state eyebrow
  handoff (Task 3b) is only complete with the page holding `bliteResultShown` and its source
  contract asserting it.

  1. `components/blite-result.tsx`
  2. `components/blite-result.test.tsx`
  3. `components/precheckout-immersive.tsx`
  4. `components/precheckout-immersive.test.tsx`
  5. `app/analyze/page.tsx`
  6. `app/analyze/page.test.ts`
  7. `docs/superpowers/specs/2026-08-31-blite-result-a-hybrid-design.md`
  8. `docs/superpowers/plans/2026-08-31-blite-result-a-hybrid.md`

  Never `git add -A`; stage by explicit path so concurrent workers' edits are untouched.
  Nothing else is staged — `package-lock.json` stays unstaged, and `.playwright-mcp/` and
  `reports/` stay untracked. No push, no deploy, no migration.

---

## Self-review against the brief

- **Rejected metadata** → Task 1 Step 3 test 1.
- **Qualitative confidence labels** → Task 1 Step 3 test 2 + deletion in Task 2 Step 1.
- **Decorative signal header / excess eyebrows** → Task 1 Step 3 test 3 + Task 3 Step 2.
- **Shared-axis / spectrum UI** → Task 1 Step 3 test 4.
- **All real signals, categories, numeric confidence, candidate range** → Task 1 Step 2.
- **CTA / analytics behaviour** → Task 1 Step 2 (CTA callback) + Task 3 (parent suite intact).
- **Media-free DTO renders complete, no empty visualization** → Task 1 Step 4.
- **Smallest coherent structure** → one new prop-only component; parent logic untouched.
- **Ownership** → only the eight paths listed in Task 6 (6 code/test + 2 docs);
  explicit-path staging, nothing else added to the index.

---

## Verification record — 2026-08-31 (finalization pass)

Run in `/Users/youngminpark/orca/workspaces/yeosachin_scanner/blite-result-a-hybrid` on branch
`0mininseoul/blite-result-a-hybrid`. Commands and their actual results, not paraphrases.

### Focused suites — pass

```
npx vitest run components/blite-result.test.tsx components/precheckout-immersive.test.tsx \
  components/precheckout-demo.test.tsx app/analyze/page.test.ts
→ Test Files 4 passed (4) · Tests 60 passed (60)
```

### The ref guard is load-bearing — proved, then restored

Task 3b Step 4 asks for the guard to be *proved*, not asserted. With
`|| resultAnnouncedRef.current` temporarily removed from the result effect in
`components/precheckout-immersive.tsx`:

```
npx vitest run components/precheckout-immersive.test.tsx \
  -t "tells the page the result sheet is on screen"
→ AssertionError: expected "spy" to be called once, but got 3 times
```

Three calls, exactly the failure the plan predicted. The guard was restored immediately and
the file is byte-identical to the committed version.

### Typecheck, lint, full suite — pass

```
npx tsc --noEmit          → exit 0, no diagnostics
npm run lint              → exit 0, no findings
npm run test              → Test Files 717 passed | 1 skipped (718)
                            Tests 7597 passed | 48 skipped (7645)
```

**Bounded note on the 48 skipped tests.** None of them are Docker-dependent and none touch
this change. They are opt-in suites that self-skip unless an environment variable names a
disposable target: the Postgres concurrency/migration integration suites require a
`*_TEST_URL` plus a destructive-test marker naming a local ephemeral database, and
`web-client.smoke.test.ts` requires `RUN_SMOKE=1`. Docker is in fact available in this
environment (`docker info` → exit 0); these suites were still not opted into, because
provisioning a destructive database target is outside this change's scope and unrelated to a
presentational component. Skipped-by-design, not skipped-by-failure.

### Production build — two separate results

**1. Plain `npm run build` — fails on missing build-time public env vars, not on this change.**

```
npm run build → exit 1
Error: @supabase/ssr: Your project's URL and API key are required to create a Supabase client!
Export encountered an error on /betatest/page: /betatest, exiting the build.
Error occurred prerendering page "/_not-found".
```

The worktree carries no `.env.local` (only `.env.example`), so
`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` are unset and every prerendered
page that constructs a Supabase client throws at export time. This is the environment's
missing configuration reproducing on `/betatest` and `/_not-found` — routes this change does
not touch — and is recorded as its own result rather than folded into the successful one.

**2. Same build with placeholder *public* values — passes.**

```
NEXT_PUBLIC_SUPABASE_URL="https://placeholder.supabase.co" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="placeholder-anon-key" \
npm run build
→ ✓ Compiled successfully in 18.3s
→ exit 0
```

Placeholders only, both of them public build-time values; no secret, no service-role key, and
no network call to any Supabase project. The route manifest lists `○ /analyze` and contains
zero occurrences of `blite-preview-tmp`, which is the build-level confirmation that the
temporary visual-verification route is gone.

### Rejections confirmed at the source, not only in tests

```
grep -rn "SIGNAL_BAND_LABEL" --include=*.ts --include=*.tsx .   → no match (map deleted)
grep -n "postCount" components/blite-result.tsx components/precheckout-immersive.tsx
                                                                → no match (still unrendered)
components/blite-result.tsx: one <Eyebrow>, one .label-ko
app/: no blite-preview-tmp route, and no other temporary harness
```

### Visual verification — carried over, not re-run

Task 5's browser pass was executed in the implementation session against the temporary
`/blite-preview-tmp` route; its measured results are recorded in
`docs/superpowers/specs/2026-08-31-blite-result-a-hybrid-design.md` §Verification record
(overflow at 320/390/1280, eyebrow and bracket budgets, zero media elements inside the sheet,
every measure bound to its own confidence, CTA focus ring — and a reduced-motion reading that
was sampled after the delays had elapsed and is therefore superseded by §2 of the follow-up).
It was
**not** re-run in this finalization pass, because the route it depended on has since been
deleted and re-creating it would reintroduce exactly the temporary artifact this pass is
meant to confirm is gone. The screenshots remain at
`reports/blite-result-a-hybrid-20260831/*.png`.

### What is deliberately not committed

- `reports/blite-result-a-hybrid-20260831/*.png` — evidence only. Tracked `reports/` holds
  `.md` and `.json` and no binaries at all, so there is no repository convention that would
  require committing screenshots. Left untracked.
- `.playwright-mcp/` — user-owned browser session logs, untouched and left untracked.
- `package-lock.json` — a one-line `devOptional` flag change from a local `npm install`.
  Setup noise, not part of this change; left unstaged and uncommitted.

---

## Follow-up — 2026-09-01: the first-paint double-eyebrow flash

Shipped, then found on arrival: the withdrawal was announced from a **passive** effect, which
React flushes only after handing the commit that mounts the sheet back to the browser. For one
frame the page's heading eyebrow and the sheet's own `관계 판독 범위` eyebrow were both on
screen — the two-eyebrow state this design exists to prevent, surviving as a flash.

**Fix (safe and minimal).** In `components/precheckout-immersive.tsx`, split the one effect in
two:

- `useLayoutEffect` — `onBliteResultShown?.()` only, still `resultAnnouncedRef`-guarded. Layout
  effects run before the commit is handed to the browser, and the parent state update this
  schedules is flushed in the same pass, so the withdrawal is never a frame late.
- `useEffect` — `BLITE_RESULT_VIEWED` only, guarded by a new `resultViewedRef`. Analytics keeps
  its passive timing and its own exactly-once guard, so nothing about the event changed and no
  Amplitude call moved onto the pre-paint path.

Nothing else was touched: no markup, no copy, no design exclusion, no CTA/gender/fallback path,
no `data-amp` masking, no DTO or analytics vocabulary.

**Why the test is a source contract, not a render.** The first two attempts were render-based
and both were wrong for the same reason. jsdom cannot observe a paint, and `act()` makes it
worse: it drains layout effects, passive effects, and the resulting re-render into one
synchronous flush. Instrumenting a timeline (announcement, analytics, and a `MutationObserver`
delivery, each sampling the DOM) produced **identical output for the fixed and the broken
implementation** — the harness cannot see this bug at all, so a render-based assertion would
have passed on the bug and proved nothing. The contract is therefore asserted against the
component's source, which is the convention `app/analyze/page.test.ts` already uses for its
half of the same handoff. Reverting the layout effect fails that test.

### Verification — 2026-09-01

`node_modules` was empty at the start of this pass (wiped between dispatches), so dependencies
were restored with `npm ci`, which installs from the lockfile and never rewrites it —
`package-lock.json` is byte-identical afterwards (md5 `7d1d879b…` before and after), its
one-line `devOptional` change still unstaged.

```
npx vitest run components/blite-result.test.tsx components/precheckout-immersive.test.tsx \
  components/precheckout-demo.test.tsx app/analyze/page.test.ts
                          → Test Files 4 passed (4) · Tests 61 passed (61)
npx tsc --noEmit          → exit 0, no diagnostics
npm run lint              → exit 0 · 16 pre-existing warnings, 0 errors, none in owned files
npm run test              → Test Files 732 passed | 2 skipped (734)
                            Tests 7746 passed | 75 skipped (7821)
NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… npm run build
                          → ✓ Compiled successfully in 14.4s · exit 0 · ○ /analyze
```

Placeholder public build-time values again, for the same reason as the previous pass: no
`.env.local` in this worktree. No secret, no service-role key, no provider call.

Revert-detection, run both ways: with `useLayoutEffect` restored to `useEffect`, the new test
fails (`expected '\n' to contain 'onBliteResultShown?.();'`); with the fix in place it passes.
The existing exactly-once tests — the callback under a re-rendering parent with a fresh
callback identity, and the fallback path never announcing — pass unchanged.

---

## Follow-up — 2026-09-01: three review blockers

The layout-effect fix earlier the same day closed the first-paint flash and left the passive
exactly-once analytics alone, but review found three defects it did not touch. All three are
now closed, each with a regression that was checked in both directions.

### 1. The withdrawal outlived the sheet

`bliteResultShown` was set true on arrival and cleared only in `handleReset`. The sheet exists
only on a non-legacy surface, so **any** move to the legacy surface unmounted it while the flag
stayed true — and the plan screen, which is not the result sheet, then rendered permanently
without its `판독 의뢰서 · 대상 확인` eyebrow. The result CTA is the ordinary path into that
state: `상세 분석 보기` → `onGoToPlans` → `handleGoToPlans` → `surface: 'legacy'`.

`setBliteResultShown(false)` now runs in `handleGoToPlans` and in the auto-checkout recovery
release — both direct legacy transitions. The state declaration also moved up beside
`precheckoutSurface`, which is what it is actually bound to.

The regression in `app/analyze/page.test.ts` pins the CTA path by name, and then generalises:
**every** `surface: 'legacy'` occurrence in the file must be preceded by the reset, so a fourth
transition cannot reintroduce the bug silently. It also pins that exactly one site sets the flag
true. Removing the reset from `handleGoToPlans` fails it.

### 2. Reduced motion was hiding content, not motion

`@media (prefers-reduced-motion: reduce)` collapsed `animation-duration` to `0.001ms` but left
`animation-delay` alone. `.reveal`, `.reveal-rail` and `.meter-fill` all animate with `both`, so
the from-state — `opacity: 0`, `scaleY(0)`, `width: 0` — is held for the entire delay. With the
sheet's stagger (ledger rows to 330ms, measures to 500ms, the verdict card at 420ms), a reader
who asked for less motion got blank rows and empty measures that popped in up to half a second
late. The previous verification recorded "the final frame with no movement" because the
screenshot was taken after the delays had already elapsed; it measured the wrong instant.

`app/globals.css` now zeroes `animation-delay` for `.reveal`, `.reveal-rail`, `.reveal-wipe`,
`.reveal-sweep` and `.meter-fill` inside that media query. `!important` is required and not
incidental: the delays are inline styles, and an important author declaration is the only thing
that outranks one. `components/blite-result.tsx` documents the coupling at its delay constants.

The regression reads both files: it extracts every `reveal*`/`meter-fill` class the component
actually uses and asserts each is named in the reset, so a new staggered class cannot be added
without covering it. Dropping `.meter-fill` from the rule fails it.

### 3. The verdict copy claimed a source the sheet cannot always have

`공개 피드와 계정 규모를 바탕으로 한 1차 범위예요` names public posts and account scale as the
evidence behind the number, on a screen deliberately built to stand up with no media-backed
field. It now reads `이번 판독에서 확인한 내용을 바탕으로 좁힌 1차 범위예요` — source-agnostic,
and true of every DTO the sheet renders. The second sentence is untouched, as is `1차 범위`
(the rejected string was `1차 판독`, which still appears nowhere).

The regression asserts the new sentence on both fixtures and sweeps the screen's **static** copy
— persona and signal text excluded, since those are model output about the target rather than
the screen's own provenance statement — for `공개 피드`, `게시물`, `프로필 사진`, `팔로워` and
`계정 규모`.

### 3b. The media-free claim was overstated, and is now scoped

`lib/services/precheckout/blite-inference.ts` returns `null` when the digest has
`postCount === 0`, so the backend produces no B-lite DTO at all for a zero-post target. The
fixture comment ("the shape a preflight target with no posts and no profile picture still
produces"), the component docstring, and the spec's "A DTO whose target has no media renders
exactly the same complete screen" all asserted a reachability that does not exist.

All three now say what is actually true: the guard is **component-level**. A schema-valid DTO
with `postCount: 0` renders the same complete screen, which stops the component acquiring a
media dependency the contract never promised. No test or doc claims the zero-post path is
reachable end to end.

### Scope held

No shared-axis or spectrum graph, no case-file header, no confidence badge, no new eyebrow: the
sheet still carries exactly one `Eyebrow` and one `.label-ko`, one bracketed card, and the four
rejections' tests are unchanged and green. Blocker 3 changed one sentence of copy; blockers 1
and 2 changed no markup at all.

### Verification — 2026-09-01 (blocker pass)

```
npx vitest run components/blite-result.test.tsx components/precheckout-immersive.test.tsx \
  components/precheckout-demo.test.tsx app/analyze/page.test.ts
                          → Test Files 4 passed (4) · Tests 64 passed (64)
npx tsc --noEmit          → exit 0, no diagnostics
npm run lint              → exit 0 · 16 pre-existing warnings, 0 errors, none in owned files
npm run test              → Test Files 732 passed | 2 skipped (734)
                            Tests 7749 passed | 75 skipped (7824)
NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… npm run build
                          → ✓ Compiled successfully in 8.1s · exit 0 · ○ /analyze
```

Each regression was run both ways rather than only green:

| Regression | Broken how | Failure |
| --- | --- | --- |
| CTA → legacy | reset removed from `handleGoToPlans` | `expected 'const handleGoToPlans = useCallback((…' to contain 'setBliteResultShown(false);'` |
| Reduced motion | `.meter-fill` dropped from the reset | `expected '@media (prefers-reduced-motion: reduc…' to contain '.meter-fill'` |

Placeholder **public** build-time values again — no `.env.local` in this worktree. No secret, no
service-role key, no provider call. `package-lock.json`, `.playwright-mcp/` and `reports/` were
not read, edited, staged, or deleted.
