# 결제 전 몰입형 예시 결과 — 디자인 2

- 작성일: 2026-08-11
- 상태: 사용자 승인된 디자인 2를 구현 가능한 경계로 고정한 설계
- 위치: `/analyze`의 성공한 preflight 대상 확인 카드와 기존 요금제 카드 사이

## 결정 요약

성공한 ready preflight와 본인 계정 제외 결정이 모두 있는 경우, 실제 대상의 확인된 프로필과 팔로워·팔로잉 수를 먼저 그대로 보여준다. 그 바로 아래에 **6초짜리 예시 결과 시연**을 인라인으로 재생하고, 끝나면 기존 플랜 카드로 이어진다. 시연의 관계 그래프, 여성 후보 두 명, 위험 근거 리포트는 현재 published synthetic fixture에서만 가져오며, 화면의 모든 단계에서 실제 대상과 무관한 합성 예시임을 분명히 표시한다.

이 기능은 분석을 시작하거나 결과를 기다리게 하는 화면이 아니다. preflight는 이미 끝난 상태이고, 실제 관계 수집·후보 분류·위험도 계산·분석 시작은 사용자가 기존 플랜을 선택하고 기존 결제 경로를 통과한 뒤의 현재 계약에만 남는다.

## 목적과 성공 기준

### 목적

- 사용자가 가격을 보기 전에 제품 결과의 구조와 읽는 방식을 짧게 이해하게 한다.
- 실제 대상 확인으로 얻은 맥락과, 별도 합성 예시가 주는 결과 경험을 명확히 분리한다.
- 로그인과 결제는 기존처럼 플랜 선택 뒤에만 요구하고, 가격 확인 경로를 막지 않는다.

### 성공 기준

- `readyPreflight`와 exclusion 결정 뒤에만 대상 확인과 예시 시연이 보인다.
- 대상 reveal에는 해당 ready preflight의 실제 `username`, `profileImage`, `fullName`, `bio`, `followersCount`, `followingCount`만 사용한다.
- 합성 영역에는 fixture의 정확히 두 공개 후보와 한 개의 리포트 일부만 보이며, 화면과 접근성 텍스트 모두 `예시 결과 · 합성 데이터`임을 밝힌다.
- 사용자는 어느 단계에서든 `가격 바로 보기`를 누르고 즉시 기존 플랜 섹션으로 이동할 수 있다.
- 시연은 정상 환경에서 6초 이내에 끝나며, 그 시간은 제품 분석 대기시간이나 실제 작업 진행률처럼 표현되지 않는다.
- fixture·네트워크·클라이언트 파싱 실패는 예시만 숨기고 기존 대상 카드와 플랜 카드를 그대로 노출한다.
- 실제 대상 식별 정보는 Session Replay에서 마스킹되고, 새로 명시적으로 허용하는 replay 콘텐츠는 합성 예시 블록뿐이다.

## 방향 검토와 확정안

| 안 | 개요 | 장점 | 단점 | 결정 |
| --- | --- | --- | --- | --- |
| 1. 정적 예시 카드 | 대상 카드 아래에 합성 결과 요약만 즉시 배치 | 가장 작은 변경, 가격까지 최단 거리 | 결과가 어떻게 만들어지고 읽히는지 전달력이 약함 | 미채택 |
| 2. 인라인 6초 시연 | 실제 대상 확인 후 합성 예시를 세 장면으로 순차 노출하고 플랜으로 연결 | 확인된 대상 맥락은 유지하면서 제품 경험을 설명하고, 즉시 skip도 가능 | 타이밍·접근성·실패 시 열림 동작을 정확히 구현해야 함 | **채택** |
| 3. 질문형 또는 긴 대기형 흐름 | 문항, 선택지, 카운트다운 뒤 예시 결과를 노출 | 체류시간을 길게 만들 수 있음 | 답변이 실제 분석에 쓰인다는 오해와 가격 접근 지연을 만듦 | 미채택 |

이미 관찰한 `vir-tually.love` 여정에서는 짧은 장면 전환과 다음 행동으로 이어지는 리듬만 참고한다. 그 서비스의 질문 구조, 문구, 브랜드, 자산, 화면 구성, 로그인 흐름, 장시간 suspense를 복제하지 않는다.

## 범위

### 포함

- ready preflight 대상 확인을 시연의 첫 reveal로 재사용한다.
- 관계 그래프 확인, 여성 후보 분류, 위험 근거 분석의 세 합성 장면을 5~7초 안에 보여준다.
- 현재 published synthetic fixture를 축약한 정확히 두 후보와 한 리포트 일부를 보여준다.
- `가격 바로 보기`와 `플랜 선택하고 실제 판독 시작`의 앵커 동작을 추가한다.
- reduced motion, 키보드, 스크린리더, failure, Session Replay, 최소 analytics를 설계한다.

### 제외

- 설문, 질문, 답변 저장, 개인화된 예시 생성
- 실제 팔로워·팔로잉·맞팔 목록, 실제 후보, 실제 상호작용, 실제 성별 판단의 노출
- 대상의 점수, 추정 위험도, 후보 수, 발견 수, 판독 완료 상태의 표시
- 새 Instagram scraper 호출, 새 preflight 호출, 새 analysis 시작 호출, DB migration, fixture 생성·수정
- 플랜 카탈로그·가격·재고·선택 로직, checkout, 로그인 시점, claim, entitlement, 기존 analysis 시작 의미의 변경
- `app/page.tsx`의 확정 랜딩 마케팅 카피 변경

## 진실성 계약

이 화면이 지켜야 할 문장은 다음과 같다.

> **실제 대상 확인:** 위 대상 프로필과 팔로워·팔로잉 수는 방금 완료된 preflight에서 확인된 값이다.
>
> **예시 시연:** 아래 후보와 리포트는 실제 대상과 무관한 합성 데이터로 만든 예시다. 실제 대상의 관계·후보·위험도는 아직 수집하거나 계산하지 않았다.

이를 구현상 다음 규칙으로 고정한다.

1. 실제 target reveal은 현재 `readyPreflight.target`만 렌더한다. 이 데이터는 합성 projection 함수, 예시 API 요청, analytics property에 절대 들어가지 않는다.
2. 관계 그래프는 `합성 관계 그래프`라는 라벨을 갖는 설명용 도형이다. 실제 팔로워·팔로잉·맞팔 노드, 핸들, 개수, 연결 관계를 그리지 않는다.
3. 두 후보는 published fixture의 featured rank 1·2 공개 후보만 쓴다. 각 후보의 합성 아바타·합성 이름·합성 핸들은 허용하지만, target의 이미지·이름·바이오·count와 섞지 않는다.
4. 수치형 `displayScore`는 예시에도 노출하지 않는다. 후보의 등급은 `고위험 예시` 또는 `주의 예시`처럼 질적 라벨로만 보이며, 실제 대상에 대한 점수처럼 읽힐 수 있는 수치는 없다.
5. 리포트 일부는 rank 1 fixture 후보의 기존 `highRiskNarrative` 두 줄을 그대로 축약해 쓴다. fixture에 이 두 줄이 없거나 계약을 만족하지 않으면 예시 전체를 렌더하지 않는다. 새 AI 호출이나 문장 생성은 하지 않는다.
6. 단계 레이블은 `관계 그래프 확인 · 예시`, `여성 후보 분류 · 예시`, `위험 근거 분석 · 예시`다. `판독 완료`, `여성 N명 발견`, `위험도 확정`, `실제 분석 중` 같은 표현을 사용하지 않는다.
7. 6초는 이미 준비된 합성 화면을 보여주는 연출 시간일 뿐이다. 숫자 카운트다운, 예상 완료 시각, 퍼센트 진행률, 로딩 spinner, 20초 대기, 대기 강제는 없다.
8. `플랜 선택하고 실제 판독 시작`은 플랜 섹션으로 가는 앵커일 뿐이다. 그 클릭은 plan selection, 로그인, checkout, entitlement, analysis start를 호출하지 않는다. 실제 판독 시작은 현행 결제 후 흐름에서만 발생한다.

## 화면 구조와 상태

### 표시 조건

`app/analyze/page.tsx`는 기존 조건을 그대로 사용해 아래 조합에서만 preview를 마운트한다.

```text
preflight.status === 'ready'
AND exclusionState is 'excluded' or 'skipped'
AND readyPreflight is current-pricing valid
AND autoCheckout transition is not visible
```

`pending`, `blocked`, `consumed`, 가격 refresh 중, 로그인 후 자동 checkout 이동 중에는 preview를 만들지 않는다. 대상 변경·reset·새 preflight·가격 snapshot 교체는 이전 preview를 언마운트하고 타이머와 fixture 요청을 취소한다.

### 화면 골격

```text
성공한 ready preflight
  └─ PrecheckoutDemoPreview
       ├─ 실제 대상 확인 카드 (기존 CaseCard 표현 재사용, Replay 마스킹)
       │    └─ @target / 실명·bio / 실제 팔로워·팔로잉 수
       └─ 예시 결과 · 합성 데이터
            ├─ 가격 바로 보기  ───────────────────────────┐
            ├─ 관계 그래프 확인 · 예시                   │
            ├─ 여성 후보 분류 · 예시 (합성 후보 2명)       │
            ├─ 위험 근거 분석 · 예시 (합성 리포트 일부)    │
            └─ 플랜 선택하고 실제 판독 시작 ──────────────┤
                                                         ↓
       기존 요금제 선택 section#plan-selection
         └─ 기존 radio, 가격, checkout CTA, login handoff
```

실제 target을 표시하는 기존 `CaseCard` 마크업은 새 컴포넌트 안으로 좁게 옮긴다. 같은 카드를 두 번 렌더하지 않는다. 즉, target card 자체가 장면 시작 전의 실제 reveal이며, 그 뒤 세 장면만 합성 시연이다.

### 기본 타이밍

fixture DTO가 유효하게 도착한 시점부터 총 **6,000ms**를 사용한다. 화면이 백그라운드에 있어도 실제 분석 작업을 나타내는 타이머가 아니므로, 재포커스 시에는 현재 장면을 정적으로 보존하거나 바로 최종 예시로 전환한다. 누적 지연을 만들지 않는다.

| 경과 시간 | 장면 | 보이는 내용 | 금지되는 의미 |
| --- | --- | --- | --- |
| 0–1,800ms | 관계 그래프 확인 · 예시 | target 이름 없는 합성 그래프와 `예시 결과 · 합성 데이터` 배지 | 실제 관계 목록 수집 또는 맞팔 수 계산 |
| 1,800–3,700ms | 여성 후보 분류 · 예시 | fixture featured rank 1·2의 합성 후보 두 행, 질적 risk tag | 실제 대상의 여성 후보 또는 실제 성별 판단 |
| 3,700–6,000ms | 위험 근거 분석 · 예시 | 첫 합성 후보의 fixture narrative 두 줄과 결과 구조 | 실제 대상의 위험도·점수·판독 완료 |
| 6,000ms 이후 | 정적 결과 구성 예시 | 세 장면의 요약, 상세 펼치기, 플랜 앵커 CTA | 실시간 진행 또는 완료 보고 |

각 장면은 150~250ms의 opacity/transform 전환만 쓴다. CSS와 JavaScript 모두 `prefers-reduced-motion`을 존중해야 하며, 장면 전환이 다음 장면의 정보 접근을 막지 않아야 한다.

### 즉시 skip 및 플랜 CTA

- `가격 바로 보기`는 첫 렌더부터 모든 장면 상단에 항상 노출되는 일반 앵커다. `href="#plan-selection"`가 JavaScript 없이도 동작해야 한다.
- JavaScript가 있을 때는 클릭 즉시 타이머와 fetch 결과 반영을 중단하고 예시 영역을 접는다. 그 뒤 native anchor로 `section#plan-selection`에 이동한다. 네트워크 완료나 6초 종료를 기다리지 않는다.
- 최종 장면의 primary CTA 문구는 정확히 `플랜 선택하고 실제 판독 시작`이다. 이 역시 동일한 `#plan-selection` 앵커이며, 기존 radio와 결제 CTA를 재사용한다.
- 계획 섹션은 `id="plan-selection"`, `tabIndex={-1}`, sticky header를 고려한 scroll margin을 가진다. 사용자가 skip 또는 CTA를 활성화했을 때에만 heading으로 focus를 옮긴다. 자동 scroll이나 자동 focus는 없다.
- CTA 클릭은 `plan_selected`를 발화하지 않는다. `plan_selected`는 현재처럼 radio 선택 때만, `plan_viewed`는 현재처럼 ready preflight의 플랜 카드가 노출될 때만 발화한다.

### 펼치기

최종 정적 상태에는 `예시 결과 자세히 보기` button을 둔다. 열기 전에는 합성 후보 두 행, 한 줄 요약, 플랜 CTA를 보여주고, 열면 같은 두 후보의 요약 필드와 fixture narrative 두 줄을 한 case-file 형태로 모두 보인다. 더 많은 후보를 요청·페이지네이션·로드하지 않는다.

button은 `aria-expanded`와 `aria-controls`를 갖는다. 닫았다 다시 열어도 새 데이터 요청이나 새 analytics 이벤트는 발생하지 않는다.

## 데이터 경계와 계약

### 실제 preflight target 경계

새 컴포넌트가 받는 실제 데이터는 다음 좁은 view model뿐이다.

```ts
type PreflightTargetReveal = Readonly<{
  username: string;
  fullName: string | null;
  bio: string | null;
  profileImage: string | null;
  followersCount: number;
  followingCount: number;
}>;
```

이 값은 `readyPreflight.target`에서 직접 만들며, 화면의 target card 렌더링에만 사용한다. `preflightId`는 analytics dedupe와 component lifecycle key에만 사용한다. target object와 `preflightId`를 fixture endpoint URL, query, request body, server log, analytics property, synthetic DTO에 넣지 않는다.

### 합성 preview DTO

`lib/services/demo-analysis/precheckout-preview.ts`는 fixture 전체를 브라우저에 넘기지 않는 순수 projection 모듈이다. server-only loader인 `loadPublishedDemoFixture()`를 이 모듈에 넣지 않는다.

```ts
type PrecheckoutDemoCandidate = Readonly<{
  displayName: string | null;
  instagramId: string;
  profileImage: string; // /demo-avatars/* local asset only
  riskBand: 'high_risk' | 'caution' | 'normal';
  oneLineOverview: string;
}>;

type PrecheckoutDemoPreviewV1 = Readonly<{
  schemaVersion: 1;
  fixtureVersion: string;
  candidates: readonly [PrecheckoutDemoCandidate, PrecheckoutDemoCandidate];
  report: Readonly<{
    riskBand: 'high_risk';
    lines: readonly [string, string];
  }>;
}>;
```

`displayScore`, fixture target summary, mutual counts, private accounts, non-featured accounts, raw payload, source URL, preflight data는 DTO에 넣지 않는다. client는 같은 Zod schema로 응답을 다시 검증하고, 실패 시 `null`로 취급한다.

### projection 규칙

`toPrecheckoutDemoPreview(fixture)`는 다음을 모두 만족할 때만 DTO를 반환한다.

1. loader가 현재 `DEMO_FIXTURE_VERSION`의 published, 검증 완료 fixture를 제공한다.
2. `featuredRank === 1`과 `featuredRank === 2`인 서로 다른 공개 후보가 각각 하나씩 있다.
3. rank 1 후보는 `riskBand === 'high_risk'`, `analysisDepth === 'narrative'`, 정확히 두 줄의 `highRiskNarrative`를 가진다.
4. 두 후보의 avatar는 `/demo-avatars/` local asset 규칙을 만족한다.

하나라도 맞지 않으면 `null`을 반환한다. projection은 임의 후보를 채우거나 문장을 보정하지 않는다. fixture version이 바뀌면 새 published fixture가 이 계약을 충족할 때에만 preview가 다시 보인다.

### 읽기 endpoint

`app/api/demo-analysis/precheckout-preview/route.ts`를 추가한다.

- `GET`만 허용하며 인증, target, preflight ID, query parameter, request body를 요구하지 않는다.
- 서버에서만 `loadPublishedDemoFixture()`와 순수 projection을 연결한다.
- 성공 시 위의 작은 DTO만 반환한다. 유효 fixture가 없거나 server-only rollout flag `PRECHECKOUT_DEMO_PREVIEW_ENABLED`가 켜져 있지 않으면 `204 No Content`으로 응답한다.
- response에는 target, preflight, user, fixture raw payload, 후보 2명 외의 목록, 외부 URL, secret를 넣지 않는다.
- endpoint는 Instagram, Apify, RapidAPI, self-hosted transport, analysis route, preflight route를 호출하지 않는다.
- 짧은 shared cache를 사용할 수 있으나 fixture version을 응답에 포함한다. cache 실패나 stale response는 제품 흐름에 영향을 주지 않는다.

`DEMO_ANALYSIS_ENABLED`는 기존 demo run 자격의 server-only 의미를 유지한다. 이 preview rollout flag와 합치거나 browser로 직렬화하지 않는다.

### 컴포넌트 경계

| 경계 | 책임 | 하지 않는 일 |
| --- | --- | --- |
| `components/precheckout-demo-preview.tsx` | 실제 target card, 합성 장면 상태, 6초 연출, skip/anchor, reduced motion, expand, client response 검증, one-shot demo analytics | plan 선택, checkout, 로그인, preflight 갱신, fixture 전체 보관 |
| `lib/services/demo-analysis/precheckout-preview.ts` | published fixture에서 작고 검증 가능한 DTO projection 및 schema | DB 조회, React state, target 결합, analytics 전송 |
| `app/api/demo-analysis/precheckout-preview/route.ts` | server-only fixture loader와 projection을 연결하고 최소 DTO 반환 | 사용자별 결과 생성, scraper/AI 호출, target 입력 수신 |
| `app/analyze/page.tsx` | 기존 ready/exclusion gate에서 component를 배치하고 `#plan-selection`을 부여 | preview 안에서 플랜/결제 상태를 재구현 |

이 구분은 현재 client page를 server/client wrapper로 대규모 분해하지 않기 위한 것이다. 기존 `case-ui` primitive와 result risk 표현을 사용하되, 공통 fixture·checkout·preflight 모듈의 책임은 넓히지 않는다.

## Session Replay와 개인정보 경계

`/analyze`는 이미 replay 허용 route이므로 새 블록은 명시적 DOM 경계가 필요하다.

1. `PrecheckoutDemoPreview` root에는 `data-precheckout-replay-scope`를 둔다. 이 scope는 `SESSION_REPLAY_PRIVACY_CONFIG.maskSelector`에 추가한다.
2. 실제 target card 전체에는 중복 방어로 `data-amp-mask`를 둔다. handle, full name, bio, avatar, followers/following 수, alt text가 모두 replay에서 마스킹 대상이다.
3. 합성 fixture 콘텐츠만 `data-precheckout-demo-allow`를 둔다. 이 selector만 `unmaskSelector`에 추가해 scope의 자식 중 합성 후보·합성 avatar·합성 narrative·합성 라벨만 readable replay 콘텐츠로 허용한다. 이 marker는 `precheckout-demo-preview.tsx` 밖에서 사용하지 않으며, contract test가 그 exclusivity를 검증한다.
4. skip, CTA, target 변경, 플랜 카드, error, 로그인·결제 영역을 새 allowlist에 넣지 않는다. 기존 route-level allowlist와 `data-amp-mask`/`data-amp-block` 계약도 넓히지 않는다.
5. Replay 및 explicit analytics 어디에도 target username, full name, bio, image URL, count, candidate handles, candidate text, score, fixture raw payload를 property로 보내지 않는다.

이 설계는 UI 브라우저에는 실제 target card를 보여주되 Session Replay에는 보이지 않게 한다. replay 마스킹은 네트워크 접근 제어가 아니므로, endpoint DTO 자체에서 target과 raw fixture를 제외하는 경계를 함께 유지한다.

## Analytics

기존 `plan_viewed`는 현재의 `app/analyze/page.tsx` effect와 `planViewEventKey`를 그대로 쓴다. preview가 성공·실패·skip되더라도 플랜 카드가 보이면 기존 조건에 따라 계속 발화하며, 이 기능이 plan viewed를 지연하거나 중복시키지 않는다.

`EVENTS`에 다음 두 event를 추가한다.

| 이벤트 | 정확한 발화 시점 | 한 preflight당 최대 | 허용 property |
| --- | --- | --- | --- |
| `demo_result_viewed` | 유효한 합성 DTO의 최종 정적 결과가 화면에서 50% 이상 보이는 첫 시점 | 1 | `preflight_id`, `fixture_version` |
| `demo_result_expanded` | 사용자가 `예시 결과 자세히 보기`를 열어 상세 영역이 보이는 첫 시점 | 1 | `preflight_id`, `fixture_version` |

각 event는 `tryClaimAnalyticsEvent(availableAnalyticsStorage(), key)`와 local ref를 함께 사용한다. key는 각각 `amplitude:demo_result_viewed:<preflightId>`와 `amplitude:demo_result_expanded:<preflightId>`다. storage를 사용할 수 없으면 in-memory ref가 같은 mounted component 안의 중복을 막고, analytics 실패는 UI·anchor·checkout 흐름에 영향을 주지 않는다.

`fixture_version`은 현재 `DEMO_FIXTURE_VERSION`과 정확히 같은 제한된 문자열만 허용하는 새 property validator다. event property에는 target 식별자, 이름, 바이오, 이미지, real count, demo 후보 이름·핸들·텍스트·등급·점수, source URL, claim token, order ID, user ID를 넣지 않는다. skip, 자동 장면 전환, CTA anchor, collapse에는 별도 event를 만들지 않는다.

## 접근성 및 모션

- preview는 `section`과 연결된 heading을 사용한다. 현재 장면 제목만 `aria-live="polite"`로 짧게 알리고, 실제 분석 진행률처럼 읽히는 `progressbar`는 만들지 않는다.
- `prefers-reduced-motion: reduce`에서는 timer, graph pulse, opacity/transform transition을 전부 건너뛴다. 유효 DTO가 도착하면 세 장면을 완료된 정적 case-file로 즉시 렌더하고, expand와 anchor는 동일하게 제공한다.
- motion preference가 재생 도중 reduce로 바뀌면 남은 timer를 취소하고 즉시 정적 최종 상태로 전환한다.
- `가격 바로 보기`, `예시 결과 자세히 보기`, `플랜 선택하고 실제 판독 시작`은 keyboard focus가 가능하고 항상 visible focus style을 가진다. focus trap, 자동 focus, pointer-only gesture를 쓰지 않는다.
- 고위험/주의 구분은 색만으로 전달하지 않는다. `RiskTag`의 한국어 텍스트를 함께 보이고, 의미 있는 텍스트에는 `text-fg-dim` 이상 대비를 쓴다.
- target avatar의 alt는 사용자 화면에는 실제 handle을 설명할 수 있지만 replay scope에서 마스킹된다. 합성 avatar는 반복 낭독을 피하도록 decorative alt를 사용하고, 후보의 합성 이름·핸들은 텍스트로 읽힌다.
- detail은 button으로 열고 닫으며, 동일한 두 합성 후보만 유지한다. 자동으로 detail을 열거나 화면을 이동시키지 않는다.

## 실패 및 성능 계약

### fail-open

다음 경우 `PrecheckoutDemoPreview`는 실제 target card만 남기거나 예시 부분만 즉시 접고, `#plan-selection`과 기존 checkout UI를 지연 없이 노출한다.

- rollout flag off 또는 endpoint `204`
- fixture DB load 실패, published row 부재, projection `null`, client schema parse 실패
- endpoint fetch 오류, timeout, abort, 비정상 HTTP 응답
- 예시 local asset load 실패
- target reset, stale pricing refresh, consumed preflight, auto checkout transition

사용자에게 fixture 내부 오류를 보여주거나 새 재시도 CTA를 만들지 않는다. 실패 로그는 target·preflight·fixture payload를 포함하지 않는 aggregate error code만 허용하며, preview 실패가 preflight 상태·plan eligibility·login·checkout을 변경해서는 안 된다.

### 성능

- endpoint fetch는 ready preflight 이후 component 안에서 비차단으로 시작하고, 계획 섹션을 suspense하거나 disabled하지 않는다.
- client는 `AbortController`와 1,500ms deadline을 사용한다. 한 mount에 한 번만 시도하고 자동 retry·polling·backoff를 하지 않는다.
- response는 2 candidates와 2 report lines만 보내며, 8KB 미만의 JSON 계약을 유지한다. fixture 전체 84/145 목록, raw payload, 이미지 binary를 전송하지 않는다.
- 합성 avatar는 기존 local `/demo-avatars/*`만 사용한다. 외부 image host, preloading 된 Instagram image, new font, third-party script를 추가하지 않는다.
- layout은 target card 뒤에 compact preview rail을 먼저 확보해 응답 도착 시 플랜 radio가 클릭 중에 크게 밀리지 않게 한다. preview fetch가 실패하면 rail을 제거하고 plan section을 즉시 정상 문서 흐름으로 돌린다.
- timer는 unmount·skip·reduced motion 전환에서 모두 clear한다. 시연은 preflight와 독립된 UI timer이므로 작업 queue, provider cost, browser leave에 영향을 주지 않는다.

## 시각 언어

기존 dark dossier/case UI를 그대로 쓴다.

- 실제 target reveal은 구획의 유일한 Tier 2 `CaseCard`와 blood bracket을 사용한다.
- 합성 장면은 Tier 0 information rails를 기본으로 하고, 최종 리포트 일부에만 작은 `Panel`을 쓴다. 예시 카드마다 `CaseCard` bracket을 반복하지 않는다.
- `RiskTag`와 `GradeRail`의 기존 위험 위계를 재사용하되, 점수형 `ThreatBar`와 score 숫자는 preview에 렌더하지 않는다.
- 크림슨은 실제 target의 긍정적 확인이나 CTA 장식이 아니라 brand/고위험 예시 강조에만 제한한다. 합성 high/caution labels는 기존 blood/amber 의미를 유지한다.
- `예시 결과 · 합성 데이터` 배지는 대상 카드 바로 뒤와 최종 summary에 모두 보이게 하여, 장면 전환 중에도 실제 데이터와 혼동되지 않게 한다.

## 예상 변경 파일

| 파일 | 변경 | 책임 |
| --- | --- | --- |
| `components/precheckout-demo-preview.tsx` | 생성 | target reveal, 합성 시연, skip, expand, reduced motion, local analytics trigger, replay DOM markers |
| `lib/services/demo-analysis/precheckout-preview.ts` | 생성 | small DTO schema와 fixture pure projection |
| `lib/services/demo-analysis/precheckout-preview.test.ts` | 생성 | DTO selection, no-target/no-score boundary, invalid fixture fail-open unit coverage |
| `app/api/demo-analysis/precheckout-preview/route.ts` | 생성 | server-only published fixture read와 minimal response |
| `app/api/demo-analysis/precheckout-preview/route.test.ts` | 생성 | published/disabled/unavailable response contract |
| `app/analyze/page.tsx` | 수정 | existing target card를 component에 좁게 위임, ready gate 배치, `#plan-selection` anchor; checkout/login/preflight code는 유지 |
| `.env.example` | 수정 | browser에 노출하지 않는 `PRECHECKOUT_DEMO_PREVIEW_ENABLED` rollout flag 문서화 |
| `lib/services/analytics.ts` | 수정 | event/property allowlist와 replay scope/allow selectors |
| `lib/services/analytics-funnel.ts` 또는 `lib/services/earlybird/analytics-state.ts` | 수정 | demo event key helper를 기존 session dedupe pattern으로 추가 |
| `lib/services/analytics*.test.ts` | 수정/추가 | property allowlist, one-shot semantics, replay selector contract |
| `components/precheckout-demo-preview.test.tsx` | 생성 | phase timing, skip, CTA, expand, reduced motion, fetch failure UI contract |

`app/page.tsx`, plan catalog, preflight service, checkout route, login modal, scraping providers, Supabase migrations는 이 변경의 대상이 아니다.

## 구현 acceptance criteria

### 화면과 흐름

1. ready preflight와 exclusion 결정이 있는 정상 경로에서 실제 target card가 한 번만 보이고, 실제 profile/count가 현재 preflight DTO와 일치한다.
2. 유효 fixture가 있을 때 target card 뒤에는 `예시 결과 · 합성 데이터`라는 visible text가 있고, 세 합성 장면은 위의 순서·6초 일정으로 보인다. fixture가 없으면 예시 영역 없이 계획 섹션을 보인다.
3. 합성 후보는 정확히 두 명이고 local demo avatar를 쓴다. target 이미지·텍스트·count 또는 실제 관계 목록은 합성 장면에 없다.
4. target 또는 preview 어디에도 target score, 위험도, 발견 수, 판독 완료 claim이 없다. preview의 score 숫자도 없다.
5. `가격 바로 보기`는 첫 0ms부터 keyboard와 pointer로 작동하고, 네트워크 지연·timer와 관계없이 plan heading으로 이동한다.
6. final CTA는 정확히 `플랜 선택하고 실제 판독 시작`이며, 클릭은 existing `#plan-selection`로만 이동한다. plan을 선택하거나 checkout/login을 시작하지 않는다.
7. plan radio 선택, 기존 plan CTA, login-on-purchase, post-login auto checkout, plan pricing refresh, entitlement consumption은 regression 없이 현행처럼 작동한다.

### 데이터·privacy·network

1. projection test는 rank 1·2 후보와 rank 1 narrative만 받고, `displayScore`, summary, private list, raw payload, target fields를 DTO에서 제외함을 검증한다.
2. endpoint test는 request target/query/body가 없어도 동일한 synthetic-only response를 반환하고, 유효하지 않거나 unavailable하면 `204`를 반환함을 검증한다.
3. browser network 검증에서 preview가 Instagram provider, scraper transport, `/api/analysis/preflight`, `/api/analysis/start`, checkout endpoint를 새로 호출하지 않음을 확인한다.
4. Session Replay 검증에서 target handle/name/bio/avatar/count은 마스킹되고, 새 allow selector의 합성 demo content만 readable임을 확인한다.
5. explicit event payload 검사에서 두 demo event는 정해진 두 property만 가지며, 금지된 식별자와 fixture contents가 없음을 확인한다.

### motion·failure·analytics

1. fake timer test는 0ms, 1,800ms, 3,700ms, 6,000ms의 장면 전환과 unmount/skip timer cleanup을 검증한다.
2. `prefers-reduced-motion` initial과 runtime change test는 즉시 정적 결과를 보이고 animation/timer를 만들지 않음을 검증한다.
3. endpoint 204, invalid JSON, timeout, abort, image failure test는 error rail 없이 plan section이 계속 렌더되는 fail-open 동작을 검증한다.
4. `demo_result_viewed`는 final static preview가 50% intersection을 처음 만족할 때만, `demo_result_expanded`는 detail 첫 open 때만 각각 preflight당 1회 전송된다. rerender, collapse/reopen, plan 선택은 중복을 만들지 않는다.
5. existing `plan_viewed`는 preview를 skip하거나 fixture가 없을 때도 현재와 같은 key·property·시점으로 한 번씩 남는다.

## rollout 및 검증 순서

1. pure projection, endpoint, analytics/replay contracts, component timing tests를 먼저 통과시킨다.
2. local에서 정상 ready preflight, reduced-motion, keyboard-only, fixture unavailable, 1.5초 timeout을 점검한다. 어느 경우에도 실제 checkout이 실행되거나 preflight가 새로 만들어지지 않아야 한다.
3. Vercel Preview에서 server-only preview flag를 켜고, 합성 fixture만 반환되는 endpoint payload와 browser network를 확인한다. existing plan selection과 로그인 handoff는 로그인 화면 직전까지 회귀 검증한다.
4. Preview Replay에서 real target card가 마스킹되고 합성 demo block만 허용되는지, explicit Amplitude debugger에서 두 event의 property allowlist와 one-shot key가 맞는지 확인한다.
5. Production은 flag off 배포 후 좁은 enable로 시작한다. 전환 평가는 `demo_result_viewed → plan_selected`와 기존 `plan_viewed → plan_selected`를 비교하되, 예시 후보·target·점수를 segment로 사용하지 않는다.
6. 문제 발생 시 flag를 끄면 endpoint가 `204`를 돌려 preview만 사라지고 기존 target confirmation·plan·login·checkout은 계속 동작한다. rollback에 migration, payment 상태 변경, preflight 재실행은 필요 없다.

## 설계 자체 점검

- 미정 표기나 빈 구현 지시 없이, 선택한 화면 위치·타이밍·DTO·event property·failure response를 구체화했다.
- 실제 target과 합성 fixture의 데이터 흐름이 만나지 않도록 component prop, projection, endpoint, replay, analytics 경계를 분리했다.
- 6초 시연은 예시 presentation만 다루며 실제 preflight/checkout/login/analysis 의미를 바꾸지 않는다.
- 범위는 `/analyze`의 한 인라인 component와 최소 read-only endpoint·analytics/privacy 계약으로 제한했고, 랜딩 카피와 생산 파이프라인에는 변경을 요구하지 않는다.
