# Vertex 연결·사용량 1차 확인 예산 — 승인용

작성일: 2026-10-09, Asia/Seoul. 한국어 원본이며 아직 유료 AI 호출을 실행하지 않았다.

## 승인 요청

**전체 실행 상한 US$1, 생성 호출 총 2회**로 실제 Vertex 인증·응답·token usage를 확인한다. 개인정보 없는 고정 합성 텍스트만 사용한다. Apify·Instagram·DB·기존 replay·사용자 계정 분석·결제·운영 rollout 변경은 포함하지 않는다. 새 Dev UI 환경과도 별도 작업이다.

| 모델 | 호출 상한 | thinking | 입력 상한 | 요청 출력 상한 |
| --- | ---: | --- | ---: | ---: |
| `gemini-3.1-flash-lite` | 1 | MINIMAL | 4,096 tokens | 2,048 tokens |
| `gemini-3.7-flash` | 1 | LOW | 4,096 tokens | 2,048 tokens |

두 호출은 global/Standard 경로로만 수행한다. 각 요청은 단일 turn·TEXT 응답·`candidateCount=1`로 고정한다. 후보 응답을 여러 개 생성하거나 grounding·media·batch/priority·tuning·tool call을 사용하지 않는다. 자동/SDK/application retry는 0회다. 남은 예산으로 호출을 늘리지 않는다.

## 금액 근거와 한도

10월 9일 [Google 공식 가격표](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)는 Flash-Lite global text 입력/출력 100만 token당 $0.25/$1.50, 3.7 Flash는 2026년 말까지 $0.75/$3.75를 표시한다. 출력에는 response와 reasoning이 포함된다. credits/할인 정산에 의존하지 않도록 3.7에 더 높은 $1.50/$7.50을 적용해 예약한다.

`MINIMAL`/`LOW`는 수치 한도가 아니다. 요청 출력 cap만을 thinking 포함 완전한 과금 상한으로 가정하지 않고, 각 모델의 [최대 출력 65,536](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-lite) [token 한도](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-7-flash)를 보수 예약에 사용한다. 입력 4,096과 출력 65,536을 각 1회, 위 상단 단가로 계산한 합계는 **$0.596992**다. US$1 안에 여유가 있다. 이 계산은 token 기반 보수 한도이며 invoice 실액 관측과 별개다.

실행 전에 공식 모델 ceiling·endpoint의 thinking 포함 한도와 가격을 다시 확인한다. ceiling 계약을 확인할 수 없거나 모델/가격이 달라지면 호출하지 않고 재산정한다. 입력은 `/4` 휴리스틱에 의존하지 않으며 고정 ASCII 입력의 전체 크기·요청 token 조건을 검증한다. 비용 예약을 먼저 확보한 뒤 최대 2회만 dispatch한다. 실패·timeout·usage 누락도 예약을 소비한 것으로 취급하고 자동 재실행하지 않는다.

## 실행 준비와 기록

앱의 AI wrapper는 ambient DB budget/logging과 retry가 있으므로 그대로 호출하지 않는다. 분리된 작은 probe를 준비해 직접 provider 요청 수와 budget을 고정한다. 설치된 SDK의 숨은 retry가 없는지 확인하거나 retry 없는 고정 REST 전송을 사용한다. credential·Authorization header·raw 응답·thought signature·오류 본문은 출력/기록하지 않는다.

승인된 project identity와 고정 모델, 호출수·응답 status/완료 이유·모델 버전의 허용된 값·token usage 존재/합계·가격 provenance·estimate만 safe receipt에 남긴다. 모델명/metadata도 expected enum·bounded 문자열을 검증한다. credential 또는 project 일치가 확인되지 않으면 시작하지 않는다.

수용 기준은 두 모델의 실제 연결/usage 경계 확인과 전체 budget·무재시도·무Apify 준수다. 실패한 모델은 안전한 오류 분류만 보고하고 별도 승인이 없는 추가 호출을 하지 않는다. 실제 연결 성공을 사용자 계정 분석 성공이나 high-risk recall PASS로 해석하지 않는다.

## 실제 품질·비용 평가의 별도 blocker

현재 확보한 W04 근거에는 v2.12 정책이 연결된 표본과 최신 비용 provenance 자격 표본이 없다. 독립 high-risk label·동일 cohort baseline/proposed 예측도 없다. 기존 replay lineage는 v2.11까지이며 보존 원본에 dry-run을 실행하면 artifact를 정리할 수 있어 사용하지 않는다.

실제 품질 평가는 승인된 합성 연결 probe와 다르다. 독립 label·같은 cohort·자료/정책 provenance·stage별 호출 상한을 확보해야 별도 예산을 계산할 수 있다. 기존 cost gate의 동일 token volume 재가격 모델과 서로 다른 응답 길이의 실측 비교도 구분한다. 이 US$1 승인에 일반 production 승격이나 품질 cohort 수집/평가를 포함하지 않는다.

코드 조사에서 3.7 escalation에 MINIMAL이 유지되는 경로가 발견됐다. [현재 공식 thinking 계약](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking)의 3.7 지원 수준과 caller를 대조해 별도 최소 수정 여부를 검토한다. 이 probe는 3.7 LOW로 고정하며 production 정책을 변경하지 않는다.
