# Supabase 22 comment/interactions retirement production evidence

Captured after coordinator post-apply verification at
`2026-09-11T02:45:27+09:00`. The pre-apply production facts below and the
post-apply facts were independently collected by the coordinator; the reviewed
dynamic-routine inventory was collected as one read-only linked aggregate
returning only a count and deterministic SHA-256, with no routine names or
definitions output. The worker did not call Supabase or perform any production
mutation. The already verified account-deletion post-apply evidence is included
through cherry-picked commit `18426f8fb5b2d23d5d86c912dc805d7a2bd32220`.

## Decision

The owner approved production retirement of exactly these two qualified
relations:

This package records owner approval for that exact ordered allowlist and hash.

```text
public.comment_details
public.interaction_logs
```

The canonical ordered JSON is
`["public.comment_details","public.interaction_logs"]`; its deterministic
UTF-8 SHA-256 is
`a616d2972b931904113f18fb075850ef13cba0a384ea3b819740ee2f012dabe6`.
The approved allowlist is bound to the generated migration
`supabase/migrations/20260910123053_retire_comment_interaction_evidence.sql`,
which is now VERIFIED production applied by the coordinator with destructive
operations limited to that exact allowlist. The reversible draft SQL remains
under `supabase/operations/`.

## Production evidence

- Exact row counts are `0` for both `public.comment_details` and
  `public.interaction_logs`.
- From the database postmaster start at `2026-07-10T11:52:33+09:00`, each
  table has `n_tup_ins = 0`, `n_tup_upd = 0`, and `n_tup_del = 0`.
- There are no incoming foreign keys, dependent views, routine mentions, user
  triggers, or publication memberships for either table.
- Current `app/`, `lib/`, `hooks/`, and `scripts/` runtime inspection has no
  references to either table. Git history contains only canonical contract
  fixture references.
- The reviewed definitions and policies are the original declarations in
  `supabase/migrations/001_initial_schema.sql` plus the client-access revocation
  in `supabase/migrations/20260710161639_hide_interaction_evidence_from_clients.sql`.
- Each table has only its outgoing `ON DELETE CASCADE` foreign key to
  `public.analysis_results`, its primary-key and `result_id` indexes, its RLS
  SELECT policy, and the retained `service_role`/`postgres` grants after
  `anon`/`authenticated` access was revoked.
- A nonzero `idx_scan` count is not direct-use proof: deleting a parent row in
  `public.analysis_results` can make PostgreSQL use a child `result_id` index
  for foreign-key cascade checks. The index counters therefore do not override
  the zero-row, zero-write, dependency, and runtime evidence above.
- The supplied activity evidence had `background_null_state_activity=2`, consisting exactly
  of the pg_cron launcher and pg_net 0.19.5 worker. Both rows had visible
  queries and `state` `NULL`; they were known non-client background activity,
  not hidden client backends. The current production relevant active DDL count
  was `0`, and all other supplied evidence matched the package above.

## Post-apply verification

The coordinator verified the following production facts at
`2026-09-11T02:45:27+09:00`:

- Migration `20260910123053` exists exactly once in remote migration history.
- The public table count is `185`.
- `public.comment_details` and `public.interaction_logs` are both absent.
- Incoming foreign keys, dependent views, routine dependencies, routine
  mentions, user triggers, all-table publications, public-schema publications,
  and target publication memberships are all `0`.
- The isolated CLI post-apply dry-run returned `Remote database is up to date`.
- Main CI run `34507499334` succeeded, and Vercel status for merge commit
  `35d3c41f5bfde9c56384b18213d4fe690720baea` succeeded.

This closes the exact-allowlist apply and post-apply verification gates. The
allowlist and all recorded evidence hashes remain unchanged.

## Concurrency correction and apply window

The generated migration now takes the fixed transaction-scoped advisory lock
`pg_advisory_xact_lock(22091010, 22)` immediately after `BEGIN`. This lock
serializes coordinated copies of this rollout only; it does not block
uncoordinated PostgreSQL DDL.

Two fail-closed active-DDL checks exclude this migration's own backend and run
before catalog evidence and immediately before the two drops. They cover
`CREATE`/`ALTER`/`DROP PUBLICATION` and `CREATE`/`ALTER`/`DROP` (including
`OR REPLACE`) `FUNCTION`/`PROCEDURE`/`ROUTINE`; comments between tokens are
normalized before the visible-query regex branch is evaluated. A same-database
session whose `backend_type` is `NULL`, or a `client backend` whose `state` is
`NULL`, whose query is `NULL`, or whose query is the PostgreSQL `<insufficient
privilege>` sentinel, is treated as unknown and blocks the rollout. Known
non-client background rows with `state` `NULL` are allowed, matching the two
supplied pg_cron/pg_net rows; active relevant DDL is still fail-closed for
`client backend` sessions. Hidden rows are not discarded by an `active` filter.
The contiguous routine scan remains, and a complete inventory guard covers all
non-system, non-extension `prokind` function/procedure definitions containing
the exact `EXECUTE` token. The reviewed production inventory count is `19`
with SHA-256
`3fdc7ecfc40a9d50d789a4b81fda1e7be9e1488f16d9411833f1ea939f4d51a9`, computed
from sorted JSONB schema/name/identity-argument/definition entries joined by
LF; this permits the known unrelated dynamic routines while failing closed on
any addition, removal, edit, or alternate split-literal construction.

The current production relevant active DDL count is `0`. Tracked CI has no
production `supabase db push` entrypoint. A coordinator-only single-writer DDL maintenance window
is required from final preflight through post-apply
verification: only the coordinator may run schema, routine, or publication DDL
during that interval. Target table locks and the advisory lock alone do not
block uncoordinated PostgreSQL DDL, so the active-session checks are point-in-
time fail-closed observations and not a distributed lock. Catalog `SHARE`
locks are not used because the production role privilege checks were false for
`pg_proc`, `pg_publication`, `pg_publication_namespace`, and
`pg_publication_rel`.

## Zero-row archive and isolated restore evidence

The deterministic zero-row dataset is the compact UTF-8 JSON
`[{"table":"public.comment_details","rows":[]},{"table":"public.interaction_logs","rows":[]}]`,
with SHA-256
`bb705113dc6c51ea03e76a8d92f1b1e644809809f6d15615b69b4a2ea36a56ad`. Archive
encryption is excepted for this package. No row payload exists to encrypt; the
exception does not waive schema restoration or verification.

The focused test runs an isolated PGlite restore drill: it extracts only the
commented restore block, creates minimal `anon`, `authenticated`, and
`service_role` roles, `auth.uid()`, `extensions.uuid_generate_v4()`, and the
parent `public.analysis_results` table, then applies and verifies both target
tables. The drill verifies exact column order/types/defaults/nullability,
primary and foreign-key/check constraints, indexes, RLS policies, and grants.
PGlite is a harness only: it does not provide hosted Supabase publication or
catalog primitives, so the active guarded DROP section is not executed and no
production or Management API log evidence is claimed.
No Management API log evidence was collected or claimed.

The coordinator separately verified one disposable local PostgreSQL 17 cluster
over TCP `127.0.0.1` with `-U postgres` using exactly three direct probes:
restricted-role hidden state/query fail-closed (`hidden_guard=t`), EXECUTE
inventory expected-fingerprint stability followed by routine-mutation
detection (`inventory_stable=t`, `inventory_mutation_detected=t`), and
comment-gap plus `FUNCTION`/`PROCEDURE`/`ROUTINE`/`PUBLICATION` active-DDL
lexical matching (`ddl_lexical=t`). The exact cluster was stopped and trashed
after verification; no production service was called or mutated.

The focused destructive-scope verifier now includes EOF statements and marks
dynamic assembled DDL in `DO`/`EXECUTE` blocks as requiring review, including
indented and same-line forms. The active migration still contains exactly the
approved two non-CASCADE `DROP TABLE` statements.

The manifest's bounded observation conclusion is: within the supplied
postmaster-start counters and bounded `app/`/`lib/`/`hooks/`/`scripts/`
inspection, both tables are zero-row and zero-write with no observed
runtime/dependency use. This supports an owner-approval proposal, not an
assertion that all future or external use is impossible; the post-apply
absence and dependency checks are recorded above.

## Draft contract and restoration

`supabase/operations/20260910_retire_comment_interaction_evidence_draft.sql`
remains the reversible SQL artifact for this package. It takes an
access-exclusive lock on the exact two tables, fails closed if either table is
missing, non-empty, or has an incoming foreign key, dependent view/routine,
user trigger, or publication membership, then issues only:

```sql
DROP TABLE public.comment_details;
DROP TABLE public.interaction_logs;
```

The DROP statements do not use `CASCADE`. The file's commented restore block is
executable SQL for an isolated restore and recreates, for both tables, the
original column order/defaults, primary keys, outgoing foreign keys and checks,
`result_id` indexes, RLS enablement and SELECT policies, owner, and the
`PUBLIC`/`anon`/`authenticated` revocations plus `postgres`/`service_role`
grants. Keeping the restore block commented prevents an accidental drop-and-
recreate cycle when the draft is inspected or run after approval.

The generated migration at
`supabase/migrations/20260910123053_retire_comment_interaction_evidence.sql`
contains only the reviewed active transaction, fail-closed guards, and the two
exact non-CASCADE DROP statements. It contains no restore block; the
coordinator performed the independent exact-allowlist dry-run and apply, then
completed the post-apply verification recorded above.

## Verified production outcome

1. Owner approval is recorded for exactly the two qualified names and the hash above.
2. The generated migration was applied only within the reviewed destructive scope.
3. Remote migration history contains the selected migration exactly once.
4. Post-apply read-only absence and dependency checks passed, and the exact
   restore SQL remains available as rollback evidence.

No flag activation, real `0_min._.00` canary, `payment_pending` action, or
landing copy change occurred in this task. The worker performed no production
destructive action; the coordinator's applied migration is the production
action evidenced above.
