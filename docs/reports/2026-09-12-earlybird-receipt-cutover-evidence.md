# Earlybird receipt cutover implementation evidence

Date: 2026-09-12
Base: `90d5cd83`
Scope: the approved 13-table earlybird receipt cohort only.

## Delivered artifacts

- `supabase/migrations/20260912074059_retire_earlybird_receipt_archive.sql`
  archives and retires the 13 source relations in one transaction.
- `supabase/operations/20260912_restore_earlybird_receipt_tables.sql` is an
  isolated, archive-preserving restore operation. It requires the explicit
  `supabase.retirement_isolated = 'true'` session guard and never deletes or
  rewrites archive rows.
- `scripts/correct-concierge-basic-result.ts` is the only runtime/operator
  caller changed. Its publication marker now uses the archive-aware source
  function while preserving the existing idempotent skip/CAS behavior.

## Archive and cutover contract

The migration uses 13 literal, source-specific `INSERT ... SELECT` branches.
Each receipt stores the complete typed source row in `legacy_row`, the literal
source relation name, `schema_version = 1`, and the exact `{order_id}` primary
key object. Receipts are inserted into `public.maintenance_jobs` as
`state = 'succeeded'` with a domain-separated target-key hash and a payload
content hash; conflicting existing keys abort unless state, payload, and both
hashes match exactly.

The reviewed production predecessor guard expects `maintenance_jobs` to have
17 columns, including nullable `legacy_pending_user_id`; all 13 receipts leave
that field NULL. The migration locks the maintenance table and all source
relations deterministically, revalidates relation OIDs and typed shapes, checks
RLS/immutability/publication/FK guards, and drops source tables without
`CASCADE`. The expected aggregate is 21 source rows: 2, 1, 1, 1, 1, 7, 1,
1, 2, 1, 1, 1, and 1 in the literal source order.

## Named routine changes

The migration fingerprints and rewrites these 36 retained routines in place,
keeping signatures, result shapes, ACLs, and surrounding payment/analysis
state transitions stable while replacing source reads with typed,
source-allowlisted archive projections:

```text
bootstrap_earlybird_v211_concierge_first_order
bridge_earlybird_v211_lease_rearm_admission
complete_analysis_v2_preflight_admission
complete_earlybird_concierge_snapshot_recovery
create_or_replay_earlybird_fulfillment_request
earlybird_concierge_snapshot_conflict_receipt_authorized
earlybird_pfe3_media_artifact_adoption_ready
earlybird_pfe_evidence_rejection_adoption_ready
earlybird_profile_fetch_exhaustion_provider_run_adoption_ready
earlybird_provider_run_adoption_ready_pre_first15
earlybird_v211_apify_transient_failure_ready
earlybird_v211_apify_transient_replay_ready
earlybird_v211_concierge_replay_ready
earlybird_v211_policy_identity_replay_ready
earlybird_v211_profile_ai_diagnostic_replay_ready
earlybird_v211_relationship_lineage_rearm_ready
inspect_earlybird_concierge_snapshot_conflict_precheck
inspect_earlybird_concierge_snapshot_recovery_execution
list_analysis_v2_dispatchable_jobs
mark_earlybird_concierge_snapshot_recovery_job_local
publish_earlybird_v211_first_payment_concierge
purge_expired_analysis_v2_preflights
read_earlybird_v211_concierge_recovery_source_v1
read_earlybird_v211_concierge_result_source
rearm_earlybird_concierge_snapshot_conflict_execution
recover_earlybird_concierge_snapshot_conflict
recover_earlybird_schema_failed_fulfillment
register_earlybird_v211_concierge_reviewed_source
request_analysis_v2_provider_run_cleanup
resolve_analysis_v2_exact_recovery_provider_run
resolve_analysis_v2_recovery_provider_run_pre_first15
resolve_analysis_v2_recovery_provider_run_pre_pfe2
resolve_analysis_v2_recovery_provider_run_pre_pfe3
resolve_analysis_v2_recovery_provider_run
restore_earlybird_concierge_snapshot_conflict_cancelled_branche
resume_earlybird_v211_policy_identity_admission
```

Three source writers now persist succeeded archive receipts before continuing
their existing state transitions through these internal helpers:

- `archive_earlybird_schema_failure_recovery`
- `archive_earlybird_concierge_snapshot_conflict_recovery`
- `archive_earlybird_v211_concierge_replay`

Reviewed-source and publication-marker updates use the additional internal
helpers `archive_earlybird_v211_concierge_reviewed_source` and
`mark_earlybird_v211_concierge_publication_source`. The eleven one-shot
rearm/recovery writer functions are dropped only after a catalog dependency and
sanitized routine-body no-caller guard; active service/operator writers remain.

`purge_expired_analysis_v2_preflights` receives 13 explicit archive retention
branches covering every historical order, request, and preflight reference,
with typed JSON decoding and a fail-closed archive integrity assertion.

The guarded retirement set is the eleven one-shot writers
`rearm_earlybird_zero_spend_adoption_policy_failure`,
`rearm_earlybird_pfe_target_evidence_start_rejection`,
`rearm_earlybird_pfe3_media_artifact_error`,
`recover_earlybird_profile_fetch_exhaustion_fulfillment`,
`rearm_earlybird_terminal_unavailable_job_exhaustion`,
`rearm_earlybird_v211_apify_transient_replay`,
`rearm_earlybird_v211_concierge_replay`,
`rearm_earlybird_v211_lease_policy_failure`,
`rearm_earlybird_v211_policy_identity_replay`,
`rearm_earlybird_v211_profile_ai_diagnostic_replay`, and
`rearm_earlybird_v211_relationship_lineage_failure`. They are dropped only
after exact signature resolution plus catalog and sanitized body no-caller
guards.

## Verification evidence

- Pinned linked CLI: Supabase CLI `2.102.0`; all linked reads used the isolated
  read-only workdir named in the plan. No production mutation, push, merge,
  deploy, activation, canary, or raw row/identifier export was performed.
- Sanitized production catalog evidence: 36 retained routine fingerprints
  matched the reviewed map; retained caller search for the 11 retirement
  candidates returned zero callers; source aggregate total was 21.
- Pinned `supabase db lint --local` completed with `No schema errors found`.
- `git diff --check` completed cleanly.
- TypeScript typecheck was attempted narrowly, but this checkout has no local
  TypeScript compiler or installed dependencies; `npx tsc` returned the
  package-manager guidance to install TypeScript. No dependency or lockfile was
  changed.

The remaining gate is coordinator-owned: isolated dry-run, exact migration
allowlist review, and any later production apply/history verification. This
commit intentionally performs none of those production actions.
