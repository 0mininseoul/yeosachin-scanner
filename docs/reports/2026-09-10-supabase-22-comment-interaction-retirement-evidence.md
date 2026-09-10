# Supabase 22 comment/interactions retirement approval evidence

Captured 2026-09-10 as an evidence-only package. The production facts below
were independently collected by the coordinator; this worker made no remote
service call, applied no Supabase migration, and performed no production DROP.
The owner has separately approved the exact ordered allowlist below, while the
generated migration remains approved-but-not-applied. The already verified
account-deletion post-apply evidence is included through cherry-picked commit
`18426f8fb5b2d23d5d86c912dc805d7a2bd32220`.

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
`supabase/migrations/20260910123053_retire_comment_interaction_evidence.sql`.
The migration is approved-but-not-applied; destructive operations remain
refused, and the reversible draft SQL remains under `supabase/operations/`.

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

The manifest's bounded observation conclusion is: within the supplied
postmaster-start counters and bounded `app/`/`lib/`/`hooks/`/`scripts/`
inspection, both tables are zero-row and zero-write with no observed
runtime/dependency use. This supports an owner-approval proposal, not an
assertion that all future or external use is impossible.

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
coordinator owns its independent exact-allowlist dry-run, apply, and
post-apply verification.

## Remaining gates

1. Owner approval is recorded for exactly the two qualified names and the hash above.
2. The generated migration is approved-but-not-applied and must remain limited
   to the reviewed destructive scope.
3. Run a dry-run and apply only that allowlisted migration, then verify remote
   migration history.
4. Perform post-apply read-only absence/dependency checks and retain the exact
   restore SQL as rollback evidence.

No flag activation, real `0_min._.00` canary, `payment_pending` action, landing
copy change, or production destructive action occurred in this task.
