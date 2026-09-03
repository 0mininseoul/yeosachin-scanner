# Supabase Staged Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce redundant Supabase analysis tables only after the permanent order-audit bundle proves complete parity and retention safety.

**Architecture:** Use expand/verify/contract. First dual-read the new bundle against existing score-audit and cost-derived stores, then switch operator reads to the bundle behind a reversible flag, archive immutable evidence with checksums, and finally remove only dependencies proven unused. Payment, retry, provider receipt, media, and active runtime tables stay out of scope.

**Tech Stack:** PostgreSQL/Supabase, TypeScript, Vitest/PGlite, production aggregate verification scripts.

---

## 1. Enforce prerequisites

- [ ] Do not begin until `20260904130000_add_permanent_order_audit_bundle.sql` is deployed and at least one real completed production order has a complete bundle or explicit, correct gap state.
- [ ] Reconcile local/remote migration history and create an exact allowlist; never run `supabase db push --include-all` from a mixed worktree.
- [ ] Freeze the candidate set to the six `analysis_v2_score_audit_*` tables plus `analysis_v2_cost_attributions` and `analysis_v2_cost_rollup_snapshots`. Any additional table requires a new audited plan.

## 2. Build parity evidence before routing changes

- [ ] Add a bounded service-role parity RPC/script comparing request coverage, row counts, hashes, score components, cost totals, unknown-usage status, and late-version lineage between old stores and audit bundles.
- [ ] Add tests for complete, intentionally incomplete, late-cost, retry, and zero-candidate orders; distinguish mismatch from expected source gaps.
- [ ] Require zero unexplained mismatches across the agreed production sample/window and persist only aggregate results plus checksums.

## 3. Switch reads reversibly

- [ ] Add a server-only read flag so score/cost operator APIs can read the bundle while legacy reads remain available for rollback.
- [ ] Run shadow comparison on every operator read during the validation window; emit bounded aggregate mismatch metrics without PII.
- [ ] Promote bundle reads only after parity gates pass; retain old writes until the contract phase completes.

## 4. Archive and contract

- [ ] Create an immutable archive manifest with table name, cutoff, row count, checksum, object location, and verification time; test restore/read before any destructive DDL.
- [ ] Remove writers, functions, cron jobs, and views for one candidate group at a time; deploy and observe before dropping its tables in a later migration.
- [ ] Drop only candidates with verified archive, zero runtime references, no pending/active work, and passed rollback drill. Do not touch payment, entitlement, provider receipts/reservations, retries, media, user/result, or active pipeline tables.

## 5. Verification and handoff

- [ ] Run schema-reference search, migration/PGlite tests, full typecheck/lint/build, production aggregate parity, and post-contract readiness/error checks.
- [ ] Report exact tables retained/dropped, archive checksums, row counts, rollback path, and before/after table count. Any unresolved mismatch blocks contraction rather than being coerced.

