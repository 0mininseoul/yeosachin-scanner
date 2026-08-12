# Preflight Apify Three-Way Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route new preflight Apify fallbacks deterministically across primary, secondary, and quaternary credentials.

**Architecture:** Extend the existing pure selector only. Stored provider-run slots remain authoritative for retries, and incomplete three-token configuration falls back to the configured Analysis V2 slot.

**Tech Stack:** TypeScript, Vitest, Next.js worker on Cloud Run

---

### Task 1: Lock the three-way selector contract

**Files:**
- Modify: `lib/services/instagram/providers/apify.test.ts`

- [ ] Add a test that supplies primary, secondary, and quaternary tokens and finds deterministic UUID fixtures assigned to all three slots.
- [ ] Add a test that omits quaternary and expects the configured Analysis V2 fallback slot.
- [ ] Run `npx vitest run lib/services/instagram/providers/apify.test.ts` and confirm the new three-way assertion fails because quaternary is never selected.

### Task 2: Implement the minimal selector change

**Files:**
- Modify: `lib/services/instagram/providers/apify-relationship.ts`

- [ ] Require all three token slots before enabling the pool.
- [ ] Map the SHA-256 digest to the ordered slots `primary`, `secondary`, and `quaternary` using modulo three.
- [ ] Run `npx vitest run lib/services/instagram/providers/apify.test.ts` and confirm all tests pass.
- [ ] Run targeted ESLint and `npm run build`.

### Task 3: Review, ship, and verify

**Files:**
- No additional source files.

- [ ] Review the diff for accidental routing changes outside preflight.
- [ ] Commit and push the isolated branch, open a PR, and wait for required checks.
- [ ] Merge the PR and deploy the exact merged commit to the Cloud Run worker.
- [ ] Verify the new revision is Ready at 100% traffic and retains primary, secondary, and quaternary secret references.
- [ ] Confirm fresh preflight IDs map across all three slots and monitor worker failures after rollout.
