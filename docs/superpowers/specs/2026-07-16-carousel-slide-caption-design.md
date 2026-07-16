# 캐러셀 슬라이드별 캡션 수집·분석 설계

## 목표

인스타그램 캐러셀의 슬라이드별 캡션을 기존 프로필 수집 결과에서 손실 없이
보존한다. 선택된 이미지와 캡션의 대응 관계를 Gemini에 전달하고, 최신 캐러셀의
나머지 슬라이드 캡션도 TOP10 파트너 안전성 판정과 최대 3명의 고위험 총평에
반영한다.

## 비목표

- 캡션을 얻기 위한 별도 자체 크롤러 요청을 추가하지 않는다.
- Apify Actor 실행, dataset item, Gemini generation 호출, DAG stage를 추가하지 않는다.
- 모든 여성 후보의 `featureAnalysis`에 최대 20개 원문을 무제한으로 넣지 않는다.
- 매우 긴 캡션의 모든 문자를 Gemini에 보내는 것을 보장하지 않는다.

## 제공자 정책

기존 제공자 선택을 그대로 유지한다.

1. 로그인 없는 자체 `web_profile_info` 요청을 우선 시도한다.
2. 실패한 username만 `apify/instagram-profile-scraper`로 fallback한다.
3. 어느 제공자가 선택되었든 이미 받은 carousel child payload의 캡션을 파싱한다.
4. Apify 응답의 `childPosts.caption`을 읽는 것은 같은 프로필 dataset item의 필드를
   사용하는 것이므로 추가 Actor 실행이나 item 과금을 만들지 않는다.

## 데이터 모델

`InstagramPostMediaItem`과 V2 profile checkpoint child schema에 선택 필드 `caption`(최대
2,200자)을 추가한다. 자식 순서, child ID, media type, URL과 캡션을 함께 보존한다.

자식 캡션에서 확실하게 파싱된 `@username`은 부모 post의 `mentionedUsers`에 중복 없이
합친다. 기존 `hasCandidateTargetMention` 점수 로직이 추가 AI 호출 없이 슬라이드별 언급을
반영할 수 있게 한다.

Supabase의 `analysis_v2_valid_profile_snapshot` 함수는 child object에 `caption`을 허용하고
문자열 타입과 2,200자 상한을 검증하도록 새 migration으로 교체한다. 함수 권한은
기존과 동일하게 유지한다.

## 캡션 선택 정책

### 선택된 3장

최신 완전 캐러셀의 첫 장, 중간 장, 마지막 장은 기존 media policy대로 `featureAnalysis`에
들어간다. 각 선택 이미지에 child caption이 있으면 그 캡션을 연결하고, 없으면 부모
post caption을 한 번만 fallback으로 연결한다. 같은 게시물 캡션을 세 번 복제해
`evidenceRefId`가 충돌하는 현재 E2E 장애를 함께 제거한다.

### 나머지 최대 17장

기존 `partnerSafetyContactSheetCandidates`에 선택된 슬라이드만 대상으로 한다. TOP10에
대해 기존 `partnerSafety` 호출의 contact-sheet cell 번호와 슬라이드 캡션을 같은 순서로
전달한다. 모델은 캡션만으로 관계를 단정할 수 없고, 반드시 contact-sheet에서
시각 근거가 있는 cell을 인용해야 한다.

### 고위험 총평

최종 고위험 최대 3명의 기존 `highRiskNarrative` 호출에 최신 캐러셀 슬라이드
캡션 dossier를 추가한다. dossier 전체에 하나의 content-addressed evidence ref를 부여하고,
첫 줄의 계정 스타일·페르소나 근거로만 사용한다. 캡션을 교제나 외도의 단정
근거로 사용하지 않는다.

## 고정 예산

캡션 dossier의 표시 문자 합계는 계정당 2,000자를 넘지 않는다.

- 빈 캡션은 제거한다.
- Unicode NFKC 정규화 후 공백을 축소한다.
- 완전히 같은 문구는 첫 슬라이드만 유지한다.
- 전체가 2,000자 이하면 원문을 모두 유지한다.
- 초과하면 모든 비어 슬라이드에 기본 분량을 공평하게 할당한 뒤, 대상 계정
  정확 언급을 포함한 슬라이드와 최근 슬라이드에 남은 예산을 배분한다.
- 원문은 profile staging에 보존되고 terminal cleanup 시 기존과 같이 삭제된다.

추가 Gemini generation 호출은 없지만 더 많은 입력 토큰을 보내면 실제 비용이 문자 그대로
0 증가한다고 보장할 수는 없다. 출시 정책은 호출 수와 프롬프트 상한을 늘리지 않고,
E2E에서 전체 비용과 p95 완료 시간의 비회귀를 확인하는 것이다.

## 병렬성과 내구성

캡션 파싱·정규화·압축은 profile fetch 결과를 소비하는 기존 작업 내에서 CPU로
수행한다. 새 network 의존성을 만들지 않는다. TOP10 `partnerSafety`는 기존 concurrency 5,
고위험 `narrative`는 기존 concurrency 3을 그대로 사용한다. 브라우저 이탈 여부와 관계없이
서버 DAG가 계속 실행되는 기존 내구성 모델도 변경하지 않는다.

## 완료 기준

- 자체 및 Apify mapper 모두 child caption을 순서대로 보존한다.
- Supabase checkpoint가 적합한 child caption을 수락하고 2,200자 초과와 알 수 없는 key를
  거부한다.
- 선택된 서로 다른 슬라이드 캡션은 서로 다른 feature evidence로 들어간다.
- 단일 부모 캡션은 이미지 3장에 중복 복제되지 않는다.
- dossier는 2,000자 상한, 슬라이드 순서, 중복 제거, 공평 발췌을 재현 가능하게
  유지한다.
- provider run, dataset item, Gemini attempt, DAG job 수가 변경되지 않는다.
- 대상 테스트, TypeScript, ESLint, migration contract, E2E 비용·시간 검증을 통과한다.
