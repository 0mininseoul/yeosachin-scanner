# Supabase 22 final convergence evidence

## Status

This is the read-only production snapshot taken on 2026-09-11 after the
`20260911001903` earlybird retirement migration. The linked production project
was inspected through the authenticated, pinned `npx supabase@2.102.0` CLI from
an isolated work directory; no SQL mutation, migration push, table drop,
activation, canary, payment-state change, or raw-row export was performed.

The source repository boundary is `origin/main` at commit
`956dd485259c7e1dd5b0ecbea09f24fd90aafb2a`. Secrets, access tokens, cookies,
UUIDs, provider payloads, and user/device identifiers are intentionally absent.

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
- `consolidate`: 140 legacy tables, assigned to an explicit canonical
  destination and preservation requirement.
- `retire`: 0. No current destructive allowlist is defensible.
- `blocked`: 15 tables requiring new production evidence or an owner-scoped
  contract before any retirement decision.

The 15 blocked tables are:

`analysis_order_audit_assembly_queue`, `analysis_order_audit_bundles`,
`analysis_order_audit_candidates`, `analysis_order_audit_interactions`,
`analysis_v2_apify_secret_ref_prune_guard`,
`analysis_v2_profile_provider_canary_experiments`,
`analysis_v2_profile_provider_canary_runs`,
`analysis_v2_profile_repair_canary_runs`, `demo_analysis_fixtures`,
`demo_analysis_runs`, `earlybird_first15_canary_provider_rearms`,
`earlybird_v211_concierge_publications`, `payment_orders`, `payments`,
`pending_analysis`.

Wave 1 has an exact 102-table analysis source allowlist in the inventory and
targets the analysis canonical families. Wave 2 has an exact 38-table
commerce/operations source allowlist and targets the account, fulfillment,
notification, payment, configuration, lease, and maintenance families. Both
waves are additive, source-authoritative, and have an exact empty destructive
allowlist. Wave 3 is blocked with an exact empty approved destructive
allowlist; terminal convergence is therefore not ready.

The classification decisions preserve data by requiring bounded dual-write,
aggregate parity, normalized row checksums, source-authoritative rollback,
encrypted archive/restore evidence, and explicit owner approval before a
source table can leave the catalog. Unknown cost or payment evidence stays
unknown/blocked; it is never fabricated or converted into a payment state.

## Evidence limits

Catalog queries captured names, relation classes, aggregate counts, dependency
counts, policy/trigger/publication counts, RLS state, statistics counters, and
sanitized source-reference counts only. Static source-reference counts do not
prove absence of external callers. Several replay, audit, canary, and secret
lifecycle tables have stored-routine or foreign-key dependencies even when
their current row/write counters are zero, which is why they are consolidated
or blocked rather than retired.

The current `stats_reset` boundary is unavailable, and no live activation or
canary scope was authorized. Any future retirement must first obtain a bounded
post-reset write-quiescence window and independently verify routine, view,
trigger, publication, foreign-key, scheduler, and external-writer absence.

## Reproduction boundary

The safe inspection shape is a read-only linked query with the pinned CLI in an
isolated work directory containing only Supabase CLI metadata. Use `db query
--linked --output json`; do not source an application `.env.local`, print CLI
credentials, export raw rows, or use `db push`. The plan in
[`2026-09-11-supabase-22-final-convergence.md`](../superpowers/plans/2026-09-11-supabase-22-final-convergence.md)
defines the exact future dry-run, post-apply, rollback, and test gates.

Official references used for the CLI contract:

- [Supabase `db query` reference](https://supabase.com/docs/reference/cli/supabase-db-query)
- [Supabase `migration list` reference](https://supabase.com/docs/reference/cli/supabase-migration-list)
- [Supabase `db push` reference](https://supabase.com/docs/reference/cli/supabase-db-push)
- [Supabase database inspection guide](https://supabase.com/docs/guides/database/inspect)
- [Supabase changelog](https://supabase.com/changelog.md)
