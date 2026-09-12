# Supabase 운영 단순화 설계 (operational policy v1)

## 문서 상태와 결정 요약

- 기준 SHA: 053d46326e7ecf45c02ebab9ae210ffe66624d00
- 기준일: 2026-09-13
- 성격: exact-22 table/set 계약을 대체하는 bounded operational contraction 설계
- 이전 planning dispatch의 작업 범위: 이 문서와 대응 plan 문서의 검토 반영만 수행했다. 코드·SQL 수정, 원격 Supabase 또는 Vercel 접근, migration apply, canary, payment 상태 mutation, 테스트 실행은 하지 않았다.

exact-22는 terminal table 수가 아니라 historical baseline으로만 남긴다. 새 목표는 active runtime과 operator contract를 보존하면서, inactive canonical shadow의 table, flag, mirror/shadow-read, 전용 RPC, backfill entry point, ACL/trigger/index 의존성을 family 단위로 닫는 것이다.

현재 aggregate가 제시한 W1A 후보 upper bound는 다음 8개다.

~~~
analysis_artifacts
analysis_audit_bundles
analysis_cache
analysis_costs
fulfillment_jobs
notification_outbox
system_configuration
system_leases
~~~

이는 8개를 반드시 제거하라는 숫자가 아니다. 적용 직전 fresh catalog와 caller/dependency evidence가 한 family라도 불충분하면 해당 family를 deferred set으로 옮긴다. 구현자는 8개를 맞추기 위해 row count, parity, dependency, operator evidence를 생략하거나 만들어내지 않는다.

### 현재 implementation package의 predeploy 경계

이 설계와 이전 planning dispatch를 실행하는 별도 implementation package는 exact contraction을 아직 작성하지 않는다. predeploy 단계의 `20260913130000_contract_supabase_operational_policy_v1.sql`은 retained `analysis_jobs`/`analysis_events`와 호환되는 validator, retry enqueue RPC, family load RPC만 additive하게 추가하며, 기존 RPC·table·function·index·trigger·ACL과 caller-controlled GUC evidence를 건드리지 않는다. 이후 code deploy, old-revision drain, fresh independent evidence, fixed exact embedded manifest/hash를 순서대로 완료한 뒤에만 W1A-only exact no-CASCADE contraction migration을 새로 작성·적용한다.

`account_lifecycle`은 W1A에서 완전히 제외한 retained/deferred family다. `account-deletion.ts`의 flag-gated lifecycle evidence와 irreversible-action guard를 대체 설계하지 않으며, account_lifecycle table/RPC/flags/callers는 이번 code/schema change에서 손대지 않는다.

다음은 W1A에서 보존하고 변경하지 않는다.

- analysis_jobs와 analysis_events: 관측 snapshot은 각각 19행과 81행이며, W1A 선행 필수 full-row archive가 아니다. W1A에서는 table, row, schema, index, FK, trigger, ACL의 보존·비변경만 확인하고, 별도 preservation wave에서 archive를 판단한다.
- payment_events와 payment_pending 계약: payment webhook/order ledger, payments, payment_orders, earlybird_orders, pending_analysis와 함께 hold한다. payment_pending을 쓰거나 보정하지 않는다.
- analysis_provider_runs와 analysis_v2_provider_runs: 0행이어도 provider admission, charge, reservation, reconciliation caller가 있으므로 active/retained다.
- maintenance_jobs: account deletion mirror, recovery, replay, rearm, cleanup, terminalization, purge, audit assembly의 operator store다.
- analysis_order_audit_assembly_queue, analysis_order_audit_bundles, analysis_order_audit_candidates, analysis_order_audit_interactions와 그 operator RPC/view/trigger contract: analysis_audit_bundles와 다른 영구 operator audit 계층이며 W1A에서 건드리지 않는다.

## 증거 기준과 분류

현재 제공된 aggregate-only snapshot은 public base tables 160개, exact-count zero-row tables 61개, pg_stat.stats_reset NULL이다. 이 숫자는 관측 snapshot일 뿐 inactivity, quiescence 또는 terminal count를 뜻하지 않는다. exact-22의 과거 숫자와 2026-09-11의 177-table snapshot은 historical baseline으로만 기록한다.

분류 규칙은 다음과 같다.

| 분류 | 포함 예시 | W1A 의미 |
| --- | --- | --- |
| active runtime | users, analysis_requests, analysis_results, analysis_preflights, analysis_pipeline_jobs, analysis_progress_state, analysis_progress_events, ai_analysis_cache, analysis_anonymous_profile_cache | source of truth로 유지 |
| retained execution | analysis_jobs, analysis_events | W1A에서 object와 contract를 그대로 유지 |
| retained provider/payment/recovery | analysis_provider_runs, analysis_v2_provider_runs, payment_events, maintenance_jobs, payments, payment_orders, earlybird_orders, pending_analysis | W1A no-touch |
| retained operator contract | analysis_order_audit_assembly_queue, analysis_order_audit_bundles, analysis_order_audit_candidates, analysis_order_audit_interactions table, 관련 parity/read/recovery RPC와 admin routes | W1A no-touch |
| W1A candidate | 위 8개 | fresh evidence를 통과한 family만 명시 allowlist로 수축 |
| deferred preservation/hold | jobs/events archive, payment_events, audit source parity, account deletion source retirement | 별도 wave |

0행은 단독 근거가 아니다. W1A 승인에는 disabled flag, active caller 부재, legacy path 독립성, direct/indirect dependency closure, operator independence, no-CASCADE allowlist가 모두 필요하다.

## exact-22 대체 계약: supabase-operational-policy-v1

기존 SUPABASE_22_CANONICAL_TABLES, expected table count, exact routine set, canonicalSetMatch를 operational policy schema/version으로 대체한다. policy는 catalog snapshot마다 다음 형태로 생성한다.

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
    "analysis_costs", "fulfillment_jobs",
    "notification_outbox", "system_configuration", "system_leases"
  ],
  "closure": {
    "tables": [],
    "routines": [],
    "flags": [],
    "indexes": [],
    "triggers": [],
    "policies": [],
    "acls": [],
    "views": [],
    "foreignKeys": [],
    "sequences": [],
    "publications": [],
    "dependencies": []
  },
  "noCascadeAllowlistHash": null
}
~~~

closure 배열은 실행 시 catalog evidence로 채우며, 빈 배열을 승인값으로 해석하지 않는다. noCascadeAllowlistHash는 exact no-CASCADE manifest를 확인한 뒤에만 채우며 null을 승인값으로 해석하지 않는다. approvedSubset은 위 8개 upper bound에서 fresh evidence가 승인한 family만 담고, 8개보다 줄어들 수 있다. policy verifier의 invariants는 다음과 같다.

1. retained와 forbiddenW1A table/routine/object는 catalog에 존재하고 pre/post checksum이 허용된 변화 외에는 같다.
2. approvedSubset에서 실제로 승인된 subset의 table과 W1A-only object만 absent가 된다.
3. forbiddenW1A object, payment_pending 상태, analysis_jobs row/schema/index/FK/ACL/trigger, analysis_events row/schema/index/FK/ACL/trigger, maintenance_jobs mirror/parity/hash는 W1A drop 또는 mutation allowlist에 절대 들어가지 않는다.
4. source caller, flag, routine, view, FK, ACL, sequence, publication, trigger, pg_depend edge가 closure에 없으면 해당 family는 deferred다.
5. fresh evidence에 따라 approvedSubset은 8개보다 작아질 수 있다. policy version이 같다고 table 수가 고정되는 것은 아니다.

기존 catalog pglite 및 contract test는 새 policy에 맞게 갱신하지만 새 test file은 만들지 않는다. 최소 갱신 범위는 lib/services/operations/supabase-22-catalog-pglite.test.ts, lib/services/operations/supabase-22-evidence.test.ts, scripts/verify-supabase-22-catalog.test.ts, scripts/generate-supabase-22-retirement-inventory.test.ts, scripts/verify-supabase-22-archive-restore.test.ts이며, 변경한 분석/commerce store의 기존 contract test만 추가로 갱신한다.

실제 repo의 archive verifier 파일은 `scripts/verify-supabase-22-archive-restore.ts`와 `scripts/verify-supabase-22-archive-restore.test.ts`다. 이 verifier는 order-audit parity의 encrypted archive/isolated restore checksum을 검증하므로 retain/update disposition으로 두고, operational-policy-v1의 schemaVersion/sourceSha/retained/forbiddenW1A/approvedSubset/closure/noCascadeAllowlistHash와 실제 retained operator table/RPC invariants를 소비하도록 갱신한다. `canonicalSetMatch`와 exact-22 count/set만 검증하는 assertion은 retire한다. 현재 repo verifier에는 order-audit archive/restore 검증이 있으므로 파일 자체를 retire하지 않는다.

## 분석 canonical 계층의 dependency closure

### 현재 공용 family와 W1A/retained split

20260909095740_add_analysis_canonical_tables.sql은 jobs, events, artifacts, costs, cache, audit를 하나의 validator, family flag, load bundle, retry marker 표면으로 묶었다. W1A는 artifacts/audit/cache/cost를 제거하지만 jobs/events는 retained하므로 공용 evidence 경계를 그대로 삭제하면 안 된다. 현재 package에서는 retained jobs/events 호환 표면을 additive predeploy migration과 code deploy로 분리하고, W1A object contraction은 old-revision drain·fresh evidence·fixed manifest/hash 이후의 별도 package로 남긴다.

| 영역 | retained analysis_jobs/events | W1A analysis_artifacts/audit/cache/cost |
| --- | --- | --- |
| Type/flag | 기존 jobs 계약 유지; 새 ANALYSIS_CANONICAL_EVENTS_READ/WRITE를 events 전용으로 분리 | ANALYSIS_CANONICAL_EVIDENCE_READ/WRITE, COST_READ/WRITE, CACHE_READ/WRITE, AUDIT_READ/WRITE는 hard-off 후 config와 source에서 제거 |
| canonical-analysis-store.ts | AnalysisCanonicalWriteFamily를 jobs/events만 허용; recordJob와 appendEvent의 validation/RPC를 유지 | appendArtifact, appendCost, appendLateCostAudit, upsertCache, appendAuditRow, loadAuditVersions와 W1A payload maps 제거 |
| canonical-analysis-read.ts | AnalysisCanonicalReadFamily와 bundle shape를 jobs/events만 허용; legacy reader/fail-open 유지 | artifacts, costs, caches, audits row parser, audit shadow-read, W1A parity path 제거 |
| bundle/load | 6-array AnalysisCanonicalReadBundle 대신 jobs/events 2-array execution bundle만 반환 | artifacts/costs/caches/audits를 포함한 기존 bundle shape를 남기지 않음 |
| retry | 새 retained-only enqueue_analysis_execution_retry_v1(UUID,TEXT)는 family를 jobs/events로 제한하고 retry marker를 analysis_events에 기록 | enqueue_analysis_canonical_retry의 evidence/cost/cache/audit branch와 W1A family allowlist 제거; compatibility wrapper로 W1A 이름을 남기지 않음 |
| SQL RPC | record_analysis_canonical_job, append_analysis_canonical_event는 retained contract | append_analysis_canonical_artifact, append_analysis_canonical_cost, upsert_analysis_canonical_cache, append_analysis_canonical_audit, append_analysis_canonical_late_cost_audit는 W1A drop allowlist |
| load RPC | 새 load_analysis_execution_family_v1(UUID,TEXT)는 jobs/events만 query | load_analysis_canonical_family(UUID,TEXT)는 W1A 6-family bundle 의존성이므로 caller를 새 RPC로 바꾼 뒤 drop |

이 split은 flag 이름만 바꾸는 작업이 아니다. source import, env read, RPC parameter, response parser, retry marker parser, payload validator, migration ACL, pg_depend edge를 함께 검증해야 한다. predeploy 단계에서는 새 retained-only validator/RPC를 추가하되 old RPC와 old-compatible writer를 drain 전까지 유지하고, exact contraction 단계에서만 fresh evidence와 fixed manifest/hash에 근거해 W1A 참조를 제거한다.

### validator와 payload closure

현재 SQL의 analysis_canonical_json_object_has_exact_keys, analysis_canonical_json_value_valid, analysis_canonical_payload_valid, analysis_canonical_payload_has_only_keys와 TypeScript의 CANONICAL_PAYLOAD_KEYS/CANONICAL_EXACT_NESTED_KEYS는 여섯 family key와 familyRows를 함께 허용한다. predeploy에서는 old validator를 변경하지 않고 retained-only 호환 validator/RPC를 additive하게 제공하며, 다음 규칙을 exact contraction 이후의 retained contract에 적용한다.

- retained execution validator는 jobs payload와 events payload, operational retry payload만 허용한다. jobs의 job state/generation/attempt/dependency/completionHash와 events의 kind/state/contentHash/timestamp 검증은 유지한다.
- W1A 전용 artifacts, costs, caches, audits row shape와 late-cost idempotency/audit version 검증은 제거한다. familyRows의 artifacts/costs/caches/audits key와 그 nested exact-key branch도 제거한다.
- analysis_jobs의 기존 payload constraint와 20260911123000이 추가한 source/sourceHash provenance는 W1A에서 축소하지 않는다. jobs/events 보존 wave가 별도로 결정할 때까지 current retained constraint와 index를 비변경으로 보존한다.
- 공용 hash/timestamp/scalar validator가 jobs/events에서 필요하면 retained-only 이름 또는 retained-only implementation으로 남긴다. W1A key를 허용하는 generic validator를 남긴 채 table만 drop하지 않는다.

### trigger와 index closure

20260909095740의 reject_analysis_canonical_mutation은 events, costs, audit trigger에 공유된다. W1A에서 function을 무심코 삭제하면 retained events append-only 보호가 깨지므로 다음처럼 분리한다.

- retained: analysis_events_append_only와 전용 reject_analysis_event_mutation 또는 동등한 retained-only trigger function.
- W1A drop: analysis_costs_append_only, analysis_audit_bundles_append_only와 그 전용 trigger function dependency.
- retained index: analysis_jobs_dispatch_idx, analysis_events_request_created_idx, analysis_events_retry_key_idx.
- W1A drop: analysis_artifacts_request_kind_idx, analysis_costs_request_recorded_idx, analysis_costs_request_idempotency_idx, analysis_cache_expiry_idx, analysis_cache_request_updated_idx, analysis_audit_request_version_idx, analysis_audit_request_idempotency_idx.
- 20260911123000의 analysis_events_backfill_copy_key_idx는 analysis_events 보존 wave가 소유하는 deferred index다. W1A에서는 index를 drop하거나 rebuild하지 않고, pre/post catalog에서 동일함을 확인한다.

### 20260911123000 backfill branch

20260911123000_add_analysis_canonical_backfill_apply.sql의 dependency를 branch 단위로 기록한다.

1. analysis_jobs payload constraint 확장, analysis_events backfill copy index, jobs/events source mapping은 retained execution preservation wave의 deferred evidence다. W1A에서 full-row archive나 backfill을 실행하지 않고 object non-change만 확인한다.
2. append_analysis_canonical_artifact 재정의는 W1A artifact fence이므로 W1A contraction에서 더 이상 호출·grant·dependency를 남기지 않는다.
3. apply_analysis_canonical_backfill_row(TEXT,TEXT,TEXT,TEXT,TEXT,UUID,JSONB)의 jobs/events/artifacts/costs 단일 branch RPC는 W1A에서 실행하지 않는다. source와 DB caller count가 0이고 old revision drain·fresh evidence·fixed exact manifest/hash가 모두 끝난 뒤에만 W1A contraction migration이 old multi-family function을 exact signature로 no-CASCADE drop한다. artifact/cost branch를 제거한 retained-only preservation RPC는 별도 wave에서 새로 설계하며, 기존 multi-family RPC를 compatibility wrapper로 남기지 않는다.
4. 20260911100000_grant_wave1_backfill_projection_select.sql의 analysis_artifacts와 analysis_costs column-level grant 및 관련 backfill caller는 W1A closure에서 제거한다. analysis_jobs와 analysis_events grant/index/constraint는 retained object로 유지한다.

따라서 analysis_jobs/events full-row archive는 W1A의 선행 조건이 아니다. 후속 preservation wave에서 consistent snapshot, full-row archive, row-level checksum, PK/reference manifest를 독립적으로 수행하고, 그 결과가 없다는 이유로 W1A에서 jobs/events를 drop하지 않는다.

### W1A backfill entry-point disposition

`scripts/backfill-analysis-canonical.ts`는 abandoned exact-22 multi-family backfill entry point이므로 W1A code deploy에서 retire/delete하고 `scripts/backfill-analysis-canonical.test.ts`도 함께 정리한다. `package.json`의 해당 script alias(현재 repo에는 없음), production import(현재 없음), 그리고 다음 docs caller의 runnable command/reference를 제거하거나 retired historical note로 바꾼다: `docs/reports/2026-09-11-supabase-22-final-convergence-inventory.json`, `docs/reports/2026-09-11-supabase-22-wave1-production-readonly-evidence.md`, `docs/superpowers/plans/2026-09-09-supabase-22-table-analysis-canonicalization.md`, `docs/superpowers/plans/2026-09-09-supabase-22-table-master.md`, `docs/superpowers/plans/2026-09-11-supabase-22-final-convergence.md`.

`scripts/backfill-commerce-operations-canonical.ts`는 fulfillment/notification/config/lease 등 W1A family를 함께 노출하는 old multi-family entry point이므로 W1A code deploy에서 retire/delete하고 `scripts/backfill-commerce-operations-canonical.test.ts` 및 package/import/docs caller를 함께 정리한다. commerce docs caller는 `docs/reports/2026-09-09-supabase-22-commerce-operations-evidence.md`, `docs/reports/2026-09-10-supabase-22-next-retirement-candidates.json`, `docs/reports/2026-09-11-supabase-22-final-convergence-inventory.json`, `docs/superpowers/plans/2026-09-09-supabase-22-table-commerce-operations-canonicalization.md`, `docs/superpowers/plans/2026-09-09-supabase-22-table-master.md`, `docs/superpowers/plans/2026-09-11-supabase-22-final-convergence.md`이며 historical evidence는 실행 가능한 caller가 아니도록 disposition을 기록한다. account_lifecycle caller는 삭제하지 않고 no-touch로 유지한다.

`scripts/backfill-account-deletion-canonical.ts`, `scripts/backfill-account-deletion-canonical.test.ts`, `lib/services/identity/account-deletion-canonical-pglite.test.ts`의 import/test와 `backfill_account_deletion_jobs_v1`/`collect_account_deletion_parity_v1` maintenance parity는 보존한다. 이 dedicated account-deletion/maintenance parity path와 `canonicalJsonHash`, `canonicalEvidenceHash`, `canonical_json_string_v1`, `canonical_json_number_v1`, `canonical_json_v1`, `canonical_json_hash_v1` shared hash는 W1A backfill retire에 포함하지 않는다. W1A에서는 retained jobs/events용 새 backfill script/RPC를 만들지 않는다.

## commerce와 account deletion dependency closure

### W1A commerce family

W1A commerce target은 fulfillment_jobs, notification_outbox, system_configuration, system_leases다. 각 table의 table, RLS/force RLS, relation ACL, FK, partial index, sequence, trigger, service RPC, source flag, shadow comparator, backfill script를 하나의 allowlist로 닫는다. account_lifecycle은 retained/deferred이며 table/RPC/flags/callers를 이번 code/schema change에서 손대지 않는다.

- fulfillment_jobs: upsert_fulfillment_job_v1, fulfillment dual-write/fallback, fulfillment recovery index를 W1A-only로 제거한다. earlybird legacy fulfillment/order RPC와 earlybird_orders는 유지한다.
- notification_outbox: enqueue_notification_v1, claim_notification_outbox_v1, finish_notification_outbox_v1, reconcile_stale_notification_outbox_v1, list_notification_outbox_v1, shadowReadCanonicalNotificationOutbox와 notification read/write flags를 함께 제거한다. list_notification_legacy_outbox_v1은 canonical parity 전용 legacy reader이므로 source caller를 먼저 제거한 뒤 canonical reader와 함께 W1A manifest의 exact drop list에 넣는다. 세 legacy outbox table, enqueue/delivery route, idempotency/retry는 유지한다.
- system_configuration: record_system_configuration_v1, canonical_system_configuration_json가 W1A-only인지 caller inventory로 확인하고, 전용 flag/index/trigger를 제거한다. shared canonical_json_*와 payment/maintenance caller는 유지한다.
- system_leases: acquire_system_lease_v1와 lease family flag/index를 제거한다. provider/admission runtime lease가 실제로 이 table을 사용한다는 fresh evidence가 있으면 family 전체를 deferred로 이동한다.

### account deletion과 account_lifecycle은 no-touch

account_lifecycle은 W1A에서 완전히 제외한다. account-deletion.ts의 flag-gated lifecycle evidence와 irreversible-action guard 대체는 별도 deferred design으로 이동하며, 이번 wave에는 account_lifecycle table, account_lifecycle_account_recorded_idx, account_lifecycle_immutable trigger, append_account_lifecycle_v1, account lifecycle flags, account-principal/account-deletion callers에 대한 code/schema change가 없다. account deletion 정리는 다음 mirror/parity/shared hash를 보존하는 것을 전제로 한다.

- 유지 table/source: maintenance_jobs, account_deletion_jobs와 maintenance_jobs_recovery_idx. maintenance_jobs의 kind, target_key_hash, content_hash, payload, lease_generation, retry/blocked 상태를 보존한다.
- 유지 RPC: mirror_account_deletion_job_v1, enqueue_maintenance_job_v1, claim_maintenance_jobs_v1, finish_maintenance_job_v1, reconcile_stale_maintenance_jobs_v1, backfill_account_deletion_jobs_v1, collect_account_deletion_parity_v1.
- 유지 source contract: account-deletion-maintenance mirror/recovery adapter, source_key_hash, legacy_state, target_key_hash, content_hash와 parity schema/checksum. account-deletion source를 maintenance mirror/parity와 함께 retire하는 별도 evidence 없이는 제거하지 않는다.
- 유지 hash contract: SQL canonical_json_string_v1, canonical_json_number_v1, canonical_json_v1, canonical_json_hash_v1와 TypeScript canonicalJsonHash, canonicalEvidenceHash. account deletion과 payment/maintenance가 공유하므로 canonical-commerce-store 전체를 account_lifecycle no-touch decision과 함께 제거하지 않는다.
- no-touch 대상: account_lifecycle table, account_lifecycle_account_recorded_idx, account_lifecycle_immutable trigger, append_account_lifecycle_v1, account lifecycle read/write flag, account-principal/account-deletion callers. account_deletion.ts의 flag-gated lifecycle evidence, begin/finalize/complete source RPC, maintenance mirror/recovery branch, irreversible-action guard는 그대로 유지한다.

### 보존 operator contract

다음 이름과 contract는 W1A approvedSubset의 analysis_audit_bundles shadow table과 혼동하지 않는다. `analysis_audit_bundles`는 analysis canonical shadow table이고, `analysis_order_audit_bundles`는 아래 permanent operator audit table이다.

- tables: analysis_order_audit_assembly_queue, analysis_order_audit_bundles, analysis_order_audit_candidates, analysis_order_audit_interactions
- operator RPC: load_analysis_order_audit_bundle, list_analysis_order_audit_bundles, list_analysis_order_audit_bundle_recovery, claim_analysis_order_audit_bundle, release_analysis_order_audit_bundle, enqueue_analysis_order_audit_bundle, assemble_analysis_order_audit_bundle, read_analysis_order_audit_parity_snapshot
- shared audit functions/triggers: analysis_order_audit_digest, analysis_order_audit_redact_json, analysis_order_audit_bundle_payload, analysis_order_audit_parity_attestation_is_safe, analysis_order_audit_candidate_key_coverage, analysis_order_audit_cost_source_hash, analysis_order_audit_source_table_hash, analysis_order_audit_purge_fence, analysis_order_audit_summary_counts, analysis_order_audit_retention_payload, analysis_order_audit_enqueue_from_request, analysis_order_audit_enqueue_from_request_id, prevent_analysis_order_audit_bundle_mutation, prevent_analysis_order_audit_candidate_mutation, prevent_analysis_order_audit_interaction_mutation, enqueue_analysis_order_audit_after_request_finalization, enqueue_analysis_order_audit_after_result_summary, enqueue_analysis_order_audit_after_cost_snapshot, enqueue_analysis_order_audit_after_cost_attribution, capture_analysis_order_audit_parity_attestation_after_completion
- routes: admin order-audit, admin analysis-audit, analysis observability projection과 관련 legacy RPC/view

이 operator 계층은 실제 completed bundle/parity evidence가 없으면 retire할 수 없다. 실제 0_min._.00 canary나 synthetic bundle은 genuine production evidence로 인정하지 않는다.

## W1A, 보존 wave, hold

### W1A

W1A는 fresh evidence가 승인한 subset에 한해 다음 8개 upper-bound 후보와 W1A-only dependencies만 수축한다. account_lifecycle은 retained/deferred no-touch다. analysis_jobs/events full-row archive, provider/payment/operator audit/maintenance deletion, active V2 source backfill은 W1A 선행 작업이 아니다.

W1A에서 허용하는 schema change는 explicit no-CASCADE allowlist뿐이다. table, W1A-only routine, W1A-only index, W1A-only trigger, W1A-only policy/ACL, W1A-only sequence, W1A-only view와 그 pg_depend/FK edge를 exact manifest로 열거한다. allowlist 밖 object가 drop되거나 retained object에 DDL/DML이 발생하면 즉시 중단한다.

### preservation wave

후속 preservation wave는 analysis_jobs와 analysis_events만 별도 대상으로 한다. consistent snapshot, full-row encrypted archive, row checksum, PK uniqueness, column/type/default, FK/reference manifest, source SHA와 migration history를 기록한 뒤 archive parity를 판단한다. 이 wave는 W1A의 성공 조건이나 W1A migration precondition으로 사용하지 않는다.

### payment/audit hold

payment_events, payment_pending, payments, payment_orders, earlybird_orders, pending_analysis 및 payment/order webhook contract는 hold다. analysis_provider_runs와 analysis_v2_provider_runs, analysis_order_audit_assembly_queue, analysis_order_audit_bundles, analysis_order_audit_candidates, analysis_order_audit_interactions operator contract, maintenance_jobs, account_lifecycle도 hold/retained다. 독립 evidence 없이 row count가 0이라는 이유로 이 대상을 변경하지 않는다.

## 적용 순서와 evidence gate

적용 순서는 고정한다.

1. predeploy additive compatibility migration: retained jobs/events validator와 compatibility RPC를 추가하고 기존 RPC·table·function·index·trigger·ACL을 보존한다. caller-controlled GUC evidence는 허용하지 않는다.
2. code deploy: legacy source path가 authoritative이고 W1A mirror/shadow caller가 제거된 revision을 배포한다. old-compatible event writer는 old revision drain 전까지 수용한다.
3. old revision drain: Vercel/worker의 이전 revision을 drain하고, in-flight request/job/queue가 끝나며 old revision이 W1A RPC/flag를 더 이상 호출하지 않는 증거를 수집한다.
4. verified evidence and fixed manifest/hash: drain 이후 fresh independent catalog/traffic evidence, source caller, migration history, flag/config, row/checksum, exact routine signature/SECURITY DEFINER/`search_path`/ACL, full operator-audit contract, typed `payment_pending` read-only counts/checksum, revision/window/drain, view/FK/sequence/publication/trigger/pg_depend manifest를 같은 observation window에서 검증하고 exact embedded no-CASCADE manifest/hash를 고정한다.
5. W1A flags hard-off and removal: 위 evidence와 fixed manifest/hash가 ready일 때만 analysis W1A flags와 commerce W1A flags를 false/hard-off로 고정하고 code/config/RPC manifest에서 제거한다. account lifecycle flags/callers는 no-touch retained/deferred이며, retained jobs/events, maintenance, payment hold flags는 별도 retained policy로 남긴다.
6. schema contraction: 위 조건을 모두 통과한 뒤에만 exact no-CASCADE allowlist migration을 새로 작성·적용한다. old migration file을 수정하지 않으며, DROP ... CASCADE를 사용하지 않는다.

W1A flag 목록은 다음과 같다.

- analysis: ANALYSIS_CANONICAL_EVIDENCE_READ, ANALYSIS_CANONICAL_EVIDENCE_WRITE, ANALYSIS_CANONICAL_COST_READ, ANALYSIS_CANONICAL_COST_WRITE, ANALYSIS_CANONICAL_CACHE_READ, ANALYSIS_CANONICAL_CACHE_WRITE, ANALYSIS_CANONICAL_AUDIT_READ, ANALYSIS_CANONICAL_AUDIT_WRITE
- commerce: COMMERCE_CANONICAL_FULFILLMENT_READ, COMMERCE_CANONICAL_FULFILLMENT_WRITE, COMMERCE_CANONICAL_NOTIFICATION_READ, COMMERCE_CANONICAL_NOTIFICATION_WRITE, COMMERCE_CANONICAL_CONFIG_READ, COMMERCE_CANONICAL_CONFIG_WRITE, COMMERCE_CANONICAL_LEASE_READ, COMMERCE_CANONICAL_LEASE_WRITE

ANALYSIS_CANONICAL_JOBS_*와 새 ANALYSIS_CANONICAL_EVENTS_*, COMMERCE_CANONICAL_MAINTENANCE_*와 account lifecycle/payment hold flags는 W1A 제거 목록에 넣지 않는다. payment flags는 계속 hard-off일 수 있으나 payment contract와 함께 별도 hold로 관리한다.

중단 조건은 nonzero/mismatch/checksum failure, active caller, enabled flag, unclosed pg_depend/FK/view/ACL/trigger/sequence/publication, legacy/operator contract failure, old revision drain failure, unexpected object mutation, migration history mismatch다.

## migration manifest closure

contraction migration manifest에는 아래 항목을 모두 포함한다.

1. W1A table exact allowlist와 각 table의 PK/unique/check/default, RLS/force RLS, relation ACL, column grant/revoke.
2. W1A routine exact names, argument signatures, SECURITY DEFINER/search_path/EXECUTE ACL, caller source와 reverse dependency.
3. retained/W1A flag names와 deploy config source, old revision에서의 마지막 observation.
4. retained analysis_jobs/events index와 deferred backfill index, W1A index exact names 및 partial predicate.
5. retained events append-only trigger와 W1A cost/audit/config trigger를 분리한 trigger function dependency. account_lifecycle trigger/function은 retained/deferred no-touch로 manifest에 남긴다.
6. W1A table의 analysis_requests, analysis_jobs, earlybird_orders, users FK와 retained table FK를 구분한 FK closure.
7. identity/serial sequence, publication/subscription, partition, view/materialized view, row policy, ACL, trigger, pg_depend edge와 ownership.
8. shared canonical JSON/hash: canonical_json_string_v1, canonical_json_number_v1, canonical_json_v1, canonical_json_hash_v1, canonicalJsonHash, canonicalEvidenceHash. payment/maintenance/account-deletion parity caller가 남아 있으면 이 objects를 W1A에서 drop하지 않는다.
9. legacy notification reader list_notification_legacy_outbox_v1의 source caller와 disposition, canonical notification reader list_notification_outbox_v1의 paired disposition. legacy delivery table/route를 shadow reader와 혼동하지 않는다.
10. 20260909095740_add_analysis_canonical_tables.sql과 20260911123000_add_analysis_canonical_backfill_apply.sql의 immutable history, 20260911100000의 column grants, 새 contraction migration의 exact allowlist. historical migration을 overwrite하지 않는다.

각 drop는 대상 object 이름과 signature를 직접 적고, catalog에서 동일 object가 실제로 존재하는지 preflight한다. no-CASCADE로 실패하면 migration을 반복하거나 broad drop으로 우회하지 않는다.

## 검증 범위와 금지 사항

후속 구현의 기본 검증은 다음 두 종류뿐이다.

- npx tsc --noEmit --pretty false
- 변경한 기존 contract/pglite test만 targeted run. 대표 범위는 canonical-analysis-store/read/pglite, canonical-operations-store, canonical-commerce-store/pglite, supabase-22-catalog-pglite, supabase-22-evidence, verify-supabase-22-catalog, generate-supabase-22-retirement-inventory의 기존 파일이다.

새 test file, 광범위 test suite, full CI, production/Supabase/Vercel 접근은 금지한다. 이 문서 작업에서는 위 검증도 실행하지 않고 marker scan, git diff --check, 변경 파일 정확히 두 개 확인만 수행한다. 실제 0_min._.00 canary, synthetic canary, fake production bundle은 실행하거나 evidence로 사용하지 않는다.

## 현재 작업의 산출물 경계

현재 dispatch에서 수정 가능한 파일은 다음 두 개뿐이다.

- docs/superpowers/specs/2026-09-13-supabase-operational-simplification-design.md
- docs/superpowers/plans/2026-09-13-supabase-operational-simplification.md

현재 작업은 code/SQL implementation이나 migration apply를 포함하지 않는다. 후속 구현은 기존 migration history를 보존하고, 위 dependency closure와 operational policy v1을 먼저 code review한 뒤에만 별도 branch에서 수행한다.

## 근거 파일

- canonical analysis schema: supabase/migrations/20260909095740_add_analysis_canonical_tables.sql
- analysis backfill/apply: supabase/migrations/20260911123000_add_analysis_canonical_backfill_apply.sql
- backfill grants: supabase/migrations/20260911100000_grant_wave1_backfill_projection_select.sql
- commerce/operations schema: supabase/migrations/20260909095932_add_commerce_operation_canonical_tables.sql
- account deletion mirror/parity: supabase/migrations/20260910020205_prepare_account_deletion_canonical_wave.sql, supabase/migrations/20260910035257_add_account_deletion_backfill_parity.sql
- analysis adapters: lib/services/analysis/canonical-analysis-store.ts, lib/services/analysis/canonical-analysis-read.ts
- operations/hash adapters: lib/services/operations/canonical-operations-store.ts, lib/services/commerce/canonical-commerce-store.ts
- account deletion: lib/services/identity/account-deletion.ts, lib/services/identity/account-deletion-canonical-adapter.ts
- policy/catalog: lib/services/operations/supabase-22-evidence.ts, scripts/generate-supabase-22-retirement-inventory.ts, scripts/verify-supabase-22-catalog.ts
- operator audit contract: supabase/migrations/20260904130000_add_permanent_order_audit_bundle.sql, supabase/migrations/20260905100000_add_operator_console_audit_projection.sql, supabase/migrations/20260905110000_add_order_audit_consolidation_readiness.sql
