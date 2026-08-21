# Result publication after refund

## Goal

Keep payment and refund history authoritative while ensuring that a result which was fully produced and delivered remains readable after a refund. The immediate production case is `316zz.z`; the rule must be general and must not encode a username or request identifier.

## Existing state owners

- `earlybird_orders.status` records the commercial lifecycle, including payment, refund, and cancellation states.
- `earlybird_fulfillments.status` records the paid-result fulfillment lifecycle and binds an order to its analysis request.
- `analysis_requests.status` records the analysis execution lifecycle.

No second result-status column will be added to `earlybird_orders`. Doing so would duplicate `earlybird_fulfillments.status` and create a synchronization problem.

## Publication rule

A paid result is publication-authorized only when all of the following are true:

1. Its analysis request is `completed` and is not a concierge batch source request.
2. Every paid order linked to that request has a commercial status of `completed`, `refund_pending`, or `refunded`.
3. Every linked paid order has a fulfillment row bound to the same request with status `completed` and a non-null `completed_at`.

Free and legacy publication behavior and the historic first-order bootstrap remain unchanged. Payment-pending, payment-failed, paid-but-unfulfilled, in-progress, overflow-refund-required, and cancelled orders remain blocked.

## Data handling

The migration changes only the publication authorization function. It does not rewrite order status, payment identifiers, refund state, fulfillment state, result rows, or user identifiers. The already completed `316zz.z` fulfillment therefore becomes readable without falsifying its `refunded` commercial state.

## Verification

- Add PGlite cases proving completed, refund-pending, and refunded orders with completed fulfillment are authorized.
- Add negative cases proving refunded orders without completed fulfillment and cancelled orders remain blocked.
- Run the focused publication-authority tests and migration contract tests.
- Apply only the new migration from an isolated Supabase workdir after dry-run allowlist verification.
- Audit the exact delivered scope: 27 completed orders paid since 2026-08-11 KST plus the completed `316zz.z` result must report 28/28 publication-authorized.
