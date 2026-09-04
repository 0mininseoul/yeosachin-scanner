# Permanent Per-Order Audit Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently preserve a complete, operator-readable, order-keyed record of each analysis pipeline and its measured operating cost without treating unknown usage as zero.

**Architecture:** Add an immutable, versioned audit-bundle aggregate assembled from authoritative V2 relationship, AI checkpoint, interaction, feature, score, and cost sources. A small parent table owns version/hash/completeness; normalized child rows hold candidate and interaction detail so large orders remain queryable. Initial publication and late cost reconciliation append new versions, never overwrite prior evidence. Existing pipeline tables continue as execution stores until parity is proven.

**Tech Stack:** PostgreSQL/Supabase RPCs and RLS, TypeScript/Zod, Next.js operator API, Vitest, PGlite/PostgreSQL concurrency tests.

---

## 1. Define the immutable bundle contract with failing tests (RED)

- [ ] Add `lib/services/analysis/order-audit-bundle.test.ts` for parent metadata, source hashes, declared/collected counts, completeness/gap codes, cost status, and append-only version rules.
- [ ] Add `lib/services/analysis/order-audit-bundle-migration-contract.test.ts` and `order-audit-bundle-pglite.test.ts` covering the new tables/RPCs, operator-only reads, immutable writes, idempotent assembly, late reconciliation, and concurrent assemblers.
- [ ] Add route tests for `app/api/admin/order-audit/[requestId]/route.ts`: cookie authentication, operator allowlist, pagination/filter parsing, private no-store headers, 401/403/404 behavior, and redaction.
- [ ] Use fixtures with accounts that have no posts/profile image and with missing provider usage; assert these become explicit gaps/unknown cost, not absent orders or zero cost.
- [ ] Run the new focused tests and capture the contract failures before implementation.

## 2. Add the append-only schema and assembler RPC

- [ ] Add `supabase/migrations/20260904130000_add_permanent_order_audit_bundle.sql` defining `analysis_order_audit_bundles`, `analysis_order_audit_candidates`, and `analysis_order_audit_interactions`.
- [ ] Parent identity must include `request_id`, immutable `version`, previous-version hash, source-set hash, pipeline/risk/AI/scheduler policies, plan/access mode, assembled time, completeness status, gap codes, and copied per-order cost totals/status.
- [ ] Candidate rows must preserve mutual membership/ordinal, privacy/profile availability, initial gender output/model/confidence/reason, final gender output/model/confidence/reason, evidence/checkpoint identities, final inclusion state, and all risk components/formula/version/final score/rank.
- [ ] Interaction rows must distinguish target-post likes, target-post comments with the retained comment text/details, candidate-post likes, tags, and mentions; include candidate key, source post/evidence identity, ordinal/time when known, and completeness/gap state.
- [ ] Persist followers/following declared and collected counts, mutual total/list hash, public/private/screened totals, target post/profile-media availability, and provider run/alias identities on the parent; never persist provider tokens.
- [ ] Enable and force RLS, deny direct client reads/writes, grant service-role assembly and operator loader RPC only, fix `search_path`, and prohibit UPDATE/DELETE with triggers or privileges.

## 3. Assemble only from authoritative persisted sources

- [ ] Add `lib/services/analysis/order-audit-bundle.ts` with strict Zod parsing and service-role methods for enqueue/assemble/load; do not reconstruct evidence from user-facing result JSON when authoritative V2 rows exist.
- [ ] In the SQL assembler, source relationship counts/rows from `analysis_v2_relationship_sides` and its manifests/mutual rows, gender evidence from `analysis_v2_ai_result_checkpoints` plus candidate feature rows, interaction evidence from `analysis_target_interactors` and retained comment/evidence rows, and risk detail from candidate feature/score/final-score checkpoints.
- [ ] Copy the latest `analysis_v2_cost_attributions` snapshot, including provider/model/stage components, currency, observed versus estimated amounts, `usage_unknown`, and explicit missing-source codes. Never coalesce unknown cost to zero.
- [ ] Make `(request_id, source_set_hash)` idempotent. If any authoritative source changes or late cost usage arrives, append `version + 1` linked to the prior hash.
- [ ] Bound each RPC page and payload; use indexed child-table queries rather than one unbounded JSON aggregate.

## 4. Trigger assembly at durable lifecycle boundaries

- [ ] Add an idempotent assembly enqueue/call after successful V2 result finalization in `lib/services/analysis/v2-worker.ts`; audit failure must be observable/retriable but must not roll back an already committed customer result.
- [ ] Add a second enqueue/call from the cost-attribution refresh/reconciliation path introduced by `supabase/migrations/20260904110000_add_analysis_v2_cost_attribution.sql` so late usage appends a corrected bundle version.
- [ ] Add recovery listing/claim/release RPCs and worker-side retry handling with leases and terminal error codes; do not add an unbounded hot-loop or synchronous full-table scan.
- [ ] Add lifecycle tests for finalization, duplicate task delivery, crash after bundle commit, late cost settlement, permanent missing-source gap, and operator reload.

## 5. Expose a stable operator API independent of dashboard design

- [ ] Add `app/api/admin/order-audit/[requestId]/route.ts` and `lib/services/analysis/order-audit-query.ts` with summary plus paginated `mutuals`, `gender`, `interactions`, and `risk` sections.
- [ ] Reuse `isAnalysisAuditOperator` from `lib/services/analysis/score-audit.ts`; preserve cookie auth and `Cache-Control: private, no-store`.
- [ ] Return usernames/comment evidence only to authorized operators, omit user UUIDs and secret/provider identifiers, and expose alias names plus run IDs/hashes only.
- [ ] Keep this task UI-free. The paused dashboard implementation will consume this API after the revised design is approved.

## 6. Verification and coordinator handoff

- [ ] Run all new bundle tests plus `per-order-cost-attribution-*`, score-audit, V2 result/finalizer/worker, and admin route suites.
- [ ] Run `npx tsc --noEmit --pretty false`, `npm run lint`, `npm run build`, and `git diff --check`.
- [ ] Verify representative Basic/Standard/Plus fixtures include every requested process stage and preserve unknowns; compare source counts/hashes to bundle counts/hashes.
- [ ] Commit schema, service/lifecycle, and operator API as separate commits. Report SHA/files/tests, migration prerequisites, parity metrics, and known gaps. Do not apply the remote migration or deploy in this implementation task.

