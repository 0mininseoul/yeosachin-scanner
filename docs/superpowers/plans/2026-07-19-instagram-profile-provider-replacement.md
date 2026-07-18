# Instagram Profile Fallback Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate and use a pinned official Apify Actor as the complete paid public-profile fallback for one authorized `0_min._.00` Standard V2 E2E, preserving strict evidence, crash-safe resume, privacy cleanup, Groble isolation, and the 280-second request target.

**Architecture:** The paid `apify/instagram-profile-scraper` micro-canary falsified the transient-repair hypothesis, so this plan does not reclassify its schema failures and does not add a third repair stage. Instead, it tests pinned build `0.0.692` of official `apify/instagram-scraper` on the same exact 15 public profiles. If two separately fenced runs return 15/15 strict profiles within 60 seconds and reconcile cost/cleanup, the new Actor replaces the whole paid `profile-fallback` only for one signed authorized-test request; normal production routing remains unchanged and disabled after the E2E.

**Tech Stack:** TypeScript, Zod, Vitest, PGlite, Supabase PostgreSQL/RPC, Apify Client, Google Vertex Gemini, Cloud Tasks, Cloud Run, Next.js 16, Vercel, Playwright.

---

## Evidence and new hypothesis

The current reviewed baseline is clean `main == origin/main == 9d450f91324639b2c6ee93c89324543dc3001aec`.

The immutable `profile-repair-canary-v1` repetition 1 requested 15 rows from `apify/instagram-profile-scraper`, took `54,570ms`, cost `$0.039`, and failed with 9 success, 3 incomplete, and 3 schema outcomes. The three schema rows omitted `postsCount`; the three incomplete rows had fewer than `min(postsCount, 8)` usable recent posts. Repetition 2 was never reserved or started. The journal remains unchanged and its `$0.039` is R&D cost, never product unit cost.

This result falsified H1 from `2026-07-18-instagram-v2-launch-unblock.md`: the same Actor did not recover the exact incomplete set. This plan never changes those historical outcome categories, never treats missing `postsCount` as success, and never implements the old `profile-repair` operation.

The self-hosted primary has a separate failure signature. Direct logged-out `web_profile_info` calls that reached Instagram returned HTTP 429; circuit/global-gate fail-fast then prevented almost all later network starts. Session cookies, proxy rotation, residential unblock, and credential rotation remain forbidden. Fixed-egress research cannot establish 238-profile reliability within the five-minute envelope and is outside this E2E plan.

The new falsifiable hypothesis is:

- **H4, replacement correctness:** official `apify/instagram-scraper` build `0.0.692` with `resultsType='details'` returns strict full-profile evidence for all 15 known public failures. Either canary repetition below 15/15, any unavailable/incomplete/schema/auth/quota/rate-limit/transport/duplicate/unattributed row, build drift, latency over 60 seconds, unsettled cost, or incomplete storage cleanup falsifies H4 and stops implementation.
- **H5, authorized-request performance:** replacing the whole public-profile fallback removes the sequential old-Actor-plus-repair design. With profile Actor concurrency eight and a primary-lane monotonic deadline, the final profile lane must finish below 150 seconds and the request below 280 seconds.
- **H6, launch proof:** PII-free evidence captured before purge must prove exact fallback selection, Actor/build/contract identity, media and interaction policy, Gemini usage, cost, result persistence, and cleanup.

The current public Actor metadata reports build `0.0.692` and pay-per-event pricing advertised at about `$0.0027` per result. These are planning inputs, not billing truth. Immediately before a paid call, the runtime must verify the exact build still exists, the run-specific event price and minimum charge, balance, concurrency, and restricted access. The hard maximum, not the estimate, controls admission.

## Hard invariants

- Never print, commit, or expose an `APIFY_*` token, owner identity, source request ID, external run/storage ID, username list, profile URL, ordered-set HMAC, or raw provider error.
- Forced-RLS, RPC-only service-role journals may persist the minimum crash-safety identifiers: `source_request_id`, confirmed `run_id`, reservation identity, Actor/build/contract identity, safe counts/costs, and cleanup state. These IDs are forbidden in logs, CLI output, public evidence, user APIs, and ordinary application tables.
- The canary journal may temporarily store a domain-separated HMAC-SHA256 of the ordered 15 using the existing operator HMAC secret. It is never output and is set to `NULL` when `experiment_terminal` cleanup is complete.
- `experiment_terminal` means exactly one of: both repetitions passed; an actually started repetition reached terminal failure after actual-cost reconciliation and three-storage cleanup; an ambiguous reservation was manually resolved by attaching and cleaning the one matching run or by verifying that no run exists; repetition 1 passed but the operator explicitly chose `aborted_by_operator`; or the durable one-hour repetition-2 approval window elapsed with no repetition-2 reservation, producing `expired_waiting_for_repetition`. At `experiment_terminal`, clean and verify every retained source/canary storage and clear the HMAC without reserving a missing later repetition. HMAC/source storage remain only while an ambiguity is genuinely unresolved or the bounded repetition-2 approval window is active.
- Never make a paid call without the exact valueless confirmation flag and fresh explicit approval in that executing session. Micro-canary approval does not authorize the full E2E.
- Never buy Apify credit, rotate secrets, change account access, make a real Groble payment, mark an order paid, or consume QA `payment_pending` inventory without separate approval.
- The replacement canary and authorized E2E operate only on public profiles. Private rows never enter the detailed profile fallback.
- The replacement Actor receives exactly the ordered unresolved public set frozen after self-hosted terminal outcomes. Primary successes, private mutuals, unavailable rows, and unrelated usernames are excluded.
- The existing 90% per-batch evidence threshold, 99% relationship threshold, strict target-profile contract, media policy, interaction policy, and V2 scoring policy remain unchanged.
- Actor ID, build, input/output contract versions, credential slot, ordered input operation hash, maximum charge, and confirmed run ID are durable identity. A mismatch fails closed.
- `starting` with no confirmed run ID is ambiguous. It can be reconciled only by a DB-owner-only manual resolver and never authorizes a new start.
- The canary/full-fallback orchestrator, not the provider adapter, owns external cleanup after profile checkpoint, terminal counts, and actual cost are durable. It deletes and verifies KVS, dataset, and request queue storage before marking cleanup complete.
- Public admission remains false. The replacement is authorized-test-only, bound by signed execution policy, and disabled after the run.
- Paid-canary admission requires the deployed exact SHA to have `ANALYSIS_V2_RECOVERY_ENABLED=true` and the structurally exact `analysis-v2-recovery` Scheduler for `/api/analysis/v2/recover` in `ENABLED` state. Both remain enabled until `experiment_terminal` cleanup is durably complete; a gate, revision, Scheduler-state, URI, audience, schedule, or retry-contract mismatch fails closed before an Actor start.
- Every change uses an isolated branch/worktree, TDD, PR, independent spec review, independent code-quality review, green CI, merge to main, ordered migration, and exact-SHA deployment.

## File map

### PR A: Replacement adapter and exact-15 canary

- Create `lib/services/instagram/providers/apify-profile-details.ts` and test: pinned Actor definition, minimal input, strict shared parser, lifecycle, build/cost verification.
- Create `lib/services/analysis/profile-provider-canary-run-store.ts` and unit/PGlite/migration-contract tests: replacement journal, ordered-set HMAC, manual ambiguity resolution, cleanup state.
- Create `supabase/migrations/20260719120000_add_profile_provider_replacement_canary.sql`: forced-RLS journal and source authorization RPCs.
- Create `scripts/canary-instagram-profile-provider-options.ts` and test: exact CLI confirmation and sanitized report.
- Create `scripts/canary-instagram-profile-provider.ts` and test: zero-cost source replay, paid lifecycle, accounting, cleanup.
- Create `scripts/resolve-profile-provider-canary-ambiguous-start.ts` and tests: DB-owner-only attach-or-absence workflow, never a start.
- Create `scripts/finalize-profile-provider-canary.ts` and tests: cleanup-only operator abandonment after repetition 1, never a start.
- Create `lib/services/analysis/profile-provider-canary-recovery.ts` and tests, and modify `app/api/analysis/v2/recover/route.ts` plus route tests: scheduled cleanup-only expiry, never a start.
- Modify deployment/readiness script tests: the paid-canary preflight proves exact deployed SHA, recovery gate `true`, and the exact `analysis-v2-recovery` Scheduler `ENABLED`; it refuses starts and refuses recovery disablement while a canary is nonterminal.
- Modify `package.json`, `docs/authorized-apify-sharded-e2e-runbook.md`, and `docs/operations-cost-model.md`.

### PR B: Authorized-test full-profile fallback selection and durable identity

- Modify `lib/services/analysis/authorized-test-provider-policy.ts` and tests: exact Actor/build/contracts for `profile-fallback` only.
- Modify `lib/services/analysis/test-entitlement.ts`, consumption tests, and policy PGlite tests: signed immutable replacement identity and confirmation claim.
- Modify `lib/services/instagram/providers/types.ts`, `config.ts`, `scraper.ts`, and tests: choose the replacement adapter only from the authorized policy.
- Modify `lib/services/analysis/v2-provider-run-store.ts`, lifecycle tests, and forward migration: build/contracts/operation identity and cleanup state.
- Modify `lib/services/analysis/v2-profile-fetch-store.ts` and tests only as needed to persist fallback provider identity with the existing two-stage primary/fallback checkpoint. No third attempt is added.
- Modify `lib/services/analysis/v2-collection-executors.ts`, target reuse tests, and runtime-dependency tests: bind/resume the exact replacement Actor for the frozen profile fallback.

### PR C: Slot-aware profile capacity and primary deadline

- Modify Apify semaphore/provider files and tests: per-physical-slot account cap, `profile|non_profile` sublimits, cross-slot independence.
- Modify self-hosted index/web-client and V2 executor tests: profile-lane monotonic deadline; no direct request starts after it.
- Modify deployment/env generation scripts and infra tests: profile cap 8, non-profile cap 2, Cloud Run/queue concurrency 8, max instance 1, one revision.

### PR D: Launch evidence, paid interlocks, readiness, and cost

- Implement PR 4 from `2026-07-18-instagram-v2-launch-unblock.md`, replacing repair evidence with replacement Actor/build/contract/exact-fallback evidence.
- Require exact paid confirmation in both signed admission and entitlement issuers.
- Correct mobile history route to `/mypage`.
- Add named early-bird regressions and pre/post deployment inventory/order deltas.

## Task 0: Freeze state and prove source feasibility

- [ ] **Step 1: Verify the repository and operational baseline**

```bash
git fetch origin
git status --short --branch
git rev-parse main
git rev-parse origin/main
git diff --exit-code
git diff --cached --exit-code
```

Require no active V2 requests/jobs/provider runs/preflights, four empty Cloud Tasks queues, one failed reconciled v1 canary repetition, no repetition 2 row, QA Standard still `payment_pending`, Basic 0/10 sold and Standard 0/10 sold.

- [ ] **Step 2: Run the zero-cost existing source replay before implementation**

Use the reviewed v1 script without `--confirm-paid-api-call`. Require:

```json
{
  "mode": "replay",
  "source_run_count": 8,
  "requested_count": 15,
  "critical_incomplete_count": 3,
  "total_actual_cost_usd": 0,
  "session_maximum_exposure_usd": 0,
  "gate_passed": false
}
```

Actor run delta and journal-write delta must both be zero. If any source KVS/dataset is unavailable, stop before PR A. This feasibility check passed on 2026-07-19 and must be repeated at execution.

- [ ] **Step 3: Create the PR A worktree and baseline**

```bash
git worktree add .worktrees/profile-fallback-replacement-canary \
  -b feat/profile-fallback-replacement-canary origin/main
cd .worktrees/profile-fallback-replacement-canary
npm install
npm test
```

Expected baseline: 214 passing test files, one skipped file, 1,982 passing tests, three skipped tests.

## Task 1: Implement the pinned replacement adapter with TDD

- [ ] **Step 1: Write RED tests**

Create `lib/services/instagram/providers/apify-profile-details.test.ts` and assert:

```ts
expect(REPLACEMENT_PROFILE_ACTOR).toEqual({
    actorId: 'apify/instagram-scraper',
    build: '0.0.692',
    inputContractVersion: 1,
    outputContractVersion: 1,
    estimatedResultCostUsd: 0.0027,
});

expect(buildReplacementProfileInput(['alice', 'bob'])).toEqual({
    directUrls: [
        'https://www.instagram.com/alice/',
        'https://www.instagram.com/bob/',
    ],
    resultsType: 'details',
});
```

Do not set `resultsLimit`; it is a per-URL post/comment depth, not profile cardinality. Start options must include exact `build`, `maxItems=requestedCount`, fixed `maxTotalChargeUsd`, and `restartOnError=false`. The returned `run.buildNumber` must equal `0.0.692`.

Tests also cover exact order/attribution, duplicate/unexpected/cross-batch rejection, explicit not-found only, missing/short recent posts as incomplete, all other schema failures, reel thumbnail separation, carousel child order/caption alignment, resume of only the confirmed run, no replacement start, accounting, and deadline behavior.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run lib/services/instagram/providers/apify-profile-details.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal adapter**

Create:

```ts
export const REPLACEMENT_PROFILE_ACTOR = Object.freeze({
    actorId: 'apify/instagram-scraper',
    build: '0.0.692',
    inputContractVersion: 1,
    outputContractVersion: 1,
    estimatedResultCostUsd: 0.0027,
});

export function buildReplacementProfileInput(usernames: readonly string[]) {
    return {
        directUrls: usernames.map(username =>
            `https://www.instagram.com/${username}/`
        ),
        resultsType: 'details' as const,
    };
}
```

Reuse the current strict profile/media parser and `startOrResumeApifyActor`; do not duplicate parsing or accept optional provider fields as complete evidence. The adapter returns results only. Cleanup remains an orchestrator responsibility.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run \
  lib/services/instagram/providers/apify-profile-details.test.ts \
  lib/services/instagram/providers/apify.test.ts \
  lib/domain/analysis/media-policy.test.ts \
  lib/domain/analysis/carousel-caption-policy.test.ts
```

## Task 2: Add the crash-safe exact-15 canary journal

- [ ] **Step 1: Write store, SQL-contract, and PGlite RED tests**

The journal fixes:

```text
canary_version = profile-fallback-replacement-canary-v1
actor_id = apify/instagram-scraper
actor_build = 0.0.692
input_contract_version = 1
output_contract_version = 1
credential_slot = primary
requested_count = 15
max_charge_usd = 0.05
repetition in 1,2
```

It stores source request ID, reservation token, temporary ordered-set HMAC, state, confirmed run ID, safe terminal counts, latency, gate, actual cost, and mandatory KVS/dataset/request-queue cleanup states/timestamps. It stores no username, URL, storage ID, payload, owner/email, token, or free-form error.

The source RPC requires the exact authorized execution policy, owner/entitlement/preflight/request lineage, eight reviewed terminal source runs, target `0_min._.00`, v2 failed status, and 15 unique public incomplete rows with three critical-batch members.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run \
  lib/services/analysis/profile-provider-canary-run-store.test.ts \
  lib/services/analysis/profile-provider-canary-run-migration-contract.test.ts \
  lib/services/analysis/profile-provider-canary-run-pglite.test.ts
```

- [ ] **Step 3: Implement lifecycle and cleanup ordering**

```text
load exact source -> compute ordered HMAC -> reserve repetition
-> before-start identity check -> start -> checkpoint run ID
-> resume/wait same run -> verify build -> parse 15 outcomes
-> terminalize safe counts -> reconcile stable actual cost
-> derive and delete KVS/dataset/request queue -> verify not found
-> mark all cleanup complete -> allow next repetition
```

Before start, require the account/run default access policy to be `RESTRICTED`; otherwise stop without mutation. Repetition 2 reloads the source, recomputes the HMAC, and must match the journal. When `experiment_terminal` is reached, delete and verify all retained source KVS/dataset/request queues, clean every actually existing canary run, and clear the HMAC in SQL while retaining counts/cost/provenance. A failed repetition 1 never reserves repetition 2 merely to reach cleanup.

- [ ] **Step 4: Add DB-owner-only ambiguous resolution**

Create a resolver that inspects only the exact Actor/build/credential/time window. If exactly one run matches and its INPUT HMAC equals the reservation HMAC, attach it and permit only resume/reconcile/cleanup. If no run exists, record externally verified absence but do not start. If multiple runs or a mismatch exists, remain blocked. Unit/PGlite tests cover lost start response, checkpoint failure, abort success/failure, zero/one/multiple matches, and prove the resolver never calls Actor start. Add explicit terminal-cleanup tests for repetition-1 strict failure, verified-no-run resolution, adopted-run terminal failure, successful two-repetition completion, repetition-1 success followed by operator abandonment, and repetition-1 success followed by silent process loss and expiry; every path clears HMAC/source storage only at `experiment_terminal`, and abandonment/expiry start zero Actors.

Persist `rep2_approval_deadline_at = repetition1.terminalized_at + 3,600,000ms` when repetition 1 passes. Extend the existing OIDC-authenticated `/api/analysis/v2/recover` maintenance path with a bounded, `FOR UPDATE SKIP LOCKED` replacement-canary cleanup scan. When the deadline has elapsed and repetition 2 is absent, it idempotently records `expired_waiting_for_repetition`, performs cleanup-only source purge, and clears the HMAC. It never reserves a repetition or calls Actor start. Recovery-route tests prove a pre-deadline row is untouched, an expired row is finalized once, concurrent scans do not double-clean, maintenance auth remains required, and all Actor start mocks remain at zero. Deployment/readiness tests prove the paid command cannot start when the deployed SHA is stale, the recovery gate is false, or the exact Scheduler is paused or structurally drifted; an active nonterminal canary also blocks any transition that would disable the gate or pause the Scheduler.

- [ ] **Step 5: Verify GREEN**

Run the three focused suites and require RLS/revokes, idempotency, HMAC lifecycle, ambiguity, cost, and three-storage cleanup tests all pass.

## Task 3: Add the zero-cost replay and paid CLI boundary

- [ ] **Step 1: Write RED option/script tests**

Default replay has zero journal writes and starts. Sanitized output is limited to mode, source-run count, requested/critical counts, per-repetition lifecycle/counts/latency/actual cost/cleanup/gate, total actual, maximum exposure, and cost status.

Exact `--confirm-paid-api-call` fixes two conditional repetitions, `$0.05` per run, `$0.10` total. Overrides, duplicate flags, and `--confirm-paid-api-call=true` are rejected.

- [ ] **Step 2: Implement script and package commands**

```json
"canary:instagram-profile-provider": "tsx --env-file=.env.local scripts/canary-instagram-profile-provider.ts",
"canary:instagram-profile-provider:resolve": "tsx --env-file=.env.local scripts/resolve-profile-provider-canary-ambiguous-start.ts",
"canary:instagram-profile-provider:finalize": "tsx --env-file=.env.local scripts/finalize-profile-provider-canary.ts"
```

Pass gate per repetition only at exactly 15 success, zero other outcomes, latency `<=60,000ms`, actual cost `<=0.05`, build match, restricted access, and complete cleanup. Repetition 2 requires a fresh executing-session approval if it could start in a later invocation. Any terminal failure marks the experiment terminal after reconciliation/cleanup and triggers source purge/HMAC clearing without creating repetition 2. If repetition 1 passed but the paid invocation ended before repetition 2, the operator must either provide fresh approval for the already-declared second run or invoke the exact cleanup-only `canary:instagram-profile-provider:finalize` command. That command records `aborted_by_operator`, starts zero Actors, purges retained source storage, and clears the HMAC under the original approval's cleanup scope.

- [ ] **Step 3: Run PR A verification**

```bash
npx vitest run \
  lib/services/instagram/providers/apify-profile-details.test.ts \
  lib/services/analysis/profile-provider-canary-run-store.test.ts \
  lib/services/analysis/profile-provider-canary-run-migration-contract.test.ts \
  lib/services/analysis/profile-provider-canary-run-pglite.test.ts \
  scripts/canary-instagram-profile-provider-options.test.ts \
  scripts/canary-instagram-profile-provider.test.ts \
  scripts/resolve-profile-provider-canary-ambiguous-start.test.ts \
  scripts/finalize-profile-provider-canary.test.ts \
  scripts/canary-apify-profile-repair.test.ts
npm test
npm run lint
npx tsc --noEmit
npm run build
git diff --check
```

Run the six named early-bird suites from the original runbook and require QA payment/inventory deltas zero.

## Task 4: Review, merge, deploy, and run zero-cost replay

- [ ] **Step 1: Open PR A**

Commit only the files in PR A, push `feat/profile-fallback-replacement-canary`, and open a PR. The spec reviewer checks H1 preservation, exact 15, HMAC, IDs, build/input, paid gates, ambiguity, cleanup, and Groble isolation. After spec approval, the code reviewer checks parser reuse, lifecycle ordering, SQL locks/RLS, and tests.

- [ ] **Step 2: Merge and deploy exact SHA**

Require green GitHub and Vercel CI. Apply the forward migration in order, deploy exact merged SHA only with zero active work, and keep public admission/replacement routing disabled. Before any paid canary, promote that exact SHA with `ANALYSIS_V2_RECOVERY_ENABLED=true`, reconcile and verify the exact `analysis-v2-recovery` Scheduler as `ENABLED`, and record a fail-closed readiness result. Do not disable recovery or pause the Scheduler until the canary journal proves `experiment_terminal` and all cleanup complete.

- [ ] **Step 3: Run zero-cost replay**

Without the paid flag, require exact 15, three critical rows, fresh starts zero, journal delta zero, Actor run delta zero, and cost zero. Recheck queues, active work, QA order, and inventory.

## Task 5: Paid replacement-canary approval stop

- [ ] **Step 1: Recheck live account and Actor contract**

Verify build `0.0.692` availability, current event price, minimum max charge, balance, concurrency headroom, current account default access `RESTRICTED`, selected physical secret identity, and no competing operator. Also verify the exact deployed SHA, `ANALYSIS_V2_RECOVERY_ENABLED=true`, and the structurally exact `analysis-v2-recovery` Scheduler for `/api/analysis/v2/recover` is `ENABLED`. The paid command rechecks this immediately before reservation and starts zero Actors on mismatch. Keep the recovery gate and Scheduler enabled through durable `experiment_terminal` cleanup. Do not mutate account settings or buy credit.

- [ ] **Step 2: Request fresh approval**

Report:

```text
Actor/build: apify/instagram-scraper 0.0.692
Input: exact 15 reviewed public profiles
Runs: up to 2, repetition 2 conditional
Expected: about $0.0405/run at current advertised rate
Hard cap: $0.05/run, $0.10/session
Latency gate: <=60s/run
Quality gate: 15/15 strict profiles
Privacy: KVS/dataset/request queue deleted and verified after durable cost
```

The approval scope must explicitly include deletion of the terminal source/canary provider storage after evidence capture. Do not call paid mode before approval.

- [ ] **Step 3: Run once and branch**

If both repetitions pass, continue. Any failure or ambiguity stops all new starts; do not change build/Actor/slot, relax evidence, or retry without a new plan and approval.

## Task 6: Implement authorized-test full fallback selection (PR B)

- [ ] **Step 1: Write RED policy and identity tests**

Extend the authorized-test execution policy so `profile-fallback` fixes:

```ts
{
  logicalProvider: 'apify',
  actorId: 'apify/instagram-scraper',
  actorBuild: '0.0.692',
  inputContractVersion: 1,
  outputContractVersion: 1,
  credentialOperation: 'profile-fallback',
  maxItemsPerRun: 30,
  maxChargeUsdPerRun: 0.09,
  maxProfileFallbackRuns: 20,
  maxProfileFallbackExposureUsd: 1.80,
}
```

This policy is accepted only by confirmed signed test admission/entitlement for target `0_min._.00`. Normal production policy remains the original Actor.

- [ ] **Step 2: Extend durable run identity**

Add actor build, input/output contracts, canonical ordered-input operation hash, maximum items/charge, and cleanup state to the provider-run forward migration/store. Reserve before start, checkpoint external ID, resume the same ID, verify returned build, checkpoint strict outcomes in the existing fallback slot, reconcile actual cost, then delete/verify KVS/dataset/request queue and mark cleanup complete.

The operation key remains `createAnalysisV2ProviderOperationKey('profile-fallback', canonicalInput)` and includes Actor/build/contracts in canonical input. No new credential policy field is introduced; it reuses the signed `profile-fallback` slot.

- [ ] **Step 3: Route only the authorized test to the replacement adapter**

Remove hard-coded fallback Actor assumptions from `getProfilesBatchV2` and the executor, but do not widen public config. Freeze the exact unresolved ordered public set after all primary outcomes are durable. Preserve primary successes, reject private/unrelated rows, and persist one terminal replacement outcome per requested username in the existing fallback checkpoint.

- [ ] **Step 4: Add fixed primary/fallback/AI lane deadlines**

Export code constants, not operator-overridable environment values:

```ts
export const PROFILE_LANE_BUDGET_MS = 150_000;
export const SELFHOSTED_PRIMARY_BUDGET_MS = 15_000;
export const PAID_PROFILE_FALLBACK_BUDGET_MS = 60_000;
export const PROFILE_AI_RESERVE_MS = 75_000;
```

At the durable profile-stage start, derive monotonic cutoffs `primaryDeadline=start+15_000`, `fallbackDeadline=start+75_000`, and `profileLaneDeadline=start+150_000`. Pass `primaryDeadline` through the V2 executor and self-hosted provider. At or after 15,000ms, start no new Instagram request and emit terminal fail-fast outcomes for the exact unresolved set. The replacement Actor may resume only the already-checkpointed run after its start window and cannot make a new paid start at or after `fallbackDeadline`. Profile AI cannot begin when less than 75,000ms remains; the worker fails closed instead of spending into the final-stage reserve. Do not disable the global gate or circuit.

Boundary tests use a monotonic fake clock and prove: a primary request may start at 14,999ms but not 15,000ms; a fresh fallback may start at 74,999ms but not 75,000ms; a checkpointed fallback may only resume after 75,000ms; profile AI may enter with exactly 75,000ms remaining but not 74,999ms; and no work crosses 150,000ms. Deployment/readiness tests assert these compiled constants and reject environment variables that attempt to override them.

- [ ] **Step 5: Verify PR B**

Focused tests prove policy binding, missing-confirmation zero starts, exact unresolved selection, public-only filtering, crash at every reserve/start/checkpoint/cost/cleanup boundary, old Actor legacy resume, build drift, cost caps, and no third attempt. Run full test/lint/type/build and named Groble suites; obtain both reviews, green CI, merge, migrate, and deploy with authorized replacement still disabled.

## Task 7: Implement capacity and launch evidence (PR C and PR D)

- [ ] **Step 1: Add slot/class capacity with deployment contracts**

Both profile Actors use the profile-class cap; relationships/interactions use non-profile cap two. Per physical slot account cap is deterministic and never exceeds live account headroom. Deployment/env tests require profile 8, non-profile 2, Cloud Run and queue concurrency 8, max instance 1, one 100% revision, and exact SHA.

- [ ] **Step 2: Capture launch evidence before purge**

Persist PII-free self-hosted network/global-gate/circuit origins and latency buckets, exact replacement requested/result counts, Actor/build/contracts, media/reel/carousel/caption counts, interaction stage evidence, risk-policy version, Gemini stage/model/thinking/retry/tokens/latency/cost, provider actuals, and cleanup health.

- [ ] **Step 3: Add readiness and paid-token interlocks**

Both token issuers require exact `--confirm-paid-api-call`; missing confirmation yields no usable token and zero preflight/request/provider starts. Readiness blocks on Actor/build/operation mismatch, missing GCP evidence, unknown Gemini usage, active/unreconciled runs, incomplete cleanup, artifacts, wrong deployed revision, or timing failure.

Timing gates are:

```text
request wall < 280s
relationships + target <= 60s
profile collection + profile AI <= 150s
shortlist + reverse interactions <= 45s
narrative + finalize <= 40s
post-result provider settlement/cleanup reported separately
```

- [ ] **Step 4: Run Groble regression for each PR and deployment**

Run checkout, webhook, order-status, UI-state, migration-contract, and earlybird PGlite suites. Pre/post production checks require QA `payment_pending`, null payment/due/sequence/result, zero QA webhook delta, Basic/Standard inventory delta zero, and analysis work delta zero.

- [ ] **Step 5: Review, merge, migrate, and deploy each PR independently**

Correct mobile resume route from `/history` to `/mypage`. Keep public admission false and authorized replacement disabled until final approval.

## Task 8: Full Standard E2E approval stop

- [ ] **Step 1: Recompute current operation map and exposure**

Include Standard maxima: followers 800, following 800, public detailed profiles up to 600, target likers 600, comments 90, reverse likers up to 1,000, all Gemini stage caps, preflight cost, provider actual/maximum, Cloud Run/Tasks list-price, and no Groble payment. Separate expected cost from `sum(max_charge_usd)` conservative exposure.

- [ ] **Step 2: Ask for separate full-paid approval**

Canary approval does not carry over. Require approval for both signed admission and entitlement confirmation commands, the one authorized target, the exact deployed SHA/Actor/build, and the stated maximum exposure.

## Task 9: Run and verify one authorized Standard E2E

- [ ] **Step 1: Create exactly one request**

Use a new idempotency key in the same authenticated owner session. Require one entitlement consumption, one reciprocal preflight/request, zero siblings, explicit exclusion decision, and no Groble checkout/webhook/order mutation.

- [ ] **Step 2: Prove background/mobile continuation**

At `390x844`, leave after V2 acceptance, verify Cloud Tasks advances without browser `/step` POST, return via `/mypage`, reopen the same progress/result, close, and reopen the durable result again.

- [ ] **Step 3: Verify collection and result policy**

Require declared/collected follower and following equality; consistent mutual/public/private counts; exact public fallback provenance; documented private-name sort; recent-mutual-woman badges; exclusion absence; signed images; reel thumbnails; carousel child/caption alignment; target comments/likers and reverse interactions; V2 score/band/order/policy agreement; and privacy-safe copy.

- [ ] **Step 4: Reconcile time and cost**

Report preflight wall, request stage walls, request total, and post-result settlement separately. Sum preflight Apify actual, relationship/profile/interaction Apify actual, Gemini complete modeled cost, Vertex billed actual, Cloud Run/Tasks meter-times-list-price, and billed actual when available. Keep both canary R&D costs separate from product unit cost. Delayed billing yields `BEHAVIOR_SUCCESS_COST_BLOCKED`.

- [ ] **Step 5: Teardown**

Disable authorized replacement/sharding, keep public admission false, and confirm all queues, active provider rows, jobs, cleanup intents, and media artifacts are zero. Do not delete the owner-visible final result.

## Task 10: Final report and stop boundary

Report E2E status/result URL, reviewed/deployed SHA, stage timings, complete relationship/profile counts, self-hosted attempt origins, replacement fallback success/missing counts, media/interactions/score/UI checks, Apify/Gemini/Cloud Run/Tasks costs, R&D canary spend, PRs, QA order/inventory deltas, and automatic-launch blockers.

This E2E verifies collection completeness and policy/UI consistency, not semantic accuracy against reality. Automatic paid launch remains blocked on a separately approved deployment-wide fenced Gemini lease and controlled Basic/Standard samples.

## Plan self-review

- The failed H1 result and schema categories are unchanged.
- No repair operation or third profile checkpoint exists.
- The new Actor is exact-request, authorized-test-only, public-only, build-pinned, cost-fenced, and disabled after the run.
- Source feasibility is checked before implementation, and exact-set equality survives cross-process resume through a temporary HMAC.
- Crash safety persists only minimal IDs in forced-RLS journals; outputs remain identifier-free.
- External storage cleanup is orchestrator-owned, mandatory, verified, and durable.
- Timing, deployment concurrency, cost windows, mobile persistence, media/interactions/scoring, and named Groble regressions are explicit.
- Self-hosted proxy/session/rotation, real payment, credit purchase, automatic launch, and distributed Gemini lease implementation are outside this plan.
