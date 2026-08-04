# Analysis V2 프로덕션 운영 정본

기준일: 2026-07-28. 이 문서는 Analysis V2의 현재 운영 상태와 장애·배포 판단의 정본이다. 과거 계획은 [최종 출시 준비 계획](./superpowers/plans/2026-07-28-final-launch-readiness.md), 비용 측정 상태는 [운영 비용 모델](./operations-cost-model.md)을 따른다. 아래의 운영 사실은 코드와 forward migration을 함께 근거로 한다.

## 현재 배포·실행 상태

- result-sharing 배포의 canonical Cloud Run worker는 revision `analysis-worker-ff4492c63756`, SHA `f4492c1`, traffic 100%다.
- 공개 admission은 Vercel의 `ANALYSIS_V2_ADMISSION_ENABLED=true` gate다. canonical Cloud Run worker는 이 admission 변수를 갖지 않으며 `ANALYSIS_V2_WORKER_ENABLED=true`, `ANALYSIS_V2_RECOVERY_ENABLED=true`, `ANALYSIS_V2_TASKS_ENABLED=true`, `PREFLIGHT_TASKS_ENABLED=true`, `EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED=true`를 맡는다([`lib/services/analysis/v2-execution-gate.ts`](../lib/services/analysis/v2-execution-gate.ts), [`scripts/deploy-analysis-v2-worker.sh`](../scripts/deploy-analysis-v2-worker.sh)).
- canonical Cloud Tasks target은 V2 job queue의 정확한 `/api/analysis/v2/worker`와 preflight queue의 정확한 `/api/analysis/preflight/worker`다. 두 설정 모두 query 없는 HTTPS target을 요구하고 OIDC audience는 해당 target과 같은 origin의 `/`이어야 한다([`lib/services/analysis/v2-tasks.ts`](../lib/services/analysis/v2-tasks.ts), [`lib/services/analysis/preflight-tasks.ts`](../lib/services/analysis/preflight-tasks.ts)).
- secondary Apify 계정이 선택되어 있다. 검증용 `analysis-worker-secondary-e2e`는 보존하되 worker/recovery/tasks/preflight/automatic fulfillment를 모두 `false`로 유지한다. 그것은 production queue의 대체 대상이 아니다.
- 자동 분석 공개 입장은 소유자 결정으로 이미 열려 있다. 이 사실은 비용 완전성이나 UI 시간대 SLA가 증명됐다는 뜻이 아니다.

## 사전 점검, checkout, webhook, outbox

여기서 **사전 점검(preflight)** 은 결제·분석 전에 대상과 플랜 가능성을 확인하고 불변 snapshot을 만드는 단계다. preflight는 분석 요청과 별개이며, 실행 시 snapshot을 다시 검증한다.

1. checkout은 서버 카탈로그 및 preflight snapshot에서만 Basic/Standard를 만들며, 현재 가격 버전은 `earlybird-2026-08-v3`다. 기존 v1/v2 payment lineage는 새 checkout으로 바꾸지 않고 immutable snapshot을 보존한다([`20260803200000_update_earlybird_pricing_v3.sql`](../supabase/migrations/20260803200000_update_earlybird_pricing_v3.sql), [`app/api/earlybird/checkout/route.ts`](../app/api/earlybird/checkout/route.ts)).
2. Groble webhook은 결제를 검증하고 `earlybird_fulfillments.awaiting_operator` outbox 행만 만든다. webhook이 직접 `analysis_requests`나 Task를 만들지 않는다([`20260724123300_add_earlybird_fulfillment_outbox.sql`](../supabase/migrations/20260724123300_add_earlybird_fulfillment_outbox.sql)).
3. canonical recovery가 `EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED=true`일 때만 bounded 자동 입장을 실행한다. paid/reference-confirmed/payment ID/금액·상품/소유자/production preflight 및 불변 launch·catalog·pricing·policy snapshot을 모두 다시 검증한다([`20260728120000_add_earlybird_automatic_fulfillment.sql`](../supabase/migrations/20260728120000_add_earlybird_automatic_fulfillment.sql), [`lib/services/earlybird/fulfillment-store.ts`](../lib/services/earlybird/fulfillment-store.ts)).
4. 복구는 이미 `admission_pending`인 작업을 drain하며, 불일치·실패는 새 유료 요청을 임의로 만들지 않고 `manual_review` 또는 기존 재시도 경계로 남긴다. `payment_pending` 주문 두 건은 독립된 provider 증거가 없는 한 변경하지 않는다.

## canonical queue와 복구

Cloud Tasks의 V2 job queue와 preflight queue는 모두 canonical `analysis-worker` origin의 각 전용 worker path로만 dispatch한다. V2 job identity는 request, job key, generation, reservation token으로 fence되고 동일 generation Task 이름은 재사용된다([`lib/services/analysis/v2-tasks.ts`](../lib/services/analysis/v2-tasks.ts), [`lib/services/analysis/preflight-tasks.ts`](../lib/services/analysis/preflight-tasks.ts), [`lib/services/analysis/v2-job-store.ts`](../lib/services/analysis/v2-job-store.ts)).

`POST /api/analysis/v2/recover`는 maintenance 인증과 recovery gate를 통과해야 한다. 복구 pass는 dispatchable job 재전송, Gemini cutoff/lease 및 scheduler operation 회복, earlybird fulfillment, terminal media cleanup, provider terminalization/usage reconciliation, bounded background score audit를 수행한다([`app/api/analysis/v2/recover/route.ts`](../app/api/analysis/v2/recover/route.ts), [`lib/services/analysis/v2-recovery.ts`](../lib/services/analysis/v2-recovery.ts)).

Actor 시작 응답이 없어 `starting`인데 run ID가 없는 경우는 비용 0 또는 run 부재로 추정하지 않는다. 자동화는 해당 행을 block으로 보고, 고요 기간과 정확한 credential-slot provider 확인 후 DB owner의 immutable audit 절차만 사용할 수 있다([provider lifecycle runbook](./analysis-v2-provider-lifecycle-runbook.md)).

## V2 DAG와 불변 정책

V2의 durable DAG는 `coordinator:bootstrap`에서 다음처럼 fan-out/fan-in한다. 작업 key와 readiness는 [`lib/services/analysis/v2-dag-planner.ts`](../lib/services/analysis/v2-dag-planner.ts), 실행은 [`lib/services/analysis/v2-worker.ts`](../lib/services/analysis/v2-worker.ts)에 있다.

```text
bootstrap
  ├─ relationships collect ─┬─ profile fetch batches ─ profile AI batches ─┐
  │                         └─ private-name batches ───────────────────────┤
  └─ target-evidence collect ──────────────────────────────────────────────┘
                                      ↓
                              primary-evidence join
                                      ↓
                              candidate screening
                         ┌────────────┴────────────┐
                    reverse likes             partner safety
                         └────────────┬────────────┘
                                      ↓
                                   final score
                                      ↓
                                  narratives
                                      ↓
                                   finalize
```

정책은 request/preflight snapshot으로 고정된다. 현재 신규 production 선택은 `ai-stage-policy-v2.10`과 `risk-policy-v2.5`다. v2.7/v2.8/v2.9 rollout gate가 production에 있는 동안에도 신규 선택을 과거 버전으로 되돌리지 않는다. v2.10은 v2.9 scheduler semantics를 유지하며 v2.8의 presentation finalizer guard를 successor에 적용한다([`20260728110000_add_ai_stage_policy_v210.sql`](../supabase/migrations/20260728110000_add_ai_stage_policy_v210.sql), [`lib/services/ai/stage-policy.ts`](../lib/services/ai/stage-policy.ts)). 과거 request의 snapshot은 forward-only migration으로 바꾸지 않는다.

Gemini generation은 process-local semaphore가 아니라 DB-global lease가 정본이다. `analysis_v2_gemini_leases`의 8 slot과 fence/lease/cutoff protocol은 모든 revision·instance가 공유하며, slot 부족·격리·deadline 부족은 새 AI 시도로 소비하지 않고 지연 재실행한다. 격리 해제는 DB owner의 사고 근거 절차만 가능하다([`20260724123200_add_analysis_v2_gemini_leases.sql`](../supabase/migrations/20260724123200_add_analysis_v2_gemini_leases.sql), [`lib/services/analysis/v2-gemini-lease-store.ts`](../lib/services/analysis/v2-gemini-lease-store.ts)).

성별은 triage 뒤 evidence가 충분한 후보에만 opportunistic gender-resolution을 한다. 해소할 수 없거나 모순된 evidence는 `unknown`으로 유지한다. 집계 성별 실험은 별도 관측이며 account identifier·이름·bio·caption·URL·prompt·media locator를 보고서에 넣지 않는다([`lib/services/analysis/v2-gender-resolution-quality.ts`](../lib/services/analysis/v2-gender-resolution-quality.ts), [`lib/services/analysis/replay/resolver-experiment-runner.ts`](../lib/services/analysis/replay/resolver-experiment-runner.ts)).

## 위험도 v2.5

`risk-policy-v2.5`는 공식/그룹 계정과 strong-partner 후보를 relative high/caution 강제 배정에서 제외한다. eligible 후보는 natural score 내림차순, 동점이면 candidate ID 순으로 rank한다.

- inbound evidence가 하나라도 있으면 high pool은 inbound 후보만이다. 모든 eligible 후보의 inbound evidence가 0일 때만 eligible 전체를 high pool로 fallback한다.
- eligible이 3명 미만이면 natural 결과를 유지한다. 3명이면 high 최소 1명이다.
- eligible이 4명 이상일 때 목표 floor는 high 2명이지만, 실제 high 수는 high pool 수와 caution 2명을 남기는 `eligible - 2`에 cap된다. 예를 들어 inbound high pool이 1명이면 high도 1명이다.
- eligible이 5명 이상이고 high pool이 3명 이상이며 세 번째 natural public score가 4.2 이상일 때만 목표 floor를 high 3명으로 올린다. 이때도 high pool 수와 caution 2명 확보 cap을 적용한다.
- high는 최대 3명, caution은 남은 eligible 안에서 최소 2명·최대 10명이다. 후보→대상과 대상→후보 tag component는 모두 score에 보존한다.

구현 및 DB contract는 [`lib/domain/analysis/relative-risk-policy.ts`](../lib/domain/analysis/relative-risk-policy.ts), [`20260728180000_add_risk_policy_v25.sql`](../supabase/migrations/20260728180000_add_risk_policy_v25.sql)에 있다.

## 결과 확정, 이미지, 공유, 피드백

Analysis V2가 Gemini 입력으로 실제 사용한 normalized JPEG는 private GCS의
`analysis-v2-retained/` opaque prefix에 30일 보관한다. 범위는 triage 입력,
feature/partner-contact source에서 앞 단계와 중복되지 않는 remainder, 실제 Gemini에
전달되는 generated contact-sheet JPEG이며, 이 bundle들의 합집합이 source media와 실제
AI 이미지 입력 전체를 이룬다. raw Apify dataset 전체, 원본 URL, username,
request UUID, selection ID 원문은 장기 object path나 metadata에 저장하지 않는다. 기존
`analysis-v2/` job artifact는 계속 Age=1이며 30일 archive와 수명주기를 섞지 않는다.
archive write가 실패하면 해당 AI stage는 checkpoint를 만들지 않고 sanitized storage 오류로
종료한다([`lib/services/analysis/v2-source-media-archive.ts`](../lib/services/analysis/v2-source-media-archive.ts),
[`scripts/configure-analysis-v2-media-bucket.sh`](../scripts/configure-analysis-v2-media-bucket.sh)).

finalize는 DAG readiness를 확인해 immutable V2 result summary/page를 만든다. terminal failure는 소유자 library에서 숨긴다. 이 경계는 [`20260726035347_hide_failed_analysis_owner_history.sql`](../supabase/migrations/20260726035347_hide_failed_analysis_owner_history.sql), [`lib/services/analysis/owner-history.ts`](../lib/services/analysis/owner-history.ts)에 있다.

결과 이미지의 정상 경로는 result 시점 capture → normalized WebP → R2 object metadata → owner/share resolver다. terminal media는 recovery와 purge가 정리한다([`20260724123500_add_analysis_v2_result_image_objects.sql`](../supabase/migrations/20260724123500_add_analysis_v2_result_image_objects.sql), [`lib/services/media/result-image-capture.ts`](../lib/services/media/result-image-capture.ts), [`lib/services/media/result-image-purge.ts`](../lib/services/media/result-image-purge.ts)). R2 read 실패는 결과를 실패시키지 않고 placeholder/텍스트 fallback을 사용한다.

공유는 완료된 결과의 소유자만 enable/revoke한다. 같은 route의 `DELETE`가 `share_enabled=false`, token 제거의 compare-and-set을 수행하므로 기존 public token은 더 이상 유효하지 않다([`app/api/share/enable/route.ts`](../app/api/share/enable/route.ts)). 공유 이미지 route는 enabled completed V2 token과 requested locator를 재검증하고 R2 object만 반환하며 no-store header와 placeholder fallback을 쓴다([`app/api/share/[token]/image/route.ts`](../app/api/share/[token]/image/route.ts)). OG route는 R2 target image를 서버에서 읽어 inline으로 렌더하므로 expiring origin/proxy URL을 public OG에 노출하지 않는다([`app/api/share/[token]/opengraph-image/route.tsx`](../app/api/share/[token]/opengraph-image/route.tsx)).

`result_feedback`은 로그인한 결과 소유자만 같은 request에 남길 수 있고, free text는 1,000자로 제한해 service role로만 저장한다. body는 실패 로그에 쓰지 않는다([`app/api/result-feedback/route.ts`](../app/api/result-feedback/route.ts), [`20260728150000_add_result_feedback.sql`](../supabase/migrations/20260728150000_add_result_feedback.sql)).

## post-finalization score audit와 관측

score audit는 결과 확정 이후의 background 작업이다. final score checkpoint locator에서 source를 capture/materialize하고, recovery가 provider cleanup·usage reconciliation 뒤 작은 시간 예산으로 drain한다. audit 문제는 분석 결과나 provider cleanup 성공을 바꾸지 않는다([`20260727032000_add_analysis_v2_score_audit.sql`](../supabase/migrations/20260727032000_add_analysis_v2_score_audit.sql), [`lib/services/analysis/score-audit.ts`](../lib/services/analysis/score-audit.ts)). operator는 cookie-authenticated allowlist 뒤의 `/api/admin/analysis-audit`만 사용하며 응답은 `private, no-store`다([`app/api/admin/analysis-audit/route.ts`](../app/api/admin/analysis-audit/route.ts)).

요청 단위 운영 조회는 `/api/admin/analysis-observability`와 `load_analysis_v2_operational_observability` RPC다. provider actual/conservative, Gemini estimated, queue/processing/provider/Gemini timing, job retry, profile outcome 집계와 coverage를 보되 GCP infrastructure는 포함하지 않는다. 기간 preflight acquisition cost는 별도 aggregate RPC로 보고 `hasUnsettled` 또는 `isComplete=false`를 0원으로 취급하지 않는다([`lib/services/analysis/observability.ts`](../lib/services/analysis/observability.ts), [`app/api/admin/analysis-observability/route.ts`](../app/api/admin/analysis-observability/route.ts)).

## Rollout, rollback, privacy·secret 경계

- rollout은 reviewed migration history 확인 → 허용된 migration만 dry-run → DB migration/ACL 검증 → application 및 canonical worker 배포 → queue/recovery/preflight/automatic fulfillment 상태 확인 순서다. dirty/mixed worktree에서 `supabase db push --include-all`은 사용하지 않는다.
- rollback은 Vercel admission gate와 Cloud Run worker/recovery/automatic-fulfillment gate를 각각 필요한 범위에서 끈다. 이미 durable admission 상태인 작업은 recovery로 drain하며, 결제 상태를 rollback 수단으로 바꾸지 않는다.
- R2 capture/purge, provider reconciliation, Gemini quarantine, task delivery fence의 오류는 각각의 durable ledger를 먼저 조사한다. ambiguous provider start에 replacement run을 만들지 않는다.
- token, DB password, cookie, request/order/user UUID, provider hidden data, prompt/evidence/media URL을 문서·console·telemetry에 기록하지 않는다. server-only secret은 `NEXT_PUBLIC_`에 넣지 않는다. 공유 token은 접근 권한이므로 로그에 남기지 않는다.
# Betatest free-credit pool

For the dedicated `/betatest` Apify free-credit admission, recovery, alerts, grant
procedure, rollout, and rollback, see
[`betatest-apify-credit-pool-runbook.md`](./betatest-apify-credit-pool-runbook.md).
