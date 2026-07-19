# 랜딩 익명 리드 저장 + 로그인 후 프리필 — 설계

- 날짜: 2026-07-19
- 브랜치: `feat/landing-lead-capture` (워크트리 `.worktrees/landing-lead-capture`, `main` 기준)

## 배경 / 현재 동작

로그아웃 상태에서 랜딩(`app/page.tsx`)의 히어로 입력창에 인스타 아이디를 넣고 "지금 바로
확인하기"를 누르면 `handleStart()`가 실행된다. 현재는:

1. 입력값을 정규화(`@`·공백 제거)해 `sessionStorage`(`pending_ig`, `pending-analysis-target`
   서비스)에 저장한다.
2. Amplitude `TARGET_SUBMITTED` 이벤트를 보낸다. **단, 아이디 값은 마스킹되어 실제 값이
   서버 어디에도 영구 저장되지 않는다.**
3. 로그아웃 상태면 로그인 모달(`LoginModal`)을 연다.

로그인(카카오 OAuth) 후에는 `/analyze?autostart=1`로 돌아오고, `app/analyze/page.tsx`의
초기화 `useEffect`가 sessionStorage의 아이디를 입력창에 채운 뒤 **곧바로 자동으로
preflight(대상 계정 조회)를 실행**한다. 이 preflight는 Apify 유료 조회 비용을 유발한다.

## 목표

1. **익명 리드 저장**: 로그아웃 유저가 아이디를 제출해 로그인 모달이 뜨는 시점에, 입력한
   인스타 아이디를 attribution(유입 정보)과 함께 Supabase에 저장한다. 유저가 이후 로그인하지
   않아도 저장은 이루어져야 한다.
2. **로그인 후 프리필 + 수동 시작**: 로그인 후 `/analyze`에서 입력했던 아이디가 입력창에
   채워져 있고, 유저는 "대상 계정 확인하기" 버튼만 누르면 조회가 시작되도록 한다. 즉 현재의
   자동 실행을 제거한다(유료 조회를 유저 확인 후 실행 = 비용 안전).

## 확정된 결정

- 리드의 1차 목적: **리드 수집(마케팅/재유입)**. 유저와 연결(user_id)하지 않는다.
- 중복 처리: **제출마다 1행(append)**. 중복 제거 없음.
- attribution 포함: `readAttribution()` 기반 utm 필드 + `document.referrer` + `user_agent`.
- 로그인 후 프리필 위치: **`/analyze`에서 채움 + 유저 클릭**(자동 실행 끄기).

## 대안 검토 (익명 쓰기 방식)

| 접근 | 방식 | 결론 |
|---|---|---|
| **A. 서버 API Route + admin 인서트** ✅ | `POST /api/leads` → 같은 오리진/JSON 가드 + zod → `supabaseAdmin`(service_role) insert | 채택. `earlybird/waitlist` 패턴과 일관. 공개 테이블 노출 없음. |
| B. Supabase 익명 인증 | 익명 세션 후 RLS insert | auth 유저 오염, 과함. 기각. |
| C. 브라우저 anon 키 직접 insert | 클라에서 RLS insert 정책으로 직접 insert | 하드닝된 "서버 경유" 관례 위반, 오리진 가드·레이트리밋 불가. 기각. |

## Feature 1 — 익명 리드 저장

### DB 마이그레이션

`supabase/migrations/20260719160000_add_landing_leads.sql`

```sql
CREATE TABLE public.landing_leads (
    id           UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    instagram_id TEXT NOT NULL,          -- 정규화: @·공백 제거, 소문자
    raw_input    TEXT,                    -- 유저가 입력한 원문(<=100)
    utm_source   TEXT,
    utm_medium   TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    utm_term     TEXT,
    referrer     TEXT,                    -- document.referrer(<=500)
    user_agent   TEXT,                    -- 서버에서 요청 헤더로 캡처
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX landing_leads_instagram_id_created_at_idx
    ON public.landing_leads(instagram_id, created_at DESC);

ALTER TABLE public.landing_leads ENABLE ROW LEVEL SECURITY;
-- 정책 없음: 클라(anon/authenticated) 접근 전면 차단. service_role만 접근(RLS 우회).
REVOKE ALL ON TABLE public.landing_leads FROM anon, authenticated;
GRANT INSERT, SELECT ON TABLE public.landing_leads TO service_role;
```

- 컬럼 기본값·타입·하드닝 스타일은 `20260717140000_add_groble_earlybird_presale.sql`과 동일하게
  맞춘다(`extensions.gen_random_uuid()`, `pg_catalog.clock_timestamp()`,
  `REVOKE ALL ... FROM anon, authenticated`, service_role grant, 정책 없음).

### 서버

`lib/services/leads/contracts.ts`
- zod `landingLeadRequestSchema`:
  - `instagramId: string` — 서버가 다시 정규화·검증(신뢰 안 함).
  - `rawInput?: string` (max 100)
  - `attribution?: { source?, medium?, campaign?, content?, term? }` — 각 항목 string max 64.
  - `referrer?: string` (max 500)
- HTTP 가드는 `@/lib/services/earlybird/contracts`의 `isSameOriginMutation`, `isJsonRequest`를
  **import 재사용**한다(earlybird 파일은 수정하지 않음 — 병렬 세션 충돌 방지).
- 리드 정규화 함수 `normalizeLeadInstagramId(value): string | null`:
  - `trim()` → 선행 `@` 제거 → 소문자화 → `^[A-Za-z0-9._]{1,30}$` 검증(연속/양끝 `.` 금지),
    `pending-analysis-target`의 `TARGET_PATTERN` 규칙과 동일. 실패 시 `null`.

`lib/services/leads/store.ts`
- `insertLandingLead(input)`:
  - `supabaseAdmin.from('landing_leads').insert({ instagram_id, raw_input, utm_source, ... ,
    referrer, user_agent })`.
  - 실패 시 `LeadPersistenceError`(코드 포함) throw. 성공 시 `{ leadId }` 반환(또는 void).

`app/api/leads/route.ts` (POST)
1. `isSameOriginMutation` 실패 → 403 `FORBIDDEN_ORIGIN`.
2. `isJsonRequest` 실패 → 415 `UNSUPPORTED_MEDIA_TYPE`.
3. body 파싱 실패 / zod 실패 → 400 `INVALID_REQUEST`.
4. `normalizeLeadInstagramId` 실패 → 400 `INVALID_REQUEST`.
5. `user_agent`는 `request.headers.get('user-agent')`(max 500)로 서버에서 캡처.
6. `insertLandingLead(...)` 성공 → 201. 실패 → 503 `LEAD_UNAVAILABLE`.
- **인증 체크 없음.** 로그아웃 유저도 호출 가능(이 기능의 핵심).

### 클라이언트

`lib/services/landing-lead.ts` (client helper)
- `reportLandingLead({ instagramId, rawInput, search })`:
  - `readAttribution(search)`로 utm 값을, `document.referrer`로 referrer를 구성.
  - `fetch('/api/leads', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(...) })`.
  - **fire-and-forget**: `await` 없이 호출, 모든 오류를 삼킨다(`.catch(() => {})`).

`app/page.tsx` `handleStart`
- `!user` 분기에서 `setLoginOpen(true)` **직전**에
  `void reportLandingLead({ instagramId: id, rawInput: igId, search: window.location.search })`
  호출. 실패해도 로그인 모달 표시·기존 흐름을 절대 막거나 지연시키지 않는다.
- **마케팅 카피(헤드라인/서브/스텝/CTA 등)는 수정하지 않는다** (CLAUDE.md Project Rule #4).
- 리드는 **로그아웃 유저가 로그인 모달에 도달하는 시점에만** 저장한다(요청 범위). 로그인 유저의
  제출은 리드로 저장하지 않는다.

## Feature 2 — 로그인 후 프리필 + 수동 클릭

- 기존 `pending-analysis-target`(sessionStorage) 핸드오프를 그대로 활용한다. OAuth 같은 탭
  왕복에도 sessionStorage가 유지되므로 로그인 후 아이디를 복원할 수 있다. 리드 테이블은 유저
  연결이 없으므로 프리필 소스로 쓰지 않는다.
- `app/analyze/page.tsx` 초기화 `useEffect`의 `autostart` 분기를 **프리필 전용**으로 변경:
  - `readPendingAnalysisTargetForAutostart(sessionStorage)`로 아이디를 읽어 `setInstagramId`로
    입력창에 채우는 것까지만 수행한다.
  - **자동 `startPreflight(...)` 호출과 이어지는 `bindPendingAnalysisTarget`·리다이렉트 블록을
    제거**한다. 실제 조회는 유저가 "대상 계정 확인하기"를 눌러 `handleStartPreflight`가 실행될
    때 일어난다(이 핸들러는 기존 그대로).
  - 방어적 `!user` 처리(로그인 페이지로 replace)는 유지한다. `/analyze`는 미들웨어 보호 경로라
    실제로는 도달 시 user가 존재한다.
- **파라미터명 `autostart=1`과 헬퍼명 `readPendingAnalysisTargetForAutostart`는 유지**한다
  (문자열 매칭 테스트 및 병렬 워크트리와의 충돌 방지). 동작만 바꾸고 주석으로 "프리필 전용,
  자동 실행 안 함"을 명시한다.

### 의도된 부수효과

이 변경은 `autostart=1`을 쓰는 다른 두 흐름에도 적용된다:
- (a) 랜딩에서 로그인 상태로 제출 → `/analyze?autostart=1`
- (b) `/analyze`에서 로그아웃 상태로 클릭 → 로그인 → `/analyze?autostart=1`

두 경우 모두 자동 실행이 사라지고 유저가 `/analyze`에서 클릭 1회를 더 하게 된다. 유료
preflight를 항상 유저 확인 후 실행한다는 비용 안전 원칙에 부합하므로 일관되게 적용한다.

## 테스트

- `normalizeLeadInstagramId` 단위 테스트(정상/`@`·대문자/패턴 위반/양끝·연속 `.`/길이 초과).
- `landingLeadRequestSchema` zod 검증 테스트(필드 누락/초과 길이/정상).
- `/api/leads` 라우트 분기 테스트: 오리진 위반 403, 비 JSON 415, zod 실패 400, 정규화 실패
  400 (earlybird 라우트·`admin.test.ts` 스타일 참고).
- `app/analyze/page.tsx` autostart 분기가 프리필만 하고 auto-run 하지 않음을 확인하는
  회귀 테스트(기존 `amplitude-caller-contract.test.ts` / `v1-v2-route-isolation.test.ts`가
  깨지지 않는지 포함).

## 범위 밖 (YAGNI)

- 리드-유저 연결(로그인 후 user_id 바인딩).
- 리드 조회/관리 UI, 대시보드.
- 레이트리밋/캡차(오리진 가드 + zod로 충분하다고 판단; 필요 시 후속).
- 로그인 유저 제출의 리드 저장.
