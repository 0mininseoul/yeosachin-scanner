# Groble 얼리버드 사전 구매 운영 인수인계

## Groble 대시보드 입력값

기존에 생성된 Basic/Standard 결제창을 그대로 사용한다. 새 상품을 만들거나 이 저장소에서 Groble 재고를 수정하지 않는다.

| 설정 | Basic | Standard |
|---|---|---|
| 진입 페이지 | `https://yeosachin.vercel.app/analyze?plan=basic` | `https://yeosachin.vercel.app/analyze?plan=standard` |
| 이동 페이지 | `https://yeosachin.vercel.app/earlybird?plan=basic` | `https://yeosachin.vercel.app/earlybird?plan=standard` |
| 이동 버튼 문구 | `사전 구매 현황 확인` | `사전 구매 현황 확인` |
| Groble 상품 재고 | 10건 유지 | 10건 유지 |

Webhook URL은 `https://yeosachin.vercel.app/api/webhooks/groble`이며 `payment.completed`와 `payment.cancel_requested`를 구독한다.

Groble의 현재 공식 가이드를 기준으로 결제창 주소는 `https://groble.im/payment/{결제창 주소}` 형식을 사용한다. 진입 페이지는 결제창을 닫거나 뒤로 갈 때 돌아오는 판매 페이지이고, 이동 페이지는 완료 화면 버튼의 목적지일 뿐 결제 증명이 아니다.

- [결제창 연동 가이드](https://www.groble.im/help/guides/payment-module)
- [Webhook 연동 가이드](https://www.groble.im/help/guides/webhook)
- [Webhook 이벤트 명세](https://www.groble.im/help/guides/webhook-events)

## 서버 환경변수

다음 값은 모두 서버 전용이다. `NEXT_PUBLIC_` 접두사를 붙이거나 실제 값을 커밋하지 않는다.

```dotenv
GROBLE_BASIC_PRODUCT_ID=<Basic webhook content.id>
GROBLE_STANDARD_PRODUCT_ID=<Standard webhook content.id>
GROBLE_BASIC_PAYMENT_ADDRESS=<Basic 결제 URL의 payment/ 뒤 주소>
GROBLE_STANDARD_PAYMENT_ADDRESS=<Standard 결제 URL의 payment/ 뒤 주소>
GROBLE_WEBHOOK_SECRET=<Groble webhook secret>
GROBLE_WEBHOOK_PREVIOUS_SECRET=<키 교체 기간에만 이전 secret>
```

상품 ID와 결제창 주소는 서로 다른 값으로 관리하며 영문, 숫자, `_`, `-`만 허용한다. 상품 ID는 webhook `content.id` 검증에만 사용하고, 결제창 주소는 URL 생성에만 사용한다. Webhook secret 교체 중에는 현재 서명과 이전 서명을 각각 공식 헤더로 검증하고, 교체가 끝나면 이전 secret을 제거한다.

## 배포 순서

이 문서는 순서만 정의한다. 사용자 승인 전에는 아래 배포와 실제 결제를 수행하지 않는다.

1. Groble의 기존 두 상품 가격과 상품별 재고 10건을 대시보드에서 다시 확인한다.
2. 운영 환경의 다섯 가지 필수 서버 전용 값과, 필요한 경우 이전 webhook secret을 비밀 관리 시스템에 설정한다.
3. `20260717140000_add_groble_earlybird_presale.sql` forward migration을 먼저 적용한다.
4. 애플리케이션 코드를 배포한다.
5. Groble에 위 진입 페이지, 이동 페이지, 이동 버튼 문구, webhook URL과 이벤트를 설정한다.
6. 승인된 별도 점검 창에서 서명 검증, 멱등 재전송, Basic/Standard 상태 복원을 확인한다.

롤백은 코드를 먼저 이전 버전으로 돌린 뒤 접수를 중단한다. 이미 생성된 주문·결제 감사 행은 삭제하지 않는다. forward migration의 테이블을 되돌리는 파괴적 migration은 만들지 않는다.

## 결제 확정과 수량 운영

- 성공 화면 진입이나 프론트 숫자로 접수 확정하지 않는다.
- 공식 raw-body HMAC과 ±5분 timestamp를 통과한 `payment.completed`만 접수를 확정하며, `payment.cancel_requested`는 환불 검토 상태로만 전환한다.
- 결제창 구매자 이메일은 현재 로그인 계정의 이메일과 같아야 한다. 이메일·전화번호·카드 정보와 원본 payload는 새 테이블이나 브라우저 응답에 저장하지 않는다.
- 다른 플랜의 최신 사전 점검으로 다시 시도하면 이전 미처리 주문은 snapshot을 변경하지 않고 `cancelled`로 남기며, 새 snapshot으로 별도 주문을 만든다. 이전 결제창에서 뒤늦게 결제된 건은 새 주문에 붙이지 않고 환불 검토 대상으로 격리한다.
- Groble 완료 이벤트에는 앱의 주문 식별자가 없으므로, 같은 구매자가 같은 플랜을 새 snapshot으로 다시 열면 이전 주문과 구분할 수 없다. 현재 `payment_pending` 주문이나 같은 상품의 미해결 `cancelled` 주문이 있으면 새 주문을 만들지 않고 `EARLYBIRD_CHECKOUT_ALREADY_PENDING`으로 차단하여 기존 snapshot을 보존한다. 이미 종료 상태인 동일 주문은 결제창 재진입 대상으로 반환하지 않는다.
- Basic과 Standard는 각각 독립된 서버 한도 10건과 순번 1~10을 사용한다. 한 플랜의 남은 수량을 다른 플랜으로 옮기지 않는다.
- 채널 표시 수량의 정본은 [운영 원가 문서의 Groble 얼리버드 표시안](./operations-cost-model.md#groble-얼리버드-표시안-성공-e2e-후-확정)과 함께 확인한다.
- Groble 상품 재고와 서버 inventory를 동시에 유지한다.
- 이미 결제된 11번째 예외는 `overflow_refund_required`로 분리된다. 운영자는 이 상태를 환불 처리 대상으로 확인하고, 실제 조치는 승인된 Groble 운영 절차를 따른다.
- 구매자 취소 요청은 `refund_pending`으로 표시한다. 최종 `cancelled`/`refunded` 전환은 서비스 역할 전용 RPC를 사용하는 운영 절차에서만 수행한다.
- 취소 요청 webhook이 결제 완료 webhook보다 먼저 도착해도 후속 결제를 판매로 확정하거나 수량에 포함하지 않고 `refund_pending`으로 재조정한다.
- 결제 확정은 `analysis_requests`를 만들거나 Cloud Tasks/V2 자동 분석을 시작하지 않는다.

## 수동 결과 연결

판독 작업을 수동으로 진행할 때 주문 상태는 `paid`에서 `analysis_in_progress`, `completed` 순으로 변경한다. 완료 주문에 `result_request_id`를 연결할 수 있지만, 연결된 `analysis_requests.user_id`가 주문 소유자와 같고 결과가 완료 상태일 때만 링크가 표시된다.

이 변경에는 운영자 UI가 포함되지 않는다. 서비스 역할을 사용하는 운영 도구는 주문 소유권을 검증하고 최소 필드만 갱신해야 하며, 토큰·서명·구매자 정보를 로그에 남기지 않는다.

## 정책 문구

애플리케이션에 새로운 취소·환불 안내를 추가하지 않는다. Groble 상품 화면에는 심사를 통과한 실제 정책 원문만 유지하고, 변경이 필요하면 승인된 원문을 별도 제공받아 검토 후 반영한다.
