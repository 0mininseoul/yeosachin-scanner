# Supabase 22 account-deletion contraction wave evidence

Captured 2026-09-10 from the linked production project using read-only Supabase
CLI metadata/query access. No production migration, write RPC, archive,
restore, backfill, admission activation, or canary was run.

## Scope and inventory

- Source: `public.account_deletion_jobs`.
- Canonical destination: `public.maintenance_jobs`.
- Related phase evidence: `public.account_lifecycle`.
- Latest committed retirement inventory: `docs/reports/2026-09-10-supabase-22-retirement-inventory.json`.
- Inventory classification: legacy, `consolidate-after-proof`, contraction candidate `false`.
- Inventory dependency evidence: source dependency count `18` (FK `1`, view `0`, routine `0`, trigger `0`, policy `0`); source caller/reference counts `0/0`.
- Canonical dependency evidence: `account_lifecycle` `17` (FK `1`, trigger `1`, callers/references `1/1`); `maintenance_jobs` `33` (FK `0`, trigger `0`, callers/references `1/1`).

## Read-only production shape

Exact row counts were `account_deletion_jobs=12`, `account_lifecycle=0`, and
`maintenance_jobs=0`. The source state distribution was `completed=8` with
all three phase timestamps present, and `requested=4` with all three phase
timestamps absent.

The source columns are, in order: `account_id uuid NOT NULL` (primary key and
`users(id)` foreign key with `ON DELETE RESTRICT`), `state text NOT NULL`
default `requested`, `requested_at timestamptz NOT NULL`,
`objects_purged_at timestamptz`, `database_purged_at timestamptz`,
`completed_at timestamptz`, and `updated_at timestamptz NOT NULL`. Its checks
allow only `requested`, `objects_purged`, `database_purged`, and `completed`,
with the corresponding timestamp shape.

The canonical lifecycle shape has 7 columns: identity `id`, `account_id`,
`event_kind`, `state`, `content_hash`, object `payload`, and `recorded_at`.
The canonical maintenance shape has 16 columns: `id`, `kind`,
`target_key_hash`, `state`, `attempt_count`, `lease_generation`,
`lease_token`, `lease_holder_hash`, `lease_expires_at`, `next_attempt_at`,
`terminal_at`, `last_error_code`, object `payload`, `content_hash`,
`created_at`, and `updated_at`.

All three tables have RLS enabled and forced, with zero policies. The source
has only `service_role` table `SELECT/INSERT/UPDATE` grants; the canonical
tables have no direct client or `service_role` table grants. Existing service
RPCs have `service_role` execute grants and no `anon`/`authenticated` execute
grants in the inspected ACL.

The only inspected trigger is `account_lifecycle_immutable`, a BEFORE UPDATE
or DELETE append-only guard. There are no user-defined triggers on the source
or maintenance table.

## Routines and callers

The source routines are `begin_account_deletion_v1(uuid)`,
`finalize_account_deletion_database_v1(uuid,jsonb)`, and
`complete_account_deletion_v1(uuid)`. The inspected canonical service
boundaries are `append_account_lifecycle_v1`,
`enqueue_maintenance_job_v1`, `claim_maintenance_jobs_v1`,
`finish_maintenance_job_v1`, and `reconcile_stale_maintenance_jobs_v1`.
All are SECURITY DEFINER routines owned by the database owner with an empty
routine search path in the reviewed migrations.

Repository inspection found no direct runtime SQL reference to the legacy
table; the account-deletion service calls the three source routines. The
service already records phase evidence in `account_lifecycle` behind its
disabled-by-default account writer flag. This wave adds a separate,
disabled-by-default maintenance mirror after successful source transitions.
The hook is gated by `COMMERCE_CANONICAL_MAINTENANCE_WRITE`; the existing
maintenance read flag remains disabled.

## Additive wave and parity evidence

The proposed function is `public.mirror_account_deletion_job_v1(uuid)`,
service-role-only. It reads one source row, derives a domain-separated target
hash, writes only a sanitized state/timestamp projection to one `purge`
`maintenance_jobs` row, and preserves the source as authoritative. It stores
no account UUID in the canonical payload. Repeated calls are idempotent;
source regression after canonical success is marked blocked with
`ACCOUNT_DELETION_SOURCE_REGRESSION`.

### Proposed implementation, not run in production

The generated migration
`supabase/migrations/20260910035257_add_account_deletion_backfill_parity.sql`
adds two service-role-only routines. This is a code proposal only; the
migration was not applied remotely and neither routine was invoked against
production.

| Action | Production status | Output/scope contract |
|---|---|---|
| `backfill_account_deletion_jobs_v1(integer,text)` | proposed, not run | At most 100 source rows, opaque hash cursor, forward-only calls to `mirror_account_deletion_job_v1` inside SQL, idempotent mirror counts, no raw UUID output. |
| `collect_account_deletion_parity_v1()` | proposed, not run | Read-only SQL aggregation of source/canonical counts, deterministic checksums, and mismatch field names only; no row or UUID export. |
| typed server adapter methods | local code only, not activated | Backfill remains gated by `COMMERCE_CANONICAL_MAINTENANCE_WRITE`; parity has no write path. |

The local report-only harness remains bounded to 100 rows per page and refuses
mutation, cutover, activation, drop, truncate, and delete options. It is not a
substitute for a production parity result.

The read-only source projection checksum is
`865d24fc97cb5d8816b7d5a17eb0fc78e3f31d9395d7055e8545aacd39ec4b6f` for 12
rows; canonical count is 0 and canonical checksum is null, so parity is
blocked and no backfill was attempted.

The archive/restore manifest is recorded separately at
`docs/reports/2026-09-10-account-deletion-canonical-archive-restore-manifest.json`.
Both archive and isolated restore are `not_run`; its destructive allowlist is
empty.

## Remaining gates

Destructive readiness is blocked. Required independent evidence remains:

- `archive-manifest` and `restore-drill`: encrypted archive and isolated
  restore with matching checksum;
- `per-order-parity`: complete per-row source-to-canonical parity, including
  canonical reads;
- `observation-window`: a closed window with the maintenance writer/read flags
  still independently controlled;
- `dependency-inventory` and `migration-history`: zero dependency/traffic
  proof after the additive wave, plus clean history after any separately
  approved migration apply;
- `rollback-evidence`: an independently verified rollback path;
- `no-activation-or-canary`: independent read-only proof that admission and a
  real canary stayed inactive;
- `payment-pending-disposition`: independent evidence and disposition for any
  pending-payment records, intentionally not evaluated by this wave;
- `separate-approval`: owner approval for the exact contraction, with a
  separate approval required before any destructive statement is proposed or
  executed.

`payment_pending` was not read or mutated. Admission remains inactive, the real
`0_min._.00` canary was not run, the destructive allowlist is `[]`, and the
source table was not dropped, renamed, truncated, deleted from, or backfilled.

## Local implementation verification

The additive implementation was verified locally without a remote connection:

- Focused TDD contracts: `35` tests passed, including migration contract,
  adapter, report-only helper, and PGlite backfill/parity tests.
- Typecheck: `npx tsc --noEmit --pretty false` passed.
- Lint: `npm run lint` passed with existing repository warnings and no errors.
- Diff hygiene: `git diff --check` passed.
- Secret scan: changed hunks and the generated migration passed redacted
  `gitleaks` scans. A whole-tree scan remains noisy from pre-existing findings
  outside this wave and was not used as evidence of a new secret.
- Production actions: migration apply, backfill RPC, parity RPC, archive,
  restore, flag change, admission activation, canary, and destructive action
  were all not run.
