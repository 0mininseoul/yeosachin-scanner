# Amplitude 제품 분석 운영 가이드

Amplitude는 클라이언트 제품 퍼널을 보는 보조 분석 도구다. 결제·주문·분석 상태의 원장은 Supabase이며, Amplitude 수치로 결제 장부를 확정하지 않는다.

공식 참고 문서:

- [Unified Browser SDK](https://amplitude.com/docs/sdks/analytics/browser/browser-unified-sdk)
- [Session Replay SDK와 sampling](https://amplitude.com/docs/sdks/session-replay/session-replay-standalone-sdk)

## 1. 환경과 초기화

- `NEXT_PUBLIC_AMPLITUDE_API_KEY`에 프로젝트 API key를 설정한다. 이 값은 브라우저 SDK 식별용 공개 구성이지 서버 비밀이 아니다.
- 최상위 client provider가 `@amplitude/unified`의 `initAll`을 생명주기 동안 한 번만 초기화한다. key 누락이나 SDK 실패는 제품 흐름을 중단하지 않는다.
- 인증 전에는 익명 상태를 사용하고, 인증 후 Amplitude user ID는 Supabase UUID만 사용한다. 이메일, 전화번호, 인스타그램 아이디를 ID나 user property로 설정하지 않는다.
- 결제·주문·Groble webhook 경로에서는 서버에서 Amplitude 이벤트를 전송하지 않는다. 단, 분석 파이프라인이 소유한 terminal lifecycle(`analysis_started`, `analysis_completed`, `analysis_failed`)은 Cloud Tasks 재시도와 클라이언트 이탈을 보완하기 위해 서버에서 best-effort로 전송한다. 이 예외는 분석 원장의 UUID와 terminal 상태만 사용하며 전송 실패가 파이프라인을 실패시키지 않는다.
- Analytics 자동 수집은 세션 경계를 포함해 전부 끈다. page URL·view, form·element·frustration interaction, file download, network, web vitals·performance, attribution은 수집하지 않고 닫힌 allowlist의 명시 이벤트만 전송한다. 허용 핵심 경로에서 사용자의 클릭·스크롤 행동 관찰은 URL 정규화·마스킹을 적용한 Session Replay interaction이 맡는다. 일반 autocapture는 이 속성 allowlist를 우회할 수 있으므로 별도 안전 계약이 생기기 전까지 켜지 않는다.
- Session Replay는 Next Production build(`NODE_ENV=production`)에서 `NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED=true`이고 경로·개인정보 조건도 통과할 때만 후보가 된다. 별도의 `NEXT_PUBLIC_VERCEL_ENV` 설정은 요구하지 않는다. 현재 승인된 Production beta 운영값은 `NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE=1`(100%)이며, 허용 핵심 경로의 모든 세션을 검증할 수 있다. 런타임은 형식이 맞는 `0.01`(1%)부터 `0.10`(10%)까지와 정확한 `1`(100%)만 지원하며, 형식 오류 또는 범위 밖 값은 fail-closed `sampleRate: 0`으로 비활성화한다.

## 2. 개인정보 경계

SDK localStorage 캐시의 remote config는 실시간 승인으로 취급하지 않고 초기화 전에 제거한다. SDK 타임아웃과 캐시 거부는 joined config의 `captureEnabled: false`로 Replay 수집을 비활성화한다.

Session Replay 허용 경로 템플릿은 `/`, `/privacy`, `/terms`, `/login`, `/analyze`, `/betatest`, `/earlybird`, `/mypage`, `/progress/:requestId`, `/result/:requestId`, `/share/:token`이다. 허용 경로의 query·hash와 동적 request ID·share token은 local UGC filter rule이 Replay meta와 batched click·scroll interaction을 영속화하기 전에 식별자와 query가 없는 정적 경로 템플릿으로 치환한다. 알 수 없는 경로와 admin·API 경로는 allowlist 밖에서 fail-closed로 Replay를 중지하며, 중지된 세션은 새 페이지/세션 전까지 다시 시작하지 않는다.

DNT 또는 GPC(Global Privacy Control) opt-out이면 fail-closed로 `sampleRate: 0`, `capture_enabled: false`로 Replay를 차단한다. Vercel의 enable·sample 환경변수가 rollout 활성화와 표본율을 권위 있게 결정한다. 신뢰한 Amplitude remote config는 `capture_enabled: true`인지 확인하는 emergency veto로만 사용하며, upstream `sample_rate`와 다른 설정은 적용하거나 전달하지 않는다. Amplitude가 `capture_enabled: false`를 반환하면 Replay를 차단하고, remote config 응답 오류·실패·형식 오류도 fail-closed `sampleRate: 0`으로 처리한다. Replay의 click·scroll interaction은 batching을 켜서 수집하지만 network·console·performance·document title 수집은 끈다. 일반 Analytics autocapture도 page URL·view, form·element·frustration interaction을 포함해 계속 끈 상태다.

Replay는 설치된 SDK가 지원하는 가장 낮은 기본 수준인 `light`를 사용한다. 일반 static text·레이아웃·비민감 media는 Replay에서 보이므로 실제 사용자 화면에 가깝게 확인할 수 있다. 전역 `form`/`input`/media/DOM attribute 마스킹·차단은 사용하지 않는다. 대신 `[data-amp-mask]`는 인스타그램 아이디·이메일처럼 명시한 입력·식별 텍스트에만, `[data-amp-block]`는 프로필 이미지·UGC 결과처럼 명시한 식별 영역에만 사용한다.

명시 이벤트와 속성은 닫힌 allowlist를 통과하며 명시 이벤트에는 페이지 URL을 보내지 않는다. Replay URL은 local UGC filter rule으로 정규화한다. 고객 또는 사용자가 입력한 이메일·전화번호·연락처와 결제 연락처, 인스타그램 식별자, 이름, bio/소개글, 댓글/comment, caption/캡션, 프로필 이미지·미디어 같은 UGC 결과는 해당 UI의 `[data-amp-mask]` 또는 `[data-amp-block]`으로 보호하고, event·user property에는 보내지 않는다. 허용 핵심 경로의 일반 page/container는 마스킹하지 않아 실제 흐름과 레이아웃을 확인할 수 있다.

## 3. 이벤트와 허용 속성

이벤트 vocabulary:

- 유입·인증: `landing_viewed`, `target_submitted`, `auth_started`, `auth_completed`, `login_prompted`
- 사전 검사: `preflight_started`, `preflight_succeeded`, `preflight_failed`, `exclusion_decided`
- 플랜·결제 이동: `plan_viewed`, `plan_selected`, `checkout_started`, `checkout_redirected`
- 결제 확인: `payment_confirmed_viewed`, `earlybird_status_viewed`
- 분석·결과: `analysis_started`, `analysis_completed`, `analysis_failed`, `result_viewed`, `result_shared`

허용 properties는 `plan_id`, `required_plan_id`, `amount_krw`, `stage`, `status`, `duration_ms`, 닫힌 `error_code`, 구간화한 followers/following 수, 제한된 UTM source·medium·campaign·content·term, 내부 preflight/order/request UUID, 결과 수, 공유 여부·채널로 제한한다. 공유 링크 유입은 토큰이 아닌 닫힌 `source=shared` 표식으로만 이어진다. `error_code`의 사전 검사 하위 사유는 `HANDLE_FORMAT_INVALID`, `TARGET_NOT_FOUND`, `TARGET_PRIVATE`, `PLAN_CAPACITY_EXCEEDED`, `EXCLUSION_RULE_VIOLATION`, `PROVIDER_TEMPORARY_FAILURE`를 사용한다. `plan_id`에 `plus`가 존재하는 것은 공통 스키마 호환을 위한 것이며 Plus 대기 신청 전용 분석을 뜻하지 않는다.

`payment_confirmed_viewed`의 의미는 이름 그대로 결제 확인 화면 조회다. `paid`·`analysis_in_progress`·`completed` 주문의 화면을 본 사실을 기록할 뿐 결제 승인이나 매출을 뜻하지 않으며, 이름은 기존 대시보드 호환을 위해 유지한다. 실매출의 정본은 Supabase `earlybird_orders`에서 `payment_id`, `actual_amount_krw`, `paid_at`이 모두 존재하는 행으로만 확정한다. 특히 `actual_amount_krw=0` 또는 `manual_recon_*` 결제 ID를 Amplitude 매출 합계로 해석하지 않는다.

분석 lifecycle은 서버가 정본이다. `analysis_started`는 admission 이후 Cloud Task가 첫 job을 시작한 시점, `analysis_completed`는 결과가 조회 가능한 terminal 시점, `analysis_failed`는 terminal 실패 시점이다. 서버 원장의 멱등 키는 `(request_id, event_name)`이고, 같은 요청의 Cloud Tasks 재시도는 같은 Amplitude `insert_id`를 사용한다. 과거 클라이언트 발화와의 차이는 `analysis_lifecycle_events` 원장 및 기간별 terminal 성공 요청 수와 대조해 누락량으로 기록한다.

preflight 실패 사유의 원인 확인 결과, 현재 POST 경로는 인증·본문/아이디 형식·Idempotency-Key·admission 검사를 `analysis_preflights` 생성 RPC보다 먼저 수행한다. 따라서 이 단계에서 거절된 `VALIDATION_ERROR`는 생성된 preflight 행이 purge된 것이 아니라, 원장에 남을 대상 자체가 없었던 경우다. provider 조회·제외 결정 단계에서 발생한 실패는 preflight 행과 별도 PII 없는 `analysis_preflight_failures` 원장에 bounded reason code로 남긴다. 과거 Amplitude의 단일 `VALIDATION_ERROR`는 사후에 세분화할 수 없으므로 새 수집분부터 `HANDLE_FORMAT_INVALID`, `TARGET_NOT_FOUND`, `TARGET_PRIVATE`, `PLAN_CAPACITY_EXCEEDED`, `EXCLUSION_RULE_VIOLATION`, `PROVIDER_TEMPORARY_FAILURE`로 구분한다.

로그인 시점을 결제 클릭으로 늦추는 익명 preflight는 다음 경계를 따른다. 익명 행은 `user_id IS NULL`로 만들고, 짧은 만료의 서명 claim token을 발급한다. token은 OAuth `next` 상태에 포함하고 callback 서버가 검증·일회성 claim한 뒤에만 `earlybird_orders`를 만들 수 있다. token은 이벤트나 user property에 보내지 않는다. `analysis_preflights`의 브라우저 읽기·갱신은 authenticated owner 정책 또는 claim hash와 만료를 transaction-local context로 제시한 anon/authenticated RLS 정책만 통과하며, 이 경로에서 service role로 소유권을 우회하지 않는다. 익명 프로필 summary만 명시적 `anonymous_apify` provider selector로 Apify에 보내며, 유료 분석의 `selfhosted_auth` 경로와 섞지 않는다. 동일 target snapshot은 PII-free input hash로 24시간 재사용하고, IP·디바이스 해시 기준 10분당 5회 및 일일 기본 300회의 상한을 둔다. 상한을 넘으면 새 외부 요청 대신 로그인 계속하기 경로로 폴백한다. preflight가 확정한 적격성·플랜 카드·가격 snapshot을 그대로 반환하므로 비로그인 화면도 현재 카탈로그 가격을 사용한다. `/api/analysis/start`, `/api/earlybird/checkout`, 진행·결과·마이페이지는 계속 인증을 요구하며, 익명 preflight는 분석을 시작할 수 없다. 샘플 리포트 작업 전까지 익명 요청은 사용자 UUID 기반 데모 자격 판정에 진입하지 않는다.

## 4. 대시보드 생성

실제 이벤트가 한 건 이상 수신된 뒤, 아래 운영 대시보드가 없을 때만 로그인된 Comet 브라우저의 Amplitude UI에서 Production API key가 연결된 프로젝트를 선택하고 `얼리버드 전환 대시보드`를 만든다. 차트 생성 API를 사용하지 않고 기존 대시보드를 중복 생성하지 않는다. Preview도 같은 프로젝트를 쓴다면 알려진 테스트 Supabase UUID를 user segment에서 제외한다. 이메일이나 전화번호로 테스트 사용자를 구분하지 않는다.

현재 운영 대시보드는 [Amplitude `얼리버드 전환 대시보드`](https://app.amplitude.com/analytics/shiny-disk-989835/dashboard/p7w87cf8)이다. 저장된 전체 차트에서 taxonomy seed user ID `00000000-0000-4000-8000-000000000001`을 제외한다.

1. 일별 유입과 UTM 채널: `landing_viewed` 추이와 source·medium·campaign breakdown
2. 핵심 전환 funnel: `landing_viewed` → `target_submitted` → `auth_completed` → `preflight_succeeded` → `plan_selected` → `checkout_redirected` → `payment_confirmed_viewed`
3. 단계별 이탈률: 같은 funnel의 단계 전환율과 median conversion time
4. Basic·Standard 수요: `plan_viewed`, `plan_selected`, `checkout_started`, `checkout_redirected`를 `plan_id`로 breakdown하고 각 플랜 전환율 비교
5. 사전 검사 품질: `preflight_succeeded`와 `preflight_failed` 비율, `error_code` breakdown, `duration_ms` p50·p90
6. 결제 확인: `payment_confirmed_viewed`의 distinct user·event 수와 화면에 표시된 금액의 참고 breakdown. 매출 확정은 `earlybird_orders.payment_id`, `actual_amount_krw`, `paid_at`이 모두 있는 행만 Supabase와 대조
7. 결과 사용: `result_viewed`, `result_shared` 추이와 `share_channel`, `is_shared` breakdown
8. 이벤트 기반 핵심 이탈 세그먼트: 같은 세션에서 `target_submitted` 후 `preflight_succeeded`가 없거나 `plan_selected` 후 `checkout_redirected`가 없는 사용자. Replay 링크 없이 후속 이벤트 유무로만 구성
9. 공유 유입 전환: `result_viewed`의 `is_shared=true` 조회 수를 분모로 삼고, 같은 익명/인증 흐름에서 `source=shared`가 붙은 후속 `target_submitted` 수를 세어 공유 조회 1건당 신규 의뢰 수를 계산한다. 공유 토큰이나 외부 식별자는 breakdown에 사용하지 않는다.

기존 9개 이벤트 대시보드 패널은 유지한다. Replay는 이 대시보드의 대체 지표나 별도 민감 화면 패널이 아니며, 허용 핵심 경로에서 수신된 beta 세션의 문제를 조사할 때만 보조적으로 확인한다. Plus 대기 신청 전용 차트도 만들지 않고 대시보드에서 제외한다.

## 5. Live 검증

- Production beta 검증에서는 100% sampling이므로 허용 핵심 경로를 통과한 한 세션에서 Replay 수신을 확인한다. `/`, `/privacy`, `/terms`, `/login`, `/analyze`, `/betatest`, `/earlybird`, `/mypage`, `/progress/:requestId`, `/result/:requestId`, `/share/:token`을 각각 검증한다.
- Amplitude User Lookup 또는 Debugger에서 이벤트 순서와 Supabase UUID identity를 확인한다. 익명 이벤트가 인증 후 잘못된 이메일·전화번호 identity에 연결되지 않았는지 확인한다.
- 결제 완료 fixture 또는 실제 검증 결제는 고객 화면이 `paid`를 읽은 뒤 `payment_confirmed_viewed`를 한 번만 보내는지 확인한다. 중복 새로고침은 dedupe 계약과 비교한다.
- 각 이벤트 상세의 properties 탭에서 schema에 없는 값이 제거되는지 확인한다.
- 합성 query·hash·request ID·share token으로 허용 경로를 이동하고, 수신된 Replay에서 meta와 batched click·scroll interaction의 page URL이 각각 식별자 없는 정적 경로 템플릿으로만 표시되는지 확인한다. click과 scroll을 실제로 발생시켜 beta 세션에서 interaction이 연결되는지도 확인한다.
- 알 수 없는 경로와 admin·API 경로에서는 Replay가 수신되지 않는지 확인한다. DNT/GPC opt-out 브라우저도 수신되지 않아야 한다.
- 금지 속성 검사: `email`, `phone`, `name`, `instagram`, `username`, `profile`, `bio`, `comment`, `caption`, `image`, `media`, `url`, `token`, `cookie`, `signature`, `body`, `response` 이름이나 실제 민감 값이 event·user properties에 없는지 검사한다. Replay UI에서는 일반 static text·레이아웃·비민감 media가 실제 화면처럼 보이고, 고객·사용자 입력값과 식별·UGC 영역만 `[data-amp-mask]` 또는 `[data-amp-block]`으로 보호되는지 확인한다.
- 원장 대조: `payment_confirmed_viewed`의 distinct user 수를 같은 기간 `earlybird_orders`에서 `status IN ('paid', 'analysis_in_progress', 'completed')`인 distinct `user_id` 수와 비교한다. 서버 `analysis_completed` 수는 `analysis_v2` terminal 성공 요청 수와 비교하고, 기존 클라이언트 이벤트와의 차이를 누락량으로 별도 기록한다.
- Replay payload와 UI에서 network·console·performance·document title 수집 및 일반 Analytics autocapture가 활성화되지 않았는지 확인한다.

검증 중 민감 속성이 발견되면 대시보드 작성과 Production rollout을 중단한다. allowlist 또는 caller를 수정하고 잘못 수집된 데이터의 삭제 절차를 Amplitude 프로젝트 관리자와 확인한 뒤 다시 검증한다.

## 6. Rollout과 롤백

`DEMO_ANALYSIS_ENABLED`는 server-only 데모 자격(demo eligibility)만 제어하며 브라우저로 직렬화하거나 Replay gate에 사용하지 않는다. 따라서 값과 관계없이 `/analyze`, `/progress/:requestId`, `/result/:requestId`, `/share/:token`을 포함한 위 허용 핵심 경로는 다른 Replay 조건을 모두 충족하면 수집 후보가 된다. 알 수 없는 경로와 admin·API 경로는 계속 route allowlist 밖에서 차단된다.

Rollout은 로컬 테스트, Vercel Preview 명시 이벤트 검증, 금지 속성·URL canonicalization 검사, Production에 `NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED=true` 및 `NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE=1` 설정, Production live 검증 순서로 진행한다. 배포 전에는 Replay UI 수신을 완료된 사실로 기록하지 않으며, 배포 직후 허용 핵심 경로의 beta 세션에서 핵심 funnel 이벤트, canonical route template, batched click·scroll interaction, 마스킹·차단 상태와 제품 흐름을 함께 확인한다.

Replay만 롤백하려면 `NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED=false`와 `NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE=0`을 함께 설정하고 재배포한다. 이 조치는 명시 이벤트 analytics는 유지한다. 반대로 `NEXT_PUBLIC_AMPLITUDE_API_KEY`를 제거하는 것은 전체 analytics kill switch로서 명시 이벤트 전송까지 모두 중단한다. SDK 실패나 key 제거 후에도 로그인·preflight·checkout·결과 화면이 정상 동작해야 한다.
