# Supabase 22-Table Consolidation Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** 승인된 설계의 사용자·분석·상거래·운영 증거를 보존하면서 production \`public\` base/partitioned table 수를 정확히 22개로 수렴시킨다.

**Architecture:** 기존 aggregate 이름은 유지하고, 같은 lifecycle·보존·접근 정책을 공유하는 family만 typed column과 검증된 JSONB envelope를 가진 canonical table로 단계적으로 합친다. 모든 family는 expand → dual-write/backfill → parity/shadow-read → read-only rollback window → archive/restore → 별도 contract 순서로 진행하며, 이 문서는 네 개의 독립 실행 상세 계획을 조율한다.

**Tech Stack:** Next.js App Router, TypeScript/Zod, PostgreSQL/Supabase RLS/RPC, Vitest, PGlite, disposable PostgreSQL, Supabase CLI, encrypted R2/GCS archive.

---

## 현재 판정과 실행 금지선

승인된 설계는 [\`docs/superpowers/specs/2026-09-09-supabase-22-table-consolidation-design.md\`](../../specs/2026-09-09-supabase-22-table-consolidation-design.md)이다. 기존 staged plan [\`docs/superpowers/plans/2026-09-04-supabase-staged-consolidation.md\`](2026-09-04-supabase-staged-consolidation.md)과 readiness report [\`docs/reports/2026-09-05-supabase-consolidation-readiness.md\`](../../reports/2026-09-05-supabase-consolidation-readiness.md)는 현재 상태를 blocked로 기록한다. 2026-09-05 manifest의 genuine completed bundle 수는 0, parity evidence 수는 0, contraction allowlist는 빈 배열이다.

- [ ] 현재 단계에서 어떤 SQL, API, worker, dashboard도 \`DROP TABLE\`, \`DROP VIEW\`, \`DROP FUNCTION\`, \`TRUNCATE\`, rename, archive 삭제를 실행하지 않는다.
- [ ] analysis admission activation, 분석 admission gate 변경, 실제 \`0_min._.00\` canary를 이 프로젝트의 검증이나 rollout에 포함하지 않는다.
- [ ] 독립적인 provider 증거와 감사 가능한 disposition 없이 external user의 \`payment_pending\`을 바꾸지 않는다. consolidation plan은 \`payment_pending\` 행을 읽기·보존만 하며 상태 변경 권한을 추가하지 않는다.
- [ ] browser에는 service-role key, raw anonymous device ID, raw capture token, internal HMAC, claim token을 보내지 않는다.
- [ ] \`app/page.tsx\`의 marketing copy는 수정하지 않는다.
- [ ] dirty/mixed worktree에서 \`supabase db push --include-all\`를 실행하지 않는다. 모든 remote apply는 exact allowlist, dry-run, remote history 확인을 별도 evidence로 남긴다.

## 최종 canonical public table 22개

count는 Supabase-managed schema, view, external object를 제외한 \`public\` base/partitioned table에만 적용한다. PostgreSQL의 다른 schema로 옮겨 숫자를 맞추지 않는다.

| # | canonical table | 책임 | 소유 상세 계획 |
|---:|---|---|---|
| 1 | \`users\` | application principal, paid/account projection | commerce/operations |
| 2 | \`landing_leads\` | anonymous journey의 target/excluded 입력과 verified claim | landing identity/admin |
| 3 | \`earlybird_waitlist\` | active waitlist와 immutable signup snapshot | commerce/operations |
| 4 | \`earlybird_orders\` | order, pricing snapshot, payment state, result linkage | commerce/operations |
| 5 | \`result_feedback\` | owner-submitted result feedback | commerce/operations |
| 6 | \`analysis_requests\` | analysis aggregate root, ownership, admission/current progress projection | analysis canonicalization |
| 7 | \`analysis_preflights\` | preflight, anonymous claim, exclusion, policy snapshot, scrub state | landing identity/admin + analysis |
| 8 | \`analysis_jobs\` | DAG work, dependencies, attempts, generation, lease, completion fence | analysis canonicalization |
| 9 | \`analysis_events\` | append-only progress/lifecycle/sanitized operational events | analysis canonicalization |
| 10 | \`analysis_artifacts\` | staged evidence, manifests, media refs, replay material, retention metadata | analysis canonicalization |
| 11 | \`analysis_results\` | versioned summary/candidates/scores/narrative/publication/ranking/share | analysis canonicalization |
| 12 | \`analysis_provider_runs\` | provider execution, operation identity, reservation, ambiguity, usage/reconciliation | analysis canonicalization |
| 13 | \`analysis_costs\` | append-only provider/AI cost facts, attribution, unknown/bounds, late reconciliation | analysis canonicalization |
| 14 | \`analysis_cache\` | AI/profile/anonymous/B-lite cache with scope, TTL, single-flight state | analysis canonicalization |
| 15 | \`analysis_audit_bundles\` | immutable versioned audit evidence, completeness, parity, purge fence | analysis canonicalization |
| 16 | \`payment_events\` | immutable webhook, reconciliation, refund/failure, paid evidence | commerce/operations |
| 17 | \`fulfillment_jobs\` | delivery/admission queue, bounded retry, operator review | commerce/operations |
| 18 | \`notification_outbox\` | Discord/Kakao/Sentry delivery, dedupe, retry | commerce/operations |
| 19 | \`account_lifecycle\` | classification, paid evidence, deletion, withdrawal, E2E, retirement transitions | commerce/operations |
| 20 | \`system_configuration\` | versioned plans, gates, provider policy, budgets, effective snapshots | commerce/operations |
| 21 | \`system_leases\` | typed concurrency reservation, lease, heartbeat, generation, fencing | commerce/operations |
| 22 | \`maintenance_jobs\` | recovery, replay, rearm, cleanup, terminalization, purge, audit assembly | commerce/operations |

기존 \`earlybird_orders\`, \`earlybird_waitlist\`, \`result_feedback\`, \`users\`, \`analysis_requests\`, \`analysis_preflights\`, \`analysis_results\`, \`analysis_provider_runs\`는 이름을 재사용한다. 새 테이블은 기존 이름이 canonical aggregate를 표현하지 않을 때만 추가한다.

## 공통 envelope와 cross-plan type contract

모든 새 canonical table의 cold detail은 아래 envelope를 지키고, owner/status/stage/rank/provider/operation key/next attempt/expiry/publication 같은 고빈도 검색 필드는 일반 column으로 둔다.

~~~sql
kind TEXT NOT NULL,
schema_version INTEGER NOT NULL CHECK (schema_version BETWEEN 1 AND 100),
request_id UUID,
job_id UUID,
state TEXT NOT NULL,
payload JSONB NOT NULL DEFAULT '{}'::JSONB,
content_hash TEXT,
retention_class TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
CONSTRAINT canonical_payload_object CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
~~~

TypeScript parser가 각 family의 \`kind\`와 \`schemaVersion\`을 discriminated union으로 검증하며, \`payload\`에는 owner UUID, raw token, provider secret, cookie, raw provider payload를 허용하지 않는다. \`unknown\` usage는 null/unknown 상태로 저장하고 숫자 0으로 바꾸지 않는다.

~~~ts
export type CanonicalEnvelope = Readonly<{
    kind: string;
    schemaVersion: number;
    requestId: string | null;
    jobId: string | null;
    state: string;
    payload: Record<string, unknown>;
    contentHash: string | null;
    retentionClass: 'short' | 'standard' | 'permanent';
    createdAt: string;
    updatedAt: string;
}>;
~~~

## 실행 순서와 독립 계획

| 순서 | 문서 | 독립 완료 조건 |
|---:|---|---|
| 1 | [\`2026-09-09-supabase-22-table-landing-identity-admin.md\`](2026-09-09-supabase-22-table-landing-identity-admin.md) | 새 target/excluded 입력이 same-device journey와 verified user claim으로만 연결되고 operator API/UI가 private projection을 반환한다. |
| 2 | [\`2026-09-09-supabase-22-table-analysis-canonicalization.md\`](2026-09-09-supabase-22-table-analysis-canonicalization.md) | analysis family가 canonical tables에 dual-write/backfill되고 source/canonical parity와 rollback reader가 증명된다. |
| 3 | [\`2026-09-09-supabase-22-table-commerce-operations-canonicalization.md\`](2026-09-09-supabase-22-table-commerce-operations-canonicalization.md) | payment evidence, fulfillment, notification, account lifecycle, config, lease, maintenance family가 canonical contract를 사용하고 \`payment_pending\`은 보호된다. |
| 4 | [\`2026-09-09-supabase-22-table-production-contract-evidence-gate.md\`](2026-09-09-supabase-22-table-production-contract-evidence-gate.md) | exact 22 catalog, dependency proof, genuine production parity, encrypted archive/restore, rollback/observation, separate approval evidence가 모두 기록되거나 blocked로 남는다. |

상세 계획은 각각 독립적으로 RED 테스트, 최소 SQL/adapter, GREEN 검증, rollback read path, commit까지 갖는다. 한 계획의 미완료를 다른 계획의 DROP/activation 권한으로 해석하지 않는다.

## Migration creation and cross-plan path contract

새 migration path는 미리 만든 timestamp를 사용하지 않고 각 상세 계획의 Task 1에서 아래 이름으로 생성한다. 각 계획은 CLI 출력에서 정확히 한 generated path를 task-specific shell variable에 캡처하고, 이후 해당 계획의 SQL placement와 \`git add\`에 그 variable만 재사용한다.

| 상세 계획 | 생성 명령 | generated path variable |
|---|---|---|
| landing identity/admin | \`npx supabase migration new add_landing_lead_journey_contract\` | \`$LANDING_MIGRATION_PATH\` |
| analysis canonicalization | \`npx supabase migration new add_analysis_canonical_tables\` | \`$ANALYSIS_MIGRATION_PATH\` |
| commerce/operations | \`npx supabase migration new add_commerce_operation_canonical_tables\` | \`$COMMERCE_MIGRATION_PATH\` |
| production evidence gate | no migration is created | none |

The three detailed plans require Steps 3–4 to run in one shell session, verify one generated path and an existing file, and never substitute an invented migration timestamp.

## Task 1: Freeze and identity/admin contract

- [ ] 2026-09-05 readiness의 0 bundle/0 parity/empty allowlist를 baseline으로 기록하고 landing journey migration과 operator private projection RED tests를 먼저 통과시킨다.
- [ ] same-device HMAC, one-time capture hash, exact historical links only, deletion unlink fence를 증명한 뒤 target/excluded dashboard를 server-only API에 연결한다.
- [ ] \`npx vitest run lib/services/landing/landing-lead-journey.test.ts lib/services/landing/landing-lead-journey-pglite.test.ts app/api/admin/landing-leads/route.test.ts\`와 typecheck를 PASS시킨다.

## Task 2: Analysis canonical family

- [ ] \`analysis_jobs\`, \`analysis_events\`, \`analysis_artifacts\`, \`analysis_costs\`, \`analysis_cache\`, \`analysis_audit_bundles\`를 additive migration으로 만들고 existing aggregate 이름은 유지한다.
- [ ] finalization/cost reconciliation dual-write, bounded backfill, family flags, legacy rollback reader를 구현하고 unknown usage를 숫자 0으로 치환하지 않는다.
- [ ] source/canonical count·ownership·state·rank·hash·cost·retention parity가 100%일 때만 해당 family를 read cutover 후보로 표시한다.

## Task 3: Commerce and operations family

- [ ] \`payment_events\`, \`fulfillment_jobs\`, \`notification_outbox\`, \`account_lifecycle\`, \`system_configuration\`, \`system_leases\`, \`maintenance_jobs\`를 additive migration으로 만들고 \`users\`, \`earlybird_orders\`, \`earlybird_waitlist\`, \`result_feedback\`는 재사용한다.
- [ ] webhook/fulfillment/outbox/account deletion dual-write와 bounded recovery를 구현하되 independent provider evidence 없는 \`payment_pending\` mutation을 거부한다.
- [ ] payment/order/fulfillment/notification/account deletion/lease/fence/retry concurrency와 rollback reader를 모두 PASS시킨다.

## Task 4: Production evidence gate and handoff

- [ ] exact canonical set, live public table count, RLS/ACL, dependency graph, migration history, archive/restore checksum, rollback window, traffic observation을 sanitized evidence로 수집한다.
- [ ] genuine completed production bundle, 100% per-order parity, aggregate checksum, encrypted archive restore, owner-authorized exact allowlist가 모두 없으면 \`blocked\`를 반환한다.
- [ ] final report의 \`destructiveOperations\`는 항상 \`refused\`이며, 이 plan set은 DROP, admission activation, \`payment_pending\` mutation, real \`0_min._.00\` canary를 실행하지 않는다.

## 공통 변경 파일과 adapter 경계

## Spec coverage map

| 승인 설계 요구 | 추적 task |
|---|---|
| Objective와 정확한 22 public base/partitioned tables | master canonical table 1–22, gate Task 1 |
| Constraints: copy 고정, ownership/payment/result/provider/recovery 보존, RLS, no admission/canary | 모든 상세 계획의 Scope/guardrail, gate Task 4 |
| Landing journey, historical uncertainty, claim/delete fence | landing Task 1–2 |
| Operator dashboard private projection | landing Task 3 |
| Wave 0 freeze/inventory | gate Task 1 및 4 |
| Wave 1 identity/operator surface | landing Task 1–3 |
| Wave 2 canonical tables/RLS/index/RPC | analysis Task 1, commerce Task 1 |
| Wave 3 dual-write/backfill/parity | analysis Task 2–3, commerce Task 2–3 |
| Wave 4 family shadow-read/cutover/rollback | analysis Task 3–4, commerce Task 3–4, gate Task 3 |
| Wave 5 archive/restore/contract/count | gate Task 2–4 |
| Failure handling과 rollback | 네 상세 계획 Task 4 및 공통 verification matrix |

- Landing plan은 generated \`$LANDING_MIGRATION_PATH\`, \`lib/services/leads/store.ts\`, \`lib/services/analysis/anonymous-preflight.ts\`, \`app/api/leads/route.ts\`, \`app/api/admin/landing-leads/route.ts\`, \`app/admin/analysis-audit/workbench.tsx\`와 해당 테스트만 소유한다.
- Analysis plan은 generated \`$ANALYSIS_MIGRATION_PATH\`, \`lib/services/analysis/canonical-analysis-store.ts\`, \`lib/services/analysis/canonical-analysis-read.ts\`, \`scripts/backfill-analysis-canonical.ts\`와 해당 테스트를 소유한다. 기존 execution table은 parity window 동안 read-only source로 남긴다.
- Commerce plan은 generated \`$COMMERCE_MIGRATION_PATH\`, \`lib/services/commerce/canonical-commerce-store.ts\`, \`lib/services/operations/canonical-operations-store.ts\`, \`scripts/backfill-commerce-operations-canonical.ts\`와 webhook/fulfillment/outbox/account lifecycle adapter 테스트를 소유한다.
- Gate plan은 \`lib/services/operations/supabase-22-evidence.ts\`, \`scripts/verify-supabase-22-catalog.ts\`, \`scripts/verify-supabase-22-archive-restore.ts\`, gate contract tests와 evidence report만 소유한다. 적용된 migration, protected migration, \`.playwright-mcp/\`는 수정하지 않는다.

어댑터는 실제 old caller가 존재하는 동안만 유지한다. 새 generic ORM, stage마다 RPC 하나, table count만 맞추는 rename/view chain은 만들지 않는다.

## 공통 verification matrix

- [ ] 각 migration contract test는 predecessor, table/column/check/index, RLS/ACL, function search path, SECURITY DEFINER RPC의 EXECUTE revoke/grant (PUBLIC·anon·authenticated revoke 및 service_role only grant), append-only trigger, no-secret/no-raw-ID shape를 문자열과 disposable database에서 검증한다.
- [ ] Landing contract는 nullable opaque \`source_preflight_id\`(FK 아님), constrained nullable \`mapping_source\`, nullable unique \`capture_token_hash\` fence, 그리고 \`mapping_status = 'unlinked_after_deletion'\` claim exclusion을 검증한다.
- [ ] Analysis contract는 \`analysis_costs\`의 DB CHECK \`NOT usage_unknown OR amount_known IS NULL\`과 \`analysis_audit_bundles\`의 non-null immutable \`content_hash\` uniqueness \`(request_id, version, kind, content_hash)\`를 검증한다.
- [ ] PGlite는 complete/partial/unknown/late-cost/conflict/zero-candidate fixture를 검증한다.
- [ ] native PostgreSQL는 lease/fence, \`SKIP LOCKED\`, idempotency, concurrent claim, append-only, rollback reader를 검증한다.
- [ ] owner result/progress/share, payment/fulfillment/retry/recovery, account deletion, operator dashboard를 canonical/legacy shadow-read로 비교한다.
- [ ] parity는 count만으로 통과하지 않는다. ownership, state transition, order/rank, content hash, cost total, retention marker, unknown source를 모두 비교한다.
- [ ] archive restore는 isolated database에서 aggregate count와 SHA-256 checksum을 재현해야 한다. archive object 존재만으로 통과시키지 않는다.
- [ ] 매 wave 뒤 exact public table count, catalog dependency, RLS/ACL/grant, route smoke, secret scan을 기록한다.
- [ ] \`npm run lint\`, \`npx tsc --noEmit --pretty false\`, \`npx vitest run lib/services/analysis/order-audit-consolidation.test.ts\`, \`npm run build\`, \`git diff --check\`를 실행하고 명령별 기대 결과를 report에 남긴다.

## Commit cadence

각 상세 계획은 RED test → schema/contract → service adapter → backfill → shadow-read → verification 단위로 커밋한다. 권장 커밋 메시지는 \`test: define canonical contract\`, \`feat: add canonical contract\`, \`feat: dual-write canonical evidence\`, \`test: prove canonical parity\`, \`docs: record consolidation evidence\`이며 한 커밋에 migration과 무관한 cleanup을 섞지 않는다.

## 완료 및 중단 조건

- [ ] 22개 이름과 책임이 canonical map과 일치하고, 기존 174개에서 줄어든 수는 각 archive manifest와 exact allowlist로 설명된다.
- [ ] \`analysis_order_audit_* \` 3개는 새 \`analysis_audit_bundles\` parity/restore/retention proof 전까지 denylist이며, 2026-09-05의 0 bundle/0 parity 상태를 ready로 재해석하지 않는다.
- [ ] \`payments\`, \`payment_orders\`, \`pending_analysis\`는 owner catalog evidence와 separate approval 전까지 unknown/no-action 또는 denylist로 남긴다.
- [ ] 하나라도 source missing, ownership mismatch, status mismatch, rank/checksum/cost/retention mismatch, unresolved dependency, restore mismatch, rollback gap이 있으면 해당 wave를 blocked로 종료한다.
- [ ] destructive action은 별도 승인된 exact allowlist가 있고, archive restore와 rollback drill이 검증된 뒤에만 별도 rollout 문서에서 다룬다. 이 master plan 자체는 DROP·activation·payment_pending mutation·real canary를 승인하지 않는다.

## Master self-review

- [ ] 설계의 landing journey, historical uncertainty, admin private projection, 22 table list, typed JSONB, five migration waves, failure handling, rollback, verification, completion criteria를 네 상세 계획의 task로 추적한다.
- [ ] 문서 전체에서 금지된 placeholder 표기, 미완료 지시, 임시 값 표기를 검색해 0건을 확인한다.
- [ ] four detailed plans의 table names, state enums, TypeScript field names, migration filenames, CLI commands를 cross-plan으로 비교한다.
- [ ] 모든 plan을 저장한 뒤 \`git diff --check\`와 placeholder scan이 0 exit/0 matches가 되는지 확인한다.
