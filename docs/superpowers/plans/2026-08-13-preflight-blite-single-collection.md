# Preflight + B-lite Single-Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship and safely roll out one-Apify-collection preflight + asynchronous B-lite with a preflight-owned bounded source artifact, irreversible normal/fallback UI latch, exact 12-second demo, and migration-first production release.

**Architecture:** One preflight provider run returns the only target profile/feed snapshot. A single transactional RPC persists the cohort/deadline, ready snapshot, and bounded source artifact; an authenticated Cloud Task then leases B-lite inference from that source while a status-only browser route reports `pending|complete|failed`. The page uses the original accepted timestamp and one irreversible `normal|fallback` latch: valid B-lite before T+48 enters the approved user-driven path, while terminal failure or T+48 unresolved runs the same unskippable 12-second demo exactly once and atomically reveals legacy account card + plans by T+60.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Zod, Vitest/jsdom, Supabase PostgreSQL/RLS/RPC, PGlite/PostgreSQL concurrency tests, Google Cloud Tasks, Apify, Gemini, Axiom/Sentry, Vercel through GitHub `main` only.

---

## 0. Baseline, invariants, and execution DAG

The approved specification is `docs/superpowers/specs/2026-08-13-preflight-blite-single-collection-design.md` at `27d8df930a6b54e08bfdfd89e39e1c9aa6d4af7b`. Every worker starts by running:

Implementation invariants: the UI owns exactly one `pathLatch: 'normal' | 'fallback'`; both demo modes run exactly 12 seconds with no skip; and no fallback state, demo event, timeout, refresh, retry, or late-result handler may start an Instagram collection.

```bash
git status --short --branch
git rev-parse HEAD
git merge-base --is-ancestor 27d8df930a6b54e08bfdfd89e39e1c9aa6d4af7b HEAD
```

Expected: clean branch, the expected task branch, and exit 0 from the ancestry check. Workers are not alone in the repository: never reset, clean, overwrite, or revert another track. Never touch `app/page.tsx` marketing copy, `.playwright-mcp/`, or `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql`.

### Track ownership

| Track | Branch from | Exclusive ownership | Dependency |
| --- | --- | --- | --- |
| A — PR #368 observability | doc commit | #368 files: `lib/services/precheckout/blite-observability*`, observability schemas/tests/docs, minimal route/inference telemetry relocation | none; compare final PR first |
| B — database/source/output lifecycle | doc commit | migration `20260813130000`, source/output stores, migration/PGlite/concurrency/lifecycle tests | none |
| C — one collection + async worker/status | doc commit for Tasks 7–8; Tasks 9–11 run on integration after A+B+C1+C2 | preflight service/task/worker, source projection, inference runner, status-only route and route tests | A and B for Tasks 9–11 |
| D — irreversible UI latch/demo | doc commit for Tasks 12–13; Task 14 runs on integration after C and D1+D2 | `components/precheckout-*`, `app/analyze/page.tsx`, frontend contract/tests | C status DTO/deadline contract for Task 14 |
| E — integration/rollout/canary | integration branch after A+B+C+D | env/config docs, vercel runtime contract, canary/query/runbook and cross-track tests | all tracks |

### Parallel work and exact integration order

Create `integration/preflight-blite-single-collection` at the doc commit. Tracks A, B, C-pure (Tasks 7–8 only), and D-core (Task 12 reducer/demo only) may branch immediately from the doc commit. C must not wire stores/tasks/routes until B is integrated; C telemetry wiring waits for A. D must not wire status fetching or `app/analyze/page.tsx` until C publishes the exact status contract.

```bash
git branch integration/preflight-blite-single-collection 27d8df930a6b54e08bfdfd89e39e1c9aa6d4af7b
git branch track/a-blite-observability 27d8df930a6b54e08bfdfd89e39e1c9aa6d4af7b
git branch track/b-blite-persistence 27d8df930a6b54e08bfdfd89e39e1c9aa6d4af7b
git branch track/c-blite-runtime 27d8df930a6b54e08bfdfd89e39e1c9aa6d4af7b
git branch track/d-blite-ui 27d8df930a6b54e08bfdfd89e39e1c9aa6d4af7b
```

Expected: five branch refs are created; if a ref already exists, inspect its ancestry rather than force-moving it.

Cherry-pick complete track commits into the integration branch in this order:

```bash
git switch integration/preflight-blite-single-collection
git cherry-pick $(git rev-list --reverse 27d8df930a6b54e08bfdfd89e39e1c9aa6d4af7b..track/a-blite-observability)
git cherry-pick $(git rev-list --reverse 27d8df930a6b54e08bfdfd89e39e1c9aa6d4af7b..track/b-blite-persistence)
git cherry-pick $(git rev-list --reverse 27d8df930a6b54e08bfdfd89e39e1c9aa6d4af7b..track/c-blite-runtime)
# Execute Tasks 9–11 here and create C3, C4, C5 directly on integration.
git cherry-pick $(git rev-list --reverse 27d8df930a6b54e08bfdfd89e39e1c9aa6d4af7b..track/d-blite-ui)
# Execute Task 14 here and create D3 directly on integration, then execute Track E.
```

Expected: A has A1–A2, B has B1–B4, C parallel branch has C1–C2, and D parallel branch has D1–D2; every range is non-empty and every cherry-pick exits 0. C3–C5, D3, and Track E are created directly on integration in that order. If a track required a merge-fix commit, append it immediately after that track, never rewrite another track's commit. Run the named GREEN suite after each track group. Do not squash: frequent commits are intentional rollback/review boundaries.

---

## Track A — Reconcile PII-safe observability dependency PR #368

### Task 1: Import and verify PR #368 without duplicating telemetry

**Files:**
- Modify only if needed after comparison: `lib/services/precheckout/blite-observability.ts`
- Test: `lib/services/precheckout/blite-observability.test.ts`
- Modify: `lib/observability/schema.ts`
- Test: `lib/observability/schema.test.ts`
- Test: `lib/observability/pipeline-events.test.ts`
- Modify: `docs/axiom-observability-operations.md`
- Test: `lib/observability/operations-docs-contract.test.ts`

- [ ] **Step 1: Fetch and compare the live dependency**

```bash
git fetch origin pull/368/head:refs/remotes/origin/pr-368
gh pr view 368 --json state,mergeCommit,headRefOid,files,url
git diff --stat 27d8df930a6b54e08bfdfd89e39e1c9aa6d4af7b...origin/pr-368
git show --stat --oneline origin/pr-368
```

Expected: PR state and exact head are visible; changed files match the PII-safe adapter/schema/tests/runbook scope. If PR #368 is already merged into `origin/main`, record its merge SHA and cherry-pick/merge that SHA instead of its old head.

- [ ] **Step 2: Write the RED ownership tests before relocation**

Add cases to `lib/services/precheckout/blite-observability.test.ts` asserting bounded methods for collection ownership at preflight and B-lite outcomes:

```ts
expect(events).toEqual([
  { event: 'precheckout_blite.profile_collection_failed', preflight_id: PREFLIGHT_ID },
]);
expect(JSON.stringify(events)).not.toMatch(/username|caption|image|prompt|model_output|user_id/i);
```

Run:

```bash
npm test -- lib/services/precheckout/blite-observability.test.ts lib/observability/schema.test.ts
```

Expected RED: collection-stage adapter/fields are absent or still route-owned; at least the new ownership assertion fails.

- [ ] **Step 3: Integrate #368 and minimally generalize ownership**

Cherry-pick the final #368 commit(s), then keep its existing event names and allowlist. Expose an adapter input with no source PII:

```ts
export type BliteTerminalContext = Readonly<{
  preflightId: string;
  startedAtMs: number;
  now?: () => number;
}>;
```

Collection failure emission will be called by Track C after the single preflight Apify attempt. Cache hits, polls, access denial, business failures, pending leases, and fallback demo events must not synthesize provider attempts.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test -- lib/services/precheckout/blite-observability.test.ts lib/observability/schema.test.ts lib/observability/pipeline-events.test.ts lib/observability/operations-docs-contract.test.ts
git diff --check
git add lib/services/precheckout/blite-observability.ts lib/services/precheckout/blite-observability.test.ts lib/observability/schema.ts lib/observability/schema.test.ts lib/observability/pipeline-events.test.ts docs/axiom-observability-operations.md lib/observability/operations-docs-contract.test.ts
git commit -m "feat: reconcile B-lite operational observability"
```

Expected GREEN: all selected tests pass; commit is A1.

### Task 2: Add bounded fallback/SLA outcome dimensions

**Files:**
- Modify: `lib/services/precheckout/blite-observability.ts`
- Test: `lib/services/precheckout/blite-observability.test.ts`
- Modify: `lib/observability/schema.ts`
- Test: `lib/observability/schema.test.ts`
- Modify: `docs/axiom-observability-operations.md`

- [ ] **Step 1: Write RED tests for bounded outcomes**

Use only allowlisted values:

```ts
const reasons = ['terminal_before_48', 'unresolved_at_48', 'demo_error'] as const;
for (const reason of reasons) observability.fallbackLatched(reason);
expect(serialized).not.toMatch(/username|full_name|bio|caption|url|token|email/i);
```

Run:

```bash
npm test -- lib/services/precheckout/blite-observability.test.ts lib/observability/schema.test.ts
```

Expected RED: fallback latch/demo outcomes are not registered.

- [ ] **Step 2: Add only bounded events/dimensions**

Add `precheckout_blite.fallback_latched` and `precheckout_blite.demo_completed|demo_failed` only if #368's final schema cannot express them with an existing event plus `disposition`. Fields are limited to `preflight_id`, `operation`, `disposition`, `error_code`, `duration_ms`, `attempt`, and bounded model/token/cost fields already approved by #368.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- lib/services/precheckout/blite-observability.test.ts lib/observability/schema.test.ts lib/observability/pipeline-events.test.ts lib/observability/operations-docs-contract.test.ts
git add lib/services/precheckout/blite-observability.ts lib/services/precheckout/blite-observability.test.ts lib/observability/schema.ts lib/observability/schema.test.ts lib/observability/pipeline-events.test.ts docs/axiom-observability-operations.md lib/observability/operations-docs-contract.test.ts
git commit -m "feat: observe bounded B-lite fallback outcomes"
```

Expected GREEN: selected tests pass; commit is A2.

---

## Track B — Additive Supabase source/output state and lifecycle

### Task 3: Specify source projection and store contract

**Files:**
- Create: `lib/services/precheckout/blite-source.ts`
- Create: `lib/services/precheckout/blite-source.test.ts`

- [ ] **Step 1: Write RED projection tests**

Test exact bounds: 256 KiB JSON, 10 posts, 160-character captions, 15 hashtags/tags/mentions, four media references, 8,192-character URLs, 60-character full name, no external URL/video/raw bytes. Define the public contract in the test:

```ts
const source = projectPrecheckoutBliteSource(profile, lineage);
expect(source.schemaVersion).toBe(1);
expect(source.posts).toHaveLength(10);
expect(source.media).toHaveLength(4);
expect(JSON.stringify(source)).not.toContain(profile.externalUrl);
expect(Buffer.byteLength(JSON.stringify(source), 'utf8')).toBeLessThanOrEqual(256 * 1024);
```

Run:

```bash
npm test -- lib/services/precheckout/blite-source.test.ts
```

Expected RED: module/function does not exist.

- [ ] **Step 2: Implement the strict types and projection**

Define and export:

```ts
export const PRECHECKOUT_BLITE_SOURCE_SCHEMA_VERSION = 1 as const;
export const precheckoutBliteSourceV1Schema = z.object({
  schemaVersion: z.literal(1),
  fullName: z.string().max(60).nullable(),
  posts: z.array(bliteSourcePostSchema).max(10),
  media: z.array(bliteSourceMediaSchema).max(4),
}).strict();
export type PrecheckoutBliteSourceV1 = z.infer<typeof precheckoutBliteSourceV1Schema>;
```

`projectPrecheckoutBliteSource(profile)` must validate before returning and throw `PRECHECKOUT_BLITE_SOURCE_INVALID` or `PRECHECKOUT_BLITE_SOURCE_TOO_LARGE`, never raw PII.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- lib/services/precheckout/blite-source.test.ts lib/services/precheckout/blite-inference.test.ts
git add lib/services/precheckout/blite-source.ts lib/services/precheckout/blite-source.test.ts
git commit -m "feat: define bounded B-lite source projection"
```

Expected GREEN: projection and existing inference tests pass; commit is B1.

### Task 4: Write the additive migration with RED contract tests

**Files:**
- Create: `supabase/migrations/20260813130000_add_preflight_blite_single_collection.sql`
- Create: `lib/services/precheckout/blite-single-collection-migration-contract.test.ts`
- Create: `lib/services/precheckout/blite-single-collection-pglite.test.ts`
- Modify: `lib/services/precheckout/blite-store-migration-contract.test.ts`

- [ ] **Step 1: Write RED textual contract tests**

Assert exact schema/function names:

```ts
expect(migration).toContain('CREATE TABLE public.precheckout_blite_sources');
expect(migration).toContain("state IN ('pending', 'complete', 'failed')");
expect(migration).toContain('finalize_preflight_blite_source_v1');
expect(migration).toContain('claim_precheckout_blite_v2');
expect(migration).toContain('fail_precheckout_blite_v2');
expect(migration).toContain('purge_expired_precheckout_blite_sources_v1');
```

Run:

```bash
npm test -- lib/services/precheckout/blite-single-collection-migration-contract.test.ts lib/services/precheckout/blite-store-migration-contract.test.ts
```

Expected RED: migration is absent and old state check lacks `failed`.

- [ ] **Step 2: Implement one forward-only migration**

The migration must:

- add snapshotted `precheckout_blite_cohort BOOLEAN NOT NULL DEFAULT FALSE` and immutable `submitted_at/deadline_at` support without rewriting historical requests into the cohort;
- create `precheckout_blite_sources(preflight_id PK FK ON DELETE CASCADE, schema_version, target_input_hash, provider_run_id/reference, payload, payload_bytes, payload_hash, collected_at, expires_at, created_at, updated_at)`;
- enforce JSON object, 256 KiB, SHA-256 hex, `expires_at <= analysis_preflights.expires_at`, and `expires_at <= collected_at + interval '30 minutes'` inside RPC validation;
- extend `precheckout_blite_cache` to `pending|complete|failed`, add `attempt_count`, bounded `failure_reason`, and immutable terminal timestamps;
- provide service-role-only `finalize_preflight_blite_source_v1`, `claim_precheckout_blite_v2`, `complete_precheckout_blite_v2`, `fail_precheckout_blite_v2`, `read_precheckout_blite_status_v1`, and bounded purge RPCs;
- atomically write ready snapshot + source for authenticated and anonymous claims by replacing/wrapping the existing completion RPCs, with exact claim token/user/target-input/provider-run lineage fences;
- reject stale lease completion/failure, cap attempts at 2, permit lease steal only before T+56 with live source, and keep complete/failed immutable;
- enable/FORCE RLS, revoke `PUBLIC, anon, authenticated`, grant only `service_role`, and fully qualify/empty every security-definer search path;
- delete source/cache on `pii_scrubbed_at`, preflight cascade, account deletion, and retention independent of feature flags.

- [ ] **Step 3: Run contract GREEN and commit**

```bash
npm test -- lib/services/precheckout/blite-single-collection-migration-contract.test.ts lib/services/precheckout/blite-store-migration-contract.test.ts
git diff --check
git add supabase/migrations/20260813130000_add_preflight_blite_single_collection.sql lib/services/precheckout/blite-single-collection-migration-contract.test.ts lib/services/precheckout/blite-store-migration-contract.test.ts
git commit -m "feat: add single-collection B-lite persistence contract"
```

Expected GREEN: contract tests pass; commit is B2. Do not apply locally or remotely yet.

### Task 5: Prove database concurrency, lifecycle, and access

**Files:**
- Modify: `lib/services/precheckout/blite-single-collection-pglite.test.ts`
- Create: `lib/services/precheckout/blite-postgres-concurrency.integration.test.ts`
- Modify: `lib/services/analysis/preflight-retention.test.ts`
- Modify: `lib/services/identity/account-deletion-pglite.test.ts`

- [ ] **Step 1: Write RED PGlite and PostgreSQL cases**

Cover: same payload replay succeeds; different hash cannot overwrite; one concurrent owner; live pending returns pending; expired lease steal; stale completion/failure rejection; two attempts then `attempts_exhausted`; immutable complete/failed; source expiry; RLS denial; service-role RPC; PII scrub/cascade/account deletion/purge; cleanup with feature disabled.

Run:

```bash
npm test -- lib/services/precheckout/blite-single-collection-pglite.test.ts lib/services/analysis/preflight-retention.test.ts lib/services/identity/account-deletion-pglite.test.ts
```

Expected RED: at least source/lifecycle and failed-state cases fail.

- [ ] **Step 2: Correct the migration only**

Keep all fixes in `20260813130000_add_preflight_blite_single_collection.sql`; do not create correction migrations before the migration has shipped.

- [ ] **Step 3: Run GREEN including real PostgreSQL harness**

```bash
npm test -- lib/services/precheckout/blite-single-collection-pglite.test.ts lib/services/analysis/preflight-retention.test.ts lib/services/identity/account-deletion-pglite.test.ts
npm test -- lib/services/precheckout/blite-postgres-concurrency.integration.test.ts
```

Expected GREEN: all selected cases pass. If Docker/PostgreSQL is unavailable, record this as an environment blocker; do not claim concurrency GREEN from PGlite alone.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260813130000_add_preflight_blite_single_collection.sql lib/services/precheckout/blite-single-collection-pglite.test.ts lib/services/precheckout/blite-postgres-concurrency.integration.test.ts lib/services/analysis/preflight-retention.test.ts lib/services/identity/account-deletion-pglite.test.ts
git commit -m "test: prove B-lite source and lease lifecycle"
```

Expected: commit B3.

### Task 6: Upgrade server stores to exact v2 RPC contracts

**Files:**
- Modify: `lib/services/precheckout/blite-store.ts`
- Modify: `lib/services/precheckout/blite-store.test.ts`
- Create: `lib/services/precheckout/blite-source-store.ts`
- Create: `lib/services/precheckout/blite-source-store.test.ts`

- [ ] **Step 1: Write RED store tests**

Require discriminated results:

```ts
type Claim =
  | { disposition: 'claimed'; leaseToken: string; source: PrecheckoutBliteSourceV1; deadlineAt: string }
  | { disposition: 'pending' }
  | { disposition: 'complete'; dto: unknown; completedAt: string }
  | { disposition: 'failed'; reason: BliteFailureReason; failedAt: string };
```

Test exact v2 RPC names/params and malformed-response failure.

Run:

```bash
npm test -- lib/services/precheckout/blite-store.test.ts lib/services/precheckout/blite-source-store.test.ts
```

Expected RED: v2 methods/source store absent.

- [ ] **Step 2: Implement minimal validated stores**

Use `supabaseAdmin` by default. Export `claim`, `complete`, `fail`, `readStatus`, `finalizeReadyWithSource`, and `purgeExpired`; never expose the client or raw DB error message.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- lib/services/precheckout/blite-store.test.ts lib/services/precheckout/blite-source-store.test.ts
git add lib/services/precheckout/blite-store.ts lib/services/precheckout/blite-store.test.ts lib/services/precheckout/blite-source-store.ts lib/services/precheckout/blite-source-store.test.ts
git commit -m "feat: add B-lite source and terminal state stores"
```

Expected GREEN: selected tests pass; commit B4.

---

## Track C — One Apify snapshot, shared deadlines, async inference, status-only API

### Task 7: Define cohort and cumulative deadline policy

**Files:**
- Create: `lib/services/precheckout/blite-runtime-policy.ts`
- Create: `lib/services/precheckout/blite-runtime-policy.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write RED policy tests**

```ts
expect(selectBliteCohort(PREFLIGHT_ID, { PRECHECKOUT_BLITE_ENABLED: 'false' })).toBe(false);
expect(bliteDeadlines(submittedAt)).toEqual({ provider: t40, checkpoint: t43, fallback: t48, inference: t56, ux: t60 });
expect(() => selectBliteCohort(PREFLIGHT_ID, { PRECHECKOUT_BLITE_ENABLED: 'true', PRECHECKOUT_BLITE_ROLLOUT_PERCENT: '101' })).toThrow();
```

Run:

```bash
npm test -- lib/services/precheckout/blite-runtime-policy.test.ts
```

Expected RED: module absent.

- [ ] **Step 2: Implement deterministic policy**

Export constants `BLITE_PROVIDER_DEADLINE_MS=40_000`, `BLITE_CHECKPOINT_DEADLINE_MS=43_000`, `BLITE_FALLBACK_LATCH_MS=48_000`, `BLITE_INFERENCE_DEADLINE_MS=56_000`, `BLITE_UX_DEADLINE_MS=60_000`, and strict `0..100` cohort parsing. Stable hashing uses only preflight UUID and persists the result; signed test-entitlement force is server-side only.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- lib/services/precheckout/blite-runtime-policy.test.ts
git add lib/services/precheckout/blite-runtime-policy.ts lib/services/precheckout/blite-runtime-policy.test.ts .env.example
git commit -m "feat: define B-lite cohort and cumulative deadlines"
```

Expected GREEN: policy tests pass; commit C1.

### Task 8: Make inference consume the durable projection

**Files:**
- Modify: `lib/services/precheckout/blite-inference.ts`
- Modify: `lib/services/precheckout/blite-inference.test.ts`
- Modify: `lib/services/ai/image-preprocessing.ts` only if it lacks absolute deadline/AbortSignal propagation
- Test: `lib/services/ai/image-preprocessing.test.ts`

- [ ] **Step 1: Write RED source/deadline tests**

Call `inferPrecheckoutBlite(source, { requestId, abortSignal, deadlineAtMs, onAttemptTelemetry })`; prove four-image max, no Instagram profile fetch, T+56 abort, and no retry/media fetch without remaining budget.

Run:

```bash
npm test -- lib/services/precheckout/blite-inference.test.ts lib/services/ai/image-preprocessing.test.ts
```

Expected RED: inference expects `InstagramProfile` and lacks absolute deadline.

- [ ] **Step 2: Adapt inference minimally**

Use `PrecheckoutBliteSourceV1`; keep the existing DTO/prompt/bands and #368 telemetry callback. No source field widening.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- lib/services/precheckout/blite-inference.test.ts lib/services/ai/image-preprocessing.test.ts
git add lib/services/precheckout/blite-inference.ts lib/services/precheckout/blite-inference.test.ts lib/services/ai/image-preprocessing.ts lib/services/ai/image-preprocessing.test.ts
git commit -m "refactor: infer B-lite from durable source"
```

Expected GREEN: selected tests pass; commit C2. Omit unchanged image-preprocessing files from `git add`.

### Task 9: Persist one Apify snapshot with ready state

**Files:**
- Modify: `lib/services/analysis/preflight.ts`
- Modify: `lib/services/analysis/preflight.test.ts`
- Modify: `lib/services/analysis/preflight-provider-run.ts` only if a read-only lineage accessor is missing
- Test: `lib/services/analysis/preflight-provider-run.test.ts`
- Modify: `app/api/analysis/preflight/worker/route.ts`
- Test: `lib/services/analysis/preflight-worker-route.test.ts`

- [ ] **Step 1: Write RED one-collection tests**

For cohort requests, assert one `getFallbackProfile` call returns feed, both ready snapshot and `projectPrecheckoutBliteSource(profile)` receive that same object, the exact provider-run lineage is stored, and `finalizeReadyWithSource` occurs before inference dispatch. Assert `TARGET_PRIVATE`, `TARGET_NOT_FOUND`, `BETA_CAPACITY_UNAVAILABLE`, incomplete feed, and provider errors retain distinct outcomes and never dispatch Gemini.

Run:

```bash
npm test -- lib/services/analysis/preflight.test.ts lib/services/analysis/preflight-provider-run.test.ts lib/services/analysis/preflight-worker-route.test.ts
```

Expected RED: current summary path/finalize API cannot satisfy source assertions.

- [ ] **Step 2: Implement the cohort path**

Add dependencies rather than hidden globals:

```ts
processPreflight(preflightId, {
  projectBliteSource,
  finalizeReadyWithSource,
  enqueueBliteInference,
  now,
});
```

Choose cohort before provider work; bind/resume the existing provider ledger; call Apify full profile/feed exactly once with T+40 deadline and no B-lite run; derive eligibility and source from that object; atomically finalize through Track B; enqueue after commit. Non-cohort behavior stays unchanged.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- lib/services/analysis/preflight.test.ts lib/services/analysis/preflight-provider-run.test.ts lib/services/analysis/preflight-worker-route.test.ts
git add lib/services/analysis/preflight.ts lib/services/analysis/preflight.test.ts lib/services/analysis/preflight-provider-run.ts lib/services/analysis/preflight-provider-run.test.ts app/api/analysis/preflight/worker/route.ts lib/services/analysis/preflight-worker-route.test.ts
git commit -m "feat: checkpoint one preflight snapshot for B-lite"
```

Expected GREEN: selected tests pass and assert exactly one physical start; commit C3. Omit unchanged provider-run files.

### Task 10: Add idempotent B-lite Cloud Task inference

**Files:**
- Modify: `lib/services/analysis/preflight-tasks.ts`
- Modify: `lib/services/analysis/preflight-tasks.test.ts`
- Modify: `app/api/analysis/preflight/worker/route.ts`
- Modify: `lib/services/analysis/preflight-worker-route.test.ts`
- Create: `lib/services/precheckout/blite-runner.ts`
- Create: `lib/services/precheckout/blite-runner.test.ts`

- [ ] **Step 1: Write RED task/runner tests**

Add request kind `{ kind: 'precheckout_blite', preflightId }`, deterministic task ID ``preflight-blite-${preflightId.toLowerCase()}``, and runner cases for claimed/pending/complete/failed, terminal reason mapping, stale lease, two attempts, T+56 abort, late completion persistence, and source deletion after terminal. Assert no scraper import/call.

Run:

```bash
npm test -- lib/services/analysis/preflight-tasks.test.ts lib/services/analysis/preflight-worker-route.test.ts lib/services/precheckout/blite-runner.test.ts
```

Expected RED: task kind and runner absent.

- [ ] **Step 2: Implement minimal queue/runner wiring**

Reuse the existing `/api/analysis/preflight/worker` OIDC verification and queue. `runPrecheckoutBlite(preflightId, dependencies)` claims Track B, calls Track C inference with T+56 signal, checkpoints complete/failed with lease token, and uses Track A terminal telemetry. Never call or import `getInstagramProfile`.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- lib/services/analysis/preflight-tasks.test.ts lib/services/analysis/preflight-worker-route.test.ts lib/services/precheckout/blite-runner.test.ts lib/services/precheckout/blite-observability.test.ts
git add lib/services/analysis/preflight-tasks.ts lib/services/analysis/preflight-tasks.test.ts app/api/analysis/preflight/worker/route.ts lib/services/analysis/preflight-worker-route.test.ts lib/services/precheckout/blite-runner.ts lib/services/precheckout/blite-runner.test.ts
git commit -m "feat: run B-lite inference as an idempotent task"
```

Expected GREEN: selected tests pass; commit C4.

### Task 11: Convert the browser endpoint to status-only

**Files:**
- Create: `lib/services/precheckout/blite-status-contract.ts`
- Create: `lib/services/precheckout/blite-status-contract.test.ts`
- Modify: `app/api/analysis/precheckout-blite/route.ts`
- Modify: `app/api/analysis/precheckout-blite/route.test.ts`

- [ ] **Step 1: Write RED contract/route tests**

Define strict responses:

```ts
type BliteStatusV1 =
  | { state: 'pending'; submittedAt: string; deadlineAt: string; fallbackAt: string; retryAfterMs: number }
  | { state: 'complete'; submittedAt: string; deadlineAt: string; fallbackAt: string; completedAt: string; dto: PrecheckoutBliteV1 }
  | { state: 'failed'; submittedAt: string; deadlineAt: string; fallbackAt: string };
```

Test owner/anonymous claim, flag/cohort, `200 complete`, `202 pending`, `204 unavailable/business/access`, strict no-store headers, and imports/calls: no scraper, Gemini, generation claim, or task dispatch.

Run:

```bash
npm test -- lib/services/precheckout/blite-status-contract.test.ts app/api/analysis/precheckout-blite/route.test.ts
```

Expected RED: contract absent; route still scrapes/infers.

- [ ] **Step 2: Implement status-only route**

Keep current owner/anonymous claim checks, read Track B status, validate Track C contract, and cap `retryAfterMs` to 500–2,000. Remove in-process DTO generation/in-flight maps and scraper/Gemini imports. Set route `maxDuration` no higher than 15 seconds.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- lib/services/precheckout/blite-status-contract.test.ts app/api/analysis/precheckout-blite/route.test.ts
git add lib/services/precheckout/blite-status-contract.ts lib/services/precheckout/blite-status-contract.test.ts app/api/analysis/precheckout-blite/route.ts app/api/analysis/precheckout-blite/route.test.ts
git commit -m "refactor: make precheckout B-lite status-only"
```

Expected GREEN: route tests prove zero provider/model work; commit is C5 and is integrated before every D commit.

---

## Track D — Irreversible UI latch and exact demo flows

### Task 12: Build a pure deterministic page-flow reducer

**Files:**
- Create: `lib/services/precheckout/blite-page-flow.ts`
- Create: `lib/services/precheckout/blite-page-flow.test.ts`

- [ ] **Step 1: Write RED reducer tests**

Define states `legacy|preflight_failed|blite_pending|blite_ready|success_demo|fallback_demo|fallback_legacy` and events `BLITE_COMPLETE|BLITE_FAILED|FALLBACK_AT_48|SUCCESS_CTA|DEMO_COMPLETE|DEMO_ERROR`. Test one irreversible `normal|fallback` latch, terminal failure at arbitrary `F<48`, T+48 unresolved, duplicate/remount events, late non-swap, business failure, and user inactivity in `blite_ready`.

Run:

```bash
npm test -- lib/services/precheckout/blite-page-flow.test.ts
```

Expected RED: reducer absent.

- [ ] **Step 2: Implement pure reducer**

```ts
export type PathLatch = null | 'normal' | 'fallback';
export type BlitePageState = Readonly<{ view: BliteView; pathLatch: PathLatch; demoStartedAtMs: number | null }>;
export function reduceBlitePage(state: BlitePageState, event: BlitePageEvent): BlitePageState;
```

Once latched, reject opposite/duplicate transitions. `DEMO_ERROR` from fallback goes directly to `fallback_legacy`.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- lib/services/precheckout/blite-page-flow.test.ts
git add lib/services/precheckout/blite-page-flow.ts lib/services/precheckout/blite-page-flow.test.ts
git commit -m "feat: define irreversible B-lite page flow"
```

Expected GREEN: reducer tests pass; commit D1.

### Task 13: Extract and harden the exact 12-second demo

**Files:**
- Create: `components/precheckout-demo.tsx`
- Create: `components/precheckout-demo.test.tsx`
- Modify: `components/precheckout-immersive.tsx`
- Modify: `components/precheckout-immersive.test.tsx`

- [ ] **Step 1: Write RED demo tests**

Use fake `requestAnimationFrame`/timers. Assert four ordered stages, duration exactly 12,000 ms, no skip button, `onComplete` exactly once, remount/effect replay does not duplicate, body overflow cleanup, and `onError` on render/runtime/asset boundary. Reduced motion may remove animation but must preserve the 12-second fallback timing and no-skip contract.

Run:

```bash
npm test -- components/precheckout-demo.test.tsx components/precheckout-immersive.test.tsx
```

Expected RED: reusable exact demo and error callback absent; existing reduced-motion behavior completes immediately.

- [ ] **Step 2: Extract one shared demo**

Export:

```ts
export function PrecheckoutDemo(props: {
  mode: 'success' | 'fallback';
  startedAtMs: number;
  onComplete: () => void;
  onError: () => void;
}): React.ReactNode;
```

Both modes use identical stages/durations/assets and no skip. Success CTA starts it; fallback latch starts it automatically.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- components/precheckout-demo.test.tsx components/precheckout-immersive.test.tsx
git add components/precheckout-demo.tsx components/precheckout-demo.test.tsx components/precheckout-immersive.tsx components/precheckout-immersive.test.tsx
git commit -m "refactor: share the exact precheckout demo"
```

Expected GREEN: both suites pass; commit D2.

### Task 14: Wire status polling and atomic card/plans reveal

**Files:**
- Modify: `components/precheckout-immersive.tsx`
- Modify: `components/precheckout-immersive.test.tsx`
- Modify: `app/analyze/page.tsx`
- Create: `lib/services/analysis/precheckout-page-contract.test.ts`
- Modify: `hooks/useAnalysisV2Preflight.ts` only if accepted/status timestamps are not exposed
- Test: `lib/services/analysis/preflight-client-races.test.ts`

- [ ] **Step 1: Write RED integration/UI cases**

Test normal complete before fallback; terminal failed at F starts immediate 12s fallback; pending at T+48 latches; fallback plans at F+12/T+60; late result cache/non-swap; refresh uses only `completedAt<=T+56` and live source/deadline; business blocked reason no demo/plans; demo error immediate legacy; account card and plans change in one React commit; hidden controls not focusable; user inactivity in `blite_ready` does not fallback.

Run:

```bash
npm test -- components/precheckout-immersive.test.tsx lib/services/analysis/precheckout-page-contract.test.ts lib/services/analysis/preflight-client-races.test.ts
```

Expected RED: account card renders outside the gate; old availability boolean cannot express states.

- [ ] **Step 2: Implement one page-owned state**

Replace `onAvailabilityChange(boolean)` with a typed state callback from the reducer. Move the legacy account card and plan section under the same render switch in `app/analyze/page.tsx`. Anchor timers to server `submittedAt/fallbackAt`; `Date.now()` may calculate remaining delay once, then a monotonic timer owns elapsed time. Poll the status-only route; no browser handler requests collection/inference.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- components/precheckout-immersive.test.tsx components/precheckout-demo.test.tsx lib/services/precheckout/blite-page-flow.test.ts lib/services/analysis/precheckout-page-contract.test.ts lib/services/analysis/preflight-client-races.test.ts
git add components/precheckout-immersive.tsx components/precheckout-immersive.test.tsx app/analyze/page.tsx lib/services/analysis/precheckout-page-contract.test.ts hooks/useAnalysisV2Preflight.ts lib/services/analysis/preflight-client-races.test.ts
git commit -m "feat: latch B-lite success and fallback UI"
```

Expected GREEN: all UI/state/race tests pass; commit D3. Omit unchanged hook/race files.

---

## Track E — Integration, full verification, migration-first rollout, and canary

### Task 15: Add cross-track runtime/config and coverage contracts

**Files:**
- Modify: `vercel.json`
- Modify: `next.config.ts` if external package tracing needs the new worker kind
- Create: `lib/services/precheckout/blite-runtime-integration.test.ts`
- Modify: `lib/observability/operations-docs-contract.test.ts`
- Modify: `docs/axiom-observability-operations.md`
- Create: `docs/preflight-blite-single-collection-runbook.md`

- [ ] **Step 1: Write RED integration contracts**

Assert worker `maxDuration` is 75 seconds, status route <=15 seconds, master flag false and rollout 0 by default, migration name is the only new pending migration, no scraper import in status/runner/frontend, source cleanup remains flag-independent, and the runbook contains migration-first/GitHub-main-only/canary/rollback commands.

Run:

```bash
npm test -- lib/services/precheckout/blite-runtime-integration.test.ts lib/observability/operations-docs-contract.test.ts
```

Expected RED: runtime/runbook contract absent.

- [ ] **Step 2: Add minimal config/runbook changes**

Set the trusted preflight worker function to `maxDuration: 75` and status route to `15` in the authoritative supported config. Document cohort `false/0`, exact Axiom queries for p50/p95/p99, terminal-before-48, unresolved-at-48, demo duration/error, T+60 guard, late non-swap, Apify physical-start count, Gemini cost/tokens, and PII field absence.

- [ ] **Step 3: Run GREEN and commit**

```bash
npm test -- lib/services/precheckout/blite-runtime-integration.test.ts lib/observability/operations-docs-contract.test.ts
git add vercel.json next.config.ts lib/services/precheckout/blite-runtime-integration.test.ts lib/observability/operations-docs-contract.test.ts docs/axiom-observability-operations.md docs/preflight-blite-single-collection-runbook.md
git commit -m "docs: add single-collection B-lite rollout gates"
```

Expected GREEN: contract tests pass; commit E1. Omit unchanged `next.config.ts`.

### Task 16: Run the complete local release gate

**Files:** no new production files unless a failing test identifies an in-scope defect; every fix gets its own RED/GREEN commit.

- [ ] **Step 1: Run focused suites**

```bash
npm test -- \
  lib/services/precheckout/blite-source.test.ts \
  lib/services/precheckout/blite-store.test.ts \
  lib/services/precheckout/blite-source-store.test.ts \
  lib/services/precheckout/blite-runtime-policy.test.ts \
  lib/services/precheckout/blite-inference.test.ts \
  lib/services/precheckout/blite-runner.test.ts \
  lib/services/precheckout/blite-status-contract.test.ts \
  lib/services/precheckout/blite-page-flow.test.ts \
  lib/services/precheckout/blite-observability.test.ts \
  app/api/analysis/precheckout-blite/route.test.ts \
  components/precheckout-demo.test.tsx \
  components/precheckout-immersive.test.tsx \
  lib/services/analysis/preflight.test.ts \
  lib/services/analysis/preflight-worker-route.test.ts \
  lib/services/analysis/preflight-tasks.test.ts \
  lib/services/analysis/preflight-retention.test.ts \
  lib/services/identity/account-deletion-pglite.test.ts
```

Expected GREEN: all named suites pass with zero failures.

- [ ] **Step 2: Run database and repository gates**

```bash
npm test -- lib/services/precheckout/blite-single-collection-pglite.test.ts
npm test -- lib/services/precheckout/blite-postgres-concurrency.integration.test.ts
npm test
npm run lint
npx tsc --noEmit
npm run build
git diff --check
git status --short
```

Expected GREEN: all tests/lint/typecheck/build pass; diff check exits 0; status contains only intentional implementation/runbook changes. Do not substitute partial results for a failed full suite.

- [ ] **Step 3: Stop on an unplanned integration defect**

If any command fails, do not make an unplanned catch-all edit. Record the exact failing command/output, add a new numbered TDD task to this plan naming the discovered test and production file paths, then execute its RED/minimal-GREEN/commit sequence. Expected: Task 16 finishes with no unexplained failures and no mixed integration commit.

### Task 17: Migration-first remote production rollout

**Files:** no repository edits unless verification reveals a documented mismatch. This task changes production and must retain an operator transcript without secrets/PII.

- [ ] **Step 1: Confirm approvals, exact Git state, and disabled gates**

```bash
git fetch origin main
git log --oneline --decorate -5
git status --short
BLITE_PR_NUMBER="$(gh pr view --json number --jq .number)"
test -n "$BLITE_PR_NUMBER"
gh pr checks "$BLITE_PR_NUMBER"
```

Expected: implementation PR is review-approved and green; worktree clean; `PRECHECKOUT_BLITE_ENABLED=false` and rollout percent `0` remain the intended production values. Do not read or print secret values.

- [ ] **Step 2: Create an isolated Supabase workdir containing only the approved migration**

```bash
BLITE_DB_WORKDIR="$(mktemp -d)"
mkdir -p "$BLITE_DB_WORKDIR/supabase/migrations"
cp supabase/config.toml "$BLITE_DB_WORKDIR/supabase/config.toml"
cp supabase/migrations/20260813130000_add_preflight_blite_single_collection.sql "$BLITE_DB_WORKDIR/supabase/migrations/"
find "$BLITE_DB_WORKDIR/supabase/migrations" -maxdepth 1 -type f -print
```

Expected: exactly one migration file is printed. Record the explicit path; never use `supabase db push --include-all`.

- [ ] **Step 3: Link using existing authenticated CLI metadata, dry-run, and verify allowlist**

From the isolated workdir, use the already approved linked project reference without printing credentials:

```bash
cd "$BLITE_DB_WORKDIR"
test -n "${BLITE_PROJECT_REF:-}"
supabase link --project-ref "$BLITE_PROJECT_REF"
supabase db push --dry-run
```

Expected: dry-run lists only `20260813130000_add_preflight_blite_single_collection.sql`. If any other migration appears, stop.

- [ ] **Step 4: Apply once and verify remote history before any retry**

```bash
supabase db push
supabase migration list
```

Expected: the exact migration is remote/applied once. If `db push` hangs after apply, do not rerun; open a second terminal, verify `supabase migration list` and read-only schema/RPC checks, then terminate the hung client only after proof.

- [ ] **Step 5: Verify DB security/lifecycle read-only**

Run the runbook's read-only SQL checks through the authenticated CLI: table/RPC existence, RLS/FORCE RLS, grants only to service role, function search paths, trigger presence, source TTL constraints, and migration history. Expected: every assertion returns the documented single row/boolean; no user UUID/source payload is selected.

- [ ] **Step 6: Merge through GitHub main only**

```bash
gh pr merge "$BLITE_PR_NUMBER" --merge --delete-branch
git fetch origin main
git log -1 --oneline origin/main
```

Expected: implementation merge is the `origin/main` head. Do not invoke `vercel deploy`, `vercel --prod`, or any direct deployment API. GitHub `main` integration is the only Vercel production path.

- [ ] **Step 7: Verify deployed disabled revision**

Use the normal Vercel/GitHub deployment status UI or read-only CLI/API documented in the runbook. Expected: `main` SHA is serving, status route performs no provider/model work, worker runtime is 75 seconds, retention succeeds, and production behavior remains legacy because master flag is false/percent 0.

### Task 18: Canary and staged expansion

**Files:** no code changes. Configuration changes go through reviewed GitHub `main` commits/PRs, never direct Vercel deployment.

- [ ] **Step 1: Run signed internal test-entitlement canaries**

Use only explicitly authorized public fixtures. Expected for each: one provider-ledger logical/physical start, source/ready same lineage, no Gemini wait for readiness, correct normal/fallback/demo behavior, deletion/retention proof, and PII-safe logs. Private/not-found/capacity fixtures must show explicit failure with no demo/plans.

- [ ] **Step 2: Query the 24-hour/30-profile acceptance window**

Run the checked-in Axiom and DB read-only queries. Expected:

- zero duplicate Apify starts;
- 100% ready cohort rows had source at readiness;
- eligible normal-success submit-to-card+B-lite p95 <=60s, with p50/p95/p99 recorded;
- terminal failure before T+48 starts fallback immediately;
- unresolved T+48 starts exactly one 12s, four-stage, no-skip demo;
- zero eligible fallback paths hide plans after T+60;
- zero late-result current-page swaps;
- demo errors immediately reveal legacy card+plans;
- no source beyond expiry +10m; zero forbidden log fields;
- Gemini attempts/tokens/media/cost and fallback ratio recorded.

- [ ] **Step 3: Expand through reviewed configuration PRs**

Apply stages `internal forced -> 1% -> 5% -> 25% -> 100%`. At each stage wait for the full acceptance window and attach query output before the next GitHub/main merge. `PRECHECKOUT_BLITE_ENABLED` remains the master kill switch.

- [ ] **Step 4: Roll back safely on any gate failure**

Through a reviewed GitHub/main configuration change, set rollout percent to `0` or master flag false. Expected: legacy account card + plans return; additive schema and retention remain active; in-flight work drains/terminalizes without recollection. Do not alter `payment_pending`, delete provider ledgers, disable retention, roll back migrations destructively, or deploy directly to Vercel.

---

## Spec coverage self-check

| Approved requirement | Implemented/proved by |
| --- | --- |
| Exactly one Apify target profile/feed collection | Tasks 9, 10, 16, 18 |
| Same snapshot for eligibility/ready/source | Tasks 3, 4, 9 |
| New preflight-owned 256 KiB/10-post/4-media/30m source, no bytes | Tasks 3–6 |
| Service-role-only, RLS, lineage, leases, terminal output states | Tasks 4–6 |
| Account deletion, PII scrub, cascade, retention, feature-independent cleanup | Tasks 4–6, 16 |
| Explicit private/not-found/capacity/provider reasons | Tasks 9, 11, 14, 18 |
| Readiness does not wait for Gemini | Tasks 9–10, 18 |
| Submission clock and T+40/T+43/T+48/T+56/T+60 | Tasks 7, 9–14 |
| Status-only API; no browser scraper/Gemini | Task 11 and Task 15 contract |
| Durable terminal failure and idempotent two-attempt lease | Tasks 4–6, 10 |
| Normal B-lite -> CTA -> exact 12s four-stage no-skip demo -> plans | Tasks 12–14 |
| Terminal-before-48 immediate fallback demo | Tasks 12, 14, 18 |
| T+48 unresolved latch; legacy card+plans by T+60 | Tasks 12, 14, 18 |
| Late result cached, current page never swaps; bounded refresh reuse | Tasks 10, 12, 14 |
| Business failures no demo/plans | Tasks 9, 12, 14, 18 |
| Demo error immediate legacy fail-open | Tasks 12–14 |
| No recollection in fallback/retry/late paths | Tasks 9–11, 14–16 |
| Successful path user inactivity excluded from fallback SLA | Tasks 12, 14 |
| PR #368 reused, PII-safe logs, costs/latencies/fallback metrics | Tasks 1–2, 10, 15, 18 |
| Migration-first, GitHub-main-only deploy, flags off until canary | Tasks 15, 17, 18 |

No task changes marketing copy, payment state, paid post-checkout collection, or production before the migration-first gate. The plan intentionally uses the existing preflight worker/OIDC queue, provider-run ledger, owner/anonymous claim mechanisms, B-lite DTO/inference prompt, and account-deletion/retention paths rather than inventing parallel infrastructure.
