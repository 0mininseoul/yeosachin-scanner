# Preflight Outcome Analytics and Delay UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split expected preflight blocks from technical failures in Amplitude and add progressive, design-system-aligned pending guidance based on the real production latency distribution.

**Architecture:** Pure helpers own terminal-outcome classification and elapsed-time stage selection. The existing preflight hook remains responsible for lifecycle timing and analytics, while a shared presentation component renders the same monotonic pending state in standard and beta flows without affecting polling or execution.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4, Amplitude Unified SDK, Vitest.

---

## File structure

- Modify `lib/services/analytics.ts`: register the new event and its closed property allowlist.
- Modify `lib/services/analytics-funnel.ts`: classify business blocks and extend terminal deduplication keys.
- Modify `hooks/useAnalysisV2Preflight.ts`: emit the classified event and expose the trusted start time.
- Create `components/preflight-pending-status.tsx`: render the shared existing-design-system pending state.
- Modify `app/analyze/page.tsx`: use the shared pending component.
- Modify `app/betatest/betatest-client.tsx`: use the shared pending component.
- Modify focused existing tests and create a component test for outcome, boundaries, privacy, and integration contracts.

### Task 1: Analytics event contract

**Files:**
- Modify: `lib/services/analytics.ts`
- Modify: `lib/services/analytics.test.ts`
- Modify: `lib/services/analytics-funnel.ts`
- Modify: `lib/services/analytics-funnel.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add assertions that `EVENTS.PREFLIGHT_BLOCKED` equals `preflight_blocked`, accepts only `duration_ms`, `error_code`, `stage`, and `preflight_id`, and that `preflightOutcomeEventKey()` accepts and distinguishes `succeeded`, `blocked`, and `failed`. Add table tests classifying the five approved business-block codes as `blocked`, ready as `succeeded`, and provider/queue/analysis/unknown codes as `failed`.

- [ ] **Step 2: Verify the tests fail for the missing event and helpers**

Run:

```bash
npx vitest run lib/services/analytics.test.ts lib/services/analytics-funnel.test.ts
```

Expected: failures identify the absent `PREFLIGHT_BLOCKED` event, outcome-key type, and classifier.

- [ ] **Step 3: Implement the minimal analytics contract**

Add:

```ts
PREFLIGHT_BLOCKED: 'preflight_blocked',
```

Register the same safe schema used by terminal failure. Introduce:

```ts
export type PreflightAnalyticsOutcome = 'succeeded' | 'blocked' | 'failed';

export function classifyPreflightAnalyticsOutcome(
    status: 'ready' | 'blocked',
    code?: string,
): PreflightAnalyticsOutcome;
```

The closed block set is `TARGET_NOT_FOUND`, `TARGET_PRIVATE`, `TARGET_UNSUPPORTED`, `OVER_PLUS_CAPACITY`, and `BETA_CAPACITY_UNAVAILABLE`. Everything else blocked maps to `failed`.

- [ ] **Step 4: Verify focused analytics tests pass**

Run the Step 2 command and expect zero failures.

- [ ] **Step 5: Commit the analytics contract**

```bash
git add lib/services/analytics.ts lib/services/analytics.test.ts lib/services/analytics-funnel.ts lib/services/analytics-funnel.test.ts
git commit -m "feat: separate blocked preflight analytics"
```

### Task 2: Hook terminal-event integration

**Files:**
- Modify: `hooks/useAnalysisV2Preflight.ts`
- Modify: `lib/services/analysis/preflight-client-races.test.ts`
- Modify: `lib/services/amplitude-funnel-caller-contract.test.ts`

- [ ] **Step 1: Write failing hook contract tests**

Assert that the hook imports the classifier, tracks `EVENTS.PREFLIGHT_BLOCKED` for an approved business block, retains `EVENTS.PREFLIGHT_FAILED` for technical terminal blocks and request failures, and exposes `preflightStartedAt`. Assert the caller contract recognizes all three terminal events.

- [ ] **Step 2: Verify the integration tests fail**

```bash
npx vitest run lib/services/analysis/preflight-client-races.test.ts lib/services/amplitude-funnel-caller-contract.test.ts
```

Expected: failures show the hook still maps all terminal blocks to `preflight_failed` and does not expose timing.

- [ ] **Step 3: Implement classified tracking**

Use `classifyPreflightAnalyticsOutcome(status.status, status.code)` to choose the event and dedupe key. Ready retains its current rich properties; blocked/failed terminal events retain normalized `error_code`, `stage`, `duration_ms`, and `preflight_id`. Return `preflightStartedAt` from the hook without exposing setters.

- [ ] **Step 4: Verify the integration tests pass**

Run the Step 2 command and expect zero failures.

- [ ] **Step 5: Commit hook integration**

```bash
git add hooks/useAnalysisV2Preflight.ts lib/services/analysis/preflight-client-races.test.ts lib/services/amplitude-funnel-caller-contract.test.ts
git commit -m "feat: classify terminal preflight outcomes"
```

### Task 3: Shared progressive pending UI

**Files:**
- Create: `components/preflight-pending-status.tsx`
- Create: `lib/services/preflight-pending-status.test.tsx`
- Modify: `app/analyze/page.tsx`
- Modify: `app/betatest/betatest-client.tsx`

- [ ] **Step 1: Write failing stage and component tests**

Test the pure stage helper at `0`, `14_999`, `15_000`, `44_999`, and `45_000` milliseconds. Render each stage and assert the approved Korean copy, existing `BrandMark`, progress rail, `data-amp-block` protection around the target, and absence of percentage/countdown text. Add source-contract assertions that both flows render `PreflightPendingStatus`.

- [ ] **Step 2: Verify the UI tests fail**

```bash
npx vitest run lib/services/preflight-pending-status.test.tsx lib/services/analysis/preflight-client-races.test.ts
```

Expected: module-not-found or missing shared component/stage failures.

- [ ] **Step 3: Implement the shared component**

Export:

```ts
export type PreflightPendingStage = 'initial' | 'taking_longer' | 'delayed';
export function preflightPendingStage(elapsedMs: number): PreflightPendingStage;
```

The component receives `targetInstagramId` and `startedAt`. It calculates wall-clock elapsed time, schedules only the next threshold, recalculates after background throttling, and clears the timer on unmount. Render with existing `BrandMark`, borders, typography, `bg-ink`, `text-fg-*`, `text-blood`, and the existing indeterminate rail animation.

- [ ] **Step 4: Replace duplicated flow markup**

Use `PreflightPendingStatus` for pending standard and beta preflights, passing the hook's `preflightStartedAt`. Do not modify terminal cards, retry behavior, polling cadence, or landing copy.

- [ ] **Step 5: Verify focused UI tests pass**

Run the Step 2 command and expect zero failures.

- [ ] **Step 6: Commit the UX implementation**

```bash
git add components/preflight-pending-status.tsx lib/services/preflight-pending-status.test.tsx app/analyze/page.tsx app/betatest/betatest-client.tsx
git commit -m "feat: add progressive preflight delay guidance"
```

### Task 4: Documentation and full verification

**Files:**
- Modify: `docs/amplitude-analytics-operations.md`

- [ ] **Step 1: Update the operations contract**

Document the deployment boundary, the three terminal event meanings, and that business eligibility blocks must not be counted as reliability failures.

- [ ] **Step 2: Run focused regression tests**

```bash
npx vitest run lib/services/analytics.test.ts lib/services/analytics-funnel.test.ts lib/services/amplitude-funnel-caller-contract.test.ts lib/services/analysis/preflight-client-races.test.ts lib/services/preflight-pending-status.test.tsx
```

Expected: zero failures.

- [ ] **Step 3: Run repository verification**

```bash
npm run lint
npm run build
```

Expected: both exit successfully.

- [ ] **Step 4: Review the complete diff**

Run `git diff origin/main...HEAD --check`, inspect `git diff --stat origin/main...HEAD`, and confirm `.superpowers/` is not staged.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/amplitude-analytics-operations.md docs/superpowers/plans/2026-08-12-preflight-outcome-and-delay-ux.md
git commit -m "docs: document preflight analytics outcomes"
```

### Task 5: Review and publish

- [ ] **Step 1: Perform a requirements-focused code review**

Review the final diff against `docs/superpowers/specs/2026-08-12-preflight-outcome-and-delay-ux-design.md`; resolve all critical and important findings.

- [ ] **Step 2: Re-run fresh verification after review fixes**

Run the focused tests, lint, and build again. Completion claims require these final outputs.

- [ ] **Step 3: Push the named branch**

```bash
git push -u origin 0mininseoul/amplitude-preflight-blocked-failed
```

- [ ] **Step 4: Create the pull request**

Create a PR targeting `main` with a summary of event separation, progressive pending UX, and verification evidence. Keep the worktree intact for review follow-up.
