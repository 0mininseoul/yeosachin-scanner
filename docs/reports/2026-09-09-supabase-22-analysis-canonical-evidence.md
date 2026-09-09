# Analysis canonicalization evidence

Status: **BLOCKED for production parity and cutover**

Date: 2026-09-09 (Asia/Seoul)

This report records local contract evidence only. No production query, remote migration, provider call, admission activation, payment mutation, destructive source operation, or real canary was performed in this worktree.

## Local implementation evidence

- Migration generated with `npx supabase migration new add_analysis_canonical_tables`: `supabase/migrations/20260909095740_add_analysis_canonical_tables.sql`.
- Six additive tables are present: `analysis_jobs`, `analysis_events`, `analysis_artifacts`, `analysis_costs`, `analysis_cache`, and `analysis_audit_bundles`.
- Every canonical table enables and forces RLS, revokes table privileges from `PUBLIC`, `anon`, `authenticated`, and `service_role`, and exposes writes/reads only through service-role RPCs.
- Event, cost, and audit rows are append-only. Audit uniqueness is `(request_id, version, kind, content_hash)`, and all persisted hashes are lower-case SHA-256 values.
- Unknown cost semantics remain fail-closed: `usage_unknown = true` requires `amount_known IS NULL`; a later known usage observation appends a new cost row and can allocate a new immutable audit version.
- The typed server adapter rejects forbidden payload keys before an RPC, computes stable JSON SHA-256 hashes when a source hash is not supplied, defaults all write flags to disabled, and reports `blocked` if a bounded retry marker cannot be durably persisted; it never claims `retry_queued` without a successful marker RPC.
- The service-only family loader includes the cache family and applies a SQL `LIMIT 100` to every returned collection; the adapter rejects unknown, malformed, or oversized collection payloads before callers receive them.
- Shadow parity requires a complete normalized schema and compares candidate, interaction, order, counts, ownership/state, ordering/hash, cost, retention, unknown-source, and every required canonical family-row collection. Unknown-source projections cannot match each other, and canonical read/comparison errors and mismatches emit sanitized diagnostics while retaining the legacy response. The server-only result-page reader now exercises this shadow path, while the audit read flag remains disabled by default.
- The report-only backfill reads `analysis_requests`, every listed legacy family table, and each canonical family table with hard-bounded `(time,key)` keyset pages; its local fixtures cover two 100-row source pages and bidirectional count/field/order parity. Cursor timestamps are restricted to safe ISO forms so the boundary cannot become a filter expression. Late provider-cost reconciliation now uses one service-only SQL RPC that locks the request row, allocates `MAX(version)+1`, and appends cost plus audit evidence atomically.
- Any late-cost atomic read/append failure enters the typed retry-marker path; the adapter validates the durable operational event's request, family, retry key, hash, retention, id, and timestamp before returning `retry_queued`. An invalid or unavailable marker remains `blocked`, while the legacy settlement remains authoritative.
- Worker completion, progress checkpoints, provider cost reconciliation, and result finalization dual-write only after the existing legacy operation succeeds. Canonical failures do not roll back a user-visible legacy success.

## Test and command evidence

- Focused canonical migration, PGlite, adapter, worker, provider-cost, progress, result, read, and backfill tests passed locally: 8 files and 157 tests in the review-fix suite, including multi-page legacy-family keyset traversal and concurrent late-cost version allocation under PGlite.
- The report-only command ran successfully and emitted only aggregate output: `status=blocked`, `scanned=0`, `complete=0`, `blocked=1`, with all six family reports blocked as `source.missing`. The source was unavailable, so no request identifiers or user data were emitted.
- `npx tsc --noEmit --pretty false --incremental false` passed.
- `npm run lint` completed with zero errors and 27 existing warnings outside this change.
- `git diff --check` passed.
- `npm run build` compiled successfully and completed its TypeScript phase, but static prerendering was blocked by missing Supabase URL/API-key environment variables for `/betatest` and `/_not-found` in this isolated worktree.

The checksums exercised by local fixtures are test values only and are not production parity evidence. No production source/canonical counts or checksums are available in this run.

## Parity and rollback state

| Family | Source count/checksum | Canonical count/checksum | State transition parity | Result |
|---|---|---|---|---|
| jobs | unavailable | unavailable | unavailable | blocked |
| evidence/progress | unavailable | unavailable | unavailable | blocked |
| cost | unavailable | unavailable | unavailable | blocked |
| cache | unavailable | unavailable | unavailable | blocked |
| audit | unavailable | unavailable | unavailable | blocked |

Local fixtures cover complete and partial rows, duplicate job keys, duplicate audit hashes, unknown usage, and a late known cost. They do not establish production counts, archival completeness, or source-to-canonical parity.

Feature flags are intentionally false by default and were not activated for a real workload:

```text
ANALYSIS_CANONICAL_JOBS_WRITE=false
ANALYSIS_CANONICAL_EVIDENCE_WRITE=false
ANALYSIS_CANONICAL_COST_WRITE=false
ANALYSIS_CANONICAL_CACHE_WRITE=false
ANALYSIS_CANONICAL_AUDIT_WRITE=false
ANALYSIS_CANONICAL_JOBS_READ=false
ANALYSIS_CANONICAL_EVIDENCE_READ=false
ANALYSIS_CANONICAL_COST_READ=false
ANALYSIS_CANONICAL_CACHE_READ=false
ANALYSIS_CANONICAL_AUDIT_READ=false
```

Rollback drill result: **local contract only**. The legacy path remains authoritative; canonical reads are server-only and family-gated; a shadow mismatch or canonical read error returns the legacy response and emits sanitized mismatch telemetry. Because production parity and archive evidence are missing, no reader family is eligible for activation and no source table is eligible for removal.

## Legacy source tables retained

The following source families remain intact and read-only for the observation window:

`analysis_pipeline_jobs`, `analysis_v2_dag_scopes`, `analysis_v2_dag_stage_manifests`, `analysis_v2_dag_batch_topology`, `analysis_v2_dag_batch_results`, `analysis_progress_state`, `analysis_progress_events`, `analysis_step_events`, `analysis_v2_relationship_*`, `analysis_target_interactors`, `analysis_v2_candidate_feature_*`, `analysis_v2_candidate_score_*`, `analysis_v2_media_artifacts`, `analysis_v2_cost_attributions`, `analysis_v2_cost_rollup_snapshots`, `analysis_provider_cost_ledger`, `ai_analysis_cache`, and `analysis_order_audit_*`.

Destructive migration, admission activation, `payment_pending` mutation, source archive/drop, and the real `0_min._.00` canary remain blocked pending genuine production parity/archive evidence.
