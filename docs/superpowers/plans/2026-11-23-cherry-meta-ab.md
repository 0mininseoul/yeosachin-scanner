# 체리 메타 A/B 테스트 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 남친/짝남 메타 광고 A/B 테스트에 필요한 광고 시안 16장과 메타 가이드, `?v=crush` 짝남 랜딩, 변형별 예약·Amplitude·메타 픽셀 추적을 만든다.

**Architecture:**
- `/cherry` route는 landing.html을 메모리에 읽어 둔다. 요청마다 `?v=` 값으로 교체표·`data-variant`·픽셀 코드를 적용한 HTML을 내보낸다.
- 3D 장면은 `data-variant`를 읽어 대상 단어를 그린다.
- 예약 API는 변형을 새 컬럼에 저장하고, landing.js와 Amplitude가 같은 값을 쓴다.
- 광고 시안은 HTML 템플릿을 Chrome headless로 PNG 렌더한다.

**Tech Stack:** Next.js 16 route handler, Supabase(PostgREST), vitest(jsdom), esbuild(3D 번들), Google Chrome headless

**Spec:** `docs/superpowers/specs/2026-11-23-cherry-meta-ab-design.md`

## Global Constraints

- 변형 값은 정확히 `bf`, `crush` 두 개다. 그 외 값이나 값 없음은 `null`(남친 문구, 변형 기록 없음).
- 짝남 문구는 설계 §6 교체표 그대로 쓴다.
  - 짝남 랜딩 h1: `내 짝남은 내가 모르는 사이` / `누구랑 맞팔하고 다닐까?`
  - 약속 2 제목: `인스타 아이디 하나면 돼요`
- 광고 헤드라인은 두 변형 모두 "어떤 여자랑"이다.
  - A: `내 남친은 나 몰래 / 어떤 여자랑 맞팔하고 다닐까?`
  - B: `내 짝남은 내가 모르는 사이 / 어떤 여자랑 맞팔하고 다닐까?`
- 남친(기본) 랜딩 문구는 바꾸지 않는다. `v`가 없을 때의 응답은 원본 landing.html과 바이트 단위로 같아야 한다(픽셀 코드 제외).
- 이메일·휴대폰 번호는 메타·Amplitude로 보내지 않는다. 픽셀 `init` 전에 `fbq('set','autoConfig',false,ID)`를 호출한다.
- 픽셀 ID 환경변수는 `CHERRY_META_PIXEL_ID`이고, `/^\d{5,20}$/`일 때만 쓴다.
- 예약은 추적 때문에 실패하면 안 된다. 컬럼 없음 오류(`PGRST204`, `42703`)가 나면 variant 없이 다시 넣는다.
- 개인정보처리방침 추가 문구는 설계 §7-4 그대로 쓴다.
- 커밋은 사용자 승인 후 이 브랜치(`claude/boyfriend-mutual-follow-ad-test-52b2ac`)에 한다. 프로덕션 DB 적용은 AGENTS.md Supabase 운영 규칙을 따르고, 적용 전에 사용자에게 확인한다.
- 시안 PNG는 git에 넣지 않는다(`docs/marketing/cherry-meta-ab/out/`).

## Review Focus

1. 광고 URL에는 `fbclid`·`utm_*`가 붙고 `#waitlist` 해시가 따라온다. 이 경우에도 `v=crush`가 인식되어야 한다. → Task 2 테스트 `keeps crush with ad params`
2. `v=CRUSH`, `v=crush%20`, `v=` 같은 잘못된 값은 남친 문구에 변형 없음(null)이어야 하고, 오류가 나면 안 된다. → Task 2 `parseCherryVariant` 테스트
3. 같은 이메일로 다른 변형 링크에서 다시 예약하면 처음 행과 처음 변형을 유지해야 한다(23505 경로). → Task 4 테스트 `keeps the first reservation on duplicate`
4. 환경변수 픽셀 ID에 공백·따옴표·스크립트가 섞여 있으면 픽셀 코드를 넣지 않아야 한다(HTML 주입 방지). → Task 3 테스트 `ignores unsafe pixel ids`
5. JS가 꺼진 짝남 방문자도 짝남 문구를 봐야 한다. 서버 렌더의 3D 대체 문구(`fallback-count`)까지 포함한다. → Task 2 테스트 `crush output has no boyfriend wording`

---

### Task 1: 광고 시안 16장과 메타 가이드

**Files:**
- Create: `docs/marketing/cherry-meta-ab/ad.html` (컨셉 4종 템플릿, 쿼리 `?c=1..4&v=bf|crush&s=feed|story`)
- Create: `docs/marketing/cherry-meta-ab/ad.css`
- Create: `docs/marketing/cherry-meta-ab/copy.js` (변형별 문구 표, `export const COPY = { bf: {...}, crush: {...} }`)
- Create: `docs/marketing/cherry-meta-ab/render.mjs` (Chrome headless로 16장 렌더)
- Create: `docs/marketing/cherry-meta-ab/index.html` (A/B 쌍을 나란히 보는 검토 보드)
- Create: `docs/marketing/cherry-meta-ab/README.md` (메타 세팅 가이드)
- Create: `docs/marketing/cherry-meta-ab/.gitignore` (`out/`)

**Interfaces:**
- Produces: `out/c{N}-{slug}_{bf|crush}_{4x5|9x16}.png`
  - slug는 `question`, `alimtalk`, `reveal`, `chat`
  - 크기는 4x5 = 1080×1350, 9x16 = 1080×1920

- [ ] **Step 1: 문구 표 작성.** `copy.js`에 설계 §5.6 표의 문구를 그대로 넣는다.
  - C1 헤드라인은 Global Constraints의 "어떤 여자랑" 판이다.
  - C2 알림 카드는 두 변형 공통이다: `[체리] 등록하신 @maru.onair_ 계정에서 새 맞팔 2명을 확인했어요.`
  - 공통 하단: `{남친|짝남} 맞팔 알리미 체리`, `사전예약 · 선착순 300명`
- [ ] **Step 2: 템플릿·스타일 작성.**
  - 폰트·색: `public/cherry/assets/*.woff2`, landing.css 토큰(`--cherry #c01836` 등)을 상대 경로로 쓴다.
  - 캐릭터: `design/namchin-demand/og/cherry.png`
  - 프로필 사진: `public/cherry/assets/hero/{seoa,rina,maru}-profile.jpg`
  - 금지: 인스타그램 로고, 인스타그램 화면 모방
  - 9:16은 위 250px·아래 340px에 글자를 두지 않는다.
  - 같은 컨셉의 A/B는 문구 외 모든 요소가 같다.
- [ ] **Step 3: `render.mjs` 작성 후 실행.**
  - 각 조합을 `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=W,H --screenshot=<out> file://…/ad.html?c=&v=&s=`로 렌더한다.
  - Run: `node docs/marketing/cherry-meta-ab/render.mjs` → Expected: `out/`에 PNG 16개, 각 크기가 맞음(`sips -g pixelWidth -g pixelHeight`)
- [ ] **Step 4: 육안 검수.**
  - 16장을 열어 글자 잘림, 폰트 미적용(대체 글꼴), 안전 영역 침범, A/B 문구 외 차이가 없는지 확인한다.
- [ ] **Step 5: README 작성.**
  - 광고 링크 2종(설계 §5.1)과 소재ID 규칙 `utm_content=c{N}_{v}_{4x5|9x16}`
  - 광고 텍스트 필드 A/B(설계 §5.6)
  - 메타 실험 세팅(설계 §5.5)
  - 픽셀 발급·`CHERRY_META_PIXEL_ID` 등록·자동 고급 매칭 끄기 절차
  - 결제 분석 쿼리(설계 §5.4 정의: 번호 우선·이메일 보조 매칭, `cherry_subscriptions.first_paid_at`이 판매 오픈부터 7일 안, `payment_provider <> 'grant'`)
- [ ] **Step 6: 커밋(사용자 승인 후).** `git add docs/marketing/cherry-meta-ab` (out/ 제외)

### Task 2: `?v=` 짝남 랜딩 렌더와 짝남 og 이미지

**Files:**
- Create: `lib/services/cherry/landing-variant.ts`
- Modify: `app/cherry/route.ts`
- Create: `design/namchin-demand/og/b-crush.html` → 캡처해 `public/cherry/og-crush.jpg`(1200×630) 생성
- Test: `tests/cherry/landing-variant.test.ts` (새 파일. 랜딩·예약 경계는 기존 서비스 테스트와 mock 수명이 달라서 분리한다)

**Interfaces:**
- Produces:
  - `type CherryVariant = 'bf' | 'crush'`
  - `parseCherryVariant(value: string | null): CherryVariant | null`
  - `CRUSH_REPLACEMENTS: readonly (readonly [from: string, to: string])[]`
  - `renderCherryLanding(html: string, options: { variant: CherryVariant | null; pixelId: string | null }): string`

- [ ] **Step 1: 실패하는 테스트 작성** (landing.html은 `readFileSync`로 실제 파일을 읽는다)
  - `parseCherryVariant`: `'bf'→'bf'`, `'crush'→'crush'`, `null`·`''`·`'CRUSH'`·`'crush '`·`'x'` → `null`
  - `every replacement source exists`: 각 `from`이 landing.html에 1회 이상 있다.
  - `crush output has no boyfriend wording`: crush 출력에서 `남자친구, 썸남`(FAQ 2 답변)을 지운 뒤 `/남친|남자친구/`이 없다. 다음 문자열이 모두 들어 있다.
    - `내 짝남은 내가 모르는 사이`
    - `인스타 아이디 하나면 돼요`
    - `짝남에게는 비밀로 할게요.`
    - `/cherry/og-crush.jpg`
    - `class="fallback-count">짝남 팔로잉`
  - `default output is untouched`: `variant: null, pixelId: null`이면 원본과 정확히 같다. `variant: 'bf'`이면 `<html lang="ko" data-variant="bf">` 외에는 원본과 같다.
  - `keeps crush with ad params`: route GET에 `?v=crush&utm_source=meta&fbclid=abc`를 주면 응답에 `data-variant="crush"`와 짝남 h1이 있다. 헤더는 `Cache-Control: public, s-maxage=300, stale-while-revalidate=3600`이다.
- [ ] **Step 2: 실패 확인.** Run: `npx vitest run tests/cherry/landing-variant.test.ts` → Expected: FAIL(module not found)
- [ ] **Step 3: 구현.**
  - `CRUSH_REPLACEMENTS`는 설계 §6을 HTML 원문 경계 그대로 옮긴 쌍이다. 긴 문자열이 먼저 오게 한다.
  - h1은 `<span>내 남친은 나 몰래</span>` → `<span>내 짝남은 내가 모르는 사이</span>`로 바꾼다.
  - og:image, twitter:image, og:image:alt도 교체한다.
  - `renderCherryLanding`은 `replaceAll`로 적용하고, `<html lang="ko">`에 `data-variant`를 단다.
  - route는 `force-static`을 지우고, 모듈 범위에서 landing.html 읽기 Promise를 한 번만 만든다. `request.nextUrl.searchParams.get('v')`를 읽는다.
- [ ] **Step 4: og 이미지 생성.**
  - `b-crush.html`은 `b.html` 복제본이다. kicker는 `짝남 맞팔 알리미 체리`, h1은 `내 짝남은 내가 모르는 사이<em>누구랑 맞팔하고<br>다닐까?</em>`이다.
  - 첫 줄이 길어 줄바꿈이나 글자 크기를 조정해야 하면 `og.css`에 `.b.crush` 규칙을 추가한다.
  - Chrome headless로 1200×630 캡처 → `sips -s format jpeg -s formatOptions 88`로 `public/cherry/og-crush.jpg`를 만든다.
- [ ] **Step 5: 통과 확인.** Run: `npx vitest run tests/cherry/landing-variant.test.ts` → Expected: PASS
- [ ] **Step 6: 커밋.**

### Task 3: 메타 픽셀과 개인정보처리방침

**Files:**
- Modify: `lib/services/cherry/landing-variant.ts` (픽셀 코드 주입)
- Modify: `app/cherry/route.ts` (`process.env.CHERRY_META_PIXEL_ID` 전달)
- Modify: `public/cherry/landing.js:425-426` (예약 완료 시 Lead)
- Modify: `app/privacy/page.tsx` (`#namchin` 섹션 문단, 처리위탁 표 :145-150, 국외이전 표 :191-215에 Meta 행)
- Test: `tests/cherry/landing-variant.test.ts`

**Interfaces:**
- Consumes: Task 2 `renderCherryLanding`
- Produces: 픽셀 ID가 유효하면 `<meta charset="utf-8">` 바로 뒤에 표준 fbq 기본 코드가 들어간다. 순서는 `fbq('set','autoConfig',false,ID); fbq('init',ID); fbq('track','PageView');`이다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `injects pixel with autoConfig off`: `pixelId: '1234567890'`이면 출력에 `connect.facebook.net/en_US/fbevents.js`가 있다. `fbq('set','autoConfig',false,'1234567890')`가 `fbq('init','1234567890')`보다 앞에 오고, `PageView`가 있다.
  - `ignores unsafe pixel ids`: `'123 456'`, `"1');alert(1);//"`, `''`, `'12ab'`이면 출력에 `fbevents`가 없다.
- [ ] **Step 2: 실패 확인.** Run: 위 vitest → FAIL
- [ ] **Step 3: 구현.**
  - 픽셀 ID는 `/^\d{5,20}$/` 검사를 통과한 값만 쓴다.
  - landing.js는 `reservationDone = true` 다음 줄에 `window.fbq?.('track', 'Lead', { content_name: document.documentElement.dataset.variant ?? 'none' })`를 넣는다.
  - privacy 문구는 설계 §7-4 그대로 넣는다.
- [ ] **Step 4: 통과 확인.** Run: 위 vitest → PASS
- [ ] **Step 5: 커밋.**

### Task 4: 예약 행에 변형 저장과 운영 콘솔 합계

**Files:**
- Create: `supabase/migrations/20261123200000_add_namchin_reservation_variant.sql`
  - `alter table public.namchin_launch_reservations add column variant text check (variant in ('bf','crush'));`
- Modify: `app/api/namchin/reservations/route.ts`
- Modify: `public/cherry/landing.js:401-409` (POST body)
- Modify: `app/api/admin/namchin/reservations/route.ts` (select에 `variant`, 응답에 `variantCounts`)
- Modify: `app/admin/console/namchin-waitlist-console.tsx` (변형 열과 합계)
- Test: `tests/cherry/landing-variant.test.ts` (`@/lib/supabase/admin` mock)

**Interfaces:**
- Produces:
  - 예약 POST body에 선택 필드 `variant?: 'bf' | 'crush'`
  - 관리 API 응답 `rows[].variant: 'bf' | 'crush' | null`
  - `variantCounts: { bf: number; crush: number; none: number }`

- [ ] **Step 1: 실패하는 테스트 작성** (POST는 `origin` 헤더를 요청 URL origin과 같게, `content-type: application/json`)
  - `stores the variant`: body에 `variant: 'crush'` → insert 인자가 `{ email, phone: '+821012345678', variant: 'crush' }`이고 200 `{received:true}`
  - `omits variant when absent`: insert 인자에 `variant` 키가 없다.
  - `rejects unknown variant`: `variant: 'x'` → 400
  - `retries without variant when the column is missing`: 첫 insert가 `{ error: { code: 'PGRST204' } }` → 두 번째 insert는 variant 없이 → 200
  - `keeps the first reservation on duplicate`: insert가 `{ error: { code: '23505' } }` → 200, insert 1회
- [ ] **Step 2: 실패 확인.** Run: `npx vitest run tests/cherry/landing-variant.test.ts` → FAIL
- [ ] **Step 3: 구현.**
  - 스키마에 `variant: z.enum(['bf','crush']).optional()`을 추가한다(strict 유지).
  - landing.js는 `dataset.variant`가 `bf|crush`일 때만 body에 넣는다.
  - 관리 API는 합계를 `count: 'exact', head: true` 쿼리 3개로 구한다(`variant.eq.bf`, `eq.crush`, `is.null`). 콘솔은 표에 변형 열을 추가하고, 목록 위에 `bf N · crush N · 없음 N`을 보여준다.
- [ ] **Step 4: 통과 확인 + 마이그레이션 로컬 검증.**
  - Run: 위 vitest → PASS
  - Run: `npx supabase db lint` 또는 로컬 스택이 있으면 `supabase db reset`
  - 로컬 스택이 없으면 SQL 문법만 확인하고, 그 사실을 보고에 적는다.
- [ ] **Step 5: 커밋.**

### Task 5: 3D 장면 대상 단어

**Files:**
- Modify: `design/namchin-demand/three/shared.js` (`export const TARGET`)
- Modify: `design/namchin-demand/three/hero.js:132`, `design/namchin-demand/three/trust.js:109,119`
- Regenerate: `public/cherry/3d/*` (`node design/namchin-demand/build-3d.mjs`)
- Test: `tests/cherry/landing-variant.test.ts`

**Interfaces:**
- Produces: `TARGET: { short: '남친' | '짝남'; full: '남자친구' | '짝남' }`
  - `document.documentElement.dataset.variant === 'crush'`이면 짝남, 아니면 남친을 쓴다.
  - 사용처: `${TARGET.short} 팔로잉`, 노드 제목 `TARGET.full`, `${TARGET.short}은 모르게`

- [ ] **Step 1: 실패하는 테스트 작성.**
  - `3d sources take the target word from the variant`: `three/hero.js`, `three/trust.js` 소스에 `/남친|남자친구/` 리터럴이 없다.
  - `shared.js`에 `'짝남'`과 `'남자친구'`가 둘 다 있다.
  - `public/cherry/3d/` 번들 전체 텍스트에 `짝남` 또는 `짝남`이 있다.
- [ ] **Step 2: 실패 확인.** Run: 위 vitest → FAIL
- [ ] **Step 3: 구현 후 번들 재생성.** Run: `node design/namchin-demand/build-3d.mjs` → Expected: `public/cherry/3d/hero.js`, `trust.js`, `shared-*.js` 재생성
- [ ] **Step 4: 통과 확인.** Run: 위 vitest → PASS
- [ ] **Step 5: 커밋.**

### Task 6: Amplitude 변형 속성

**Files:**
- Modify: `lib/services/analytics.ts:91-120` (`PropertyName`에 `'variant'`), validator 맵(`variant: enumValidator(['bf','crush'])`), `EVENT_SCHEMAS:306-309`(체리 4종 → `['variant']`)
- Modify: `lib/services/cherry-analytics.ts` (`data-variant`를 읽어 4개 이벤트에 `{ variant }` 전달, 없으면 속성 없이)
- Test: `tests/shared/cherry-analytics.test.ts`, `tests/shared/analytics.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**
  - cherry-analytics: `<html data-variant="crush">`이면 `trackEvent`가 `('cherry_viewed', { variant: 'crush' })`로 호출된다. 속성이 없으면 `('cherry_viewed', undefined)` 또는 속성 없이 호출된다.
  - analytics: 기존 테스트 방식대로, `cherry_viewed`의 `variant: 'crush'`는 전송 속성에 남고 `variant: 'x'`는 빠진다.
- [ ] **Step 2: 실패 확인.** Run: `npx vitest run tests/shared/cherry-analytics.test.ts tests/shared/analytics.test.ts` → FAIL
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인.**
  - Run: 위 vitest → PASS
  - Run: `node scripts/build-cherry-analytics.mjs --dev` → 오류 없음(산출물 `public/cherry/analytics.js`는 git 대상이 아니면 커밋하지 않는다)
- [ ] **Step 5: 커밋.**

### Task 7: 전체 검증과 PR

- [ ] **Step 1:** Run: `npx tsc --noEmit` → Expected: 오류 0
- [ ] **Step 2:** Run: `npx vitest run tests/cherry tests/shared/cherry-analytics.test.ts tests/shared/analytics.test.ts` → Expected: 전부 PASS
- [ ] **Step 3:** Run: `npx eslint` (변경 파일만) → Expected: 오류 0
- [ ] **Step 4: 개발 서버 육안 확인.** `/cherry`, `/cherry?v=bf`, `/cherry?v=crush&fbclid=x#waitlist`를 연다.
  - crush 화면(인트로, 히어로 3D, 비밀 보장 3D, 동의 체크, FAQ)에 '남친'이 없는지 스크린샷으로 확인한다.
  - `/cherry`가 기존과 같은지 확인한다.
  - 예약 제출은 개발 환경이 운영 DB를 가리킬 수 있으니 하지 않는다.
- [ ] **Step 5: PR 생성(사용자 승인 후).**
  - PR 설명에 파이프라인 맵 점검 결과를 한 줄 넣는다: "변경 없음 — 체리 사전예약 랜딩만 바뀌고 분석 파이프라인은 그대로".
  - 남은 사용자 작업(픽셀 ID, 자동 고급 매칭 끄기, 프로덕션 마이그레이션)도 적는다.
- [ ] **Step 6: 병합·배포 후 확인(사용자 승인 후).**
  - 프로덕션 마이그레이션 적용(격리 workdir, dry-run, allowlist, history 검증)
  - 픽셀 ID 등록 후 운영 `?v=crush` 화면과 픽셀 요청에 `ud[`가 없는지 확인
  - 콘솔 변형 합계 확인
