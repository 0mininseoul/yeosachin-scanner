# Supabase 22 final convergence evidence

## Status

This is the read-only production snapshot taken on 2026-09-11 after the
`20260911001903` earlybird retirement migration. The linked production project
was inspected through the authenticated, pinned `npx --yes supabase@2.102.0` CLI from
an isolated work directory; no SQL mutation, migration push, table drop,
activation, canary, payment-state change, or raw-row export was performed.

The source repository boundary is `origin/main` at commit
`956dd485259c7e1dd5b0ecbea09f24fd90aafb2a`. The CLI version assertion was
`npx --yes supabase@2.102.0 --version` = `2.102.0` before inspection; an
unversioned CLI is not an acceptable substitute. Secrets, access tokens,
cookies, UUIDs, provider payloads, and user/device identifiers are
intentionally absent.

The runtime/dependency audit baseline is the sanitized audit at commit
`00c11ad2`; its operational scan is incorporated here for the caller boundary.
The scan covers `app/**`, `components/**`, `hooks/**`, `lib/**`,
`middleware.*`, operational `scripts/**`, and `supabase/operations/**`;
`supabase/migrations/**` remains migration-history evidence. Operational
references are counted as callers but are not promoted to proof of live traffic.
The follow-up correction at `faa7b876` is also applied: `blocked` means
retirement is not authorized, and the dependency aggregate is recorded as 243
outgoing and 240 incoming foreign-key endpoint rows.

## Review finding closure map

The review report at `d8cd4525` is closed by these document-only corrections:

| Finding | Correction recorded in this baseline |
|---|---|
| P1-1 source coverage | The inventory narrows Wave 1 to 21 request-safe executable analysis sources. The two cache specs, `ai_analysis_cache` and `analysis_v2_ai_global_result_cache`, declare `requestIdColumn: null` and are rejected by the existing reader, so they are deferred. Wave 2 remains empty because the commerce report-only CLI has no wired `readBatch`/`readCanonicalBatch`; the inventory names 80 deferred analysis and 37 deferred commerce consolidate rows, with the two cross-wave declarations explicit. |
| P1-2 retry destination | Analysis retries use `analysis_events` operational `canonical_retry` markers through `enqueue_analysis_canonical_retry`; `maintenance_jobs` is not an analysis retry destination. |
| P1-3 private accounts | `private_accounts` is now blocked with no canonical destination or destructive proposal until its profile/result-artifact field, identity, owner/publication, reader, dual-write, rollback, and archive contract is proven. |
| P1-4 cohort cardinality/callers | `earlybird_concierge_batch_cohort_members` is now blocked pending order-wide uniqueness or deterministic cohort/member identity plus lossless frozen-manifest mapping. `scripts/warm-reimage-g1.ts` and `scripts/warm-reimage-g2.ts` are counted as operational callers. |
| P1-5 audit boundary | The four `analysis_order_audit_*` tables are assigned to a separate blocked audit-evidence wave with independent production bundle parity, archive, restore, and owner gates, excluded from Wave 1. |
| P2-1 CLI pin | The inventory requires and records an exact `2.102.0` assertion before every future catalog or dry-run command. |

No application, migration, or test code was changed for these corrections.

## Exact live catalog

The sanitized machine-readable inventory is
[`2026-09-11-supabase-22-final-convergence-inventory.json`](./2026-09-11-supabase-22-final-convergence-inventory.json).
It contains one row for every public base or partitioned relation, together
with aggregate dependency, RLS, statistics, and static runtime evidence.

The live relation set is exact:

- 177 public base/partitioned tables.
- 22 canonical tables, with set match true and canonical-set SHA-256
  `8c9d723b68d02caaad03d2f6795263b52b2dc46ce1b92b987faed26641af9527`.
- 155 noncanonical tables; all are accounted for in the inventory.
- 0 partitioned tables.
- RLS is enabled on all 177 tables. `FORCE ROW LEVEL SECURITY` is false on
  38, so that property remains a gate for any future canonical contract.
- The active public-write-lock aggregate was 0 at capture. This is not a
  closed traffic window: `pg_stat_database.stats_reset` was NULL, so table
  write counters are diagnostic only.

The approved canonical set is:

`account_lifecycle`, `analysis_artifacts`, `analysis_audit_bundles`,
`analysis_cache`, `analysis_costs`, `analysis_events`, `analysis_jobs`,
`analysis_preflights`, `analysis_provider_runs`, `analysis_requests`,
`analysis_results`, `earlybird_orders`, `earlybird_waitlist`,
`fulfillment_jobs`, `landing_leads`, `maintenance_jobs`,
`notification_outbox`, `payment_events`, `result_feedback`,
`system_configuration`, `system_leases`, `users`.

## Post-apply reconciliation

The current snapshot reconciles the committed pre-wave evidence:

- Baseline before the retirement waves: 187 tables.
- After the comment/interaction wave: 185 tables.
- After `20260911001903`: 177 tables, for a total retired delta of 10.
- `maintenance_jobs` contains 11 rows from the `20260911001903` retirement
  family.
- The account-deletion source has 12 rows and the earlybird webhook source has
  89 rows; these remain source evidence until their canonical parity gates
  close.
- `comment_details`, `interaction_logs`, and the eight earlybird recovery
  targets are absent.
- Selected migration history contains exactly one occurrence each of
  `20260910035257`, `20260910123053`, and `20260911001903`.

## Classification and wave disposition

Every one of the 155 noncanonical tables has exactly one classification in the
inventory:

- `retain`: 22 canonical tables.
- `consolidate`: 138 legacy tables, assigned to an explicit canonical
  destination and preservation requirement; only sources with a concrete
  current spec/reader enter an executable wave.
- `retire`: 0. No current destructive allowlist is defensible.
- `blocked`: 17 tables requiring new production evidence or an owner-scoped
  contract before any retirement decision.

The 17 blocked tables are:

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

Wave 1 has an exact 21-table request-safe executable analysis source allowlist.
The source file still declares 23 non-audit specs, but the
`ai_analysis_cache` and `analysis_v2_ai_global_result_cache` specs declare
`requestIdColumn: null`, which the existing reader rejects; both are therefore
deferred. The five defined families are jobs, events, artifacts, costs, and
cache, and the inventory names the other 80 analysis consolidate rows as
deferred, including the two cross-wave names declared by the commerce file.
Wave 2 has an empty executable allowlist: its current report-only function
declares 12 names but has no wired `readBatch` or `readCanonicalBatch`; the 37
non-blocked commerce consolidate rows are named as deferred and the cohort
source is blocked. Both canonicalization waves are source-authoritative with
exact empty destructive allowlists.

The four `analysis_order_audit_*` sources are in the separate
`auditEvidenceWave`, which is blocked evidence-only and independent of Wave 1
parity/retry accounting. Its canonical destination proposal is
`analysis_audit_bundles`, but genuine production bundle parity, encrypted
archive, isolated restore, and separate owner approval are still required.
Wave 3 is blocked with an exact empty approved destructive allowlist; terminal
convergence is therefore not ready.

Analysis dual-write failures use the existing
`enqueue_analysis_canonical_retry` marker contract in
`analysis_events(kind = operational, state = canonical_retry)`. The
`maintenance_jobs` destination is not used for analysis retry markers because
its current contract does not admit `canonical_retry`.

`private_accounts` is blocked outside every executable allowlist. Its current
4,861 rows are a request-scoped private-profile collection with no proven
lossless projection into `analysis_results`; the inventory records no canonical
destination or retirement permission. It requires field/identity, owner and
publication, share-reader, dual-write, shadow-read, rollback, and archive
proof.

`earlybird_concierge_batch_cohort_members` is blocked outside Wave 2. Its
source identity is `(cohort_key, order_id)` while the proposed
`fulfillment_jobs` identity is order-wide, so cardinality is not assumed. The
inventory records two operational callers, `scripts/warm-reimage-g1.ts` and
`scripts/warm-reimage-g2.ts`, and requires an order-wide uniqueness invariant
or deterministic cohort/member identity plus a lossless frozen-manifest
projection before parity or retirement consideration.

The classification decisions preserve data by requiring bounded dual-write,
aggregate parity, normalized row checksums, source-authoritative rollback,
encrypted archive/restore evidence, and explicit owner approval before a
source table can leave the catalog. Unknown cost or payment evidence stays
unknown/blocked; it is never fabricated or converted into a payment state.

## Evidence limits

Catalog queries captured names, relation classes, aggregate counts, dependency
counts, policy/trigger/publication counts, RLS state, statistics counters, and
sanitized source-reference counts only. Static source-reference counts do not
prove absence of external callers. The caller scan includes operational
`scripts/**` and `supabase/operations/**`; those references are not live-traffic
proof. Several replay, audit, canary, and secret lifecycle tables have
stored-routine or foreign-key dependencies even when their current row/write
counters are zero, which is why they are consolidated or blocked rather than
retired.

The current `stats_reset` boundary is unavailable, and no live activation or
canary scope was authorized. Any future retirement must first obtain a bounded
post-reset write-quiescence window and independently verify routine, view,
trigger, publication, foreign-key, scheduler, and external-writer absence.

## Reproduction boundary

The safe inspection shape is a read-only linked query with the pinned CLI in an
isolated work directory containing only Supabase CLI metadata. First assert
`test "$(npx --yes supabase@2.102.0 --version)" = "2.102.0"`, then use
`npx --yes supabase@2.102.0 db query --linked --output json`; do not source an
application `.env.local`, print CLI credentials, export raw rows, or use
`npx --yes supabase@2.102.0 db push`. The plan in
[`2026-09-11-supabase-22-final-convergence.md`](../superpowers/plans/2026-09-11-supabase-22-final-convergence.md)
defines the exact future dry-run, post-apply, rollback, and lean static/typecheck
gates. No new tests, broad test suite, or CI run is required for this report-only
document correction.

Official references used for the CLI contract:

- [Supabase `db query` reference](https://supabase.com/docs/reference/cli/supabase-db-query)
- [Supabase `migration list` reference](https://supabase.com/docs/reference/cli/supabase-migration-list)
- [Supabase `db push` reference](https://supabase.com/docs/reference/cli/supabase-db-push)
- [Supabase database inspection guide](https://supabase.com/docs/guides/database/inspect)
- [Supabase changelog](https://supabase.com/changelog.md)
