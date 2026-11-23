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

Dev Standard에 저장 수집본을 준비하는 동안 해당 QA 대상의 시작과 전달을 중지한다. 수집 모드 `DEV_LIVE_STANDARD_COLLECTION_MODE`가 미설정이면 Standard 시작 요청은 승인 발급 전에 저장 수집본 대기 상태를 반환한다. 워커는 이전 Standard 전달도 처리하지 않으며 비용 원장과 과거 결과 조회는 유지한다. 미승인 기본값을 우회하는 `live_apify`는 같은 QA에 대한 유료 수집을 별도로 승인받은 경우에만 사용한다.

### 승인된 Dev Standard 수집본 보관

수집본 보관을 함께 검증할 1회가 별도 승인된 경우에 Dev 웹과 두 워커를 `archive_capture` 모드와 같은 새 `DEV_LIVE_STANDARD_ARCHIVE_SLOT`으로 맞춘다. 슬롯에는 32자리 소문자 16진수 난수를 사용한다. 새 승인 이전의 기준 시각을 `DEV_LIVE_STANDARD_ARCHIVE_APPROVAL_NOT_BEFORE`에 UTC ISO 시각으로 기록한다. 기준 시각보다 앞선 기존 승인은 새 슬롯을 잡을 수 없다. 두 워커만 Secret Manager에서 같은 `DEV_LIVE_STANDARD_ARCHIVE_KEY`를 참조한다. 키는 Base64로 인코딩한 32바이트 값이다. 같은 슬롯은 첫 승인과 대상에 묶이며 다른 승인으로 재사용할 수 없다.

두 워커의 `DEV_LIVE_STANDARD_ARCHIVE_BUCKET`에는 같은 등록 Dev 미디어 버킷을 지정한다. 그 버킷의 `analysis-v2-dev-standard-archive/` 범위에 두 워커의 제한된 객체 읽기와 생성 권한을 확인한다. 유료 워커와 검증 CLI에는 봉인 목록을 확인할 수 있는 `storage.objects.list`가 필요하다. 활성화 전에 이 범위의 만료·삭제 정책을 확인한다. 작업은 승인 시각에서 24시간이 지나면 수집본을 거절한다. 버킷의 정책이 보관 기한이 지난 객체를 정리한다. 슬롯, 키, 대상 정책은 승인 건이 끝날 때까지 고정한다.

수집으로 확보한 정규화 증거와 판독용 JPEG, 결과용 WebP는 암호화한 항목으로 저장된다. 필수 항목이 모두 저장된 뒤에만 봉인한다. 확인한 빈 데이터와 미수집은 별도로 기록한다. 보관 검증 CLI는 승인된 QA 설정을 사용해 봉인과 필수 조각을 읽고 상태 및 배치 수만 반환한다.

```bash
npx tsx --conditions=react-server scripts/dev-standard-archive.ts --verify
```

검증 CLI는 분석을 접수하지 않는다. 정식 Dev 큐에서 보관본을 쓰려면 새 승인 및 DB 저장 출처가 해당 수집본에 고정돼 있어야 한다. 그 연결이 적용되기 전까지 재생 모드는 시작을 차단한다.

Dev Standard 동등성 검증에서는 운영과 같은 큐 동시 전달 수·재시도와 Cloud Run 리비전 최대 인스턴스 수를 사용한다. 정식 분석은 동시 8개·초당 8개·최대 8회·1시간, 사전 점검은 동시 32개·초당 32개·최대 8회·30분이다. 둘 다 백오프 40–300초와 최대 두 배 증가 4회를 사용한다. 유료 워커 서비스 최대 인스턴스는 10개, 리비전은 8개다. 사전 점검은 서비스와 리비전 각각 32개다.

새 Dev 운영자 Standard 승인의 Vertex 호출은 운영 스케줄러와 같은 동시성 제한을 적용한다. 운영자 Basic과 기존 유한 승인에는 Dev의 추가 직렬 제한이 적용된다. 같은 승인 아래 동시에 도착한 선예약은 하나의 DB 거래씩 상한을 검사한다. SDK 내부 호출은 Dev 정산이 추적하는 단일 시도로 제한한다.

특징 판독 한도를 6개로 비교하는 Dev 검증은 [Dev 전용 SQL](../../supabase/dev-ui/live-standard-feature-concurrency.sql)을 사용한다. 등록 Dev DB에서 정식 분석이 없고 Gemini 슬롯 8개가 모두 가용할 때 적용한다. 워커 내부 한도는 인스턴스당 3개이며, 두 프로필 배치가 동시에 실행될 때 공용 슬롯 6개까지 사용한다. 총 8개 슬롯과 앱의 유료 호출 120 RPM 설정을 그대로 사용한다.

Dev 유료 작업 복구는 공통 DB 마이그레이션과 운영자 Standard 승인 SQL을 반영한 뒤 [Dev 재전달 SQL](../../supabase/dev-ui/live-standard-dispatch-recovery.sql), [Dev 공급자 작업권 회수 SQL](../../supabase/dev-ui/live-standard-provider-recovery.sql)을 순서대로 적용하고 `DEV_LIVE_STANDARD_RECOVERY_ENABLED=true`로 연다. 서울 Dev Cloud Scheduler는 전용 `dev-live-paid-maintenance` OIDC 신원으로 Dev 유료 워커의 `/api/analysis/v2/recover`를 5분마다 호출한다. audience는 Dev 유료 워커의 등록 origin이다. 정식 접수 전에는 현재 QA 승인·소유자·대상과 일치하는 사전 점검에서 만료 작업권을 확인한다. 무료 Apify 계정과 입력 지문이 일치하고 기존 Actor의 시작 기록이 있을 때 다음 큐 전달이 그 Actor를 이어받는다. 새 Standard 승인과 소비된 Dev 사전 점검에 연결된 활성 분석이 한 건일 때, 운영과 같은 원장 증거를 사용해 회수 가능한 만료 작업권을 정리한 뒤 기한이 도래한 작업을 재전달한다. 활성 V2 분석이 없으면 현재 QA 승인에 속한 가장 최근 종료 요청의 작업권을 확정된 종료 증거에 한해 해제한다. Apify 실행 ID가 있으면 워커가 그 실행을 이어받는다. Vertex 감사를 포함한 미결 시도와 비용 기록은 보존한다.

같은 5분 주기의 복구는 별도 트랜잭션에서 과거 Dev Standard 승인에 연결된 슬롯도 확인한다. 요청과 모든 작업이 종료되고 요청 종료와 두 작업권 만료 후 각각 15분이 지났으며 슬롯·공급자 작업권·감사 시도가 일치하면 이전 슬롯 세대를 무효화하고 자리를 반환한다. 진행 중인 승인 건은 해당 작업이 이미 완료됐거나 스케줄러가 같은 연산을 최종 처리하여 더 발급할 수 없다는 증거가 있는 경우에만 회수한다. 미결 감사와 예산 예약은 보존하며, 회수한 자리는 새 작업이 새 세대 번호로 획득한다. Dev와 운영에 이 마이그레이션을 적용할 때는 SDK 진입 전과 인증 후 HTTP 전송 직전에 시한을 검사하는 유료 워커로 먼저 전환한다. 그 검사가 없던 리비전이 발급한 작업권은 배포 전 해당 리비전이 트래픽과 실행 인스턴스 모두 0인지 확인한다. 운영 전체 복구, 카나리 복구, 이미지 보존 정리 및 사전 점검 유지보수는 해당 Dev 경로에 묶지 않는다.

Dev 웹은 `ANALYSIS_V2_ADMISSION_ENABLED=true`로 설정하고, 사전 점검에 기록할 정책을 운영과 맞춘다. `ANALYSIS_V2_GENDER_RESOLUTION_ROLLOUT`, `ANALYSIS_V2_NARRATIVE_V28_ROLLOUT`, `ANALYSIS_V2_AI_MICROBATCH_V29_ROLLOUT`, `ANALYSIS_V2_GENDER_SUMMARY_QUALITY_V211_ROLLOUT`, `ANALYSIS_V2_AI_SCHEDULER_ROLLOUT`에는 `production`을 지정하고, `ANALYSIS_V2_VERTEX_AI_COST_OPTIMIZATION_V212_ROLLOUT`에는 `off`를 지정한다.

두 Dev 워커는 `ANALYSIS_PROVIDER_ADMISSION_ENABLED=true`, `ANALYSIS_V2_INSTAGRAM_ROUTE=apify_v1`, `VERTEX_AI_BUDGET_GUARD_ENABLED=true`, `VERTEX_AI_BUDGET_STORE=supabase`를 요구한다. 정식 분석 워커는 `ANALYSIS_V2_WORKER_ENABLED=true`가 필요하다. 아래 개별 보호 한도도 승인값을 초과하지 않아야 한다.

- 워커 공용 Vertex `VERTEX_AI_PER_RUN_BUDGET_USD`, `VERTEX_AI_PER_ORDER_BUDGET_USD`, `VERTEX_AI_DAILY_BUDGET_USD`는 양수이며 Basic 기준 `$2` 이하다. 운영자 시작 모드에서는 각 실행에 발급한 Dev 비용 원장 한도를 사용한다.
- Apify는 두 워커에 `APIFY_PROFILE_MAX_ESTIMATED_COST_USD_PER_OPERATION`을 지정한다. 정식 분석 워커에는 `APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION`, `APIFY_LIKERS_MAX_ESTIMATED_COST_USD_PER_OPERATION`, `APIFY_COMMENTS_MAX_ESTIMATED_COST_USD_PER_OPERATION`을 추가한다. 공용 설정은 양수이며 Basic 기준 `$5` 이하다.
- 1회 상한은 Basic에서 Apify Actor 요금 `$5`와 Vertex `$2`, 승인된 대상의 신규 Standard에서 Apify Actor 요금 `$6`과 Vertex `$18`이다. 기존 Standard에는 발급 당시 Vertex 상한 `$4` 또는 `$18`이 적용된다. Dev DB의 공용 예약 원장은 각 호출 전 같은 승인 ID의 공급자별 누적액을 검사한다. Vertex는 실제 전송할 프롬프트와 응답 스키마, 선택된 JPEG 수, 추론을 포함한 출력 상한으로 보수적으로 선예약한다. 디스크, GCS/R2, 데이터 전송, 공급자 요금제 조건의 별도 비용은 이 한도에 포함되지 않는다.
- 정식 분석의 단계형 Vertex 호출은 Dev 예산을 예약한 뒤 DB에 AI 시도를 기록하고 공급자 슬롯을 확보한다. 예약이 거절되면 이 기록과 슬롯이 생성되지 않는다. 승인된 예약이 슬롯 대기나 취소로 SDK 호출에 들어가지 않으면 0원으로 정산한다. 확인에 실패하면 같은 예약을 한 번 더 요청한다. SDK의 명시적 HTTP `429`는 0원으로, 완전한 사용량을 관측한 호출은 사용량 기준으로 정산한다. 전송 상태가 모호하거나 사용량이 불완전한 성공 응답은 선예약액을 유지한다.
- 11월 21일 Dev Standard는 Vertex `$3.922786` 정산과 공개 후보 판독 2/8 배치 완료 뒤, 다음 호출의 선예약이 거절됐다. 종료 시점 특징 판독 대기 16건과 분류가 완료되지 않은 공개 후보 최대 72명이 모두 추가 특징 판독을 받는다고 가정하면 이미 사용한 금액에 약 `$4.44`가 더 필요하다. 새 실행에서 공개 후보 240명 전원이 특징 판독을 받는 경우의 추정액은 단가가 관측된 102건의 P90 `$0.050456`을 적용한 `$12.11`이다. 유료 응답 거부 비율을 반영한 반복 `$0.63`, 나머지 분류·비공개 판독 `$0.40–$0.70`, 후단 판독 예약 대리값 `$1.68`, 동시 예약 여유 `$0.39`를 더하면 `$15.21–$15.51`이다. `$18`은 이 범위의 상단에 약 `$2.49`를 더한 신규 승인 상한이다. 완료 비용과 후단 판독 단가는 실측 전이다.

## 운영자 시작과 검증

- [Dev 전용 상시 승인 SQL](../../supabase/dev-ui/live-owner-start.sql)은 Dev 비용 원장 다음에 적용한다. DB는 서버가 확인한 활성 Basic 카카오 운영자와 실제로 시작한 대상·시도 ID에 새 실행을 묶는다. 같은 버튼 요청의 재전송은 동일한 승인을 사용하고, 각각의 새 시작에서 별도 상한을 적용한다.
- Dev 웹은 검증된 카카오 이메일 하나와 등록된 계정만 허용한다. 로그인, 페이지 방문, 상태 조회는 실행을 만들지 않는다. 운영자가 동일 오리진에서 실제 사전 점검을 시작한 뒤 인증된 워커가 DB 요청과 승인 ID를 검증하면 공급자 호출이 가능하다.
- 실제 분석에서는 운영과 같은 사전 점검 미리보기 및 진행·결과 컴포넌트를 사용한다. 미리보기 상태 조회는 Dev 운영자가 소유한 실제 사전 점검의 기존 결과만 읽는다. Dev는 비용 확인과 테스트 이용권으로 결제 단계를 대체하며 실제 데이터 표시를 추가한다.
- Basic 공급자 승인은 시작부터 30분이고, 기존 Standard 공급자 승인은 시작부터 150분이다. 새 Standard 공급자 승인은 종료 시각 없이 분석 실행에 연결된다. 공급자를 호출하기 전 승인된 운영자와 대상 정책, 건별 예산을 확인한다. 사전 점검과 이용권 발급은 기존 30분 안에 진행한다. 운영자가 새 분석을 시작할 때마다 별도 비용 원장을 발급한다. 이전 결과는 계속 조회할 수 있다.
- Standard를 열려면 예산과 대상에 대한 운영자 승인 후 [Standard 승인 SQL](../../supabase/dev-ui/live-owner-start-standard.sql), [사전 점검 재전송 SQL](../../supabase/dev-ui/live-standard-preflight-replay.sql), [최신 정보 확인 SQL](../../supabase/dev-ui/live-standard-fresh-admission.sql), [정식 분석 프로필 체크포인트 SQL](../../supabase/dev-ui/live-standard-fresh-profile-checkpoint.sql)을 순서대로 등록된 Dev DB에 적용한다. 승인된 대상 하나를 Dev DB의 `dev_live_budget.standard_owner_policy`에 등록한다. 같은 대상의 `DEV_LIVE_STANDARD_TARGET`을 Dev 워커 두 개에 먼저 설정하고 검증한 뒤 Dev 웹에 설정한다. 생성과 이용권 발급은 Dev 운영자 세션, 요청 대상, 확인한 플랜, DB 승인이 일치할 때 진행된다. 정책을 비활성화하면 해당 Standard 승인으로 새 비용을 예약할 수 없다.
- 기존 Dev에서 종료 시각 없는 Standard 승인으로 전환할 때는 기한이 있는 승인과 없는 승인을 모두 읽는 웹·워커를 먼저 배포한다. 두 워커의 새 리비전에서 트래픽 100%를 확인한 뒤 등록된 Dev DB에 Standard 승인 SQL을 다시 적용한다. 새 웹의 Standard 시작과 가용성 조회는 v4 RPC가 준비되면 동작한다. 웹은 시작 화면에 표시한 Vertex 상한이 현재 기준과 일치할 때 v4 발급을 요청한다. 기존 사전 점검에 연결된 승인은 원래 상한과 유효기간으로 검증한다. v4로 시작한 작업이 처리 중이면 해당 승인을 읽을 수 있는 워커 리비전을 사용한다.
- 11월 19일 Dev Standard가 접수 직후 대상 프로필 단계에서 중단됐다. 프로필 체크포인트의 조회·저장이 운영 결제 주문을 검증하고 있었다. Dev용 SQL은 연결된 사전 점검과 실제로 소비된 Standard 이용권, 현재 운영자 승인, 작업과 공급자 실행 증거를 검증해 결제 없는 Dev 요청을 처리한다.
- 같은 날 17:15 재시도는 대상 프로필과 좋아요 수집까지 완료했고 댓글 수집 Actor의 시작 거절로 17:15:41에 종료됐다. 댓글 실행 ID와 댓글 사용액은 각각 없음과 0달러로 기록됐다. 당시 워커는 코드에 고정된 `0.0.588`을 사용했으며 공급자의 HTTP 상태와 세부 오류 코드는 남지 않았다. Dev 정식 분석 워커에는 입력 계약을 확인한 `APIFY_COMMENTS_BUILD=0.0.682`를 사용한다. 이 버전은 Apify가 성공으로 표시한 공개 빌드다. 새 공급자 실행 없이 배포와 모의 검증을 진행한다. 정식 분석에서 시작이 다시 거절되면 Cloud Run의 `analysis_v2_apify_start_rejected` 이벤트에서 작업 종류, HTTP 상태, 허용된 오류 코드만 조회한다. [공개 빌드](https://api.apify.com/v2/actors/apify~instagram-comment-scraper/builds/default)
- Dev에서 분석 시작을 누르면 즉시 최신 계정 정보 확인 화면으로 전환한다. 사전 점검이 아직 처리 중이면 서버가 안내한 간격으로 같은 승인 요청의 상태를 확인한다. 서버가 정식 분석 요청 ID를 확인한 뒤 진행 화면으로 이동한다.
- 11월 19일 19:18 Dev Standard 검증에서 댓글 수집 빌드 `0.0.682`가 시작됐고 정상 종료됐다. 이후 19:19:39에 팔로워와 팔로잉 수집이 모두 Apify `403 build-not-found`를 반환했다. 두 관계 실행은 만들어지지 않았고 사용액은 각각 0달러로 기록됐다. 당시 관계 수집 빌드는 `0.0.71`이었다. Dev 정식 분석 워커의 `APIFY_RELATIONSHIP_BUILD`를 공개 성공 빌드 `0.0.96`으로 지정한다. 배포 전 Actor 빌드 상태와 기존 입력·출력 필드를 비교하고 합성 데이터로 두 요청의 옵션과 파싱을 확인한다. 대상의 관계 수는 Free API의 회당 1,000건 상한 범위에 있으며 실제 수집 완전성은 공급자 실행에서 확인한다. 재실행 전에 secondary의 현재 무료 잔액과 이번 실행 승인을 확인한다. [관계 수집 빌드](https://api.apify.com/v2/actors/scraping_solutions~instagram-scraper-followers-following-no-cookies/builds/default) · [Free API 한도](https://apify.com/scraping_solutions/instagram-scraper-followers-following-no-cookies#free-usage-limits)
- 11월 19일 20:04 Dev Standard 실행은 관계와 상호작용 수집을 통과한 뒤 20:31:44에 종료됐다. Vertex 원장의 정산 추정액 `$0.902444`와 HTTP `429` 응답 6건의 미정산 예약 `$1.603584`에 다음 호출의 보수적 예약 `$1.634304`를 더하면 `$4.140332`가 된다. `$4.140332`는 당시 Standard Vertex 상한 `$4`의 차단 판단에 사용한 합계다. [Google Cloud 과금 기준](https://cloud.google.com/model-garden/pricing?e=48754805)
- 진행 상태 응답은 완료 작업 수와 별도로 DB가 앞서 보존한 진행률을 읽는다. 현재 완료 수로 산출한 하한과 전체 0~100% 범위를 검사한다. 이를 통해 기존 진행률을 보존하면서 실패 상태를 화면에 표시한다.
- 11월 20일 03:40 KST Dev Standard는 후보 이미지 처리 재시도 중 `ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR`로 종료됐다. 같은 실행의 Cloud Storage 집계에서 조건부 쓰기 412 응답 11건, 기존 객체 메타데이터 조회 성공 11건, 본문 조회 성공 10건이 확인됐다. 임시 객체 11개의 생성·삭제 기록은 DB와 일치했다. 보존 경로를 후보와 단계에만 고정한 상태에서 재시도 이미지 묶음의 바이트 길이가 달라지면, 본문을 읽기 전에 같은 오류가 발생하는 것을 모의 저장소에서 재현했다. 객체별 로그와 종료 후 정리된 후보 매핑이 없어 당시 후보와 세부 단계는 식별할 수 없다. 이제 보존 경로는 이미지 묶음의 해시를 포함하며, 추론 비교에서 워커가 실제 사용한 묶음을 읽도록 분석 체크포인트에 해당 해시를 기록한다. 같은 입력을 재시도하면 기존 객체를 재사용한다.
- 같은 실행의 03:19~03:21 KST에는 이전 작업의 Gemini 슬롯이 풀린 뒤에도 공급자 동시 실행 원장에 예약 3건이 잠시 남아 있었다. 이 상태에서 공급자 슬롯을 얻지 못한 후보 분석은 호출 전에 `AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR`로 처리됐다. 단계형 분석은 새로 확보한 Gemini 슬롯의 반환을 확인한 경우 이 거절을 용량 대기로 넘긴다. 원장 저장이나 슬롯 반환의 성공 여부가 불확실하면 기존의 안전한 오류 경로를 유지한다. 이후 산발적으로 기록된 동일 감사 코드는 로그만으로 원인을 확정할 수 없었다.
- 11월 20일 11:24 KST에 시작한 Dev Standard는 12:16에 Vertex 사전 예산 검사로 종료됐다. 종료 원장의 추정액 `$2.411691`에 다음 특징 분석의 전체 모델 컨텍스트 기준 선예약 `$1.634304`를 더하면 승인된 `$4`를 넘겼다. 워커 로그에는 `DEV_LIVE_BUDGET_EXCEEDED`, 요청의 종료 코드에는 `ANALYSIS_V2_JOB_HANDLER_FAILED`가 남았다. 이제 Dev는 실제 요청의 입력 크기와 출력 상한을 사용해 예약액을 계산한다. [Vertex 이미지 토큰화](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/image-understanding) · [Vertex 구조화 출력](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output)
- 해당 실패 요청의 승인은 13:51 KST에 만료됐다. 이미지 보존본 183개와 개별 모델 응답 일부가 남아 있다. 후보 AI 작업 8개 중 완료된 작업은 없고, 종료 처리 후 관계·프로필 실행 입력과 단계 체크포인트는 조회되지 않는다. 최종 점수, 재생 입력 번들, 추론 비교용 보존본도 생성되지 않았다. 이 자료만으로는 종료된 요청을 재개하거나 같은 입력을 사용한 별도 오프라인 재생을 완료할 수 없다.
- 후보 코드, Dev 도메인, DB 식별자, Cloud Run IAM, 큐 상태를 확인한다. 단위 검증은 인증 실패, 같은 요청 재전송, 대상 불일치, 승인 만료, 비용 상한, 공급자 호출 없는 가용성 조회를 포함한다.
## Standard 추론 수준 비교

Dev 유료 워커의 보존 슬롯은 설정 후 처음 접수한 운영자 승인 Standard 실행 하나에 연결된다. 최종 점수 계산에서 직접 특징 분석을 통해 검증된 후보 중 고위험을 우선해 3명을 선택한다. 해당 후보의 모델 입력과 전체 후보군의 점수 입력을 결합한다. 기존 입력과 이미지 해시가 맞을 때만 Dev 비공개 저장소에 암호화해 저장한다. 분석이 최종 점수 단계 전에 종료되거나 적격 후보가 3명 미만이면 비교 보존본은 생성되지 않는다.

보존본은 승인 시점부터 최대 24시간 안에 사용한다. Dev 버킷의 수명주기 규칙이 보존본을 삭제하고, 암호화된 삭제본에는 버킷의 소프트 삭제 기간이 적용된다. 실행을 잠그는 표식에는 원본 식별자나 모델 입력을 저장하지 않는다. 워커 로그에는 보존 상태 코드만 남긴다.

운영자는 Ascentum 프로젝트의 ADC를 사용한다. 검증된 Dev 런타임에서 버킷과 슬롯을 읽고 Secret Manager의 지정된 버전에서 키를 프로세스 환경으로 전달한 뒤 아래 상태 명령을 사용한다. 비교 명령은 보존본이 준비되면 한 번만 실행할 수 있다. 기존 Apify 결과를 다시 요청하지 않고 Gemini 3.7 Flash를 같은 후보에 HIGH·MEDIUM 각각 1회, 최대 6회 호출한다. 요청별 입력 추정 상한은 32,768토큰이고 생성 상한은 8,192토큰이다. 보수 요율의 전역 예약 합계는 $0.663552이며, 오류가 발생하면 남은 호출을 중단한다. 비교 결과는 후보 번호, 두 설정의 기록된 토큰 사용량 추정 비용과 고위험 등급 변경을 반환한다. 당시 관계·역방향 좋아요 수집 범위와 별도로 확인한 파트너 증거를 고정한다.

```sh
npx tsx --conditions=react-server scripts/dev-standard-eval.ts --status
npx tsx --conditions=react-server scripts/dev-standard-eval.ts --compare
```
