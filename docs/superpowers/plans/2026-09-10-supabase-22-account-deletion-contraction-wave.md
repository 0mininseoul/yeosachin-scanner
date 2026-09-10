# Supabase 22 account-deletion contraction wave

## Outcome

Prepare a reversible, report-only first wave for `public.account_deletion_jobs`.
The reviewed destination is the existing `public.maintenance_jobs` row, while
`public.account_lifecycle` remains the append-only phase evidence stream. The
legacy table remains authoritative and no reader, admission flag, canary, or
destructive operation is enabled by this wave.

## Production evidence captured 2026-09-10

The final main commit `fad5bc7ce7a0f02a970d7f7a6a9453e74e928c78` had
successful main CI run `34441721804` and a successful Vercel production
deployment. The selected migration
`20260910035257_add_account_deletion_backfill_parity.sql` dry-run listed only
that file; its apply succeeded, local and remote migration history matched, and
a final dry-run returned `upToDate: true`.

Immediately before the backfill, the aggregate public/source/canonical counts
were `187/12/0`. The read-only pre-parity snapshot was `mismatch` with
source/canonical counts `12/0`. One bounded backfill returned
`processed: 12`, `mirrored: 12`, `duplicates: 0`, `blocked: 0`,
`has_more: false`, and `status: parity_required`. The immediate post-parity
snapshot was `match` with source/canonical counts `12/12`, equal checksum
`865d24fc97cb5d8816b7d5a17eb0fc78e3f31d9395d7055e8545aacd39ec4b6f`, and
`mismatch_fields: []`. Source states remained `completed: 8` and `requested: 4`;
canonical states were `succeeded: 8` and `queued: 4`; the public table count
stayed `187`.

Both RPCs are `SECURITY DEFINER` with an empty `search_path`; `service_role`
execute is true and `anon`/`authenticated` execute is false. The backfill RPC
has `statement_timeout = '2min'` and `lock_timeout = '5s'`; the parity RPC has
`statement_timeout = '2min'`.

This is a parity snapshot only. The source remains authoritative and active,
and four requested jobs remain. Account-deletion-specific continuous
mirror/cutover, observation, archive/restore, dependency/traffic-zero,
rollback, and exact approval remain blocked. The destructive allowlist remains
empty; no DROP, source mutation, global flag, admission, canary, or
`payment_pending` action occurred.
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
   The selected migration was applied under the exact single-file allowlist;
   the bounded production result processed 12 rows, mirrored 12, reported no
   duplicates or blocked rows, returned `has_more = false`, and required parity.
   The backfill boundary has no drop/truncate/delete/rename option.
4. Add a production-usable read-only SQL parity collector. It aggregates source
   and canonical counts/checksums and sanitized mismatch field names inside the
   database; no account UUID is returned. The immediate post-backfill result
   was a matching `12/12` snapshot with the checksum and empty mismatch list
   recorded above. The collector is a final parity snapshot only: it does not
   establish source quiescence or replace an account-deletion-specific
   continuous mirror/cutover before retirement.
5. Add an archive/restore manifest and evidence report with source and
   canonical hashes, exact proposed object names, empty destructive allowlist,
   and every unavailable gate recorded as blocked. No production archive or
   restore, flag change, admission activation, or canary is run.

## Gates left blocked

The matching result is an aggregate parity snapshot only; complete per-row or
canonical-read proof and source quiescence remain unproven. Archive encryption
and isolated restore, an account-deletion-specific continuous mirror/cutover,
a closed observation window, dependency/traffic-zero proof, rollback evidence,
exact owner approval, and separate approval to contract the legacy table remain
blocked. `payment_pending` is not inspected or mutated by this wave. The
source remains authoritative and active with four requested jobs remaining.
The destructive allowlist remains empty; any future proposal must contain only
the exact object names and allowlist hash and stop for owner approval.

## Verification

Run the focused TDD contracts first, then the repository TypeScript, lint,
secret scan, and diff review. The final handoff must state the final main SHA,
successful CI/deployment evidence, selected migration apply and history/dry-run
evidence, parity snapshot, remaining blocked gates, and the empty destructive
allowlist.
