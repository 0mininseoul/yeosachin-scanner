# Betatest Apify credit pool runbook

## Scope and telemetry

The `/betatest` path uses exactly the free aliases `primary`, `tertiary`,
`quaternary`, `quinary`, `senary`, and `septenary`; `secondary` is excluded and
invalid for this pool. Telemetry is aggregate-only and bounded: refresh
success/failure/latency, total effective headroom, allocation success/rejection,
reservation/actual/released USD, stale snapshot count, settlement lag, and active
allocations. Logs never contain tokens, provider account IDs, raw provider payloads,
cookies, Instagram IDs, request/preflight IDs, or user UUIDs.

## Alerts and immediate response

- Alert on repeated refresh failure (three failures in ten minutes): keep
  `BETATEST_FREE_POOL_ENABLED=false` or turn it off, investigate worker credentials
  out of band, then refresh using a synthetic request only.
- Alert when a stale snapshot count is non-zero for five minutes: stop new beta
  admission and restore healthy exact-six snapshots before enabling it again.
- Alert on a negative/overcommitted invariant: disable new admission immediately;
  inspect aggregate reservation and reconciled-spend rows using service-role access.
- Alert when settlement lag exceeds 15 minutes: run the idempotent recovery path,
  then verify active allocations and released USD totals.
- Alert on unexpected beta use while the feature is disabled: keep the flag off,
  investigate the server-side access/entry-channel audit, and do not bypass the
  dedicated route.

Feature-off stops new beta admission. It does not abandon active allocations:
active requests continue on their frozen maps, and terminal/recovery settlement is
idempotent. Do not rotate a running request to another alias.

## Out-of-band grant procedure

Use an authenticated service-role RPC session only after a separately approved user
identity and audit reference are supplied out of band. Direct table access is revoked.
Replace both placeholders only in the operator terminal; neither is a real UUID/hash
and neither replacement may be committed. `audit_reference_hash` is a SHA-256 digest
encoded as exactly 64 lowercase hexadecimal characters.

```sql
select public.upsert_analysis_beta_access_grant(
  '<USER_UUID_FROM_APPROVED_OUT_OF_BAND_SOURCE>'::uuid,
  true,
  pg_catalog.clock_timestamp() + interval '7 days',
  '<AUDIT_REFERENCE_SHA256_64_LOWERCASE_HEX>'
);
```

Disable/revoke through the same sanctioned RPC with a new approved audit hash:

```sql
select public.upsert_analysis_beta_access_grant(
  '<USER_UUID_FROM_APPROVED_OUT_OF_BAND_SOURCE>'::uuid,
  false,
  null,
  '<AUDIT_REFERENCE_SHA256_64_LOWERCASE_HEX>'
);
```

Do not delete an active grant while an allocation is still settling. Verify only the
caller-facing self-check; never enumerate grants to a client.

## Rollout and rollback

1. Confirm remote migration history read-only, run a migration dry-run with only
   this exact approved allowlist, apply once only after approval, and verify every
   version in remote history before continuing:

   - `20260802010000_add_betatest_apify_credit_pool.sql`
   - `20260802010100_validate_betatest_entry_channel_constraints.sql`
   - `20260802020000_add_betatest_apify_credit_reservations.sql`
   - `20260802030000_bind_betatest_provider_policy.sql`
   - `20260802030100_validate_betatest_provider_policy.sql`
   - `20260802040000_settle_betatest_apify_credit_reservations.sql`
   - `20260802050000_harden_betatest_apify_credit_capacity.sql`
   - `20260802060000_expose_betatest_frozen_provider_budgets.sql`
   - `20260802070000_wire_betatest_preflight_credit_runtime.sql`
   - `20260802080000_admit_betatest_apify_plan.sql`
   - `20260802090000_settle_betatest_terminal_credit.sql`
   - `20260802100000_harden_betatest_entry_lifecycle.sql`
   - `20260802100100_harden_betatest_entry_lifecycle_runtime.sql`
   - `20260802100200_validate_betatest_entry_lifecycle.sql`
   - `20260802100300_allow_betatest_prepare_retry_exhaustion_terminal_state.sql`
   - `20260802100400_terminalize_betatest_prepare_retry_exhaustion_runtime.sql`
   - `20260802100500_validate_betatest_prepare_retry_exhaustion.sql`
   - `20260802100600_add_betatest_pool_observability.sql`
2. Verify all seven Secret Manager secret names exist and each reference uses a
   numeric version. This includes ordinary-flow `secondary`, while beta itself uses
   only the exact six aliases above. Never print secret values.
3. Deploy the worker with beta disabled. Deploy Vercel with beta disabled; Vercel
   must not receive Apify tokens or secret references.
4. Add one approved grant and perform a zero-cost mock/synthetic validation.
5. Obtain separate approval for one bounded live canary, observe the alert metrics,
   then perform staged expansion only if the canary is healthy.

Rollback starts by setting `BETATEST_FREE_POOL_ENABLED=false`, which stops new
admission. Leave active frozen maps and idempotent settlement/recovery running; do
not remove their secret references until all active allocations are settled.

There is no per-analysis deployment. The runtime reservation and terminal settlement in
the database are the no-wait handoff: releasing unused capacity makes it available
to the next user immediately when real headroom exists.

## Dashboard source

The authenticated admin query
`/api/admin/analysis-observability?scope=betatest-pool` reads the service-role-only
aggregate RPC. Dashboard panels use `totalEffectiveHeadroomUsd`,
`staleSnapshotCount`, `activeAllocationCount`, `settlementLagMs`,
`overcommittedSlotCount`, and `runtimeEnabled`. The database clamps
`settlementLagMs` at 31,536,000,000 ms (365 days), so an extended incident remains
visible instead of invalidating the endpoint. The unexpected-disabled-use alert
correlates `runtimeEnabled=false` with new allocation events after the gate update;
already active frozen maps are expected to continue.
