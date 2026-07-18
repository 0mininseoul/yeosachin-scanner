# Amplitude, Axiom, Groble 전화번호 매칭 설계

## 목표

이 작업은 얼리버드 결제 매칭을 추가 입력 없이 안전하게 수행하고, 제품 전환과 운영 장애를 각각 Amplitude와 Axiom에서 관측 가능하게 만든다.

성공 조건은 다음과 같다.

- 새 사용자에게는 카카오 로그인만 노출한다.
- Groble 구매자 전화번호가 정규화된 카카오 전화번호와 일치하면, Groble 이메일과 서비스 로그인 이메일이 달라도 결제를 자동 확정한다.
- Groble 구매자 이메일·전화번호·표시 이름은 Supabase에 운영자 전용 결제 증거로 보관한다.
- Amplitude Analytics와 Session Replay가 클라이언트에서 한 번만 초기화되고 핵심 전환 이벤트를 수집한다.
- Axiom에서 인증, 사전 검사, 크롤러, Gemini, Cloud Tasks, Groble, 분석 파이프라인의 구조화된 로그를 조회한다.
- Axiom 로그에 대상·후보·제외 인스타그램 아이디를 포함하되, 이메일·전화번호·토큰·쿠키·댓글·bio·이미지 URL과 외부 API 원문은 제외한다.

## 비목표

- 이 작업에서 Groble 상품, 가격, 수량, 자동 분석 시작 정책을 바꾸지 않는다.
- Plus 대기 신청 전용 Amplitude 차트를 만들지 않는다.
- Axiom을 브라우저에 직접 노출되는 클라이언트 로그 수집기로 사용하지 않는다.
- Amplitude를 실제 결제 장부의 정합성 기준으로 사용하지 않는다. 실제 결제 건수와 금액은 Supabase를 기준으로 한다.

## 1. 인증 및 결제 식별자

### 신규 인증 UX

`AuthButtons`의 신규 회원가입·로그인 UI에서 Google 버튼을 숨기고 카카오만 노출한다. Supabase Google provider, Google 사용자 레코드, 기존 세션, 공용 callback 처리는 삭제하지 않는다. 이는 기존 Google 사용자의 소유 데이터를 보전하는 레거시 호환 경로다.

카카오 callback은 `/v2/user/me`를 통해 이름과 전화번호를 매 로그인 시점에 최신화한다. 사용자가 카카오톡을 사용하지 않아 전화번호가 제공되지 않는 등의 예외를 필수 케이스로 다룬다.

### 전화번호 정규화

서버 공용 전화번호 정규화기는 다음 계약을 따른다.

- 국가 코드, 공백, 하이픈, 괄호를 포함한 입력을 파싱한다.
- 한국 휴대전화 `010-1234-5678`과 `+82 10-1234-5678`을 같은 E.164 형식으로 변환한다.
- 파싱하지 못한 값은 매칭에 사용하지 않는다.
- `users.phone_number_normalized`는 널이 아닌 값에 대해 유일해야 한다. 중복은 자동 결제 확정 대신 운영 확인 대상이다.

구현은 임의 문자열 치환 대신 검증된 전화번호 파서를 사용하고 테스트 케이스로 규칙을 고정한다.

### 결제 시작 규칙

- 카카오 사용자의 정규화 전화번호가 없으면 checkout 스냅샷을 생성하지 않고 재로그인 또는 고객 지원 안내를 표시한다.
- checkout RPC는 현재 프로필에서 파생한 정규화 전화번호를 주문의 `expected_buyer_phone_number_normalized`로 스냅샷한다. webhook은 로그인 프로필의 사후 변경이 아니라 이 불변 checkout 증거와 매칭한다.
- migration 1번의 `earlybird_orders` `BEFORE INSERT` trigger는 snapshot이 null이고 사용자가 Kakao일 때만 유효한 raw `phone_number`를 먼저 정규화하고, raw 값이 무효할 때만 저장된 normalized 값으로 fallback한다. UPDATE에는 동작하지 않는다. 따라서 2번 RPC 교체 전에 시작해 사용자 advisory lock에서 대기하다가 3번 백필 후 이전 본문으로 INSERT하는 checkout도 snapshot 공백을 만들지 않는다. 2번 RPC도 같은 파생 규칙을 적용하고 전화번호 없는 새 Kakao 호출을 INSERT 전에 거부한다.
- 기존 Google 사용자의 활성 세션은 기존 이메일 매칭 계약으로 checkout을 완료할 수 있다.
- 새 Google 로그인 진입점은 UI에 노출하지 않는다.

## 2. Groble webhook 매칭

### 파싱

`payment.completed` parser는 `buyer.email` 외에 다음 공식 필드를 검증하고 반환한다.

- `buyer.displayName`
- `buyer.phoneNumber`

전화번호는 현재 Groble 계약에서 제공되지만, 이전 테스트 payload 호환을 위해 parser 입력에서는 부재할 수 있다. 부재하면 이메일 fallback으로 진입한다.

### 자동 매칭 순서

1. 결제 ID와 webhook 이벤트 ID로 기존 멱등 처리를 먼저 확인한다.
2. Groble 구매자 전화번호를 정규화한다.
3. `expected_buyer_phone_number_normalized + expected_groble_product_id + payment_pending`에 일치하는 주문이 정확히 하나면 선택한다.
4. 3번이 성공하면 Groble 이메일과 서비스 이메일이 달라도 결제를 자동 확정한다. 표시 이름은 매칭 필수 조건이 아니다.
5. pending 전화번호 후보가 0개이면 이메일보다 먼저 `cancelled + payment_id IS NULL` 스냅샷을 전화번호, 상품, 금액으로 조회한다.
6. 5번 후보가 하나면 이메일이 달라도 `late_cancelled_payment`/`refund_pending`으로 격리하고, 둘 이상이면 `ambiguous_buyer`로 보관한다. 둘 다 재고를 차감하지 않는다.
7. pending과 cancelled 전화번호 후보가 모두 0개일 때만 기존 `buyer.email + product + payment_pending` 규칙과 기존 late-cancelled 규칙으로 fallback한다.
8. 전화번호 또는 이메일 fallback 후보가 0개이거나 2개 이상이면 재고를 차감하지 않고 `unmatched` 또는 `ambiguous_buyer`로 보관한다.
9. 후보 선택 후에 상품과 금액이 스냅샷과 다르면 기존 `mismatch` 처리를 유지한다.

이 규칙에서 전화번호는 이메일보다 우선한다. 유저가 본인 전화번호로 다른 이메일을 사용해 결제하는 것이 정상 케이스이기 때문이다.

### 데이터 모델

`users`에 `phone_number_normalized`를 추가하고 널이 아닌 값에 대한 유일 인덱스를 둔다. 5개의 순차 migration이 nullable DDL·짧은 order INSERT trigger, checkout snapshot RPC, 백필·중복 중단, check validation·index, finalization RPC를 각 implicit transaction으로 분리한다. 1번 커밋 후의 null Kakao INSERT는 호출이 사용하는 RPC 본문 버전과 무관하게 trigger가 snapshot을 채우며, 1번 전에 존재한 null snapshot은 3번이 채운다. trigger function은 `SECURITY DEFINER`와 빈 search path를 사용하고 application role의 직접 실행 권한은 없으며, 임의 metadata를 `users`에 쓰는 trigger는 두지 않는다. 백필은 유효한 raw 번호를 우선하되 raw 값이 무효하면 기존 trusted normalized 값을 지우지 않는다. 중복이 발견되면 자동으로 하나를 선택하지 않고 3번 transaction을 중단해 운영자가 계정 소유권을 확인하게 한다.

`earlybird_orders`에 다음 운영자 전용 컬럼을 추가한다.

- `expected_buyer_phone_number_normalized`
- `groble_buyer_email`
- `groble_buyer_phone_number`
- `groble_buyer_display_name`

`earlybird_webhook_events`에도 일치하지 않은 결제를 후속 확인할 수 있게 같은 구매자 증거 컬럼을 추가한다. 이 컬럼들은 `anon`과 `authenticated`에 GRANT하지 않고, API DTO와 Axiom·Amplitude에 전달하지 않는다. 기존 필드별 authenticated SELECT grant 목록도 변경하지 않는다.

Supabase RPC는 여전히 service role만 실행할 수 있고, 결제 ID 잠금·사용자 잠금·주문 잠금·재고 잠금 순서와 멱등성을 유지한다. 5번 활성화 migration은 12개 인자 canonical finalizer와 함께, 전화번호 증거를 `NULL`로 위임하는 9개 인자 service-only wrapper를 유지한다. wrapper는 모든 이전 인스턴스가 drain된 후 별도 post-drain migration으로만 제거한다.

## 3. Amplitude

### SDK 구성

- 기존 `@amplitude/analytics-browser`를 `@amplitude/unified`로 교체한다.
- 최상위 client provider가 `initAll`을 한 번만 호출한다.
- `analytics.autocapture = true`, `sessionReplay.sampleRate = 1`, `engagement.skip = true`를 사용한다.
- API key가 없으면 애플리케이션은 정상 작동하고 수집만 비활성화한다.
- Amplitude user ID는 Supabase UUID만 사용하고 이메일, 전화번호, 인스타그램 아이디를 user property로 보내지 않는다.

Amplitude SDK 코드는 클라이언트에서만 실행한다. 서버 webhook에서 Amplitude HTTP event를 보내지 않는다. 결제 확인 화면이 Supabase의 `paid` 상태를 읽은 뒤 `payment_confirmed_viewed`를 한 번 기록한다.

### 명시 이벤트

이벤트 이름은 snake case 과거형으로 고정한다.

- `landing_viewed`
- `target_submitted`
- `auth_started`
- `auth_completed`
- `preflight_started`
- `preflight_succeeded`
- `preflight_failed`
- `exclusion_decided`
- `plan_viewed`
- `plan_selected`
- `checkout_started`
- `checkout_redirected`
- `payment_confirmed_viewed`
- `earlybird_status_viewed`
- `analysis_started`
- `analysis_completed`
- `result_viewed`
- `result_shared`

이벤트 property는 plan, KRW 금액, 단계, 소요 시간, 오류 코드, 구간화된 팔로워·팔로잉 수, UTM/source, 내부 preflight·order·request UUID로 제한한다. 생 인스타그램 아이디는 Amplitude에 보내지 않는다.

### Session Replay 개인정보 보호

- 입력 필드는 모두 마스킹한다.
- 인스타그램 아이디, 프로필 이미지, bio, 댓글, 판독 총평, 결제 상태의 개인 식별 영역을 block 또는 mask한다.
- Amplitude 프로젝트의 원격 Session Replay privacy 설정도 보수적 수준으로 구성한다.

### Amplitude 대시보드

실제 이벤트 수신을 확인한 후 Comet에 로그인된 Amplitude 웹 UI를 직접 조작해 `얼리버드 전환 대시보드`를 만든다. 차트 생성 API나 Amplitude connector를 사용하지 않는다.

- 일별 유입과 UTM 채널
- 랜딩 → 대상 입력 → 인증 → 사전 검사 → 플랜 선택 → checkout → 결제 확인 화면 퍼널
- 단계별 이탈률
- Basic·Standard 플랜 수요와 checkout 전환
- 사전 검사 성공률, 오류 코드, p50·p90 지연
- 결제 확인 화면 조회 건수와 금액
- 결과 조회와 공유
- 핵심 이탈 구간 Session Replay 세그먼트

Plus 대기 신청 전용 차트는 만들지 않는다.

## 4. Axiom

### 자원과 자격 증명

- 조직: `ascentum03`
- 데이터셋: `yeosachin-logs`
- kind: Events (Logs / Traces)
- retention: 30일

클립보드의 PAT는 로컬 루트 `.env.local`에 `AXIOM_PERSONAL_ACCESS_TOKEN`으로만 저장한다. PAT는 데이터셋과 런타임 토큰을 생성하는 provisioning에만 사용하고 Vercel에 추가하지 않는다.

런타임에는 `yeosachin-logs`에 ingest만 할 수 있는 별도 API 토큰을 생성해 다음 서버 전용 변수로 제공한다.

- `AXIOM_TOKEN`
- `AXIOM_DATASET=yeosachin-logs`
- `AXIOM_ORG_ID`

`NEXT_PUBLIC_AXIOM_TOKEN`은 사용하지 않는다. 브라우저에는 Axiom 인증 정보를 전달하지 않는다.

### 서버 로거

Axiom 공식 Next.js SDK를 사용해 다음 경계를 만든다.

- 공용 구조화 logger
- request ID와 trace ID context
- Next.js `instrumentation.ts` 예외 수집
- route handler 시작·응답·지연 로그
- serverless 응답 후 안전한 flush
- Axiom 장애시 비즈니스 요청을 실패시키지 않는 fail-open transport

로거는 모든 필드를 전송하기 전에 allowlist와 redaction에 통과시킨다. 에러 객체에서는 에러 이름, 내부 안전 코드, stack의 제한된 프레임만 보내고 요청 body와 외부 응답 body는 보내지 않는다.

### 공통 로그 스키마

로그는 다음 공통 필드를 사용한다.

- `timestamp`, `level`, `event`, `service`, `environment`
- `request_id`, `trace_id`, `route`, `method`, `status`, `duration_ms`
- `user_id`, `preflight_id`, `order_id`, `analysis_request_id`
- `target_instagram_id`, `candidate_instagram_id`, `excluded_instagram_id`
- `provider`, `operation`, `phase`, `attempt`, `result_count`
- `error_code`, `disposition`, `retryable`
- `estimated_cost_usd`, `input_count`, `output_count`

인스타그램 아이디는 명시적으로 허용한다. 다만 댓글, bio, caption, 프로필 이미지 URL, 피드 미디어 URL, 성별·외모 판정 원문, Groble 이메일·이름·전화번호, 서명, 쿠키, 세션, API 토큰, 서비스 계정 자격 증명은 금지 필드이다.

### 관측 이벤트

세부 로그를 남기되 과도한 ingest와 지연을 피하기 위해 계정·이미지 단위 성공 로그를 남기지 않고 배치·단계 단위로 집계한다. 개별 단위는 실패·재시도·fallback에서만 남긴다.

- auth callback 시작, provider, 프로필 동기화 성공·실패
- preflight 시작, profile 수집, 플랜 산정, 완료·실패·소요 시간
- 자체 크롤러·Apify·RapidAPI 선택, circuit state, fallback, quota, 반환 수
- Cloud Tasks enqueue, dequeue, lease, 재시도, 배경 작업 체인
- Gemini 모델, thinking level, batch 크기, 지연, rate limit, 재시도, 추정 비용
- Groble checkout 생성, redirect, webhook 서명 결과, disposition, 재고 확정
- V2 분석 단계 시작·완료·실패, 진행률, 단계 지연, 총 지연

### Axiom 대시보드와 모니터

프리뷰 또는 운영에서 대표 로그가 적재된 후 Axiom UI에서 `Yeosachin Operational Health`를 만든다.

- 전체 오류율과 route p50·p90 지연
- 사전 검사·분석 단계별 지연과 실패
- 크롤러 provider 실패·fallback·quota
- Gemini rate limit·재시도·지연·추정 비용
- Cloud Tasks 재시도·lease·worker 실패
- Groble webhook accepted·unmatched·ambiguous·mismatch·refund disposition

모니터는 결제 webhook 5xx, 결제 unmatched/mismatch, 분석 최종 실패, worker timeout, provider quota·인증 실패를 대상으로 한다. 테스트 이벤트를 운영 경고와 분리하기 위해 `environment` 필터를 필수로 사용한다.

## 5. 개인정보와 보안

- 개인정보 처리방침에 Axiom 위탁·국외 이전과 Groble에서 수신한 구매자 연락처 보관 목적을 반영한다.
- Groble PII 컬럼은 service role 전용으로 유지하고 고객 응답 DTO에서 제외한다.
- Axiom PAT와 runtime ingest token은 로그, 에러 메시지, 테스트 snapshot, Git 산출물에 포함하지 않는다.
- Axiom runtime token은 `yeosachin-logs` ingest만 허용한다.
- Amplitude Session Replay와 Axiom 로그의 마스킹 규칙을 서로 별도로 테스트한다.
- 인스타그램 아이디는 Axiom에서 장애 추적을 위해 보존하지만 Amplitude와 Session Replay에서는 마스킹한다.

## 6. 오류 처리

- Axiom 설정 누락·ingest 실패는 서비스 요청을 실패시키지 않는다.
- Amplitude key 누락·SDK 실패는 UI 흐름을 실패시키지 않는다.
- Groble 전화번호가 부재하거나 파싱되지 않으면 이메일 fallback을 적용한다.
- Groble 전화번호 후보가 정확히 하나이면 이메일 불일치는 실패 사유가 아니다.
- 전화번호 후보가 없고 이메일 fallback도 실패하면 webhook을 2xx로 멱등 수신하되 재고를 차감하지 않고 운영 경고를 발생시킨다.
- 전화번호 정규화 중복이 발생하면 자동 확정하지 않는다.

## 7. 테스트

### Groble와 Supabase

- 한국 국내 번호, `+82` 번호, 공백·하이픈, 잘못된 번호 정규화 테스트
- 전화번호 일치 + 이메일 불일치 결제 자동 확정
- 전화번호 미제공 + 이메일 일치 fallback
- 전화번호·이메일 모두 불일치한 unmatched
- 중복 전화번호 안전 실패
- 상품·금액 mismatch, 중복 event, 중복 payment, 재고 동시성 회귀
- Groble PII 컬럼이 authenticated SELECT grant와 DTO에서 제외되는 계약 테스트

### Amplitude

- 초기화 1회 보장
- key 누락 fail-open
- 명시 이벤트 이름과 허용 property
- 사용자 UUID 설정·해제
- 민감 영역 Session Replay block/mask
- 결제 확인 화면 이벤트 중복 방지

### Axiom

- allowlist가 인스타그램 아이디는 보존하고 금지 필드는 제거하는 테스트
- transport 실패 fail-open
- request/trace context 전파
- route·worker 지연 계산
- serverless flush
- PAT·runtime token 미설정 동작
- 대량 후보 처리에서 배치 단위 로그 건수 상한

### 브라우저 검증

- 신규 로그인·회원가입에 카카오만 노출되는지 확인
- 카카오 전화번호 있음·없음 checkout 상태 확인
- Amplitude 이벤트 수신과 Session Replay 마스킹 확인
- Axiom 대표 이벤트 ingest와 금지 필드 미수집 확인
- desktop·mobile에서 인증, 플랜, checkout, 결제 상태 흐름 회귀 확인

## 8. 배포 순서

1. 통합 테스트가 가능한 5개의 순차 Supabase migration을 CLI로 생성한다. 1번의 nullable DDL·짧은 order INSERT trigger, checkout 활성화, DML, validation/index, finalization/grant transaction 경계를 혼합하지 않는다.
2. `ascentum03`에 `yeosachin-logs` 데이터셋과 ingest 전용 runtime token을 생성한다.
3. 관측 SDK, 인증 UI, Groble parser·RPC를 구현한다.
4. 로컬 단위·DB·빌드 검증을 통과한다.
5. push 직전 원격 row count·table size와 장기 transaction을 확인하고 5개 Supabase migration을 순서대로 반영한다. INSERT trigger가 포함된 1번, checkout 활성화 2번, 백필 3번의 순서를 바꾸지 않는다. 이후 Vercel preview에 Amplitude key와 Axiom runtime 변수를 추가한다.
6. preview에서 대표 사용자 흐름, Groble 서명 테스트, Amplitude event, Axiom ingest를 검증한다.
7. Amplitude와 Axiom 웹 UI에서 대시보드·세그먼트·모니터를 구성한다.
8. 코드 리뷰와 회귀 검증 후 main에 merge한다.
9. 운영 배포 후 결제 webhook, 인증 실패, 분석 실패, ingest 상태를 canary 모니터링한다.

## 공식 계약 기준

- Groble webhook 이벤트: https://www.groble.im/help/guides/webhook-events
- Kakao Login 사용자 정보: https://developers.kakao.com/docs/en/kakaologin/utilize
- Kakao 전화번호 제공 예외: https://developers.kakao.com/docs/en/kakaologin/faq
- Amplitude Unified Browser SDK: https://amplitude.com/docs/sdks/analytics/browser/browser-unified-sdk
- Amplitude Session Replay privacy: https://amplitude.com/docs/session-replay/manage-privacy-settings-for-session-replay
- Axiom Next.js: https://axiom.co/docs/send-data/nextjs
- Axiom token: https://axiom.co/docs/reference/tokens
