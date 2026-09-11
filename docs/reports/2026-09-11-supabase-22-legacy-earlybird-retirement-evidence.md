# Supabase 22 legacy earlybird retirement evidence

## Status and scope

`READY_FOR_REVIEW_NOT_APPLIED`. This branch prepares, tests, and documents a
single guarded migration; it does not apply the migration to production.

The approved destructive scope is exactly eight public tables:

- `earlybird_concierge_batch_target_lineage_repairs` — 3 rows
- `earlybird_partial_adoption_second_rearms` — 1 row
- `earlybird_profile_evidence_failure_recoveries` — 2 rows
- `earlybird_v211_apify_transient_admission_resumes` — 1 row
- `earlybird_v211_concierge_copy_corrections` — 1 row
- `earlybird_v212_concierge_copy_corrections` — 1 row
- `earlybird_v213_concierge_copy_corrections` — 1 row
- `earlybird_v214_concierge_gemini_copy_corrections` — 1 row

The expected canonical total is 11 rows in `public.maintenance_jobs`. The
guarded migration requires the public base/partitioned table count to be 185
before DDL and verifies 177 after DDL. It drops only the 14 exact routine
signatures recorded in the manifest and eight literal table statements; no
wildcard, prefix, dynamically assembled identifier, or `CASCADE` operation is
present.

## Production evidence boundary

The coordinator supplied sanitized, read-only catalog evidence for the
candidate family. For the approved eight tables, incoming foreign keys,
dependent views, and publication memberships were all zero; the production
cron schema was absent. The inventory reports `track_functions=none`, so
`pg_stat_user_functions` is not used as runtime-traffic proof. The migration
therefore retains fail-closed catalog checks and a stored-function-definition
scan, while treating application/runtime ownership as an explicit coordinator
review gate.

`earlybird_v211_concierge_publications` is intentionally excluded from this
wave. Its helper
`analysis_v2_is_first_payment_concierge_publication(uuid)` is referenced by
retained result-summary triggers, so its table, helper, and retained triggers
remain unchanged. The shared
`prevent_earlybird_schema_failure_recovery_mutation()` trigger helper is also
excluded from the routine drop list and remains available to retained tables.

## Canonical preservation proof

The migration copies each source row into `maintenance_jobs` with:

- `kind` constrained to the manifest contract (`recovery`, `rearm`, or
  `replay`);
- a versioned, source-qualified SHA-256 `target_key_hash` over the complete
  primary-key JSON;
- `state='succeeded'`;
- `legacy_source_table`, `legacy_primary_key`, `legacy_row`, and
  `schema_version=1` payload fields; and
- a SHA-256 `content_hash` over the canonical payload text.

Before any destructive statement, the transaction checks each exact source
count, source-to-canonical aggregate hash, and the total of 11 canonical rows.
Conflict handling updates only an identical existing payload; a content
conflict aborts the transaction. The terminal guard rechecks canonical count,
target absence, routine absence, and public table count before commit.

## Isolated recovery and verification

`supabase/operations/20260911_restore_legacy_earlybird_recovery_tables.sql`
is an isolated rollback operation, not a migration. It requires the caller to
set `supabase.retirement_isolated='true'` in the session, rejects an already
restored target, recreates the eight historical table definitions and
immutable table-owned triggers, restores every column with an explicit type
cast from `legacy_row`, and proves source/canonical count and aggregate-hash
parity. It never deletes or rewrites `maintenance_jobs` rows.

`supabase/operations/20260911_verify_legacy_earlybird_recovery_retirement.sql`
supports caller-selected `preflight` and `postapply` modes through the
session-local `supabase.retirement_verifier_mode` setting. It emits only
relation/routine names, counts, SHA-256 hashes, boolean dependency facts, and
migration-history occurrence counts; its temporary report table is rolled
back before return. Preflight covers the baseline count, eight source counts,
canonical shape, dependencies, exact routine identities, and publications.
Postapply covers the final count, eight-table/14-routine absence, canonical
row count and hash, publications, and exactly-one migration-history entry.

The disposable PGlite suite passed 11 tests, including migration apply and
parity, baseline/source-count/shape/routine/caller fail-closed cases, the
non-isolated restore rejection, typed field parity, and verifier preflight
and postapply execution.

## Rollback and activation boundary

Rollback evidence is limited to the isolated restore operation and its
disposable PGlite drill. No production restore, migration apply, Supabase
remote connection, Vercel operation, provider call, Auth operation, payment
operation, or external-service call was performed by this branch.

The following remain unchanged and out of scope: payment records and
`payment_pending`, users and Auth identities, admission flags, active
analysis functions, retained result-summary routines, and all provider state.
No analysis admission was activated, and the real `0_min._.00` canary was
never run. Production rollout, migration-history verification, and any
postapply evidence remain coordinator-owned gates.
