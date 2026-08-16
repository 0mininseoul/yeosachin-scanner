# Exact 30 failure-class recovery report

Date: 2026-08-16 (production evidence, sanitized)

## Frozen scope

- Immutable cohort: 30 orders, one manifest hash, 27 `awaiting_operator` and 3 `failed_canary`.
- Current request shape: 30 failed retry requests; 30 orders remain `analysis_in_progress`; 0 published; 0 active jobs or provider-run leases observed.
- Current retry classes: 24 `CONCIERGE_BATCH_RETRYABLE`, 3 `CONCIERGE_PROVIDER_ARTIFACT_INVALID`, and 3 `CONCIERGE_TARGET_PROFILE_PRIVATE`.

## Exact aggregate for the 24 generic rows

The 24 generic rows all reached target collection and then shared the relationship-collection failure shape. Their bounded Apify evidence is 192 physical relationship Actor starts, exactly `24 orders × 2 relationship sides × 4 approved slots` (`senary`, `tertiary`, `quinary`, `primary`): all 192 runs reported `SUCCEEDED`, but all 192 datasets had total item count 0. Sanitized Actor logs for all 192 runs contained `FREE_API_DAILY_LIMIT_REACHED` (also emitted as the bounded `FREE_API_LIMIT`/`FREE_API_QUOTA` signals); no interaction Actor, AI classification, CAS publication, or email stage started.

Application consequence: an empty relationship dataset cannot establish the frozen relationship evidence required for a valid result. The runner now fails closed with a stage-specific `CONCIERGE_RELATIONSHIP_FOLLOWERS_EMPTY` or `CONCIERGE_RELATIONSHIP_FOLLOWING_EMPTY` code when the target declares a non-zero relationship count, rather than allowing an empty projection to reach publication.

## Other classes and handling

- 3 invalid profile artifacts: no supported bounded repair path was found. They remain excluded and unpublished.
- 3 private targets: excluded from provider retries and retained for operator/customer handling; no fabricated result is produced.
- The 24 generic rows are eligible only through the explicit retry allowlist after the provider's free daily limit is demonstrably available again. Retrying the four approved token slots while the shared Actor limit is exhausted is not an eligible repair.

## Code correction and verification

- `run-concierge-batch.ts` now requires `CONCIERGE_BATCH_RETRY_CODES`, reads retry codes only for the frozen order/request mapping, filters to the explicit allowlist, and hard-protects private and invalid-artifact classes. It supports `CONCIERGE_BATCH_DRY_RUN=true` for aggregate-only verification.
- `concierge-batch-runner.ts` exposes the allowlist selector and the non-zero relationship empty guard.
- Dry-run against the frozen production cohort selected exactly 24 rows and excluded exactly 6 (`3 private + 3 invalid artifact`); it made no provider or publication calls.
- Red-to-green TDD evidence: the allowlist and empty-relationship tests failed before implementation and pass after implementation. `npx tsc --noEmit`, `npm run lint`, and 159 targeted tests pass.

## Remaining

No valid rows were published in this recovery pass because the only proven provider path was at its shared daily limit. The exact 24-row allowlist is ready for a later reviewed retry once a bounded provider canary confirms non-empty relationship datasets; the 6 protected rows remain excluded.
