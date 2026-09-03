# Apify Ten-Account Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manage all ten configured Apify accounts while hard-fencing the paid `secondary` account to paid analysis and allocating free work across the other nine accounts from current credit, health, and manual-exclusion state.

**Architecture:** Promote the provider slot catalog to one canonical ten-slot type, derive the free-pool set by excluding `secondary`, and let a transactionally checked best-fit allocator choose among the nine free accounts. Persist credit-cycle snapshots, health, reservations, settlement, and append-only operator exclusions; workers receive only the selected alias and never expose credentials. Keep the existing operation budgets and reservation semantics, widening cardinality without weakening fail-closed admission.

**Tech Stack:** TypeScript, Zod, Vitest, PGlite/PostgreSQL migration tests, Supabase RPCs, Cloud Run/Tasks deployment shell contracts.

---

## 1. Lock the ten-slot boundary and paid-account fence (RED)

- [ ] Extend `lib/services/instagram/providers/apify.test.ts`, `lib/services/instagram/providers/apify-relationship.test.ts`, and `lib/services/analysis/preflight-provider-run.test.ts` with the exact catalog `primary, secondary, tertiary, quaternary, quinary, senary, septenary, octonary, nonary, tenth`.
- [ ] Add failing assertions that the free-pool set is exactly the same catalog minus `secondary`, that no preflight/B-lite/betatest-free path can select `secondary`, and that paid production relationship collection selects only `secondary`.
- [ ] Add failing deploy-contract assertions in `scripts/automatic-analysis-capacity-infra.test.ts` for all ten aliases and for rejection of a paid worker whose selected slot is not `secondary`.
- [ ] Run the focused tests and record the missing-slot/fence failures before implementation.

## 2. Establish one canonical provider-slot catalog (GREEN)

- [ ] Update `lib/services/instagram/providers/types.ts` so `ApifyCredentialSlot`, runtime validation, and environment-key mapping cover all ten aliases; remove concierge-only type exceptions for `octonary` and `nonary` without changing secret names or printing values.
- [ ] Refactor `lib/services/instagram/providers/apify.ts`, `lib/services/instagram/providers/apify-relationship.ts`, and `lib/services/analysis/preflight-provider-run.ts` to consume the canonical catalog and explicit workload eligibility helpers.
- [ ] Encode workload policy as data: `secondary` is paid-analysis-only; the other nine aliases are free-work eligible when healthy, sufficiently funded, and not manually excluded.
- [ ] Preserve historical receipts that already name any alias and keep replay from silently remapping a persisted alias.
- [ ] Run the provider/preflight tests and `npx tsc --noEmit --pretty false`.

## 3. Widen the credit pool from six to nine free accounts (RED/GREEN)

- [ ] Update `lib/services/analysis/beta-apify-credit-pool.test.ts` and `lib/services/analysis/beta-apify-credit-runtime.test.ts` so snapshots require the exact nine-free-slot set, including `octonary`, `nonary`, and `tenth`, and reject missing, duplicate, stale, unhealthy, or `secondary` rows.
- [ ] Rename six-specific internals in `lib/services/analysis/beta-apify-credit-runtime.ts` to cardinality-neutral names and derive array length from `BETA_APIFY_FREE_CREDENTIAL_SLOTS.length`.
- [ ] Update `lib/services/analysis/beta-apify-credit-pool.ts` and `lib/services/analysis/beta-apify-pool-observability.ts` so credit, effective headroom, active reservations, local post-snapshot debit, billing-cycle end/reset date, and health are computed for all nine free accounts.
- [ ] Keep allocation deterministic: first reject ineligible accounts, then choose the account that can cover the operation with the least remaining positive headroom; use the canonical alias as the stable tie-breaker.
- [ ] Update telemetry tests to prove metrics remain bounded, labels contain aliases only, and tokens/account identifiers never appear.

## 4. Add durable manual exclusion and transactional eligibility

- [ ] Add `supabase/migrations/20260904120000_expand_apify_free_pool_to_nine.sql` with append-only `analysis_apify_account_control_events`, a current-state projection/RPC, and widened constraints/RPCs for the exact nine free aliases.
- [ ] Require operator UUID, action (`exclude` or `restore`), non-empty reason, and event time; deny UPDATE/DELETE, enable and force RLS, revoke public/authenticated access, and grant only service-role RPC execution.
- [ ] Amend the existing allocation RPC forward-only so credit snapshot freshness, health, manual exclusion, reservations, and headroom are checked under the same transaction/advisory lock before assigning an alias.
- [ ] Add `lib/services/analysis/beta-apify-credit-pool-pglite.test.ts` coverage for nine rows, concurrent claims, an exclusion racing allocation, restoration, rollover boundaries, and `secondary` rejection.
- [ ] Add static contract tests for ACL, RLS, search path, exact allowlists, append-only behavior, and absence of destructive DDL.

## 5. Wire all ten credentials through deployment without exposing secrets

- [ ] Update `scripts/configure-analysis-v2-secrets.sh`, `scripts/generate-analysis-v2-env-files.sh`, `scripts/deploy-analysis-v2-worker.sh`, and `scripts/deploy-analysis-capacity-workers.sh` to validate and pin all ten aliases.
- [ ] Ensure dry-run/check output reports only alias, resource name, numeric version, and binding status; never print secret values.
- [ ] Update `scripts/run-concierge-batch.ts` so free-path defaults exclude `secondary`; require the existing explicit paid capability/confirmation for any paid relationship collection and prevent fallback from crossing the workload boundary.
- [ ] Add shell/TypeScript contract tests proving ordinary fallback cannot reach `secondary`, all nine free aliases are deployable, and historical explicit paid concierge flows remain opt-in.

## 6. Verification and coordinator handoff

- [ ] Run all beta credit-pool/reservation/settlement/provider/observability suites, provider tests, deployment-contract tests, `npx tsc --noEmit --pretty false`, `npm run lint`, and `npm run build`.
- [ ] Run `git diff --check`; confirm no landing marketing copy, dashboard UI, protected migration, or unrelated worktree files changed.
- [ ] Commit in small reviewed units: catalog/fences, nine-account runtime, migration/store, deployment wiring.
- [ ] Report commit SHA, changed files, RED/GREEN commands, migration filename, production env/secret prerequisites, and risks. Do not apply remote migrations, deploy, or call Apify in this implementation task.

