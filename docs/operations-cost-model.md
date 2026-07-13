# 운영 비용 및 가격 모델

기준일: 2026-07-13. USD/KRW는 가격 방어용 `1 USD = KRW 1,600`을 사용한다. 실측, 공시 단가, 보수적 추정을 구분한다.

## 추천 운영 경로

1. followers/following: Apify Scraping Solutions
2. 공개 프로필/최근 게시물: 자체 비로그인 수집기
3. 프로필 fallback: Apify 공식 Instagram Profile Scraper
4. 대상 게시물 댓글: Apify 공식 Instagram Comment Scraper
5. 공개 게시물 liker: DataDoping Instagram Likes Scraper
6. 운영자 수동 진단만: FlashAPI, CoderX, Stable RapidAPI

자체 수집기는 Instagram 로그인 세션을 사용하지 않는다. 관계 목록은 예상치의 99% 미만이면 자동 fallback 없이 실패한다. liker/comment는 반환 목록에서 확인된 양의 신호만 점수에 더하고, 목록에 없음은 '상호작용 없음'으로 간주하지 않는다.

## 확인된 단가

| 항목 | Free | Starter |
|---|---:|---:|
| Apify 구독 | `$0` | `$29/month`, `$29` usage credit 포함 |
| Scraping Solutions relationship | `$0.85/1K` | `$0.70/1K` |
| Apify Profile Scraper | `$2.60/1K` | `$2.30/1K` |
| Apify Comment Scraper | `$2.60/1K` | `$2.30/1K` |
| DataDoping Likes Scraper | `$1.55/1K` | `$1.40/1K` |

공식 출처: [Scraping Solutions pricing](https://apify.com/scraping_solutions/instagram-scraper-followers-following-no-cookies/pricing), [Apify Profile Scraper](https://apify.com/apify/instagram-profile-scraper/pricing), [Apify Comment Scraper](https://apify.com/apify/instagram-comment-scraper/pricing), [DataDoping Likes Scraper](https://apify.com/datadoping/instagram-likes-scraper/pricing), [Apify plans](https://apify.com/pricing).

FlashAPI Pro `$9.90`는 현재 결제 주기에 이미 지출했지만 생산 경로에서 제외한다. 선언 계수의 66.76%만 반환했으므로 Ultra 업그레이드도 추천하지 않는다.

### Free 수용 테스트와 Starter 전환 기준

Apify Free는 매월 `$5` usage credit을 제공하고 카드가 필요 없다. Starter는 월 `$29`를 결제하지만 동일한 `$29` usage credit과 Actor별 Bronze 할인을 제공한다. 따라서 Starter는 테스트 접근권 구매가 아니라 실제 월 사용량을 선결제하는 운영 플랜이다.

Free 단가에서 자체 profile fast path가 성공할 때 요청 상한은 다음과 같다.

- 500/500: **`$2.014 + $0.155×K`**, `K=10`이면 `$3.564`
- 1,000/1,000: **`$2.864 + $0.155×K`**, `K=10`이면 `$4.414`
- 모든 profile batch가 fallback이면 최대 `$0.9126` (`351×$0.0026`)을 추가한다.
- 기준 canary 규모 474/642는 target interaction과 `K=10`을 모두 채우면 `$3.6626`, profile fallback 극단 상한은 `$4.5752`다.

결론:

- 기능 확인용 전체 canary 1건은 잔액이 온전한 새 Free 계정 하나로 가능하다. fallback까지 고려하면 `$5`에 여유가 크지 않으므로 동시에 다른 Actor를 실행하지 않는다.
- 여러 Free 계정의 크레딧을 한 분석에 합치거나 production quota 우회 용도로 자동 회전하지 않는다. `primary`/`secondary` 슬롯은 명시적 canary와 장애 복구를 위한 credential 고정 기능이다.
- 실제 유료 사용자 분석을 받기 시작하거나 월 Apify 원가가 `$5`를 넘을 때 Starter로 전환한다. 현재 Apify의 최저 유료 플랜 명칭은 Pro가 아니라 **Starter**다.

## 실측 기준선

- FlashAPI 전체 canary: followers 320/474, following 425/642, 합계 745/1,116 (66.76%), `139.232s`.
- Apify relationship: followers 473/474 (`39.909s`, Free credit `$0.40205`), following 641/642 (`44.460s`, Free credit `$0.54485`). 합계 1,114/1,116 (99.82%).
- DataDoping liker: 익명화한 live canary 계정의 최신 post에서 109 unique, 중복 0, URL 귀속 100%, `10.545s`. 표시 좋아요 114 대비 95.6%.
- 공식 comments: 표시 댓글 7개 중 비로그인 공개 범위 5개, `6.268s`.
- 고정 build/adapter: liker 10/10, comments 5/5, 모두 중복 0/URL 귀속 100%, 전체 `25.402s`.
- 익명화한 live canary target 전체: 5 posts, liker 456 rows/228 unique accounts, comments 26, 기존 공개 여성 108명 중 `K=47`, `34.498s`, Free credit 추정 `$0.7744`.
- 기존 Gemini: Basic 245 profiles, cache 205/paid 86, `$0.699909`; cold 성격 150 paid calls, `$0.965048`.
- 비공개 이름 배치 Gemini canary: 텍스트 3건, `6.725s`, 410 input/891 billable output tokens, `$0.002878`; 100건 출력은 더 커지므로 아래 원가는 선형 보수 범위를 쓴다.
- 고위험 2문장 Gemini canary: 이미지 없는 합성 근거 1건, `9.194s`, 629 input/1,289 billable output tokens, `$0.0041815`.
- 2026-07-13 `0_min._.00` 완료 canary: followers 472, following 500, mutual 280, 공개 profile 191개 중 185개 분석, interaction `K=10`, 고위험 심층 분석 3명. 확정 Apify `$3.2441`, Gemini 242 logs(54 cache hits), 2,191,623 total tokens, Gemini 추정 `$1.6019265`, 합계 **`$4.8460265`**. 디버깅 중단을 포함한 wall time은 75분이므로 속도 기준선으로 사용하지 않고, 정상 완료 단계 실측은 profiles 약 3분, cold-heavy Gemini 약 12분, interactions 약 66초, deep analysis 약 46초다.

이번 canary의 Apify 세부 확정액은 relationship `$0.8262`, profile fallback `$0.4810`, target comments `$0.0676`, target likers `$0.58435`, candidate likers `$1.28495`다. 상한보다 낮은 이유는 Actor가 실제 반환한 결과 수로 과금하기 때문이다.

## 분석 1건 순차별 원가

기호:

- `K`: 대상 최신 4개 posts의 최대 600 liker와 최신 6개 posts의 최대 90 comment 표본에서 관측된 공개 맞팔 여성 중, 중간점수 상위 후속 확인 수 (`0≤K≤10`)
- `B`: Apify profile fallback에 실제로 전달되는 행 수 (`0≤B≤351`). 대상 프로필은 0~1행이고, 공개 맞팔 프로필은 30개 단위 고정 배치에서 자체 수집 결과가 하나라도 빠지면 해당 배치 전체를 전달한다.
- `P`: 비공개 맞팔 계정 수. 이름 정렬은 100개 단위 Gemini 텍스트 배치로 처리한다.

아래는 각 요청 상한이 모두 채워진 Starter 상한이다. Apify는 실제 반환 결과 수로 과금하므로 평소에는 더 낮다.

| 순서 | 작업 | 500/500 | 1,000/1,000 |
|---:|---|---:|---:|
| 1 | 대상 공개 프로필 + posts 10, 자체 | `$0` | `$0` |
| 2 | followers + following | `$0.70` | `$1.40` |
| 3 | mutual 교집/공개 분류, 자체 | `$0` | `$0` |
| 4 | 공개 mutual profiles, 자체/캐시 | `$0` | `$0` |
| 4-fallback | Apify profiles `B` | `$0.0023×B` | `$0.0023×B` |
| 5 | Gemini: 공개 계정당 profile 1 + feed 10 = 최대 11 images | 별도 | 별도 |
| 5-b | 비공개 계정 이름 분류, 100개/텍스트 배치 | 별도 | 별도 |
| 6 | target 6 posts × comments 15 | `$0.207` | `$0.207` |
| 7 | target 4 posts × likers 150 | `$0.84` | `$0.84` |
| 8 | 중간점수 상위 observed women `K` × 1 post × likers 100 | `$0.14×K` | `$0.14×K` |
| 8-b | 고위험 1~3명 Gemini 2문장 심층 분석, 병렬 | 별도 | 별도 |
| 9 | 교집, 점수, Supabase 저장 | `$0` | `$0` |

자체 profile fast path 성공, Gemini/Cloud Run 제외:

- 500/500: **`$1.747 + $0.14×K`**
- 1,000/1,000: **`$2.447 + $0.14×K`**
- 모든 profile batch가 fallback이면 최대 `$0.8073` (`351×$0.0023`)을 추가한다.

공개 맞팔 프로필은 중단 후에도 동일한 유료 입력과 결과를 재개할 수 있도록 호출 전에 최대 30개 배치를 고정한다. 따라서 한 배치에서 자체 수집 누락이 1개뿐이어도 Apify에는 그 배치 최대 30행을 요청할 수 있다. 이는 누락 계정 수만 과금한다는 가정보다 보수적이지만, 실행 중 캐시가 바뀌어도 같은 Actor를 재개하고 중복 호출을 막기 위한 내구성 비용이다. 요청 전체의 `B≤351` 상한은 그대로 강제한다.

Apify Profile Scraper의 durable 30개 batch는 확인 불가능한 계정을 최대 1개만 분석 대상에서 제외한다. 따라서 일반 batch는 사실상 95% 이상을 유지하고, 1명짜리 tail은 해당 계정이 unavailable이면 0/1도 허용한다. 2개 이상 누락, 반환 username 중복이나 요청 외 username은 스키마 또는 완전성 오류로 전체 batch를 차단한다. 이 정책은 삭제·변경·일시 접근 불가 계정 하나 때문에 이미 결제한 전체 batch를 재실행하지 않기 위한 것이다.

| `K` | 500/500, GCP 제외 | 1,000/1,000, GCP 제외 |
|---:|---:|---:|
| 0 | `$1.747` | `$2.447` |
| 5 | `$2.447` | `$3.147` |
| 10, 현재 최댓값 | `$3.147` | `$3.847` |

기존 익명화 live canary 실측에서 관측 후보가 47명이었더라도 이제 후속 호출은 중간점수 상위 10명으로 제한된다. 당시 관계 반환 1,114건을 현재 Starter 단가로 환산하고 새 상한을 적용하면 관계 `$0.7798` + target liker 최대 `$0.84` + 실제 comments 26건 `$0.0598` + candidate 최대 `$1.40` = **최대 `$3.0796`**다. 새 한도로 유료 canary를 다시 실행하기 전까지 이는 실측 반환량과 신규 상한을 결합한 보수적 추정이다.

### 절반으로 줄었는가

- target liker 항목만 보면 `6×200=1,200`에서 `4×150=600`으로 정확히 50% 감소했다.
- candidate liker는 `K×2×100`에서 `K×1×100`으로 정확히 50% 감소했고, `K` 자체도 최대 10으로 고정됐다.
- comments와 relationship 비용은 그대로이므로 전체 Apify 원가는 정확히 절반은 아니다.
- `K=10` Starter 상한 기준 전체 Apify 원가는 500/500에서 `$5.387→$3.147`로 **41.6%**, 1,000/1,000에서 `$6.087→$3.847`로 **36.8%** 감소한다. 상호작용 단계만 보면 `$4.687→$2.447`로 **47.8%** 감소한다.

## Gemini/Cloud Run 포함

Gemini 11장은 기존 10장 실측에 10% 보수 마진을 더한다. 비공개 이름 분류는 이미지 없이 100개 단위 텍스트 배치이고, 고위험 심층 분석은 최대 1~3개 계정을 동시에 호출한다.

- 500/500 일반 실행 Gemini: `$0.77-$1.07`
- 500/500 공개 계정 185개 cold-heavy 완료 canary Gemini: **`$1.6019`**
- 1,000/1,000 일반 실행 Gemini: `$0.99-$1.98`
- 최대 350 profiles 전부 cold Gemini: `$2.48-$3.14`
- 비공개 이름 텍스트 분류: 비공개 500명을 모두 분류하면 `$0.06-$0.12`, 1,000명이면 `$0.12-$0.24` 보수 추정. 실제 `P`가 작으면 비례해 낮아진다.
- 고위험 1~3명 2문장 심층 분석: 이미지 입력까지 포함해 합계 `$0.01-$0.06` 보수 추정
- 현재 실행기는 Vercel이고 Cloud Run은 사용하지 않으므로 Cloud Run 원가는 `$0`
- Cloud Tasks는 요청 1건당 최대 약 28개의 작은 task, 생성과 전달을 합쳐 재시도 전 약 56 operations를 사용한다. 월 첫 100만 operations가 무료라 초기 규모에서는 `$0`로 본다.

| 케이스 | Gemini/Cloud Run 제외 | Gemini/Cloud Run 포함, 일반 범위 |
|---|---:|---:|
| 500/500 | `$1.747 + $0.14×K` | `$2.587-$2.997 + $0.14×K` |
| 1,000/1,000 | `$2.447 + $0.14×K` | `$3.567-$4.727 + $0.14×K` |

`K=10`이면 500/500은 `$3.987-$4.397`, 1,000/1,000은 `$4.967-$6.127`이다. 상단은 관계 범위 안의 계정이 전부 비공개라는 극단값이며, 실제 `P`와 Gemini token에 따라 더 낮아진다. GCP `$300` credit은 Gemini와 Cloud Tasks의 현금 청구를 미루지만 Apify 비용이나 제품 경제원가를 없애지 않는다.

Apify Starter는 `$29` usage credit을 포함하므로 건당 현금원가는 usage와 `$29/N`(월 분석 수)를 더하지 않고 **`max(usage, $29/N)`**로 본다. `K=10`이면 credit은 500/500 약 5.4건, 1,000/1,000 약 4.8건을 담당한다.

Google 공식 출처: [Vertex AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing), [Cloud Tasks pricing](https://cloud.google.com/tasks/pricing), [Cloud Run pricing](https://cloud.google.com/run/pricing).

## 판매가 제안

`K≤10`이 코드와 Actor 예산 양쪽에서 강제되므로 이제 사용자별 interaction 초과 과금은 필요하지 않다.

| 제안 | VAT 포함 판매가 | 포함 `K` | 초과 |
|---|---:|---:|---:|
| Basic 500/500 | `KRW 19,900` | 최대 10명 | 없음 |
| Standard 1,000/1,000 | `KRW 29,900` | 최대 10명 | 없음 |

GCP credit 기간의 프로모션 가격으로 Basic `KRW 14,900`을 시험할 수 있지만, credit 종료 후에도 안정적인 마진을 내려면 정상가는 `KRW 19,900`이 낫다. 이 원가에는 결제 수수료, VAT 납부 효과, 환불, 고객지원, 모니터링, 법률 검토가 포함되지 않았다.

## 배포 판단

- 현재는 Cloud Tasks가 OIDC로 Vercel step endpoint를 호출한다. 서울 queue는 동시 실행 2개, 초당 2개, 최대 8회 재시도로 제한한다.
- 상호작용 job은 여성 최대 10명(10 posts)을 한 배치로 저장한다. 유료 Actor 호출 전에 `running` 예약을 먼저 기록하며, 중단된 예약은 재개 시 실패로 확정해 같은 배치를 다시 과금하지 않는다.
- DataDoping은 community Actor이며 완전성 SLA가 없다. 반환 건수, unique ratio, URL 귀속, latency, 비용을 계속 감시한다.
- Apify의 첫 terminal 응답은 비용과 `chargedEventCounts`가 임시값일 수 있다. 파이프라인은 결과 처리를 막지 않고 비용을 미정산으로 남긴 뒤, terminal 시각에서 30초가 지난 인증 `GET actor run`의 `usageTotalUsd`만 실제액으로 확정한다. 완료·실패 후 Cloud Task가 재시도하고 전역 미정산 행도 오래된 순서로 복구한다. event count 곱셈값을 여기에 더하지 않는다.
- Cloud Run으로 옮길 경우에만 request-based billing, scale-to-zero, 낮은 max instances를 다시 산정한다.

## 운영 로그와 요청별 비용 조회

로그의 기준 저장소는 하나가 아니다.

- Vercel: API invocation과 구조화된 runtime log
- Supabase `analysis_step_events`: PII 없는 단계 시작/완료/재시도/실패, 시도 횟수와 지연시간
- Supabase `analysis_provider_cost_ledger`: Apify Actor별 실제 사용액, 보수적 비용 상한, `cost_finalized_at`
- Supabase `analysis_provider_usage_expectations`: Actor 시작 전에 고정한 작업과 최대 과금액
- Supabase `gemini_token_usage`: Gemini token, latency, 호출 당시의 추정 비용
- Supabase `analysis_gemini_usage_expectations`: Gemini 실행 전에 고정한 예상 token-log 행 수
- Supabase `scraper_provider_usage`: 수집 완전성, 반환량, latency, 진단용 비용 추정
- GCP Cloud Tasks와 Apify Console: 전달 시도와 Actor 원본 실행 로그

`analysis_operational_cost_summary` view는 `request_id`별 Apify 실제액과 Gemini 추정액을 합산한다. `scraper_estimated_cost_usd`는 Apify 원장과 같은 호출을 중복 반영할 수 있으므로 총액에 더하지 않는다. GCP/Vercel 인프라 비용도 이 view의 총액에 포함하지 않는다.

운영자는 `ADMIN_API_KEY`로 다음 endpoint를 조회한다.

```bash
curl -H "Authorization: Bearer $ADMIN_API_KEY" \
  "https://<service>/api/admin/analysis-observability?requestId=<uuid>"
```

응답의 `known_total_cost_usd`는 확정된 Apify 사용액과 알려진 Gemini 추정액 합계다. `conservative_total_cost_usd`는 미종료, run ID 유실 또는 실제액 미확정 Actor 작업에 사전 비용 상한을 대신 사용한다. `total_cost_complete`는 분석이 종료됐고, 호출 전 expectation과 Actor/Gemini 원장 행 수가 모두 일치할 때만 `true`다. 분석 요청을 삭제해도 이 PII 없는 UUID 상관키와 원가·단계 이벤트는 보존된다.
