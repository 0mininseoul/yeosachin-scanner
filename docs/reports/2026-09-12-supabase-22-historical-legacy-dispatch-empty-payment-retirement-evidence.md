# Supabase 22 historical/empty-payment retirement evidence

Status: `READY_FOR_REVIEW_NOT_APPLIED`

Reviewed base SHA: `e9c7abe3df0d0569b8eda178b42382e1e8789de2`

Predecessor schema SHA: `60423b338d6f8f617c2c1457405bda719c3cf02b`

This report records the production read-only decision and the local
implementation. No production migration, push, activation, canary,
payment-state change, or analysis-runtime change was performed.

## Decision

Implement the largest defensible three-table group:

| Target | Fresh production rows | Local action |
| --- | ---: | --- |
| `public.analysis_v2_historical_legacy_dispatch_terminalization_receipts` | 5 | Preserve every typed row in `public.maintenance_jobs`, then drop the table and its three retired owner-only routines/trigger guard |
| `public.payment_orders` | 0 | Require an empty table, then drop it explicitly |
| `public.payments` | 0 | Require an empty table, preserve all six reviewed payment entry-point contracts unchanged, then drop it explicitly |

The fresh production public base/partitioned-table count was 177. The
migration asserts that baseline and expects 174 after these three targets are
removed. `public.pending_analysis` has 11 rows, all currently
`awaiting_payment`, and remains untouched; no payment state was inferred or
changed. `public.account_deletion_jobs` is deferred.

## Preservation contract

The five historical receipt rows are copied losslessly into the existing
`public.maintenance_jobs` canonical ledger before any destructive statement.
Each canonical row uses:

- `kind = 'terminalize'`;
- a domain-separated SHA-256 `target_key_hash` over the retirement contract, kind, source table, and stable `receipt_id` key;
- `payload.legacy_source_table` with the exact source relation name;
- `payload.legacy_primary_key = {"receipt_id": ...}`;
- `payload.legacy_row = to_jsonb(source_row)`, retaining every typed source column and null value;
- `payload.schema_version = 1`; and
- `content_hash` as SHA-256 over the canonical payload text.

The migration pins `TIME ZONE 'UTC'` before archive serialization and keeps the
existing source count, distinct-key, canonical conflict, ordered aggregate
hash, key, full JSONB row, and schema-version checks before dropping. The
source catalog fingerprint also covers owner/ACL, RLS and FORCE RLS, policy
set, defaults, constraints, indexes, and non-internal trigger set. Its reviewed
fingerprints are:

| Source | Catalog fingerprint |
| --- | --- |
| historical receipts | `1c71e94106ab0cfa908288171bec5b599b68a6a6880b8fe7a86eb1419f791493` |
| `payment_orders` | `c3388362ec6fe66bd39844a546295db254ed241a420fda456c5c4fa12a2037f1` |
| `payments` | `a97df2b722e35f78aba346dd64f3cd266045eaa4c6b2f1f2ad41be8af42af502` |

## Dependency evidence and exclusions

The migration keeps the exact relation allowlist and non-CASCADE drops. It
checks catalog dependencies for incoming foreign keys, dependent views,
dependent routines, and publication membership. The retired-routine guard
now scans `pg_proc` definitions in every non-system routine schema, not only
`public`, after removing SQL comments. It does not strip quoted strings, so a
literal reference inside dynamic `EXECUTE` text remains visible and fails
closed. A dynamic identifier assembled without a target literal cannot be
proven by a bounded catalog scan; the coordinator's repository inventory and
rollout review remain required for that case.

The repository caller inventory is explicit:

- `scripts/generate-analysis-v2-historical-legacy-dispatch-terminalizer.ts:278` and its contract test reference the resolver only as archived SQL-generation coverage; the generator entry point now fails closed.
- `supabase/operations/20260912_restore_historical_legacy_dispatch_and_empty_payment_tables.sql` contains only the isolated data restore path.
- `docs/analysis-v2-historical-legacy-dispatch-terminalizer-runbook.md` is the archived runbook for the retired path.
- No active `app/` or `lib/` runtime caller was found, and no other `scripts/**` or `supabase/operations/**` caller was found.

The selected historical table's only database body references are the two
retired candidate/resolver routines and its immutability trigger guard. The
other historical tables remain deferred because active routines reference
them. `pending_analysis` is explicitly out of scope because it contains live
payment-gated rows.

## Payment routine preservation

The migration's literal payment allowlist covers all six current signatures:

- `public.finalize_earlybird_groble_payment_pre_reconciliation(...)`;
- `public.finalize_earlybird_groble_payment_reconciliation_aware(...)`;
- the 12-argument `public.finalize_earlybird_groble_payment(...)`;
- `public.finalize_earlybird_groble_payment_by_reference(...)`;
- the 9-argument `public.finalize_earlybird_groble_payment(...)`; and
- `public.finalize_earlybird_groble_payment_refund_aware(...)`.

For each signature it snapshots exact OID, definition SHA-256, ACL, owner,
`SECURITY DEFINER`, and `proconfig`, then revalidates the complete contract
immediately before destructive DDL and again in the terminal guard. Any
unreviewed `finalize_earlybird_groble_payment%` prefix match aborts. The migration
does not lock or mutate `pending_analysis`, payment rows, or payment wrappers.
The terminal target-literal scan exempts only these six after their complete
contract revalidation, so an unreviewed routine remains a hard failure.

F2/F3 rollout evidence is coordinator-owned rather than an unrelated business
lock. The narrow read-only operation
`supabase/operations/20260912_verify_historical_legacy_dispatch_empty_payment_retirement.sql`
emits the pending count/status/key hash, all six wrapper contract
fingerprints, canonical archive count/hash, target presence, retired-routine
presence, public table count, and migration-history occurrence count. Run it
once before and once after apply and compare the complete sanitized JSON
object; do not run a concurrent coordinated rollout.

## Isolated restore and parity

`supabase/operations/20260912_restore_historical_legacy_dispatch_and_empty_payment_tables.sql`
is a data-only recovery operation, not a production rollback. It requires the
caller to set `supabase.retirement_isolated = 'true'`, requires the canonical
ledger and both parent relations/rows, and takes a scoped `SHARE` lock on
`maintenance_jobs` while reading archive input. It refuses pre-existing target
tables and refuses a pre-existing trigger routine before using `CREATE FUNCTION`.

The restore pins UTC, requires exactly five `state = 'succeeded'` archive rows,
recomputes and verifies every deterministic `target_key_hash` and
`content_hash`, verifies `legacy_primary_key` metadata and distinct receipt
keys, recreates the reviewed constraints/defaults/indexes/RLS/ACL/trigger
contract, and then checks exact typed full-row parity. It never deletes or
rewrites canonical rows. If a later purge removed a required parent row, the
archive remains authoritative but this typed reconstruction must refuse to
run.

A disposable PostgreSQL 17.10 fixture seeded UTC archive rows, the two parent
relations, the six live payment-prefix signatures (including `refund_aware`),
and the isolated-restore setting. The restore completed with 5 archive rows,
5 typed rows, 0 payment rows, and a six-wrapper prefix count; the session was
started in `Asia/Seoul` to verify the operation's UTC pin.

The revised retirement migration also completed on a bounded PostgreSQL 17.10
fixture: 177 public tables before the run, 5 source rows, six payment-prefix
signatures, then 174 public tables, 5 canonical archive rows, zero retired
routines, and all three targets absent. That fixture used 168 inert public
tables, synthetic parent/archive rows and roles, and a public
`uuid_generate_v4()` alias so local deparsing matched the reviewed production
catalog; these substitutions were fixture-only and no production guard was
weakened.

A local collision probe dropped only the disposable target relations inside a
rollback while retaining the trigger routine; restore refused with
`RETIREMENT_RESTORE_TRIGGER_FUNCTION_ALREADY_PRESENT`, and the outer rollback
left all three targets intact.

## Exact coordinator handoff

Migration allowlist: exactly
`supabase/migrations/20260912070144_retire_historical_legacy_dispatch_and_empty_payment_tables.sql`.
The following commands are concrete, sanitized handoff commands. They were
not used by this worker for production apply.

```sh
SOURCE_CLI_WORKDIR=/private/tmp/yeosachin-public22-cli.0GC1rz
ROLLOUT_CLI_WORKDIR=$(mktemp -d /private/tmp/yeosachin-public22-cli-rollout.XXXXXX)
MIGRATION=/Users/youngminpark/orca/workspaces/yeosachin_scanner/supabase-public-retirement-implementation-20260912/supabase/migrations/20260912070144_retire_historical_legacy_dispatch_and_empty_payment_tables.sql
VERIFY=/Users/youngminpark/orca/workspaces/yeosachin_scanner/supabase-public-retirement-implementation-20260912/supabase/operations/20260912_verify_historical_legacy_dispatch_empty_payment_retirement.sql

mkdir -p "$ROLLOUT_CLI_WORKDIR/supabase"
cp "$SOURCE_CLI_WORKDIR/supabase/config.toml" "$ROLLOUT_CLI_WORKDIR/supabase/config.toml"
cp -R "$SOURCE_CLI_WORKDIR/supabase/.temp" "$ROLLOUT_CLI_WORKDIR/supabase/.temp"

npx --yes supabase@2.102.0 --version
```

The remote history currently contains 386 applied versions, including the
legacy `001` through `010` versions. Populate the fresh rollout workdir with
empty history-only stubs from a linked read-only query, then copy exactly one
non-empty reviewed migration and verify that the non-empty allowlist is
separate from the stubs:

```sh
set -euo pipefail
mkdir -p "$ROLLOUT_CLI_WORKDIR/supabase/migrations"
HISTORY_VERSIONS=$(npx --yes supabase@2.102.0 db query \
  --workdir "$ROLLOUT_CLI_WORKDIR" --linked --output json \
  "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;" \
  2>/dev/null | jq -r '.rows[].version')
test "$(printf '%s\n' "$HISTORY_VERSIONS" | awk 'NF { count++ } END { print count + 0 }')" = "386"
while IFS= read -r version; do
  case "$version" in
    00[1-9]|010) : ;;
    *[!0-9]*|'') echo "unexpected migration version shape" >&2; exit 1 ;;
    *) test "${#version}" = "14" || { echo "unexpected migration version shape" >&2; exit 1; } ;;
  esac
  touch "$ROLLOUT_CLI_WORKDIR/supabase/migrations/${version}_remote_applied.sql"
done <<< "$HISTORY_VERSIONS"
cp "$MIGRATION" "$ROLLOUT_CLI_WORKDIR/supabase/migrations/"
test "$(find "$ROLLOUT_CLI_WORKDIR/supabase/migrations" -maxdepth 1 -type f -name '*.sql' ! -size 0c -exec basename {} \; | sort)" = "$(basename "$MIGRATION")"
test "$(find "$ROLLOUT_CLI_WORKDIR/supabase/migrations" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')" = "387"

# Read-only dry run, before any approval to apply:
npx --yes supabase@2.102.0 db push --workdir "$ROLLOUT_CLI_WORKDIR" --linked --dry-run

# Coordinator-approved apply of the one-file allowlist only:
npx --yes supabase@2.102.0 db push --workdir "$ROLLOUT_CLI_WORKDIR" --linked
```

Immediately after apply, verify migration history with the linked read-only
query and rerun the evidence operation:

```sh
npx --yes supabase@2.102.0 db query --workdir "$ROLLOUT_CLI_WORKDIR" --linked --output json \
  "SELECT count(*) AS migration_history_occurrences FROM supabase_migrations.schema_migrations WHERE version = '20260912070144';"
npx --yes supabase@2.102.0 db query --workdir "$ROLLOUT_CLI_WORKDIR" --linked --output json --file "$VERIFY"
```

For disposable restore only, provide the connection to that disposable
database outside this report, set the isolation flag in the same SQL session,
and run the restore operation with no production link or target:

```sh
RESTORE=/Users/youngminpark/orca/workspaces/yeosachin_scanner/supabase-public-retirement-implementation-20260912/supabase/operations/20260912_restore_historical_legacy_dispatch_and_empty_payment_tables.sql
psql "$DISPOSABLE_DB_URL" -v ON_ERROR_STOP=1 <<SQL
SET supabase.retirement_isolated = 'true';
\\i $RESTORE
SQL
```

The linked pre/post evidence must show unchanged pending count/status/key hash
and all six wrapper fingerprints, post-apply absence of the three target
tables and three retired routines, canonical archive count/hash of five rows,
public table count 174, and exactly one migration-history occurrence. No
activation/canary or payment-state reconciliation is part of this handoff.

## Verification boundary

The implementation files are:

- `supabase/migrations/20260912070144_retire_historical_legacy_dispatch_and_empty_payment_tables.sql`;
- `supabase/operations/20260912_restore_historical_legacy_dispatch_and_empty_payment_tables.sql`;
- `supabase/operations/20260912_verify_historical_legacy_dispatch_empty_payment_retirement.sql`; and
- this evidence report.

Archived generator/runbook files were not changed. Broad tests, build, CI,
production SQL mutation, push, merge, and activation remain out of scope.
