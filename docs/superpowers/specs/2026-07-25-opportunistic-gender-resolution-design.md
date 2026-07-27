# Opportunistic Gender Resolution Design

**상태:** 구현 승인 완료
**승인 기준:** 옵션 3(기회주의적 병렬 고급 재판정)를 채택하고, resolver 때문에
전체 분석 완료 시간이 지연되지 않도록 한다.
**기준 소스:** `origin/main`의 `38b1d2b`
**범위:** Analysis V2 백엔드, Gemini 실행·감사 원장, 후보 판정 체크포인트,
결과 요약 계약, 운영 지표, Standard E2E rollout gate의 계약과 자동 검증
**비범위:** 프론트엔드 레이아웃, 결과 수치를 맞추기 위한 사후 재분류,
Apify 요금제 전환, 이번 구현 중 유료 E2E 실행, 프로덕션 배포, Groble 변경

## 1. 결정 요약

권장안은 **기회주의적 병렬 고급 성별 재판정기**다.

- 기존 `featureAnalysis`는 그대로 유지한다.
- triage가 확실한 동일 인물 남성인 경우에는 지금처럼 즉시 남성으로 확정하고
  추가 호출을 하지 않는다.
- triage가 확실한 동일 인물 여성인 경우에는 기존 `featureAnalysis`만 실행한다.
- 그 밖의 불확실한 triage 결과에는 `featureAnalysis`와 별도
  `genderResolution`을 같은 시점에 시작한다.
- `genderResolution`은 `gemini-3-flash-preview`, thinking `LOW`, media
  resolution `MEDIUM`, 프로필 1장과 피드 최대 4장을 사용한다.
- `featureAnalysis`가 끝나는 순간 cutoff를 고정한다. 그 시점에 이미 감사 원장까지
  완료된 resolver 결과만 사용하며 resolver 모델을 추가로 기다리지 않는다.
- resolver는 기존 feature 판정이 `unresolved` 또는
  `unresolved_stage_conflict`일 때만 빈 판정을 보완한다. 이미 검증된 여성·남성
  판정을 덮어쓰지 않는다.
- resolver는 프로세스 안에서 최대 2개, 배포 전체에서 최대 2개만 실행한다.
  모든 Gemini 호출의 배포 전체 공유 상한은 기존 8개를 유지한다.
- resolver 슬롯을 기다리지 않는다. 즉시 확보하지 못하면 내부적으로
  `capacity_skipped`를 기록하고 기존 feature 결과를 사용한다.
- 일부 이미지 실패는 선택 이미지의 20% 이하이고 성공 이미지가 1장 이상이면
  허용한다. 검증 판정의 최소 근거 요건은 완화하지 않는다.
- 외부 결과는 남성·여성·미상만 제공한다. 실패 원인과 resolver 상태는
  서비스 전용 지표에만 남긴다.
- 관측된 미상 비율 20% 이하는 모니터링·배포 승인 기준일 뿐이며, 강제 분류나 결과 생성 규칙이 아니다.
  기준을 넘으면 롤아웃을 중단하고 원인을 고치며, 숫자를 맞추기 위해 결과를
  강제로 바꾸지 않는다.

## 2. 문제와 저장소 근거

### 2.1 미상이 늘어나는 현재 판정 경계

`lib/services/ai/v2-staged-analysis.ts`의 현재 최종 판정은 feature 결과가
`genderConfidence = high`이고 `ownerConsistency = same_person`인 경우에만
남성 또는 여성으로 검증한다. triage의 고신뢰 이진 판정과 feature가 다르면
`unresolved_stage_conflict`가 된다. 고신뢰 판정은 서로 다른 이미지 근거가
2개 이상이어야 한다.

이 보수성은 잘못된 여성 확정을 막지만, 모델이 중간 신뢰도로 충분히 일치하는
경우까지 모두 미상으로 남긴다. 최근 완료 결과에서 공개 계정 미상 비율이 20%를
넘어 개선이 필요하다는 관측이 있었지만, 한 건의 결과만으로 모델 정확도 전체를
단정할 수는 없다.

### 2.2 이미지 처리의 all-or-nothing 문제

`lib/services/analysis/v2-ai-scoring-executors.ts`는 현재 다음 두 경우 모두
계정 전체를 `media_unavailable`로 종료한다.

1. triage 선택 이미지 중 하나라도 정규화에 실패한 경우
2. feature용 나머지 이미지 중 하나라도 정규화에 실패한 경우

따라서 충분한 성공 이미지가 있어도 CDN 만료나 개별 디코딩 실패 한 건 때문에
성별 모델을 전혀 실행하지 않는다. 이는 모델 성능과 별개로 미상을 증가시키는
직접적인 병목이다.

### 2.3 동시 실행을 막는 lease 식별자

`analysis_v2_gemini_leases`는 배포 전체 Gemini 동시 실행을 8개 슬롯으로
제어하지만, 현재 lease 소유자를 `(request_id, job_key, attempt)`로 찾는다.
같은 profile AI 잡에서 `featureAnalysis`와 `genderResolution`이 둘 다 첫 번째
시도라면 이 세 값이 동일하다. operation을 식별자에 넣지 않고 병렬화하면 한
호출이 다른 호출의 lease를 충돌 또는 격리 상태로 만들 수 있다.

또한 현재 lease 풀은 stage를 구분하지 않는다. 프로세스 내부 semaphore만
resolver 2개로 제한해도 Cloud Run 인스턴스가 여러 개면 배포 전체 resolver
상한 2개를 보장하지 못한다.

### 2.4 단일 정책 버전 검사

현재 `AI_STAGE_POLICY_VERSION`은 `ai-stage-policy-v2.6` 한 값이고,
`v2-worker.ts`와 `v2-ai-stage-runtime.ts`는 요청에 저장된 값이 실행 중인
상수와 정확히 같아야 한다고 검사한다. 상수를 단순히 v2.7로 교체하면 이미 생성된
v2.6 요청과 재시도 요청이 영구 실패한다.

정책 버전은 요청 생성 시 고정되고 재시도·재생에서도 바뀌지 않아야 한다.
v2.6과 v2.7을 동시에 읽고 실행할 수 있는 registry가 먼저 필요하다.

### 2.5 외부 계약에 노출되는 실패 집계

`lib/contracts/analysis-v2.ts`의 현재 owner 결과에는 다음 필드가 있다.

- `successfullyScreenedMutuals`
- `fetchUnavailableMutuals`
- `mediaUnavailableMutuals`
- `analysisUnavailableMutuals`

이 값들은 판독 실패를 사용자에게 직접 또는 계산 가능한 형태로 노출한다.
내부 운영과 품질 분석에는 필요하지만 외부 결과 계약에는 없어야 한다.

### 2.6 abort와 비용 원장의 불확실성

현재 Gemini SDK는 client abort signal을 받을 수 있지만, client 요청 취소가
provider의 생성과 과금을 중단했다는 보장은 없다. abort된 호출은 성공적인
usage metadata를 받지 못할 수 있고, 현재 원장 정책에서는 이런 호출을 재시도하지
않는 모호한 종결로 다룬다.

따라서 cutoff 후 abort는 지연 감소 힌트일 뿐 비용 취소 수단으로 간주하면 안 된다.
늦은 결과를 적용하지 않는 fence, 원장 종결, lease 격리·회수 정책이 함께 있어야
한다.

## 3. 검토한 선택지

### 대안 A: `featureAnalysis` 전체를 Gemini 3 Flash로 승격

모든 feature 분석을 `gemini-3-flash-preview`로 바꾸고 기존 최종 판정 로직을
유지한다.

장점:

- stage와 결과 조정 로직이 가장 단순하다.
- 모든 feature 필드가 같은 고급 모델의 이점을 받을 수 있다.

단점:

- triage를 통과한 대부분의 계정에서 비용이 증가한다.
- feature가 필수 직렬 경로이므로 전체 분석 시간에 고급 모델 지연이 그대로 더해진다.
- 성별 문제를 해결하기 위해 위험 점수·계정 설명 등 이미 동작하는 출력까지 한 번에
  바꾼다.
- 모델 변경과 정책 변경이 결합되어 회귀 원인을 분리하기 어렵다.

결론: 비용과 주 경로 지연이 커서 채택하지 않는다.

### 대안 B: feature 종료 후 미상만 직렬 재판정

feature 결과가 미상 또는 충돌일 때만 고급 모델을 호출한다.

장점:

- 실제 최종 미상 후보에만 비용을 쓴다.
- 불필요한 speculative 호출이 없다.
- resolver 결과를 기다리므로 사용률은 높다.

단점:

- 미상 계정마다 고급 모델 시간이 직렬로 추가된다.
- 배치에 미상이 많을수록 Standard 전체 완료 시간이 크게 늘어난다.
- 사용자가 승인한 “재판정을 병렬로 진행하여 총시간의 지연 요인이 되지 않게 한다”는
  방향과 맞지 않는다.

결론: 비용 효율은 좋지만 핵심 지연 조건을 위반하므로 채택하지 않는다.

### 대안 C: 기존 Flash-Lite의 신뢰도 임계값만 완화

추가 모델 없이 feature의 `medium` 판정을 더 많이 수용하거나 최소 근거 수를 줄인다.

장점:

- 추가 호출 비용과 동시 실행 복잡성이 없다.
- 총 분석 시간이 거의 변하지 않는다.

단점:

- 같은 모델의 같은 관측을 더 낮은 기준으로 받아들이므로 독립적인 재확인이 아니다.
- 여성 오탐이 늘어도 원인을 분리하기 어렵다.
- 근거 이미지 최소 수까지 낮추면 프로필 한 장의 우연한 인물로 잘못 판정할 가능성이
  커진다.
- 미상 비율 목표를 맞추기 위한 임계값 조작으로 흐르기 쉽다.

결론: 보조적인 장기 실험은 가능하지만 단독 해결책으로 채택하지 않는다.

### 권장안: 기회주의적 병렬 `genderResolution`

불확실 triage 후보만 별도 고급 모델에 투기적으로 보내되 feature와 동시에 실행한다.
feature 종료 시 준비된 resolver 결과만 보수적인 조정 규칙에 사용한다.

이 방식은 현재 feature 주 경로와 검증 판정을 보존하고, 별도 모델의 독립적인 신호를
얻으며, resolver 모델을 직렬로 기다리지 않는다. 비용과 효과는 내부 원장에서
분리 측정할 수 있다.

## 4. 정책 버전과 불변 호환성

### 4.1 정책 registry

단일 상수를 다음 개념으로 교체한다.

- `SUPPORTED_AI_STAGE_POLICY_VERSIONS`
  - `ai-stage-policy-v2.6`
  - `ai-stage-policy-v2.7`
- `getAiStagePolicy(version, stage)`
- `assertSupportedAiStagePolicyVersion(version)`

v2.6 registry는 현재 모델, thinking, media 해상도, 미디어 수, prompt/schema 버전,
출력 토큰과 동시 실행 수를 그대로 동결한다. v2.6 요청은 resolver를 전혀 알지
못하는 것처럼 기존 경로를 실행해야 한다.

v2.7 registry는 v2.6 stage를 그대로 복사하고 `genderResolution`만 추가한다.
기존 stage 설정을 함께 바꾸지 않는다.

### 4.2 요청 생성과 실행

preflight 생성 시 rollout flag와 access mode를 읽어 정책 버전을 한 번 선택하고
기존 요청 정책 저장소에 기록한다.

- 기존 요청과 flag 비대상 요청: v2.6
- 승인된 test entitlement: v2.7 canary
- production flag 활성화 후 새 production 요청: v2.7

worker, runtime, staged identity 생성기는 저장된 요청 정책 버전을 인자로 받는다.
실행 중 환경 변수를 다시 읽어 버전을 바꾸지 않는다. 재시도, checkpoint replay,
worker revision 교체 후에도 같은 요청은 같은 버전과 같은 operation identity를
사용한다.

### 4.3 혼합 배포 순서

1. v2.6과 v2.7을 모두 읽는 코드와 additive DB migration을 배포한다.
2. rollout은 `off`로 두고 새 revision이 정상인지 확인한다.
3. 이전 worker revision이 drain된 뒤 test entitlement에서만 v2.7을 선택한다.
4. Standard E2E gate를 통과한 뒤 새 production preflight에 v2.7을 선택한다.

DB migration이 먼저 적용되어도 v2.6 payload와 기존 RPC가 계속 동작해야 한다.
코드가 먼저 배포되어도 resolver flag가 꺼진 상태에서는 새 DB 기능을 요구하지
않아야 한다.

## 5. `genderResolution` stage 계약

### 5.1 정책

| 항목 | 값 |
| --- | --- |
| stage | `genderResolution` |
| model | `gemini-3-flash-preview` |
| thinking | `LOW` |
| media resolution | `MEDIUM` |
| profile image | 최대 1장 |
| feed image | 최대 4장 |
| max output tokens | 512 |
| process stage concurrency | 2 |
| deployment stage concurrency | 2 |
| cache scope | request |
| prompt version | `gender-resolution-v1` |
| schema version | 1 |

입력에는 정규화된 이미지와 불투명한 `selectionId`만 포함한다. 사용자 이메일,
계정명, 원본 URL, 결과 순위, 위험 점수는 prompt와 identity에 넣지 않는다.

응답은 다음 값만 허용한다.

- `inferredGender`: `female | male | unknown`
- `confidence`: `low | medium | high`
- `ownerConsistency`: `same_person | mixed_people | not_visible`
- `evidenceSelectionIds`: 실제 입력으로 보낸 ID의 중복 없는 부분집합

근거가 0개면 `unknown/low/not_visible`로 정규화한다. 고신뢰 이진 판정은 서로 다른
근거 이미지가 2개 이상이어야 한다. 이 규칙은 기존 triage와 feature보다 느슨해지지
않는다.

### 5.2 실행 대상

triage 결과에 따른 실행은 다음과 같다.

| triage 결과 | feature | resolver |
| --- | --- | --- |
| high + same person + male | 실행 안 함, 남성 확정 | 실행 안 함 |
| high + same person + female | 실행 | 실행 안 함 |
| 그 밖의 `route_to_feature_analysis` | 실행 | 기회주의적으로 실행 |

고신뢰 여성 triage와 feature가 충돌하는 드문 기존
`unresolved_stage_conflict`는 이번 기본 eligibility에서는 resolver 대상이 아니다.
이를 해결하려고 고신뢰 여성 전체에 speculative 비용을 쓰지 않는다. 아래 충돌
조정 규칙은 checkpoint replay 안전성과 향후 eligibility 확장을 위해 정의하지만,
현재 v2.7 기본 경로에서는 resolver 결과가 존재하는 충돌에만 적용된다.

### 5.3 동시 시작과 cutoff

feature용 미디어 정규화와 caption 준비가 끝난 뒤 다음 순서로 실행한다.

1. `featureTask`를 즉시 시작한다.
2. 같은 event-loop turn에서 eligibility와 기회주의적 슬롯 확보를 시도하고
   `resolverTask`를 시작한다. 두 작업 사이에 `await`를 두지 않는다.
3. executor는 `featureTask`만 주 경로로 기다린다.
4. `resolverTask`는 완료되면 결과 checkpoint와 result hash까지 저장하고
   in-memory 상태를 `ready`로 바꾼다.
5. feature가 완료되는 순간 acceptance latch를 단 한 번 닫고 resolver 상태를
   동결한다.
6. latch가 닫히기 전에 `ready`가 된 결과만 조정 입력으로 사용한다.
7. `pending`이면 client abort를 보내고 내부 cutoff 종결 RPC를 기록한다.
   provider 모델 응답은 기다리지 않는다. 후보 checkpoint는 이 짧은 DB 종결
   확인만 기다릴 수 있으며 모델 생성 완료를 기다려서는 안 된다.
8. cutoff 뒤 도착한 SDK callback과 성공 응답은 fence에 의해 결과 checkpoint를
   만들거나 최종 판정을 바꿀 수 없다.

`Promise.all(featureTask, resolverTask)`를 사용하면 안 된다. resolver queue도
허용하지 않는다. 이 설계가 보장하는 것은 **resolver 모델에 대한 직렬 대기 없음**이지
네트워크·DB bookkeeping까지 0ms라는 뜻은 아니다.

feature 자체가 실패하면 resolver만으로 계정을 검증하지 않는다. resolver는
feature를 대체하는 stage가 아니며, 해당 계정은 기존 내부 unavailable 처리와 외부
미상 표현을 따른다.

## 6. 동시 실행과 lease 설계

### 6.1 프로세스 내부

현재 `AsyncSemaphore`에 resolver 전용 non-queue admission을 추가한다.

- resolver stage slot 2개 중 하나를 즉시 확보할 수 있어야 한다.
- shared slot 8개 중 하나도 즉시 확보할 수 있어야 한다.
- 둘 중 하나라도 없으면 아무 slot도 점유하지 않고 `capacity_skipped`를 반환한다.
- feature와 기존 stage는 현재 queue 동작을 유지한다.

feature를 먼저 시작하므로 resolver의 local admission은 feature 시작을 지연시키지
않는다.

### 6.2 배포 전체

DB acquire v2는 최소 다음 식별자를 받는다.

- `request_id`
- `job_key`
- `operation_key`
- `stage`
- `attempt`
- `claim_token`

lease의 유일한 실행 identity는
`(request_id, job_key, operation_key, attempt)`다. 동일 잡의 feature와 resolver는
operation key가 다르므로 서로의 lease를 재사용하거나 격리시키지 않는다.

advisory lock 안에서 다음 두 조건을 동시에 검사한다.

- leased 또는 안전 격리 중인 전체 Gemini operation 수 `< 8`
- `genderResolution` operation 수 `< 2`

resolver는 조건을 만족하는 available slot이 즉시 없으면
`resolver_capacity_pending`을 반환한다. worker 잡 전체를 재시도하거나 feature를
멈추지 않는다. 일반 stage는 resolver 전용 상한의 영향을 받지 않고 전체 8개 범위
안에서 남은 slot을 사용할 수 있다.

이 구조는 resolver가 최대 2개를 차지하므로 최악에도 일반 stage가 사용할 수 있는
6개 slot을 남긴다. 반대로 일반 stage가 이미 8개를 쓰고 있으면 resolver는 대기하지
않고 skip한다.

### 6.3 cutoff와 모호한 provider 실행

client abort는 provider 중단 보장이 아니므로 cutoff operation의 lease를 즉시
`available`로 돌리지 않는다.

- durable attempt 상태를 `cutoff`로 비재시도 종결한다.
- usage와 estimated cost를 알 수 없으면 `missing/null`로 기록한다.
- lease는 resolver lane의 안전 격리 상태로 옮긴다.
- SDK의 명시적 종결이 확인되면 fence를 확인하고 해제한다.
- SDK 종결을 확인하지 못하면 보수적인 TTL 뒤 전용 maintenance RPC가 회수한다.
- resolver 격리는 resolver 상한에 포함하지만 일반 stage 6개 이상의 진행을
  막아서는 안 된다.

늦은 callback은 이미 종결된 `cutoff` attempt와 닫힌 acceptance latch를 확인하고
no-op 또는 기대된 fence 결과로 끝난다. 성공 result를 뒤늦게 삽입하면 안 된다.

## 7. 정확한 판정 조정 규칙

먼저 현재 v2.6 feature 로직으로 `baselineClassification`을 계산한다.
resolver 적용 여부와 무관하게 이 값을 저장한다.

`readyResolver`는 다음을 모두 만족해야 한다.

- feature-completion cutoff 전에 result checkpoint가 성공적으로 저장됨
- 같은 request, job, operation의 result hash가 존재함
- 실제 입력 selection ID만 근거로 사용함
- late, cutoff, capacity skip, unavailable 상태가 아님

최종 조정은 아래 순서로 한 번만 수행한다.

### 7.1 이미 검증된 baseline

`baselineClassification`이 `verified_female` 또는 `verified_non_female`이면 그대로
유지한다. resolver가 반대여도 덮어쓰거나 충돌로 강등하지 않는다.

### 7.2 baseline이 `unresolved`

다음 첫 번째 규칙을 만족하면 resolver 성별로 검증한다.

1. resolver가 이진 성별
2. resolver confidence가 `high`
3. resolver owner consistency가 `same_person`
4. resolver의 서로 다른 근거가 2개 이상

위 규칙을 만족하지 않더라도 다음 합의 규칙을 모두 만족하면 검증한다.

1. feature와 resolver가 같은 이진 성별
2. 두 stage 모두 confidence가 `medium` 이상
3. 두 stage 모두 owner consistency가 `same_person`
4. feature gender 근거와 resolver 근거의 합집합이 서로 다른 이미지 3개 이상

그 밖에는 `unresolved`를 유지한다.

### 7.3 baseline이 `unresolved_stage_conflict`

ready resolver가 있을 때만 tie-break를 허용한다.

1. resolver가 이진 성별
2. resolver confidence가 `high`
3. resolver owner consistency가 `same_person`
4. resolver의 서로 다른 근거가 2개 이상
5. resolver 성별이 충돌한 triage 또는 feature의 이진 값 중 하나와 일치

모두 만족하면 resolver 성별로 검증한다. 아니면 충돌 상태를 유지한다.

### 7.4 unavailable과 미준비 resolver

baseline이 media 또는 analysis unavailable이면 resolver가 있어도 대체하지 않는다.
resolver가 없거나 cutoff 전에 준비되지 않았으면 baseline을 그대로 유지한다.

### 7.5 금지 규칙

- 결과 전체의 미상 비율을 보고 개별 계정 판정을 사후 변경하지 않는다.
- 여성·남성 수의 목표치를 만들지 않는다.
- resolver confidence를 코드에서 임의 승격하지 않는다.
- 실패 이미지를 존재한 근거처럼 세지 않는다.
- 근거 없는 성별을 랜덤 또는 순위 기반으로 배정하지 않는다.

## 8. 부분 이미지 실패 정책

각 triage/feature 미디어 묶음에서 다음 값을 계산한다.

```text
failedCount = failures.length
selectedCount = normalizedCount + failedCount
allowed = normalizedCount >= 1 AND failedCount * 5 <= selectedCount
```

즉 실패 비율이 정확히 20% 이하면 허용한다. 정수식으로 계산해 반올림 해석 차이를
없앤다.

예시:

- 선택 5장: 1장 실패까지 허용
- 선택 10장: 2장 실패까지 허용
- 선택 11장: 2장 실패까지 허용
- 선택 2장: 실패 허용 없음
- 선택 1장: 실패 허용 없음

허용 범위 안에서는 성공한 이미지만 prompt, caption, media hash, 근거 집합에 넣고
실패 목록은 내부 coverage에 유지한다.

20%를 넘는 경우:

- transient 실패가 하나라도 있으면 현재 job을 transient retry한다. 이미 성공한
  AI operation은 request checkpoint로 재사용하여 중복 과금을 막는다.
- 모두 permanent이면 내부 `media_unavailable`로 종결하고 외부에서는 미상에
  포함한다.

부분 실패 허용은 모델의 고신뢰 근거 기준을 완화하지 않는다. 성공 이미지가 한
장뿐이면 stage 실행은 가능하지만 서로 다른 근거 2장이 필요한 고신뢰 검증은
성립하지 않는다.

## 9. durable provenance와 불변식

profile AI 후보 checkpoint와 최종 classification row에 다음 내부 필드를 추가한다.

- `baselineClassification`
- `classificationSource`
  - `triage`
  - `feature`
  - `gender_resolution`
  - `unknown`
  - `unavailable`
- `genderResolutionStatus`
  - `disabled`
  - `not_eligible`
  - `ready_applied`
  - `ready_not_needed`
  - `ready_inconclusive`
  - `cutoff`
  - `capacity_skipped`
  - `terminal_unavailable`
- `genderResolutionOperationKey`
- `genderResolutionResultHash`

필수 불변식:

1. final과 baseline이 다르면 baseline은 `unresolved` 또는
   `unresolved_stage_conflict`여야 한다.
2. final이 baseline과 다르면 final은 `verified_female` 또는
   `verified_non_female`이어야 한다.
3. 판정이 바뀐 row는 `classificationSource = gender_resolution`,
   `genderResolutionStatus = ready_applied`여야 한다.
4. `ready_applied`, `ready_not_needed`, `ready_inconclusive`는 operation key와
   result hash가 모두 있어야 한다.
5. operation key와 result hash는 같은 request와 job의
   `genderResolution` result checkpoint와 정확히 일치해야 한다.
6. `cutoff`, `capacity_skipped`, `terminal_unavailable`, `not_eligible`,
   `disabled`는 성공 result hash를 가질 수 없다.
7. resolver는 feature가 이미 만든 verified 판정을 덮어쓸 수 없다.
8. late resolver 결과는 candidate checkpoint와 final row에 연결될 수 없다.
9. operation key prefix는 stage와 일치해야 한다.
10. attempt 예약이 없으면 provider 호출을 시작할 수 없고, terminal attempt 없이
    result checkpoint를 만들 수 없다.
11. 같은 operation attempt는 하나의 lease fence만 소유할 수 있다.
12. stale claim token은 attempt, result, candidate checkpoint를 바꿀 수 없다.
13. v2.6 legacy row는 읽을 때
    `baselineClassification = classification`,
    resolver status `disabled`, resolver key/hash `null`로 정규화한다.

resolver result cache는 request scope만 허용한다. 다른 요청의 프로필 이미지
snapshot과 결과를 재사용하지 않는다.

## 10. 외부 결과와 내부 지표

### 10.1 owner API

owner-facing summary에서 다음 네 필드를 제거한다.

- `successfullyScreenedMutuals`
- `fetchUnavailableMutuals`
- `mediaUnavailableMutuals`
- `analysisUnavailableMutuals`

외부 성별 상태는 `genderStats.male`, `genderStats.female`,
`genderStats.unknown` 세 값뿐이다. unavailable과 해결되지 않은 충돌은
`unknown`에 포함되지만 원인을 외부에 나누어 주지 않는다.

`male + female + unknown = screenedMutuals` 불변식은 유지한다. 외부 row와 오류
문구에는 resolver stage, 모델, confidence, cutoff, capacity, 이미지 실패 사유를
직렬화하지 않는다.

### 10.2 내부 보존

현재 result summary와 operational telemetry의 unavailable count는 삭제하지 않고
service-role 내부 값으로 유지한다. 추가로 service-role 전용
`analysis_v2_gender_resolution_metrics`를 결과 finalization과 같은 트랜잭션에서
upsert한다.

최소 집계:

- policy version
- screened count
- resolver eligible count
- baseline unknown count
- final unknown count
- ready count
- applied count
- inconclusive count
- cutoff count
- capacity skipped count
- terminal unavailable count
- partial-media accepted candidate count
- selected/normalized/failed media totals
- resolver attempt count
- resolver usage-complete count
- resolver usage-missing count

비용은 기존 AI attempt ledger의 `estimated_cost_usd`와 token usage를
`genderResolution` stage로 집계한다. 이메일, Instagram ID, 원본 URL, prompt,
이미지, 개별 오류 전문은 이 metrics table에 저장하지 않는다.

metrics table은 force RLS, `PUBLIC/anon/authenticated` revoke, service-role RPC만
허용한다. staging checkpoint purge 뒤에도 품질·비용 비교가 가능하도록 완료 결과와
함께 보존한다.

## 11. rollout과 Standard E2E gate

### 11.1 flag

새 preflight의 정책 선택에만 사용하는 server-side rollout mode를 둔다.

- `off`: 새 요청은 v2.6
- `test_entitlement`: 승인된 test entitlement만 v2.7
- `production`: 새 production 요청도 v2.7

flag 값은 요청 생성 후 해당 요청의 실행을 바꾸지 않는다. runtime에서 resolver만
끄는 별도 mutable flag를 두지 않는다. 긴급 중단은 새 요청을 v2.6으로 되돌리고
진행 중 v2.7 요청은 같은 정책으로 끝내거나 worker 접수를 일시 중지해 처리한다.

### 11.2 단계

1. additive migration과 dual-version 코드를 rollout `off`로 배포
2. v2.6 회귀 canary
3. `test_entitlement`에서 소규모 dry run
4. 승인된 공개 대상의 유료 **Standard** E2E 1회
5. 내부 지표·브라우저 결과·비용 원장 확인
6. production canary cohort
7. gate 통과 시 새 production preflight에 v2.7

### 11.3 Standard E2E 합격 기준

승인된 고정 공개 대상의 새 Standard 분석에서 다음을 확인한다.

- 분석이 completed이고 owner 보관함에서 열림
- `genderStats` 합이 screened public count와 일치
- 관측 미상 비율
  `genderStats.unknown / screenedMutuals <= 0.20`
  (`screenedMutuals = 0`이면 이 gate는 평가 불가)
- baseline unknown과 final unknown이 내부 지표에 각각 남음
- resolver로 바뀐 모든 row가 같은 request/job의 유효한 operation key와 result
  hash를 가짐
- verified feature 판정이 resolver에 의해 바뀐 row가 0개
- resolver 배포 전체 동시 실행이 2 이하
- 전체 Gemini 배포 동시 실행이 8 이하
- cutoff, capacity skip, unavailable이 외부 API와 화면에 노출되지 않음
- public summary에 네 failure aggregate 필드가 없음
- 부분 이미지 실패를 허용한 후보는 성공 이미지와 실제 근거만 사용
- resolver attempt의 usage/cost 완전성과 missing 건수가 내부에서 확인 가능
- feature p95와 전체 완료 시간의 비교 지표가 수집됨

미상 20% 초과 시 E2E 결과를 수정하거나 계정을 강제로 남성·여성으로 바꾸지 않는다.
production rollout을 보류하고 다음을 분해해 조사한다.

- media failure 기여분
- resolver eligibility 비율
- resolver ready-before-cutoff 비율
- capacity skip 비율
- resolver inconclusive 비율
- feature/resolver owner consistency 분포

한 계정의 E2E는 파이프라인 품질 gate이지 성별 정확도 증명이 아니다. 여성 오탐과
recall은 별도의 비식별 라벨 평가 집합에서 측정해야 한다. 라벨 평가 없이 단지
미상 비율이 낮아졌다는 이유로 정확도가 개선됐다고 결론내리지 않는다.

## 12. 비용·지연·abort 위험

### 비용

- Gemini 3 Flash preview는 Flash-Lite보다 호출당 비용이 높을 수 있다.
- feature보다 resolver가 늦으면 결과를 쓰지 못해도 이미 시작된 호출 비용이
  발생할 수 있다.
- abort 후에도 provider 과금이 이어질 수 있다.
- resolver eligibility, ready, applied, cutoff별 비용을 분리 집계해야 실제
  유효 판정 한 건당 비용을 알 수 있다.
- 가격 가정을 코드나 문서 상수로 고정하지 않고 실제 attempt ledger로 판단한다.

### 지연

- feature와 resolver 사이에 await가 없고 resolver admission이 non-queue라서
  resolver 모델을 직렬로 기다리지는 않는다.
- resolver가 shared slot을 최대 2개 점유하므로 높은 부하에서는 다른 Gemini
  stage 처리량이 줄 수 있다.
- DB lease acquire와 cutoff terminalization의 짧은 지연은 남는다.
- 강한 모델이 feature보다 대부분 느리면 ready 비율은 낮고 효과 없이 비용만
  증가할 수 있다. 이 경우 직렬 대기로 바꾸지 말고 모델·입력 수·eligibility를
  다시 검토한다.

### abort와 원장

- client abort를 provider 취소 증거로 취급하지 않는다.
- cutoff attempt는 성공으로 기록하지 않고 재시도하지 않는다.
- usage가 없으면 비용을 0으로 기록하지 않고 unknown으로 둔다.
- cutoff lease를 즉시 재사용하지 않아 일시적으로 resolver capacity가 줄 수 있다.
- cutoff terminalization 또는 fence 저장 실패는 조용히 무시하지 않는다.
  candidate 결과를 변경하지 않은 채 내부 운영 오류로 올리고, 중복 과금이나 늦은
  결과 적용보다 보수적으로 처리한다.

## 13. 파일 변경 지도

구현 단계에서 변경할 파일과 책임은 다음과 같다.

| 파일 | 변경 책임 |
| --- | --- |
| `lib/services/ai/stage-policy.ts` | v2.6/v2.7 registry, `genderResolution` 정책, resolver concurrency 2 |
| `lib/services/ai/gemini.ts` | version-aware policy, abort signal, resolver non-queue local admission |
| `lib/services/ai/v2-staged-analysis.ts` | resolver input/output schema, prompt, evidence 검증, identity |
| `lib/services/ai/index.ts` | resolver 타입과 함수 export |
| `lib/observability/schema.ts` | 내부 AI stage enum에 resolver 추가 |
| `lib/services/analysis/preflight.ts` | rollout mode로 새 요청의 immutable 정책 버전 선택 |
| `lib/services/analysis/v2-worker.ts` | 단일 상수 일치 대신 지원 버전 검사와 저장 버전 전달 |
| `lib/services/analysis/v2-ai-stage-runtime.ts` | version-aware runtime, audited resolver method, cutoff fence |
| `lib/services/analysis/v2-ai-scoring-executors.ts` | eligibility, feature/resolver 동시 시작, cutoff, 조정, 20% media 정책 |
| `lib/services/analysis/v2-ai-scoring-stage-store.ts` | baseline/source/status/op/hash schema와 legacy normalization |
| `lib/services/analysis/v2-ai-attempt-store.ts` | resolver stage/prefix, cutoff terminal status, 비용 완전성 |
| `lib/services/analysis/v2-ai-result-store.ts` | resolver request checkpoint, late-result fence, cutoff audit |
| `lib/services/analysis/v2-gemini-lease-store.ts` | operation-aware acquire v2, resolver admission, cutoff 격리 |
| `lib/services/analysis/v2-result-store.ts` | final provenance 검증, internal/public summary 분리 |
| `lib/services/analysis/v2-operational-observability.ts` | resolver·baseline/final unknown·media 품질 지표 |
| `lib/contracts/analysis-v2.ts` | owner 결과에서 failure aggregate 제거, 성별 3분류 유지 |

테스트는 각 구현 파일의 기존 colocated `*.test.ts`에 추가하며, DB 행위는 기존
PGlite 패턴을 따른다.

## 14. forward migration 지도

구현 시 다른 세션과 timestamp 충돌을 확인한 뒤 다음 두 forward migration을 만든다.
아래 이름은 이 설계가 예약하는 의도 이름이며 실제 timestamp가 이미 사용됐으면
초 단위 timestamp만 뒤로 조정한다.

### `20260725210000_add_analysis_v2_gender_resolution_stage.sql`

- `genderResolution` stage와 `gender-resolution:<sha256>` operation prefix 추가
- 다음 validator/function의 stage-operation 규칙 확장
  - `analysis_v2_valid_ai_operation_key`
  - `analysis_v2_ai_operation_matches_stage`
  - `analysis_v2_valid_ai_reservation_metadata`
  - `analysis_v2_valid_ai_result_identity`
  - `analysis_v2_ai_result_operation_key`
- AI attempt/result checkpoint의 stage constraint 확장
- resolver cache scope를 request-only로 제한
- attempt terminal status `cutoff`와 non-retry 불변식 추가
- lease에 nullable `operation_key`, `stage`와 필요한 fence metadata 추가
- operation-aware acquire/renew/release/cutoff/reap v2 RPC 추가
- resolver count 2, shared count 8을 advisory lock 안에서 강제
- 기존 v2.6 worker용 기존 RPC와 기존 row shape 유지

### `20260725213000_persist_analysis_v2_gender_resolution_provenance.sql`

- candidate feature checkpoint에 baseline/source/resolver provenance 추가
- 최신 `analysis_v2_checkpoint_candidate_features_complete` 교체
- 구 payload를 resolver disabled 기본값으로 받아들이는 compatibility 경로
- operation/result hash가 같은 request/job checkpoint와 일치하는지 검증
- final classification 변경 불변식 강제
- service-role 전용 `analysis_v2_gender_resolution_metrics` 추가
- finalization 트랜잭션에서 baseline/final unknown과 resolver 상태 집계
- `analysis_v2_result_summary_json` owner payload에서 네 failure aggregate 제거
- 내부 result summary/operational telemetry의 unavailable count는 유지
- 기존 gender stats trigger가 최종 조정된 terminal classification을 집계하도록
  순서와 합계 constraint 검증

기존 migration을 수정하지 않는다. 두 migration 모두 반복 적용이 아니라 forward-only
변경이며 v2.6 저장 데이터와 진행 요청을 읽을 수 있어야 한다.

## 15. 테스트 계획

### 정책과 identity

- v2.6 모든 stage snapshot이 구현 전과 byte-for-byte 같은 정책인지 검사
- v2.6 요청이 resolver 없이 완료되는지 검사
- v2.7만 resolver stage를 허용하는지 검사
- resolver operation prefix, cache scope, prompt/schema version 검사
- 재시도와 worker 교체 후에도 같은 request의 version과 operation key가 같은지 검사

### resolver schema

- 입력에 없는 selection ID 거부
- 근거 0개를 unknown으로 정규화
- 근거 1개의 high confidence를 medium으로 강등
- 서로 다른 근거 2개 이상의 high 이진 판정 허용
- username, URL, 사용자 식별자를 prompt/identity에 넣지 않는지 검사

### executor 병렬성

- deferred promise로 feature와 resolver가 await 없이 시작되는지 검사
- feature가 끝날 때 resolver ready면 적용 후보가 되는지 검사
- feature보다 늦은 resolver가 무시되는지 검사
- pending resolver에 cutoff/abort가 전달되는지 검사
- resolver를 기다리는 `Promise.all`이 없는지 동작 테스트로 검증
- local 또는 DB capacity 없음이 feature/job retry가 아니라
  `capacity_skipped`가 되는지 검사
- feature 오류 시 resolver만으로 검증하지 않는지 검사

### 조정 행렬

- verified female/non-female baseline은 어떤 resolver로도 불변
- unresolved + resolver high/same owner/2 evidence의 여성·남성 적용
- unresolved + feature/resolver medium 합의 + union 3 evidence 적용
- medium 불일치, mixed owner, 근거 부족은 unresolved 유지
- conflict + resolver high tie-break 적용
- conflict + medium/unknown/근거 부족은 conflict 유지
- unavailable baseline은 resolver로 대체하지 않음
- late/cutoff/capacity/unavailable resolver는 final 변경 불가

### 부분 이미지

- 5장 중 1장, 10장 중 2장, 11장 중 2장 실패 허용
- 5장 중 2장, 10장 중 3장, 11장 중 3장 실패 거부
- 성공 이미지 0장 거부
- 허용 범위 내 실패 이미지가 prompt, media hash, evidence에 없는지 검사
- 초과 transient는 retry, 초과 permanent는 내부 media unavailable인지 검사
- 한 장 성공으로 high confidence 검증이 되지 않는지 검사

### attempt/result/lease

- 동일 job의 feature attempt 1과 resolver attempt 1이 서로 다른 lease를 가지는지
  PGlite로 검증
- resolver deployment-wide 최대 2, shared 최대 8
- resolver capacity 없음은 즉시 반환하며 queue하지 않음
- cutoff가 non-retry terminal이고 result checkpoint가 없는지 검사
- cutoff 뒤 late success가 fenced되는지 검사
- cutoff lease가 즉시 일반 available로 재사용되지 않는지 검사
- 안전 TTL 뒤 resolver 격리가 회수되는지 검사
- stale claim/fence, operation-stage mismatch, 중복 terminalization 거부
- usage missing과 estimated cost null이 0비용으로 오인되지 않는지 검사

### 저장·외부 계약·지표

- v2.6 legacy checkpoint를 disabled provenance로 읽음
- final 변경 row가 resolver op/hash checkpoint와 일치함
- staging purge 후 internal aggregate가 남음
- owner schema와 route 응답에 네 failure aggregate가 없음
- resolver status, 원인, stage, model이 owner JSON에 없음
- male/female/unknown 합이 screened count와 일치
- internal unavailable count와 resolver metrics는 service role만 읽을 수 있음

### 전체 검증

- focused Vitest
- 전체 Vitest
- lint
- typecheck
- production build
- migration lint
- PGlite migration contract와 replay test
- rollout off 상태의 v2.6 canary
- test entitlement v2.7 canary
- 승인된 Standard E2E와 owner 결과 브라우저 검증

## 16. 롤백

코드 롤백의 첫 단계는 rollout mode를 `off`로 바꾸어 **새 preflight만** v2.6으로
돌리는 것이다. 이미 v2.7로 저장된 요청의 정책 버전을 수정하지 않는다.

- 진행 중 v2.7 요청은 dual-version worker로 같은 정책을 끝낸다.
- 심각한 provider 또는 원장 장애면 worker 접수를 잠시 멈추고 고친 뒤 같은
  checkpoint에서 재개한다.
- v2.7 요청을 v2.6으로 재기록하거나 resolver result를 삭제하지 않는다.
- additive DB column, stage enum 확장, metrics table은 즉시 제거하지 않는다.
- v2.7 요청과 resolver lease가 모두 종료·회수되고 retention 기간이 지난 뒤에만
  별도 migration으로 제거를 검토한다.
- owner API의 실패 정보 비노출은 resolver rollout과 독립된 개인정보·제품 경계이므로
  resolver를 롤백해도 다시 노출하지 않는다.

롤백 성공 기준은 새 요청이 v2.6으로 생성되고, 기존 v2.6/v2.7 결과가 계속 읽히며,
Gemini 공유 상한 8과 기존 stage 동작이 유지되는 것이다.

## 17. 승인된 구현 결정

다음 세 가지 결정은 구현 기준으로 승인되었다.

1. 고급 resolver는 불확실 triage에만 기회주의적으로 실행하고 고신뢰 여성 triage에는
   기본 실행하지 않는다.
2. 미상 20%는 모니터링·rollout gate로만 사용하며 강제 분류나 결과 조정 규칙으로 사용하지 않는다.
3. cutoff abort의 비용 절감을 보장하지 않으며, 모호한 호출은 비용 unknown과
   resolver 격리로 보수적으로 처리한다.

구현은 migration compatibility → 정책 registry와 원장 → executor와 provenance →
외부 계약 → 테스트 순서로 진행한다. 이번 구현에서는 test entitlement와 Standard
E2E가 통과해야 할 계약과 검증 수단까지만 준비한다. 유료 Standard E2E, 실제 rollout,
프로덕션 배포, Groble 변경은 수행하지 않는다.
