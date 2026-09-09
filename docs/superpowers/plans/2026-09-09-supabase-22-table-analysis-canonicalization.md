# Analysis Canonicalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** 기존 V2 execution family를 \`analysis_requests\`, \`analysis_preflights\`, \`analysis_results\`, \`analysis_provider_runs\`와 여섯 개의 최소 canonical table로 수렴시키고 parity가 증명된 family만 reader를 전환한다.

**Architecture:** 기존 aggregate 이름은 재사용하고, \`analysis_pipeline_jobs\`·DAG·progress·evidence·cost·cache·permanent audit family만 canonical adapter로 확장한다. 한 transaction dual-write가 가능한 경우 transaction으로 기록하고, 불가능한 경우 \`maintenance_jobs\` 소유 retry key를 남긴다. source table은 rollback window 동안 read-only로 둔다.

**Tech Stack:** PostgreSQL/Supabase, TypeScript/Zod, Vitest, PGlite, disposable PostgreSQL, server-only feature flags.

---

## Scope and exact files

| Action | Path |
|---|---|
| Create (generated path) | \`$ANALYSIS_MIGRATION_PATH\` from \`npx supabase migration new add_analysis_canonical_tables\` |
| Create | \`lib/services/analysis/canonical-analysis-store.ts\` |
| Create | \`lib/services/analysis/canonical-analysis-store.test.ts\` |
| Create | \`lib/services/analysis/canonical-analysis-pglite.test.ts\` |
| Create | \`lib/services/analysis/canonical-analysis-read.ts\` |
| Create | \`lib/services/analysis/canonical-analysis-read.test.ts\` |
| Create | \`scripts/backfill-analysis-canonical.ts\` |
| Create | \`scripts/backfill-analysis-canonical.test.ts\` |
| Modify | \`lib/services/analysis/v2-worker.ts\`, \`lib/services/analysis/provider-cost-reconciliation.ts\` |
| Modify | \`lib/services/analysis/v2-progress-reporter.ts\`, \`lib/services/analysis/v2-result-store.ts\` |

Old source families remain in scope for read-only parity only: \`analysis_pipeline_jobs\`, \`analysis_v2_dag_scopes\`, \`analysis_v2_dag_stage_manifests\`, \`analysis_v2_dag_batch_topology\`, \`analysis_v2_dag_batch_results\`, \`analysis_progress_state\`, \`analysis_progress_events\`, \`analysis_step_events\`, \`analysis_v2_relationship_*\`, \`analysis_target_interactors\`, \`analysis_v2_candidate_feature_*\`, \`analysis_v2_candidate_score_*\`, \`analysis_v2_media_artifacts\`, \`analysis_v2_cost_attributions\`, \`analysis_v2_cost_rollup_snapshots\`, \`analysis_provider_cost_ledger\`, \`ai_analysis_cache\`, and \`analysis_order_audit_*\`.

## Canonical family contract

이 plan이 추가하는 table은 \`analysis_jobs\`, \`analysis_events\`, \`analysis_artifacts\`, \`analysis_costs\`, \`analysis_cache\`, \`analysis_audit_bundles\`다. \`analysis_audit_bundles\`는 parent/candidate/interaction을 \`kind\`와 typed key로 한 table에 보관하되 고카디널리티 검색 키를 JSONB에 넣지 않는다.

~~~sql
CREATE TABLE public.analysis_jobs (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    job_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('coordinator', 'collection', 'ai', 'finalize', 'recovery')),
    state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'blocked')),
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
    dependency_count INTEGER NOT NULL DEFAULT 0 CHECK (dependency_count >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    lease_expires_at TIMESTAMPTZ,
    completion_hash TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    retention_class TEXT NOT NULL DEFAULT 'standard',
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (request_id, job_key, generation),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.analysis_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    job_id UUID REFERENCES public.analysis_jobs(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('progress', 'lifecycle', 'operational')),
    state TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    retention_class TEXT NOT NULL DEFAULT 'standard',
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.analysis_artifacts (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    job_id UUID REFERENCES public.analysis_jobs(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('evidence', 'manifest', 'media_ref', 'replay')),
    artifact_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('staged', 'retained', 'expired', 'blocked')),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    retention_class TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (request_id, artifact_key, content_hash),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.analysis_costs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    amount_known NUMERIC(18,12),
    amount_conservative NUMERIC(18,12),
    usage_unknown BOOLEAN NOT NULL,
    source_hash TEXT NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    retention_class TEXT NOT NULL DEFAULT 'permanent',
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (amount_known IS NULL OR amount_known >= 0),
    CHECK (amount_conservative IS NULL OR amount_conservative >= 0),
    CHECK (NOT usage_unknown OR amount_known IS NULL),
    CHECK (amount_conservative IS NULL OR amount_known IS NULL OR amount_conservative >= amount_known),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.analysis_cache (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    scope TEXT NOT NULL CHECK (scope IN ('ai', 'profile', 'anonymous', 'blite')),
    cache_key_hash TEXT NOT NULL CHECK (cache_key_hash ~ '^[a-f0-9]{64}$'),
    state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    single_flight_token_hash TEXT CHECK (single_flight_token_hash IS NULL OR single_flight_token_hash ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (scope, cache_key_hash),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.analysis_audit_bundles (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 100000),
    kind TEXT NOT NULL CHECK (kind IN ('bundle', 'candidate', 'interaction')),
    candidate_key TEXT,
    ordinal INTEGER,
    state TEXT NOT NULL CHECK (state IN ('complete', 'partial', 'inconsistent', 'failed')),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    retention_class TEXT NOT NULL DEFAULT 'permanent',
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (request_id, version, kind, content_hash),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);
~~~

모든 six table은 \`ENABLE FORCE ROW LEVEL SECURITY\`, \`REVOKE ALL ON TABLE public.analysis_jobs FROM PUBLIC, anon, authenticated, service_role\` 형태의 명시적 ACL, service-role-only RPC, immutable trigger 또는 append-only privilege를 사용한다. \`analysis_costs.usage_unknown = true\`일 때 DB CHECK \`NOT usage_unknown OR amount_known IS NULL\`로 \`amount_known = NULL\`을 강제한다. \`candidate_key\`와 \`ordinal\`은 표시/정렬용 nullable metadata이며 audit uniqueness는 non-null immutable \`content_hash\`에만 의존한다.

## Task 1: RED migration contracts and minimal schema

**Files:**

- Create: \`lib/services/analysis/canonical-analysis-store.test.ts\`
- Create: \`lib/services/analysis/canonical-analysis-pglite.test.ts\`
- Create (generated path): \`$ANALYSIS_MIGRATION_PATH\`

- [ ] **Step 1: Write RED contract tests.** Read the generated migration and assert six table names, enum/check values, owner/request indexes, FORCE RLS, no grant to \`anon\` or \`authenticated\`, no raw provider payload/token column, append-only event/audit behavior, the audit uniqueness key \`(request_id, version, kind, content_hash)\`, and the DB CHECK \`NOT usage_unknown OR amount_known IS NULL\`. PGlite fixtures cover complete, partial, unknown usage, late cost, duplicate \`job_key\`, and duplicate audit hash.

~~~ts
expect(sql).toContain('CREATE TABLE public.analysis_costs');
expect(sql).toContain('usage_unknown BOOLEAN NOT NULL');
expect(sql).toContain('CHECK (amount_known IS NULL OR amount_known >= 0)');
expect(sql).toContain('ALTER TABLE public.analysis_audit_bundles FORCE ROW LEVEL SECURITY');
expect(sql).not.toMatch(/provider_token|access_token|cookie|raw_provider_payload/i);
~~~

- [ ] **Step 2: Run RED.**

~~~bash
npx vitest run lib/services/analysis/canonical-analysis-store.test.ts lib/services/analysis/canonical-analysis-pglite.test.ts
~~~

Expected: FAIL because the generated analysis migration file is absent.

- [ ] **Step 3: Create the migration and add the six tables, indexes, RLS, and service RPC boundary.** Run Steps 3–4 in one shell session so the generated path variable remains available. Capture exactly one path from the CLI output, place the contract SQL above in that file, and add indexes \`analysis_jobs_dispatch_idx\` on \`(state, next_attempt_at, updated_at)\`, \`analysis_events_request_created_idx\`, \`analysis_artifacts_request_kind_idx\`, \`analysis_costs_request_recorded_idx\`, \`analysis_cache_expiry_idx\`, and \`analysis_audit_request_version_idx\`. Every SECURITY DEFINER function uses \`SET search_path = ''\` and the explicit service-role-only ACL below.

~~~bash
set -euo pipefail
ANALYSIS_MIGRATION_OUTPUT="$(npx supabase migration new add_analysis_canonical_tables)"
ANALYSIS_MIGRATION_PATH="$(printf '%s\n' "$ANALYSIS_MIGRATION_OUTPUT" | sed -n 's/^Created new migration at //p')"
test "$(printf '%s\n' "$ANALYSIS_MIGRATION_PATH" | awk 'NF { count++ } END { print count + 0 }')" -eq 1
test -f "$ANALYSIS_MIGRATION_PATH"
export ANALYSIS_MIGRATION_PATH
~~~

For \`enqueue_analysis_canonical_retry(UUID, TEXT)\`, revoke the default and client-role execute privileges and grant only \`service_role\`:

~~~sql
REVOKE EXECUTE ON FUNCTION public.enqueue_analysis_canonical_retry(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_analysis_canonical_retry(UUID, TEXT) TO service_role;
~~~

- [ ] **Step 4: Run GREEN and commit.**

~~~bash
npx vitest run lib/services/analysis/canonical-analysis-store.test.ts lib/services/analysis/canonical-analysis-pglite.test.ts
git diff --check
git add "$ANALYSIS_MIGRATION_PATH" lib/services/analysis/canonical-analysis-store.test.ts lib/services/analysis/canonical-analysis-pglite.test.ts
git commit -m "feat: add analysis canonical tables"
~~~

Expected: focused contract/PGlite tests PASS.

## Task 2: Dual-write adapters and immutable audit/cost semantics

**Files:**

- Create: \`lib/services/analysis/canonical-analysis-store.ts\`
- Create: \`lib/services/analysis/canonical-analysis-read.ts\`
- Modify: \`lib/services/analysis/v2-worker.ts\`, \`lib/services/analysis/provider-cost-reconciliation.ts\`, \`lib/services/analysis/v2-progress-reporter.ts\`, \`lib/services/analysis/v2-result-store.ts\`
- Test: \`lib/services/analysis/v2-worker.test.ts\`, \`lib/services/analysis/provider-cost-reconciliation.test.ts\`

- [ ] **Step 1: Write RED adapter tests.** Assert finalization writes \`analysis_jobs\` and \`analysis_events\` after the existing result commit; cost refresh appends \`analysis_costs\` with a new source hash; late usage appends instead of updating; one-sided write creates a bounded retry record; user-visible result success is not rolled back by audit enqueue failure.

~~~ts
expect(await store.appendCost({
    requestId,
    provider: 'vertex',
    operationKey: 'score:001',
    stage: 'score',
    amountKnown: null,
    amountConservative: 0.014,
    usageUnknown: true,
    sourceHash: 'a'.repeat(64),
})).toEqual({ status: 'appended', usageUnknown: true });
expect(rpc).toHaveBeenCalledWith('enqueue_analysis_canonical_retry', {
    p_request_id: requestId,
    p_family: 'cost',
});
~~~

- [ ] **Step 2: Implement the minimal server adapter.** \`recordJob\`, \`appendEvent\`, \`appendArtifact\`, \`appendCost\`, and \`appendAuditRow\` accept typed inputs, hash stable JSON with SHA-256, and reject forbidden keys before RPC. Keep old source writes authoritative during the window. Use family flags \`ANALYSIS_CANONICAL_JOBS_WRITE\`, \`ANALYSIS_CANONICAL_EVIDENCE_WRITE\`, \`ANALYSIS_CANONICAL_COST_WRITE\`, \`ANALYSIS_CANONICAL_CACHE_WRITE\`, and \`ANALYSIS_CANONICAL_AUDIT_WRITE\`; default all to \`false\`.

- [ ] **Step 3: Run GREEN.**

~~~bash
npx vitest run lib/services/analysis/canonical-analysis-store.test.ts lib/services/analysis/v2-worker.test.ts lib/services/analysis/provider-cost-reconciliation.test.ts lib/services/analysis/v2-progress-reporter.test.ts lib/services/analysis/v2-result-store.test.ts
~~~

Expected: PASS with all flags false and explicit unknown-cost assertions.

- [ ] **Step 4: Commit adapters.**

~~~bash
git add lib/services/analysis/canonical-analysis-store.ts lib/services/analysis/canonical-analysis-read.ts lib/services/analysis/v2-worker.ts lib/services/analysis/provider-cost-reconciliation.ts lib/services/analysis/v2-progress-reporter.ts lib/services/analysis/v2-result-store.ts lib/services/analysis/v2-worker.test.ts lib/services/analysis/provider-cost-reconciliation.test.ts
git commit -m "feat: dual-write analysis canonical evidence"
~~~

## Task 3: Bounded backfill, parity, and reversible shadow-read

**Files:**

- Create: \`scripts/backfill-analysis-canonical.ts\`
- Create: \`scripts/backfill-analysis-canonical.test.ts\`
- Modify: \`lib/services/analysis/canonical-analysis-read.ts\`
- Create: \`lib/services/analysis/canonical-analysis-read.test.ts\`

- [ ] **Step 1: Write RED backfill/read tests.** Backfill batches at most 100 request IDs ordered by \`created_at, id\`, uses \`(source_table, source_pk, source_hash)\` idempotency, and returns aggregate counts/checksums only. Assert missing source is \`blocked\`, count-only equality is \`mismatch\`, late-cost source creates a new audit version, and \`ANALYSIS_CANONICAL_*_READ\` flags are family-specific.

~~~ts
expect(buildAnalysisParity({
    source: { count: 2, checksum: 'a'.repeat(64), complete: true },
    canonical: { count: 2, checksum: 'b'.repeat(64), complete: true },
})).toEqual({ status: 'mismatch', mismatchPaths: ['checksum'] });
expect(buildAnalysisParity({
    source: null,
    canonical: { count: 0, checksum: null, complete: false },
})).toEqual({ status: 'blocked', mismatchPaths: ['source.missing'] });
~~~

- [ ] **Step 2: Implement read/write path.** Add \`backfillAnalysisCanonical({ limit: 100, cursor })\` with a hard max of 100 and no \`--apply\`, \`--drop\`, \`--truncate\`, \`--delete\`, or \`--mutate\` option. Shadow-read compares legacy/canonical normalized projections for request status/progress, result rank/score, provider operation identity, cost known/unknown, and audit retention; mismatch emits sanitized event and keeps legacy response.

- [ ] **Step 3: Run GREEN with exact command.**

~~~bash
npx vitest run scripts/backfill-analysis-canonical.test.ts lib/services/analysis/canonical-analysis-read.test.ts lib/services/analysis/order-audit-bundle.test.ts lib/services/analysis/order-audit-consolidation.test.ts
npx tsx --conditions=react-server scripts/backfill-analysis-canonical.ts --limit=100 --report-only
~~~

Expected: tests PASS; command prints \`status\` and aggregate checksums without request IDs, user IDs, usernames, payloads, or cost secrets.

- [ ] **Step 4: Commit the parity tooling.**

~~~bash
git add scripts/backfill-analysis-canonical.ts scripts/backfill-analysis-canonical.test.ts lib/services/analysis/canonical-analysis-read.ts lib/services/analysis/canonical-analysis-read.test.ts
git commit -m "feat: add bounded analysis canonical parity"
~~~

## Task 4: Family cutover readiness and regression handoff

- [ ] **Step 1: Prove independent rollback.** Keep old readers available for the full observation window, make canonical reads server-only, and require a failed shadow comparison to return legacy data. Do not drop a source table in the same deployment that first changes its reader.

- [ ] **Step 2: Run owned plus repository gates.**

~~~bash
npx vitest run lib/services/analysis/canonical-analysis-store.test.ts lib/services/analysis/canonical-analysis-pglite.test.ts lib/services/analysis/canonical-analysis-read.test.ts scripts/backfill-analysis-canonical.test.ts lib/services/analysis/v2-worker.test.ts lib/services/analysis/provider-cost-reconciliation.test.ts
npx tsc --noEmit --pretty false
npm run lint
npm run build
git diff --check
~~~

Expected: focused tests/typecheck/build PASS, lint has 0 errors, diff check has no output.

- [ ] **Step 3: Record evidence.** Write \`docs/reports/2026-09-09-supabase-22-analysis-canonical-evidence.md\` with source/canonical counts, checksums, state transition parity, unknown-cost counts, retention markers, feature flag values, rollback drill result, and the exact source tables retained. Zero genuine production audit bundles or any mismatch keeps the report blocked.

- [ ] **Step 4: Commit the handoff.**

~~~bash
git add docs/reports/2026-09-09-supabase-22-analysis-canonical-evidence.md
git commit -m "docs: record analysis canonical evidence"
~~~

No DROP, analysis admission activation, \`payment_pending\` mutation, or real \`0_min._.00\` canary is authorized by this plan.
