# Axiom 운영 관측 가이드

이 문서는 서버 운영 로그를 Axiom에 연결하고 검증하는 운영 절차다. 애플리케이션 요청은 Axiom 장애와 무관하게 계속되어야 하며, 비밀 값은 이 문서, Git, 로그, 명령 출력에 기록하지 않는다.

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
- Production: Preview 검증과 개인정보 검토가 끝난 동일한 데이터셋·권한 구성을 Production에 추가한다. 운영 데이터는 항상 `environment == "production"`으로 필터링한다.
- 변수 누락이나 Axiom 전송 실패가 서비스 응답을 실패시키지 않는지도 확인한다.

## 3. 안전한 이벤트와 필드

애플리케이션은 닫힌 allowlist를 통과한 이벤트만 보낸다.

- HTTP·Next: `http.route_completed`, `http.route_failed`, `next.request_error`
- 인증·사전 검사: `auth.*`, `preflight.*`
- 결제: `earlybird.checkout_*`, `groble.webhook_*`
- 수집: `scraper.batch_*`, `scraper.fallback_selected`, `scraper.candidate_failed`
- 작업 큐·분석: `cloud_task.enqueue_*`, `analysis_v2.worker_*`
- AI: `gemini.stage_*`

허용 차원은 환경, 이벤트, severity, request/trace ID, 정적 route·method·status·duration, 내부 user/preflight/order/analysis UUID, job key, 대상·후보·제외 인스타그램 아이디, provider·operation·phase·attempt·disposition, 집계 건수, 오류 코드, retry/fallback, 모델·thinking level·토큰 수·추정 비용, plan·금액으로 제한한다. 성공은 배치·단계 단위로 집계하고, 후보 인스타그램 아이디는 실패·재시도·fallback 진단에서만 사용한다.

다음은 금지 필드다.

- 구매자 이름·이메일·전화번호, 결제 ID·상품 secret·idempotency key
- 댓글, bio·소개글, caption, 프롬프트, AI 근거·응답·총평
- 프로필·이미지·미디어 URL 및 페이지 URL
- OAuth/provider/API 토큰, 쿠키, 세션, 서명, 서비스 계정 자격증명
- 원문 request/response body, Groble webhook body, 외부 API body

## 4. Preview 대표 검증

실제 구매자 개인정보 대신 테스트 UUID와 합성 fixture를 사용한다. 각 단계의 응답 상태가 기존 동작과 동일하고 Axiom 전송 실패가 제품 흐름을 바꾸지 않는지 확인한다.

- auth callback 성공과 프로필 동기화 실패 fixture
- preflight 성공·실패 및 제외 계정 결정
- scraper provider 실패 후 fallback 선택
- Cloud Tasks enqueue와 V2 worker 성공·재시도·terminal 실패
- Gemini 단계 성공·rate limit·실패 및 토큰·비용 집계
- 유효한 테스트 서명으로 만든 Groble fixture의 accepted와 unmatched/mismatch 처리. 실제 구매자 PII와 원문 webhook은 사용하지 않는다.

대표 레코드를 조회한다.

```apl
['yeosachin-logs']
| where environment == "preview"
| where _time > ago(24h)
| project _time, event, severity, route, status, duration_ms, provider, operation, phase, disposition, error_code
| limit 200
```

금지 필드 감사 체크리스트:

- Dataset Fields 검색에서 `email`, `phone`, `buyer`, `token`, `cookie`, `signature`, `comment`, `bio`, `caption`, `prompt`, `image`, `media`, `url`, `body`, `response`가 애플리케이션 필드로 존재하지 않는지 확인한다.
- 위 대표 조회의 raw event JSON을 표본 검사해 값에도 연락처·콘텐츠·자격증명이 없는지 확인한다.
- `target_instagram_id`, `candidate_instagram_id`, `excluded_instagram_id`는 허용된 장애 진단 목적에서만 보이는지 확인한다.
- 금지 데이터가 발견되면 즉시 Production rollout을 중단한다. 문제 코드를 차단한 뒤 데이터셋 Trim으로 잘못 적재된 기간을 삭제하고 Fields vacuum을 수행한 다음 다시 검증한다.

## 5. 대시보드

Axiom UI에서 `Yeosachin Operational Health`를 만들고 모든 요소에 `environment` 변수를 적용한다. 운영 기본값은 `production`, Preview 검증 시에만 `preview`로 바꾼다.

- Route health: 요청 수, 4xx·5xx 비율, `duration_ms` p50·p90
- Preflight: 요청·완료·실패 수, 오류 코드, 플랜별 지연
- Provider: provider·operation별 요청·실패·fallback·quota/rate limit
- Gemini: operation·model·thinking level별 지연, rate limit·재시도, prompt/completion/thinking token, 추정 비용
- Cloud Tasks / V2 worker: enqueue 결과, retry·failure·timeout, job key·phase별 상태
- Groble: accepted, unmatched, ambiguous, mismatch, cancel, overflow refund disposition과 webhook route 5xx
- Analysis: 완료·실패 수, 총 지연, phase별 p50·p90 단계 지연

성공 로그 수를 계정·이미지 수로 해석하지 않는다. 대시보드의 결제 금액은 운영 신호이며 매출 장부는 Supabase를 기준으로 한다.

## 6. 출시 모니터

Personal 요금제의 3개 모니터 제한 안에서 다음 세 개의 결합 모니터만 먼저 만든다. 모든 쿼리는 `environment == "production"`을 강제하고 테스트·Preview 이벤트를 제외한다.

- `Launch / Payment health`: Groble route 5xx 또는 `unmatched`, `ambiguous`, `mismatch`, `overflow_refund_required`가 한 건 이상 발생
- `Launch / Analysis terminal health`: terminal analysis/V2 worker failure 또는 timeout이 한 건 이상 발생
- `Launch / Provider access health`: provider 인증 실패, quota 초과 또는 rate limit 소진이 한 건 이상 발생

이메일이나 Discord notifier가 실제로 연결되어 있으면 각 모니터를 활성화하고 테스트 알림을 확인한다. notifier가 없거나 미구성 상태면 모니터를 disabled(비활성)로 저장하고 알림 목적지 연결을 후속 작업으로 기록한다. 존재하지 않는 연락처나 notifier를 임의로 만들지 않는다.

결제 5xx와 구매자 불일치, 분석 실패와 worker timeout 등을 별도 모니터로 나누는 것은 요금제 용량을 늘린 뒤에만 수행한다.

## 7. 장애 대응

- 결제: `request_id`·`order_id`로 route 실패와 `groble.webhook_*` disposition을 연결한다. 구매자 연락처나 raw webhook을 Axiom에서 찾지 않는다.
- 분석: `analysis_request_id`·`job_key`·phase로 enqueue, worker retry, terminal 결과를 연결한다.
- Provider: provider·operation·error code·fallback을 확인하고 quota/auth 문제인지 일시 장애인지 구분한다.
- Gemini: operation·model·attempt·rate limit·토큰·비용 집계를 확인한다. 프롬프트나 모델 응답은 Axiom에서 찾지 않는다.
- 영향 범위와 시작 시각을 기록한 뒤 admission 또는 worker gate 등 기존 운영 스위치로 신규 작업을 제한한다. 데이터 수정·재실행은 해당 runbook의 멱등성과 fence 조건을 확인한 뒤 수행한다.

## 8. 토큰 회전

토큰 회전은 기존 토큰을 먼저 폐기하지 않는 순서로 진행한다.

- Axiom UI에서 같은 데이터셋 ingest-only 권한의 새 런타임 토큰을 만든다.
- 로컬 또는 Preview에서 합성 이벤트 한 건과 관리 권한 거부를 확인한다.
- Vercel Preview의 `AXIOM_TOKEN`을 교체해 대표 이벤트를 확인한다.
- Production 변수를 교체하고 새 배포에서 ingest를 확인한다.
- 이전 런타임 토큰을 폐기하고 감사 기록에는 회전 시각과 토큰 이름만 남긴다.
- PAT 노출이 의심되면 계정 전체 권한 사고로 취급하여 즉시 폐기·재발급하고, 런타임에는 새 ingest-only 토큰만 둔다.

토큰 값은 티켓, 문서, 채팅, 로그, 스크린샷에 남기지 않는다.
