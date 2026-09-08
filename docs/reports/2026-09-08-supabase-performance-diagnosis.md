# Supabase performance diagnosis kickoff report

**Snapshot date:** 2026-09-08 KST

**Status:** Tasks 1–6 complete locally; production apply/activation is not approved

**Branch:** `supabase-performance-diagnosis-20260908`

## Decision

The approved local follow-up is complete. Migration `20260908081711_optimize_precheckout_blite_expiry_scan.sql` replaces only the candidate selection inside `purge_expired_precheckout_blite_sources_v1` so it starts from the expiring source table and joins its parent preflight. No expiry index, broad advisor cleanup, or scheduler recovery change was added.

The existing scheduler recovery index from PR #538 is present in production, has recorded 5,089 scans, and is selected by the current static plan. Recreating or repackaging that work would duplicate a merged optimization.

The migration was created locally with the installed Supabase CLI and was not applied. No remote DDL or DML ran. The Supabase MCP was not used. Kickoff evidence used the official read-only endpoints described below; the implementation gate refreshed migration history and database aggregates through the approved CLI/loopback-safe database path and ran only `db push --dry-run --skip-vault` for rollout validation.

## Baseline and evidence identity

Orca setup had removed exactly `"devOptional": true` from the Rollup 4.62.2 entry in `package-lock.json`. That one incidental diff was inspected and restored with `apply_patch` before the baseline was established. It is not part of this work.

After a fresh `git fetch origin main --prune`:

- `HEAD`: `02e89f496c2dabaf4ef6a9c2251928006a5b17bc`
- `origin/main`: `02e89f496c2dabaf4ef6a9c2251928006a5b17bc`
- merge base: `02e89f496c2dabaf4ef6a9c2251928006a5b17bc`
- kickoff status: clean
- GitHub checks on the commit: four check runs succeeded and the aggregate commit status was successful

This worktree has neither `.env.local` nor linked-project metadata. The AGENTS.md canonical `.worktrees/final-main-20260725` path was not present or registered. For read-only identity only, the registered main worktree at `/Users/youngminpark/Desktop/개발/yeosachin_scanner` supplied `.env.local` and `supabase/.temp/project-ref`; that worktree was not modified. In a one-shot process, the configured Supabase URL prefix matched the linked project reference, the official project-list endpoint returned exactly one match, and that project was `ACTIVE_HEALTHY`. Credentials, authorization headers, project references, user identifiers, and row payloads were never printed or persisted.

The linked CLI path could not be used safely: the current worktree was unlinked, the registered main `.env.local` was not CLI-parseable as a workdir, direct `--project-ref` inspection hit the local network's IPv6 limitation, and the active Keychain CLI account did not enumerate the linked project. The Management API identity cross-check above was therefore the only verified read-only path.

## Fresh aggregate snapshot

The current production database reports PostgreSQL 17.6 with `pg_stat_statements` enabled and `pgstattuple` unavailable.

| Area | Fresh aggregate evidence | Interpretation |
| --- | --- | --- |
| Public schema | 174 tables, 79,650,816 bytes, 73,223 estimated live tuples, 3,311 dead tuples | Small database; no evidence for a rewrite or `VACUUM FULL` |
| Public indexes | 455 indexes, 27,549,696 bytes; 30 zero-scan non-unique indexes totaling 557,056 bytes; 0 exact semantic duplicate groups | The unused candidates are collectively small; no drop is justified from cumulative counters alone |
| Foreign keys | 252 total; 202 have a leading matching index and 50 do not | Matches the advisor, but workload correlation is still required |
| RLS | all 174 public tables enabled; 133 forced; 20 visible policies | Policy tuning must be evaluated per authenticated path, not as a blanket rewrite |
| Database counters | 5,398,048 commits, 55,101 rollbacks, 9 deadlocks, 146,564 temp files, 696,739,313,897 temp bytes | Cumulative and not a recent-window latency attribution |
| Buffer counters | 988,987,010 blocks hit and 4,343 read | Approximately 99.9996% hit ratio; storage reads are not the demonstrated bottleneck |
| Activity/locks | 6 idle clients, 1 active client, 8 internal workers; 2 granted locks and 0 waiting locks | No lock-pressure incident at capture time |
| Maintenance history | 118 tables had no recorded autovacuum; 97 had no recorded autoanalyze | Mostly tiny/new tables; monitor rather than force maintenance |
| Six-hour PostgreSQL error logs | SQLSTATE `42P01`: 4; `42501`: 2 | No broad error storm; aggregate codes alone cannot attribute an application path |

`pg_stat_statements` held 4,877 entries, close to the configured 5,000-entry view, with 55 deallocations. Its reset timestamp was 2026-07-10, so totals describe a long cumulative window. The report uses call deltas and current plans where possible and does not describe every high total as a current regression. Supabase likewise documents this view as the latest 5,000 normalized statements and recommends interpreting calls, mean, maximum, and plans together ([Inspect](https://supabase.com/docs/guides/observability/inspect), [PostgreSQL pg_stat_statements](https://www.postgresql.org/docs/17/pgstatstatements.html)).

The six-hour log read grouped only error-level PostgreSQL events by SQLSTATE; it did not select timestamps, roles, query text, messages, request paths, or payloads. The four undefined-relation and two permission events cannot be safely attributed from codes alone, and diagnostic permission probes may contribute, so they are excluded from the optimization rationale. This follows Supabase's current unified ClickHouse logs contract and its guidance to select only required fields from one source ([Get project logs](https://supabase.com/docs/reference/api/v1-get-project-logs), [Query and filter logs](https://supabase.com/docs/guides/observability/advanced-log-filtering)).

## Table and access-pattern map

A syntax-level inventory across 1,283 TypeScript/JavaScript source files found 122 distinct literal RPC names and 51 literal `.from(...)` candidates before manual semantic filtering. The dominant direct-table surface is `analysis_requests` (63 calls across 25 files), followed by `analysis_results` (18/13) and `earlybird_orders` (18/13). These paths mix owner-scoped reads, primary-key predicates, status reads, ordered result reads, and service-role writes. A few legacy analysis routes request `analysis_requests` with `users(email)` nested selection; their fingerprints were not among the newly demonstrated bottlenecks.

The diagnosis candidate and scheduler recovery are different: both are accessed through security-definer RPCs rather than direct application table chains.

| Path | Static predicate/join/ordering | Runtime access | Current evidence |
| --- | --- | --- | --- |
| Scheduler recovery | `status = 'claimed'`, due recovery deadline, ordered by deadline/request/operation | maintenance RPC | Existing partial index exactly matches; current plan is an index-only scan without the former sort |
| B-lite source retention | scans parent preflights, correlated `EXISTS` on source `preflight_id` plus `expires_at <= clock_timestamp()`, ordered by parent ID, `FOR UPDATE SKIP LOCKED` | retention RPC first in every cycle | Current plan rescans the tiny source relation once per candidate parent |
| Preflight failure ledger | nullable `preflight_id` FK; application path is a server-side insert | direct service-role table write | High cumulative tuples read, but no slow current query was safely attributed |
| Anonymous preflight attempts | preflight lineage and rate-limit workflow | principally RPC-owned | High cumulative scan volume, but no specific fresh plan justified a schema change |
| Analysis request/result | request ID, user ownership, status, request-ranked results, occasional `users(email)` relationship select | authenticated reads plus service-role pipeline writes | High call surface, but not the leading fresh maintenance regression |

The service role client is server-only and uses the service-role key, while browser/server-session clients use the anonymous key plus user session. This matters for the advisor's RLS findings: service-role maintenance does not pay the same policy path as authenticated owner reads, so the B-lite retention finding is not caused by `auth.uid()` initialization.

## Ranked findings

### 1. Active correlated scan in B-lite retention — actionable after approval

`runPreflightRetention` calls `purge_expired_precheckout_blite_sources_v1` first and unconditionally because source evidence has the shortest TTL. The Cloud Scheduler contract invokes the retention endpoint every five minutes. Inside the function, the candidate loop starts from `analysis_preflights` and runs a correlated source lookup for each candidate parent before locking the selected preflight.

Production relation statistics at capture time were:

- `analysis_preflights`: 315 live, 61 dead, 62,804 sequential scans, 10,698,012 sequential tuples read
- `precheckout_blite_sources`: 0 live, 50 dead, 1,511,243 sequential scans, only 412 sequential tuples read

The second pattern is the signature of a tiny relation repeatedly rescanned, not a large table needing an index. The cumulative RPC fingerprint had 7,400 calls and 578,425.112 ms total at one snapshot. Two later scheduled calls raised it to 7,402 calls and 578,531.220 ms, a fresh delta of 106.108 ms or 53.054 ms/call. This separates an active path from merely historical totals.

A read-only static plan of the current candidate query had estimated total cost 416.50 and a correlated source sequential scan beneath an index-only traversal of candidate preflights. A source-driven equivalent had estimated total cost 4.52. Seven read-only `EXPLAIN ANALYZE` repetitions with the locking clause removed for safety produced:

| Selector | Median | Min–max | Source scan loops |
| --- | ---: | ---: | ---: |
| Current correlated selector | 0.749 ms | 0.739–3.387 ms | 315 |
| Source-driven join | 0.143 ms | 0.130–0.181 ms | 1 |

That is a 5.2× median selector improvement under the current empty/tiny-source shape. It does **not** explain the entire 46–253 ms recent RPC durations, because the safe production test excluded `FOR UPDATE` and did not execute the function. The plan therefore preserves a measurement gate and makes no claim that the selector rewrite alone eliminates all RPC latency.

### 2. PR #538 scheduler index — verified complete, no work

The production index `analysis_v2_scheduler_operations_recovery_idx` has the expected keys and `status = 'claimed'` predicate. It recorded 5,089 scans and 595,413 tuples read/fetched. The fresh static recovery plan is an index-only scan with total estimated cost 16.16 and no sort. The long-window recovery fingerprint remains cumulatively dominant at 37,598 calls and 1,106,312.783 ms, but that total spans the pre-index period. This lane will not duplicate PR #538 or edit its migration/test.

### 3. Advisor findings — real candidates, insufficient causal evidence

The official performance advisor returned 97 deterministic findings:

- 50 unindexed foreign keys
- 30 unused indexes
- 15 `auth_rls_initplan` warnings
- 2 multiple-permissive-policy warnings

The RLS warnings cover owner-facing tables including `users`, `analysis_requests`, `analysis_results`, `comment_details`, `interaction_logs`, `private_accounts`, `pending_analysis`, `ai_analysis_cache`, usage ledgers, and four policies on `analysis_preflights`. The initial schema contains direct `auth.uid()` policy calls, while newer policies commonly use `(SELECT auth.uid())`. These are credible authenticated-query candidates, but the current statement evidence did not attribute a leading recent latency path to them. The multiple-policy warnings are confined to `analysis_preflights` commands and need a separate policy-semantics audit before consolidation.

Supabase describes advisors as deterministic lint findings rather than automatic fixes and recommends confirming them against workload evidence ([Database Advisors](https://supabase.com/docs/guides/observability/advisors?lint=0015_rls_references_user_metadata), [Performance advisors API](https://supabase.com/docs/reference/api/v1-get-performance-advisors)). No advisor-driven index, index drop, or RLS rewrite is approved by this report.

### 4. No current lock, cache, bloat, or consolidation trigger

There were no waiting locks, the buffer hit ratio was effectively complete, and the database is about 76 MiB. `pgstattuple` is unavailable, so physical bloat was not measured; dead-tuple counts and sizes do not justify an intrusive substitute. Consolidation remains blocked by the existing readiness gates: there are no genuine completed audit bundles/parity reports and the contraction allowlist remains empty. No table is owned for consolidation by this lane.

### 5. Migration history remains mixed

Local and remote histories each contain 372 versions, but their sets differ by six local-only and six remote-only historical versions. The latest local and remote version is `20260905110000`, and the scheduler-index and consolidation-readiness sentinels are remote. This pre-existing divergence does not block diagnosis, but it forbids a bulk push. Any later approved migration must use a fresh CLI-generated timestamp after rebasing, an isolated temporary Supabase workdir, a one-file allowlist, dry-run, and remote-history verification.

## Local implementation and verification evidence

The installed Supabase CLI was `2.114.0`. Its `migration`, `migration new`, and `db push` help were inspected before creation. The migration was then generated with the exact command `supabase migration new optimize_precheckout_blite_expiry_scan`; no applied migration was edited.

The implementation preserves the existing signature, `SECURITY DEFINER`, empty `search_path`, limit validation, parent → cache → source lock order, post-lock expiry recheck, and cache-before-source deletion. On disposable PostgreSQL, `CREATE OR REPLACE` preserved the function OID, owner, and ACL exactly across the optimizer migration.

TDD and regression evidence:

- Contract RED: 3/3 tests failed only with `PRECHECKOUT_BLITE_EXPIRY_SCAN_MIGRATION_MISSING` before migration creation. Contract GREEN: 3/3 passed after the narrow body was added.
- PGlite selector RED: the live function still contained the parent-driven correlated selector before the optimizer migration was loaded. After loading the migration after all older relevant B-lite migrations, the selector-shape and bounded functional assertions passed.
- A first combined run under simultaneous PGlite, lint, and TypeScript load timed out in two existing tests. A later isolated run timed out in a different existing test. The originally affected two tests passed bounded verbose isolation in 1.242 s and 0.602 s, proving the assertions and SQL paths were not the failure source.
- Opt-in instrumentation localized the issue to host pressure around repeated PGlite instances: each instance reported about 475 MiB external memory and the worker reached about 1.05 GiB RSS while the host was heavily compressed/swapped. The instrumentation was removed. The new selector-shape and batch assertions were consolidated into the existing flag-off purge test, retaining every required assertion while removing two additional PGlite database initializations.
- Fresh sequential affected GREEN: 3 files, 29 tests, 11.66 s. This includes selector shape, `p_limit = 1`, deterministic UUID ordering, two expired batches, fresh source/cache retention, and a zero-result third invocation.
- Fresh disposable PostgreSQL GREEN: 1 file, 12 tests, 2.12 s against loopback database `precheckout_blite_concurrency_test` with the exact destructive-test marker. It covered locked-parent skip, purge-vs-claim, PII scrub vs complete/fail, function metadata preservation, and the target guard.
- The locked-parent test directly awaits the purge and asserts completion below 1.5 s. Transaction-local 2 s lock and 5 s statement timeouts plus the 30 s test timeout keep the test bounded, while direct await prevents a timed-out `Promise.race` branch from leaving a database query running during client release.
- The real-PostgreSQL static plan contained one `precheckout_blite_sources` relation scan and a `LockRows` node for the parent-locking selector.
- The first full relevant run exposed one deterministic release-inventory RED: the existing contract expected exactly four historical B-lite migration basenames and received the new optimizer as a fifth. After the explicit eighth-file ownership amendment, the sole correction added that basename to the existing array without changing any assertion or filter. The contract passed 11/11, then the complete relevant suite passed 205 tests with 5 guarded skips across 19 files.
- Fresh `tsc --noEmit` passed. Fresh lint completed with 0 errors and the same 17 out-of-scope warnings present on the base.
- The final bounded independent spec reviewer returned `PASS`. The two earlier reviewer attempts were stopped or recorded unavailable rather than allowed to wait indefinitely; a final local staged-diff code-quality review found no remaining issue.

## Production rollout packet — prepared, not applied

The production evidence gate is **VERIFIED FOR A SEPARATE APPLY-APPROVAL DECISION**. This does not authorize or perform Task 7.

- Fresh local/remote history after local migration creation: 373 local versions and 372 remote versions. The local fingerprint is `404605671da7af165bc8f1ac920d9540b55d1d69a54f4a39dae39cc81aca7e90`; the remote fingerprint is `bfd4fbe35f31b318ccbb9105aff2741899b4570604b804a4ae205d9dc6b2cf25`.
- Divergence is seven local-only and six remote-only versions. Removing the new optimizer from that comparison leaves the same pre-existing six-by-six divergence recorded at kickoff. The remote tip remains `20260905110000`.
- The isolated workdir `/tmp/yeosachin-supabase-blite-rollout-20260908.KniY9Q` was initialized by Supabase CLI. It contains 372 empty, version-only remote-history stubs plus the one full optimizer migration; it stores no project reference or credential.
- `supabase db push --dry-run --skip-vault` completed successfully from that workdir. Its exact pending allowlist contained only `20260908081711_optimize_precheckout_blite_expiry_scan.sql`.
- A post-dry-run history read confirmed the same 372-version remote fingerprint and confirmed optimizer version `20260908081711` is absent remotely.
- The pre-rollout aggregate snapshot recorded 7,424 purge-RPC calls and 580,478.642 ms cumulative execution time. Against the earlier 7,402-call snapshot, that is +22 calls and +1,947.422 ms, or 88.519 ms/call over the intervening window.
- Relation counters at the implementation snapshot were: `analysis_preflights` 315 live/61 dead, 62,885 sequential scans, 10,723,527 sequential tuples read; `precheckout_blite_sources` 0 live/50 dead, 1,521,330 sequential scans, 412 sequential tuples read. Against kickoff, source scans increased by 10,087 while source tuples read remained unchanged.
- Waiting locks were zero, blocking rows were zero, and cumulative database deadlocks remained 9, producing a zero deadlock delta from kickoff. The prior aggregate six-hour SQLSTATE counts remain the relevant non-row-level error snapshot; no raw log event was read during implementation.

Task 7 remains prohibited: no remote DDL/DML, real push, migration repair, mutating RPC, deployment, activation, or production canary was executed.

## Recommended next step

Review the completed local diff and rollout packet. If production rollout is desired, provide a separate Task 7 apply approval. The only remaining production action is the one-file apply followed by history/function/plan verification and a comparable scheduled-window observation; merge, deploy, activation, and canary remain separate decisions.

## Scope and ownership

This lane owns exactly these three documents and five implementation/test files:

- `docs/reports/2026-09-08-supabase-performance-diagnosis.md`
- `docs/superpowers/specs/2026-09-08-supabase-performance-diagnosis-design.md`
- `docs/superpowers/plans/2026-09-08-supabase-performance-optimization.md`
- `supabase/migrations/20260908081711_optimize_precheckout_blite_expiry_scan.sql`
- `lib/services/precheckout/blite-expiry-scan-migration-contract.test.ts`
- `lib/services/precheckout/blite-single-collection-pglite.test.ts`
- `lib/services/precheckout/blite-postgres-concurrency.integration.test.ts`
- `lib/services/precheckout/blite-single-collection-migration-contract.test.ts`

It owns no admin-console file, identity-epoch file, infrastructure shell file, existing order-audit/Apify admin contract, existing migration, scheduler object, payment object, or consolidation object.

The eighth-file amendment was approved only because the existing release-inventory contract enumerated every B-lite migration basename and deterministically rejected the new approved migration. Its permitted change is one basename entry; no assertion, filter, or other behavior may be weakened.
