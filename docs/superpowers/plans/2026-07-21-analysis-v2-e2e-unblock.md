# Analysis V2 E2E Unblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the reproduced Plus-consumption and preflight-retention database contracts, let a valid signed E2E coexist safely with live public admission, and complete the authorized `0_min._.00` Plus E2E with durable result and cost evidence.

**Architecture:** Keep public production admission as the deployment default. Select test-entitlement access only when the request carries a valid user/target/idempotency-bound admission token; reject an invalid supplied token before persistence. Apply one append-only database migration that expands the legacy request-plan domain and makes purge respect restrictive early-bird references. Verify the missing seams in Vitest and PGlite, deploy the reviewed SHA, run the existing request-bound provider sharding canary, and tear the temporary sharding down after terminal cleanup.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Vitest, PGlite, Supabase PostgreSQL/RPC, Cloud Tasks, Cloud Run, Vercel, Apify, Vertex Gemini.

---

## Root-Cause Baseline

- Branch baseline: `c87d98a`, plus isolated-worktree boundary commit `622a8bc`.
- Baseline verification: 265 test files passed, 1 skipped; 2,762 tests passed, 9 skipped; lint and `tsc --noEmit` clean.
- Plus consumption reproduction: PostgreSQL `23514`, `analysis_requests_plan_type_check`, because the V2 consumer inserts `plus` into a legacy `basic|standard` domain.
- Retention reproduction: PostgreSQL `23503`, because purge deletes preflights referenced by `earlybird_orders.preflight_id ON DELETE RESTRICT`.
- Test gap: `v2-authorized-test-provider-policy-pglite.test.ts` stubs the underlying consumer and begins with a pre-existing request.
- Migration drift: `20260719190000_reconcile_stuck_groble_earlybird_order.sql` is applied remotely but missing from git.

## Hard Invariants

- Do not change landing-page marketing copy.
- Do not log or commit provider tokens, signed admissions, entitlement tokens, owner credentials, buyer contact data, or raw private payloads.
- A supplied invalid/expired signed admission must never fall through to production access.
- A request with no signed admission must retain the current public-production behavior.
- Early-bird checkout remains Basic/Standard only; Plus remains non-purchasable and waitlist/deferred.
- Purge continues to scrub expired PII and to retain unreconciled provider-run tombstones.
- Do not change either restrictive early-bird foreign key to `CASCADE`.
- No paid provider call starts without the existing exact confirmation flag and the already-authorized exact target/cost envelope being reconfirmed immediately before execution.
- Automatic public analysis and automatic paid-order fulfillment remain disabled after the single E2E.

## Task 1: Preserve the Applied Migration

**Files:**

- Create: `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql`
- Test: `lib/services/analysis/analysis-v2-e2e-unblock-migration-contract.test.ts`

- [x] **Step 1: Add a failing migration-history contract**

Create a Vitest contract that reads the migration path and asserts the exact manual reconciliation identifiers and privacy guard comments are present. It must assert that no email address or phone-number literal is embedded.

```ts
const manualReconciliation = readFileSync(
    new URL('../../../supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql', import.meta.url),
    'utf8'
);

expect(manualReconciliation).toContain('evt_manual_recon_64115d4d_20260719');
expect(manualReconciliation).toContain('finalize_earlybird_groble_payment');
expect(manualReconciliation).not.toMatch(/[\w.+-]+@[\w.-]+/);
expect(manualReconciliation).not.toMatch(/01[016789]-?\d{3,4}-?\d{4}/);
```

- [x] **Step 2: Run the contract and prove it fails because the file is absent**

```bash
npx vitest run lib/services/analysis/analysis-v2-e2e-unblock-migration-contract.test.ts
```

Expected: failure opening `20260719190000_reconcile_stuck_groble_earlybird_order.sql`.

- [x] **Step 3: Restore the applied SQL byte-for-byte from the interrupted checkout**

Add the untracked migration unchanged with `apply_patch`. Do not re-run it remotely; Supabase already records version `20260719190000`.

- [x] **Step 4: Re-run the focused contract**

Expected: the migration-history assertions pass.

## Task 2: Make Signed Admission Request-Scoped

**Files:**

- Modify: `app/api/analysis/preflight/route.ts`
- Modify: `lib/services/analysis/preflight-route.test.ts`

- [x] **Step 1: Add the failing precedence matrix**

Add route tests for:

1. public enabled + no header -> `trustedPreflightAccessMode()` result;
2. public enabled + valid signed header -> persisted `test_entitlement` even when the trusted deployment mode is `production`;
3. public enabled + invalid/target-mismatched header -> rejection and zero `createOrReplay`/enqueue calls;
4. public disabled + valid header -> accepted `test_entitlement`;
5. public disabled + absent header -> existing 503.

Use `createAnalysisTestAdmission` and a 32-byte test secret; do not fake verification itself.

- [x] **Step 2: Run only the route tests and confirm the public-enabled signed case fails**

```bash
npx vitest run lib/services/analysis/preflight-route.test.ts
```

Expected before implementation: the public-enabled valid header is ignored and the mocked production access mode is persisted.

- [x] **Step 3: Replace the boolean helper with a tri-state resolver**

In `app/api/analysis/preflight/route.ts`, resolve the header after identity/body/idempotency validation:

```ts
type SignedTestAdmissionState = 'absent' | 'valid' | 'invalid';

function signedTestAdmissionState(
    request: Request,
    input: { userId: string; targetInstagramId: string; idempotencyKey: string }
): SignedTestAdmissionState {
    const token = request.headers.get('x-analysis-test-admission');
    if (!token?.trim()) return 'absent';
    try {
        if (!analysisTestEntitlementsEnabled()) return 'invalid';
        assertAnalysisTestEntitlementConfiguration();
        return verifyAnalysisTestAdmission(token, input) ? 'valid' : 'invalid';
    } catch {
        return 'invalid';
    }
}
```

Then enforce:

```ts
if (signedAdmission === 'invalid') {
    return failed(503, 'V2_PIPELINE_UNAVAILABLE', '새 분석 접수가 일시적으로 중단되었습니다.');
}
if (!publicAdmission && signedAdmission !== 'valid') { /* existing 503 */ }

const accessMode = signedAdmission === 'valid'
    ? 'test_entitlement'
    : trustedPreflightAccessMode();
```

Remove the old `signedTestAdmission && accessMode !== 'test_entitlement'` deployment-mode check. The feature gate and secret validation remain mandatory in the tri-state resolver.

- [x] **Step 4: Re-run route tests**

Expected: all precedence cases pass; invalid supplied headers persist and enqueue nothing.

## Task 3: Add the Database Regression Tests

**Files:**

- Continue: `lib/services/analysis/analysis-v2-e2e-unblock-migration-contract.test.ts`
- Create: `lib/services/analysis/analysis-v2-e2e-unblock-pglite.test.ts`

- [x] **Step 1: Add failing SQL contract assertions for the not-yet-created migration**

Read `20260721143000_fix_analysis_v2_e2e_admission_and_retention.sql` and assert:

```ts
expect(migration).toMatch(/CHECK\s*\(plan_type IN \('basic', 'standard', 'plus'\)\)/);
expect(purgeBody).toContain('FROM public.earlybird_orders AS earlybird_order');
expect(purgeBody).toContain('FROM public.earlybird_waitlist AS waitlist_entry');
expect(purgeBody).toContain('FROM public.analysis_preflight_provider_runs AS provider_run');
expect(migration).toContain('REVOKE ALL ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER)');
expect(migration).not.toMatch(/ON DELETE CASCADE/);
```

- [x] **Step 2: Add a focused pre-migration PGlite fixture**

Bootstrap the roles, `analysis_requests`, `analysis_preflights`, `analysis_preflight_provider_runs`, `earlybird_orders`, and `earlybird_waitlist` with the production-relevant constraints and restrictive foreign keys. Install the current purge function by extracting it from `20260714175411_add_preflight_apify_provider_run_ledger.sql`.

The first test must show the legacy schema rejects:

```sql
INSERT INTO public.analysis_requests (id, plan_type) VALUES ($1, 'plus');
```

with `analysis_requests_plan_type_check` before applying the forward migration, then show the same insert succeeds after it.

- [x] **Step 3: Add the retention poison-batch regression**

Seed three already-scrubbed, older-than-one-hour expired preflights:

- one referenced by `earlybird_orders`;
- one referenced by `earlybird_waitlist`;
- one unreferenced.

Before the forward migration, calling purge must reject with a foreign-key error. After applying the forward migration, it must return normally, retain both referenced tombstones, and delete only the unreferenced row.

- [x] **Step 4: Run the focused tests and confirm they fail because the forward migration is absent**

```bash
npx vitest run \
  lib/services/analysis/analysis-v2-e2e-unblock-migration-contract.test.ts \
  lib/services/analysis/analysis-v2-e2e-unblock-pglite.test.ts
```

## Task 4: Implement the Append-Only Database Fix

**Files:**

- Create: `supabase/migrations/20260721143000_fix_analysis_v2_e2e_admission_and_retention.sql`

- [x] **Step 1: Expand the legacy request-plan constraint safely**

Use bounded migration timeouts and the existing constraint name:

```sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_requests
    DROP CONSTRAINT IF EXISTS analysis_requests_plan_type_check;
ALTER TABLE public.analysis_requests
    ADD CONSTRAINT analysis_requests_plan_type_check
    CHECK (plan_type IN ('basic', 'standard', 'plus')) NOT VALID;
ALTER TABLE public.analysis_requests
    VALIDATE CONSTRAINT analysis_requests_plan_type_check;
```

- [x] **Step 2: Replace purge with restrictive-reference exclusions**

Copy the latest function body from `20260714175411_add_preflight_apify_provider_run_ledger.sql` and preserve every existing predicate. Add only these delete-candidate guards:

```sql
AND NOT EXISTS (
    SELECT 1
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.preflight_id = preflight.id
)
AND NOT EXISTS (
    SELECT 1
    FROM public.earlybird_waitlist AS waitlist_entry
    WHERE waitlist_entry.preflight_id = preflight.id
)
```

Preserve `SECURITY DEFINER`, empty `search_path`, validation, revokes, service-role grant, and update the function comment to mention restrictive commercial references.

- [x] **Step 3: Run focused tests**

```bash
npx vitest run \
  lib/services/analysis/analysis-v2-e2e-unblock-migration-contract.test.ts \
  lib/services/analysis/analysis-v2-e2e-unblock-pglite.test.ts \
  lib/services/analysis/preflight-provider-run-pglite.test.ts \
  lib/services/analysis/preflight-provider-run-migration-contract.test.ts
```

Expected: legacy behavior is demonstrated inside the fixture, and all post-migration assertions pass.

## Task 5: Align the Operations Documentation

**Files:**

- Modify: `docs/authorized-apify-sharded-e2e-runbook.md`
- Modify: `docs/groble-earlybird-operations.md`
- Modify: `docs/operations-cost-model.md`

- [x] **Step 1: Update the canary admission invariant**

Document that live public admission may remain enabled. A valid signed admission takes request-scoped precedence; an absent header stays production; an invalid supplied header is rejected. Remove instructions that require a global admission/access-mode flip for this canary.

- [x] **Step 2: Document retention behavior**

State that order/waitlist-linked preflights are PII-scrubbed but retained as tombstones because the commercial records use restrictive references. Unreferenced tombstones remain purgeable.

- [x] **Step 3: Preserve the launch gate**

In the cost model, record that the successful canary is still required before pricing/automatic launch and that Plus test persistence does not make Plus a purchasable product.

- [x] **Step 4: Check documentation diff for accidental scope changes**

```bash
git diff --check
git diff -- docs/authorized-apify-sharded-e2e-runbook.md \
  docs/groble-earlybird-operations.md docs/operations-cost-model.md
```

## Task 6: Verify the Change Before Deployment

- [x] **Step 1: Run the focused suite**

```bash
npx vitest run \
  lib/services/analysis/preflight-route.test.ts \
  lib/services/analysis/analysis-v2-e2e-unblock-migration-contract.test.ts \
  lib/services/analysis/analysis-v2-e2e-unblock-pglite.test.ts \
  lib/services/analysis/preflight-provider-run-pglite.test.ts \
  lib/services/analysis/v2-authorized-test-provider-policy-pglite.test.ts
```

- [x] **Step 2: Run complete repository verification**

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
git diff --check
git status --short --branch
```

- [x] **Step 3: Review the complete diff and migration ordering**

Confirm the manual reconciliation SQL is unchanged, the new migration sorts after `20260721000000`, and no secret/PII/marketing-copy file changed.

- [x] **Step 4: Commit the implementation**

```bash
git add app/api/analysis/preflight/route.ts \
  lib/services/analysis/preflight-route.test.ts \
  lib/services/analysis/analysis-v2-e2e-unblock-migration-contract.test.ts \
  lib/services/analysis/analysis-v2-e2e-unblock-pglite.test.ts \
  supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql \
  supabase/migrations/20260721143000_fix_analysis_v2_e2e_admission_and_retention.sql \
  docs/authorized-apify-sharded-e2e-runbook.md \
  docs/groble-earlybird-operations.md docs/operations-cost-model.md \
  docs/superpowers/specs/2026-07-21-analysis-v2-e2e-unblock-design.md \
  docs/superpowers/plans/2026-07-21-analysis-v2-e2e-unblock.md
git commit -m "fix(analysis-v2): unblock signed plus e2e"
```

## Task 7: Apply and Deploy Safely

- [ ] **Step 1: Run read-only production prechecks**

Verify no processing V2 request, claimed/running job, active provider run, unreconciled preflight run, or queued task. Verify `main`, Vercel, and Cloud Run SHAs/revisions and inspect migration locks/table size without printing row payloads.

- [ ] **Step 2: Apply migrations through the ordered Supabase path**

The already-recorded `20260719190000` version must not execute again. Apply only the pending forward migration, then query `pg_constraint` and `pg_get_functiondef` read-only to confirm the Plus domain and both reference guards.

- [ ] **Step 3: Deploy the reviewed route SHA**

Deploy Vercel with normal production admission/access settings unchanged. Verify a no-header request still resolves the production path and an invalid test header persists nothing.

- [ ] **Step 4: Restore bounded authorized-test sharding**

Run the existing deployment scripts in check mode first. Restore only the reviewed `secondary` and `quinary` secret references required by the persisted operation map, set `ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED=true`, deploy the worker, and confirm one revision receives 100% traffic.

- [ ] **Step 5: Verify deployment parity and headroom**

Confirm Vercel/Cloud Run reviewed SHA parity, exact slot mapping, per-Actor daily/run quota, available balance, Cloud Tasks queue limits, and no active work immediately before minting tokens.

## Task 8: Execute and Reconcile the Authorized Paid E2E

- [ ] **Step 1: Reconfirm the bounded paid call immediately before execution**

State the exact target, selected Plus plan, expected Apify/Gemini cost range, maximum authorized exposure, and that no Groble payment occurs. Use the existing `--confirm-paid-api-call` gate when minting/starting the canary.

- [ ] **Step 2: Mint fresh request-bound credentials**

Issue a new signed admission and entitlement bound to the authenticated authorized owner, normalized `0_min._.00`, a fresh idempotency key, nonce/JTI, and reviewed provider operation map. Never print them in commentary, logs, or committed files.

- [ ] **Step 3: Run the corrected browser/API loop**

Poll preflight until terminal readiness. Replay entitlement while it returns `admission_pending`, using the same idempotency identity, until exactly one request is created or a bounded terminal error occurs. Do not create a sibling request on timeout.

- [ ] **Step 4: Monitor to terminal and diagnose any failure narrowly**

Track sanitized stage/status counts at intervals under 60 seconds. For any failure, inspect the durable job/provider/preflight ledgers first, reproduce at the smallest safe seam, add a failing regression test, and fix before retrying.

- [ ] **Step 5: Verify the completed user outcome**

Require:

- request `completed` within the existing `<280s` canary target;
- one reciprocal preflight/request/JTI lineage and zero siblings;
- full relationship completeness and profile-batch evidence at the reviewed thresholds;
- durable result visible in history and reopenable after navigation/session reload;
- expected mobile result rendering and no target/exclusion leakage;
- complete PII-free provider, profile repair, media, interaction, and Gemini telemetry.

- [ ] **Step 6: Reconcile cost and cleanup**

Record sanitized Apify actual usage, complete Gemini token/model/retry usage, and bounded GCP list-price/metering evidence. Unknown usage is not counted as zero. Verify no active run, job, task, cleanup intent, provider artifact, or unreconciled cost remains.

- [ ] **Step 7: Tear down temporary sharding**

After terminal cleanup, set authorized-test sharding false, remove temporary non-selected worker secret references, redeploy, and confirm normal production requests still use only the configured primary slot.

## Task 9: Feed Evidence into Automatic-Launch Stabilization

- [ ] **Step 1: Update the existing launch plan with measured evidence**

Add the successful duration, stage distribution, provider/Gemini/GCP costs, unknown-usage count, and repair behavior to `docs/superpowers/plans/2026-07-18-instagram-v2-launch-unblock.md` without treating the single sample as a percentile.

- [ ] **Step 2: Write the next detailed plan before implementation**

The follow-up plan must cover, in order:

1. the deployment-wide fenced Gemini lease capped at eight across revisions;
2. controlled one-at-a-time Basic and Standard sample collection and p50/p95 reporting;
3. durable early-bird fulfillment using an outbox/lease/idempotent replay/recovery model;
4. issue #71 discounted late-cancel reattribution;
5. explicit public-admission rollout and rollback gates.

Do not implement automatic webhook-to-analysis dispatch as an incidental change in this E2E branch.

- [ ] **Step 3: Use the finishing-development-branch workflow**

Request review, resolve findings with regression tests, verify CI, and present merge/deployment choices. Do not claim automatic launch readiness until every separate gate is complete.
