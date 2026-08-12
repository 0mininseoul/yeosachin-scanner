# Preflight Apify dual-slot design

## Goal

Reduce preflight fallback queueing by distributing new Apify profile runs across the existing primary and secondary credentials while preserving replay safety and cost attribution.

## Current behavior

Standard preflight first attempts the self-hosted profile path. When that path enters its circuit breaker, preflight starts or resumes an Apify profile fallback run. New fallback runs select one globally configured credential slot. Existing runs persist their credential slot and resume through that slot.

Production already has both `APIFY_API_TOKEN` and `APIFY_SECONDARY_API_TOKEN`, but the selection code does not distribute preflight requests between them.

## Design

Add a pure credential-selection function for new standard preflight fallback runs.

- If both primary and secondary credentials are configured, hash the canonical preflight UUID and select a slot from one bit of the digest.
- The same preflight ID always selects the same slot across worker retries, processes, and deployments.
- If secondary is absent, retain the existing configured Analysis V2 slot behavior.
- Existing provider-run checkpoints always retain their persisted `credential_slot`; they are never rebalanced.
- Beta credit-pool allocation remains unchanged because its coordinator already owns slot selection.
- Do not introduce cross-account failover. An ambiguous Actor start must not create a second potentially billable run.

The hash input is the preflight ID rather than username, user ID, request timing, or process-local state. This yields stable distribution without grouping repeated analysis of the same target onto one account.

## Data flow

1. The worker claims a preflight.
2. The self-hosted profile path either succeeds or becomes fallback-eligible.
3. If a provider-run checkpoint already exists, the worker resumes its persisted slot.
4. For a new standard fallback run, the selector checks credential availability.
5. With both slots available, the preflight ID deterministically selects primary or secondary.
6. The selected slot is persisted with the provider-run checkpoint before starting the Actor.
7. All retries resume that checkpoint and slot.

## Error handling

- Missing secondary token: preserve the current single-slot selection.
- Invalid configured fallback slot: preserve the current configuration error.
- Missing selected token: fail closed through the existing configuration error.
- Provider rejection, timeout, or ambiguous start: preserve existing run-ledger and retry behavior; do not rotate credentials.

## Tests

- The same preflight ID always selects the same credential.
- A representative UUID set reaches both primary and secondary slots with a near-even split.
- Missing secondary credentials preserve the configured/default slot.
- Existing provider runs resume their persisted slot rather than being reselected.
- Beta slot allocation is unchanged.
- Existing preflight and Apify provider tests continue to pass.

## Rollout and rollback

Deploy through a pull request from an isolated branch. No database migration or new secret is required. After production deployment, compare preflight duration and failure rates by provider slot if available, along with overall p50/p90 latency and `PROVIDER_ERROR` rate.

Rollback is a code rollback to the prior globally selected slot. Persisted provider runs remain valid because both slot names already belong to the existing schema and token contract.
