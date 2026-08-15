# Preflight immersive B-lite flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the approved four-stage immersive flow from the accepted preflight, then gate plans behind either B-lite's full summary CTA or neutral T+90 fallback CTA.

**Architecture:** Keep the existing preflight full-profile collection and B-lite durable worker unchanged. `AnalyzePage` mounts `PrecheckoutImmersive` after the existing exclusion decision even while the preflight is pending; the component uses its persisted accepted timestamp and the existing status endpoint to run the graph player, delay B-lite reveal to a graph boundary, and derive refresh state without work duplication.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Vitest/jsdom, existing Supabase status store.

---

### Task 1: Extend the graph player for an initial pass plus slow continuation

**Files:**

- Modify: `components/precheckout-stage-graphs.tsx`
- Modify: `components/precheckout-demo.tsx`
- Test: `components/precheckout-demo.test.tsx`

- [ ] **Step 1: Write failing player tests.**

```ts
it('keeps playing after the first pass with rotating progress copy', async () => {
  root.render(createElement(PrecheckoutDemo, {
    mode: 'waiting', startedAtMs: 0, finishRequested: false,
    onComplete: vi.fn(), onError: vi.fn(),
  }));
  await advanceTimersBy(12_000);
  expect(container.querySelector('[data-precheckout-demo-phase="waiting"]')).not.toBeNull();
  expect(container.querySelector('[data-precheckout-progress]')?.textContent).toContain('추가 신호');
});

it('finishes only at the next slow-stage transition after a request', async () => {
  const onComplete = vi.fn();
  root.render(createElement(PrecheckoutDemo, {
    mode: 'waiting', startedAtMs: 0, finishRequested: false, onComplete, onError: vi.fn(),
  }));
  await advanceTimersBy(12_001);
  root.render(createElement(PrecheckoutDemo, {
    mode: 'waiting', startedAtMs: 0, finishRequested: true, onComplete, onError: vi.fn(),
  }));
  await advanceTimersBy(5_999);
  expect(onComplete).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the test and confirm RED.**

    `npm test -- components/precheckout-demo.test.tsx`

    Expected: fail because waiting mode, slow continuation, and finish gating do not exist.

- [ ] **Step 3: Implement the minimal player extension.**

```ts
export const PRECHECKOUT_WAIT_STAGE_DURATION_MS = 6_000;

function nextTransitionAt(startedAtMs: number, nowMs: number): number {
  const firstPassEndsAt = startedAtMs + PRECHECKOUT_DEMO_DURATION_MS;
  if (nowMs <= firstPassEndsAt) return firstPassEndsAt;
  return firstPassEndsAt + Math.ceil((nowMs - firstPassEndsAt) / PRECHECKOUT_WAIT_STAGE_DURATION_MS)
    * PRECHECKOUT_WAIT_STAGE_DURATION_MS;
}
```

`PrecheckoutStageGraphs` retains original timings for the first 12 seconds and maps each later
six-second interval to S1–S4. `PrecheckoutDemo` accepts `mode="waiting"` and
`finishRequested`; it renders a rotating neutral `data-precheckout-progress` message and calls
`onComplete` only at `nextTransitionAt` after a completion request.

- [ ] **Step 4: Run the player test and confirm GREEN.**

    `npm test -- components/precheckout-demo.test.tsx`

    Expected: pass, including strict-mode, accessibility, and body-overflow tests.

- [ ] **Step 5: Commit.**

    `git add components/precheckout-stage-graphs.tsx components/precheckout-demo.tsx components/precheckout-demo.test.tsx && git commit -m "feat: keep precheckout demo alive while B-lite loads"`

### Task 2: Replace card-first B-lite presentation with deterministic demo-first flow

**Files:**

- Modify: `components/precheckout-immersive.tsx`
- Test: `components/precheckout-immersive.test.tsx`

- [ ] **Step 1: Write failing flow tests.**

```ts
it('starts the graph before a pending B-lite response and renders neither legacy card nor plans', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noBody(204)));
  root.render(createElement(PrecheckoutImmersive, {
    preflightId: PREFLIGHT_ID, claimToken: null, submittedAtMs: Date.parse(SUBMITTED_AT),
    targetUsername: 'target', onGoToPlans: vi.fn(),
  }));
  await settleUi();
  expect(container.querySelector('[data-precheckout-demo-mode="waiting"]')).not.toBeNull();
  expect(container.textContent).not.toContain('관계 판독 미리보기');
  expect(container.textContent).not.toContain('상세 분석 보기');
});

it('reveals complete B-lite at a graph boundary, then releases plans only through its CTA', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(SUBMITTED_AT));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(completeStatus(validDto({ likelyFemale: false })))));
  const onGoToPlans = vi.fn();
  root.render(createElement(PrecheckoutImmersive, {
    preflightId: PREFLIGHT_ID, claimToken: null, submittedAtMs: Date.parse(SUBMITTED_AT),
    targetUsername: 'target', onGoToPlans,
  }));
  await settleUi();
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(container.textContent).toContain('target');
  expect(container.querySelectorAll('[data-precheckout-result-card]')).toHaveLength(5);
  expect(onGoToPlans).not.toHaveBeenCalled();
  await clickButton(container, '상세 분석 보기');
  expect(onGoToPlans).toHaveBeenCalledOnce();
});

it('uses a neutral fallback CTA after T+90 without opening plans early', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(SUBMITTED_AT));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noBody(204)));
  const onGoToPlans = vi.fn();
  root.render(createElement(PrecheckoutImmersive, {
    preflightId: PREFLIGHT_ID, claimToken: null, submittedAtMs: Date.parse(SUBMITTED_AT),
    targetUsername: 'target', onGoToPlans,
  }));
  await settleUi();
  await act(async () => { await vi.advanceTimersByTimeAsync(89_999); });
  expect(onGoToPlans).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(container.textContent).toContain('상세 분석 보기');
  await clickButton(container, '상세 분석 보기');
  expect(onGoToPlans).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the test and confirm RED.**

    `npm test -- components/precheckout-immersive.test.tsx`

    Expected: fail because pending returns `null`, the current B-lite result is one card, and
    `SUCCESS_CTA` starts the demo after its card CTA.

- [ ] **Step 3: Implement the minimal flow.**

Keep one `PrecheckoutDemo mode="waiting"` mounted from `submittedAtMs`. A valid parsed DTO
sets a result completion request; a terminal/pending/unavailable/transient status remains on the
demo and is retried until `submittedAtMs + BLITE_UX_DEADLINE_MS`, which sets the fallback request.
The player completes the active graph before rendering its target, persona, feed evidence, gender,
and relationship cards. B-lite's `상세 분석 보기` and the neutral fallback CTA are the only calls
to `onGoToPlans`; do not render an explicit B-lite failure message. Retain browser status-promise
caching so a refresh performs only status reads and a completed response is reused.

- [ ] **Step 4: Run the flow test and confirm GREEN.**

    `npm test -- components/precheckout-immersive.test.tsx`

    Expected: pass for immediate demo, slow pending loop, transition-bound result, 90-second
fallback, CTA gate, refresh, and no early legacy card/plans.

- [ ] **Step 5: Commit.**

    `git add components/precheckout-immersive.tsx components/precheckout-immersive.test.tsx && git commit -m "fix: gate precheckout plans behind immersive demo"`

### Task 3: Mount the flow from accepted preflight and preserve plan gating

**Files:**

- Modify: `app/analyze/page.tsx`
- Modify: `app/analyze/page.test.ts`
- Modify only if needed: `lib/services/precheckout/blite-page-flow.ts`

- [ ] **Step 1: Write failing page-boundary tests.**

```ts
it('holds the matching accepted preflight on the immersive surface until its CTA releases legacy', () => {
  expect(resolveActivePrecheckoutSurface({ preflightId: 'p', surface: 'awaiting' }, 'p')).toBe('awaiting');
  expect(resolveActivePrecheckoutSurface({ preflightId: 'p', surface: 'legacy' }, 'p')).toBe('legacy');
});
```

- [ ] **Step 2: Run the test and inspect the ready-only RED path.**

    `npm test -- app/analyze/page.test.ts`

    Expected: the renderer still mounts the component inside `readyPreflight` and renders the
target card before it.

- [ ] **Step 3: Implement accepted-preflight mounting.**

Use `preflight?.preflightId` to reset and resolve the active surface. After the exclusion
decision, mount the immersive component while its accepted preflight is pending or ready; pass the
persisted start timestamp and normalized target handle. Render the legacy target card and plan
section only when the same surface is `legacy`. If fallback CTA is selected before the normal
preflight data arrives, render the existing pending status instead of an empty plan region.

- [ ] **Step 4: Run the page test and confirm GREEN.**

    `npm test -- app/analyze/page.test.ts`

    Expected: pass with no diff to `app/page.tsx` marketing copy.

- [ ] **Step 5: Commit.**

    `git add app/analyze/page.tsx app/analyze/page.test.ts lib/services/precheckout/blite-page-flow.ts && git commit -m "fix: start precheckout demo from accepted preflight"`

### Task 4: Review, merge, deploy, and produce mobile evidence

**Files:**

- Modify: none unless verification discovers a regression

- [ ] **Step 1: Run local verification.**

    `npm test -- components/precheckout-demo.test.tsx components/precheckout-immersive.test.tsx app/analyze/page.test.ts && npm run lint && npm run build && npm test`

    Expected: every command exits zero.

- [ ] **Step 2: Independently review scope and fixed copy.**

    `git diff origin/main...HEAD --check && git diff origin/main...HEAD -- app/page.tsx && git status --short`

    Expected: no whitespace errors, no landing-copy change, and only intended files.

- [ ] **Step 3: Create PR and wait for green checks.**

    `gh pr create --base main --head 0mininseoul/preflight-demo-blite-order-20260815 --fill`

    Expected: a PR URL; every required GitHub check passes before merge.

- [ ] **Step 4: Merge through GitHub main and verify production mobile.**

Merge the approved green PR, wait for Vercel production deployment, and use a fresh iOS/mobile
session with the supplied target. Record only sanitized evidence of S1→S4 initial ordering, slow
pending continuation, graph-boundary full result plus CTA gate, or neutral T+90 fallback; do not
print or persist raw payloads, credentials, claim tokens, or identifiers.
