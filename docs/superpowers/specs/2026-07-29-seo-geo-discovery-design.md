# 위장여사친 판독기 SEO·GEO·AEO 검색 발견성 — 설계

- 작성일: 2026-07-29
- 브랜치: `0mininseoul/seo-geo-discovery-optimization`
- 기준 커밋: `097d57d`
- 공개 기준 URL: `https://yeosachin.com`

## 배경과 현재 상태

목표 검색어는 `위장여사친 판독기`이며, 관련 정보 탐색 의도인 `위장여사친 구분법`에서도
서비스가 검색·인용될 수 있어야 한다. Google 일반 검색뿐 아니라 Google의 생성형 AI 검색
기능과 ChatGPT Search에서 발견·인용·추천될 수 있는 기반을 만든다.

2026-07-29 기준 저장소와 운영 URL을 점검한 결과:

1. 랜딩의 title, description, Open Graph, apex canonical은 이미 설정되어 있다.
2. `https://yeosachin.com/robots.txt`와 `/sitemap.xml`은 모두 404다.
3. 정확 검색어 `위장여사친 판독기`와 `site:yeosachin.com` 검색에서 운영 사이트가 확인되지
   않는다. `site:` 결과는 불완전할 수 있으므로 최종 판단은 Search Console URL 검사로 한다.
4. `위장여사친 구분법` 검색 의도에는 타사의 테스트형 콘텐츠가 노출되지만, 현재 서비스에는
   검색자가 읽고 AI가 인용할 수 있는 독립적인 설명 페이지가 없다.
5. 루트 metadata의 canonical `/`가 하위 라우트에 상속된다. 새 공개 콘텐츠는 반드시 자체
   canonical을 선언하고, 비공개·운영 라우트는 검색 대상에서 제외해야 한다.
6. OpenAI 공식 referral인 `utm_source=chatgpt.com`은 현재 Amplitude attribution allowlist에서
   탈락하므로 ChatGPT 유입이 측정되지 않는다.

변경 전 `npm test` 기준선은 4,175개 통과, 22개 실패, 90개 skip이었다. 실패는 모두 동시에
실행된 PGlite 인스턴스의 5~10초 초기화/훅 타임아웃이었다. 대표 실패 테스트
`v2-v24-upper-bound-reconciliation-pglite.test.ts`를 단일 워커로 재실행하면 3.8초에
통과했다. 이 설계의 구현 검증은 SEO 대상 테스트와 빌드·린트를 독립적으로 통과시키고, 전체
스위트는 PGlite 병렬 부하를 피하는 실행 조건으로 다시 확인한다.

## 목표

1. Google이 공개 핵심 URL을 발견하고 올바른 canonical로 색인할 수 있게 한다.
2. `위장여사친 판독기`라는 서비스 엔티티와 `위장여사친 구분법`이라는 탐색 의도를 한 사이트
   안에서 명확히 연결한다.
3. ChatGPT Search가 공개 설명 콘텐츠를 크롤링하고 출처로 인용할 수 있게 한다.
4. 사용자가 희망한 장기 모델 노출을 위해 GPTBot의 공개 콘텐츠 접근도 허용한다.
5. Google Search Console과 기존 Amplitude에서 Google·ChatGPT 발견성을 측정할 수 있게 한다.
6. `app/page.tsx`에 확정된 마케팅 카피는 한 글자도 수정하지 않는다.

## 성공 기준과 보장하지 않는 것

### 구현 완료 기준

- `/robots.txt`와 `/sitemap.xml`이 유효한 200 응답을 반환한다.
- sitemap에는 공개된 자체 canonical URL만 들어간다.
- 랜딩과 가이드가 서로 내부 링크로 연결된다.
- 랜딩과 가이드의 canonical, title, description, JSON-LD가 렌더된 초기 HTML에 존재한다.
- 공개 콘텐츠는 Googlebot과 OpenAI 크롤러가 접근할 수 있다.
- 인증·결과·운영·API URL은 sitemap에서 제외되고 적절히 크롤링 또는 색인 제한된다.
- `utm_source=chatgpt.com` 유입이 `source=chatgpt`, `medium=referral`로 정규화된다.
- 대상 단위 테스트, 린트, 프로덕션 빌드, 로컬 브라우저 검증이 통과한다.

### 외부 시스템에 의존하는 결과

검색 1위, 색인 시점, Google AI 기능의 노출, ChatGPT의 특정 답변 추천은 Google/OpenAI의
검색·랭킹·안전 시스템과 외부 평판에 의존하므로 코드로 보장할 수 없다. 이번 변경은 이 결과에
필요한 발견성·인용 가능성·측정 가능성을 최대화한다. 배포 후 Search Console 제출과 일정 기간의
관측이 필요하다.

## 조사 결론

### Google에서 GEO/AEO는 별도 해킹이 아니라 SEO 기반이다

Google의 2026년 공식 가이드는 생성형 AI 기능도 Search index와 핵심 랭킹 시스템에
기반한다고 설명한다. 공개·크롤링·색인 가능한 기술 구조, 독창적이고 유용한 콘텐츠, 명확한
사이트 구조가 우선이다.

다음 관행은 채택하지 않는다.

- `llms.txt`: Google은 이를 사용하지 않으며 순위에도 도움이 되지 않는다고 명시한다.
- 검색어 변형마다 만드는 대량 페이지: scaled content abuse 위험이 있고 장기적으로도 비효율적이다.
- AI만을 위한 잘게 쪼개기 또는 중복 재작성.
- 허위 후기·평점·전문가 자격·인위적인 외부 언급.
- FAQ/HowTo schema를 리치 결과 획득 수단으로 과장하는 것. HowTo 리치 결과는 폐지되었고,
  FAQ 리치 결과는 정부·의료 권위 사이트 중심으로 제한된다.

### OpenAI의 세 크롤러는 목적이 서로 다르다

- `OAI-SearchBot`: ChatGPT Search에서 검색·인용하기 위한 크롤러.
- `GPTBot`: 향후 foundation model 학습에 사용할 수 있는 콘텐츠를 수집하는 크롤러.
- `ChatGPT-User`: 사용자의 명시적 요청으로 페이지를 방문할 때 쓰는 에이전트.

사용자의 목표가 현재 검색 추천과 장기 모델 노출을 모두 포함하므로 공개 콘텐츠에는 셋 다
허용한다. robots 정책은 각 크롤러에 독립적으로 적용되며, 변경 반영에는 약 24시간 이상 걸릴
수 있다.

### GEO 연구의 적용 범위

KDD 2024의 GEO 논문은 이미 생성 엔진의 입력 문서 집합에 포함된 콘텐츠의 표현·근거·인용
방식이 답변 내 가시성에 영향을 줄 수 있음을 보였다. 그러나 이 결과는 자연 검색에서의 발견,
장기적인 추천, 실제 전환을 보장하지 않는다. 따라서 다음처럼 제한적으로 적용한다.

- 질문에 대한 직접 답변과 명확한 제목·소제목.
- 서비스가 실제로 사용하는 관찰 기준과 한계를 구체적으로 기술.
- 검증 가능한 자체 방법론과 수정일을 공개.
- 과장된 심리 통계나 출처 없는 수치를 만들지 않음.

## 채택한 접근

### 대안 A — 기술 SEO만 추가

robots, sitemap, canonical만 추가하면 가장 빠르지만, `위장여사친 구분법` 질문에 답하거나
ChatGPT가 인용할 독립 콘텐츠가 없다. 색인 적격성만 해결하고 추천 가능성은 거의 개선하지
못하므로 기각한다.

### 대안 B — 기술 기반 + 대표 가이드 + 엔티티 + 측정

한 개의 독창적인 대표 가이드에 서비스 정의·판독 기준·방법론·한계를 담고, 기술 SEO와
구조화 데이터, 내부 링크, ChatGPT attribution을 함께 적용한다. Google 공식 가이드와 가장
잘 맞고 스팸 위험이 낮으며 현재 서비스 규모에 적합하다. **이 안을 채택한다.**

### 대안 C — 프로그램형 콘텐츠 클러스터와 외부 언급 확대

키워드 변형별 페이지와 대량의 외부 언급을 먼저 만드는 접근이다. 초기 사이트에서 품질이
희석되고 Google의 scaled content abuse 정책과 충돌할 가능성이 높다. 실제 검색 데이터가
축적된 뒤 독립적인 사용자 질문이 확인될 경우에만 후속 단계로 검토한다.

## 기술 설계

### 1. 크롤링 정책

`app/robots.ts`를 Next.js MetadataRoute로 추가한다.

공개 콘텐츠에는 다음 에이전트의 접근을 명시적으로 허용한다.

- `Googlebot`
- `OAI-SearchBot`
- `GPTBot`
- `ChatGPT-User`
- 그 밖의 정상 크롤러(`*`)

다음 경로는 공개 검색 콘텐츠가 아니므로 crawl 대상에서 제외한다.

- `/api/`
- `/admin/`
- `/auth/`
- `/progress/`
- `/result/`
- `/share/`

`robots.txt`는 접근 통제 수단이 아니다. 실제 분석·운영 데이터는 기존 인증, 토큰, RLS가 계속
보호한다. 로그인·분석 입력·마이페이지·얼리버드처럼 HTML이지만 검색 가치가 없는 화면에는
route metadata의 `robots: { index: false, follow: false }`를 적용한다. 동적 결과·운영 경로는
기존 접근 통제와 robots 제외를 함께 유지한다.

공유 페이지는 기존 소셜 미리보기 호환성 때문에 일반적인 noindex metadata를 새로 넣지 않는다.
대신 sitemap에서 제외하고 `/share/` crawl을 제한하며, 현재의 토큰·공유 활성화 검증을
유지한다.

`robots.txt`에는 다음 sitemap 절대 URL을 선언한다.

```text
https://yeosachin.com/sitemap.xml
```

### 2. sitemap

`app/sitemap.ts`를 추가하고 다음 자체 canonical URL만 반환한다.

- `https://yeosachin.com/`
- `https://yeosachin.com/guide/wijang-yeosachin`
- `https://yeosachin.com/terms`
- `https://yeosachin.com/privacy`

모든 URL은 절대 URL이어야 한다. 실제 콘텐츠 수정일만 `lastModified`로 넣는다. Google이
무시하는 `priority`와 `changeFrequency`는 넣지 않는다. 인증 페이지, API, 결과, 공유 링크,
쿼리 파라미터 URL은 절대 포함하지 않는다.

### 3. canonical과 metadata

- 루트 canonical `/`와 기존 랜딩 metadata는 유지한다.
- 새 가이드는 `/guide/wijang-yeosachin` 자체 canonical을 선언한다.
- 약관과 개인정보처리방침도 각각 `/terms`, `/privacy` 자체 canonical 및 고유 title,
  description을 선언한다.
- 검색 가치가 없는 HTML 라우트는 noindex metadata로 루트 canonical 상속의 영향을 제거한다.
- `www.yeosachin.com`과 기존 Vercel 호스트의 308 apex redirect는 현재 `proxy.ts` 동작을
  그대로 유지한다.

### 4. 구조화 데이터

공용 JSON-LD 렌더러는 `<` 문자를 `\u003c`로 바꾼 뒤
`<script type="application/ld+json">`으로 초기 HTML에 출력한다.

랜딩에는 다음 그래프를 넣는다.

- `WebSite`
  - `name`: `위장여사친 판독기`
  - `alternateName`: `AI 위장 여사친 판독기`
  - `url`, `inLanguage`
- `Organization`
  - `name`/`legalName`: 운영 주체와 브랜드를 실제 footer·법적 문서와 일치시킴
  - `url`, `brand`

가이드에는 다음을 넣는다.

- `Article`: headline, description, URL, 한국어, 게시·수정일, Ascentum author/publisher
- `BreadcrumbList`: 홈 → 위장여사친 구분법

`FAQPage`, `HowTo`, `Review`, `AggregateRating`, 임의의 `sameAs`는 추가하지 않는다.
구조화 데이터는 보이는 콘텐츠와 정확히 일치해야 하며 리치 결과를 보장하지 않는다.

## 대표 콘텐츠 설계

### URL과 metadata

- URL: `/guide/wijang-yeosachin`
- title: `위장여사친 구분법 | 위장여사친 판독기`
- H1: `위장여사친 구분법: 인스타 공개 신호로 확인하는 기준`
- description:
  `맞팔 관계와 좋아요·댓글·태그·멘션 등 인스타그램 공개 신호로 위장여사친 후보를 구분하는 기준과 AI 판독 방식을 설명합니다.`

페이지는 Server Component로 렌더링하며 자바스크립트 실행 없이 본문과 링크를 읽을 수 있어야
한다.

### 첫 답변

문서 첫 화면에서 검색 질문에 바로 답한다.

> 위장여사친은 친구라고 소개되지만 공개된 상호작용에서 반복적인 친밀 신호가 나타나는
> 여사친을 뜻합니다. 한 번의 좋아요나 맞팔만으로 단정하지 않고, 맞팔 관계와 댓글·좋아요·
> 태그·멘션 같은 여러 공개 신호를 함께 비교해야 합니다.

이어 서비스 정의를 분명히 한다.

> 위장여사친 판독기는 남자친구의 인스타그램 공개 계정을 기준으로 맞팔 관계와 공개
> 상호작용을 AI로 교차 분석해, 확인이 필요한 후보를 상대적 위험도 순으로 보여주는 서비스입니다.

이 문구는 서비스가 실제 수행하는 범위 안에서 작성하며, 비공개 게시물·DM·실제 감정·외도
사실을 확인한다는 표현은 사용하지 않는다.

### 본문 구조

1. `위장여사친이란?`
   - 서비스가 사용하는 운영 정의.
   - 일반 여사친과 구분할 때 단일 행동이 아니라 조합을 본다는 원칙.
2. `구분할 때 함께 보는 공개 신호`
   - 맞팔 관계와 비교 대상.
   - 좋아요·댓글의 반복성과 댓글 친밀도.
   - 태그·멘션 등 공개 연결 신호.
   - 프로필과 공개 맥락.
   - 한 항목이 아닌 5개 축의 상대적 비교.
3. `수동 확인과 AI 판독의 차이`
   - 사람이 일부 계정을 순차적으로 보는 방식과, 맞팔 전체를 같은 기준으로 비교하는 방식.
4. `위장여사친 판독기는 어떻게 분석하나`
   - 공개 프로필 수집 → 맞팔 후보 추출 → 공개 상호작용 교차 분석 → 상대 위험도 정렬.
   - 내부 모델명·공급자·비밀 프롬프트는 공개하지 않는다.
5. `결과를 읽을 때 주의할 점`
   - 상대 위험도이며 사실 확정이 아님.
   - 비공개 정보·DM을 보지 않음.
   - 공개 데이터가 부족하거나 바뀌면 결과가 달라질 수 있음.
6. `자주 묻는 질문`
   - 좋아요 하나만으로 위장여사친인가?
   - 비공개 계정도 판독하는가?
   - 상대방에게 알림이 가는가?
   - 결과는 100% 정확한가?
   - 직접 확인하는 것과 무엇이 다른가?
7. 서비스 CTA
   - `/analyze`로 이동.
8. 방법론·게시일·수정일·운영 주체
   - 독자가 콘텐츠의 출처와 최신성을 확인할 수 있게 한다.

### 내부 링크

- 랜딩 footer 링크 모음에 `위장여사친 구분법`을 추가한다.
- 가이드에는 브랜드 홈과 `/analyze` 링크를 넣는다.
- 고정된 랜딩 헤드라인, 서브 문구, STEP, 신뢰 블록, 스트립, 하단 CTA 문구는 수정하지
  않는다.

## ChatGPT referral 측정

OpenAI는 ChatGPT Search 링크에 `utm_source=chatgpt.com`을 붙인다. 현재
`readAttribution()`은 이 값을 allowlist에서 제거한다.

다음처럼 정규화한다.

- raw `utm_source=chatgpt.com` → analytics `source=chatgpt`
- `utm_medium`이 없으면 → `medium=referral`
- 기존 `direct`, `google`, `instagram`, `kakao` 계약은 유지
- 원본 URL, 검색어, referrer 전체는 analytics 이벤트에 보내지 않는다

`lib/services/analytics.ts`, `lib/services/analytics-funnel.ts`와 관련 계약 테스트를 함께
갱신한다. 별도의 사용자 식별자나 개인정보를 추가하지 않는다.

## Search Console 운영 절차

구현 PR에는 `docs/seo-geo-search-console-runbook.md`를 추가한다. 배포 후 사용자가 수행할
절차는 다음과 같다.

1. Search Console에 `yeosachin.com` Domain property를 추가하고 DNS TXT로 소유권을 인증한다.
2. `설정 → Search generative AI`가 표시되면
   `Include my site's links and content in Search generative AI features`를 선택한다.
   이 기능은 2026-07-29 현재 일부 속성에 순차 배포 중이다.
3. `https://yeosachin.com/sitemap.xml`을 제출하고 상태가 `성공`인지 확인한다.
4. URL 검사에서 `/`와 `/guide/wijang-yeosachin`을 각각 실제 URL 테스트한 뒤 색인 생성을
   요청한다.
5. 두 URL의 `사용자 선언 표준 URL`과 `Google에서 선택한 표준 URL`이 일치하는지 확인한다.
6. 검색 실적에서 `위장여사친 판독기`, `위장여사친 구분법`, 띄어쓰기 변형을 추적한다.
7. 제공되는 경우 생성형 AI 실적 보고서에서 AI 개요·AI 모드의 페이지별 노출을 확인한다.
8. Amplitude에서 `source=chatgpt`, `medium=referral` 랜딩 유입을 확인한다.

색인 요청은 힌트이며 즉시 색인 또는 순위를 보장하지 않는다. 첫 관측 주기는 배포 후 7일,
28일, 90일로 한다.

## 테스트와 검증

구현은 테스트 우선으로 진행한다.

### 단위·계약 테스트

- robots가 공개 크롤러를 허용하고 모든 비공개 경로를 제외하는지 확인.
- sitemap이 정확한 공개 absolute canonical URL만 포함하는지 확인.
- 공개 metadata의 title, description, canonical, robots를 확인.
- JSON-LD 직렬화가 `<`를 이스케이프하고 선언된 schema와 visible content가 일치하는지 확인.
- `utm_source=chatgpt.com` 정규화와 기존 attribution 회귀 확인.
- 가이드가 H1, 직접 답변, 서비스 정의, 방법론, 한계, FAQ, CTA를 포함하는지 확인.
- 랜딩 고정 마케팅 카피의 기존 계약 테스트가 그대로 통과하는지 확인.

### 정적·프로덕션 검증

- 변경 파일 대상 ESLint.
- `npm run lint`.
- `npm run build`.
- SEO 관련 Vitest 대상 실행.
- 전체 Vitest는 PGlite 병렬 부하를 피하는 워커 설정으로 실행하거나, 기존 기준선 타임아웃과
  신규 실패를 명확히 분리해 기록한다.

### 브라우저·HTTP 검증

로컬 프로덕션 또는 개발 서버에서 다음을 확인한다.

- `/`, `/guide/wijang-yeosachin`, `/robots.txt`, `/sitemap.xml`이 200.
- 초기 HTML의 canonical, robots, title, description, JSON-LD.
- 가이드 본문이 JavaScript 없이 읽히고 내부 링크와 CTA가 작동.
- 375px 모바일과 데스크톱에서 오버플로·가독성 문제 없음.
- private route가 sitemap에 없고 noindex/인증 경계를 유지.
- Rich Results Test 또는 schema validator에서 JSON-LD 구문 오류 없음.

## 배포와 관측

이번 작업은 별도 브랜치에서 커밋하고 GitHub PR까지 생성한다. 프로덕션 배포와 Search Console
조작은 PR 병합 이후 별도 단계이며, 이번 작업이 자동으로 프로덕션을 변경하지 않는다.

배포 이후:

1. 공개 endpoints와 크롤러 응답을 다시 확인한다.
2. Search Console 절차를 수행한다.
3. OpenAI robots 변경은 반영까지 시간이 걸릴 수 있으므로 24~72시간 뒤 다시 확인한다.
4. 7/28/90일에 검색 및 생성형 AI 노출을 기록한다.
5. 데이터가 쌓인 뒤에만 추가 가이드나 외부 홍보 주제를 결정한다.

## 범위 밖

- 프로덕션 배포와 DNS/Search Console 직접 변경.
- 유료 링크, 자동 댓글, 가짜 리뷰, 가짜 전문가 인용, 인위적인 추천 조작.
- 키워드 변형마다 만드는 대량 문서.
- `llms.txt` 또는 AI 전용 Markdown 사본.
- 서비스 판독 알고리즘, Gemini 프롬프트, 데이터베이스, 결제, Instagram scraper 변경.
- `app/page.tsx`의 확정 마케팅 카피 변경.

## 참고 자료

- Google, Optimizing your website for generative AI features:
  https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
- Google, Build and submit a sitemap:
  https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
- Google, Robots meta tag and X-Robots-Tag:
  https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag
- Google Search Console, Search generative AI control:
  https://support.google.com/webmasters/answer/16908024
- Google Search Console, Generative AI performance report:
  https://support.google.com/webmasters/answer/16984139
- OpenAI, Overview of OpenAI Crawlers:
  https://developers.openai.com/api/docs/bots
- OpenAI, Publishers and Developers FAQ:
  https://help.openai.com/en/articles/12627856
- Next.js, robots metadata file:
  https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots
- Next.js, sitemap metadata file:
  https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap
- Next.js, JSON-LD:
  https://nextjs.org/docs/app/guides/json-ld
- Aggarwal et al., GEO: Generative Engine Optimization, KDD 2024:
  https://arxiv.org/abs/2311.09735
