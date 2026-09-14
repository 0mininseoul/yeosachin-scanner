# Supabase operational contraction next wave Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the current migration-provenance blocker and identify only the smallest evidence-proven Supabase contraction subset while preserving service contracts and data.

**Architecture:** Reuse `supabase-operational-policy-v1` and existing read-only collectors. Approve zero or more exact families from fresh caller/dependency evidence; only a fixed no-CASCADE migration with resolved provenance may reach an isolated coordinator gate. The former exact-22 target is retired.

**Tech Stack:** Supabase CLI `2.102.0`, PostgreSQL catalog queries, existing TypeScript evidence/verifier scripts, and focused contract/type checks only when future code changes require them.

---

## Current baseline and hard blockers

The dated reports on `origin/main` record **152 public base/partitioned tables
after W1A**, six local-only and six remote-only migration versions, and **two
unresolved remote-only rows**. The three-table `analysis_v2_replay_capture`
cluster is empty but blocked by deployed routine/FK dependencies and is not an
approved drop target. These are report-derived context, not fresh approval
evidence or a desired table count.

This planning task performs no Supabase read, repair, migration, DDL/DML,
`db push`, payment mutation, test, CI, or deployment. No arbitrary 22-table
target, new sink/schema/table, or data-preservation shortcut is allowed.

## Files and worker split

- Read: `docs/reports/2026-09-13-supabase-next-contraction-audit.md`
- Read: `docs/reports/2026-09-13-supabase-migration-provenance-reconciliation.md`
- Read: `docs/superpowers/specs/2026-09-13-supabase-operational-simplification-design.md`
- Read: `lib/services/operations/supabase-22-evidence.ts`
- Read: `scripts/generate-supabase-22-retirement-inventory.ts`
- Read: `scripts/verify-supabase-22-catalog.ts`
- Read: `lib/services/analysis/replay/replay-supabase-repository.ts`
- Modify only after all gates pass: existing callers/evidence files, one exact
  migration, and its existing-style verifier/restore artifact if needed.
- Never modify historical migrations, retained/payment/operator contracts,
  `app/page.tsx`, `.playwright-mcp/`, `AGENTS.md`, or the protected migration.

- [ ] Dispatch implementation to a fresh visible Orca Codex `gpt-5.6-luna`,
  effort `max`, only after provenance and fresh evidence permit an edit.
- [ ] Dispatch independent review to a different fresh visible Orca Codex
  `gpt-5.6-luna`, effort `max`; it approves no unresolved provenance or broad
  allowlist.

## Task 1: Freeze provenance without repair

- [ ] Fetch and prove the source:

  ```sh
  git fetch origin main --prune
  git status --short --branch
  git rev-parse origin/main
  git diff --name-only origin/main...HEAD
  ```

- [ ] From the canonical owner worktree and linked authenticated CLI, run only:

  ```sh
  npx --yes supabase@2.102.0 --version
  npx --yes supabase@2.102.0 migration list --linked
  ```

  Do not source dotenv files, print credentials/project references/raw rows, use
  a connector, or read machine manifests into the report.
- [ ] Compare local/remote version sets and bounded statement hashes. Require
  owner-reviewed exact source plus current routine body/ACL/constraint/
  dependency proof for both unresolved remote-only rows. Four non-main exact
  source matches remain provenance artifacts; do not import them automatically.
- [ ] If either row remains unresolved, record `BLOCKED_NO_CHANGE` and stop. Do
  not run `migration repair`, `supabase db push`, or
  `supabase db push --include-all`, add guessed migrations, or replay SQL.

## Task 2: Collect fresh diagnostic contraction evidence

**Files:** existing evidence/verifier scripts only; no production mutation.

- [ ] Run the existing inventory with protected owner variables and bounded,
  sanitized output:

  ```sh
  node --import tsx scripts/generate-supabase-22-retirement-inventory.ts --project-ref "$SUPABASE_PROJECT_REF" --cli-path "$SUPABASE_CLI_PATH"
  node --import tsx scripts/verify-supabase-22-catalog.ts --report-only --project-ref "$SUPABASE_PROJECT_REF"
  ```

  The inventory/verifier remains diagnostic and blocked; exit status `1` from
  the catalog verifier is expected when readiness is incomplete. Never pass
  destructive flags or a caller-supplied readiness boolean.
- [ ] In one fresh window, verify exact source callers, deployed routine
  signatures/`SECURITY DEFINER`/`search_path`/ACL, RLS/force-RLS, FK/view/
  sequence/publication/trigger/`pg_depend`, flags/config, operator-audit
  independence, typed read-only `payment_pending` counts/checksum, and old
  revision drain. Zero rows or point-in-time activity alone is insufficient.
- [ ] Start `approvedSubset` empty. The replay-capture cluster may become a
  target only if every deployed writer/cleanup dependency and repository caller
  is independently removed or redirected without changing replay behavior.
  Otherwise keep it deferred. Never select by prefix, row count, “legacy” label,
  or an arbitrary table count.

## Task 3: Conditional minimal implementation and manifest

**Files:**

- Modify only if Task 2 proves a safe caller change:
  `lib/services/analysis/replay/replay-supabase-repository.ts` and existing
  evidence/policy/verifier files
- Create only after provenance/closure approval: one exact migration and its
  checked-in verifier/restore artifact

- [ ] Map every application, recovery, admin, and deployed DB caller before
  editing. If the replay repository still needs the source, leave it unchanged
  and keep the family blocked.
- [ ] Preserve analysis execution, provider, payment, recovery, operator-audit,
  account-deletion, shared-hash, and `payment_pending` contracts/data. Do not
  create a replacement schema/table/sink or edit old migration history.
- [ ] Freeze a non-empty exact manifest/hash only after fresh evidence proves
  target object signatures, ACL/RLS, dependencies, source callers, retained
  objects, migration provenance, and an isolated restore/rollback operation.
  Empty/shape-only closure and table-count assertions never authorize DDL.
- [ ] If code/SQL changes, run only affected existing contract/PGlite tests and:

  ```sh
  npx tsc --noEmit --pretty false
  git diff --check
  ```

  No full suite or CI unless the future code change demonstrates a need.

## Task 4: Isolated coordinator migration gate

- [ ] Require resolved provenance, same-window fresh evidence, zero active
  callers, retained-contract parity, independent review, a clean fetched
  `origin/main`, and exactly one reviewed migration. Any unresolved row or
  mixed/dirty history stops before authoring/apply.
- [ ] In a bounded temporary Supabase workdir from fetched `origin/main`, copy
  only the reviewed migration and linked metadata. Verify no unrelated pending
  migration or protected-file change.
- [ ] Dry-run and inspect history:

  ```sh
  npx --yes supabase@2.102.0 db push --workdir "$ROLLOUT_CLI_WORKDIR" --linked --dry-run
  npx --yes supabase@2.102.0 migration list --workdir "$ROLLOUT_CLI_WORKDIR" --linked
  ```

  Expected: exactly the reviewed allowlist. Never use `--include-all`.
- [ ] After coordinator approval only, apply once:

  ```sh
  npx --yes supabase@2.102.0 db push --workdir "$ROLLOUT_CLI_WORKDIR" --linked
  ```

  If it appears hung, inspect remote history/catalog read-only before terminating
  or retrying; never repeat based only on a local timeout.
- [ ] Run the checked-in post-apply verifier and stop at
  `VERIFIED_PRODUCTION_EVIDENCE`. No activation, payment-state mutation,
  provider work, queue/gate change, or real `0_min._.00` canary.

## Stop, rollback, and acceptance

- [ ] Stop on migration-history mismatch, active caller, dependency/ACL/RLS drift,
  unexpected object/row/checksum change, extra dry-run file, or missing restore.
- [ ] Before apply, rollback is no-op. After a committed migration, use only the
  reviewed isolated restore/rollback operation; never invent a compensating
  migration or use `CASCADE`.
- [ ] Acceptance records the 152-table baseline and six-by-six provenance split
  as context, keeps two unresolved rows fail-closed, approves only a literal
  evidence-proven subset (possibly empty), preserves contracts/data, and emits
  only sanitized evidence.
- [ ] Git status contains only approved files; no `payment_pending`, schema,
  migration history, landing copy, or protected path is changed unexpectedly.

Self-review: report blockers, exact CLI/allowlist gates, no arbitrary 22 target,
retained-contract boundary, rollback, independent review, and the terminal
`VERIFIED_PRODUCTION_EVIDENCE` stop are all covered without restating the full
operational-simplification design.
