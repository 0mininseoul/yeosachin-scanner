# Analysis V2 paid-provider lifecycle runbook

V2 never retries an ambiguous Actor start. Every confirmed Apify run ID is resumed,
stopped, terminalized, and cost-reconciled with the credential slot stored on its ledger row.
The recovery endpoint repeats these operations with bounded concurrency.

## Normal recovery

- `SCRAPING_RUN_PENDING_ERROR` and `SCRAPING_DATASET_TRANSIENT_ERROR` retry the exact
  checkpointed run ID. They never start a replacement Actor.
- A terminal request first records a cleanup intent. That intent freezes new paid-run
  reservations for the request.
- Confirmed `READY` or `RUNNING` runs are aborted. `ABORTING` or `TIMING-OUT` runs are
  waited to a terminal state. Already-terminal runs are confirmed without aborting.
- Terminal usage remains null until the 30-second authenticated reconciliation pass reads
  stable `usageTotalUsd`. Result delivery does not wait for that settlement pass.
- A retried worker loads the original cleanup intent and uses its original job, input hash,
  and error code. It does not rerun the failed stage or replace the failure reason.
- If a worker crashes on its final allowed attempt, the next claim does not fail or purge the
  request in the database. It receives a fresh cleanup-only lease, preserves any earlier
  terminal reason (or records `JOB_ATTEMPTS_EXHAUSTED` when none exists), and enters provider
  cleanup before the stage handler can run.
- Usage reconciliation claims the least-recently-attempted eligible rows. A failed provider
  read receives bounded exponential backoff, so one poisoned row cannot pin the head of the
  reconciliation page.

## Unconfirmed Actor start

A `starting` ledger row with no `run_id` means the Actor start response was ambiguous.
Automation cannot determine whether Apify created a chargeable run, so request failure and
PII purge remain blocked. Recovery reports it as `providerRunsBlocked` and does not invent a
run ID, terminal status, or zero-dollar usage.

1. Wait until the cleanup intent, failed-job lease expiry, provider reservation, and provider
   row update have all been quiet for at least 30 minutes. Every processing job lease for the
   request must also have expired at least 30 minutes ago. The database rejects an earlier
   marker even when the operator is the database owner.
2. In the Apify account for the row's exact `credential_slot`, inspect the stored `actor_id`
   and the complete time window beginning at `reserved_at`. Check both active and terminal
   runs; do not infer absence from the application ledger alone.
3. If an active or terminal matching run may exist, do not resolve the row. Stop or confirm
   that run and investigate manually. Repeat the Apify check immediately before the insert.
4. Only after confirming that no matching run exists, connect as the database owner and
   insert the immutable audit marker below. Runtime and `service_role` intentionally have no
   permission to write this table. Audit text and references must not contain Instagram
   handles, provider tokens, captions, comments, or other user content.

```sql
INSERT INTO public.analysis_v2_unconfirmed_start_resolutions (
    reservation_token,
    request_id,
    job_key,
    operation_key,
    input_hash,
    logical_provider,
    actor_id,
    credential_slot,
    max_charge_usd,
    resolution,
    audit_reason,
    audit_reference,
    audited_by
)
SELECT
    provider_run.reservation_token,
    provider_run.request_id,
    provider_run.job_key,
    provider_run.operation_key,
    provider_run.input_hash,
    provider_run.logical_provider,
    provider_run.actor_id,
    provider_run.credential_slot,
    provider_run.max_charge_usd,
    'confirmed_no_active_run',
    'Apify account and Actor time window manually checked',
    'incident-or-dashboard-reference',
    'operator-identity'
FROM public.analysis_v2_provider_runs AS provider_run
WHERE provider_run.reservation_token = 'replace-with-reservation-uuid'
  AND provider_run.status = 'starting'
  AND provider_run.run_id IS NULL;
```

The trigger locks preflight, request, failed job, cleanup intent, and provider reservation in
the canonical order. It rejects a terminal request, completed cleanup intent, live or recently
expired job lease, a provider row changed during the 30-minute quiet period, and any identity
drift. It then records the database session actor and confirmation time and makes the marker
immutable. Do not bypass a `RESOLUTION_NOT_READY`, `RESOLUTION_NOT_QUIESCENT`, or identity
error with direct table changes.

The original provider row remains `starting`; unknown usage continues to be reported
conservatively at its maximum charge. The next recovery or worker retry completes the original
terminal failure and request purge only after every confirmed run is terminal and every other
ambiguous start has its own valid audit marker.
