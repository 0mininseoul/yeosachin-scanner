# Earlybird automatic fulfillment

The production source of truth is [Analysis V2 production operations](./analysis-v2-production-operations.md). This runbook defines the narrower payment-to-analysis admission and rollback boundary.

## Launch contract

Automatic fulfillment is admitted by the signed Groble `payment.completed` webhook, not by a historical database sweep.

- `EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED` is a Vercel-only kill switch. Missing or `false` preserves concierge handling.
- When the switch is `true`, `EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE` must be a fixed RFC3339 instant. Only a payment whose signed `paidAt` is at or after that instant is eligible.
- An eligible order is finalized first, bound durably to the `secondary` Apify credential slot, and then admitted. Request creation remains in the existing fulfillment advance/recovery path.
- Signed payments before the cutoff are still finalized and notified, but remain `awaiting_operator` for concierge handling.
- Duplicate webhook deliveries apply the same original `paidAt` cutoff. They cannot make an older payment newly eligible.

The canonical Cloud Run worker must use:

```dotenv
EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED=false
ANALYSIS_V2_RECOVERY_ENABLED=true
```

The first setting prevents the independent recovery sweep from admitting historical `awaiting_operator` rows outside the webhook cutoff. Recovery remains enabled so webhook-admitted `admission_pending` and `retryable_failure` rows continue to drain.

Manual concierge fulfillment remains available throughout. Its operator-selected immutable token slot is not rewritten by the webhook path.

## Token boundary

- New preflights select deterministically from `primary`, `quinary`, and `senary` through `PREFLIGHT_APIFY_API_TOKEN_SLOTS=primary,quinary,senary`.
- Existing preflight provider runs always resume their stored slot, including historical `tenth` rows.
- Formal paid `apify_v1` work uses the order-scoped `secondary` slot. It does not rotate or fall back to a preflight credential.
- Keep existing secret references while durable old runs can still reference them. A token being excluded from new selection is not permission to delete its secret.

## Rollout

1. Deploy the database migration before application or worker code that calls its new RPC.
2. Deploy Vercel with webhook auto-admission disabled.
3. Deploy the canonical worker with recovery enabled, historical automatic admission disabled, and the exact preflight token pool configured.
4. Confirm the request, job, provider-run, fulfillment, and task queues are quiescent twice before opening the gate.
5. Set a fixed future cutoff, enable webhook auto-admission, and use the first post-cutoff payment as the canary.
6. Verify that the order is bound to `secondary`, produces exactly one V2 request and bootstrap job, reaches a published result, and retains the recent-mutual badge metadata.

Do not move the cutoff backward during the rollout. Do not change paid-order state as a deployment control.

## Rollback

Set `EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED=false` in Vercel. This immediately returns new payments to concierge handling without closing checkout or changing payment finalization.

Keep `ANALYSIS_V2_RECOVERY_ENABLED=true` until already admitted work drains. If the worker itself is unsafe, disable only the worker/dispatch gate after recording aggregate queue state; do not mutate payment status or delete provider-run evidence.

After rollback, verify that no new post-disable fulfillment moved from `awaiting_operator`, while existing durable admissions either completed or remain recoverable.
