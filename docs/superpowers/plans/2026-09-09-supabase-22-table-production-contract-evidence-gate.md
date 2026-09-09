# Production Contract and Evidence Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** canonicalization의 실제 production contract, parity, archive/restore, dependency, rollback, observation evidence를 집계하고 모든 미충족 gate를 blocked로 반환한다.

**Architecture:** 읽기 전용 catalog/evidence collector가 정확한 22-table set, RLS/ACL, routines/triggers/FK/view/publication/sequence/partition/pg_depend, migration history, genuine completed audit bundle, checksum parity, archive restore, rollback, observation window을 별도 증거로 수집한다. 기존 \`order-audit-consolidation.ts\`의 mutation refusal을 유지하고, gate 통과는 별도 owner approval을 기록할 뿐 DROP/activation 권한을 부여하지 않는다.

**Tech Stack:** TypeScript/Zod, Supabase service-role RPC/CLI, PostgreSQL catalog SQL, Vitest, PGlite, encrypted R2/GCS archive verification.

---

## Scope and exact files

| Action | Path |
|---|---|
| Create | \`lib/services/operations/supabase-22-evidence.ts\` |
| Create | \`lib/services/operations/supabase-22-evidence.test.ts\` |
| Create | \`lib/services/operations/supabase-22-catalog-pglite.test.ts\` |
| Create | \`scripts/verify-supabase-22-catalog.ts\` |
| Create | \`scripts/verify-supabase-22-catalog.test.ts\` |
| Create | \`scripts/verify-supabase-22-archive-restore.ts\` |
| Create | \`scripts/verify-supabase-22-archive-restore.test.ts\` |
| Modify | \`lib/services/analysis/order-audit-consolidation.ts\`, \`scripts/verify-analysis-order-audit-parity.ts\` |
| Create | \`docs/reports/2026-09-09-supabase-22-evidence-gate.json\` |

이 plan은 migration apply, archive delete, table drop, analysis admission activation, payment state mutation, provider call, real \`0_min._.00\` canary를 실행하지 않는다. credentials, DB password, cookie, user UUID, raw export, Authorization header는 출력/저장하지 않는다.

## Evidence contract

~~~ts
export type Supabase22Evidence = Readonly<{
    schemaVersion: 'supabase-22-evidence-v1';
    publicTableCount: number;
    canonicalTables: readonly string[];
    unexpectedTables: readonly string[];
    missingTables: readonly string[];
    dependencyClean: boolean;
    migrationHistoryClean: boolean;
    genuineCompletedBundleCount: number;
    parityStatus: 'ready' | 'mismatch' | 'blocked';
    archiveManifest: {
        verified: boolean;
        aggregateChecksum: string | null;
        restoreStatus: 'verified' | 'mismatch' | 'blocked' | 'not_run';
    };
    rollbackEvidenceVerified: boolean;
    observationWindowClosed: boolean;
    ownerApprovalRecorded: boolean;
    destructiveOperations: 'refused';
    missingGates: readonly string[];
}>;
~~~

Canonical set is the exact sorted 22 names below; count-only or another schema copy never passes.

~~~ts
export const SUPABASE_22_CANONICAL_TABLES = [
    'account_lifecycle', 'analysis_artifacts', 'analysis_audit_bundles',
    'analysis_cache', 'analysis_costs', 'analysis_events', 'analysis_jobs',
    'analysis_preflights', 'analysis_provider_runs', 'analysis_requests',
    'analysis_results', 'earlybird_orders', 'earlybird_waitlist',
    'fulfillment_jobs', 'landing_leads', 'maintenance_jobs',
    'notification_outbox', 'payment_events', 'result_feedback',
    'system_configuration', 'system_leases', 'users',
] as const;
~~~

## Task 1: RED gate model and catalog proof

**Files:**

- Create: \`lib/services/operations/supabase-22-evidence.test.ts\`
- Create: \`lib/services/operations/supabase-22-evidence.ts\`
- Create: \`scripts/verify-supabase-22-catalog.test.ts\`
- Create: \`scripts/verify-supabase-22-catalog.ts\`

- [ ] **Step 1: Write RED tests.** Assert no selected request produces \`blocked\`, zero genuine bundles produces \`blocked\`, one count mismatch produces \`mismatch\`, missing canonical name produces \`missing-table\`, unexpected public table produces \`unexpected-table\`, and every output includes \`destructiveOperations: 'refused'\`. Assert PII guard rejects UUID/email/URL/raw payload keys.

~~~ts
expect(evaluateSupabase22Gate({
    publicTableCount: 22,
    canonicalTables: SUPABASE_22_CANONICAL_TABLES,
    unexpectedTables: [],
    missingTables: [],
    dependencyClean: true,
    migrationHistoryClean: true,
    genuineCompletedBundleCount: 0,
    parityStatus: 'blocked',
    archiveManifest: { verified: false, aggregateChecksum: null, restoreStatus: 'blocked' },
    rollbackEvidenceVerified: false,
    observationWindowClosed: false,
    ownerApprovalRecorded: false,
})).toMatchObject({ status: 'blocked', destructiveOperations: 'refused' });
~~~

- [ ] **Step 2: Run RED.**

~~~bash
npx vitest run lib/services/operations/supabase-22-evidence.test.ts scripts/verify-supabase-22-catalog.test.ts
~~~

Expected: FAIL because the collector and canonical set do not exist.

- [ ] **Step 3: Implement read-only catalog collector.** Execute one parameterized SQL query through the already authenticated service-role path:

~~~sql
SELECT c.relname,
       c.relkind,
       c.relpersistence,
       c.relrowsecurity,
       c.relforcerowsecurity
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
ORDER BY c.relname;
~~~

Join separate queries for \`pg_constraint\`, \`pg_policy\`, \`pg_roles\` ACL, \`pg_trigger\`, \`pg_proc\`, \`pg_depend\`, \`pg_publication_rel\`, sequences, partitions, views, and extensions. Mark any unresolved dependency or non-RLS table as blocked; do not auto-fix catalog state.

- [ ] **Step 4: Run GREEN and commit.**

~~~bash
npx vitest run lib/services/operations/supabase-22-evidence.test.ts scripts/verify-supabase-22-catalog.test.ts
git diff --check
git add lib/services/operations/supabase-22-evidence.ts lib/services/operations/supabase-22-evidence.test.ts scripts/verify-supabase-22-catalog.ts scripts/verify-supabase-22-catalog.test.ts
git commit -m "feat: add supabase 22 catalog gate"
~~~

Expected: gate tests PASS and \`publicTableCount: 22\` is required, not manufactured.

## Task 2: Production parity, archive manifest, and restore proof

**Files:**

- Create: \`scripts/verify-supabase-22-archive-restore.ts\`
- Create: \`scripts/verify-supabase-22-archive-restore.test.ts\`
- Modify: \`lib/services/analysis/order-audit-consolidation.ts\`, \`scripts/verify-analysis-order-audit-parity.ts\`

- [ ] **Step 1: Write RED evidence tests.** Extend \`ConsolidationReadinessInput\` with \`publicTableCount\`, \`canonicalSetMatch\`, \`catalogDependencyClean\`, \`paymentPendingDispositionRecorded\`, \`noActivationOrCanary\`, and \`archiveRestoreChecksumMatch\`. Require at least one genuine completed production order, completed recovery row, every selected parity section, zero blocked/mismatch, non-empty encrypted archive manifest, and matching restore checksum.

~~~ts
expect(evaluateConsolidationReadiness({
    genuineCompletedBundleCount: 1,
    perOrderParityCount: 1,
    aggregateChecksumsMatch: true,
    archiveManifestVerified: true,
    restoreDrillVerified: false,
    rollbackEvidenceVerified: true,
    dependencyInventoryComplete: true,
    separateApprovalGranted: false,
    observationWindowClosed: true,
    publicTableCount: 22,
    canonicalSetMatch: true,
    catalogDependencyClean: true,
    paymentPendingDispositionRecorded: true,
    noActivationOrCanary: true,
    archiveRestoreChecksumMatch: false,
})).toMatchObject({ status: 'blocked' });
~~~

- [ ] **Step 2: Implement report-only archive/restore verifier.** Reuse \`read_analysis_order_audit_parity_snapshot(uuid)\`, \`buildOrderAuditParityReport\`, \`stableChecksum\`, and \`assertPiiSafeConsolidationOutput\`. \`--request-id\` accepts at most 20 explicit UUIDs; \`--archive-manifest\` emits counts/checksums/retention only; \`--restore-path\` reads an isolated restored manifest and compares exact checksums. Reject \`--execute\`, \`--apply\`, \`--drop\`, \`--truncate\`, \`--rename\`, \`--delete\`, and \`--mutate\`.

- [ ] **Step 3: Run GREEN against safe fixtures and existing readiness state.**

~~~bash
npx vitest run scripts/verify-supabase-22-archive-restore.test.ts lib/services/analysis/order-audit-consolidation.test.ts scripts/verify-analysis-order-audit-parity.test.ts
npm run verify:order-audit-parity -- --request-id=123e4567-e89b-42d3-a456-426614174000 --archive-manifest
npx tsx --conditions=react-server scripts/verify-supabase-22-archive-restore.ts --report-only --manifest docs/reports/2026-09-09-supabase-22-evidence-gate.json
~~~

Expected: synthetic/empty existing state exits non-zero with \`status: blocked\`; no remote data or row changes occur.

- [ ] **Step 4: Commit evidence model.**

~~~bash
git add lib/services/analysis/order-audit-consolidation.ts scripts/verify-analysis-order-audit-parity.ts scripts/verify-supabase-22-archive-restore.ts scripts/verify-supabase-22-archive-restore.test.ts
git commit -m "feat: gate supabase 22 archive evidence"
~~~

## Task 3: Rollback, traffic observation, and owner approval contract

**Files:**

- Modify: \`lib/services/operations/supabase-22-evidence.ts\`
- Modify: \`scripts/verify-supabase-22-catalog.ts\`
- Create: \`lib/services/operations/supabase-22-evidence-traffic.test.ts\`

- [ ] **Step 1: Write RED observation tests.** Require per-family server-only old reader availability, canonical read/write flags, bounded retry queues, zero active legacy writers across routes/workers/jobs/scripts/RPCs/dashboard readers, and a closed observation window. Any mismatch keeps old reader selected and sets \`rollbackEvidenceVerified: false\`.

~~~ts
expect(resolveFamilyReader({
    canonicalEnabled: true,
    shadowMismatch: true,
    legacyAvailable: true,
})).toEqual({ reader: 'legacy', status: 'rollback_required' });
expect(resolveFamilyReader({
    canonicalEnabled: true,
    shadowMismatch: false,
    legacyAvailable: false,
})).toEqual({ reader: 'blocked', status: 'rollback_unavailable' });
~~~

- [ ] **Step 2: Implement traffic and approval parser.** Read event aggregates only; never print route payloads or user/device/provider identifiers. Approval is a separate signed operator record with \`allowlistHash\`, \`approvedAt\`, \`approvedByRole\`, and exact object names. It does not execute SQL. Record \`paymentPendingDispositionRecorded\` only when independent provider evidence and disposition are present; otherwise remain blocked.

- [ ] **Step 3: Run GREEN.**

~~~bash
npx vitest run lib/services/operations/supabase-22-evidence-traffic.test.ts lib/services/operations/supabase-22-evidence.test.ts
npx tsc --noEmit --pretty false
npm run lint
npm run build
git diff --check
~~~

Expected: tests/typecheck/build PASS, lint has 0 errors, diff check has no output.

- [ ] **Step 4: Commit the rollback contract.**

~~~bash
git add lib/services/operations/supabase-22-evidence.ts scripts/verify-supabase-22-catalog.ts lib/services/operations/supabase-22-evidence-traffic.test.ts
git commit -m "feat: add supabase 22 rollback gate"
~~~

## Task 4: Final evidence artifact and handoff

- [ ] **Step 1: Assemble \`docs/reports/2026-09-09-supabase-22-evidence-gate.json\` with this exact top-level shape and sanitized values only.**

~~~json
{
  "schemaVersion": "supabase-22-evidence-v1",
  "publicTableCount": 174,
  "canonicalTables": [],
  "unexpectedTables": [],
  "missingTables": [],
  "dependencyClean": false,
  "migrationHistoryClean": false,
  "genuineCompletedBundleCount": 0,
  "parityStatus": "blocked",
  "archiveManifest": {
    "verified": false,
    "aggregateChecksum": null,
    "restoreStatus": "blocked"
  },
  "rollbackEvidenceVerified": false,
  "observationWindowClosed": false,
  "ownerApprovalRecorded": false,
  "destructiveOperations": "refused",
  "missingGates": [
    "genuine-completed-bundle",
    "per-order-parity",
    "archive-manifest",
    "restore-drill",
    "dependency-inventory",
    "rollback-evidence",
    "observation-window",
    "separate-approval"
  ]
}
~~~

- [ ] **Step 2: Run the final self-review commands.**

~~~bash
rg -n 'DROP|TRUNCATE|payment_pending|0_min[.]_[.]00|admission.*activat|--apply|--execute|--mutate' lib/services/operations/supabase-22-evidence.ts scripts/verify-supabase-22-catalog.ts scripts/verify-supabase-22-archive-restore.ts docs/reports/2026-09-09-supabase-22-evidence-gate.json
git diff --check
npx vitest run lib/services/operations/supabase-22-evidence.test.ts lib/services/operations/supabase-22-catalog-pglite.test.ts scripts/verify-supabase-22-catalog.test.ts scripts/verify-supabase-22-archive-restore.test.ts lib/services/analysis/order-audit-consolidation.test.ts scripts/verify-analysis-order-audit-parity.test.ts
~~~

Expected: forbidden operation scan finds only refusal/guard assertions, tests PASS, and diff check is empty.

- [ ] **Step 3: Commit the sanitized evidence artifact.**

~~~bash
git add docs/reports/2026-09-09-supabase-22-evidence-gate.json
git commit -m "docs: record supabase 22 evidence gate"
~~~

- [ ] **Step 4: Handoff with a hard stop.** Report exact canonical table set, current count, allowlist hash, parity/checksum status, archive/restore status, rollback window, unresolved dependencies, and commit SHA. A blocked report is the correct result for the existing 0-bundle/0-parity state; do not retry a migration push or manufacture a canary.

No DROP, analysis admission activation, \`payment_pending\` mutation, or real \`0_min._.00\` canary is authorized by this plan.
