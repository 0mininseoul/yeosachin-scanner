# Preflight persistence backlog stabilization

## Goal

Restore durable preflight throughput without increasing Apify failures. Production is successful at reaching the worker, but concurrent workers fail before provider execution with `PREFLIGHT_PERSISTENCE_ERROR`, causing Cloud Tasks retries and a growing backlog.

## Evidence and constraints

- At queue concurrency 7, the queue grew from 292 to 301 while all three Apify accounts had zero running runs.
- In the same three-minute window, 12 worker requests returned 500 and all 12 emitted `PREFLIGHT_PERSISTENCE_ERROR`.
- Reducing dispatch concurrency limits damage but does not remove the persistence failure.
- Existing request state, idempotency, provider-run checkpoints, and three-way Apify routing must remain compatible.
- Avoid a new multi-queue architecture unless the database evidence proves the current claim/finalize contract cannot be made reliable.

## Design

1. Identify the exact failing persistence operation and PostgreSQL error code. Preserve privacy by logging only the operation and safe database error code, never row data or credentials.
2. Compare the deployed claim/finalize RPC definitions with the working low-concurrency path. Remove avoidable lock amplification or statement work from the hot claim path while retaining a single atomic state transition.
3. Treat transient database transport, serialization, deadlock, and lock-timeout errors as Cloud Tasks retries without recording a terminal preflight failure. Permanent schema/contract errors remain explicit failures.
4. Keep provider work and provider-run checkpoint semantics unchanged. This avoids a second queue/state machine unless the evidence requires it.
5. Deploy the smallest migration/code change, verify at concurrency 2, then increase to 4 and 7 only while the failure rate stays near zero and backlog decreases.

## Error handling

- A transient persistence error returns a retryable worker response so Cloud Tasks retries with the existing backoff.
- It must not terminalize the preflight or create a duplicate provider run.
- A non-transient persistence contract error remains a 500 with a sanitized operation/code event.

## Verification

- Unit tests distinguish transient and permanent persistence errors.
- Migration tests prove claim exclusivity and replay safety.
- Production canary records queue depth, HTTP status, persistence error count, and Apify running runs at each concurrency step.
- Success requires the queue to decrease over two observation windows with no new rate-limit failures and no material persistence-error burst.
