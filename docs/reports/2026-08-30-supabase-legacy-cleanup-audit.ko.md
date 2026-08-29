# Supabase 및 레거시 분석 정리 감사

**감사일:** 2026-08-30 (Asia/Seoul)

**수정 기준:** `c507254f68a72bc3de8e243fdb6827eb25710031`

**감사 소스 기준:** `origin/main`의 `2a28326462bf636f92368dc894b5ea76911d79bb`

**감사 모드:** 읽기 전용 API/catalog 메타데이터, source-schema 메타데이터, aggregate count 헤더만 확인했으며 행 본문은 수집하지 않았다.

## 결론

현재 증거만으로 즉시 삭제할 수 있는 객체는 없다. 운영 API에는 PostgREST 정의 165개( CRUD-capable relation path 164개와 read-only view path 1개)가 노출되고, 소스 트리의 `app/`, `lib/`, `hooks/`, `components/`, `scripts/`, `docs/`에서는 그중 152개 이름이 텍스트로 참조된다. 165개 정의 모두 아래 ledger에서 정확히 하나의 분류를 가지며, 텍스트 참조 부재·HTTP 403·source/live 이름 차이는 객체 미사용이나 0행의 증거로 사용하지 않는다.

유료 Analysis V2가 정본 실행 경로다. preflight와 entitlement/admission 뒤 Cloud Tasks가 V2 worker를 호출하고, worker가 durable staged state를 기록하며, finalizer가 owner-scoped 결과를 발행하고, 결과 이미지는 private R2 registry를 사용한다. V1/step 호환 경계는 migration-only 또는 owner-history read 경계로 남아 있으나 트래픽·DB dependency·과거 결과 호환성을 증명한 뒤에만 consolidate할 수 있다. Apify/RapidAPI/self-hosted provider 전환 구조는 의도된 운영·rollback 계약이므로 정리 대상이 아니다.

Endpoint/schema fingerprint는 credential과 행 데이터를 출력하지 않고 확인했다. 다만 이 환경에서는 Supabase management-plane project identity를 독립 증명하지 못했다. linked CLI query는 네트워크/권한 제약으로 막혔고 계정에 보이는 project 목록에도 endpoint와 일치하는 항목이 없었다. 따라서 운영 근거는 “canonical endpoint/schema fingerprint”로만 표시하며 owner-authorized catalog snapshot 전에는 파괴적 결정을 하지 않는다.

별도로 owner가 승인한 정확히 지정된 administrator test-order cleanup operation은 과거의 특수 범위 작업이다. 이 감사에서는 이를 승인하거나 실행하지 않았으며, 이 작업의 과거 승인은 여기서 어떤 미래 mutation도 승인하지 않는다. 또한 external-user `payment_pending` 주문은 independent provider evidence와 auditable disposition 없이는 변경·삭제하지 않는다는 규칙을 완화하지 않는다.

## 범위와 안전 경계

이 감사에서는 다음을 하지 않았다.

- 행 데이터, 이름, 이메일, username, UUID, cookie, provider payload, raw storage path를 읽지 않았다.
- mutation RPC, DDL, DML, migration history repair, `supabase db push`를 실행하지 않았다.
- migration, executable SQL, application code, provider 설정 또는 보호된 reconciliation migration을 수정하지 않았다.
- relation의 `403`을 빈 테이블 또는 부재로 해석하지 않았다.
- Apify, RapidAPI, Gemini, Instagram, R2, GCS 또는 기타 provider를 호출하지 않았다.
- Apify/RapidAPI/self-hosted route switch 삭제를 권고하지 않았다.

live relation 수는 HTTP HEAD/count 메타데이터 요청으로만 확인했다. exact-count pass는 `Content-Range` 합계만 반환했으며 response body는 읽지 않았다. PostgREST OpenAPI로 relation definition과 RPC path를 열거했고, Supabase Storage bucket 수만 세고 bucket 이름은 보존하지 않았다. 정적 검사는 `app/`, `lib/`, `hooks/`, `components/`, `scripts/`, `docs/`, `supabase/migrations/`를 대상으로 했다.

### Identity 및 근거 한계

canonical main worktree 환경 파일은 key 이름으로만 읽었고 `source`하거나 출력하지 않았다. 구성된 Supabase HTTPS endpoint는 표준 public schema OpenAPI를 반환하여 definition 165개와 path 805개를 보였다. CLI 버전은 2.114.0이었다. 계정에 보이는 두 project는 endpoint-derived identity와 일치하지 않았고, linked database query는 현재 네트워크의 IPv6 route를 사용할 수 없어 실패했으며 별도 link 시도도 endpoint 권한으로 거부됐다. project reference, token, secret, DB password, Authorization header, cookie, 사용자 식별자는 보고서에 넣지 않았다.

이는 구성 endpoint에서 기대한 production schema가 응답한다는 사실만 증명하며 management-plane ownership이나 완전한 `pg_catalog` snapshot을 증명하지 않는다. 후속 gate는 같은 endpoint에 대한 owner-authorized read-only catalog export다.

OpenAPI path의 정확한 산식은 `805 = root path 1 + relation/view path 165 + RPC path 639`이다. 따라서 relation/RPC subset은 `804 = 165 + 639`이고, root path 1개는 relation이나 RPC가 아니다. 165개 relation/view path 중 164개는 CRUD-capable이고 1개는 read-only view다.

### 파괴적 작업 보류

이 보고서는 어떠한 실행도 승인하지 않는다. 향후 row 삭제·status mutation, Auth 삭제, storage/object purge, DDL/DML, migration, mutation-capable RPC는 기존 owner-catalog, traffic/compatibility, exact ownership/identity, provider/payment, external-media gate를 모두 통과하기 전까지 차단한다. 별도 승인된 과거 administrator test-order 작업도 이 gate들의 우회 수단이 아니다.

## 수정된 비식별 총계

| 영역 | 관측 총계 | 근거와 한계 |
|---|---:|---|
| PostgREST named definitions | 165 | OpenAPI definition의 정확한 수; 전체 DB catalog가 아님 |
| CRUD-capable relation path | 164 | OpenAPI path 분류의 정확한 수; 모든 path의 `pg_class` kind는 주장하지 않음 |
| read-only view path | 1 | `analysis_operational_cost_summary`; RLS가 필요한 table로 세지 않음 |
| materialized-view path | 0 관측 | OpenAPI에 없음; owner-level `pg_class` 확인 필요 |
| RPC path | 639 | 고유 `/rpc/` 이름; 긴 PostgreSQL 식별자 truncate와 overload 존재 |
| exact-count header relation | 60 | HEAD 요청만 수행; 행 본문 없음 |
| 접근 가능 relation exact 합계 | 48,931 | 60개 `Content-Range` 합계; PII export가 아님 |
| 직접 read 거부 relation | 105 | HTTP 403; 0행 또는 부재를 뜻하지 않음 |
| local migration 파일 | 354 | git-tracked SQL; newest timestamp `20260829120000` |
| source의 고유 table create 이름 | 161 | 선언 scan; 원격 적용 완료를 뜻하지 않음 |
| source의 고유 view 이름 | 2 | `analysis_operational_cost_summary`, `daily_token_usage`; source history이며 live kind가 아님 |
| source의 materialized-view 명시 선언 | 0 | declaration scan; live catalog kind 확인 필요 |
| source의 sequence 명시 선언 | 0 | declaration scan; serial/identity 소유 sequence는 catalog 확인 필요 |
| function 선언 이벤트 / 고유 이름 | 951 / 646 | replace·overload·이력 정의가 섞임 |
| trigger 선언 이벤트 / 고유 이름 | 83 / 78 | source 선언 scan; 현재 enabled 상태 미확인 |
| policy create / drop 이벤트 | 19 / 5 | source history이며 현재 `pg_policy` 상태가 아님 |
| whitespace-normalized 명시 RLS enable 이벤트 / 고유 이름 | 165 / 161 | 주석 제거 및 임의 whitespace 정규화; source history이며 현재 `relrowsecurity`가 아님 |
| whitespace-normalized 명시 force-RLS 이벤트 / 고유 이름 | 126 / 123 | source history이며 현재 `relforcerowsecurity`가 아님 |
| 동적 RLS boundary target 이름 | 4 / 추가 2 | `payments`, `payment_orders`, `users`, `ai_analysis_cache`; 앞의 두 이름만 명시 집합에 추가됨 |
| public 또는 unqualified FK reference 절 / distinct target | 263 / 35 | `public.*` 243개 + unqualified 20개; 현재 constraint는 미확인 |
| realtime publication-add 이벤트 / source 이름 | 3 / 3 | 초기 `analysis_requests`와 guarded progress 두 개; live membership 미확인 |
| Supabase Storage bucket | 0 | 결과 이미지는 외부 R2, source media는 private GCS |

Migration source에는 고유 table create 이름 161개가 있다. 164개 CRUD-capable live definition과 비교하면 현재 `CREATE TABLE` 선언으로 설명되지 않는 live 이름은 `payment_orders`, `payments`, `pending_analysis` 세 개다. 나머지 하나는 table 비교 대상이 아닌 `analysis_operational_cost_summary` view다. source에 있는 `daily_token_usage`는 현재 exposed definition 목록에는 없다. 이 차이는 provenance 확인 사항이지 삭제 근거가 아니다.

## 접근 가능한 relation의 exact aggregate count

다음 표에는 exact-count를 얻은 60개 중 non-zero인 40개 relation만 의도적으로 나열했다. 나머지 20개 exact-count relation은 0행이어서 표에서 생략했으며 누락된 것이 아니다. 403인 105개는 0행으로 추정하지 않았다.

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

Accessible subset family roll-up은 `account_*` 5개/134행, non-V2 `analysis_*` 27개/16,185행, `analysis_v2_*` 3개/3,915행, `earlybird_*` 6개/300행, `precheckout_*` 3개/8행, `ai_analysis_cache`를 포함한 legacy/core 14개/28,373행, `demo_*` 2개/16행이다. 이는 운영 우선순위 신호일 뿐 삭제 승인이나 PII 목록이 아니다. 이 절의 값은 모두 exact header total이며 estimate가 아니고, denied relation row count는 제공하지 않는다.

## Catalog evidence boundary: partition, size, column, key

안전한 API pass에서 얻지 못한 현재 catalog 메타데이터에 대해서는 명시적으로 evidence limit을 둔다. 대상은 165개 전체 definition이다.

| 메타데이터 | 이번 감사의 근거 | owner-authorized 후속 근거 |
|---|---|---|
| partitioned-table 상태 | source에서 `CREATE TABLE ... PARTITION BY`와 `CREATE TABLE ... PARTITION OF` 선언을 각각 0개 확인했다. SQL/window `PARTITION BY`는 query syntax이므로 제외했다. live partition 상태는 unknown이다. | 모든 exposed definition의 read-only `pg_class.relkind`, `relispartition`, `pg_partitioned_table`, parent/child relation metadata. boolean과 비식별 이름만 반환한다. |
| relation size | `pg_relation_size`, `pg_indexes_size`, `pg_total_relation_size`, `reltuples`를 수집하지 않았다. 60개 `Content-Range`는 정확한 row count이지 disk size나 estimate가 아니다. | 105개 denied relation을 포함한 165개 전체의 byte 또는 coarse size bucket과 exact/estimated 여부. |
| current columns | OpenAPI definition은 API shape일 뿐 현재 `pg_attribute`/`information_schema.columns`의 보장은 아니며 per-column export를 보존하지 않았다. hidden/server-only column을 포함한 현재 column은 unknown이다. | 165개 전체에 대해 column name, type, nullability, default/generated/identity flag, ordinal만 export하고 값은 export하지 않는다. |
| primary/unique keys | source 선언에는 key text와 FK가 있으나 replacement/drop 이후 현재 constraint를 증명하지 못한다. live `pg_constraint`/`pg_index` inventory는 수집하지 않았다. | 165개 전체의 현재 PK/UNIQUE/index membership와 순서, FK validation/action. 이름과 boolean이면 충분하다. |
| relation kind | OpenAPI에서 read-only view path 하나만 식별했다. 나머지 164개는 CRUD-capable API relation이지만 `pg_class` 없이는 ordinary table, foreign table, view, partition, sequence-owned 여부를 주장하지 않는다. | 모든 definition의 현재 `pg_class.relkind`와 dependency/ownership metadata. |

Source partition declaration 0은 live DB에 partition table이 없다는 증명이 아니다. 403 relation도 owner catalog 요청에서 제외하지 않는다.

## RLS·policy·foreign key·trigger·realtime

### RLS와 policy

354개 migration 파일을 대상으로 임의 whitespace를 정규화한 source scan은 `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` 165개 이벤트와 고유 relation 이름 161개를 찾았다. 명시 force-RLS는 126개 이벤트와 고유 이름 123개이며, 명시 enable 집합 안의 38개 차이는 source상 enable-only history다. 이는 현재 live 상태가 아니다.

Internal data API boundary migration의 동적 conditional target array는 정확히 네 이름이다: `payments`, `payment_orders`, `users`, `ai_analysis_cache`. `users`와 `ai_analysis_cache`는 이미 161개 명시 집합에 있고 `payments`, `payment_orders`만 두 개를 추가한다. 따라서 명시 선언과 동적 대상의 union은 163개다. 164개 CRUD-capable live definition과 대조하면 source RLS-enable 근거가 없는 exposed table은 `pending_analysis` 하나뿐이다. `analysis_operational_cost_summary`는 유일한 read-only view이므로 false missing-RLS table로 세지 않는다. 이전 17개 missing list는 multiline whitespace와 conditional target array를 처리하지 못한 regex artifact였다.

이는 source coverage inventory이며 현재 live RLS를 주장하지 않는다. 직접-read pass의 HTTP 403은 internal service-owned/force-RLS/revoked Data API grant와 일치할 수 있지만 row 부재 신호가 아니다. 현재 `pg_class`, `pg_policy`, `information_schema.role_table_grants`는 owner-authorized catalog export로 확인해야 한다.

Source에는 policy create 19개와 drop 5개 이벤트가 있다. 특히 `users`, `analysis_requests`, `analysis_results`, `comment_details`, `interaction_logs`, `private_accounts`, anonymous preflight, earlybird 영역의 history를 보존해야 한다. Internal data-boundary migration은 `users`, `payments`, `payment_orders`, `ai_analysis_cache`에 server-owned access만 남기고 client object access를 제거한다. 이는 보안 경계이며 삭제 근거가 아니다.

### Foreign key

Source scan은 schema-qualified와 unqualified를 분리했다.

- `public.*`를 명시한 절은 243개, distinct target은 34개다.
- `REFERENCES <name>`처럼 schema 없이 쓴 절은 20개, distinct target은 정확히 5개다: `analysis_preflights`, `analysis_requests`, `analysis_results`, `earlybird_orders`, `users`.
- 따라서 public-or-unqualified textual total은 263개 절과 35개 distinct target이다.

20개 unqualified 절은 schema-qualified 절에 몰래 합치지 않았다. migration context상 public resolution이 가능해 보이지만 live schema, referenced column, validation state, delete action은 catalog proof가 필요하다. Source clause에는 `CASCADE`, `RESTRICT`, `SET NULL`, `NO ACTION` 의미가 섞여 있다.

의존성은 평면적인 legacy schema가 아니다.

- `analysis_requests`는 request progress, results, V2 staged evidence, provider runs, revenue/coverage ledger, image manifest, owner-history projection의 부모 경계다.
- `analysis_preflights`는 anonymous/paid admission, provider acquisition run, precheckout cache, exclusion, expiry 경계다.
- `analysis_pipeline_jobs`와 V2 scheduler operation은 background 실행·recovery fence이며 제거하면 유료 provider 중복 작업을 만들 수 있다.
- `earlybird_orders` 및 webhook/fulfillment/reconciliation은 commercial lifecycle이므로 result execution과 합치지 않는다.
- `users`와 account-principal bridge는 identity classification과 paid evidence의 소유 경계다. cleanup을 위해 auth identity를 새 analytics identity로 바꾸지 않는다.

### Trigger와 realtime publication

Trigger 선언 이벤트는 83개, source 이름은 78개다. 다수는 payment/account/V2/precheckout/concierge row의 immutable·recovery guard다. 이 invariant를 먼저 복제하지 않고 table을 교체하면 안전 경계가 약해진다. 현재 `pg_trigger` enabled state와 trigger-to-function dependency는 조회하지 않았다.

Source의 `supabase_realtime` publication-add 이벤트는 두 migration에 걸쳐 정확히 3개이며 membership은 다음과 같다.

1. Initial schema의 unqualified `ALTER PUBLICATION`: `analysis_requests`.
2. V2 progress migration의 guarded addition: `analysis_progress_state`.
3. 같은 V2 progress migration의 guarded addition: `analysis_progress_events`.

Guarded addition은 `supabase_realtime`가 있고 해당 table이 이미 member가 아닌지 확인한다. 현재 publication membership, replica identity, live publication 설정은 조회하지 않았다. Browser가 현재 polling한다거나 service-role direct read가 거부된다는 이유로 realtime row를 삭제하지 않는다.

## Code 및 문서 경로 지도

### Canonical paid Analysis V2

`hooks/useAnalysisV2Preflight.ts`가 idempotency key, target input, anonymous device boundary와 함께 `POST /api/analysis/preflight`를 호출한다. `app/api/analysis/preflight/route.ts`가 preflight를 생성/replay하고 generation을 예약한 뒤 dedicated worker를 enqueue하며, queue mode가 허용할 때만 bounded local fallback을 쓴다. `app/api/analysis/preflight/worker/route.ts`는 preflight/provider work와 fresh admission을 수행하고, `app/api/analysis/v2/worker/route.ts`는 Cloud Tasks V2 job contract와 durable DAG를 실행한다. V2는 checkpoint relationship, target evidence, profile batch, gender/feature stage, scoring, narrative, recovery, provider usage, result publication을 저장하고 RPC로 보호한다. Result route는 authenticated ownership과 authoritative publication 뒤 page projection을 읽는다. `app/result/[requestId]/page.tsx`는 V2 pipeline이면 V2 result를 먼저 요청하고 `V2_ROUTE_REQUIRED`면 canonical V2 URL로 이동한다.

V2 staged evidence, provider/Gemini/revenue ledger, recovery/replay, concierge correction, score audit, owner history는 durable state이며 이름 수나 403만으로 dead code가 아니다. live count가 scheduler operation, provider/Gemini ledger, preflight failure, image metadata, result activity를 보인다.

### V1 및 step 호환 경계

`app/api/analysis/run/route.ts`는 migration-only이고 기본 HTTP 410이며 explicit legacy gate와 admin authorization이 모두 있어야 한다. 그러나 `app/api/analysis/start/route.ts`는 여전히 `analysis_requests`를 생성/로드하고 old step/background fallback을 시작할 수 있다. `/status`, `/progress`, `/result`, `/step`과 owner result page는 호환 및 historical read를 보존한다. `analysis_requests`, `analysis_results`, `private_accounts`는 live count와 광범위한 정적 참조가 있으므로 drop 대상이 아니다.

V1을 V2로 consolidate하려면 완전한 observation window에서 V1 write traffic 0, scheduled job/script 호출 없음, DB function/trigger/view dependency 없음, 모든 historical result가 compatibility adapter로 조회됨, archive/restore drill 통과를 각각 기록해야 한다. migration-only 410만으로 zero traffic이나 zero DB dependency를 증명할 수 없다.

### Anonymous preflight, B-lite, admission

Anonymous preflight는 활성 funnel이다. client device boundary, IP/device/target hash budget, 30분 서명 claim, raw token 대신 claim hash, authenticated owner claim을 사용한다. Anonymous read는 raw provider image URL을 반환하지 않는다. `preflight-retention.ts`는 provider cost reconciliation 뒤 short-lived source evidence와 expired preflight를 purge하고 parent를 terminal scrub한다. attempts/cache/failure/preflight의 non-zero count는 즉시 삭제 금지의 직접 근거다.

### Instagram provider adapter

`lib/services/instagram/scraper.ts`는 profile, profilesBatch, followers, following capability를 라우팅한다. Apify, RapidAPI, self-hosted 구현과 fallback은 configuration별 운영 전환·rollback 계약이다. README와 V2 operations 문서는 public legacy self-hosted, paid authenticated-worker, manual RapidAPI/CoderX diagnostics, Apify relationship/profile provider를 구분한다. 이 switching layer는 보존한다.

### Commercial lifecycle와 media

`earlybird_orders`, `earlybird_waitlist`, webhook event, fulfillment, payment reconciliation, Discord outbox는 별도의 commercial lifecycle이다. Checkout finalization은 admission 경계를 통과하기 전 analysis request를 만들지 않는다. `payments`와 `payment_orders`는 client access가 revoke된 server-owned legacy relation이므로 직접 app `.from()` 참조가 없다는 이유로 삭제하지 않는다.

Verified endpoint의 Supabase Storage bucket은 0개다. V2 result image는 private R2와 `analysis_v2_result_image_objects` registry를 사용하며, AI source media는 private GCS workspace다. R2/GCS credential과 object path는 검사하지 않았다. External media lifecycle은 별도 dependency로 보존·감사해야 하며 Supabase Storage drop으로 대체할 수 없다.

### 정적 참조 scan

`app`, `lib`, `hooks`, `components`, `scripts`, `docs`에서 165개 live definition 중 152개 이름이 텍스트로 나타났고 13개는 나타나지 않았다: `analysis_gemini_usage_expectations`, `analysis_provider_usage_expectations`, `analysis_revenue_ai_routing_attempt_lineages`, `analysis_revenue_final_coverage_gates`, `analysis_revenue_primary_quality_checkpoints`, `analysis_revenue_resolver_passes`, `analysis_v2_result_revision_female_rows`, `analysis_v2_result_revisions`, `comment_details`, `earlybird_profile_evidence_failure_recoveries`, `earlybird_v211_concierge_publications`, `interaction_logs`, `pending_analysis`.

이 scan은 dynamic RPC 이름, SQL body, trigger, scheduled job, external dashboard, Cloud Tasks, Vercel cron, historical client를 resolve하지 않는다. 위 13개도 drop 대상이 아니며 아래 ledger에서 각각 정확히 한 번 분류된다.

## 노출된 165개 definition 전체의 classification ledger

이 ledger의 대상은 PostgREST definition 165개뿐이다( CRUD-capable relation path 164개와 read-only view path 1개). RPC path 639개는 별도의 routine surface로 집계했고 relation으로 잘못 분류하지 않았다. Routine dependency proof는 owner catalog gate로 남긴다. Label은 서로 배타적이며 의미는 하나씩만 갖는다.

- `keep`: active 또는 protected; 현재 cleanup 제안 없음.
- `consolidate`: compatibility와 traffic proof 뒤 canonical contract 또는 equivalent projection 뒤로 이동.
- `archive-then-drop`: bounded archive, restore proof, retention check, 별도 승인을 통과한 뒤의 미래 retirement 경로이며 현재 삭제 지시가 아님.
- `drop-candidate`: 현재 proof bar를 모두 통과한 객체. 없음.
- `unknown`: evidence가 불완전하거나 owner-level dependency가 있을 수 있음. 삭제하지 않음.

모든 exposed definition은 아래 complete membership set 중 정확히 하나에만 있다. 집합은 서로 겹치지 않고 합계는 165개다.

### `keep` (158)

`account_classification_audit`, `account_deletion_jobs`, `account_ledger_rollout_state`, `account_paid_evidence`, `ai_analysis_cache`, `analysis_anonymous_preflight_attempts`, `analysis_anonymous_profile_cache`, `analysis_anonymous_profile_cache_locks`, `analysis_apify_credit_snapshots`, `analysis_beta_access_grants`, `analysis_beta_access_policy`, `analysis_beta_pool_allocations`, `analysis_beta_pool_local_debits`, `analysis_beta_pool_reservation_archive`, `analysis_beta_pool_reservations`, `analysis_beta_runtime_gate`, `analysis_gemini_usage_expectations`, `analysis_interaction_evidence`, `analysis_interaction_jobs`, `analysis_interaction_scores`, `analysis_lifecycle_events`, `analysis_pipeline_jobs`, `analysis_preflight_acquisition_cost_events`, `analysis_preflight_failures`, `analysis_preflight_provider_runs`, `analysis_preflights`, `analysis_progress_events`, `analysis_progress_state`, `analysis_provider_cost_ledger`, `analysis_provider_runs`, `analysis_provider_usage_expectations`, `analysis_requests`, `analysis_result_share_observations`, `analysis_results`, `analysis_revenue_ai_routing_attempt_lineages`, `analysis_revenue_cost_operations`, `analysis_revenue_dispatch_guards`, `analysis_revenue_final_coverage_gates`, `analysis_revenue_fresh_provider_evidence`, `analysis_revenue_primary_quality_checkpoints`, `analysis_revenue_resolver_capacity_reservations`, `analysis_revenue_resolver_outcome_overlays`, `analysis_revenue_resolver_passes`, `analysis_revenue_run_ledgers`, `analysis_step_events`, `analysis_target_interactors`, `analysis_v2_active_profile_heartbeats`, `analysis_v2_ai_attempts`, `analysis_v2_ai_global_result_cache`, `analysis_v2_ai_result_checkpoints`, `analysis_v2_ai_scoring_stage_checkpoints`, `analysis_v2_apify_secret_ref_prune_guard`, `analysis_v2_candidate_feature_manifests`, `analysis_v2_candidate_feature_rows`, `analysis_v2_candidate_score_manifests`, `analysis_v2_candidate_score_rows`, `analysis_v2_dag_batch_results`, `analysis_v2_dag_batch_topology`, `analysis_v2_dag_scopes`, `analysis_v2_dag_stage_manifests`, `analysis_v2_failure_receipts`, `analysis_v2_female_results`, `analysis_v2_gemini_leases`, `analysis_v2_gender_resolution_metrics`, `analysis_v2_gender_routing_candidates`, `analysis_v2_gender_routing_manifests`, `analysis_v2_media_artifacts`, `analysis_v2_mutual_rows`, `analysis_v2_narrative_manifests`, `analysis_v2_narrative_rows`, `analysis_v2_partner_safety_manifests`, `analysis_v2_partner_safety_rows`, `analysis_v2_preliminary_score_manifests`, `analysis_v2_preliminary_score_rows`, `analysis_v2_private_name_manifests`, `analysis_v2_private_name_rows`, `analysis_v2_private_results`, `analysis_v2_profile_fetch_batches`, `analysis_v2_profile_fetch_outcomes`, `analysis_v2_profile_fetch_telemetry`, `analysis_v2_profile_provider_canary_experiments`, `analysis_v2_profile_provider_canary_runs`, `analysis_v2_profile_repair_canary_runs`, `analysis_v2_provider_cleanup_intents`, `analysis_v2_provider_execution_policies`, `analysis_v2_provider_runs`, `analysis_v2_recovery_provider_run_adoptions`, `analysis_v2_relationship_manifests`, `analysis_v2_relationship_rows`, `analysis_v2_relationship_sides`, `analysis_v2_replay_capture_audit_events`, `analysis_v2_replay_capture_authorizations`, `analysis_v2_replay_capture_fragments`, `analysis_v2_result_coverage_telemetry`, `analysis_v2_result_image_manifests`, `analysis_v2_result_image_objects`, `analysis_v2_result_image_purge_outbox`, `analysis_v2_result_revision_female_rows`, `analysis_v2_result_revisions`, `analysis_v2_result_summaries`, `analysis_v2_reverse_like_manifests`, `analysis_v2_reverse_like_rows`, `analysis_v2_scheduler_operations`, `analysis_v2_score_audit_intents`, `analysis_v2_score_audit_rows`, `analysis_v2_score_audit_runs`, `analysis_v2_score_audit_scan_locators`, `analysis_v2_score_audit_source_rows`, `analysis_v2_score_audit_sources`, `analysis_v2_selfhosted_auth_runs`, `analysis_v2_target_evidence_manifests`, `analysis_v2_test_entitlement_consumptions`, `analysis_v2_unconfirmed_start_resolutions`, `comment_details`, `earlybird_adoption_policy_failure_rearms`, `earlybird_checkout_reconciliations`, `earlybird_concierge_batch_cohort_members`, `earlybird_concierge_batch_target_lineage_repairs`, `earlybird_concierge_snapshot_conflict_recoveries`, `earlybird_first15_canary_provider_rearms`, `earlybird_fulfillments`, `earlybird_orders`, `earlybird_partial_adoption_second_rearms`, `earlybird_payment_discord_outbox`, `earlybird_pfe3_media_artifact_rearms`, `earlybird_pfe_target_evidence_start_rejection_rearms`, `earlybird_plan_inventory`, `earlybird_profile_evidence_failure_recoveries`, `earlybird_profile_fetch_exhaustion_recoveries`, `earlybird_schema_failure_recoveries`, `earlybird_terminal_unavailable_exhaustion_rearms`, `earlybird_v211_apify_transient_admission_resumes`, `earlybird_v211_apify_transient_replays`, `earlybird_v211_concierge_copy_corrections`, `earlybird_v211_concierge_publications`, `earlybird_v211_concierge_replays`, `earlybird_v211_lease_policy_failure_rearms`, `earlybird_v211_policy_identity_replays`, `earlybird_v211_profile_ai_diagnostic_replays`, `earlybird_v211_relationship_lineage_failure_rearms`, `earlybird_v212_concierge_copy_corrections`, `earlybird_v213_concierge_copy_corrections`, `earlybird_v214_concierge_gemini_copy_corrections`, `earlybird_waitlist`, `earlybird_webhook_events`, `gemini_token_usage`, `interaction_logs`, `kakao_signup_discord_outbox`, `landing_leads`, `precheckout_blite_cache`, `precheckout_blite_dispatches`, `precheckout_blite_sources`, `private_accounts`, `result_feedback`, `scraper_provider_usage`, `selfhosted_profile_request_start_gate`, `sentry_discord_alert_outbox`, `users`

### `consolidate` (1)

`analysis_operational_cost_summary`

이 view는 live이며 accessible exact row 391개가 있다. 교체 시 equivalent columns, authorization, historical read, aggregate semantics를 먼저 보존해야 한다.

### `archive-then-drop` (3)

`account_e2e_test_runners`, `demo_analysis_fixtures`, `demo_analysis_runs`

이는 미래의 별도 승인 경로다. sanitized aggregate preflight, explicit identity allowlist, archive/restore proof, 필요한 경우 Auth deletion proof, post-operation verification이 모두 필요하다. 현재 작은 count는 삭제를 승인하지 않는다.

22개 E2E identity는 owner가 제공한 expected set이며 새로 입증한 live count가 아니다. 구성은 email이 `e2e`로 시작하는 Kakao user 20명과 `provider=e2e` user 2명이다. 이 감사에서는 해당 identity를 읽거나 live membership을 증명하지 않았다. 향후 어떤 mutation을 하기 전에도 이 expected set에 대한 sanitized aggregate exact-count 및 exact-membership preflight를 실행해야 하며, count 또는 membership이 하나라도 다르면 즉시 중단한다.

### `unknown` (3)

`payment_orders`, `payments`, `pending_analysis`

세 definition은 unresolved live definition이다. `payments`와 `payment_orders`는 server-owned legacy boundary이며 conditional source RLS target array로 coverage된다. `pending_analysis`는 exact 11행이고 현재 source RLS-enable 근거가 없다. retention을 결정하기 전에 owner-level relation kind, grant, policy, dependency, historical provenance를 확인한다.

### `drop-candidate` (0)

노출된 definition 없음.

어떤 분류도 DDL을 승인하지 않는다. 미래 retirement 대상 세 definition은 현재 drop candidate가 아니다. 미확정 세 definition에는 cleanup 지시를 부여하지 않는다.

## 반드시 보존할 데이터 및 identity 정책

1. **Retention floor:** persistent non-admin, non-E2E user-linked record에 대한 보수적이고 inclusive한 floor는 `2026-07-24 00:00 Asia/Seoul`이다. 해당 시각 이후 및 그 시각을 포함하는 record는 보존한다. “legacy”라는 이유로 table-wide delete를 하지 않는다. floor 이전 timestamp도 그 자체로 cleanup을 승인하지 않으며, timestamp·ownership·identity classification이 불명확한 record는 exact evidence가 확인될 때까지 차단한다.
2. **Admin identity 및 test 범위:** admin/operator account와 classification을 보존한다. 별도로 owner가 승인한 정확히 지정된 administrator test-order cleanup operation은 과거의 특수 범위 작업이며, 이 감사에서는 승인하거나 실행하지 않았다. 이를 다른 admin, E2E 또는 external record로 일반화하지 않는다.
3. **E2E identity set:** 22개 E2E identity는 owner가 제공한 expected set이며 새로 입증한 live count가 아니다. email이 `e2e`로 시작하는 Kakao user 20명과 `provider=e2e` user 2명으로 구성된다. 이들은 이번 감사의 mutation 범위 밖에 있다. 향후 mutation 전에는 sanitized aggregate exact-count 및 exact-membership preflight를 요구하고, mismatch이면 즉시 중단한 뒤 별도 승인된 identity allowlist, Auth deletion proof, post-delete verification gate를 적용한다.
4. **Landing target/excluded 분리:** `landing_leads`는 input과 attribution field를 가지며 service-owned다. funnel metric에서 analysis target과 명시적 excluded target을 구분하고 paid metric에 섞지 않는다.
5. **Waitlist와 withdrawn archive:** `earlybird_waitlist`는 active waitlist로 유지한다. withdrawn는 별도 access-controlled archive 또는 immutable lifecycle 경계로 분리하고 waitlist state에 덮어쓰지 않는다. 이 감사에서는 dedicated live withdrawn relation을 확인하지 못했으므로 future design은 승인 전까지 unknown이다.
6. **Stable anonymous-to-auth mapping:** 기존 opaque claim/hash와 device boundary를 보존한다. mutable email, username, raw token을 analytics identity로 사용하지 않고 preflight를 authenticated owner에 한 번만 claim한다. 이미 owner가 있는 preflight를 재claim할 때 owner row를 보존한다.
7. **Paid-only `first_paid_at`:** account-principal bridge의 external classification과 immutable provider/payment evidence가 있을 때만 earliest timestamp를 monotonic하게 기록한다. status string, 양수 금액, E2E/admin order, `payment_pending`, refund만으로 paid-ever 또는 `first_paid_at`을 만들지 않는다.
8. **Short-lived TTL artifact 및 abandoned `payment_pending`:** abandoned `payment_pending` order와 expired preflight/source/cache row처럼 이전에 승인된 short-lived TTL artifact는 persistent user-linked record와 별도 class이며 age만으로 정리하지 않는다. 정리하려면 exact artifact ownership 및 identity classification, exact TTL 만료, 해당되는 terminal provider/payment/media evidence, auditable disposition이 필요하다. External user의 pending order는 independent provider evidence 없이 절대 변경·삭제하지 않으며 TTL 만료만으로는 충분하지 않다. Immutable pricing/payment lineage를 보존하고 unresolved order를 피하려고 새 order를 만들지 않는다.
9. **Media와 provider evidence:** external R2 deletion이 확인될 때까지 result-image registry row를 보존한다. ambiguous provider-start ledger는 provider outcome이 resolve될 때까지 보존한다. missing response/object를 “not executed”로 추정하지 않는다.

## 안전한 향후 cleanup 순서

이 순서는 절차 설명이며 executable SQL을 포함하지 않는다.

1. **Owner proof:** 같은 endpoint의 read-only catalog snapshot으로 relation, column, PK/UNIQUE, FK, view/matview, sequence, routine, trigger, policy, RLS/force-RLS, grant, publication, `pg_depend`, migration history를 확인한다. object metadata와 aggregate count만 export한다.
2. **Traffic proof:** 완전한 observation window에서 route/job/RPC access를 측정한다. V1 write quietness와 V1 historical read를 분리하고 Cloud Tasks, cron, script, dashboard, external operator를 포함한다.
3. **Compatibility boundary:** canonical V2 owner-history/result projection이 보존 대상 V1 result를 모두 제공하게 한다. request ID와 owner authorization을 보존하고 historical row identity를 다시 쓰지 않는다.
4. **Archive proof:** encrypted access-controlled archive, aggregate manifest, restore verification을 만든다. `2026-07-24 00:00 Asia/Seoul` 이후 및 해당 시각을 포함하는 persistent non-admin, non-E2E user-linked record를 destructive scope에서 제외하고 admin/auth identity를 별도로 보존한다. 별도 승인된 short-lived TTL artifact는 exact ownership/identity와 provider/payment/media gate를 통과한 뒤에만 따로 처리하며, payment/provider evidence는 retention을 검토하기 전에 archive한다.
5. **Reference migration:** caller를 surface별로 옮기며 sanitized aggregate mismatch만 기록한다. rollback window 동안 old path는 read-only로 둔다.
6. **Retention gate:** 별도 승인된 short-lived TTL artifact(예: abandoned `payment_pending`, preflight/source/cache row) 중 exact ownership/scope, TTL, provider cost, payment disposition, lease, external object가 terminal/reconciled인 것만 정리한다. retention floor 이상인 persistent user-linked record, payment evidence, account identity, result ownership, legal/operational audit row는 보존한다.
7. **Object-removal approval:** 이전 gate가 통과한 뒤에만 owner가 정확한 migration allowlist를 승인한다. migration order, dependent routine, trigger, policy, publication, grant, rollback을 검토한다. 이 감사에는 migration file이나 executable SQL이 없다.
8. **Post-removal verification:** catalog·aggregate, route smoke test, owner-history, payment/recovery, media access/purge, secret scan을 다시 확인하고 합의된 기간 archive와 rollback evidence를 보존한다.

## 삭제를 막는 미확인 사항

- 구성 endpoint가 실제 production `yeosachin` project인지 management-plane confirmation과 read-only catalog snapshot이 필요하다. 현재 환경은 endpoint/schema fingerprint만 확인했다.
- 165개 전체 definition, 특히 105개 denied와 13개 static-ref 부재 이름의 live relation kind, partition flag, size, row estimate, current column, PK/UNIQUE, FK, policy, grant, trigger, publication membership, `pg_depend`가 필요하다.
- 원격에 적용된 migration version이 무엇이며 354개 source와 정확히 일치하는지 확인해야 한다. 보호된 reconciliation migration은 변경하지 않는다.
- dynamic RPC, external job, cron, dashboard, historical client가 long-tail RPC나 V1 endpoint를 호출하는지 확인해야 한다.
- `2026-07-24 00:00 Asia/Seoul` 전후 data를 persistent non-admin/non-E2E user-linked record와 별도 승인된 short-lived TTL artifact로 나누고 account classification/lifecycle별 aggregate로 확인해야 하며 row export는 하지 않는다.
- owner가 제공한 E2E expected set(email prefix `e2e`인 Kakao user 20명과 `provider=e2e` user 2명)이 exact-count 및 exact-membership preflight를 통과하는지 확인해야 한다. mismatch이면 향후 mutation을 중단한다.
- independent provider evidence가 있는 payment와 abandoned/recoverable `payment_pending`을 구분해야 한다. 이 감사에서는 payment 상태를 변경하지 않았다.
- R2/GCS object의 age/terminal/orphan aggregate가 필요하다. object name/path는 남기지 않고 storage owner 승인 뒤 metadata만 읽는다.

## 보안 및 운영 메모

검사한 경로에서 service-role 경계는 server-only로 유지된다. cleanup을 쉽게 하려고 browser에 노출하거나 revoked client grant를 약화하지 않는다. Anonymous claim은 claim과 rate-limit input을 hash하고 lifetime을 제한하며 anonymous projection에서 raw image URL을 제외한다. Result/media route의 owner/admin authorization, no-store, opaque media reference, R2 integrity check도 canonical path의 dependency로 보존한다.

HTTP 403 105개는 internal surface의 direct Data API 접근이 제한된다는 positive signal이다. 후속 catalog export도 최소 owner-authorized read-only 경로만 사용하고 object name, boolean, aggregate count만 반환해야 한다. secret, cookie, raw identifier, provider payload, claim token, media URL, raw user content를 log하거나 commit하지 않는다.

## 감사 ledger 및 검증

- 수정 작업은 `c507254f68a72bc3de8e243fdb6827eb25710031` 위에서 수행했고, 감사 source baseline은 `origin/main`의 `2a28326462bf636f92368dc894b5ea76911d79bb`로 유지했다.
- 보호된 `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql`은 tracked 및 unchanged로 보존했다.
- 기존 unrelated `package-lock.json` worktree 변경은 보존하고 stage하지 않았다.
- live 확인은 OpenAPI definition/path, relation HEAD count header, accessible exact count, 403 총계, Storage bucket count의 aggregate/metadata pass만 사용했다.
- whitespace-normalized RLS count, dynamic RLS target coverage, source/live table alignment, qualified/unqualified FK count, complete realtime publication membership, relation/RPC reference, route/store/provider map, 문서 cross-reference를 점검했다.
- 두 보고서는 service-role/password/connection-string/Bearer/JWT 및 identifier-like email/UUID pattern을 secret-scan했다.
- 별도 owner 승인 administrator test-order cleanup operation은 과거의 특수 범위 context로만 기록했으며, 이 감사에서는 승인하거나 실행하지 않았고 external-user `payment_pending` provider-evidence gate를 완화하지 않는다.
- production mutation, migration repair, DDL, DML, mutation RPC, provider call, deployment는 없었다.
