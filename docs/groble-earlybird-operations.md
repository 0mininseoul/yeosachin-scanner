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
4. 아래 전화번호 매칭 migration 게이트를 통과한 뒤 5개 파일을 순서대로 적용한다.
5. 12개 인자 finalizer와 9개 인자 호환 wrapper의 시그니처와 service-role ACL을 확인한다.
6. 애플리케이션 코드를 배포한다. 롤링 배포 중 이전 인스턴스는 9개 인자 wrapper를 계속 사용한다.
7. Groble에 위 진입 페이지, 이동 페이지, 이동 버튼 문구, webhook URL과 이벤트를 설정한다.
8. 승인된 별도 점검 창에서 서명 검증, 멱등 재전송, Basic/Standard 상태 복원을 확인한다.

롤백은 코드를 먼저 이전 버전으로 돌린 뒤 접수를 중단한다. 이미 생성된 주문·결제 감사 행은 삭제하지 않는다. forward migration의 테이블을 되돌리는 파괴적 migration은 만들지 않는다.

## 전화번호 매칭 migration 게이트

Supabase CLI v2.102.0은 각 migration 파일 전체를 하나의 implicit transaction으로 실행한다. no-transaction 지시자와 `CREATE INDEX CONCURRENTLY`를 migration 안에서 사용하지 않는다. 따라서 다음 파일 경계를 유지한다.

| 순서 | migration | transaction 범위와 lock 의미 |
|---|---|---|
| 1 | `20260718104053_add_groble_phone_matching.sql` | nullable column, `NOT VALID` check, 정규화 helper와 `earlybird_orders`의 null-only Kakao `BEFORE INSERT` snapshot trigger를 추가한다. trigger 생성은 기존 `ALTER TABLE` transaction 안에서 끝나는 짧은 schema 작업이며, ACCESS EXCLUSIVE lock을 스캔·인덱스·RPC 작업 동안 유지하지 않는다. |
| 2 | `20260718114650_activate_groble_phone_checkout.sql` | checkout RPC와 service-role ACL만 교체한다. 새 RPC도 유효한 raw `phone_number`를 우선 snapshot하고 Kakao 전화번호가 없으면 INSERT 전에 거부한다. |
| 3 | `20260718114658_backfill_groble_phone_matching.sql` | `users`와 미해결 주문을 DML로 백필한다. 유효한 raw 번호를 우선하되 raw 값이 무효하면 기존 trusted normalized 값을 보존하고, 정규화 중복이 있으면 전체 transaction을 중단한다. |
| 4 | `20260718114707_validate_groble_phone_matching.sql` | check validation과 3개의 일반 index build만 수행한다. 인덱스의 write-blocking lock을 1번 ACCESS EXCLUSIVE transaction과 분리한다. |
| 5 | `20260718120345_activate_groble_phone_finalization.sql` | 12개 인자 finalizer, 9개 인자 호환 wrapper, refund RPC와 grant만 교체한다. index build 실패와 finalization 계약 활성화를 분리한다. |

다섯 파일은 모두 `lock_timeout = '5s'`와 `statement_timeout = '2min'`으로 제한한다. 1번이 커밋된 뒤 발생하는 모든 주문 INSERT는 RPC 버전과 무관하게 trigger를 통과한다. 따라서 2번 교체 전에 시작해 사용자 advisory lock에서 대기하다가 3번 백필 후 이전 함수 본문으로 INSERT하는 호출도, INSERT 순간 유효한 raw Kakao 번호를 우선 정규화하고 raw 값이 무효할 때만 저장된 normalized 값으로 fallback해 snapshot한다. 1번 전에 이미 존재한 null snapshot은 3번이 백필한다. trigger는 null인 Kakao INSERT에만 동작하고 UPDATE에는 동작하지 않으므로 기존 snapshot과 Google 이메일 fallback을 변경하지 않는다. 이 불변식은 checkout 중단이나 maintenance-only workaround에 의존하지 않는다.

2026-07-18 원격 실측 기준은 `users` 약 0행/49KB, `earlybird_orders` 1행/128KB, `earlybird_webhook_events` 10행/72KB이다. push 직전 SQL editor에서 다음을 다시 실행한다.

```sql
SELECT relname,
       n_live_tup::BIGINT AS estimated_rows,
       pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(relid)) AS total_size
FROM pg_catalog.pg_stat_user_tables
WHERE schemaname = 'public'
  AND relname IN ('users', 'earlybird_orders', 'earlybird_webhook_events')
ORDER BY relname;

SELECT pid, usename, application_name, state, xact_start
FROM pg_catalog.pg_stat_activity
WHERE xact_start < pg_catalog.clock_timestamp() - INTERVAL '30 seconds'
  AND pid <> pg_catalog.pg_backend_pid()
ORDER BY xact_start;
```

어느 테이블이든 10,000행 또는 10MB를 넘거나 30초 이상 진행 중인 transaction이 있으면 일반 push를 중단하고 쓰기 트래픽을 제한한 maintenance window에서 다시 검토한다. 작은 실측 규모가 유지되면 `npx supabase migration list --linked`로 순서를 확인한 뒤 push한다.

`lock_timeout` 또는 `statement_timeout`으로 특정 파일이 실패하면 그 파일의 transaction은 전체 롤백된다. 자동 반복하거나 migration history를 수동 완료 처리하지 않는다. `migration list --linked`로 완료된 이전 파일과 실패한 파일을 확인하고, 대기 transaction을 제거하거나 maintenance window를 잡은 뒤 미적용 파일부터 재시도한다. `DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW`는 재시도 대상이 아니라 계정 소유권 확인 후 데이터를 해결해야 하는 중단 조건이다.

9개 인자 finalizer wrapper는 롤링 배포의 이전 인스턴스가 모두 drain된 후에도 즉시 삭제하지 않는다. 호출 현황을 확인한 후 별도 post-drain forward migration으로만 제거한다.

## 결제 확정과 수량 운영

- 성공 화면 진입이나 프론트 숫자로 접수 확정하지 않는다.
- 공식 raw-body HMAC과 ±5분 timestamp를 통과한 `payment.completed`만 접수를 확정하며, `payment.cancel_requested`는 환불 검토 상태로만 전환한다.
- 결제 완료는 checkout 시점의 정규화 전화번호 snapshot을 이메일보다 먼저 매칭한다. 전화번호 후보가 없을 때만 기존 이메일 규칙으로 fallback한다.
- Groble 구매자 이메일·전화번호·표시 이름은 길이를 제한한 service-role 전용 결제 증거로만 저장한다. 카드 정보와 원본 payload는 저장하지 않고, 브라우저 응답·Amplitude·Axiom에 구매자 증거를 보내지 않는다.
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
