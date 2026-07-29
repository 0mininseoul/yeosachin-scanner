# 위장여사친 판독기 SEO·GEO·AEO 검색 발견성 — 구현 계획

> 설계: `docs/superpowers/specs/2026-07-29-seo-geo-discovery-design.md`
>
> 구현 규칙: 각 동작은 테스트를 먼저 작성하고 예상한 이유로 실패하는 것을 확인한 뒤 최소
> 구현으로 통과시킨다. `app/page.tsx`의 확정 마케팅 카피는 수정하지 않는다.

## Task 1 — 검색 발견성 기반과 구조화 데이터

### 목표

공개 URL을 검색 크롤러가 발견·색인할 수 있게 하고, 공개·비공개 라우트의 검색 경계를
명시하며, 안전하게 JSON-LD를 렌더링한다.

### RED

새 테스트 파일 `lib/services/seo/discovery.test.ts`를 작성한다.

1. `app/robots.ts`의 반환값이 다음을 만족하는지 검증한다.
   - `Googlebot`, `OAI-SearchBot`, `GPTBot`, `ChatGPT-User`, `*`를 허용.
   - `/api/`, `/admin/`, `/auth/`, `/progress/`, `/result/`, `/share/`를 제외.
   - `https://yeosachin.com/sitemap.xml`을 선언.
2. `app/sitemap.ts`의 URL이 정확히 다음 네 개이고 모두 절대 canonical인지 검증한다.
   - `/`
   - `/guide/wijang-yeosachin`
   - `/terms`
   - `/privacy`
   - `priority`와 `changeFrequency`가 없어야 한다.
3. JSON-LD 직렬화가 `<`를 `\u003c`로 바꾸고 유효한 JSON으로 되돌릴 수 있는지 검증한다.
4. 홈페이지 JSON-LD 그래프가 실제 브랜드·법인·URL·한국어 정보를 포함하고,
   허위 `Review`, `AggregateRating`, `sameAs`를 포함하지 않는지 검증한다.
5. 약관·개인정보처리방침 metadata가 고유 title, description, 자체 canonical을 갖는지
   검증한다.
6. 검색 가치가 없는 HTML 라우트가 공용 noindex metadata를 사용하는지 검증한다.

테스트를 실행해 필요한 모듈·exports가 아직 없어 실패하는 것을 확인한다.

```bash
npx vitest run lib/services/seo/discovery.test.ts
```

### GREEN

1. `lib/services/seo/discovery.ts`
   - canonical origin을 `CANONICAL_APP_ORIGIN`에서 재사용.
   - 공개 sitemap URL, private crawl path, AI crawler 목록을 한 곳에서 정의.
   - homepage `WebSite` + `Organization` JSON-LD 그래프 생성.
   - 공용 `NOINDEX_ROBOTS` metadata 상수 제공.
2. `components/seo/json-ld.tsx`
   - `<`를 `\u003c`로 escape하는 직렬화 함수.
   - `application/ld+json` script 렌더러.
   - 테스트 가능한 직렬화 함수를 export.
3. `app/robots.ts`
   - Next.js `MetadataRoute.Robots` 구현.
4. `app/sitemap.ts`
   - Next.js `MetadataRoute.Sitemap` 구현.
   - 실제 날짜만 `lastModified`에 사용하고 priority/changeFrequency는 생략.
5. `app/page.tsx`
   - 고정 카피는 변경하지 않고 import와 homepage JSON-LD script만 추가.
6. `app/privacy/page.tsx`, `app/terms/page.tsx`
   - 고유 Metadata export 추가. 법적 본문은 수정하지 않음.
7. noindex route metadata
   - `app/admin/layout.tsx`
   - `app/analyze/layout.tsx`
   - `app/login/layout.tsx`
   - `app/progress/layout.tsx`
   - `app/result/layout.tsx`
   - 기존 `app/earlybird/page.tsx`, `app/mypage/page.tsx` metadata 갱신.
   - `/share`는 기존 소셜 미리보기 호환성 때문에 변경하지 않음.

### 검증

```bash
npx vitest run lib/services/seo/discovery.test.ts
npx eslint app/robots.ts app/sitemap.ts components/seo/json-ld.tsx \
  lib/services/seo/discovery.ts app/privacy/page.tsx app/terms/page.tsx \
  app/admin/layout.tsx app/analyze/layout.tsx app/login/layout.tsx \
  app/progress/layout.tsx app/result/layout.tsx app/earlybird/page.tsx \
  app/mypage/page.tsx app/page.tsx
```

커밋 메시지:

```text
feat: add search discovery infrastructure
```

## Task 2 — 대표 가이드와 내부 엔티티 연결

### 목표

`위장여사친 구분법` 질문에 직접 답하고 서비스의 실제 판독 방식·한계·CTA를 설명하는
서버 렌더링 대표 페이지를 만든다. 랜딩 고정 카피는 유지하면서 내부 링크로 연결한다.

### RED

새 테스트 파일 `lib/services/seo/guide-page.test.tsx`를 작성한다.

1. 가이드 metadata가 다음을 만족하는지 검증한다.
   - title: `위장여사친 구분법 | 위장여사친 판독기`
   - canonical: `/guide/wijang-yeosachin`
   - 고유 description과 index/follow.
2. 실제 Page component를 static markup으로 렌더해 다음 visible content를 검증한다.
   - H1 `위장여사친 구분법: 인스타 공개 신호로 확인하는 기준`
   - 첫 답변의 운영 정의.
   - `위장여사친 판독기` 서비스 직접 정의.
   - 맞팔, 좋아요, 댓글, 태그, 멘션의 복수 신호.
   - 수동 확인과 AI 판독 비교.
   - 공개 프로필 → 맞팔 후보 → 공개 상호작용 → 상대 위험도 과정.
   - 비공개 정보·DM을 보지 않으며 사실 확정이 아니라는 한계.
   - 다섯 개 FAQ와 `/analyze` CTA.
   - 게시일·수정일·운영 주체.
3. guide JSON-LD가 `Article`과 `BreadcrumbList`를 포함하고 visible metadata와
   title/date/URL이 일치하는지 검증한다.
4. `app/page.tsx` footer에 `/guide/wijang-yeosachin` 내부 링크가 생겼는지 검증한다.
5. 랜딩의 고정 hero/STEP/trust/strip/bottom CTA 핵심 문구가 그대로 남아 있는지 회귀
   검증한다.

테스트를 실행해 새 route와 guide JSON-LD가 없어 실패하는 것을 확인한다.

```bash
npx vitest run lib/services/seo/guide-page.test.tsx
```

### GREEN

1. `app/guide/wijang-yeosachin/page.tsx`
   - Server Component.
   - 기존 dark case-file 디자인 토큰과 `TopBar`, `Eyebrow`, `CaseCard`,
     `PrimaryButton` 또는 링크 스타일을 재사용.
   - 설계 문서의 첫 답변, 본문 8개 구획, FAQ, CTA, 방법론 정보를 visible HTML로 구현.
   - 콘텐츠는 실제 공개 분석 범위만 설명하고, 출처 없는 심리 통계나 확정적 진단을 쓰지 않음.
   - 고유 metadata와 guide JSON-LD 출력.
2. `lib/services/seo/discovery.ts`
   - Article + BreadcrumbList guide JSON-LD builder 추가.
   - visible metadata와 공유하는 상수로 title/description/date 불일치 방지.
3. `app/page.tsx`
   - footer 링크 묶음에 `위장여사친 구분법` 링크만 추가.
   - 기존 카피 한 글자도 변경하지 않음.

### 검증

```bash
npx vitest run lib/services/seo/discovery.test.ts \
  lib/services/seo/guide-page.test.tsx
npx eslint app/guide/wijang-yeosachin/page.tsx \
  lib/services/seo/discovery.ts lib/services/seo/guide-page.test.tsx app/page.tsx
```

커밋 메시지:

```text
feat: publish the definitive disguised-friend guide
```

## Task 3 — ChatGPT attribution과 Search Console 운영 문서

### 목표

OpenAI가 붙이는 referral을 기존 개인정보 경계 안에서 측정하고, 배포 후 사용자가 수행할
Google Search Console 절차를 재현 가능한 문서로 제공한다.

### RED

기존 `lib/services/analytics-funnel.test.ts`와 `lib/services/analytics.test.ts`에 다음
테스트를 먼저 추가한다.

1. `utm_source=chatgpt.com`만 있으면 `{ source: 'chatgpt', medium: 'referral' }`.
2. 명시적인 유효 `utm_medium`이 있으면 그 값을 보존.
3. 기존 direct/google/instagram/kakao 정규화가 그대로 유지.
4. Amplitude `LANDING_VIEWED` source validator가 `chatgpt`를 허용.
5. 원본 `chatgpt.com`, URL, referrer, query 문자열을 이벤트 값으로 보내지 않음.

새 docs contract test `lib/services/seo/search-console-runbook.test.ts`를 작성한다.

1. Domain property + DNS TXT 인증.
2. `설정 → Search generative AI` 포함 설정과 단계적 출시 주의.
3. 절대 sitemap URL 제출.
4. `/`와 guide 실제 URL 검사·색인 요청.
5. 사용자 선언/Google 선택 canonical 확인.
6. 일반 검색 실적과 생성형 AI 실적 보고서.
7. Amplitude `chatgpt / referral`.
8. 7/28/90일 관측.
9. 색인과 1위·추천을 보장하지 않는다는 문구.

테스트를 실행해 ChatGPT source와 운영 문서가 없어 실패하는 것을 확인한다.

```bash
npx vitest run lib/services/analytics-funnel.test.ts \
  lib/services/analytics.test.ts \
  lib/services/seo/search-console-runbook.test.ts
```

### GREEN

1. `lib/services/analytics-funnel.ts`
   - raw `chatgpt.com`을 내부 enum `chatgpt`로 정규화.
   - medium이 없을 때만 `referral` 기본값.
2. `lib/services/analytics.ts`
   - source validator에 `chatgpt` 추가.
3. `docs/seo-geo-search-console-runbook.md`
   - 위 RED 요구사항을 한국어 단계별 체크리스트로 작성.
   - Google/OpenAI 공식 문서 링크 포함.
   - 배포 전/후 확인 URL 및 예상 결과 포함.

### 검증

```bash
npx vitest run lib/services/analytics-funnel.test.ts \
  lib/services/analytics.test.ts \
  lib/services/seo/search-console-runbook.test.ts
npx eslint lib/services/analytics-funnel.ts lib/services/analytics.ts \
  lib/services/analytics-funnel.test.ts lib/services/analytics.test.ts \
  lib/services/seo/search-console-runbook.test.ts
```

커밋 메시지:

```text
feat: measure ChatGPT referrals
```

## Task 4 — 통합 검증과 PR 준비

### 자동 검증

```bash
npm run lint
npm run build
npx vitest run lib/services/seo/discovery.test.ts \
  lib/services/seo/guide-page.test.tsx \
  lib/services/seo/search-console-runbook.test.ts \
  lib/services/analytics-funnel.test.ts \
  lib/services/analytics.test.ts
```

전체 테스트는 먼저 일반 실행하고, 기준선과 같은 PGlite 타임아웃이 재현되면 단일 워커 또는
낮은 워커 수로 신규 회귀 여부를 분리한다.

```bash
npm test
npx vitest run --maxWorkers=1 --fileParallelism=false
```

### 로컬 HTTP·브라우저 검증

1. 프로덕션 빌드 서버를 실행.
2. 다음 URL이 200인지 확인:
   - `/`
   - `/guide/wijang-yeosachin`
   - `/robots.txt`
   - `/sitemap.xml`
3. initial HTML에서 title, description, canonical, JSON-LD 확인.
4. crawler user-agent로 공개 페이지 접근 및 robots 규칙 확인.
5. guide를 375px 모바일과 데스크톱에서 확인.
6. 홈↔가이드, guide→`/analyze` 링크 확인.
7. private route가 sitemap에 없고 noindex/인증 경계를 유지하는지 확인.

### 최종 검토

- 설계 문서와 diff의 사양 일치 검토.
- Critical/Important 코드 리뷰 지적을 모두 해결.
- 보호된 migration과 `.playwright-mcp/` 무변경 확인.
- `origin/main`과의 diff, 커밋, working tree 상태 확인.
- 브랜치를 push하고 GitHub PR 생성.
