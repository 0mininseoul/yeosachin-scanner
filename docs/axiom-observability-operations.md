# Axiom 운영 관측 가이드

이 문서는 서버 운영 로그를 Axiom에 연결하고 검증하는 운영 절차다. 2026-08-10 기준 제품 사건의 의미와 매출 집계 기준은 [8월 매출 우선 운영 전략](strategy/2026-08-08-revenue-first-operating-strategy.md), 구현 경계는 [매출 E2E·관측 설계](superpowers/specs/2026-08-10-revenue-e2e-observability-design.md)를 따른다. 애플리케이션 요청은 Axiom 장애와 무관하게 계속되어야 하며, 비밀 값은 이 문서, Git, 로그, 명령 출력에 기록하지 않는다.

공식 참고 문서:

- [데이터셋 관리](https://axiom.co/docs/reference/datasets)
- [API 토큰과 PAT](https://axiom.co/docs/reference/tokens)
- [요금제별 제한](https://axiom.co/docs/reference/limits)

## 1. 데이터셋과 조직 확인

- 로그인한 Axiom UI의 조직 전환 메뉴와 Settings에서 실제 조직 ID를 UI에서 확인한다. 예전 계획 문서의 조직 ID를 복사하거나 추측하지 않는다.
- Settings > Datasets and views > New dataset에서 Kind를 `Events`, 이름을 `yeosachin-logs`, Data retention을 `30일`로 설정한다.
- 이미 같은 이름의 데이터셋이 있으면 새로 만들지 않고 Kind와 retention을 확인한다. Personal 요금제의 최대 보관 기간도 30일이므로 더 길다고 가정하지 않는다.
- 운영 전 Settings 화면에서 실제 조직 ID, 데이터셋 이름, Kind, 30일 보관 설정을 다시 확인한다. 확인 결과에는 토큰 값을 기록하지 않는다.

## 2. 최소 권한 토큰과 환경 변수

Personal Access Token(PAT)은 초기 데이터셋·토큰 provisioning에만 사용한다. PAT는 계정 전체 권한을 가지므로 Vercel이나 애플리케이션 런타임에 사용하지 않으며, 저장소·운영 문서·스크린샷에 값을 남기지 않는다.

Settings > API tokens에서 `yeosachin-runtime-ingest`를 만들고 `yeosachin-logs`에 ingest만 가능한 전용 권한을 부여한다. Query, 데이터셋 관리, 대시보드, 모니터, 사용자·토큰·조직 관리 권한은 부여하지 않는다. 런타임에는 다음 서버 전용 변수만 설정한다.

```dotenv
AXIOM_TOKEN=<dataset-scoped-ingest-token>
AXIOM_DATASET=yeosachin-logs
AXIOM_ORG_ID=<UI에서 확인한 실제 조직 ID>
```

`AXIOM_TOKEN`과 `AXIOM_ORG_ID`는 클라이언트 공개 변수가 아니다. 값을 출력하는 진단 명령, shell tracing, 브라우저 번들, 클라이언트 API 응답을 사용하지 않는다.

배포 순서:

- 로컬: 무해한 합성 이벤트 한 건으로 ingest가 되고 데이터셋 조회·관리 권한은 거부되는지 확인한다.
- Vercel Preview: 위 세 변수만 Preview에 추가하고 대표 시나리오 및 금지 필드 검사를 완료한다.
- Production: Preview 검증과 개인정보 검토가 끝난 동일한 데이터셋·권한 구성을 Production에 추가한다. 현재 데이터셋은 중첩 객체가 아니라 평탄화된 dotted key로 저장되므로 APL에서는 항상 `['fields.environment'] == "production"`으로 필터링한다.
- 변수 누락이나 Axiom 전송 실패가 서비스 응답을 실패시키지 않는지도 확인한다.

## 3. 안전한 이벤트와 필드

애플리케이션은 닫힌 allowlist를 통과한 이벤트만 보낸다.

- HTTP·Next: `http.route_completed`, `http.route_failed`, `next.request_error`
- 인증·사전 검사: `auth.*`, `preflight.*`
- 결제 전 B-lite 서버 결과: `precheckout_blite.completed`, `precheckout_blite.profile_collection_failed`, `precheckout_blite.inference_failed`, `precheckout_blite.finalizer_failed`; 브라우저 결과 `precheckout_blite.fallback_latched`·`precheckout_blite.demo_started`·`precheckout_blite.demo_completed`·`precheckout_blite.demo_failed`는 Amplitude
- 결제: `earlybird.checkout_*`, `earlybird.waitlist_*`, `groble.webhook_*`
- 수집: `scraper.batch_*`, `scraper.fallback_selected`, `scraper.candidate_failed`
- 작업 큐·분석: `cloud_task.enqueue_*`, `analysis_v2.fresh_admission_enqueued`, `analysis_v2.request_queued`, `analysis_v2.worker_*`, `analysis_v2.result_viewed`
- 결과 공유: `result_share_initiated`, `result_share_copy_succeeded`, `result_share_handoff_completed`, `result_share_cancelled`, `result_share_failed`, `result_shared_confirmed`, `shared_result_opened`
- AI: `gemini.stage_*`

허용 차원은 환경, 이벤트, severity, request/trace ID, 정적 route·method·status·duration, 내부 user/preflight/order/analysis UUID, job key, 대상·후보·제외 인스타그램 아이디, provider·operation·phase·attempt·disposition, 집계 건수, 오류 코드, retry/fallback, 모델·thinking level·토큰 수·추정 비용, plan·금액, 서버가 판정한 `traffic_class`로 제한한다. B-lite fallback latch는 `terminal_before_48`, `unresolved_at_48`, `demo_error`만 disposition으로 허용하고, demo outcome은 `completed` 또는 `failed`만 사용한다. 성공은 배치·단계 단위로 집계하고, 후보 인스타그램 아이디는 실패·재시도·fallback 진단에서만 사용한다. `traffic_class`는 `external`, `operator`, `e2e_test`, `internal_tester`, `unknown`의 닫힌 값만 허용하고 매출·수요 지표는 `external`만 집계한다.

`precheckout_blite.fallback_latched`와 `precheckout_blite.demo_*`의 허용 차원은 `preflight_id`, `operation`, `duration_ms`, `disposition`뿐이며 provider 차원이나 provider 실행을 추가하지 않는다. No provider attempt is synthesized for a fallback latch, demo completion/failure, cache hit, another owner's pending lease, or access denial. `duration_ms`는 submit-origin 시각부터의 bounded elapsed time으로 조사하고, T+48 unresolved latch는 T+48–T+60의 12초 demo guard와 함께 확인한다.

브라우저에서만 결정되는 `precheckout_blite.fallback_latched`, `precheckout_blite.demo_started`, `precheckout_blite.demo_completed`, `precheckout_blite.demo_failed`는 Amplitude 제품 퍼널이 소유한다. 기존 인증·상태 route는 상태 조회 전용이므로 별도 public logging endpoint나 bounded beacon을 추가하지 않으며, Vercel/Axiom은 서버 결과(`precheckout_blite.completed`, `precheckout_blite.profile_collection_failed`, `precheckout_blite.inference_failed`)만 담당한다.

공유 사건은 더 좁은 전용 allowlist를 사용한다. `event`, `request_id`, `share_channel`, `share_outcome`, `traffic_class`, environment·route·status와 필요한 correlation ID만 허용한다. 공유 URL·토큰, user/preflight/order ID, Instagram 식별자, 결과 내용은 기록하지 않는다. 클립보드 성공은 링크 복사, Web Share 성공은 OS handoff일 뿐 수신자 전달 확인이 아니다. `result_shared_confirmed`는 Kakao 공식 Share webhook을 검증한 경우에만 사용한다.

다음은 금지 필드다.

- 구매자 이름·이메일·전화번호, 결제 ID·상품 secret·idempotency key
- 댓글, bio·소개글, caption, 프롬프트, AI 근거·응답·총평
- 프로필·이미지·미디어 URL 및 페이지 URL
- OAuth/provider/API 토큰, 쿠키, 세션, 서명, 서비스 계정 자격증명
- 원문 request/response body, Groble webhook body, 외부 API body

Vercel 런타임에서는 같은 allowlist로 정제된 이벤트를 구조화 console 로그에도 남긴다. 따라서 Vercel은 즉시 장애 확인·특정 `request_id` 검색에, Axiom은 30일 범위의 상태 전환·집계·상관관계 조회에 사용한다. 두 곳 모두 원문 예외, 요청 본문, 토큰, 연락처를 기록하지 않는다.

Vercel lifecycle 이벤트는 Axiom에 보관한다. Cloud Run preflight worker는 Axiom transport가 없을 때 allowlist를 통과한 JSON 한 줄을 stdout으로 기록하며, Cloud Logging이 이를 구조화 로그로 수집한다. 따라서 worker의 terminal 이벤트는 Axiom 전송이 없는 배포에서는 Cloud Logging에서 조사한다.

Cloud Logging Logs Explorer에서 worker terminal 이벤트만 안전하게 확인하려면 다음 필터를 사용하고, 결과는 `timestamp`·`jsonPayload.event`·`jsonPayload.disposition`·`jsonPayload.error_code`·`jsonPayload.attempt`만으로 판독한다. 전체 payload를 내보내거나 내부 식별자를 티켓·채팅에 복사하지 않는다.

```text
resource.type="cloud_run_revision"
resource.labels.service_name="analysis-worker"
jsonPayload.event=~"^preflight\.(completed|failed)$"
```

Cloud Tasks 재시도로 terminal 이벤트는 attempt 단위 at-least-once로 전달될 수 있다. `preflight_id`·`event`·`attempt`가 모두 있을 때만 `preflight_id + event + attempt`를 dedupe 키로 사용한다. 완료 이벤트처럼 `attempt`가 없거나 pre-parse/config/auth reject처럼 correlation field가 없는 경우에는 `event`와 사용 가능한 correlation field 및 제한된 시간 창으로만 조사하며, 이 로그는 영속 exactly-once를 보장하지 않는다.

## 4. Preview 대표 검증

실제 구매자 개인정보 대신 테스트 UUID와 합성 fixture를 사용한다. 각 단계의 응답 상태가 기존 동작과 동일하고 Axiom 전송 실패가 제품 흐름을 바꾸지 않는지 확인한다.

- auth callback 성공과 프로필 동기화 실패 fixture
- preflight 성공·실패 및 제외 계정 결정
- scraper provider 실패 후 fallback 선택
- Cloud Tasks enqueue와 V2 worker 성공·재시도·terminal 실패
- Gemini 단계 성공·rate limit·실패 및 토큰·비용 집계
- 유효한 테스트 서명으로 만든 Groble fixture의 accepted와 unmatched/mismatch 처리. 실제 구매자 PII와 원문 webhook은 사용하지 않는다.
- 결과 소유자 또는 허용된 관리자의 공유 endpoint 호출과 비인가 호출 거부
- clipboard 성공·거절, Web Share handoff·취소·실패, Kakao Share webhook의 유효·중복·무효 요청. 실제 공유 URL·토큰은 로그 fixture에 넣지 않는다.
- Axiom 전송 실패 시 공유 UI와 webhook의 제품 응답이 기존 의미를 유지하는지 확인

대표 레코드를 조회한다.

```apl
['yeosachin-logs']
| where ['fields.environment'] == "preview"
| where _time > ago(24h)
| project _time, ['fields.event'], ['fields.severity'], ['fields.route'], ['fields.status'],
    ['fields.duration_ms'], ['fields.provider'], ['fields.operation'], ['fields.phase'],
    ['fields.disposition'], ['fields.error_code']
| limit 200
```

B-lite가 소유한 durable generation lease의 terminal outcome은 다음 production 조회로 확인한다. `provider=apify`인 실패는 프로필 수집, `provider=gemini`인 실패는 이미지 준비 또는 추론 경계다. `precheckout_blite.finalizer_failed`는 source/cache/dispatch를 만들기 전 최종화 RPC가 fail-open된 사건이며, `correlation`은 `schema_cache_miss` 또는 `fence_lost`의 닫힌 값만 허용한다. B-lite 실패 응답의 기존 `204` fail-open은 preflight와 checkout availability를 보존하며, 관측 전송 실패도 이 응답을 바꾸지 않는다. cache hit, 다른 인스턴스가 소유한 pending lease, access denial은 새 provider outcome으로 집계하지 않는다.

```apl
['yeosachin-logs']
| where ['fields.environment'] == "production"
| where ['fields.event'] in (
    "precheckout_blite.completed",
    "precheckout_blite.profile_collection_failed",
    "precheckout_blite.inference_failed",
    "precheckout_blite.finalizer_failed"
)
| project _time, ['fields.event'], ['fields.provider'], ['fields.operation'],
    ['fields.error_code'], ['fields.disposition'], ['fields.duration_ms'],
    ['fields.preflight_id'], ['fields.correlation']
| order by _time desc
```

Fallback/SLA의 브라우저 결과는 Amplitude에서 `fallback_latched`, `demo_started`, `demo_completed`, `demo_failed`로 집계하고, Vercel/Axiom에서는 위 서버 terminal events만 확인한다. Terminal failure가 T+48 전에 발생했는지, unresolved 요청이 T+48에서 latch되었는지, demo가 정확히 한 번 완료되었는지/실패했는지는 제품 퍼널에서 분리해 본다. 제출 시각부터 fallback legacy reveal까지의 p50/p95/p99와 T+60 plans-hidden guard rate는 Amplitude outcome과 서버 `duration_ms`를 함께 사용한다. Fallback, timeout, refresh, retry, late result, or demo event must never trigger a new Instagram collection.

금지 필드 감사 체크리스트:

- Dataset Fields 검색에서 `email`, `phone`, `buyer`, `token`, `cookie`, `signature`, `comment`, `bio`, `caption`, `prompt`, `image`, `media`, `url`, `body`, `response`가 애플리케이션 필드로 존재하지 않는지 확인한다.
- 위 대표 조회의 raw event JSON을 표본 검사해 값에도 연락처·콘텐츠·자격증명이 없는지 확인한다.
- `target_instagram_id`, `candidate_instagram_id`, `excluded_instagram_id`는 허용된 장애 진단 목적에서만 보이는지 확인한다.
- 금지 데이터가 발견되면 즉시 Production rollout과 Axiom ingest를 중단하고 런타임 토큰을 폐기한다. 로거 allowlist와 영향범위를 확인한 뒤만 재개한다.
- Axiom `Trim`은 지정 시각보다 오래된 데이터 **블록**을 비가역적으로 삭제하며, 새 이벤트와 같은 블록에 있는 이전 이벤트는 남을 수 있다. 따라서 특정 최신 이벤트의 삭제를 보장하지 않으며 대상 기간 삭제 도구로 사용하지 않는다.
- 정확한 폐기가 필요하면 영향 범위를 동결하고 데이터셋 재생성 또는 Axiom 지원을 통한 폐기 방법을 검토한다. `Trim`, 데이터셋 삭제·재생성 같은 파괴적 조치는 영향·복구 불가성을 문서화하고 사업자의 명시적 승인을 받은 후에만 실행한다. 이벤트가 폐기된 뒤 Fields vacuum으로 남은 스키마를 정리한다.

## 5. 대시보드

Axiom UI에서 `Yeosachin Operational Health`를 만들고 모든 요소에 `['fields.environment']` 변수를 적용한다. 운영 기본값은 `production`, Preview 검증 시에만 `preview`로 바꾼다. 현재 평탄화된 데이터셋에서는 패널의 이벤트·차원 필터도 `['fields.event']`, `['fields.status']`, `['fields.duration_ms']`처럼 bracket-quoted dotted key를 사용한다.

- Route health: 요청 수, 4xx·5xx 비율, `duration_ms` p50·p90
- Preflight: 요청·완료·실패 수, 오류 코드, 플랜별 지연
- Provider: provider·operation별 요청·실패·fallback·quota/rate limit
- Gemini: operation·model·thinking level별 지연, rate limit·재시도, prompt/completion/thinking token, 추정 비용
- B-lite server terminal: `precheckout_blite.completed`, `precheckout_blite.profile_collection_failed`, `precheckout_blite.inference_failed`, `precheckout_blite.finalizer_failed`의 provider·error code·duration; finalizer failure는 닫힌 `correlation`으로만 원인을 집계하며, 브라우저 fallback/demo 퍼널과 T+60 guard는 Amplitude 기준
- Cloud Tasks / V2 worker: enqueue 결과, retry·failure·timeout, job key·phase별 상태
- Groble: `accepted`, `duplicate_event`, `duplicate_payment`, `unmatched`, `ambiguous_buyer`, `mismatch`, `overflow_refund_required`, `cancel_requested`, `cancel_duplicate_event`, `cancel_unmatched`, `cancel_mismatch`, `cancel_before_payment`, `late_cancelled_payment` disposition과 webhook route 5xx
- Analysis: 완료·실패 수, 총 지연, phase별 p50·p90 단계 지연
- Result sharing: share event·channel·outcome·`traffic_class`별 수. 제품 KPI에는 `traffic_class=external`만 사용하고 initiated/copy/handoff/Kakao-confirmed/open을 합치지 않는다.
- User lifecycle: `preflight.requested` → `preflight.completed` → `preflight.exclusion_decided` → `earlybird.checkout_created` 또는 `earlybird.waitlist_created` → `groble.webhook_finalized` → `analysis_v2.fresh_admission_enqueued` → `analysis_v2.request_queued` → `analysis_v2.worker_*` → `analysis_v2.result_viewed` → 공유 사건 → `shared_result_opened` 수와 이탈 지점

성공 로그 수를 계정·이미지 수로 해석하지 않는다. 대시보드의 결제 금액은 운영 신호이며 매출 장부는 Supabase를 기준으로 한다.

## 6. 사용자 여정 조사

한 사용자의 여정은 브라우저 클릭 전체를 복제하는 방식이 아니라, 서버가 실제로 수락·완료한 상태 전환으로 재구성한다. 아래 키를 순서대로 연결한다.

1. `preflight_id`: 사전 점검 요청, 완료/차단, 제외 결정, 결제·대기 신청의 기본 키
2. `order_id`: checkout 생성과 Groble webhook 최종화의 연결 키
3. `analysis_request_id`: 분석 접수, 워커 실행, 결과 페이지 열람과 공유 시도의 기본 키
4. `job_key`: 한 분석 요청 안의 큐·워커 단계 키
5. `request_id`: 하나의 HTTP 요청과 Vercel 런타임 로그를 연결하는 단기 진단 키

`preflight_id`와 `analysis_request_id`는 `analysis_v2.request_queued`에 함께 기록된다. 결제 webhook은 `order_id`로 checkout 생성 이벤트와 연결한다. 따라서 결제 webhook만으로 user 또는 preflight를 역조회하려 하지 않는다.

사전 점검부터 결과 페이지 열람·공유까지의 전환을 확인하는 기본 조회 예시는 다음과 같다. 실제 UUID 값은 운영 티켓·로그 출력에 복사하지 않고 Axiom UI의 안전한 필터 입력으로만 사용한다. 사업 지표로 볼 때는 `['fields.traffic_class'] == "external"` 필터를 추가한다.

```apl
['yeosachin-logs']
| where ['fields.environment'] == "production"
| where ['fields.event'] in (
    "preflight.requested", "preflight.completed", "preflight.exclusion_decided",
    "earlybird.checkout_created", "earlybird.waitlist_created",
    "groble.webhook_finalized", "analysis_v2.fresh_admission_enqueued",
    "analysis_v2.request_queued", "analysis_v2.worker_completed",
    "analysis_v2.worker_retry", "analysis_v2.worker_failed", "analysis_v2.result_viewed",
    "result_share_initiated", "result_share_copy_succeeded",
    "result_share_handoff_completed", "result_share_cancelled", "result_share_failed",
    "result_shared_confirmed", "shared_result_opened"
)
| project _time, ['fields.event'], ['fields.severity'], ['fields.disposition'],
    ['fields.error_code'], ['fields.request_id'], ['fields.user_id'], ['fields.preflight_id'],
    ['fields.order_id'], ['fields.analysis_request_id'], ['fields.job_key'], ['fields.plan_id'],
    ['fields.status'], ['fields.duration_ms'], ['fields.share_channel'],
    ['fields.share_outcome'], ['fields.traffic_class']
| order by _time asc
```

결과 페이지의 다음 페이지와 진행 화면의 폴링은 lifecycle 이벤트로 기록하지 않는다. `analysis_v2.result_viewed`는 커서 없는 결과 페이지 응답을 기록하므로 새로고침·재열람은 별도 실제 열람으로 남을 수 있다. `result_share_copy_succeeded`와 `result_share_handoff_completed`는 수신자 전달이 아니라 각각 복사와 OS handoff의 운영 신호다. 고유 전환율은 Amplitude의 제품 퍼널을 기준으로 보고, Axiom에서는 결과 도달·재열람·공유 경계의 운영 신호로만 사용한다.

Vercel에서 같은 시점의 상세 요청을 볼 때는 Axiom 이벤트의 `request_id`와 route를 사용한다. Axiom은 상태 전환의 권위 있는 보관소이고, Vercel은 짧은 실시간 조사 창이다. 어느 쪽도 Amplitude의 브라우저 UX 퍼널을 대체하지 않는다.

## 7. 출시 모니터

Personal 요금제의 3개 모니터 제한 안에서 다음 세 개의 결합 모니터만 먼저 만든다. 모든 쿼리는 `['fields.environment'] == "production"`을 강제하고 `['fields.event']`, `['fields.disposition']`, `['fields.error_code']`, `['fields.status']`로 조건을 작성해 테스트·Preview 이벤트를 제외한다.

- `Launch / Payment health`: Groble route 5xx 또는 `unmatched`, `ambiguous_buyer`, `mismatch`, `overflow_refund_required`, `cancel_requested`, `cancel_*`, `late_cancelled_payment` 조건이 한 건 이상 발생
- `Launch / Analysis terminal health`: terminal analysis/V2 worker failure 또는 timeout이 한 건 이상 발생
- `Launch / Provider access health`: provider 인증 실패, quota 초과 또는 rate limit 소진이 한 건 이상 발생

이메일이나 Discord notifier가 실제로 연결되어 있으면 각 모니터를 활성화하고 테스트 알림을 확인한다. notifier가 없거나 미구성 상태면 모니터를 disabled(비활성)로 저장하고 알림 목적지 연결을 후속 작업으로 기록한다. 존재하지 않는 연락처나 notifier를 임의로 만들지 않는다.

결제 5xx와 구매자 불일치, 분석 실패와 worker timeout 등을 별도 모니터로 나누는 것은 요금제 용량을 늘린 뒤에만 수행한다.

## 8. 장애 대응

- 결제: `request_id`·`order_id`로 route 실패와 `groble.webhook_*` disposition을 연결한다. 구매자 연락처나 raw webhook을 Axiom에서 찾지 않는다.
- 분석: `preflight_id` → `analysis_request_id` → `job_key` 순으로 `analysis_v2.request_queued`, worker, `analysis_v2.result_viewed`를 연결한다.
- 공유: `analysis_request_id`와 `request_id`로 공유 사건을 연결하되 로그에서 공유 URL·토큰·Instagram 식별자·결과 내용을 찾지 않는다. Kakao 확인 전송은 검증된 webhook 사건만 인정한다.
- Provider: provider·operation·error code·fallback을 확인하고 quota/auth 문제인지 일시 장애인지 구분한다.
- Gemini: operation·model·attempt·rate limit·토큰·비용 집계를 확인한다. 프롬프트나 모델 응답은 Axiom에서 찾지 않는다.
- 영향 범위와 시작 시각을 기록한 뒤 admission 또는 worker gate 등 기존 운영 스위치로 신규 작업을 제한한다. 데이터 수정·재실행은 해당 runbook의 멱등성과 fence 조건을 확인한 뒤 수행한다.

## 9. 토큰 회전

토큰 회전은 기존 토큰을 먼저 폐기하지 않는 순서로 진행한다.

- Axiom UI에서 같은 데이터셋 ingest-only 권한의 새 런타임 토큰을 만든다.
- 로컬 또는 Preview에서 합성 이벤트 한 건과 관리 권한 거부를 확인한다.
- Vercel Preview의 `AXIOM_TOKEN`을 교체해 대표 이벤트를 확인한다.
- Production 변수를 교체하고 새 배포에서 ingest를 확인한다.
- 이전 런타임 토큰을 폐기하고 감사 기록에는 회전 시각과 토큰 이름만 남긴다.
- PAT 노출이 의심되면 계정 전체 권한 사고로 취급하여 즉시 폐기·재발급하고, 런타임에는 새 ingest-only 토큰만 둔다.

토큰 값은 티켓, 문서, 채팅, 로그, 스크린샷에 남기지 않는다.
