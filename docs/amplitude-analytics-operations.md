# Amplitude 제품 분석 운영 가이드

Amplitude는 클라이언트 제품 퍼널을 보는 보조 분석 도구다. 결제·주문·분석 상태의 원장은 Supabase이며, Amplitude 수치로 결제 장부를 확정하지 않는다.

공식 참고 문서:

- [Unified Browser SDK](https://amplitude.com/docs/sdks/analytics/browser/browser-unified-sdk)
- [Session Replay SDK와 sampling](https://amplitude.com/docs/sdks/session-replay/session-replay-standalone-sdk)

## 1. 환경과 초기화

- `NEXT_PUBLIC_AMPLITUDE_API_KEY`에 프로젝트 API key를 설정한다. 이 값은 브라우저 SDK 식별용 공개 구성이지 서버 비밀이 아니다.
- 최상위 client provider가 `@amplitude/unified`의 `initAll`을 생명주기 동안 한 번만 초기화한다. key 누락이나 SDK 실패는 제품 흐름을 중단하지 않는다.
- 인증 전에는 익명 상태를 사용하고, 인증 후 Amplitude user ID는 Supabase UUID만 사용한다. 이메일, 전화번호, 인스타그램 아이디를 ID나 user property로 설정하지 않는다.
- Analytics는 클라이언트에서만 전송한다. Groble webhook 등 서버 요청에서 Amplitude 이벤트를 보내지 않는다.
- Analytics 자동 수집은 세션 경계를 포함해 전부 끈다. page URL·view, form·element·frustration interaction, file download, network, web vitals·performance, attribution은 수집하지 않고 닫힌 allowlist의 명시 이벤트만 전송한다.
- Session Replay는 Production(`NEXT_PUBLIC_VERCEL_ENV=production`)에서 `NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED=true`이고 경로·개인정보 조건도 통과할 때만 후보가 된다. 현재 승인된 Production 운영값은 `NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE=0.05`(5%)다. 런타임은 형식이 맞는 `0.01`(1%)부터 `0.10`(10%)까지를 지원하며, 형식 오류 또는 범위 밖 값은 fail-closed `sampleRate: 0`으로 비활성화한다. 현재 `0.05` 변경은 별도 검토가 필요하다.

## 2. 개인정보 경계

Session Replay 허용 경로 템플릿은 `/`, `/privacy`, `/terms`, `/login`, `/analyze`, `/earlybird`, `/mypage`, `/progress/:requestId`, `/result/:requestId`, `/share/:token`이다. 허용 경로의 query·hash와 동적 request ID·share token은 local UGC filter rule이 Replay meta와 batched click·scroll interaction을 영속화하기 전에 식별자와 query가 없는 정적 경로 템플릿으로 치환한다. 알 수 없는 경로와 admin·API 경로는 allowlist 밖에서 fail-closed로 Replay를 중지하며, 중지된 세션은 새 페이지/세션 전까지 다시 시작하지 않는다.

DNT 또는 GPC(Global Privacy Control) opt-out이면 fail-closed로 `sampleRate: 0`, `capture_enabled: false`로 Replay를 차단한다. SDK 또는 remote acknowledgement의 sampling 값이 기대값과 불일치하거나 remote config 응답 오류·실패가 발생해도 같은 fail-closed 응답을 반환한다. Replay의 click·scroll interaction은 batching을 켜서 수집하지만 network·console·performance·document title 수집은 끈다. 일반 Analytics autocapture도 page URL·view, form·element·frustration interaction을 포함해 계속 끈 상태다.

Replay는 conservative 기본 수준으로 모든 text와 input을 마스킹하고, `form`, `input`, `select`, `textarea`, `option`, `[contenteditable]`, `.amp-mask`, `[data-amp-mask]`도 명시적으로 마스킹한다. DOM attribute의 `href`, `src`, `alt`, `title`, `aria-label`, `value`, `placeholder` 값 역시 직렬화 전에 마스킹하며 unmask selector는 두지 않는다. `img`, `video`, `audio`, `canvas`, `svg` 전체와 `.amp-block`, `[data-amp-block]`, `[data-amp-sensitive]`, `[data-amp-private]`는 차단한다.

명시 이벤트와 속성은 닫힌 allowlist를 통과하며 명시 이벤트에는 페이지 URL을 보내지 않는다. Replay URL은 local UGC filter rule으로 정규화하고, DOM의 URL·접근성·입력 관련 attribute는 위 명시 allowlist로 마스킹한다. 생 인스타그램 식별자, 이름, bio/소개글, 댓글/comment, caption/캡션, 이미지·미디어와 고객 또는 사용자 입력 이메일·전화번호·연락처, 결제 연락처, raw 오류·응답 같은 민감 개인정보는 replay 또는 event에 보내지 않는다. 허용 핵심 경로의 page/container는 구조와 흐름만 보이도록 마스킹하며, 실제 private/sensitive 영역과 미디어는 계속 차단한다.

## 3. 이벤트와 허용 속성

이벤트 vocabulary:

- 유입·인증: `landing_viewed`, `target_submitted`, `auth_started`, `auth_completed`
- 사전 검사: `preflight_started`, `preflight_succeeded`, `preflight_failed`, `exclusion_decided`
- 플랜·결제 이동: `plan_viewed`, `plan_selected`, `checkout_started`, `checkout_redirected`
- 결제 확인: `payment_confirmed_viewed`, `earlybird_status_viewed`
- 분석·결과: `analysis_started`, `analysis_completed`, `result_viewed`, `result_shared`

허용 properties는 `plan_id`, `required_plan_id`, `amount_krw`, `stage`, `status`, `duration_ms`, 닫힌 `error_code`, 구간화한 followers/following 수, 제한된 UTM source·medium·campaign·content·term, 내부 preflight/order/request UUID, 결과 수, 공유 여부·채널로 제한한다. `plan_id`에 `plus`가 존재하는 것은 공통 스키마 호환을 위한 것이며 Plus 대기 신청 전용 분석을 뜻하지 않는다.

## 4. 대시보드 생성

실제 이벤트가 한 건 이상 수신된 뒤, 아래 운영 대시보드가 없을 때만 로그인된 Comet 브라우저의 Amplitude UI에서 Production API key가 연결된 프로젝트를 선택하고 `얼리버드 전환 대시보드`를 만든다. 차트 생성 API를 사용하지 않고 기존 대시보드를 중복 생성하지 않는다. Preview도 같은 프로젝트를 쓴다면 알려진 테스트 Supabase UUID를 user segment에서 제외한다. 이메일이나 전화번호로 테스트 사용자를 구분하지 않는다.

현재 운영 대시보드는 [Amplitude `얼리버드 전환 대시보드`](https://app.amplitude.com/analytics/shiny-disk-989835/dashboard/p7w87cf8)이다. 저장된 전체 차트에서 taxonomy seed user ID `00000000-0000-4000-8000-000000000001`을 제외한다.

1. 일별 유입과 UTM 채널: `landing_viewed` 추이와 source·medium·campaign breakdown
2. 핵심 전환 funnel: `landing_viewed` → `target_submitted` → `auth_completed` → `preflight_succeeded` → `plan_selected` → `checkout_redirected` → `payment_confirmed_viewed`
3. 단계별 이탈률: 같은 funnel의 단계 전환율과 median conversion time
4. Basic·Standard 수요: `plan_viewed`, `plan_selected`, `checkout_started`, `checkout_redirected`를 `plan_id`로 breakdown하고 각 플랜 전환율 비교
5. 사전 검사 품질: `preflight_succeeded`와 `preflight_failed` 비율, `error_code` breakdown, `duration_ms` p50·p90
6. 결제 확인: `payment_confirmed_viewed`의 distinct user·event 수, `amount_krw` 합계·플랜별 breakdown. 매출 확정은 Supabase와 대조
7. 결과 사용: `result_viewed`, `result_shared` 추이와 `share_channel`, `is_shared` breakdown
8. 이벤트 기반 핵심 이탈 세그먼트: 같은 세션에서 `target_submitted` 후 `preflight_succeeded`가 없거나 `plan_selected` 후 `checkout_redirected`가 없는 사용자. Replay 링크 없이 후속 이벤트 유무로만 구성

기존 8개 이벤트 대시보드 패널은 유지한다. Replay는 이 대시보드의 대체 지표나 별도 민감 화면 패널이 아니며, 허용 핵심 경로에서 수신된 표본 세션의 문제를 조사할 때만 보조적으로 확인한다. Plus 대기 신청 전용 차트도 만들지 않고 대시보드에서 제외한다.

## 5. Live 검증

- Production 검증에서는 5% sampling 때문에 한 세션에서 Replay 영상이 반드시 생긴다고 가정하거나 배포 전에 실제 UI 수신을 확정하지 않는다. `/`, `/privacy`, `/terms`, `/login`, `/analyze`, `/earlybird`, `/mypage`, `/progress/:requestId`, `/result/:requestId`, `/share/:token`을 통과하는 표본 세션을 충분히 만든 뒤 Replay 수신 여부를 확인한다.
- Amplitude User Lookup 또는 Debugger에서 이벤트 순서와 Supabase UUID identity를 확인한다. 익명 이벤트가 인증 후 잘못된 이메일·전화번호 identity에 연결되지 않았는지 확인한다.
- 결제 완료 fixture 또는 실제 검증 결제는 고객 화면이 `paid`를 읽은 뒤 `payment_confirmed_viewed`를 한 번만 보내는지 확인한다. 중복 새로고침은 dedupe 계약과 비교한다.
- 각 이벤트 상세의 properties 탭에서 schema에 없는 값이 제거되는지 확인한다.
- 합성 query·hash·request ID·share token으로 허용 경로를 이동하고, 수신된 Replay가 있을 때 meta와 batched click·scroll interaction의 page URL이 각각 식별자 없는 정적 경로 템플릿으로만 표시되는지 확인한다. click과 scroll을 실제로 발생시켜 표본 세션에서 interaction이 연결되는지도 확인한다.
- 알 수 없는 경로와 admin·API 경로에서는 Replay가 수신되지 않는지 확인한다. DNT/GPC opt-out 브라우저도 수신되지 않아야 한다.
- 금지 속성 검사: `email`, `phone`, `name`, `instagram`, `username`, `profile`, `bio`, `comment`, `caption`, `image`, `media`, `url`, `token`, `cookie`, `signature`, `body`, `response` 이름이나 실제 민감 값이 event·user properties에 없는지 검사한다. Replay에는 고객 또는 사용자 입력 이메일·연락처와 민감 개인정보가 없어야 하며, text/input과 `href`, `src`, `alt`, `title`, `aria-label`, `value`, `placeholder`가 마스킹되고 private/sensitive 노드와 모든 `img`, `video`, `audio`, `canvas`, `svg`가 차단됐는지 확인한다.
- Replay payload와 UI에서 network·console·performance·document title 수집 및 일반 Analytics autocapture가 활성화되지 않았는지 확인한다.

검증 중 민감 속성이 발견되면 대시보드 작성과 Production rollout을 중단한다. allowlist 또는 caller를 수정하고 잘못 수집된 데이터의 삭제 절차를 Amplitude 프로젝트 관리자와 확인한 뒤 다시 검증한다.

## 6. Rollout과 롤백

`DEMO_ANALYSIS_ENABLED`는 server-only 데모 자격(demo eligibility)만 제어하며 브라우저로 직렬화하거나 Replay gate에 사용하지 않는다. 따라서 값과 관계없이 `/analyze`, `/progress/:requestId`, `/result/:requestId`, `/share/:token`을 포함한 위 허용 핵심 경로는 다른 Replay 조건을 모두 충족하면 수집 후보가 된다. 알 수 없는 경로와 admin·API 경로는 계속 route allowlist 밖에서 차단된다.

Rollout은 로컬 테스트, Vercel Preview 명시 이벤트 검증, 금지 속성·URL canonicalization 검사, Production에 `NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED=true` 및 `NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE=0.05` 설정, Production live 검증 순서로 진행한다. 배포 전에는 Replay UI 수신을 완료된 사실로 기록하지 않으며, 배포 직후 충분한 5% 표본을 만든 다음 핵심 funnel 이벤트, canonical route template, batched click·scroll interaction, 마스킹·차단 상태와 제품 흐름을 함께 확인한다.

Replay만 롤백하려면 `NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED=false`와 `NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE=0`을 함께 설정하고 재배포한다. 이 조치는 명시 이벤트 analytics는 유지한다. 반대로 `NEXT_PUBLIC_AMPLITUDE_API_KEY`를 제거하는 것은 전체 analytics kill switch로서 명시 이벤트 전송까지 모두 중단한다. SDK 실패나 key 제거 후에도 로그인·preflight·checkout·결과 화면이 정상 동작해야 한다.
