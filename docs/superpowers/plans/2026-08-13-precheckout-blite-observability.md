# Precheckout B-lite Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make B-lite Apify and Gemini outcomes directly queryable in Axiom with bounded, PII-free events.

**Architecture:** Extend the closed operational schema with three B-lite terminal events, then add a small B-lite telemetry adapter shared by the route and Gemini callback. The existing scraper aggregate hook remains the source of generic Apify attempt telemetry, while B-lite-specific events identify the teaser path and preserve its fail-open behavior.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Vitest, Axiom operational logger, Apify scraper router, Gemini telemetry callbacks.

---

### Task 1: Register the event contract

**Files:**
- Modify: `lib/observability/schema.ts`
- Modify: `lib/observability/schema.test.ts`
- Modify: `lib/observability/pipeline-events.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add cases that sanitize `precheckout_blite.completed`, `precheckout_blite.profile_collection_failed`, and `precheckout_blite.inference_failed`, preserving only `preflight_id`, provider, operation, duration, disposition, and bounded error code.

- [ ] **Step 2: Verify RED**

Run: `npm test -- lib/observability/schema.test.ts lib/observability/pipeline-events.test.ts`

Expected: FAIL because the three event names and the `precheckout_blite` operation are not registered.

- [ ] **Step 3: Register the minimal names**

Add the three event names to `OPERATIONAL_EVENT_NAMES` and `precheckout_blite` to `OPERATIONAL_OPERATIONS`. Do not expand the field allowlist.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- lib/observability/schema.test.ts lib/observability/pipeline-events.test.ts`

Expected: PASS.

### Task 2: Emit B-lite route and provider outcomes

**Files:**
- Create: `lib/services/precheckout/blite-observability.ts`
- Create: `lib/services/precheckout/blite-observability.test.ts`
- Modify: `app/api/analysis/precheckout-blite/route.ts`
- Modify: `app/api/analysis/precheckout-blite/route.test.ts`

- [ ] **Step 1: Write failing adapter and route tests**

Cover these exact terminal outcomes: Apify collection failure emits `precheckout_blite.profile_collection_failed`; null or failed inference emits `precheckout_blite.inference_failed`; valid DTO plus durable checkpoint emits `precheckout_blite.completed`. Assert that cache hits, pending leases, access denial, username, and target content are absent from emitted fields.

- [ ] **Step 2: Verify RED**

Run: `npm test -- lib/services/precheckout/blite-observability.test.ts app/api/analysis/precheckout-blite/route.test.ts`

Expected: FAIL because the adapter and B-lite events do not exist.

- [ ] **Step 3: Add the minimal adapter and wiring**

Create a typed adapter that maps bounded failure categories to existing error codes and calls `operationalLogger.emit` best-effort. Pass `createSupabaseScraperTelemetryHook()` as the Apify `onTelemetry` hook. Record elapsed time from generation ownership through terminal outcome, and emit success only after `precheckoutBliteStore.complete` succeeds.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- lib/services/precheckout/blite-observability.test.ts app/api/analysis/precheckout-blite/route.test.ts lib/services/instagram/supabase-telemetry.test.ts`

Expected: PASS.

### Task 3: Connect Gemini attempt telemetry

**Files:**
- Modify: `lib/services/precheckout/blite-inference.ts`
- Modify: `lib/services/precheckout/blite-inference.test.ts`
- Modify: `lib/services/precheckout/blite-observability.ts`
- Modify: `lib/services/precheckout/blite-observability.test.ts`

- [ ] **Step 1: Write a failing callback test**

Assert `inferPrecheckoutBlite` supplies `onAttemptTelemetry`, and that an `ambiguous`, `rate_limited`, `rejected`, or `response_rejected` terminal attempt maps to one bounded inference failure without model output or input content.

- [ ] **Step 2: Verify RED**

Run: `npm test -- lib/services/precheckout/blite-inference.test.ts lib/services/precheckout/blite-observability.test.ts`

Expected: FAIL because B-lite does not pass an attempt callback.

- [ ] **Step 3: Wire the callback**

Extend `PrecheckoutBliteInferenceOptions` with a best-effort attempt sink and pass it to `analyzeWithGemini`. Deduplicate terminal inference failure at the route boundary so a Gemini callback and the fail-open return do not create two B-lite failure records.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- lib/services/precheckout/blite-inference.test.ts lib/services/precheckout/blite-observability.test.ts app/api/analysis/precheckout-blite/route.test.ts`

Expected: PASS.

### Task 4: Document the production query and verify the repository

**Files:**
- Modify: `docs/axiom-observability-operations.md`
- Modify: `lib/observability/operations-docs-contract.test.ts`

- [ ] **Step 1: Write a failing docs contract test**

Require an APL query selecting the three B-lite events in production and projecting provider, operation, error code, disposition, duration, and preflight ID.

- [ ] **Step 2: Verify RED**

Run: `npm test -- lib/observability/operations-docs-contract.test.ts`

Expected: FAIL because the operator query is absent.

- [ ] **Step 3: Add the runbook query**

Document a production query using bracket-quoted dotted fields and note that `204` preserves preflight and checkout availability.

- [ ] **Step 4: Run full verification**

Run: `npm test -- lib/observability/schema.test.ts lib/observability/pipeline-events.test.ts lib/services/precheckout/blite-observability.test.ts app/api/analysis/precheckout-blite/route.test.ts lib/services/precheckout/blite-inference.test.ts lib/services/instagram/supabase-telemetry.test.ts lib/observability/operations-docs-contract.test.ts`

Run: `npm run lint`

Run: `npx tsc --noEmit`

Run: `npm run build`

Expected: all exit 0.

- [ ] **Step 5: Review, land, and production-check**

Push the branch, open a PR, wait for required CI, review the diff for privacy and duplicate events, merge, verify the Vercel production deployment is Ready, run one owned B-lite canary, then query Axiom for `precheckout_blite.completed` without copying raw identifiers into the report.
