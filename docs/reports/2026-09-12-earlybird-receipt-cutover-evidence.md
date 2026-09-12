# Earlybird receipt cutover implementation evidence

Date: 2026-09-12
Ancestor: `245ef9d5517b791ceb65491ed187e744c56f6ad8`
Implementation commit: `046ae4faf9bb70a6e7abbeb3e2c41fa1a3a2f8ce`
Scope: the approved thirteen-table earlybird receipt cohort only.

This report records bounded local evidence for the repaired SQL. It is not a
production apply record and does not claim production VERIFIED or apply-ready
status.

## Delivered corrections

- C1: the candidate no-caller guard now uses explicit escape strings for the
  function-name backreference and the opening-parenthesis matcher. The scan
  covers all non-system routine schemas while retaining `pg_depend` coverage.
  The existing candidate list, exact signatures, and candidate self-exclusion
  remain unchanged.
- C2: the generated
  `bootstrap_earlybird_v211_concierge_first_order` body now replaces the
  six-table dynamic `to_regclass` / `EXECUTE` recovery loop with six explicit,
  source-labelled archive branches. The replacement is guarded by exact
  before/after counts, checks succeeded state, nullable pending ownership,
  schema version, and typed `order_id`, and a completeness guard rejects any
  retired relation reference or dynamic recovery lookup left in the generated
  body. The existing purge-safety assertion is called at the top of this
  bootstrap before input processing.
- I3: candidate retirement still uses exact `pg_depend` checks and now scans
  non-system routine schemas, including functions and procedures. The scoped
  application/operator call-site and live catalog checks remain a required
  coordinator-owned gate.
- I4: the existing archive purge assertion now fails closed on malformed
  source rows, exact primary-key shape, schema version, content hash, or
  domain-separated target hash. The three generated typed projections enforce
  the same contract, and the existing reviewed-source and publication mutators
  invoke the assertion before selecting or updating a receipt.
- M2: restore now requires both `CURRENT_USER` and `SESSION_USER` to be
  `postgres`, locks `maintenance_jobs` before archive inspection, validates
  the complete thirteen-source manifest, and checks recreated trigger function
  owner, `SECURITY DEFINER`, empty `search_path`, and exact reviewed ACLs. The
  recreated adoption guard receives the explicit original grants; the existing
  shared guard is not privilege-normalized. The concierge trigger body keeps
  the exact original source formatting.
- M1: the existing plan records the reviewed seventeen-column
  `maintenance_jobs` shape, including nullable `legacy_pending_user_id`.

No existing caller was changed. The migration and restore remain the only SQL
artifacts in scope, with the explicitly authorized plan correction.

## Bounded native PostgreSQL 17 execution

All SQL execution below used a fresh worker-owned native PostgreSQL 17.10
cluster over a local Unix socket. The fixture contained synthetic rows only.
There were no remote Supabase calls, Supabase CLI calls, environment or secret
reads, production reads or writes, pushes, merges, deployments, activation,
canary, or payment disposition changes.

The predecessor fixture was built from the local full-schema clone. It started
with 184 public tables, added the nullable pending column and the two reviewed
predecessor history markers, then removed the eight stale predecessor tables
and three unrelated stale tables required to reach the migration's reviewed
173-table baseline. The three exact routine definitions supplied in the
coordinator's disposable evidence file were loaded only into this fixture.
The 21 synthetic source rows were copied from the valid local fixture with
triggers disabled during the copy because that fixture intentionally has no
production parent graph; this is a fixture substitution, not a production
guard bypass.

The actual revised migration command was:

```sh
EB17_SOCKET_DIR="$(cat /tmp/earlybird-cutover-pg17-socket-path)"
psql -X -1 -v ON_ERROR_STOP=1 -U postgres -h "$EB17_SOCKET_DIR" -p 55444 \
  -d eb_candidate_final_pg17_20260912 \
  -f supabase/migrations/20260912074059_retire_earlybird_receipt_archive.sql
```

It completed with `COMMIT`. Sanitized post-checks returned:

- archive integrity, including state, pending ownership, schema version,
  exact `{order_id}` key, content hash, and target hash: `true`;
- archived source rows: `21` with the reviewed per-source distribution
  `2, 1, 1, 1, 1, 7, 1, 1, 2, 1, 1, 1, 1`;
- public tables: `173 -> 160`;
- retired source relations: `0`;
- retired candidate routines: `0`;
- generated bootstrap dynamic-loop and direct retired-source checks: clear;
- generated bootstrap top-level purge assertion: present;
- all five new archive/mutator helpers: function-local `TimeZone=UTC`.

The candidate also preserved the aggregate definitions of the six unrelated
maintenance/payment routines checked against the pre-cutover full-schema
clone. The aggregate fingerprints were equal before and after the migration.
The bounded fixture contained no unrelated pending archive row, so live
pending-archive preservation remains a coordinator-owned production gate.

## Focused C1 and C2 evidence

On native PostgreSQL 17.10 with `standard_conforming_strings = on`, the
original C1 expressions reproduced a literal backreference and malformed
caller regex. The repaired expressions extracted the exact candidate function
name and completed the no-caller path on the actual candidate fixture.

For C2, a rollback-only SQL wrapper extracted the six-branch exclusion block
from the migrated candidate's actual `pg_get_functiondef`, verified exact
single occurrence, and executed that extracted block with synthetic order
variables. Results were:

```text
EARLYBIRD_C2_EXCLUSION_BLOCK_EXTRACTION=exact
EARLYBIRD_C2_ARCHIVED_RECEIPT=blocked
EARLYBIRD_C2_NO_RECEIPT=falls_through
EARLYBIRD_C2_UNRELATED_SOURCE=unchanged_non_membership
```

The unrelated-source line is a negative control showing that a source outside
the six retired recovery labels remains outside this exclusion block. There is
no retained source in the original loop: all six original loop relations are
retired by this cohort, so a retained-source-in-loop case is not applicable.
This focused proof covers the changed exclusion logic only; it is not an
end-to-end bootstrap or fulfillment proof.

## Restore and typed-payload evidence

The exact isolated restore command used a fresh synthetic clone with the
reviewed explicit ACLs on the existing shared guard:

```sh
EB17_SOCKET_DIR="$(cat /tmp/earlybird-cutover-pg17-socket-path)"
psql -X -v ON_ERROR_STOP=1 -U postgres -h "$EB17_SOCKET_DIR" -p 55444 \
  -d eb_restore_m2_exact_pg17_20260912 <<SQL
SET supabase.retirement_isolated = 'true';
\\i $PWD/supabase/operations/20260912_restore_earlybird_receipt_tables.sql
SQL
```

The operation committed successfully. Sanitized post-checks returned:

- `postgres` identity precondition: `true`;
- restored archive rows: `21`;
- restored source tables: `13`;
- restored foreign keys: `55`;
- forced-RLS restored tables: `13`;
- trigger function owner/security-definer/empty-search-path/exact ACL guard:
  `true`;
- concierge-v2 trigger body fingerprint equal to the original reviewed source:
  `true`.

The following rollback/abort checks used fresh synthetic clones and left zero
source tables after transaction rollback:

- replacing the schema-failure cohort content hash with a valid-looking wrong
  hash aborted with `EARLYBIRD_RECEIPT_RESTORE_ARCHIVE_MANIFEST_INVALID` before
  table creation; source-table count was `0`;
- replacing one typed `prior_attempt_count` payload value with a non-numeric
  string while recomputing its content hash aborted with PostgreSQL's typed
  `smallint` cast error; source-table count was `0`;
- running the operation after `SET ROLE anon` aborted at
  `EARLYBIRD_RECEIPT_RESTORE_POSTGRES_REQUIRED` before table creation.

Normal archive writer and mutator behavior was also exercised in rollback-only
transactions. The archive writer inserted exactly one row across two identical
calls. Reviewed-source and publication-marker mutators returned `true` on the
first transition and `false` on the identical retry. Repeating each comparison
with client session timezones `Asia/Seoul` and `UTC` passed after the new
helpers' function-local UTC setting; the transaction was rolled back.

## Review disposition and remaining gates

- C1, C2, and C3: corrected and covered by actual bounded native-PG17
  candidate/restore execution. Root owns integrated typecheck and final review.
- I1 and M3: corrected by lock-first manifest validation and existing typed
  restore inserts; corrupt hash and bad typed payload both abort before any
  restored source table remains.
- I2: the coordinator has a separate serialized 14/14 sanitized DDL comparison
  against the reviewed snapshot. A serialized production pre-apply comparison
  of all thirteen source PK/unique/CHECK/FK action/trigger/ACL/RLS contracts,
  plus the seventeen-column `maintenance_jobs` unique/CHECK/index/RLS/ACL
  contract, remains REQUIRED before any production action.
- I3: the local non-system routine scan is broader, but coordinator-owned live
  checks for routine, policy, trigger, event-trigger, application, and operator
  references remain REQUIRED. Comment-only, historical, and owned-restore
  references must be classified there.
- I4: archive assertion, typed projections, bootstrap exclusion, and mutator
  fail-closed checks are present. The full normal bootstrap path was not run:
  the bounded full-schema clone has no required order, fulfillment, request,
  provider, and relationship parent graph, and constructing that graph would
  expand this focused task into unrelated service behavior. The report therefore
  does not claim normal end-to-end bootstrap or normal projection-reader
  success; generated reader definitions compiled and the focused C2 wrapper plus
  full-RPC corrupt-archive rejection are the bounded changed-logic evidence.
- M1: plan count/name correction is committed as the authorized plan-only
  change.
- M2: explicit postgres ownership and exact trigger metadata are enforced and
  passed in the true-ACL synthetic restore; no generalized privilege framework
  was added.

`git diff --check` passed before the implementation commit and after report
editing. Root must still run integrated typecheck, repeat the serialized live
catalog/call-site gates, review the exact migration allowlist and dry-run, and
own any production history/apply verification. This checkout intentionally makes
no production claim and must not be labelled VERIFIED from this evidence alone.
