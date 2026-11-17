# OAuth 상태 소실과 preflight 오류 조사

2026-11-18 KST 기준. 원시 로그·사용자 UUID·쿠키·토큰·DB 비밀번호를 기록하지 않고 운영 로그의 집계, 배포 소스, DB 함수 정의와 무변경 검증을 대조했다. Apify·AI·실제 계정 분석 호출은 실행하지 않았다. 이 문서와 같은 이름의 `.safe.json`이 안전 집계 근거다.

## preflight가 언제부터 실패했는가

B-lite 결과 저장 완료도 10/19·21·26·27 각 1건씩 총 4건 확인했다. 마지막 명시적 `precheckout_blite.completed/success`는 10/27 10:13:46 KST다. 이 이벤트는 저장소의 complete가 true를 반환한 뒤 발생하며, 실제 사용자 화면 열람은 별도다.

조건부 용량 재시도 경로의 함수명 결함은 9/1의 커밋 `71930801`, PR #522에서 도입됐다. 10월에도 프로필 수집 후 `ready`로 완료된 기록 6건이 있으므로, preflight 전체가 9월부터 계속 실패한 상태였다는 해석은 맞지 않는다. 프로필 ready, 후속 B-lite 추론 성공, 실제 사용자 분석 완료는 구분한다.

| 시점, KST | 확인한 사실 | 한계 |
|---|---|---|
| 9/17 | 장기 Monitoring에서 전용 preflight 서비스의 첫 관측 5xx 4건 | worker/recover 경로를 구분할 수 없어 같은 결함으로 단정하지 않는다 |
| 10/19 01:58 | 현재 보존된 경로별 요청 로그 시작 | `_Default` 보존 30일 이전의 상세 로그는 복원할 수 없다 |
| 10/19·21·26·27·28 | 프로필 ready 각 1·1·1·1·2건, 합계 6건 | 전체 UI와 유료 분석 성공을 뜻하지 않는다 |
| 10/27 10:13 | 보존된 마지막 B-lite 결과 저장 완료 | 실제 사용자 화면 열람과 유료 정식 분석 완료는 별도다 |
| 10/28 05:15 | 보존된 마지막 프로필 ready | 이날 후속 B-lite 두 건은 별도 `VALIDATION_ERROR`로 실패했다 |
| 11/10 20:21 | 보존 범위에서 첫 worker 5xx | `run_pending` 500 두 건·용량 대기 503 한 건 뒤 `TARGET_PRIVATE/blocked`로 종결했다 |
| 11/11 10:57 | 마지막 worker HTTP200 | 프로필 결과가 `blocked`여서 성공으로 세지 않았다 |
| 11/13 16:47~17:50 | worker/recover 5xx 합계 100건 | 아래 재무장 함수명 결함의 관측 사슬과 일치한다 |
| 11/14~17 | recover HTTP200 매일 1,440건, worker 요청 0건 | 정기 복구의 정상 응답을 사용자 분석 성공으로 해석하지 않는다 |

장기 서비스 5xx는 9/17 4건, 9/22 2건, 9/29 3건, 10/9 1건, 10/12 2건, 11/10 3건, 11/13 100건이다. 9월의 정확한 worker/recover와 ready 이력은 현재 보존 로그만으로 확정할 수 없다. 9/4~16 시계열 공백을 정상으로 해석하지 않았다. Audit의 9/7 recovery Pause, 9/16 Resume는 공백 일부와 겹친다. `_Required`의 400일 Audit 보존은 사용자 요청 상세 로그의 보존과 다르다.

## 11/13 100건의 원인과 수정

앱은 `mark_analysis_preflight_rearmed_dispatch_for_provider_capacity_v2`라는 65바이트 RPC를 호출했다. PostgreSQL은 이를 63바이트인 `mark_analysis_preflight_rearmed_dispatch_for_provider_capacity_`로 등록했다. SQL 직접 호출은 식별자를 자동으로 축약해 성공하지만 PostgREST는 전체 문자열로 찾으므로 `PGRST202`가 발생했다.

| 단계 | 관측 건수 |
|---|---:|
| 4개 preflight의 첫 6회 내부 용량 대기 | worker 503 24건 |
| 각 7번째 시도에서 generation2 작업 생성 후 mark 실패 | worker 500 4건 |
| dispatch가 reserved로 남은 뒤 이전·후속 작업의 claim 실패 | worker 500 49건 |
| 같은 RPC를 호출하는 정기 복구 실패 | recover 500 23건 |

Cloud Tasks의 4개 lineage, 작업 8개, worker 전달 77건을 독립 집계했다. 내부 용량 대기가 최초 계기이고, 용량 대기를 영구적인 dispatch 실패로 확대시킨 결함은 함수명 불일치다. 당시 `PROVIDER_ERROR/status503` 28건은 앱의 내부 용량 대기 분기에서 생성됐다. 이 28건에는 active·분당 rate·기존 lease 중 어떤 한도였는지를 구분할 reason/counter가 남지 않아 최초 용량 대기의 세부 분기는 확정하지 않는다. [앞선 비용 조사](2026-11-18-cloud-run-cost.ko.md)의 분류를 외부 provider의 실제 HTTP503으로 읽으면 안 된다.

당시 serving revision → 이미지 content digest → 성공 Cloud Build → GCS 소스 ZIP → Git `b44f718042dfd14909dd5a358f3a92fb44aec76e`의 핵심 파일 9개를 바이트 비교해 모두 일치했다. DB의 claim/rearm/mark/recovery-list 함수 본문 MD5 네 개도 해당 migration과 일치했다. 원시 ZIP과 로그는 저장하지 않았다.

배포 함수의 NULL 인자 조기 반환을 먼저 확인한 뒤 모든 인자가 NULL인 요청 두 개를 비교했다. 기존 65바이트 이름은 HTTP404/PGRST202, 실제 63바이트 이름은 HTTP200/false였다. 행 조회·변경이나 provider 호출이 없는 검증이다. 독립 PGlite에서는 재무장·mark·claim의 정상 상태 전이와, SQL 직접 호출이 긴 이름 오류를 숨기는 현상을 재현했다.

[PR #609](https://github.com/0mininseoul/yeosachin-scanner/pull/609)는 앱의 RPC 상수 하나를 실제 등록 이름으로 고쳤다. migration·history repair·DDL 변경은 없다. 기존 generation/token fence와 불확실한 enqueue 응답의 보존 방식은 유지한다. 관련 4파일 162개 검사, 타입체크, diff 검사와 구현자 외 agent의 독립 리뷰가 통과했다. ESLint 오류는 0개이며 기존 경고 3개가 있다. `pg_proc.proname::text = $1::text` 회귀 검사는 식별자 자동 축약에 의한 오탐을 막는다.

추가 오프라인 재현에서는 mark가 성공해 후속 generation에 작업을 넘긴 뒤에도 이전 Cloud Task에 HTTP503을 반환하는 문제를 확인했다. 이전 generation이 다시 배달되면 이미 바뀐 fence와 충돌해 불필요한 500이 남는다. 후속 수정은 enqueue 확인과 DB mark 성공이 증명된 경우에만 HTTP200 `CAPACITY_HANDOFF`로 이전 전달을 종료한다. 미확정 응답·mark 실패·legacy 무 fence·재시도 한도 이전은 기존 503/500을 보존한다. B-lite 인계 경로에는 변경이 없다. [PR #610](https://github.com/0mininseoul/yeosachin-scanner/pull/610)은 이 인계 처리를 main `a97b2b6e95aab09b2639e4764d0947fe59e0fc09`에 병합했다. 후속 전달 처리의 37개 검사와 독립 리뷰가 통과했고, 두 수정을 함께 검증한 기존 4파일 173개 검사도 통과했다. 기존 운영 로그의 `enqueue/enqueued/retryable=false` 분류를 사용하며 새로운 민감값을 남기지 않는다.

PR #609는 main `c99d4783701d4732c369cb735ea688107fcad592`에 병합됐다. 후속 #610을 포함한 main `a97b2b6e95aab09b2639e4764d0947fe59e0fc09`의 CI는 성공했고 Vercel 프로덕션도 같은 SHA로 READY다.

## worker 운영 배포 검증

Cloud Run 첫 source 빌드는 Next 컴파일 후 TypeScript 단계에서 V8 heap 약 2GB 한도로 실패했다. 트래픽·runtime·IAM·queue·scheduler는 그대로였다. 최신 source 빌더가 기존 owner 검증에 필요한 sourceProvenance 필드를 남기지 않는 차이도 확인했다. 기존 성공 빌드의 classic 레시피와 heap 4GB를 사용했고, 8CPU 빌드 머신의 현재 할당량 부족은 기본 머신으로 해소했다. quota를 늘리지 않았다. 소스는 두 수정을 통합한 main `a97b2b6e`의 새 Git ZIP이며 기존 owner 검증기의 전체 Git 비교를 통과했다. 과거 코드·브랜치를 재적용하지 않았다. 빌드 성공과 runtime 설정 변경은 별개다.

- 새 이미지: `sha256:a5c6179067c42f1aa96313b0db305e2d28dfc0a45f903ef770c1917685e5f97d`.
- 소스 ZIP SHA256: `ac4cc97fb8bc1a9aa3772cb5db62b90758ef958d92f40d48be4a88e9fa1f320f`.
- 후보 revision: `analysis-preflight-worker-rpcfix-a97b2b6e-1118`. 0% staging에서 소스·이미지·세 attestation·기존 runtime·권한·큐·스케줄러를 검증했고 독립 리뷰가 통과했다.
- 임시 0% 태그로 GET `/api/analysis/preflight/recover`의 405를 받아 실제 Next 앱 기동을 확인했다. POST 전용 route의 method dispatch 확인이며, 사용자 분석·provider 성공 검사와 다르다. 태그 제거 후 전체 runtime 기준 해시가 복원됐다.
- 11/18 03:44:26 KST에 정확한 후보로 트래픽 100%를 전환했다. CAS를 사용했고 운영 활성화·용량·비밀 환경값·IAM·큐·스케줄러는 변경하지 않았다. 대기 작업은 0개였다.
- 03:45:04 KST에 기존 minutely scheduler의 recover POST가 새 revision에서 HTTP200으로 응답했다. 수동 POST·재처리·provider 호출은 0회이며, 이 관측 창의 요청 5xx는 0건이다. 별도 agent가 native 트래픽·Ready·attestation·보호 해시·이 scheduler 응답을 독립 확인했다. 짧은 관측창이며 실제 사용자 preflight나 유료 정식 분석 성공을 대신하지 않는다.

웹과 worker의 배포는 각각 native 상태로 확인했다. worker는 Vercel 웹 배포와 별도로 전환했으며 이후 문서만 바뀐 main과의 runtime 소스 동등성을 마감 시 확인한다.

## 추가로 재현한 B-lite 입력 계약 오류

별도 무과금 합성 재현에서 durable source가 허용하는 100자 해시태그를 inference 입력이 64자로 제한하는 불일치를 확인했다. 65~100자는 정상 저장 후 실제 runner에서 `inference_response_invalid` → `inference_failed/VALIDATION_ERROR`로 끝났다. 이 경로는 미디어·AI 작업 이전이다.

추론의 해시태그 제한만 기존 canonical source의 100자 상수를 사용하도록 정합화했다. 65·100자의 회귀 검사 실패를 먼저 확인한 뒤 수정했고 101자는 계속 외부 작업 전에 거절한다. 기존 3파일 44개 검사·타입체크·ESLint·diff가 통과했다. 구현자 외 reviewer는 관련 4파일 48개 검사와 코드 리뷰에서 P1/P2 0건을 보고했다. 상위 세션도 같은 코드에서 preflight 173개와 B-lite 44개를 각각 재실행해 모두 통과했다. 실제 외부 API·Apify·AI 호출은 0회다. 현재 확인된 계약 오류의 수정이며 10/28 실제 두 건과의 인과는 입증되지 않았다. 해당 입력과 validation path/길이 진단이 보존되지 않아 과거 두 건의 직접 원인은 미확정이다. 이 추가 수정의 PR 및 worker 배포 증거는 최종 마감 때 갱신한다.

## OAuth 상태 소실의 원인 범위

운영 `/auth/v1/health`의 GoTrue는 `v2.198.0`이다. 해당 tag는 소스 `387e91f37e00b64b9060352988066bbb685f6e45`와 같다. 관측한 `OAuth state not found or expired`는 provider 콜백이 `auth.flow_state` 행을 찾지 못했을 때 발생한다. 행이 남은 5분 기본 만료는 `OAuth state has expired`, 이미 콜백이 사용된 행이 남은 경우는 `State has already been used`라는 별도 오류다. 성공한 PKCE 교환은 상태 행을 삭제한다. [provider 상태 조회](https://github.com/supabase/auth/blob/v2.198.0/internal/api/external.go#L535-L573) · [PKCE 성공 시 삭제](https://github.com/supabase/auth/blob/v2.198.0/internal/api/token.go#L308-L351)

공식 Management API의 `auth_logs`를 집계해 다음 순서를 확인했다. OAuth state·code·사용자 식별자는 반환하거나 저장하지 않았다.

| 11/18 KST | 단계 | 응답 |
|---|---|---:|
| 00:29:56 | authorize 시작 | 302 |
| 00:30:01 | provider callback 성공 | 302 |
| 00:30:04 | PKCE token 교환 성공 | 200 |
| 00:30:05 | 상태 행 없음 callback 실패 | 303 |

마지막 오류와 303 로그는 내부 request ID의 distinct 집계로 한 요청임을 확인했다. 성공한 상태를 소비한 직후 provider 콜백이 다시 요청된 패턴이 유력하다. 그러나 기존 로그에는 두 콜백을 같은 flow로 연결할 값이 없으므로, 같은 콜백의 재사용인지와 뒤로가기·새로고침·중복 탐색 중 무엇이 재요청을 만들었는지는 확정하지 않는다. 이 순서가 사용자가 처음 제보한 브라우저 탐색과 같은 flow임을 확인한 것도 아니다. 시간 근접만으로 특정 브라우저 동작을 원인으로 기록하지 않는다.

조회 시 flattened `log_attributes['path']`는 해당 창의 23건 모두 `/`로 덮여 있었다. 원본 JSON의 `path`를 `JSONExtractString`으로 읽어 고정 경로만 분류했다. 경로 필드 오염을 실제 callback 부재로 해석하지 않았다. CLI의 현재 Keychain 인증은 DB 조회 403이어서 canonical root 환경의 기존 인증을 메모리에 주입한 공식 REST 읽기 경로와 Aside Studio의 읽기 전용 SQL을 사용했다. DB의 `auth.audit_log_entries`는 현재 0행이며 Auth 운영 로그와 구분했다. `auth.flow_state`의 사용자 정의 trigger는 0개다.

실제 설치 SDK `@supabase/ssr 0.8.0`·`auth-js 2.91.0`으로 외부 provider 없이 13개 조건을 검사했다. 서버 callback의 자동 코드 교환은 0회이고, 정상 경로의 명시적 exchange caller는 하나다. 로그인 동시 시작은 verifier 덮어쓰기 오류를 만들 수 있지만 상태 행 없음과 실패 계층이 다르다. 현재 앱 코드가 자동으로 두 번 교환한다는 증거는 없다.

[PR #608](https://github.com/0mininseoul/yeosachin-scanner/pull/608)의 관리자 복귀 처리와 수동 재로그인은 유지한다. `/admin0min`과 유효한 운영자 세션을 확인하며, 오래된 오류 query를 제거한다. 인증 우회·자동 OAuth 재시도·Auth 상태 삭제나 만료 설정 변경은 추가하지 않았다. 관리자 카카오 로그인과 비공개 API는 [앞선 실제 Aside 검증](2026-11-18-admin0min-dev-verification.ko.md)에서 확인했다.

## 남은 경계와 재개 조건

- OAuth의 실패 계층과 직전 성공 순서는 확인했다. 같은 provider 콜백을 재요청한 브라우저 동작은 미확정이다. 재발 시 로그인 시작·콜백·token 교환의 시각, 경로, 상태, 중복 탐색 여부를 민감값 없이 대조한다. 토큰·쿠키·state/code 원문·사용자 UUID 수집은 요구하지 않는다.
- 9월의 서비스 5xx를 모두 이번 결함으로 분류할 근거는 없다. 보존된 당일 경로·오류 분류가 추가 확보될 때만 같은 원인으로 연결한다.
- 10/28 B-lite `VALIDATION_ERROR` 두 건은 별도 유형이다. 현재 입력 계약 불일치는 무과금 합성 재현으로 수정했지만 당시 두 건의 직접 원인으로 확정하지 않는다. 보존된 검증 위치·길이 구간 자료가 추가 확보될 때만 연결한다. 유료 AI 재실행을 해법으로 가정하지 않는다.
- 실제 사용자 계정의 결제·정식 분석 성공은 사용자 실행 경계다. 이번 변경의 코드·DB 계약·배포 검증과 구분한다.

프로덕션 재활성화, queue/scheduler의 재개·주기 변경, 공급자 호출, migration 이력 변경, 사용자 소유 파일 변경은 이 작업에 포함하지 않는다. 보호 파일 2개·보존 manifest 3개·기존 browser 파일 7개·지정 archive ref 24개는 해시/정확한 ref 비교에서 변경이 없었다. 마감 시 다시 확인한다.
