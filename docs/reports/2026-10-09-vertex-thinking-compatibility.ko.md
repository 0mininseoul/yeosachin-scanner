# Vertex 3.7 thinking 계약 최소 수정

공유 route 선택기에서 `genderTriage`·`privateAccountName`의 두 escalation 이유가 모두 `gemini-3.7-flash + MINIMAL`을 만들었다. provider 없는 순수 함수 재현으로 4조합을 확인했다. [Google 공식 3.7 가이드](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-7-flash)는 `LOW/MEDIUM/HIGH`만 지원하고 `MINIMAL`을 명시하면 API validation 오류라고 안내한다.

현재 자동 production escalation caller는 `featureAnalysis`·`highRiskNarrative`이며 둘 다 이미 LOW다. 따라서 이번 finding은 공유 API의 확정된 계약 결함이고, 운영에서 이 결함으로 실제 실패한 분석이 관측됐다는 기록은 아니다.

## 변경

- 선택기는 escalation의 기본 MINIMAL만 LOW로 결정한다. 기본 Flash-Lite MINIMAL과 그 밖의 stage 정책은 유지한다. 결과/cache identity와 generation 옵션은 같은 선택 값을 사용한다.
- Gemini 경계는 확정된 모델·thinking이 3.7 계열(지원 matcher의 revision/resource alias 포함) + MINIMAL이면 `VERTEX_AI_THINKING_LEVEL_UNSUPPORTED`로 거절한다. credential·기본 예산 가드·예산 예약·attempt audit·SDK 호출 전에 판정한다. SDK 직전 silent normalization은 하지 않는다.
- production 코드 2개 파일의 8줄과 해당 기존 검사 3개 파일을 변경했다. 외부 provider·DB·정책 rollout·실제 계정 분석은 실행하지 않았다.

## 검증·독립 리뷰

구현자는 기존 행동 검사 RED 11개 실패에서 GREEN으로 수정했고, 직접·관련 mock 검사 총 374개 PASS를 확인했다. 타입체크·대상 ESLint·diff 공백 검사도 PASS다.

구현자와 다른 `vertex_compat_spec_review`는 명세 준수 PASS 및 관련 mock 3파일 271개 독립 재실행 PASS를 보고했다. 그 이후 별도 `vertex_compat_quality_review`가 alias·조기 거절 순서·identity·기본값/legacy env 경계를 확인해 품질 PASS를 보고했다. 실제 Vertex·Apify 호출과 자격 조회는 0회다.

PR의 exact-head CI·배포 후보 검증과 main 병합/동기화는 해당 GitHub 기록으로 관리한다. 새 Dev UI 환경에 후보를 포함할 때 commit provenance를 연결한다. 이 수정은 실제 모델 연결 성공·high-risk recall·비용 절감 승격을 증명하지 않는다. 별도 US$1 연결 probe는 예산 승인과 thinking 포함 과금 ceiling 확인 전에는 실행하지 않는다.
