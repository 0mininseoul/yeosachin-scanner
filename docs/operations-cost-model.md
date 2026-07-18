# V2 운영 비용 모델

기준일: 2026-07-17. 이 문서는 현재 V2 코드의 **과금 단위와 측정 방법**을 정리한다. 2026-07-17 Standard E2E는 실패했으며 V2 유료 성공 E2E가 아직 끝나지 않았으므로 건당 달러 원가와 최종 판매가는 확정하지 않는다. Actor 콘솔 가격, 과거 V1 canary, 환경변수의 예산 상한을 V2 실측 원가로 대체해서는 안 된다.

## 플랜 범위

정본은 `lib/domain/analysis/plan-catalog.ts`다.

| 플랜 | followers 상한 | following 상한 | 상세 분석 맞팔 상한 |
|---|---:|---:|---:|
| Basic | 400 | 400 | 300 |
| Standard | 800 | 800 | 600 |
| Plus | 1,200 | 1,200 | 900 |

- followers와 following 중 하나라도 상한을 넘으면 해당 플랜을 선택할 수 없다.
- Plus 상한을 넘는 계정은 현재 지원하지 않는다.
- 상세 분석 상한은 관계 목록 수집 상한과 다르다. 관계 교집합 전체를 계산한 뒤 정본 순서로 최대 300/600/900명만 프로필·AI 상세 단계에 보낸다.
- 런타임 카탈로그 판매가는 `pricingVersion=deferred`다. V2 성공 E2E와 비용 대사가 끝나기 전에는 애플리케이션 UI·설정이나 일반 운영 문서에 런타임 가격을 하드코딩하지 않는다. 아래 Groble 채널 표시안만 이 문서에 둔 예외이며 런타임 가격이나 최종 판매가가 아니다.

## Groble 얼리버드 표시안 (성공 E2E 후 확정)

아래 표는 런타임 카탈로그와 분리된 **잠정 Groble 채널 제안**이다. 성공 E2E와 Groble 상품 심사를 모두 통과한 뒤에만 확정하며, 애플리케이션의 `pricingVersion=deferred`를 변경하지 않는다. 결제 연동은 이 문서와 authorized E2E 범위 밖이며 다른 브랜치에서 진행한다.

| 플랜 | 기준가 | 얼리버드 결제액 | 제공 방식 |
|---|---:|---:|---|
| Basic | 39,900원 | 14,900원 | 결제 후 48시간 이내 수동 전달 |
| Standard | 69,900원 | 19,900원 | 결제 후 48시간 이내 수동 전달 |
| Plus | - | 대기 신청 | 대기 신청 |

Basic과 Standard는 각각 독립적으로 선착순 10건씩만 받는 표시안이다. 이 수량과 금액은 성공 E2E 및 Groble 상품 심사 전에는 게시·판매 조건으로 확정하지 않는다.

## V2 과금 경로

결제 전 대상 프로필 사전 점검은 로그인 없는 자체 summary 수집을 먼저 시도한다. 대상 없음이 자체 수집에서 명시적으로 확인되면 유료 fallback을 실행하지 않는다. 분류된 자체 provider 실패일 때만 최초 preflight operation과 각 fresh-admission generation이 각각 Apify profile fallback 1회를 허용한다. fresh-admission fallback은 최신 게시물 parser가 최대 10건까지 검증한 bounded full-profile snapshot/schema를 통과한 뒤만 해당 run을 schema v1으로 표시한다. 각 실행 전 별도의 원장 행을 예약하고 `maxTotalChargeUsd=$0.0026`을 고정하며, 같은 operation/generation의 retry는 저장된 run ID만 재개한다. 최초 실행과 fresh generation 1회가 모두 fallback하면 합산 상한은 `$0.0052`다. Instagram 로그인 쿠키나 세션은 전달하지 않는다.

1. 대상/공개 맞팔 프로필은 로그인 없는 자체 수집기를 먼저 사용한다.
2. 자체 수집의 username별 terminal 결과를 먼저 저장하고, **그 스냅샷에서 정확히 unresolved인 username만** Apify profile fallback 입력으로 고정한다. target-evidence는 현재 consumed preflight의 같은 target/generation에 schema-v1 표시된 fresh run이 있으면 그 dataset을 1회 재해석한다. 이 경우 새 Actor나 `analysis_v2_provider_runs` 행을 만들지 않고 비용은 preflight에만 귀속한다. 표시된 run이 없으면 기존 bound fallback을 실행한다.
3. followers/following은 Apify 관계 Actor로 수집하고, 각 방향에서 선언 수의 99% 고유 커버리지를 만족하지 못하면 결과를 만들지 않는다.
4. 대상 상호작용은 최신 게시물 중 liker 최대 `4 x 150 = 600`, comment 최대 `6 x 15 = 90`을 수집한다.
5. 역방향 좋아요는 예비점수 상위 후보 `K<=10`의 최신 게시물 1개에서 후보당 최대 100명을 수집한다.
6. 역방향 대상 계정이 반환 목록에 있으면 양의 관측이다. 대상이 없더라도 게시물 전체 liker 수가 100 이하이고 고유 반환 수가 그 전체 수를 덮을 때만 부재를 확정한다. 예를 들어 `100/114`나 `109/114`는 부재가 아니라 `not_collected`다.
7. Gemini는 성별 triage, 라우팅된 여성 feature 분석, shortlist partner-safety, 대표 고위험 narrative로 나뉜다. 영구 미디어 부분 실패나 구조적 snapshot 누락은 부정 근거로 쓰지 않는다.

자체 프로필 시작은 production에서 Supabase singleton RPC를 통해 Vercel과 모든 Cloud Run instance를 합쳐 예약한다. 기본 750ms 간격에 100ms response guard를 더한 유효 slot은 850ms다. 237건은 첫 시작부터 마지막 시작까지 200.6초, 운영 예산상 약 201초가 필요하며 response tail은 별도다. admission 예약은 최대 500ms, full-profile 예약은 최대 60초만 기다리고 RPC 자체는 750ms에 hard timeout된다. 300ms process-local gate와 circuit은 defense in depth로 유지한다. coordination 실패나 response guard 초과는 Instagram 요청 전에 fail-closed 되고 기존 fallback 정책이 다음 경로를 결정하므로, 직접 수집 요청 수는 늘지 않지만 fallback 비용 가능성은 남는다. 이 제한은 burst를 줄일 뿐 Instagram의 로그인 없는 요청 수락을 보장하지 않는다.

FlashAPI, CoderX, Stable RapidAPI는 V2 production DAG에 포함하지 않는다.

## 캐러셀 슬라이드 캡션 증분 비용 제약

기존 profile dataset item에 이미 포함된 자식 캡션만 사용하며, 제공자 선택과 V2 DAG 토폴로지는 바꾸지 않는다.

| 증분 항목 | 변화량 |
|---|---:|
| Apify Actor runs | 0 |
| Apify dataset items | 0 |
| Gemini generation calls | 0 |
| DAG jobs | 0 |

- feature 단계의 슬라이드 캡션은 기존 부모 캡션 evidence row를 대체하며, 새 AI 호출이나 별도 캡션 row fanout을 추가하지 않는다.
- partner contact-sheet 캡션과 high-risk narrative dossier는 같은 결정적 정책에서 나온 발췌문을 재사용한다. partner 캡션 표시 문자 합계와 dossier 전체는 각각 최대 2,000자이다.
- input token 과금은 이 고정 상한 안에서 변할 수 있으며, 문자 그대로 0원 증가를 보장하지 않는다. 출시는 유료 E2E의 전체 비용과 wall time p95 비회귀 gate를 통과해야 한다.

## Profile fallback replacement canary 비용 경계

공식 `apify/instagram-scraper` build `0.0.692`를 검증하는 replacement canary는 제품 건당
원가가 아니라 별도 R&D 표본이다. Actor가 현재 표시하는 결과당 약 `$0.0027`은 계획값일
뿐이며, 15개 입력의 예상액은 약 `$0.0405`다. 실행 직전 가격과 build를 다시 확인하고,
코드에 고정된 최대 과금은 repetition당 `$0.05`, 두 repetition 합계 `$0.10`이다.
현재 가격은 `PAY_PER_EVENT`의 단일 primary `result` 이벤트와 계정 `plan.tier`별
`eventTieredPricingUsd`에서 읽는다. 실행기는 현재 tier뿐 아니라 선언된 모든 알려진 tier의
15건 금액을 보수적으로 상한 검사하며 추가 이벤트, 알 수 없는 tier, flat/tiered 중복을
모두 거부한다.

- 각 repetition은 정확히 15개 공개 프로필만 받으며 15/15 strict 결과, critical 3/3,
  60초 이하, exact build, `RESTRICTED` run access, stable actual cost를 모두 통과해야 한다.
- 실제 사용액은 청구 진실을 보존하기 위해 run당 `$1.00` incident bound까지 기록한다.
  `$0.05` 초과는 품질 gate 실패이고 다음 repetition을 금지하지만, 비용 대사와 KVS,
  dataset, request queue 및 retained source storage 정리는 계속한다. `$1.00` 초과는
  자동 분류하지 않고 incident로 중단한다.
- 이전 `instagram-profile-scraper` canary repetition 1의 `$0.039`와 새 replacement canary
  actual은 모두 `C_provider` 제품 원가에서 제외하고 R&D 비용으로 별도 보고한다.
- 새 Actor를 V2 제품 원가의 `u_profile`로 반영하는 시점은 두 canary repetition 통과,
  authorized Standard E2E 성공, 모든 provider actual 대사, storage cleanup 완료 이후다.
  그 전까지 아래의 플랜별 비용 표는 계속 `미측정`이다.

## 건당 비용 식

V2 E2E에서 아래 변수를 preflight별 원장과 분석 요청별 원장으로 측정한다.

- `F`, `G`: 관계 Actor가 실제 반환한 followers/following 과금 행
- `P`: preflight에 예약된 Apify target-summary operation 수. 최초 operation은 `0..1`, 각 fresh-admission generation도 `0..1`이며 같은 generation retry는 `P`를 늘리지 않는다.
- `B`: 자체 수집 실패 후 새 Apify profile Actor fallback으로 고정된 정확한 unresolved 수. preflight fresh run을 재해석한 target은 중복 과금 행이 아니므로 `B`에 더하지 않는다.
- `LT`: 대상 게시물 liker 과금 행, `0 <= LT <= 600`
- `CT`: 대상 게시물 comment 과금 행, `0 <= CT <= 90`
- `R_i`: shortlist 후보 `i`의 역방향 liker 과금 행, `0 <= R_i <= 100`, `K <= 10`
- `T_s,in`, `T_s,out`, `T_s,think`: Gemini 단계 `s`의 실제 input/output/thinking token
- `CPU`, `MEM`, `TASK`: Cloud Run CPU·메모리 시간과 Cloud Tasks operation

Actor별 실제 단가를 각각 `u_preflight,j`, `u_rel`, `u_profile`, `u_liker`, `u_comment`라 하면 외부 수집 비용은 다음과 같다. `u_preflight,j`는 operation `j` 종료 30초 후 인증된 run 재조회로 확정한 `usageTotalUsd`이며 각각 `0 <= u_preflight,j <= $0.0026`이다.

```text
C_provider = sum(u_preflight,j, j=1..P)
           + (F + G) * u_rel
           + B * u_profile
           + LT * u_liker
           + CT * u_comment
           + sum(R_i * u_liker, i=1..K)
```

Gemini와 GCP 비용은 실제 billing meter로 계산한다.

```text
C_gemini = sum(model_price_s(T_s,in, T_s,out, T_s,think))
C_gcp     = cloud_run_price(CPU, MEM) + cloud_tasks_price(TASK)
C_total   = C_provider + C_gemini + C_gcp
```

GCP `$300` credit은 현금 청구 시점을 늦출 뿐 `C_gemini`와 `C_gcp`의 경제원가를 0으로 만들지 않는다. Apify 비용에는 적용되지 않는다.

`C_total`은 소비된 preflight의 모든 operation별 `u_preflight,j`를 해당 분석에 귀속한다. 사전 점검 후 결제/분석으로 전환되지 않고 만료·이탈한 preflight도 최초 fallback이 실행됐다면 최대 `$0.0026`의 획득 원가가 이미 발생한다. 유료 전환 경로에서 최초와 fresh generation 1회가 모두 fallback하면 최대 `$0.0052`이며, 추가 fresh generation이 생성되면 각 세대의 실제액을 더한다. 기간 총원가와 판매가 산정은 성공 분석만 모수로 보지 말고, 모든 생성 preflight operation의 실제액을 합산한 뒤 유료 전환 건에 배부해야 한다. Apify fallback이 대상 없음을 확인한 경우에도 유저 결제는 없지만 이 운영 원가는 발생할 수 있다.

## 현재 측정 상태

| 항목 | Basic | Standard | Plus |
|---|---:|---:|---:|
| V2 provider 건당 비용 | 미측정 | 미측정 | 미측정 |
| V2 Gemini 건당 비용 | 미측정 | 미측정 | 미측정 |
| V2 Cloud Run/Tasks 건당 비용 | 미측정 | 미측정 | 미측정 |
| V2 전체 wall time p50/p95 | 미측정 | 미측정 | 미측정 |
| E2E 기반 최종 판매가 | 보류 | 보류 | 보류 |

2026-07-13의 `0_min._.00` 완료 canary와 그 이전 비용표는 V1 순차 실행, 과거 plan 상한, 과거 batch fallback, 다른 Gemini fanout을 사용했다. 관계/Actor 기능 진단 자료로는 남기되 V2 가격이나 5분 SLA 근거로 사용하지 않는다.

### 2026-07-17 Standard 실패 E2E 비용 하한

Preflight `3d6759a9-948c-4de1-be7a-d02aa72ed8fd`에서 대상 `0_min._.00`의 Standard 요청 `b27bc417-5e45-41b1-aad3-af733fdbb954`를 실행했다. 요청은 완료되지 않았으므로 이 기록은 성공 표본, p50/p95, 5분 SLA 또는 최종 판매가의 근거가 아니다.

- 전체 wall time은 `1,308,289ms`(`21m48.289s`), queue는 `978ms`, processing은 `1,307,311ms`였다. 21개 job 중 11개가 완료되고 1개가 실패했으며 9개가 취소됐다. `private-names` batch 1이 7회 시도를 소진했고 sibling AI checkpoint job들이 취소됐다.
- 첫 번째 원인은 private-name topology content hash를 독립된 scope의 consumer job hash와 잘못 비교한 것이었다. 두 번째 원인은 executor가 `verified_female`에만 media bundle을 저장하는데도 candidate feature 완료 조건이 non-`verified_female` 분류에도 media bundle을 요구한 것이었다. Forward migration `20260717120000_fix_analysis_v2_checkpoint_contracts.sql`과 PGlite tests는 이 계약을 교정하지만, 아직 배포됐거나 성공 E2E로 검증됐다고 기록하지 않는다.
- 요청에 귀속된 provider run 12개는 모두 정산됐고 actual은 정확히 `$2.1816`이다. Preflight actual `$0.0052`는 별도다.
- Gemini는 400 attempts에 대해 `$0.57216325`가 추정됐지만 feature-analysis의 `response-rejected` attempt 2개는 usage가 누락되거나 malformed였다. 따라서 `costComplete=false`이며 요청 비용은 `$2.75376325` 이상, preflight를 포함한 end-to-end 비용은 `$2.75896325` 이상이다. GCP infrastructure와 usage가 불명확한 두 Gemini 호출의 비용은 이 하한에 포함되지 않는다.
- AI/provider generation 대부분은 약 `3m10`에 끝났고 나머지 약 `18m38`은 checkpoint retry와 cancellation 지연이었다. 이는 교정 후 5분 미만 가능성을 시사할 뿐 입증하지 않는다.
- candidate 상세 profile은 236개였다. 직접 `selfhosted` 성공은 0개였고 rate-limit outcome 6개와 Instagram 요청을 보내지 않은 global-gate/circuit outcome 약 230개가 기록됐다. 정확히 unresolved인 계정만 Apify candidate fallback 대상으로 삼았으며 이 실행에서는 236개 모두 unresolved였다. Fallback은 227개 성공, 9개 incomplete/unavailable이었고, target을 포함한 aggregate는 228개 성공, 9개 incomplete였다. Cloud Run datacenter egress는 self-hosted-only profile 수집의 launch blocker로 남는다.
- 요청이 upstream에서 실패했으므로 candidate liker stage는 실행되지 않았다.

## V2 E2E 측정 절차

1. Basic/Standard/Plus 각각 동의받은 fixture를 준비하고, cold와 warm cache를 분리한다.
2. 모든 생성 preflight의 operation별 key·generation·run id·상한·실제액과 유료 분석 전환 여부를 기록한다. 관계 선언/반환/고유 수, 정확한 `B`, `LT`, `CT`, 각 `R_i`, 분석 Actor run id와 실제 청구액도 함께 기록한다.
3. Gemini 단계별 model, thinking level, 이미지 수, input/output/thinking token, cache hit, latency, 추정액을 기록한다.
4. Cloud Run instance CPU·메모리 시간, Cloud Tasks delivery/retry 수, 전체 wall time을 기록한다.
5. 요청의 provider run 수와 AI attempt 수가 사전 고정 DAG와 일치할 때만 `cost_complete=true`로 본다.
6. 각 플랜에서 성공 표본과 오류/재시도 표본을 모두 모아 p50, p95, 최대값을 계산한다.
7. 5분 p95, 원가 대사, 중복 과금 0건을 통과한 뒤 판매가와 결제를 확정한다.

## 원장과 운영 조회

- `analysis_v2_provider_runs`: V2 Actor 예약, run id, terminal 상태, 실제 사용액과 비용 상한
- `analysis_preflight_provider_runs`: 최초 preflight와 fresh-admission generation별 Apify target-profile summary fallback의 복합 operation 원장. 각 행은 예약, run id, credential slot, `$0.0026` 상한, terminal 상태, provider `finishedAt`이 최소 30초 지난 후의 실제 사용액을 가진다. 만료·이탈 preflight도 모든 operation 행의 정산 전에는 원장을 삭제하지 않는다.
- `analysis_v2_ai_attempts`: V2 Gemini attempt, token, thinking, latency, 추정 비용
- `analysis_pipeline_jobs`: stage별 시도, 시작/완료, 오류와 wall time 계산 근거
- `analysis_v2_profile_fetch_*`: 자체 결과와 exact unresolved fallback 집합
- `analysis_progress_state`, `analysis_progress_events`: 사용자용 정리된 진행 상태

- `analysis_v2_profile_fetch_telemetry`: profile working set 삭제 후에도 남는 request/job/source/status/failure category/HTTP status별 outcome, request, latency 집계. 일반 profile batch뿐 아니라 대상 계정 수집(`track:target-evidence:collect`)도 포함한다.
- `analysis_v2_result_coverage_telemetry`: result working set과 독립적으로 남는 plan과 followers/following/mutual/screening coverage 숫자

`/api/admin/analysis-observability?requestId=<uuid>`는 먼저 service-role 전용
`load_analysis_v2_operational_observability` RPC로 V2 요청인지 확인한다. V2면 아래를
반환하고, V2가 아니면 기존 V1 `analysis_operational_cost_summary` 및 step event 조회를
그대로 사용한다.

이 endpoint와 RPC는 분석 요청 단위 관측이며 별도 preflight 원장의 만료·이탈 비용을
기간 합계로 집계하지 않는다. 가격·전환 원가 대사의 preflight 정본은 service-role 전용
`aggregate_analysis_preflight_acquisition_costs(start_date, end_date_exclusive)` RPC다. 이
RPC는 `STABLE` 단일 statement snapshot에서 장기
`analysis_preflight_acquisition_cost_events`의 확정 비용과, 같은 UTC 예약 기간에
속한 현재 `starting/running/terminal actual-null` 원장의 보수적 최대 노출을 함께 반환한다.
`hasUnsettled=true` 또는 `isComplete=false`이면 그 기간의 비용은 아직 확정되지 않은 것이며,
`analysis_preflight_provider_runs`를 직접 조회하거나 확정 이벤트만 합산해 0원으로 간주하지 않는다.

- provider actual: 실제 사용액이 정산된 run의 합
- provider conservative: 정산된 run은 actual, active/미정산 run은 `max_charge_usd`로 합산
- Gemini estimated: terminal AI attempt에 저장된 `estimated_cost_usd`의 합
- completeness: provider active/미정산, AI reserved/usage missing, job status와 result coverage 유무
- timing: request 생성부터 현재/완료까지의 wall time, 첫 job 시작 전 queue delay, 첫 시작 이후 processing time, provider runtime, Gemini latency, job별 attempt·duration
- profile/result: username을 제외한 source/status/failure category/HTTP status별 outcome 집계와 plan/coverage 숫자. 따라서 자체 크롤러의 403, 429, 5xx를 계정 식별 정보 없이 구분한다.

V2 관측 원가는 `provider actual/conservative + Gemini estimated`이다. Cloud Run, Cloud Tasks,
네트워크 등 GCP infrastructure는 이 RPC의 숫자에 **포함하지 않으며**, 응답의
`gcpInfrastructureIncluded=false`로 명시한다. 원본 username, profile, prompt, evidence, provider
input/run id, lease/fence 값은 telemetry 테이블과 RPC 응답에 포함하지 않는다.

## 출시 판단

- 무료 Apify 계정 여러 개를 production quota 우회용으로 자동 회전하지 않는다. 테스트 credential slot은 명시적 canary와 장애 복구에만 사용한다.
- Actor plan 결제는 V2 canary가 무료 credit을 초과하거나 production 예상 월 사용량이 확인된 뒤 결정한다.
- 판매가는 `p95(C_total)`에 기간 내 만료·이탈 preflight 획득원가의 유료 전환 건당 배부액, VAT, 결제 수수료, 환불, 지원, 모니터링, 실패 재시도 여유를 더해 산정한다.
- V2 cost reconciliation과 유료 E2E가 완료되기 전 checkout/webhook을 production으로 열지 않는다.
