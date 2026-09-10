# Supabase 22 account-deletion contraction wave

## Outcome

Prepare a reversible, report-only first wave for `public.account_deletion_jobs`.
The reviewed destination is the existing `public.maintenance_jobs` row, while
`public.account_lifecycle` remains the append-only phase evidence stream. The
legacy table remains authoritative and no reader, admission flag, canary, or
destructive operation is enabled by this wave.

## Production evidence captured 2026-09-10

Migration `20260910020205_prepare_account_deletion_canonical_wave.sql` was
merged, deployed, applied, and remotely verified. Immediately after that apply,
the production public table count remained `187`, the legacy source exact count
was `12`, and canonical `purge` rows were `0`. Migration
`20260910035257_add_account_deletion_backfill_parity.sql` remains proposed and
not applied; no production backfill or parity call has occurred. The source has
seven columns, one
`account_id` foreign key with `ON DELETE RESTRICT`, two state checks, no
user-defined trigger, FORCE RLS with no policies, and service-role table ACL.
The canonical tables have the reviewed 7-column lifecycle and 16-column
maintenance shapes; lifecycle has one immutable trigger and maintenance has
the existing `purge` kind, state, lease, hash, payload, and uniqueness checks.
The exact source routines are `begin_account_deletion_v1(uuid)`,
`finalize_account_deletion_database_v1(uuid,jsonb)`, and
`complete_account_deletion_v1(uuid)`. Canonical routines are service-RPC
boundaries; no runtime file directly references the legacy table, while the
account-deletion service calls those three routines.
The full sanitized evidence and archive/restore manifest are recorded in
`docs/reports/2026-09-10-supabase-22-account-deletion-wave-evidence.md` and
`docs/reports/2026-09-10-account-deletion-canonical-archive-restore-manifest.json`.

## Additive implementation

1. Add a service-only `mirror_account_deletion_job_v1(uuid)` RPC. It reads the
   source row, derives a domain-separated canonical target hash, stores only a sanitized
   state/timestamp projection in one `maintenance_jobs` `purge` row, and keeps
   the source table authoritative. It never stores the account UUID in the
   maintenance payload.
2. Retain the existing typed runtime mirror adapter and add a disabled-by-default
   maintenance write hook after each successful legacy deletion transition.
   Mirror failure is bounded and reportable; it cannot turn into a destructive
   fallback. Backfill and parity remain SQL service routines for controlled
   operator invocation through the linked CLI, not TypeScript adapter methods.
3. Add pure projection/parity helpers and a separate forward-only SQL backfill
   boundary. It accepts at most 100 source rows per call, invokes the existing
   service-only mirror routine inside the database, uses an opaque hash cursor,
   and returns only nonterminal `progressed`, `parity_required`, or `blocked`
   statuses. `has_more = false` always returns `parity_required`, requiring a
   separate `collect_account_deletion_parity_v1()` call. If that parity snapshot
   mismatches, the operator contract restarts the backfill from a `NULL` cursor.
   The backfill boundary has no drop/truncate/delete/rename option; migration
   `20260910035257` remains proposed and not applied in this wave.
4. Add a production-usable read-only SQL parity collector. It aggregates source
   and canonical counts/checksums and sanitized mismatch field names inside the
   database; no account UUID is returned. The collector is a final parity
   snapshot only: it does not establish source quiescence or replace an
   account-deletion-specific continuous mirror/cutover before retirement. It is
   proposed and not called against production in this wave.
5. Add an archive/restore manifest and evidence report with source and
   canonical hashes, exact proposed object names, empty destructive allowlist,
   and every unavailable gate recorded as blocked. No production archive,
   restore, `20260910035257` migration apply, backfill, or canary is run.

## Gates left blocked

Archive encryption and isolated restore, complete per-row parity, source
quiescence, an account-deletion-specific continuous mirror/cutover, a closed
observation window, dependency/traffic zero proof, owner approval, migration
history after the applied migration, and separate approval to contract the
legacy table remain required. `payment_pending` is not inspected or mutated by
this wave. The destructive allowlist remains empty; any future proposal must
contain only the exact object names and allowlist hash and stop for owner
approval.

## Verification

Run the focused TDD contracts first, then the repository TypeScript, lint,
secret scan, and diff review. The final handoff must state the commit SHA,
remaining gates, and distinguish the remotely verified `20260910020205` apply
from the unapplied `20260910035257` proposal and the absent production
backfill/parity calls.
