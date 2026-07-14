# Vercel에서 GCP Cloud Tasks를 호출하는 키리스 인증

## 목적

Vercel의 V2 분석 API와 무료 사전 조회 API는 서비스 계정 JSON 키 없이 Google Cloud Tasks에 작업을 등록한다. Vercel이 발급한 짧은 수명의 OIDC 토큰을 Google Security Token Service(STS)가 검증하고, 전용 enqueuer 서비스 계정의 짧은 수명 액세스 토큰으로 교환한다.

다음 신원은 모두 서로 달라야 하며 V1 task/enqueuer 신원도 재사용하지 않는다.

| 역할 | 신원 | 인증 방식 |
| --- | --- | --- |
| Vercel에서 작업 등록 | `ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL` | Vercel OIDC -> GCP WIF -> 서비스 계정 impersonation |
| Cloud Run 실행 및 후속 작업 등록 | `ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL` | Cloud Run 연결 ADC |
| Cloud Tasks가 worker 호출 | `ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL` | Cloud Tasks가 발급하는 대상 OIDC 토큰 |
| Scheduler가 유지보수 route 호출 | `ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL` | Cloud Scheduler가 발급하는 대상 OIDC 토큰 |
| Cloud Build source build | `ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT` | Cloud Build 연결 신원 |

이전 이름인 `ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL`은 배포 마이그레이션 기간에만 허용한다. 새 이름과 동시에 설정하면 값이 정확히 같아야 하며, 다르면 모든 관련 스크립트가 중단한다.

V1 분석 경로는 기존 ADC/호환 자격증명 처리를 그대로 유지한다. 이 문서의 WIF 설정은 V2와 preflight 호출자에만 적용한다.

## 신뢰 경계

WIF provider는 다음 불변 조건을 모두 만족하는 Vercel 토큰만 허용한다.

- 정확한 Vercel team `owner_id`
- 정확한 Vercel `project_id`
- `production` 환경

Google subject는 `<VERCEL_OIDC_PROJECT_ID>:production`으로 고정된다. 전용 enqueuer의 서비스 계정 리소스 IAM 정책 전체에는 이 subject 하나를 가진 `roles/iam.workloadIdentityUser` 바인딩만 존재해야 한다. `roles/iam.serviceAccountTokenCreator`, `roles/iam.serviceAccountOpenIdTokenCreator`, `roles/iam.serviceAccountUser`를 포함한 다른 역할이나 principal은 허용하지 않는다. enqueuer에는 사용자 관리 키와 프로젝트 전역 역할도 없어야 한다.

workload identity pool에는 구성된 provider 하나만 존재해야 한다. `--show-deleted` 목록에 비활성 또는 삭제 대기 중인 다른 provider가 있어도 검증에 실패한다. 기존 provider의 issuer, attribute mapping, 조건, allowed audience가 선언과 다르면 자동 수정하지 않고 운영자 검토를 요구한다.

두 audience 문자열은 비슷하지만 서로 바꿔 쓰면 안 된다.

- Vercel custom token audience: `https://iam.googleapis.com/<provider-resource>`
- Google STS external-account audience: `//iam.googleapis.com/<provider-resource>`

애플리케이션은 `GCP_VERCEL_WIF_PROVIDER_RESOURCE` 하나에서 두 값을 별도로 만든다. OIDC 토큰은 실제 Google 인증이 필요할 때만 요청한다. `@vercel/oidc`와 `google-auth-library`의 유효 토큰 캐시를 사용하며, 요청 컨텍스트를 벗어난 별도 OIDC 토큰 캐시는 두지 않는다.

## 최초 구성 순서

아래 작업은 인증된 운영자 터미널에서 실행한다. 먼저 모든 스크립트를 `--dry-run`으로 확인하고, 출력이 예상과 일치할 때만 실제 적용한다.

1. `.env.example`의 `ANALYSIS_V2_*`, `PREFLIGHT_*`, `GCP_VERCEL_WIF_PROVIDER_RESOURCE`, `VERCEL_OIDC_*` 값을 운영 환경에 맞게 준비한다.
2. `scripts/configure-analysis-v2-worker-identity.sh`를 실행해 전용 enqueuer를 포함한 키리스 서비스 계정들을 만든다.
3. `scripts/configure-analysis-v2-vercel-wif.sh`를 실행해 API, pool, provider와 정확한 impersonation 바인딩을 구성한다.
4. `scripts/configure-analysis-v2-secrets.sh`와 `scripts/configure-analysis-v2-media-bucket.sh`를 실행한다.
5. tracked/untracked 변경이 없는 커밋을 준비한다. 배포 스크립트는 현재 디렉터리를 올리지 않고 `git archive HEAD`로 만든 일회성 깨끗한 source tree만 업로드한다.
6. `scripts/deploy-analysis-v2-worker.sh`를 실행한다. 이 스크립트가 V2 및 preflight queue, 정확한 Cloud Run invoker, 유지보수 Scheduler job도 구성한다.
7. 각 스크립트를 `--check`로 다시 실행해 실제 상태와 선언 상태가 같은지 확인한다.

WIF 단계의 예시는 다음과 같다.

```bash
bash scripts/configure-analysis-v2-vercel-wif.sh --dry-run
bash scripts/configure-analysis-v2-vercel-wif.sh
bash scripts/configure-analysis-v2-vercel-wif.sh --check
```

`GCP_VERCEL_WIF_PROVIDER_RESOURCE`의 `projects/...` 값에는 프로젝트 ID가 아니라 숫자 project number를 사용한다. 스크립트는 `ANALYSIS_V2_TASKS_PROJECT`에서 조회한 숫자와 일치하지 않으면 중단한다.

일반 apply는 기존 리소스의 예상 밖 IAM이나 Scheduler 설정을 삭제하지 않는다. 검토가 끝난 경우에만 각각 `--reconcile-iam`, `--reconcile-jobs`를 명시한다. 신규 리소스 또는 빈 정책만 선언된 최소 정책으로 초기화된다.

## 최소 권한 계약

- runtime은 프로젝트에서 `roles/aiplatform.user`만 갖고, media bucket의 custom object create/get/delete 역할과 세 Secret Manager 리소스의 accessor만 갖는다.
- build는 프로젝트에서 `roles/run.builder`만 갖는다.
- runtime, build, maintenance 서비스 계정 리소스의 `roles/iam.serviceAccountUser`에는 `ANALYSIS_V2_DEPLOYER_IAM_MEMBER` 하나만 존재한다.
- V2 task OIDC 신원은 사용자 관리 키와 프로젝트 역할이 없고, actAs 멤버는 V2 enqueuer, runtime, Cloud Tasks service agent뿐이다. token creator 역할은 허용하지 않는다.
- V2 queue의 enqueuer는 V2 enqueuer와 runtime, viewer는 runtime뿐이다. preflight queue의 enqueuer는 V2 enqueuer뿐이다.
- Cloud Run `roles/run.invoker`는 V2 task OIDC와 maintenance 신원 두 개뿐이다. V1 신원은 V2 worker를 호출할 수 없다.
- media bucket은 Requester Pays, public access, object versioning, soft delete를 사용하지 않고 `Age=1` 삭제 lifecycle만 사용한다.

## 유지보수 작업

`configure-analysis-v2-maintenance.sh`는 다음 두 authenticated POST job을 exact configuration으로 관리한다.

| 작업 | 주기 | 경로 | deadline |
| --- | --- | --- | --- |
| 멈춘 V2 job 복구 | 매 1분 | `/api/analysis/v2/recover` | 300초 |
| preflight PII scrub/purge | 매 5분 | `/api/analysis/preflight/retention` | 60초 |

두 작업은 retry 3회, 최대 retry 기간 300초, 10~60초 backoff를 사용한다. retention route는 한 번에 expired 항목 250개와 terminal 항목 250개만 요청한다. 두 route는 maintenance 서비스 계정 이메일과 Cloud Run origin audience를 모두 검증하며 브라우저 세션과 무관하게 동작한다.

## 런타임 환경변수

Vercel Production에는 다음 값을 설정한다.

```dotenv
ANALYSIS_V2_ADMISSION_ENABLED=false
ANALYSIS_V2_TASKS_CALLER_AUTH_MODE=vercel-wif
PREFLIGHT_TASKS_CALLER_AUTH_MODE=vercel-wif
GCP_VERCEL_WIF_PROVIDER_RESOURCE=projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER
ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL=analysis-v2-enqueuer@PROJECT_ID.iam.gserviceaccount.com
PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL=analysis-v2-enqueuer@PROJECT_ID.iam.gserviceaccount.com
```

Vercel 프로젝트 설정에서 OIDC 토큰 발급이 활성화되어 있어야 한다. `VERCEL_OIDC_TEAM_SLUG`, `VERCEL_OIDC_TEAM_ID`, `VERCEL_OIDC_PROJECT_ID`는 인프라 bootstrap 입력일 뿐 애플리케이션 런타임 비밀값이 아니다. `VERCEL_OIDC_TOKEN`, 서비스 계정 JSON, `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64`를 V2 작업 등록용으로 추가하지 않는다.

Cloud Run worker는 다음 값을 사용한다.

```dotenv
ANALYSIS_V2_WORKER_ENABLED=false
ANALYSIS_V2_RECOVERY_ENABLED=false
ANALYSIS_V2_TASKS_CALLER_AUTH_MODE=adc
PREFLIGHT_TASKS_CALLER_AUTH_MODE=adc
```

`ANALYSIS_V2_ADMISSION_ENABLED`는 신규 preflight/분석 생성만 제어한다. 이를 끄더라도 이미 인증된 Cloud Tasks worker와 Scheduler 복구는 계속 실행되도록 `ANALYSIS_V2_WORKER_ENABLED`, `ANALYSIS_V2_RECOVERY_ENABLED`를 별도로 유지한다. worker에는 연결된 서비스 계정 ADC만 사용한다. WIF provider 입력과 Vercel OIDC 값은 넣지 않는다. 배포 스크립트가 이 경계를 검사한다.

두 Cloud Run gate는 배포 입력과 runtime 값이 각각 독립적이며 기본값은 모두 `false`다. 폐기된 `ANALYSIS_V2_WORKER_EXECUTION_ENABLED`를 설정하지 않는다. Vercel intake 전용 `ANALYSIS_V2_ADMISSION_ENABLED`도 Cloud Run revision에 존재하면 안 되며, 배포 스크립트는 두 이름을 기존 revision에서 제거한다.

배포된 revision에는 컨테이너가 정확히 하나만 있어야 한다. env 이름 중복, sidecar/비기본 container placement, `VERCEL*`, WIF bootstrap 입력, enqueuer identity, 서비스 계정 키나 토큰 형태의 plaintext env는 모두 검증 실패다. build 서비스 계정은 `projects/PROJECT_ID/serviceAccounts/EMAIL` 전체 리소스 이름으로 전달한다.

## 검증

로컬 단위·인프라 계약 검증은 실제 GCP 리소스를 변경하지 않는다.

```bash
npx vitest run \
  lib/services/google/vercel-wif.test.ts \
  lib/services/analysis/background-tasks.test.ts \
  lib/services/analysis/v2-tasks.test.ts \
  lib/services/analysis/preflight-tasks.test.ts \
  lib/services/analysis/v2-maintenance-auth.test.ts \
  lib/services/analysis/preflight-retention.test.ts \
  lib/services/analysis/preflight-retention-route.test.ts \
  lib/services/analysis/v2-recovery-route.test.ts
bash scripts/test-analysis-v2-vercel-wif.sh
bash scripts/test-analysis-v2-secret-scripts.sh
bash scripts/test-analysis-v2-source-archive.sh
bash scripts/test-analysis-v2-infra-scripts.sh
```

운영 E2E는 WIF 적용, Cloud Run 배포, queue 구성, Vercel Production 환경변수 배포가 모두 끝난 뒤 수행한다. Production에 묶인 provider이므로 preview/development 토큰이 거부되는 것이 정상이다.

## 장애 확인

- 설정 파싱 단계에서 실패하면 두 caller mode가 런타임에 맞는지 먼저 본다. Vercel은 `vercel-wif`, Cloud Run은 `adc`여야 한다.
- STS의 audience 오류는 `https://...`와 `//...`를 뒤바꾸지 않았는지 확인한다.
- impersonation 거부는 enqueuer 서비스 계정 IAM의 정확한 subject 바인딩과 Vercel `owner_id`, `project_id`, `environment` 조건을 확인한다.
- queue 등록 권한 거부는 전용 enqueuer가 대상 queue에만 필요한 권한을 갖는지 확인한다. 문제를 피하려고 프로젝트 전역 `roles/cloudtasks.enqueuer`를 부여하지 않는다.
- recovery/retention의 401은 Scheduler OIDC service account와 audience가 정확한지 확인한다. 503 `MAINTENANCE_UNAVAILABLE`은 worker runtime env의 maintenance 설정을 확인한다.
- Scheduler job drift는 먼저 `--check` 출력과 현재 job JSON을 검토한다. 의도된 교정일 때만 `--reconcile-jobs`를 사용한다.
- IAM drift는 해당 리소스의 현재 policy를 별도 보관하고 principal 소유자를 확인한다. 의도된 교정일 때만 `--reconcile-iam`을 사용한다.
- source deploy가 중단되면 Git worktree가 clean하고 source dir가 worktree root이며 tracked symlink가 없는지 확인한다. 민감 파일을 `.gcloudignore`로 숨기는 방식에 의존하지 않는다.
- `--check`가 사용자 관리 키, 추가 WIF principal, 업로드한 JWK, 삭제 대기 provider 또는 provider drift를 발견하면 자동으로 넓혀서 허용하지 않는다. 원인을 검토하고 선언된 최소 권한 상태로 되돌린다.
