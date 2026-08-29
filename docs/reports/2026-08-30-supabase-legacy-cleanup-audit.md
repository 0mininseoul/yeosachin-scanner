# Supabase and legacy-analysis cleanup audit

**Audit date:** 2026-08-30 (Asia/Seoul)

**Source baseline:** `origin/main` at `2a28326462bf636f92368dc894b5ea76911d79bb`

**Audit mode:** read-only catalog metadata, schema metadata, and aggregate count headers; no row payloads were collected.

## Executive decision

There is no safe immediate drop candidate in the evidence available for this audit. The live API exposes 165 named definitions, the source tree has active references to 152 of those relation names, and the remaining names include history, recovery, and protected service-owned surfaces; absence of a direct text reference is not evidence of absence of a trigger, foreign key, function, job, or historical-read dependency.

The paid Analysis V2 path is the canonical execution path: preflight and entitlement/admission lead to Cloud Tasks, the V2 worker writes staged durable state, finalization publishes an owner-scoped result, and result images use the private R2 registry. The V1/step compatibility surface remains a migration-only or owner-history read boundary, but it must be consolidated only after traffic, database dependencies, and historical-result compatibility are proven. The intentional Apify/RapidAPI/self-hosted provider switching is retained; it is not a cleanup target.

The live endpoint and expected schema fingerprint were verified without printing credentials or row data. The Supabase management-plane project identity could not be independently proven in this environment: the linked CLI query was blocked by network/privilege limitations and the account-visible project list did not identify the endpoint. The live evidence is therefore labeled “canonical endpoint/schema fingerprint” rather than owner-level project proof, and every destructive decision remains blocked on an owner-authorized catalog snapshot.

## Scope and safety boundary

This audit intentionally did **not**:

- read row-level data, names, emails, usernames, UUIDs, cookies, provider payloads, or raw storage paths;
- call a mutation-capable RPC, perform DDL or DML, repair migration history, or run `supabase db push`;
- edit a migration, executable SQL, application code, provider configuration, or the protected reconciliation migration;
- make any conclusion from a `403` relation response that the relation is empty;
- recommend deleting the Apify/RapidAPI/self-hosted route switch.

The live relation count was collected with HTTP HEAD/count metadata requests only. The exact-count pass returned `Content-Range` totals and no response bodies. PostgREST OpenAPI metadata was used to enumerate exposed relation and RPC paths. Supabase Storage bucket metadata was counted without retaining bucket names. Static inspection covered `app/`, `lib/`, `hooks/`, `components/`, `scripts/`, `docs/`, and `supabase/migrations/`.

### Identity and evidence limitation

The URL was taken from the canonical main worktree's environment file by key-name lookup without sourcing or printing the file. Its host was checked as a Supabase HTTPS host, and the endpoint returned a standard public schema OpenAPI document with 165 definitions and 805 paths. The CLI reported version 2.114.0; its project listing exposed two account-visible projects that did not match the endpoint-derived project identity, while the linked database query was unavailable because the current network did not support the project's IPv6 route. A separate link attempt was rejected by the account's endpoint privilege. No project reference, token, secret, database password, or authorization header is included in this report.

This is enough to establish that the expected production schema is reachable at the configured endpoint, but not enough to claim management-plane ownership or a complete `pg_catalog` snapshot. The follow-up gate is an owner-authorized, read-only catalog export for the same endpoint.

## Sanitized inventory totals

| Surface | Observed total | Evidence and qualification |
|---|---:|---|
| PostgREST named definitions | 165 | OpenAPI definitions; exposed API surface, not a complete database catalog |
| Exposed relation paths | 165 | 164 CRUD-capable relations plus one read-only view path |
| Exposed CRUD relations | 164 | A `403` on a relation means direct role access was denied, not zero rows |
| Exposed read-only views | 1 | `analysis_operational_cost_summary` |
| Exposed materialized views | 0 observed | No matview path in OpenAPI; owner-level `pg_class` confirmation is still required |
| Exposed RPC paths | 639 | Unique `/rpc/` names in OpenAPI; some long PostgreSQL identifiers are truncated and overloads exist |
| Relations with exact-count headers | 60 | HEAD requests only; zero row bodies read |
| Exact-count total for accessible relations | 48,931 | Sum of 60 `Content-Range` values; not a PII export |
| Relations with direct-read denial | 105 | HTTP 403; likely internal/forced-RLS or revoked surfaces; do not treat as absent |
| Local migration files | 354 | Git-tracked SQL files; newest timestamp is `20260829120000` |
| Unique table names created in current migration source | 161 | Declaration scan; not proof that every migration is applied remotely |
| Unique view names in migration source | 2 | Three create/replace events: `analysis_operational_cost_summary` and `daily_token_usage` |
| Explicit materialized-view declarations in source | 0 | Declaration scan |
| Explicit sequence declarations in source | 0 | Declaration scan; serial/identity-owned sequences still need catalog proof |
| Function declaration events / unique names | 951 / 646 | Replacements, overloads, and historical definitions make event count non-canonical |
| Trigger declaration events / unique names | 83 / 78 | Source declaration scan; current enabled state unverified |
| Policy create events / drop events | 19 / 5 | Source history, not current `pg_policy` state |
| RLS enable events / unique relations | 153 / 148 | Source history; 110 unique relations also have force-RLS events |
| Force-RLS events / unique relations | 113 / 110 | Source history; all forced names were also in the enabled set |
| Public FK reference lines / distinct targets | 243 / 34 | Source scan of `REFERENCES public.*`; current constraint state unverified |
| Guarded realtime publication-add events | 2 | `analysis_progress_state` and `analysis_progress_events` in migration source; live membership unverified |
| Supabase Storage buckets | 0 | Storage API bucket count; result-image path is external R2 and source media uses private GCS |

The migration source contains 161 unique current table names. The live exposed table set is 164, so four live names are not explained by a current `CREATE TABLE` declaration: one view (`analysis_operational_cost_summary`) and the legacy relations `payment_orders`, `payments`, and `pending_analysis`. `daily_token_usage` is declared in the old source but is not in the current exposed relation list. The three extra legacy relations must remain `unknown` until the owner-level catalog and dependency pass explains their provenance.

## Aggregate live counts

The following are sanitized exact counts from accessible relation headers. They are counts only; no row data was read. Forty of the 60 exact-count relations were non-zero and the other 20 returned zero; the 105 denied relations were not inferred to be zero.

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

Useful family roll-ups for the accessible 60-relation subset are: `account_*` 5 relations / 134 rows; non-V2 `analysis_*` 27 / 16,185; `analysis_v2_*` 3 / 3,915; `earlybird_*` 6 / 300; `precheckout_*` 3 / 8; the legacy/core set including `ai_analysis_cache` 14 / 28,373; and `demo_*` 2 / 16. These are operational prioritization signals only, not deletion authorization.

## RLS, policies, FK, trigger, and publication assessment

### RLS and policies

The migration history enables RLS on 148 unique relations and force-RLS on 110 of them; there are 38 source-declared enabled-but-not-forced relations. The direct-read pass returned 105 HTTP 403 responses, which is consistent with internal service-owned or force-RLS surfaces and revoked Data API grants. It is not a row absence signal.

Seventeen exposed names had no local `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` declaration in the scanned migration source: `analysis_operational_cost_summary`, `analysis_v2_apify_secret_ref_prune_guard`, `earlybird_concierge_batch_target_lineage_repairs`, `earlybird_concierge_snapshot_conflict_recoveries`, `earlybird_pfe3_media_artifact_rearms`, `earlybird_pfe_target_evidence_start_rejection_rearms`, `earlybird_profile_evidence_failure_recoveries`, `earlybird_profile_fetch_exhaustion_recoveries`, `earlybird_terminal_unavailable_exhaustion_rearms`, `earlybird_v211_apify_transient_admission_resumes`, `earlybird_v211_apify_transient_replays`, `earlybird_v211_lease_policy_failure_rearms`, `earlybird_v211_profile_ai_diagnostic_replays`, `earlybird_v211_relationship_lineage_failure_rearms`, `payment_orders`, `payments`, and `pending_analysis`. Several recovery relations intentionally revoke Data API privileges; the three legacy relations are not explained by current table-create declarations. The owner-level `pg_class`, `pg_policy`, and `information_schema.role_table_grants` snapshot must resolve these before any retention or removal decision.

The source has 19 policy-create events and 5 policy-drop events. This history is especially important for `users`, `analysis_requests`, `analysis_results`, `comment_details`, `interaction_logs`, `private_accounts`, anonymous preflight, and earlybird surfaces. The internal data boundary migration explicitly keeps server-owned access for `users`, `payments`, `payment_orders`, and `ai_analysis_cache` while removing client object access; this is a security boundary, not evidence that these relations can be deleted.

### Foreign keys and triggers

The source contains 243 `REFERENCES public.*` lines targeting 34 distinct public relations. The most frequent target names are `analysis_requests` (88), `analysis_preflights` (40), `earlybird_orders` (27), `analysis_pipeline_jobs` (25), and `users` (15). Inline source clauses include both `CASCADE` and `RESTRICT` semantics; the current database constraint list, validation state, and all referenced columns still require owner-level catalog proof.

The dependency shape is not a flat legacy schema:

- `analysis_requests` is the parent for request progress, results, V2 staged evidence, provider runs, revenue/coverage ledgers, image manifests, and owner-history projections.
- `analysis_preflights` is the parent for anonymous/paid admission, provider acquisition runs, precheckout caches, exclusion decisions, and expiry fences.
- `analysis_pipeline_jobs` and V2 scheduler operations fence background execution and recovery; removing them can create duplicate paid provider work.
- `earlybird_orders` and webhook/fulfillment/reconciliation relations are the commercial lifecycle and must stay separate from result execution.
- `users` and the account-principal bridge own identity classification and paid evidence; the auth identity must not be replaced by a new analytics identity as part of cleanup.

There are 83 trigger declaration events (78 source names). Many are immutability/recovery guards for payment, account, V2, precheckout, and concierge rows. Replacing a table without first reproducing those trigger invariants would weaken the safety boundary. Live `pg_trigger` enabled state and trigger-to-function dependencies were not queried.

The source has two guarded additions to the `supabase_realtime` publication for progress state/events. The current publication membership and replica identity were not queried; realtime rows must not be dropped merely because the browser currently polls or because direct service-role reads are denied.

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

Across `app`, `lib`, `hooks`, `components`, `scripts`, and `docs`, 152 of 165 live relation names appeared in text references. Thirteen names did not appear in that scan: `analysis_gemini_usage_expectations`, `analysis_provider_usage_expectations`, `analysis_revenue_ai_routing_attempt_lineages`, `analysis_revenue_final_coverage_gates`, `analysis_revenue_primary_quality_checkpoints`, `analysis_revenue_resolver_passes`, `analysis_v2_result_revision_female_rows`, `analysis_v2_result_revisions`, `comment_details`, `earlybird_profile_evidence_failure_recoveries`, `earlybird_v211_concierge_publications`, `interaction_logs`, and `pending_analysis`.

This scan is intentionally conservative. It does not resolve dynamic RPC names, SQL bodies, triggers, scheduled jobs, external dashboards, Cloud Tasks, Vercel cron configuration, or historical clients. The thirteen names are `unknown`, not drop candidates.

## Classification matrix

The classes below mean:

- **keep:** active or protected; no cleanup proposal now;
- **consolidate:** move behind one canonical contract only after compatibility and traffic proof;
- **archive-then-drop:** possible future retirement after a bounded archive, retention proof, and separate approval;
- **drop-candidate:** no current item meets this bar;
- **unknown:** evidence is incomplete or an owner-level dependency may exist.

| Surface | Classification | Evidence | Confidence |
|---|---|---|---|
| `users`, Auth identity, account classification, admin/operator identity | keep | Live `users` count; account-principal bridge; server-owned access boundary; admin identity is a protected control plane | High |
| `analysis_requests`, `analysis_results`, `private_accounts`, progress/result compatibility | keep | Non-zero counts, owner-history/result routes, broad code references, historical data requirement | High |
| V2 jobs, staged evidence, provider/Gemini/revenue ledgers, recovery/replay/audit | keep | 105 restricted internal relations plus active counts and trigger/FK fences | High |
| Preflight, anonymous cache/claims, B-lite, admission and retention | keep | Active routes, queue worker, retention routine, non-zero exact counts | High |
| `earlybird_orders`, fulfillment/webhook/reconciliation, `earlybird_waitlist` | keep | Commercial lifecycle and provider-evidence state are separate from analysis execution | High |
| Apify/RapidAPI/self-hosted switching and authenticated worker | keep | Explicit router/configuration and rollback/manual-provider contract | High |
| R2 result-image registry and private GCS source workspace | keep | V2 result route and media store; Supabase Storage is empty | High |
| V1 write/start/step implementation and duplicate DTO/store projections | consolidate | `/run` is 410/admin-gated, but `/start`, status/result compatibility, scripts, and historical reads remain | Medium |
| `analysis_operational_cost_summary` and older observability projections | consolidate only after proof | Live view has 391 accessible rows and a code reference; replace only with an equivalent canonical projection | Medium |
| Short-lived anonymous/precheckout source evidence | archive-then-drop | Retention RPCs exist, but current counts are non-zero and provider-cost reconciliation must precede purge | Medium |
| `pending_analysis` | unknown; archive-then-drop only later | 11 exact rows, no static text reference, but live relation and legacy behavior are not explained by current migrations | Low |
| `payments`, `payment_orders` | unknown; archive-then-drop only later | Server-owned legacy boundary and unknown live catalog state; no direct app reference is not enough | Low |
| `demo_analysis_*`, E2E runner rows, admin test artifacts | archive-then-drop only under a separate approval | Small live demo counts; operator/test routes and identity classification remain active; 22 E2E identities were not read | Medium |
| Thirteen live relations without static text references | unknown | Could be trigger/RPC/recovery/history dependencies; no owner-level `pg_depend` proof | Low |
| Long-tail function overloads and old RPC names | unknown | 951 declaration events, 646 source names, 639 exposed paths; PostgreSQL identifier truncation/overloads make name-only comparison unsafe | Low |
| Any current relation as an immediate drop-candidate | drop-candidate: none | No item has simultaneous zero traffic, zero code/DB dependency, archive proof, and rollback proof | High |

No classification authorizes DDL. `archive-then-drop` is a future gate, not an instruction to delete data now.

## Required data and identity policy

The cleanup design must preserve the following invariants:

1. **Retention floor:** preserve user and analysis data dated 2026-07-24 or later. Do not use a table-wide delete to remove “legacy” rows. Earlier data also needs an owner-approved archive policy; age alone is not enough.
2. **Admin identity:** preserve the admin/operator account and its classification. Admin/test cleanup is a separate approved operation, never an inferred side effect of table consolidation.
3. **Test identities:** the 22 E2E identities and admin test artifacts are not in scope for this audit. Remove them only with a separately approved identity allowlist, aggregate preflight, auth deletion proof, and post-delete verification.
4. **Landing target/excluded split:** `landing_leads` currently has an input plus attribution fields and is service-owned. Future funnel metrics must distinguish an analysis target from an explicitly excluded target; do not reinterpret one mixed column or use paid metrics for both.
5. **Waitlist versus withdrawn archive:** keep `earlybird_waitlist` as the active waitlist. Create a separate, access-controlled withdrawn archive or equivalent immutable lifecycle boundary; do not fold withdrawn records into waitlist state. No dedicated live withdrawn relation was observed in this audit, so its future design is `unknown` until approved.
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

- Can the owner provide management-plane confirmation that the configured endpoint is the intended production `yeosachin` project, plus a read-only catalog snapshot? The current environment could verify the endpoint/schema fingerprint but not owner-level project identity.
- What are the exact live relation kinds, sizes, row estimates, policies, grants, triggers, publication membership, and `pg_depend` edges for the 105 denied relations and the 13 no-static-reference names?
- Which migration versions are applied remotely, and does remote history exactly align with the 354-file source set? The protected reconciliation migration must remain untouched.
- Which external jobs, dashboards, cron tasks, operators, and historical clients call long-tail RPCs or V1 endpoints dynamically?
- What are the date-bounded aggregate counts, by account classification and lifecycle, for data before and after 2026-07-24? Do not answer this by exporting rows.
- Which payment records have independent provider evidence, and which `payment_pending` records are abandoned versus still recoverable? No payment status was changed in this audit.
- What is the external R2/GCS object count and terminal/orphan status by request age? Read object metadata only after the storage owner approves a sanitized aggregate report.

## Security and operations notes

The service-role boundary is correctly treated as server-only in the inspected paths; do not expose it to a browser or weaken the revoked client grants to make cleanup easier. The anonymous claim design hashes the claim and rate-limit inputs, bounds the lifetime, and omits raw image URLs from anonymous projections; preserve those properties during any mapping consolidation. The result and media routes use owner/administrator authorization, no-store behavior, opaque media references, and R2 integrity checks; those are dependencies of the canonical path.

The 105 HTTP 403 responses are a positive signal that direct Data API access is restricted on internal surfaces. Any follow-up catalog export should use the minimum owner-authorized read-only path and should return object names, booleans, and aggregate counts only. Do not log or commit secrets, cookies, raw identifiers, provider payloads, claim tokens, media URLs, or raw user content.

## Audit ledger and verification

- Baseline checked: `HEAD == origin/main == 2a28326462bf636f92368dc894b5ea76911d79bb`.
- Protected migration `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql` remained tracked and unchanged.
- Existing unrelated `package-lock.json` worktree change was preserved and not staged.
- Live checks were aggregate/metadata-only: OpenAPI definitions and paths, HEAD relation count headers, exact counts for accessible relations, forbidden-status totals, and Storage bucket count.
- Static checks included migration declaration counts, source-to-live table alignment, relation/RPC text references, route/store/provider mapping, and documentation cross-reference.
- The report pair was secret-scanned for service-role/password/connection-string/Bearer/JWT patterns and identifier-like email/UUID patterns before commit.
- No production mutation, migration repair, DDL, DML, RPC mutation, provider call, or deployment was performed.
