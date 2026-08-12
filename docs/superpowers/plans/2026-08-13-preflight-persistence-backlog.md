# Preflight Persistence Backlog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Identify and remove the single database persistence bottleneck that is causing preflight retries and queue growth.

**Architecture:** Keep the existing worker, queue, lease, and Apify routing. First expose only the sanitized persistence operation and PostgreSQL code already present in the wrapped error. Use that production evidence to change only the failing RPC or caller, then canary queue concurrency from 2 to 4 to 7.

**Tech Stack:** Next.js, TypeScript, Vitest, Supabase PostgreSQL, Cloud Run, Cloud Tasks

---

### Task 1: Safe persistence diagnostics

**Files:**
- Modify: `lib/services/analysis/preflight.ts`
- Modify: `app/api/analysis/preflight/worker/route.ts`
- Test: `lib/services/analysis/preflight-route.test.ts`

- [ ] Add a failing test proving retry logs include only a sanitized persistence operation and database code.
- [ ] Run the focused test and confirm it fails.
- [ ] Preserve sanitized diagnostics on `PreflightWorkerRetryError` and emit them from the worker.
- [ ] Run focused tests, TypeScript, and lint.
- [ ] Commit and deploy the diagnostic-only change.

### Task 2: Fix the evidenced persistence operation

**Files:**
- Modify only the caller or migration identified by Task 1 production evidence.
- Add its focused regression test.

- [ ] Observe at least one production persistence retry and record its operation/code aggregate.
- [ ] Write the smallest failing regression test for that operation.
- [ ] Apply one minimal fix without changing queue or provider architecture.
- [ ] Run focused tests, migration checks if applicable, TypeScript, lint, and build.
- [ ] Commit, open PR, review, merge, and deploy.

### Task 3: Drain canary

- [ ] Verify concurrency 2 has no persistence burst and queue depth decreases.
- [ ] Increase to concurrency 4 and repeat the observation.
- [ ] Increase to concurrency 7 only if 4 remains stable.
- [ ] Record queue depth, 2xx/5xx, persistence failures, and Apify rate limits at every step.
