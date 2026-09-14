# Production VERIFIED evidence completion Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the current production evidence blocker through two narrowly allowlisted
existing-resource mutations, collect a fresh owner-only zero-work window, and stop at
`VERIFIED`/`VERIFIED_OK` before activation or canary.

**Architecture:** A separate owner-only `unblock inspect`/`unblock apply` pair first
resolves one complete exact cross-plane graph and, only with an approved digest, creates
missing non-secret selectors and sets sampling on exactly two existing PAUSED queues.
Only then do the existing `prepare inspect/apply` and `epoch inspect/apply` stages run.
No protected value leaves owner memory or the existing inherited-FD boundary.

**Tech Stack:** Existing TypeScript owner/evidence modules, Node.js `tsx`, Vercel/Google
Cloud/Supabase owner transports, and focused tests/typecheck only in a future implementation
change.

---

## Boundary and current blocker

The current owner-only preparation attempt is `EVIDENCE_UNAVAILABLE`: exact production
bindings are missing and TaskActivityLog sampling on the paused queues is not full. This
is not retrospective evidence. This packet changes planning documents only; it does not
run production, tests, CI, Supabase, deployment, or mutation.

Only these prospective unblock mutations are allowed:

1. Bind an absent allowlisted selector field to an independently proven existing resource.
   Existing non-empty values are cross-checks and cannot be overwritten.
2. Set `stackdriverLoggingConfig.samplingRatio` to `1.0` on exactly the two packet-fixed
   existing queues, both already `PAUSED`.

Both require a safe before-state digest, independent review, exact read-back, bounded
rollback, and a fresh evidence window afterward. No new sink, schema, table, queue,
scheduler, bucket, or other resource is allowed.

## Files and worker split

- Read: `docs/superpowers/specs/2026-09-14-owner-only-production-evidence-collection-amendment.md`
- Read: `docs/superpowers/specs/2026-09-14-owner-only-identity-epoch-descriptor-preparation-design.md`
- Read: `docs/analysis-v2-production-operations.md`
- Read: `docs/reports/2026-09-11-preflight-admin-final-gap-audit.md`
- Read: `docs/reports/2026-09-11-supabase-22-wave1-production-readonly-evidence.md`
- Read later: owner discovery/production/transport modules and their existing focused tests.
- Future implementation may modify only the owner CLI/operator and focused tests required
  for the separate unblock boundary; this documentation correction modifies no runtime,
  migration, configuration, landing-copy, or protected file.

- [ ] Dispatch implementation only after this plan is independently reviewed.
- [ ] Dispatch a different fresh visible Orca Codex `gpt-5.6-luna`, effort `max`,
  to review the implementation diff and safe digests/counts before any production call.

## Task 1: Freeze the reviewed source and blocker

**Files:** read-only files above.

- [ ] Fetch and prove the reviewed source:

  ```sh
  git fetch origin main --prune
  git status --short --branch
  git rev-parse HEAD
  git rev-parse origin/main
  git diff --name-only origin/main...HEAD
  ```

  Require a clean reviewed implementation worktree except its scoped owner diff; no
  runtime, migration, configuration, landing-copy, or protected-file change.
- [ ] Preserve `EVIDENCE_UNAVAILABLE` as the current blocker. Do not copy any old count,
  checksum, task listing, or log result into the new evidence window.

## Task 2: Add the separate owner-only unblock boundary

**Files (future implementation only):**

- Modify: `scripts/prepare-capacity-identity-epoch.ts`
- Modify: `scripts/capacity-identity-epoch/owner-production.ts` and existing owner operator
  only as needed
- Create only if needed: a narrow unblock module and focused tests

- [ ] Parse exactly `unblock inspect` and
  `unblock apply --approved-digest DIGEST` before the existing
  `prepare inspect/apply` commands. `unblock inspect` is read-only and has no digest
  input; `unblock apply` accepts only its immediately preceding safe digest. Do not
  make either command a `prepare` subcommand or make the phases call one another to
  construct a digest.
- [ ] `unblock inspect` reads only surviving exact Vercel deployment/alias/env/readiness,
  Cloud Run service/revision/build, Cloud Tasks queue, recovery/retention Scheduler,
  IAM, fixed Supabase ledger, TaskActivityLog/pause-provenance, and GCS lock/journal
  anchors. Build forward and reverse indexes for deployment↔readiness, revision↔build,
  queue↔service/target, scheduler↔service, audit stream↔queue/scheduler, ledger↔runtime,
  and lock↔project. Every edge must agree on project and scope in both directions.
- [ ] Accept only one complete graph. Incomplete pagination, duplicates, mixed scope,
  missing reverse edges, stale source/build, or competing graphs returns
  `DISCOVERY_AMBIGUOUS` or `EVIDENCE_UNAVAILABLE`; never choose by substring, recency,
  lexical order, first match, fallback, or report.
- [ ] Keep all project/resource values, identities, URLs, env values, credentials, and raw
  provider bodies in memory only. Emit the digest plus bounded missing/existing field
  counts, exact queue count (`2`), PAUSED count, and planned sampling-change count;
  never emit protected values.

## Task 3: Freeze the selector allowlist and provider operation shapes

The only missing-field creates use these exact environment key names already in
`owner-production.ts`:

```text
ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET
ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE
ANALYSIS_CAPACITY_TASK_AUDIT_LOG_NAME
ANALYSIS_CAPACITY_TASK_AUDIT_SINK_NAME
ANALYSIS_CAPACITY_TASK_AUDIT_BUCKET_RESOURCE
ANALYSIS_CAPACITY_TASK_AUDIT_CORRELATION
ANALYSIS_CAPACITY_SCHEDULER_AUDIT_LOG_NAME
ANALYSIS_CAPACITY_SCHEDULER_AUDIT_SINK_NAME
ANALYSIS_CAPACITY_SCHEDULER_AUDIT_BUCKET_RESOURCE
ANALYSIS_CAPACITY_SCHEDULER_AUDIT_CORRELATION
VERCEL_PRODUCER_ALIAS
PREFLIGHT_TASKS_PROJECT
PREFLIGHT_TASKS_LOCATION
PREFLIGHT_TASKS_QUEUE
PREFLIGHT_TASKS_CLOUD_RUN_SERVICE
PREFLIGHT_TASKS_CLOUD_RUN_REGION
PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB
PREFLIGHT_TASKS_MAINTENANCE_LOCATION
ANALYSIS_V2_TASKS_PROJECT
ANALYSIS_V2_TASKS_LOCATION
ANALYSIS_V2_TASKS_QUEUE
ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE
ANALYSIS_V2_TASKS_CLOUD_RUN_REGION
ANALYSIS_V2_RECOVERY_SCHEDULER_JOB
ANALYSIS_V2_MAINTENANCE_LOCATION
ANALYSIS_V2_RETENTION_SCHEDULER_JOB
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_URL
```

`SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are excluded
credentials; no credential, secret, or secret reference is eligible. Derive each missing
field only from existing exact relationships:

| Key group | Exact surviving relationship |
| --- | --- |
| `ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET` | Existing GCS epoch journal/lock namespace correlated one-to-one with the selected queue/service/scheduler/build/readiness graph. |
| `ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE` | The same `legacyTargetResource` returned by old and desired public readiness and consistent with the selected queue/service/build scope. |
| `ANALYSIS_CAPACITY_TASK_AUDIT_LOG_NAME`, `ANALYSIS_CAPACITY_TASK_AUDIT_SINK_NAME`, `ANALYSIS_CAPACITY_TASK_AUDIT_BUCKET_RESOURCE`, `ANALYSIS_CAPACITY_TASK_AUDIT_CORRELATION` | Existing TaskActivityLog stream/sink/bucket/correlation that scopes both selected queues, their services/builds, and their project. |
| `ANALYSIS_CAPACITY_SCHEDULER_AUDIT_LOG_NAME`, `ANALYSIS_CAPACITY_SCHEDULER_AUDIT_SINK_NAME`, `ANALYSIS_CAPACITY_SCHEDULER_AUDIT_BUCKET_RESOURCE`, `ANALYSIS_CAPACITY_SCHEDULER_AUDIT_CORRELATION` | Existing pause-provenance stream/sink/bucket/correlation for the two selected recovery schedulers, their services/builds, and their project. |
| `VERCEL_PRODUCER_ALIAS` | The single alias pointing to the selected old production deployment and matching its readiness origin/source and the same service/build graph. |
| `PREFLIGHT_TASKS_PROJECT`, `PREFLIGHT_TASKS_LOCATION`, `PREFLIGHT_TASKS_QUEUE` | Project/location/name of the one exact preflight queue whose target/caller points to the selected preflight service and matching build/readiness. |
| `PREFLIGHT_TASKS_CLOUD_RUN_SERVICE`, `PREFLIGHT_TASKS_CLOUD_RUN_REGION` | Name/region of that one ready preflight service/revision and its exact queue target, worker path, build, and readiness. |
| `PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB`, `PREFLIGHT_TASKS_MAINTENANCE_LOCATION` | Name/location of the one recovery job targeting the same project/service and matching queue, build, maintenance identity, and pause provenance. |
| `ANALYSIS_V2_TASKS_PROJECT`, `ANALYSIS_V2_TASKS_LOCATION`, `ANALYSIS_V2_TASKS_QUEUE` | Project/location/name of the one exact V2 queue whose target/caller points to the selected V2 service and matching build/readiness. |
| `ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE`, `ANALYSIS_V2_TASKS_CLOUD_RUN_REGION` | Name/region of that one ready V2 service/revision and its exact queue target, worker path, build, and readiness. |
| `ANALYSIS_V2_RECOVERY_SCHEDULER_JOB`, `ANALYSIS_V2_MAINTENANCE_LOCATION` | Name/location of the one recovery job targeting the same project/service and matching queue, build, maintenance identity, and pause provenance. |
| `ANALYSIS_V2_RETENTION_SCHEDULER_JOB` | The one existing enabled retention job in the same queue/service/scheduler/build/readiness scope, distinct from both recovery jobs. |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL` | The one authenticated Supabase origin serving the three fixed ledgers and matching the selected queue/service/scheduler/build/readiness graph; a missing twin may derive only from the other exact origin. |

For every key, an existing non-empty value is a cross-check only. Create only an absent
field; an empty, duplicate, branch-scoped, multi-target, sensitive, or conflicting row
stops the operation. No actual project, resource, identity, URL, or protected value is
written in this plan.

- [ ] Vercel create is exactly one authenticated
  `POST /v10/projects/{vercelProjectId}/env?teamId={vercelTeamId}` per missing key,
  with body `{key, value, type: "plain", target: ["production"]}`. No update, overwrite,
  extra target, `gitBranch`, custom-environment ID, sensitive/encrypted type, or
  duplicate key is allowed. Read every created row back through the exact env reader.
- [ ] Cloud Tasks mutation is exactly two authenticated requests, one per canonical
  existing PAUSED queue:

  ```text
  PATCH /v2/{exactQueueResource}?updateMask=stackdriverLoggingConfig.samplingRatio
  body: {"stackdriverLoggingConfig":{"samplingRatio":1.0}}
  ```

  Read both full queue objects back and require the same queue resources, state `PAUSED`,
  unchanged configuration except sampling, and exact ratio `1.0`. No other queue,
  task, field, sink, exclusion, scheduler, gate, IAM policy, or resource is touched.
- [ ] Keep before/after digests, created env IDs, and prior sampling values in memory.
  Rollback may only delete rows created by this invocation with
  `DELETE /v9/projects/{vercelProjectId}/env/{createdEnvId}?teamId={vercelTeamId}`
  and restore the two prior sampling values with the same two exact Cloud Tasks PATCH
  shapes. Never delete a pre-existing env row or restore a guessed value. Rollback
  failure is terminal owner review; do not retry or broaden scope.

## Task 4: Independent implementation review

**Files:** the future Task 2-3 implementation diff and focused tests.

- [ ] Verify the parser boundary, single complete graph, bidirectional edges, exact
  allowlist, memory-only protected values, exact provider request shapes, before/after
  digest, read-back, rollback, and no-new-resource boundary.
- [ ] Verify no token, cookie, UUID, URL, raw manifest/provider body, or child stderr
  reaches argv, env, output, Git, journal, ordinary files, or Orca messages.
- [ ] Approve only safe digests/counts. Any finding requires correction and another review
  before a production call.

## Task 5: Run the unblock pair

**Files:** existing owner CLI; production mutation only after Task 4 approval.

- [ ] Validate owner authentication, pinned CLI, canonical linked source, closed public
  gates, exact single graph, and output boundaries. Run:

  ```sh
  node --import tsx scripts/prepare-capacity-identity-epoch.ts unblock inspect
  ```

  Require a safe `UNBLOCK_DIGEST`, exactly two queue selectors, both queues `PAUSED`,
  and the reviewed missing-field/sampling counts. If uniqueness or before-state evidence
  is unavailable, stop with `DISCOVERY_AMBIGUOUS`/`EVIDENCE_UNAVAILABLE`.
- [ ] A separate reviewer approves the safe digest, exact graph/counts, after policy
  (`samplingRatio=1.0`), and rollback scope. Run from the same owner session:

  ```sh
  node --import tsx scripts/prepare-capacity-identity-epoch.ts unblock apply --approved-digest "$UNBLOCK_DIGEST"
  ```

  The command must re-read the graph and refuse stale digest, changed existing value,
  non-PAUSED queue, extra candidate, or any field/resource drift before the first write.
- [ ] Require exact env/queue read-back and the reviewed after digest. On any failure,
  execute only the bounded rollback, verify its digest, and stop if rollback fails.
  Discard the pre-mutation observation before starting a fresh baseline-to-verification
  window.

## Task 6: Existing preparation, only after unblock

- [ ] Run the existing read-only preparation command after successful unblock read-back:

  ```sh
  node --import tsx scripts/prepare-capacity-identity-epoch.ts prepare inspect
  ```

  Require exact selectors, closed gates, PAUSED/empty queues, separated retention,
  scheduler provenance, and an independently approved preparation digest.
- [ ] Run `prepare apply --approved-digest "$APPROVED_DIGEST"` only for the existing
  account/scheduler allowlist. It may create missing keyless accounts and pause enabled
  recovery schedulers; it may not repeat selector/sampling changes, create keys, alter
  IAM/retention/queues/gates, deploy, or resume.
- [ ] Read every allowed mutation back. A scheduler grace miss is
  `QUIESCENCE_PENDING`; wait outside the process and begin another fresh inspect. Do not
  resume or compensate automatically.

## Task 7: Fresh epoch evidence and terminal boundary

- [ ] Run `epoch inspect` twice with new authenticated clients. Require equal packet,
  bootstrap, scope, identity-graph, source/build/runtime/readiness, fixed-ledger,
  TaskActivityLog, queue, scheduler, permission, and ingestion-lag digests. Counts of
  zero with incomplete coverage remain `EVIDENCE_UNAVAILABLE`.
- [ ] After independent approval, run:

  ```sh
  node --import tsx scripts/prepare-capacity-identity-epoch.ts epoch apply --approved-digest "$APPROVED_DIGEST" --through VERIFIED
  ```

  Accept only existing check success, coordinator `VERIFIED`, and verifier
  `VERIFIED_OK`. The inherited-FD bridge never writes descriptors to disk, env, argv,
  journal, or ordinary files.
- [ ] Verify safe terminal facts: public gates closed, both queues paused/empty, recovery
  schedulers paused/aged with provenance, and retention enabled. Stop here; no activation,
  gate-open, queue/scheduler resume, provider/user work, or real `0_min._.00` canary.

## Task 8: Future runbook amendment

**Files (future implementation task, not this docs-only packet):**

- Modify: `docs/analysis-v2-production-operations.md`

- [ ] Amend the runbook's current logging-change prohibition only for this reviewed
  prospective exception: exactly the two existing canonical PAUSED queues, only
  `stackdriverLoggingConfig.samplingRatio`, target `1.0`, with owner digest,
  independent approval, exact read-back, and rollback limited to created env rows plus
  the two prior sampling values.
- [ ] Document `unblock inspect` and
  `unblock apply --approved-digest` before the existing `prepare inspect/apply`
  commands, including the single-graph and memory-only boundary. Do not broaden the
  prohibition for any other logging configuration or resource, and do not edit the
  runbook in this docs-only correction unless one consistency line in the plan is needed.

## Stop and acceptance

- [ ] Stop with `DISCOVERY_AMBIGUOUS`/`EVIDENCE_UNAVAILABLE` on missing/ambiguous
  graph, stale digest, incomplete page/window/permission/lag coverage, non-PAUSED queue,
  existing-value conflict, extra field/resource, unsafe output, or failed rollback.
- [ ] No new sink/schema/table/queue/scheduler/bucket/resource exists; no remote migration,
  Supabase repair/replay/push, payment-state mutation, deployment, activation, or canary
  occurs in this plan.
- [ ] Any future implementation commit contains only the reviewed owner files/tests plus
  the separately reviewed runbook amendment. This packet itself contains only scoped
  planning-document corrections.
