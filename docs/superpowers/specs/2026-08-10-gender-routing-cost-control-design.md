# 성별 라우팅과 상세 수집 원가 상한 설계

- 상태: 2026-08-10 사용자 승인
- 기준일: 2026-08-10
- 범위: Analysis V2 관계 payload 이후 1차 성별 라우팅, Basic/Standard 상세 수집 상한, 최종 미상 gate
- 비범위: likes/comments 범위 축소, 랜딩 카피 변경, selfhosted_auth 전환, 점수로 성별 강제 보정

## 1. 결정

1. 이 제품의 분석 대상은 남성이며 상세 분석은 여성 가능성이 높은 공개 맞팔을 우선한다.
2. 1차 입력은 관계 payload의 `profile_pic_url`과 `fullname`뿐이다. username, bio, 과거 cache, 별도 profile fetch는 쓰지 않는다.
3. 공개 맞팔이 플랜 상세 상한 이하면 1차 모델을 호출하지 않고 전원 상세 분석한다.
4. 상한을 넘을 때만 서로 겹치지 않는 `female_priority`, `uncertainty`, `male_deprioritized` bucket을 만들고 80/20 quota로 선택한다.
5. 상세 수집과 interaction 대상은 Basic 100명, Standard 200명을 넘지 않는다.
6. screened 미상 부담이 30%를 넘으면 자동 완료하지 않는다. 이 비율은 coverage gate이지 성별 정확도 지표가 아니다.

## 2. 입력과 모집단

### 2.1 모집단

관계 checkpoint에서 맞팔 판정과 기존 제외 정책을 통과한 **공개 맞팔**만 이 라우팅 모집단이다. 비공개 계정은 기존 이름 기반 별도 결과 계약을 유지하며 상한과 섞지 않는다.

모집단은 request 생성 시 저장한 plan snapshot을 따른다.

| 플랜 | 관계 방향별 최대 | 1차 라우팅 최대 입력 | 상세 상한 |
|---|---:|---:|---:|
| Basic | 400 / 400 | 공개 맞팔 최대 400 | 100 |
| Standard | 800 / 800 | 공개 맞팔 최대 800 | 200 |

checkpoint의 공개 맞팔이 snapshot 최대를 넘으면 일부만 조용히 자르지 않고 lineage 오류로 중단한다.

### 2.2 허용 입력

- `profile_pic_url`
- `fullname`

금지 입력과 보강 경로:

- username, bio
- 기존 profile cache 전수 조회
- feed post, caption, comment, liker
- 별도 provider profile fetch

request-local URL 중복 제거와 이미 받은 동일 이미지 bytes 재사용만 허용한다. 이는 네트워크 중복 방지이며 과거 cache 보강이 아니다.

이미지는 최대 256 KiB, JPEG/PNG/WebP, redirect 2회, 3초 timeout으로 request-local 정규화한다. 이미지 실패 시 fullname이 있으면 name-only, fullname도 없으면 모델을 호출하지 않고 `uncertainty / evidence=none`으로 보낸다. 이미지 URL 문자열은 model prompt, manifest, 로그에 넣지 않는다.

## 3. 1차 모델 출력과 검증

모델 출력 schema:

- `female_score`: 0~1
- `male_score`: 0~1
- `uncertainty_score`: 0~1
- `evidence`: `image_and_name | image_only | name_only | none`

세 점수는 유한한 수이고 합이 `0.99~1.01`이어야 한다. 통과하면 합이 정확히 1이 되도록 정규화한다. 범위 초과, NaN, schema 오류, evidence와 실제 입력 불일치는 해당 candidate의 라우팅 실패다. 점수는 상대 순위용이며 사용자 결과·최종 성별·위험 점수에 쓰거나 통계적으로 보정된 확률이라고 표시하지 않는다.

policy version은 다음을 한 묶음으로 고정한다.

- prompt, model, generation 설정, JSON schema
- 이미지 정규화 규칙
- score 검증·정규화 규칙
- bucket threshold와 quota/fill 알고리즘
- tie-break HMAC domain과 manifest schema
- retry와 장애 threshold

## 4. 완결된 후보 선택 알고리즘

### 4.1 stage 생략

모집단 `N <= 상세 상한`이면 전원을 stable key 순서로 선택한다. 1차 모델과 이미지 다운로드를 생략하고 manifest에 `selection_reason = population_within_cap`을 기록한다. 80/20 비율을 억지로 만들지 않는다.

### 4.2 bucket

`N > 상세 상한`일 때 정상 출력마다 다음 순서로 하나의 bucket만 배정한다.

1. `uncertainty`: `uncertainty_score >= 0.40` 또는 `abs(female_score - male_score) < 0.15`
2. `female_priority`: 1이 아니고 `female_score > male_score`
3. `male_deprioritized`: 나머지

입력이 모두 없거나 허용 범위 안의 개별 라우팅 실패 candidate는 `(0, 0, 1)`로 저장하고 `uncertainty`에 넣되 `routing_unavailable = true`를 함께 기록한다.

### 4.3 정렬

- `female_priority`: `female_score DESC`, `uncertainty_score ASC`
- `uncertainty`: `uncertainty_score DESC`, `female_score DESC`
- `male_deprioritized`: `female_score DESC`, `uncertainty_score DESC`
- 모든 동점: `HMAC(request_id, relationship_checkpoint_id, candidate_stable_key, policy_version)` 오름차순

HMAC 키는 Secret Manager에서 읽고 raw candidate key와 digest를 일반 로그에 남기지 않는다.

### 4.4 quota와 fill

| 플랜 | cap | female quota | uncertainty quota |
|---|---:|---:|---:|
| Basic | 100 | 80 | 20 |
| Standard | 200 | 160 | 40 |

1. `female_priority`에서 female quota까지 선택한다.
2. 이미 선택된 candidate를 제외하고 `uncertainty`에서 uncertainty quota까지 선택한다.
3. 남은 자리는 unused `female_priority` → unused `uncertainty` → `male_deprioritized` 순서로 채운다.
4. 모집단이 cap보다 크면 정확히 cap, 작거나 같으면 정확히 N명이어야 한다.

실제 bucket별 선택 수와 quota 부족분을 manifest에 기록한다. pool이 부족한데도 “80/20을 달성했다”고 표시하지 않는다.

## 5. 라우팅 장애와 재시도

`attempted`는 이미지 또는 fullname이 있어 모델 호출 대상인 수, `valid`와 `failed`는 검증 결과다.

- `valid = 0`이거나 `failed / attempted > 0.10`이면 stage 전체를 `routing_unavailable`로 본다.
- 전체 장애에서는 실패 candidate만 같은 normalized input과 policy로 한 번 재시도한다. `valid = 0`이면 전 candidate가 한 번만 재시도 대상이다. 이미 valid인 candidate를 다시 호출하지 않고 paid profile 전수 fetch로 fallback하지 않는다.
- 재시도 뒤에도 `valid = 0` 또는 누적 실패 비율이 10%를 넘으면 후보를 선택하거나 상세 비용을 쓰지 않고 request를 `manual_review`로 보낸다.
- 실패 비율이 10% 이하이면 실패 candidate만 uncertainty bucket에 포함하고 정상 후보와 함께 결정적으로 선택한다.
- `attempted = 0`이면 모든 candidate가 무입력이다. `N > cap`이면 유효한 순위를 만들 수 없으므로 전체 장애, `N <= cap`이면 stage 생략 규칙으로 전원 상세 분석한다.

## 6. manifest와 재시도 결정성

manifest unique key는 `(request_id, relationship_checkpoint_id, policy_version)`다. 상태는 `building | complete | invalidated`이며 `complete`만 downstream에서 읽는다.

header에는 다음을 저장한다.

- plan/scope snapshot, 모집단·선택·bucket별 수
- policy version, canonical input HMAC, manifest schema version
- 생성 attempt, stage 상태, exact quota 부족 수

candidate row에는 다음을 저장한다.

- request-local opaque candidate key
- input presence와 image-content HMAC
- 검증된 bounded scores, evidence, bucket, routing-unavailable 여부
- 선택 여부, 선택 slot(`female | uncertainty | fill`), 최종 ordinal

raw fullname, username, URL, image bytes는 manifest와 로그에 넣지 않는다. canonical input HMAC은 stable key로 정렬한 `input presence + normalized fullname HMAC + image-content HMAC`을 domain-separated HMAC한 값이다. 만료 query가 붙은 URL 자체는 hash 입력에서도 제외한다.

manifest header와 candidate row는 한 transaction에서 `complete`로 전환한다. crash로 `building`이 남으면 같은 input/policy가 기존 row를 지우지 않고 새 attempt를 만들며, complete manifest가 이미 있으면 그대로 재사용한다. relationship checkpoint나 plan/policy snapshot이 바뀌면 새 manifest를 만들고 이전 집합과 섞지 않는다.

## 7. 상세 분석, coverage와 미상 gate

선택된 candidate만 기존 상세 profile, 최신순 최대 8개 media, gender stage, likes/comments와 interaction 수집 대상으로 보낸다. 이번 변경은 interaction 종류나 per-operation limit을 줄이지 않지만 **상한 밖 candidate에 interaction을 실행하지 않는다.** 1차 점수는 2차 최종 성별을 덮어쓰지 않는다.

candidate 최종 상태는 다음 불변식을 가진다.

- `screened`: manifest에서 선택된 집합
- `not_screened`: 공개 모집단에서 선택되지 않은 집합
- `final_gender`: screened에 대해 `female | male | unknown`
- `unavailable_reason`: `none | fetch_unavailable | media_unavailable | analysis_unavailable`
- `unavailable_reason != none`이면 `final_gender = unknown`

따라서 항상:

```text
screened_count + not_screened_count = public_mutual_count
unknown_burden_count = count(screened where final_gender = unknown)
unknown_ratio = unknown_burden_count / screened_count
```

unavailable은 unknown의 원인이라 분자에 한 번만 들어간다. 공개 맞팔이 0이면 `screened=0`, `unknown_ratio=0`으로 빈 공개 결과를 완료할 수 있다. 공개 맞팔이 있는데 screened가 0이면 invariant 오류다.

30% 비교는 반올림한 표시값이 아니라 정수식 `unknown_burden_count * 10 <= screened_count * 3`으로 판정한다.

### 7.1 resolver와 manual review

1. unknown ratio가 30% 이하면 자동 finalize를 허용한다.
2. 30%를 넘으면 `analysis_unavailable → media_unavailable → fetch_unavailable → 기타 unknown` 순으로 Basic 최대 20명, Standard 최대 40명에 기존 opportunistic resolver를 한 번 실행한다. 동률은 manifest HMAC 순서다.
3. resolver도 §8의 비용 예산 안에서 사전 예약돼야 하며 새 candidate를 상한 밖에서 끌어오지 않는다.
4. 이후에도 30%를 넘으면 `manual_review`다. 자동 완료·자동 전달하지 않는다.
5. 운영자는 같은 manifest 안에서 한 번의 승인된 concierge 재수집 후 완료하거나, 미확정 범위를 명시한 `manual_partial` 전달을 고객에게 안내하거나, 환불한다. 점수의 큰 쪽으로 성별을 강제하지 않는다.

`manual_partial`은 자동 E2E 성공으로 세지 않으며 운영자 승인 시각과 exact unknown counts를 주문 원장에 연결한다.

## 8. 원가 상한

비용은 무료 credit을 0원으로 보지 않고 [운영 비용 및 가격 모델](../../operations-cost-model.md)의 buffer 환율과 공개 list price로 환산한다.

| 단계 | Basic hard cap | Standard hard cap |
|---|---:|---:|
| 1차 입력 candidate-equivalent | 400 | 800 |
| 1차 실패 재시도 candidate-equivalent | 최대 400, candidate별 1회 | 최대 800, candidate별 1회 |
| 상세 profile/media/interaction candidate | 100 | 200 |
| resolver candidate | 20 | 40 |
| margin target | **904원** | **1,817원** |
| 제한 판매 hard safety cap | **1,808원** | **3,634원** |

margin target은 현행 결제 수수료 차감 후 계획 순수입이다. 첫 제한 판매는 원가 학습을 위해 그 두 배까지의 명시적 손실 예산을 허용하되, hard safety cap을 넘는 자동화는 열지 않는다. 고정 infra와 운영 인건비는 별도 기록한다.

- 각 유료 operation은 비용 ledger에 reservation이 있어야 시작한다.
- retry와 resolver도 같은 plan budget에서 차감한다.
- 보수적 예상 비용이 남은 예산을 넘으면 operation을 시작하지 않고 `manual_review`로 전환한다.
- actual cost가 margin target 이하면 단위경제성까지 통과다.
- margin target 초과, hard safety cap 이하면 E2E 기능은 통과할 수 있지만 `negative_margin_pilot`로 표시하고 재고 10개 제한·가격 인상/추가 절감 검토 없이 확대하지 않는다.
- hard safety cap을 넘은 E2E는 기능이 완료돼도 비용 gate 실패다.
- 이전 policy가 더 비싸면 자동 fallback하지 않고 해당 플랜 신규 재고를 닫는다.

## 9. 이미지 수명주기

1차 정규화 이미지는 request-local 임시 artifact이며 terminal cleanup 대상이다. 최종 결과에 표시할 target·후보 이미지는 finalize 전에 내부 R2 result-image store로 캡처한다. 공급자 CDN URL은 결과 DTO에 들어가지 않는다.

stage1 image fetch 실패는 name-only로 계속할 수 있지만, 최종 result image 캡처 품질은 [유료 분석 E2E 설계](./2026-08-10-revenue-e2e-observability-design.md)의 별도 gate를 따른다.

## 10. 정확도와 독립 audit

unknown 30%는 얼마나 많이 답했는지만 측정하며 맞게 답했는지는 증명하지 않는다. production 활성화 전 두 E2E에서 다음 blind audit를 추가한다.

1. reviewer는 1차 점수와 bucket을 보지 않고 공개 프로필·상세 증거만 본다.
2. 최종 female이 20명 이하면 전원, 넘으면 manifest HMAC으로 20명을 표본 추출한다. 명백한 비여성 false positive 비율은 10% 이하여야 한다.
3. `not_screened`가 있으면 플랜별 최대 20명을 별도 audit-only 상세 수집한다. 이 결과는 사용자 결과와 risk score에 넣지 않는다.
4. audit-only 표본의 female 비율이 `female_priority` 선택군보다 10%p 넘게 높으면 라우팅이 여성 후보를 우선했다는 gate에 실패한다.
5. 표본이 10명 미만이면 정확도 결론을 내리지 않고 descriptive evidence로만 기록한다. 이 경우 unknown gate만으로 “정확도 검증”을 선언하지 않는다.

audit 결과는 aggregate count와 rate만 남기고 계정 식별자를 문서·로그에 기록하지 않는다.

## 11. 테스트와 출시 gate

### 단위·계약 테스트

- 허용 입력 두 개 외 username/bio/cache/profile fetch가 stage1에 들어가지 않음
- `N <= cap` 모델 호출 0회, 전원 선택
- 세 bucket 경계값, score schema 오류, 개별/전체 장애
- Basic 80/20, Standard 160/40, pool 부족과 fill 순서
- 동일 input/checkpoint/policy의 manifest·ordinal 동일
- checkpoint/policy/plan snapshot 변경 시 manifest 혼합 거절
- coverage 수식, unavailable 중복 계수 방지, 0 모집단
- 30% 경계, resolver cap, manual review와 `manual_partial`
- 모든 provider/AI operation의 사전 비용 reservation과 초과 fail-closed
- raw fullname·URL·username·bio가 manifest와 로그에 없음

### E2E pass/fail

- Basic `winglss1`, Standard `0_min._.00`이 실행 시점에 공개이고 해당 plan capacity 안임. 아니면 대상을 임의 대체하지 않고 사용자에게 재승인을 요청한다.
- 새 provider lineage로 fresh 관계 수집부터 완료
- 상세 선택·interaction candidate와 비용이 hard safety cap 이하; margin target 초과 여부 별도 표시
- coverage invariant와 unknown ratio 30% 이하
- blind audit 기준 통과
- target과 표시 candidate 이미지가 새 세션에서 내부 경로로 로드
- request-scoped Sentry/Axiom 오류 0, queue/lease/provider run/artifact terminal

`manual_review`, `manual_partial`, 비용 cap 초과는 안전한 처리지만 E2E 성공은 아니다. Basic 성공 뒤 Standard를 실행한다.

## 12. 출시와 rollback

1. additive schema와 old/new policy reader를 먼저 배포한다.
2. worker code를 100% promotion하되 새 policy selector는 `test_entitlement`에만 연다.
3. Basic과 Standard가 §11을 모두 통과한 뒤 신규 production request에만 selector를 연다.
4. 이미 시작한 request는 저장된 policy로 끝내고 기존 결과를 재분류하지 않는다.
5. 비용·정확도·coverage gate가 실패하면 새 policy를 끄고 해당 플랜 재고를 0으로 둔다. 더 비싼 과거 policy로 유료 요청을 자동 fallback하지 않는다.
