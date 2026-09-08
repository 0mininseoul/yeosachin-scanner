# Supabase B-lite retention selector implementation plan

**Execution status:** Tasks 1–6 completed locally; Task 7 remains prohibited pending separate production approval.

> **Plan only:** Do not execute this plan until the design is approved. Implementation approval does not authorize production apply.

**Goal:** Remove the demonstrated correlated B-lite source rescan while preserving the retention RPC's exact correctness, privilege, batching, and lock-order contracts.

**Architecture:** Keep the scheduler, route, TypeScript RPC caller, function identity, and deletion loop unchanged. A new migration replaces only the function's candidate selector with a source-driven inner join and locks only the parent preflight. Functional behavior is proved in PGlite; real row-lock behavior is proved against an explicitly marked disposable loopback PostgreSQL database.

**Tech stack:** Supabase/PostgreSQL 17, SQL migrations, TypeScript, Vitest, PGlite, optional disposable local PostgreSQL.

---

## Approval gates

- [x] Obtain approval for `docs/superpowers/specs/2026-09-08-supabase-performance-diagnosis-design.md` before creating a migration or changing tests.
- [x] Treat local implementation and production apply as separate approvals.
- [x] Before implementation, fetch/rebase and verify `HEAD`, `origin/main`, and merge base are identical or document the approved new base.
- [x] Reconfirm no other lane owns the same function or planned migration suffix.
- [x] If local/remote migration histories still differ, never use `supabase db push --include-all`; production rollout must use an isolated one-file workdir.

## Task 1: Write the migration contract first

**Files:**

- Create: `lib/services/precheckout/blite-expiry-scan-migration-contract.test.ts`
- Future create: `supabase/migrations/<CLI_TIMESTAMP>_optimize_precheckout_blite_expiry_scan.sql`

- [x] Generate the migration timestamp only after the approval/rebase gate with `supabase migration new optimize_precheckout_blite_expiry_scan`. Do not apply it.
- [x] Add a failing Vitest contract that discovers exactly one migration with that suffix and asserts:
  - predecessor metadata matches the then-current latest migration;
  - transaction-local `lock_timeout = '5s'` and `statement_timeout = '2min'` are present;
  - only `CREATE OR REPLACE FUNCTION public.purge_expired_precheckout_blite_sources_v1` is changed;
  - the selector starts from `precheckout_blite_sources`, joins `analysis_preflights` on `preflight_id = id`, retains expiry/order/limit, and uses `FOR UPDATE OF preflight SKIP LOCKED`;
  - the parent → cache → source lock order, post-lock expiry recheck, cache-before-source delete order, limit validation, security-definer setting, and empty search path remain present;
  - no `CREATE/DROP/ALTER TABLE`, `CREATE/DROP INDEX`, `TRUNCATE`, grant change, payment object, admin object, or scheduler object appears.
- [x] Run `npx vitest run lib/services/precheckout/blite-expiry-scan-migration-contract.test.ts` and record the expected failure because the migration body is absent.

## Task 2: Create the narrow function-replacement migration

**File:** `supabase/migrations/<CLI_TIMESTAMP>_optimize_precheckout_blite_expiry_scan.sql`

- [x] Add predecessor metadata and bounded transaction-local timeouts.
- [x] Copy the currently effective function body into `CREATE OR REPLACE FUNCTION`; change only the candidate query to:

```sql
FOR v_preflight_id IN
    SELECT preflight.id
    FROM public.precheckout_blite_sources AS expired_source
    JOIN public.analysis_preflights AS preflight
      ON preflight.id = expired_source.preflight_id
    WHERE expired_source.expires_at <= pg_catalog.clock_timestamp()
    ORDER BY preflight.id
    LIMIT p_limit
    FOR UPDATE OF preflight SKIP LOCKED
LOOP
```

- [x] Keep the per-row section equivalent to the current body:

```sql
SELECT cache.* INTO v_cache
FROM public.precheckout_blite_cache AS cache
WHERE cache.preflight_id = v_preflight_id
FOR UPDATE;

SELECT source.* INTO v_source
FROM public.precheckout_blite_sources AS source
WHERE source.preflight_id = v_preflight_id
FOR UPDATE;

v_now := pg_catalog.clock_timestamp();
IF NOT FOUND OR v_source.expires_at > v_now THEN
    CONTINUE;
END IF;

DELETE FROM public.precheckout_blite_cache
WHERE preflight_id = v_preflight_id;
DELETE FROM public.precheckout_blite_sources
WHERE preflight_id = v_preflight_id;
v_deleted := v_deleted + 1;
```

- [x] Do not add an index, change the signature/grants/owner, edit the applied 202608 migration, or touch application runtime code.
- [x] Re-run the focused contract and require it to pass.

## Task 3: Prove functional behavior in PGlite

**File:** `lib/services/precheckout/blite-single-collection-pglite.test.ts`

- [x] Load the new optimizer migration after all older relevant B-lite migrations in `createDb()`.
- [x] Preserve the existing tests for expired cleanup, flag-off cleanup, invalid input, cache/source deletion, and claim behavior.
- [x] Extend the existing flag-off purge test with expired and fresh sources so one PGlite database proves:
  - `p_limit = 1` deletes exactly one expired candidate;
  - deterministic UUID ordering selects the expected candidate;
  - a second invocation deletes the next expired candidate;
  - the fresh source and its cache remain;
  - an empty third invocation returns zero.
- [x] Run:

```bash
npx vitest run \
  lib/services/precheckout/blite-expiry-scan-migration-contract.test.ts \
  lib/services/precheckout/blite-single-collection-pglite.test.ts \
  lib/services/analysis/preflight-retention.test.ts
```

- [x] Require all tests to pass before the real-PostgreSQL lock task.

## Task 4: Prove lock ordering and `SKIP LOCKED` on disposable PostgreSQL

**File:** `lib/services/precheckout/blite-postgres-concurrency.integration.test.ts`

- [x] Load the new migration after all older relevant migrations in the guarded local bootstrap.
- [x] Keep the current target guard: only `localhost`/`127.0.0.1`, database `precheckout_blite_concurrency_test`, and the exact destructive-test marker may enable the suite.
- [x] Add a test that seeds two expired sources in UUID order, locks the first parent in a separate transaction, calls purge with limit 1, and proves the second parent is deleted without waiting while the locked first parent remains.
- [x] Preserve and run the existing purge-vs-claim and PII-scrub-vs-terminal cases to detect lock inversion or deadlock.
- [x] Compare function OID, owner, ACL, `SECURITY DEFINER`, and `search_path` before and after the optimizer migration.
- [x] Prove the real static plan scans the source relation once and contains the parent `LockRows` node.
- [x] Run the suite only against a disposable local database using its existing explicit environment guard. Never use linked, staging, or production connection details.
- [x] If disposable PostgreSQL is unavailable, record this as a rollout-blocking verification gap; PGlite alone is not sufficient for approval to apply. The database was available, so no gap remains.

## Task 5: Review and verify the local implementation

**Files:** the four provisional implementation files plus the one explicitly approved release-inventory contract amendment.

- [x] Run `git diff --check`.
- [x] Run the focused Vitest commands from Tasks 3 and 4.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npm run lint`; distinguish pre-existing warnings from new errors.
- [x] Run the repository's full relevant test command if the focused and type/lint gates are green; document unrelated infrastructure failures rather than changing out-of-scope files.
- [x] Inspect the diff for secrets, protected data, admin/identity/infra edits, unintended migration files, scheduler duplication, and any package-lock change.
- [x] Re-run the read-only static plans locally: the selector must scan the source relation once and retain a parent row-lock node/semantics.
- [x] Submit the implementation diff for code review. The bounded final independent spec reviewer returned `PASS`; the staged-diff code-quality review found no remaining issue. No production allowlist was applied.

## Task 6: Prepare, but do not execute, the production rollout packet

**No repository file is changed in this task unless the report/plan is separately updated.**

- [x] Capture pre-rollout read-only deltas for the purge RPC, both relation scan counters, waiting locks, and relevant errors. Do not reset statistics.
- [x] Reconcile the then-current remote/local migration history and record exact fingerprints and divergence.
- [x] Build an isolated temporary Supabase workdir containing the required config plus exactly the approved migration history/allowlist needed by the CLI; ensure the new migration is the sole pending version.
- [x] Run a dry-run and verify the exact one-file allowlist.
- [ ] Present the rollout packet and obtain separate production-apply approval.
- [x] Until that approval, do not run remote DDL/DML, real `db push`, migration repair, or an RPC that mutates rows.

## Task 7: Apply and observe only after separate approval

- [ ] Apply the one allowlisted migration through the approved isolated CLI path.
- [ ] If the CLI appears to hang after apply, query remote migration history first; do not repeat the push.
- [ ] Verify the migration version, function definition hash/shape, owner/grants, and source-driven static plan.
- [ ] Across a comparable scheduled-call window, compare calls and total-execution deltas, relation scan deltas, lock waits, and errors.
- [ ] Declare success only if correctness is intact, the source scan occurs once per selector call, no new lock-wait/deadlock pattern appears, and recent execution deltas are non-regressing.
- [ ] If rollback is required, create and review a new rollback migration restoring the old body; obtain separate approval before applying it.

## Explicit file ownership

This plan's implementation owner is limited to:

1. `supabase/migrations/20260908081711_optimize_precheckout_blite_expiry_scan.sql`;
2. one new migration-contract test;
3. the existing B-lite PGlite lifecycle test;
4. the existing B-lite disposable-PostgreSQL concurrency test.
5. `lib/services/precheckout/blite-single-collection-migration-contract.test.ts`, limited to adding the new CLI-generated basename to its existing release allowlist.

The fifth implementation/test file was added after the full relevant suite proved its existing exact migration inventory deterministically rejected the newly approved migration. The amendment may not remove, weaken, or skip any assertion. No admin console, identity epoch, infrastructure shell, PR #538, order-audit, Apify admin, payment, consolidation, or applied-migration file is owned. Any additional file requires a reviewed plan amendment before edit.

## Affected regression correction record

The first combined verification ran PGlite, lint, and TypeScript concurrently and timed out in two existing PGlite tests. Bounded verbose isolation made those exact tests green in 1.242 s and 0.602 s; a later isolated combined run timed out at a different existing test. Opt-in timing/RSS instrumentation then showed repeated PGlite instances each allocating about 475 MiB external memory and the worker reaching about 1.05 GiB RSS on an already compressed/swapped host. No SQL assertion failed.

The instrumentation was removed. The source-driven definition check and every required multi-row assertion were folded into the existing flag-off purge test, eliminating two redundant database initializations without reducing coverage. The affected set was then run sequentially, with no lint/tsc process in parallel: 29 tests passed in 11.66 s. Disposable PostgreSQL then passed 12/12 tests in 2.12 s.

## GSTACK REVIEW REPORT

### Executive summary

The plan is implementation-ready after design approval. It isolates one measured selector defect, preserves the existing lock protocol explicitly, and separates local implementation permission from production rollout permission. No unresolved critical correctness or data-safety issue remains in the plan itself.

### Architecture and scope review

- **Resolved:** An early direction to optimize the historically dominant scheduler recovery path was rejected because PR #538 is already present, used, and planned by the optimizer.
- **Resolved:** The design does not change scheduler cadence, application APIs, function identity, RLS, grants, admin UI, or identity infrastructure.
- **Resolved:** The change is bounded to one function replacement and three test files; a new index and broad advisor sweep were removed as unsupported scope.
- **Gate:** Any need for a fifth implementation file stops execution and requires an ownership-map amendment.

### Data flow and concurrency review

- **Resolved:** The source-driven join could have inverted locks by locking a source row during selection. `FOR UPDATE OF preflight SKIP LOCKED` limits the selector lock to the parent, preserving parent → cache → source.
- **Resolved:** Post-lock expiry revalidation and cache-before-source deletion remain mandatory, covering the time-of-check/time-of-use window.
- **Resolved:** Real PostgreSQL testing is mandatory because PGlite cannot be the sole authority for row-lock scheduling.
- **Gate:** Production apply is blocked if the locked-parent skip test cannot run or reveals a wait/deadlock regression.

### Performance review

- **Resolved:** The measured 5.2× result applies only to the selector; the plan does not overclaim the full RPC improvement.
- **Resolved:** Long-window `pg_stat_statements` totals are handled with before/after deltas rather than a state-changing reset.
- **Resolved:** An expiry index is deferred because the source relation is tiny/empty and the structural rescan can be removed without write amplification.
- **Gate:** Post-rollout observation must show one source scan per selector invocation and no material recent RPC regression.

### Test and rollout review

- **Resolved:** Tests cover syntax/ownership boundaries, functional batches, expiry/freshness, locked-parent skipping, and the existing claim/terminal races.
- **Resolved:** The migration is created only after approval and rebase, never by editing an applied migration.
- **Resolved:** Mixed migration history is contained by an isolated workdir, exact one-file allowlist, dry-run, and history-first hang handling.
- **Resolved:** Rollback is history-tracked and separately approved, not ad hoc remote DDL.

### Overengineering and operational review

- No new application abstraction, metric pipeline, index, scheduler, feature flag, admin surface, or cleanup mechanism is introduced.
- Advisor findings remain documented backlog evidence rather than being bundled into this fix.
- Independent cross-model review was not run; this report records the completed repository, production-aggregate, query-plan, correctness, concurrency, performance, and rollout self-review.

### Verdict

**PASS FOR DESIGN APPROVAL.** The next permitted action is approval of the selected design. Migration creation, local implementation, and all remote operations remain unexecuted.
