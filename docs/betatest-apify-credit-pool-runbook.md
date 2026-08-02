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

Use an authenticated service-role SQL session only after a separately approved user
identity is supplied out of band. Replace the placeholder only in the operator
terminal; it is intentionally not a real UUID and must never be committed.

```sql
insert into public.analysis_beta_access_grants
  (user_id, enabled, expires_at, audit_note)
values
  ('<USER_UUID_FROM_APPROVED_OUT_OF_BAND_SOURCE>', true,
   now() + interval '7 days', 'approved betatest canary')
on conflict (user_id) do update
set enabled = excluded.enabled,
    expires_at = excluded.expires_at,
    audit_note = excluded.audit_note;
```

To revoke, set `enabled=false` with an audit note; do not delete an active grant
while an allocation is still settling. Verify only the caller-facing self-check;
never enumerate grants to a client.

## Rollout and rollback

1. Confirm remote migration history read-only, run a migration dry-run with the
   exact approved allowlist, apply once only after approval, and verify history.
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
