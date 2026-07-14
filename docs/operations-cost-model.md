# V2 운영 비용 모델

기준일: 2026-07-14. 이 문서는 현재 V2 코드의 **과금 단위와 측정 방법**을 정리한다. V2 유료 E2E가 아직 끝나지 않았으므로 건당 달러 원가와 판매가는 확정하지 않는다. Actor 콘솔 가격, 과거 V1 canary, 환경변수의 예산 상한을 V2 실측 원가로 대체해서는 안 된다.

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
- 판매가는 `pricingVersion=deferred`다. V2 실측과 결제 대사가 끝나기 전에는 UI나 문서에 금액을 하드코딩하지 않는다.

## V2 과금 경로

1. 대상/공개 맞팔 프로필은 로그인 없는 자체 수집기를 먼저 사용한다.
2. 자체 수집의 username별 terminal 결과를 먼저 저장하고, **그 스냅샷에서 정확히 unresolved인 username만** Apify profile fallback 입력으로 고정한다. 성공한 계정이나 30개 batch 전체를 다시 보내지 않는다.
3. followers/following은 Apify 관계 Actor로 수집하고, 각 방향에서 선언 수의 99% 고유 커버리지를 만족하지 못하면 결과를 만들지 않는다.
4. 대상 상호작용은 최신 게시물 중 liker 최대 `4 x 150 = 600`, comment 최대 `6 x 15 = 90`을 수집한다.
5. 역방향 좋아요는 예비점수 상위 후보 `K<=10`의 최신 게시물 1개에서 후보당 최대 100명을 수집한다.
6. 역방향 대상 계정이 반환 목록에 있으면 양의 관측이다. 대상이 없더라도 게시물 전체 liker 수가 100 이하이고 고유 반환 수가 그 전체 수를 덮을 때만 부재를 확정한다. 예를 들어 `100/114`나 `109/114`는 부재가 아니라 `not_collected`다.
7. Gemini는 성별 triage, 라우팅된 여성 feature 분석, shortlist partner-safety, 대표 고위험 narrative로 나뉜다. 영구 미디어 부분 실패나 구조적 snapshot 누락은 부정 근거로 쓰지 않는다.

FlashAPI, CoderX, Stable RapidAPI는 V2 production DAG에 포함하지 않는다.

## 건당 비용 식

V2 E2E에서 아래 변수를 요청별 원장으로 측정한다.

- `F`, `G`: 관계 Actor가 실제 반환한 followers/following 과금 행
- `B`: 자체 수집 실패 후 Apify profile fallback으로 고정된 정확한 unresolved 수
- `LT`: 대상 게시물 liker 과금 행, `0 <= LT <= 600`
- `CT`: 대상 게시물 comment 과금 행, `0 <= CT <= 90`
- `R_i`: shortlist 후보 `i`의 역방향 liker 과금 행, `0 <= R_i <= 100`, `K <= 10`
- `T_s,in`, `T_s,out`, `T_s,think`: Gemini 단계 `s`의 실제 input/output/thinking token
- `CPU`, `MEM`, `TASK`: Cloud Run CPU·메모리 시간과 Cloud Tasks operation

Actor별 실제 단가를 각각 `u_rel`, `u_profile`, `u_liker`, `u_comment`라 하면 외부 수집 비용은 다음과 같다.

```text
C_provider = (F + G) * u_rel
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

## 현재 측정 상태

| 항목 | Basic | Standard | Plus |
|---|---:|---:|---:|
| V2 provider 건당 비용 | 미측정 | 미측정 | 미측정 |
| V2 Gemini 건당 비용 | 미측정 | 미측정 | 미측정 |
| V2 Cloud Run/Tasks 건당 비용 | 미측정 | 미측정 | 미측정 |
| V2 전체 wall time p50/p95 | 미측정 | 미측정 | 미측정 |
| 권장 판매가 | 보류 | 보류 | 보류 |

2026-07-13의 `0_min._.00` 완료 canary와 그 이전 비용표는 V1 순차 실행, 과거 plan 상한, 과거 batch fallback, 다른 Gemini fanout을 사용했다. 관계/Actor 기능 진단 자료로는 남기되 V2 가격이나 5분 SLA 근거로 사용하지 않는다.

## V2 E2E 측정 절차

1. Basic/Standard/Plus 각각 동의받은 fixture를 준비하고, cold와 warm cache를 분리한다.
2. 관계 선언/반환/고유 수, 정확한 `B`, `LT`, `CT`, 각 `R_i`, Actor run id와 실제 청구액을 기록한다.
3. Gemini 단계별 model, thinking level, 이미지 수, input/output/thinking token, cache hit, latency, 추정액을 기록한다.
4. Cloud Run instance CPU·메모리 시간, Cloud Tasks delivery/retry 수, 전체 wall time을 기록한다.
5. 요청의 provider run 수와 AI attempt 수가 사전 고정 DAG와 일치할 때만 `cost_complete=true`로 본다.
6. 각 플랜에서 성공 표본과 오류/재시도 표본을 모두 모아 p50, p95, 최대값을 계산한다.
7. 5분 p95, 원가 대사, 중복 과금 0건을 통과한 뒤 판매가와 결제를 확정한다.

## 원장과 운영 조회

- `analysis_v2_provider_runs`: V2 Actor 예약, run id, terminal 상태, 실제 사용액과 비용 상한
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
- 판매가는 `p95(C_total)`에 VAT, 결제 수수료, 환불, 지원, 모니터링, 실패 재시도 여유를 더해 산정한다.
- V2 cost reconciliation과 유료 E2E가 완료되기 전 checkout/webhook을 production으로 열지 않는다.
