# B-lite fallback production investigation

Date: 2026-09-05 (Asia/Seoul)

## Executive finding

The recurring fallback is confirmed as a Cloud Tasks target version-skew defect, not a B-lite cohort gate, provider outage, or capacity rejection. Production Vercel is publishing preflight tasks to the legacy `analysis-worker` origin while the dedicated `analysis-preflight-worker` is the intended preflight target. The producer now adds `workloadRole: "preflight"`, but the legacy worker revision predates that contract and uses a strict Zod schema, so it rejects every delivered task as `INVALID_REQUEST` before `processPreflight`, `selectBliteCohort`, or `runPrecheckoutBlite` can execute.

Confidence: high (approximately 0.99). The direct target URL value was masked by Vercel and was not printed; the receiver-side Cloud Run evidence, source provenance, and matching authorization behavior establish the normalized target as the legacy service.

## Query windows and safety boundary

- Incident runtime window: `2026-09-04T16:00:00Z` through `2026-09-04T18:00:00Z`, which is 2026-09-05 01:00 through 03:00 KST.
- Vercel B-lite polling slice: `2026-09-04T16:00:00Z` through `2026-09-04T17:20:00Z`, or 01:00 through 02:20 KST.
- Recent sanitized Supabase REST slice: queried over `2026-09-02T17:19:00Z` through `2026-09-05T17:19:00Z`; KST buckets were used for interpretation. Only aggregate, non-identifier columns were selected.
- No production mutation, paid Apify call, order/payment canary, or payment status change was performed. Amplitude was not queried because the Cloud Run, Vercel, queue, and sanitized database evidence was already conclusive; no raw export was created.

## Production evidence

| Source | Sanitized result | Meaning |
| --- | --- | --- |
| Cloud Run `analysis-worker`, 2026-09-04 16:00Z hour | 4 POSTs to `/api/analysis/preflight/worker`; all HTTP 400; structured events were `preflight.failed`, `disposition=rejected`, `error_code=INVALID_REQUEST` | The legacy service received preflight tasks and rejected them at request parsing. |
| Cloud Run `analysis-worker`, 2026-09-04 17:00Z hour | 16 POSTs to the same route; all HTTP 400 with the same structured outcome | The failure recurred across both incident hours, not a single transient request. |
| Cloud Run `analysis-preflight-worker`, incident window | 0 POSTs to `/api/analysis/preflight/worker`; only scheduled `/api/analysis/preflight/recover` 200 traffic | The dedicated worker was not the task destination. |
| Cloud Tasks `analysis-preflight` | Queue `RUNNING`, max concurrency 32, 0 pending tasks at inspection; old `analysis-pipeline` was paused | Queue availability was not the blocker. Tasks were dispatched and reached the wrong service. |
| Vercel production environment | `PRECHECKOUT_BLITE_ENABLED=true`, `PRECHECKOUT_BLITE_ROLLOUT_PERCENT=100`; preflight target and audience variables were present but masked/sensitive | B-lite was enabled for all cohorts. The incident was not caused by `off` or `0%`. |
| Cloud Run environment | Both services had B-lite enabled at 100%; dedicated worker had `ANALYSIS_WORKLOAD_ROLE=preflight` and preflight tasks enabled | The worker-side gate was also open; dedicated runtime was configured for the rollout. |
| Vercel runtime logs, B-lite polling slice | 39 serverless and 17 middleware POST records to `/api/analysis/precheckout-blite`, all HTTP 204; preflight GETs returned 200 | The UI polled the B-lite endpoint, but no B-lite result existed because the worker rejected the task before execution. 204 is the empty/pending contract here, not evidence of a provider failure. |
| Supabase REST, recent slice | 2 recent production rows were `expired`, `precheckout_blite_cohort=false`, ordinary `dispatch_state=enqueued`, and admission state idle; a seven-day aggregate contained 4 consumed rows and these 2 expired rows | The two incident preflights remained at the default cohort value because processing never reached cohort selection, then expired. |
The Cloud Run request log has two records per HTTP request in the queried slice (request and structured application event). The authoritative distinct request count is therefore 4 + 16 = 20, not 60 log records.

## Source and version provenance

- Vercel production was deployed from main at `09eec7cc0a8feb5bd771d0203000a194f009211d`.
- Legacy `analysis-worker` traffic was revision `f702c5778820`, source label `702c571485569ccc7d37faaec816ac2c3658bdb2` (2026-08-30). Its preflight worker schema predates workload-role isolation.
- Dedicated `analysis-preflight-worker` traffic was source `3b28e55c8877276557f8a5a218fb2b966376d889`, descended from capacity rollout commit `71930801385136146cb158ef18336fda3b076246` (2026-09-01). This is the source family that understands the current producer contract and preflight role.
- Commit `719308` added `workloadRole` to the producer payload and to the dedicated preflight worker schema, and added worker-role enforcement. Vercel was updated to the producer contract, but the configured target continued to route to the older worker.

## Verified code path

1. `lib/services/analysis/preflight-tasks.ts:433-455` builds the Cloud Task HTTP request and adds `workloadRole` to every payload. `:461-491` creates ordinary preflight tasks; `:552-586` creates B-lite tasks. The target URL and OIDC audience are read from `PREFLIGHT_TASKS_TARGET_URL` and `PREFLIGHT_TASKS_OIDC_AUDIENCE`.
2. `lib/services/analysis/preflight-tasks.ts:250-267` validates the exact pathname `/api/analysis/preflight/worker` and requires the audience to equal the target origin. This catches malformed paths, but a stale legacy origin still satisfies the syntactic path/audience check.
3. The current route schema in `app/api/analysis/preflight/worker/route.ts:56-99` accepts optional `workloadRole` on ordinary, fresh-admission, beta-prepare, and `precheckout_blite` payloads. After config/auth/body parsing (`:272-295`), it validates the preflight role (`:312-320`), recognizes B-lite (`:322`), and can enter the B-lite runner in the processing branch beginning at `:328`.
4. The legacy `702c5714` route schema had strict objects at `app/api/analysis/preflight/worker/route.ts:46-68` with no `workloadRole` field. Its body parser at `:105-114` maps that unknown-field rejection to HTTP 400 `INVALID_REQUEST`. Because this happens before the processing branch, `runPrecheckoutBlite` and `processPreflight` are never called.
5. `lib/services/precheckout/blite-runtime-policy.ts:76` requires the B-lite gate to be true and `:36-46` parses the rollout percentage. With the observed deployed values true/100, a normally reached production preflight would be cohort-eligible; the observed `false` rows are therefore a consequence of early task rejection, not a deliberate non-cohort assignment.
6. `app/api/analysis/precheckout-blite/route.ts:34` returns an empty 204 only when the flag is off, while later status/cache checks can also return 204 when no ready B-lite result is available. Since Vercel's flag was true, the observed 204s indicate missing durable B-lite output after the rejected tasks.

## Root-cause chain

`Vercel producer (new payload with workloadRole)` → `analysis-preflight` queue → `stale PREFLIGHT_TASKS_TARGET_URL/audience resolving to legacy analysis-worker` → `702c` strict schema rejects unknown `workloadRole` → HTTP 400 `INVALID_REQUEST` → no `processPreflight`/cohort activation/B-lite runner → `precheckout_blite_cohort` remains false → preflight expires → UI's B-lite poll returns empty 204 and displays the fallback target.

This is a delivery/configuration version-skew defect. It is not an Apify, Gemini, Cloud Tasks capacity, readiness, or provider-admission failure: the task reached a service, was rejected at its contract boundary, and no provider work was started.

## Minimal remediation and verification runbook

The following reviewed runbook is the remediation path; steps 1–3 have now been applied by the coordinator's rollout worker, while steps 4–5 remain verification. This worker made no production mutation:

1. Set the Vercel production `PREFLIGHT_TASKS_TARGET_URL` to the dedicated `analysis-preflight-worker` HTTPS origin with exactly `/api/analysis/preflight/worker` and set `PREFLIGHT_TASKS_OIDC_AUDIENCE` to that same origin (root path). Do not point this queue at `analysis-worker`.
2. Redeploy Vercel from the approved source and verify the target/audience pair without printing sensitive values. Preserve the currently observed B-lite true/100 values only if that rollout is approved; changing the gate is not the remedy for this incident.
3. Confirm the dedicated Cloud Run service has 100% traffic on the approved preflight-role revision/source and that `analysis-worker` is not a preflight target. The `analysis-preflight` queue is already running and currently empty, so do not delete or mutate tasks based on this report.
4. Regression-test the task contract locally with mocks: a producer payload containing `workloadRole=preflight` must be accepted by the dedicated route, while target validation must reject a target origin that is not the approved preflight service. No external user, paid provider, order, or payment state is needed.
5. After redeploy, verify only sanitized aggregates: new preflight POSTs arrive on `analysis-preflight-worker`, legacy preflight-route 400s stop, dedicated events progress beyond request rejection, eligible rows activate `precheckout_blite_cohort=true`, and B-lite polling returns a non-empty result or an intentional pending/empty state according to the durable status. Do not alter `payment_pending` or other production status rows during verification.

The targeted local Vitest command was blocked by a missing `@vitest/utils` dependency; this is an environment-only validation limitation and is not production evidence.

The checked-in runbook/example still documents off/0 until the staged internal → 1% → 5% → 25% → 100% B-lite rollout. That is a rollout-governance follow-up, but it does not explain these incident rows because the deployed Vercel and Cloud Run values were already true/100; the immediate fix is target/audience alignment and source-version verification.

## Remediation applied (verified)

- Vercel production `PREFLIGHT_TASKS_TARGET_URL` and `PREFLIGHT_TASKS_OIDC_AUDIENCE` now resolve to the dedicated `analysis-preflight-worker`; a READY production deployment was aliased.
- Dedicated Cloud Run revision `analysis-preflight-worker-00008-97k` is `latestCreated=latestReady` with 100% traffic, source label `0252ccac959593fe4fd2277b560d785a76afdea0`, role `preflight`, stage `initial`, concurrency 1, and max scale 32.
- No post-fix natural-user retry or canary has been observed or run yet. Runtime success, cohort activation, and cessation of legacy 400s remain pending read-only verification after the next eligible request.

## Residual uncertainty

The direct Vercel target and audience values were intentionally not retrieved or printed because Vercel marks them sensitive. The rollout worker's verified deployment state closes the configuration/provenance gap, but execution-level recovery is not yet demonstrated because no post-fix natural-user retry or canary has occurred.
