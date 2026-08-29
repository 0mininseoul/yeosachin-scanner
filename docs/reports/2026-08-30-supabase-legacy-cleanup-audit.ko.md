# Supabase 및 레거시 분석 정리 감사

**감사일:** 2026-08-30 (Asia/Seoul)

**기준 소스:** `origin/main`의 `2a28326462bf636f92368dc894b5ea76911d79bb`

**범위:** 읽기 전용 카탈로그 메타데이터, 스키마 메타데이터, aggregate count 헤더. 행 본문은 수집하지 않았다.

## 결론

현재 증거만으로 즉시 삭제할 수 있는 객체는 없다. 운영 API에 165개 정의가 노출되고, 소스의 `app/`, `lib/`, `hooks/`, `components/`, `scripts/`, `docs/`에서 152개 relation 이름이 참조된다. 나머지 이름에도 복구·이력·서버 전용 의존성이 있을 수 있으므로, 텍스트 참조가 없다는 이유만으로 삭제 후보로 올리면 안 된다.

유료 Analysis V2가 정본 실행 경로다. preflight와 entitlement/admission 뒤 Cloud Tasks가 V2 worker를 호출하고, worker가 durable staged state를 기록하며, finalizer가 owner-scoped 결과를 발행하고, 결과 이미지는 private R2 registry를 사용한다. V1/step 호환 경로는 migration-only 또는 이력 조회 경계로 남아 있지만, 트래픽·DB dependency·과거 결과 호환성을 확인한 뒤에만 consolidate할 수 있다.

Apify/RapidAPI/self-hosted의 의도적인 provider 전환 구조는 삭제 대상이 아니다. 이 감사에서는 운영 mutation, migration 수정, DDL/DML, mutation RPC, provider 호출, 배포를 수행하지 않았다.

## Production 확인과 한계

canonical main worktree의 환경 파일은 키 이름으로만 읽었고 출력하거나 `source`하지 않았다. 구성된 Supabase HTTPS endpoint는 표준 public schema OpenAPI를 반환했고 정의 165개, path 805개가 확인됐다. 다만 이 환경에서는 management-plane project identity를 독립적으로 증명하지 못했다. CLI project 목록에는 endpoint와 일치하는 owner-level project가 확인되지 않았고, linked DB query는 현재 네트워크의 IPv6/권한 제약으로 실패했다. 따라서 이 보고서의 production 근거는 “canonical endpoint/schema fingerprint”로 표기하며, owner-level catalog snapshot을 받기 전에는 삭제 결정을 하지 않는다.

토큰, project reference, DB 비밀번호, Authorization 헤더, cookie, UUID, 이메일, username, raw row, raw storage path는 보고서에 넣지 않았다.

## 산출물 총계

| 영역 | 총계 | 해석 |
|---|---:|---|
| PostgREST 정의 | 165 | API에 노출된 정의이며 전체 DB catalog가 아님 |
| relation path | 165 | CRUD relation 164개 + read-only view 1개 |
| read-only view | 1 | `analysis_operational_cost_summary` |
| materialized view | 0 관측 | OpenAPI에 없음; `pg_catalog` 확인 필요 |
| RPC path | 639 | OpenAPI의 고유 `/rpc/` 이름 |
| exact count 가능 relation | 60 | HEAD 요청의 `Content-Range`만 읽음 |
| exact row 합계 | 48,931 | 60개 relation의 aggregate header 합계 |
| 직접 read 거부 relation | 105 | HTTP 403; 빈 테이블이라는 뜻이 아님 |
| migration 파일 | 354 | newest timestamp `20260829120000` |
| migration source의 고유 table create | 161 | 원격 적용 완료를 뜻하지 않음 |
| migration source의 고유 view | 2 | `analysis_operational_cost_summary`, `daily_token_usage` |
| materialized view/sequence 선언 | 0 / 0 | source scan 기준; identity/serial sequence는 catalog 확인 필요 |
| function 선언 이벤트 / 고유 이름 | 951 / 646 | replace·overload·이력 정의가 섞임 |
| trigger 선언 이벤트 / 고유 이름 | 83 / 78 | 현재 enabled 상태는 미확인 |
| policy create / drop 이벤트 | 19 / 5 | source history이며 현재 `pg_policy`가 아님 |
| RLS enable 이벤트 / 고유 relation | 153 / 148 | source history 기준 |
| force-RLS 이벤트 / 고유 relation | 113 / 110 | 모두 enable 집합 안에 있음 |
| public FK reference 라인 / 대상 수 | 243 / 34 | source의 `REFERENCES public.*` scan |
| realtime publication add 이벤트 | 2 | progress state/events; 현재 membership 미확인 |
| Supabase Storage bucket | 0 | 결과 이미지는 외부 R2, source media는 private GCS |

Live table 164개와 비교하면 현재 migration source로 설명되지 않는 table은 `payment_orders`, `payments`, `pending_analysis` 3개다. `analysis_operational_cost_summary`는 별도 view이고, source에 있는 `daily_token_usage`는 현재 exposed relation 목록에 없다. 이 차이는 삭제 근거가 아니라 migration history와 owner catalog를 먼저 맞춰야 한다는 신호다.

## 접근 가능한 relation의 exact aggregate count

다음은 row를 읽지 않고 HEAD/count metadata만 읽어 얻은 주요 값이다. 접근 가능한 60개 중 40개가 non-zero이고 20개가 0행이며, 403인 105개는 0행으로 추정하지 않았다.

| relation | exact rows | relation | exact rows |
|---|---:|---|---:|
| `users` | 482 | `analysis_requests` | 208 |
| `analysis_results` | 1,566 | `private_accounts` | 4,861 |
| `analysis_preflights` | 317 | `analysis_preflight_failures` | 5,069 |
| `analysis_pipeline_jobs` | 1,274 | `analysis_step_events` | 90 |
| `analysis_anonymous_preflight_attempts` | 4,713 | `analysis_anonymous_profile_cache` | 2,469 |
| `analysis_v2_scheduler_operations` | 3,351 | `analysis_v2_result_image_objects` | 506 |
| `gemini_token_usage` | 16,475 | `landing_leads` | 5,647 |
| `earlybird_orders` | 158 | `earlybird_waitlist` | 39 |
| `earlybird_webhook_events` | 88 | `earlybird_payment_discord_outbox` | 9 |
| `account_paid_evidence` | 55 | `account_classification_audit` | 64 |
| `ai_analysis_cache` | 402 | `kakao_signup_discord_outbox` | 444 |
| `analysis_operational_cost_summary` | 391 | `analysis_provider_cost_ledger` | 24 |
| `analysis_provider_usage_expectations` | 24 | `analysis_gemini_usage_expectations` | 40 |
| `analysis_v2_test_entitlement_consumptions` | 58 | `precheckout_blite_cache` | 5 |
| `precheckout_blite_dispatches` | 3 | `demo_analysis_runs` | 14 |
| `demo_analysis_fixtures` | 2 | `account_deletion_jobs` | 12 |
| `account_e2e_test_runners` | 2 | `account_ledger_rollout_state` | 1 |
| `earlybird_checkout_reconciliations` | 4 | `earlybird_plan_inventory` | 2 |
| `result_feedback` | 1 | `scraper_provider_usage` | 49 |
| `sentry_discord_alert_outbox` | 1 | `pending_analysis` | 11 |

가족별로는 accessible subset에서 `account_*` 5개/134행, non-V2 `analysis_*` 27개/16,185행, `analysis_v2_*` 3개/3,915행, `earlybird_*` 6개/300행, `precheckout_*` 3개/8행, legacy/core와 `ai_analysis_cache` 14개/28,373행, `demo_*` 2개/16행이다. 이는 우선순위 신호이지 삭제 승인이나 PII 목록이 아니다.

## RLS·policy·FK·trigger·publication

- migration source는 148개 relation에 RLS를 enable했고 110개에는 force-RLS 이벤트도 있다. 38개는 source상 enable-only다.
- 105개 relation의 403은 내부 service-owned/force-RLS/revoke 경계를 나타낼 수 있으므로, 직접 read 불가를 “미사용”이나 “빈 테이블”로 해석하지 않는다.
- source의 243개 public FK reference는 34개 대상에 연결된다. 주요 대상은 `analysis_requests` 88회, `analysis_preflights` 40회, `earlybird_orders` 27회, `analysis_pipeline_jobs` 25회, `users` 15회다.
- `analysis_requests`는 결과·progress·V2 staged evidence·provider run·revenue/coverage ledger·image manifest·owner history의 부모 경계다.
- `analysis_preflights`는 anonymous/paid admission·provider run·B-lite cache·exclusion·expiry 경계다.
- `earlybird_orders`는 결제/fulfillment/webhook/reconciliation의 상업 lifecycle이며 분석 실행과 합치면 안 된다.
- trigger 선언 83건 중 다수는 payment/account/V2/precheckout/concierge의 immutable·recovery guard다. 이를 복제하지 않고 table을 합치면 안전 경계를 약화시킬 수 있다.
- migration source의 realtime publication add는 progress state/events에 대해 2건이다. 현재 publication membership, replica identity, trigger enabled 상태는 owner catalog로 확인해야 한다.

현재 exposed 목록에는 local RLS enable 선언이 없는 이름도 있다. `analysis_operational_cost_summary`, 여러 earlybird recovery relation, `payment_orders`, `payments`, `pending_analysis` 등이 이에 포함된다. recovery relation 일부는 의도적으로 Data API 권한을 revoke한 것이고, legacy 3개 relation은 현재 create source와 provenance가 설명되지 않았으므로 모두 `unknown`으로 둔다.

## Canonical/legacy 경로 지도

### Canonical V2

`hooks/useAnalysisV2Preflight.ts` → `POST /api/analysis/preflight` → preflight queue/worker → `POST /api/analysis/v2/worker` → durable V2 DAG → authoritative result publication → owner/share result + R2 image registry의 순서다. V2 worker는 scheduler/job generation/lease를 사용하고, result route는 authenticated owner와 publication 상태를 확인한 뒤 page projection을 반환한다. `app/result/[requestId]/page.tsx`는 V2를 먼저 시도하고, `V2_ROUTE_REQUIRED` 응답이 오면 canonical V2 URL로 이동한다.

V2 staged evidence, provider/Gemini/revenue ledger, recovery/replay, concierge correction, score audit, owner history는 이력과 장애 복구를 위한 durable state다. 높은 이름 수나 403만으로 정리하면 안 된다.

### V1 및 호환 경계

`app/api/analysis/run/route.ts`는 migration-only이며 기본 HTTP 410이고 명시적인 legacy gate와 admin authorization이 모두 있어야 한다. 그러나 `app/api/analysis/start/route.ts`, status/progress/result/step 및 기존 owner history가 남아 있고, `analysis_requests`, `analysis_results`, `private_accounts`도 live count와 코드 참조가 있다. 따라서 V1은 “삭제”가 아니라 먼저 read compatibility를 보장하는 `consolidate` 대상이다.

V1 write traffic가 완전한 관측 기간 동안 0이고, cron/Cloud Tasks/script/external operator가 호출하지 않으며, DB function/trigger/view dependency가 없고, 과거 결과가 V2 compatibility adapter로 복원되는 것을 확인하기 전에는 제거하지 않는다.

### Anonymous preflight와 B-lite

anonymous preflight는 활성 funnel이다. client device boundary, 서버의 IP/device/target hash budget, 30분 서명 claim, raw token이 아닌 claim hash, authenticated owner claim이 사용된다. anonymous read는 raw provider image URL을 반환하지 않는다. `preflight-retention.ts`는 provider cost reconciliation 뒤 짧은 source evidence와 만료 preflight를 purge하고 terminal scrub을 수행한다. attempts/cache/failure/preflight의 non-zero count도 즉시 삭제 금지의 근거다.

### Provider와 media

`lib/services/instagram/scraper.ts`는 profile/profilesBatch/followers/following을 capability별로 라우팅한다. Apify, RapidAPI, self-hosted 구현과 fallback은 의도된 운영 전환·rollback 계약이므로 모두 `keep`이다.

Supabase Storage는 bucket 0개다. 결과 이미지는 private R2와 `analysis_v2_result_image_objects` registry를 사용하고, AI source media는 private GCS workspace다. R2/GCS object lifecycle은 별도 dependency이며 Supabase Storage 삭제 작업으로 대체할 수 없다.

## 분류

| 대상 | 분류 | 근거 / 신뢰도 |
|---|---|---|
| `users`, Auth identity, account classification, admin/operator identity | keep | identity 및 server-owned boundary. 높음 |
| `analysis_requests`, `analysis_results`, `private_accounts`, progress/result 호환 | keep | live count·owner history·코드 참조·보존 정책. 높음 |
| V2 jobs/staged evidence/provider·Gemini·revenue ledger/recovery/audit | keep | 내부 restricted relation과 durable fence. 높음 |
| preflight/anonymous/B-lite/admission/retention | keep | 활성 route·worker·retention 및 non-zero count. 높음 |
| earlybird order/fulfillment/webhook/reconciliation/waitlist | keep | 결제 lifecycle와 실행 lifecycle을 분리. 높음 |
| Apify/RapidAPI/self-hosted switching | keep | 의도적 provider router/rollback. 높음 |
| R2 result-image registry, private GCS workspace | keep | canonical media path. 높음 |
| V1 start/step/write 및 중복 DTO/store projection | consolidate | `/run`은 410이지만 start/status/result/history와 script가 남음. 중간 |
| cost/observability 오래된 projection | consolidate 후속 | live view와 참조가 있으므로 equivalent projection 이후에만. 중간 |
| 짧은 TTL anonymous/precheckout source/cache | archive-then-drop | provider cost·lease·외부 object terminal 확인과 archive가 선행. 중간 |
| `pending_analysis` | unknown; 이후 archive-then-drop 가능 | 11행, static ref 없음, legacy provenance 미설명. 낮음 |
| `payments`, `payment_orders` | unknown; 이후 archive-then-drop 가능 | server-owned legacy boundary, catalog/dep 미확인. 낮음 |
| demo/E2E/admin test artifacts | archive-then-drop, 별도 승인 후 | 현재 test/operator 경계가 남음; 22 E2E identity는 읽지 않음. 중간 |
| static ref 없는 13개 relation | unknown | trigger/RPC/recovery/history 가능. 낮음 |
| 장기 function overload/RPC | unknown | 951 declaration, 646 source names, 639 exposed paths; truncation/overload 문제. 낮음 |
| 현재 relation 즉시 삭제 | drop-candidate: 없음 | zero traffic·zero dependency·archive·rollback을 동시에 증명한 객체가 없음. 높음 |

Static scan에서 참조가 없었던 13개는 `analysis_gemini_usage_expectations`, `analysis_provider_usage_expectations`, `analysis_revenue_ai_routing_attempt_lineages`, `analysis_revenue_final_coverage_gates`, `analysis_revenue_primary_quality_checkpoints`, `analysis_revenue_resolver_passes`, `analysis_v2_result_revision_female_rows`, `analysis_v2_result_revisions`, `comment_details`, `earlybird_profile_evidence_failure_recoveries`, `earlybird_v211_concierge_publications`, `interaction_logs`, `pending_analysis`다. 이 목록은 삭제 후보가 아니라 owner catalog 확인 목록이다.

## 반드시 보존할 데이터 정책

1. 2026-07-24 이후 user/analysis data는 전부 보존한다. “legacy”라는 이유로 table-wide delete를 하지 않는다.
2. admin identity와 operator classification을 보존한다. admin/test cleanup은 별도 승인 작업이다.
3. 22개 E2E identity와 admin test artifact는 이번 범위가 아니다. 별도 allowlist·Auth deletion proof·post-delete 검증이 있을 때만 제거한다.
4. `landing_leads`는 현재 input/attribution 데이터다. 향후 landing metric에서는 analysis target과 명시적 excluded target을 분리하고 paid metric에 혼합하지 않는다.
5. `earlybird_waitlist`는 활성 waitlist로 유지한다. withdrawn는 별도 access-controlled archive/lifecycle로 분리하며 waitlist 상태로 덮어쓰지 않는다. 현재 dedicated withdrawn relation은 확인되지 않아 future design은 unknown이다.
6. anonymous-to-auth mapping은 opaque claim/hash와 device boundary를 유지한다. mutable email/username/raw token을 analytics identity로 사용하지 않고, 동일 preflight 재claim 시 owner row를 보존한다.
7. `first_paid_at`은 account-principal bridge의 external classification과 immutable provider/payment evidence가 있을 때만 earliest timestamp를 monotonic하게 기록한다. `payment_pending`, 양수 금액만 있는 행, E2E/admin/refund만으로 paid-ever를 만들지 않는다.
8. abandoned `payment_pending`은 짧은 bounded retention을 적용할 수 있지만, 독립 provider evidence와 auditable disposition 없이는 상태 변경·삭제하지 않는다. immutable pricing/payment lineage를 보존한다.
9. provider start가 ambiguous하거나 R2 삭제가 확인되지 않은 행은 결과가 없다고 추정해 삭제하지 않는다. ledger와 external object terminal evidence가 필요하다.

## 후속 정리 순서

1. 같은 endpoint에 대해 owner-authorized read-only catalog를 받아 relation kind/column/key/FK/view/matview/sequence/routine/trigger/policy/RLS/grant/publication/`pg_depend`/migration history를 확인한다.
2. V1 write와 V1 historical read를 분리해 route/RPC/job/cron/script/external operator traffic을 완전한 관측 기간 동안 측정한다.
3. 모든 보존 대상 V1 결과가 V2 owner-history/result compatibility adapter로 읽히는지 확인한다.
4. 2026-07-24 이후 데이터, Auth/admin identity, payment/provider evidence를 destructive scope에서 제외한 archive와 restore drill을 만든다.
5. caller를 한 surface씩 canonical contract로 이동하고 aggregate mismatch만 기록한다. rollback window 동안 구 path는 read-only로 둔다.
6. provider cost, lease, external media가 terminal/reconciled인 짧은 TTL source/cache만 retention gate 후 정리한다.
7. 위 gates가 모두 통과한 뒤에만 정확한 migration allowlist와 owner approval로 object removal을 검토한다. 이 감사에는 migration file이나 executable SQL이 없다.
8. 적용 뒤 catalog, aggregate count, result/history, payment/recovery, media purge/access, secret scan을 재검증한다.

## 삭제를 막는 미확인 사항

- 구성 endpoint가 실제 production `yeosachin` project인지 management-plane 확인이 필요하다.
- 105개 403 relation, static ref 없는 13개 relation의 실제 kind/size/policy/grant/trigger/publication/`pg_depend`가 필요하다.
- 354개 source migration과 원격 migration history의 정확한 alignment가 필요하다. 보호된 reconciliation migration은 변경하지 않는다.
- dynamic RPC, external job, cron, dashboard, historical client 호출 여부가 필요하다.
- 2026-07-24 전후 aggregate를 account classification/lifecycle별로 확인해야 한다. row export는 하지 않는다.
- 독립 provider evidence가 있는 payment만 분류하고, abandoned와 recoverable `payment_pending`을 구분해야 한다. 이 감사에서는 payment 상태를 바꾸지 않았다.
- R2/GCS object의 age/terminal/orphan aggregate가 필요하다. object name/path를 보고서에 남기지 않는다.

## 감사 ledger

- `HEAD == origin/main == 2a28326462bf636f92368dc894b5ea76911d79bb` 확인.
- `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql`은 tracked 및 unchanged로 보존.
- 기존 unrelated `package-lock.json` 변경은 보존하고 stage하지 않음.
- live 확인은 OpenAPI, relation HEAD count, accessible exact count, 403 total, Storage bucket count뿐이었다.
- migration declaration, source/live table alignment, relation/RPC text reference, route/store/provider map, docs cross-reference를 점검.
- 두 보고서는 service-role/password/connection-string/Bearer/JWT 및 identifier-like email/UUID 패턴을 secret-scan했다.
- production mutation·migration repair·DDL·DML·mutation RPC·provider call·deployment 없음.
