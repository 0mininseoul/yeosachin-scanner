# Supabase 22 account-deletion contraction wave evidence

Captured 2026-09-10 with the linked Supabase CLI. The final main commit
`fad5bc7ce7a0f02a970d7f7a6a9453e74e928c78` had successful main CI run
`34441721804` and a successful Vercel production deployment. The selected
migration `20260910035257_add_account_deletion_backfill_parity.sql` dry-run
listed only that file; its apply succeeded, local and remote migration history
matched, and a final dry-run returned `upToDate: true`.

Immediately before the backfill, aggregate public/source/canonical counts were
`187/12/0`. The read-only pre-parity snapshot was `mismatch` with
source/canonical counts `12/0`. One bounded backfill returned `processed: 12`,
`mirrored: 12`, `duplicates: 0`, `blocked: 0`, `has_more: false`, and
`status: parity_required`. The immediate post-parity snapshot was `match` with
source/canonical counts `12/12`, equal checksum
`865d24fc97cb5d8816b7d5a17eb0fc78e3f31d9395d7055e8545aacd39ec4b6f`, and
`mismatch_fields: []`. Source states remained `completed: 8` and `requested: 4`;
canonical states were `succeeded: 8` and `queued: 4`; the public table count
stayed `187`.

This is a parity snapshot only. The source remains authoritative and active,
and four requested jobs remain. No account or user identifiers, cursor hash,
tokens, or raw payloads are included in this report.

## Scope and inventory

- Source: `public.account_deletion_jobs`.
- Canonical destination: `public.maintenance_jobs`.
- Related phase evidence: `public.account_lifecycle`.
- Latest committed retirement inventory: `docs/reports/2026-09-10-supabase-22-retirement-inventory.json`.
- Inventory classification: legacy, `consolidate-after-proof`, contraction candidate `false`.
- Inventory dependency evidence: source dependency count `18` (FK `1`, view `0`, routine `0`, trigger `0`, policy `0`); source caller/reference counts `0/0`.
- Canonical dependency evidence: `account_lifecycle` `17` (FK `1`, trigger `1`, callers/references `1/1`); `maintenance_jobs` `33` (FK `0`, trigger `0`, callers/references `1/1`).

## Read-only production shape

The pre-backfill aggregate counts were public/source/canonical `187/12/0`, and
the read-only pre-parity snapshot was `mismatch` with source/canonical `12/0`.
After one bounded backfill, the immediate post-parity aggregate snapshot was
`match` with source/canonical `12/12`, equal checksum
`865d24fc97cb5d8816b7d5a17eb0fc78e3f31d9395d7055e8545aacd39ec4b6f`, and an
empty `mismatch_fields` list. The public table count stayed `187`.

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

Both selected backfill/parity RPCs are SECURITY DEFINER with an empty
`search_path`; `service_role` execute is true and `anon`/`authenticated`
execute is false. The backfill RPC has `statement_timeout = '2min'` and
`lock_timeout = '5s'`; the parity RPC has `statement_timeout = '2min'`.

Repository inspection found no direct runtime SQL reference to the legacy
table; the account-deletion service calls the three source routines. The
service already records phase evidence in `account_lifecycle` behind its
disabled-by-default account writer flag. This wave adds a separate,
disabled-by-default maintenance mirror after successful source transitions.
The hook is gated by `COMMERCE_CANONICAL_MAINTENANCE_WRITE`; the existing
maintenance read flag remains disabled.

## Applied migration and parity evidence

The applied migration exposes `public.mirror_account_deletion_job_v1(uuid)` as
a service-role-only routine. It reads one source row, derives a
domain-separated target hash, writes only a sanitized state/timestamp
projection to one `purge` `maintenance_jobs` row, and preserves the source as
authoritative. It stores no account UUID in the canonical payload. Repeated
calls are idempotent; source regression after canonical success is marked
blocked with `ACCOUNT_DELETION_SOURCE_REGRESSION`.

### Selected migration and bounded production run

The generated migration
`supabase/migrations/20260910035257_add_account_deletion_backfill_parity.sql`
adds two service-role-only routines. Its exact dry-run allowlist listed only
that file; the apply succeeded, local and remote migration history matched, and
the final dry-run returned `upToDate: true`.

| Action | Production status | Output/scope contract |
|---|---|---|
| `backfill_account_deletion_jobs_v1(integer,text)` | applied and invoked once in one bounded run | At most 100 source rows, opaque hash cursor, forward-only calls to `mirror_account_deletion_job_v1` inside SQL, idempotent mirror counts, no raw UUID output; returns only nonterminal `progressed`, `parity_required`, or `blocked`. |
| `collect_account_deletion_parity_v1()` | applied and invoked immediately after backfill | Read-only SQL aggregation of source/canonical counts, deterministic checksums, and mismatch field names only; no row or UUID export; operator-only through the linked CLI. |
| runtime mirror adapter | local code only, not activated | Retained only for the existing account-deletion runtime mirror hook; no backfill/parity TypeScript adapter surface. |

The bounded run processed `12`, mirrored `12`, and returned `duplicates: 0`,
`blocked: 0`, `has_more: false`, and `status: parity_required`. The local and
production contracts remain bounded to 100 rows per page and refuse mutation,
cutover, activation, drop, truncate, and delete options. The matching parity
snapshot is aggregate evidence only: it does not prove source quiescence or
replace an account-deletion-specific continuous mirror and cutover before
retirement.

The archive/restore manifest is recorded separately at
`docs/reports/2026-09-10-account-deletion-canonical-archive-restore-manifest.json`.
Both archive and isolated restore are `not_run`; its destructive allowlist is
empty.

## Remaining gates

Destructive readiness is blocked. The aggregate parity snapshot does not close
the following independent gates:

- `archive-manifest` and `restore-drill`: encrypted archive and isolated
  restore with matching checksum;
- `per-row-parity`: complete per-row source-to-canonical parity, including
  canonical reads beyond this aggregate snapshot;
- `account-deletion-continuous-mirror`: continuous account-deletion-specific
  mirror and cutover proof;
- `observation-window`: a closed window with the maintenance writer/read flags
  still independently controlled;
- `dependency-inventory` and `traffic-zero`: zero dependency/traffic proof
  after the additive wave;
- `rollback-evidence`: an independently verified rollback path;
- `no-activation-or-canary`: independent read-only proof that admission and a
  real canary stayed inactive;
- `payment-pending-disposition`: independent evidence and disposition for any
  pending-payment records, intentionally not evaluated by this wave;
- `separate-approval`: owner approval for the exact contraction, with a
  separate approval required before any destructive statement is proposed or
  executed.

`payment_pending` was not read or mutated. Admission remains inactive, the real
`0_min._.00` canary was not run, no global flag changed, the destructive
allowlist is `[]`, and the source table was not dropped, renamed, truncated, or
deleted from. The source remains authoritative and active with four requested
jobs remaining; no source mutation occurred.

## Local implementation verification

The additive implementation was verified locally without a remote connection:

- Focused TDD contracts: `42` tests passed locally across migration contract,
  runtime mirror adapter, report-only helper, and PGlite backfill/parity tests.
- Typecheck: `npx tsc --noEmit --pretty false` passed.
- Lint: `npm run lint` passed with existing repository warnings and no errors.
- Diff hygiene: `git diff --check` passed.
- Secret scan: changed hunks and the generated migration passed redacted
  `gitleaks` scans. A whole-tree scan remains noisy from pre-existing findings
  outside this wave and was not used as evidence of a new secret.
- Production actions: the selected `20260910035257` dry-run listed only that
  file, its apply succeeded, local/remote migration history matched, and the
  final dry-run returned `upToDate: true`; one bounded backfill and one
  immediate parity snapshot are recorded above. No archive, restore, flag
  change, admission activation, canary, or destructive action occurred.
