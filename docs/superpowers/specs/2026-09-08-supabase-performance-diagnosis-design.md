# Supabase B-lite retention selector design

**Status:** approved and implemented locally; production apply not approved

**Evidence:** `docs/reports/2026-09-08-supabase-performance-diagnosis.md`

## Problem

The five-minute preflight retention cycle always runs `purge_expired_precheckout_blite_sources_v1`. Its candidate loop starts from every candidate `analysis_preflights` row and evaluates a correlated `EXISTS` against `precheckout_blite_sources`. Production currently has 315 live preflights and no live B-lite sources, so the source relation is tiny but is revisited once per parent candidate.

The desired result is a smaller selector cost without changing the RPC signature, deletion semantics, bounded batch behavior, lock ordering, grants, RLS posture, or scheduler configuration.

## Invariants

The implementation must preserve all of the following:

1. `p_limit` remains required to be between 1 and 1,000 and the function still returns the number of deleted source rows.
2. Only sources expired at the function's database clock may be selected.
3. Candidates remain ordered by preflight UUID and bounded by `p_limit`.
4. Concurrent workers lock only the parent candidate in the selector and use `SKIP LOCKED`.
5. Per candidate, lock order remains parent → cache → source before either delete.
6. The source expiry is rechecked after locks are acquired, so a concurrent change cannot cause a fresh row to be deleted.
7. Cache deletion precedes source deletion.
8. The function remains `SECURITY DEFINER` with `search_path = ''` and keeps its existing identity, owner, and grants.
9. The retention endpoint, schedule, RPC call name, application types, admin console, and identity-epoch code do not change.

## Options considered

### Option A — source-driven join, no new index (recommended)

Select expired sources first, join their parent preflight by primary key, order by the parent ID, and lock only the parent:

```sql
SELECT preflight.id
FROM public.precheckout_blite_sources AS expired_source
JOIN public.analysis_preflights AS preflight
  ON preflight.id = expired_source.preflight_id
WHERE expired_source.expires_at <= pg_catalog.clock_timestamp()
ORDER BY preflight.id
LIMIT p_limit
FOR UPDATE OF preflight SKIP LOCKED
```

Pros:

- Removes the demonstrated correlated source rescan.
- Uses the existing source primary key/parent primary key relationship.
- Adds no write amplification or new schema object.
- Keeps the current RPC and lock protocol.
- Read-only selector measurement was 5.2× faster at the current production cardinality.

Cons:

- The safe production benchmark excluded row locking and the function body.
- A source table that later becomes large could still need an expiry index, but current evidence does not justify one.
- The rewrite must prove `FOR UPDATE OF preflight SKIP LOCKED` behavior on real PostgreSQL, not only PGlite.

### Option B — add an `expires_at` index and keep the correlated selector

Pros:

- Additive and familiar.
- Could help if the source table grows substantially.

Cons:

- The current source table has zero live rows and is 128 KiB; scanning it once is cheaper than maintaining an index for an unproven future shape.
- It does not structurally remove one correlated lookup per parent candidate.
- It adds write and migration cost without a planner proof that the current query will use it.

Decision: reject for now. Reconsider only if post-rewrite observations show source cardinality or scan cost growing.

### Option C — broad advisor/index/RLS sweep

Pros:

- Addresses a larger inventory of theoretical findings.

Cons:

- Mixes unrelated access paths and raises regression/lock risk.
- Zero-scan index counters and FK lints are cumulative, and several objects are newly deployed.
- RLS policy rewrites require authenticated semantic tests, not only catalog lints.
- Scheduler work would duplicate PR #538.

Decision: reject for this lane. Preserve the advisor output as a backlog input for separately scoped, workload-correlated diagnoses.

## Selected design

Migration `20260908081711_optimize_precheckout_blite_expiry_scan.sql` was created after implementation approval and fresh base/ownership verification. It uses `CREATE OR REPLACE FUNCTION` to change only the candidate query shown above. The original applied migration remains immutable.

The selector will specify `FOR UPDATE OF preflight SKIP LOCKED`. The `OF preflight` clause is intentional: joining from `precheckout_blite_sources` must not acquire a source-row lock before the function takes the cache lock, because that would invert the established parent → cache → source order.

Inside the loop, the existing cache lock, source lock, post-lock expiry recheck, delete order, and counter remain equivalent to the effective predecessor. The optimizer migration is loaded after all older relevant B-lite migrations in both functional and real-PostgreSQL tests. No index is created. No TypeScript runtime code changes because the RPC contract is unchanged.

```text
Cloud Scheduler (*/5)
  → retention route
    → runPreflightRetention
      → purge_expired_precheckout_blite_sources_v1(limit=100)
        → scan expired source once
          → join + lock parent candidate, skip locked
            → lock cache
              → lock and recheck source
                → delete cache → delete source
```

## Correctness and concurrency tests

The local test plan must prove:

- invalid limits still fail with the same error contract;
- an empty source table returns zero;
- expired sources are selected and fresh sources are retained;
- `p_limit` bounds deletions and UUID ordering remains deterministic;
- a locked first parent is skipped so another expired parent can be purged without waiting;
- purge-versus-claim and purge-versus-terminal/PII cleanup preserve the existing outcome and do not deadlock;
- anon/authenticated execution privileges remain unchanged;
- the migration contains no table/index/drop/alter/truncate operation and changes only the named function.

The completed local evidence proves those contracts. PGlite passed 29 affected tests sequentially after selector-shape and multi-row batch coverage were consolidated into an existing purge test to avoid two redundant high-memory database initializations. The explicitly marked disposable loopback PostgreSQL suite passed 12 tests, including a locked-first-parent skip case, existing lock-inversion races, a one-source-scan/`LockRows` static plan, and direct before/after equality of function OID, owner, and ACL. The final test diff contains no diagnostic RSS instrumentation.

PGlite covers functional selection/deletion semantics. The existing explicitly guarded loopback PostgreSQL integration suite covers actual row-lock and `SKIP LOCKED` semantics. Tests must never point at a linked or production database.

## Measurement and rollout

Because `pg_stat_statements` has a long cumulative window and resetting it would mutate operational state, verification uses snapshots and deltas rather than a reset:

1. Before rollout, record the RPC calls/total/mean/max and relation scan counters.
2. Obtain separate production-apply approval.
3. Apply only the one allowlisted migration from an isolated temporary workdir after a dry-run.
4. Verify remote migration history before retrying or stopping any apparently hung CLI process.
5. Confirm the function definition, grants, and a static source-driven plan.
6. Over a comparable scheduled-call window, compare call and execution-time deltas, relation scan deltas, errors, and waiting locks.

Success means the source scan occurs once per selector invocation, correctness/concurrency suites remain green, no new waiting-lock pattern appears, and the recent RPC delta improves or at minimum does not regress materially. The report must distinguish selector improvement from full RPC duration.

Tasks 1–6 reached the pre-apply evidence gate: the isolated workdir contains the exact remote version history plus only the new migration, dry-run lists exactly that one pending file, and post-dry-run history proves it remains unapplied. This is rollout preparation evidence only; step 2 and every production mutation remain pending separate approval.

## Rollback

Rollback is a separate, history-tracked migration that restores the exact prior function body under bounded local lock and statement timeouts. Do not delete a migration, edit production history, or run ad hoc remote DDL. A rollback apply requires the same separate approval, isolated workdir, exact allowlist, dry-run, and history verification.

## Ownership map

### Implemented ownership

| File | Action | Purpose |
| --- | --- | --- |
| `supabase/migrations/20260908081711_optimize_precheckout_blite_expiry_scan.sql` | create | Replace only the purge function selector; timestamp chosen after rebase |
| `lib/services/precheckout/blite-expiry-scan-migration-contract.test.ts` | create | Enforce migration shape, invariants, and absence of unrelated DDL |
| `lib/services/precheckout/blite-single-collection-pglite.test.ts` | modify | Load the new migration and extend bounded functional purge coverage |
| `lib/services/precheckout/blite-postgres-concurrency.integration.test.ts` | modify | Load the new migration and prove locked-parent skip/deadlock behavior |
| `lib/services/precheckout/blite-single-collection-migration-contract.test.ts` | modify | Register the new basename in the existing exact release inventory |

No application runtime file changed. Together with the three existing report/spec/plan documents, these are the complete eight-file ownership boundary. The inventory-test amendment is limited to one basename and does not weaken any existing assertion.

### Explicitly unowned

- `app/admin/**`, `app/api/admin/**`, admin UI/styles, and existing order-audit/Apify admin contracts/docs
- `scripts/capacity-identity-epoch*`, identity-epoch implementation/tests, and infrastructure shell files
- PR #538's scheduler index migration and contract tests
- existing applied migrations, payment/pending state, consolidation objects, and the protected reconcile migration
- `/Users/youngminpark/Desktop/개발/개발/yeosachin_scanner`
