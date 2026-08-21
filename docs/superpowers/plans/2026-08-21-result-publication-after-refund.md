# Result Publication After Refund Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a fully completed and delivered paid result readable after its order enters `refund_pending` or `refunded`, without changing financial history.

**Architecture:** Preserve `earlybird_orders` as the commercial lifecycle and use the existing `earlybird_fulfillments` plus `analysis_requests` as the result lifecycle. Replace only `analysis_result_publication_authorized(UUID)` so a terminal refund state is compatible with a completed, request-bound fulfillment while all incomplete and cancelled shapes remain fail-closed.

**Tech Stack:** PostgreSQL/Supabase migrations, Vitest, PGlite, Supabase CLI

---

### Task 1: Lock the publication contract with failing tests

**Files:**
- Modify: `lib/services/analysis/result-publication-authority-pglite.test.ts`

- [ ] **Step 1: Reference the new migration after the two existing guard migrations**

Add a `readFileSync` for `supabase/migrations/20260821080948_allow_completed_results_after_refund.sql` and execute its extracted authority function last.

- [ ] **Step 2: Add paid-order fixtures for refund states**

Create completed fulfillment fixtures for order statuses `refund_pending` and `refunded`, plus a refunded fixture whose fulfillment remains `analysis_in_progress` and a cancelled fixture whose fulfillment says `completed`.

- [ ] **Step 3: Assert the intended matrix**

```ts
await expect(authority(REQUEST_REFUND_PENDING)).resolves.toBe(true);
await expect(authority(REQUEST_REFUNDED)).resolves.toBe(true);
await expect(authority(REQUEST_REFUNDED_INCOMPLETE)).resolves.toBe(false);
await expect(authority(REQUEST_CANCELLED)).resolves.toBe(false);
```

- [ ] **Step 4: Run the focused test and verify red state**

Run: `npx vitest run lib/services/analysis/result-publication-authority-pglite.test.ts`

Expected: FAIL because the new migration does not exist yet.

### Task 2: Implement the minimal forward-only migration

**Files:**
- Create with `supabase migration new`: `supabase/migrations/20260821080948_allow_completed_results_after_refund.sql`

- [ ] **Step 1: Create the migration through the Supabase CLI**

Run: `supabase migration new allow_completed_results_after_refund`

Expected: one empty migration file at `supabase/migrations/20260821080948_allow_completed_results_after_refund.sql`.

- [ ] **Step 2: Replace only the authority function**

Copy the current function body from `20260816230000_result_source_publication_guard.sql` and change the paid-order failure predicate from requiring only `status = 'completed'` to permitting exactly:

```sql
earlybird_order.status NOT IN ('completed', 'refund_pending', 'refunded')
```

Keep the same completed fulfillment binding, source-request exclusion, privileges, lock timeout, and statement timeout. Do not update any data rows.

- [ ] **Step 3: Run focused tests and contract tests**

Run:

```bash
npx vitest run \
  lib/services/analysis/result-publication-authority-pglite.test.ts \
  lib/services/analysis/result-publication-guard-migration-contract.test.ts \
  lib/services/analysis/result-publication-authority.test.ts
```

Expected: all tests PASS.

- [ ] **Step 4: Commit the tested migration**

```bash
git add lib/services/analysis/result-publication-authority-pglite.test.ts \
  supabase/migrations/20260821080948_allow_completed_results_after_refund.sql
git commit -m "fix: preserve completed results after refund"
```

### Task 3: Apply exactly one production migration

**Files:**
- Apply only: `supabase/migrations/20260821080948_allow_completed_results_after_refund.sql`

- [ ] **Step 1: Create an isolated temporary Supabase workdir**

Use `mktemp -d` and copy only `supabase/config.toml` plus the new migration into its `supabase/migrations` directory. Do not copy unrelated pending migrations.

- [ ] **Step 2: Verify the migration allowlist with dry-run**

Run `supabase db push --linked --project-ref ddfugwqninkkofkgnbve --dry-run` from the isolated workdir.

Expected: exactly `20260821080948_allow_completed_results_after_refund.sql` is listed.

- [ ] **Step 3: Push once and verify remote history**

Run the same command without `--dry-run`, then query `supabase migration list --linked --project-ref ddfugwqninkkofkgnbve`.

Expected: the local and remote migration timestamp both appear once.

- [ ] **Step 4: Audit the delivered scope without exposing identifiers**

Query the 27 completed orders paid since `2026-08-11 00:00 Asia/Seoul` plus the data-bearing `316zz.z` request. Return only aggregate counts and target handles.

Expected: 28 scoped pages, 28 completed requests, and 28 publication-authorized results; `316zz.z` remains `refunded` with completed fulfillment.

### Task 4: Complete media persistence and production verification

**Files:**
- No repository file changes.

- [ ] **Step 1: Finish the tenth-token-only recollection process**

Expected: no Apify slot other than `tenth` is configured or used; every successful fresh profile image is written under its stable R2 key.

- [ ] **Step 2: Enable the production cache flag and redeploy**

Update `CONCIERGE_IMAGE_PROXY_CACHE_ENABLED=true` for production, redeploy the current production commit, and wait for `READY`.

- [ ] **Step 3: Verify persistence and page access**

Confirm the R2 sample parity checks pass, the image proxy returns cached content, and the exact delivered cohort remains 28/28 publication-authorized.
