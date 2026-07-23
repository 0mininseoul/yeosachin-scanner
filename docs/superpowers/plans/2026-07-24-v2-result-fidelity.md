# V2 Result Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist trustworthy V2 gender totals, deploy the backend result contract, and produce a fresh completed Plus E2E result with real profile, commentary, and private-name ordering data.

**Architecture:** A required `genderStats` object crosses the public TypeScript contract. A PostgreSQL `BEFORE INSERT` trigger derives the aggregate from terminal candidate rows inside the existing atomic finalization transaction, before staging purge, while a guarded migration backfills the one existing result. The internal result-store reader temporarily accepts pre-migration DB summaries and normalizes them to an all-unknown aggregate, allowing code-first deployment without API downtime. The separate frontend session consumes this API field and owns all display-only changes.

**Tech Stack:** Next.js, TypeScript, Zod, Vitest, PGlite, PostgreSQL/Supabase, Cloud Run, Cloud Tasks, Vercel

---

### Task 1: Lock the public result contract

**Files:**
- Modify: `lib/contracts/analysis-v2.test.ts`
- Modify: `lib/contracts/analysis-v2.ts`

- [x] **Step 1: Write the failing contract tests**

Add valid totals to summary fixtures and assertions that a missing object or a sum different from `screenedMutuals` is rejected:

```ts
genderStats: { male: 1, female: 1, unknown: 1 },
```

```ts
expect(analysisResultSummaryV1Schema.safeParse({
    ...legacy,
    genderStats: { male: 1, female: 1, unknown: 0 },
}).success).toBe(false);
```

- [x] **Step 2: Run the contract test and verify it fails**

Run: `npx vitest run lib/contracts/analysis-v2.test.ts`

Expected: FAIL because `genderStats` is not part of the strict schema.

- [x] **Step 3: Add the minimal strict schema**

Add this required object to `analysisResultSummaryV1Schema`:

```ts
genderStats: z.object({
    male: z.number().int().nonnegative(),
    female: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
}).strict(),
```

Add a refinement:

```ts
if (
    value.genderStats.male
        + value.genderStats.female
        + value.genderStats.unknown
    !== value.screenedMutuals
) {
    context.addIssue({
        code: 'custom',
        message: 'Gender totals must equal the screened public mutual count.',
        path: ['genderStats'],
    });
}
```

- [x] **Step 4: Run the contract test and verify it passes**

Run: `npx vitest run lib/contracts/analysis-v2.test.ts`

Expected: PASS.

- [x] **Step 5: Commit the contract**

```bash
git add lib/contracts/analysis-v2.ts lib/contracts/analysis-v2.test.ts
git commit -m "feat: add v2 result gender stats contract"
```

### Task 2: Prove the durable PostgreSQL behavior

**Files:**
- Create: `lib/services/analysis/v2-result-gender-stats-migration-contract.test.ts`
- Create: `lib/services/analysis/v2-result-gender-stats-pglite.test.ts`
- Modify: `supabase/migrations/20260723191547_persist_analysis_v2_gender_stats.sql`

- [x] **Step 1: Write failing migration contract tests**

Require the migration to add all three columns, a total constraint, a trigger that maps the two verified classes explicitly, a guarded legacy backfill, and `genderStats` JSON:

```ts
expect(migration).toContain('male_count SMALLINT');
expect(migration).toContain('female_count SMALLINT');
expect(migration).toContain('unknown_count SMALLINT');
expect(populator).toContain("terminal_classification = 'verified_non_female'");
expect(populator).toContain("terminal_classification = 'verified_female'");
expect(summaryJson).toContain("'genderStats'");
```

- [x] **Step 2: Write failing focused PGlite tests**

Create minimal legacy tables, apply the migration, and assert:

```sql
SELECT male_count, female_count, unknown_count
FROM public.analysis_v2_result_summaries
WHERE request_id = $1
```

The cases must cover valid legacy JSON backfill, safe female/unknown fallback, new insert classification mapping, and rejection when staged totals do not equal `screened_mutuals`.

- [x] **Step 3: Run both tests and verify they fail**

Run:

```bash
npx vitest run \
  lib/services/analysis/v2-result-gender-stats-migration-contract.test.ts \
  lib/services/analysis/v2-result-gender-stats-pglite.test.ts
```

Expected: FAIL because the generated migration is empty.

- [x] **Step 4: Implement the migration**

Add nullable columns, backfill, set `NOT NULL`, and add:

```sql
CHECK (
    male_count >= 0
    AND female_count >= 0
    AND unknown_count >= 0
    AND male_count + female_count + unknown_count = screened_mutuals
)
```

Create an RPC-inaccessible trigger function that sets:

```sql
NEW.female_count := count(*) FILTER (
    WHERE terminal_classification = 'verified_female'
);
NEW.male_count := count(*) FILTER (
    WHERE terminal_classification = 'verified_non_female'
);
NEW.unknown_count := count(*) FILTER (
    WHERE terminal_classification NOT IN ('verified_female', 'verified_non_female')
);
```

Raise `ANALYSIS_V2_RESULT_NOT_READY` when the total differs from `NEW.screened_mutuals`, and replace `analysis_v2_result_summary_json` so it emits:

```sql
'genderStats', pg_catalog.jsonb_build_object(
    'male', p_summary.male_count,
    'female', p_summary.female_count,
    'unknown', p_summary.unknown_count
)
```

- [x] **Step 5: Run the focused migration tests and verify they pass**

Run the two-test command from Step 3.

Expected: PASS.

- [x] **Step 6: Commit the migration**

```bash
git add \
  supabase/migrations/20260723191547_persist_analysis_v2_gender_stats.sql \
  lib/services/analysis/v2-result-gender-stats-migration-contract.test.ts \
  lib/services/analysis/v2-result-gender-stats-pglite.test.ts
git commit -m "feat: persist v2 result gender stats"
```

### Task 3: Carry gender totals through the result store

**Files:**
- Modify: `lib/services/analysis/v2-result-store.test.ts`
- Modify: `lib/services/analysis/v2-result-route.test.ts`
- Modify: `lib/services/analysis/v2-ai-scoring-executors.test.ts`
- Modify: `lib/services/analysis/v2-result-store.ts`

- [x] **Step 1: Update fixtures and write the failing result-store assertion**

Add coherent `genderStats` to every raw summary fixture and assert a loaded owner snapshot preserves the counts:

```ts
expect(first?.summary.genderStats).toEqual({
    male: 0,
    female: 2,
    unknown: 0,
});
```

- [x] **Step 2: Run focused store and route tests**

Run:

```bash
npx vitest run \
  lib/services/analysis/v2-result-store.test.ts \
  lib/services/analysis/v2-result-route.test.ts \
  lib/services/analysis/v2-ai-scoring-executors.test.ts
```

Expected: FAIL until all strict raw-summary fixtures and parsing paths include the new field.

- [x] **Step 3: Make the minimal store changes**

Keep `analysisResultSummaryV1Schema` strict. At the internal DB boundary, accept a missing pre-migration `genderStats` and normalize it to all-unknown so the code can be deployed before the migration without breaking existing reads. Preserve real persisted counts whenever they are present.

- [x] **Step 4: Run focused tests and verify they pass**

Run the command from Step 2.

Expected: PASS.

- [x] **Step 5: Commit the store boundary**

```bash
git add \
  lib/services/analysis/v2-result-store.ts \
  lib/services/analysis/v2-result-store.test.ts \
  lib/services/analysis/v2-result-route.test.ts \
  lib/services/analysis/v2-ai-scoring-executors.test.ts
git commit -m "feat: expose v2 result gender stats"
```

### Task 4: Verify and review the backend

**Files:**
- Verify all files changed in Tasks 1–3

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run \
  lib/contracts/analysis-v2.test.ts \
  lib/services/analysis/v2-result-store.test.ts \
  lib/services/analysis/v2-result-route.test.ts \
  lib/services/analysis/v2-ai-scoring-executors.test.ts \
  lib/services/analysis/v2-result-gender-stats-migration-contract.test.ts \
  lib/services/analysis/v2-result-gender-stats-pglite.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the full verification suite**

Run:

```bash
npm test -- --run
npm run lint
npx tsc --noEmit
npm run build
supabase db lint --linked
```

Expected: every command exits zero.

- [ ] **Step 3: Review the diff**

Run:

```bash
git diff origin/main...HEAD --check
git diff --stat origin/main...HEAD
git status --short
```

Expected: no whitespace errors, no frontend files, and only the approved backend, tests, migration, and plan documents.

- [ ] **Step 4: Request code review and fix actionable findings**

Review security, transactional behavior, legacy backfill, strict API compatibility, and migration lock scope. Re-run focused verification after each fix.

### Task 5: Merge, migrate, and deploy

**Files:**
- No new source files

- [ ] **Step 1: Push the branch and open a PR**

Push `fix/v2-result-fidelity`, open a PR against `main`, and wait for required CI.

- [ ] **Step 2: Merge only after CI and review pass**

Confirm the merge commit is reachable from `origin/main`.

- [ ] **Step 3: Apply pending migrations in order**

Run a dry-run first, inspect the complete migration set, then apply it to the linked production project. Verify `analysis_v2_result_summaries` has non-null coherent totals and the result JSON RPC includes `genderStats`.

- [ ] **Step 4: Deploy production and the active E2E worker**

Deploy the exact merged commit to Vercel and `analysis-worker-secondary-e2e`. Keep test sharding disabled unless the approved runbook explicitly requires otherwise.

- [ ] **Step 5: Run post-deploy canaries**

Verify production readiness, worker revision and traffic, scheduler target, empty queues, recovery health, owner result route, and image-proxy authorization.

### Task 6: Run and verify the fresh Plus E2E

**Files:**
- No source changes unless the run exposes a reproducible defect

- [ ] **Step 1: Perform a read-only paid-call readiness check**

Confirm available Apify slot, provider quota, Gemini policy, queue health, no active target request, and bounded maximum cost. Do not start unless every gate passes.

- [ ] **Step 2: Create one authorized Plus run**

Use the existing logged-in owner session and the durable test-entitlement flow. Start exactly one run for the approved target and skip exclusion.

- [ ] **Step 3: Monitor to a terminal state**

Monitor jobs, provider runs, reconciliation, and progress without issuing duplicate starts. Recover only through the documented durable recovery path.

- [ ] **Step 4: Verify the completed archive result**

Check aggregate invariants without exposing account identifiers:

```text
current proxy images load
account summaries are genuinely distinct AI outputs
private rows follow persisted name-female score/confidence order
male + female + unknown equals screened public mutuals
followers/following use declared Instagram counts
no screening-detail counts are displayed
risk scores are integers
threat meters contain ten segments
```

- [ ] **Step 5: Preserve the completed result and clean temporary resources**

Keep the successful archive entry, leave the old sample untouched, remove only temporary E2E credentials/files, and verify queues and scheduler return to the intended steady state.
