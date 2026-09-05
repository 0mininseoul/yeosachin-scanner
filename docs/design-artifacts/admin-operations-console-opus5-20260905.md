# 판독 운영 콘솔 재설계 — 근거와 데이터 계약 공백

- 아티팩트: `docs/design-artifacts/admin-operations-console-opus5-20260905.html` (자체 완결 HTML 1개)
- 성격: **디자인 전용**. 프로덕션 React·API·DB·마이그레이션·배포·프로바이더·큐·결제 변경 없음. PR 없음.
- 데이터: 전부 합성. 실제 계정·주문·이용자 값이 아닙니다.
- 기준 커밋: `origin/main` @ `b2e83433`
- 검증: Chromium 1440 / 1024 / 768 렌더링, 콘솔 오류 0건

---

## 1. 직전 시안과 무엇을 다르게 했나

직전 시안(`admin-operations-dashboard-visibility-opus5-20260904`)은 이미 밝은 팔레트였는데도
"직관적이지 않고 잘 안 보인다"로 반려됐습니다. 그래서 이번에는 **색이 아니라 정보 구조**를 바꿨습니다.

| 직전 | 이번 | 이유 |
| --- | --- | --- |
| 탭 3개(요약/계정/주문) | **탭 없음.** 계정과 주문이 한 화면 | 운영자의 첫 질문("앞으로 몇 건 더 돌릴 수 있나")은 계정 잔액 ÷ 주문 원가라 두 탭에 걸쳐 있었음 |
| 산문 판정 문장이 히어로 | **숫자가 히어로** — `약 154건` | 운영 보드는 문장이 아니라 계기판으로 읽힘 |
| 단계 스테퍼, 한 번에 한 단계만 표시 | **6단계 전부 상시 노출**, 열어도 나머지가 접히지 않음 | 요구된 6개 증거 그룹을 서로 비교해야 결함 위치가 보임 |
| 유료 채널 전용 보라색 | **전용 색 없음.** 유료는 별도 섹션으로 물리적 분리 | 영구히 변하지 않는 구분은 색보다 구조가 맞음. 색은 상태 전용으로 비움 |
| CASE FILE 시각 언어 | 없음 | — |

### 이번 시안의 단 하나의 대담한 요소: `최초 이탈` 띠

증거 단계는 실제 파이프라인 순서(맞팔 → 1차 성별 → 최종 성별 → 좋아요 → 댓글 → 위험 산출)로 놓았습니다.
선언 수와 수집 수가 **처음으로** 어긋나는 단계 위에 검은 띠가 한 줄 들어갑니다.

> **최초 이탈** — 여기서 처음으로 수집 수가 선언 수와 어긋납니다. 앞 단계는 모두 완전하므로 원인은 이 단계입니다.

페이지에서 채도 높은 영역은 `확인 필요` 블록과 이 띠 둘뿐입니다. 나머지는 흰 바탕 + 1px 헤어라인입니다.
이 띠 하나가 "어느 단계를 봐야 하는가"라는 판단을 운영자 대신 끝내줍니다.

### 결함 발견이 빠른 이유

- 모든 목록이 **결함 우선 정렬**입니다. 계정은 차단 → 주의 → 제외 → 정상, 주문 기본 필터는 `결함 있는 것만`.
- 각 행이 **결함 사유를 자체적으로** 들고 있습니다. 드릴다운은 *증거*를 보려고 여는 것이지 *무엇이 잘못됐는지* 알아내려고 여는 게 아닙니다.
- `선언 / 수집` 쌍을 전 화면 공통 문법으로 고정했습니다. 스키마의 `*_declared` / `*_collected` 컬럼이 실제 귀속 완전성 기본 단위이기 때문입니다.

### 상태는 색만으로 표현하지 않음

모든 상태 칩은 `사각형 + 색 + 한국어 라벨` 세 겹입니다. 색각 이상·흑백 인쇄에서도 읽힙니다.

---

## 2. 화면이 답하는 순서

1. **앞으로 몇 건 더 돌릴 수 있나** — `약 154건`. 근거를 바로 밑에 붙였습니다:
   실측 주문 원가 중앙값 `$0.317`, 잔액을 신뢰할 수 있는 계정만 합산 `6/10`.
2. **지금 손댈 게 뭔가** — `확인 필요 8건`. 계정 결함과 주문 결함을 한 목록에 섞어
   차단 → 주의 순으로 세웠습니다. 주문 항목은 바로 드릴다운으로 넘어갑니다.
3. **이 주문은 얼마 들었고 어디서 틀어졌나** — 주문 행 클릭 → 상세.

### 계정 10개

- `secondary` 1개만 **유료 계정** 섹션에 단독으로 둡니다. 실제 과금이 발생하는 유일한 계정이고,
  `POST { action: 'refresh-paid-secondary' }`로 즉시 재조회할 수 있는 유일한 계정입니다.
- 나머지 9개는 **무료 계정** 표. `PATCH { credentialSlot, excluded }`가 무료 슬롯만 받으므로
  배차 제외/복귀 버튼도 이 표에만 있습니다.
- 잔액이 **미상**인 계정(`freshnessState !== 'fresh'`)은 숫자 자리에 `미상`을 쓰고
  게이지를 빗금으로 비웁니다. 오래된 값을 현재 잔액처럼 보여주지 않습니다.
  이건 스키마가 강제하는 불변식이기도 합니다 — `fresh`가 아니면 `effectiveRemainingUsd`는 NULL입니다.

### 주문 원가

`실비`와 `보수 추정`을 **다른 열**로 둡니다. 섞지 않는 이유는 4절 G8을 보세요.

---

## 3. 디자인 토큰

```
--board   #EEF1F5   페이지 바탕(차가운 연회색)
--surface #FFFFFF   카드·표 표면
--ink     #16202B   본문            흰 바탕 대비 16.46:1
--ink-2   #4A5A6E   보조 텍스트                  7.05:1
--ink-3   #5D6D80   주석                         5.30:1
--line    #D3DBE4 / --line-2 #E7ECF2   헤어라인
--ok      #0A6E4A   정상   (--ok-bg   #E6F4EE)   5.55:1
--warn    #8A4A00   주의   (--warn-bg #FBF0E2)   6.10:1
--bad     #B01818   차단   (--bad-bg  #FBEAEA)   6.04:1
--sel     #1B4FD8   선택·링크성 액션             6.65:1
```

대비는 브라우저에서 WCAG 상대휘도 공식으로 계산해 확인했습니다. 전부 AA(4.5:1) 이상입니다.

- 타이포는 한 벌(`Apple SD Gothic Neo → Pretendard → Noto Sans KR` + 시스템 산세리프)만 씁니다.
  **숫자가 디스플레이 타입입니다** — 큰 값은 `tabular-nums` 700 웨이트, 라벨은 작고 조용하게.
- 모노스페이스는 **비교해야 하는 값에만** 씁니다(요청 ID, 번들/결과 해시, 게시물·증거 ID, 결함 코드).
  장식이 아니라 자릿수 정렬이 목적입니다. 한글에는 쓰지 않습니다.
- 대문자 트래킹 eyebrow 라벨은 **한 개도 없습니다.**
- 그래프는 **없습니다.** 잔액 게이지만 남겼고, 6px 단색 막대에 숫자를 항상 병기합니다.
- 사용자 동작이 없는 애니메이션은 없습니다. `prefers-reduced-motion`도 존중합니다.

### 반응형

| 폭 | 처리 |
| --- | --- |
| ≥1180 | 여력/확인필요 2단, 상세 지표 4칸, 단계 헤더 6열 |
| 860–1180 | 여력/확인필요 1단, 지표 2칸, 단계 헤더에서 누락 건수 열 숨김 |
| ≤860 | 지표 1칸, 단계 헤더 3열 그리드로 명시 배치 |

넓은 표는 각자 `overflow-x:auto` 안에서만 스크롤합니다. **페이지 본문은 어느 폭에서도 가로 스크롤되지 않습니다**
(1440/1024/768에서 `scrollWidth === clientWidth` 확인).

---

## 4. 데이터 계약 공백

아래는 코드를 읽어 확인한 사실입니다. 시안이 **현재 계약만으로는 못 그리는 것**들입니다.

### G1. 영구 보관 상태를 읽을 수 있는 경로가 없음 — **요구사항 직접 충돌**

- `analysis_order_audit_bundle_payload()`가 돌려주는 필드에 보관/퍼지 관련 항목이 없습니다.
- `analysis_order_audit_assembly_queue`에는 `status`, `purge_fenced_at`, `purge_fence_reason`, `purged_at`이
  있지만, **이 테이블을 읽는 운영자용 RPC가 없습니다.**
- `orderAuditListRowSchema`는 `.strict()`이고 보관 필드가 없습니다.
- `analysis_order_audit_candidates`에도 후보별 보관 컬럼이 없습니다.

→ 요구된 "영구 보관 상태"는 **현재 데이터로 렌더할 수 없습니다.** 시안은
`retention { state: 'retained'|'pending'|'fenced', version, assembledAt, purgeFencedAt, reason }`를
**제안 필드**로 두고, 위험 행에는 주문 단위 값을 상속시켜 표시합니다(후보별 필드가 없으므로).
필요한 최소 변경: 번들 payload에 큐의 `status`/`purge_fenced_at`/`purge_fence_reason`을 투영.

### G2. 드릴다운 행 모양이 TypeScript 계약에 고정돼 있지 않음

`orderAuditLoadPayloadSchema.rows`는 `z.array(z.object({}).passthrough()).max(50)`입니다.
실제 컬럼 집합은 SQL RPC 안에만 있습니다. UI는 필드명을 하드코딩할 수밖에 없고 컴파일 타임 보증이 없습니다.
섹션별 행 스키마를 TS에 명시하면 이 시안의 표는 그대로 타입 안전해집니다.

### G3. 성별 판정 단계별 건수를 서버에서 못 받음

- `section=gender`의 `total`은 필터에 걸린 **후보 수**이지, 1차/최종 판정이 있는 건수가 아닙니다.
- 번들 요약에는 `mutuals.screened` 하나뿐이고 1차/최종이 나뉘어 있지 않습니다.
- `pageSize` 상한이 50이라 전체를 세려면 후보 전량을 페이징해야 합니다.

→ 시안의 2·3단계 `수집 / 선언` 숫자는 **클라이언트에서 전체 로스터를 세어** 만든 값입니다.
실데이터에서는 불가능합니다. 번들 요약에 `gender.initialResolved` / `gender.finalResolved` 카운트가 필요합니다.

### G4. `section=gender` 하나가 서로 다른 두 질문을 담당

1차와 최종이 한 행의 `initial` / `final` 하위 객체로 옵니다. 목록으로는 충분하지만
두 단계는 **독립적인 건수와 독립적인 완전성**이 필요합니다(G3과 같은 뿌리).

### G5. 주문 간 집계 엔드포인트가 없음

`list_analysis_order_audit_bundles`는 키셋 페이징(최대 50)뿐이고 "오늘 총 원가", "원가 중앙값" 같은
서버측 집계가 없습니다. 시안의 `약 154건` 산출에 쓰인 중앙값은 **불러온 페이지에서만** 계산한 값이라
실데이터에서는 표본 편향이 생깁니다. 여력 지표를 쓰려면 집계 RPC가 필요합니다.

### G6. 관리자 인증 방식이 두 갈래

| 엔드포인트 | 인증 |
| --- | --- |
| `/api/admin/order-audit`, `/api/admin/apify-accounts` | 운영자 세션 (`createClient()` + `getAnalysisAuditOperatorDecision`) |
| `/api/admin/token-usage`, `/api/admin/analysis-observability` | `hasValidAdminAuthorization(Authorization 헤더)` |

→ 브라우저 세션으로 동작하는 이 콘솔은 뒤쪽 두 개를 **호출할 수 없습니다.**
Gemini 토큰 사용량, `costPolicy`, betatest 풀 관측치는 현재 설계에서 접근 불가입니다.

### G7. "토큰 잔량"이라는 단위가 Apify 계약에 없음

인벤토리는 전부 USD입니다(`monthlyLimitUsd`, `monthlyUsageUsd`, `effectiveRemainingUsd`).
토큰 단위는 없고, Gemini 토큰 사용량은 계정별이 아니며 다른 인증 뒤에 있습니다(G6).

→ 시안은 잔여 용량을 **USD + 실측 주문 원가 중앙값으로 나눈 "≈N건"**으로 표현합니다.
이 환산은 두 계약을 클라이언트에서 조인한 파생값이고, 서버가 주는 필드가 아닙니다.

### G8. 사용량이 미상이면 `knownUsd`는 항상 NULL

마이그레이션에서 확인:

```sql
IF NOT v_cost_usage_unknown THEN
    v_cost_known := v_total_known;
END IF;
v_cost_conservative := v_total_conservative;
```

- `cost.status = 'unknown'` → `knownUsd`는 NULL, `conservativeUsd`만 존재
- `cost.status = 'not_available'` → 둘 다 NULL (원가 롤업 행 자체가 없음)

→ 시안이 `실비`와 `보수 추정`을 절대 같은 칸에 넣지 않는 이유입니다.
보수 추정을 실측 원가처럼 보여주면 운영자가 확정되지 않은 금액을 확정된 것으로 읽습니다.
`미확정`·`원장 없음`은 숫자 자리에 그대로 글자로 씁니다.

### G9. 주문 ↔ 계정 연결은 `providerRuns[].credentialSlot` 하나뿐이고 부분적

`providerRuns`는 `followers`/`following`/`target_likers`/`target_comments` 4단계에 대해
`credentialSlot`을 갖습니다. 그러나 Apify가 아닌 경로(예: rapidapi)에는 슬롯이 없고,
**AI(Gemini/Vertex) 비용에는 슬롯 개념 자체가 없습니다.**

→ "이 주문은 어느 계정이 냈나"는 **Apify 단계에 한해서만** 답할 수 있습니다.
시안의 `과금 계정` 칸은 이 한계를 그대로 노출합니다(단계별 `stage: provider / slot` 나열).

### G10. 상호작용 누락 사유는 번들 수준에만 있음

행이 아예 수집되지 않으면 그 행은 목록에 나타날 수 없습니다. 누락 건수는 요약의
`declared - collected`로, 사유는 번들 `gap_codes`(`TARGET_LIKES_ROWS_GAP` 등)로 읽어야 합니다.
시안도 그렇게 배치했습니다 — 단계 헤더에 `8건 누락`, 주문 행에 결함 코드.
행 단위 `gapCodes`는 *수집됐으나 불완전한* 행에만 의미가 있습니다.

---

## 5. 시안에서 실제로 동작하는 것

브라우저에서 확인한 항목입니다.

- 주문 행 클릭 / 키보드 포커스 → 상세 진입, `← 주문 목록`으로 복귀
- 증거 6단계 개별 펼침 — **하나를 열어도 나머지가 접히지 않음**
- 단계별 필터(`전체`/`공개`/`비공개`, `좋아요만`, `댓글만`, `공개만`)와
  `pageSize=25` 커서 페이징 (실제 RPC 파라미터를 화면에 표기)
- 위험 행 `산식 보기` → 8개 기여도 원장 + 점수 전이(pre → raw → public → final) + 보관 상태
- 무료 계정 `배차 제외 / 배차 복귀` → 여력·가용 계정 수·무료 잔여가 함께 재계산
  (octonary 복귀 시 `154건 → 168건`, `$14.69 → $19.29`로 일관되게 반영)
- 유료 계정 `지금 잔액 새로고침` (호출 흉내, 실제 프로바이더 호출 없음)

### 합성 데이터가 계약을 지키는 방식

- 슬롯 10개가 정규 순서 그대로, `secondary`만 `paid`, 나머지 9개는 `free`
- `freshnessState !== 'fresh'` → `effectiveRemainingUsd`는 NULL, 화면은 `미상`
- `cycleResetAt === billingCycleEndAt`
- `secondary`는 `manuallyExcluded` 될 수 없음 (배차 제어 버튼이 무료 표에만 있음)
- 결함 코드는 실제 어휘만 사용: `COST_USAGE_UNKNOWN`, `PROVIDER_USAGE_UNKNOWN`,
  `TARGET_LIKES_ROWS_GAP`, `RISK_SCORES_MISSING`, `CANDIDATE_FEATURES_MISSING`,
  `CANDIDATE_KEY_SET_GAP`, `CANDIDATE_LIKES_SOURCE_MISSING`, `COST_SOURCE_MISSING`
- 주문 4건은 서로 다른 결함 유형을 보여주고, 각각 `최초 이탈` 위치가 결함 코드와 일치합니다:

| 주문 | 결함 | 최초 이탈 |
| --- | --- | --- |
| `@yeonwoo_.k` | `TARGET_LIKES_ROWS_GAP` | 4단계 좋아요 (88/96) |
| `@seoyunnn_` | `RISK_SCORES_MISSING` | 6단계 위험 산출 (0/260) |
| `@minseo.ye` | `CANDIDATE_KEY_SET_GAP` | 1단계 맞팔 (339/347) |
| `@chaerin_00` | `COST_SOURCE_MISSING` | **없음** — 원가만 결함, 증거는 완전 |

마지막 행이 중요합니다. **원가 귀속과 증거 완전성은 서로 독립적인 축**이고,
시안은 둘을 따로 읽을 수 있게 분리해 뒀습니다.
