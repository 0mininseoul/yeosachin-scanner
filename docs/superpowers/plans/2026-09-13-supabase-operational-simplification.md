# Supabase 운영 단순화 Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 기준 SHA 053d46326e7ecf45c02ebab9ae210ffe66624d00에서 exact-22 terminal count 계약을 폐기하고, active runtime·payment·provider·operator audit·maintenance contract를 보존하면서 fresh evidence가 허용한 inactive canonical shadow subset만 수축한다.

**Architecture:** legacy V2, payment/order, notification, identity deletion, provider admission/charge, operator audit source를 authoritative 또는 retained contract로 둔다. predeploy additive compatibility migration으로 retained jobs/events의 호환 validator와 RPC 표면을 먼저 제공하고, code deploy → old revision drain → fresh independent evidence와 fixed exact manifest/hash를 거친 뒤에만 별도 exact no-CASCADE contraction migration을 작성·적용한다. analysis_jobs/events는 W1A에서 object 보존·비변경만 확인하고 full-row archive는 별도 preservation wave로 이동한다.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase PostgreSQL, Supabase CLI 2.102.0, existing TypeScript/SQL contract and PGlite tests.

---

## 이전 planning dispatch의 경계 (보존)

이전 planning dispatch에서 실제로 수정하는 파일은 아래 두 문서뿐이다.

- docs/superpowers/specs/2026-09-13-supabase-operational-simplification-design.md
- docs/superpowers/plans/2026-09-13-supabase-operational-simplification.md

이전 planning dispatch에서는 코드/SQL 구현, production/remote Supabase/Vercel 접근, migration apply, supabase db push, flag activation, test 실행, canary, payment_pending mutation을 하지 않았다. 후속 implementation work package는 이 경계와 분리된 작업이며, 아래의 predeploy compatibility 구현만 포함하고 exact contraction이나 원격 적용 권한을 부여하지 않는다.

## 현재 implementation package의 고정 순서

이 문서의 planning dispatch와 별도인 현재 implementation package는 다음 순서를 고정한다.

1. **Predeploy additive compatibility migration:** `20260913130000_contract_supabase_operational_policy_v1.sql`은 retained `analysis_jobs`/`analysis_events`와 호환되는 validator, retry enqueue RPC, family load RPC만 추가한다. 기존 RPC·table·function·index·trigger·ACL은 drop/변경하지 않고, caller-controlled GUC evidence도 허용하지 않는다.
2. **Code deploy:** producer/consumer가 새 retained execution contract를 사용할 수 있게 배포하되 old revision과 old-compatible event writer를 즉시 제거하지 않는다.
3. **Old-revision drain and fresh evidence:** old revision의 in-flight request/job/queue 및 old RPC caller가 0임을 drain evidence로 확인한 뒤, 독립 read-only catalog/traffic evidence에서 exact routine signature, SECURITY DEFINER, `search_path`, ACL, full operator-audit contract, typed `payment_pending` read-only counts/checksum, revision/window/drain을 검증한다.
4. **Fixed exact manifest/hash:** 위 fresh evidence를 바탕으로 exact object/dependency manifest와 no-CASCADE allowlist hash를 고정하고 embedded source/hash를 남긴다. shape-only closure, caller-supplied hash/boolean, 빈 배열은 승인 근거가 아니다.
5. **Post-deploy contraction authoring/application:** 위 조건이 모두 충족된 뒤에만 W1A-only exact contraction migration을 새로 작성하고 별도 승인·적용한다. 이 implementation package에는 contraction migration이 없으며 production/remote apply는 수행하지 않는다.

## 결정된 operational policy

### supabase-operational-policy-v1

기존 SUPABASE_22_CANONICAL_TABLES, expected table count 187/165, exact canonical set, canonicalSetMatch는 다음 policy schema/version으로 대체한다.

~~~
{
  "schemaVersion": "supabase-operational-policy-v1",
  "sourceSha": "053d46326e7ecf45c02ebab9ae210ffe66624d00",
  "retained": {
    "execution": ["analysis_jobs", "analysis_events"],
    "provider": ["analysis_provider_runs", "analysis_v2_provider_runs"],
    "payment": ["payment_events", "payment_pending", "payments", "payment_orders", "earlybird_orders", "pending_analysis"],
    "recovery": ["maintenance_jobs"],
    "identityDeferred": ["account_lifecycle"],
    "operatorAudit": {
      "tables": [
        "analysis_order_audit_assembly_queue", "analysis_order_audit_bundles",
        "analysis_order_audit_candidates", "analysis_order_audit_interactions"
      ],
      "rpcExamples": [
        "load_analysis_order_audit_bundle", "list_analysis_order_audit_bundles",
        "claim_analysis_order_audit_bundle", "read_analysis_order_audit_parity_snapshot"
      ]
    }
  },
  "forbiddenW1A": [
    "analysis_jobs", "analysis_events", "analysis_provider_runs",
    "analysis_v2_provider_runs", "payment_events", "maintenance_jobs",
    "analysis_order_audit_assembly_queue", "analysis_order_audit_bundles",
    "analysis_order_audit_candidates", "analysis_order_audit_interactions",
    "account_lifecycle"
  ],
  "approvedSubset": [
    "analysis_artifacts", "analysis_audit_bundles", "analysis_cache",
    "analysis_costs", "fulfillment_jobs", "notification_outbox",
    "system_configuration", "system_leases"
  ],
  "closure": {
    "tables": [], "routines": [], "flags": [], "indexes": [],
    "triggers": [], "policies": [], "acls": [], "views": [],
    "foreignKeys": [], "sequences": [], "publications": [],
    "dependencies": []
  },
  "noCascadeAllowlistHash": null
}
~~~

closure는 fresh catalog 결과로 채우며 빈 배열을 통과값으로 취급하지 않는다. noCascadeAllowlistHash는 exact no-CASCADE manifest를 확인한 뒤에만 채우며 null을 승인값으로 취급하지 않는다. retained/forbiddenW1A object는 pre/post에 존재하고 checksum이 허용된 변화 외에는 동일해야 한다. approvedSubset은 다음 8개 upper bound에서 fresh evidence가 승인한 family만 담고, 8개보다 줄어들 수 있으며 구현자는 숫자를 억지로 맞추지 않는다.

### W1A와 보존 경계

- W1A upper bound: analysis_artifacts, analysis_audit_bundles, analysis_cache, analysis_costs, fulfillment_jobs, notification_outbox, system_configuration, system_leases.
- account_lifecycle은 W1A에서 완전히 제외한 retained/deferred family다. account-deletion.ts의 flag-gated lifecycle evidence와 irreversible-action guard를 대체 설계하지 않으며, account_lifecycle table/RPC/flags/callers는 이번 code/schema change에서 손대지 않는다.
- W1A에서 보존: analysis_jobs/events table·row·schema·index·FK·trigger·ACL, analysis_provider_runs, analysis_v2_provider_runs, payment_events, payment_pending, payments, payment_orders, earlybird_orders, pending_analysis, maintenance_jobs.
- operator audit contract는 analysis_order_audit_assembly_queue, analysis_order_audit_bundles, analysis_order_audit_candidates, analysis_order_audit_interactions table과 load_analysis_order_audit_bundle, list_analysis_order_audit_bundles, claim_analysis_order_audit_bundle, read_analysis_order_audit_parity_snapshot RPC 예시를 포함하며 W1A에서 보존한다. analysis_audit_bundles는 이 계층과 다른 W1A analysis canonical shadow table이다.
- analysis_jobs/events 19/81 full-row archive는 W1A 선행 조건이 아니다. W1A에서는 object 보존·비변경만 확인하고, 후속 preservation wave에서 consistent snapshot/archive/checksum/reference manifest를 독립 수행한다.
- payment_events hold와 payment_pending read-only 관찰은 유지하되 status mutation은 하지 않는다.
- 실제 0_min._.00 canary, synthetic canary, fake production bundle은 실행하거나 evidence로 사용하지 않는다.

## 파일 지도

| 후속 work package | 변경 대상 | 책임 |
| --- | --- | --- |
| analysis adapter split | lib/services/analysis/canonical-analysis-store.ts, lib/services/analysis/canonical-analysis-read.ts, lib/services/analysis/v2-worker.ts, lib/services/analysis/v2-progress-reporter.ts, lib/services/analysis/provider-cost-reconciliation.ts, lib/services/analysis/v2-result-store.ts | retained jobs/events만 남기고 W1A artifact/audit/cache/cost branch 제거 |
| analysis SQL closure | 새 contraction migration과 restore manifest; 기존 20260909095740, 20260911123000, 20260911100000은 immutable history | validator/RPC/index/trigger/grant/backfill branch를 exact allowlist로 분리 |
| commerce/account closure | lib/services/operations/canonical-operations-store.ts, lib/services/commerce/canonical-commerce-store.ts, lib/services/identity/account-principal-store.ts, lib/services/identity/account-deletion.ts, lib/services/identity/account-deletion-canonical-adapter.ts, earlybird/notification callers | W1A fulfillment/notification/config/lease mirror만 제거하고 account_lifecycle, maintenance mirror/parity/shared hash/payment hold 보존 |
| policy replacement | lib/services/operations/supabase-22-evidence.ts, scripts/generate-supabase-22-retirement-inventory.ts, scripts/verify-supabase-22-catalog.ts | exact-22 count/set 대신 operational policy v1 검증 |
| existing tests only | 기존 canonical/catalog/evidence/contract/PGlite test 파일 | 새 test file 없이 정책 및 retained/forbidden invariant 갱신 |

## Task 0: fresh evidence와 policy manifest를 고정한다

**Files:**

- Read: lib/services/operations/supabase-22-evidence.ts
- Read: scripts/generate-supabase-22-retirement-inventory.ts
- Read: scripts/verify-supabase-22-catalog.ts
- Read: supabase/migrations/20260909095740_add_analysis_canonical_tables.sql
- Read: supabase/migrations/20260911123000_add_analysis_canonical_backfill_apply.sql
- Read: supabase/migrations/20260911100000_grant_wave1_backfill_projection_select.sql
- Read: supabase/migrations/20260909095932_add_commerce_operation_canonical_tables.sql

- [ ] **Step 1: 기준 SHA와 worktree 경계를 기록한다.**

실행 명령:

~~~sh
git status --short --branch
git rev-parse HEAD
git show -s --format='%H%n%s' 053d46326e7ecf45c02ebab9ae210ffe66624d00
~~~

기대 결과: HEAD가 기준 SHA이고, 현재 작업 변경은 이 두 문서 외에 없다. app/page.tsx, .playwright-mcp/, 보호 migration은 수정 대상에서 제외한다.

- [ ] **Step 2: fresh catalog evidence를 policy 입력으로 분리한다.**

public table count, exact row count, PK digest, column/type/default, index, FK, trigger, policy/RLS, ACL, view, sequence, publication, partition, pg_depend, migration history, source caller, flag/config source를 하나의 observation window에 기록한다. pg_stat.stats_reset, last updated timestamp, 0행만으로 quiescence를 판정하지 않는다.

- [ ] **Step 3: retained/forbidden/approvedSubset을 policy v1로 분류한다.**

retained에는 analysis_jobs, analysis_events, analysis_provider_runs, analysis_v2_provider_runs, payment_events, payment_pending, payments, payment_orders, earlybird_orders, pending_analysis, maintenance_jobs와 analysis_order_audit_assembly_queue, analysis_order_audit_bundles, analysis_order_audit_candidates, analysis_order_audit_interactions를 넣는다. operator RPC 예시는 load_analysis_order_audit_bundle, list_analysis_order_audit_bundles, claim_analysis_order_audit_bundle, read_analysis_order_audit_parity_snapshot이다. account_lifecycle은 retained/deferred이며 W1A approvedSubset에는 넣지 않는다. W1A approvedSubset은 8개 upper bound에서 시작하되 caller/dependency/legacy/operator evidence가 부족한 family를 deferred로 이동한다.

완료 조건: policy schemaVersion이 supabase-operational-policy-v1이고, table count가 future guarantee로 노출되지 않으며, forbiddenW1A와 closure가 명시되어 있다.

## Task 1: analysis_jobs/events와 W1A artifact/audit/cache/cost를 split한다

**Files:**

- Modify: lib/services/analysis/canonical-analysis-store.ts
- Modify: lib/services/analysis/canonical-analysis-read.ts
- Modify: lib/services/analysis/v2-worker.ts
- Modify: lib/services/analysis/v2-progress-reporter.ts
- Modify: lib/services/analysis/provider-cost-reconciliation.ts
- Modify: lib/services/analysis/v2-result-store.ts
- Modify: existing analysis canonical contract tests only
- Read: supabase/migrations/20260909095740_add_analysis_canonical_tables.sql
- Read: supabase/migrations/20260911123000_add_analysis_canonical_backfill_apply.sql
- Read: supabase/migrations/20260911100000_grant_wave1_backfill_projection_select.sql

- [ ] **Step 1: 공용 evidence flag를 retained events 전용 flag로 분리한다.**

현재 appendEvent와 appendArtifact가 공유하는 ANALYSIS_CANONICAL_EVIDENCE_READ/WRITE를 유지하지 않는다. jobs는 ANALYSIS_CANONICAL_JOBS_READ/WRITE를 유지하고, events는 새 ANALYSIS_CANONICAL_EVENTS_READ/WRITE로 분리한다. W1A에서는 ANALYSIS_CANONICAL_EVIDENCE_READ/WRITE, COST_READ/WRITE, CACHE_READ/WRITE, AUDIT_READ/WRITE를 hard-off한 뒤 env/config/source에서 제거한다.

- [ ] **Step 2: canonical-analysis-store.ts의 family/type/interface를 jobs/events만 허용하도록 정리한다.**

recordJob, appendEvent, retained payload/hash/timestamp validation과 retained RPC 호출은 유지한다. appendArtifact, appendCost, appendLateCostAudit, upsertCache, appendAuditRow, loadAuditVersions, W1A payload maps와 audit version parser는 제거한다. AnalysisCanonicalWriteFamily와 retry result type은 jobs/events만 허용한다.

- [ ] **Step 3: canonical-analysis-read.ts의 six-array bundle을 two-array execution bundle로 바꾼다.**

AnalysisCanonicalReadFamily는 jobs/events만 허용한다. AnalysisCanonicalReadBundle, row parser, nested exact-key map, parity path에서 artifacts/costs/caches/audits/familyRows branch를 제거한다. legacy read는 authoritative로 유지하고 canonical failure/mismatch는 fail-open한다.

- [ ] **Step 4: bundle/load/retry RPC를 retained-only contract로 rewrite한다.**

record_analysis_canonical_job와 append_analysis_canonical_event는 retained RPC로 유지한다. load_analysis_canonical_family(UUID,TEXT)는 caller를 새 load_analysis_execution_family_v1(UUID,TEXT)로 바꾼 뒤 drop한다. 새 load RPC는 family jobs/events만 받고 response도 jobs/events만 반환한다. enqueue_analysis_canonical_retry의 W1A branch를 제거하고 enqueue_analysis_execution_retry_v1(UUID,TEXT)로 retained jobs/events retry marker만 기록한다. append_analysis_canonical_artifact, append_analysis_canonical_cost, upsert_analysis_canonical_cache, append_analysis_canonical_audit, append_analysis_canonical_late_cost_audit는 W1A-only drop list로 만든다.

- [ ] **Step 5: SQL/TypeScript validator를 retained-only로 split한다.**

analysis_canonical_json_object_has_exact_keys, analysis_canonical_json_value_valid, analysis_canonical_payload_valid, analysis_canonical_payload_has_only_keys와 CANONICAL_PAYLOAD_KEYS/CANONICAL_EXACT_NESTED_KEYS의 W1A artifacts/costs/caches/audits/familyRows branch를 제거한다. jobs state/generation/attempt/dependency/completionHash, events kind/state/contentHash/timestamp와 operational retry payload 검증은 남긴다. W1A key를 허용하는 generic validator를 남긴 채 table만 drop하지 않는다.

- [ ] **Step 6: trigger/index dependency를 retained와 W1A로 분리한다.**

analysis_events_append_only와 retained-only reject trigger function을 유지한다. analysis_costs_append_only, analysis_audit_bundles_append_only와 W1A trigger dependency는 제거한다. retained index는 analysis_jobs_dispatch_idx, analysis_events_request_created_idx, analysis_events_retry_key_idx다. W1A index는 analysis_artifacts_request_kind_idx, analysis_costs_request_recorded_idx, analysis_costs_request_idempotency_idx, analysis_cache_expiry_idx, analysis_cache_request_updated_idx, analysis_audit_request_version_idx, analysis_audit_request_idempotency_idx다.

- [ ] **Step 7: 20260911123000 backfill branch를 W1A에서 실행하지 않는다.**

analysis_jobs/events payload constraint, analysis_events_backfill_copy_key_idx와 jobs/events branch는 preservation wave의 deferred evidence로 object non-change만 확인한다. append_analysis_canonical_artifact 재정의와 artifacts/costs branch를 W1A code/migration dependency에서 제거한다. apply_analysis_canonical_backfill_row(TEXT,TEXT,TEXT,TEXT,TEXT,UUID,JSONB)는 W1A에서 호출하지 않으며, source/DB caller count가 0이고 old revision drain이 끝난 뒤 contraction migration에서 exact signature로 no-CASCADE drop한다. 기존 multi-family RPC를 wrapper로 남기지 않으며 retained-only preservation RPC는 별도 wave에서 새로 설계한다. W1A에서는 retained jobs/events용 새 backfill script/RPC를 만들지 않는다. 20260911100000의 artifact/cost column grant는 제거하고 jobs/events grant는 유지한다.

완료 조건: retained execution source에 W1A table name, W1A flag, W1A RPC, six-array response key, W1A retry branch가 없고, analysis_jobs/events table/index/constraint/grant와 legacy path가 동일하다.

## Task 2: commerce W1A와 account deletion을 분리한다

**Files:**

- Modify: lib/services/operations/canonical-operations-store.ts
- Modify: lib/services/commerce/canonical-commerce-store.ts
- Modify: lib/services/identity/account-principal-store.ts
- Modify: lib/services/identity/account-deletion.ts
- Modify: lib/services/identity/account-deletion-canonical-adapter.ts
- Modify: lib/services/earlybird/fulfillment-store.ts
- Modify: lib/services/earlybird/payment-discord.ts
- Modify: lib/services/identity/kakao-signup-discord.ts
- Modify: lib/services/sentry-discord-alert.ts
- Modify: app/api/internal/earlybird-payment-discord-outbox/route.ts
- Modify: app/api/internal/kakao-signup-discord-outbox/route.ts
- Modify: app/api/internal/sentry-discord-alert-outbox/route.ts
- Read: supabase/migrations/20260909095932_add_commerce_operation_canonical_tables.sql
- Read: supabase/migrations/20260910020205_prepare_account_deletion_canonical_wave.sql
- Read: supabase/migrations/20260910035257_add_account_deletion_backfill_parity.sql

- [ ] **Step 1: fulfillment/notification/config/lease W1A caller를 제거한다.**

upsert_fulfillment_job_v1와 fulfillment dual-write/fallback, enqueue_notification_v1/claim_notification_outbox_v1/finish_notification_outbox_v1/reconcile_stale_notification_outbox_v1/list_notification_outbox_v1, record_system_configuration_v1, acquire_system_lease_v1와 각 W1A flag/shadow helper를 제거한다. legacy fulfillment/order, three notification outbox delivery route, idempotency/retry, provider/admission runtime lease가 독립적으로 유지되는지 source evidence를 남긴다.

- [ ] **Step 2: legacy notification reader를 manifest에 명시한다.**

list_notification_legacy_outbox_v1는 canonical parity 전용 reader이므로 source caller와 W1A disposition을 기록한다. shadowReadCanonicalNotificationOutbox 제거 후 list_notification_outbox_v1와 함께 exact drop allowlist에 넣는다. legacy outbox source tables와 delivery route는 유지하며 두 reader를 delivery contract로 오인하지 않는다.

- [ ] **Step 3: account deletion과 account_lifecycle을 이번 wave에서 no-touch로 고정한다.**

account_lifecycle table, account_lifecycle_account_recorded_idx, account_lifecycle_immutable, append_account_lifecycle_v1, account lifecycle flags와 callers를 이번 code/schema change에서 제거·변경하지 않는다. account-deletion.ts의 flag-gated lifecycle evidence, begin_account_deletion_v1, finalize_account_deletion_database_v1, complete_account_deletion_v1, irreversible-action guard와 maintenance mirror/recovery branch를 그대로 유지한다. lifecycle evidence/guard 대체 설계는 별도 deferred wave로 이동한다.

- [ ] **Step 4: maintenance_jobs mirror/parity/shared hash를 보존한다.**

maintenance_jobs, maintenance_jobs_recovery_idx, mirror_account_deletion_job_v1, enqueue_maintenance_job_v1, claim_maintenance_jobs_v1, finish_maintenance_job_v1, reconcile_stale_maintenance_jobs_v1, backfill_account_deletion_jobs_v1, collect_account_deletion_parity_v1를 forbiddenW1A로 기록한다. source_key_hash, legacy_state, target_key_hash, content_hash, parity schema/checksum을 pre/post 비교한다.

canonicalJsonHash, canonicalEvidenceHash와 SQL canonical_json_string_v1, canonical_json_number_v1, canonical_json_v1, canonical_json_hash_v1는 payment/maintenance/account-deletion caller가 공유하므로 canonical-commerce-store 전체를 제거하지 않는다. W1A-only canonical_system_configuration_json는 caller inventory가 닫힌 경우에만 drop list에 넣는다.

- [ ] **Step 5: payment/provider/operator audit contract를 no-touch로 고정한다.**

payment_events, payment_pending, payments, payment_orders, earlybird_orders, pending_analysis, record_payment_event_v1, analysis_provider_runs, analysis_v2_provider_runs와 analysis_order_audit_assembly_queue, analysis_order_audit_bundles, analysis_order_audit_candidates, analysis_order_audit_interactions 및 load/list/claim/release/enqueue/assemble/read parity RPC를 W1A drop/mutation allowlist에서 제외한다.

- [ ] **Step 6: W1A를 참조하는 old backfill entry point의 caller와 파일 disposition을 고정한다.**

`scripts/backfill-analysis-canonical.ts`는 abandoned exact-22 multi-family backfill entry point이므로 W1A code deploy에서 retire/delete한다. `scripts/backfill-analysis-canonical.test.ts`도 함께 retire/delete하고, `package.json`의 해당 script alias(현재 repo에는 없음), production import(현재 없음), 다음 docs caller의 runnable command/reference를 제거하거나 retired historical note로 바꾼다: `docs/reports/2026-09-11-supabase-22-final-convergence-inventory.json`, `docs/reports/2026-09-11-supabase-22-wave1-production-readonly-evidence.md`, `docs/superpowers/plans/2026-09-09-supabase-22-table-analysis-canonicalization.md`, `docs/superpowers/plans/2026-09-09-supabase-22-table-master.md`, `docs/superpowers/plans/2026-09-11-supabase-22-final-convergence.md`. `apply_analysis_canonical_backfill_row(TEXT,TEXT,TEXT,TEXT,TEXT,UUID,JSONB)`는 source/DB caller count가 0이고 old revision drain이 끝난 뒤에만 exact signature로 no-CASCADE drop한다. W1A에서는 retained jobs/events용 새 backfill script/RPC를 만들지 않는다.

`scripts/backfill-commerce-operations-canonical.ts`는 fulfillment/notification/config/lease 등 W1A family를 함께 노출하는 old multi-family entry point이므로 W1A code deploy에서 retire/delete하고 `scripts/backfill-commerce-operations-canonical.test.ts`와 package/import/docs caller를 함께 정리한다. commerce docs caller는 `docs/reports/2026-09-09-supabase-22-commerce-operations-evidence.md`, `docs/reports/2026-09-10-supabase-22-next-retirement-candidates.json`, `docs/reports/2026-09-11-supabase-22-final-convergence-inventory.json`, `docs/superpowers/plans/2026-09-09-supabase-22-table-commerce-operations-canonicalization.md`, `docs/superpowers/plans/2026-09-09-supabase-22-table-master.md`, `docs/superpowers/plans/2026-09-11-supabase-22-final-convergence.md`이며 historical evidence는 실행 가능한 caller가 아니도록 disposition을 기록한다. account_lifecycle caller는 삭제하지 않고 no-touch로 유지한다.

`scripts/backfill-account-deletion-canonical.ts`, `scripts/backfill-account-deletion-canonical.test.ts`, `lib/services/identity/account-deletion-canonical-pglite.test.ts`의 import/test와 `backfill_account_deletion_jobs_v1`/`collect_account_deletion_parity_v1` maintenance parity는 보존한다. 이 dedicated account-deletion/maintenance parity path와 `canonicalJsonHash`, `canonicalEvidenceHash`, `canonical_json_string_v1`, `canonical_json_number_v1`, `canonical_json_v1`, `canonical_json_hash_v1` shared hash는 W1A backfill retire에 포함하지 않는다.

완료 조건: W1A commerce caller가 제거되고 legacy routes가 유지되며, maintenance mirror/parity/shared hash, payment/provider/operator audit contract에 변경이 없다. account_lifecycle과 dedicated account-deletion parity caller는 남아 있고, W1A family caller count만 0이다.

## Task 3: exact-22 verifier를 operational policy verifier로 바꾼다

**Files:**

- Modify: lib/services/operations/supabase-22-evidence.ts
- Modify: scripts/generate-supabase-22-retirement-inventory.ts
- Modify: scripts/verify-supabase-22-catalog.ts
- Modify: scripts/verify-supabase-22-archive-restore.ts (retain and update; actual repo path)
- Modify: existing tests only:
  - lib/services/operations/supabase-22-catalog-pglite.test.ts
  - lib/services/operations/supabase-22-evidence.test.ts
  - scripts/verify-supabase-22-catalog.test.ts
  - scripts/generate-supabase-22-retirement-inventory.test.ts
  - scripts/verify-supabase-22-archive-restore.test.ts
  - affected existing canonical-analysis/canonical-commerce/canonical-operations contract tests

- [ ] **Step 1: policy schema/version과 classification output을 정의한다.**

SUPABASE_22_CANONICAL_TABLES와 187/165 expected count comparison을 제거한다. supabase-operational-policy-v1, sourceSha, retained, forbiddenW1A, approvedSubset, closure, noCascadeAllowlistHash와 deferred reason을 출력한다. policy version은 고정하되 table count와 approvedSubset 크기는 fresh evidence에 따라 변할 수 있다.

- [ ] **Step 2: retained/forbidden invariant를 검증한다.**

verifier는 retained analysis_jobs, analysis_events, analysis_provider_runs, analysis_v2_provider_runs, payment_events, payment_pending, payments, payment_orders, earlybird_orders, pending_analysis, maintenance_jobs와 analysis_order_audit_assembly_queue, analysis_order_audit_bundles, analysis_order_audit_candidates, analysis_order_audit_interactions가 존재하는지 확인한다. operator RPC 예시인 load_analysis_order_audit_bundle, list_analysis_order_audit_bundles, claim_analysis_order_audit_bundle, read_analysis_order_audit_parity_snapshot도 retained contract로 확인한다. analysis_audit_bundles는 approvedSubset의 W1A shadow table이며 analysis_order_audit_bundles와 다른 object다. forbiddenW1A에 대한 DROP/ALTER/DML, account_lifecycle mutation, payment_pending mutation, unexpected routine/flag/ACL/view/FK/sequence/trigger/publication change가 있으면 실패한다.

- [ ] **Step 3: 기존 catalog PGlite fixture와 기존 contract assertion만 갱신한다.**

lib/services/operations/supabase-22-catalog-pglite.test.ts의 exact-22 table fixture/assertion을 policy class와 retained/forbidden invariant로 바꾼다. supabase-22-evidence, verify catalog, generate inventory, verify-supabase-22-archive-restore의 기존 assertion을 새 schemaVersion/sourceSha/retained/forbiddenW1A/approvedSubset/closure/noCascadeAllowlistHash와 subset semantics에 맞게 갱신한다. 새 test file, snapshot suite, broad CI job은 만들지 않는다.

- [ ] **Step 4: historical document semantics를 유지한다.**

실제 repo의 archive verifier 파일은 `scripts/verify-supabase-22-archive-restore.ts`와 `scripts/verify-supabase-22-archive-restore.test.ts`다. 이 verifier는 order-audit parity의 encrypted archive/isolated restore checksum을 검증하므로 retire하지 않고 operational-policy-v1의 새 schemaVersion/sourceSha/retained/forbiddenW1A/approvedSubset/closure/noCascadeAllowlistHash와 실제 retained operator table/RPC invariants를 소비하도록 갱신한다. `canonicalSetMatch`, exact-22 count/set만 검증하는 assertion은 제거한다. 기존 exact-22 design/report는 historical baseline으로 남기고, 새 inventory/policy가 160 snapshot 또는 exact-22 terminal count를 future guarantee로 표현하지 않는지 확인한다.

완료 조건: catalog와 archive/restore verifier가 exact count/set 대신 policy version, retained/forbidden invariant, closure completeness, approvedSubset과 no-CASCADE allowlist hash를 판정한다.

## Task 4: migration manifest와 bounded contraction 순서를 고정한다

**Files:**

- Create in a later implementation branch: new W1A contraction migration and isolated restore operation
- Read only: supabase/migrations/20260909095740_add_analysis_canonical_tables.sql
- Read only: supabase/migrations/20260911123000_add_analysis_canonical_backfill_apply.sql
- Read only: supabase/migrations/20260911100000_grant_wave1_backfill_projection_select.sql
- Read only: supabase/migrations/20260909095932_add_commerce_operation_canonical_tables.sql

- [ ] **Step 1: manifest object classes를 완성한다.**

manifest에는 W1A table, PK/unique/check/default, RLS/force RLS, table/column ACL, exact routine signature와 SECURITY DEFINER/search_path/EXECUTE ACL, flags/config source, indexes/predicates, triggers/functions, policies, views/materialized views, FK, serial/identity sequence, publication/partition, ownership, pg_depend edge를 포함한다.

- [ ] **Step 2: analysis exact drop/retain list를 고정한다.**

drop 후보는 analysis_artifacts, analysis_audit_bundles, analysis_cache, analysis_costs와 그 W1A-only RPC/index/trigger/ACL/FK/sequence/view dependency다. retain list는 analysis_jobs/events, analysis_jobs_dispatch_idx, analysis_events_request_created_idx, analysis_events_retry_key_idx, analysis_events_backfill_copy_key_idx, current retained constraints/grants/trigger와 execution-only validator다.

- [ ] **Step 3: commerce exact drop/retain list를 고정한다.**

drop 후보는 fulfillment_jobs, notification_outbox, system_configuration, system_leases와 W1A-only routine/index/trigger/ACL/FK/sequence/view dependency다. account_lifecycle은 table/RPC/flags/callers를 포함해 retained/deferred로 유지한다. retain list는 payment_events, its immutable trigger/function, maintenance_jobs and recovery index/RPC, shared canonical JSON/hash, legacy source outbox tables/routes, provider tables, order/payment source와 analysis_order_audit_assembly_queue, analysis_order_audit_bundles, analysis_order_audit_candidates, analysis_order_audit_interactions이다.

- [ ] **Step 4: no-CASCADE migration precondition을 명시한다.**

모든 DROP TABLE/FUNCTION/INDEX/TRIGGER는 exact schema/name/signature를 직접 적는다. DROP ... CASCADE, broad wildcard, implicit dependent deletion은 금지한다. dependency precondition 또는 allowlist가 하나라도 실패하면 migration을 apply하지 않고 family를 deferred set으로 되돌린다.

- [ ] **Step 5: predeploy additive compatibility → code deploy → old revision drain → fresh evidence + fixed manifest/hash → flags hard-off/removed → exact contraction 순서를 적용한다.**

`20260913130000_contract_supabase_operational_policy_v1.sql` 같은 additive compatibility migration을 먼저 적용할 수 있지만, old Vercel/worker revision이 drain되어 in-flight request/job/queue와 old RPC caller가 0임을 증명하기 전에는 schema를 줄이지 않는다. drain 후 fresh independent evidence와 exact embedded manifest/hash를 검증하고, W1A flags를 모두 hard-off한 뒤 source/config에서 제거한다. exact contraction migration은 이 모든 조건이 충족된 뒤에만 새로 작성·적용한다. W1A flags는 ANALYSIS_CANONICAL_EVIDENCE_READ, ANALYSIS_CANONICAL_EVIDENCE_WRITE, ANALYSIS_CANONICAL_COST_READ, ANALYSIS_CANONICAL_COST_WRITE, ANALYSIS_CANONICAL_CACHE_READ, ANALYSIS_CANONICAL_CACHE_WRITE, ANALYSIS_CANONICAL_AUDIT_READ, ANALYSIS_CANONICAL_AUDIT_WRITE와 COMMERCE_CANONICAL_FULFILLMENT_READ, COMMERCE_CANONICAL_FULFILLMENT_WRITE, COMMERCE_CANONICAL_NOTIFICATION_READ, COMMERCE_CANONICAL_NOTIFICATION_WRITE, COMMERCE_CANONICAL_CONFIG_READ, COMMERCE_CANONICAL_CONFIG_WRITE, COMMERCE_CANONICAL_LEASE_READ, COMMERCE_CANONICAL_LEASE_WRITE다. account lifecycle flags/callers는 no-touch retained/deferred이고, retained jobs/events flags, maintenance, payment hold flag는 별도 policy로 남긴다.

- [ ] **Step 6: post evidence를 수집한다.**

W1A subset만 absent이고 forbiddenW1A/retained object checksum, provider/payment/operator/recovery rows, legacy route/RPC contract, maintenance mirror/parity/hash, migration history가 동일한지 확인한다. analysis_jobs/events full-row archive는 post/W1A gate에서 요구하지 않고 preservation wave로 기록한다.

완료 조건: old revision drain evidence, W1A hard-off/removal evidence, exact no-CASCADE allowlist, pre/post catalog digest와 retained contract evidence가 모두 존재한다.

## Task 5: 제한된 검증과 handoff

**Files:**

- Verify only the two documents in this dispatch

- [ ] **Step 1: marker scan을 수행한다.**

다음 패턴을 문서 두 개에서 검사한다.

~~~sh
marker_pattern='TO''DO|TB''D|FIX''ME|PLACE''HOLDER'
rg -n -i "$marker_pattern" \
  docs/superpowers/specs/2026-09-13-supabase-operational-simplification-design.md \
  docs/superpowers/plans/2026-09-13-supabase-operational-simplification.md
~~~

기대 결과: 출력이 없다. 이 dispatch에서는 npx tsc와 test를 실행하지 않는다.

- [ ] **Step 2: diff hygiene와 정확한 파일 수를 검증한다.**

~~~sh
git diff --check
git diff --name-only 053d46326e7ecf45c02ebab9ae210ffe66624d00
git status --short
~~~

기대 결과: diff --check 성공, 변경 파일 name-only가 위 두 문서와 정확히 일치, protected path 변경 없음.

- [ ] **Step 3: 후속 implementation 검증 범위를 고정한다.**

후속 code implementation에서 허용하는 기본 검증은 npx tsc --noEmit --pretty false와 변경한 기존 contract/pglite test의 targeted run뿐이다. 관련 기존 파일은 canonical-analysis-store/read/pglite, canonical-operations-store, canonical-commerce-store/pglite, supabase-22-catalog-pglite, supabase-22-evidence, verify-supabase-22-catalog, generate-supabase-22-retirement-inventory다. 새 테스트, broad test suite, full CI, production/remote access, 실제 0_min._.00 canary는 금지한다.

- [ ] **Step 4: 문서 commit을 만든다.**

~~~sh
git add docs/superpowers/specs/2026-09-13-supabase-operational-simplification-design.md \
  docs/superpowers/plans/2026-09-13-supabase-operational-simplification.md
git commit -m "docs: close operational simplification dependencies"
git rev-parse HEAD
~~~

기대 결과: commit에 문서 두 개만 포함되고 commit SHA를 coordinator에게 보고한다.

## 완료 기준

- 기준 SHA가 두 문서에 053d46326e7ecf45c02ebab9ae210ffe66624d00으로 기록되어 있다.
- retained analysis_jobs/events와 W1A artifacts/audit/cache/cost의 common evidence flag, bundle/load/retry RPC, validator, trigger, index, 20260911123000 backfill branch split이 명시되어 있다.
- account deletion은 maintenance_jobs mirror/parity/shared hash를 보존하고, account_lifecycle table/RPC/flags/callers와 flag-gated lifecycle evidence/irreversible-action guard를 이번 wave에서 no-touch retained/deferred로 둔다.
- exact-22 대신 supabase-operational-policy-v1과 retained/forbiddenW1A invariant, 기존 catalog PGlite test 갱신 범위가 정의되어 있다.
- analysis_jobs/events full-row archive가 W1A 선행 필수가 아니고 후속 preservation wave이며 W1A object non-change만 확인한다고 명시되어 있다.
- payment_events/payment_pending, analysis_provider_runs/analysis_v2_provider_runs, analysis_order_audit_assembly_queue, analysis_order_audit_bundles, analysis_order_audit_candidates, analysis_order_audit_interactions operator contract, maintenance_jobs 보존 이름이 선명하다.
- shared canonical JSON/hash, legacy notification reader, ACL/view/FK/sequence/trigger/pg_depend closure가 migration manifest에 포함되어 있다.
- code deploy, old revision drain, verified evidence, all W1A flags hard-off/removed, no-CASCADE exact allowlist 순서와 실제 0_min._.00 canary 금지가 명시되어 있다.
- 검증 범위가 기본 tsc와 관련 기존 contract test로 제한되고, 새 테스트와 광범위 CI가 금지되어 있다.
- marker scan, git diff --check, 정확한 두 파일 확인 후 commit SHA를 handoff한다.
