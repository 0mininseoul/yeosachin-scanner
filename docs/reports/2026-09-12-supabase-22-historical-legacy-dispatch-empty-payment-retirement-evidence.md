# Supabase 22 historical/empty-payment retirement evidence

Status: `READY_FOR_REVIEW_NOT_APPLIED`

This report records the production read-only decision and the local implementation. No production migration, push, activation, canary, payment-state change, or analysis-runtime change was performed.

## Decision

Implement the largest defensible three-table group:

| Target | Fresh production rows | Local action |
| --- | ---: | --- |
| `public.analysis_v2_historical_legacy_dispatch_terminalization_receipts` | 5 | Preserve every typed row in `public.maintenance_jobs`, then drop the table and its three retired owner-only routines/trigger guard |
| `public.payment_orders` | 0 | Require an empty table, then drop it explicitly |
| `public.payments` | 0 | Require an empty table, preserve the owner-only pre-reconciliation routine and its wrapper contract unchanged, then drop the table explicitly |

The fresh production public base/partitioned-table count was 177. The migration asserts that baseline and expects 174 after these three targets are removed. `public.pending_analysis` has 11 rows, all currently `awaiting_payment`, and remains untouched; no payment state was inferred or changed. `public.account_deletion_jobs` is deferred.

## Preservation contract

The five historical receipt rows are copied losslessly into the existing `public.maintenance_jobs` canonical ledger before any destructive statement. Each canonical row uses:

- `kind = 'terminalize'`;
- a domain-separated SHA-256 `target_key_hash` over the retirement contract, kind, source table, and the stable `receipt_id` key;
- `payload.legacy_source_table` with the exact source relation name;
- `payload.legacy_primary_key = {"receipt_id": ...}`;
- `payload.legacy_row = to_jsonb(source_row)`, retaining every typed source column and null value;
- `payload.schema_version = 1`; and
- `content_hash` as SHA-256 over the canonical payload text.

The migration fails closed on an existing conflicting canonical key, checks source count and distinct primary-key multiplicity, verifies ordered aggregate hashes, and verifies every source row's key, full JSONB row, and schema version before dropping. Empty payment tables have a vacuous preservation proof through exact zero-row guards.

## Dependency evidence and exclusions

All 14 historical receipt tables were present as ordinary public base tables. For each, the production catalog showed zero incoming foreign keys, zero direct dependent views, zero direct dependent routines, and no publication membership; each has one immutability trigger owned by the table. The selected historical table's two body references are the owner-only candidate/resolver routines being retired, plus its immutability trigger guard.

The other 13 historical receipt tables remain because dynamic routine-body references connect them to active analysis/preflight/provider/job paths:

Those 13 deferred sources contain 21 rows (the complete 14-table historical cohort contains 26 rows including the selected five).

| Deferred source | Rows | Active reference evidence |
| --- | ---: | --- |
| `earlybird_adoption_policy_failure_rearms` | 2 | `purge_expired_analysis_v2_preflights` and active preflight retention |
| `earlybird_concierge_snapshot_conflict_recoveries` | 1 | `list_analysis_v2_dispatchable_jobs` and active V2 job store |
| `earlybird_pfe_target_evidence_start_rejection_rearms` | 1 | active recovery-provider adoption chain |
| `earlybird_pfe3_media_artifact_rearms` | 1 | active recovery-provider adoption chain |
| `earlybird_profile_fetch_exhaustion_recoveries` | 1 | active recovery-provider adoption chain |
| `earlybird_schema_failure_recoveries` | 7 | preflight retention, fulfillment recovery, and preflight admission |
| `earlybird_terminal_unavailable_exhaustion_rearms` | 1 | `purge_expired_analysis_v2_preflights` and active preflight retention |
| `earlybird_v211_apify_transient_replays` | 1 | active recovery-provider adoption chain |
| `earlybird_v211_concierge_replays` | 2 | active recovery-provider adoption chain |
| `earlybird_v211_lease_policy_failure_rearms` | 1 | active recovery-provider adoption chain |
| `earlybird_v211_policy_identity_replays` | 1 | active recovery-provider adoption chain |
| `earlybird_v211_profile_ai_diagnostic_replays` | 1 | active recovery-provider adoption chain |
| `earlybird_v211_relationship_lineage_failure_rearms` | 1 | active recovery-provider adoption chain |

The selected `public.payments` table had one lexical body match, `public.finalize_earlybird_groble_payment_pre_reconciliation`, but the live match is comment-only. The routine is intentionally preserved: the `finalize_earlybird_groble_payment_reconciliation_aware` wrapper invokes it, and its database-owner-only ACL is the expected `SECURITY DEFINER` boundary. The migration allowlists its exact signature, snapshots and rechecks its definition/ACL hashes, and leaves its body, grants, and existence unchanged. `public.payment_orders` had no incoming/dependent catalog or body references. `public.pending_analysis` had no body references but is explicitly excluded because it contains live payment-gated rows.

## Local implementation

- Supabase-specific migration guidance was followed: the pinned CLI generated the migration filename, production checks used only the authenticated linked workdir, and no production mutation was attempted.
- Migration: `supabase/migrations/20260912070144_retire_historical_legacy_dispatch_and_empty_payment_tables.sql`
- Isolated restore operation: `supabase/operations/20260912_restore_historical_legacy_dispatch_and_empty_payment_tables.sql`
- The migration uses a transaction, advisory lock, lock/statement timeouts, exact relation OID revalidation, literal target allowlists, exact source/canonical shapes and primary keys, incoming-FK/view/routine/publication guards, preserved payment-routine definition/ACL hash revalidation, explicit non-`CASCADE` drops, and a final table/routine/reference/count guard.
- The historical terminalizer runbook is marked archived/retired, and the generator CLI now fails closed with a retirement error. Its pure validation/SQL-generation helpers remain available only for existing contract tests; no runtime adapter or analysis canonical adapter was changed.

## Rollback and verification

Before commit, any failed guard rolls back the transaction automatically. After a reviewed production commit, recovery is intentionally isolated: execute the restore operation only in a disposable database after `SET supabase.retirement_isolated = 'true'`. It requires the canonical ledger and parent relations, refuses pre-existing targets, reconstructs the historical table with its typed constraints/index, recreates the server-only empty payment relations with their constraints/indexes/RLS boundary, restores the five rows from `legacy_row`, and verifies exact ordered row parity and zero payment rows. It does not delete or rewrite canonical rows and is not a production rollback command.

Local checks completed before coordinator handoff: `git diff --check`, `npx tsc --noEmit`, a narrow PGlite retirement proof (`public_tables=174`, `canonical_rows=5`, and `pending_analysis` retained), and the isolated restore proof (`restored_receipts=5`, both payment tables zero, and `canonical_rows=5`). Broad tests/build/CI and production SQL mutation are out of scope for this task.

## Coordinator rollout gate

The coordinator must review the exact migration allowlist and run its own production dry-run/dependency verification before any apply. If accepted, apply only this migration in the authenticated linked production workdir, then verify the migration history, final public count, absence of the three targets and three retired historical routines, presence and unchanged definition/ACL of `finalize_earlybird_groble_payment_pre_reconciliation`, canonical archive count, and unchanged `pending_analysis` count/status; do not run activation/canary or mutate payment state.
