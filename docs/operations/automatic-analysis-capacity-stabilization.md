# Automatic-analysis capacity stabilization runbook

This runbook is the launch gate for the split automatic-analysis capacity change. It keeps one codebase and one analysis engine while isolating the preflight and paid workloads at the Cloud Tasks, Cloud Run, and provider-admission layers.

## Approved launch envelope

| Workload | Existing queue / service role | Initial active execution | Expansion gate | Provider boundary |
| --- | --- | ---: | ---: | --- |
| Preflight | `analysis-preflight` / `preflight` | 32 | 64 only after synthetic validation and canary | Apify credentials exactly `primary`, `quinary`, `senary` |
| Paid full analysis | `analysis-v2-pipeline` / `paid` | 8 | 16 or more only after measured canary and release approval | Full followers/following remains on `secondary`; all paid Apify starts use DB-global budgets |

The preflight acceptance target is a 400-request burst with no lost request, duplicate terminal effect, or ownership corruption. The paid acceptance target is at least 200 durably accepted full analyses while provider execution remains globally bounded. The existing eight-slot Gemini database lease remains authoritative; the additive admission budgets do not replace that lease protocol. Paid worker/analysis concurrency is a task/service bound: expanding it from 8 to 16+ does not widen the Gemini ceiling or any existing Apify global, credential-slot, relationship, or rate budget.

## Production gates

All of these gates are required before enabling provider admission in production:

1. Run the deterministic fake-provider harness from the exact release commit:

   ```bash
   npm run load:analysis-capacity
   ```

   The initial-stage JSON report must show `accepted=600`, `terminalized=600`, `lost=0`, `duplicateTerminalEffects=0`, `eventualDrain=true`, `maxPreflightProviderActive===32`, `maxPaidProviderActive===8`, `maxGeminiActive===8`, `workerPreflightConcurrency===32`, and `workerPaidConcurrency===8`; the expanded-stage run must show the same exact provider maxima with `workerPreflightConcurrency===64` and `workerPaidConcurrency===16`. Both reports must include positive capacity-pending, retry/recovery, and fence-rotation evidence, plus independently observed task-create, admission-wrapper, and fake-provider invocation counters. The report labels database contention as `deterministic-serial-fake`; native PostgreSQL contention and EXPLAIN evidence are separate release artifacts. The harness must not resolve or call Apify, Gemini, Cloud Tasks, Cloud Run, Supabase, or any other external provider.

2. Run the targeted admission, PGlite, queue-role, worker-route, and infra contract tests. Then run the scheduler benchmark, full test suite, lint, TypeScript check, production build, and `git diff --check`.

3. Apply only the reviewed migration allowlist. For this change the allowlist is exactly:

   `supabase/migrations/20260831100000_add_analysis_provider_admission_leases.sql`

   In a dirty or mixed worktree, use an isolated temporary Supabase workdir and a dry-run with this exact allowlist. Do not use `--include-all`; verify remote migration history after an approved apply. No remote migration is part of this worker task.

4. Verify the service accounts exist, are enabled, and have only the reviewed IAM bindings. The queue enqueuer is queue-scoped; the worker runtime can invoke only its role-specific private Cloud Run service. The Cloud Tasks OIDC service account, target URL, and audience must match exactly. `--dry-run` and `--check` must complete before any apply.

5. Set `ANALYSIS_PROVIDER_ADMISSION_ENABLED=true` only in a reviewed runtime manifest for the canary. Missing, malformed, or mismatched workload-role configuration is fail-closed. Never use a plaintext provider token or a `latest` secret reference in a deployment manifest.

Active capacity promotion also requires the deployer to perform the same
official Vercel evidence check as release readiness: select the READY production
deployment from `GET /v6/deployments`, fetch
`GET /v2/deployments/{uid-or-id}/aliases` for that exact deployment under the
same token/team context, and bind the public freeze/readiness origin to its
immutable URL or returned alias. The observed Vercel Git SHA and the Cloud Run
`analysis-v2-source-commit` label must equal the reviewed source SHA; a caller
supplied origin or capacity-only SHA is not evidence.

The bootstrap stage is intentionally gate-off: deploy both private role services
with `PREFLIGHT_TASKS_ENABLED=false`, `ANALYSIS_V2_TASKS_ENABLED=false`,
`ANALYSIS_V2_WORKER_ENABLED=false`, and `ANALYSIS_PROVIDER_ADMISSION_ENABLED=false`,
then verify the exact ready revisions, service URL/audience, resources, secrets,
and role-scoped IAM. Before any initial or expanded gate-on revision, freeze the
public V1 producer configuration and beta-prepare intake, pause the legacy
queues, block the old invocation targets, and verify the actual queue state is
empty plus all legacy V1/provider claims and ambiguous runs are zero. Roleless
fresh predecessors are accepted only by the preflight drain path while gates
are off; the readiness barrier must prove that cohort empty before admission is
enabled. A late roleless delivery after the gate is on is terminally rejected
with `ANALYSIS_V2_LEGACY_FRESH_DRAIN_REQUIRED` and `status=legacy_drain_required`
in a 200 acknowledgement, rather than retried
as paid work. Readiness is an authoritative pre-promotion barrier, not a
post-promotion assertion.

## Rollout sequence

### 1. Fake-provider gate

Run the harness and all targeted tests in a clean CI checkout. Capture the machine-readable report as release evidence. A failure in loss, duplicate terminal effects, ownership fences, provider bounds, database contention, or eventual drain blocks the rollout.

### 2. Preflight 32 canary

Configure and deploy only the preflight role with `ANALYSIS_CAPACITY_STAGE=initial` and `ANALYSIS_WORKLOAD_ROLE=preflight`. The durable queue identity is `analysis-preflight`; use `scripts/configure-analysis-capacity-queues.sh --role=preflight --dry-run` and `scripts/deploy-analysis-capacity-workers.sh --role=preflight --dry-run`, review the printed queue target, OIDC audience, runtime identity, service name, max instances, and exact IAM checks, then use `--check` against the deployed resources. Apply the gate-on revision with `--no-traffic`, capture and verify its exact `latestCreatedRevisionName`/Ready revision and provenance, run readiness, and promote with `--to-revisions=CAPTURED_REVISION=100`; never promote `latest`. Apply only after the dry-run and approval gates pass.

Send a controlled burst, first below 32 active provider starts and then at the 400-request acceptance target. Observe queue age, task retry count, dispatch failures, admission `capacity_pending`, lease expiry/recovery, Apify starts by role and credential, Gemini lease occupancy, database lock/wait time, terminal transition counts, and ownership-fence conflicts. The worker bound may be 32 initially and 64 after expansion, but the database-global preflight Apify provider ceiling remains exactly 32 in both stages. Roll back if any request is lost, any terminal effect is duplicated, any owner fence is violated, any provider start exceeds the global/slot budget, or recovery does not drain within the bounded maintenance window.

### 3. Preflight expansion to 64

Set `ANALYSIS_CAPACITY_EXPANSION_CANARY=true` only after the 32 worker/provider canary has passed its agreed observation window and the fake-provider report has been attached to the release. Then run the same no-traffic staged dry-run/check/apply, exact revision readiness, and captured-revision promotion sequence with `ANALYSIS_CAPACITY_STAGE=expanded`. Worker concurrency becomes 64, while the preflight Apify provider ceiling remains exactly 32; do not increase provider budgets or route work to the exhausted tenth token. The preflight pool remains exactly `primary,quinary,senary`.

### 4. Paid 8 canary

Configure and deploy the paid role independently with `ANALYSIS_CAPACITY_STAGE=initial`, `ANALYSIS_WORKLOAD_ROLE=paid`, and the paid target URL/audience/service identity. The durable queue identity is `analysis-v2-pipeline`; new paid fresh-admission tasks use this queue and `/api/analysis/v2/worker`. During the gates-off mixed-version window only, legacy roleless fresh-admission tasks drain on `analysis-preflight`; do not enable admission until that cohort is empty. Use the same no-traffic exact-revision/readiness/captured-revision promotion sequence. Admit at least 200 paid requests durably, but keep active paid worker execution at 8 and paid Apify/Gemini provider ceilings at 8. Verify that preflight queue age and admission success are unchanged while paid work drains. Full followers/following must remain on the secondary credential and be covered by the relationship-specific budget.

### 5. Paid expansion

Only after a measured paid canary and explicit release approval may `ANALYSIS_CAPACITY_STAGE=expanded` enable 16 or more paid workers. Expansion requires `ANALYSIS_CAPACITY_EXPANSION_CANARY=true`, fresh synthetic evidence, and observed provider/database headroom. Worker concurrency becomes 16+, while paid Apify and Gemini provider ceilings remain exactly 8 and 8; a higher worker bound never bypasses the database-global provider admission or the existing Gemini lease.

## Recovery, retry, and rollback

Repeated task delivery is safe because the durable request/job generation and provider operation identity are claimed before execution. New task payloads declare `workloadRole`; legacy roleless payloads are accepted only by their existing queue/service for drain compatibility, and any explicitly mismatched role is rejected. A live admission replay returns `already_acquired`; a stale or expired fence cannot renew or release the current owner. The bounded recovery pass lists expired admissions, rotates the recovery fence, and replays only rows that remain expired. Ambiguous provider starts retain the admission and provider-run checkpoint for authoritative reconciliation; they are never blindly restarted.

On rollback, first stop admission of the affected role, then deploy the last known-good role-specific service and queue configuration. Keep the database migration in place: the additive tables/RPCs are inert when `ANALYSIS_PROVIDER_ADMISSION_ENABLED=false`, and removing them before all leases and provider-run reconciliation are settled is unsafe. Re-run the recovery endpoint and verify zero active/unreconciled admissions, no pending ownership fences, and stable terminal counts before any migration cleanup.

The deployment scripts are intentionally separate from the existing legacy queue script. A dry-run prints mutations without invoking `gcloud`; `--check` reports drift without mutating resources; apply re-verifies the observed service account, concurrency, max scale, role, admission gate, queue target, and OIDC audience. Any collision between role queues, services, target URLs, or audiences fails closed. The scripts default to check-only; `--apply` is required for mutation.

## Initial-stage service-account identity roll-forward

An already-serving `initial` worker sometimes has to adopt a rotated identity
set: a new Cloud Tasks caller, a new Cloud Run runtime identity, and a role
enqueuer environment value that the serving revision never carried. Ordinary
verification is exact and rejects all three, so this rotation needs the explicit
`--allow-initial-identity-roll-forward` allowance. Never hardcode the prior
identities anywhere; supply them per run.

**The allowance is preflight-only.** The active public runtime publishes a
producer-configuration fingerprint for the preflight producer contract only, so
preflight is the sole role where the deployer can prove from published evidence
that the rotated caller/target/audience is already the live producer contract
before the worker adopts it. There is no equivalent published evidence for the
paid producer, so `--allow-initial-identity-roll-forward` is refused outright for
`--role=paid`, before any observation or mutation. This is a limitation of the
current published evidence, not a claim that paid has no producer: a paid
identity rotation needs its own reviewed evidence path and is out of scope here.
Ordinary paid apply behaviour is unchanged and stays exact — a drifted paid task
caller, target URL, or OIDC audience still fails closed.

The allowance is accepted only when every one of these holds:

- `--role=preflight`;
- an explicit `--apply` together with `--reconcile-iam` — the invoker binding
  must be rotated onto the new caller, so a check/dry-run is refused;
- target stage `initial` and observed stage `initial`, and never combined with
  `--allow-bootstrap-initial-transition`;
- the complete externally supplied prior-state assertion set
  `ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_TASK_SERVICE_ACCOUNT_EMAIL`,
  `..._OLD_ENQUEUER_SERVICE_ACCOUNT_EMAIL` (the literal `absent` when the
  serving revision carries no enqueuer value), `..._OLD_RUNTIME_SERVICE_ACCOUNT_EMAIL`,
  and `..._OLD_SOURCE_SHA`, each matching the observed service exactly. Every
  prior identity must be a service account in the task project, must differ from
  all eight desired workload identities and the build identity, and must be
  pairwise distinct; the prior source SHA must differ from the reviewed source
  SHA. Supplying any of these assertions *without* the flag is rejected before
  anything is observed;
- the role's own target queue matches the full resource identity
  `projects/PROJECT/locations/LOCATION/queues/QUEUE` exactly — a same-named queue
  in another project or region is refused — and is `PAUSED` and observably empty,
  so no in-flight task can still carry the prior caller identity;
- the preflight recovery scheduler is provably quiescent. A `PAUSED` Cloud Tasks
  queue still accepts `createTask`, and the currently serving recovery endpoint
  enqueues with the *old* caller identity, so an every-minute scheduler that is
  still `ENABLED` can put an old-caller task into the queue after it was observed
  empty. The guard therefore requires the exact job resource
  `projects/PROJECT/locations/LOCATION/jobs/JOB` in state `PAUSED` with its
  reviewed attempt-deadline and retry contract, plus an externally supplied
  `ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_PREFLIGHT_RECOVERY_PAUSE_EPOCH`
  (strict decimal epoch seconds, not in the future) that is at least 660 seconds
  old — the deployed Cloud Run request timeout of 600s plus grace. Take that
  epoch as the audited pause time rounded **up** to the next whole second;
  observed attempt timestamps are likewise rounded up, so a sub-second remainder
  can never buy up to 0.999s of extra apparent age. The job name and the
  resolved scheduler location (`PREFLIGHT_TASKS_MAINTENANCE_LOCATION`, falling
  back to the Cloud Run region — not the Cloud Tasks queue location) are
  validated before either reaches a `gcloud` argument. **An absent
  `lastAttemptTime` never proves drain:** a paused job has been observed to stop
  reporting it seconds after a real attempt, so the aged pause assertion is
  mandatory and a *present* `lastAttemptTime` inside the window is also refused.
  `userUpdateTime` is documented as creation time and is never used as pause time;
- all eight desired workload identities — preflight and paid
  task/enqueuer/runtime/maintenance — are pairwise distinct, and the reviewed
  runtime manifest already carries the desired role enqueuer value;
- the complete published Vercel evidence chain already agrees with the desired
  contract: the selected READY production deployment's Git SHA equals the
  reviewed source SHA, the public freeze origin is bound to that exact
  deployment URL or one of its returned aliases, the next-deploy production
  environment metadata carries the required producer keys with no hidden
  production values, and the active producer fingerprint matches the desired
  caller/target/audience;
- the existing service IAM already carries exactly one unconditioned
  `roles/run.invoker` binding whose members are exactly the asserted prior task
  caller and the unchanged current maintenance caller. An extra member, a public
  or `allAuthenticatedUsers` member, an IAM condition, a missing member, more
  than one invoker binding, or no invoker binding at all is refused before
  `set-iam-policy` runs.

All of that evidence is gathered before any service, IAM, or deploy mutation.
(The generation-bound GCS deploy lock is acquired earlier — it is this run's
mutual-exclusion token, not a change to the service, its IAM, or its revisions.)
The evidence is then re-proven a
second time in one dedicated **final mutation barrier** immediately before the
single `set-iam-policy` call, because a read-then-write gap is exactly where an
out-of-band change would slip through. The barrier re-describes the exact paused
and empty target queue, re-checks the recovery scheduler and the aged pause
assertion, re-runs the complete Vercel evidence chain, re-reads the service and
requires the *same* `metadata.resourceVersion` and `metadata.generation` plus the
exact asserted prior task/enqueuer/runtime identities, prior source SHA, and the
captured serving traffic allocation, and finally re-reads the IAM policy and
requires the exact prior invoker binding together with a non-empty `etag`. The
desired policy is then built from that latest policy JSON with the `etag`
preserved, written with exactly one `set-iam-policy` call and no retry, and read
back; the observed policy must equal the intended policy modulo the new
server-issued `etag`, so any unrelated binding change, added binding or member,
introduced condition, or changed policy version fails the run before
`gcloud run deploy`. If the invoker binding has independently become the desired
binding between reads, the run fails closed rather than treating it as success.

The allowance is predeploy-only and covers only the three identity values.
Arbitrary environment, source, maintenance, target, audience, queue, stage, and
traffic checks stay exact; under the flag the source provenance must equal the
externally asserted prior SHA rather than any syntactically valid older SHA. The
staged revision is verified exactly against the reviewed manifest and runtime
identity, and the promoted revision is verified exactly again; post-promotion
drift of the task caller, the enqueuer, or the runtime identity each
independently triggers the automatic rollback.

An exceptional run never resumes the recovery scheduler. On success it re-proves
the job is still `PAUSED` and reports the resume as deferred; every failure path
also leaves it paused. The external final rollout owns the sole resume of both
recovery schedulers and both queues, after both role deploys, Vercel, IAM, logs,
ledger, and provider-free probes have all passed.

### What rollback actually does

Be precise about this when handling a failure. **The automatic rollback restores
traffic only.** It moves the serving allocation back to the exact captured
pre-deploy revision and verifies that it matches; it does *not* redeploy the
previous source, and it does *not* restore the previous IAM policy. A
`set-iam-policy` that already succeeded stays applied.

So after a failed identity roll-forward:

- the target queue stays `PAUSED` and the recovery scheduler stays `PAUSED`;
- if the failure happened *after* the invoker rotation, the service is already
  serving the rotated invoker binding. Restoring the prior binding is a separate,
  explicit operator step that must itself be verified against a freshly read
  policy and its `etag` before any retry;
- because the queue was paused and empty before the rotation, no task is stranded
  on a caller identity that has lost invoke permission.

Re-enable the queue and the recovery scheduler only after the promoted revision
verifies and the final rollout checks pass.

## Observability and stop thresholds

Page the on-call and stop the canary for any one of the following:

- lost admission, duplicate terminal effect, duplicate ownership, or a task claimed by the wrong workload role;
- `maxPreflightProviderActive > 32` during the initial stage, `maxPaidProviderActive > 8`, or Gemini active leases above 8;
- a preflight start using a credential other than `primary`, `quinary`, or `senary`, or full followers/following using anything other than `secondary`;
- increasing `capacity_pending` with no eventual drain, lease recovery failures, database lock timeouts/deadlocks, or unbounded retry growth;
- target URL, OIDC audience, service account, queue, or IAM drift;
- any provider call in a fake-provider gate or any unexpected provider credit usage.

Keep the release evidence: fake-provider JSON, targeted and full test logs, scheduler benchmark output, migration dry-run/check output, `EXPLAIN (FORMAT JSON)` for the expiry-recovery index, and post-canary aggregate counters. The B-lite redesign and later Supabase table-reduction cleanup are separate work and are not prerequisites for this rollout.
