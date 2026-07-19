# Amplitude, Axiom, Groble 전화번호 매칭 설계

> 역사적 설계 문서의 보존본이며, 폐기된 연락처 보관 지시를 현행 보안 계약으로 정정했다. `20260719131500_stop_persisting_groble_buyer_contacts.sql`은 기존 연락처를 삭제하고 old/new writer의 저장을 막는다. 전화번호 신뢰는 Kakao REST callback이 원자적으로 기록한 provenance에만 기반하고, 주문은 checkout 시점의 불변 매칭 정책과 전화번호 증거를 사용한다. 이메일 fallback은 migration 전에 생성된 `legacy_email` 주문에만 허용한다. Groble 구매자 연락처는 signed webhook transaction 동안만 처리하며 보관하지 않는다. 배포 기준은 [Groble 얼리버드 운영 문서](../../groble-earlybird-operations.md)를 따른다.

## 목표

이 작업은 얼리버드 결제 매칭을 추가 입력 없이 안전하게 수행하고, 제품 전환과 운영 장애를 각각 Amplitude와 Axiom에서 관측 가능하게 만든다.

성공 조건은 다음과 같다.

- 새 사용자에게는 카카오 로그인만 노출한다.
- Groble 구매자 전화번호가 정규화된 카카오 전화번호와 일치하면, Groble 이메일과 서비스 로그인 이메일이 달라도 결제를 자동 확정한다.
- Groble 구매자 이메일·전화번호는 매칭 transaction 밖에 저장하지 않는다.
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

카카오 callback은 `/v2/user/me`를 통해 이름과 전화번호를 매 로그인 시점에 최신화한다. 유효한 전화번호는 raw 값, E.164 normalized 값, `kakao_rest_api` source, DB clock 기반 verified-at을 한 쓰기로 기록한다. 이 callback만 전화번호 provenance를 쓰며 `/api/user/me`와 Supabase auth metadata는 전화번호를 동기화하지 않는다. 사용자가 카카오톡을 사용하지 않아 전화번호가 제공되지 않는 등의 예외를 필수 케이스로 다룬다.

### 전화번호 정규화

서버 공용 전화번호 정규화기는 다음 계약을 따른다.

- 국가 코드, 공백, 하이픈, 괄호를 포함한 입력을 파싱한다.
- 한국 휴대전화 `010-1234-5678`과 `+82 10-1234-5678`을 같은 E.164 형식으로 변환한다.
- 파싱하지 못한 값은 매칭에 사용하지 않는다.
- `users.phone_number_normalized`는 널이 아닌 값에 대해 유일해야 한다. 중복은 자동 결제 확정 대신 운영 확인 대상이다.

구현은 임의 문자열 치환 대신 검증된 전화번호 파서를 사용하고 테스트 케이스로 규칙을 고정한다.

### 결제 시작 규칙

- checkout에는 24시간 이내에 Kakao REST로 검증된 atomic raw/normalized/source/verified-at provenance가 필요하다. raw 값에서 즉석 파생하거나 저장된 normalized 값으로 fallback하지 않는다.
- checkout RPC는 bounded 상품 검증 후 `earlybird:groble:product:<product_id>` namespaced advisory lock, user lock 순서로 획득한다. 모든 주문 INSERT에 적용되는 trigger도 snapshot 조회 전에 같은 product lock을 획득하고, RPC 경로에서는 같은 transaction lock을 재진입한다. caller가 제공한 매칭 값을 덮어쓰고 `buyer_match_policy = 'verified_kakao_phone'`과 normalized/source/verified-at을 snapshot한다. 이 네 필드는 이후 UPDATE할 수 없고, webhook은 현재 사용자 프로필이 아니라 주문 snapshot과 매칭한다.
- Phase 1은 기존 checkout body를 application role에서 revoke된 내부 이름으로 보존하고, product lock을 먼저 획득하는 bridge를 설치한다. Phase 2가 새 body로 교체된 뒤에도 Phase 1에서 시작한 호출이 끝날 수 있도록 내부 body는 즉시 drop하지 않고 별도 post-drain migration에서만 제거한다.
- migration 적용 전에 존재한 주문만 `legacy_email`로 분류한다. Phase 3은 legacy raw 전화번호를 승격하거나 기존 주문에 전화번호를 백필하지 않는다.
- 기존 Google 세션은 소유 데이터 조회를 유지하지만 신규 checkout을 만들 수 없다. 신규 주문은 provider와 무관하게 verified Kakao provenance가 없으면 `CHECKOUT_PHONE_REQUIRED`로 실패한다.
- 새 Google 로그인 진입점은 UI에 노출하지 않는다.

## 2. Groble webhook 매칭

### 파싱

`payment.completed` parser는 `buyer.email`과 공식 `buyer.phoneNumber` 필드를 검증하고 반환한다. 표시 이름은 application event로 반환하지 않는다.

전화번호는 현재 Groble 계약에서 제공되지만 이전 signed payload 호환을 위해 parser 입력에서는 부재할 수 있다. 부재한 전화번호는 `legacy_email` 주문에 대해서만 이메일 매칭을 허용하며, `verified_kakao_phone` 주문은 이메일로 fallback하지 않는다.

### 자동 매칭 순서

1. 결제 ID와 webhook 이벤트 ID로 기존 멱등 처리를 먼저 확인한다.
2. Groble 구매자 전화번호를 정규화한다.
3. `verified_kakao_phone + expected_buyer_phone_number_normalized + expected_groble_product_id + payment_pending`에 일치하는 주문이 정확히 하나면 선택한다.
4. 3번이 성공하면 Groble 이메일과 서비스 이메일이 달라도 결제를 자동 확정한다.
5. pending 전화번호 후보가 0개이면 이메일보다 먼저 `cancelled + payment_id IS NULL` 스냅샷을 전화번호, 상품, 금액으로 조회한다.
6. 5번 후보가 하나면 이메일이 달라도 `late_cancelled_payment`/`refund_pending`으로 격리하고, 둘 이상이면 `ambiguous_buyer`로 보관한다. 둘 다 재고를 차감하지 않는다.
7. pending과 cancelled 전화번호 후보가 모두 0개일 때만 `legacy_email` 정책의 `buyer.email + product` 규칙과 late-cancelled 규칙을 사용한다. 동일 user/product/amount의 cancelled legacy 후보도 복수이면 `ambiguous_buyer`이며 최신 한 건을 임의 선택하지 않는다.
8. 전화번호 또는 허용된 legacy 이메일 후보가 0개이거나 2개 이상이면 재고를 차감하지 않고 `unmatched` 또는 `ambiguous_buyer`로 기록한다.
9. 후보 선택 후에 상품과 금액이 스냅샷과 다르면 기존 `mismatch` 처리를 유지한다.

이 규칙에서 전화번호는 이메일보다 우선한다. 유저가 본인 전화번호로 다른 이메일을 사용해 결제하는 것이 정상 케이스이기 때문이다.

### 데이터 모델

`users`에 `phone_number_normalized`, `phone_number_verification_source`, `phone_number_verified_at`을 추가하고 세 provenance 값이 전부 NULL이거나 완전한 verified Kakao 묶음인 atomic check를 둔다. 널이 아닌 normalized 값은 유일해야 한다. 사용자 trigger는 callback의 verified-at을 DB clock으로 확정하고, 검증 시각 없이 raw/profile 전화번호를 바꾸는 이전 writer의 provenance를 제거한다. Phase 3은 불완전한 provenance를 제거할 뿐 raw 전화번호를 normalized identity로 승격하지 않는다. 중복이 발견되면 3번 transaction을 중단해 운영자가 계정 소유권을 확인한다.

`earlybird_orders`에 다음 운영자 전용 컬럼을 추가한다.

- `expected_buyer_phone_number_normalized`
- `buyer_match_policy`
- `expected_buyer_phone_verification_source`
- `expected_buyer_phone_verified_at`

주문 snapshot check는 `legacy_email`이면 전화번호 증거가 모두 NULL이고, `verified_kakao_phone`이면 normalized/source/verified-at이 모두 완전하도록 강제한다. 호환용 `groble_buyer_*` 컬럼은 주문과 webhook event에 남아 있지만 `20260719131500_stop_persisting_groble_buyer_contacts.sql`이 기존 값을 삭제하고 old/new writer의 INSERT·UPDATE를 모두 NULL로 만든다. 이 컬럼들은 `anon`과 `authenticated`에 GRANT하지 않고 API DTO와 Axiom·Amplitude에 전달하지 않는다.

Supabase RPC는 service role만 실행할 수 있고 멱등성을 유지한다. advisory lock 순서는 rolling wrapper의 `payment -> namespaced product -> user ID 오름차순`, checkout/trigger의 `product -> user`이며, canonical은 기존 `payment -> user`를 유지한다. 두 finalizer overload는 `NULL`을 포함한 event type을 bounded validation에서 fail closed한다. 9개 인자 rolling wrapper는 같은 상품의 verified owner·기존 payment ID 주문 owner·이메일 후보를 하나의 sorted user set으로 잠근 뒤 existing event/payment를 read-only로 확인해 canonical duplicate path를 보존한다. duplicate payment owner는 canonical 위임 전에 이미 잠겨 있어 cross-product wrapper 간 user lock 순서가 뒤집히지 않는다. product lock은 wrapper의 판정과 모든 verified order INSERT를 직렬화하므로 신규 event의 product-wide recheck 뒤 다른 사용자의 same-product snapshot이 끼어들 수 없다. unresolved verified 주문이 하나라도 남아 있으면 쓰기 전에 `GROBLE_CANONICAL_PHONE_REQUIRED`로 롤백하고, verified 후보가 없고 처리 가능한 legacy 후보가 있을 때만 이메일-only canonical 호출을 허용한다. 같은 payment ID의 old/new finalizer도 payment lock에서 먼저 직렬화되어 user/payment 역순 교착을 만들지 않는다.

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

- 개인정보 처리방침에 Axiom 위탁·국외 이전과 Groble 구매자 연락처의 결제 매칭 중 일시 처리를 반영한다.
- Groble 구매자 연락처는 매칭 transaction 밖에 저장하지 않고 고객 응답 DTO에서도 제외한다.
- Axiom PAT와 runtime ingest token은 로그, 에러 메시지, 테스트 snapshot, Git 산출물에 포함하지 않는다.
- Axiom runtime token은 `yeosachin-logs` ingest만 허용한다.
- Amplitude Session Replay와 Axiom 로그의 마스킹 규칙을 서로 별도로 테스트한다.
- 인스타그램 아이디는 Axiom에서 장애 추적을 위해 보존하지만 Amplitude와 Session Replay에서는 마스킹한다.

## 6. 오류 처리

- Axiom 설정 누락·ingest 실패는 서비스 요청을 실패시키지 않는다.
- Amplitude key 누락·SDK 실패는 UI 흐름을 실패시키지 않는다.
- Groble 전화번호가 부재하거나 파싱되지 않으면 `legacy_email` 주문에만 이메일 fallback을 적용한다. verified 주문은 `unmatched`로 남긴다.
- Groble 전화번호 후보가 정확히 하나이면 이메일 불일치는 실패 사유가 아니다.
- 전화번호 후보가 없고 이메일 fallback도 실패하면 webhook을 2xx로 멱등 수신하되 재고를 차감하지 않고 운영 경고를 발생시킨다.
- 전화번호 정규화 중복이 발생하면 자동 확정하지 않는다.

## 7. 테스트

### Groble와 Supabase

- 한국 국내 번호, `+82` 번호, 공백·하이픈, 잘못된 번호 정규화 테스트
- 전화번호 일치 + 이메일 불일치 결제 자동 확정
- 전화번호 미제공 + migration 전 legacy 주문의 이메일 일치 fallback
- verified 주문의 전화번호 미제공/불일치 시 이메일 fallback 금지
- 전화번호·이메일 모두 불일치한 unmatched
- 중복 전화번호 안전 실패
- 상품·금액 mismatch, 중복 event, 중복 payment, 재고 동시성 회귀
- Groble PII가 주문·event에 저장되지 않고 authenticated SELECT grant와 DTO에서도 제외되는 계약 테스트

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

1. 통합 테스트가 가능한 5개의 순차 Supabase migration을 CLI로 생성한다. 1번의 nullable DDL·짧은 order INSERT trigger·product-first checkout bridge, checkout 활성화, DML, validation/index, finalization/grant transaction 경계를 혼합하지 않는다.
2. `ascentum03`에 `yeosachin-logs` 데이터셋과 ingest 전용 runtime token을 생성한다.
3. 관측 SDK, 인증 UI, Groble parser·RPC를 구현한다.
4. 로컬 단위·DB·빌드 검증을 통과한다.
5. push 직전 원격 row count·table size와 장기 transaction을 확인하고 checkout/order INSERT 쓰기를 제한한다. active writer가 0인지 확인한 뒤 5개 Supabase migration을 순서대로 반영한다. INSERT trigger와 product-first bridge가 포함된 1번, checkout 활성화 2번, 백필 3번의 순서를 바꾸지 않으며 Phase 1 internal checkout body는 post-drain 전까지 revoke 상태로 남긴다. 이후 Vercel preview에 Amplitude key와 Axiom runtime 변수를 추가한다.
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
