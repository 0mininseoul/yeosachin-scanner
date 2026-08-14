# Anonymous preflight production stall RCA (sanitized)

Investigation window: 2026-08-14 15:32:27–15:57:37 UTC (2026-08-15 00:32:27–00:57:37 KST). No production state, queue task, rollout environment, or database row was mutated or replayed.

## Timeline

| UTC | Boundary | Evidence |
|---|---|---|
| 15:32:27.464 | Anonymous preflight created | Supabase row accepted with 30-minute expiry and immutable B-lite deadline at 15:33:57.464; no request/job row is created for this anonymous path. |
| 15:32:28.704–15:32:30.174 | Dispatch and admission | DB dispatch marked enqueued; Cloud Tasks queue was RUNNING; Vercel/Axiom recorded `POST /api/analysis/preflight` 202 and the exclusion PATCH 204. |
| 15:32:30.014–15:32:53.787 | Provider ledger | Apify provider run reserved, started, and terminalized `succeeded`; usage reconciliation completed at 15:35:03.557. |
| 15:32:28.772–15:32:48.570 | Worker attempt 1 | Cloud Run revision `analysis-worker-f5e5c0a00476` executed the PR405 worker and returned retryable `run_pending` (HTTP 500). |
| 15:33:28.673–15:33:29.311 | Worker attempt 2 | Same revision returned retryable `run_pending` (HTTP 500). |
| 15:34:49.444–15:34:50.727 | Worker attempt 3 | After the B-lite deadline, same revision returned retryable `persistence` (HTTP 500). |
| 15:37:30.842–15:37:31.805 | Worker attempt 4 | Retryable `persistence` (HTTP 500). |
| 15:42:31.911–15:42:33.743 | Worker attempt 5 | Retryable `persistence` (HTTP 500). |
| 15:47:33.856–15:47:35.117 | Worker attempt 6 | Retryable `persistence` (HTTP 500). |
| 15:52:35.259–15:52:36.168 | Worker attempt 7 | Retryable `persistence` (HTTP 500); no `ready` or `blocked` finalization occurred in the worker. |
| 15:57:36.870 | Public state | The next claim hit the database attempt fence and auto-blocked the row with `ANALYSIS_FAILED`; no ready snapshot or B-lite source/cache/dispatch row exists. |

## Root cause

The production stall was caused by an input-hash identity drift exposed by the B-lite deadline fail-open path. Before the deadline, the worker uses the hash persisted in the anonymous claim; after activation crosses the immutable deadline, `processPreflight` fell into ordinary anonymous fallback and recomputed the hash from the Cloud Run HMAC secret, so `load_analysis_preflight_provider_run` rejected the existing provider ledger lineage and the adapter surfaced a retryable persistence failure. The PR405 terminal-no-profile fence was not reachable because it explicitly excludes `persistence` failures; attempts 3–7 therefore returned HTTP 500 until the database claim fence auto-blocked on the next delivery.

Evidence is mutually consistent: the provider run is already `succeeded`, the persistence failures begin only after the immutable B-lite deadline, the Cloud Run structured events report retryable `persistence` without a provider failure, and a safe comparison against the canonical local HMAC configuration does not match the persisted target hash. Production Vercel and Cloud Run environment values were not read or printed; the remaining operational telemetry gap is the absence of a non-reversible hash-fingerprint/source field on the provider-ledger load failure.

## Fix and verification

- `processPreflight` now prefers `claim.targetInputHash` whenever it is present, including the ordinary-readiness fail-open path; it only recomputes the hash for legacy claims without a persisted hash.
- Added a regression test covering anonymous B-lite activation failure after the deadline with worker HMAC drift. The test failed before the fix and passes after it.
- Passed: focused B-lite/terminal tests (18), full `preflight.test.ts` (102), related provider/worker/source-store tests (34), `npm run lint`, and `npx tsc --noEmit`.

The change is committed in this worker worktree only. Coordinator review is required before deploying the web and worker revisions; no rollback, rollout, environment, queue, or database remediation was performed.
