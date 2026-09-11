# Supabase 22 final runtime/dependency audit

As of 2026-09-11, the linked production `public` catalog contains **177 current base/partitioned tables**: the approved canonical 22 plus a reconciled **155-table noncanonical gap**. The retirement decision is **blocked**: no noncanonical table qualifies for a safe retirement batch under the combined runtime, database-dependency, payment-boundary, data-preservation, and migration-provenance gates.

## Executive decision

- Live catalog accounting is exact: 177 total = 22 canonical + 155 noncanonical; every current public table appears once in the JSON manifest.
- The largest safe retirement batch is **0**. The largest blocked review group is the 68-table application-runtime-caller group.
- `payment_orders` is the only noncanonical relation with no explicit FK/view/routine-body/trigger/policy/publication/sequence/partition edge in the audited dependency set, but it is payment-sensitive and therefore remains blocked.
- Empty tables are surfaced aggressively for generated/recovery review: 52 noncanonical tables are empty, 24 of those also have zero write counters; 36 current tables are both empty and zero-write (37 have zero counters when one nonempty table is included). Empty/zero-write state is not treated as proof of deadness because database objects, code callers, payment boundaries, and unobserved external traffic remain possible.
- No migration, drop, activation, canary, payment, or application-code change was made.

Here, `status: blocked` means retirement is not yet authorized; the convergence plan's `consolidate` classification describes an intended future destination, not a contradiction.

## Scope and evidence boundary

The audit used `origin/main` at commit `956dd485259c7e1dd5b0ecbea09f24fd90aafb2a`, the linked production Supabase catalog, and the pinned CLI `npx supabase@2.102.0`. Production inspection was read-only metadata and exact `count(*)` evidence; no secrets, UUIDs, or raw rows are persisted in either audit artifact.

The static scan covered non-test files in `app/**`, `components/**`, `hooks/**`, `lib/**`, and `middleware.*` as application/runtime evidence; `scripts/**` and `supabase/operations/**` are reported separately as operational evidence; and `supabase/migrations/**` is migration-history evidence. Operational references are not promoted to proof of live request traffic.

## Catalog and row reconciliation

| Catalog class | Tables | Empty | Small (1-100) | Medium (101-10,000) | Large (>10,000) | Exact rows |
|---|---:|---:|---:|---:|---:|---:|
| Canonical | 22 | 13 | 3 | 6 | 0 | 8490 |
| Noncanonical | 155 | 52 | 76 | 25 | 2 | 64779 |
| All | 177 | 65 | 79 | 31 | 2 | 73269 |

All 177 relations are ordinary base tables (`relkind IN ('r','p')`); relation classes are {"base":177} and partition count is 0. Exact counts succeeded for 177/177 tables, totaling 73269 rows (8490 canonical, 64779 noncanonical). The catalog-name SHA-256 is `55ec10e28a7420a8c35efd4baa4fd47b4c0c4202e4369d5ad17cdd46f10fb725`; exact-row-pair SHA-256 is `a9a1f08adeaa54fd1e089c953e83a1e057333d742570faee77e863a27eff3395`; static evidence SHA-256 is `6fff84ccdb20cf28da95ea65e51ec5f358f1e3820986d500d2cb9898c067a25b`.

The row-count and preservation classes in the manifest are intentionally non-destructive: `empty` means exact count 0, `small` means 1-100, `medium` means 101-10,000, and `large` means greater than 10,000. The classes identify review priority, not deletion authorization.

## Runtime and database dependency findings

Static application inspection finds 68 noncanonical tables with direct application references and 87 without a direct application reference in the scanned runtime classes. This is not a closed runtime-traffic observation: `track_functions=none`, user function-stat rows are 0, and the statistics reset/window evidence does not establish inactivity.

The live catalog dependency totals are:

| Evidence | Count |
|---|---:|
| Foreign-key endpoint rows | 483 (243 outgoing, 240 incoming) |
| Distinct foreign-key constraints | 243 |
| View-dependent relations | 18 |
| Direct routine dependency objects | 0 |
| Routine-body table references | 2225 |
| User triggers | 100 |
| Policies | 18 |
| Explicit public-table publication memberships | 3 |
| Owned sequences | 5 |
| Partition edges | 0 |

Per-table `genericPgDependCount` is retained in JSON as catalog evidence, but it includes table-owned/internal dependency metadata and is not by itself a retirement blocker. The structural-clean boolean uses the explicit retirement-relevant edge classes above, including routine-body references. All 177 tables have RLS enabled; 139 force RLS; there are no public grants. The global publication catalog has 2 publications, 0 all-table memberships, 0 public-schema memberships, and 4 explicit memberships overall (3 on public tables).

## Concrete blocker groups and review waves

The following groups are mutually exclusive and exhaustive for the 155 noncanonical tables. Names are listed here for reviewer usability; the JSON manifest uses table ordinals in wave/group membership fields so its sole table-name inventory remains exactly once.

### Payment-sensitive boundary (4)

- Wave/group: `blocked-payment-sensitive`
- Decision: blocked; payment/order state requires owner evidence even when empty; nonempty members also require preservation.
- Members: `earlybird_webhook_events`, `payment_orders`, `payments`, `pending_analysis`

### Application runtime callers (68)

- Wave/group: `blocked-runtime-caller`
- Decision: blocked; application references must be removed or redirected and then re-verified.
- Members: `account_e2e_test_runners`, `account_ledger_rollout_state`, `ai_analysis_cache`, `analysis_anonymous_profile_cache`, `analysis_interaction_evidence`, `analysis_interaction_jobs`, `analysis_interaction_scores`, `analysis_pipeline_jobs`, `analysis_preflight_failures`, `analysis_preflight_provider_runs`, `analysis_progress_events`, `analysis_progress_state`, `analysis_provider_admission_budgets`, `analysis_provider_admission_leases`, `analysis_provider_cost_ledger`, `analysis_result_share_observations`, `analysis_revenue_cost_operations`, `analysis_revenue_dispatch_guards`, `analysis_step_events`, `analysis_target_interactors`, `analysis_v2_active_profile_heartbeats`, `analysis_v2_ai_attempts`, `analysis_v2_ai_global_result_cache`, `analysis_v2_ai_result_checkpoints`, `analysis_v2_ai_scoring_stage_checkpoints`, `analysis_v2_candidate_feature_manifests`, `analysis_v2_candidate_feature_rows`, `analysis_v2_candidate_score_manifests`, `analysis_v2_candidate_score_rows`, `analysis_v2_dag_batch_results`, `analysis_v2_dag_batch_topology`, `analysis_v2_dag_scopes`, `analysis_v2_dag_stage_manifests`, `analysis_v2_female_results`, `analysis_v2_gemini_leases`, `analysis_v2_gender_resolution_metrics`, `analysis_v2_gender_routing_candidates`, `analysis_v2_gender_routing_manifests`, `analysis_v2_media_artifacts`, `analysis_v2_mutual_rows`, `analysis_v2_narrative_manifests`, `analysis_v2_narrative_rows`, `analysis_v2_partner_safety_manifests`, `analysis_v2_partner_safety_rows`, `analysis_v2_preliminary_score_manifests`, `analysis_v2_preliminary_score_rows`, `analysis_v2_private_name_manifests`, `analysis_v2_private_name_rows`, `analysis_v2_private_results`, `analysis_v2_profile_fetch_batches`, `analysis_v2_profile_fetch_outcomes`, `analysis_v2_provider_execution_policies`, `analysis_v2_provider_runs`, `analysis_v2_relationship_manifests`, `analysis_v2_relationship_rows`, `analysis_v2_relationship_sides`, `analysis_v2_result_summaries`, `analysis_v2_reverse_like_manifests`, `analysis_v2_reverse_like_rows`, `analysis_v2_scheduler_operations`, `analysis_v2_target_evidence_manifests`, `analysis_v2_test_entitlement_consumptions`, `demo_analysis_fixtures`, `demo_analysis_runs`, `earlybird_plan_inventory`, `gemini_token_usage`, `private_accounts`, `scraper_provider_usage`

### Nonempty historical/business data (62)

- Wave/group: `blocked-nonempty-preservation`
- Decision: blocked; nonzero exact rows require an explicit preservation/archive decision before retirement.
- Members: `account_classification_audit`, `account_deletion_jobs`, `account_paid_evidence`, `analysis_anonymous_preflight_attempts`, `analysis_apify_credit_snapshots`, `analysis_beta_access_grants`, `analysis_beta_access_policy`, `analysis_beta_pool_allocations`, `analysis_beta_pool_reservation_archive`, `analysis_beta_pool_reservations`, `analysis_beta_runtime_gate`, `analysis_gemini_usage_expectations`, `analysis_order_audit_assembly_queue`, `analysis_order_audit_bundles`, `analysis_preflight_acquisition_cost_events`, `analysis_provider_usage_expectations`, `analysis_v2_apify_secret_ref_prune_guard`, `analysis_v2_cost_attributions`, `analysis_v2_cost_rollup_snapshots`, `analysis_v2_failure_receipts`, `analysis_v2_historical_legacy_dispatch_terminalization_receipts`, `analysis_v2_profile_fetch_telemetry`, `analysis_v2_profile_provider_canary_experiments`, `analysis_v2_profile_provider_canary_runs`, `analysis_v2_profile_repair_canary_runs`, `analysis_v2_provider_cleanup_intents`, `analysis_v2_recovery_provider_run_adoptions`, `analysis_v2_result_coverage_telemetry`, `analysis_v2_result_image_manifests`, `analysis_v2_result_revision_female_rows`, `analysis_v2_result_revisions`, `analysis_v2_score_audit_intents`, `analysis_v2_score_audit_rows`, `analysis_v2_score_audit_runs`, `analysis_v2_score_audit_scan_locators`, `analysis_v2_score_audit_source_rows`, `analysis_v2_score_audit_sources`, `analysis_v2_selfhosted_auth_runs`, `earlybird_adoption_policy_failure_rearms`, `earlybird_checkout_reconciliations`, `earlybird_concierge_batch_cohort_members`, `earlybird_concierge_snapshot_conflict_recoveries`, `earlybird_first15_canary_provider_rearms`, `earlybird_fulfillments`, `earlybird_payment_discord_outbox`, `earlybird_pfe_target_evidence_start_rejection_rearms`, `earlybird_pfe3_media_artifact_rearms`, `earlybird_profile_fetch_exhaustion_recoveries`, `earlybird_schema_failure_recoveries`, `earlybird_terminal_unavailable_exhaustion_rearms`, `earlybird_v211_apify_transient_replays`, `earlybird_v211_concierge_publications`, `earlybird_v211_concierge_replays`, `earlybird_v211_lease_policy_failure_rearms`, `earlybird_v211_policy_identity_replays`, `earlybird_v211_profile_ai_diagnostic_replays`, `earlybird_v211_relationship_lineage_failure_rearms`, `kakao_signup_discord_outbox`, `precheckout_blite_cache`, `precheckout_blite_dispatches`, `selfhosted_profile_request_start_gate`, `sentry_discord_alert_outbox`

### Empty but catalog-coupled/generated or recovery surface (21)

- Wave/group: `blocked-empty-catalog-coupled`
- Decision: blocked; empty state is not deadness; explicit database edges and routine-body references require dependency cleanup and owner evidence.
- Members: `analysis_anonymous_profile_cache_locks`, `analysis_beta_pool_local_debits`, `analysis_lifecycle_events`, `analysis_order_audit_candidates`, `analysis_order_audit_interactions`, `analysis_revenue_ai_routing_attempt_lineages`, `analysis_revenue_final_coverage_gates`, `analysis_revenue_fresh_provider_evidence`, `analysis_revenue_primary_quality_checkpoints`, `analysis_revenue_resolver_capacity_reservations`, `analysis_revenue_resolver_outcome_overlays`, `analysis_revenue_resolver_passes`, `analysis_revenue_run_ledgers`, `analysis_v2_replay_capture_audit_events`, `analysis_v2_replay_capture_authorizations`, `analysis_v2_replay_capture_fragments`, `analysis_v2_result_image_objects`, `analysis_v2_result_image_purge_outbox`, `analysis_v2_unconfirmed_start_resolutions`, `precheckout_blite_sources`, `vertex_ai_budget_reservations`


A separate candidate-pool wave contains the one structurally isolated noncanonical ordinal, `payment_orders`; it is deliberately blocked by the payment-sensitive denylist. The empty-coupled review wave has 21 members; the runtime-caller review wave has 68; the nonempty-preservation wave has 62; and the payment-sensitive review wave has 4. Each wave has eligible count 0 in the manifest.

## Approved canonical set

The approved canonical 22 are:

`account_lifecycle`, `analysis_artifacts`, `analysis_audit_bundles`, `analysis_cache`, `analysis_costs`, `analysis_events`, `analysis_jobs`, `analysis_preflights`, `analysis_provider_runs`, `analysis_requests`, `analysis_results`, `earlybird_orders`, `earlybird_waitlist`, `fulfillment_jobs`, `landing_leads`, `maintenance_jobs`, `notification_outbox`, `payment_events`, `result_feedback`, `system_configuration`, `system_leases`, `users`

They are marked `tableClass: "canonical"`, `disposition: "retain-canonical"`, and `waveId: "canonical-retain"` in the JSON.

## Migration/provenance checks

Local migration files and remote migration history each contain 383 distinct versions, and the version sets match. Version/name alignment is not clean: 7 version/name pairs differ, the name mismatch digest is `e5aaa2cf5e21784717de35719df0a23c379cc92c919962ca428c7feeec32e63e`, and remote history contains 1 null statement row. Local/remote version-name hashes and local migration-body hash are preserved in JSON as evidence.

This provenance mismatch does not prove that any table is dead, so it is a fail-closed blocker for retirement authorization. It also means no cleanup migration allowlist is inferred from this audit.

## Retirement disposition

```
safeRetirementCandidateCount: 0
largestSafeRetirementBatchCount: 0
status: blocked
```

No noncanonical table passes all gates. The next safe step is owner-led evidence collection for the blocked waves, followed by a fresh catalog/dependency/runtime audit; this report authorizes no production mutation.

## Artifact validation

- JSON manifest: `docs/reports/2026-09-11-supabase-22-final-runtime-dependency-audit.json`
- Expected accounting: 177 total, 22 canonical, 155 noncanonical, 5 review waves plus one candidate-pool view.
- The manifest stores hashes, counts, booleans, sanitized identifiers, and ordinals only; it stores no raw rows, secrets, or UUIDs.
