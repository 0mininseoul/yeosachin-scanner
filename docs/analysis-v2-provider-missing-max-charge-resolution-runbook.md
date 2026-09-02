# Analysis V2 provider-missing conservative max-charge resolution

This runbook is a release gate for the narrow V2 cohort whose Apify provider
terminal is `succeeded`, historical credential slot is `tertiary`, provider
usage is irrecoverably missing, and the provider run ID and terminal timestamps
are present. `actual_usage_usd = max_charge_usd` is the conservative accounting
amount only; `manual_resolution_kind = conservative_max_charge` plus the
immutable evidence hash and timestamp make that distinction explicit. The
provider status and run ID are never changed.

## Migration order

The parallel preflight PR migration
`20260902100000_ambiguous_max_charge_identity_drift_repair.sql` is the actual
predecessor and must merge before this V2 migration:
`20260903020000_add_analysis_v2_conservative_max_charge_resolution.sql`.

## Owner-only gate

Do not source or print `.env.local`, reconstruct a link, invoke a provider, or
run this procedure through `service_role`. The candidate and resolver functions
are database-owner-only and return identity/accounting fields only; they do not
return target usernames, raw provider payloads, captions, URLs, or other PII.

In a protected database-owner session, run the read-only candidate gate with a
limit of six. A limit of six makes an unexpected sixth row visible instead of
silently truncating it:

```sql
SELECT jsonb_array_length(
    public.list_analysis_v2_conservative_max_charge_candidates(6)
) AS candidate_count;
```

Stop immediately unless `candidate_count = 5`. The authoritative current
evidence is exactly five rows; the function independently enforces the
seven-day (`terminalized_at <= clock_timestamp() - INTERVAL '7 days'`) terminal
age fence, succeeded/Apify/tertiary cohort, complete run
identity, expired-or-absent request and job leases, and no live provider
admission. Save only that owner query result as a temporary, access-controlled
JSON file; never commit it or include raw provider evidence in the file.

## Generate the owner SQL file

After the gate is exactly five, place the sanitized candidate JSON in a
temporary protected file outside the repository and generate a SQL file using
the file-only generator. The evidence hash must be the lowercase SHA-256 of a
PII-free incident-reference artifact; it is not a provider payload or a raw
identifier.

```sh
npx tsx scripts/generate-analysis-v2-conservative-max-charge-resolution.ts \
  --input /secure/temporary/v2-provider-candidates.json \
  --output /secure/temporary/v2-provider-resolution.sql \
  --evidence-hash <64-lowercase-hex-evidence-hash>
```

The generator performs no network calls, reads no environment files, requires
exactly five rows, rejects unknown fields, and emits calls containing every
immutable identity parameter: request, job, operation, input hash, job claim
token, reservation token, run ID, provider, actor, credential slot, max charge,
reserved/start/terminal timestamps, status, resolution kind, and evidence hash.
Review the generated file for five calls and execute it in one database-owner
transaction. The resolver locks request → exact job → exact provider, fails
closed on any identity drift or live lease/admission, and is strictly
idempotent only for the same immutable identity and evidence hash.

An exact active or already-settled `analysis_revenue_cost_operations` provider
child is passed through the latest
`settle_analysis_revenue_cost_operation_v2` RPC. If neither an exact active nor
a settled child is present, the resolver creates neither a child
nor a synthetic event; canonical V2 provider cost aggregation counts the filled
conservative amount. Released, denied, or any other child state fails closed;
an exact settled replay returns the same settled disposition. Any ledger fence
failure rolls back the provider update and child settlement together.

## Post-resolution verification

In the same owner session, rerun the candidate gate and require zero rows. Then
verify through the normal service-role list/reconcile path that no resolved row
is returned and readiness is clear. Do not mutate jobs, requests, admission
leases, queues, schedulers, `payment_pending`, or any provider target as part of
this procedure.

Delete temporary candidate and generated SQL files according to the owner’s
secure evidence-retention policy after the change window; neither file belongs
in this repository or in an incident report.
