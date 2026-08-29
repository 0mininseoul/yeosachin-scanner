# Precheckout B-lite Visible Grace Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve an already-completed B-lite preview after a long exclusion-screen pause and give unresolved stale entries one complete visible waiting loop before the neutral fallback.

**Architecture:** Keep the immutable provider and inference deadlines anchored to preflight submission. Add only a browser display deadline derived from the later of the existing T+90 UX deadline and one initial 20-second pass plus one four-stage waiting loop from visible entry. A durable complete status wins before display-deadline evaluation; a terminal failure exits at the first safe graph boundary.

**Tech Stack:** React 19, TypeScript, Vitest fake timers, Next.js App Router

---

### Task 1: Correct stale-entry B-lite result and fallback timing

**Files:**
- Modify: `components/precheckout-immersive.tsx`
- Test: `components/precheckout-immersive.test.tsx`
- Modify only if needed for a timing SSOT: `components/precheckout-stage-graphs.tsx`

- [ ] **Step 1: Write the failing durable-result regression**

Add a test that mounts `PrecheckoutImmersive` with `submittedAtMs` five minutes in the past and a `completeStatus()` response. Assert that the fallback is absent and the four B-lite result cards appear after the initial 20-second pass.

- [ ] **Step 2: Run the durable-result regression and verify RED**

Run:

```bash
npx vitest run components/precheckout-immersive.test.tsx
```

Expected: the new stale-complete assertion fails because the existing deadline check selects fallback before consuming the complete DTO.

- [ ] **Step 3: Write the failing unresolved visible-grace regression**

Add a test that mounts with the same stale submission and an unresolved response. Assert that fallback is absent at 20 seconds and 43,999 milliseconds after visible entry, then present after the complete additional 24-second waiting loop at 44 seconds.

- [ ] **Step 4: Run the visible-grace regression and verify RED**

Run:

```bash
npx vitest run components/precheckout-immersive.test.tsx
```

Expected: the new unresolved assertion fails because the existing implementation falls back after the first 20-second pass.

- [ ] **Step 5: Preserve terminal-failure behavior**

Add or refine a focused test using `failedStatus()` with a stale submission. Assert no fallback before 20 seconds and fallback at the first safe boundary, without the extra waiting loop.

- [ ] **Step 6: Implement the minimum browser-only timing change**

In `PrecheckoutImmersive`, derive a visible unresolved deadline equivalent to:

```ts
const minimumVisibleFallbackAtMs = visibleEntryAtMs
    + PRECHECKOUT_DEMO_DURATION_MS
    + PRECHECKOUT_WAIT_STAGE_DURATION_MS * 4;
const visibleFallbackAtMs = Math.max(deadlineAtMs, minimumVisibleFallbackAtMs);
```

Use a named/exported waiting-cycle duration instead of the literal multiplier only if that reduces duplicate timing knowledge. Consume `status.state === 'complete'` before applying stale-deadline fallback. Continue polling pending/transient/unavailable status until `visibleFallbackAtMs`. Request fallback immediately for terminal failed status while retaining the component's safe graph-boundary settlement. Do not alter server/provider/inference deadlines or start new external work.

- [ ] **Step 7: Verify GREEN and neighboring timing behavior**

Run:

```bash
npx vitest run components/precheckout-immersive.test.tsx components/precheckout-demo.test.tsx components/precheckout-stage-graphs.test.tsx
```

Expected: all selected tests pass, including existing fresh-entry T+90, plan-gate, remount, and graph-cycle assertions.

- [ ] **Step 8: Run static verification and self-review**

Run the repository's TypeScript check or the narrowest documented static validation. Review timer cleanup, in-flight fetch behavior, analytics event deduplication, and the absence of provider/payment/Supabase changes.

- [ ] **Step 9: Commit the focused hotfix**

```bash
git add components/precheckout-immersive.tsx components/precheckout-immersive.test.tsx components/precheckout-stage-graphs.tsx docs/superpowers/plans/2026-08-29-precheckout-blite-visible-grace-hotfix.md
git commit -m "fix: preserve B-lite preview after exclusion delay"
```
