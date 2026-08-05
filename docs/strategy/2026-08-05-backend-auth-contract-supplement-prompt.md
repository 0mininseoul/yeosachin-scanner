# 백엔드 세션 보충 프롬프트 — 익명 preflight의 인증 계약

- 작성일: 2026-08-05
- **선행 프롬프트**: [계측 신뢰성 + 익명 preflight 지원](./2026-07-31-backend-funnel-instrumentation-prompt.md) — **이미 전달됨**
- 성격: 선행 프롬프트 **B 섹션의 누락분 보충**. 대체가 아니라 추가

아래 `---` 사이를 백엔드 세션에 추가로 전달하면 됩니다.

---

# 보충 — 익명 preflight의 인증 계약 (선행 프롬프트 B 섹션 보완)

앞서 전달한 프롬프트의 **B. 익명 preflight 지원**에서 빠진 부분이 있다. B1은 claim token 발급과 `user_id` nullable까지만 적었는데, **preflight 경로가 인증에 하드로 묶여 있어서 토큰만 만들어서는 익명이 되지 않는다.** 이 보충분이 실제 구현 표면의 대부분이다.

## B0. 열어야 하는 인증 게이트

| 위치 | 현재 | 필요한 변경 |
|---|---|---|
| `POST /api/analysis/preflight`<br>(`app/api/analysis/preflight/route.ts:131-135`) | `supabase.auth.getUser()` 실패 시 **`401 UNAUTHORIZED` "로그인이 필요합니다"** 즉시 반환 | 익명 요청 허용. `userId`를 null로 두고 claim token 발급 |
| `GET /api/analysis/preflight/[preflightId]`<br>(`route.ts:160`) | `preflightStore.findForOwner(preflightId, user.id)` — **소유자 스코프 읽기.** 익명 호출자는 자기 preflight를 읽을 방법이 없다 | claim token을 읽기 자격으로 받는 경로 추가. 익명 preflight에서는 토큰이 소유권을 대신한다 |
| `analysis_preflights` RLS | owner 기준 정책. `user_id IS NULL` 행에 대한 정책이 없다 | 익명 행의 읽기·갱신 경계를 정책으로 새로 정의한다. **service role로 우회하지 말고 정책으로 표현할 것** |
| 플랜 적격성·가격 카탈로그 | 인증 뒤에서만 계산 | 비로그인 상태에서 preflight 결과 기반으로 **적격 플랜과 정확한 가격**을 반환해야 한다 |

**마지막 항목이 특히 중요하다.** 이 변경의 목적이 "가격을 보는 사람 수를 18명에서 세 자리로 만드는 것"인데, 플랜 적격성이 계정 규모에 따라 갈리므로 **부정확한 가격을 보여주면 측정 자체가 오염된다.**

## B0-1. 반드시 닫아둬야 하는 것

익명화 범위를 명확히 한다. 아래는 **그대로 인증을 유지한다.**

- **`POST /api/earlybird/checkout`** — 여기가 로그인이 착지하는 지점이고, 주문은 사용자에 귀속돼야 한다
- **결과 조회 / 진행 상태 / 마이페이지** — 소유자 스코프 유지. 제3자 개인정보가 담긴 화면이다
- **익명 preflight는 분석을 시작시킬 수 없다.** 분석 실행 자격은 claim + 결제 이후에만 생긴다

## B0-2. 조용히 깨지는 곳 — 데모 자격 판정

`app/api/analysis/preflight/route.ts:147`의 `isDemoEligible(user.id, rawTargetInstagramId)`와 `[preflightId]/route.ts`의 `isDemoOperator(user.id)`가 **`user.id`를 키로 쓴다.** 익명 preflight에는 그 값이 없다.

하필 **샘플 리포트가 쓰려는 것이 바로 이 데모 데이터**다. 따라서 데모 자격 판정을 사용자 식별자에 묶지 않는 형태로 바꿔야 하며, **이 결정은 샘플 리포트 설계와 함께 내린다**(별도 작업).

## 남용 방어가 더 중요해지는 이유

선행 프롬프트 B3에 rate limit을 적었지만, B0에서 401 게이트를 열면 **그 게이트가 지금까지 사실상의 rate limit이었다**는 점이 드러난다. 익명 개방과 방어는 **같이 나가야 한다.** 방어 없이 먼저 열면 안 된다.

선행 프롬프트 B2대로 익명 preflight의 프로필 수집을 **Apify로 격리**하면 버너 계정 정지 리스크는 막지만, **비용 폭주는 별개**다. IP·디바이스 rate limit과 동일 타겟 스냅샷 재사용이 함께 있어야 한다.

## 완료 판정

- 로그아웃 상태에서 아이디 입력 → preflight 실행 → 결과 조회 → **적격 플랜과 정확한 가격 확인**까지 401 없이 도달한다
- 같은 상태에서 **분석 시작과 checkout은 여전히 거부**된다
- 익명 preflight를 다른 브라우저에서 claim token 없이 조회하면 **거부**된다
- 로그인 후 claim이 성공하면 그 preflight로 주문이 생성된다
- **RLS 정책만으로** 위 경계가 성립한다 (service role 우회 없이)

## 범위 밖

- **샘플 리포트(데모 데이터) 구현** — 별도 작업. 단 B0-2의 데모 자격 판정 변경은 그 작업과 맞물리므로 함께 결정한다
- **프론트 UX 구현** — 화면 순서, 로그인 모달 카피, 로그인 취소 시 복귀 처리. 설계는 `docs/strategy/2026-08-05-anonymous-preflight-ux-design.md`

---
