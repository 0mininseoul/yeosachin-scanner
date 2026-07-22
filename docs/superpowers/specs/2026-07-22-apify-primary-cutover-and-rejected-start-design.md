# Apify Primary 안전 전환과 확정적 시작 거절 처리 설계

## 현재 상태

현재 운영 Cloud Run 서비스의 논리 슬롯 `primary`는
`ai-baram-v2-apify-primary:2`를 참조한다. 토큰 원문을 출력하지 않고 지문만
비교한 결과, 이 버전은 로컬 `APIFY_SEPTENARY_API_TOKEN`과 같다. 같은 Secret Manager
비밀의 버전 `1`은 로컬 `APIFY_PRIMARY_API_TOKEN`과 같다.

현재 배포된 Septenary 계정은 월간 사용 한도를 넘었다. 교체할 Primary 계정은 Free
플랜이며 월간 한도는 `$10`, 현재 사용액은 `$5.473343669480983`, 남은 한도는
`$4.526656330519017`이다. 현재 사용 주기는 `2026-07-25T23:59:59.999Z`에 끝난다.
해당 계정으로 프로필 Actor에 접근할 수 있음도 확인했다.

실패한 preflight는 Apify가 Actor 시작을 거절하기 전에 `primary` provider 원장 행을
예약했다. 해당 계정·Actor·예약 시간 범위에서 실제 Actor run은 하나도 없다.
다만 기존 30분 무변경 기간과 preflight 만료 조건을 모두 충족하기 전에는 해당 행을
기존 버전에 묶인 채 유지해야 한다. 조건을 충족한 뒤 DB 소유자 전용 함수로
`resolved_no_run`처리한다.

## 목표

1. 기존 Cloud Run 서비스의 숫자 비밀 버전을 바꾸지 않고, 새 Analysis V2와 preflight
   작업이 `APIFY_PRIMARY_API_TOKEN`을 사용하게 한다.
2. 기존 서비스와 `primary:2`를 불변의 복구 근거로 보존한다.
3. 예상한 카카오 사용자로 승인된 Plus E2E 1건을 완료하고, 성공 결과를 해당 사용자의
   보관함에 남긴다.
4. E2E의 모든 provider run과 비용 정산이 끝난 뒤 임시 다중 계정 샤딩 구성을
   제거한다.
5. Apify가 확정적으로 반환한 HTTP 오류를 "Actor가 실행됐을 수도 있는 불명한
   시작"으로 오판하지 않게 한다.

## 하지 않는 일

- Secret Manager 버전을 비활성화하거나 삭제하지 않는다.
- `ai-baram-v2-apify-primary:2`를 수정하거나, 기존 비밀 버전에 다른 토큰을 넣지 않는다.
- 자동 계정 풀링, 한도 우회, provider 자동 failover를 추가하지 않는다.
- 네트워크 timeout이나 Actor 생성 여부를 알 수 없는 응답 후에 Actor 시작을 재시도하지
  않는다.
- 완료된 E2E 결과를 사용자의 보관함에서 삭제하지 않는다.

## 검토한 토큰 전환 방식

### 1. 새 Cloud Run 서비스로 이전: 채택

처음부터 `ai-baram-v2-apify-primary:1`을 참조하는 새 Cloud Run 서비스를 만든다. 현재
서비스의 작업을 모두 비운 뒤 Vercel의 task 대상과 Scheduler 대상을 새 서비스로
바꾸다. 새 서비스에는 과거 credential identity가 없으므로 기존 배포 안전 규칙을 지킨다.
롤백은 대상 URL만 기존 값으로 되돌리면 된다. 기존 서비스와 비밀 참조는 수정하지
않는다.

### 2. 기존 서비스의 `primary:2`를 `primary:1`로 직접 변경: 기각

작업은 짧지만 레포의 같은 슬롯 불변 규칙을 어긴다. 기존 원장 행은 논리 슬롯만
저장하고 credential 세대를 저장하지 않는다. 따라서 직접 변경하면 동일한 `primary`가 시간에
따라 다른 물리 계정을 뜻하게 되며, 검토된 배포 차단 장치도 우회하게 된다.

### 3. credential 세대를 DB에 저장하고 기존 서비스에서 감사 후 교체: 보류

모든 provider 원장과 비용 이벤트에 credential 버전 identity를 추가하면 향후 기존 서비스
내 회전을 감사할 수 있다. 하지만 이는 더 큰 스키마·수명주기 프로젝트이다. 이번 전환은 새
서비스를 사용하면 identity를 유지할 수 있으므로 이 방식은 보류한다.

## 전환 구조

작업 중에는 비공개 Cloud Run 서비스 세 개를 사용한다.

- `analysis-worker`: 현재 복구 전용 서비스. `primary:2`에 계속 묶인다.
- `analysis-worker-primary-e2e`: 임시 E2E 서비스. `primary:1`과 승인된 operation 분리에
  필요한 추가 숫자 슬롯 참조를 갖는다.
- `analysis-worker-primary`: 최종 운영 서비스. E2E와 비용 정산이 끝난 후
  `primary:1`만 참조한다.

각 서비스는 검토된 같은 앱 이미지/소스 커밋, 런타임 서비스 계정, 비밀이 아닌
런타임 정책, 스케일링 한도, HMAC/Supabase/이미지 비밀 버전을 사용한다. 서비스
이름, 자신을 가리키는 task URL, 허용된 Apify 참조만 다르다.

Vercel은 계속 접수와 task 등록을 담당한다. 운영 배포는 현재 선택한 worker의 task 대상
URL과 OIDC audience를 고정해 가져간다. Cloud Tasks는 이미 생성된 task의 URL을 나중에
바꾸지 않는다. 따라서 서비스를 바꾸기 전에 항상 대기 task가 0건인지 확인해야 한다.
두 maintenance Scheduler job도 새 worker가 Ready이고 invoker IAM이 올바른지 확인한 후에
같이 전환한다.

## 운영 순서

1. 실패한 preflight가 만료되고 provider 행이 최소 30분 동안 변경되지 않을 때까지
   기다린다.
2. 기존 계정의 정확한 Actor 시간 범위를 다시 감사한다. 관련 run이 하나라도 있으면
   중단한다. 없으면 DB 소유자 전용 no-run SQL을 생성·실행하고 미해결 목록에서
   제거됐는지 확인한다.
3. 처리 중 request, claim/running job, active 또는 미정산 provider 행, cleanup intent,
   미디어 artifact, 대기 task가 모두 0인지 확인한다.
4. 확정적 Actor 시작 거절 처리 수정을 머지하고, 그 정확한 커밋을 Vercel에 배포한다.
5. `analysis-worker-primary-e2e`를 `primary:1`과 검토된 임시 슬롯 참조로 생성한다.
   비공개로 유지하고 task/maintenance 서비스 계정에만 `run.invoker`를 부여한다.
6. 새 revision의 이미지/소스 SHA, 비밀 참조, 런타임 gate, IAM, 단일 revision 트래픽,
   health endpoint를 확인한 후에만 작업을 보낸다.
7. Vercel의 task URL/audience 변수 네 개와 Scheduler URI 두 개를 임시 서비스로 변경한다.
   같은 머지 커밋을 다시 배포하고, 비밀을 출력하지 않고 고정된 환경을 검증한다.
8. 승인된 Plus E2E를 정확히 1번 실행한다. preflight 재사용, provider 계보, 최종 비용,
   결과 노출, 보관함 유지, queue 비움, artifact cleanup, 미해결 행 0건을 확인한다.
9. 승인된 테스트 샤딩 정책을 비활성화하고 Vercel을 다시 배포한다.
10. `analysis-worker-primary`를 `primary:1`만 참조하도록 생성한다. 두 번째 0건 drain 후
    Vercel과 Scheduler를 최종 서비스로 바꾸고, 복구 전용 서비스 두 개에서 invoker
    권한을 제거한다.
11. 서비스와 비밀 버전은 삭제하지 않는다. 최종 active 서비스, revision, 소스 SHA,
    비밀 버전, E2E 근거만 토큰과 사용자 콘텐츠 없이 기록한다.

## 확정적 Actor 시작 거절 처리

### 분류 규칙

`apify-client`는 HTTP 요청이 Apify에 도착했고 Apify가 2xx가 아닌 API 오류를 반환했을 때만
`ApifyApiError`를 만든다. 이는 실행 여부가 불명한 통신 실패가 아니라 시작 거절이다.
네트워크 오류, 로컬 deadline, 연결 초기화, 타입이 없는 실패는 계속 불명한 시작으로
처리한다.

### Provider callback

`ProviderRunCheckpoint`에 선택적 `onRunStartRejected` callback을 추가한다. callback은 불변
provider identity, 제한된 `statusCode`, 정제된 provider error `type`만 받는다. provider 메시지,
요청 payload, 토큰, 사용자 입력은 전달하거나 저장하지 않는다.

`startOrResumeApifyActor`는 다음 순서를 따른다.

1. 기존 시작 예약을 DB에 저장한다.
2. Actor 시작을 한 번만 호출한다.
3. `ApifyApiError`면 `onRunStartRejected`로 확정 거절을 저장하고, 정제된
   `SCRAPING_PROVIDER_START_REJECTED_ERROR`를 던진다.
4. 다른 시작 오류면 기존 `SCRAPING_AMBIGUOUS_START_ERROR`를 던지고 재시도하지 않는다.

거절 저장에 실패하면 persistence 사고로 남긴다. 이 실패가 두 번째 Actor 시작을 허용하지
않는다.

### 원장 상태

preflight와 request provider 원장에 terminal 상태 `rejected`를 추가한다. 거절된 행은 다음
조건을 갖는다.

- `run_id = NULL`
- run 시작 시각 없음
- terminal 시각 있음
- `actual_usage_usd = 0`
- 비용 정산 시각 있음
- 해당 원장이 metadata를 허용하는 경우 제한된 HTTP status와 정제된 provider error type

preflight 장기 비용 기록에는 최대 비용과 실제 비용이 모두 0인
`provider_start_rejected` 이벤트를 남긴다. 이를 `manual_no_run`으로 기록하지 않는다.
`manual_no_run`은 외부 근거를 운영자가 확인한 경우에만 사용한다. retention, readiness,
cleanup, 비용 합산은 `rejected`를 terminal·정산 완료 상태로 취급한다.

### 오류 처리

- 한도, 검증, 결제, 권한 등의 `ApifyApiError`는 재시도 없이 현재 operation을 실패
  처리하고 불명한 행을 남기지 않는다.
- 공개 preflight 응답은 기존처럼 정제된 `ANALYSIS_FAILED`를 사용한다.
- request worker는 실제 실행 중인 provider run이 없는 상태에서 기존 terminal cleanup을
  수행한다.
- Apify 오류 원문은 PostgreSQL, application log, client 응답에 남기지 않는다.

## 검증

### 자동 테스트

- 실제 `ApifyApiError` fixture로 현재 코드의 잘못된 불명 분류를 먼저 재현하고, 해당 테스트가
  올바른 이유로 실패하는 것을 확인한다.
- rejection callback이 한 번만 호출되고, run checkpoint와 wait는 호출되지 않으며,
  정제된 확정 거절 error code가 발생하는지 확인한다.
- 기존 deadline/network 테스트는 계속 불명 처리와 Actor 시작 1회를 증명해야 한다.
- PGlite 테스트로 preflight/request 원장의 `rejected` 전이, 실제 비용 0, 멱등성, identity
  충돌, retention, readiness, 장기 비용 이벤트를 확인한다.
- migration contract 테스트로 constraint, grant, security-definer search path, provider 오류 원문
  미저장을 확인한다.
- 머지 전에 관련 Vitest, migration, typecheck, lint, build, 인프라 스크립트 테스트를
  모두 통과한다.

### 운영 검증

- 토큰과 지문을 출력하지 않고, 임시/최종 서비스의 `primary` 참조가 로컬
  `APIFY_PRIMARY_API_TOKEN`과 같은지 확인한다.
- Cloud Run과 Vercel의 소스 SHA가 머지 커밋과 같은지 확인한다.
- 새 task와 maintenance job이 정확히 하나의 운영 worker를 가리키는지 확인한다.
- 승인된 Plus request가 완료되고 모든 유료 run과 비용이 정산되며, queue와 artifact가
  비워지고, 예상한 소유자의 보관함에 결과가 보이는지 확인한다.
- 최종 worker에 임시 non-primary Apify 참조가 없고, 복구 전용 서비스에 task/maintenance
  invoker 권한이 없는지 확인한다.

## 롤백

임시 E2E 서비스에 작업을 보내기 전에는 기존 서비스가 그대로 남아 있으므로 별도 롤백이
필요하지 않다. 대상을 전환한 후에는 Vercel의 task URL/audience 네 개를 기존 값으로
복원하고, 직전 known-good Vercel 소스를 배포하며, Scheduler URI 두 개를 기존 서비스로
돌린다. 롤백 중에 비밀 버전을 변경하거나 서비스를 삭제하지 않는다. active 또는 미정산
provider run이 하나라도 있으면, 해당 서비스와 credential identity로 복구·정산이 끝날 때까지
전환을 중단한다.

## 보안과 개인정보

- 토큰 비교는 true/false 결과만 출력한다.
- 토큰, 토큰 지문, provider 오류 원문, Instagram 식별자, 카카오 인증정보, 2FA 코드를
  소스·명령 출력·근거·로그에 기록하지 않는다.
- 근거에는 제한된 건수, 시각, 서비스/revision 이름, 소스 SHA, 논리 슬롯, 숫자 비밀
  버전, 비용만 남긴다.
- 모든 새 Cloud Run 서비스는 인증을 유지하고 resource-scoped secret access와 invoker IAM을
  사용한다.
