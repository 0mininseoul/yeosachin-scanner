# Supabase 22 Final Convergence Implementation Plan

> Historical plan disposition (2026-09-13): exact-22 backfill entry points referenced by this plan are retired and non-runnable. Current implementation evidence is governed by `supabase-operational-policy-v1`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every defensible legacy public table toward the approved exact 22-table Supabase catalog while preserving required data, and retire a source only after an explicit, reversible evidence gate proves that it is safe.

**Architecture:** Keep the 22 approved canonical tables as the only target families. Additive canonical adapters and bounded backfills run while each legacy source remains authoritative; normalized parity and shadow reads decide family-by-family cutover. Destructive retirement is a separate, literal migration allowlist with archive/restore proof, not a side effect of canonicalization.

**Tech Stack:** PostgreSQL/Supabase, Next.js/TypeScript, PGlite or disposable PostgreSQL, the existing operations/evidence verifiers, and the pinned `npx --yes supabase@2.102.0` CLI.

---

## Scope and current evidence

Worker-owned artifacts for this plan are exactly:

- `docs/superpowers/plans/2026-09-11-supabase-22-final-convergence.md`
- `docs/reports/2026-09-11-supabase-22-final-convergence-inventory.json`
- `docs/reports/2026-09-11-supabase-22-final-convergence-evidence.md`

The inventory is the source of truth for all 177 table rows, including the
classification, destination, dependency evidence, runtime evidence, and
preservation requirement of every relation. Do not broaden this task into
application copy, `.playwright-mcp`, the protected migration
`supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql`,
or a new abstraction layer.

The captured live state is 177 public base/partitioned tables, 22 canonical,
155 noncanonical, and 0 partitioned. The canonical set matches exactly. All
177 have RLS enabled, but 38 are not force-RLS. The captured write-lock count
is 0, while `pg_stat_database.stats_reset` is NULL; neither observation is a
closed quiescence proof. Current classification is 22 `retain`, 138
`consolidate`, 0 `retire`, and 17 `blocked`. The two additional blocked rows
are `private_accounts` and `earlybird_concierge_batch_cohort_members`; their
prior family destinations are proposals only, not executable mappings.

## Review finding closure map

The review at `d8cd4525` is closed by the following document-level corrections;
no application, migration, or test code is changed by this handoff.

| Finding | Explicit correction |
|---|---|
| P1-1 source coverage | Wave 1 contains only the 21 request-safe executable legacy names from `scripts/backfill-analysis-canonical.ts`; its two cache specs, `ai_analysis_cache` and `analysis_v2_ai_global_result_cache`, declare `requestIdColumn: null` and are rejected by the existing reader, so they are deferred. Wave 2 has an empty executable allowlist because `scripts/backfill-commerce-operations-canonical.ts` has no wired `readBatch`/`readCanonicalBatch`. The remaining 80 analysis and 37 commerce consolidate rows are named as deferred, and the two cross-wave declarations are called out separately. |
| P1-2 retry destination | Analysis retry markers use `enqueue_analysis_canonical_retry` and the existing `analysis_events` operational `canonical_retry` contract; `maintenance_jobs` is explicitly excluded from the analysis retry path. |
| P1-3 private accounts | `private_accounts` is blocked, outside Wave 1, with no canonical destination or destructive proposal until a lossless profile/result-artifact contract covers fields, identity, ownership, publication, readers, dual-write, and rollback. |
| P1-4 cohort cardinality/callers | `earlybird_concierge_batch_cohort_members` is blocked until order-wide uniqueness or a deterministic cohort/member identity and lossless frozen-manifest projection are proven. The inventory counts `scripts/warm-reimage-g1.ts` and `scripts/warm-reimage-g2.ts` as operational callers. |
| P1-5 audit boundary | The four `analysis_order_audit_*` sources are removed from Wave 1 and assigned to a separate blocked audit-evidence wave with independent production-bundle parity, archive, restore, and owner gates. |
| P2-1 CLI pin | Every future CLI inspection/dry-run starts with `npx --yes supabase@2.102.0 --version` and an exact `2.102.0` assertion; unversioned CLI resolution is forbidden. |

The deferred lists preserve the exact 177/22/155 catalog accounting. They are
not permission to invent adapters during implementation; a deferred source
must first acquire a concrete reader, projection, identity/cursor rule, and
parity evidence before entering an executable allowlist.

The canonical set, in the approved order, is:

`account_lifecycle`, `analysis_artifacts`, `analysis_audit_bundles`,
`analysis_cache`, `analysis_costs`, `analysis_events`, `analysis_jobs`,
`analysis_preflights`, `analysis_provider_runs`, `analysis_requests`,
`analysis_results`, `earlybird_orders`, `earlybird_waitlist`,
`fulfillment_jobs`, `landing_leads`, `maintenance_jobs`,
`notification_outbox`, `payment_events`, `result_feedback`,
`system_configuration`, `system_leases`, `users`.

## Non-negotiable safety rules

- Inspect production read-only. Do not run `db push`, `db reset`, `DROP`,
  `TRUNCATE`, `DELETE`, activation, a real canary, or any payment-state
  mutation while gathering evidence.
- Use only `npx --yes supabase@2.102.0`; first run
  `npx --yes supabase@2.102.0 --version` and assert the output is exactly
  `2.102.0`. Use the linked authenticated project and an isolated temporary
  CLI work directory when the canonical worktree has application
  environment-file parsing issues. Never print or persist tokens,
  database passwords, cookies, UUIDs, raw provider payloads, or user/device
  identifiers.
- Do not run `npx --yes supabase@2.102.0 db push --include-all` in a dirty or
  mixed worktree. A future apply must use a clean isolated worktree and a
  literal migration allowlist after a dry run.
- Do not change `payment_pending` or any other external order state without
  independent provider evidence and its existing owner-approved path.
- Do not treat a zero current row count, a zero lock count, a zero source
  reference count, or a zero stats counter as retirement proof.
- Keep source tables authoritative until parity, shadow-read, rollback, and
  archive/restore gates are all closed. Feature flags default off.

## Exact allowlists and classification contract

The inventory contains exact machine-readable arrays:

- `waves.wave1AnalysisCanonicalization.sourceAllowlist`: exactly 21
  request-safe executable analysis source tables from the current specs in
  `scripts/backfill-analysis-canonical.ts`. The file still declares 23
  non-audit specs, but `ai_analysis_cache` and
  `analysis_v2_ai_global_result_cache` have `requestIdColumn: null` and the
  existing reader rejects them, so both remain deferred. The five defined
  source families are jobs, events, artifacts, costs, and cache.
- `waves.wave1AnalysisCanonicalization.deferredSourceAllowlist`: exactly 80
  analysis consolidate rows. This includes the two rejected cache specs and
  the two commerce-file declarations `analysis_v2_recovery_provider_run_adoptions`
  and `analysis_v2_gemini_leases` as named cross-wave deferred sources, not as
  Wave 1 sources.
- `waves.wave2CommerceOperationsCanonicalization.sourceAllowlist`: `[]`.
  The current commerce function declares 12 names but has no wired
  `readBatch` or `readCanonicalBatch`, so none is executable. Its 37
  non-blocked consolidate rows are listed in
  `deferredSourceAllowlist`; the cohort member source is separately blocked.
- `waves.auditEvidenceWave.sourceAllowlist`: exactly the four
  `analysis_order_audit_*` sources. This wave is blocked evidence-only and is
  excluded from Wave 1 completion and retry-drain accounting.
- `waves.wave1AnalysisCanonicalization.destructiveAllowlist`: `[]`.
- `waves.wave2CommerceOperationsCanonicalization.destructiveAllowlist`: `[]`.
- `waves.wave3RetirementCandidates.approvedDestructiveAllowlist`: `[]`.
- `waves.terminalConvergence.destructiveAllowlist`: `[]`.

The 17 blocked names requiring new evidence are:

`analysis_order_audit_assembly_queue`, `analysis_order_audit_bundles`,
`analysis_order_audit_candidates`, `analysis_order_audit_interactions`,
`analysis_v2_apify_secret_ref_prune_guard`,
`analysis_v2_profile_provider_canary_experiments`,
`analysis_v2_profile_provider_canary_runs`,
`analysis_v2_profile_repair_canary_runs`, `demo_analysis_fixtures`,
`demo_analysis_runs`, `earlybird_first15_canary_provider_rearms`,
`earlybird_v211_concierge_publications`, `payment_orders`, `payments`,
`pending_analysis`, `private_accounts`,
`earlybird_concierge_batch_cohort_members`.

`payment_orders`, `payments`, and `pending_analysis` remain blocked until an
owner catalog and preservation contract exist. `private_accounts` remains
blocked until its profile/result-artifact contract is lossless. The cohort
member source remains blocked until cardinality, frozen-manifest mapping, and
operational caller migration are proven. The order-audit family remains
blocked until genuine production bundles, parity, archive, restore, and owner
approval exist. Canaries, secret-reference pruning, demo fixtures, and
concierge publications remain blocked until their own scoped contracts close.

## Wave 0: freeze, inventory, and approval boundary

**Purpose:** Reproduce the evidence without changing production and establish
the exact input for every later wave.

- [ ] Work from a clean temporary checkout of `origin/main` at the captured
  repository commit; assert the protected paths are unchanged.
- [ ] Create an isolated temporary directory containing only the linked
  Supabase CLI metadata needed by `npx --yes supabase@2.102.0`. Assert
  `npx --yes supabase@2.102.0 --version` is exactly `2.102.0` before any query,
  then run only read-only `npx --yes supabase@2.102.0 db query --linked
  --output json` catalog queries and `npx --yes supabase@2.102.0 migration list
  --linked`.
  Capture table class/count, canonical set, RLS/force-RLS, ACLs, FKs, views,
  routines, triggers, policies, publications, partitions, stats, active write
  locks, and sanitized static caller counts from application roots plus
  operational `scripts/**` and `supabase/operations/**` roots.
- [ ] Regenerate the inventory and assert `177`, `22`, `155`, `0`, the exact
  canonical-set SHA, one row per relation, and the four classification counts
  `22/138/0/17`. Reject duplicate or missing names and reject any sensitive
  value before writing the report.
- [ ] Reconcile the prior 187 -> 185 -> 177 baseline, the three selected
  migration-history occurrences, the 11 canonical maintenance rows, 12
  account-deletion source rows, 89 webhook source rows, and absence of the
  already-retired tables.
- [ ] Run static checks (`npx tsc --noEmit --pretty false` and
  `git diff --check`) plus the exact-count JSON assertion before any future
  implementation wave. Do not add or run broad tests/CI for this report-only
  plan. This wave is complete only when the sanitized report is committed and
  the coordinator records the exact commit SHA.

**Wave 0 gate:** all 177 rows accounted for; canonical set exact; no raw rows,
secrets, UUIDs, or payloads; no production mutation; `destructiveAllowlist` is
`[]`. A missing catalog field or unavailable stats boundary is `blocked`, not
an inferred pass.

## Wave 1: mapped analysis canonicalization, additive only

**Purpose:** Converge only the 21 request-safe executable analysis source
tables from the current specs in `scripts/backfill-analysis-canonical.ts`
across five defined source families (jobs, events, artifacts, costs, and
cache), without deleting source data. The two cache specs with
`requestIdColumn: null` are rejected by the existing reader and, together with
the other 78 analysis consolidate rows, make 80 deferred analysis rows outside
this wave.

- [ ] Use the existing analysis canonicalization plan and its named files for
  the five defined families: jobs, events, artifacts, costs, and cache.
  Reuse existing aggregate names and keep the 21 allowlisted sources
  authoritative during rollback. The two cache specs with
  `requestIdColumn: null` remain deferred because the existing reader rejects
  them. `analysis_order_audit_*` is excluded and is handled only by the blocked
  audit-evidence wave below.
- [ ] Add server-only, typed dual-write adapters behind family flags, all
  defaulting to `false`. If a transaction cannot dual-write, append a bounded
  operational retry marker through the existing
  `enqueue_analysis_canonical_retry` RPC into `analysis_events` with
  `kind=operational` and `state=canonical_retry`; do not use `maintenance_jobs`
  for analysis retries and do not claim parity from a failed write.
- [ ] Backfill in batches of at most 100 request identifiers, ordered by a
  stable source cursor. Emit aggregate count/checksum status only. Preserve
  request status/progress, result rank/score, provider operation identity,
  cost-known/unknown semantics, audit retention/version, replay fragments, and
  relationship lineage. Unknown cost remains `amount_known = NULL` and
  `usage_unknown = true`.
- [ ] Compare normalized source/canonical projections, not just counts. A
  mismatch keeps the legacy reader. Shadow-read the canonical family while the
  legacy path remains the response path; record sanitized mismatch metrics.
- [ ] Require zero unresolved parity mismatches, a drained
  `analysis_events(kind=operational,state=canonical_retry)` marker set, no
  forbidden payload/token columns, RLS/ACL checks, and a reader rollback
  contract before enabling any family flag. Enabling a flag is outside this
  read-only task and requires a separate owner approval.

**Wave 1 dry-run and post-apply gate:** the future migration set must be a
literal list of the generated analysis migration version(s), with no
`--include-all`; assert `npx --yes supabase@2.102.0 --version` is exactly
`2.102.0`, then run `npx --yes supabase@2.102.0 db push --dry-run --linked`
from an isolated clean worktree and verify that the output contains only that
literal set. After an approved apply, verify migration history exactly once, canonical
schema/ACL/RLS/routine contracts, source/canonical aggregate parity, retry
drain, and unchanged payment/account invariants. The approved destructive list
remains `[]` for this wave.

**Wave 1 rollback:** set all analysis canonical read flags false, drain or
  fence `analysis_events` canonical-retry markers, return reads to the source
  tables, and retain canonical rows for forensic comparison. If a migration
  itself must be reversed, use the migration's explicit reversible path from a
  clean isolated worktree after verifying remote history; never repeat a hung
  push.

## Audit evidence wave: blocked and independent

The four `analysis_order_audit_*` sources are a separate blocked evidence wave,
not part of Wave 1 completion, its five-family parity, or its retry-drain
accounting. The current source allowlist is exactly:

`analysis_order_audit_assembly_queue`, `analysis_order_audit_bundles`,
`analysis_order_audit_candidates`, `analysis_order_audit_interactions`.

- [ ] Keep all four sources authoritative and preserve their existing foreign
  keys/triggers. Do not assign them to the Wave 1 executable allowlist or
  canonicalize them from count-only evidence.
- [ ] Obtain genuine production bundle/candidate/interaction projections and
  prove per-row parity against `analysis_audit_bundles`, including version,
  inclusion/completeness state, interaction ordering, immutable content hash,
  retention, and request ownership.
- [ ] Produce encrypted archive and isolated restore evidence with deterministic
  aggregate checksums, then obtain separate analysis-audit owner approval.
  Until every gate closes, this wave remains blocked and its destructive
  allowlist remains `[]`.

**Audit rollback:** retain source-authoritative audit reads, discard no source
rows, and preserve canonical comparison evidence. A mismatch, missing bundle,
archive, restore, or owner approval keeps the wave blocked.

## Wave 2: commerce and operations canonicalization, deferred

**Purpose:** Define the boundary for the 38 commerce/operations source tables
without pretending that the current CLI is executable. The existing commerce
file declares 12 names, but `backfillCommerceOperationsCanonical` is invoked
without `readBatch` or `readCanonicalBatch` and therefore returns
`SOURCE_NOT_CONFIGURED` with zero processed records. The executable allowlist
is consequently `[]`; 37 consolidate rows are explicitly deferred and the
cohort member source is blocked.

- [ ] Before any source enters this wave, wire real source and canonical
  readers into the report-only CLI, then add an exact per-source adapter spec
  (field projection, identity/cursor rule, normalization, and parity
  contract). That implementation is outside this document-only handoff.
- [ ] Keep all 37 deferred commerce sources source-authoritative. The two
  names declared by the commerce file but belonging to analysis boundaries,
  `analysis_v2_recovery_provider_run_adoptions` and
  `analysis_v2_gemini_leases`, remain deferred cross-wave sources until a real
  reader and explicit destination contract exist.
- [ ] Keep `private_accounts` blocked outside Wave 1. Its fields
  `id/request_id/instagram_id/profile_image/full_name/name_female_score/
  name_is_name/name_confidence/created_at` need a lossless profile or
  result-artifact destination, owner/publication and share-reader parity,
  server-only dual-write, shadow-read rollback, and archive evidence before
  any allowlist entry.
- [ ] Keep `earlybird_concierge_batch_cohort_members` blocked until its source
  primary key `(cohort_key, order_id)` is proven unique by `order_id` alone or
  mapped to a deterministic cohort/member identity. The proposed
  `fulfillment_jobs` destination has `UNIQUE(order_id)` and must receive a
  lossless frozen-manifest projection; migrate the callers in
  `scripts/warm-reimage-g1.ts` and `scripts/warm-reimage-g2.ts` before parity.
  It is not a Wave 2 source.
- [ ] Keep webhook, fulfillment, outbox, account-deletion, recovery, and lease
  writers source-authoritative behind server-only flags. Enforce event and
  notification idempotency, fulfillment lease generation/fencing, lifecycle
  ordering, configuration versioning, and maintenance retry identity.
- [ ] Backfill at most 100 source records per batch with aggregate parity
  checksums. Preserve the 12 account-deletion rows and 89 webhook rows. Keep
  raw provider bodies, cookies, contact fields, and tokens out of canonical
  payloads. Record only redacted event evidence and stable hashes.
- [ ] For `payment_pending`, require independent provider no-sale evidence and
  the existing owner-approved reconciliation path. A missing or ambiguous
  provider result is `blocked`; no canonicalization step may mark it paid,
  failed, refunded, or otherwise mutate the order.
- [ ] Require event/order/fulfillment/lifecycle parity, bounded retry drain,
  ACL/RLS/routine checks, shadow-read agreement, and rollback before any family
  reader is enabled. Flags remain false until separately approved.

**Wave 2 dry-run and post-apply gate:** after the reader prerequisite closes,
use a literal list containing only the generated commerce/operations migration
version(s); assert `npx --yes supabase@2.102.0 --version` is exactly `2.102.0`,
then run `npx --yes supabase@2.102.0 db push --dry-run --linked`; do not use
`--include-all`. After approval, verify the exact migration history, canonical
constraints, event idempotency, fulfillment fences, notification dedupe,
account lifecycle order, lease generation, retry drain, archive/restore
proof, and unchanged payment-pending dispositions. The approved destructive
list remains `[]`.

**Wave 2 rollback:** disable canonical readers, return to source-authoritative
webhook/fulfillment/outbox/account paths, fence outstanding canonical leases,
and retain canonical evidence for comparison. Never fabricate a provider
disposition or retry a migration push without first reading remote history and
catalog state.

## Wave 3: evidence-gated retirement candidates

**Purpose:** Retire only a future, exact, owner-approved set after Waves 1 and
2 have closed all preservation gates.

The current approved retirement set is exactly `[]`. The current 17 blocked
names above are not a drop allowlist. No table is classified `retire` in the
captured state.

- [ ] Regenerate the full 177-row inventory after each additive wave. A table
  may enter a new retirement proposal only if it is no longer a source for a
  canonical family, its preserved rows/checksums are complete, and its owner
  contract names the canonical destination or an approved archive.
- [ ] Prove a bounded post-reset observation window with source row count 0,
  zero inserts/updates/deletes, and no active locks or writers. `stats_reset =
  NULL` fails this gate. Current zero counters are not sufficient.
- [ ] Prove no incoming or outgoing FK, dependent view, stored routine
  definition, trigger, publication, scheduled job, repository caller, or
  external writer. The caller scan must include application roots and
  operational `scripts/**` plus `supabase/operations/**`; a stored-routine
  mention, operational caller, or dependency edge keeps the table blocked even
  if it is empty.
- [ ] Produce an encrypted isolated archive and restore manifest containing
  aggregate count/checksum only. Verify restore into a disposable database,
  deterministic checksum match, schema/ACL/RLS match, and a tested rollback
  reader. Record owner approval and retention period outside raw production
  data.
- [ ] Write a new evidence report with a literal `approvedDestructiveAllowlist`
  of exact table names. Keep it empty when any gate is missing. Never replace
  the list with a wildcard, a pattern, or `--include-all`.

**Retirement dry-run:** after the literal migration version and table allowlist
are approved, assert `npx --yes supabase@2.102.0 --version` is exactly
`2.102.0`, then run `npx --yes supabase@2.102.0 db push --dry-run --linked` in a
clean isolated worktree and assert that only the exact migration is selected.
Do not run an apply in this plan. If a future apply hangs, inspect remote
migration history and catalog state first; do not repeat the command blindly.

**Retirement post-apply gate:** verify exact expected count delta from the
pre-apply inventory, canonical count/set, migration history exactly once,
absence of retired relations and dependencies, preserved aggregate checksums,
archive/restore checksum, RLS/ACL/routine contracts, and no changes to
payment-pending or canary state. Any mismatch blocks the next wave.

**Retirement rollback:** use the pre-approved isolated restore/archive path,
restore source-authoritative reads, fence retries, verify canonical rows are
unchanged, and record a new sanitized inventory. Rollback is not a reason to
drop canonical data or repeat an uncertain push.

## Wave 4: terminal exact-22 contract

Wave 4 is a verification state, not an instruction to force the count down.
It becomes ready only when all source families have parity, all approved
retirements have independent archive/restore proof, and all 17 current blocked
decisions have either an owner-approved preservation contract or remain outside
the catalog with a documented reason.

- [ ] Query public base/partitioned relations and assert count exactly `22`,
  partition count `0`, canonical set exact, and canonical-set SHA unchanged.
- [ ] Assert every canonical relation has the required RLS/force-RLS, ACL,
  foreign-key, trigger, routine, view, publication, and sequence contracts;
  no legacy writer remains on a retired source; and all migration versions are
  present exactly once.
- [ ] Reuse only existing contract checks when they are necessary to establish
  a migration or reader gate; do not propose new tests or broad CI in this
  document-only plan. Keep activation and real canary state untouched.
- [ ] Publish a final sanitized inventory and evidence report with every table
  accounted for and `destructiveOperations: "refused"` unless a separate
  approved execution report says otherwise.

## Verification commands and handoff

Use the lean default checks from the clean implementation worktree after each
future code/migration wave, never against production during this read-only
task. Do not run a broad test suite or CI for this document-only handoff:

```bash
npx tsc --noEmit --pretty false
npm run lint
git diff --check
```

For each future migration, the required evidence is limited to the exact
pinned-CLI pre-apply dry-run and post-apply migration/catalog/parity evidence:

```bash
test "$(npx --yes supabase@2.102.0 --version)" = "2.102.0"
npx --yes supabase@2.102.0 db push --dry-run --linked
npx --yes supabase@2.102.0 migration list --linked
```

The dry-run must name only the literal migration allowlist. Post-apply evidence
must assert the exact expected table delta, canonical 22/set, selected
migration occurrence exactly once, and source/canonical aggregate parity; any
missing field, unavailable stats boundary, or ambiguous result remains
blocked. No new test files, broad test command, CI run, production mutation,
activation, canary, or payment-state mutation is part of this task.

Before committing a report, run a JSON parse and exact-count assertion without
printing table rows:

```bash
node - <<'NODE'
const d = require('./docs/reports/2026-09-11-supabase-22-final-convergence-inventory.json');
if (d.liveState.publicBasePartitionedTableCount !== 177
  || d.liveState.canonicalTableCount !== 22
  || d.liveState.noncanonicalTableCount !== 155
  || d.tables.length !== 177
  || d.classificationSummary.retain !== 22
  || d.classificationSummary.consolidate !== 138
  || d.classificationSummary.retire !== 0
  || d.classificationSummary.blocked !== 17
  || d.destructiveOperations !== 'refused') process.exit(1);
if (new Set(d.tables.map(row => row.tableName)).size !== 177) process.exit(1);
console.log('supabase-22 sanitized inventory contract: PASS');
NODE
```

The handoff is complete only when the three worker-owned files are the only
intended diff, `git diff --check` and the static/typecheck/report contracts
pass, no sensitive values are present, and the coordinator receives the full
commit SHA. No production mutation, push, drop, activation, real canary, or
payment-pending mutation is part of this handoff.
