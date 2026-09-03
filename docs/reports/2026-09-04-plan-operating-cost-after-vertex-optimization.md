# Vertex AI 최적화 후 플랜별 건당 운영비 추정

산출일: 2026-09-04 (Asia/Seoul)
기준 코드: 이 worktree의 origin/main (3b28e55c, per-order cost attribution 반영 시점)

## Executive Summary

이 보고서의 추천 숫자는 **완전원가가 아닌, 직접 귀속 가능한 변동비의 모델 추정치**다. 2026-08-23 역사 보고서의 결제 건별 AI·Apify 원장을 출발점으로 삼고, Vertex fixture의 모델 절감률을 **AI 항목에만** 적용했다.

| 플랜 | 결제 건수 | [Projection] Vertex 평균 | [Measured linked] Apify 평균 | [Projection] 직접 귀속 평균 | 발행 건 lower / base / upper |
|---|---:|---:|---:|---:|---:|
| Basic | 23 | $0.271833 / ₩394 | $0.085367 / ₩124 | **$0.357200 / ₩518** | $0.071434 / ₩104 / $0.281654 / ₩408 / $2.182762 / ₩3,165 |
| Standard | 13 | $0.452966 / ₩657 | $0.013288 / ₩19 | **$0.466254 / ₩676** | $0.180453 / ₩262 / $0.504836 / ₩732 / $1.353456 / ₩1,963 |
| Plus | 0 | 산출 불가 | 산출 불가 | **산출 불가** | 산출 불가; 아래의 별도 모델 proxy만 제공 |

- Basic과 Standard 평균은 paid orders를 분모로 한 역사 cohort projection이다. 발행 건 lower/base/upper는 각각 결과가 발행된 건의 최소값/중앙값/최대값이며, 신뢰구간이 아니다.
- 역사 원장에는 usage metadata가 없는 AI cutoff 3건이 비용 0으로 기록돼 있다. 이는 무료라는 뜻이 아니라 당시 known-cost lower-bound 처리이므로, 이번 projection도 그 미확정 금액을 unknown으로 남긴 보수적 하한이다.
- Plus에는 결제·발행 표본이 없고 Plus용 Vertex token fixture도 없으므로 측정 기반 평균을 만들지 않았다. 강제로 예산을 잡아야 할 때만 현재 코드 상한과 명시적 선형 scaling 가정을 결합한 모델 proxy를 사용한다.
- 61.307124%는 gemini-3.7-flash 역사 aggregate와 gemini-3.1-flash-lite/3.7 혼합 fixture의 **동일 token volume·80/20 route mix 가정**에서 나온 수치다. 생산 spend 측정치가 아니며, high-risk evidence가 unverified_fixture라 v2.12 rollout gate가 아직 열리지 않았다.
- GCP/Cloud Tasks/Supabase/Vercel/email/support/refund 및 공유 작업 비용은 알 수 없으므로 0원으로 넣지 않았다. 따라서 표의 직접 귀속 비용은 실제 총원가보다 낮을 수 있다.

## 1. 범위와 계산 기준

### 무엇을 추정했는가

목표는 “현재 Vertex 비용 최적화가 실제로 적용되고, Instagram 수집 workload가 역사 cohort와 동일하다”는 조건에서 플랜별 **건당 평균 직접 변동비**를 KRW와 USD로 재계산하는 것이다. 서비스 전체 손익, 세금, 환불, 지원비, 공용 인프라 배부액은 이 산출의 범위 밖이다.

### 분모와 역사 보고서 방법론

제공된 operating-cost-20260823 보고서와 그 보고서가 사용한 건별 원장을 기준으로 했다.

- cohort: 2026-08-08 KST 이후 결제된 36건
- 분모: 결제 건수 — Basic 23건, Standard 13건, Plus 0건
- 결과 발행: Basic 16건, Standard 11건, Plus 0건
- AI: 저장된 token usage와 당시 코드 단가로 계산한 금액
- Apify: 요청에 연결되고 terminal/reconciled 된 provider actual
- 역사 보고서가 직접 귀속한 비용은 공유 batch·실험·retry·공용 인프라를 완전히 배부하지 않은 **신뢰 가능한 하한**이다.
- 역사 기간의 plan 미귀속 합계(Apify $154.602250, Gemini $11.178518)는 플랜별로 임의 배부하지 않았다. 따라서 표의 평균에는 포함되지 않는다.

### Projection formula

Vertex fixture의 절감률은 다음과 같이 재현했다.

    modeled_savings = 1 - 56.801862 / 146.801862 = 0.61307124
    optimized_vertex = historical_ai × (1 - modeled_savings)
    known_direct = optimized_vertex + historical_or_modeled_apify

USD→KRW는 코드와 운영 전략에 고정된 planning buffer인 ₩1,450 / $1을 사용했다. 실제 카드 FX나 정산 환율이 아니다. 표의 금액은 USD / KRW 순서다.

## 2. Basic·Standard: 역사 cohort에 연결한 평균 추정

### 구성요소별 평균

아래는 역사 결제 원장의 AI 평균을 Vertex 절감 factor로 낮춘 projection이다. Apify는 Vertex 변경으로 변하지 않는다고 보고 역사 원장의 평균을 그대로 유지했다. Other는 미측정이며, 표의 직접 귀속 합계에 포함하지 않았다.

| 플랜 | [Projection] Vertex | [Measured linked] Apify | [Unknown] Other | [Projection] known direct total |
|---|---:|---:|---:|---:|
| Basic | $0.271833 / ₩394 | $0.085367 / ₩124 | **unknown** | **$0.357200 / ₩518** |
| Standard | $0.452966 / ₩657 | $0.013288 / ₩19 | **unknown** | **$0.466254 / ₩676** |

Basic의 known direct 평균은 역사 $0.787907에서 $0.357200으로 54.7% 줄어든다. AI만 보면 $0.702539에서 $0.271833으로 정확히 61.3% 줄고, Apify $0.085367은 그대로다. Standard는 known direct 평균이 $1.183958에서 $0.466254로 60.6% 줄며, AI는 $1.170670에서 $0.452966, Apify는 $0.013288로 유지된다. 이 감소율은 각 플랜의 production 측정치가 아니라 역사 평균에 fixture factor를 적용한 결과다.

### lower / base / upper: 발행 건 분포를 재계산한 값

여기서 lower = 최소, base = 중앙값, upper = 최대다. 16/11개의 발행 건에만 적용되며 결제 전체 평균의 confidence interval 또는 미래 p95가 아니다. 각 건의 AI 금액에만 factor를 적용하고 Apify 금액은 보존했다.

| 플랜 | lower | base (median) | upper |
|---|---:|---:|---:|
| Basic (16 published) | $0.071434 / ₩104 | $0.281654 / ₩408 | $2.182762 / ₩3,165 |
| Standard (11 published) | $0.180453 / ₩262 | $0.504836 / ₩732 | $1.353456 / ₩1,963 |

역사 보고서의 최적화 전 발행 건 분포는 Basic $0.180498 / $0.723804 / $3.269708, Standard $0.462254 / $1.176328 / $3.493826이었다. 같은 Apify 금액을 두고 AI만 낮춘 projection이므로 upper가 줄어든 것처럼 보이지만, 새 정책의 실제 route·retry·token 분포가 이 cohort와 같다는 보장은 없다.

## 3. Plus: 측정 평균은 없고, 명시적 모델 proxy만 가능

Plus는 역사 결제 0건이라 historical denominator가 없다. 2026-07-24의 통제 성공 표본은 provider $3.33835와 Gemini 추정 $0.5858645가 관측됐지만 costComplete=false였고, 이 표본을 Plus 평균이나 마진 근거로 사용하지 않았다.

예산 감각을 위해서만 다음 proxy를 계산했다.

1. Plus의 current detailed limit 900을 v2.12 Standard revenue-routing limit 200으로 나눈 4.5배를 Standard AI 평균에 선형 적용한다.
2. Plus의 Vertex base proxy는 $1.170670 × 4.5 × 0.38692876 = $2.038346이다.
3. Apify는 현재 코드의 모든 collection cap을 소진하는 stress proxy $7.096600을 쓴다. 이는 provider actual 평균이 아니다.
4. Other와 실제 Plus의 route·token·retry 분포는 unknown으로 남긴다.

v2.12의 Vertex per-order budget admission ceiling은 $5.000000 / ₩7,250이다. 이 값은 작업을 허용하기 전에 예약하는 안전 상한이지 Plus 평균이나 실제 청구액이 아니므로, Plus의 Vertex unknown을 이 ceiling으로 대체하지 않았다.

| 구성요소 | Plus proxy (USD / KRW) | 해석 |
|---|---:|---|
| [Model proxy] Vertex base | $2.038346 / ₩2,956 | Standard AI 평균의 4.5배라는 비검증 가정 |
| [Policy ceiling] Vertex per-order budget | $5.000000 / ₩7,250 | 평균이 아닌 v2.12 admission safety ceiling |
| [Cap proxy] Apify | $7.096600 / ₩10,290 | 관계·profile·interaction·reverse-like 모두 current cap 사용 |
| [Unknown] Other | **unknown** | GCP/Tasks/공유비용 등, 0으로 대체하지 않음 |
| [Model proxy] known direct base | **$9.134946 / ₩13,246** | 실제 total은 이 값에 unknown 비용이 더해질 수 있음 |

Plus proxy의 lower/base/upper는 통계적 범위가 아니라 Vertex 절감률 bookend다. Apify cap은 고정하고, lower는 100% Vertex savings, base는 fixture 61.307124%, upper는 0% savings(역사 AI proxy 전액 유지)로 계산했다.

| 플랜 | lower | base | upper |
|---|---:|---:|---:|
| Plus model proxy | $7.096600 / ₩10,290 | $9.134946 / ₩13,246 | $12.364614 / ₩17,929 |

Plus의 $7.096600은 “모든 Apify cap만 채웠을 때의 known provider amount”이지 total lower bound가 아니다. Vertex와 Other의 실제 사용량이 기록되기 전에는 Plus의 평균, p50/p95, 마진을 확정할 수 없다.

## 4. 현재 Apify 코드와 Vertex policy를 반영한 stress envelope

### Apify cap 구성

현재 기본 paid route는 apify_v1이다. v2.12 test-entitlement revenue routing이 적용될 때 Basic/Standard의 detailed selection은 각각 100/200이며, Plus는 900이다. 관계 목록은 catalog 상한 400/800/1,200을 양방향으로 사용한다. 아래는 checked-in default 단가를 적용한 **최대 노출 계산**이며 provider actual이 아니다.

| 플랜 | 관계 양방향 | target profile | 후보 profile | target likers | target comments | reverse likes | Apify cap 합계 | preflight fallback |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Basic | $0.680000 / ₩986 | $0.002600 / ₩4 | $0.260000 / ₩377 | $0.930000 / ₩1,349 | $0.234000 / ₩339 | $1.550000 / ₩2,248 | **$3.656600 / ₩5,302** | +$0–0.005200 / +₩0–8 |
| Standard | $1.360000 / ₩1,972 | $0.002600 / ₩4 | $0.520000 / ₩754 | $0.930000 / ₩1,349 | $0.234000 / ₩339 | $1.550000 / ₩2,248 | **$4.596600 / ₩6,665** | +$0–0.005200 / +₩0–8 |
| Plus | $2.040000 / ₩2,958 | $0.002600 / ₩4 | $2.340000 / ₩3,393 | $0.930000 / ₩1,349 | $0.234000 / ₩339 | $1.550000 / ₩2,248 | **$7.096600 / ₩10,290** | +$0–0.005200 / +₩0–8 |

계산에 사용한 checked-in 기본값은 관계 $0.00085/result, profile $0.0026/result, liker $0.00155/result, comment $0.0026/result다. 실제 반환 수가 적거나 게시물이 없으면 낮아질 수 있고, selfhosted-auth route를 선택하면 paid Apify 행이 explicit zero receipt가 될 수 있지만 그 worker/GCP 비용은 별도로 남는다.

주의할 점은 catalog의 일반 detailedMutualLimit가 Basic/Standard 300/600으로 남아 있다는 것이다. 위의 $3.656600/$4.596600은 **v2.12 test-entitlement의 100/200 selection envelope**이다. 일반 300/600 selection을 그대로 쓰는 경우 후보 profile 항목은 Basic $0.260000→$0.780000 (증가 $0.520000 / ₩754), Standard $0.520000→$1.560000 (증가 $1.040000 / ₩1,508)으로 늘어나므로 Apify cap 합계도 Basic $4.176600 / ₩6,056, Standard $5.636600 / ₩8,173이 된다. v2.12가 production rollout 전인 현재 이 두 envelope를 섞어 쓰지 않아야 한다.

### Vertex 절감률 sensitivity

cap stress에 역사 AI 평균(Plus는 위의 4.5배 proxy)을 더하면 아래와 같다. lower/base/upper는 각각 **100% / 61.307124% / 0% Vertex savings** bookend이며, Other와 optional preflight는 제외했다.

| 플랜 | lower | base | upper | base 구성 |
|---|---:|---:|---:|---|
| Basic | $3.656600 / ₩5,302 | **$3.928433 / ₩5,696** | $4.359139 / ₩6,321 | Apify $3.656600 + Vertex $0.271833 |
| Standard | $4.596600 / ₩6,665 | **$5.049566 / ₩7,322** | $5.767270 / ₩8,363 | Apify $4.596600 + Vertex $0.452966 |
| Plus (model proxy) | $7.096600 / ₩10,290 | **$9.134946 / ₩13,246** | $12.364614 / ₩17,929 | Apify $7.096600 + Vertex $2.038346 |

이 표는 평균 forecast가 아니라 “모든 provider cap을 사용했을 때의 known-cost stress test”다. 특히 lower의 Vertex $0은 실제 무료라는 뜻이 아니며, Other unknown을 0으로 취급하지 않았다. preflight fallback이 두 세대 모두 실행되면 각 행의 known cost에 최대 $0.0052 / ₩8을 추가한다.

## 5. 역사 보고서와의 비교

역사 보고서의 합계를 결제 건수로 나눈 old direct average와 이번 projection을 비교하면 다음과 같다.

| 플랜 | old AI avg | optimized Vertex projection | old Apify avg | optimized known direct avg | direct 감소 |
|---|---:|---:|---:|---:|---:|
| Basic | $0.702539 / ₩1,019 | $0.271833 / ₩394 | $0.085367 / ₩124 | **$0.357200 / ₩518** | 54.7% |
| Standard | $1.170670 / ₩1,697 | $0.452966 / ₩657 | $0.013288 / ₩19 | **$0.466254 / ₩676** | 60.6% |
| Plus | — | — | — | — | 표본 없음 |

Basic의 direct 감소율이 Vertex 61.3%보다 작은 이유는 Apify가 비용의 일부로 남기 때문이다. Standard는 역사 AI 비중이 더 높아 direct 감소율이 61.3%에 가까워진다. 이 비교는 같은 historical denominator와 비용 귀속 정책을 유지한 counterfactual이며, 새 정책이 실제 production에서 만든 saving을 측정한 결과가 아니다.

## 6. 61.3%가 플랜별로 적용되는가

| 플랜 | 적용 판단 | 이유 |
|---|---|---|
| Basic | **조건부 적용 가능** | fixture의 동일 aggregate token volume과 80/20 default/high-value mix가 Basic에도 성립한다는 가정일 때만 AI projection에 적용했다. Basic별 실제 route/token evidence는 없다. |
| Standard | **조건부 적용 가능** | Basic과 동일하다. Standard별 실제 route/token evidence는 없으며 historical AI 평균에만 factor를 적용했다. |
| Plus | **근거 있는 적용 불가** | paid cohort와 Plus fixture가 없다. 본문의 4.5배 Vertex 값은 budget proxy일 뿐이며, 61.3%의 Plus별 검증이 아니다. |

현재 v2.12는 forward-only policy이고 stable implicit default는 v2.7이다. v2.12 fixture는 cost arithmetic gate를 통과했지만 high-risk recall evidence가 unverified_fixture라 rollout gate가 blocked 상태다. 따라서 위 Basic/Standard 숫자는 “최적화가 승인·롤아웃된 뒤의 가정상 비용”이지 2026-09-04 production 비용이 아니다.

## 7. 가격과 margin arithmetic

Basic/Standard의 가격은 current catalog에서 확정돼 있고, Plus는 deferred price다. 문서화된 Groble fee 8.69%를 적용한 planning net revenue는 Basic ₩9,039.69, Standard ₩18,170.69다. 아래는 unknown 비용을 차감하지 않은 **known direct contribution proxy**이며 완전 margin이 아니다.

| 플랜 | 결제 가격 | fee 차감 planning net | 역사 cohort projection 비용 | known direct contribution | cap-stress base 비용 | cap-stress contribution |
|---|---:|---:|---:|---:|---:|---:|
| Basic | ₩9,900 | ₩9,039.69 | ₩518 | ₩8,522 (94.3%) | ₩5,696 | ₩3,343 (37.0%) |
| Standard | ₩19,900 | ₩18,170.69 | ₩676 | ₩17,495 (96.3%) | ₩7,322 | ₩10,849 (59.7%) |
| Plus | deferred | 산출 불가 | 산출 불가 | 산출 불가 | ₩13,246 proxy | 산출 불가 |

실제 margin에는 Other unknown, GCP/Tasks, shared allocation, failed/retried work, preflight 이탈·만료 원가, refund, tax, support가 들어간다. 그러므로 이 표의 퍼센트는 가격 유지나 Plus 출시를 승인하는 근거가 아니다.

## 8. 가정과 불확실성

1. **Vertex factor:** 61.307124%는 2026-08-19 aggregate를 동일 token volume으로 재가격한 deterministic fixture다. production route mix, input/output token, retry, unknown usage가 달라지면 factor가 달라진다.
2. **Quality gate:** fixture의 high-risk recall은 97/100 대 baseline 100/100이지만 evidence status가 unverified다. 비용 projection이 품질 검증을 대신하지 않는다.
3. **Policy rollout:** v2.12는 production spend evidence가 없는 forward-only gate다. rollout 전에는 역사 cohort가 새 정책을 실제로 사용하지 않는다.
4. **Apify:** 역사 보고서의 Apify 값은 linked terminal actual이지만, current code cap은 result 단가 기반 estimated ceiling이다. 둘을 같은 종류의 측정치로 해석하지 않았다.
5. **Plus:** Plus historical paid denominator와 plan-specific token mix가 없어 4.5배 linear scaling을 임시 proxy로만 표시했다. Plus 평균·p50·p95는 측정 전 산출 불가다.
6. **Other:** current per-order attribution scope는 infrastructure_included=false다. unknown/active/unreconciled 비용은 0으로 합산하지 않았고, production ledger가 없는 상태에서 새로운 provider/log query도 하지 않았다.
7. **FX:** ₩1,450/$1은 planning buffer이며 실제 결제·카드·정산 FX가 아니다.
8. **Sampling:** Basic 23건과 Standard 13건은 작은 historical cohort이며 policy drift, refund/cutoff rows, failed/retry mix가 미래 평균을 바꿀 수 있다.

## 9. 운영 의사결정과 다음 측정 gate

- 단기 planning에는 Basic **$0.357 / ₩518**, Standard **$0.466 / ₩676**의 historical-linked known-direct 평균을 사용한다. 이 숫자에 Other가 포함돼 있다고 말하지 않는다.
- capacity 예산과 worst-case 노출에는 Basic **$3.928 / ₩5,696**, Standard **$5.050 / ₩7,322**의 cap-stress base를 별도로 본다. 이것은 평균이 아니다.
- Plus는 판매가가 정해지고, 동일한 DAG에서 성공·실패·retry 표본의 provider actual, Vertex usage estimate, GCP/Tasks usage를 모은 뒤에만 평균과 margin을 확정한다.
- v2.12 rollout 전에 plan별 route share, input/output/thinking token, unknown usage, reserved-vs-measured cost, Apify terminal actual, preflight fallback, GCP/Tasks allocation을 request/order 원장에 남기고 p50/p95를 계산한다.
- current per-order rollup의 infrastructure_included=false 경계를 유지한다. complete flag가 false인 order를 평균에 넣을 때는 known lower bound 또는 conservative bound로 명시한다.

## Source basis and reproducibility

사용한 자료는 다음과 같다.

- 제공된 역사 보고서: operating-cost-20260823/report.html, 그리고 동일 report의 건별 원장·검증 자료 order_costs.csv, validation.md, artifact.json
- Vertex evidence: docs/reports/2026-09-02-vertex-ai-cost-optimization-evidence.md
- Vertex fixture: reports/vertex-ai-cost-optimization-fixture.json
- Vertex 단가·추정 로직: lib/services/ai/gemini-cost.ts, lib/services/ai/vertex-ai-cost-policy.ts, lib/services/ai/stage-policy.ts
- 플랜·수집 cap: lib/domain/analysis/plan-catalog.ts, lib/services/analysis/gender-routing.ts, lib/services/analysis/v2-apify-operation-costs.ts, lib/services/instagram/config.ts
- 운영 비용 귀속 경계와 price reference: docs/operations-cost-model.md, docs/analysis-v2-cost-attribution.md

이 작업에서는 provider, Vertex, database, production log에 대한 신규 외부 호출이나 mutation을 하지 않았다. 보고서에는 token, account/user identifier, raw username, secret, project identifier, raw provider payload를 저장하지 않았다. 차트 대신 exact audit table을 사용한 이유는 현재 관측 plan cut이 두 plan의 소규모 cohort와 Plus 무표본으로 구성되어, 차트가 추세나 confidence를 암시할 위험이 더 크기 때문이다.
