# Preflight Apify Dual-Slot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministically distribute new standard and anonymous preflight Apify fallback runs across the configured primary and secondary credentials without changing retry, beta-pool, or billing semantics.

**Architecture:** Add a pure selector beside the existing Apify credential helpers. The selector hashes the canonical preflight UUID only when both primary and secondary tokens exist; otherwise it delegates to the existing Analysis V2 slot selector. Call it only when creating a new non-beta preflight provider-run identity, leaving existing persisted runs and beta holds authoritative.

**Tech Stack:** TypeScript, Node `crypto`, Vitest, Next.js 16, Supabase provider-run ledger

---

## File structure

- Modify `lib/services/instagram/providers/apify-relationship.ts`: export the deterministic preflight slot selector.
- Modify `lib/services/instagram/providers/apify.test.ts`: unit-test determinism, distribution, and compatibility fallback.
- Modify `lib/services/analysis/preflight.ts`: use the selector for new anonymous and standard fallback runs only.
- Modify `lib/services/analysis/preflight.test.ts`: verify new-run slot selection and persisted-run reuse.

### Task 1: Define deterministic credential selection

**Files:**
- Modify: `lib/services/instagram/providers/apify.test.ts`
- Modify: `lib/services/instagram/providers/apify-relationship.ts`

- [ ] **Step 1: Write failing selector tests**

Add tests that import `selectPreflightApifyCredentialSlot` and assert:

```ts
const dual = {
    APIFY_API_TOKEN: 'primary-token',
    APIFY_SECONDARY_API_TOKEN: 'secondary-token',
};
expect(selectPreflightApifyCredentialSlot(PREFLIGHT_A, dual))
    .toBe(selectPreflightApifyCredentialSlot(PREFLIGHT_A, dual));
expect(new Set(PREFLIGHT_IDS.map(id => selectPreflightApifyCredentialSlot(id, dual))))
    .toEqual(new Set(['primary', 'secondary']));
expect(selectPreflightApifyCredentialSlot(PREFLIGHT_A, {
    APIFY_API_TOKEN: 'primary-token',
    ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'primary',
})).toBe('primary');
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run lib/services/instagram/providers/apify.test.ts`

Expected: FAIL because `selectPreflightApifyCredentialSlot` is not exported.

- [ ] **Step 3: Implement the pure selector**

In `apify-relationship.ts`, import `createHash` from `node:crypto` and add:

```ts
export function selectPreflightApifyCredentialSlot(
    preflightId: string,
    env: Record<string, string | undefined> = process.env,
): ApifyCredentialSlot {
    const hasPrimary = Boolean(env.APIFY_PRIMARY_API_TOKEN?.trim() || env.APIFY_API_TOKEN?.trim());
    const hasSecondary = Boolean(env.APIFY_SECONDARY_API_TOKEN?.trim());
    if (!hasPrimary || !hasSecondary) return selectAnalysisV2ApifyCredentialSlot(env);
    const firstByte = createHash('sha256').update(preflightId.toLowerCase(), 'utf8').digest()[0];
    return firstByte % 2 === 0 ? 'primary' : 'secondary';
}
```

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --run lib/services/instagram/providers/apify.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit selector**

```bash
git add lib/services/instagram/providers/apify-relationship.ts lib/services/instagram/providers/apify.test.ts
git commit -m "feat: select preflight Apify slot deterministically"
```

### Task 2: Wire only new non-beta preflight runs

**Files:**
- Modify: `lib/services/analysis/preflight.test.ts`
- Modify: `lib/services/analysis/preflight.ts`

- [ ] **Step 1: Write failing worker tests**

Add one anonymous and one standard fallback test with both tokens configured. Capture `providerRunStore.reserve` and assert the persisted identity slot equals `selectPreflightApifyCredentialSlot(preflightId, env)`. Extend the existing-run test with both tokens and assert its persisted `quinary` slot is resumed. Keep the existing beta test assertion unchanged.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run lib/services/analysis/preflight.test.ts`

Expected: FAIL because new runs still call `selectAnalysisV2ApifyCredentialSlot`.

- [ ] **Step 3: Replace new-run selection sites**

Import `selectPreflightApifyCredentialSlot` and use:

```ts
selectPreflightApifyCredentialSlot(claim.preflightId, dependencies.env)
```

for a new anonymous fallback and a new standard fallback. Do not change existing-run resume or beta-hold selection.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --run lib/services/analysis/preflight.test.ts lib/services/instagram/providers/apify.test.ts`

Expected: both files PASS.

- [ ] **Step 5: Commit integration**

```bash
git add lib/services/analysis/preflight.ts lib/services/analysis/preflight.test.ts
git commit -m "feat: distribute preflight fallback across Apify slots"
```

### Task 3: Regression verification and delivery

**Files:**
- Verify all modified files and relevant provider-run tests.

- [ ] **Step 1: Run focused regression suite**

Run:

```bash
npm test -- --run \
  lib/services/instagram/providers/apify.test.ts \
  lib/services/analysis/preflight.test.ts \
  lib/services/analysis/preflight-provider-run.test.ts \
  lib/services/analysis/preflight-provider-run-pglite.test.ts \
  lib/services/analysis/beta-apify-preflight-coordinator.test.ts
```

Expected: all tests PASS.

- [ ] **Step 2: Run static verification**

Run: `npm run lint && npm run build`

Expected: both commands exit 0.

- [ ] **Step 3: Review diff and secrets**

Run: `git diff origin/main...HEAD --check` and inspect `git diff origin/main...HEAD`.

Expected: no whitespace errors, token values, unrelated files, or beta-path changes.

- [ ] **Step 4: Push and open PR**

Push `0mininseoul/preflight-apify-dual-slot`, create a PR to `main`, and wait for required checks.

- [ ] **Step 5: Merge and verify Production**

Merge after review and green CI. Verify the Vercel Production deployment is Ready, `yeosachin.com` returns HTTP 200, new provider-run telemetry uses both credential slots, and preflight p50/p90 plus `PROVIDER_ERROR` do not regress during the canary window.
