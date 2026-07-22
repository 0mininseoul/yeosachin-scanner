# Apify Secondary 전환·시작 거절 처리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 레포의 현재 지침에 따라 subagent는 사용하지 않고 현재 세션에서 직접 실행한다.

**Goal:** 실제 판매에 사용할 `APIFY_SECONDARY_API_TOKEN` 계정으로 운영 worker를 안전하게 전환하고, Apify의 확정적 시작 거절가 미해결 원장 행을 남기지 않게 하며, 승인된 Plus E2E를 완료한다.

**Architecture:** 기존 `analysis-worker`/`primary:2`는 복구 근거로 보존하고, 임시 `analysis-worker-secondary-e2e`와 최종 `analysis-worker-secondary`를 새로 배포한다. 코드에서는 `ApifyApiError`만 확정 거절로 분류하고, preflight/request provider 원장을 `rejected`, 0원, 정산 완료로 원자적 전이한다. 통신 오류와 deadline은 기존처럼 불명 시작으로 보존한다.

**Tech Stack:** Next.js 15, TypeScript, Vitest, PGlite, Supabase PostgreSQL migrations/RPC, `apify-client` 2.21.0, Google Cloud Run/Tasks/Scheduler/Secret Manager, Vercel CLI, gcloud CLI.

---

## 파일 구조

- `lib/services/instagram/providers/types.ts`: 확정 거절 callback 입력과 provider checkpoint 계약.
- `lib/services/instagram/providers/apify-relationship.ts`: `ApifyApiError`와 통신 실패의 분리, callback 호출, 정제된 error code.
- `lib/services/instagram/providers/apify.test.ts`: Actor 시작 거절/timeout 분류 단위 테스트.
- `lib/services/analysis/preflight-provider-run.ts`: preflight/fresh-admission `rejected` RPC 바인딩.
- `lib/services/analysis/preflight-provider-run.test.ts`: callback 바인딩과 RPC 인자 테스트.
- `lib/services/analysis/preflight-provider-run-pglite.test.ts`: preflight 거절 전이·비용 이벤트·retention 테스트.
- `lib/services/analysis/v2-provider-run-store.ts`: request provider 거절 RPC와 adapter callback.
- `lib/services/analysis/v2-provider-run-store.test.ts`: request 원장 거절 인자·상태 파싱 테스트.
- `lib/services/analysis/apify-start-rejection-pglite.test.ts`: preflight/request 거절 전이·cleanup/readiness·비용 이벤트 통합 테스트.
- `lib/services/analysis/v2-worker-error-codes.ts`: `SCRAPING_PROVIDER_START_REJECTED_ERROR` 허용 목록.
- `lib/services/analysis/preflight.ts`: 확정 거절을 non-retryable provider 실패로 분류.
- `supabase/migrations/20260722110000_record_definite_apify_start_rejections.sql`: 두 원장의 `rejected` 상태, RPC, preflight 장기 0원 이벤트, retention/readiness 연결.
- `lib/services/analysis/apify-start-rejection-migration-contract.test.ts`: migration 보안·constraint·ACL contract.
- `docs/authorized-apify-sharded-e2e-runbook.md`: Secondary 기준 임시 operation map, Free E2E와 Starter 출시 E2E의 경계.

### Task 1: 기존 불명 preflight를 정확히 해소한다

**Files:**
- Read: `docs/preflight-ambiguous-apify-start-resolution-runbook.md`
- Read: `scripts/resolve-preflight-ambiguous-apify-start.ts`
- External evidence: source tree 밖 `mktemp`로 생성한 파일

- [ ] **Step 1: 30분 조건을 재확인한다**

Run:

```bash
date -u '+%Y-%m-%dT%H:%M:%SZ'
npx tsx --env-file='/Users/youngminpark/Desktop/개발/ai baram detector/ai-baram-detector/.env.local' \
  scripts/resolve-preflight-ambiguous-apify-start.ts --list --limit=20
```

Expected: `c801ffe8-c072-4330-bdd9-53b9047c6a45` 행이 정확히 1개 보이고, slot은 `primary`, Actor는 `apify/instagram-profile-scraper`, `runId` 없음, 예약 시각은 기존 값과 같다.

- [ ] **Step 2: 기존 Septenary 계정에서 정확한 시간 범위의 run 0건을 다시 확인한다**

`APIFY_SEPTENARY_API_TOKEN`으로 `apify/instagram-profile-scraper` run을 `2026-07-22T02:17:30Z`부터 현재까지 조회한다. 출력은 `runsInWindow`, status 건수, 조회 시간만 포함한다.

Expected: `runsInWindow: 0`.

- [ ] **Step 3: owner-only SQL을 생성하고 DB owner로 실행한다**

Run: `--list` 출력의 immutable identity를 그대로 `--resolve` 인자에 넣고, confirmation은 정확히 `I_VERIFIED_EXACT_APIFY_ACTOR_SLOT_AND_TIME_WINDOW_HAS_NO_RUN`을 사용한다. evidence reference는 source tree 밖 파일의 SHA-256만 DB에 들어가게 한다.

Expected: `resolved_no_run`, `actual_usage_usd=0`, manual cost event 1건.

- [ ] **Step 4: 후속 검증**

Run: `--list` 명령을 다시 실행하고 Cloud Tasks 두 queue의 task 건수를 조회한다.

Expected: 해당 preflight가 목록에서 사라지고 대기 task 0건.

### Task 2: Apify 확정 거절 테스트를 RED로 만든다

**Files:**
- Modify: `lib/services/instagram/providers/apify.test.ts`
- Modify: `lib/services/analysis/preflight-provider-run.test.ts`
- Modify: `lib/services/analysis/v2-provider-run-store.test.ts`

- [ ] **Step 1: 실제 `ApifyApiError` fixture 테스트를 추가한다**

Add:

```ts
import { ApifyApiError } from 'apify-client';

function rejectedStartError(statusCode = 402, type = 'usage-limit-exceeded') {
    return new ApifyApiError({
        status: statusCode,
        data: { error: { message: 'suppressed in production', type } },
        config: { method: 'post', url: '/v2/acts/example/runs' },
    } as never, 1);
}
```

테스트는 `actor.start` 거절, `onRunStartRejected` 1회, `onRunStarted` 0회, `waitForFinish` 0회, `SCRAPING_PROVIDER_START_REJECTED_ERROR`를 기대한다.

- [ ] **Step 2: store callback RED 테스트를 추가한다**

preflight와 V2 adapter 테스트에서 `onRunStartRejected` 호출 후 각각 `checkpointRejected`/`rejectedRpc`가 immutable identity로 한 번 호출되는지 검증한다.

- [ ] **Step 3: RED를 확인한다**

Run:

```bash
npx vitest run lib/services/instagram/providers/apify.test.ts \
  lib/services/analysis/preflight-provider-run.test.ts \
  lib/services/analysis/v2-provider-run-store.test.ts
```

Expected: `onRunStartRejected`, `checkpointRejected`, `SCRAPING_PROVIDER_START_REJECTED_ERROR` 미정의로 FAIL. 기존 테스트 오류가 아니어야 한다.

### Task 3: 확정 거절 callback과 오류 분류를 GREEN으로 만든다

**Files:**
- Modify: `lib/services/instagram/providers/types.ts`
- Modify: `lib/services/instagram/providers/apify-relationship.ts`
- Modify: `lib/services/analysis/v2-worker-error-codes.ts`
- Modify: `lib/services/analysis/preflight.ts`

- [ ] **Step 1: callback 계약을 추가한다**

Add:

```ts
export interface ProviderRunStartRejected {
    logicalProvider: Extract<ProviderName, 'apify' | 'coderx'>;
    actorId: string;
    credentialSlot: ApifyCredentialSlot;
    maxChargeUsd: number;
    statusCode: number;
    errorType: string | null;
}

interface ProviderRunStartCallbacks {
    onRunStartRejected?(input: ProviderRunStartRejected): void | Promise<void>;
}
```

`ProviderRunCheckpoint`/`ProviderCallContext`는 `ProviderRunStartCallbacks`을 확장한다.

- [ ] **Step 2: `startOrResumeApifyActor` 분류를 구현한다**

`ApifyApiError`를 value import하고, `actor.start` catch를 다음 규칙으로 바꾸다.

```ts
} catch (error) {
    if (error instanceof ApifyApiError) {
        const statusCode = Number.isInteger(error.statusCode)
            && error.statusCode >= 400 && error.statusCode <= 599
            ? error.statusCode
            : 500;
        const errorType = typeof error.type === 'string'
            && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(error.type)
            ? error.type.toLowerCase()
            : null;
        try {
            await context?.onRunStartRejected?.({
                logicalProvider: options.logicalProvider,
                actorId,
                credentialSlot,
                maxChargeUsd: maxTotalChargeUsd,
                statusCode,
                errorType,
            });
        } catch (callbackError) {
            throw sanitizedProviderCallbackError(
                callbackError,
                'ANALYSIS_V2_PROVIDER_RUN_REJECTION_PERSISTENCE_ERROR'
            );
        }
        throw new Error('SCRAPING_PROVIDER_START_REJECTED_ERROR');
    }
    throw new Error(
        'SCRAPING_AMBIGUOUS_START_ERROR: Apify Actor start response was not confirmed.'
    );
}
```

- [ ] **Step 3: error allowlist/classification을 연결한다**

`v2-worker-error-codes.ts`에 `SCRAPING_PROVIDER_START_REJECTED_ERROR`를 추가한다. `classifyPreflightError`는 이 코드를 `category: 'provider'`, `retryable: false`, `paidFallbackEligible: false`로 분류한다. Apify 프로필/관계/상호작용 wrapper는 이 typed error를 일반 transport error로 덮지 않고 그대로 던진다.

- [ ] **Step 4: 단위 테스트 GREEN을 확인한다**

Run: `npx vitest run lib/services/instagram/providers/apify.test.ts`

Expected: 확정 거절 테스트 PASS, 기존 deadline 테스트 PASS.

### Task 4: DB migration을 PGlite RED→GREEN으로 구현한다

**Files:**
- Create: `supabase/migrations/20260722110000_record_definite_apify_start_rejections.sql`
- Create: `lib/services/analysis/apify-start-rejection-migration-contract.test.ts`
- Create: `lib/services/analysis/apify-start-rejection-pglite.test.ts`

- [ ] **Step 1: migration contract/PGlite RED 테스트를 추가한다**

다음을 검증한다.

- 두 status constraint에 `rejected` 포함
- `rejected` row는 `run_id`/`run_started_at` 없음, terminal/reconciled 시각 있음, actual 0
- `reject_analysis_v2_provider_run_start`/`reject_analysis_preflight_provider_run_start` RPC
- `SECURITY DEFINER SET search_path = ''`
- `PUBLIC`, `anon`, `authenticated`은 실행 불가, `service_role`만 실행 가능
- 동일 identity 재호출만 멱등, 다른 identity/state는 충돌
- preflight `provider_start_rejected` 이벤트는 max/actual 0, provider 메시지·input·run ID 없음
- retention/readiness/unreconciled list가 `rejected`를 차단 행으로 보지 않음

- [ ] **Step 2: RED를 확인한다**

```bash
npx vitest run \
  lib/services/analysis/apify-start-rejection-migration-contract.test.ts \
  lib/services/analysis/apify-start-rejection-pglite.test.ts
```

Expected: migration/RPC 미존재로 FAIL.

- [ ] **Step 3: migration의 핵심 상태 전이를 구현한다**

Migration은 기존 constraint를 이름으로 drop/recreate하고 다음 핵심 전이를 두 RPC에 동일하게 적용한다.

```sql
UPDATE public.analysis_preflight_provider_runs AS provider_run
SET status = 'rejected',
    terminalized_at = v_now,
    actual_usage_usd = 0,
    usage_reconciled_at = v_now,
    updated_at = v_now
WHERE provider_run.preflight_id = p_preflight_id
  AND provider_run.operation_key = p_operation_key
  AND provider_run.status = 'starting'
  AND provider_run.run_id IS NULL
RETURNING provider_run.* INTO v_run;
```

V2 RPC는 `request_id`, `job_key`, `claim_token`, `operation_key`, `reservation_token`을 모두 lock/검증한 후 같은 상태로 전이한다. Preflight RPC는 `preflight_id`, `operation_key`, `claim_token`, `input_hash`, provider identity를 검증한다. Fresh-admission은 기존 operation-key-aware wrapper를 통해 같은 RPC를 사용한다.

- [ ] **Step 4: 장기 비용 이벤트를 원자적으로 기록한다**

`billing_identity_hash` 입력은 domain string, immutable provider identity, preflight/operation identity의 해시만 사용한다. `event_kind='provider_start_rejected'`, `terminal_status='rejected'`, max/actual 0, evidence hash NULL을 RPC 트랜잭션 안에서 insert한다.

- [ ] **Step 5: PGlite/contract GREEN을 확인한다**

Expected: 추가한 테스트 모두 PASS.

### Task 5: TypeScript store를 `rejected` RPC에 연결한다

**Files:**
- Modify: `lib/services/analysis/preflight-provider-run.ts`
- Modify: `lib/services/analysis/v2-provider-run-store.ts`
- Modify: 각 store 테스트

- [ ] **Step 1: status/parser/interface를 확장한다**

`PreflightProviderRunStatus`/ `ANALYSIS_V2_PROVIDER_RUN_STATUSES`에 `rejected`를 추가한다. Parser는 `rejected` 일 때 `runId=null`, `runStartedAt=null`, `terminalizedAt!=null`, `actualUsageUsd=0`, `usageReconciledAt!=null`을 강제한다.

- [ ] **Step 2: store API를 추가한다**

```ts
checkpointRejected(input: RunClaimInput & ProviderIdentity):
    Promise<StoredPreflightProviderRun>;

rejectStart(input: AnalysisV2ProviderRunIdentity & {
    reservationToken: string;
}): Promise<StoredAnalysisV2ProviderRun>;
```

각 DB name map에 새 RPC를 추가하고, `onRunStartRejected` callback은 provider identity와 현재 reservation을 검증한 후 이 API만 호출한다. HTTP status/error type은 DB에 저장하지 않는다.

- [ ] **Step 3: store/adapter 테스트 GREEN을 확인한다**

Run: Task 2의 세 테스트 파일.

Expected: 전체 PASS.

- [ ] **Step 4: 구현 커밋**

```bash
git add lib/services/instagram/providers/types.ts \
  lib/services/instagram/providers/apify-relationship.ts \
  lib/services/instagram/providers/apify.test.ts \
  lib/services/analysis/preflight-provider-run.ts \
  lib/services/analysis/preflight-provider-run.test.ts \
  lib/services/analysis/v2-provider-run-store.ts \
  lib/services/analysis/v2-provider-run-store.test.ts \
  lib/services/analysis/v2-worker-error-codes.ts \
  lib/services/analysis/preflight.ts \
  supabase/migrations/20260722110000_record_definite_apify_start_rejections.sql \
  lib/services/analysis/apify-start-rejection-migration-contract.test.ts \
  lib/services/analysis/apify-start-rejection-pglite.test.ts \
  docs/authorized-apify-sharded-e2e-runbook.md
git commit -m 'fix: persist definite Apify start rejections'
```

### Task 6: 회귀 검증·리뷰·머지를 완료한다

**Files:**
- Modify: `docs/authorized-apify-sharded-e2e-runbook.md`

- [ ] **Step 1: Secondary operation map을 문서화한다**

```dotenv
ANALYSIS_V2_APIFY_API_TOKEN_SLOT=secondary
ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT=tertiary
ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT=quaternary
ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT=secondary
ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT=secondary
ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT=quinary
ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT=quinary
```

`target-likers`/`candidate-likers`는 서로 다른 슬롯이고, 두 relationship side도 서로 다르며, profile preflight/request는 normal selected slot과 같다.

- [ ] **Step 2: 정적 검증**

```bash
npm run typecheck
npm run lint
npm run test:run
npm run build
bash scripts/test-analysis-v2-secret-scripts.sh
bash scripts/test-analysis-v2-infra-scripts.sh
git diff --check
```

Expected: 모두 exit 0. 비밀·PII 출력 없음.

- [ ] **Step 3: 리뷰 후 수정**

`review` 절차로 보안, race, SQL lock 순서, 멱등성, raw error 누출, retention 누락을 검토한다. 발견사항은 테스트를 먼저 추가한 후 수정한다.

- [ ] **Step 4: PR 생성·CI·머지**

feature branch로 바꾸어 docs+fix 커밋을 push하고 PR을 생성한다. CI 성공과 review 해소 후 squash merge한다. 머지 후 정확한 `main` SHA를 기록한다.

### Task 7: Supabase migration을 운영에 적용한다

**Files:**
- Read: `supabase/migrations/20260722110000_record_definite_apify_start_rejections.sql`

- [ ] **Step 1: 원격 migration 순서와 drift를 확인한다**

```bash
npx supabase migration list --linked
npx supabase db push --linked --dry-run
```

Expected: 새 migration 하나만 정상 순서에 대기. `--include-all` 사용 금지.

- [ ] **Step 2: migration 적용**

Run: `npx supabase db push --linked`

Expected: exit 0, 실패 또는 순서 drift 없음.

- [ ] **Step 3: 배포 후 ACL/shape 읽기 전용 검증**

DB owner query로 새 RPC는 `service_role`만 실행 가능하고, 두 constraint에 `rejected`가 있으며, raw message 컬럼이 추가되지 않았음을 확인한다.

### Task 8: Secondary 임시 E2E worker를 새 서비스로 배포한다

**Files:**
- Read: `scripts/deploy-analysis-v2-worker.sh`
- Read: `scripts/generate-analysis-v2-env-files.sh`
- External: source tree 밖 build/runtime env files

- [ ] **Step 1: 전환 직전 drain**

DB snapshot에서 processing request, processing job, active/unreconciled preflight+request provider, pending cleanup, media artifact가 모두 0인지 확인한다. `analysis-v2-pipeline`, `analysis-preflight` queue의 task 건수도 0이어야 한다.

- [ ] **Step 2: 모든 E2E 계정 한도/Actor daily quota를 즉시 재검증한다**

Selected `secondary:1`, relationship `tertiary:1`/`quaternary:1`, interaction `quinary:1`에 대해 plan, 잔여 한도, active job 0, UTC 당일 정확한 Actor run 건수를 조회한다. 하나라도 부족하면 배포/E2E를 중단한다.

- [ ] **Step 3: 새 서비스 dry-run**

외부 runtime env에 `ANALYSIS_V2_APIFY_API_TOKEN_SLOT=secondary`를 설정하고 선택 비밀 버전을 `1`로 고정한다. `ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE=analysis-worker-secondary-e2e`로 deploy script `--dry-run`을 실행한다.

Expected: 기존 서비스 변경 없이 새 서비스 생성, `APIFY_SECONDARY_API_TOKEN=ai-baram-v2-apify-secondary:1`, 필요한 tertiary/quaternary/quinary numeric refs만 출력.

- [ ] **Step 4: 새 서비스 적용·검증**

Merged SHA 소스로 deploy script를 실행하고 `--check`를 재실행한다. 정확한 소스 label, image digest, 100% 단일 revision, max instance 1, concurrency 8, gate 750/100ms, private IAM을 확인한다.

### Task 9: Vercel·Scheduler를 임시 Secondary worker로 전환한다

- [ ] **Step 1: 새 Cloud Run origin을 읽기 전용으로 구한다**

```bash
task_origin="$(gcloud run services describe analysis-worker-secondary-e2e \
  --project=gen-lang-client-0311522474 --region=asia-northeast3 \
  --format='value(status.url)')"
test -n "$task_origin"
```

- [ ] **Step 2: Vercel production 변수 네 개를 새 origin으로 교체한다**

`ANALYSIS_V2_TASKS_TARGET_URL`, `ANALYSIS_V2_TASKS_OIDC_AUDIENCE`, `PREFLIGHT_TASKS_TARGET_URL`, `PREFLIGHT_TASKS_OIDC_AUDIENCE`를 stdin으로 교체한다. 토큰 변수를 추가하지 않는다.

- [ ] **Step 3: 정확한 merged source를 Vercel production으로 배포한다**

Expected: READY, `yeosachin.vercel.app` alias, Git SHA가 merged SHA와 일치.

- [ ] **Step 4: Scheduler job 두 개를 새 origin으로 교체한다**

`analysis-v2-recovery` URI는 `/api/analysis/v2/recover`, `analysis-v2-preflight-retention` URI는 `/api/analysis/preflight/retention`을 사용한다. OIDC audience는 새 origin이다.

- [ ] **Step 5: 임의 실행 없이 구조만 검증한다**

Vercel environment name, Cloud Run ref, Scheduler URI/audience, invoker IAM을 읽기 전용으로 확인한다. 아직 E2E preflight를 생성하지 않는다.

### Task 10: 승인된 Plus E2E를 단 한 번 완료한다

- [ ] **Step 1: 브라우저 세션의 소유자를 확인한다**

로그인 이메일과 user UUID가 승인된 값과 정확히 같은지 확인한다. 인증정보는 출력하지 않는다.

- [ ] **Step 2: 새 idempotency key로 preflight를 한 번 생성한다**

대상은 정확히 `0_min._.00`, access mode는 Plus 테스트 권한, 새 key는 현재 시각으로 한 번만 생성한다. 브라우저 POST 출력이 비어도 DB에서 key를 조회하고 POST를 반복하지 않는다.

- [ ] **Step 3: preflight ready와 girlfriend exclusion `skip`을 확정한다**

Ready snapshot의 target/plan/capacity를 확인하고 exclusion을 명시적으로 `skip`처리한다.

- [ ] **Step 4: 테스트 entitlement로 request를 한 번 생성한다**

Request-bound policy가 runbook의 Secondary/tertiary/quaternary/quinary map과 같고, consumed preflight/request/owner lineage가 상호 일치하는지 확인한다.

- [ ] **Step 5: terminal까지 poll하고 중복 paid start를 금지한다**

Progress가 변경될 때만 요약한다. `starting`+run ID 없음, 미정산 비용, 실패한 quota 신호가 나오면 대체 run을 시작하지 않고 중단한다.

- [ ] **Step 6: 성공 검증**

Request `completed`, result/evidence 존재, preflight 프로필 run 재사용, 중복 profile Actor 0, 모든 provider terminal/reconciled, Gemini usage 완전, queue 0, artifact 0, 보관함의 결과 노출을 확인한다. 총 비용은 preflight/request/Cloud Run/Tasks/Gemini으로 분리해 보고한다.

### Task 11: 임시 샤딩을 제거하고 최종 Secondary worker로 전환한다

- [ ] **Step 1: E2E 정산 drain**

모든 request/preflight provider row, cleanup, artifact, task가 terminal/reconciled/0건인지 확인한다.

- [ ] **Step 2: Vercel authorized-test 정책을 비활성화한다**

`ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED=false`를 적용하고 대상/소유자/operation slot 임시 변수를 production에서 제거한 뒤 배포한다. 공개 admission 정책은 기존 값을 유지한다.

- [ ] **Step 3: `analysis-worker-secondary`를 최초 배포한다**

Merged SHA, selected `secondary`, `ai-baram-v2-apify-secondary:1`만 Apify ref로 새 서비스를 배포한다. 다른 Apify ref는 포함하지 않는다.

- [ ] **Step 4: 두 번째 Vercel/Scheduler 전환**

Task 9와 같은 절차로 최종 서비스 URL/audience를 적용한다. 전환 직전·직후 queue 0을 확인한다.

- [ ] **Step 5: 복구 전용 서비스의 invoker를 제거한다**

`analysis-worker`와 `analysis-worker-secondary-e2e`에서 task/maintenance `run.invoker` 바인딩을 제거한다. 서비스·revision·secret version은 삭제/비활성화하지 않는다.

- [ ] **Step 6: 최종 canary**

`yeosachin.vercel.app`과 인증된 worker health를 검증하고, 새 무료/paid request를 생성하지 않는다. 최종 Vercel/Cloud Run SHA, service/revision, Scheduler URI, secret numeric ref, queue 0, DB 0을 기록한다.

### Task 12: Starter 구독 후 최종 판매 출시 gate를 남긴다

- [ ] **Step 1: 현재 결과를 기능 E2E로만 표시한다**

현재 Secondary가 Free이므로 이번 성공을 Starter 판매 출시 승인으로 표시하지 않는다.

- [ ] **Step 2: 사용자가 Starter를 구매한 후 플랜을 재검증한다**

`/v2/users/me`, `/limits`, `/usage/monthly`로 같은 Secondary 계정/token의 paid Starter plan, 월간 한도, active/concurrency 한도를 확인한다. 토큰/지문/계정 식별자는 출력하지 않는다.

- [ ] **Step 3: 출시 직전 Plus E2E 1건을 다시 실행한다**

새 승인으로 Task 10을 반복한다. 이 post-upgrade E2E만 실제 Starter 판매 출시 gate를 통과한 것으로 기록한다.
