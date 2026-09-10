# Supabase 22 account-deletion contraction wave

## Outcome

Prepare a reversible, report-only first wave for `public.account_deletion_jobs`.
The reviewed destination is the existing `public.maintenance_jobs` row, while
`public.account_lifecycle` remains the append-only phase evidence stream. The
legacy table remains authoritative and no reader, admission flag, canary, or
destructive operation is enabled by this wave.

## Production evidence captured 2026-09-10

The linked Supabase CLI was used read-only. The exact source row count is 12:
8 `completed` rows and 4 `requested` rows. `account_lifecycle` and
`maintenance_jobs` are both empty. The source has seven columns, one
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
2. Add a typed wave-specific adapter and a disabled-by-default maintenance write
   hook after each successful legacy deletion transition. Mirror failure is
   bounded and reportable; it cannot turn into a destructive fallback.
3. Add pure projection/parity helpers and a bounded report-only backfill
   harness. It accepts at most 100 source rows, returns counts/checksums and
   sanitized mismatch fields only, and has no apply/drop/truncate/delete/
   mutate option.
4. Add an archive/restore manifest and evidence report with source and
   canonical hashes, exact proposed object names, empty destructive allowlist,
   and every unavailable gate recorded as blocked. No production archive,
   restore, backfill, migration push, or canary is run.

## Gates left blocked

Archive encryption and isolated restore, complete per-row parity, a closed
observation window, dependency/traffic zero proof, owner approval, migration
history after apply, and separate approval to contract the legacy table remain
required. `payment_pending` is not inspected or mutated by this wave. The
destructive allowlist remains empty; any future proposal must contain only the
exact object names and allowlist hash and stop for owner approval.

## Verification

Run the focused TDD contracts first, then the repository TypeScript, lint,
secret scan, and diff review. The final handoff must state the commit SHA,
remaining gates, and explicit confirmation that production was unchanged.
