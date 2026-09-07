# Coordinated Capacity Identity Epoch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user selected one fresh visible Orca Codex `gpt-5.6-luna` with `max` effort, supervised by the coordinator, in a separate implementation worktree. That selection overrides generic suggestions to switch models, use hidden subagents, or implement in the coordinator session.

**Goal:** Implement and independently verify the approved dual-role identity transition, land green code, and obtain production `VERIFIED` evidence with both public admission gates closed, without activating or running the real canary.

**Architecture:** A small TypeScript coordinator owns protected input validation, a GCS-fenced append-only journal, independent observation and mutation adapters, and the ordered dual-role transition. Public readiness becomes the exact additive v3 contract; existing role deploy paths retain their guards and participate only in mutual exclusion. Live adapters use authenticated control-plane APIs and exact read-back; the offline harness supplies in-memory cloud resources, injected clocks, and counters that throw on provider/work operations.

**Tech Stack:** Node 24, TypeScript, Next.js App Router, Vitest, existing `google-auth-library`, GCS JSON API, IAM policy etags, Cloud Run/Tasks/Scheduler control planes, Vercel REST API, existing authenticated operator tooling.

---

## Authority and immutable references

- Approved English design: `docs/superpowers/specs/2026-09-07-coordinated-capacity-identity-epoch-roll-forward-design.md`, all sections 1–13 and acceptance rows in section 10.
- Korean review: `docs/superpowers/specs/2026-09-07-coordinated-capacity-identity-epoch-roll-forward-review-ko.md`.
- Approval/checkpoint: `/Users/youngminpark/.gstack/projects/0mininseoul-yeosachin-scanner/checkpoints/20260907-131500-coordinated-identity-epoch-implementation-handoff.md`.
- Approved design HEAD: `1eb605aa7aeab43a3c0f969ef31e7d76a35d7cc1`; approval base and freshly fetched `origin/main`: `02e89f496c2dabaf4ef6a9c2251928006a5b17bc`.
- The old documents' “proposed” labels are historical. The user approved Option A and implementation. Preserve those exact documents/history; do not reopen A/B/C.
- The root owns planning, review, orchestration, production decisions, and independent evidence checks. The visible worker owns implementation edits and commits, corrections, and PR preparation. Further rollout work requires a concrete coordinator dispatch but no new user approval before `VERIFIED`.
- Activation is implemented and tested offline, but production invocation must stop at `VERIFIED`. No actual `0_min._.00` canary, Apify/Gemini/Vertex/RapidAPI/Instagram/B-lite work, payments, credential rotation, secret-version changes, database changes, account deletion, or Docker cleanup.
- No protected identity/project/resource/URL/credential/environment/manifest/user value in stdout, stderr, argv diagnostics, git, journal, ordinary temp files, or reports. Read existing protected inputs in memory; use private inherited descriptors or protected operator storage for required input transport. Do not source `.env.local`.
- Preserve existing dirty worktrees, `.playwright-mcp/`, and `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql`. No destructive git commands or mixed migration pushes.

## File map

| Path | Responsibility |
| --- | --- |
| `lib/services/analysis/legacy-analysis-public-readiness.ts` | Preserve aggregate v2 semantics and append two independent Vercel gate booleans. |
| `lib/services/analysis/legacy-analysis-public-readiness.test.ts` | Full exact schema, key order, gate interpretation, malformed config, unchanged aggregate formula. |
| `lib/services/analysis/public-readiness-contract.ts` | Strict shared v3 wire/shape and expected-value validation, including duplicate JSON keys. |
| `lib/services/analysis/public-readiness-contract.test.ts` | Raw JSON and object contract rejection matrix. |
| `scripts/validate-analysis-public-readiness.ts` | Quiet stdin bridge for shell consumers, fixed reason-code output only. |
| `scripts/check-analysis-v2-release-readiness.sh` | Explicit independently expected public gate facts using the shared parser. |
| `scripts/deploy-analysis-capacity-workers.sh` | v3 consumer and epoch exclusion around ordinary mutation; existing exceptions preserved. |
| `scripts/configure-analysis-capacity-queues.sh` | Epoch exclusion around delegated capacity queue mutations. |
| `scripts/configure-analysis-tasks-queue.sh` | Guard direct capacity-owned queue mutation entry when necessary to close the same bypass. |
| `scripts/configure-analysis-preflight-maintenance.sh` | Include standalone epoch-owned Run IAM/recovery scheduler mutations in shared exclusion; retain read-only and ordinary guards. |
| `scripts/configure-analysis-v2-maintenance.sh` | Include standalone paid recovery mutations in shared exclusion without disabling or altering unrelated retention work. |
| `scripts/test-analysis-v2-release-readiness.sh` | Existing shell release harness v3 fixtures and negative tests. |
| `scripts/automatic-analysis-capacity-infra.test.ts` | Ordinary/bootstrap/expanded/preflight-exception regression and epoch exclusion tests. |
| `scripts/capacity-identity-epoch/contracts.ts` | Fixed slot/state schemas, typed protected packet, safe codes, canonical hashing. |
| `scripts/capacity-identity-epoch/packet.ts` | Strict protected input loading, old/desired validation, internal opaque capability issuance. |
| `scripts/capacity-identity-epoch/journal.ts` | Immutable header, generation-CAS lock, contiguous transitions, abort markers, resume fencing. |
| `scripts/capacity-identity-epoch/observations.ts` | Pure validators for exact source, runtime, IAM, queue, scheduler, retention, producer, zero-work observations. |
| `scripts/capacity-identity-epoch/coordinator.ts` | State ordering, proof barriers, idempotency, recovery, separate activation fence. |
| `scripts/capacity-identity-epoch/platform.ts` | Narrow authenticated transport, cancellation/deadlines, no raw errors, real API response parsing. |
| `scripts/capacity-identity-epoch/gcs.ts` | Real GCS storage adapter with conditional writes/read-back and full journal pagination. |
| `scripts/capacity-identity-epoch/cloud-run.ts` | Pinned source builds, deterministic no-traffic revisions, observation barriers and exact promotion. |
| `scripts/capacity-identity-epoch/iam.ts` | Desired grant additions, exact etag CAS, scoped retirement only after both promotions. |
| `scripts/capacity-identity-epoch/work-planes.ts` | Complete Tasks/Scheduler/retention observation, digest-protected pause/resume and probe/ledger checks. |
| `scripts/capacity-identity-epoch/vercel.ts` | Exact Git-backed deployment/alias/readiness chain, closed alignment and independent gate changes. |
| `scripts/capacity-identity-epoch/fixtures.ts` | Test-only fake cloud, injected clock, failure points, side-effect counters; never imported by live CLI. |
| `scripts/capacity-identity-epoch/{packet,journal,observations,coordinator,platform}.test.ts` | Domain and live transport contract tests, failure injection, redaction. |
| `scripts/run-capacity-identity-epoch.ts` | Safe CLI with check as default and explicit through-VERIFIED application. |
| `scripts/check-capacity-identity-epoch-exclusion.ts` | Ordinary-script exclusion/lease bridge with no coordinator bypass flag. |
| `scripts/capacity-identity-epoch.integration.test.ts` | Offline whole-run, crash and CLI harness. |
| `.github/workflows/ci.yml` | Ensure shell and epoch contract suites are required, provider-free checks. |
| `package.json` | Safe operator command and focused epoch test command; no automatic env loading. |
| `docs/analysis-v2-production-operations.md` | Concrete protected-input preparation, recovery and VERIFIED/activation runbook. |
| `docs/superpowers/reviews/2026-09-07-capacity-identity-epoch-implementation.md` | Non-secret evidence, review resolutions and limitations only. |

Split adapter files further only when needed to keep one responsibility per file. Do not add unrelated dependencies or rewrite the existing large shell deployer. This is one coordinated feature, so one plan keeps the cross-resource order reviewable.

## Task 1: Confirm isolated source and baseline

**Files:** Read `AGENTS.md`, both specs, this plan, `package.json`, `vitest.config.ts`, `.github/workflows/ci.yml`.

- [ ] Create a fresh visible Orca child implementation worktree stacked on the design-plus-plan commit. Verify ancestry and exact launch receipt (`codex`, `gpt-5.6-luna`, `max`); run the configured `npm install` setup.
- [ ] Run `git status --short`, `git merge-base --is-ancestor 1eb605aa7aeab43a3c0f969ef31e7d76a35d7cc1 HEAD`, and `node --version`. Expected: clean source, ancestor exit 0, Node 24.
- [ ] Run `npx vitest run lib/services/analysis/legacy-analysis-public-readiness.test.ts` and `bash scripts/test-analysis-v2-release-readiness.sh`. Expected: baseline pass. Report a baseline failure separately before attributing it to this change.
- [ ] Read both specs fully and challenge implementation omissions via Orca `ask`; do not edit the approved design or start production work during the implementation dispatch.

## Task 2: Add readiness v3 without changing ready

**Files:** Modify `lib/services/analysis/legacy-analysis-public-readiness.ts` and its test; inspect `v2-execution-gate.ts`, `lib/services/earlybird/auto-admission-config.ts`, and `app/api/analysis/capacity/readiness/route.ts`.

- [ ] Add failing exact-key/order and all-four-gate-combinations tests using the existing valid fingerprint fixture. Every valid combination must preserve the same `ready`, HTTP 200, source, fingerprints, and routes.

```ts
for (const publicGate of [false, true]) {
    for (const paidGate of [false, true]) {
        const env = {
            ...validEnvironment,
            ANALYSIS_V2_ADMISSION_ENABLED: String(publicGate),
            EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: String(paidGate),
            EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE: '2026-01-01T00:00:00Z',
        };
        const dto = getLegacyAnalysisPublicReadiness(env);
        expect(dto.ready).toBe(true);
        expect(dto.analysisV2AdmissionEnabled).toBe(publicGate);
        expect(dto.earlybirdWebhookAutoAdmissionEnabled).toBe(paidGate);
        expect(Object.keys(dto).slice(-2)).toEqual([
            'analysisV2AdmissionEnabled', 'earlybirdWebhookAutoAdmissionEnabled',
        ]);
    }
}
```

- [ ] Run the file and confirm the failure is missing v3 behavior. Append exactly these two fields after `routes` in both the type and returned object; change only the schema literal to `analysis-public-freeze-readiness-v3`.

```ts
analysisV2AdmissionEnabled: isAnalysisV2AdmissionAvailable(env),
earlybirdWebhookAutoAdmissionEnabled: readEarlybirdAutoAdmissionConfig(env).enabled,
```

Use the actual gate parsers, including paid not-before validity, so readiness does not falsely certify closure while a real gate is open. Preserve their malformed-config fail-closed behavior: an invalid configuration cannot yield a successful v3 proof. Never map an exception to a success-shaped closed boolean. Keep the existing v2 `ready` expression byte-for-byte where practical.

- [ ] Assert `ready=false` for each missing v2 requirement under every valid gate combination; assert no private provider field exists. Run the focused test and commit `feat: expose independent Vercel admission facts in readiness v3`.

## Task 3: Strict wire contract and all consumers

**Files:** Create `public-readiness-contract.ts`, its test, and the quiet bridge; update the three shell/infra consumers and fixtures in the file map.

- [ ] Write failures for v2, extra/missing/renamed/duplicate keys (top-level and route), wrong boolean types, route extra inner keys, wrong SHA, either fingerprint/version, inconsistent `*Ready`, and mismatched independently expected gates.
- [ ] Export `parsePublicReadinessJson(raw: string): LegacyPublicReadiness` and `assertPublicReadiness(dto, expected)`; expected includes exact source, resource, both fingerprint pairs, and both independent booleans. Reject duplicate decoded JSON keys before ordinary JSON parsing; a reviver alone is insufficient because duplicate properties are already lost. Bound bytes/depth and reject malformed/trailing input.

```ts
export const READINESS_KEYS = [
    'schemaVersion', 'ready', 'stage', 'freezeMode', 'publicFreezeEnabled',
    'sourceSha', 'legacyTargetResource',
    'preflightProducerConfigFingerprintVersion', 'preflightProducerConfigFingerprint',
    'preflightProducerConfigReady', 'paidProducerConfigFingerprintVersion',
    'paidProducerConfigFingerprint', 'paidProducerConfigReady', 'routes',
    'analysisV2AdmissionEnabled', 'earlybirdWebhookAutoAdmissionEnabled',
] as const;

export function hasExactKeys(value: object, expected: readonly string[]): boolean {
    const keys = Object.keys(value).sort();
    return keys.length === expected.length
        && keys.every((key, index) => key === [...expected].sort()[index]);
}
```

- [ ] Make the stdin bridge print only `PASS` or one fixed code and exit 0/1. Shell consumers must use it rather than letting `jq` silently discard duplicate keys. Preserve ordinary check/apply semantics: outside an epoch validate gate types without forcing every ordinary deployment to be closed; the release gate takes explicit independently reviewed expected booleans; coordinator closed states require both false.
- [ ] Run `rg -n 'analysis-public-freeze-readiness-v2' lib scripts` and account for every remaining occurrence as a deliberate rejection fixture; run readiness tests, existing infra tests, and the shell harness. Commit `feat: enforce strict readiness v3 across release consumers`.

## Task 4: Complete protected packet and opaque capability

**Files:** Create `contracts.ts`, `packet.ts`, `packet.test.ts`.

- [ ] Define fixed slots/states, canonical hashing, exact schemas, and allowlisted errors. Use Zod strict schemas or equivalent exact-key parsing; never serialize validation issues or input values.

```ts
export const ROLES = ['preflight', 'paid'] as const;
export const SLOTS = [
    'preflight.task-caller', 'preflight.enqueuer', 'preflight.runtime',
    'preflight.maintenance', 'paid.task-caller', 'paid.enqueuer',
    'paid.runtime', 'paid.maintenance',
] as const;
export const STATES = [
    'PREPARED', 'STAGED', 'PRODUCERS_CLOSED_ALIGNED', 'QUEUES_ALIGNED',
    'INVOKERS_ROTATED', 'SERVICES_PROMOTED', 'VERIFIED', 'ACTIVATED',
] as const;
export type Role = typeof ROLES[number];
export type Slot = typeof SLOTS[number];
export type State = typeof STATES[number];
```

The packet must include every record in spec section 4, exact resources and canonical digests, old live revisions, desired pinned build/runtime/secret references and deterministic revision plans, independently reviewed activation booleans, bounded quiescence/freshness limits, authenticated observation inputs, and probe/zero-work evidence sources. Old and desired producer revisions may differ from old worker revisions; do not require all old platform SHAs to be equal. Desired immutable revision IDs cannot be required at preparation.

- [ ] Add pairwise tests over all 28 desired workload pairs and eight build aliases, every missing/additional slot, malformed/cross-project/key/wildcard identity, old shared identity, retired reuse, and exact same-slot unchanged identity.

```ts
const desiredIds = SLOTS.map((slot) => desired.roleSlots[slot].identity);
if (new Set(desiredIds).size !== 8 || desiredIds.includes(desired.build.identity)) {
    throw new EpochError('IDENTITY_CONFLICT');
}
for (const [index, slot] of SLOTS.entries()) {
    const priorSlots = SLOTS.filter((oldSlot) =>
        old.roleSlots[oldSlot].identity === desiredIds[index]);
    if (priorSlots.length !== 0 && (priorSlots.length !== 1 || priorSlots[0] !== slot)) {
        throw new EpochError('IDENTITY_CONFLICT');
    }
}
```

- [ ] Load protected packet only from a private inherited descriptor or pre-existing protected operator channel, with bounds and permissions. No copy to ordinary files. Validate capability binding to epoch digest, desired digest, exact role set, and lock namespace; use an unforgeable in-process object registry at adapter entry, issued only inside validated coordinator bootstrap. A copied object, arbitrary environment boolean, ordinary role flag, or stale fence cannot authorize an operation. Define tests for capability forgery, altered packet, wrong namespace and resume.
- [ ] Run `npx vitest run scripts/capacity-identity-epoch/packet.test.ts`; expected all invalid inputs fail before cloud mutation. Commit `feat: validate complete coordinated identity epoch packets`.

## Task 5: Durable journal, shared exclusion, and fencing

**Files:** Create `journal.ts`, `gcs.ts`, `journal.test.ts`, exclusion bridge; modify ordinary mutation entry points from the file map.

- [ ] Implement the exact immutable header/lock/transition schemas from spec 9.1. No mutable state in the header/lock. Header and transitions use `ifGenerationMatch=0`; lease updates and takeovers use the observed generation. GCS generations are decimal strings, never rounded JS numbers.
- [ ] Derive state by fully listing journal objects and checking contiguous sequence, from/to links, version, epoch, digest and valid fence lineage. Prior transitions can carry earlier legitimate fences after a reviewed takeover; an old writer cannot append after fence loss. Reject duplicates even when different transition-digest suffixes share one sequence. Bind transitions to the immutable header and content digest.
- [ ] Make every cloud mutation and journal append assert a live owner/fence, unexpired lease and header binding. Renew during bounded long builds before expiry; expiry requires new ownership and full observation, never late renewal. Test expired ownership while a build is still running and before append.

```ts
if (observed.ownerDigest !== ownerDigest
    || observed.lockFence !== fence
    || observed.lockExpiresAt <= now()) {
    throw new EpochError('LOCK_LOST');
}
await storage.put(lockKey, nextLock, { ifGenerationMatch: observedGeneration });
```

- [ ] Close cross-epoch and ordinary-script races. The epoch lock remains the only state writer; a generation-protected resource reservation in the same bucket excludes a second epoch over the same two planes, and generation-fenced reservations at existing ordinary service-lock keys prevent pre-upgrade role deploy overlap. Ordinary capacity queue/deploy mutations acquire/check the corresponding common reservation for their whole mutation interval, not just an existence check before a race. No per-role lock substitutes for the epoch journal. Reservations contain only digests/expiry/fence and are not a second state machine.
- [ ] Test two epochs racing, an ordinary deploy winning first, coordinator winning first, concurrent role queue apply, stale owner cleanup, crash after header creation, duplicate append, missing sequence, failed generation precondition and aborted capability reuse. Read-only ordinary checks remain permitted; no paid exceptional bypass.
- [ ] Cover standalone preflight/paid maintenance entry points as well as their nested invocation from a deployer: the same exact owned IAM/scheduler resources must not mutate concurrently with an epoch. Test each winner ordering and nested delegation without deadlock or a forgeable environment bypass; preserve unrelated retention behavior. This closes the existing resource-wide exclusion requirement discovered during implementation review, not a new exceptional path.
- [ ] Run journal and infra tests. Commit `feat: fence coordinated epochs and preserve append-only state`.

## Task 6: Observation proofs and zero-work provenance

**Files:** Create `observations.ts`, `observations.test.ts`, test fixtures.

- [ ] Define typed observations carrying resource-specific evidence, not caller-asserted success booleans. IAM has a real etag; Run has observed generation/resourceVersion; Tasks/Scheduler/Vercel have complete canonical observation digests; GCS has generations.
- [ ] Prove old live identities from service/revision attachment, scheduler OIDC and queue/SA IAM. An absent old enqueuer runtime alias cannot be replaced with a guessed desired identity: independently observe the exact prior enqueuer IAM contract, or reject incomplete evidence.
- [ ] Validate exact complete task listing, paused queue, resource/project/location, scheduler config and paused state, aged non-future pause timestamp plus available last-attempt evidence, and enabled exact retention resource. Track stable configuration digest separately from expected operation-induced state changes and task observations so a requested pause is not confused with external config drift.

```ts
if (!Number.isSafeInteger(pauseEpochMs) || pauseEpochMs > nowMs
    || nowMs - pauseEpochMs < timeoutMs + graceMs
    || (lastAttemptMs !== null && nowMs - lastAttemptMs < timeoutMs + graceMs)) {
    throw new EpochError('SCHEDULER_NOT_QUIESCENT');
}
```

- [ ] Validate full Run settings against existing strict INITIAL manifests: actual runtime attachment, exact env key/value and pinned numeric secrets, role, max instances, CPU/memory/concurrency/timeout, source label, canonical target and audience, private IAM, explicit immutable traffic and private provider gate true. Staging proof cannot come from the old revision.
- [ ] Define baseline/end observation windows and independent provider-ledger, billing/work-ledger, task-creation audit and receiver-log evidence. Empty queue snapshots alone cannot prove no task was created and deleted; fake counters alone cannot be live evidence. Missing permissions, pagination, lag coverage, or required observation source yields `EVIDENCE_UNAVAILABLE`, never a zero default.
- [ ] Tests alter every proof field independently; include malformed/absent/paginated data and permission denial. Run observations tests, commit `feat: validate independent epoch observation evidence`.

## Task 7: Real control-plane adapters

**Files:** Create `platform.ts`, `cloud-run.ts`, `iam.ts`, `work-planes.ts`, `vercel.ts`, and `platform.test.ts`.

- [ ] Implement authenticated protected transport with hard host/path/method allowlists, no redirects, bounded timeouts/response sizes, bounded read polling, cancellation and fixed-code errors. Capture CLI stdout/stderr in memory if CLI is needed; never log raw commands or output. Existing authenticated operator sessions provide credentials; no new service-account keys or secret rotation.
- [ ] Implement real GCS conditional media/metadata operations and paginated list using the adapter from Task 5. Verify bucket privacy and live expected storage identity, not an arbitrary packet URL.
- [ ] Implement exact pinned source build/staging with deterministic revision suffix, captured immutable revision, no traffic, readiness polling, preserved secret references and settings. Use fresh Run metadata before an operation and exact read-back after it. A changed generation caused by the requested operation must match its expected postcondition; unexpected concurrent config changes fail. Never claim a resourceVersion observation conditionally fences a deploy request.
- [ ] Implement resource-scoped IAM `getIamPolicy`/`setIamPolicy` with etag in every write, desired additions preserving unrelated policy, and exact normalized read-back excluding only provider-controlled etag. Scope run.invoker, queue enqueuer/viewer, SA actAs and token creation to the corresponding role/resources. Do not grant project-wide workload access as a convenience.
- [ ] Implement actual Tasks and Scheduler paginated observations and exact pause/resume. Desired scheduler OIDC/target changes are a required auth-chain alignment substep while paused, after desired IAM additions and before final promotion/verification; reject task-level OIDC overrides inconsistent with producer/runtime configuration. Keep job paused and age/quiescence proof valid across updates. Queue-owned target/OIDC overrides, if present, must be exact and explicitly reviewed before change. No synthetic tasks.
- [ ] Implement Vercel closed producer alignment from an exact reviewed Git source and immutable deployment ID; prove alias ownership plus public source/fingerprint DTO. Project next-deploy encrypted metadata does not prove active gate values. Desired gate settings use protected deployment input and must be observed at runtime before state completion. Keep both false for the current rollout.
- [ ] Implement two bounded authenticated malformed-body receiver probes using reviewed invalid JSON body `'{'`, exact intended caller/audience and reviewed 400 response. This reaches parsing after auth without containing a real account/request/user/task. Use the actual receiver error code for each route; 401/403 do not prove successful auth. Compare side-effect observations across the entire window, account for log lag, do not retry ambiguous probes automatically.
- [ ] Test production adapter requests using injected fake transport, including etag/generation contents, exact paths, pagination, redirect rejection, all protected marker redaction and malformed responses. Live CLI must wire these concrete adapters, never test fixtures or callbacks that return supplied success booleans. Commit `feat: implement protected epoch control-plane adapters`.

## Task 8: Ordered coordinator through VERIFIED

**Files:** Create `coordinator.ts`, `coordinator.test.ts`.

- [ ] Build one fixed transition function per state. Put a fresh bounded precondition proof and lock check before each mutation, then exact post-read before transition append. Record each substep's durable observed result through safe digests so a crash before a whole-state append can reconcile exact existing results.

```ts
const completed = await journal.readValidatedState();
const stopIndex = STATES.indexOf('VERIFIED');
for (let index = completed === null ? 0 : STATES.indexOf(completed) + 1;
    index <= stopIndex; index += 1) {
    await lock.assertCurrent();
    const before = await transitions[STATES[index]].observeBefore();
    await transitions[STATES[index]].perform(before);
    const after = await transitions[STATES[index]].observeAfter();
    await lock.assertCurrent();
    await journal.appendVerifiedTransition(STATES[index], before, after);
}
```

Each transition implementation is a concrete adapter orchestration, not an injected proof assertion from a packet. Preparation initializes only storage after all admission proofs. Staging creates/reuses both no-traffic revisions. Producer alignment changes both fingerprints while closed. Queue alignment revalidates pause/emptiness. Invoker rotation adds desired grants and aligns paused auth contracts. Promotion uses the exact captured revisions, preflight then paid; retired invoker/enqueuer grants are removed only after both exact serving proofs. VERIFIED repeats public proof, full private proof, provider-free probes and complete zero-work evidence.

- [ ] Implement state-aware resume: recorded earlier snapshots are not demanded to equal the old state after a known completed mutation. Reconstruct expected intermediate state from exact journal/packet evidence; adopt only exact idempotent postconditions, never arbitrary current cloud state. Partial IAM addition/removal and one-role promotion are completed only after fresh proof.
- [ ] Test exact ordering and no mutation at PREPARED/VERIFIED except journal and probes; inject failure immediately before and after each actual submutation, restart with retained fake cloud/GCS and require deterministic safe recovery. Run coordinator tests, commit `feat: coordinate dual-role identity rotation through verification`.

## Task 9: Offline activation, compensation, and abort

**Files:** Extend coordinator/tests/journal.

- [ ] Require a separate activation authorization bound to current VERIFIED proof digest, packet, owner/fence, freshness window, exact source and independently reviewed gate values. `--through VERIFIED`, missing authorization, design approval alone or copied stale proof cannot activate. Current live dispatch never supplies this authorization.
- [ ] Implement the fixed activation order and immediate compensation. Once both public facts are proven, newly admitted tasks are legitimate; compare immutable queue config separately from task-list changes, preserve task contents and do not require pre-boundary emptiness again.

```ts
const resumeOrder = [
    ['scheduler', 'preflight'], ['scheduler', 'paid'],
    ['queue', 'preflight'], ['queue', 'paid'],
] as const;
```

- [ ] On any activation error, first attempt to close both Vercel gates, then pause every observed resumed resource even if one closure/pause fails; collect bounded failure codes and verify what actually closed. Never claim complete closure on a failed compensation. Preserve desired IAM/revisions, retention and tasks; non-empty queues require operator review/safe drain, not an automatic retry.
- [ ] Add durable abort records without overwriting transitions/header. Reject aborted capabilities and stale owners; perform only minimum safe closure under valid authority. Test public-open-before-first-resume, failure after each of four resumes, work arriving in the pause window, failed compensation, second abort, stale activation proof and post-VERIFIED drift. Commit `feat: fence activation and preserve work during epoch recovery`.

## Task 10: CLI and provider-free integration harness

**Files:** Create live CLI and integration harness; update `package.json`, `.github/workflows/ci.yml`.

- [ ] CLI defaults to check with no remote writes; explicit apply takes protected packet/capability descriptors and `--through VERIFIED`. Help/dry-run emits only abstract actions and digests. No arbitrary shell command, URL override, boolean exceptional path or fixture mode in production execution. A production activation command must demand the separate proof-bound authorization; current operator instructions never invoke it.
- [ ] Add scripts without implicit environment loading:

```json
"capacity:identity-epoch": "tsx scripts/run-capacity-identity-epoch.ts",
"test:identity-epoch": "vitest run scripts/capacity-identity-epoch scripts/capacity-identity-epoch.integration.test.ts lib/services/analysis/legacy-analysis-public-readiness.test.ts lib/services/analysis/public-readiness-contract.test.ts"
```

- [ ] Wire integration fixtures to fake cloud/clock/storage, with forbidden provider/billing/work/task APIs throwing and independently tracked counters. Run complete prepare-through-VERIFIED and crash/activation compensation matrices; no production credentials/network. Include a test proving live CLI construction uses real adapters and refuses absent protected inputs.

```ts
expect(result.state).toBe('VERIFIED');
expect(cloud.publicGates).toEqual({ preflight: false, paid: false });
expect(cloud.queues.map((queue) => queue.state)).toEqual(['PAUSED', 'PAUSED']);
expect(cloud.schedulers.map((job) => job.state)).toEqual(['PAUSED', 'PAUSED']);
expect(cloud.effects).toEqual({ providers: 0, billable: 0, tasks: 0, userWork: 0 });
expect(journal.states()).toEqual(STATES.slice(0, -1));
```

- [ ] Ensure CI runs focused tests and the shell readiness harness as required checks in addition to the existing full suite. Preserve existing PostgreSQL CI jobs; Docker Desktop local volume cleanup is unnecessary and unauthorized. Commit `test: require provider-free identity epoch release checks`.

## Task 11: Security review and complete verification

**Files:** Review all implementation paths; write only non-secret results in the review report and runbook.

- [ ] Run focused tests and both shell regression suites. Run `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`, `npm audit --audit-level=high`, and `git diff --check`. Use CI-like fake build environment through a safe process environment, never production `.env.local` in tests. Record required skipped native database suites accurately and obtain their GitHub CI results before landing.
- [ ] Review packet injection, forged capability, lost lease during long operation, cross-epoch overlap, ordinary-script races, stale cleanup, resource/project confusion, IAM conditions/extra grants, output leakage and live-adapter wiring. Test unique protected canary marker strings in every exception/stdout/stderr/journal path. Redaction must operate by output allowlist, not regex-only scrubbing of arbitrary errors.
- [ ] Add a spec section/acceptance-row-to-test map. No claim of completeness based only on mocks: include exact HTTP/CLI request contract tests and actual live evidence source support. No real provider calls are a prerequisite for declaring this code tested.
- [ ] Coordinator independently reviews the diff; route corrections through the same visible Luna max worker. Then dispatch a fresh visible read-only Orca reviewer over the exact candidate commit for independent pre-landing security/correctness review; no reviewer code writes. Resolve substantive findings through the implementation worker and rerun only affected checks plus required CI.

## Task 12: PR, green CI, exact-source landing

**Files:** Implementation worker prepares the PR and final code/report corrections.

- [ ] Confirm exact diff contains approved design history, plan and implementation only. Preserve design commits, append ordinary commits, and merge/restack latest `origin/main` non-destructively if it has advanced.
- [ ] Worker creates a GitHub PR against `main` with concrete problem/result, separate VERIFIED boundary and actual validation. Do not include protected values in PR text.
- [ ] Coordinator reviews exact PR HEAD and every required CI result, including security audit and native PostgreSQL jobs. Resolve all findings before merge; do not bypass failing checks. Merge authorized implementation only after green CI.
- [ ] Fetch and record exact merged Git SHA; verify production Git-backed Vercel deployment and alias both point to this SHA. If automatic deployment is closed but v3 is not yet serving, use the exact merged source to deploy readiness v3 with both gates false. No activation changes.

## Task 13: Protected production preparation and VERIFIED stop

**Files:** No application code edits during rollout; an approved safe adapter correction returns to review/CI/source alignment first.

- [ ] Re-observe all historical facts; no checkpoint result substitutes for live evidence. Locate existing protected manifests/operator inputs by safe metadata, never print values. Confirm current canonical main through `git worktree list` and source checks; don't force-update a dirty checkout.
- [ ] Verify public v3 exact shape, `ready=true`, both gates false, source and fingerprints. Independently observe exact Run/IAM/Tasks/Scheduler/retention/source/baseline ledgers; form complete old manifest from those observations and validate existing reviewed desired inputs. Missing complete identities, aged pause provenance, adapter permissions or ledger evidence are real blockers; never invent inputs or replace them with confirmed booleans.
- [ ] Run read-only packet/coordinator check, inspect only safe action/digest summary, then run the same protected reviewed packet through `VERIFIED` under the production coordinator dispatch. Credential use is confined to authenticated operator observation/control-plane operations. It does not authorize provider work, secret rotation or production data mutation.
- [ ] Independently re-read the finished journal, locks, exact source/revision/IAM/fingerprints, both closed gates, both PAUSED empty queues, both PAUSED aged schedulers, enabled retention and zero-work evidence. No `ACTIVATED` record or resume/gate-open command may be present.
- [ ] Present safe evidence with exact code/CI alignment, phase, proof outcomes and unresolved limitations. Save a new append-only checkpoint. Stop here for separate activation approval; the real canary remains user-run.

## Plan review (coordinator, 2026-09-07)

| Design requirement | Implementation tasks | Review result |
| --- | --- | --- |
| Eight slots, separate build, old/shared/retired rules, complete protected inputs | 4, 6, 13 | Covered; reject absence rather than invent prior enqueuer evidence. |
| Additive exact readiness, independent gates, unchanged ready and routes | 2, 3 | Covered; use actual gate parsers and duplicate-aware wire parsing. |
| Immutable header, GCS generation lock, append-only contiguous journal | 5, 8 | Covered; journal is state source; generation strings avoid precision loss. |
| Single owner across epochs and ordinary deployment tools | 5 | Covered with common resource exclusion plus legacy lock participation; epoch remains sole state machine. |
| Real CAS/observation controls, desired revisions captured only at STAGED | 6, 7, 8 | Covered; no invented Tasks/Scheduler etags or Run request CAS. |
| Producer closure, quiescence, IAM add, both promote, retired grant removal | 7, 8 | Covered; explicit paused scheduler OIDC alignment closes auth-chain omission. |
| Crash resume, stale owner, abort, partial activation and admitted tasks | 5, 8, 9 | Covered; unknown compensation cannot be reported as closure. |
| All section 10 tests, provider-free probes, real evidence and redaction | 3–11, 13 | Covered; no fake live adapters or queue snapshots masquerading as zero-work proof. |
| Review, green CI, merge, Vercel SHA, VERIFIED gate, no real canary | 11–13 | Covered; current authority stops before activation. |

Self-review found and resolved five implementation hazards: gate-parser disagreement, duplicate JSON keys hidden by jq, per-service-only locks permitting a second epoch, paused scheduler OIDC drift, and empty queue snapshots being insufficient zero-task evidence. These are concrete implementations of approved invariants, not changes to the approved operating direction. Follow-up decisions that materially change the design require coordinator review.

Primary API references checked during planning: [GCS request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions), [Cloud Tasks paginated task listing](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/list), [Cloud Run services](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services), and [Vercel deployments](https://vercel.com/docs/deployments/overview). Re-check the exact endpoint contract while implementing each live adapter.

Plan status: coordinator review complete; supervised implementation and independent negative-case review are in progress. The 2026-09-07 maintenance-entry clarification above records a bounded file-map omission under the approved shared-exclusion invariant. Milestone acceptance and test outcomes are tracked separately; a commit or smoke-test pass does not imply review acceptance. The user already selected supervised visible Orca execution, so no execution-choice confirmation is required.
