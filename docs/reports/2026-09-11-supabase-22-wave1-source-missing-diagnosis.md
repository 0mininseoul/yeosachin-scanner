# Supabase 22 Wave 1 production `source.missing` diagnosis

## Result

Wave 1 remains blocked. The smallest production probe audit found both
accepted and denied entries in the rowless, `request_id`-only REST probe, as
enumerated below. Every denied executable source and each executable canonical
destination returned sanitized SQLSTATE `42501` (`permission_denied`), which
proves only current ACL denial for that selected column/path. An accepted
`empty_result` proves only that this one-column probe passed the current ACL
check; neither result proves full approved-projection reachability or rules out
a later schema, RLS, or policy blocker.

The audit was run from a fresh `origin/main` worktree. Supabase CLI validation
used the pinned `npx --yes supabase@2.102.0` command and returned `2.102.0`.
Production configuration came only from the canonical main worktree's
`.env.local` through Node's `--env-file` option. The environment file was not
sourced, copied, printed, or persisted.

Each probe selected only the checked-in request-id column and used `limit=0`,
so the response was rowless. The runner discarded response bodies and printed
or persisted only the checked-in object name, effective request-id column,
probe classification, and sanitized error code/category. A denied probe is
evidence only of current ACL denial for that request-id-only path; an accepted
probe does not exercise the approved projection, request filters, ordering, or
key columns. No URLs, credentials, headers, project references, rows, values,
UUIDs, request IDs, cursors, counts, or raw errors were emitted or persisted.

## Contract scope

`ANALYSIS_CANONICAL_BACKFILL_FAMILIES` defines exactly 21 executable legacy
sources in four families: jobs, events, artifacts, and costs. Every executable
`BackfillTableSpec` leaves `requestIdColumn` undefined, so the effective and
expected request-id column is `request_id` for every source and canonical
destination below. The contract also retains cache and audit as deferred
families with no executable legacy sources; their canonical objects were not
probed because `readFamily` explicitly returns before any read for a deferred
family.

## Sanitized REST request-id-only probe results

### Executable legacy sources

| Family | Checked-in table | Expected request-id column | Request-id-only probe | Error code | Error category |
|---|---|---|---|---|---|
| jobs | `analysis_pipeline_jobs` | `request_id` | accepted | — | `empty_result` |
| jobs | `analysis_v2_dag_scopes` | `request_id` | denied | `42501` | `permission_denied` |
| jobs | `analysis_v2_dag_stage_manifests` | `request_id` | denied | `42501` | `permission_denied` |
| jobs | `analysis_v2_dag_batch_topology` | `request_id` | denied | `42501` | `permission_denied` |
| jobs | `analysis_v2_dag_batch_results` | `request_id` | denied | `42501` | `permission_denied` |
| events | `analysis_progress_state` | `request_id` | denied | `42501` | `permission_denied` |
| events | `analysis_progress_events` | `request_id` | denied | `42501` | `permission_denied` |
| events | `analysis_step_events` | `request_id` | accepted | — | `empty_result` |
| artifacts | `analysis_v2_relationship_sides` | `request_id` | denied | `42501` | `permission_denied` |
| artifacts | `analysis_v2_relationship_rows` | `request_id` | denied | `42501` | `permission_denied` |
| artifacts | `analysis_v2_relationship_manifests` | `request_id` | denied | `42501` | `permission_denied` |
| artifacts | `analysis_v2_target_evidence_manifests` | `request_id` | denied | `42501` | `permission_denied` |
| artifacts | `analysis_target_interactors` | `request_id` | denied | `42501` | `permission_denied` |
| artifacts | `analysis_v2_candidate_feature_manifests` | `request_id` | denied | `42501` | `permission_denied` |
| artifacts | `analysis_v2_candidate_feature_rows` | `request_id` | denied | `42501` | `permission_denied` |
| artifacts | `analysis_v2_candidate_score_manifests` | `request_id` | denied | `42501` | `permission_denied` |
| artifacts | `analysis_v2_candidate_score_rows` | `request_id` | denied | `42501` | `permission_denied` |
| artifacts | `analysis_v2_media_artifacts` | `request_id` | denied | `42501` | `permission_denied` |
| costs | `analysis_v2_cost_attributions` | `request_id` | denied | `42501` | `permission_denied` |
| costs | `analysis_v2_cost_rollup_snapshots` | `request_id` | denied | `42501` | `permission_denied` |
| costs | `analysis_provider_cost_ledger` | `request_id` | accepted | — | `empty_result` |

### Canonical destinations for executable families (request-id-only probe)

| Family | Checked-in table | Expected request-id column | Request-id-only probe | Error code | Error category |
|---|---|---|---|---|---|
| jobs | `analysis_jobs` | `request_id` | denied | `42501` | `permission_denied` |
| events | `analysis_events` | `request_id` | denied | `42501` | `permission_denied` |
| artifacts | `analysis_artifacts` | `request_id` | denied | `42501` | `permission_denied` |
| costs | `analysis_costs` | `request_id` | denied | `42501` | `permission_denied` |

The deferred canonical destinations `analysis_cache` and
`analysis_audit_bundles` both have checked-in expected request-id column
`request_id`, but neither was probed: the backfill contract marks both
families deferred and prohibits a canonical read without an executable,
request-safe legacy source.

## Exact cause of each `source.missing`

The backfill reader marks a family source incomplete when any executable legacy
read fails. Its parity decision then reports `source.missing` before checking
the canonical completeness branch. Therefore a source permission failure can
mask a separately observed canonical failure in the family-level parity path.

| Family | Objects that cause `source.missing` | Canonical request-id-only probe |
|---|---|---|
| jobs | `analysis_v2_dag_scopes`, `analysis_v2_dag_stage_manifests`, `analysis_v2_dag_batch_topology`, and `analysis_v2_dag_batch_results` (`42501`, `permission_denied`) | `analysis_jobs` request-id-only probe denied (`42501`, `permission_denied`) |
| events | `analysis_progress_state` and `analysis_progress_events` (`42501`, `permission_denied`) | `analysis_events` request-id-only probe denied (`42501`, `permission_denied`) |
| artifacts | `analysis_v2_relationship_sides`, `analysis_v2_relationship_rows`, `analysis_v2_relationship_manifests`, `analysis_v2_target_evidence_manifests`, `analysis_target_interactors`, `analysis_v2_candidate_feature_manifests`, `analysis_v2_candidate_feature_rows`, `analysis_v2_candidate_score_manifests`, `analysis_v2_candidate_score_rows`, and `analysis_v2_media_artifacts` (`42501`, `permission_denied`) | `analysis_artifacts` request-id-only probe denied (`42501`, `permission_denied`) |
| costs | `analysis_v2_cost_attributions` and `analysis_v2_cost_rollup_snapshots` (`42501`, `permission_denied`) | `analysis_costs` request-id-only probe denied (`42501`, `permission_denied`) |
| cache | No object was read; the family is deferred with no executable source, so the contract returns a synthetic blocked `source.missing` result | No canonical read by contract |
| audit | No object was read; the family is deferred with no executable source, so the contract returns a synthetic blocked `source.missing` result | No canonical read by contract |

The accepted sources listed above returned the intended rowless probe response
and do not cause `source.missing`. Their acceptance does not prove that the
source is complete or empty for a real request, that the full approved
projection is readable, or that no later schema/RLS/policy blocker exists; it
only proves that this metadata-like REST path accepted the checked-in
request-id-only probe.

## Interpretation and boundary

`42501` is a sanitized permission-denied classification. It does not prove
that any denied object is physically absent; it proves only current ACL denial
for the selected `request_id` column on the supplied service-role REST path.
An accepted rowless probe is not full approved-projection reachability and does
not rule out a later schema, RLS, or policy blocker. The existing catalog check
based on `has_table_privilege('service_role', ..., 'SELECT')` is a
relation-level check and therefore remains false for column-only SELECT
grants; it does not inspect the projection ACL. Likewise, this audit does not
assess service-only RPC reachability for the canonical tables. No
implementation, schema, privilege, flag, data, migration, activation, canary,
deployment, or payment state was changed. No tests, typecheck, lint, build, CI,
or deploy command was run.

The legacy path therefore remains authoritative, canonical read/write
activation remains blocked, and no source retirement or backfill mutation is
authorized by this evidence.
