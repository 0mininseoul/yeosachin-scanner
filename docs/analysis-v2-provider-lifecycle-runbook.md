# Analysis V2 paid-provider lifecycle runbook

V2 never retries an ambiguous Actor start. Every confirmed Apify run ID is resumed,
stopped, terminalized, and cost-reconciled with the credential slot stored on its ledger row.
The recovery endpoint repeats these operations with bounded concurrency.

## Worker time-window contract

The current Cloud Run request timeout and Cloud Tasks dispatch deadline are both 600 seconds. A
current-contract V2 job claim uses the same 600-second lease, while the route stops admitting new
paid AI work at 540 seconds. This reserves the final 60 seconds for result checkpointing and
fence release.

The route module's `maxDuration` remains 300 seconds so a Vercel Hobby build stays valid; Cloud
Tasks targets the canonical Cloud Run worker, where the independent 600-second request timeout
applies.

The Gemini SDK timeout (210 seconds) and its 15-second durable commit reserve are intentionally
unchanged. If `ANALYSIS_V2_AI_DEADLINE_TOO_SHORT` rises, inspect queue delivery, worker timeout,
and job-lease drift before altering model policy, concurrency, or retry behavior.

Tasks created under this contract carry `X-Analysis-V2-Worker-Contract: 2` inside the
OIDC-authenticated Cloud Tasks request. The strict task body remains unchanged so an older worker
can safely ignore the header. An absent or unknown header remains on the original 300-second
handler and 360-second lease contract. This prevents a rolling worker deploy from making a
pre-existing 300-second delivery outlive its Cloud Tasks deadline.

Rollback must restore the route, task dispatch, Cloud Run timeout, and claim-lease values as one
release. Do not roll back only one surface while jobs are live: allow their current 600-second
leases to expire or complete first, then verify recovery has re-enqueued only fenced work.

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

### 2026-08-30 paid-analysis stabilization

The forward-only stabilization migrations are applied in filename order:
`20260830100000_retain_succeeded_direct_fresh_checkpoint.sql` (progress merge),
`20260830101000_retain_succeeded_direct_fresh_checkpoint.sql` (direct-fresh retry admission),
`20260830102000_add_analysis_v2_terminal_failure_takeover.sql` (intent-owned crash-window
takeover), then `20260830103000_scope_analysis_v2_provider_cleanup.sql` (exact cleanup-intent
reader). Do not apply these migrations piecemeal or replay the incident order.

An exact succeeded direct-fresh provider row is admissible after a legitimate job claim rotates:
the reservation identity and run ID remain immutable, while the current job claim is a separate
execution fence. The retry admission RPC returns only a fully attributed, completed checkpoint;
it rejects mixed fallback/repair rows, missing provider proof, input drift, or ambiguous starts
with sanitized `ANALYSIS_V2_PROFILE_RETRY_ADMISSION_*` reason codes. It does not call Apify.

Cleanup intent is the request-level terminalization authority. While it is pending, the
request-wide reserve/list/settle wrappers reject new sibling provider starts and reconcile every
provider row for the request; the exact job reader only returns the intent for its immutable failed
job key and `analysis_pipeline_jobs.input_hash` fence. If no running provider row or unconfirmed
`starting` row remains, `takeover_analysis_v2_terminal_failure` transfers the live execution fence
immediately without incrementing attempts; repeated delivery by the current owner is idempotent
and a competing live owner is fenced. The request-level finalizer marks the request terminal only
after all active/ambiguous provider rows are resolved, preserving spend safety.

The paid return path redirects server-side to the owner-scoped progress route as soon as a
request ID exists. The progress media rail is an accumulated, non-gating presentation surface:
it retains loaded candidates across refreshes, account changes, publication-lag snapshots, and
transient image errors. Only an EPIPE paired with this image-proxy request's aborted client
signal is benign route-local observability noise; an EPIPE without that route-specific abort
remains logged. The global Next request-error boundary applies the same narrow rule using only
the exact GET route metadata because it does not expose the response signal.

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

## Profile-batch repair (third attempt)

A profile batch resolves in up to three attempts per username: `primary` (cache or the
self-hosted crawler), `fallback` (`apify/instagram-profile-scraper`), and `repair`
(`apify/instagram-scraper`, build `0.0.692`). Repair exists because the fallback actor
intermittently omits a few usernames from a batch, leaving it below the fail-closed 90%
per-batch completeness gate. Repair re-runs the still-failed subset through a different actor.

- **At most once per batch.** Repair runs only when the merged primary+fallback evidence fails
  the 90% gate and only over the frozen-unresolved usernames still `failed` after the merge.
  `unavailable` accounts are never repaired. Once `repair_completed_at` is set the batch never
  starts a second repair run, even a repair that resolved nothing — a completed-but-insufficient
  repair fails the batch terminally rather than spending again.
- **Own ledger row, shared slot.** A repair run reserves its own `analysis_v2_provider_runs` row
  under the `profile-repair:<sha256>` operation key, so it coexists with the batch's
  `profile-fallback:<sha256>` row. Its credential slot resolves through the `profile-fallback`
  slot of the authorized-test policy — no eighth slot is added to the seven-key slot map.
- **Cost.** The pinned rate is 0.0027 USD per result with a hard 0.09 USD cap enforced twice
  (before the run and after, against the actor's reported usage). A full 30-username repair is at
  most 0.081 USD; the observed shortfall of three usernames is 0.0081 USD.
- **Repair adds a route to success, never budget.** A failed repair is the batch's most recent
  terminal evidence and is still counted against the 90% gate. The gate predicate is unchanged;
  repair can only move a username from `failed` to `success`, never widen the failure budget.
- **RESTRICTED pinning is preserved.** The repair actor's run, key-value store, dataset, and
  request queue are pinned to `RESTRICTED` before the dataset is read; a run that cannot be
  pinned raises `SCRAPING_ACCESS_ERROR` and no repair is checkpointed.
- **Failure semantics reuse the fallback path.** `SCRAPING_RUN_PENDING_ERROR` retries the same
  checkpointed repair run (never a replacement); a terminal actor failure or an ambiguous start
  is handled by the same cleanup-intent and reconciliation machinery described above. A repair
  is checkpointed only on a durable terminal outcome set, so a transport or run barrier is never
  sealed as synthetic failures.
- **Observability.** Repair outcomes are counted in `analysis_v2_profile_fetch_telemetry` under
  `source = 'repair'`, separable from `fallback`, so repair volume, failure categories, and
  latency are visible at the operational read boundary.
