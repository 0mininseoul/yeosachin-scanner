# Orca worktree cleanup Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove only Orca-managed worktrees proven clean, inactive, and fully merged into fetched `origin/main`, preserving all canonical, dirty, user-owned, active, report-source, and protected paths.

**Architecture:** Build a complete Git/Orca candidate matrix, apply clean+merged+not-preserved predicates, obtain independent review, then remove one candidate at a time with `orca worktree rm` without `--force`; re-audit after every removal.

**Tech Stack:** Git worktree metadata and Orca worktree/terminal/worker commands. No direct Git removal, shell deletion, reset, checkout, clean, terminal stop, or worker stop.

---

## Boundary and unconditional preservation

This planning task removes nothing. Always preserve:

- canonical main `.worktrees/final-main-20260725`;
- current `cormorant`, its coordinator/root resources, and this task worktree;
- Desktop/main and every path containing `.playwright-mcp/`;
- all dirty/untracked/user-owned or report-source worktrees;
- any path with a live terminal, active/reclaimable/retained worker, owner-retained
  resource, uncovered host, or ambiguous ownership;
- all non-ancestor/unmerged worktrees; and
- any path where the named protected migration is missing, changed, or cannot be
  compared without reading its contents.

`docs/investigations/worktree-cleanup-audit-20260906.md` is context only. It does
not authorize removal of registrations created or changed afterward.

## Files and worker split

- Read: `AGENTS.md`
- Read: `docs/investigations/worktree-cleanup-audit-20260906.md`
- Read: Git registrations and Orca-native worktree/terminal/worker state
- No source, migration, configuration, landing-copy, report, or manifest edit

- [ ] Dispatch a fresh visible Orca Codex `gpt-5.6-luna`, effort `max` audit
  worker to build the sanitized matrix and remove only approved candidates.
- [ ] Dispatch a different fresh visible Orca Codex `gpt-5.6-luna`, effort `max`
  reviewer to recompute every predicate and approve the exact candidate list.

## Task 1: Enumerate complete Git and Orca state

- [ ] Fetch ancestry without changing a worktree:

  ```sh
  git fetch origin main --prune
  git rev-parse origin/main
  git worktree list --porcelain
  ```

- [ ] Enumerate Orca-managed worktrees, coverage, terminals, and workers:

  ```sh
  orca worktree list --repo path:"$REPO_ROOT" --limit 1000 --json
  orca worktree ps --limit 1000 --json
  orca terminal list --limit 1000 --json
  orca orchestration worker-list --include-remote --limit 100 --json
  ```

  If any response reports a `not covered` host, stop; an empty partial page is
  not evidence that that host has no worktrees. Record only safe state/counts,
  not raw process arguments, credentials, cookies, IDs, or resource payloads.

## Task 2: Prove the three predicates for every registration

- [ ] Clean predicate, including untracked files:

  ```sh
  git -C "$WORKTREE_PATH" status --porcelain=v1 --untracked-files=all
  git -C "$WORKTREE_PATH" diff --quiet
  git -C "$WORKTREE_PATH" diff --cached --quiet
  ```

  Any output/failure/unreadable path/submodule difference means `PRESERVE`; do
  not run `git clean`.
- [ ] Merged predicate:

  ```sh
  git -C "$WORKTREE_PATH" rev-parse HEAD
  git -C "$WORKTREE_PATH" merge-base --is-ancestor HEAD origin/main
  ```

  Missing ancestry, detached/unclear provenance, or non-zero result means
  `PRESERVE`.
- [ ] Inactivity predicate: correlate each path against complete Orca terminal,
  worker, process-CWD, and owner/resource state. Any live or retained association
  means `PRESERVE`; do not close a terminal/worker to qualify it.
- [ ] Protected predicate: preserve every `.playwright-mcp/` path. Compare only
  opaque hashes of the named protected migration against canonical main:

  ```sh
  git -C "$CANONICAL_MAIN" show HEAD:supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql | shasum -a 256
  git -C "$WORKTREE_PATH" show HEAD:supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql | shasum -a 256
  ```

  Missing/read/hash mismatch means `PRESERVE`; never print, overwrite, or repair
  the file.

## Task 3: Classify and independently review

- [ ] Mark canonical main, cormorant, current task, Desktop/main,
  `.playwright-mcp/`, dirty/user-owned, active/resource-attached, report-source,
  uncovered, non-ancestor, and protected-uncertain paths as `PRESERVE`.
- [ ] Candidate allowlist is the intersection of: Orca-managed, complete host
  coverage, clean including untracked files, `HEAD` ancestor of fresh
  `origin/main`, inactive, non-anchor, non-user-owned, no report-source role,
  and protected-file hash match. It may be empty; age/branch absence alone is
  never enough.
- [ ] Independent reviewer reruns the registration, host-coverage, status,
  ancestry, protected-hash, terminal, worker, and resource checks. Any
  disagreement removes a candidate from the allowlist and preserves it.

## Task 4: Orca-native removal and post-check

- [ ] Immediately before each removal, rerun all predicates for that one path.
  If any state changed, stop all removals and obtain a new review.
- [ ] Remove only with:

  ```sh
  orca worktree rm --worktree path:"$CANDIDATE_PATH"
  ```

  Never pass `--force`; do not use `git worktree remove`, `git branch -D`,
  `rm`/`rm -rf`, `git clean`, `git reset`, or `git checkout`. Do not pass
  `--run-hooks` unless a separately reviewed repository hook is in scope.
- [ ] On any Orca error, selector mismatch, branch surprise, live-resource
  warning, or partial result, stop and preserve all remaining paths. If a
  removed worktree is later needed, re-create it only through a fresh Orca
  review from its retained branch/commit.
- [ ] After each successful removal, rerun:

  ```sh
  git worktree list --porcelain
  orca worktree list --repo path:"$REPO_ROOT" --limit 1000 --json
  orca worktree ps --limit 1000 --json
  ```

  Confirm canonical main, cormorant, current task, Desktop/main, protected
  paths, dirty/user-owned paths, and report sources remain present/unchanged.

## Stop conditions and acceptance

- [ ] Any unknown host/owner/resource state, dirty/untracked file, live/retained
  resource, report-source marker, protected mismatch, or non-ancestor HEAD is a
  preserve decision, not a cleanup error.
- [ ] Every removed path was independently proven clean, inactive, fully merged,
  non-anchor, and safe in the same audit window, and was removed only by Orca
  without `--force`.
- [ ] No terminal/worker is stopped, no user-owned file is deleted, no branch is
  force-deleted, and no protected file changes.
- [ ] Final handoff contains only sanitized preserved/candidate/removed counts,
  reason codes, removed HEAD hashes, and fetched `origin/main`; no raw contents,
  manifests, credentials, cookies, IDs, or process arguments.

Self-review: complete host coverage, canonical/cormorant/user/protected
preservation, three predicates, independent review, Orca-only removal, and
post-removal verification are explicit; no direct destructive Git/shell path is
available.
