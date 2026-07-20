# Groble 얼리버드 사전 구매 설계

> **[중요: 폐기된 기한 안내]** 이 문서는 판독 결과 제공 기한을 결제 완료 후 **48시간**
> (`earlybird-48h-v1` 고지 버전, `due_at = paid_at + interval '48 hours'`)으로 설계하고 있으나,
> 이후 **폐기(superseded)** 되었다. 현재는 결제 완료 후 **24시간**이며, 고지 버전도
> `earlybird-24h-v1`로 이름이 바뀌었다 —
> `supabase/migrations/20260720100000_shorten_earlybird_delivery_window.sql` 기준. 아래
> 본문의 48시간 관련 서술은 폐기된 설계 기록이므로 그대로 따르지 말 것.

## 목표

Basic과 Standard는 Groble에 이미 등록된 결제창으로 각각 10건만 얼리버드 사전 구매를 받고, Plus는 결제 없이 대기 신청만 받는다. 결제 확정은 브라우저 복귀가 아니라 검증된 Groble `payment.completed` 웹훅으로만 수행한다. 결제 확정은 자동 V2 분석이나 Cloud Tasks를 시작하지 않으며, 수동 판독 상태와 결과 연결은 별도 얼리버드 주문 상태 머신에서 관리한다.

## 공식 연동 계약

- 결제창 URL은 Groble 결제창 가이드의 `https://groble.im/payment/{결제창 주소}` 형식을 사용한다.
- Groble의 진입 페이지는 결제창에서 뒤로 가거나 완료 화면을 닫을 때 돌아오는 판매 페이지다.
- Groble의 이동 페이지는 완료 화면의 이동 버튼 목적지일 뿐 결제 증명이 아니다.
- 일반 결제 확정은 `payment.completed` 이벤트만 인정하고, `payment.cancel_requested`는 환불 검토 상태 전환에만 사용한다.
- 웹훅은 JSON 파싱 전 원문에 대해 `HEX(HMAC-SHA256(secret, "{timestamp}.{raw_body}"))`를 검증한다.
- `X-Groble-Timestamp`는 현재 시각 기준 ±5분만 허용하고, `X-Groble-Idempotency-Key`와 이벤트 ID를 중복 방지 키로 저장한다.
- 상품 ID는 `content.id`, 실결제 금액은 `pricing.finalAmount`, 결제 ID는 `merchantUid`, 결제 확정 시각은 `payment.purchasedAt`에서 읽는다.

## 상품과 가격

| 플랜 | 기준가 | 얼리버드가 | 서버 한도 | 처리 |
|---|---:|---:|---:|---|
| Basic | 39,900원 | 14,900원 | 10건 | Groble 결제 |
| Standard | 69,900원 | 19,900원 | 10건 | Groble 결제 |
| Plus | 표시 가격 없음 | 결제 없음 | 해당 없음 | 대기 신청 |

가격 버전은 `earlybird-2026-07-v1`, 필수 고지 문구 버전은 `earlybird-48h-v1`로 고정한다. 사용자 화면과 저장 데이터에는 얼리버드 사전 구매 표현만 사용한다.

얼리버드 진입을 위해 세 플랜의 분석 카탈로그 노출 상태는 `production`으로 전환한다. Basic과 Standard만 결제 가능한 고정 KRW 가격을 가지며 Plus 가격은 계속 미정 상태로 두고 대기 신청만 허용한다. 이 변경은 결제 확정 시 자동 분석 실행을 뜻하지 않는다.

## 결제 전 흐름

1. 사용자는 로그인 후 기존 V2 preflight와 여자친구 제외 결정을 완료한다.
2. 클라이언트는 플랜 ID와 preflight ID, 필수 고지 동의 여부만 보낸다. 가격과 팔로워·팔로잉 수는 보내더라도 사용하지 않는다.
3. 서버는 소유자에게 속하고, 만료되지 않았고, `ready`이며, 제외 결정이 완료된 preflight를 다시 읽는다.
4. 서버는 preflight의 `required_plan_id`, `plan_cards_snapshot`, `pricing_version`, `pricing_snapshot`으로 선택 가능 여부와 금액을 검증한다. Standard 필요 계정의 Basic 구매와 Plus 결제 생성을 차단한다.
5. 서버 전용 RPC가 preflight와 사용자를 잠그고 대상 계정, 제외 계정, 관계 수, 플랜, 가격 버전, 동의 문구와 동의 시각을 주문에 고정한다.
6. Basic/Standard는 서버 환경변수의 기존 Groble 결제창 주소로 결제 URL을 만들고, 별도 상품 ID는 webhook 검증 기대값으로 주문에 고정한다. Plus는 별도 대기 신청 행만 생성한다.

Groble의 공개 결제창 가이드에는 동적 주문 메타데이터 전달 계약이 없으므로, 웹훅의 정규화된 `buyer.email`을 기존 `users.email`과 대조해 사용자를 찾고 그 사용자의 해당 상품 `payment_pending` 주문을 확정한다. 구매자 이메일은 새 테이블이나 webhook 감사 로그에 복제 저장하지 않는다. 같은 사용자·상품의 복수 주문은 이벤트만으로 식별할 수 없으므로, 기존 `payment_pending` 주문이나 해당 상품의 미해결 `cancelled` 주문이 있으면 같은 플랜의 새 snapshot 주문 생성을 차단한다.

## 데이터 모델

### `earlybird_orders`

- 소유자: `user_id`
- 원본: `preflight_id`
- 고정 스냅샷: 대상 계정, 팔로워·팔로잉 수, 제외 결정·계정, 플랜, 가격 버전, 기대 금액, 기대 Groble 상품 ID
- 동의 증적: 문구 버전, 문구 전체, 동의 시각
- 결제 증적: 고유 `payment_id`, 실제 상품 ID, 실제 결제 금액, `paid_at`, `due_at`
- 접수: 플랜별 `plan_sequence` 1~10
- 수동 처리: 주문 상태와 nullable `result_request_id`

주문 상태는 `payment_pending`, `payment_failed`, `paid`, `analysis_in_progress`, `completed`, `overflow_refund_required`, `cancelled`, `refund_pending`, `refunded`를 사용한다. 사용자 노출 상태는 각각 결제 확인, 판독 대기, 판독 중, 결과 전달 완료 또는 해당 예외 상태로 매핑한다.

### `earlybird_plan_inventory`

Basic과 Standard에 독립된 한도 10과 확정 건수를 저장한다. 결제 확정 RPC는 해당 플랜 행만 `FOR UPDATE`로 잠근다. 다른 플랜의 남는 수량은 읽거나 이전하지 않는다.

### `earlybird_webhook_events`

이벤트 ID, Groble 멱등 키, 이벤트 타입·시각, 결제 ID, 상품 ID, 금액, 처리 결과, 연결 주문 ID만 저장한다. 원본 payload, 구매자 이름·이메일·전화번호, 카드 정보는 저장하지 않는다.

### `earlybird_waitlist`

Plus 대상의 사용자, preflight, 대상·제외 계정 스냅샷과 신청 시각을 저장한다. 결제 ID, 결제 금액, Groble 상품 ID는 두지 않는다.

## 원자적 결제 확정

서비스 역할만 호출 가능한 `finalize_earlybird_groble_payment` RPC가 한 트랜잭션에서 다음을 수행한다.

1. 결제 ID 기준 transaction advisory lock을 획득한다.
2. 이미 같은 `payment_id`로 확정된 주문이 있으면 기존 결과를 반환한다.
3. 이벤트 ID와 멱등 키를 감사 테이블에서 중복 확인한다.
4. 구매자 이메일로 기존 사용자를 찾고, 사용자·상품에 맞는 최신 `payment_pending` 주문을 잠근다.
5. 상품 ID와 금액이 주문의 기대값과 정확히 일치하는지 확인한다. 불일치는 `payment_failed`로 격리한다.
6. 해당 플랜의 inventory 행만 잠근다.
7. 10건 미만이면 확정 건수를 1 증가시키고 그 값을 `plan_sequence`로 배정한다. `paid_at`은 Groble 구매 완료 시각이며 `due_at = paid_at + interval '48 hours'`로 저장한다.
8. 이미 10건이면 inventory를 증가시키지 않고 주문을 `overflow_refund_required`로 격리한다.
9. 처리 결과를 webhook 감사 행에 저장하고 반환한다.

Basic과 Standard가 서로 다른 inventory 행을 잠그므로 수량과 순번은 서로 간섭하지 않는다. `payment_id`에는 UNIQUE 제약을 두고 이벤트 ID와 멱등 키도 각각 UNIQUE로 둔다.

## 권한과 노출

- 모든 새 `public` 테이블에 RLS를 켠다.
- 주문과 대기 신청은 `TO authenticated USING ((select auth.uid()) = user_id)` 소유자 조회 정책만 둔다.
- insert/update/delete는 브라우저에 부여하지 않는다.
- webhook 감사와 inventory는 브라우저 정책을 만들지 않는다.
- SECURITY DEFINER RPC는 `search_path = ''`를 사용하고 `PUBLIC`, `anon`, `authenticated` 실행 권한을 회수한 뒤 `service_role`에만 허용한다.
- 상태 API는 service role로 읽더라도 인증 사용자 ID로 필터링하고 안전한 DTO만 반환한다.
- 결과 링크는 연결된 `analysis_requests.user_id`가 주문 소유자와 같은 경우에만 노출한다.

## 화면과 URL

- 진입 페이지
  - Basic: `https://yeosachin.vercel.app/analyze?plan=basic`
  - Standard: `https://yeosachin.vercel.app/analyze?plan=standard`
- 이동 페이지
  - Basic: `https://yeosachin.vercel.app/earlybird?plan=basic`
  - Standard: `https://yeosachin.vercel.app/earlybird?plan=standard`
- 이동 버튼 문구: `사전 구매 현황 확인`
- webhook: `https://yeosachin.vercel.app/api/webhooks/groble`

`/analyze`는 플랜 카드, 기준가 취소선, 얼리버드가, 플랜별 선착순 10건 안내, 필수 고지 체크박스, 결제 버튼 또는 Plus 대기 신청 버튼을 제공한다. 브라우저 숫자를 재고 판단에 사용하지 않으며 실제 판매 제한은 서버 트랜잭션에서만 판정한다. `/earlybird`는 새로고침하거나 다시 방문해도 소유자의 최신 주문을 서버에서 복원하며 대상 계정, 플랜, 실결제 금액, 접수 시각, 48시간 전달 예정 시각, 플랜별 순번, 현재 상태, 안전한 결과 링크를 표시한다.

## 취소·환불 문구

이번 변경에서 별도 취소·환불 정책 문구를 새로 작성하지 않는다. Groble 심사에 사용된 실제 정책이 저장소에 제공되지 않았으므로, 기존 약관 링크와 Groble 주문 화면 외에 임의 문구를 추가하지 않는다.

## 비범위

- Groble 상품 생성·수정·재고 변경
- 운영 배포와 실제 결제
- 결제 확정 시 `analysis_requests` 생성
- 결제 확정 시 Cloud Tasks 또는 자동 V2 분석 시작
- 운영자용 수동 처리 UI
