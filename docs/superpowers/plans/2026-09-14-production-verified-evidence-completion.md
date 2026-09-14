# Production VERIFIED evidence completion Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the known evidence blocker through two narrowly allowlisted existing-resource mutations, collect a fresh owner-only zero-work window, and stop at `VERIFIED`/`VERIFIED_OK` before activation or canary.

**Architecture:** Reuse the existing owner CLI, packet, coordinator, and verifier. Add one explicit `prepare unblock` gate for exact selector bindings and exact-queue logging sampling; require before/after digests, independent review, read-back, rollback, and a fresh observation before the existing four-stage path continues.

**Tech Stack:** Existing TypeScript owner/evidence modules, Node.js `tsx`, Vercel/Google Cloud/Supabase owner transports, and focused tests/typecheck only when this future code change requires them.

---

## Boundary and current blocker

The current owner-only `prepare inspect` blocker is
`EVIDENCE_UNAVAILABLE`: exact production bindings are missing and TaskActivityLog
sampling on the paused queues is not full. This is not retrospective evidence.
The preflight/admin gap audit and W1A read-only report are context only; neither
can satisfy the new window.

Only these prospective unblock mutations are allowed:

1. Bind owner configuration to independently verified exact resources that already
   exist; no guessed, substring, first-match, or fallback selector.
2. Set `stackdriverLoggingConfig.samplingRatio` to `1.0` on exactly the two
   packet-fixed existing queues, both already `PAUSED`.

Both require a safe before-state digest, independent review, exact read-back,
bounded rollback to the before-state, and a fresh evidence window afterward. No
new sink, schema, table, queue, scheduler, bucket, or other resource is allowed.

## Files and worker split

- Read: `docs/superpowers/specs/2026-09-14-owner-only-identity-epoch-descriptor-preparation-design.md`
- Read: `docs/superpowers/specs/2026-09-14-owner-only-production-evidence-collection-amendment.md`
- Read: `docs/analysis-v2-production-operations.md`
- Read: `docs/reports/2026-09-11-preflight-admin-final-gap-audit.md`
- Read: `docs/reports/2026-09-11-supabase-22-wave1-production-readonly-evidence.md`
- Read: `scripts/prepare-capacity-identity-epoch.ts`, `scripts/capacity-identity-epoch/owner-preparation-operator.ts`, `owner-production.ts`, `owner-discovery.ts`, and `live-evidence.ts`
- Modify only if a gap is proven: the existing owner operator/transport modules
  and their existing focused tests; do not edit app runtime, migrations,
  package/config files, `AGENTS.md`, landing copy, or protected paths.

- [ ] Dispatch implementation to a fresh visible Orca Codex `gpt-5.6-luna`,
  effort `max`. It may add only the explicit `prepare unblock` operation and
  its existing-module tests; it must not run production or add an abstraction,
  sink, schema, table, resource, or activation path.
- [ ] Dispatch independent review to a different fresh visible Orca Codex
  `gpt-5.6-luna`, effort `max`. The reviewer receives only safe digests/counts,
  checks the mutation allowlist and rollback, and approves before production.

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

  Expected: clean reviewed implementation worktree except its scoped diff; no
  runtime, migration, configuration, landing-copy, or protected-file change.

- [ ] Re-read the approved design/amendment and preserve the current blocker as
  `EVIDENCE_UNAVAILABLE`; do not copy any old count/checksum/task listing into
  the new evidence window.

## Task 2: Implement only the missing unblock guard

**Files:**

- Modify, only if needed: `scripts/prepare-capacity-identity-epoch.ts`
- Modify, only if needed: `scripts/capacity-identity-epoch/owner-preparation-operator.ts`
- Modify, only if needed: `scripts/capacity-identity-epoch/owner-production.ts`
- Modify, only if needed: their existing focused tests

- [ ] Prove whether current code can emit a safe before-state digest, verify two
  exact paused queue objects, and read back exact selector/sampling changes. If
  it already can, make no code change.
- [ ] Otherwise add the existing-boundary `prepare unblock` operation:

  ```sh
  node --import tsx scripts/prepare-capacity-identity-epoch.ts prepare unblock --approved-digest "$UNBLOCK_DIGEST"
  ```

  It must re-read the approved before-state and mutate only exact existing
  selector bindings and `samplingRatio=1.0` on the two exact existing PAUSED
  queues. It must reject stale/ambiguous/mixed-scope selectors and any extra
  resource or field; no ad-hoc shell/API mutation is permitted.
- [ ] Implement bounded rollback using the recorded before-state digest for
  partial write, read-back failure, queue-state drift, or after-state mismatch.
  Rollback changes only the same selector fields and the same two sampling
  values; rollback failure is terminal with gates/queues closed.
- [ ] If code changed, run only affected existing focused tests and:

  ```sh
  npx tsc --noEmit --pretty false
  git diff --check
  ```

  Expected cases: missing/ambiguous binding, stale before digest, non-PAUSED
  queue, extra-field drift, exact two-queue sampling, read-back failure,
  rollback, and protected-output leakage. No full suite, lint, build, or CI.

## Task 3: Independent code review

**Files:** review Task 2 diff/tests plus the approved design/amendment.

- [ ] Reviewer verifies no token, cookie, UUID, URL, raw manifest/provider body,
  or child stderr reaches argv, env, output, Git, journal, ordinary files, or
  Orca messages.
- [ ] Reviewer verifies the only prospective unblock writes are exact existing
  selector bindings and `samplingRatio=1.0` on exactly two existing PAUSED
  queues, with before digest, independent approval, read-back, rollback, and no
  new sink/schema/table/resource.
- [ ] Reviewer verifies the existing packet/coordinator/verifier semantics and
  the terminal no-activation boundary are unchanged.

## Task 4: Read-only inspect and before-state gate

**Files:** existing owner CLI; no production mutation.

- [ ] Validate owner authentication, pinned CLI, clean reviewed source, closed
  public gates, and protected output boundaries without sourcing dotenv files.
- [ ] Run:

  ```sh
  node --import tsx scripts/prepare-capacity-identity-epoch.ts prepare inspect
  ```

  Require safe `beforeStateDigest`, exact selector bindings (or a bounded list
  of missing binding fields), exactly two queue selectors, and both queues
  `PAUSED`. If exact identity or before-state digest is unavailable, stop.
- [ ] A separate reviewer approves the before digest, exact selector fields,
  exact two queues, after policy (`samplingRatio=1.0`), rollback digest, and
  no-new-resource boundary. Approval contains no protected values.

## Task 5: Apply the two allowed unblock mutations

**Files:** existing owner operator only.

- [ ] Run the reviewed command from the same owner session:

  ```sh
  node --import tsx scripts/prepare-capacity-identity-epoch.ts prepare unblock --approved-digest "$UNBLOCK_DIGEST"
  ```

  The command must refuse a changed before digest. It may bind only the reviewed
  existing-resource selectors and set only the two exact paused queues’ sampling
  ratio to `1.0`; it may not touch logging sinks/exclusions, queue state,
  schedulers, IAM, accounts, deployment, payment, provider, schema, or tables.
- [ ] Read every changed selector and both queue objects back. Accept only the
  reviewed after-state digest, both queues still `PAUSED`, both ratios exactly
  `1.0`, and no additional field/resource drift.
- [ ] On any failure, use the checked-in bounded rollback to restore the recorded
  before-state and verify a rollback digest. If rollback fails, stop with gates
  and queues closed; do not retry or broaden scope.
- [ ] After successful read-back, discard the pre-mutation observation and start
  a fresh baseline-to-verification window. Re-run `prepare inspect`; no prior
  count, checksum, task listing, or log result is evidence for that window.

## Task 6: Existing base preparation, only as a separate gate

The approved design’s missing keyless-account creation or recovery-scheduler
pause is not an unblock mutation and must not be folded into `prepare unblock`.

- [ ] If still required, obtain a new digest/review after Task 5 and run:

  ```sh
  node --import tsx scripts/prepare-capacity-identity-epoch.ts prepare apply --approved-digest "$APPROVED_DIGEST"
  ```

  Require the existing account/scheduler allowlist and read-back. Do not change
  selector bindings or sampling through this command.
- [ ] If it mutates or returns `QUIESCENCE_PENDING`, keep gates/queues closed,
  wait outside the process for the configured grace, and begin another fresh
  inspect window. Never resume or compensate automatically.

## Task 7: Fresh epoch evidence and terminal boundary

- [ ] Run `node --import tsx scripts/prepare-capacity-identity-epoch.ts epoch inspect`.
  Require two new independent passes, exact matching packet/bootstrap/scope/
  identity digests, complete pages, sampling `1.0`, full interval/permissions/
  ingestion-lag coverage, all three fixed ledgers, and no drift. Zero with
  incomplete coverage is `EVIDENCE_UNAVAILABLE`.
- [ ] Obtain independent approval of the safe proposal digest, then run:

  ```sh
  node --import tsx scripts/prepare-capacity-identity-epoch.ts epoch apply --approved-digest "$APPROVED_DIGEST" --through VERIFIED
  ```

  Accept only existing check success, coordinator `VERIFIED`, and verifier
  `VERIFIED_OK`. The inherited-FD bridge must never write descriptors to disk,
  env, argv, journal, or ordinary files.
- [ ] Verify safe terminal facts: both public gates closed, both queues paused/
  empty, recovery schedulers paused/aged with provenance, retention enabled.
  Stop here: no activation, gate-open, queue/scheduler resume, provider/user
  work, or real `0_min._.00` canary.

## Stop, rollback, and handoff

- [ ] Stop on missing/ambiguous binding, stale digest, non-PAUSED queue,
  sampling not `1.0`, incomplete pagination/window/permissions/lag coverage,
  extra field/resource drift, or unsafe output.
- [ ] Unblock rollback is limited to the recorded selector fields and two queue
  sampling values; rollback failure is a terminal owner-review stop.
- [ ] A failed later coordinator child closes pipes and stops without running the
  next child or activating; reconcile only through existing fail-closed rules.
- [ ] Implementation commits only scoped owner files, reviewer records approval,
  and coordinator records safe codes/digests/counts only.

## Observable acceptance and self-review

- [ ] Current blocker is either honestly `EVIDENCE_UNAVAILABLE` or closed by the
  reviewed two-mutation gate; no retrospective evidence is claimed.
- [ ] No new sink/schema/table/resource exists; only exact existing selectors and
  two exact paused queues were changed, with before/after/rollback digests and
  fresh evidence after read-back.
- [ ] Existing coordinator reaches `VERIFIED`, verifier returns `VERIFIED_OK`,
  and activation/canary/provider/user work does not occur.
- [ ] `git status` contains only approved owner-evidence files; no runtime,
  migration, package, config, or landing-copy edit is present.

Self-review: the amendment, current blocker, two-mutation allowlist, review,
read-back/rollback, fresh-window rule, existing four-stage execution, and
`VERIFIED` stop are all covered above; no old evidence is used as a gate.
