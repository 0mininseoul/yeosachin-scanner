# Supabase operational contraction next wave Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the six-version migration provenance split, then identify only an
independently proven minimal Supabase contraction subset while preserving service contracts,
data, and migration history.

**Architecture:** Provenance source-package recovery is a prerequisite and is separate from
any DDL. The first executable task obtains exact source for all six remote-only versions;
the next task proves the six local-only files are not pending desired behavior. Only after
independent review may the active directory be contracted locally, followed by exact parity
and zero-pending dry-run gates before any separately reviewed contraction DDL.

**Tech Stack:** Supabase CLI `2.102.0`, PostgreSQL catalog queries, existing TypeScript
evidence/verifier scripts, and focused contract/type checks only for a future code change.

---

## Boundary and baseline

The reports on `origin/main` are context only: 152 public base/partitioned tables after
W1A, six local-only versions, and six remote-only versions. The three-table
`analysis_v2_replay_capture` cluster remains blocked by deployed routine/FK dependencies;
no table count or empty result authorizes deletion.

This docs packet performs no Supabase read, migration repair, replay, non-dry
`db push`, DDL/DML, payment mutation, test, CI, or deployment. It must never mutate remote
migration history. If any source, equivalence, parity, or dependency proof fails, finish
`BLOCKED_NO_CHANGE`.

## Files and worker split

- Read: `docs/reports/2026-09-13-supabase-next-contraction-audit.md`
- Read: `docs/reports/2026-09-13-supabase-migration-provenance-reconciliation.md`
- Read: `docs/superpowers/specs/2026-09-13-supabase-operational-simplification-design.md`
- Read: existing evidence/verifier scripts and their focused tests.
- Future implementation may modify only reviewed migration source/evidence artifacts;
  never modify historical migration contents, retained/payment/operator contracts,
  `app/page.tsx`, `.playwright-mcp/`, `AGENTS.md`, or the protected migration.
- [ ] Use a fresh independent reviewer for source recovery, local-only disposition,
  active-directory changes, and any later DDL allowlist.

## Task 1: First executable task — recover all six remote-only source packages

**Files:** source-package recovery workspace only; no active migration or remote-history mutation.

The remote-only versions are exactly:

| Version/name | Required source recovery |
| --- | --- |
| `20260814110000_rearm_concierge_snapshot_conflict_execution` | Reconstruct exact SQL from authenticated remote statement array. |
| `20260814111000_reopen_concierge_snapshot_cleanup_intent` | Reconstruct exact SQL from authenticated remote statement array. |
| `20260823165841_add_incident_gender_review_correction` | Recover exact file from identified non-main commit `9fc65c76`. |
| `20260824151600_publish_incident_reviewed_result_copy` | Recover exact file from identified non-main commit `9042120d`. |
| `20260824152500_normalize_incident_reviewed_copy_subjects` | Recover exact file from identified non-main commit `6bdb5149`. |
| `20260824160500_publish_incident_media_reviewed_result_copy` | Recover exact file from identified non-main commit `0c52c100`. |

- [ ] Before any catalog or DDL task, an owner obtains the four non-main blobs and the
  two authenticated remote statement arrays in memory or an isolated temporary source
  workspace. Do not use an unauthenticated export, guessed placeholder, later routine
  body, or local-only file as source.
- [ ] For every version, reconstruct canonical SQL using the recorded Supabase
  statement-array separator and blank-separator-line rules, without any other whitespace
  normalization. Verify statement count, canonical character length, remote hash, local
  SHA-256, and canonical byte/text equivalence. A mismatch, malformed array, truncated
  statement, or unresolved source is `BLOCKED_NO_CHANGE`.
- [ ] Do not commit raw query output, statement-array JSON, provider response envelopes,
  credentials, project references, or protected resource values. Record only version,
  source disposition, statement count/length, and opaque hashes in the sanitized review
  record.
- [ ] Independent owner review approves all six exact source packages together. Four are
  `NON_MAIN_EXACT_SOURCE`; two are `REMOTE_STATEMENT_ARRAY_EXACT_SOURCE`. No file
  enters the active migration directory before that review.

## Task 2: Prove all six local-only files are not pending desired behavior

**Files:** read-only local files, current remote catalog/routine/constraint/ACL/schema evidence.

The local-only set is exactly:

- `20260805001619_remove_server_inventory_gate.sql`
- `20260805014000_skip_paid_relationship_precheck_for_selfhosted_auth.sql`
- `20260805023000_skip_paid_target_prechecks_for_selfhosted_auth.sql`
- `20260805025000_allow_selfhosted_auth_relationship_source_status.sql`
- `20260805050000_remove_paid_server_inventory_gate.sql`
- `20260813233000_allow_anonymous_preflight_slot_validator_exec.sql`

- [ ] For each file, map every object/behavior it would create or alter to the current
  authenticated remote state and repository/deployed callers. Prove current routine body,
  signature, `SECURITY DEFINER`, `search_path`, ACL/grants, constraints, schemas/tables,
  indexes/views, triggers/policies, publications, and `pg_depend` edges are already
  equivalent to the migration's desired behavior.
- [ ] Check application, recovery, admin, operator, scheduled, and deployed database
  callers independently. Do not classify a file redundant from row counts, a “legacy”
  label, a substring, or a static source scan alone.
- [ ] Record one disposition and opaque hash per local-only file:
  `LOCAL_ONLY_REDUNDANT_CURRENT_STATE` only when the full routine/constraint/ACL/schema/
  dependency equivalence is proven; otherwise `BLOCKED_NO_CHANGE`. Keep the original
  content available in Git history.

## Task 3: Reviewed local source-package contraction, still no remote mutation

- [ ] After Task 1 and Task 2 independent review, restore the six exact remote-only files
  into the active migration directory using their reviewed filenames/content.
- [ ] Only in the same reviewed local change, remove the six
  `LOCAL_ONLY_REDUNDANT_CURRENT_STATE` files from the active migration directory.
  Record each of the six remote and six local source hashes, source type, and disposition
  in a sanitized reconciliation manifest; the removed content remains recoverable in Git history.
- [ ] Do not run `migration repair`, replay SQL, non-dry `db push`, or any remote
  migration-history operation. If the reviewed source or local-only equivalence is not
  complete, leave the active directory unchanged and report `BLOCKED_NO_CHANGE`.

## Task 4: Correct linked CLI invocation and exact history parity

Use the canonical linked owner workdir for project selection. The Supabase CLI global
`--workdir` option precedes the subcommand; do not pass a protected project reference in
argv when the linked owner workdir is available.

- [ ] Resolve `OWNER_WORKDIR` to the canonical linked owner workdir and invoke the pinned
  CLI only in this form:

  ```sh
  npx --yes supabase@2.102.0 --workdir "$OWNER_WORKDIR" migration list --linked
  ```

  Require the returned remote/local version sets to be exactly equal, with 391 distinct
  versions expected only as a report-context cross-check, not as a guessed target.
- [ ] Any future inventory/verifier wrapper that currently accepts an explicit project
  selector must gain a workdir-only path that derives the linked ref from
  `$OWNER_WORKDIR/supabase/.temp/project-ref` and invokes the pinned CLI with
  `--workdir` before its subcommand. Do not expose the ref in argv, logs, reports, or
  ordinary files; never pass an explicit project selector when the canonical linked
  workdir can be used.
- [ ] In an isolated temporary rollout workdir containing only fetched
  `origin/main`, linked metadata, and the six reviewed remote source files (with the six
  local-only files removed), run the read-only dry-run with the same argument placement:

  ```sh
  npx --yes supabase@2.102.0 --workdir "$ROLLOUT_CLI_WORKDIR" db push --linked --dry-run
  npx --yes supabase@2.102.0 --workdir "$ROLLOUT_CLI_WORKDIR" migration list --linked
  ```

  Require zero pending migrations and exact version-set parity. Never use
  `--include-all`; never run the non-dry command in this plan.

## Task 5: Separate later contraction DDL gate

- [ ] Only after exact `migration list --linked` parity, zero-pending dry-run, fresh
  object/dependency evidence, retained-contract parity, independent review, and a literal
  no-CASCADE allowlist may a separately approved future task consider contraction DDL.
  The allowlist may be empty; no arbitrary 22-table target is valid.
- [ ] The later DDL task must use a bounded isolated workdir and the same linked CLI
  argument placement, then verify object/ACL/RLS/dependency/restore evidence. This plan
  does not execute DDL, replay SQL, repair history, or push.
- [ ] Any mismatch in source bytes, statement count/length/hash, canonical equivalence,
  routine/constraint/ACL/schema/dependency state, version set, dry-run, restore, or caller
  proof is `BLOCKED_NO_CHANGE`.

## Acceptance and self-review

- [ ] All six remote-only source packages have owner-reviewed exact provenance: four from
  the named non-main commits and two reconstructed from authenticated statement arrays.
- [ ] All six local-only files are independently proven redundant against current
  routine/constraint/ACL/schema/dependency behavior, with hashes/dispositions recorded and
  original content retained in Git history.
- [ ] The active directory changes happen only after review; remote migration history is
  untouched, and no repair, replay, non-dry push, payment-state mutation, or data change
  occurs.
- [ ] Linked CLI `--workdir` placement is correct; project-ref argv is avoided; isolated
  workdir and exact allowlist safety remain intact.
- [ ] Before any later contraction DDL, `migration list --linked` is exact and the
  isolated `db push --linked --dry-run` has zero pending migrations.
