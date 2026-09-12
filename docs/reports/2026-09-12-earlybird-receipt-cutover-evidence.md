# Earlybird receipt cutover implementation evidence

Date: 2026-09-12
Ancestor: `245ef9d5517b791ceb65491ed187e744c56f6ad8`
Implementation commit: `046ae4faf9bb70a6e7abbeb3e2c41fa1a3a2f8ce`
Residual-fix base: `9ec4c586fc78348f74c868d4ace0375020b8398b`
Residual-fix commit: `2476d16d`
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

## Residual archive-integrity follow-up

This section is the follow-up proof for the immutable residual-fix base
`9ec4c586fc78348f74c868d4ace0375020b8398b`; the earlier sections retain the
accepted evidence for the original implementation commit. Only the existing
migration, restore operation, and this evidence document changed in this
follow-up.

The three approved changes are:

- The restore manifest guard now requires
  `legacy_primary_key = jsonb_build_object('order_id', payload->'legacy_row'->'order_id')`
  in addition to the existing exact shape, type, and hash checks.
- The three generated `FROM`, `JOIN LATERAL`, and `FROM LATERAL` projection
  templates and the purge assertion now compare numeric JSON `schema_version`
  `1` using `->` and `1::JSONB`. A compact per-source predicate is derived
  from the already locked `pg_attribute` rows and injected with `format`; it
  preserves all 107 source `NOT NULL` columns across 13 catalogs while leaving
  nullable concierge enrichment admissible.
- The active-DDL snapshot regex recognizes `CREATE OR REPLACE` with real
  whitespace tokens, while retaining ordinary `CREATE`, `ALTER`, and `DROP`
  forms. Its SQL comment documents that root serializes deployment ownership
  and that the regex is not a formal future-concurrency exclusion.

The disposable pre-change red cases were:

```text
RED_RESTORE_PK|accepted=true|desired=false
RED_PROJECTION_STRING_VERSION|accepted=true|desired=false
RED_PROJECTION_NULL_REQUIRED|accepted=true|desired=false
RED_ACTIVE_DDL_CREATE_OR_REPLACE|accepted=false|desired=true
```

The revised candidate used the existing native PG17.10 cluster and a bounded
synthetic fixture. The fixture was reduced from 184 to the reviewed 173 public
tables, supplied the two predecessor history markers and nullable pending
column, loaded the three exact hash-verified predecessor routine definitions
from the coordinator's disposable routine artifact, and copied 21 synthetic
source rows with triggers disabled because no parent graph was in scope. It
also pruned 12 obsolete predecessor, copy-correction, lineage, and transient-
admission routines so this was a bounded predecessor fixture rather than a
full production-catalog clone; the migration's own scoped trigger/function
removals were then exercised normally. The 118 typed source fields, including
107 required `NOT NULL` fields and 11 legitimate nullable concierge enrichment
fields, are the catalog coverage boundary. The actual revised migration
command targeted only this disposable database:

```sh
EB17_SOCKET_DIR="$(cat /tmp/earlybird-cutover-pg17-socket-path)"
psql -X -v ON_ERROR_STOP=1 -U postgres -h "$EB17_SOCKET_DIR" -p 55444 \
  -d eb_residual_root_routines_pg17_20260912 \
  -f supabase/migrations/20260912074059_retire_earlybird_receipt_archive.sql
```

It completed with `COMMIT`. Sanitized post-checks returned:

```text
public_tables=160
archive_rows=21
source_tables_remaining=0
content_hash_matches=21
target_key_hash_matches=21
numeric_schema_version=21
legacy_pk_matches_row=21
```

The actual revised generated definitions were re-extracted from
`pg_get_functiondef`. Their function and fragment SHA-256 evidence was:

```text
publish_earlybird_v211_first_payment_concierge function=bc6bc72f83b5298cb51aaea412e482c9c9fc38caedbce3973d94eca6e0caecc0
FROM fragment=5f44856662dab919f0d2f23cd897588a9c2784a6be333287b27c0a4f5cbd9c95 valid_count=1
complete_analysis_v2_preflight_admission function=87abe26caafc3c507443913aaad5b4ac01967ed7cd816585fb5a5584f22aa3af
JOIN LATERAL fragment=18c68b7cec9575074a36b4b19b8ef52f73f2345eb60b47f64bebaaebe0f58526 valid_count=1
publish_earlybird_v211_first_payment_concierge FROM LATERAL fragment=de577c03f35e8da678e1583bb94a92a77af00f8924d7728050b5f4ae5fc83db5 valid_count=1
read_earlybird_v211_concierge_result_source FROM fragment=3bbd485dacca237a85776c7a9e09430a6cb0b8a2609ce933bd209b6e8de8cb42 nullable_enrichment_valid_count=2
generated_not_null_predicate_coverage=107/107 sources=13/13
```

Rollback-only projection negatives against the actual revised `FROM`
fragment returned `0` rows for both a string schema version `"1"` and a
rehashed JSON-null `expected_fulfillment_attempt_count`. The concierge control
had two rows with JSON-null reviewed-source enrichment fields and both rows
remained admissible. The revised purge assertion had a valid control, its
function definition contained the numeric `1::JSONB` predicate, and a rehashed
string-version row was rejected with `P0001`.

The exact revised restore archive-integrity `DO` block was run from the owned
restore operation against a fresh synthetic clone. The valid control committed
with 21 archive rows. In a separate clone, one primary key was changed while
both content and target-key hashes were recomputed; the exact guard exited with
`EARLYBIRD_RECEIPT_RESTORE_ARCHIVE_MANIFEST_INVALID`, and source-table counts
were `0` both before and after the rejection, proving the mismatch was rejected
before source-table DDL.

The exact revised DDL assertion returned the expected results for normalized
positive and negative controls:

```text
create_or_replace_function_newline=true
create_or_replace_procedure_whitespace=true
ordinary_create_function=true
ordinary_alter_routine=true
ordinary_drop_procedure=true
ordinary_create_publication=true
non_ddl_select=true
```

The pre-existing no-caller guard, trigger DDL, six payment wrappers, and
unrelated maintenance behavior were not changed or rerun here; their accepted
component evidence above and the coordinator's independent live catalog gate
remain the provenance for those unaffected contracts. This follow-up used no
remote Supabase calls, production writes, activation, canary, payment mutation,
new tests, broad CI, or TypeScript changes, and it makes no production
`VERIFIED` claim.

In the matrix above, each `=true` means the observed classification matched its
expected classification; specifically, `non_ddl_select=true` means the `SELECT`
control remained a negative (non-DDL) result.

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
