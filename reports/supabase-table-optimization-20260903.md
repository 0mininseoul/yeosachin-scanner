# Supabase table/index optimization report

## Decision

One evidence-backed, additive index is prepared for coordinator-only rollout:

`20260904100000_analysis_v2_scheduler_recovery_index.sql`

No production migration was applied by this worker. No payment, user, analysis, queue, provider, AI, scraper, or canary state was read or changed beyond aggregate catalog/statistics diagnostics.

## Evidence integrity and identity

All production database evidence in this report was re-run through the official Supabase Management API HTTPS database-query endpoint with `read_only: true`. A harmless scalar probe returned HTTP 201 with the expected sentinel, so `tlsPeerVerified=true`; no direct pooler evidence obtained before the TLS correction is included or used.

The canonical project URL and its API project reference matched in memory, and the exact approved recent migration sentinels were present:

`20260902090000`, `20260902091000`, `20260902091001`, `20260902100000`, `20260903020000`, `20260904000000`

The remote and local migration file counts were both 366. There were six local-only and six remote-only historical versions; this six-versus-six divergence is pre-existing and outside this scope, and was neither approved, repaired, deleted, nor replayed.

## Sanitized diagnostic snapshot

The following values are aggregate-only and came from HTTP 201 read-only Management API queries with `tlsPeerVerified=true`.

- PostgreSQL counters: 4,987,080 commits, 54,937 rollbacks, 9 deadlocks, 133,145 temp files, and 622,618,906,782 temporary bytes.
- Activity: 20 backend entries, including 12 client backends (1 active and 11 idle) and 8 internal workers. The idle/internal event waits were normal event waits; there were no lock-waiting sessions.
- Locks: 7 total, all 7 granted, 0 waiting; 5 were relation locks.
- Connection settings: `max_connections=60`, `superuser_reserved_connections=3`, `statement_timeout=120000ms`, `lock_timeout=0`, `idle_in_transaction_session_timeout=0`, and activity query size 1024 bytes.
- Tables: 168 tables, 78,831,616 bytes total, 72,942 live tuples, and 3,224 dead tuples. 112 tables had no recorded autovacuum and 93 had no recorded autoanalyze; the high dead-tuple ratios were confined to small staging/lease tables and do not justify a rewrite or `VACUUM FULL`.
- Indexes: 435 total; 26 non-unique indexes had no recorded scans, totaling 548,864 bytes. Seven duplicate-definition groups were found. Dropping unused or duplicate indexes is explicitly deferred because there is no safe, workload-correlated removal evidence in this change.
- Foreign keys: 247 total, 203 covered by a leading matching index and 44 without one. The performance advisor flagged 50 unindexed foreign keys, including scheduler and preflight relationships; only the scheduler recovery path has sufficient measured evidence for this PR, so the remaining foreign-key candidates are deferred.
- RLS: all 168 tables had RLS enabled, 127 were forced, 20 policies were visible to the diagnostic role, and 153 tables had no policy. The no-policy tables are treated as service-only until separately reviewed; no RLS policy is changed here.

Notable sequential-scan aggregates included `analysis_v2_scheduler_operations` at 32,340 scans and 72,323,586 tuples read, `analysis_preflight_failures` at 4,837 scans and 16,216,304 tuples read, and `analysis_anonymous_preflight_attempts` at 5,807 scans and 13,237,557 tuples read. Existing scheduler indexes consisted of the primary key only; the recovery-shaped partial index was absent.

## Query evidence and error pattern

`pg_stat_statements` returned 4,850 aggregate rows. Normalized fingerprints were retained instead of query text or literals.

| Operation label | Fingerprint | Calls | Total execution ms | Mean ms | Max ms | Rows |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Scheduler recovery | `sha256:0740dcd102f89fe1` | 32,318 | 1,031,849.783 | 31.928 | 2,736.258 | 32,318 |
| Scheduler lease reaping | `sha256:aa61a6581d7178cb` | 32,317 | 66,096.555 | 2.045 | 240.017 | aggregate retained only |
| Scheduler operation claim | `sha256:af84899692aa7bf1` | 16,202 | 364,824.195 | 22.517 | 6,017.077 | aggregate retained only |

Across the ranked views, the highest-call fingerprint was `sha256:093ace110cd463a2` with 1,062,647 calls and 0.112ms mean; the highest-row fingerprint was `sha256:718af1ee20405500` with 827,442 rows and 582.287ms mean; and the highest-mean fingerprint was `sha256:7769e8e2f5047b6a` with 7,872.494ms mean across 2 calls. These ranked fingerprints include catalog/session work and are not independently actionable without a stable application label.

A static read-only plan for the scheduler recovery predicate showed `Seq Scan` on `analysis_v2_scheduler_operations`, followed by `Sort` and `Limit`; the estimated sequential scan cost was 584.05 and the sorted plan cost was 586.32. The scheduler status aggregate was 117 claimed rows, 3,238 ready rows, and 68 terminal-unavailable rows; all rows in the due-count view were due, with no future recovery deadlines.

The six-hour sanitized log aggregate contained PostgreSQL SQLSTATE counts: `25P02` 19, `42P01` 10, `42501` 8, and `42883` 1, with no edge error entries. Attribution is limited because the safe redacted log view omits request text, and some `42P01`/`42501` entries were generated by this worker's intentionally invalid diagnostic probes, including the read-only RPC-plan attempt; those entries are excluded from the migration rationale. The RPC EXPLAIN request returned HTTP 400 under the read-only API role, no RPC was executed, and no mutation occurred.

## Migration rationale

The recovery fingerprint is the dominant measured scheduler path, and its table scan volume plus the static plan directly match a partial ordered index on claimed rows. The prepared migration creates:

- a partial predicate for `status = 'claimed'`;
- key order `recovery_deadline_at, request_id, operation_key`, matching the recovery filter and ordering;
- transaction-compatible `CREATE INDEX IF NOT EXISTS`, with no row or schema rewrite.

Expected impact is removal of the repeated full-table scan and sort for the recovery path, subject to planner choice and cache state. The exact post-rollout impact must be measured; the baseline is 32,318 calls, 1,031,849.783 total execution milliseconds, and the sequential-scan/Sort plan above.

### Lock, timeout, and rollout contract

The exact CLI push path applies each migration file in one transaction, so this migration intentionally uses transaction-compatible `CREATE INDEX IF NOT EXISTS` rather than `CREATE INDEX CONCURRENTLY`. It sets an exact transaction-local `lock_timeout` of 5 seconds and an exact transaction-local `statement_timeout` of 2 minutes; the current observed database defaults were `statement_timeout=120000ms` and `lock_timeout=0`, but the migration's explicit values govern its build transaction.

Regular `CREATE INDEX` takes a `SHARE` table lock: ordinary reads can continue, while concurrent writes wait during the build, and a pre-existing conflicting transaction can make the build wait. The 5-second lock timeout fails closed before waiting too long, and the 2-minute statement timeout rolls the transaction back if the build exceeds its bound. The table is approximately 5.0 MiB with 3,423 live rows in the observed snapshot, so the build is expected to be short and the bounded lock exposure is justified by verified size, but the write pause remains the primary rollout risk. No remote apply, dry-run, or deploy was performed by this worker.

### Allowlist and rollback

The exact production allowlist contains only `20260904100000_analysis_v2_scheduler_recovery_index.sql`, after predecessor `20260904000000`. The coordinator should apply it from an isolated one-file work directory through the normal Supabase CLI push path, with a dry-run first and remote migration-history verification afterward; the migration is deliberately compatible with that path's transaction wrapper.

If verification fails or the index is not used, the coordinator-only rollback should be a separate, history-tracked follow-up migration containing transaction-compatible `DROP INDEX IF EXISTS public.analysis_v2_scheduler_operations_recovery_idx` under the same 5-second lock and 2-minute statement bounds; this worker will not execute it ad hoc. Rollback verification should confirm the index is absent and capture a fresh recovery plan and aggregate fingerprint delta.

## Verification and regression plan

Before/after checks should confirm the exact migration version, a valid and ready index with the claimed predicate and key order, and a recovery plan using an ordered partial-index path without the prior full scan/sort when the planner selects it. Compare the recovery fingerprint's calls, mean/total execution time, scan counters, and error counts over a comparable window; monitor lock waits and write latency during rollout. The added Vitest migration contract checks the version/predecessor, one-file statement shape, exact predicate/key order, transaction-compatible DDL, bounded local timeouts, and absence of destructive/provider/payment/user operations.

Local verification completed as follows:

- Focused migration contract: 2 tests passed.
- Ephemeral local PostgreSQL-compatible transactional execution: migration applied inside a transaction and the expected index was present afterward.
- Typecheck: `npx tsc --noEmit` passed with exit 0.
- Lint: exit 0 with 16 pre-existing warnings and no errors.
- `git diff --check`: passed for tracked changes; the intended untracked files were also reviewed before staging.
- Full `npm test`: 753 files passed, 2 skipped, and 1 infrastructure file failed with 65 `spawnSync bash/git ENOENT` failures in the pre-existing automatic-analysis infrastructure harness; 7,832 tests passed, 77 skipped, and 65 failed for that environment/tooling reason. The focused migration contract remains green.
- `npm audit`: one pre-existing moderate `@humanfs/node` advisory was reported; `package-lock.json` was user-owned and left unchanged, and no audit fix was run.

## Source guidance

The implementation follows the current Supabase Query Optimization, Managing Indexes, Database Advisors, Database debugging/inspection, Connect to Postgres, Logging, Advanced log filtering, and Management API database/logs documentation, plus the current Supabase changelog. The repository's current Supabase operations guidance and the installed CLI's `db push` contract confirm one implicit transaction per migration file; this is why the final DDL is transaction-compatible rather than concurrent. The Supabase Postgres best-practices guidance used here covers evidence-backed missing/composite/partial indexes, foreign-key indexing, `pg_stat_statements`, vacuum/analyze monitoring, short lock waits, connection limits, and RLS predicate performance.

PR and CI details will be appended after local verification and the separate PR is created; no merge or deployment is part of this worker's scope.
