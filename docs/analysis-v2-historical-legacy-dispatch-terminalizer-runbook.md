# V2 historical legacy-dispatch terminalizer runbook

This runbook is for the one owner-authorized historical cohort behind the V2 capacity gate. It is deliberately narrow: a candidate must be a V2 request already in `failed`, have exactly roleless legacy delivered-job provenance, be at least seven days old, and have a pending job with no lease or a processing job whose lease has expired. The request/job may have zero, one, or multiple provider-run ledger rows; when rows exist, every row must be terminal and reconciled, and each row carrying `conservative_max_charge` must satisfy its recorded evidence invariants. A job does not need a conservative max-charge row, and no provider row is created or changed by this action.

The terminalizer is a database-owner action. The candidate and resolver functions have no execute grant for `PUBLIC`, `anon`, `authenticated`, or `service_role`; use the reviewed database-owner session that owns the migration. Do not use `/api/analysis/v2/recover`: this operation has no runtime adapter and must not execute a provider cleanup path.

## Before the action

1. Confirm that the reviewed migration is present in the deployment's migration history and that no unrelated migration is being applied in the same change window. This runbook does not authorize applying a remote migration from a feature worktree.
2. In the owner session, list at most six rows:

   ```sql
   SELECT public.list_analysis_v2_historical_legacy_dispatch_candidates(6);
   ```

3. Stop if the result is not exactly the five expected rows. Do not add a row by hand, substitute a request/job identity, or continue from a stale candidate file. The returned fields are sanitized ledger identity and timing fields only; do not copy user/profile data into an evidence packet.
4. Confirm that every selected row is still from the already reconciled cohort. The resolver repeats every gate while locking the request and job, so an active, unreconciled, malformed, or otherwise nonterminal provider row, a changed lease, provider admission lease, queue claim, cleanup intent, AI attempt, generation lease, budget reservation, or active revenue-cost child aborts the call. A valid `rejected` provider row is terminal and reconciled when it has no `run_id` or `run_started_at`, `actual_usage_usd = 0`, and non-null terminal/reconciliation timestamps; it does not require a provider run ID.

## Generate and execute

Create a temporary candidate JSON file outside the repository with mode `0400` or `0600`. Keep only the exact five RPC rows and the fields emitted by the candidate function; the two manual-resolution fields are either both present for a valid conservative resolution or both `null` when no such row exists. Compute an owner evidence SHA-256 over the separately retained, sanitized audit reference; never put credentials, cookies, provider payloads, usernames, captions, or raw exports in the file.

Generate a private SQL file outside the repository. The generator requires exactly five unique request/job identities, binds every dispatch pre-state field, and defaults to the bounded `failed` transition:

```bash
npx tsx scripts/generate-analysis-v2-historical-legacy-dispatch-terminalizer.ts \
  --input /private/path/historical-legacy-candidates.json \
  --output /private/path/historical-legacy-terminalization.sql \
  --audit-evidence-hash <lowercase-sha256>
```

Review the generated file for five calls to `public.resolve_analysis_v2_historical_legacy_dispatch`, then execute it in the database-owner session. The resolver creates one immutable receipt per request/job and changes only the job lifecycle fields: it clears stale job lease fields, sets `failed` (or an explicitly selected `cancelled` status), records the bounded error code and timestamps, and leaves dispatch provenance and all request, payment, user, result, provider, AI, queue, cleanup, and revenue ledgers untouched.

## Verify and close

In the same owner session, rerun the candidate query and inspect the capacity readiness snapshot:

```sql
SELECT public.list_analysis_v2_historical_legacy_dispatch_candidates(6);
SELECT public.analysis_capacity_activation_readiness();
```

The candidate result must be `[]`; `legacyActiveQueuedV2Tasks` must decrease only by the exact rows resolved (expected final value for this incident: `0`). A second execution with the unchanged generated file is an idempotent replay and must return the existing receipt; any identity or evidence drift must fail closed. Do not mutate `payment_pending`, queue/scheduler state, request status, user/result records, provider rows, or revenue-cost rows, and do not run a canary or provider/AI call as part of verification.

After recording sanitized counts, the owner should remove the temporary candidate and generated SQL files using the organization's recoverable secure-file procedure. Retain only the immutable receipt identifiers, row count, transition status, bounded error code, readiness count, and audit evidence hash; never retain raw candidate exports or secrets in the repository.
