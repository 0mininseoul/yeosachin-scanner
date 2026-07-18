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
- 자동 수집은 세션 경계만 사용하고 page URL, page view, form, element interaction, network, performance, attribution 자동 수집은 끈다.

## 2. 개인정보 경계

Session Replay는 현재 비활성화 상태다. 구현은 `sampleRate: 0`, `capture_enabled: false`를 강제하며 interaction, network, document title, URL change 수집도 끈다. 원격 설정도 0으로 고정해 fail-closed로 동작하므로 replay 영상은 수집·보관되지 않는다.

명시 이벤트와 속성은 닫힌 allowlist를 통과한다. 생 인스타그램 아이디, 이메일, 전화번호, 이름, profile/bio/comment/caption 등 소셜 콘텐츠, 이미지·미디어·페이지 URL, 결제 연락처, raw 오류·응답은 보내지 않는다. 민감 화면의 block/mask 표시는 Replay가 실수로 활성화되는 변경에 대비한 추가 방어선이며 현재 수집을 의미하지 않는다.

## 3. 이벤트와 허용 속성

이벤트 vocabulary:

- 유입·인증: `landing_viewed`, `target_submitted`, `auth_started`, `auth_completed`
- 사전 검사: `preflight_started`, `preflight_succeeded`, `preflight_failed`, `exclusion_decided`
- 플랜·결제 이동: `plan_viewed`, `plan_selected`, `checkout_started`, `checkout_redirected`
- 결제 확인: `payment_confirmed_viewed`, `earlybird_status_viewed`
- 분석·결과: `analysis_started`, `analysis_completed`, `result_viewed`, `result_shared`

허용 properties는 `plan_id`, `required_plan_id`, `amount_krw`, `stage`, `status`, `duration_ms`, 닫힌 `error_code`, 구간화한 followers/following 수, 제한된 UTM source·medium·campaign·content·term, 내부 preflight/order/request UUID, 결과 수, 공유 여부·채널로 제한한다. `plan_id`에 `plus`가 존재하는 것은 공통 스키마 호환을 위한 것이며 Plus 대기 신청 전용 분석을 뜻하지 않는다.

## 4. 대시보드 생성

실제 이벤트가 한 건 이상 수신된 뒤 로그인된 Comet 브라우저의 Amplitude UI에서 Production API key가 연결된 프로젝트를 선택하고 새 dashboard `얼리버드 전환 대시보드`를 만든다. 차트 생성 API를 사용하지 않는다. Preview도 같은 프로젝트를 쓴다면 알려진 테스트 Supabase UUID를 user segment에서 제외한다. 이메일이나 전화번호로 테스트 사용자를 구분하지 않는다.

1. 일별 유입과 UTM 채널: `landing_viewed` 추이와 source·medium·campaign breakdown
2. 핵심 전환 funnel: `landing_viewed` → `target_submitted` → `auth_completed` → `preflight_succeeded` → `plan_selected` → `checkout_redirected` → `payment_confirmed_viewed`
3. 단계별 이탈률: 같은 funnel의 단계 전환율과 median conversion time
4. Basic·Standard 수요: `plan_viewed`, `plan_selected`, `checkout_started`, `checkout_redirected`를 `plan_id`로 breakdown하고 각 플랜 전환율 비교
5. 사전 검사 품질: `preflight_succeeded`와 `preflight_failed` 비율, `error_code` breakdown, `duration_ms` p50·p90
6. 결제 확인: `payment_confirmed_viewed`의 distinct user·event 수, `amount_krw` 합계·플랜별 breakdown. 매출 확정은 Supabase와 대조
7. 결과 사용: `result_viewed`, `result_shared` 추이와 `share_channel`, `is_shared` breakdown
8. 이벤트 기반 핵심 이탈 세그먼트: 같은 세션에서 `target_submitted` 후 `preflight_succeeded`가 없거나 `plan_selected` 후 `checkout_redirected`가 없는 사용자. Replay 링크 없이 후속 이벤트 유무로만 구성

Session Replay가 비활성화되어 있으므로 Replay 세그먼트나 영상 패널을 만들지 않는다. Plus 대기 신청 전용 차트도 만들지 않고 대시보드에서 제외한다.

## 5. Live 검증

- Preview 또는 Production에서 동의된 테스트 사용자로 landing → 대상 입력 → 인증 → preflight → 플랜 조회·선택 → checkout 이동까지 한 번 수행한다.
- Amplitude User Lookup 또는 Debugger에서 이벤트 순서와 Supabase UUID identity를 확인한다. 익명 이벤트가 인증 후 잘못된 이메일·전화번호 identity에 연결되지 않았는지 확인한다.
- 결제 완료 fixture 또는 실제 검증 결제는 고객 화면이 `paid`를 읽은 뒤 `payment_confirmed_viewed`를 한 번만 보내는지 확인한다. 중복 새로고침은 dedupe 계약과 비교한다.
- 각 이벤트 상세의 properties 탭에서 schema에 없는 값이 제거되는지 확인한다.
- 금지 속성 검사: `email`, `phone`, `name`, `instagram`, `username`, `profile`, `bio`, `comment`, `caption`, `image`, `media`, `url`, `token`, `cookie`, `signature`, `body`, `response` 이름이나 실제 민감 값이 event·user properties에 없는지 표본 검사한다.
- `[Amplitude] Replay Captured` 이벤트와 Replay 영상이 새로 생성되지 않는지 확인한다.

검증 중 민감 속성이 발견되면 대시보드 작성과 Production rollout을 중단한다. allowlist 또는 caller를 수정하고 잘못 수집된 데이터의 삭제 절차를 Amplitude 프로젝트 관리자와 확인한 뒤 다시 검증한다.

## 6. Rollout과 롤백

Rollout은 로컬 테스트, Vercel Preview 실이벤트, 금지 속성 검사, Production 환경 변수 추가, Production live event 확인 순서로 진행한다. 배포 직후 핵심 funnel 이벤트 수신과 제품 흐름을 함께 확인한다.

롤백은 `NEXT_PUBLIC_AMPLITUDE_API_KEY`를 Production 환경에서 제거하고 재배포하여 새 전송을 중단하는 방식으로 수행한다. SDK 실패나 key 제거 후에도 로그인·preflight·checkout·결과 화면이 정상 동작해야 한다. Session Replay는 문제 해결 중에도 `sampleRate: 0`과 capture 비활성 상태를 유지한다.
