# Dev 실제 분석 준비와 검증

Dev의 기본 분석은 합성 데이터로 진행한다. 실제 분석 옵션은 승인된 카카오 운영자가 Dev 전용 인프라에서 Basic 한 건을 검증하는 용도다. 테스트 이용권으로 결제 단계를 대체하고, 사전 점검·큐·워커·진행·결과는 운영과 같은 애플리케이션 코드로 검증한다.

## 현재 준비 상태

11월 18일 Dev DB 읽기 전용 확인에서 public 테이블 150개와 합성 주문용 `dev_ui` 테이블 3개를 확인했다. `account_e2e_test_runners`, `account_ledger_rollout_state`, `analysis_provider_admission_budgets`, `analysis_provider_usage_expectations`, `analysis_v2_provider_execution_policies`, `earlybird_plan_inventory`는 존재하며 모두 0행이었다. 따라서 기준점만으로는 실제 처리에 필요한 Dev 등록이나 공급자 실행 정책이 준비되지 않는다.

현재 운영 GCP 프로젝트의 서울 리전과 접근 가능한 프로젝트 목록에는 이 실행 계약에 맞는 Dev 서비스·큐·전용 자격 증명이 확인되지 않았다. 격리 프로젝트 `yeosachin-dev-live-261118`을 별도로 생성하고 프로젝트 활성 상태와 결제 미연결을 확인했다. 운영 Cloud Run이 속한 `Ascentum`(`gen-lang-client-0311522474`)은 기존 결제 연결을 사용할 수 있는 배치 대안이다. 기존 Dev 서비스의 모의 분석은 Dev Vercel 및 Dev Supabase에서 실행한다. 운영의 Secret Manager 설정과 과거 검증용 Cloud Run 서비스는 독립 Dev 구성의 증거가 되지 않는다.

## Dev 리소스 계약

| 대상 | 값과 검증 방법 |
| --- | --- |
| 웹 | 등록된 `yeosachin-dev` Vercel 프로젝트의 production 슬롯과 `https://dev.yeosachin.com`. 기존 카카오 로그인과 등록된 tester를 사용한다. |
| DB / Auth | 등록된 Dev Supabase 프로젝트. 브라우저 빌드와 서버 런타임이 같은 프로젝트를 사용한다. |
| GCP | 기본 배치는 별도 Dev 프로젝트다. 기존 결제 연결 사용을 위해 `DEV_LIVE_GCP_PLACEMENT=ascentum_shared`를 선택하면 실제 Ascentum ID `gen-lang-client-0311522474`와 숫자 ID `919163272964`의 조합만 허용한다. `DEV_LIVE_GCP_PROJECT`, `DEV_LIVE_GCP_PROJECT_NUMBER`, `GOOGLE_CLOUD_PROJECT`를 선택한 배치에 맞춘다. |
| Cloud Run | 서울 `asia-northeast3`, IAM 인증이 필수인 서비스 `dev-live-preflight`와 `dev-live-paid`. GCP가 발급한 각 서비스의 기본 URL을 `DEV_LIVE_PREFLIGHT_ORIGIN`, `DEV_LIVE_PAID_ORIGIN`에 넣는다. 계약상 `https://dev-live-<role>-<Dev 프로젝트 숫자 ID>.asia-northeast3.run.app` 형식이다. |
| Cloud Tasks | 같은 Dev 프로젝트·서울 리전의 큐 `dev-live-preflight`, `dev-live-paid`. 각각 `/api/analysis/preflight/worker`, `/api/analysis/v2/worker`만 POST로 전달한다. OIDC audience는 해당 서비스 origin이다. |
| IAM | 역할별 OIDC invoker `dev-live-preflight-invoker`, `dev-live-paid-invoker`에 해당 Dev 서비스의 invoke 권한만 부여한다. 두 Dev 워커는 각자 Dev 런타임 서비스 계정으로 ADC를 사용한다. Vercel은 Dev WIF pool/provider `dev-live-vercel/dev-live-vercel`을 통해 `dev-live-vercel-enqueuer`를 사용한다. Dev 팀·project ID·production 슬롯을 WIF 조건에 고정한다. |
| 미디어 | Dev GCS `<Dev 프로젝트 ID>-dev-live-media`를 private intermediate artifact에 사용한다. Dev R2 `<Dev 프로젝트 ID>-dev-live-results`는 결과 이미지 저장용이며 키는 이 버킷으로 제한한다. Web reader와 worker writer에 필요한 권한만 각각 부여한다. |

Ascentum 배치에서는 `dev-live-*` 이름과 전용 권한으로 기존 워커·큐와 실행 경로를 나눈다. 프로젝트의 결제와 프로젝트 단위 할당량은 함께 사용한다. 배포 대상은 Dev 이름의 신규 리소스다. Cloud Run과 Cloud Tasks의 URL 및 OIDC 제약은 공식 계약에 따른다. [Cloud Run HTTPS URL](https://docs.cloud.google.com/run/docs/triggering/https-request) · [Cloud Tasks OIDC](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks)

## 호출 0회로 준비하는 순서

1. 기존 Dev DB의 live preflight·판매 없이 처리하는 entitlement·fresh admission·provider budget/lease·진행·결과 RPC의 이름과 실제 권한을 현재 후보 코드와 비교한다. 10월 기준점과 최신 migration 목록의 차이는 이 호출 목록으로 좁힌다. 특히 63바이트로 저장된 provider capacity mark RPC를 실제 카탈로그 이름으로 확인한다. [Dev 기준점과 기존 검증](../../supabase/dev-ui/README.ko.md)
2. Dev 프로젝트임을 재확인한 뒤 부족한 정의와 seed만 별도 SQL로 검토한다. 테스트 이용권 사용자는 현 카카오 allowlist의 Dev 계정 한 명을 existing principal RPC로 분류하고, 활성 `e2e_test` runner의 서버 `app_metadata`와 registry 값을 모두 Basic으로 설정한다. 사용할 역할 및 Dev 토큰 슬롯에 필요한 Apify·Gemini admission budget과 공급자 비용을 위한 한도를 준비한다. 운영 주문·인벤토리·자격 증명 같은 행을 복제하지 않는다. 원격 migration 이력을 수정하거나 보호 migration을 재적용하지 않는다.
3. 선택한 프로젝트에서 Dev 전용 런타임·invoker·Vercel enqueuer IAM을 분리한다. Ascentum에서는 운영 리소스의 설정 요약과 IAM 기준 해시를 먼저 확인하고 Dev에 속하는 신규 리소스에만 권한을 지정한다. Vercel에는 두 Dev 큐의 enqueue/get 및 두 Dev invoker의 제한된 actAs만 부여한다. 워커에는 해당 큐의 enqueue/get, 자기 Dev 버킷·Secret의 역할별 권한만 부여한다. 큐는 검사 단계에서 중지하고 동시 실행 한도를 1로 설정한다. 큐 설정의 URL·OIDC 덮어쓰기가 없는지, Cloud Run에 공개 invoke 권한이 없는지 native metadata에서 확인한다. 기존 배포자의 운영 activation 루틴을 실행하지 않는다.
4. Dev 자격 증명 저장소에서 Dev Supabase 서버 키, Apify 슬롯별 Dev 토큰, Dev Vertex IAM, 이미지 서명 키와 Dev R2 자격 증명을 마련한다. 워커 Secret 값은 Secret Manager version reference로만 공급한다. Dev 웹의 `LANDING_LEAD_CAPTURE_SECRET`은 Dev 전용 값을 사용해 제외 선택의 식별 정보를 Dev DB 안에서 연결한다. Vercel 토큰이나 Secret 값을 내려받아 터미널·문서·파일에 남기지 않는다. 사전 점검·분석에서 사용할 운영 공급자 정책은 이름·모델·제한값만 확인해 Dev 설정에 맞춘다.
5. 리뷰된 같은 후보에서 Dev 웹과 두 워커를 각각 빌드한다. 워커 환경은 `DEV_LIVE_WORKLOAD`와 `ANALYSIS_WORKLOAD_ROLE`를 실제 역할 `preflight` 또는 `paid`로 맞춘다. 각 역할은 해당 namespace의 `*_TASKS_ENABLED`, `*_TASKS_PROJECT`, `*_TASKS_LOCATION`, `*_TASKS_QUEUE`, `*_TASKS_TARGET_URL`, `*_TASKS_OIDC_AUDIENCE`, `*_TASKS_SERVICE_ACCOUNT_EMAIL`, `*_TASKS_CALLER_AUTH_MODE=adc`를 사용한다. Web은 양쪽 namespace에 `vercel-wif`, `*_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL`, 정확한 Dev `GCP_VERCEL_WIF_PROVIDER_RESOURCE`를 지정한다.
6. `DEV_LIVE_ANALYSIS_ARMED`는 꺼 두고 승인값을 만들지 않는다. `PREFLIGHT_LOCAL_AFTER_ENABLED`, `ANALYSIS_BETA_PREPARE_ENABLED`, `BETATEST_FREE_POOL_ENABLED`, `PREFLIGHT_TASKS_RECOVERY_ENABLED`, `ANALYSIS_V2_RECOVERY_ENABLED`, `ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED`는 끈다. Dev infra metadata·큐 조회 권한·리소스 일치, 승인 전 API 차단, 기존 모의 분석을 확인한다. 정상 워커 경로는 외부 공급자 함수의 모의 구현 또는 오프라인 회귀로 검사한다.

## 실행 정책 및 비용

Dev의 테스트 승인 대상은 Basic 한 건이다. Dev 웹은 `ANALYSIS_V2_ADMISSION_ENABLED=true`로 설정하고, 사전 점검에 기록할 정책을 운영과 맞춘다. `ANALYSIS_V2_GENDER_RESOLUTION_ROLLOUT`, `ANALYSIS_V2_NARRATIVE_V28_ROLLOUT`, `ANALYSIS_V2_AI_MICROBATCH_V29_ROLLOUT`, `ANALYSIS_V2_GENDER_SUMMARY_QUALITY_V211_ROLLOUT`, `ANALYSIS_V2_AI_SCHEDULER_ROLLOUT`에는 `production`을 지정하고, `ANALYSIS_V2_VERTEX_AI_COST_OPTIMIZATION_V212_ROLLOUT`에는 `off`를 지정한다.

두 Dev 워커는 `ANALYSIS_PROVIDER_ADMISSION_ENABLED=true`, `ANALYSIS_V2_INSTAGRAM_ROUTE=apify_v1`, `VERTEX_AI_BUDGET_GUARD_ENABLED=true`, `VERTEX_AI_BUDGET_STORE=supabase`를 요구한다. 정식 분석 워커는 `ANALYSIS_V2_WORKER_ENABLED=true`가 필요하다. 아래 개별 보호 한도도 승인값을 초과하지 않아야 한다.

- Vertex `VERTEX_AI_PER_RUN_BUDGET_USD`, `VERTEX_AI_PER_ORDER_BUDGET_USD`, `VERTEX_AI_DAILY_BUDGET_USD`의 양수 합의값은 해당 실행의 Vertex 승인 상한 이하다.
- Apify는 두 워커에 `APIFY_PROFILE_MAX_ESTIMATED_COST_USD_PER_OPERATION`을 지정한다. 정식 분석 워커에는 `APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION`, `APIFY_LIKERS_MAX_ESTIMATED_COST_USD_PER_OPERATION`, `APIFY_COMMENTS_MAX_ESTIMATED_COST_USD_PER_OPERATION`을 추가한다. 값은 양수이며 각 승인 상한을 넘지 않도록 한다.
- 제안 상한은 Apify Actor 요금 `$5`, Vertex `$2`이다. actor start와 Vertex 호출 전에 Dev DB의 공용 예약 원장을 사용해 승인 ID별로 합산하고, 재시도가 중복 비용을 발생시키지 않는지 검증한다. Actor 실행 과금 상한 설정과 AI 비용 산정 방식은 실제 공급자 요금과 별도로 대조한다. 디스크, GCS/R2, 데이터 전송, 공급자 요금제 조건의 별도 비용은 이 실행 한도에 포함되지 않는다.

## 승인 전 운영자 점검

- Dev 웹에서 실제 모드가 비용 승인 전 차단되고 기존 카카오 세션에서만 합성 분석이 가능한지 확인한다. 정확한 후보 코드, Dev 도메인, DB 식별자, private Cloud Run IAM, Dev 리소스 및 승격 후보의 코드 일치를 안전한 메타데이터로 남긴다.
- Dev·운영의 Apify Actor/단위 과금과 AI 프로젝트·모델의 최신 스냅샷을 대조한다. Dev DB의 비용 예약 RPC를 적용하고 mock 실행에서 성공·실패·동시 요청·재시도를 검증하기 전까지 다음 단계로 이동하지 않는다. Actor의 실행 과금 상한과 AI 요청별 토큰/재시도 예약을 각각 확인한다.
- 서버 승인에는 대상 한 개, 승인 시간, 30분 이내 만료, Apify·AI별 상한을 포함한다. 같은 승인으로 새 preflight·이용권이 중복 발행되지 않는지 확인한다. 실패 후 자동으로 새 비용을 발생시키는 경로가 없음을 모의 테스트에서 먼저 확인한다.
- 첫 공급자 호출은 비용 승인 이후 사용자가 해당 Dev 실행을 직접 시작할 때 발생한다. 비용 승인이 미확정이거나 Dev 자격 증명·큐·워커·DB 필수 설정 중 하나가 없으면 실제 모드는 잠겨 있다.
