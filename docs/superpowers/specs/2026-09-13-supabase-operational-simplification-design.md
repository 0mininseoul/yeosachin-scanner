# Supabase 운영 단순화 설계 (exact-22 재검토)

## 문서 상태와 결정 요약

- 기준 커밋: `origin/main` `2cd1312f`
- 기준일: 2026-09-13
- 성격: 기존 owner-approved exact-22 설계를 대체하는 운영 단순화 제안
- 현재 작업 범위: 저장소와 기존 보고서의 문서 감사만 수행한다. 원격 Supabase 조회, migration 적용, table drop, flag activation, canary, `payment_pending` 변경은 하지 않는다.

결론은 **모든 active V2 테이블을 inactive canonical shadow 계층으로 옮기지 않고, 실제 런타임 경로가 사용하지 않는 canonical shadow family를 철거하는 것**이다. exact-22를 유지하는 것이 목표가 아니며, 목표는 서비스 계약을 보존하면서 테이블, RPC, flag, dual-write/shadow-read 분기, 복구·검증 표면을 함께 줄이는 것이다.

현재 기준의 첫 번째 적용 후보는 다음 9개다.

```text
account_lifecycle
analysis_artifacts
analysis_audit_bundles
analysis_cache
analysis_costs
fulfillment_jobs
notification_outbox
system_configuration
system_leases
```

`payment_events`는 현재 exact-zero인 shadow 후보이지만 결제 민감도가 높으므로 첫 적용 allowlist에서 분리한다. `analysis_jobs`(19행), `analysis_events`(81행)는 보존·아카이브·체크섬을 먼저 통과해야 하며 첫 wave에서 삭제하지 않는다. `analysis_provider_runs`는 현재 aggregate가 0행이어도 소스의 active provider admission/charge 경로가 직접 사용하므로 보존한다. `maintenance_jobs`는 operator recovery/archive store이므로 보존한다. 실제 적용 allowlist는 아래 증거 게이트를 다시 통과한 뒤에만 확정한다.

## 현재 증거의 기준

### 최신 aggregate와 해석 범위

coordinator가 제공한 2026-09-13 Supabase CLI 2.102.0 aggregate-only inventory를 현재 운영 스냅샷으로 사용한다.

| 지표 | 현재 스냅샷 | 해석 |
| --- | ---: | --- |
| `public` base tables | 160 | 현재 카탈로그의 관측값일 뿐 terminal count 목표가 아니다. |
| exact-count zero-row tables | 61 | 0행만으로 inactive 또는 drop-safe라고 결론내리지 않는다. |
| `pg_stat` `stats_reset` | `NULL` | 통계 counter와 inactivity를 quiescence 증거로 사용하지 않는다. |
| canonical/shadow 조사 집합 | 13개 | 11개 zero-row와 `analysis_jobs`/`analysis_events`의 nonzero를 포함한 기존 후보 집합이다. |

canonical/shadow 조사 집합의 현재 집계는 다음과 같다.

| 이름 | 관측 행 수 | 이번 설계의 분류 |
| --- | ---: | --- |
| `account_lifecycle` | 0 | 첫 wave 후보 |
| `analysis_artifacts` | 0 | 첫 wave 후보 |
| `analysis_audit_bundles` | 0 | 첫 wave 후보 |
| `analysis_cache` | 0 | 첫 wave 후보 |
| `analysis_costs` | 0 | 첫 wave 후보 |
| `analysis_provider_runs` | 0 | active runtime caller가 있어 보존 |
| `fulfillment_jobs` | 0 | 첫 wave 후보 |
| `notification_outbox` | 0 | 첫 wave 후보 |
| `payment_events` | 0 | payment-sensitive hold |
| `system_configuration` | 0 | 첫 wave 후보 |
| `system_leases` | 0 | 첫 wave 후보 |
| `analysis_jobs` | 19 | 보존/아카이브 wave로 분리 |
| `analysis_events` | 81 | 보존/아카이브 wave로 분리 |

동일 aggregate에서 관찰된 active 데이터는 `users` 482, `landing_leads` 5,698, `result_feedback` 1, `earlybird_waitlist` 39, `earlybird_orders` 159, `analysis_requests` 209, `analysis_results` 1,566, `analysis_preflights` 315, `analysis_pipeline_jobs` 1,294, `analysis_progress_state` 118, `analysis_progress_events` 359이다. 이는 legacy V2와 제품 운영 경로가 아직 살아 있다는 증거로 사용하며, 해당 테이블을 canonical shadow로 옮기는 근거로 사용하지 않는다.

이 문서의 수치는 snapshot이다. 문서나 구현은 최종 table 수를 약속하지 않고, 적용 직전의 fresh catalog와 dependency evidence로 allowlist를 재계산한다. 기존 2026-09-11 보고서의 177-table snapshot 및 exact-22 숫자는 역사적 baseline으로만 취급한다.

### 소스 코드가 보여주는 현재 계약

- `lib/services/analysis/canonical-analysis-read.ts`는 family read flag가 꺼져 있으면 legacy 결과를 반환하고, canonical 오류나 mismatch도 legacy로 fail-open한다.
- `lib/services/analysis/canonical-analysis-store.ts`의 write는 `analysisCanonicalWriteEnabled`가 꺼져 있으면 disabled 상태를 반환한다.
- `lib/services/analysis/v2-worker.ts`와 `lib/services/analysis/v2-progress-reporter.ts`의 canonical job/event 기록은 legacy 완료·checkpoint 뒤의 best-effort mirror다.
- `lib/services/analysis/provider-cost-reconciliation.ts`의 canonical cost/audit mirror는 legacy settlement을 authoritative로 둔 flag-gated 경로다.
- `lib/services/analysis/v2-result-store.ts`의 audit shadow-read도 default-off이며, result page의 legacy 결과 경로가 본체다.
- `lib/services/operations/canonical-operations-store.ts`에는 payment, fulfillment, notification, account, config, lease, maintenance family flag와 shadow helper가 함께 있다. `maintenance_jobs` 관련 claim/finish/reconcile 및 archive 경로는 active recovery 계약이므로 별도로 남긴다.
- `app/api/webhooks/groble/route.ts`, `lib/services/earlybird/fulfillment-store.ts`, `lib/services/earlybird/payment-discord.ts`, `lib/services/identity/kakao-signup-discord.ts`, `lib/services/sentry-discord-alert.ts`, `lib/services/identity/account-principal-store.ts`, `lib/services/identity/account-deletion.ts`는 각 canonical mirror가 flag-gated임을 보여준다. mirror를 제거해도 legacy payment, fulfillment, notification, account 경로는 유지해야 한다.
- `app/api/internal/earlybird-payment-discord-outbox/route.ts`, `app/api/internal/kakao-signup-discord-outbox/route.ts`, `app/api/internal/sentry-discord-alert-outbox/route.ts`는 canonical notification shadow-read가 켜진 경우에만 호출하고 legacy outbox delivery를 수행한다.
- `app/api/admin/analysis-observability/route.ts`, `app/api/admin/order-audit/route.ts`, `app/api/admin/analysis-audit/route.ts`, `app/api/admin/landing-leads/route.ts`는 active projection/RPC와 legacy 운영 데이터를 사용한다. operator dashboard를 canonical shadow에 연결하거나 새 admin table을 만들지 않는다.

### 기존 설계·보고서의 경계

- `docs/superpowers/specs/2026-09-09-supabase-22-table-consolidation-design.md`와 `docs/superpowers/plans/2026-09-11-supabase-22-final-convergence.md`는 exact-22 목표의 owner-approved baseline이다. 이 문서는 그 목표를 운영 단순화 KPI로 재정의한다.
- `docs/reports/2026-09-09-supabase-22-analysis-canonical-evidence.md`는 analysis canonical 6개가 additive이고 관련 flags가 default-off이며 legacy path가 authoritative임을 기록한다.
- `docs/reports/2026-09-09-supabase-22-commerce-operations-evidence.md`는 commerce canonical 7개가 additive이고 read/write flags가 default-off이며 legacy payment/fulfillment/account/notification이 authoritative임을 기록한다.
- `docs/reports/2026-09-11-supabase-22-wave1-production-readonly-evidence.md`는 canonical parity/cutover가 완료되지 않았고 source/canonical parity가 missing/permission 경계에 막혔음을 기록한다. 이는 active source를 shadow로 이관할 근거가 아니다.
- `docs/reports/2026-09-12-supabase-22-pending-analysis-retirement-evidence.md`, `docs/reports/2026-09-12-supabase-22-historical-legacy-dispatch-empty-payment-retirement-evidence.md`, `docs/reports/2026-09-12-earlybird-receipt-cutover-evidence.md`는 review-only/미적용 경계로 취급한다. 이 문서는 해당 migration이 production에 적용되었다고 주장하지 않는다.

## 운영 분류와 보존 원칙

| 분류 | 예시 | 원칙 | 이번 문서에서의 조치 |
| --- | --- | --- | --- |
| active runtime table | `users`, `analysis_requests`, `analysis_results`, `analysis_pipeline_jobs`, `analysis_progress_state`, `analysis_progress_events`, `analysis_provider_runs`, `ai_analysis_cache`, `analysis_anonymous_profile_cache` | 현재 서비스 caller와 request/result/worker 계약을 우선한다. row count가 0이어도 caller가 있으면 active다. | canonical로 이관하지 않고 유지한다. |
| inactive canonical shadow table | `analysis_artifacts`, `analysis_audit_bundles`, `analysis_cache`, `analysis_costs`, `account_lifecycle`, `fulfillment_jobs`, `notification_outbox`, `system_configuration`, `system_leases`, 조건부 `payment_events` | default-off flag, active caller 부재, independent legacy path, dependency-free가 모두 입증되어야 retire한다. | 9개를 W1A 후보로, `payment_events`를 W1B hold로 둔다. |
| transitional canonical data | `analysis_jobs`, `analysis_events` | nonzero data 또는 worker mirror 흔적이 있으므로 보존과 checksum이 우선이다. | 19/81행을 full-row archive/checksum 후 별도 wave에서 판단한다. 첫 wave drop 금지. |
| historical/recovery table | `maintenance_jobs`, `payment_orders`, `payments`, `pending_analysis`, historical dispatch sources, `supabase/operations/20260911_restore_*`, `supabase/operations/20260912_restore_*` | 복구 가능성과 payment/order 상태 보존이 우선이다. | `maintenance_jobs`와 recovery artifacts를 유지하고 첫 wave에서 건드리지 않는다. |
| operator-facing projection | analysis observability, order audit, score audit, landing-lead admin routes와 그 active RPC/view | 사람이 보는 운영 계약은 active source에 남긴다. canonical shadow를 새 운영 화면의 prerequisite로 만들지 않는다. | 기존 admin routes를 보존하고 pre/post read smoke로 검증한다. |

특히 `analysis_provider_runs`는 aggregate가 0이어도 `lib/services/analysis/provider-run.ts`의 admission/charge 경로가 직접 참조한다. `maintenance_jobs`는 account deletion 및 recovery adapter가 참조한다. 따라서 이 둘은 0행 또는 canonical 소속이라는 이유만으로 W1A에 넣을 수 없다.

## 접근 방식 비교

| 접근 | 내용 | 장점 | 비용·위험 | 판정 |
| --- | --- | --- | --- | --- |
| A. exact-22 전면 수렴 | active V2와 commerce source를 canonical 22개로 이관하고 backfill, dual-write, shadow-read, cutover를 완료한다. | 장기적으로 한 canonical contract를 만들 수 있고 표면적 명칭이 단순하다. | 현재 parity가 완결되지 않았고, active source와 canonical을 동시에 운영해야 한다. RPC·flag·backfill·rollback 표면이 커지며 서비스 경로를 중복화한다. 0행인 `analysis_provider_runs`도 잘못 분류할 위험이 있다. | 운영 단순화 목표와 불일치. 채택하지 않는다. |
| B. hybrid shadow 유지 | inactive shadow를 유지하되 proven family만 점진적으로 canonicalize하고 나머지는 계속 default-off로 둔다. | 즉시 drop이 없어 schema 위험이 낮고, 향후 cutover 선택권을 남긴다. | 22개 계층, family flag, mirror helper, RPC와 migration/restore 계약을 장기간 유지한다. 실제 요청/운영 흐름이 줄지 않는다. | 현재 단계의 단순화 효과가 부족하다. |
| C. inactive shadow 우선 철거 | legacy V2와 active projection을 source of truth로 유지하고, 실제 caller가 없는 inactive shadow family만 family 단위로 제거한다. nonzero canonical jobs/events와 recovery/payment 계층은 별도 보존 wave로 둔다. | 테이블뿐 아니라 flag, mirror, shadow-read, family RPC, backfill entry point를 함께 제거할 수 있다. 현재 default-off/fail-open 계약을 유지하여 서비스 경로 변경을 작게 만든다. | exact-22 숫자를 포기하고 fresh dependency/traffic/archive 증거가 필요하다. 일부 family는 payment·복구 때문에 후순위다. | **권고. 운영 단순화 KPI와 현재 증거에 가장 잘 맞는다.** |

### 권고안의 수렴 규칙

1. table count는 결과 지표이고 목표값이 아니다. KPI는 제거된 runtime branch, family flag, canonical-only RPC, compatibility path, migration/restore surface의 수와 활성 서비스 계약 보존이다.
2. 한 family의 table만 지우지 않는다. 그 family의 application caller, read/write flag, shadow comparator, backfill/verify entry point, 전용 RPC, RLS/policy/trigger/index를 같은 change set에서 닫는다.
3. 공용 `canonicalJsonHash`/`canonicalEvidenceHash`가 `maintenance_jobs`와 account recovery에서 쓰이면 `lib/services/commerce/canonical-commerce-store.ts` 전체를 제거하지 않는다. payment/notification mirror 부분만 떼고 공용 hash/recovery helper는 남긴다.
4. 과거 migration 파일은 migration history integrity를 위해 삭제하거나 덮어쓰지 않는다. 새 contraction migration과 격리된 restore operation으로 후속 변경을 표현한다.
5. 적용 전 evidence가 하나라도 불충족이면 해당 table/family를 deferred set으로 이동하고 다음 wave로 넘긴다. 정확한 terminal table 수는 선언하지 않는다.

## 첫 bounded wave

### W1A 적용 allowlist

W1A는 다음 9개 table과 그것을 독점적으로 지탱하는 shadow code/RPC/flag만 대상으로 한다.

| family | table | 현재 보이는 안전성 근거 | 남겨야 하는 legacy/active 계약 |
| --- | --- | --- | --- |
| analysis | `analysis_artifacts` | aggregate 0; canonical artifact write가 default-off이고 legacy result/evidence가 authoritative | result store, active evidence/projection |
| analysis | `analysis_audit_bundles` | aggregate 0; audit shadow-read가 default-off/fail-open | active score/order audit route와 legacy audit sources |
| analysis | `analysis_cache` | aggregate 0; canonical cache family는 optional | `ai_analysis_cache`, `analysis_anonymous_profile_cache`, legacy cache callers |
| analysis | `analysis_costs` | aggregate 0; provider cost mirror는 legacy settlement 뒤 best-effort | provider-run admission/charge와 legacy cost ledger |
| commerce | `account_lifecycle` | aggregate 0; principal mirror가 write flag-gated | user/account deletion source path와 `maintenance_jobs` recovery |
| commerce | `fulfillment_jobs` | aggregate 0; fulfillment canonical dual-write default-off | earlybird legacy fulfillment/order path |
| commerce | `notification_outbox` | aggregate 0; internal outbox route의 canonical read/mirror가 flag-gated | 세 legacy notification outbox delivery route |
| commerce | `system_configuration` | aggregate 0; canonical config write/read flag-gated | 현재 configuration source/callers, migration history |
| commerce | `system_leases` | aggregate 0; canonical lease family가 optional | 현재 worker/admission lease 경로 및 active provider-run 계약 |

이 표는 적용 승인서가 아니다. 동일 이름의 행 수가 현재 aggregate와 달라지거나 caller/dependency가 발견되면 W1A에서 제거한다. `analysis_jobs`, `analysis_events`, `analysis_provider_runs`, `maintenance_jobs`, 모든 active V2 source, `payment_events`는 W1A drop allowlist에 포함하지 않는다.

### W1B와 보존 wave

- W1B는 `payment_events` 전용이다. payment webhook/order state, `payments`, `payment_orders`, `earlybird_orders`, `pending_analysis`, `payment_pending` 상태의 independent evidence가 없으면 진행하지 않는다. 이 설계와 현재 문서 작업에서는 W1B를 실행하지 않는다.
- 보존 wave는 `analysis_jobs` 19행과 `analysis_events` 81행을 consistent snapshot으로 full-row archive하고 row-level checksum, PK uniqueness, foreign-key/reference manifest를 남기는 작업이다. archive가 없거나 checksum이 맞지 않으면 table을 유지한다.
- `analysis_provider_runs`와 `maintenance_jobs`는 source audit 결과에 따라 active/recovery contract를 유지한다. zero-row 재관측만으로 보존 결정을 뒤집지 않는다.

## 증거 게이트

### 적용 전

후속 implementation owner는 다음을 한 번의 read-only, 일관된 snapshot으로 수집해야 한다.

1. git SHA, migration history, public base table/view/routine 목록과 owner/schema를 저장한다.
2. W1A 및 hold 후보 각각에 대해 exact row count, PK digest, 모든 column/type/default, index, FK, trigger, policy/RLS, ACL, publication/sequence/partition, `pg_depend` edge를 저장한다.
3. `ANALYSIS_CANONICAL_*`, `COMMERCE_CANONICAL_*` read/write flag의 실제 값과 deploy config 출처를 확인한다. `pg_stat` 또는 마지막 updated timestamp만으로 traffic 없음이나 quiescence를 증명하지 않는다.
4. `rg` 기반 소스 caller inventory와 migration routine body inventory를 만든다. direct table reference, RPC reference, env flag reference, admin route reference를 각각 분리한다.
5. `analysis_jobs/events`는 19/81행 snapshot을 보존/아카이브하고 full-row checksum을 계산한다. snapshot이 바뀌면 새 manifest를 만들고 drop을 멈춘다.
6. payment, user deletion, order/fulfillment 및 operator dashboard의 legacy path가 canonical shadow 없이 완료되는지 route/RPC contract evidence로 확인한다.
7. 대상 table이 실제로 0행인지 확인하는 것과 별개로, insert/update caller가 없고 disabled flag도 제거 가능하다는 소스 증거를 확보한다.

### 적용 후

- migration history에 정확히 한 개의 새 contraction migration만 추가되었는지 확인한다.
- W1A allowlist의 table과 family-specific function/policy/trigger/index가 사라졌고, 다른 table이나 maintenance helper로 dependency가 남지 않았는지 확인한다. `CASCADE`로 숨은 object를 지우지 않는다.
- active runtime table, `analysis_provider_runs`, `maintenance_jobs`, `analysis_jobs/events`, legacy payment/order/user/result/admin route의 존재·row count·checksum이 허용된 변화 외에 동일한지 확인한다.
- application source에 W1A family flag, canonical mirror/shadow-read, 전용 backfill/verify entry point가 남지 않았는지 확인한다. shared hash/recovery helper와 유지 대상 jobs/events path는 예외로 확인한다.
- 분석 시작, progress, result, earlybird fulfillment, webhook finalization, 세 notification outbox delivery, account deletion/recovery, admin observability/order/score audit의 기존 contract smoke를 수행한다.
- `payment_pending`를 읽기 외의 방식으로 변경한 SQL, application call 또는 migration side effect가 없는지 확인한다.
- rollback archive manifest와 post-drop catalog digest를 저장한다. 결과 카탈로그 수는 보고하되 terminal count로 약속하지 않는다.

### 중단 조건

다음 중 하나라도 있으면 migration을 적용하지 않고 해당 후보를 deferred set으로 옮긴다.

- 대상에 nonzero row, checksum 불일치, 보존 archive 실패가 있다.
- active caller, enabled flag, routine/view/FK/dependency edge, publication/trigger/ACL 사용 흔적이 있다.
- legacy path가 대상 shadow의 결과를 필요로 하거나 admin operator 결과가 달라진다.
- payment/order/user deletion/recovery evidence가 독립적으로 닫히지 않는다.
- migration history 또는 restore manifest가 현재 branch와 일치하지 않는다.
- 계획되지 않은 table, function, policy, flag, status row가 함께 바뀐다.

## 롤백 원칙

1. 가장 안전한 rollback은 schema drop 전에 application commit을 되돌리는 것이다. 따라서 W1A family의 모든 read/write/shadow caller를 먼저 제거하고, legacy path가 독립적으로 동작하는 것을 확인한 뒤 schema를 줄인다.
2. schema migration 이후 application 장애가 확인되면 먼저 격리 DB에서 `supabase/operations/20260913_restore_inactive_canonical_shadow.sql`에 해당하는 restore operation을 archive manifest로 검증한다. 대상 table, column, PK, policy/RLS, trigger, index, routine을 checksum과 함께 복원한 뒤 application commit을 되돌린다.
3. production restore는 owner 승인과 fresh dependency check 뒤에만 수행한다. archive를 덮어쓰거나 삭제하지 않으며, 불확실한 migration을 반복 적용하지 않는다.
4. legacy active source와 `maintenance_jobs`는 rollback을 위해 계속 보존한다. payment/order state를 재생성하거나 `payment_pending`을 보정하는 별도 mutation은 이 설계의 rollback에 포함하지 않는다.

## 구현 경계

이 문서는 설계와 계획만 산출한다. 현재 작업에서 하지 않는 일은 다음과 같다.

- `supabase db push`, remote catalog 조회, migration apply, table/function drop
- canonical read/write flag activation 또는 실제 canary
- `payment_pending` 및 payment/order 상태 변경
- active V2 table을 canonical table로 backfill하거나 canonical을 authoritative로 전환
- `app/page.tsx` 마케팅 copy 및 protected file 변경
- 새 테스트 추가 또는 application/SQL implementation

후속 구현에서는 기존 migration 파일을 수정하지 않고 새 migration과 restore operation을 추가한다. 기존 contract test 파일은 정책 변경에 맞게 갱신할 수 있지만 새 테스트 suite를 만들지 않는다.

## 근거 파일

- 기존 설계/계획: `docs/superpowers/specs/2026-09-09-supabase-22-table-consolidation-design.md`, `docs/superpowers/plans/2026-09-11-supabase-22-final-convergence.md`
- canonical analysis migration: `supabase/migrations/20260909095740_add_analysis_canonical_tables.sql`
- canonical commerce/operations migration: `supabase/migrations/20260909095932_add_commerce_operation_canonical_tables.sql`
- analysis shadow adapters: `lib/services/analysis/canonical-analysis-read.ts`, `lib/services/analysis/canonical-analysis-store.ts`, `lib/services/analysis/v2-worker.ts`, `lib/services/analysis/v2-progress-reporter.ts`, `lib/services/analysis/provider-cost-reconciliation.ts`, `lib/services/analysis/v2-result-store.ts`
- commerce/operations adapters: `lib/services/operations/canonical-operations-store.ts`, `lib/services/commerce/canonical-commerce-store.ts`
- exact-22 contracts to revise: `lib/services/operations/supabase-22-evidence.ts`, `scripts/generate-supabase-22-retirement-inventory.ts`, `scripts/verify-supabase-22-catalog.ts`
- operator routes: `app/api/admin/analysis-observability/route.ts`, `app/api/admin/order-audit/route.ts`, `app/api/admin/analysis-audit/route.ts`, `app/api/admin/landing-leads/route.ts`
- historical evidence: `docs/reports/2026-09-09-supabase-22-analysis-canonical-evidence.md`, `docs/reports/2026-09-09-supabase-22-commerce-operations-evidence.md`, `docs/reports/2026-09-11-supabase-22-wave1-production-readonly-evidence.md`, `docs/reports/2026-09-12-supabase-22-pending-analysis-retirement-evidence.md`, `docs/reports/2026-09-12-supabase-22-historical-legacy-dispatch-empty-payment-retirement-evidence.md`, `docs/reports/2026-09-12-earlybird-receipt-cutover-evidence.md`
