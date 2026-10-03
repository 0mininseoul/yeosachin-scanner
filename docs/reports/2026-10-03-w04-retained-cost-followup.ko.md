# 2026-10-03 W04 보존 비용 자료 후속 확인

W04의 **무호출 보존 자료 조사와 비용 coverage 확인은 완료**했다. 현재 보존 자료에서 요청 정책이 v2.12로 연결되는 표본은 0개이며, 실제 high-risk label과 동일 cohort 비교 결과는 확보하지 못했다. **v2.12 실제 품질·비용 절감 검증과 승격은 계속 보류**한다. 새 offline 도구를 만드는 것만으로 부족한 표본이나 label을 채울 수 없으므로 이번 단계에서 코드 변경은 필요하지 않다.

근거는 root가 저장한 [안전 집계 DTO](./2026-10-03-w04-retained-cost-followup.safe.json)다. 원격 SELECT의 관측 시각은 **2026-10-03 16:34:28 KST**, DTO 기록 시각은 **16:34:30 KST**다. 아래 생성·종료 시각은 그때 조회된 과거 행의 시각이며, 오늘 새 분석을 실행한 시각이 아니다. 이 보고서 작성자는 safe JSON만 읽었고 추가 DB 조회를 하지 않았다. DTO의 Apify 호출과 AI 호출은 각각 0회이며, 새 사용자 분석·사용자 테스트도 실행하지 않았다.

## 관측 범위와 비용의 의미

집계는 `analysis_v2_ai_attempts`와 `vertex_ai_budget_reservations`에 **현재 남아 있는 행**을 대상으로 한다. 정책 분류를 위해 `analysis_requests`의 요청 snapshot만 서버 내부에서 JOIN했다. 결과에는 사용자·요청·주문·run·대상 계정 식별자, 원시 payload, 비밀값 또는 함수 본문을 포함하지 않았다.

- 권위 있는 정책 위치는 `analysis_requests.policy_versions_snapshot->>'aiStage'`다. 알려진 `ai-stage-policy-v2.6`부터 `v2.12`까지만 반환하고, 다른 값의 원문은 출력하지 않았다. 모델명이나 현재 환경 설정으로 과거 정책을 추정하지 않았다.
- AI attempt의 usage는 `prompt_tokens`, `completion_tokens`, `thinking_tokens`, `total_tokens`라는 typed column에 저장된다. Gemini 응답의 usage JSON이나 RPC 입력 JSON을 반환하지 않았다.
- token-complete는 terminal 행에서 `usage_metadata_status='complete'`, `usage_complete=true`, 네 token 값 존재, `total=prompt+completion+thinking`을 충족한 표본이다.
- 최신 비용 provenance 계약은 terminal 행의 `usage_complete=true`와 `metered_estimated_cost_usd`, `cache_read_tokens`, `canonical_model_name`, `pricing_version`의 존재를 함께 요구한다. token-complete와 이 비용 자격은 별개다.
- AI attempt의 기록된 estimate와 budget의 `actual_cost_usd`는 모두 사용 토큰에 가격표를 적용한 **비용 추정**이다. 청구서 실액을 관측한 결과가 아니다. budget은 같은 호출의 별도 금액 경계일 수 있으므로 **두 ledger 금액을 합산하지 않는다**.
- 자격을 충족하는 금액 표본이 없는 합계는 `null`로 유지했다. unknown이나 빈 표본을 비용 0으로 치환하지 않았다.

## AI attempt 보존 표본

| 항목 | 2026-10-03 조회 결과 |
|---|---:|
| 보존 attempt | 12,207 |
| terminal / reserved | 12,202 / 5 |
| token-complete / token-incomplete terminal | 11,543 / 659 |
| 최신 비용 provenance 자격 충족 terminal | 0 |
| 최신 계약에서 비용 usage unknown terminal | 12,202 |
| token usage는 complete이나 비용 provenance 자격 미충족 | 11,543 |
| 기록된 usage estimate가 있는 terminal | 11,299 |
| 기록된 응답 usage 기반 estimate 합계 | **$16.80342625** |
| 최신 provenance 자격 충족 estimate 합계 | **null** |
| 요청 snapshot상 v2.12 연결 attempt | 0 |
| 정책 unknown attempt | 4,441 |

첫 생성은 **2026-07-15 22:14:09 KST**, 마지막 생성은 **2026-08-30 19:53:39 KST**, 마지막 terminalization은 **2026-08-30 19:58:04 KST**다. reserved 5개가 있다는 사실을 현재 실행 중인 작업 5개로 해석하지 않는다. 이번 집계는 job 상태나 실행 lease를 재확인하지 않았다.

token-complete 11,543개의 token 합계는 입력 **43,755,174**, completion **2,971,264**, thinking **1,613,632**, 전체 **48,340,070**이다. 전체는 앞의 세 항목 합과 일치한다. 이는 사용량이 완전하게 기록된 부분집합의 합계이며, 비용 provenance 전체 충족이나 품질 통과를 뜻하지 않는다.

| 요청 snapshot 정책 분류 | 보존 행 | terminal | reserved | token-complete terminal | 기록된 usage estimate 합계 |
|---|---:|---:|---:|---:|---:|
| v2.7 | 4,115 | 4,111 | 4 | 3,638 | $5.6592865 |
| v2.10 | 2,379 | 2,378 | 1 | 2,320 | $3.27567825 |
| v2.11 | 1,272 | 1,272 | 0 | 1,253 | $1.5478615 |
| `unknown_unrecognized_policy` | 4,441 | 4,441 | 0 | 4,332 | $6.3206 |
| 전체 | 12,207 | 12,202 | 5 | 11,543 | $16.80342625 |

`unknown_unrecognized_policy`는 이번 known-enum 분류에 해당하지 않는 요청 snapshot이라는 뜻이다. 원문 정책을 읽거나 기록하지 않았으므로 어떤 과거 정책인지 임의로 채우지 않는다. 위 모든 정책 그룹의 최신 비용 provenance 자격 충족 수는 0이다.

과거 행을 최신 가격·cache provenance로 자동 backfill하지 않는 소스 계약이 있다. 다만 이번 DTO는 개별 provenance 컬럼의 누락 건수를 분해하지 않았으므로 **어느 항목 때문에 각 행이 탈락했는지는 확정하지 않는다**. 자격 0개를 토큰 사용량도 없었다거나 기록된 모든 estimate가 잘못됐다는 뜻으로 해석하지 않는다.

## Vertex budget 보존 표본

| 항목 | 2026-10-03 조회 결과 |
|---|---:|
| 보존 reservation | 2 |
| settled / reserved / cancelled | 2 / 0 / 0 |
| settled usage known / unknown | 2 / 0 |
| 정책 분류 | 2개 모두 `unknown_request_match` |
| 요청 snapshot상 v2.12 연결 reservation | 0 |
| settled 응답 usage 기반 estimate 합계 | **$0.00837** |
| 두 reservation의 dispatch 전 비용 상한 합계 | $0.0202895 |
| 예약 시 추정 input token 합계 | 3,715 |
| 예약 시 output token 상한 합계 | 6,144 |

생성 시각은 **2026-09-19 15:40:51 KST**와 **2026-10-01 01:24:22 KST**이며, 마지막 갱신은 **2026-10-01 01:24:28 KST**다. 입력 token과 출력 상한은 예약 당시 값이며 실제 응답 token 사용량으로 바꾸어 표시하지 않는다. 상한 대비 estimate 차이를 같은 품질을 유지한 v2.12 비용 절감률로 계산하지 않는다.

`run_id`를 요청의 `id::text`와 연결했으나 두 행 모두 보존 요청에 매치되지 않았다. 코드에는 요청 기반 scope 외 legacy/replay scope도 가능하지만, 이번 결과만으로 어느 경우인지 결정하지 않는다. 따라서 두 건이 v2.12였다고 단정할 수도, v2.12가 아니었다고 단정할 수도 없다. 요청 JOIN 실패는 AI attempt와의 정확한 시도 단위 매칭을 검사한 결과와도 다르다.

이 관측은 9월 19일·10월 1일에 생성된 별도 budget 기록이 남아 있음을 보여준다. 과거의 요청·preflight·job 집계와 범위가 다르므로, 요청 집계가 0이라는 이유로 그 이후 모든 AI 활동이 없었다고 결론 내리지 않는다. 이 두 행 역시 실제 사용자 분석 성공이나 사용자 테스트 완료의 증거가 아니다.

## Retention과 품질 검증의 한계

현재 retained 행의 기간과 수는 전체 과거 호출 이력을 복원하지 않는다. 삭제·보존 범위, 별도 replay 기록, 요청에 연결되지 않는 scope의 전체 이력은 이번 SELECT에서 확인하지 않았다. 따라서 **“현재 요청 정책 JOIN으로 확인되는 v2.12 표본은 0”**이라고만 판정하며, **“과거 v2.12 호출은 절대 없었다”**고 확대하지 않는다.

이번 DTO에는 독립 high-risk label, baseline/proposed의 동일 cohort 예측, true-positive 분자와 실제 high-risk 분모가 없다. 기존 gate의 fixture recall이나 비용 절감 모델을 이 비용 집계로 실증으로 바꾸지 않는다. runtime rollout 설정이 `TEST_ENTITLEMENT`라는 기존 설정 관측도 label 증거를 대신하지 않는다. gate의 현재 blocker는 [앞선 W04 조사](./2026-10-03-w00-w04-evidence.ko.md)에 기록된 `VERTEX_AI_HIGH_RISK_RECALL_EVIDENCE_UNVERIFIED`이며, 이번 후속 작업에서 gate를 재실행하거나 fixture status를 변경하지 않았다.

## 재개 조건과 실행 경계

1. **보존 자료만으로 정책 근거 보완:** 요청 정책에 연결되지 않는 budget 자료의 provenance가 이미 보존돼 있다면, 별도 허용된 metadata/집계 경로로 연결 근거를 확인한다. 모델명·날짜·현재 rollout만으로 unknown을 v2.12로 바꾸지 않는다. 필요한 자료가 없으면 정책 unknown을 유지한다.
2. **실제 품질 비교 자료 확보:** 독립 검증된 high-risk label, 같은 cohort의 기존 baseline/proposed 예측, 정책·기간·표본수·자료 hash와 label provenance가 있어야 한다. 원시 계정·식별자·payload를 보고서에 복사하지 않고 검증된 aggregate로 평가한다. 양성 분모가 없거나 비교 cohort가 일치하지 않으면 recall 검증은 계속 보류한다.
3. **비용 coverage와 비교 범위 확정:** 실제 usage, retry, route mix, unknown, 가격 provenance가 포함된 비교 집계를 확보해야 한다. 최신 자격 미충족 과거 행에 현재 가격 provenance를 소급해 채우지 않는다. 동일 token volume 재가격 모델과 관측된 사용량 기반 estimate, invoice 실액은 분리한다.
4. **기존 gate 재사용:** 검증된 집계가 준비되면 `scripts/vertex-ai-cost-gate.ts`의 `--fixture` 입력과 기존 순수 평가기를 재사용할 수 있다. fixture의 `unverified_fixture`를 `labeled`로 바꾸는 것만으로는 재개 조건을 충족하지 않는다. 자료가 없는 동안 새 offline 도구만 추가해 품질 PASS를 만들지 않는다.
5. **이번 범위 유지:** Apify API·actor, 유료 AI, 새 분석, 사용자 테스트, capture/run/apply, 운영 rollout 변경은 실행하지 않는다. 이 보고서는 후속 유료 호출이나 사용자 대신 분석을 실행하는 승인이 아니다.

특히 **기존 replay CLI의 `dry-run`도 보존 원본에 실행하면 안 된다.** `scripts/replay-analysis-v2.ts`는 bundle/key를 인증해 읽은 뒤 `finally`에서 `removeOwnedReplayArtifacts`를 호출하며, 성공 또는 인증 후 만료 거절에서도 소유 파일을 정리한다. dry-run은 AI 처리 분기를 건너뛰어 품질·비용 실측을 새로 만들지 않는다. 이 동작은 기존 `tests/analysis/replay/replay-runner.test.ts`의 무호출 dry-run 검사와 `tests/analysis/replay/tools/replay-analysis-v2.test.ts`의 artifact 정리 검사에 명시돼 있다. 이번 작업에서는 replay bundle/key를 열거나 복사하거나 실행하지 않았다.

## 근거 경로와 검증

- 직접 관측: `docs/reports/2026-10-03-w04-retained-cost-followup.safe.json`.
- 정책 reader: `lib/services/analysis/v2-ai-policy-store.ts`, `lib/services/analysis/v2-worker.ts`; `load_analysis_v2_ai_stage_policy_version`은 요청 snapshot의 `aiStage`를 읽는다.
- usage 기록: `lib/services/ai/gemini.ts`, `lib/services/analysis/v2-ai-attempt-store.ts`, `lib/services/analysis/v2-ai-result-store.ts`.
- 최신 비용 자격과 이중계상 방지: `supabase/migrations/20260904110000_add_analysis_v2_cost_attribution.sql`의 cost provenance trigger, `ai_rollup`, `vertex_budget_rollup`.
- budget 예약·정산: `supabase/migrations/20260902090000_add_vertex_ai_cost_budget_reservations.sql`, `lib/services/ai/vertex-ai-budget-store.ts`.
- 기존 관련 검사: `tests/analysis/execution/per-order-cost-attribution-pglite.test.ts`, `tests/ai/vertex-ai-cost-gate.test.ts`, `tests/ai/tools/vertex-ai-cost-gate.test.ts`, 위 replay 검사. 후속 보고서 작성 중 이 검사들을 재실행하지 않았다.

위 코드 계약은 앞선 읽기 전용 소스 조사에서 확인했다. 이번 작성 단계에서 새로 읽은 운영 자료는 safe JSON뿐이다. 변경 파일은 이 한국어 보고서 하나이며 safe JSON·기존 보고서·상태판·코드·보존 원본은 편집하지 않았다. DTO의 정책별 합계·상태 분해·token 합계·금액 합계 일치와 보고서의 식별자·credential 패턴 부재 검사는 **PASS**했다. 대상 파일 `git diff --check`와 새 파일의 trailing whitespace·EOF newline 검사도 **PASS**했다. 비용·품질 검증을 위한 추가 실행은 하지 않았다.
