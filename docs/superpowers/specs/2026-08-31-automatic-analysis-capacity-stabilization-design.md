# Automatic-analysis capacity stabilization design

Status: approved implementation baseline

Date: 2026-08-31

Base: `0mininseoul/production-analysis-structural-stabilization` at
`9645cde2db31c067d639fde953fba41ffc1623da`

## Objective and fixed launch boundaries

The service must durably absorb a burst of 400 preflight submissions and at
least 200 paid admissions without losing a request, producing duplicate
terminal effects, corrupting ownership, or allowing provider execution to
escape a database-global budget. The existing V2 DAG, provider-run ledger,
Gemini lease table, result finalizer, and recovery worker remain the one
analysis engine. This extension adds workload roles, admission gates, and
queue/service isolation around those components.

The following values are fixed for launch and are not implementation knobs:

| workload | queue target | initial active limit | expansion gate |
| --- | --- | ---: | --- |
| preflight | existing `analysis-preflight` and `/api/analysis/preflight/worker` | 32 Cloud Run requests | synthetic proof, then canary to 64 |
| paid analysis | existing `analysis-v2-pipeline` and `/api/analysis/v2/worker` | 8 active analyses | synthetic proof, then canary to 16+ |

The preflight credential pool is exactly `primary,quinary,senary`; the
exhausted tenth token is never selected for new preflight work. Full
followers/following remains on the secondary credential and is covered by a
database-global provider budget. Gemini keeps its existing eight-slot global
fenced lease protocol. Apify paid starts, including retries and lease
recovery, receive the same database-global fenced admission treatment rather
than a process-local semaphore.

## Workload-role isolation

`ANALYSIS_WORKLOAD_ROLE` is mandatory on worker runtimes and accepts only
`preflight` or `paid`. A preflight process may acknowledge only a preflight
task contract and may not execute a paid job; a paid process may acknowledge
only the paid V2 task contract and may not execute a preflight task. Missing or
unknown runtime roles, and any explicitly mismatched task role, fail closed
with a retryable 503 before any provider call. During mixed-version drain, a
legacy task payload may omit `workloadRole`; the receiving role's queue/service
is then authoritative, while an explicitly declared opposite role is always
rejected. The role is persisted in new task payloads and provider admission
identity, so a split-service rollout cannot accidentally run a declared task
on the wrong service.

Each role has an independent Cloud Tasks queue, Cloud Run service, target URL,
OIDC audience, task invoker identity, and runtime service account. Queue
configuration uses exact queue IAM and checks the service's canonical URL and
attached runtime identity. Deployment scripts support `--dry-run`, `--check`,
and `--apply` with the same validation path; apply is the only mode allowed to
mutate infrastructure. Rollback consists of closing the admission gate,
draining each queue independently, and restoring the previous role-specific
revision/limits; the two queues are never merged during rollback.

## Database-global provider admission

The additive `analysis_provider_admission_leases` table is the authority for
provider start admission. A row is keyed by workload role, logical provider,
credential slot, and budget bucket. It stores an owner operation identity,
lease token, monotonic fence, expiry, reservation cost, and timestamps. RPCs
are `SECURITY DEFINER`, set `search_path = ''`, are executable only by
`service_role`, and validate request/job ownership through existing fenced
ledgers. No anonymous or authenticated role can read, write, or execute the
privileged helpers.

The acquire RPC is idempotent for the same operation identity and returns one
of `acquired`, `already_acquired`, or `capacity_pending`. Renew and release
require both token and fence. Expired claims are recoverable only through a
separate recovery RPC that rotates the fence; a concurrent stale owner cannot
release or checkpoint a newer owner. The request/job/provider operation key is
the idempotency key. Existing `analysis_v2_provider_runs`, revenue cost
operations, and Gemini leases remain the cost and terminal truth; the new row
only gates a provider start and is released after a terminal checkpoint or a
safe durable rejection.

Launch budgets are explicit and immutable in the migration:

* preflight Apify profile starts: 32 active claims, split across the exact
  three-token pool;
* paid Apify starts: 8 active claims globally, with secondary-only
  followers/following admissions and a per-slot rate budget;
* Gemini: existing eight fenced slots, retained unchanged.

The paid worker/analysis concurrency setting (8 initially, 16+ only behind a
measured canary) is a task/service execution bound, not a provider-budget
widening. It does not increase the Gemini eight-slot ceiling or any Apify
global, slot, relationship, or rate budget; excess provider starts remain
`capacity_pending` until the database-global admission becomes available.

The runtime acquires the provider lease before the first external Apify start,
persists the provider-run reservation before calling Apify, and never retries
an ambiguous start. A rejected or expired claim is released without creating a
replacement operation; a confirmed run is resumed from its immutable run ID.

## Idempotency and terminal effects

Task names remain deterministic from request/job/generation. The task body
contains the role, request, job, generation, and reservation token. Fresh paid
admission uses the existing `analysis-v2-pipeline` queue/service with an
explicit `fresh_admission` payload; old fresh-admission tasks continue draining
on `analysis-preflight`. The worker claims the durable job before execution and
checks role plus claim fence. A duplicate Cloud Tasks delivery therefore
becomes an idempotent replay or a fenced no-op. Result publication and failure
terminalization continue to use compare-and-set RPCs; analytics and
notifications are fail-open and cannot create a second terminal effect.

Provider admission identity is carried through reserve/start/checkpoint/release
and recovery. Concurrent recovery can rotate an expired admission fence only
once. A second recovery observes the new live owner and does not start a
provider. Split-service rollout is safe because new tasks declare their role,
legacy roleless payloads drain only on their existing queue/service, and an
explicit role mismatch is rejected before claim or provider activity.

## Deterministic load proof

The repository includes a test-only fake Apify/Gemini provider registry and a
reproducible in-memory load harness. The harness submits 400 preflight and 200
paid admissions, injects duplicate deliveries and expired-lease recovery, and
drains under the role limits. It emits machine-checkable JSON aggregates:
accepted/lost/terminal/duplicate-terminal counts, maximum preflight and paid
provider concurrency, maximum Gemini concurrency, database contention/lock
wait counters, and a boolean eventual-drain result. Initial and expanded
reports must each observe exact preflight Apify=32, paid Apify=8, and
Gemini=8; worker execution bounds are separate observations of 32/8 initially
and 64/16 when expanded. Fake providers can only be
selected when `ANALYSIS_FAKE_PROVIDER_MODE=load` and a test-only capability is
passed; production configuration rejects the mode and never falls through to
real credentials.

Representative SQL/PGlite tests cover acquire idempotency, fenced renew/release,
expiry recovery, role and credential budgets, concurrent claims, and restrictive
ACLs. EXPLAIN evidence is captured for the hot claim and expiry indexes where
the local PostgreSQL/PGlite runtime supports it.

## Launch-critical versus later cleanup

Launch-critical: role-aware task payloads and gates; separate queue/service
configuration; global provider admission migration and runtime adapter;
provider-start integration; deterministic fake providers; idempotent duplicate
delivery/recovery tests; load harness; migration/infra contracts; and English
and Korean rollout/rollback runbooks.

Later cleanup: reducing or consolidating legacy Supabase tables, removing old
provider/recovery RPC aliases, and rewriting historical migration chains. That
cleanup is explicitly out of scope and must not be mixed into this release.

## Rollout and rollback gates

1. Run all fake-provider unit, PGlite, SQL contract, and load tests. No paid
   provider or external network calls are permitted.
2. Apply only the migration allowlist recorded in the release plan after a
   dry-run and history check. Verify ACLs, indexes, and role budgets.
3. Deploy both services with gates off. Run `--check` against exact URLs,
   audiences, IAM, role, queue, and concurrency settings.
4. Bootstrap both private services with all execution/admission gates off,
   verify the exact serving revisions and role-scoped IAM/configuration, then
   freeze V1 producers, pause and drain the old target queues, block old
   invocation targets, and prove zero legacy live claims/ambiguous runs before
   any gate-on promotion. Deploy the gate-on preflight revision with
   `--no-traffic`, verify that exact staged revision, run the authoritative
   readiness barrier immediately before promotion, and promote that captured
   revision (never `--to-latest`). Canary preflight at 32 worker requests;
   expand workers to 64 only after zero loss/duplicate terminal effects, zero
   fence violations, bounded DB contention, and eventual drain. The
   database-global preflight Apify ceiling remains exactly 32 in both stages.
5. Canary paid analysis at 8 worker executions using the same staged,
   captured-revision promotion and readiness barrier. Promote workers to 16+
   only after the same invariants and an explicit canary gate; the paid Apify
   and Gemini ceilings remain exactly 8 and 8, respectively, with no ambiguous
   starts or unimplemented provider-budget widening.
6. Enable intake gates in this order: preflight, then paid admission. Keep
   recovery enabled throughout and record queue age, pending admission,
   provider active claims, lease-expiry recovery, and terminalization rates.

On rollback, disable only the affected intake gate, leave already accepted
work recoverable, stop scaling the affected role, and drain its queue. Do
not mutate payment status, cancel an ambiguous provider run, or reuse the
other role's queue/service. Restore the prior revision and run the same
`--check` plus a duplicate-delivery/recovery smoke test before reopening.
