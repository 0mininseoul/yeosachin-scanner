# 2026년 8월 매출 우선 운영 전략

- 최초 작성일: 2026-08-08
- 최종 갱신일: 2026-08-10
- 상태: 팀 공유용 실행 결정안
- 적용 기간: 2026-08-08 ~ 2026-08-31
- 코드 기준: `origin/main@7f899b7c` + 결제 후 안내 화면 + 첫 결제 concierge 복구 + 운영자 결과 조회 경로(`979e5a67`까지)
- 현재 상태: **첫 결제 결과 생성 완료, 구매자가 2026-08-09 보관함에서 직접 열람, 운영자 계정 조회도 검증 완료**
- 8월 최우선 목표: **관리자·내부 테스트를 제외한 환불 차감 실결제 누적 100,000원**
- 동시 운영 목표: **모든 유료 주문을 약속한 기한 안에 결과까지 전달**
- 범위: 위장여사친판독기와 맞팔 알리미의 출시 순서, 가격, 원가 상한, 운영 중단 기준
- 제외: 사용자 인터뷰, 확정 랜딩 카피 변경, 장기 자동화 상세 설계

> 이 문서는 8월 매출 실행 순서와 가격·판매 중단 규칙의 정본이며 [전략 전면 재검토 rev.3](./2026-08-07-strategy-full-review.md)를 대체한다. 제품 가설의 정본은 [린 캔버스](./2026-07-31-lean-canvas.md), 운영 원가의 측정 정본은 [운영 비용 및 가격 모델](../operations-cost-model.md)이다. 구현 계약은 [계정 원장](../superpowers/specs/2026-08-10-account-ledger-paid-status-design.md), [성별 라우팅](../superpowers/specs/2026-08-10-gender-routing-cost-control-design.md), [유료 분석 E2E](../superpowers/specs/2026-08-10-revenue-e2e-observability-design.md) 설계를 따른다.

---

## 1. 업데이트된 최종 결정

2026-08-08, 트위터 게시물에서 유입된 외부 사용자가 위장여사친판독기 Basic을 990원에 결제했다. 첫 실결제 목표는 달성됐다. 이 결제는 **990원에서 실제 지불 의향이 존재한다는 첫 증거**지만, 더 높은 가격이나 시장 전체 수요까지 검증한 증거는 아니다.

현재 결론은 다음과 같다.

1. 위장여사친판독기를 보류하지 않는다. Apify 단일 경로, 제한 재고, 비동기 전달과 concierge 운영으로 판매를 계속 연다.
2. 현재 Basic 990원 / Standard 1,990원은 이번 제한 재고가 소진되거나 정상 전달 5건이 쌓일 때까지 유지한다. 첫 전달 직후 2,900원 / 4,900원으로 즉시 올리지 않는다.
3. 판독기 정상 전달 5건과 플랜별 실원가를 확보하면 1차 가격을 Basic 1,990원 / Standard 2,990원으로 올려 검증한다. 2,900원 / 4,900원은 그다음 가격 실험으로 미룬다.
4. 맞팔 알리미는 판독기와 selfhosted_auth 안정화를 기다리지 않는다. 8월 12일까지 30일 유료 concierge 파일럿을 판매 가능한 상태로 만든다.
5. 알리미는 최초 기준 목록을 만드는 일회성 설정비와 월 감시비를 분리한다. 화면에는 `월 1,990원부터`를 주 가격으로 노출하되 설정비를 결제 전에 명확히 알린다.
6. 변화가 전혀 없는 달의 무료 정책은 초기 이벤트로 채택한다. 환불이나 0원 재결제가 아니라 **다음 30일 무료 연장**으로 운영한다.
7. selfhosted_auth는 8월 매출의 선행 조건이 아니다. Apify로 매출과 E2E를 먼저 만들고, 버너 계정 2~3개의 별도 canary가 통과한 뒤에만 전환한다.
8. 자동 완료 이메일 파이프라인은 이번 운영 주기에 구축하지 않는다. 자동 E2E가 복구될 때까지 운영자가 완료 건을 확인하고 수동으로 전달한다.
9. 구현 우선순위는 **Apify Basic/Standard E2E 복구 → 유료 주문 원장·관측 정합성 → 맞팔 알리미 concierge 파일럿**이다. 계정 정리는 E2E를 방해하지 않는 additive migration으로 병행한다.

한 문장으로 요약하면 다음과 같다.

> **판독기는 제한 판매와 concierge로 지금 매출을 계속 받고, 맞팔 알리미는 즉시 저가 유료 파일럿으로 병행 출시한다. 8월 10만 원은 두 제품의 합산 매출로 만든다.**

---

## 2. 첫 실결제에서 확인된 사실

### 2.1 주문과 장애

- 외부 Basic 990원 결제 1건이 2026-08-08 21:41 KST에 정상 승인됐다.
- 판매자 주문 참조와 결제 완료 웹훅은 정상 확인됐다. 결제 자체의 실패가 아니다.
- 최초 자동 처리에서는 분석 요청이 생성되지 않았고 fulfillment가 `manual_review`에 들어갔다.
- 직접 원인은 유료 분석의 여섯 scraper selector가 `selfhosted` / `selfhosted_auth`를 사용하던 상태에서 인증 버너 계정이 영구 격리된 것이다.
- fresh admission의 프로필 조회가 인증 실패로 세 번 종료되면서 `ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE`로 차단됐다.
- 따라서 최초 장애는 downstream 분석 오류가 아니라 **분석 요청 생성 전 fresh profile admission 실패**다.

### 2.2 결제자가 실제로 본 화면

Amplitude 원시 이벤트 시각과 당시 fulfillment 상태를 함께 보면, 결제자가 Groble에서 돌아온 직후 실제로 본 첫 화면은 다음이었다.

- 제목: `판독을 자동으로 시작하고 있어요`
- 설명: `잠시만 기다리면 진행 화면으로 이어집니다.`

약 8분 뒤 fulfillment가 `manual_review`로 바뀐 이후 같은 페이지를 계속 열어두거나 새로고침했다면 지원 안내 화면으로 전환됐을 수 있다. 최초 노출 화면은 지원 안내가 아니라 자동 시작 대기 화면이다.

### 2.3 즉시 적용한 운영 조치

- production `analysis-worker`의 profile, profilesBatch, followers, following, likers, comments를 Apify로 되돌렸다.
- 최초 설정 변경 때 새 revision은 생성됐지만 기존 selfhosted revision에 트래픽 100%가 남아 있었다. 실제 serving revision과 로그를 다시 대조해 Apify revision으로 트래픽 100%를 명시 전환했다.
- 현재 serving revision에서 여섯 selector가 모두 `apify`, `SELFHOSTED_AUTH_ENABLED=false`, Ready/Active임을 확인했다.
- 결제 후 `paid` / `analysis_in_progress` 상태에서 진행 화면으로 자동 이동하지 않도록 변경했다.
- 현재 결제 후 안내 문구는 `판독 결과가 완성되면 가입하신 이메일로 결과 링크를 보내드릴게요.`다.
- 이 안내 화면은 production에 배포됐다.

주의할 점이 하나 있다. V2 결과 완료 시 자동 이메일 outbox는 없고 이번 운영 주기에도 만들지 않는다. 재고가 제한된 현재는 운영자가 완료 여부를 확인해 이메일 또는 직접 URL로 전달한다. **자동 E2E가 복구될 때까지 화면의 약속은 concierge 운영 SLA로 이행한다.**

### 2.4 첫 주문의 처리 원칙

- 전달 기한: 주문 원장의 `due_at`, 2026-08-09 21:41 KST 이전
- 우선순위: 신규 기능보다 이 주문의 Apify 분석 생성과 결과 전달이 먼저다.
- 결과가 자동 주문 흐름에 연결되지 않더라도, 소유자가 볼 수 있는 결과 URL을 concierge로 먼저 생성한다. 구매자가 보관함에서 먼저 확인하면 별도 URL을 중복 발송하지 않고 열람 사실만 기록한다.
- 환불 요청이 오면 분석 완료 여부와 무관하게 즉시 환불 절차로 전환한다.
- 환불 요청이 없는 현재 상태를 임의로 환불·완료 처리하지 않는다.

### 2.5 첫 주문 복구 결과

2026-08-09 09:37 KST, due_at보다 약 12시간 먼저 결과 생성과 소유자 전용 결과 페이지 검증을 완료했다. 주문·fulfillment·분석 요청은 하나의 트랜잭션으로 `completed`가 됐다. 구매자는 같은 날 14:48 KST경 보관함에서 결과를 직접 확인했고, 운영자 계정에서도 같은 결과를 열 수 있음을 확인했다. 따라서 추가 URL 발송은 하지 않았다.

- 신규 Apify 수집을 시작하지 않고 기존 결제 건에 귀속된 데이터셋 19개를 재사용했다.
- 수집 범위: 팔로워 390, 팔로잉 256, 맞팔 182, 공개 134, 비공개 48
- Basic의 상세 분석 한도는 300명이므로 공개 134명 전원을 screened로 집계했다.
- 공개 프로필 증거는 129명, profile fetch 불가는 5명이었다. 불가 5명은 가짜 프로필을 만들지 않고 unknown에 포함했다.
- 최종 성별 집계: 남성 64, 여성 12, unknown 58
- unknown 중 profile fetch 불가 5, 미디어 불가 0, AI 분석 불가 6을 별도로 보존했다.
- 결과 로더에서 소유자 일치, 여성 결과 12행, 비공개 결과 48행을 확인했다.

복구 과정에서 확인한 재발 방지 항목은 세 가지다.

1. 시점이 다른 관계 스냅샷 중 가장 큰 391명 목록이 아니라 결제 건에 보존된 정확한 390명 목록을 선택해야 한다.
2. Apify의 최근 게시물 최대 10개를 운영 체크포인트 규칙과 동일하게 최신순 8개로 정규화해야 한다.
3. `not screened`는 플랜 상한 초과에만 사용한다. 프로필 조회 실패는 `fetch unavailable`로 분리한다.

세 항목은 첫 결제 concierge 복구 경로에서 각각 코드·migration·계약 테스트로 반영됐다. 다만 이는 **보존 데이터 재생 경로의 수정 완료**를 뜻하며, 신규 수집부터 결과 페이지까지의 fresh Basic/Standard E2E가 복구됐다는 뜻은 아니다. fresh E2E 두 건이 아래 출시 gate다.

첫 결과의 프로필 이미지는 결과 화면에서 표시되지 않았다. 결과 수치와 소유권은 정상이나, 공급자 CDN URL은 장기 결과 표시 계약으로 사용할 수 없다. fresh E2E에서는 최종 결과 이미지가 공급자 URL이 아니라 내부 R2 보존 객체와 권한을 검사하는 안정된 same-origin 경로로 열리는 것을 필수 합격 조건으로 둔다.

---

## 3. 8월 목표와 매출 산식

### 3.1 목표 정의

8월 매출 목표는 다음 두 숫자로 함께 관리한다.

| 지표 | 8월 목표 | 정의 |
|---|---:|---|
| 외부 실결제 총액 | 100,000원 | 관리자·0원·`payment_pending` 제외, 실제 승인액 합계 |
| 환불 차감 매출 | **100,000원** | 실결제 총액에서 완료된 환불액을 차감 |
| 기한 내 전달률 | **100%** | `due_at` 안에 결과 URL을 전달한 유료 주문 비율 |

첫 Basic 990원은 외부 실결제 총액과 `fulfilled paid order`에 포함한다. 결과가 완성됐고 구매자가 직접 열람했기 때문이다. 현재 목표 잔액은 **99,010원**이다.

### 3.2 판독기만으로는 10만 원에 도달할 수 없다

Basic과 Standard의 전체 재고를 각각 10건으로 제한하고 현재 가격을 유지하면 최대 결제액은 다음과 같다.

- Basic: 10 × 990원 = 9,900원
- Standard: 10 × 1,990원 = 19,900원
- 합계: **29,800원**

따라서 현재 재고만으로는 10만 원 목표의 29.8%밖에 만들 수 없다. 판독기 재고를 무작정 늘리거나 가격을 근거 없이 급격히 올리는 대신, 알리미 초기 설정비와 첫 30일 패스를 함께 판매해야 한다.

### 3.3 권장 매출 조합

알리미 파일럿을 Light 8명, Standard 8명에게 초기 설정과 첫 30일 패스를 함께 판매하면 다음과 같다.

| 구성 | 계산 | 결제액 |
|---|---:|---:|
| 판독기 제한 재고 | Basic 10 + Standard 10 | 29,800원 |
| 알리미 Light 8명 | 8 × (설정 1,990 + 30일 1,990) | 31,840원 |
| 알리미 Standard 8명 | 8 × (설정 2,990 + 30일 2,990) | 47,840원 |
| 합계 |  | **109,480원** |

이는 예측이 아니라 10만 원에 필요한 판매량 역산이다. 전원이 Light라면 알리미 약 18명이 필요하다. 따라서 8월 핵심 판매 목표는 **판독기 재고 20건 + 알리미 신규 설정 16건**으로 둔다.

---

## 4. 제품별 우선순위와 일정

### 4.1 8월 9일까지: 첫 결제 복구

1. ~~현재 Basic 결제 건을 Apify로 재실행하거나 concierge 결과로 생성한다.~~ 완료
2. ~~결과 URL을 소유자가 열 수 있는지 확인한다.~~ 완료
3. ~~구매자의 보관함 결과 열람을 확인하고 별도 URL 발송 여부를 결정한다.~~ 직접 열람 확인, 추가 발송 생략
4. 같은 설정에서 Basic E2E 한 건을 추가 canary로 완주한다.

### 4.2 8월 10일~11일: 판독기 E2E와 제한 판매

1. Apify Basic과 Standard를 각각 preflight부터 결과 페이지까지 완주한다. Basic 대상은 `winglss1`, Standard 대상은 `0_min._.00`으로 고정한다.
2. provider 실제 비용, Gemini 사용량, 소요 시간, 재시도 횟수, coverage를 기록한다.
3. 기존 Groble 재고 제한 Basic 10 / Standard 10을 유지한다.
4. likes/comments 범위는 유지한다. 원가 절감은 5.3의 1, 2단계까지만 한다.
5. 신규 결제를 기본적으로 닫지 않는다. 대신 아래 중단 기준을 자동 또는 운영 체크리스트로 집행한다.
6. 실제 Groble 재결제 대신 분리된 E2E 인증 계정과 signed test entitlement를 사용한다. 결제 경계는 이미 발생한 외부 실결제 원장과 별도 계약 테스트로 검증한다.
7. fresh E2E가 통과하면 ready preflight와 플랜 사이에 현재 published synthetic fixture를 축약한 demo 결과를 노출한다. 실제 대상의 결과처럼 보이게 만들지 않고 `예시 결과`로 명확히 표시하되, 기존 결과 컴포넌트와 디자인 시스템을 재사용해 결제 전에 결과 경험을 이해시키고 몰입을 만든다.

### 4.3 8월 12일까지: 맞팔 알리미 유료 파일럿 출시

판독기 전체 안정화나 selfhosted_auth를 기다리지 않고 다음 최소 범위로 판매한다.

- 기존 디자인 시스템, Supabase 인증, Instagram provider router, 관계 목록 정규화, Groble 1회 결제를 재사용한다.
- 첫 5명은 스냅샷, refresh 승인, diff 확인, 알림톡 발송을 concierge로 운영한다.
- 자동 갱신 구독 대신 `30일 감시 패스`로 결제받고 만료 전에 갱신을 안내한다.
- 결제 전 계정 규모를 확인해 Light 또는 Standard만 판매한다.
- 알림톡 실제 수신 canary가 통과하기 전에는 유료 접수를 열지 않는다.

### 4.4 8월 13일~31일: 매출 집중

- 트위터를 첫 실결제가 확인된 획득 채널로 우선 재현한다.
- 매일 같은 시각에 제품별 결제액, 환불액, 미전달 주문, 원가, 유입 source를 기록한다.
- 판독기보다 알리미의 결제 속도가 빠르면 신규 구현 시간은 알리미에 우선 배정한다.
- 판독기는 유입용 1회 상품, 알리미는 반복 매출 상품이라는 장기 구조를 유지한다.

---

## 5. 위장여사친판독기 운영 정책

### 5.1 판매와 중단 기준

신규 결제는 8월 11일까지 닫지 않는다. 제한 재고가 운영 부하 상한이다. 다만 다음 중 하나가 발생하면 해당 플랜 재고를 즉시 0으로 바꾼다.

- 결과가 없는 유료 주문이 3건 이상 쌓임
- 가장 오래된 주문의 `due_at`이 6시간 이내인데 분석 요청이 시작되지 않음
- 한 건이라도 전달 기한 초과
- 중복 청구 또는 중복 분석 발생
- 같은 원인의 E2E 실패가 두 번 연속 발생
- 환불 요청을 처리할 운영자가 없는 상태

재개 조건은 미전달 주문 1건 이하, 같은 플랜 canary 1건 완주, 예상 원가 상한 확인이다.

### 5.2 가격 정책

| 단계 | Basic | Standard | 전환 조건 |
|---|---:|---:|---|
| 현재 제한 판매 | **990원** | **1,990원** | 현재 재고 유지 |
| 1차 인상 실험 | **1,990원** | **2,990원** | 정상 전달 5건 + 플랜별 p95 원가 확인 |
| 2차 인상 후보 | 2,900원 | 4,900원 | 1차 가격에서 결제 전환과 마진을 확인한 뒤 별도 실험 |

첫 결제 한 건만으로 곧바로 2,900원 / 4,900원이 작동한다고 결론 내릴 수 없다. 반대로 990원이 유일하게 가능한 가격이라고도 결론 내릴 수 없다. 가격은 정상 전달 표본과 실제 원가가 생길 때 한 단계씩 올린다.

selfhosted_auth가 성공해도 990원 / 1,990원으로 자동 인하하지 않는다. 비용 절감분은 먼저 환불, 재시도, 계정 교체, 고객지원 여유로 남긴다.

### 5.3 원가 절감 순서

이번 운영 주기에는 다음 두 단계만 실행한다.

1. 공개 맞팔이 상세 상한을 넘을 때만 관계 수집 결과의 **`profile_pic_url`과 `fullname`**으로 1차 라우팅 점수를 만든다. 상한 이하면 모델을 호출하지 않고 전원을 상세 분석한다. username, bio, 기존 프로필 캐시 전수 검색은 입력과 보강 경로에서 제외한다. 1차 점수는 최종 성별 판정이 아니라 상세 수집 우선순위를 정하는 값이다.
2. 상세 profile·media·interaction 후보를 Basic 100명 / Standard 200명으로 제한한다. 상한을 넘는 모집단에서는 여성 우선 80%와 불확실 탐색 20%를 서로 겹치지 않게 뽑고, 부족분은 고정된 순서로 채운다. 동점은 요청·checkpoint·후보의 안정 식별자를 사용한 HMAC으로 결정한다.

상한 밖 공개 맞팔은 `unknown`이 아니라 `not_screened`로 기록한다. 상한 안 후보는 기존 상세 프로필·미디어 단계에서 최종적으로 여성·남성·미상으로 판정한다. `fetch/media/analysis_unavailable`는 screened unknown의 원인이지 별도 모집단이 아니다. 최종 미상 비율의 자동 완료 SLO는 screened 후보 기준 **30% 이하**다. 30%를 넘으면 bounded resolver를 실행하고, 그래도 넘으면 결과를 억지로 이진 분류하지 않고 `manual_review`로 보낸다.

30%는 답을 낸 범위를 보는 coverage gate일 뿐 성별 정확도를 증명하지 않는다. Basic/Standard E2E에서는 1차 점수를 보지 않는 blind review와 `not_screened` holdout으로 정확도를 별도 검사한다. 무료 credit도 공개 단가로 환산한다. provider+AI 변동원가 목표는 수수료 차감 후 계획 순수입인 Basic 904원 / Standard 1,817원이며, 제한 판매의 hard safety cap은 그 두 배인 1,808원 / 3,634원이다. 목표 초과·hard cap 이하는 `negative_margin_pilot`로 표시해 재고를 확대하지 않고, hard cap 초과는 자동화 출시 gate 실패다. 완결된 알고리즘·재시도·manifest·audit 계약은 [성별 라우팅 설계](../superpowers/specs/2026-08-10-gender-routing-cost-control-design.md)가 정본이다.

다음 항목은 후순위로 보류한다.

- 역방향 좋아요 조회 축소
- 후보→대상 좋아요 축소
- 후보→대상 댓글 축소
- 태그·멘션 등 interaction 범위 변경

likes/comments를 줄이는 결정은 위 두 단계의 실원가를 확인한 뒤 별도 승인한다.

### 5.4 이메일 전달 운영

- `paid`, `analysis_in_progress`, `manual_review` 화면은 결과 링크를 이메일로 보낸다고 안내한다.
- 자동 분석 E2E가 복구되기 전에는 운영자가 완료 목록을 확인하고 수동 발송한다.
- 이번 운영 주기에는 V2 완료 이메일 outbox를 구현하지 않는다. 미전달 유료 주문이 늘면 재고 중단 기준을 적용하고 자동 발송 범위를 별도 승인한다.
- 이메일 발송 성공만으로 완료 처리하지 않고, 소유자 전용 결과 URL이 실제 `completed` 요청을 가리키는지 확인한다.

### 5.5 결과 이미지 보존

- provider dataset의 CDN URL을 완성된 결과의 장기 이미지 URL로 저장하지 않는다.
- finalize 전에 대상, 결과 여성 후보, 비공개 후보의 표시 이미지를 내부 R2 result-image 객체로 캡처한다.
- 결과 API는 안정된 same-origin 불투명 경로만 반환하고, 원본 provider URL·버킷 객체 키·만료 URL을 immutable result에 넣지 않는다.
- Basic/Standard E2E는 결과 페이지의 대상·후보 이미지가 새 세션에서도 실제 로드될 때만 성공으로 판정한다.

---

## 6. 맞팔 알리미 감지 방식

### 6.1 `followers와 following이 모두 변할 때만 refresh`를 기본값으로 쓰지 않는 이유

AND 조건은 원가가 낮지만 실제 신규 맞팔을 놓친다.

- 상대가 이미 나를 팔로우 중인데 대상이 새로 상대를 팔로우하면 `following`만 변해도 신규 맞팔이다.
- 대상이 이미 상대를 팔로우 중인데 상대가 새로 대상을 팔로우하면 `followers`만 변해도 신규 맞팔이다.
- 언팔과 신규 팔로우가 같은 날 상쇄되면 count 자체가 그대로일 수도 있다.

따라서 AND-only를 “새 맞팔 알림”의 기본 정책으로 판매하면 핵심 약속과 맞지 않는다. 별도 `절약 감시` 옵션으로 제공할 수는 있지만 누락 가능성을 결제 전에 명확히 알려야 한다.

### 6.2 기본 감지 정책: 방향별 OR refresh

기본값은 다음과 같다.

1. 매일 profile count를 확인한다.
2. 한 방향만 바뀌면 그 방향 목록만 다시 수집한다.
3. 새 `following`은 캐시된 `followers`와, 새 `follower`는 캐시된 `following`과 교집합을 계산한다.
4. 두 방향이 모두 바뀌면 두 목록을 수집한다.
5. count 변동 직후의 일시적 흔들림을 피하기 위해 6~24시간 debounce 후 한 번만 실행한다.
6. 같은 날 여러 변화는 한 건의 알림톡으로 묶는다.

이 방식은 일상적인 한 방향 변화 때 두 목록을 모두 긁지 않으면서도 AND-only의 치명적인 누락을 피한다. 내부 원가 원장에서는 한 방향 수집을 0.5 full-refresh credit으로 계산한다.

count가 같은 순교체는 일별 count만으로 잡을 수 없다. 파일럿에서는 이를 제한사항으로 고지하고, 갱신 시점의 전체 감사에서 보완한다.

refresh credit은 사용자 화면에서 매번 차감되는 포인트가 아니라 **운영 원가 상한**이다. 그렇다고 상한을 넘어서 계속 무제한 수집하는 것도 아니다.

- Light와 Standard는 각각 표에 적힌 full-refresh 상당량까지만 목록 수집을 자동 승인한다.
- 상한에 도달하면 저비용 일별 count 감시는 계속하지만 목록 refresh와 상세 알림은 중지한다.
- 사용자에게 추가권 구매 또는 다음 30일 갱신을 안내한다. 자동 추가 과금은 하지 않는다.
- 추가권 구매나 다음 주기 시작 후에는 마지막 정상 스냅샷과 새 스냅샷의 순변화를 전달한다. 중지 기간 안의 날짜별 발생 순서까지 복원된다고 약속하지 않는다.

따라서 남자친구가 서로 다른 5일에 일반 계정을 한 명씩 팔로우해 내부 한도를 소진하면 서비스가 끝없이 비용을 쓰지 않는다. 신규 맞팔이 없더라도 새 following 정보 자체를 알림 가치로 제공할지는 파일럿에서 별도 카피·수요 신호로 검증하되, 현재 핵심 약속은 **새 맞팔 감지**로 유지한다.

---

## 7. 맞팔 알리미 가격 정책

### 7.1 출시 가격

| 플랜 | 계정 규모 조건¹ | 최초 설정비 | 30일 감시비 | 포함량 |
|---|---|---:|---:|---|
| Light | 각 방향 ≤400, 합계 ≤800 | **1,990원** | **1,990원** | 일별 count + full refresh 1회 상당의 내부 원가 한도 + 알림톡 |
| Standard | 각 방향 ≤800, 합계 ≤1,600 | **2,990원** | **2,990원** | 일별 count + full refresh 1회 상당의 내부 원가 한도 + 알림톡 |
| 초과 계정 | 위 상한 중 하나라도 초과 | 대기 신청 | - | 개별 견적 전 판매하지 않음 |

¹ 합계뿐 아니라 방향별 상한도 적용한다. 한 방향으로 치우친 계정의 원가 초과를 막기 위해서다.

랜딩의 주 가격은 `월 1,990원부터`로 노출한다. 설정비는 최초 기준 스냅샷을 만드는 비용으로 결제 직전에 숨기지 않고 함께 보여준다. 4,900원 / 7,900원은 수요 검증 전 파일럿 진입 가격으로는 높으므로 채택하지 않는다.

포함량을 초과하면 자동으로 추가 과금하지 않는다. 운영자가 비용을 확인한 뒤 다음 중 하나를 안내한다.

- Light full-refresh 추가권: 1,490원
- Standard full-refresh 추가권: 2,490원
- 다음 갱신일까지 목록 refresh 일시 중지

### 7.2 변화 없는 달 무료 이벤트

초기 이벤트로 채택한다.

- 대상: 파일럿 선착순 100계정 또는 2026-09-30까지 중 먼저 도달하는 시점
- 조건: 유료 30일 동안 follower/following count 변화가 한 번도 없어 목록 refresh가 실행되지 않음
- 혜택: 다음 30일 감시 무료 연장
- 방식: 환불 또는 0원 주문이 아니라 내부 이용 기간 연장
- 월별 예산 상한: 100계정 × 약 113원 = **약 11,300원**

설정비가 최초 전체 목록 원가를 부담하므로 무변화 연장 기간에는 일별 profile count와 종료/연장 알림 비용만 발생한다. 초기 100계정까지는 충분히 감수 가능한 획득 비용이다.

### 7.3 원가 계획

계획 기준은 다음과 같다.

- Apify relationship actor Starter: 결과 1,000개당 $0.70
- Apify profile actor Starter: 결과 1,000개당 $2.30
- SOLAPI 알림톡: 건당 13원, VAT 별도
- 계획 환율 버퍼: 1 USD = 1,450원
- Groble 수수료: 내부 운영 가정 8.69%

| 항목 | Light | Standard |
|---|---:|---:|
| 최초 전체 기준 목록 | 약 812원 | 약 1,624원 |
| 일별 profile count 30회 + 알림톡 1회 | 약 113원 | 약 113원 |
| full refresh 1회 포함 월 계획 원가 | 약 925원 | 약 1,737원 |
| 감시비 수수료 차감 후 계획 순수입 | 약 1,817원 | 약 2,730원 |
| 계획 공헌 여유 | 약 892원 | 약 993원 |

이 계산은 운영 인건비와 예외 지원을 포함하지 않는다. 따라서 첫 5명은 자동화 타당성보다 실제 결제와 운영 시간을 확인하는 concierge 파일럿이다.

단가 출처:

- [Apify followers/following actor 가격](https://apify.com/scraping_solutions/instagram-scraper-followers-following-no-cookies/pricing)
- [Apify Instagram profile actor 가격](https://apify.com/apify/instagram-scraper/pricing)
- [SOLAPI 가격](https://solapi.com/pricing)
- [Groble 결제창 연동 가이드](https://www.groble.im/help/guides/payment-module)

---

## 8. selfhosted_auth 전환 정책

selfhosted_auth는 첫 매출 조건이 아니라 장기 원가 절감 실험이다.

1. 개인 계정이 아닌 버너 계정 2~3개만 사용한다.
2. 계정별 operation set을 나눠 한 계정에 요청을 몰지 않는다.
3. 각 operation set이 3회 연속 성공해야 한다.
4. 마지막 성공 후 48시간 동안 401, 423, 429, challenge, `PleaseWaitFewMinutes`가 없어야 한다.
5. 수집 성공이 아니라 Basic/Standard 전체 E2E 성공으로 판정한다.
6. canary 트래픽에서 먼저 검증하고 Apify 즉시 rollback 경로를 유지한다.
7. 한 paid durable run 안에서 provider를 자동 혼합하지 않는다.

성공 후에도 가격을 자동 인하하지 않는다. Apify 대비 p50/p95 원가, 7일·30일 계정 생존율, 장애율, 현재 가격 전환율을 본 뒤 별도 결정한다.

---

## 9. 사용자 원장·결제 플래그·관측 정책

### 9.1 퍼널 집계 정정

기존 문서의 `checkout_started 고유 사용자 5명`은 외부 사용자 5명으로 사용할 수 없다. 당시 이름과 연결되지 않았던 2026-07-19 Basic 14,900원 checkout identity는 관리자였고, 별도로 지정된 내부 테스터도 모든 퍼널·매출 지표에서 제외해야 한다.

기존 숫자를 사람 이름 목록으로 유지하지 않는다. 앞으로 모든 Amplitude·Axiom·Supabase 집계는 서버에서 결정한 `traffic_class`를 공통으로 사용한다.

| `traffic_class` | 집계 정책 |
|---|---|
| `external` | 퍼널·매출·제품 KPI에 포함 |
| `operator` | 운영 검증으로 분리, 외부 KPI 제외 |
| `e2e_test` | E2E 품질 지표에만 포함, 외부 KPI 제외 |
| `internal_tester` | 기능 테스트로 분리, 외부 KPI 제외 |
| `unknown` | 외부로 자동 간주하지 않고 identity 정합성 큐로 보냄 |

따라서 과거 `checkout_started = 5` 표기는 폐기하고, 분류가 적용된 원시 이벤트로 다시 산출한 값만 사용한다. 실제 매출은 계속 Supabase 승인 원장이 정본이며 Amplitude checkout 이벤트로 대체하지 않는다.

### 9.2 E2E 계정 분리

2026-08-10 원격 원장을 읽기 전용으로 감사한 결과는 다음과 같다.

- `users` 물리 행은 50개다.
- Auth identity가 연결된 행은 33개, Auth identity가 없는 행은 17개다.
- Auth identity가 없는 17개는 명백한 테스트 결제·분석 흔적만 가진 합성 행이다.
- 테스트 흔적이 많은 Auth identity 한 개는 관리자 운영 계정이므로 E2E 계정으로 분류하거나 정리하지 않는다.
- 나머지 실제 가입 계정은 테스트 근거가 없으므로 E2E로 추정하지 않는다.

이에 따라 실유저와 테스트 사용자를 FK가 끊긴 별도 물리 테이블로 즉시 이동하지 않는다. 11개 FK와 현재 함수 정의 43개가 사용자 원장을 참조하므로, 단일 기준 원장 `account_principals`에 `account_class`, `traffic_class`, `lifecycle`을 두고 다음 표면을 분리한다. rename 전에 애플리케이션의 직접 사용자 읽기·쓰기를 stable service-only RPC로 옮기고 이전 revision을 drain한다.

- `users`: `production / active` 계정만 보이는 읽기 전용 운영 표면. 관리자 포함
- `e2e_users`: active와 retired를 lifecycle로 구분하는 service-role 전용 테스트 표면
- 신규 Basic/Standard E2E용 Auth identity는 두 개만 별도로 만든다.
- 17개 합성 행은 deterministic 조건과 사전 승인한 집합 HMAC이 모두 맞을 때만 server-only transaction에서 `e2e_test / retired`로 분류한다. 삭제하지 않는다.
- E2E 복구 후 활성 테스트 계정은 두 개만 유지하고, 실패 실험 계정은 세션을 폐기한 뒤 `retired`로 바꾼다.

`retired`는 표기만 바꾸는 값이 아니다. 기존 세션을 무효화하고 로그인 bootstrap, preflight, checkout, test entitlement, owner admission을 모두 fail-closed한다. 실제 cutover 순서와 함수 권한은 [계정 원장 설계](../superpowers/specs/2026-08-10-account-ledger-paid-status-design.md)를 따른다.

### 9.3 결제 상태

`is_paid_user`는 **한 번이라도 실제 승인 결제가 있었는가**를 뜻하는 paid-ever 플래그로 고정한다.

첫 외부 구매자의 값이 false인 것은 결제가 실패해서가 아니라, 현재 Groble 주문 확정 경로가 `users.is_paid_user`를 갱신하지 않기 때문이다. 주문 원장이 정본이고 플래그가 뒤처진 상태다.

- 서버가 `external`로 분류한 계정에 `payment.completed` event의 `disposition = accepted`와 주문 lineage가 확정되는 같은 트랜잭션에서 central writer가 `is_paid_user = true`와 가장 이른 `first_paid_at`을 기록한다.
- 환불 후에도 과거 구매 사실은 사라지지 않으므로 `is_paid_user`를 false로 되돌리지 않는다.
- 현재 유효한 이용권은 별도 `has_active_purchase` 파생 값으로 조회한다.
- 웹훅 경로뿐 아니라 운영 reconciliation로 결제가 확정돼도 같은 central DB writer를 사용한다.
- `payment_id`·`paid_at`·양수 금액만으로는 paid-ever를 올리지 않는다. 원격의 합성 E2E 주문도 이 형태를 가지므로 account/traffic 분류와 외부 결제 provenance가 모두 필요하다.
- 기존 승인 결제는 관리자·테스터 분류를 먼저 완료한 뒤 외부 주문만 backfill한다.

### 9.4 결과 공유와 Session Replay

채널마다 확인 가능한 성공 경계가 다르므로 하나의 `result_shared`로 뭉치지 않는다.

- 공유 UI/SDK 호출은 `result_share_initiated`다.
- 클립보드 resolve는 `result_share_copy_succeeded`다. 링크 복사이지 상대 전달 성공은 아니다.
- Web Share resolve는 `result_share_handoff_completed`다. 플랫폼에 따라 resolve 시점이 달라 실제 전송 완료로 부르지 않는다.
- Kakao는 공식 Share webhook이 도착한 경우에만 `result_shared_confirmed`다. webhook을 붙이기 전에는 initiated만 기록한다.
- share token 결과 페이지가 열리면 별도 `shared_result_opened`로 본다.
- 각 사건은 인증·권한 검증된 서버 경계를 거쳐 Amplitude와 Axiom에 같은 의미로 기록한다. Axiom 허용 필드는 `request_id`, bounded channel/outcome, `traffic_class`와 공통 metadata뿐이며 공유 URL, 토큰, 사용자 이메일, Instagram 식별자와 결과 내용은 금지한다.
- 공유 준비용 prewarm이나 `/api/share/enable` 호출은 어떤 성공 이벤트도 아니다.
- Session Replay는 결과 페이지의 레이아웃·일반 텍스트·프로필 카드와 이미지를 볼 수 있도록 과도한 `data-amp-block`을 제거한다. 로그인·결제 입력, 연락처, 자유 입력, 오류 원문과 인증정보는 계속 마스킹한다.

---

## 10. 매일 보는 숫자

| 지표 | 정의 | 운영 결정 |
|---|---|---|
| 외부 실결제 총액 | 관리자·0원·pending 제외 승인액 | 10만 원 진척 |
| 환불 차감 매출 | 실결제에서 완료 환불 차감 | 8월 최종 목표 |
| fulfilled paid order | 결과 URL 전달까지 끝난 유료 주문 | 가격 인상·재고 확대 |
| unresolved paid queue | 결과가 없는 유료 주문 수 | 재고 중단 기준 |
| delivery SLA | `due_at` 내 결과 전달률 | 판매 지속 여부 |
| delivery cash cost | provider + AI/GCP + 재시도·알림 비용 | 가격·범위 결정 |
| product/source revenue | 제품·유입 source별 승인액 | 마케팅 시간 배분 |
| alert setup sold | 유료 알리미 최초 설정 수 | 16건 목표 |
| refresh cost/operator minutes | 알리미 refresh당 비용과 수동 시간 | 자동화 우선순위 |
| free extension liability | 무변화 무료 연장 계정 수와 예상 113원 | 이벤트 예산 상한 |
| screened unknown ratio | 상세 수집 후보 중 최종 미상 비율 | coverage gate; 정확도와 별도 관리 |
| traffic-class leakage | 외부 KPI에 operator/test가 섞인 건수 | 0건이 아니면 대시보드 숫자 폐기 |
| paid-flag drift | accepted 외부 결제와 `is_paid_user`가 불일치한 계정 | central writer·backfill 장애 확인 |
| share initiated / handoff / confirmed | 시도·복사/OS handoff·Kakao 확인 전송 | 채널별 공유 루프 판단 |

---

## 11. 이번 달에 하지 않을 것

- 첫 결제 장애만 보고 판독기를 전면 보류
- 판독기 완전 안정화 또는 selfhosted_auth 완료까지 알리미 출시 대기
- 첫 결제 직후 근거 없이 2,900원 / 4,900원으로 일괄 인상
- likes/comments를 1, 2단계 원가 실측 전에 축소
- AND-only 감지를 누락 없는 신규 맞팔 알림으로 판매
- 알리미 수요 검증 전에 자동 갱신·대규모 스케줄러 완성
- 자동 이메일이 없는 상태를 숨기고 무인 운영으로 간주하거나, E2E 복구 전에 이메일 자동화부터 구현
- `payment_pending` 또는 환불 완료 주문을 매출로 집계
- 결제자 이름, UUID, 대상 Instagram ID, 정확한 출생연도를 전략 문서에 기록
- 확정된 판독기 랜딩 마케팅 카피 변경

---

## 12. 팀 실행 체크리스트

### 첫 결제와 판독기

- [x] 결제·웹훅·판매자 참조 확인
- [x] 결제자가 실제로 본 화면을 Amplitude 원시 이벤트로 확인
- [x] 장애 원인을 selfhosted_auth fresh admission 실패로 특정
- [x] production scraper를 Apify로 rollback하고 실제 serving traffic 100% 확인
- [x] 결제 후 이메일 결과 안내 화면 배포
- [x] 첫 결제 건 결과 생성 및 소유자 URL 확인
- [x] 구매자가 보관함에서 결과를 직접 열람
- [x] 운영자 계정으로 구매자 결과 조회 확인
- [ ] Apify Basic 전체 E2E 1건 완주
- [ ] Apify Standard 전체 E2E 1건 완주
- [ ] 플랜별 실제 비용·시간·coverage 기록
- [ ] 완료 결과의 대상·후보 R2 이미지 로드 확인
- [ ] screened 최종 미상 비율 30% 이하, blind audit와 비용 cap 통과
- [ ] preflight 이후 synthetic demo 결과 노출과 `demo_result_viewed` 계측

### 맞팔 알리미

- [ ] Light/Standard 최초 설정 상품과 30일 패스 준비
- [ ] 방향별 OR refresh 운영 체크리스트 준비
- [ ] 무변화 30일 무료 연장 원장 준비
- [ ] 알림톡 실제 수신 canary 통과
- [ ] 8월 12일까지 유료 접수 시작
- [ ] 첫 5명 concierge 운영 시간과 원가 기록
- [ ] 8월 신규 설정 16건 판매

### 안정화와 자동화

- [ ] 원가 절감 1단계: 관계 payload 재사용
- [ ] 원가 절감 2단계: 80/20 라우팅으로 Basic 100 / Standard 200 후보 상한
- [ ] `account_principals` + production `users` / service-only `e2e_users` 표면 분리
- [ ] 두 개의 전용 E2E Auth identity 생성, 기존 합성 테스트 행 retired 분류
- [ ] paid-ever central writer·`first_paid_at` backfill·`has_active_purchase` 조회
- [ ] 공유 initiated/copy/handoff/Kakao confirmed의 Amplitude·Axiom 서버 관측 추가
- [ ] 결과 Replay의 과도한 block 해제와 민감 입력 마스킹 회귀 테스트
- [ ] 정상 전달 5건 후 1,990원 / 2,990원 가격 실험 판정
- [ ] 버너 2~3개 selfhosted_auth canary는 매출 작업과 분리

---

## 13. 최종 판정문

첫 Basic 990원 결제는 판독기 수요가 0이라는 가설을 깨뜨렸다. 따라서 판독기를 지금 보류하는 것은 성급하다. 그러나 제한 재고를 모두 팔아도 10만 원에 못 미치고, 첫 주문에서 운영 장애도 확인됐다. 판독기에만 다시 올인하는 것 역시 8월 목표와 맞지 않는다.

맞팔 알리미는 판독기의 결과 경험을 기다리지 않고 기준 스냅샷 자체로 첫 가치를 줄 수 있다. 초기 설정비를 분리하면 변화 없는 달의 원가가 약 113원으로 낮아져 무료 연장 이벤트도 감당할 수 있다. 다만 AND-only는 실제 신규 맞팔을 놓치므로 기본값은 방향별 OR refresh가 맞다.

따라서 8월의 실행 순서는 다음과 같다.

> **첫 유료 주문 열람 완료 → 전용 테스트 계정으로 Apify Basic/Standard E2E 복구 → 판독기 제한 판매 유지와 맞팔 알리미 `월 1,990원부터` concierge 파일럿 병행 → 두 제품 합산 환불 차감 매출 10만 원 달성 → selfhosted_auth는 별도 원가 절감 canary로 검증.**
