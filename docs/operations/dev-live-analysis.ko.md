# Dev 실제 분석 준비와 검증

Dev의 기본 분석은 합성 데이터로 진행한다. 실제 분석 옵션은 등록된 카카오 운영자 한 명이 Dev 전용 인프라에서 Basic과 별도로 승인된 대상의 Standard를 검증하는 용도다. 운영자는 직접 시작할 때마다 1회 예산을 자동으로 받는다. 테스트 이용권으로 결제 단계를 대체하고, 사전 점검·큐·워커·진행·결과는 운영과 같은 애플리케이션 코드로 검증한다.

## 현재 준비 상태

11월 18일 Dev DB 초기 설정에서 Basic 테스트 실행자 1명, 공급자 동시 실행·속도 한도 22개, Gemini lease 8개를 설정했다. 시작 전 Apify 슬롯 10개는 잔액 미확인 상태이며, 과금 승인 사용·비용 예약·실제 요청·결제 주문은 각각 0건으로 확인했다. 과거 미과금 격리 프로젝트 `yeosachin-dev-live-261118`은 삭제 요청 상태다. Dev 워커와 큐는 기존 운영 프로젝트 Ascentum의 별도 `dev-live-*` 리소스로 구성한다.

Dev와 운영의 구매 전 사전 점검 워커는 `PREFLIGHT_PROFILE_PROVIDER=apify_pool`로 동작한다. 로그인 여부, B-lite 참여 여부와 관계없이 새 프로필 수집에는 non-secondary Apify 슬롯 9개만 사용한다. 유효한 익명 캐시는 재사용하며, 여유 있는 슬롯이 없으면 용량 대기로 처리한다. Dev는 승인된 운영 Apify 슬롯의 Secret 버전을 참조한다. DB가 최근 잔액과 내부 예약을 확인해 슬롯을 선택한다. 슬롯 예약에 사용 가능한 잔액 정보가 없으면 승인된 작업을 사용자가 시작하고 워커가 DB claim을 확보한 뒤에만 잔액을 갱신한다. 무료 슬롯에서 시작한 기존 실행은 같은 슬롯으로 재개한다. 기존 사전 점검 실행에 secondary가 기록돼 있으면 공급자 호출 전에 차단한다. 사용자가 Basic을 선택한 뒤 최신 프로필 확인에서 Apify로 넘어갈 때와 정식 분석에서 Apify를 호출할 때 `secondary`를 사용한다. Dev와 운영은 Apify 계정 잔액을 공유한다.

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

Ascentum Dev에서 최신 프로필 확인용 기존 DB 래퍼가 명시적 `secondary` 예약을 거절하면, 정확한 Dev 프로젝트에만 [Dev 전용 SQL](../../supabase/dev-ui/live-fresh-admission-secondary.sql)을 적용한다. 이 SQL은 기존 함수 본문과 권한을 검증하고 자동 선택의 non-secondary 제한을 보존한다.

1. 기존 Dev DB의 live preflight·판매 없이 처리하는 entitlement·fresh admission·provider budget/lease·진행·결과 RPC의 이름과 실제 권한을 현재 후보 코드와 비교한다. 10월 기준점과 최신 migration 목록의 차이는 이 호출 목록으로 좁힌다. 특히 63바이트로 저장된 provider capacity mark RPC를 실제 카탈로그 이름으로 확인한다. [Dev 기준점과 기존 검증](../../supabase/dev-ui/README.ko.md)
2. Dev 프로젝트임을 재확인한 뒤 부족한 정의와 seed만 별도 SQL로 검토한다. 테스트 이용권 사용자는 현 카카오 allowlist의 Dev 계정 한 명을 existing principal RPC로 분류하고, 활성 `e2e_test` runner의 서버 `app_metadata`와 registry 값을 모두 Basic으로 설정한다. 사용할 역할 및 Dev 토큰 슬롯에 필요한 Apify·Gemini admission budget과 공급자 비용을 위한 한도를 준비한다. 운영 주문·인벤토리·자격 증명 같은 행을 복제하지 않는다. 원격 migration 이력을 수정하거나 보호 migration을 재적용하지 않는다.
3. 선택한 프로젝트에서 Dev 전용 런타임·invoker·Vercel enqueuer IAM을 분리한다. Ascentum에서는 운영 리소스의 설정 요약과 IAM 기준 해시를 먼저 확인하고 Dev에 속하는 신규 리소스에만 권한을 지정한다. Vercel에는 두 Dev 큐의 enqueue/get 및 두 Dev invoker의 제한된 actAs만 부여한다. 워커에는 해당 큐의 enqueue/get과 역할별 Dev 저장소 권한을 부여한다. 승인된 운영 Apify Secret은 preflight에 non-secondary 9개, 정식 분석에 secondary 1개의 접근 권한만 부여한다. 큐는 검사 단계에서 중지하고 동시 실행 한도를 1로 설정한다. 큐 설정의 URL·OIDC 덮어쓰기가 없는지, Cloud Run에 공개 invoke 권한이 없는지 native metadata에서 확인한다. 기존 배포자의 운영 activation 루틴을 실행하지 않는다.
4. Dev Supabase 서버 키, Dev Vertex IAM, 이미지 서명 키와 Dev R2 자격 증명을 마련한다. Apify는 승인된 기존 Secret의 현재 버전을 역할별로 고정 참조한다. 워커 Secret 값은 Secret Manager version reference로만 공급한다. Dev 웹의 `LANDING_LEAD_CAPTURE_SECRET`은 Dev 전용 값을 사용해 제외 선택의 식별 정보를 Dev DB 안에서 연결한다. Vercel 토큰이나 Secret 값을 내려받아 터미널·문서·파일에 남기지 않는다. 사전 점검·분석에서 사용할 운영 공급자 정책은 이름·모델·제한값만 확인해 Dev 설정에 맞춘다.
5. 리뷰된 같은 후보에서 Dev 웹과 두 워커를 각각 빌드한다. 워커 환경은 `DEV_LIVE_WORKLOAD`와 `ANALYSIS_WORKLOAD_ROLE`를 실제 역할 `preflight` 또는 `paid`로 맞춘다. 각 역할은 해당 namespace의 `*_TASKS_ENABLED`, `*_TASKS_PROJECT`, `*_TASKS_LOCATION`, `*_TASKS_QUEUE`, `*_TASKS_TARGET_URL`, `*_TASKS_OIDC_AUDIENCE`, `*_TASKS_SERVICE_ACCOUNT_EMAIL`, `*_TASKS_CALLER_AUTH_MODE=adc`를 사용한다. Web은 양쪽 namespace에 `vercel-wif`, `*_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL`, 정확한 Dev `GCP_VERCEL_WIF_PROVIDER_RESOURCE`를 지정한다.
6. 검증 중에는 `DEV_LIVE_ANALYSIS_ARMED`를 끈다. 웹과 두 워커의 검증이 끝나면 모두 `DEV_LIVE_ANALYSIS_MODE=owner_start`, `DEV_LIVE_ANALYSIS_ARMED=true`로 맞춘다. 이 모드에서는 웹과 워커가 만료 시각이 고정된 공용 환경 변수 승인을 사용하지 않는다. `PREFLIGHT_LOCAL_AFTER_ENABLED`, `ANALYSIS_BETA_PREPARE_ENABLED`, `BETATEST_FREE_POOL_ENABLED`, `PREFLIGHT_TASKS_RECOVERY_ENABLED`, `ANALYSIS_V2_RECOVERY_ENABLED`, `ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED`는 끈다. Dev infra metadata·큐 조회 권한·리소스 일치, 승인 전 API 차단, 기존 모의 분석을 확인한다. 정상 워커 경로는 외부 공급자 함수의 모의 구현 또는 오프라인 회귀로 검사한다.

## 실행 정책 및 비용

Dev 웹은 `ANALYSIS_V2_ADMISSION_ENABLED=true`로 설정하고, 사전 점검에 기록할 정책을 운영과 맞춘다. `ANALYSIS_V2_GENDER_RESOLUTION_ROLLOUT`, `ANALYSIS_V2_NARRATIVE_V28_ROLLOUT`, `ANALYSIS_V2_AI_MICROBATCH_V29_ROLLOUT`, `ANALYSIS_V2_GENDER_SUMMARY_QUALITY_V211_ROLLOUT`, `ANALYSIS_V2_AI_SCHEDULER_ROLLOUT`에는 `production`을 지정하고, `ANALYSIS_V2_VERTEX_AI_COST_OPTIMIZATION_V212_ROLLOUT`에는 `off`를 지정한다.

두 Dev 워커는 `ANALYSIS_PROVIDER_ADMISSION_ENABLED=true`, `ANALYSIS_V2_INSTAGRAM_ROUTE=apify_v1`, `VERTEX_AI_BUDGET_GUARD_ENABLED=true`, `VERTEX_AI_BUDGET_STORE=supabase`를 요구한다. 정식 분석 워커는 `ANALYSIS_V2_WORKER_ENABLED=true`가 필요하다. 아래 개별 보호 한도도 승인값을 초과하지 않아야 한다.

- 워커 공용 Vertex `VERTEX_AI_PER_RUN_BUDGET_USD`, `VERTEX_AI_PER_ORDER_BUDGET_USD`, `VERTEX_AI_DAILY_BUDGET_USD`는 양수이며 Basic 기준 `$2` 이하다. 운영자 시작 모드에서는 각 실행에 발급한 Dev 비용 원장 한도를 사용한다.
- Apify는 두 워커에 `APIFY_PROFILE_MAX_ESTIMATED_COST_USD_PER_OPERATION`을 지정한다. 정식 분석 워커에는 `APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION`, `APIFY_LIKERS_MAX_ESTIMATED_COST_USD_PER_OPERATION`, `APIFY_COMMENTS_MAX_ESTIMATED_COST_USD_PER_OPERATION`을 추가한다. 공용 설정은 양수이며 Basic 기준 `$5` 이하다.
- 1회 상한은 Basic에서 Apify Actor 요금 `$5`와 Vertex `$2`, 승인된 Standard 대상에서 Apify Actor 요금 `$6`과 Vertex `$4`이다. Dev DB의 공용 예약 원장은 각 호출 전 같은 승인 ID의 공급자별 누적액을 검사한다. 한도를 넘는 호출은 차단한다. Vertex는 호출의 전체 입력 한도까지 선예약하고 완전한 사용량이 기록된 경우에만 차액을 반환한다. 디스크, GCS/R2, 데이터 전송, 공급자 요금제 조건의 별도 비용은 이 실행 한도에 포함되지 않는다.

## 운영자 시작과 검증

- [Dev 전용 상시 승인 SQL](../../supabase/dev-ui/live-owner-start.sql)은 Dev 비용 원장 다음에 적용한다. DB는 서버가 확인한 활성 Basic 카카오 운영자와 실제로 시작한 대상·시도 ID에 새 실행을 묶는다. 같은 버튼 요청의 재전송은 동일한 승인을 사용하고, 각각의 새 시작에서 별도 상한을 적용한다.
- Dev 웹은 검증된 카카오 이메일 하나와 등록된 계정만 허용한다. 로그인, 페이지 방문, 상태 조회는 실행을 만들지 않는다. 운영자가 동일 오리진에서 실제 사전 점검을 시작한 뒤 인증된 워커가 DB 요청과 승인 ID를 검증하면 공급자 호출이 가능하다.
- 실제 분석에서는 운영과 같은 사전 점검 미리보기 및 진행·결과 컴포넌트를 사용한다. 미리보기 상태 조회는 Dev 운영자가 소유한 실제 사전 점검의 기존 결과만 읽는다. Dev는 비용 확인과 테스트 이용권으로 결제 단계를 대체하며 실제 데이터 표시를 추가한다.
- Basic 공급자 승인은 시작부터 30분이다. Standard의 사전 점검과 이용권 발급은 기존 30분 안에 진행한다. 접수된 Standard 분석의 공급자 호출은 시작 시점부터 최대 150분 동안 같은 승인을 사용한다. 새 실행에는 사용자의 시작 동작과 별도 예산이 필요하다. 만료된 실행에서는 새 공급자 호출과 이용권 발급을 차단한다. 이전 결과는 계속 조회할 수 있다.
- Standard를 열려면 예산과 대상에 대한 운영자 승인 후 [Standard 승인 SQL](../../supabase/dev-ui/live-owner-start-standard.sql), [사전 점검 재전송 SQL](../../supabase/dev-ui/live-standard-preflight-replay.sql), [최신 정보 확인 SQL](../../supabase/dev-ui/live-standard-fresh-admission.sql), [정식 분석 프로필 체크포인트 SQL](../../supabase/dev-ui/live-standard-fresh-profile-checkpoint.sql)을 순서대로 등록된 Dev DB에 적용한다. 승인된 대상 하나를 Dev DB의 `dev_live_budget.standard_owner_policy`에 등록한다. 같은 대상의 `DEV_LIVE_STANDARD_TARGET`을 Dev 워커 두 개에 먼저 설정하고 검증한 뒤 Dev 웹에 설정한다. 생성과 이용권 발급은 Dev 운영자 세션, 요청 대상, 확인한 플랜, DB 승인이 일치할 때 진행된다. 정책을 비활성화하면 해당 Standard 승인으로 새 비용을 예약할 수 없다.
- 11월 19일 Dev Standard가 접수 직후 대상 프로필 단계에서 중단됐다. 프로필 체크포인트의 조회·저장이 운영 결제 주문을 검증하고 있었다. Dev용 SQL은 연결된 사전 점검과 실제로 소비된 Standard 이용권, 현재 운영자 승인, 작업과 공급자 실행 증거를 검증해 결제 없는 Dev 요청을 처리한다.
- 같은 날 17:15 재시도는 대상 프로필과 좋아요 수집까지 완료했고 댓글 수집 Actor의 시작 거절로 17:15:41에 종료됐다. 댓글 실행 ID와 댓글 사용액은 각각 없음과 0달러로 기록됐다. 당시 워커는 코드에 고정된 `0.0.588`을 사용했으며 공급자의 HTTP 상태와 세부 오류 코드는 남지 않았다. Dev 정식 분석 워커에는 입력 계약을 확인한 `APIFY_COMMENTS_BUILD=0.0.682`를 사용한다. 이 버전은 Apify가 성공으로 표시한 공개 빌드다. 새 공급자 실행 없이 배포와 모의 검증을 진행한다. 정식 분석에서 시작이 다시 거절되면 Cloud Run의 `analysis_v2_apify_start_rejected` 이벤트에서 작업 종류, HTTP 상태, 허용된 오류 코드만 조회한다. [공개 빌드](https://api.apify.com/v2/actors/apify~instagram-comment-scraper/builds/default)
- Dev에서 분석 시작을 누르면 즉시 최신 계정 정보 확인 화면으로 전환한다. 사전 점검이 아직 처리 중이면 서버가 안내한 간격으로 같은 승인 요청의 상태를 확인한다. 서버가 정식 분석 요청 ID를 확인한 뒤 진행 화면으로 이동한다.
- 11월 19일 19:18 Dev Standard 검증에서 댓글 수집 빌드 `0.0.682`가 시작됐고 정상 종료됐다. 이후 19:19:39에 팔로워와 팔로잉 수집이 모두 Apify `403 build-not-found`를 반환했다. 두 관계 실행은 만들어지지 않았고 사용액은 각각 0달러로 기록됐다. 당시 관계 수집 빌드는 `0.0.71`이었다. Dev 정식 분석 워커의 `APIFY_RELATIONSHIP_BUILD`를 공개 성공 빌드 `0.0.96`으로 지정한다. 배포 전 Actor 빌드 상태와 기존 입력·출력 필드를 비교하고 합성 데이터로 두 요청의 옵션과 파싱을 확인한다. 대상의 관계 수는 Free API의 회당 1,000건 상한 범위에 있으며 실제 수집 완전성은 공급자 실행에서 확인한다. 재실행 전에 secondary의 현재 무료 잔액과 이번 실행 승인을 확인한다. [관계 수집 빌드](https://api.apify.com/v2/actors/scraping_solutions~instagram-scraper-followers-following-no-cookies/builds/default) · [Free API 한도](https://apify.com/scraping_solutions/instagram-scraper-followers-following-no-cookies#free-usage-limits)
- 11월 19일 20:04 Dev Standard 실행은 관계와 상호작용 수집을 통과한 뒤 20:31:44에 종료됐다. Vertex 원장의 정산 추정액 `$0.902444`와 HTTP `429` 응답 6건의 미정산 예약 `$1.603584`에 다음 호출의 보수적 예약 `$1.634304`를 더하면 `$4.140332`가 된다. `$4.140332`는 차단 판단에 사용한 합계다. Dev 워커는 SDK가 실제 HTTP `429`를 반환한 해당 호출만 0원으로 정산한다. 전송 상태가 모호하거나 사용량이 불완전한 성공 응답은 선예약액을 유지한다. Standard Vertex 상한은 `$4`다. [Google Cloud 과금 기준](https://cloud.google.com/model-garden/pricing?e=48754805)
- 진행 상태 응답은 완료 작업 수와 별도로 DB가 앞서 보존한 진행률을 읽는다. 현재 완료 수로 산출한 하한과 전체 0~100% 범위를 검사한다. 이를 통해 기존 진행률을 보존하면서 실패 상태를 화면에 표시한다.
- 후보 코드, Dev 도메인, DB 식별자, Cloud Run IAM, 큐 상태를 확인한다. 단위 검증은 인증 실패, 같은 요청 재전송, 대상 불일치, 승인 만료, 비용 상한, 공급자 호출 없는 가용성 조회를 포함한다.
