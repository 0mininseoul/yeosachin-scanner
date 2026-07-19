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
4. `scripts/configure-analysis-v2-secrets.sh`, `scripts/configure-analysis-v2-media-bucket.sh`, `scripts/configure-analysis-v2-deploy-lock.sh`를 실행한다. deploy-lock bucket 이름은 128-bit random suffix로 최초 한 번 생성해 보호된 배포 환경에 영속화하며 deployer만 접근해야 한다. deploy-lock 구성과 `--check`는 bucket metadata/IAM을 읽을 수 있는 운영자 권한으로 실행한다.
5. tracked/untracked 변경이 없는 커밋을 준비한다. 배포 스크립트는 현재 디렉터리를 올리지 않고 `git archive HEAD`로 만든 일회성 깨끗한 source tree만 업로드한다.
6. `scripts/deploy-analysis-v2-worker.sh`를 실행한다. 기존 서비스에서는 새 source와 최종 runtime 설정을 모두 무트래픽 revision으로 만들고, V2/preflight queue, 정확한 Cloud Run invoker, 유지보수 Scheduler를 검증한 뒤 검증된 revision만 100%로 승격한다. 최초 생성의 비활성 bootstrap 예외는 아래 rollback 계약을 따른다.
7. 각 스크립트를 `--check`로 다시 실행해 실제 상태와 선언 상태가 같은지 확인한다. 최소 권한 deployer의 `roles/storage.objectUser`에는 bucket metadata/IAM 조회 권한이 없으므로, deploy-lock 스크립트 검사는 구성 운영자가 별도로 수행한다.

WIF 단계의 예시는 다음과 같다.

```bash
bash scripts/configure-analysis-v2-vercel-wif.sh --dry-run
bash scripts/configure-analysis-v2-vercel-wif.sh
bash scripts/configure-analysis-v2-vercel-wif.sh --check
```

`GCP_VERCEL_WIF_PROVIDER_RESOURCE`의 `projects/...` 값에는 프로젝트 ID가 아니라 숫자 project number를 사용한다. 스크립트는 `ANALYSIS_V2_TASKS_PROJECT`에서 조회한 숫자와 일치하지 않으면 중단한다.

deploy-lock bucket은 다음처럼 최초 구성 때 한 번만 생성한다. 출력된 literal 전체를 `ANALYSIS_V2_DEPLOY_LOCK_BUCKET`으로 CI/운영자 배포 환경에 저장하고 배포마다 다시 생성하지 않는다. 128-bit suffix는 예측 가능한 전역 GCS 이름 선점을 방지한다.

```bash
printf 'ANALYSIS_V2_DEPLOY_LOCK_BUCKET=analysis-v2-lock-%s\n' \
  "$(openssl rand -hex 16)"
```

일반 apply는 기존 리소스의 예상 밖 IAM이나 Scheduler 설정을 삭제하지 않는다. 검토가 끝난 경우에만 각각 `--reconcile-iam`, `--reconcile-jobs`를 명시한다. 신규 리소스 또는 빈 정책만 선언된 최소 정책으로 초기화된다.

## Cloud Run 배포와 rollback 계약

배포 스크립트는 기존 서비스의 단일 100% traffic revision을 known-good으로 기록하고 다음 순서를 강제한다.

apply는 먼저 `ANALYSIS_V2_DEPLOY_LOCK_BUCKET` coordination bucket에 `REGION/SERVICE.lock` object를 `if-generation-match=0`으로 생성해 서비스별 배포를 직렬화한다. 이 bucket의 IAM은 `ANALYSIS_V2_DEPLOYER_IAM_MEMBER` 하나의 `roles/storage.objectUser`만 허용하고 runtime은 접근할 수 없다. bucket metadata와 IAM의 exact 검사는 구성 스크립트가 운영자 권한으로 담당하며, 배포 스크립트는 최소 권한 deployer로 object 생성/조회/삭제 능력을 실제 lock 획득 과정에서 검증한다. lock payload에는 매 실행 생성한 별도 128-bit owner token이 들어간다. 생성 응답이 유실되어 CLI가 실패를 반환해도 bounded observation으로 generation과 payload가 정확히 자기 것임을 증명하면 해당 generation을 안전하게 인수한다. generation에 귀속된 owner payload를 검증한 다음에만 획득 상태를 확정하고, 종료 시에는 획득한 정확한 generation으로만 삭제한다. 따라서 확인 전에 object가 교체되거나 실제 다른 배포가 보유한 경우 그 generation을 정리하지 않는다. 또한 승격 직전과 rollback 직전에 live traffic 소유 revision을 다시 확인하여, 다른 배포가 승격한 traffic을 stale rollback으로 덮어쓰지 않는다.

1. `git archive HEAD` source를 빌드하고 `analysis-v2-source-commit=<40자리 SHA>` revision label과 Ready 상태, immutable image digest를 검증한다. 기존 서비스에서는 `--no-traffic`을 사용한다. Cloud Run이 신규 서비스 생성에는 이 옵션을 허용하지 않으므로 최초 revision만 모든 실행 설정이 빠진 비활성 bootstrap으로 100% 배포한다.
2. canonical queue target, OIDC audience, worker/recovery gate를 별도의 `--no-traffic` 최종 revision에 적용하고 같은 SHA provenance를 다시 검증한다. 최종 revision은 동시 배포가 겹쳐도 다른 source image를 상속하지 않도록 1단계에서 검증한 정확한 digest를 `--image`로 고정한다.
3. 새 revision에 traffic을 보내지 않은 채 queue, IAM, Scheduler 구조를 검증한다. recovery Scheduler의 실행 상태는 이 구간까지 기존 live revision의 gate와 맞춰 둔다.
4. 정확한 revision 이름으로만 100% traffic을 전환하고 새 recovery gate를 pause/resume한 뒤 모든 계약을 다시 검사한다. `LATEST` 별칭은 승격과 rollback에 사용하지 않는다.
5. 승격 전 Scheduler 전환, 승격 명령, 또는 사후 검증이 실패하면 기록한 known-good 상태를 자동 복원한다. known-good recovery가 `false`면 recovery job을 먼저 pause하고 검증한 뒤 traffic을 복원한다. bootstrap으로 돌아갈 때는 recovery와 retention을 모두 먼저 pause한다. known-good recovery가 `true`면 traffic을 먼저 복원한 뒤 recovery job을 resume한다.

스크립트는 시작할 때 known-good gate에 맞는 수동 rollback 순서를 출력한다. 자동 rollback까지 실패하면 다음 순서를 지킨다. recovery-disabled 또는 bootstrap revision으로 돌아가는 경우에는 해당 pause 명령을 traffic 명령보다 먼저 실행하고 상태를 확인한다.

```bash
# known-good recovery가 false일 때 traffic 전환 전에 실행한다.
gcloud scheduler jobs pause analysis-v2-recovery \
  --project=PROJECT_ID \
  --location=asia-northeast3
# known-good가 execution-disabled bootstrap일 때만 이 pause도 함께 선행한다.
gcloud scheduler jobs pause analysis-v2-preflight-retention \
  --project=PROJECT_ID \
  --location=asia-northeast3
gcloud run services update-traffic SERVICE \
  --project=PROJECT_ID \
  --region=asia-northeast3 \
  --to-revisions=KNOWN_GOOD_REVISION=100
# known-good recovery가 true일 때만 traffic 복원 후 실행한다.
gcloud scheduler jobs resume analysis-v2-recovery \
  --project=PROJECT_ID \
  --location=asia-northeast3
```

최초 서비스 생성은 두 Cloud Run gate가 모두 `false`일 때만 허용한다. 첫 source revision에는 V2 task, worker, recovery, preflight task 실행 gate를 넣지 않고, 실제 비활성 상태와 100% traffic을 검증한 뒤 이를 bootstrap known-good rollback 대상으로 기록한다. Scheduler 생성은 최종 revision 승격 뒤로 미루며, 이후 검증 실패로 bootstrap revision에 rollback하면 인증 설정이 없는 revision에 maintenance 요청이 반복되지 않도록 recovery와 retention job을 모두 pause한다. 이후 정상 배포가 성공하면 retention은 다시 항상 `ENABLED` 상태가 된다. `--deploy-health-check`는 container startup probe와 Ready 상태만 확인하며 기능 E2E를 대신하지 않는다. 무트래픽 private revision의 인증된 tag URL canary는 아직 자동화하지 않았으므로, 공개 admission 전에는 아래 signed canary를 별도로 완료해야 한다.

비정상 종료로 lock object가 남았다면 실행 중인 배포가 없음을 Cloud Run/Cloud Build 기록으로 확인한 후에만 `gcloud storage rm gs://DEPLOY_LOCK_BUCKET/REGION/SERVICE.lock`을 수동 실행한다. `DEPLOY_LOCK_BUCKET`에는 영속화한 `ANALYSIS_V2_DEPLOY_LOCK_BUCKET` 값을 넣는다. 확인 없이 lock을 삭제하면 동시 배포 보장을 무효화한다.

## 최소 권한 계약

- runtime은 프로젝트에서 `roles/aiplatform.user`만 갖고, media bucket의 custom object create/get/delete 역할과 세 Secret Manager 리소스의 accessor만 갖는다.
- build는 프로젝트에서 `roles/run.builder`만 갖는다.
- deployer는 deploy-lock bucket에서 `roles/storage.objectUser`만 갖는다. bucket metadata/IAM exact audit는 별도 구성 운영자가 수행한다.
- runtime, build, maintenance 서비스 계정 리소스의 `roles/iam.serviceAccountUser`에는 `ANALYSIS_V2_DEPLOYER_IAM_MEMBER` 하나만 존재한다.
- V2 task OIDC 신원은 사용자 관리 키와 프로젝트 역할이 없고, actAs 멤버는 V2 enqueuer, runtime, Cloud Tasks service agent뿐이다. token creator 역할은 허용하지 않는다.
- V2 queue의 enqueuer는 V2 enqueuer와 runtime, viewer는 runtime뿐이다. preflight queue의 enqueuer는 V2 enqueuer뿐이다.
- Cloud Run `roles/run.invoker`는 V2 task OIDC와 maintenance 신원 두 개뿐이다. V1 신원은 V2 worker를 호출할 수 없다.
- media bucket은 Requester Pays, public access, object versioning, soft delete를 사용하지 않고 `Age=1` 삭제 lifecycle만 사용한다.

## 유지보수 작업

`configure-analysis-v2-maintenance.sh`는 다음 두 authenticated POST job을 exact configuration으로 관리한다.

| 작업 | 주기 | 경로 | gate별 상태 | deadline |
| --- | --- | --- | --- | --- |
| 멈춘 V2 job 복구 | 매 1분 | `/api/analysis/v2/recover` | recovery `false`: `PAUSED`, `true`: `ENABLED` | 300초 |
| preflight PII scrub/purge | 매 5분 | `/api/analysis/preflight/retention` | 항상 `ENABLED` | 60초 |

두 작업은 retry 3회, 최대 retry 기간 300초, 10~60초 backoff를 사용한다. recovery gate가 꺼진 동안 job 정의는 보존하되 pause하여 의도된 503 재시도를 만들지 않는다. gate 전환에 따른 pause/resume은 정상 reconciliation이므로 `--reconcile-jobs`가 필요 없다. schedule·URI·OIDC·retry 같은 구조적 drift가 발견되면 잘못된 작업이 계속 실행되지 않도록 apply가 해당 job을 먼저 pause하고, 명시적 `--reconcile-jobs` 승인 없이는 구조를 바꾸지 않는다. retention route는 한 번에 expired 항목 250개와 terminal 항목 250개만 요청한다. 두 route는 maintenance 서비스 계정 이메일과 Cloud Run origin audience를 모두 검증하며 브라우저 세션과 무관하게 동작한다.

rollback은 known-good recovery가 `true`여도 recovery job의 구조가 exact일 때만 resume한다. URI, audience, schedule 등이 drift된 job은 복구 과정에서도 `PAUSED`로 남겨 잘못된 endpoint를 자동 호출하지 않는다.

## 런타임 환경변수

Vercel Production에는 다음 값을 설정한다.

```dotenv
ANALYSIS_V2_ADMISSION_ENABLED=false
PREFLIGHT_ACCESS_MODE=test_entitlement
ANALYSIS_TEST_ENTITLEMENTS_ENABLED=true
ANALYSIS_TEST_ENTITLEMENT_SECRET=CANONICAL_BASE64URL_32_BYTE_SECRET
ANALYSIS_V2_TASKS_ENABLED=true
ANALYSIS_V2_TASKS_PROJECT=PROJECT_ID
ANALYSIS_V2_TASKS_LOCATION=asia-northeast3
ANALYSIS_V2_TASKS_QUEUE=analysis-v2-pipeline
ANALYSIS_V2_TASKS_TARGET_URL=https://analysis-worker.example.com/api/analysis/v2/worker
ANALYSIS_V2_TASKS_OIDC_AUDIENCE=https://analysis-worker.example.com
ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL=analysis-v2-task@PROJECT_ID.iam.gserviceaccount.com
ANALYSIS_V2_TASKS_CALLER_AUTH_MODE=vercel-wif
PREFLIGHT_TASKS_ENABLED=true
PREFLIGHT_TASKS_PROJECT=PROJECT_ID
PREFLIGHT_TASKS_LOCATION=asia-northeast3
PREFLIGHT_TASKS_QUEUE=analysis-preflight
PREFLIGHT_TASKS_TARGET_URL=https://analysis-worker.example.com/api/analysis/preflight/worker
PREFLIGHT_TASKS_OIDC_AUDIENCE=https://analysis-worker.example.com
PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL=analysis-v2-task@PROJECT_ID.iam.gserviceaccount.com
PREFLIGHT_TASKS_CALLER_AUTH_MODE=vercel-wif
GCP_VERCEL_WIF_PROVIDER_RESOURCE=projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER
ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL=analysis-v2-enqueuer@PROJECT_ID.iam.gserviceaccount.com
PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL=analysis-v2-enqueuer@PROJECT_ID.iam.gserviceaccount.com
```

queue/project/location, worker 경로를 포함한 target URL, origin만 담은 OIDC audience,
호출 대상 task 서비스 계정은 모두 작업 등록 시 필수다. `*_TASKS_ENABLED=false`이면
WIF가 정상이어도 작업을 등록하지 않으므로 운영 Vercel에는 두 값을 `true`로 둔다.
초기 구성 중에는 `ANALYSIS_V2_ADMISSION_ENABLED=false`를 유지해 신규 요청만 막는다.

`ANALYSIS_TEST_ENTITLEMENT_SECRET`는 정확히 32 random byte의 canonical base64url
인코딩이어야 하며 provider, Supabase, image proxy 또는 Cloud Tasks 비밀과
재사용하지 않는다. 같은 키를 로컬 운영자 CLI와 Vercel Production의
테스트 admission/entitlement 서명에만 사용한다. 키 자체는 브라우저로
전송하지 않는다.

Vercel 프로젝트 설정에서 OIDC 토큰 발급이 활성화되어 있어야 한다. `VERCEL_OIDC_TEAM_SLUG`, `VERCEL_OIDC_TEAM_ID`, `VERCEL_OIDC_PROJECT_ID`는 인프라 bootstrap 입력일 뿐 애플리케이션 런타임 비밀값이 아니다. `VERCEL_OIDC_TOKEN`, 서비스 계정 JSON, `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64`를 V2 작업 등록용으로 추가하지 않는다.

V1 enqueuer가 service account로 구성된 이력이 있으면 운영자 배포 환경에
`ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL`을 정확히 제공한다. Vercel Production
환경, 모든 Cloud Run revision, Cloud Tasks queue IAM을 확인해 V1 enqueuer service-account가
한 번도 구성되지 않았음을 증명한 경우에만, 그 email 대신
`ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED=true`을 명시할 수 있다. 두 값은 함께 설정하지
않으며, 이 예외에도 V1 task identity와 V2 전용 enqueuer의 분리는 그대로 검증한다.

Cloud Run worker는 다음 값을 사용한다.

```dotenv
ANALYSIS_V2_WORKER_ENABLED=false
ANALYSIS_V2_RECOVERY_ENABLED=false
ANALYSIS_V2_TASKS_CALLER_AUTH_MODE=adc
PREFLIGHT_TASKS_CALLER_AUTH_MODE=adc
```

`ANALYSIS_V2_ADMISSION_ENABLED`는 신규 preflight/분석 생성만 제어한다. 이를 끄더라도 이미 인증된 Cloud Tasks worker와 Scheduler 복구는 계속 실행되도록 `ANALYSIS_V2_WORKER_ENABLED`, `ANALYSIS_V2_RECOVERY_ENABLED`를 별도로 유지한다. worker에는 연결된 서비스 계정 ADC만 사용한다. WIF provider 입력과 Vercel OIDC 값은 넣지 않는다. 배포 스크립트가 이 경계를 검사한다.

두 Cloud Run gate는 배포 입력과 runtime 값이 각각 독립적이며 기본값은 모두 `false`다. 폐기된 `ANALYSIS_V2_WORKER_EXECUTION_ENABLED`를 설정하지 않는다. Vercel intake 전용 `ANALYSIS_V2_ADMISSION_ENABLED`도 Cloud Run revision에 존재하면 안 되며, 배포 스크립트는 두 이름을 기존 revision에서 제거한다.

Cloud Run runtime/build env manifest는 문자열 검색이 아니라 Node ENV parser와 `js-yaml`의 duplicate-엄격 YAML parser로 구조를 읽는다. 인용된 YAML key도 동일한 금지/정확 key 규칙을 적용받고, build manifest는 비어 있지 않은 공개 Supabase 두 key만 허용한다. runtime ENV 형식은 한 줄당 bare key assignment만 허용하며, 복잡한 다중 행 값은 YAML 파일로 표현한다.
검증이 완료되면 파싱한 JSON 값에서 일회성 0400 YAML snapshot을 생성하고 `gcloud`에는 이 snapshot만 전달한다. 원본 manifest 파일이 배포 중 바뀌거나 symlink target이 교체되어도 업로드 bytes는 바뀌지 않으며, snapshot은 종료 trap에서 삭제된다.

## 출시 gate 전환 순서

1. Vercel Production에 위 작업 등록 및 test-entitlement 환경변수를 배포하되 `ANALYSIS_V2_ADMISSION_ENABLED=false`를 유지한다.
2. Cloud Run을 `ANALYSIS_V2_WORKER_ENABLED=false`, `ANALYSIS_V2_RECOVERY_ENABLED=false`로 배포하고 모든 `--check`를 통과시킨다.
3. Cloud Run에서 `ANALYSIS_V2_WORKER_ENABLED=true`를 먼저 적용해 인증된 작업 처리 경로를 확인한다.
4. Cloud Run에서 `ANALYSIS_V2_RECOVERY_ENABLED=true`를 적용하고 Scheduler 복구 호출과 backlog가 정상인지 확인한다.
5. 공개 admission을 열지 않고 아래의 2단계 서명 canary를 완료한다.
6. 비용, 완전성, 5분 SLA와 rollback 점검을 모두 통과한 뒤에만 Vercel Production의 `ANALYSIS_V2_ADMISSION_ENABLED=true`를 배포한다.

### 공개 admission 전 signed canary

1. 운영자가 테스트할 로그인 사용자의 Supabase UUID, 대상 Instagram ID,
   16~128자 idempotency key를 고정한다.
2. 신뢰할 수 있는 운영자 터미널에서 다음 토큰을 발급한다.

```bash
npm run test-admission:issue -- \
  --user USER_UUID \
  --target TARGET_INSTAGRAM_ID \
  --idempotency-key CANARY_IDEMPOTENCY_KEY \
  --confirm-paid-api-call
```

3. 같은 사용자의 로그인 세션으로 `POST /api/analysis/preflight`를 호출하며,
   `Idempotency-Key` 헤더에 위 키를, `X-Analysis-Test-Admission` 헤더에
   발급된 토큰을 넣는다. 토큰은 user, target, idempotency key와 10분
   유효기간에 모두 바인딩되므로 다른 계정이나 대상으로 재사용할 수 없다.
4. preflight가 `ready`가 되고 제외 결정이 저장되면 기존 방식으로 plan-bound
   entitlement를 발급한다.

```bash
npm run test-entitlement:issue -- \
  --preflight PREFLIGHT_UUID \
  --user USER_UUID \
  --plan basic \
  --confirm-paid-api-call
```

5. 같은 로그인 세션으로 `POST /api/analysis/preflight/PREFLIGHT_UUID/entitle`를
   호출하고 `X-Analysis-Test-Entitlement`에 두 번째 토큰을 넣는다. 이 route는
   유효한 user, preflight, plan 서명이 있을 때만 공개 admission gate를 바이패스한다.

두 issuer 모두 정확히 한 번의 값 없는 `--confirm-paid-api-call`을 요구한다. 이 확인이
없으면 usable token, preflight, request, provider start가 생기지 않는다. 두 토큰은 서명 domain이 분리되어
서로 바꿔 사용할 수 없다. canary 중에도
`ANALYSIS_V2_ADMISSION_ENABLED=false`이므로 서명 토큰이 없는 일반 로그인
사용자의 preflight와 분석 시작은 계속 503으로 차단된다.

중단 시에는 신규 유입을 먼저 막기 위해 Vercel admission을 `false`로 되돌린다. 이미 등록된 작업을 안전하게 drain/복구해야 하므로 worker와 recovery gate는 별도 장애 근거가 없는 한 즉시 끄지 않는다.

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
- recovery/retention의 401은 Scheduler OIDC service account와 audience가 정확한지 확인한다. recovery gate가 `false`인데 호출이나 503 `MAINTENANCE_UNAVAILABLE`이 반복되면 recovery job이 `PAUSED`인지 먼저 확인한다.
- Scheduler 구조 drift는 먼저 `--check` 출력과 현재 job JSON을 검토한다. 의도된 교정일 때만 `--reconcile-jobs`를 사용하며, recovery gate에 따른 pause/resume에는 사용하지 않는다.
- IAM drift는 해당 리소스의 현재 policy를 별도 보관하고 principal 소유자를 확인한다. 의도된 교정일 때만 `--reconcile-iam`을 사용한다.
- source deploy가 중단되면 Git worktree가 clean하고 source dir가 worktree root이며 tracked symlink가 없는지 확인한다. 민감 파일을 `.gcloudignore`로 숨기는 방식에 의존하지 않는다.
- 배포가 promotion 뒤 실패하면 출력의 `rollback verified`와 실제 traffic revision을 함께 확인한다. 자동 rollback이 불완전하면 기록된 known-good revision과 recovery Scheduler 상태를 위 수동 명령으로 복구한 뒤 admission을 닫아 둔다.
- `--check`가 사용자 관리 키, 추가 WIF principal, 업로드한 JWK, 삭제 대기 provider 또는 provider drift를 발견하면 자동으로 넓혀서 허용하지 않는다. 원인을 검토하고 선언된 최소 권한 상태로 되돌린다.
