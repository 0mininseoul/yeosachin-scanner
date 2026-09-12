# Supabase 22 pending_analysis retirement evidence

Status: READY_FOR_REVIEW_NOT_APPLIED

Implementation commit: `cc751644e0875b957ca6f91a9b5633e9ad3aa0d7`
(`fix: retain pending archive user cascade`).

No production migration, push, activation, canary, payment-state update, or
merge was performed. Production evidence was read with the pinned authenticated
Supabase CLI 2.102.0 through the linked workdir
/private/tmp/yeosachin-public22-cli.0GC1rz; no secrets, raw rows, usernames,
or user IDs are recorded here.

## Decision

Retire only public.pending_analysis, after the sibling
20260912070144_retire_historical_legacy_dispatch_and_empty_payment_tables.sql
has been applied:

| Target | Fresh production evidence | Local action |
| --- | ---: | --- |
| public.pending_analysis | 11 rows | Preserve all rows in public.maintenance_jobs, then drop the source table explicitly |

The fresh public base/partitioned-table count is 177. The sibling migration is
the required preceding slice, so this migration asserts 174 before the drop and
173 after it. The source status remains awaiting_payment in every archived
row; no payment completion, sale/no-sale, or payment_pending disposition is
inferred or changed. Before the archive insert, the migration validates the
reviewed 16-column maintenance_jobs predecessor, then appends nullable
maintenance_jobs.legacy_pending_user_id UUID with an auth.users(id) ON DELETE
CASCADE FK. A scoped check requires that field exactly for this succeeded
pending_analysis archive cohort and ties it to payload.legacy_row.user_id;
unrelated maintenance rows remain NULL.

## Source evidence

- 11 distinct primary keys; all 11 statuses are awaiting_payment.
- 0 non-null polar_checkout_id values.
- Session-local production labels were created 2026-01-30 through
  2026-02-03 and updated 2026-01-30 through 2026-02-03 in Asia/Seoul.
- The migration and restore operation pin TIME ZONE 'UTC'. Under that
  serialization, both created and updated dates span 2026-01-29 through
  2026-02-03; the exact full-row SHA-256 is
  e7298026824e8f78487aa2b7335277b36c908ee94d1792bba20fd0d1dd4f959b.
- Columns are id uuid NOT NULL, user_id uuid NOT NULL,
  target_instagram_id text NOT NULL, target_gender text NOT NULL,
  plan_type text NOT NULL, status text NOT NULL,
  polar_checkout_id text, created_at timestamptz, and
  updated_at timestamptz; the primary key is id.
- Existing checks constrain gender to male/female, plan to basic/standard,
  and status to awaiting_payment/paid/refunded/expired. The source has one
  outgoing user_id -> auth.users(id) ON DELETE CASCADE FK and zero incoming
  FKs.
- The typed archive reference is derived from source user_id only; it does not
  rewrite the source row, payload, content_hash, or status.

## Dependency and access boundary

- Zero dependent views, zero dependent routines, zero routine-body mentions,
  zero view-body mentions, zero user triggers, and zero publication
  memberships. The local app, lib, scripts, and supabase/operations caller
  scan found no callers; only the existing inventory denylist names this
  legacy table.
- The source has RLS enabled and not forced, two existing owner policies
  (INSERT and SELECT, both auth.uid() = user_id for PUBLIC), and the legacy
  broad table ACL observed in production.
- public.maintenance_jobs is RLS-enabled and forced with owner-only ACL.
  The migration guards this canonical shape and boundary before inserting
  archive rows.

## Preservation and retirement contract

Each source row becomes one immutable canonical row with:

- kind = audit_assembly;
- state = succeeded, meaning only that the archive operation completed;
- a domain-separated SHA-256 target_key_hash over the source table and id;
- payload.legacy_source_table = pending_analysis;
- payload.legacy_primary_key = {"id": ...};
- payload.legacy_row = to_jsonb(source_row), retaining every source field,
  key, timestamp, null, and original status;
- payload.schema_version = 1;
- explicit archive_state_semantics, no_work_enqueued, and
  payment_state_mutated = false; and
- content_hash over the complete canonical payload; and
- legacy_pending_user_id = source_row.user_id, backed by a partial non-null
  index and the auth.users ON DELETE CASCADE FK.

The migration locks both relations in one transaction, rejects changed
relation/schema/RLS/ACL/dependency evidence, requires the exact 11-row
awaiting-payment/null-checkout/UTC-window snapshot and full-row hash, rejects
canonical conflicts, verifies per-row and aggregate parity, then runs only
DROP TABLE public.pending_analysis without CASCADE. It does not enqueue
work, update any business row, or mutate payment state.

## Retention and restore lifecycle

The typed FK intentionally preserves the source table's account-deletion
semantics: deleting an auth.users parent removes only that user's pending
archive rows. The isolated restore operation requires the exact 11-row archive
count, aggregate hash, typed references, and parent users; after an authorized
user deletion it fails closed rather than synthesizing missing rows or
resurrecting deliberately deleted account data. Unrelated maintenance rows and
their statuses are outside the scope and remain unchanged.

## Owned files

- Migration:
  supabase/migrations/20260912073338_retire_pending_analysis_legacy_input.sql
- Isolated restore operation:
  supabase/operations/20260912_restore_pending_analysis_legacy_input.sql

The restore operation requires SET supabase.retirement_isolated = 'true',
refuses a pre-existing source table, locks the canonical archive, verifies
succeeded state plus deterministic key/content hashes, the typed FK contract,
and the canonical full-row hash before insert, recreates the typed source
shape/indexes/RLS/policies, and verifies exact restored full-row parity. It
never deletes or rewrites canonical rows and requires auth.users in the
disposable database.

## Validation

- The pre-change disposable contract check failed because the typed retention
  field was absent; the post-change check found the typed FK, scoped parity,
  and strict restore guards.
- Narrow disposable PostgreSQL 17 proof passed with synthetic rows. The
  unmodified committed migration first rejected the fixture with
  RETIREMENT_GUARD_SOURCE_EVIDENCE_MISMATCH; a derived stdin-only SQL stream
  substituted only the reviewed production aggregate hash literal with the
  fixture's UTC serialization hash, leaving all shape/status/count/window/
  parity guards unchanged. The retained disposable data directory is
  /private/tmp/pending-retention-fix-proof.4hCRrL; its local server was stopped
  after proof. Archive results were 173 public tables after retirement, source
  absent, 11 archive rows, 11 typed references, a present partial index, and
  consistent payload hashes. Strict restore returned 11 rows, all
  awaiting_payment, zero checkout references, and a matching full-row hash.
- The synthetic account-deletion proof removed exactly one pending archive row
  and its restored source row, leaving 10 typed archive rows and two unrelated
  blocked maintenance rows unchanged in payload, hash, and state. A subsequent
  restore attempt failed closed with RETIREMENT_RESTORE_ARCHIVE_EVIDENCE_MISMATCH.
- git diff --check passed. No new committed tests, broad test/CI/build/lint
  runs, typecheck, or production SQL mutation were performed.

## Coordinator rollout gate

The coordinator must review the exact one-migration allowlist and independently
run production dry-run/dependency checks before any apply. If accepted, apply
only this migration after the sibling migration, then verify migration history,
173 public tables, source absence, 11 canonical rows with unchanged
awaiting_payment payloads and zero checkout references, the nullable typed FK,
its ON DELETE CASCADE action, the scoped constraint/index, and no
payment_pending mutation. Production apply, push, activation, canary, merge,
and deploy remain out of scope for this commit.
