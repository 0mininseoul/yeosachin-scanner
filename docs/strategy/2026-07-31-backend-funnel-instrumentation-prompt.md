# 백엔드 세션 인계 프롬프트 — 계측 신뢰성 + 익명 preflight 지원

- 최초 작성: 2026-07-31 / **개정: 2026-08-05** (레포 175커밋 반영, 항목 5개 추가)
- 관련 문서: [린 캔버스](./2026-07-31-lean-canvas.md) · [익명 preflight UX 설계](./2026-08-05-anonymous-preflight-ux-design.md)
- 성격: **정책 결정 1건 + 계측 수정 6건 + 익명 preflight 지원 3건**

아래 `---` 사이를 백엔드 세션에 그대로 전달하면 됩니다.

---

# 배경 — 왜 지금인가

실측 퍼널을 처음 뽑았고(Amplitude Dashboard REST API, 2026-07-01~08-05, 관리자 `974247fa-8d0e-4ab7-b6d2-ddf256ad6bdd` 제외, uniques는 `seriesCollapsed`), **계측을 신뢰할 수 없다는 것이 드러났다.**

| 단계 | uniques |
|---|---:|
| `landing_viewed` | 341 |
| `target_submitted` | 108 |
| `auth_completed` | 27 |
| `preflight_succeeded` | 18 |
| `plan_viewed` | 18 |
| `plan_selected` | 10 |
| `checkout_started` | 5 |
| `checkout_redirected` | 3 |
| `payment_confirmed_viewed` | 3 |

그리고 제품 방향으로 **로그인 시점을 preflight 뒤(결제 클릭 시점)로 옮기는 변경**이 검토되고 있다. 그 변경의 효과를 측정하려면 계측이 먼저 고쳐져야 한다.

작업은 세 묶음이다. **A(계측 신뢰성)를 먼저, B(익명 preflight 지원)는 UX 변경과 함께, C는 참고 사항.**

---

# A. 계측 신뢰성

## A1. 익명→로그인 identity 병합 오계상 — 최우선

### 확정된 증상

Supabase `earlybird_orders` 원장(17행)에서 **결제 흔적이 있는 주문 10건**(`paid` 3 / `analysis_in_progress` 6 / `completed` 1)이 **전부 관리자 계정 `974247fa-…` 하나**다. 비관리자는 `payment_pending` 3명과 `payment_failed` 1명뿐이고 결제는 0건이다.

그런데 Amplitude에서 **관리자를 제외한 3명**이 `payment_confirmed_viewed`를 발화했다(`status=paid` 3건, plan_id는 standard 2 / basic 1).

> **즉 관리자 한 명의 행동이 Amplitude에서 최소 3명의 별개 사용자로 집계되고 있다.**

### 원인은 가설 단계 — 검증부터 할 것

`lib/services/analytics.ts`에 `identityRevision` 큐와 `pruneQueuedEventsForCurrentIdentity`, `setSdkUserId`, `resetSdkIdentity`, `bootIdentityRequiresReset`이 이미 있다. 단순 race가 아닐 수 있으므로 **원인을 단정하지 말고 아래를 실제로 재현·확인**할 것.

확인할 후보:

1. **발화 시점이 identity 설정보다 이른가.** `app/earlybird/earlybird-status.tsx:57`의 `useEffect(..., [order])`는 서버 props인 `order`에만 의존하고 auth identity 확정을 기다리지 않는다. Supabase 세션 복원이 끝나기 전에 발화하면 익명 상태로 나간다
2. **익명 이벤트가 로그인 후 병합되는가.** Amplitude가 device_id 기반 익명 사용자를 이후 `setUserId`된 사용자와 같은 사람으로 합치는지, 아니면 별개로 남는지
3. **세션·기기별로 분리되는가.** 같은 Supabase 사용자가 다른 브라우저·기기에서 접속했을 때 `user_id`가 일관되게 붙는지
4. **`tryClaimAnalyticsEvent`의 storage 스코프.** dedup 키가 storage 단위라 기기가 바뀌면 재발화된다 — totals 중복 요인이지 uniques 분리 원인은 아니지만 함께 본다

### 완료 판정

- 같은 Supabase 사용자의 이벤트는 기기·세션·로그인 전후와 무관하게 **하나의 Amplitude user로 집계**된다
- **원장 대조가 맞는다**: `payment_confirmed_viewed`의 고유 사용자 수 = `earlybird_orders`에서 `paid`/`analysis_in_progress`/`completed` 상태를 가진 고유 `user_id` 수
- 회귀 테스트로 고정한다

## A2. `payment_confirmed_viewed` 의미 정정

현재 이 이벤트는 `paymentConfirmationEventKey`(`lib/services/earlybird/analytics-state.ts:27`)에 따라 주문 상태가 `paid`/`analysis_in_progress`/`completed`일 때 발화한다. 즉 **"결제 완료"가 아니라 "결제 확인 화면을 봤다"**이다.

실제로 원장에는 `actual_amount_krw = 0`인 주문이 다수이고 `payment_id`가 `manual_recon_…`인 수동 대사 건도 있다. **이 이벤트를 매출 지표로 쓰면 안 된다.**

**요청**: 이름 또는 정의를 정정하고 문서에 반영한다.

- **(권장) 이름 유지 + 의미 명문화.** `docs/amplitude-analytics-operations.md`에 "이 이벤트는 결제 확인 화면 조회이며 매출 정본은 Supabase"라고 명시. 기존 대시보드가 깨지지 않는다
- 이름 변경 시 `payment_status_viewed`처럼 사실에 맞게. 단 기존 저장 차트와 히스토리 단절을 감수해야 한다

어느 쪽이든 **실매출 확정은 `earlybird_orders`의 `payment_id`·`actual_amount_krw`·`paid_at`이 모두 있는 행**으로만 한다.

## A3. 분석 생명주기 서버측 발화 (최초 요청 사항)

`analysis_started`/`analysis_completed`가 **클라이언트에서만** 발화되어 진행 화면 이탈 시 누락된다. 분석은 Cloud Tasks가 소유해 서버에서 완주하는데 그 사실이 기록되지 않는다.

현재 발화 지점:

| 이벤트 | 위치 |
|---|---|
| `analysis_started` | `hooks/useAnalysisV2Preflight.ts`, `hooks/useAnalysisProgress.ts` |
| `analysis_completed` | `hooks/useAnalysisProgress.ts`, `app/result/[requestId]/page.tsx` (결과 페이지 진입 보완 발화) |

### 먼저 결정할 것 (구현보다 앞선다)

`docs/amplitude-analytics-operations.md`가 이렇게 못박고 있다.

> "Analytics는 클라이언트에서만 전송한다. Groble webhook 등 서버 요청에서 Amplitude 이벤트를 보내지 않는다."

이 작업은 이 규칙을 바꾼다. 소유자와 함께 확정하고 **문서를 먼저 고칠 것.**

- **(권장) 옵션 A** — 분석 파이프라인 terminal 상태에 한해 서버 발화를 허용하도록 개정. 결제·webhook 경로의 서버 발화 금지는 유지
- 옵션 B — Amplitude를 건드리지 않고 Supabase 원장 쿼리로 퍼널을 본다. 다만 앞단 퍼널이 Amplitude에 있어 결합 분석이 번거롭다

### 요구사항

- **원장 사실 기준으로 발화한다.** `analysis_started`는 admission 통과 후 첫 job 시작, `analysis_completed`는 결과가 조회 가능해진 시점
- **`analysis_failed` 신설.** 현재 vocabulary에 실패 이벤트가 없어 완주율의 분모를 볼 수 없다. `error_code`는 기존 닫힌 enum 재사용
- **중복 제거**: 서버를 정본으로 하고 클라이언트 발화를 제거하는 쪽을 권장. `app/result/[requestId]/page.tsx`의 보완 발화는 존재 이유가 사라지므로 함께 제거 대상
- **Cloud Tasks 재시도가 이벤트를 중복 발화시키지 않도록** 원장에 발화 여부를 기록하거나 멱등 키 사용
- 전송 실패가 파이프라인에 영향을 주면 안 된다 (fail-open)
- `lib/services/amplitude-funnel-caller-contract.test.ts`가 caller 위치를 정규식으로 고정하고 있으므로 함께 갱신

### 완료 판정

같은 기간 **서버 완료 이벤트 수 = `analysis_v2` terminal 성공 요청 수.** 클라이언트 이벤트와의 차이를 한 번 기록해 둘 것 — 그 차이가 그동안 놓친 양이다.

## A4. preflight 실패 사유 세분화

`preflight_started` 26명 중 **13명이 `VALIDATION_ERROR`**다(그 외 `INTERNAL_ERROR` 2, `PROVIDER_ERROR` 1). 로그인을 통과한 사람의 절반이 여기서 막히는데 **닫힌 enum이라 무엇 때문에 막혔는지 구분되지 않는다.**

또한 Amplitude `preflight_started`는 26명인데 **Supabase `analysis_preflights`의 고유 `user_id`는 5명뿐**이다.

**요청**

1. **먼저 원인을 확인한다** — VALIDATION_ERROR가 preflight 행 생성 **전에** 거부되는 것인지, purge로 지워지는 것인지. 전자라면 실패 사유를 사후 분석할 서버 원장이 아예 없다는 뜻이다
2. **실패 사유를 서버 원장에 남긴다.** PII 없이 사유 코드만. 대상 인스타그램 아이디·원문 오류 메시지는 저장하지 않는다
3. **`error_code` 하위 사유를 세분화한다.** 최소한 다음이 구분돼야 한다
   - 핸들 형식 오류
   - 대상 계정 없음
   - **비공개 계정**
   - **플랜 상한 초과** (Plus 한도 초과 포함)
   - 본인 계정 제외 규칙 위반
   - provider 일시 실패
4. 세분화한 값이 기존 닫힌 allowlist를 통과하도록 스키마를 함께 확장한다

**왜 중요한가**: 익명 preflight로 바뀌면 이 실패가 더 앞단으로 나와 더 많은 사람이 만난다. 원인을 모른 채로 개방하면 안 된다.

## A5. 공유 링크 유입 → 본인 분석 전환 트래킹

`result_viewed`를 `is_shared`로 나누면 **True 17 / False 1**이다. 즉 결과를 본 18명 중 17명이 **공유 링크로 들어온 외부인**이다. 공유를 보낸 사람은 관리자뿐이지만, **링크를 받아서 여는 행동은 외부에서 실제로 일어난다.**

지금 알 수 없는 것: **그 17명이 자기 것도 분석했는가.** 바이럴 루프의 마지막 고리인데 측정되지 않는다.

**요청**

- `/share/[token]` 유입에 **출처 표식을 부여**하고, 이후 같은 사용자의 `landing_viewed` → `target_submitted` → 결제까지를 **공유 유입 코호트로 추적**한다
- 구현은 attribution 파라미터(공유 페이지 CTA의 내부 source 표식) 또는 세션 속성으로 하되 **기존 닫힌 property allowlist를 지킬 것**. 공유 토큰 자체나 제3자 식별자를 이벤트에 넣지 않는다
- 지표: **공유 조회 1건당 신규 `target_submitted` 수**. 1 미만이면 바이럴이 아니라 부가 기능으로 대우한다

## A6. 익명 상태 퍼널 이벤트 발화

로그인 시점을 뒤로 옮기면(B 참조) `plan_viewed`·`plan_selected`가 **비로그인 상태에서 발생**한다. 지금처럼 로그인 이후에만 발화되면 **변경의 효과를 아예 측정할 수 없다.**

**요청**

- `plan_viewed`, `plan_selected`, `checkout_started`를 익명 상태에서도 발화
- 그 익명 이벤트가 이후 로그인 시 **올바른 Supabase UUID로 병합**되어야 한다 → **A1과 같은 뿌리이므로 함께 처리**
- 신규 이벤트 **`login_prompted`** 추가 권장: 결제 클릭으로 로그인 모달이 노출된 시점. 로그인 요구 지점의 이탈을 별도로 본다

---

# B. 익명 preflight 지원 (UX 변경과 함께)

제품 변경 방향: **로그인을 아이디 입력 직후가 아니라 [결제하기] 클릭 시점으로 옮긴다.** 전체 설계는 `docs/strategy/2026-08-05-anonymous-preflight-ux-design.md`.

근거: `target_submitted`(108) → `auth_completed`(27)에서 **81명이 이탈**한다. 플랜~결제 전체 손실(15명)의 5배가 넘고, **가격을 본 사람이 18명뿐**이라 가격 가설을 검증할 수 없다.

## B1. 익명 preflight 소유권 이전(claim)과 OAuth 상태 전달

- preflight를 `user_id NULL`로 생성하고 **서명된 claim token**을 발급한다. 로그인 완료 후 그 토큰으로 `user_id`를 채운다
- `analysis_preflights.user_id`가 NOT NULL이면 forward migration 필요
- `earlybird_orders.preflight_id`가 `NOT NULL UNIQUE REFERENCES … ON DELETE RESTRICT`이므로 **주문 생성은 claim 완료 후**여야 한다
- claim token은 **일회용·단기 만료**. 이미 claim된 preflight의 재claim은 거부한다 (타인 preflight 탈취 방지)

**⚠️ 가장 흔한 실패 지점 — OAuth 리디렉트 상태 보존**

카카오 로그인은 페이지를 떠난다. 돌아왔을 때 **preflight claim token, 선택한 plan_id, 본인 계정 제외 결정**이 살아 있어야 한다.

- **`sessionStorage`만으로는 안 된다.** 카카오톡 인앱 웹뷰 등에서 유실된다
- **claim token을 OAuth `state` 파라미터 또는 콜백 redirect URL에 실을 것.** 서버가 콜백에서 복원한다
- `state`에 담을 때는 **서명·만료·일회성**을 지키고, 콜백에서 검증 실패 시 안전하게 플랜 화면으로 되돌린다
- 복원 실패가 "처음부터 다시"로 이어지면 **지금보다 나쁘다.** 이 경로의 회귀 테스트가 필수다

## B2. 익명 preflight는 Apify로 — 버너 계정 리스크 격리

유료 경로가 지정 버너 계정의 인증 세션(`selfhosted_auth`)을 쓰므로, 익명 트래픽을 그대로 인증 worker에 태우면 **Instagram 요청 수가 늘어 계정 정지 확률이 올라간다. 정지되면 유료 경로 전체가 동시에 멈춘다.**

**요청: 익명 preflight의 대상 프로필 summary 수집만 Apify로 라우팅한다.**

- 계정 하나의 profile summary라 건당 `$0.0026` 수준이고 108건 기준 약 $0.28로 무시할 만하다
- **효과: 버너 계정을 결제한 사용자의 분석에만 쓰게 되어 계정 리스크가 매출과 연동된다.** 돈 낸 만큼만 계정을 태운다
- 기존 preflight 원장·상한 메커니즘(`analysis_preflight_provider_runs`, `maxTotalChargeUsd`, 30초 후 실제액 정산)을 그대로 재사용한다
- 비용 폭주 방어를 위해 **일일 상한과 초과 시 동작**(로그인 요구로 폴백 등)을 정의할 것
- **유료 분석 경로와 섞이지 않도록 provider selector를 분리한다.** 현재 유료 경로는 `selfhosted_auth` 전용이므로 이건 명시적 예외 경로가 된다

## B3. 남용 방어

로그인이 사실상 rate limit 역할을 하고 있었다. 없애면 대체가 필요하다.

- IP·디바이스 기준 rate limit
- **동일 타겟 preflight 스냅샷 재사용** — 같은 계정을 여러 명이 조회해도 외부 요청은 1회. 원가와 요청 수를 동시에 줄인다
- 익명 preflight 일일 상한

---

# C. 최신 레포 반영 참고

이 프롬프트의 최초 작성(2026-07-31) 이후 main이 175커밋 진행됐다. 관련 변경:

- **유료 경로 `selfhosted_auth` 전격 전환** (2026-08-04). 대상 프로필 preflight, `fresh_admission`, 후보 프로필 배치, followers/following, liker/comment가 모두 인증 worker를 거친다. 정상 유료 경로의 Apify Actor 비용은 `$0`
- **가격 v3**: Basic 990원 / Standard 1,990원 (`earlybird-2026-08-v3`)
- 위 두 가지 때문에 **B2의 "preflight만 Apify"는 현재 아키텍처에서 명시적 예외 경로**가 된다

**문서 갱신**: `README.md`의 Instagram 수집 서술은 이미 갱신했다. `docs/amplitude-analytics-operations.md`의 "클라이언트에서만 전송한다" 규칙은 A3 결정에 따라 함께 고쳐야 한다.

---

# 범위 밖

- Session Replay 경로 확대 (`/`, `/privacy`, `/terms`만 허용하는 현재 게이트를 건드리지 않는다)
- 결제·webhook 경로의 서버측 Amplitude 발화
- 신규 대시보드 생성 (기존 [얼리버드 전환 대시보드](https://app.amplitude.com/analytics/shiny-disk-989835/dashboard/p7w87cf8)에 패널 추가로 충분한지 먼저 확인)
- 분석 소요시간 단축 (별도 진행 중)

# 프라이버시 계약 (모든 항목 공통)

- user ID는 **Supabase UUID만**. 이메일·전화번호·인스타그램 아이디를 ID나 user property로 보내지 않는다
- property는 닫힌 allowlist만 통과 (`lib/services/analytics.ts`의 `ALLOWED_PROPERTIES`). 새 사유 코드·이벤트를 추가하면 allowlist와 스키마를 함께 확장한다
- 인스타그램 식별자, 이름, bio, 캡션, 댓글, 미디어 URL, prompt, provider run id, **공유 토큰**, raw 오류 메시지는 어떤 경우에도 보내지 않는다
- 이벤트에 페이지 URL을 보내지 않는다

# 최종 검증

- 금지 속성 검사: `email`, `phone`, `name`, `instagram`, `username`, `profile`, `bio`, `comment`, `caption`, `image`, `media`, `url`, `token` 이름이나 실제 민감 값이 event·user property에 없는지
- **원장 대조**: `payment_confirmed_viewed` 고유 사용자 수 = `earlybird_orders`의 해당 상태 고유 `user_id` 수
- **원장 대조**: 서버 `analysis_completed` 수 = `analysis_v2` terminal 성공 요청 수
- 로그인 전후·기기 변경 시 같은 사용자가 하나로 집계되는지 실제 시나리오로 확인

---
