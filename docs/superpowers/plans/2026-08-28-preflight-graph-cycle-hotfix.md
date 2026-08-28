# Preflight Graph-Cycle Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the first four-graph preflight pass exactly 20 seconds and prevent the fourth progress rail from carrying into later waiting cycles.

**Architecture:** Keep the existing imperative SVG player and absolute timeline. Change only its timing constants and add an explicit cycle-boundary reset before the normal stage transition helper runs; preserve the 24-second waiting loop, stage-boundary handoff, and 90-second preflight deadline.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, JSDOM

---

## Scope guard

- In scope: `components/precheckout-stage-graphs.tsx` and the two focused precheckout test files listed below.
- Out of scope: preflight collection, Apify tokens, checkout/payment, Supabase, Amplitude event schemas, landing copy, and graph artwork.
- Production data and database migrations are not involved.

### Task 1: Lock the new timing and cycle-reset contracts in tests

**Files:**
- Modify: `components/precheckout-demo.test.tsx`
- Modify: `components/precheckout-immersive.test.tsx`
- Reference only: `components/precheckout-demo.tsx`
- Reference only: `components/precheckout-stage-graphs.tsx`

- [ ] **Step 1: Update the focused duration contract test**

In `components/precheckout-demo.test.tsx`, change the initial-stage expectations to:

```ts
expect(PRECHECKOUT_DEMO_STAGE_DURATIONS_MS).toEqual([4_500, 4_500, 4_500, 4_500]);
expect(PRECHECKOUT_DEMO_DURATION_MS).toBe(20_000);
```

Rename the exact-runtime test so its title states `20,000ms`. Update direct frame boundaries from `2_600`, `5_300`, and `7_800` to `4_500`, `9_000`, and `13_500` respectively.

- [ ] **Step 2: Update elapsed-position fixtures without weakening their assertions**

Where the demo component tests use 10 seconds to prove that an absolute timeline is already on stage 4, use 15 seconds instead. Keep the one-millisecond-before and exact-deadline assertions expressed from `DEMO_DURATION_MS`, for example:

```ts
await advanceTimersBy(15_000);
// ...stage 4 assertion...
await advanceTimersBy(DEMO_DURATION_MS - 15_001);
expect(onComplete).not.toHaveBeenCalled();
await advanceTimersBy(1);
expect(onComplete).toHaveBeenCalledTimes(1);
```

Update the internal module mock's stage durations to `[4_500, 4_500, 4_500, 4_500]`. Do not replace duration-derived assertions with loose waits.

- [ ] **Step 3: Add the exact fourth-rail regression**

Import `PRECHECKOUT_WAIT_STAGE_DURATION_MS` directly from `./precheckout-stage-graphs`. Add one test that renders `PrecheckoutDemo` in `waiting` mode with `finishRequested={false}`, drives the existing fake wall and monotonic clocks through `requestAnimationFrame`, and crosses both:

```ts
const firstWaitingCycleAtMs = PRECHECKOUT_DEMO_DURATION_MS;
const secondWaitingCycleAtMs = firstWaitingCycleAtMs
    + PRECHECKOUT_WAIT_STAGE_DURATION_MS * 4;
```

At each boundary, assert that accessible status reports stage `1/4`, the first rail begins empty, and the fourth rail is empty rather than `100%`. Read the rail elements from `.precheckout-stage-graphs i > span` (or the narrowest stable selector already supported by the markup) and assert their inline `style.width` values. This test must reproduce the reported second-cycle defect before implementation.

- [ ] **Step 4: Replace only old 12-second UX-contract literals in the immersive suite**

In `components/precheckout-immersive.test.tsx`, import `PRECHECKOUT_DEMO_DURATION_MS` from `./precheckout-demo`. Replace the initial-pass waits and expected `duration_ms: 12_000` payload with the exported constant. Use `PRECHECKOUT_DEMO_DURATION_MS - 1` for the just-before-boundary assertions.

Also update comments that describe a 12-second pass. Do not change the independent 90-second deadline assertions or 6-second waiting-stage assertions.

- [ ] **Step 5: Run the focused tests and record the expected RED state**

Run:

```bash
npm test -- components/precheckout-demo.test.tsx components/precheckout-immersive.test.tsx
```

Expected before implementation: failures on the 20-second timing contract and the waiting-cycle fourth-rail reset. Confirm failures are assertion failures, not test-environment errors. Do not commit the RED state.

### Task 2: Implement the minimal graph-player fix

**Files:**
- Modify: `components/precheckout-stage-graphs.tsx`
- Test: `components/precheckout-demo.test.tsx`
- Test: `components/precheckout-immersive.test.tsx`

- [ ] **Step 1: Set the approved first-pass duration**

Change the four `STAGES` durations to `4_500` and `REVEAL_MS` to `2_000`. Update the nearby duration comment to state the exact equation:

```ts
/** 4500 * 4 + 2000 = 20000ms total. */
const REVEAL_MS = 2_000;
```

Keep `PRECHECKOUT_WAIT_STAGE_DURATION_MS` at `6_000`.

- [ ] **Step 2: Reset active visual state at each waiting-cycle boundary**

Inside the existing effect, add a small helper adjacent to `setActive`:

```ts
function resetForWaitingCycle() {
    if (activeIndex >= 0) {
        engines[activeIndex].svg.style.opacity = '0';
    }
    activeIndex = -1;
    railRefs.current.forEach(bar => {
        if (bar) bar.style.width = '0';
    });
}
```

In the `nextSlowCycle !== slowCycle` branch, update `slowCycle` and call this helper. Remove the old rail-only reset. This ordering is required: clear `activeIndex` before `setActive(active)` so the normal transition helper cannot refill the previous S4 rail.

- [ ] **Step 3: Keep reduced-motion documentation accurate**

Change only the reduced-motion comment from an exact 12-second deadline to an exact 20-second deadline. Reduced-motion behavior and completion ownership remain unchanged.

- [ ] **Step 4: Run the focused tests to GREEN**

Run:

```bash
npm test -- components/precheckout-demo.test.tsx components/precheckout-immersive.test.tsx
```

Expected: both files pass, including the new first- and second-waiting-cycle rail assertions.

- [ ] **Step 5: Commit the coherent application change**

Review `git diff --check` and commit the implementation plus focused tests together:

```bash
git add components/precheckout-stage-graphs.tsx \
  components/precheckout-demo.test.tsx \
  components/precheckout-immersive.test.tsx
git commit -m "fix: reset preflight graph waiting cycles"
```

### Task 3: Verify the narrow hotfix

**Files:**
- Verify: `components/precheckout-stage-graphs.tsx`
- Verify: `components/precheckout-demo.test.tsx`
- Verify: `components/precheckout-immersive.test.tsx`
- Verify only: repository build and lint configuration

- [ ] **Step 1: Run the focused regression suites**

```bash
npm test -- components/precheckout-demo.test.tsx components/precheckout-immersive.test.tsx app/analyze/page.test.ts
```

- [ ] **Step 2: Run static verification**

```bash
npx tsc --noEmit
npm run lint
git diff --check
```

- [ ] **Step 3: Run the production build**

Run `npm run build` using the worktree's existing non-secret environment. If public Supabase build variables are absent, inject only syntactically valid non-secret placeholders for the build command; never print or copy credentials from another worktree.

- [ ] **Step 4: Audit the final change boundary**

Use `git status --short` and `git show --stat --oneline HEAD`. Confirm that the application commit touches exactly the graph player and the two focused tests. Confirm no payment, Supabase, Apify, analytics, landing-page, or migration file changed.

### Task 4: Review, land, deploy, and observe

**Files:**
- Review: approved design, this implementation plan, and the application commit
- Remote target: existing `yeosachin-scanner` repository and Vercel project only

- [ ] **Step 1: Perform independent spec and quality review**

Verify the implementation matches the approved design, the regression test fails on the parent commit and passes on the implementation commit, and the reset helper does not alter intra-cycle transitions or the 90-second fallback authority. Fix only confirmed issues, then rerun Task 3.

- [ ] **Step 2: Land by ancestry-safe fast-forward**

Fetch the remote, verify the implementation commit descends from current `origin/main`, and integrate without destructive reset or broad checkout. If `origin/main` moved incompatibly, stop and rebase or cherry-pick in an isolated worktree before pushing.

- [ ] **Step 3: Deploy through the existing production project**

Deploy from the updated main branch to the existing Vercel project `yeosachin-scanner`. Do not create or use `ai-baram-detector` and do not mutate production Supabase.

- [ ] **Step 4: Verify production behavior without creating an order**

Confirm the production deployment is healthy. Observe at least two graph cycles during a preflight that does not proceed into checkout. Verify:

- the guaranteed initial S1-S4 pass lasts 20 seconds;
- each later stage remains 6 seconds;
- the second cycle starts at S1 with S4's rail empty;
- result/fallback handoff still occurs only at a stage boundary;
- no checkout or order is created by this visual verification.

If a fresh production scrape would disturb an active user test or consume an unapproved target, defer only the live visual observation to the next user-run preflight and report that limitation explicitly; do not claim it was observed.
