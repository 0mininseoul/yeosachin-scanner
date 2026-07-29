# SEO/GEO Search Console 운영 런북

이 문서는 `yeosachin.com` 배포 전후의 검색 노출 점검, Google Search Console 등록, Google 생성형 AI 노출 설정, ChatGPT 유입 측정을 위한 운영 절차다.

## 사전 준비

- Google 계정으로 Search Console에 로그인할 수 있어야 한다.
- `yeosachin.com` DNS TXT 레코드를 추가·수정할 권한과 DNS 관리 화면 접근 권한을 준비한다.
- 배포 후보와 프로덕션의 HTTP 응답 및 HTML 메타데이터를 읽기 전용으로 확인할 수 있어야 한다.
- Google 확인 토큰, 자격 증명, 쿠키, 사용자 ID는 이 문서나 작업 로그에 붙여 넣지 않는다.

## 1. 배포 전·후 URL 확인

배포 전에는 배포 후보에서 아래 경로의 응답과 메타데이터를 확인한다. 배포 후에는 동일한 검사를 프로덕션의 절대 URL로 다시 실행한다. 리디렉션이 있으면 최종 URL과 상태 코드를 함께 기록한다.

| URL | 기대 결과 |
| --- | --- |
| `https://yeosachin.com/robots.txt` | HTTP 200, Googlebot·OAI-SearchBot이 공개 경로를 크롤링하도록 허용하고 절대 sitemap URL `https://yeosachin.com/sitemap.xml`을 선언함 |
| `https://yeosachin.com/sitemap.xml` | HTTP 200, 유효한 XML이며 정확히 공개 canonical URL `https://yeosachin.com/`, `https://yeosachin.com/guide/wijang-yeosachin`, `https://yeosachin.com/terms`, `https://yeosachin.com/privacy`만 포함함 |
| `https://yeosachin.com/` | HTTP 200, canonical이 `https://yeosachin.com/`이고 `noindex`가 없음 |
| `https://yeosachin.com/guide/wijang-yeosachin` | HTTP 200, canonical이 `https://yeosachin.com/guide/wijang-yeosachin`이고 `noindex`가 없음 |
| `https://yeosachin.com/terms` | HTTP 200, canonical이 `https://yeosachin.com/terms`이고 `noindex`가 없음 |
| `https://yeosachin.com/privacy` | HTTP 200, canonical이 `https://yeosachin.com/privacy`이고 `noindex`가 없음 |

배포 전과 배포 후 각각 다음을 확인한다.

1. `curl -I` 또는 동등한 읽기 전용 검사로 200 응답과 예상하지 않은 리디렉션 여부를 확인한다.
2. robots 정책이 공개 홈·가이드·약관·개인정보 페이지를 허용하고 비공개/인증 경로를 허용하지 않는지 확인한다.
3. sitemap이 위 표의 공개 HTML 4개만 `https://yeosachin.com` 절대 URL로 포함하는지 확인한다.
4. 홈·가이드·약관·개인정보 HTML의 `rel="canonical"`이 위 표의 자기 참조 URL과 일치하는지 확인한다.

## 2. Domain property와 DNS 소유권 확인

1. Search Console 속성 선택기에서 새 속성을 추가하고 `yeosachin.com`을 **Domain property**로 선택한다. 프로토콜이나 경로는 입력하지 않는다.
2. Search Console이 제공한 **DNS TXT 레코드로 소유권(ownership)을 확인**한다. TXT 토큰 값 자체는 티켓, 문서, 채팅, 저장소에 복사하지 않는다.
3. DNS 전파 후 Search Console에서 확인을 실행하고 소유권 확인 완료 상태를 기록한다.
4. Domain property는 HTTP/HTTPS 및 하위 도메인을 함께 집계하므로 이후 모든 절차에서 `yeosachin.com` 속성을 선택했는지 재확인한다.

## 3. Search generative AI 포함 설정

속성의 **설정 → Search generative AI**를 연다. 제어가 보이면 **“내 사이트의 링크와 콘텐츠를 Search generative AI 기능에 포함(Include my site's links and content)”**을 선택하거나 유지한다.

- Google 안내상 모든 속성의 기본값은 포함(include)이다. 상위 속성을 상속하는 하위 속성은 상위 설정을 따른다.
- 이 제어는 현재 일부(subset) 사이트 소유자에게 순차 rollout 중이므로 계정이나 속성에 아직 노출되지 않을 수 있다. 보이지 않으면 기본 포함 상태로 간주하되, 7일 점검 때 다시 확인한다.
- 포함 설정은 AI Overviews, AI Mode, Google Discover의 생성형 AI 기능에 노출될 자격을 허용할 뿐 노출이나 인용을 보장하지 않는다.

## 4. Sitemap 제출

1. Search Console의 **Sitemaps** 보고서를 연다.
2. 절대 URL `https://yeosachin.com/sitemap.xml`을 제출(submit)한다.
3. 제출 직후와 다음 점검 때 상태가 **성공(Success)**인지 확인한다. 성공이 아니면 해당 행을 열어 가져오기·파싱 오류를 확인한다.
4. 발견 URL 수가 예상 공개 URL 수와 맞는지, Page indexing 보고서에서 sitemap별 색인 상태를 확인한다.

## 5. URL Inspection, 실시간 테스트, 색인 요청

다음 두 URL을 각각 별도로 검사한다.

- `https://yeosachin.com/`: URL Inspection에서 **실시간 URL 테스트(Live URL test)**를 실행해 가져오기와 색인 허용을 확인한 뒤 **색인 생성 요청(Request indexing)**을 누른다.
- `https://yeosachin.com/guide/wijang-yeosachin`: URL Inspection에서 **실시간 URL 테스트(Live URL test)**를 실행해 가져오기와 색인 허용을 확인한 뒤 **색인 생성 요청(Request indexing)**을 누른다.

각 URL의 Page indexing 상세에서 다음을 기록한다.

- 크롤링 허용과 색인 생성 허용 여부
- 마지막 크롤링과 페이지 가져오기 결과
- **사용자 선언 표준 URL(User-declared canonical)**
- **Google 선택 표준 URL(Google-selected canonical)**

각 URL의 **사용자 선언 표준 URL**과 **Google에서 선택한 표준 URL**을 비교하여 해당 자기 참조 URL로 일치하는지 확인한다.

두 canonical은 해당 행의 자기 참조 URL과 같아야 한다. Google 선택값이 아직 없으면 신규 URL의 처리 지연으로 기록하고 관찰 주기에 다시 확인한다.

## 6. 측정

### 일반 Search Performance

Search Console의 **Performance → Search results**에서 기간 비교와 페이지/쿼리 필터를 사용한다.

- 핵심 쿼리: `위장여사친 판독기`, `위장여사친 구분법`
- 띄어쓰기 변형(variant): `위장 여사친 판독기`, `위장 여사친 구분법`, 붙여쓰기·부분 띄어쓰기 조합
- 지표: 노출, 클릭, CTR, 평균 게재순위
- 페이지: 홈과 `/guide/wijang-yeosachin`을 분리해 확인

### Google 생성형 AI 성과

**Generative AI performance report(생성형 AI 성과 보고서)**에서 **AI Overviews(AI 개요)**와 **AI Mode**의 노출 추이, 페이지, 국가, 기기, 날짜를 확인한다. 이 데이터는 일반 Performance 보고서의 Web 검색 유형에도 포함될 수 있다.

보고서가 없거나 미제공이면 rollout 중인 속성이거나 생성형 AI 노출(impression)이 충분하지 않을 수 있으므로 장애로 단정하지 않는다. 설정의 포함 상태를 확인하고 다음 관찰 주기에 다시 확인한다.

### ChatGPT 추천 유입과 Amplitude

OpenAI는 ChatGPT 검색 결과의 발행자 추천 링크에 `utm_source=chatgpt.com`을 자동으로 붙인다고 설명한다. 애플리케이션은 이 값만 내부 안전 enum으로 정규화하므로 Amplitude의 `landing_viewed` 이벤트에서 `source=chatgpt`, `medium=referral` 조합을 확인한다.

- 원본 URL, referrer, 검색 query, `chatgpt.com` 원문, 임의 UTM 값은 이벤트 속성으로 전송하거나 운영 보고서에 복사하지 않는다.
- 유효한 `utm_medium`이 명시된 경우 그 안전 enum을 유지하므로 ChatGPT 행을 볼 때 medium별 분포도 함께 확인한다.
- 유입 수와 이후 `target_submitted`, 인증, 결제, 분석 퍼널 전환은 집계값으로만 비교한다.

## 7. 7/28/90일 관찰 체크리스트

### 7일

- 배포 후 URL 6개가 계속 200인지 재확인한다.
- sitemap 상태, URL Inspection 색인 상태, 두 canonical을 확인한다.
- Search generative AI 제어가 노출됐는지와 포함 상태를 확인한다.
- 일반 Search Performance의 초기 노출과 Amplitude ChatGPT 유입을 기준선으로 기록한다.

### 28일

- 핵심 쿼리와 띄어쓰기 변형의 28일 추이를 이전 기간과 비교한다.
- 홈/가이드별 클릭·노출·CTR·평균 게재순위를 비교한다.
- Generative AI performance report의 제공 여부와 AI Overviews/AI Mode 노출을 확인한다.
- `source=chatgpt`, `medium=referral` 유입과 후속 퍼널의 집계 추이를 비교한다.

### 90일

- 90일 누적과 이전 90일을 비교하고 일시적 변동과 지속 추세를 구분한다.
- canonical, 색인, sitemap 오류가 재발했는지 확인한다.
- 일반 검색·Google 생성형 AI·ChatGPT 추천 유입을 별도 채널로 정리한다.
- 관찰된 쿼리와 페이지 성과를 바탕으로 다음 콘텐츠/기술 개선 후보를 제안하되 성과를 보장하는 표현은 쓰지 않는다.

## 8. 문제 해결

### Generative AI 보고서가 없을 때

보고서가 없거나 미제공인 경우 rollout 대상이 아니거나 생성형 AI 노출이 부족할 수 있다. **설정 → Search generative AI**가 보이면 포함을 확인하고, 일반 Performance의 Web 검색 데이터와 Amplitude를 계속 관찰한다.

### 색인되지 않을 때

색인되지 않음 또는 미등록 상태면 먼저 HTTP 상태, robots, `noindex`, sitemap 포함, 내부 링크, 렌더링된 canonical을 확인한다. URL Inspection 실시간 테스트가 성공하면 색인 생성을 한 번 요청하고 최소 7일 관찰한다. 반복 요청은 처리 우선순위를 보장하지 않는다.

### canonical 불일치(canonical mismatch)

Google-selected canonical과 User-declared canonical이 불일치하면 현재 URL, 선언 canonical, Google 선택 URL을 함께 비교한다. 리디렉션, 중복 콘텐츠, sitemap URL, 내부 링크, 프로토콜/호스트 일관성을 수정한 뒤 실시간 테스트와 재크롤링 요청을 수행한다.

## 9. 보장하지 않는 사항

**Sitemap 제출과 색인 생성 요청(indexing request)은 Google에 보내는 힌트(hint)일 뿐이다.**

- sitemap 또는 색인 요청은 실제 **색인을 보장하지 않는다**.
- 기술 요건 충족과 콘텐츠 개선은 검색 결과 **1위 랭킹을 보장하지 않는다**.
- Google 생성형 AI 포함 설정은 **AI 인용(citation)을 보장하지 않는다**.
- OAI-SearchBot 허용과 ChatGPT 유입 측정은 **ChatGPT 추천(recommendation)을 보장하지 않는다**.

## 10. 공식 참고 자료

기술 절차는 다음 공식 문서를 기준으로 갱신한다.

- Google Search Console: [속성 추가와 Domain property](https://support.google.com/webmasters/answer/34592)
- Google Search Console: [Search generative AI 제어](https://support.google.com/webmasters/answer/16908024)
- Google Search Console: [Sitemaps 보고서](https://support.google.com/webmasters/answer/7451001)
- Google Search Console: [URL Inspection](https://support.google.com/webmasters/answer/12482179)
- Google Search Console: [Page indexing 및 canonical 문제 해결](https://support.google.com/webmasters/answer/7440203)
- Google Search Console: [Generative AI performance report](https://support.google.com/webmasters/answer/16984139)
- Google Search Central: [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)
- Google Search Central: [Build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- OpenAI: [Crawler overview](https://developers.openai.com/api/docs/bots)
- OpenAI: [Publishers and Developers FAQ](https://help.openai.com/en/articles/12627856-publishers-and-developers-faq)
