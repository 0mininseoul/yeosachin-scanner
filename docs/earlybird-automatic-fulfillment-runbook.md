# Earlybird automatic fulfillment

## Authorized launch behavior

`EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED=true` opens automatic fulfillment only
on the canonical `analysis-worker` service. On each bounded Analysis V2 recovery
pass, the worker atomically admits eligible `awaiting_operator` earlybird rows and
then uses the existing fresh-admission, request, job, and task recovery flow.

The payment webhook remains enqueue-only. Automatic fulfillment does not create an
analysis request directly and returns only opaque fulfillment identities to the
worker.

An order is eligible only when it is still `paid`, reference-confirmed, has a
payment ID, has an amount within its immutable expected amount, matches its expected
product, uses Basic or Standard, and passes the existing immutable preflight snapshot
checks. Cancelled, refund-pending, payment-pending, manual-review, invalid, and
ambiguous rows stay out of the automatic path.

Existing eligible `awaiting_operator` rows are included on later bounded recovery
passes; they do not require a new webhook. The `analysis-worker-secondary-e2e`
service must always set the flag to `false`.

## Rollback

Set `EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED=false` and deploy the canonical worker.
This immediately stops new automatic admissions while already admitted rows continue
through the durable recovery flow. The prior operator admission path remains
available throughout.

Do not change paid-order state to perform a rollback. Use the normal recovery and
reconciliation telemetry to confirm the admitted queue drains.
