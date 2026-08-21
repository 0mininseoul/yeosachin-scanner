# Precheckout immersive UX hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every visible precheckout entry play the complete S1 → S2 → S3 → S4 sequence before a B-lite or fallback outcome, restore only the high-confidence gender confirmation gate, and return the post-CTA legacy screen to its top.

**Architecture:** Preserve the accepted preflight timestamp as the durable B-lite deadline clock, but create one mount-local visible-entry timestamp for the presentation clock. `PrecheckoutImmersive` will use that local time for graph playback, transition boundaries, and demo-duration analytics; its result view becomes a small state machine that branches to the restored confirmation screen only for a likely-female DTO at the shared threshold. `AnalyzePage` continues to own the one explicit release from `awaiting` to `legacy`, then performs exactly one non-smooth viewport reset after that legacy surface commits.

**Tech Stack:** Next.js 16 App Router, React 19 hooks, TypeScript, Vitest 3 with jsdom, existing precheckout B-lite DTO/analytics contracts.

---

## File structure and boundaries

- `components/precheckout-immersive.tsx` — Own the two clock domains, graph-bound outcome settlement, conditional gender-confirmation/result/fallback view state, and only the existing precheckout analytics vocabulary. Do not change the B-lite API, DTO schema, polling cache, deadline policy, provider work, or checkout admission behavior.
- `components/precheckout-immersive.test.tsx` — Drive the component with fake wall and animation-frame clocks; protect fresh visible entries, deadline grace, confirmation/rejection behavior, fixed copy, CTA gating, caching, and existing error/fallback behavior.
- `components/precheckout-demo.tsx` and `components/precheckout-demo.test.tsx` — Leave production code unchanged. The latter remains the direct contract for the four-stage graph timing/order; run it with the focused suite so the new parent clock does not regress the player.
- `app/analyze/page.tsx` — Replace the deferred plan-section scrolling effect with a one-shot top reset tied only to the explicit immersive CTA release; remove plan-section/plan-heading refs and their focus behavior.
- `app/analyze/page.test.ts` — Keep the existing page-flow source-contract assertions and add an isolated, importable viewport-reset assertion plus source assertions that forbid plan scrolling and readiness-triggered scrolling.

No migrations, endpoints, DTO/API changes, provider calls, browser storage, landing-page copy, checkout selection, login action, or analytics schema changes are part of this hotfix.

### Task 1: Lock the presentation-clock and result-gate regressions with component tests

**Files:**

- Modify: `components/precheckout-immersive.test.tsx`
- Verify only: `components/precheckout-demo.test.tsx`

- [ ] **Step 1: Make the component test drive both wall time and the graph animation frame.**

Replace the passive `requestAnimationFrame` stub in the suite setup with the same controllable pattern already used by `components/precheckout-demo.test.tsx`. This lets the test assert the announced S1, S2, S3, and S4 labels instead of inferring graph order from a timeout.

```ts
let rafCallback: FrameRequestCallback | null;
let monotonicTimeMs: number;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SUBMITTED_AT));
    monotonicTimeMs = Date.parse(SUBMITTED_AT);
    vi.spyOn(performance, 'now').mockImplementation(() => monotonicTimeMs);
    rafCallback = null;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
        rafCallback = callback;
        return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    // Keep the existing matchMedia/container/root setup.
});

async function paintAt(epochMs: number) {
    await act(async () => {
        vi.setSystemTime(epochMs);
        monotonicTimeMs = epochMs;
        rafCallback?.(monotonicTimeMs);
    });
}
```

- [ ] **Step 2: Add the failing visible-entry, cached-result, and deadline-grace tests.**

Extend `completeStatus` so it accepts a DTO, then add the following tests. Use a `submittedAtMs` that is already beyond `BLITE_UX_DEADLINE_MS` for the first test; this proves the durable deadline is latched while the new visible sequence is still allowed to finish.

```ts
it('starts every stale accepted preflight at S1 and reaches S2, S3, and S4 before fallback', async () => {
    const visibleEntryAtMs = Date.parse(SUBMITTED_AT) + BLITE_UX_DEADLINE_MS + 1;
    vi.setSystemTime(visibleEntryAtMs);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noBody()));

    await act(async () => {
        root.render(createElement(StrictMode, null, createElement(PrecheckoutImmersive, {
            preflightId: PREFLIGHT_ID,
            claimToken: null,
            submittedAtMs: Date.parse(SUBMITTED_AT),
            targetUsername: 'target',
            onGoToPlans: vi.fn(),
        })));
    });
    await settleUi();

    const status = () => container.querySelector('[role="status"]')?.textContent ?? '';
    expect(status()).toContain('1/4');
    await paintAt(visibleEntryAtMs + 2_600);
    expect(status()).toContain('2/4');
    await paintAt(visibleEntryAtMs + 5_300);
    expect(status()).toContain('3/4');
    await paintAt(visibleEntryAtMs + 7_800);
    expect(status()).toContain('4/4');
    await advance(4_199);
    expect(container.querySelector('[data-precheckout-fallback]')).toBeNull();
    await advance(1);
    expect(container.querySelector('[data-precheckout-fallback]')).not.toBeNull();
});

it('gives a cached complete DTO a fresh 12-second visible pass after remount', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completeStatus()));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
        root.render(createElement(PrecheckoutImmersive, {
            preflightId: PREFLIGHT_ID, claimToken: 'claim-token',
            submittedAtMs: Date.parse(SUBMITTED_AT), targetUsername: 'target', onGoToPlans: vi.fn(),
        }));
    });
    await settleUi();
    act(() => root.unmount());
    root = createRoot(container);
    vi.setSystemTime(Date.parse(SUBMITTED_AT) + 3_000);
    await act(async () => {
        root.render(createElement(PrecheckoutImmersive, {
            preflightId: PREFLIGHT_ID, claimToken: 'claim-token',
            submittedAtMs: Date.parse(SUBMITTED_AT), targetUsername: 'target', onGoToPlans: vi.fn(),
        }));
    });
    await settleUi();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('1/4');
    await advance(11_999);
    expect(container.querySelector('[data-precheckout-result-card]')).toBeNull();
    await advance(1);
    expect(container.querySelector('[data-precheckout-result-card]')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
});
```

Keep the existing terminal, malformed/transient, runtime-error, slow-loop, and request-cache tests, but update any old assertion that expects an expiry to interrupt an initial visible pass. A late deadline now latches the fallback immediately and stops polling, but reveals it only at the next boundary calculated from the fresh visible-entry timestamp.

- [ ] **Step 3: Add the failing gender and copy coverage.**

Add a DTO helper that only overrides the existing fixture fields, so every case remains schema-valid. Cover the threshold inclusively, below-threshold direct result, the affirmative/rejected paths, no ordinary gender card, and both required copy changes.

```ts
function dtoWithGenderRead(likelyFemale: boolean, confidence: number) {
    return {
        ...validDto(),
        candidateRange: { min: 34, max: 80 },
        postCount: 8,
        genderRead: {
            likelyFemale,
            confidence,
            reasons: ['첫 번째 확인 근거예요.', '두 번째 확인 근거예요.', '세 번째 확인 근거예요.'],
        },
    };
}

it('shows confirmation at the shared 0.70 threshold, then shows the normal result only after 예', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
        completeStatus(dtoWithGenderRead(true, 0.70)),
    )));
    const onGoToPlans = vi.fn();
    await renderAndFinishInitialPass({ onGoToPlans });

    expect(container.textContent).toContain('이 계정의 인물이 남자가 맞나요?');
    expect(container.textContent).toContain('첫 번째 확인 근거예요.');
    expect(container.querySelector('[data-precheckout-result-card]')).toBeNull();
    expect(onGoToPlans).not.toHaveBeenCalled();
    clickButton(container, '예');
    expect(container.textContent).toContain('분석 후보 예상 범위 34~80명');
    expect(analyticsMocks.trackPrecheckoutEvent).toHaveBeenCalledWith(
        'precheckout_blite_gender_confirmation_completed', PREFLIGHT_ID,
        { gender_confirmation_outcome: 'confirmed' },
    );
});

it('bypasses confirmation below the shared threshold and never renders a normal gender summary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
        completeStatus(dtoWithGenderRead(true, 0.69)),
    )));
    await renderAndFinishInitialPass();

    expect(container.textContent).not.toContain('이 계정의 인물이 남자가 맞나요?');
    expect(container.textContent).not.toContain('성별 판독 요약');
    expect(container.textContent).not.toContain('신뢰도 0.69');
    expect(container.textContent).toContain('최근 게시물들에서 확인한 패턴');
    expect(container.textContent).not.toContain('최근 공개 게시물 8개');
    expect(container.textContent).toContain('분석 후보 예상 범위 34~80명');
    expect(container.textContent).not.toContain('34 – 80명');
});

it('keeps a rejected confirmation on a neutral CTA and reports result mode only when that CTA is clicked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
        completeStatus(dtoWithGenderRead(true, 0.70)),
    )));
    const onGoToPlans = vi.fn();
    await renderAndFinishInitialPass({ onGoToPlans });
    clickButton(container, '아니오');

    expect(container.querySelector('[data-precheckout-fallback]')).not.toBeNull();
    expect(onGoToPlans).not.toHaveBeenCalled();
    expect(analyticsMocks.trackPrecheckoutEvent).toHaveBeenCalledWith(
        'precheckout_blite_gender_confirmation_completed', PREFLIGHT_ID,
        { gender_confirmation_outcome: 'rejected' },
    );
    expect(analyticsMocks.trackPrecheckoutEvent).not.toHaveBeenCalledWith(
        'precheckout_blite_fallback_selected', PREFLIGHT_ID, expect.anything(),
    );
    clickButton(container, '상세 분석 보기');
    expect(onGoToPlans).toHaveBeenCalledOnce();
    expect(analyticsMocks.trackPrecheckoutEvent).toHaveBeenCalledWith(
        'precheckout_plan_gate_reached', PREFLIGHT_ID, { demo_mode: 'result' },
    );
});
```

Define `renderAndFinishInitialPass` in this test file as a fixture-local helper that renders the normal valid props, awaits `settleUi()`, calls `advance(PRECHECKOUT_DEMO_DURATION_MS)`, and then awaits `settleUi()`. Import `PRECHECKOUT_DEMO_DURATION_MS` from `./precheckout-demo` (or its existing stage-graph source) rather than restating `12_000` in this helper. Retain a normal-result CTA test and change its result-card expectation from five to four cards.

- [ ] **Step 4: Run the focused tests and confirm RED.**

Run:

```bash
npm test -- components/precheckout-immersive.test.tsx
```

Expected: FAIL because the current component derives its graph clock and analytics duration from `submittedAtMs`, force-settles a deadline fallback, has no `GenderConfirmScreen`, still renders the ordinary gender card, still renders the post count and spaced en dash range, and reports rejected fallback CTA mode as `fallback`.

### Task 2: Implement the two-clock immersive state machine and presentation-only copy update

**Files:**

- Modify: `components/precheckout-immersive.tsx`
- Test: `components/precheckout-immersive.test.tsx`

- [ ] **Step 1: Split the durable deadline clock from the visible-entry presentation clock.**

Import the existing shared threshold and expand the local view union. Compute the accepted timestamp solely for the deadline (falling back to the local timestamp only when the optional prop is invalid), and create the local value once per component mount.

```ts
import {
    PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD,
    precheckoutBliteV1Schema,
    type PrecheckoutBliteSignalBand,
    type PrecheckoutBliteV1,
} from '@/lib/services/precheckout/blite-contract';

type ImmersiveView = 'demo' | 'gender-confirm' | 'result' | 'fallback';

function needsGenderConfirmation(dto: PrecheckoutBliteV1): boolean {
    return dto.genderRead.likelyFemale === true
        && dto.genderRead.confidence >= PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD;
}

const [visibleEntryAtMs] = useState(() => Date.now());
const acceptedPreflightAtMs = isValidEpoch(submittedAtMs)
    ? submittedAtMs
    : visibleEntryAtMs;
const deadlineAtMs = acceptedPreflightAtMs + BLITE_UX_DEADLINE_MS;
```

Replace each presentation use of the old `startedAtMs` with `visibleEntryAtMs`:

```ts
duration_ms: boundedDemoDurationMs(visibleEntryAtMs, Date.now()),
const targetAtMs = nextGraphTransitionAt(visibleEntryAtMs, Date.now());

<PrecheckoutDemo
    mode="waiting"
    startedAtMs={visibleEntryAtMs}
    finishRequested={exit !== null}
    onComplete={handleDemoComplete}
    onError={handleDemoError}
/>
```

Do not change the status cache, status parser, fetch endpoint, polling retry policy, `BLITE_UX_DEADLINE_MS`, or `deadlineAtMs` polling cut-off. The deadline timer and `Date.now() >= deadlineAtMs` branch must still latch `exitRef` to `fallback` and prevent more polling; remove `forceImmediate` from `requestExit` and make every exit settle through `nextGraphTransitionAt(visibleEntryAtMs, Date.now())`. That gives a stale accepted preflight the bounded initial 12-second display grace without extending durable work or issuing another request.

- [ ] **Step 2: Reveal the correct post-demo screen and restore only the high-confidence confirmation.**

Make `finishExit` choose its post-demo view once, using the parsed DTO retained in `dtoRef`. Continue to emit `DEMO_COMPLETED` exactly once with the existing `result`/`fallback` vocabulary.

```ts
const finishExit = useCallback((finalExit: DemoExit) => {
    if (settledExitRef.current) return;
    settledExitRef.current = true;
    emitPrecheckoutEvent(PRECHECKOUT_EVENTS.DEMO_COMPLETED, {
        demo_mode: finalExit === 'result' ? 'result' : 'fallback',
        duration_ms: boundedDemoDurationMs(visibleEntryAtMs, Date.now()),
    });
    const nextView: ImmersiveView = finalExit === 'result' && dtoRef.current
        ? needsGenderConfirmation(dtoRef.current) ? 'gender-confirm' : 'result'
        : 'fallback';
    setView(nextView);
}, [emitPrecheckoutEvent, visibleEntryAtMs]);
```

Reintroduce the previously approved `GenderConfirmScreen` immediately before `BliteResultScreen`, preserving its three reasons and `예`/`아니오` controls. Render it only for `view === 'gender-confirm' && dto` and wire its callbacks exactly as follows:

```tsx
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
        setView('fallback');
    }}
/>
```

The rejected path must not call `requestExit`, `onGoToPlans`, or `BLITE_FALLBACK_SELECTED`: it is a user decision after a valid result, not a timeout. Parameterize the fallback CTA's `PLAN_GATE_REACHED` property from the settled exit so the ordinary fallback reports `{ demo_mode: 'fallback' }` but the rejection CTA reports `{ demo_mode: 'result' }`:

```tsx
return <FallbackScreen onContinue={() => {
    emitPrecheckoutEvent(PRECHECKOUT_EVENTS.PLAN_GATE_REACHED, {
        demo_mode: exit === 'result' ? 'result' : 'fallback',
    });
    onGoToPlans();
}} />;
```

Keep the existing result CTA's preview-click event and result-mode plan-gate event. Keep `BLITE_RESULT_VIEWED` tied only to the real `result` view, so a confirmation screen and a rejection do not count as a normal result view.

- [ ] **Step 3: Remove normal gender rendering and apply the exact two copy substitutions.**

Delete the entire ordinary `성별 판독 요약` `CaseCard` from `BliteResultScreen`; do not remove `genderRead` or `postCount` from `PrecheckoutBliteV1`, its parser, API payload, inference, or database storage. Replace only the following render strings:

```tsx
<p className="mt-2 text-[12px] text-fg-dim">최근 게시물들에서 확인한 패턴</p>

<p className="num mt-2 text-[18px] font-extrabold text-fg">
    분석 후보 예상 범위 {dto.candidateRange.min}~{dto.candidateRange.max}명
</p>
```

The tilde is the literal ASCII `~` with no surrounding spaces. Do not change target/persona/signal/range/CTA content other than these two required presentation strings.

- [ ] **Step 4: Run the component regression suite and confirm GREEN.**

Run:

```bash
npm test -- components/precheckout-immersive.test.tsx
```

Expected: PASS. Fresh mounts, remounts, StrictMode replay, and reload-like cached DTO use all announce S1 before S2/S3/S4; a valid DTO waits for the fresh initial pass; an expired durable deadline latches but does not cut that pass short; only the inclusive high-confidence female case sees confirmation; rejection stays behind a neutral CTA with result demo mode; normal result has four cards, no gender summary, no exact post count, and `34~80명`.

- [ ] **Step 5: Commit the component change.**

```bash
git add components/precheckout-immersive.tsx components/precheckout-immersive.test.tsx
git commit -m "fix: reset precheckout immersive presentation clock"
```

### Task 3: Reset the released legacy screen to its top without readiness scrolling

**Files:**

- Modify: `app/analyze/page.tsx`
- Modify: `app/analyze/page.test.ts`

- [ ] **Step 1: Add the failing viewport-reset contract in the page test.**

Keep `app/analyze/page.test.ts` as a lightweight page-boundary test, but make its environment jsdom and import a narrow exported reset function from the page module. The test starts at a nonzero scroll position, checks the exact non-smooth top call, then verifies the source has no plan-section scroll or readiness dependency.

```ts
// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AnalyzePage, { resetPrecheckoutLegacyViewport } from './page';

afterEach(() => vi.unstubAllGlobals());

it('resets the explicit immersive CTA legacy transition to the viewport top without a plan scroll', () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 640 });

    expect(window.scrollY).toBe(640);
    resetPrecheckoutLegacyViewport();
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });

    const page = readFileSync(join(process.cwd(), 'app/analyze/page.tsx'), 'utf8');
    expect(page).not.toContain('scrollIntoView');
    expect(page).not.toContain('planSectionRef');
    expect(page).not.toContain('planHeadingRef');
    expect(page).toContain('resetPrecheckoutLegacyViewport();');
});
```

Do not render `AnalyzePage` in this test: its current test style intentionally isolates the page-flow contract from all preflight/checkout/network dependencies. Remove the unused default import if the test does not render it. Retain the existing `resolveActivePrecheckoutSurface` assertions and add a source assertion that the reset effect depends on `activePrecheckoutSurface`, not `readyPreflight`, so a later pending→ready update cannot cause a second scroll.

- [ ] **Step 2: Run the page test and confirm RED.**

Run:

```bash
npm test -- app/analyze/page.test.ts
```

Expected: FAIL because `resetPrecheckoutLegacyViewport` does not exist and the current page still keeps plan refs and calls smooth `scrollIntoView` only after `readyPreflight`.

- [ ] **Step 3: Replace deferred plan scrolling with the one-shot post-commit top reset.**

Export the narrow browser-only helper above `AnalyzePage`, then replace the two plan refs and their effect. Keep `planGateRequestedRef` because it identifies an explicit immersive CTA rather than a normal render/recovery surface change.

```ts
export function resetPrecheckoutLegacyViewport(): void {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

const planGateRequestedRef = useRef(false);

const handleGoToPlans = useCallback(() => {
    const preflightId = immersivePreflight?.preflightId;
    if (!preflightId) return;
    planGateRequestedRef.current = true;
    setPrecheckoutSurface({ preflightId, surface: 'legacy' });
}, [immersivePreflight?.preflightId]);

useEffect(() => {
    if (!planGateRequestedRef.current || activePrecheckoutSurface !== 'legacy') return;
    planGateRequestedRef.current = false;
    resetPrecheckoutLegacyViewport();
}, [activePrecheckoutSurface]);
```

This effect runs after React commits the first `legacy` surface, whether that surface shows `PreflightPendingStatus` or the ready target/plans. Remove `planSectionRef` and `planHeadingRef`, their JSX `ref`/`tabIndex` usage, the `requestAnimationFrame`, and the `scrollIntoView({ behavior: 'smooth', block: 'start' })` call. Do not move focus to the plan heading; no focus is needed for this handoff, so the requirement to use `preventScroll` if focus is managed is not invoked.

Do not alter `handleGoToPlans` ownership: it remains the sole state transition to `legacy` and must not select a plan, start checkout, invoke login, or reset the viewport for unrelated readiness changes.

- [ ] **Step 4: Run the page test and confirm GREEN.**

Run:

```bash
npm test -- app/analyze/page.test.ts
```

Expected: PASS. The explicit transition emits one `{ top: 0, left: 0, behavior: 'auto' }` call from a nonzero scroll position, no plan heading/section scroll API remains, and readiness has no route to add a delayed second scroll.

- [ ] **Step 5: Commit the page handoff change.**

```bash
git add app/analyze/page.tsx app/analyze/page.test.ts
git commit -m "fix: reset precheckout CTA handoff to top"
```

### Task 4: Verify scope and the untouched graph player

**Files:**

- Verify only: `components/precheckout-demo.test.tsx`
- Verify only: `components/precheckout-immersive.test.tsx`
- Verify only: `app/analyze/page.test.ts`

- [ ] **Step 1: Run all focused regression files.**

```bash
npm test -- components/precheckout-demo.test.tsx components/precheckout-immersive.test.tsx app/analyze/page.test.ts
```

Expected: PASS. The direct demo tests still enforce the 12-second duration and S1→S4 ordering, while the immersive boundary tests establish that their `startedAtMs` input is fresh for every visible entry.

- [ ] **Step 2: Run lint.**

```bash
npm run lint
```

Expected: exit code 0 with no new lint errors in the modified component, page, or tests.

- [ ] **Step 3: Inspect the final diff for prohibited scope expansion.**

```bash
git diff --check HEAD~2..HEAD
git diff --name-only HEAD~2..HEAD
git diff HEAD~2..HEAD -- app/page.tsx lib/services/precheckout/blite-contract.ts lib/services/precheckout/blite-inference.ts app/api supabase
```

Expected: no whitespace errors; only the two source files and their focused tests changed; no landing-page marketing copy, B-lite contract/inference/API/provider/persistence, checkout rules, or migrations changed. The last diff is empty.

## Self-review

- **Spec coverage:** Task 1 and Task 2 cover a mount-local visible-entry clock, S1→S2→S3→S4 on mount/remount/reload/StrictMode, a fresh 12-second cached-result wait, and deadline latching with bounded graph-boundary grace. Task 2 covers the inclusive `likelyFemale === true && confidence >= 0.70` confirmation, confirmed/rejected analytics and CTA behavior, removal of only the normal gender card, ASCII `~` range, and omission of exact post counts. Task 3 covers the one explicit CTA transition, top reset after legacy commit in both pending/ready branches, removal of plan scrolling, and no later readiness scroll.
- **Scope review:** The plan deliberately preserves the B-lite DTO/API/schema, request cache, durable deadline/poll cut-off, graph player, analytics vocabulary, preflight reducer, checkout admission flow, and `app/page.tsx` marketing copy. It introduces no storage, migration, endpoint, provider/Gemini invocation, or analytics event/property.
- **Placeholder and consistency review:** There are no `TODO`/`TBD` steps. The plan consistently uses `visibleEntryAtMs` for presentation, `acceptedPreflightAtMs`/`deadlineAtMs` for the durable cutoff, `needsGenderConfirmation` for the shared threshold, and `resetPrecheckoutLegacyViewport` for the one-shot CTA reset; all test commands and exact affected paths are specified above.
