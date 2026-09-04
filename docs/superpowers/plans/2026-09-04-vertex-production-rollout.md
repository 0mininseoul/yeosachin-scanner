# Vertex Cost-Optimized Production Rollout Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move eligible production automatic analyses onto the guarded `ai-stage-policy-v2.12` path while preserving a rollback switch, shared budget enforcement, and the user-owned final target test.

**Architecture:** Treat the existing v2.12 implementation as immutable release input. First audit actual database migration, Vercel, Cloud Run, Cloud Tasks, and environment state; then produce real non-paid gate evidence from retained/replay fixtures where possible. Only promote the rollout control after all fail-closed budget and readiness checks pass. Do not execute a provider collection or paid canary for `0_min._.00`; leave that final validation to the user.

**Tech Stack:** Supabase CLI, Vercel CLI, Google Cloud CLI, existing Vertex deterministic gate and production-readiness scripts.

---

## 1. Reconcile exact release state read-only

- [ ] In a clean worktree based on current `origin/main`, verify commits for PRs #529, #537, #538, and #539 are ancestors and capture the exact SHA.
- [ ] Read linked-project migration history without printing credentials. Confirm `20260902090000`, `20260902091000`, `20260904090000`, and `20260904110000` status; stop if local/remote divergence makes the allowlist ambiguous.
- [ ] Inspect Vercel production deployment SHA/environment names, Cloud Run revisions/traffic, Cloud Tasks queue state/rates, and readiness endpoint. Redact project IDs, tokens, URLs carrying secrets, user IDs, and raw payloads.
- [ ] Verify production values semantically: budget guard enabled, store `supabase`, per-run `$2`, per-order `$5`, daily `$100`, and rollout currently `test_entitlement` or `off`.

## 2. Close the quality gate without a paid target run

- [ ] Run `npm run cost:vertex-ai:gate` and preserve the expected fixture blocker separately from infrastructure failures.
- [ ] Search retained authorized replay/production audit material for labeled high-risk outcomes that can satisfy the gate without issuing a new provider request. Build only aggregate, de-identified evidence; do not export raw account/user payloads.
- [ ] If real retained evidence meets recall/route/unknown-usage thresholds, update the gate evidence fixture/report through a small code PR with tests. If no valid evidence exists, do not fabricate it and keep the rollout at `test_entitlement`; report production promotion as blocked pending the user’s canary.
- [ ] Confirm modeled gross savings remains at least 50% and every 3.7 attempt has typed `high_value` or `ambiguous` justification.

## 3. Apply only reviewed migrations and deploy exact SHA

- [ ] If any required reviewed migration is missing, create an isolated temporary Supabase workdir containing only the exact allowlist, run dry-run, inspect SQL/history, apply once, and verify remote history before terminating a stuck CLI. Never use `--include-all`.
- [ ] Deploy the reviewed web/worker SHA with exact pinned secrets and budget settings. Keep Vertex Batch disabled for interactive traffic.
- [ ] Deploy/check the canonical preflight and paid workers, verify 100% intended revision traffic, and confirm no secret value appears in command output or logs.
- [ ] Resume/verify the intended active queues only: preflight concurrency 32 and V2 paid pipeline concurrency 8; keep legacy queues paused.

## 4. Promote or safely hold the rollout

- [ ] When and only when real gate evidence passes, change `ANALYSIS_V2_VERTEX_AI_COST_OPTIMIZATION_V212_ROLLOUT` from `test_entitlement` to `production`, redeploy exact SHA, and verify newly created production preflights snapshot `ai-stage-policy-v2.12` without dispatching provider work.
- [ ] If the real quality gate remains unavailable, keep `test_entitlement` and verify the user’s authorized test path is immediately runnable with INITIAL activation and queues resumed. Clearly report that general production orders still use the prior policy.
- [ ] Validate rollback by dry-running/recording the single env change back to `off` or `test_entitlement`; do not execute rollback unless a health check fails.

## 5. Post-deploy verification and handoff

- [ ] Run readiness twice, queue describe twice, Cloud Run revision/traffic checks, Vercel deployment check, migration-history verification, and aggregate error/denial/unknown-usage queries.
- [ ] Confirm no Apify collection, paid Vertex request, analysis order, or `0_min._.00` test was initiated by this task.
- [ ] Produce `docs/operations/2026-09-04-vertex-cost-production-rollout.md` containing exact deployed SHA, sanitized configuration, gate outcome, migration allowlist, queue/worker state, rollback command, and the single user action remaining.
- [ ] If a code/evidence change was necessary, commit it and report SHA/tests for coordinator review. Otherwise report the read-only/deployment evidence and exact production state without creating a cosmetic commit.

