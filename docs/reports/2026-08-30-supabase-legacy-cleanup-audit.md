# Supabase and legacy-analysis cleanup audit

**Audit date:** 2026-08-30 (Asia/Seoul)

**Correction base:** `c507254f68a72bc3de8e243fdb6827eb25710031`

**Source baseline:** `origin/main` at `2a28326462bf636f92368dc894b5ea76911d79bb`

**Audit mode:** read-only API/catalog metadata, source-schema metadata, and aggregate count headers; no row payloads were collected.

## Executive decision

There is no safe immediate drop candidate in the evidence available for this audit. The live API exposes 165 named PostgREST definitions (164 CRUD-capable relation paths and one read-only view path), while the source tree has text references to 152 of those relation names. Every one of the 165 definitions is assigned exactly one classification in the ledger below; a missing text reference, an HTTP 403, or a source/live naming mismatch is never treated as proof that an object is unused or empty.

The paid Analysis V2 path is the canonical execution path: preflight and entitlement/admission lead to Cloud Tasks, the V2 worker writes staged durable state, finalization publishes an owner-scoped result, and result images use the private R2 registry. The V1/step compatibility surface remains a migration-only or owner-history read boundary, but it must be consolidated only after traffic, database dependencies, and historical-result compatibility are proven. The intentional Apify/RapidAPI/self-hosted provider switching is retained; it is not a cleanup target.

The endpoint/schema fingerprint was verified without printing credentials or row data. Supabase management-plane project identity could not be independently proven in this environment: the linked CLI query was blocked by network/privilege limitations and the account-visible project list did not identify the endpoint. Live evidence is therefore labeled “canonical endpoint/schema fingerprint,” not owner-level project proof, and every destructive decision remains blocked on an owner-authorized catalog snapshot.

## Scope and safety boundary

This audit intentionally did **not**:

- read row-level data, names, emails, usernames, UUIDs, cookies, provider payloads, or raw storage paths;
- call a mutation-capable RPC, perform DDL or DML, repair migration history, or run `supabase db push`;
- edit a migration, executable SQL, application code, provider configuration, or the protected reconciliation migration;
- make any conclusion from a `403` relation response that the relation is empty;
- call Apify, RapidAPI, Gemini, Instagram, R2, GCS, or any other provider;
- recommend deleting the Apify/RapidAPI/self-hosted route switch.

The live relation count was collected with HTTP HEAD/count metadata requests only. The exact-count pass returned `Content-Range` totals and no response bodies. PostgREST OpenAPI metadata was used to enumerate relation definitions and RPC paths. Supabase Storage bucket metadata was counted without retaining bucket names. Static inspection covered `app/`, `lib/`, `hooks/`, `components/`, `scripts/`, `docs/`, and `supabase/migrations/`.

### Identity and evidence limitation

The URL was taken from the canonical main worktree environment file by key-name lookup without sourcing or printing the file. Its host was checked as a Supabase HTTPS host, and the endpoint returned a standard public schema OpenAPI document with 165 definitions and 805 paths. The CLI reported version 2.114.0; its project listing exposed two account-visible projects that did not match the endpoint-derived project identity, while the linked database query was unavailable because the current network did not support the project's IPv6 route. A separate link attempt was rejected by the account's endpoint privilege. No project reference, token, secret, database password, Authorization header, cookie, or user identifier is included in this report.

This establishes reachability of the expected production schema at the configured endpoint, but not management-plane ownership or a complete `pg_catalog` snapshot. The follow-up gate is an owner-authorized, read-only catalog export for the same endpoint.

## Corrected sanitized inventory totals

| Surface | Observed total | Evidence and qualification |
|---|---:|---|
| PostgREST named definitions | 165 | Exact OpenAPI definition count; exposed API surface, not a complete database catalog |
| Exposed CRUD-capable relation paths | 164 | Exact OpenAPI path classification; underlying `pg_class` kind is not asserted for every path |
| Exposed read-only view paths | 1 | `analysis_operational_cost_summary`; view path, not a table requiring RLS |
| Exposed materialized-view paths | 0 observed | No matview path in OpenAPI; owner-level `pg_class` confirmation is still required |
| Exposed RPC paths | 639 | Unique `/rpc/` names in OpenAPI; long PostgreSQL identifiers can be truncated and overloads exist |
| Relations with exact-count headers | 60 | HEAD requests only; zero row bodies read |
| Exact-count total for accessible relations | 48,931 | Sum of 60 `Content-Range` values; not a PII export |
| Relations with direct-read denial | 105 | HTTP 403; not a zero-row or absence signal |
| Local migration files | 354 | Git-tracked SQL files; newest timestamp is `20260829120000` |
| Unique table names created in current migration source | 161 | Declaration scan; not proof that every migration is applied remotely |
| Unique view names in migration source | 2 | `analysis_operational_cost_summary` and `daily_token_usage`; source history, not current live kind |
| Explicit materialized-view declarations in source | 0 | Declaration scan; live catalog kind still requires owner evidence |
| Explicit sequence declarations in source | 0 | Declaration scan; serial/identity-owned sequences still require catalog evidence |
| Function declaration events / unique names | 951 / 646 | Replacements, overloads, and historical definitions make event count non-canonical |
| Trigger declaration events / unique names | 83 / 78 | Source declaration scan; current enabled state unverified |
| Policy create events / drop events | 19 / 5 | Source history, not current `pg_policy` state |
| Whitespace-normalized explicit RLS enable events / unique names | 165 / 161 | Comments removed and arbitrary whitespace normalized for the source scan; source history, not current `pg_class.relrowsecurity` |
| Whitespace-normalized explicit force-RLS events / unique names | 126 / 123 | Source history, not current `pg_class.relforcerowsecurity` |
| Dynamic RLS-boundary target names | 4 / 2 additional | `payments`, `payment_orders`, `users`, `ai_analysis_cache`; the first two add names beyond the 161 explicit set |
| Public-or-unqualified FK reference clauses / distinct targets | 263 / 35 | 243 schema-qualified `public.*` clauses plus 20 syntactically unqualified clauses; current constraints unverified |
| Realtime publication-add events / distinct source names | 3 / 3 | Initial `analysis_requests`, then guarded `analysis_progress_state` and `analysis_progress_events`; live membership unverified |
| Supabase Storage buckets | 0 | Storage API bucket count; result-image path is external R2 and source media uses private GCS |

The migration source contains 161 unique current table names. Compared with the 164 CRUD-capable live definitions, three live names are not explained by a current `CREATE TABLE` declaration: `payment_orders`, `payments`, and `pending_analysis`. The fourth live definition outside that table comparison is the `analysis_operational_cost_summary` view. `daily_token_usage` is declared in older source but is not in the current exposed definition list. These differences are provenance questions, not deletion evidence.

## Aggregate live counts

The following are sanitized exact counts from accessible relation headers. Forty of the 60 exact-count relations were non-zero and the other 20 returned zero; the 105 denied relations were not inferred to be zero.

| Family / relation | Exact rows |
|---|---:|
| `account_classification_audit` | 64 |
| `account_deletion_jobs` | 12 |
| `account_e2e_test_runners` | 2 |
| `account_ledger_rollout_state` | 1 |
| `account_paid_evidence` | 55 |
| `ai_analysis_cache` | 402 |
| `analysis_anonymous_preflight_attempts` | 4,713 |
| `analysis_anonymous_profile_cache` | 2,469 |
| `analysis_gemini_usage_expectations` | 40 |
| `analysis_operational_cost_summary` (view) | 391 |
| `analysis_pipeline_jobs` | 1,274 |
| `analysis_preflight_failures` | 5,069 |
| `analysis_preflights` | 317 |
| `analysis_provider_cost_ledger` | 24 |
| `analysis_provider_usage_expectations` | 24 |
| `analysis_requests` | 208 |
| `analysis_results` | 1,566 |
| `analysis_step_events` | 90 |
| `analysis_v2_result_image_objects` | 506 |
| `analysis_v2_scheduler_operations` | 3,351 |
| `analysis_v2_test_entitlement_consumptions` | 58 |
| `demo_analysis_fixtures` | 2 |
| `demo_analysis_runs` | 14 |
| `earlybird_checkout_reconciliations` | 4 |
| `earlybird_orders` | 158 |
| `earlybird_payment_discord_outbox` | 9 |
| `earlybird_plan_inventory` | 2 |
| `earlybird_waitlist` | 39 |
| `earlybird_webhook_events` | 88 |
| `gemini_token_usage` | 16,475 |
| `kakao_signup_discord_outbox` | 444 |
| `landing_leads` | 5,647 |
| `pending_analysis` | 11 |
| `precheckout_blite_cache` | 5 |
| `precheckout_blite_dispatches` | 3 |
| `private_accounts` | 4,861 |
| `result_feedback` | 1 |
| `scraper_provider_usage` | 49 |
| `sentry_discord_alert_outbox` | 1 |
| `users` | 482 |

Useful family roll-ups for the accessible 60-relation subset are: `account_*` 5 relations / 134 rows; non-V2 `analysis_*` 27 / 16,185; `analysis_v2_*` 3 / 3,915; `earlybird_*` 6 / 300; `precheckout_*` 3 / 8; the legacy/core set including `ai_analysis_cache` 14 / 28,373; and `demo_*` 2 / 16. These are operational prioritization signals only, not deletion authorization. All values in this section are exact header totals, not estimates; no denied-relation row count is supplied.

## Catalog evidence boundary: partitioning, sizes, columns, and keys

This audit does not claim a current catalog inventory for metadata that is not exposed by the safe API pass. The evidence limit is explicit for all 165 definitions:

| Metadata | Evidence available in this audit | Required owner-authorized evidence |
|---|---|---|
| Partitioned-table status | Source scan found zero `CREATE TABLE ... PARTITION BY` and zero `CREATE TABLE ... PARTITION OF` declarations. SQL/window `PARTITION BY` clauses were excluded because they are query syntax. Live partition status is unknown. | For every exposed definition, read-only `pg_class.relkind`, `relispartition`, `pg_partitioned_table`, and parent/child relation metadata; return booleans and sanitized names only. |
| Relation sizes | No `pg_relation_size`, `pg_indexes_size`, `pg_total_relation_size`, or `reltuples` data was collected. The 60 `Content-Range` totals are exact row counts, not disk-size measurements or estimates. | For all 165 definitions, including the 105 denied relations, provide size bytes or coarse size buckets and state whether any row estimate is exact or estimated. |
| Current columns | OpenAPI definitions are an API shape, not a guaranteed current `pg_attribute`/`information_schema.columns` inventory; no per-column export was retained. Current columns are unknown, including hidden or server-only columns. | For all 165 definitions, export sanitized column metadata: name, type, nullability, default/generated/identity flags, and ordinal position. Do not export values. |
| Primary/unique keys | Source declarations contain key text and FK references, but source history cannot prove current constraints after replacements or drops. No live `pg_constraint`/`pg_index` inventory was collected. | For all 165 definitions, export current PK/UNIQUE/index membership and ordered columns, plus FK validation/actions; names and booleans are sufficient. |
| Relation kind | One read-only view path is identified by OpenAPI; the other 164 paths are CRUD-capable API relations, but ordinary table, foreign table, view, partition, and sequence-owned status is not claimed without `pg_class`. | Return current `pg_class.relkind` and dependency/ownership metadata for every definition. |

The absence of a source partition declaration is not proof that the live database has no partitioned table, and a `403` does not exempt a relation from this owner catalog request.

## RLS, policies, foreign keys, triggers, and realtime

### RLS and policies

The whitespace-tolerant source scan normalized arbitrary whitespace across all 354 migration files and found 165 explicit `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` events covering 161 unique relation names. The source also has 126 explicit force-RLS events covering 123 unique names; the 38-name difference inside the explicit set is source-declared enable-only history, not current state.

The internal data API boundary migration contains a dynamic, conditional target array with exactly four names: `payments`, `payment_orders`, `users`, and `ai_analysis_cache`. `users` and `ai_analysis_cache` are already in the 161 explicit names; `payments` and `payment_orders` add two names. Therefore the union of explicit and dynamic source RLS coverage is 163 unique names. Against the 164 live CRUD-capable definitions, the only exposed table without source RLS-enable evidence is `pending_analysis`. `analysis_operational_cost_summary` is the sole read-only view and is not reported as a false missing-RLS table. The earlier 17-name missing list was a regex artifact caused by multiline whitespace and failure to account for the conditional target array.

This is a source-coverage inventory, not a claim about current live RLS. The direct-read pass returned 105 HTTP 403 responses, which is consistent with internal service-owned or force-RLS surfaces and revoked Data API grants. It is not a row absence signal. Current `pg_class`, `pg_policy`, and `information_schema.role_table_grants` state must be obtained from the owner-authorized catalog export before any retention or removal decision.

The source has 19 policy-create events and 5 policy-drop events. This history is especially important for `users`, `analysis_requests`, `analysis_results`, `comment_details`, `interaction_logs`, `private_accounts`, anonymous preflight, and earlybird surfaces. The internal data-boundary migration explicitly keeps server-owned access for `users`, `payments`, `payment_orders`, and `ai_analysis_cache` while removing client object access; this is a security boundary, not evidence that these relations can be deleted.

### Foreign keys

The source scan distinguishes schema-qualified and unqualified clauses:

- 243 clauses explicitly target `public.*`, across 34 distinct target names.
- 20 clauses use unqualified `REFERENCES <name>` syntax, across exactly five target names: `analysis_preflights`, `analysis_requests`, `analysis_results`, `earlybird_orders`, and `users`.
- The combined textual total is therefore 263 public-or-unqualified clauses across 35 distinct target names.

The 20 unqualified clauses are not silently counted as schema-qualified: their migration context makes public resolution plausible, but the live schema, referenced columns, validation state, and delete actions still require catalog proof. Inline source clauses include `CASCADE`, `RESTRICT`, `SET NULL`, and `NO ACTION` semantics.

The dependency shape is not a flat legacy schema:

- `analysis_requests` is the parent for request progress, results, V2 staged evidence, provider runs, revenue/coverage ledgers, image manifests, and owner-history projections.
- `analysis_preflights` is the parent for anonymous/paid admission, provider acquisition runs, precheckout caches, exclusion decisions, and expiry fences.
- `analysis_pipeline_jobs` and V2 scheduler operations fence background execution and recovery; removing them can create duplicate paid provider work.
- `earlybird_orders` and webhook/fulfillment/reconciliation relations are the commercial lifecycle and must stay separate from result execution.
- `users` and the account-principal bridge own identity classification and paid evidence; the auth identity must not be replaced by a new analytics identity as part of cleanup.

### Triggers and realtime publication

There are 83 trigger declaration events (78 source names). Many are immutability/recovery guards for payment, account, V2, precheckout, and concierge rows. Replacing a table without first reproducing those trigger invariants would weaken the safety boundary. Live `pg_trigger` enabled state and trigger-to-function dependencies were not queried.

The source contains exactly three `supabase_realtime` publication-add events across two migrations, with complete source membership:

1. Initial schema: `analysis_requests` (unqualified `ALTER PUBLICATION` statement).
2. V2 progress migration: guarded addition of `analysis_progress_state`.
3. V2 progress migration: guarded addition of `analysis_progress_events`.

The guarded additions check that `supabase_realtime` exists and that each table is not already a member. Current publication membership, replica identity, and live publication settings were not queried. Realtime rows must not be dropped merely because the browser currently polls or because direct service-role reads are denied.

## Code and documentation map

### Canonical paid Analysis V2

The canonical flow is:

1. `hooks/useAnalysisV2Preflight.ts` calls `POST /api/analysis/preflight` with an idempotency key, target input, and the anonymous device boundary when applicable.
2. `app/api/analysis/preflight/route.ts` creates or replays a preflight, reserves a generation, and enqueues the dedicated preflight worker; it has a bounded local fallback only when the configured queue mode allows it.
3. `app/api/analysis/preflight/worker/route.ts` performs preflight/provider work and fresh admission. `app/api/analysis/v2/worker/route.ts` receives the Cloud Tasks V2 job contract and runs the durable DAG.
4. V2 stores and RPCs checkpoint relationships, target evidence, profile batches, gender/feature stages, scoring, narratives, recovery, provider usage, and result publication. The result route checks authenticated ownership and authoritative publication before reading the page projection.
5. `app/result/[requestId]/page.tsx` first requests the V2 result when the pipeline is V2 and follows the server's `V2_ROUTE_REQUIRED` redirect when a legacy entry resolves to V2. Progress falls back to `/api/analysis/status` only when a V2 progress URL has not yet been selected.

The dense V2 table/RPC surface is intentional durability and observability state, not dead code. The live counts confirm activity in scheduler operations, provider/Gemini ledgers, preflight failures, image metadata, and results. V2 recovery, replay, concierge correction, score audit, and owner-history code is needed for already-created work and rollback evidence.

### V1 and step compatibility path

`app/api/analysis/run/route.ts` labels itself migration-only, returns HTTP 410 by default, and requires the explicit legacy gate plus admin authorization when enabled. `app/api/analysis/start/route.ts` still creates/loads `analysis_requests` and can launch the older step/background fallback; `app/api/analysis/status`, `/progress`, `/result`, `/step`, and the owner result page preserve compatibility and historical reads. The old `analysis_requests`/`analysis_results`/`private_accounts` surfaces have live counts and broad static references, so they are not drop candidates.

The V1 pipeline can be consolidated into V2 only after all of the following are recorded: zero production traffic for the V1 write path across a complete observation window, no scheduled job or script invokes it, no database function/trigger/view depends on its tables, all historical result pages resolve through a compatibility adapter, and an archive/restore drill passes. The migration-only 410 is a useful control, but it does not prove zero traffic or zero database dependencies.

### Anonymous preflight, B-lite, and admission

Anonymous preflight is an active funnel, not legacy residue. The client stores an anonymous device boundary; the server uses hashed IP/device/target values for bounded budget checks, signs a 30-minute claim, persists a claim hash rather than the raw token, and claims the preflight against the authenticated owner. Anonymous reads deliberately omit the raw provider image URL. `preflight-retention.ts` reconciles provider costs before purging short-lived source evidence and expired preflights, then terminally scrubs parent data. The non-zero live counts for anonymous attempts, profile cache, preflight failures, and preflights are direct evidence against an immediate drop.

### Instagram provider adapters

`lib/services/instagram/scraper.ts` remains the router for profile, batch profile, followers, and following capabilities. The Apify, RapidAPI, and self-hosted implementations are selected per capability through configuration; fallback behavior is explicit. The README and V2 operations document distinguish public legacy self-hosted access, paid authenticated-worker access, manual RapidAPI/CoderX diagnostics, and Apify relationship/profile providers. This switching layer is deliberate rollback/provider policy and must be kept.

### Commercial lifecycle and media

`earlybird_orders`, `earlybird_waitlist`, webhook events, fulfillment, payment reconciliation, and Discord outboxes form a separate commercial lifecycle. Checkout finalization intentionally does not create an analysis request until the admission boundary is satisfied. `payments` and `payment_orders` are server-owned legacy relations with client access revoked; their lack of direct app `.from()` references is insufficient for deletion.

Supabase Storage has zero buckets in the verified endpoint. V2 result images use the private R2 store and `analysis_v2_result_image_objects` as the database registry; private GCS is the short-lived AI source-media workspace. R2/GCS credentials and object paths were not inspected. The external media lifecycle is therefore a dependency to preserve and separately audit, not a Supabase Storage drop candidate.

### Static reference scan

Across `app`, `lib`, `hooks`, `components`, `scripts`, and `docs`, 152 of 165 live definition names appeared in text references. Thirteen names did not appear in that scan: `analysis_gemini_usage_expectations`, `analysis_provider_usage_expectations`, `analysis_revenue_ai_routing_attempt_lineages`, `analysis_revenue_final_coverage_gates`, `analysis_revenue_primary_quality_checkpoints`, `analysis_revenue_resolver_passes`, `analysis_v2_result_revision_female_rows`, `analysis_v2_result_revisions`, `comment_details`, `earlybird_profile_evidence_failure_recoveries`, `earlybird_v211_concierge_publications`, `interaction_logs`, and `pending_analysis`.

This scan is intentionally conservative. It does not resolve dynamic RPC names, SQL bodies, triggers, scheduled jobs, external dashboards, Cloud Tasks, Vercel cron configuration, or historical clients. The 13 names are not drop candidates; each is classified exactly once in the ledger below.

## Classification ledger for all 165 exposed definitions

The ledger covers the 165 PostgREST definitions only: 164 CRUD-capable relation paths plus the one read-only view path. RPC paths are a separately counted routine surface (639 names); routine dependency proof remains an owner-catalog gate and is not misclassified as a relation. The labels are mutually exclusive and have exactly one meaning:

- `keep`: active or protected; no cleanup proposal now.
- `consolidate`: move behind one canonical contract or equivalent projection only after compatibility and traffic proof.
- `archive-then-drop`: a future retirement path after bounded archive, restore proof, retention checks, and separate approval; it is not a current deletion instruction.
- `drop-candidate`: all current proof bars pass; there are none.
- `unknown`: evidence is incomplete or an owner-level dependency may exist; no deletion action follows.

Every exposed definition appears in exactly one complete membership set below. The sets are disjoint and their counts sum to 165.

### `keep` (158)

`account_classification_audit`, `account_deletion_jobs`, `account_ledger_rollout_state`, `account_paid_evidence`, `ai_analysis_cache`, `analysis_anonymous_preflight_attempts`, `analysis_anonymous_profile_cache`, `analysis_anonymous_profile_cache_locks`, `analysis_apify_credit_snapshots`, `analysis_beta_access_grants`, `analysis_beta_access_policy`, `analysis_beta_pool_allocations`, `analysis_beta_pool_local_debits`, `analysis_beta_pool_reservation_archive`, `analysis_beta_pool_reservations`, `analysis_beta_runtime_gate`, `analysis_gemini_usage_expectations`, `analysis_interaction_evidence`, `analysis_interaction_jobs`, `analysis_interaction_scores`, `analysis_lifecycle_events`, `analysis_pipeline_jobs`, `analysis_preflight_acquisition_cost_events`, `analysis_preflight_failures`, `analysis_preflight_provider_runs`, `analysis_preflights`, `analysis_progress_events`, `analysis_progress_state`, `analysis_provider_cost_ledger`, `analysis_provider_runs`, `analysis_provider_usage_expectations`, `analysis_requests`, `analysis_result_share_observations`, `analysis_results`, `analysis_revenue_ai_routing_attempt_lineages`, `analysis_revenue_cost_operations`, `analysis_revenue_dispatch_guards`, `analysis_revenue_final_coverage_gates`, `analysis_revenue_fresh_provider_evidence`, `analysis_revenue_primary_quality_checkpoints`, `analysis_revenue_resolver_capacity_reservations`, `analysis_revenue_resolver_outcome_overlays`, `analysis_revenue_resolver_passes`, `analysis_revenue_run_ledgers`, `analysis_step_events`, `analysis_target_interactors`, `analysis_v2_active_profile_heartbeats`, `analysis_v2_ai_attempts`, `analysis_v2_ai_global_result_cache`, `analysis_v2_ai_result_checkpoints`, `analysis_v2_ai_scoring_stage_checkpoints`, `analysis_v2_apify_secret_ref_prune_guard`, `analysis_v2_candidate_feature_manifests`, `analysis_v2_candidate_feature_rows`, `analysis_v2_candidate_score_manifests`, `analysis_v2_candidate_score_rows`, `analysis_v2_dag_batch_results`, `analysis_v2_dag_batch_topology`, `analysis_v2_dag_scopes`, `analysis_v2_dag_stage_manifests`, `analysis_v2_failure_receipts`, `analysis_v2_female_results`, `analysis_v2_gemini_leases`, `analysis_v2_gender_resolution_metrics`, `analysis_v2_gender_routing_candidates`, `analysis_v2_gender_routing_manifests`, `analysis_v2_media_artifacts`, `analysis_v2_mutual_rows`, `analysis_v2_narrative_manifests`, `analysis_v2_narrative_rows`, `analysis_v2_partner_safety_manifests`, `analysis_v2_partner_safety_rows`, `analysis_v2_preliminary_score_manifests`, `analysis_v2_preliminary_score_rows`, `analysis_v2_private_name_manifests`, `analysis_v2_private_name_rows`, `analysis_v2_private_results`, `analysis_v2_profile_fetch_batches`, `analysis_v2_profile_fetch_outcomes`, `analysis_v2_profile_fetch_telemetry`, `analysis_v2_profile_provider_canary_experiments`, `analysis_v2_profile_provider_canary_runs`, `analysis_v2_profile_repair_canary_runs`, `analysis_v2_provider_cleanup_intents`, `analysis_v2_provider_execution_policies`, `analysis_v2_provider_runs`, `analysis_v2_recovery_provider_run_adoptions`, `analysis_v2_relationship_manifests`, `analysis_v2_relationship_rows`, `analysis_v2_relationship_sides`, `analysis_v2_replay_capture_audit_events`, `analysis_v2_replay_capture_authorizations`, `analysis_v2_replay_capture_fragments`, `analysis_v2_result_coverage_telemetry`, `analysis_v2_result_image_manifests`, `analysis_v2_result_image_objects`, `analysis_v2_result_image_purge_outbox`, `analysis_v2_result_revision_female_rows`, `analysis_v2_result_revisions`, `analysis_v2_result_summaries`, `analysis_v2_reverse_like_manifests`, `analysis_v2_reverse_like_rows`, `analysis_v2_scheduler_operations`, `analysis_v2_score_audit_intents`, `analysis_v2_score_audit_rows`, `analysis_v2_score_audit_runs`, `analysis_v2_score_audit_scan_locators`, `analysis_v2_score_audit_source_rows`, `analysis_v2_score_audit_sources`, `analysis_v2_selfhosted_auth_runs`, `analysis_v2_target_evidence_manifests`, `analysis_v2_test_entitlement_consumptions`, `analysis_v2_unconfirmed_start_resolutions`, `comment_details`, `earlybird_adoption_policy_failure_rearms`, `earlybird_checkout_reconciliations`, `earlybird_concierge_batch_cohort_members`, `earlybird_concierge_batch_target_lineage_repairs`, `earlybird_concierge_snapshot_conflict_recoveries`, `earlybird_first15_canary_provider_rearms`, `earlybird_fulfillments`, `earlybird_orders`, `earlybird_partial_adoption_second_rearms`, `earlybird_payment_discord_outbox`, `earlybird_pfe3_media_artifact_rearms`, `earlybird_pfe_target_evidence_start_rejection_rearms`, `earlybird_plan_inventory`, `earlybird_profile_evidence_failure_recoveries`, `earlybird_profile_fetch_exhaustion_recoveries`, `earlybird_schema_failure_recoveries`, `earlybird_terminal_unavailable_exhaustion_rearms`, `earlybird_v211_apify_transient_admission_resumes`, `earlybird_v211_apify_transient_replays`, `earlybird_v211_concierge_copy_corrections`, `earlybird_v211_concierge_publications`, `earlybird_v211_concierge_replays`, `earlybird_v211_lease_policy_failure_rearms`, `earlybird_v211_policy_identity_replays`, `earlybird_v211_profile_ai_diagnostic_replays`, `earlybird_v211_relationship_lineage_failure_rearms`, `earlybird_v212_concierge_copy_corrections`, `earlybird_v213_concierge_copy_corrections`, `earlybird_v214_concierge_gemini_copy_corrections`, `earlybird_waitlist`, `earlybird_webhook_events`, `gemini_token_usage`, `interaction_logs`, `kakao_signup_discord_outbox`, `landing_leads`, `precheckout_blite_cache`, `precheckout_blite_dispatches`, `precheckout_blite_sources`, `private_accounts`, `result_feedback`, `scraper_provider_usage`, `selfhosted_profile_request_start_gate`, `sentry_discord_alert_outbox`, `users`

### `consolidate` (1)

`analysis_operational_cost_summary`

This view remains live and had 391 exact accessible rows. Any replacement must preserve equivalent columns, authorization, historical reads, and aggregate semantics before the view is retired.

### `archive-then-drop` (3)

`account_e2e_test_runners`, `demo_analysis_fixtures`, `demo_analysis_runs`

This is a future, separately approved path only. It requires a sanitized aggregate preflight, an explicit identity allowlist, archive and restore proof, Auth deletion proof where applicable, and post-operation verification. Current small counts do not authorize deletion.

### `unknown` (3)

`payment_orders`, `payments`, `pending_analysis`

These remain unresolved live definitions. `payments` and `payment_orders` are server-owned legacy boundaries and are covered by the conditional source RLS target array; `pending_analysis` has 11 exact rows and no current source RLS-enable evidence. Obtain owner-level relation kind, grants, policies, dependencies, and historical provenance before deciding retention.

### `drop-candidate` (0)

No exposed definition.

No classification authorizes DDL. The three future-retirement definitions are not current drop candidates. The three unresolved definitions receive no cleanup instruction.

## Required data and identity policy

The cleanup design must preserve the following invariants:

1. **Retention floor:** preserve user and analysis data dated 2026-07-24 or later. Do not use a table-wide delete to remove “legacy” rows. Earlier data also needs an owner-approved archive policy; age alone is not enough.
2. **Admin identity:** preserve the admin/operator account and its classification. Admin/test cleanup is a separate approved operation, never an inferred side effect of table consolidation.
3. **Test identities:** the 22 E2E identities and admin test artifacts are not in scope for this audit. Remove them only with a separately approved identity allowlist, aggregate preflight, Auth deletion proof, and post-delete verification.
4. **Landing target/excluded split:** `landing_leads` currently has an input plus attribution fields and is service-owned. Future funnel metrics must distinguish an analysis target from an explicitly excluded target; do not reinterpret one mixed column or use paid metrics for both.
5. **Waitlist versus withdrawn archive:** keep `earlybird_waitlist` as the active waitlist. Create a separate, access-controlled withdrawn archive or equivalent immutable lifecycle boundary; do not fold withdrawn records into waitlist state. No dedicated live withdrawn relation was observed in this audit, so its future design is unknown until approved.
6. **Stable anonymous-to-auth mapping:** preserve the existing opaque claim/hash and device boundary. Claim a preflight to an authenticated owner once, without using a mutable email, username, or raw token as the analytics identity. Preserve the owner row if a repeated claim resolves to an already-owned preflight.
7. **Paid-only `first_paid_at`:** use the account-principal bridge's external classification plus immutable provider/payment evidence. A status string, positive amount, E2E order, admin order, `payment_pending`, or refund alone must not set paid-ever or `first_paid_at`; when valid evidence exists, retain the earliest paid timestamp monotonically.
8. **Abandoned `payment_pending`:** retain a short bounded pending window, but never change or delete a pending order without independent provider evidence and an auditable disposition. Preserve immutable pricing/payment lineage and do not manufacture a new order to work around an unresolved one.
9. **Media and provider evidence:** preserve result-image registry rows until the external R2 deletion is confirmed; preserve ambiguous provider-start ledgers until the provider outcome is resolved. Never infer “not executed” from a missing response or missing object.

## Safe future cleanup sequence

This sequence is intentionally procedural and contains no executable SQL:

1. **Owner proof:** obtain a read-only catalog snapshot for the verified endpoint covering relations, columns, primary/unique keys, foreign keys, views/materialized views, sequences, routines, triggers, policies, RLS/force-RLS, grants, publications, `pg_depend`, and migration history. Export only object metadata and aggregate counts.
2. **Traffic proof:** instrument or inspect route/job/RPC access counts for a complete observation window. Prove V1 write quietness separately from V1 historical reads. Include Cloud Tasks, cron, scripts, dashboards, and external operators.
3. **Compatibility boundary:** make the canonical V2 owner-history/result projection able to serve every retained V1 result. Preserve request IDs and owner authorization; do not rewrite historical row identity.
4. **Archive proof:** create an encrypted, access-controlled archive with aggregate manifests and restore verification. Exclude all data dated 2026-07-24 or later from destructive scope, and separately preserve admin/auth identity. Archive pending payment and provider evidence before considering retention.
5. **Reference migration:** move callers one surface at a time, with dual-read comparison that records only sanitized aggregate mismatches. Keep the old path read-only during the rollback window.
6. **Retention gate:** expire only short-lived source/cache rows whose provider costs, leases, and external objects are terminal and reconciled. Keep payment evidence, account identity, result ownership, and legal/operational audit rows.
7. **Object-removal approval:** only after the prior gates pass should an owner approve a small, exact migration allowlist for an object. Review migration order, dependent routines, triggers, policies, publications, grants, and rollback before applying it. This audit supplies no migration file or executable SQL.
8. **Post-removal verification:** re-run catalog and aggregate checks, route smoke tests, owner-history reads, payment/recovery reconciliation, media access/purge checks, and secret scans. Retain the archive and rollback evidence for the agreed window.

## Open questions blocking deletion

- Can the owner provide management-plane confirmation that the configured endpoint is the intended production `yeosachin` project, plus a read-only catalog snapshot? The current environment verified only the endpoint/schema fingerprint.
- What are the exact live relation kinds, partition flags, sizes, row estimates, current columns, primary/unique keys, foreign keys, policies, grants, triggers, publication membership, and `pg_depend` edges for all 165 definitions, especially the 105 denied relations and the 13 no-static-reference names?
- Which migration versions are applied remotely, and does remote history exactly align with the 354-file source set? The protected reconciliation migration must remain untouched.
- Which external jobs, dashboards, cron tasks, operators, and historical clients call long-tail RPCs or V1 endpoints dynamically?
- What are the date-bounded aggregate counts, by account classification and lifecycle, for data before and after 2026-07-24? Do not answer this by exporting rows.
- Which payment records have independent provider evidence, and which `payment_pending` records are abandoned versus still recoverable? No payment status was changed in this audit.
- What is the external R2/GCS object count and terminal/orphan status by request age? Read object metadata only after the storage owner approves a sanitized aggregate report.

## Security and operations notes

The service-role boundary is correctly treated as server-only in the inspected paths; do not expose it to a browser or weaken the revoked client grants to make cleanup easier. The anonymous claim design hashes the claim and rate-limit inputs, bounds the lifetime, and omits raw image URLs from anonymous projections; preserve those properties during any mapping consolidation. The result and media routes use owner/administrator authorization, no-store behavior, opaque media references, and R2 integrity checks; those are dependencies of the canonical path.

The 105 HTTP 403 responses are a positive signal that direct Data API access is restricted on internal surfaces. Any follow-up catalog export should use the minimum owner-authorized read-only path and should return object names, booleans, and aggregate counts only. Do not log or commit secrets, cookies, raw identifiers, provider payloads, claim tokens, media URLs, or raw user content.

## Audit ledger and verification

- Correction work is based on `c507254f68a72bc3de8e243fdb6827eb25710031`; the audit's source baseline remains `origin/main` at `2a28326462bf636f92368dc894b5ea76911d79bb`.
- Protected migration `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql` remained tracked and unchanged.
- Existing unrelated `package-lock.json` worktree change was preserved and not staged.
- Live checks were aggregate/metadata-only: OpenAPI definitions and paths, HEAD relation count headers, exact counts for accessible relations, forbidden-status totals, and Storage bucket count.
- Static checks included whitespace-normalized RLS declaration counts, dynamic RLS target coverage, source-to-live table alignment, qualified and unqualified FK reference counts, complete realtime publication-add membership, relation/RPC text references, route/store/provider mapping, and documentation cross-reference.
- The report pair was secret-scanned for service-role/password/connection-string/Bearer/JWT patterns and identifier-like email/UUID patterns before commit.
- No production mutation, migration repair, DDL, DML, mutation RPC, provider call, or deployment was performed.
