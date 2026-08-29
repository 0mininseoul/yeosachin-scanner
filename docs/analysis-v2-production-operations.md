# Analysis V2 프로덕션 운영 정본

기준일: 2026-08-27. 이 문서는 Analysis V2의 현재 운영 상태와 장애·배포 판단의 정본이다. 과거 계획은 [최종 출시 준비 계획](./superpowers/plans/2026-07-28-final-launch-readiness.md), 결제 자동 입장과 rollback은 [Earlybird automatic fulfillment](./earlybird-automatic-fulfillment-runbook.md), 비용 측정 상태는 [운영 비용 모델](./operations-cost-model.md)을 따른다. 아래의 운영 사실은 코드, forward migration, 배포 실측을 함께 근거로 한다.

## 현재 배포·실행 상태

- 2026-08-27 canonical Cloud Run worker는 revision `analysis-worker-fd70251r827a`가 traffic 100%를 받는다. worker/recovery/V2 tasks/preflight tasks는 활성화되어 있고 `PREFLIGHT_APIFY_API_TOKEN_SLOTS=primary,quinary,senary`다. 새 preflight run만 이 풀에서 결정적으로 선택하며, 이미 durable provider run이 있는 요청은 저장된 슬롯을 그대로 재개한다.
- Vercel production은 exact source commit `5511a6ca`를 배포해 `yeosachin.com`에 연결했다. 신규 결제 자동 입장은 `EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED=true`와 고정 cutoff `2026-08-27T04:40:00Z`를 함께 요구하므로, cutoff 이전 signed payment는 계속 concierge `awaiting_operator` 경계를 따른다.
- 공개 preflight/분석 생성은 Vercel의 `ANALYSIS_V2_ADMISSION_ENABLED` gate다. 신규 결제 자동 입장은 별도 Vercel gate인 `EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED`와 고정 RFC3339 cutoff `EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE`를 함께 사용한다. 두 gate를 동일한 의미로 취급하지 않는다.
- canonical worker의 `ANALYSIS_V2_WORKER_ENABLED=true`, `ANALYSIS_V2_RECOVERY_ENABLED=true`, `ANALYSIS_V2_TASKS_ENABLED=true`, `PREFLIGHT_TASKS_ENABLED=true`, `EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED=false`를 유지한다. Vercel cutoff 이후 새 signed payment만 webhook 경계에서 자동 입장하고 historical `awaiting_operator` sweep는 열지 않는다([`lib/services/analysis/v2-execution-gate.ts`](../lib/services/analysis/v2-execution-gate.ts), [`scripts/deploy-analysis-v2-worker.sh`](../scripts/deploy-analysis-v2-worker.sh)).
- canonical Cloud Tasks target은 V2 job queue의 정확한 `/api/analysis/v2/worker`와 preflight queue의 정확한 `/api/analysis/preflight/worker`다. 두 설정 모두 query 없는 HTTPS target을 요구하고 OIDC audience는 해당 target과 같은 origin의 `/`이어야 한다([`lib/services/analysis/v2-tasks.ts`](../lib/services/analysis/v2-tasks.ts), [`lib/services/analysis/preflight-tasks.ts`](../lib/services/analysis/preflight-tasks.ts)).
- 결제 후 정식 `apify_v1` 분석의 팔로워·팔로잉 및 기타 provider work는 주문별 `secondary` 슬롯으로 고정되며 preflight 풀로 회전하거나 폴백하지 않는다. 검증용 `analysis-worker-secondary-e2e`는 보존하되 worker/recovery/tasks/preflight/automatic fulfillment를 모두 `false`로 유지한다. 그것은 production queue의 대체 대상이 아니다.
- `junho_dem`은 로그인한 allowlisted operator에게만 제공되는 synthetic fixture다. 서버에서 username을 정규화한 뒤 정확히 일치하면 owner-bound demo run을 idempotent하게 시작하고 run별 HttpOnly marker로 결과를 즉시 연다. 비로그인은 로그인 경계, 비운영자는 403으로 닫히며 production reservation, Cloud Tasks, provider, Gemini, 운영 telemetry를 우회한다. 비슷한 다른 username은 일반 admission을 따른다.

## Canonical Vercel project contract

- 운영 Vercel 프로젝트의 정확한 CLI slug은 `yeosachin-scanner`이며 `yeosachin.com`에 연결한다.
- retired slug `ai-baram-detector`는 다시 link·create·deploy하지 않는다. 해당 slug로 연결된 로컬 설정은 유효한 운영 대상이 아니다.
- Vercel 환경변수 또는 배포 명령을 실행하기 전에 로컬 `.vercel/project.json`을 확인해 canonical 프로젝트(`yeosachin-scanner`)에 연결되어 있는지 검증한다. 파일이 없거나 대상이 다르면 명령을 중단하고 먼저 연결을 바로잡는다.

## 사전 점검, checkout, webhook, outbox

여기서 **사전 점검(preflight)** 은 결제·분석 전에 대상과 플랜 가능성을 확인하고 불변 snapshot을 만드는 단계다. preflight는 분석 요청과 별개이며, 실행 시 snapshot을 다시 검증한다.

1. checkout은 서버 카탈로그 및 preflight snapshot에서만 Basic/Standard를 만들며, 현재 가격 버전은 `earlybird-2026-08-v5`다. 기존 v1/v2/v3/v4 payment lineage는 새 checkout으로 바꾸지 않고 immutable snapshot을 보존한다. 단, 기존 기대금액이 현재 결제액보다 낮아 Groble 가격 변경 뒤 불일치할 pending 링크는 복구하지 않는다([`20260812122517_update_earlybird_pricing_v5.sql`](../supabase/migrations/20260812122517_update_earlybird_pricing_v5.sql), [`app/api/earlybird/checkout/route.ts`](../app/api/earlybird/checkout/route.ts)).
2. Groble webhook은 signed payment를 검증하고 먼저 `earlybird_fulfillments.awaiting_operator`를 만든다. `EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED`가 정확히 `true`이고 signed `paidAt`이 고정 cutoff 이상일 때만 같은 요청 경계에서 주문과 preflight를 `secondary`에 고정하고 durable admission을 시도한다. cutoff 이전 결제와 duplicate delivery는 자동 입장하지 않는다.
3. canonical worker의 `EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED=false`는 historical `awaiting_operator` sweep를 막는다. `ANALYSIS_V2_RECOVERY_ENABLED=true`는 webhook이 이미 승인한 `admission_pending`·`retryable_failure`만 drain한다([`20260728120000_add_earlybird_automatic_fulfillment.sql`](../supabase/migrations/20260728120000_add_earlybird_automatic_fulfillment.sql), [`lib/services/earlybird/fulfillment-store.ts`](../lib/services/earlybird/fulfillment-store.ts)).
4. gate가 false거나 cutoff 이전이면 결제 확정과 notification은 유지하면서 concierge `awaiting_operator`에 남는다. 불일치·실패는 새 유료 요청을 임의로 만들지 않고 `manual_review` 또는 기존 재시도 경계로 남긴다. 독립된 provider 증거 없는 `payment_pending`은 상태 변경 근거로 사용하지 않는다.

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

- **Fresh provenance activation gate (통과):** 격리된 disposable PostgreSQL 17에서 exact predecessor chain과 two-session barrier를 사용한 23/23 concurrency 검증이 통과했다. fresh admission/record/bind/checkpoint와 dispatch-guard/scheduler wrapper 교차 실행이 bounded lock timeout 안에서 deadlock과 잔류 lock wait 없이 끝났다. production Supabase나 paid provider call은 사용하지 않았다. PGlite contract와 이 실제 PostgreSQL 증거를 함께 rollout 근거로 사용한다.
- rollout은 reviewed migration history 확인 → exact migration allowlist dry-run → DB migration/ACL 검증 → Vercel gate-off 배포 → canonical worker 3개 preflight pool 및 recovery 배포 → queue를 두 번 확인 → 고정 future webhook cutoff 설정 → 신규 결제 gate 활성화 순서다. dirty/mixed worktree에서 `supabase db push --include-all`은 사용하지 않는다.
- **Exact-SHA GitHub CI release gate:** `scripts/deploy-analysis-v2-worker.sh`의 `apply`만 source SHA를 확인한 직후 고정된 GitHub REST API의 `0mininseoul/yeosachin-scanner` `.github/workflows/ci.yml` 실행을 `event=push`, `branch=main`, `head_sha` 필터로 조회한다. 실행의 path는 정확한 `.github/workflows/ci.yml` base path와 선택적인 `@ref` suffix만 정규화하며, validated selection은 exact lowercase SHA, `event=push`, `head_branch=main`을 모두 요구한다. 최소 한 개의 matching main-push run이 있고 모든 matching run이 `status=completed`, `conclusion=success`일 때만 통과하며, absent·pending·failure·다른 SHA·wrong path/branch/event·malformed/API/auth 오류는 모두 fail closed한다. `GITHUB_TOKEN` 또는 `GH_TOKEN`(GitHub Actions read 권한)은 **apply 전용 배포 prerequisite**이며 token/API 응답은 출력하지 않고, 우회 옵션은 없다. `--dry-run`과 `--check`는 기존 read-only preflight를 유지하기 위해 이 release gate를 호출하지 않는다.
- **Vercel Git deployment coverage (read-only classification):** 이 저장소의 `vercel.json`은 `git.deploymentEnabled.main=true`만 선언하며, 위 gate가 Vercel Git 자동 배포를 검사하거나 차단하지는 않는다. 따라서 GitHub CI 성공을 Vercel Production의 자동 배포 전에 요구하는 설정은 이 릴리스의 코드가 덮지 않는 **residual external setting**이다. Vercel 프로젝트의 Git production branch/protection 설정은 운영자가 별도로 확인·관리하고, 이 릴리스에서는 Vercel/GitHub provider 설정을 변경하지 않는다.
- **External deployment controls:** 이 gate는 `gcloud run deploy`·`gcloud run services update` 같은 직접 gcloud 배포나 Vercel CLI/API·Git provider의 직접 배포/보호 우회를 검사하거나 차단하지 못한다. 이러한 direct gcloud와 Vercel bypass는 **external controls**이며, 운영자는 별도 IAM·Vercel project protection·audit 정책으로 제한·감시해야 한다. 이 릴리스에서는 해당 provider 설정이나 배포를 변경하지 않는다.
- reviewed Basic/Standard `test_entitlement` gender routing은 전용 Secret Manager resource `ai-baram-v2-gender-routing-hmac`만 사용한다. outside-source dotenv의 `ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET`을 `configure-analysis-v2-secrets.sh`로 provision하고, 반환된 exact numeric version을 protected deploy configuration의 `ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION`에 고정한 뒤 같은 pin으로 deploy `--dry-run`, apply, `--check`를 실행한다. 값·`latest`·다른 identity/provider/Supabase secret 재사용은 금지하며, 최초 rollout 전에는 current template와 active revision 모두 cleanly absent여야 하고 이후 두 surface는 같은 exact ref여야 한다. 이 wiring은 일반 production/Plus routing 동작을 바꾸지 않는다.
- 결제 자동 분석 rollback은 먼저 Vercel의 `EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED=false`로 신규 admission만 닫는다. 이미 durable admission 상태인 작업은 `ANALYSIS_V2_RECOVERY_ENABLED=true`로 drain하고, checkout·결제 확정·concierge를 유지한다. worker 자체가 unsafe할 때만 별도 worker/dispatch gate를 닫으며 결제 상태를 rollback 수단으로 바꾸지 않는다.
- R2 capture/purge, provider reconciliation, Gemini quarantine, task delivery fence의 오류는 각각의 durable ledger를 먼저 조사한다. ambiguous provider start에 replacement run을 만들지 않는다.
- token, DB password, cookie, request/order/user UUID, provider hidden data, prompt/evidence/media URL을 문서·console·telemetry에 기록하지 않는다. server-only secret은 `NEXT_PUBLIC_`에 넣지 않는다. 공유 token은 접근 권한이므로 로그에 남기지 않는다.
# Betatest free-credit pool

For the dedicated `/betatest` Apify free-credit admission, recovery, alerts, grant
procedure, rollout, and rollback, see
[`betatest-apify-credit-pool-runbook.md`](./betatest-apify-credit-pool-runbook.md).
