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
4. checkout 쓰기를 제한한 maintenance window에서 아래 전화번호 매칭 migration 게이트를 통과한 뒤 6개 파일을 순서대로 적용한다.
5. migration 적용 후 DB schema, 12개 인자 finalizer와 9개 인자 호환 wrapper의 signature, service-role ACL을 확인한다.
6. 애플리케이션 코드를 배포한다. 롤링 배포 중 이전 인스턴스는 9개 인자 wrapper를 계속 사용한다.
7. Groble에 위 진입 페이지, 이동 페이지, 이동 버튼 문구, webhook URL과 이벤트를 설정한다.
8. 승인된 별도 점검 창에서 서명 검증, 멱등 재전송, Basic/Standard 상태 복원을 확인한다.

롤백은 코드를 먼저 이전 버전으로 돌린 뒤 접수를 중단한다. 이미 생성된 주문·결제 감사 행은 삭제하지 않는다. forward migration의 테이블을 되돌리는 파괴적 migration은 만들지 않는다.

## 전화번호 매칭 migration 게이트

Supabase CLI v2.102.0은 각 migration 파일 전체를 하나의 implicit transaction으로 실행한다. no-transaction 지시자와 `CREATE INDEX CONCURRENTLY`를 migration 안에서 사용하지 않는다. 따라서 다음 파일 경계를 유지한다.

| 순서 | migration | transaction 범위와 lock 의미 |
|---|---|---|
| 1 | `20260719131000_add_groble_phone_matching.sql` | 사용자 전화번호의 Kakao REST 검증 출처와 DB 검증 시각, 주문의 매칭 정책과 불변 snapshot column, `NOT VALID` check, 정규화 helper와 trigger를 추가한다. 기존 주문만 `legacy_email`로 분류하고, 이후 모든 INSERT는 24시간 이내의 `kakao_rest_api` 검증을 `verified_kakao_phone` snapshot으로 강제한다. 기존 checkout body는 application role에서 실행할 수 없는 내부 이름으로 바꾸고, bounded 상품 검증 후 product lock을 먼저 잡아 그 body로 위임하는 Phase 1 bridge를 설치한다. |
| 2 | `20260719131100_activate_groble_phone_checkout.sql` | checkout RPC와 service-role ACL만 교체한다. 새 RPC는 bounded 입력 검증 뒤 namespaced product lock, user lock 순서로 획득하고, 24시간 이내에 Kakao REST로 검증된 전화번호만 snapshot하며 raw 전화번호나 이메일로 fallback하지 않는다. |
| 3 | `20260719131200_backfill_groble_phone_matching.sql` | 출처가 완전하지 않은 normalized 전화번호를 제거하고 검증된 normalized 중복이 있으면 전체 transaction을 중단한다. legacy raw 전화번호를 승격하거나 주문에 전화번호를 백필하지 않는다. |
| 4 | `20260719131300_validate_groble_phone_matching.sql` | 사용자 provenance와 주문 매칭 snapshot을 포함한 check validation, 3개의 일반 index build만 수행한다. 인덱스의 write-blocking lock을 1번 ACCESS EXCLUSIVE transaction과 분리한다. |
| 5 | `20260719131400_activate_groble_phone_finalization.sql` | 12개 인자 finalizer, 9개 인자 호환 wrapper, refund RPC와 grant만 교체한다. finalizer는 주문의 불변 정책에 따라 검증 전화번호 또는 legacy 이메일만 사용한다. wrapper는 입력 검증 후 payment, namespaced product, 정렬된 user lock 순서로 직렬화하며 user set에 기존 payment ID 주문 owner, 같은 상품의 verified owner, 이메일 후보를 모두 포함한다. |
| 6 | `20260719131500_stop_persisting_groble_buyer_contacts.sql` | 기존 구매자 연락처를 삭제하고 주문·웹훅 이벤트의 호환 컬럼을 old/new writer 모두에서 NULL로 강제하는 `BEFORE INSERT OR UPDATE` fence를 설치한다. 컬럼은 롤링 배포 호환성을 위해 즉시 drop하지 않는다. |

원격에 적용된 head `20260719120000_add_profile_provider_canary_journal.sql` 다음의 일반(ordinary) migration push는 다음 release gate를 모두 통과해야 한다.

이 exact-six 검사는 pre-rollout freeze gate이며 production에서 위 6개 migration이 모두 적용되었다고 확인되기 전까지 유지한다. 기준선 뒤에 다른 migration이 하나라도 merge되면 feature 앞·뒤 위치와 무관하게 drift로 중단한다. 여섯 파일의 production 적용 확인 뒤에만 현행 migration history에 맞게 이 contract와 gate를 reconcile하거나 retire한다.

**2026-07-19 reconcile 완료.** 위 6개 migration이 production에 모두 적용된 것을 읽기 전용 history 비교로 확인했다. 따라서 exact-six freeze는 해제하고, contract는 여섯 파일이 기준선 직후에 표와 같은 순서로 연속해 존재하는지만 고정한다. 기준선 뒤에 추가되는 ordinary migration은 아래 1~8단계 release gate를 그대로 따르는 조건으로 허용한다. 이 reconcile 시점의 적용 head는 `20260719160000_add_landing_leads.sql`이다.

이 reconcile 이후 2026-07-19 hotfix migration 1건이 추가되었다. 아래 1~8단계를 적용할 때는 이 절 마지막의 hotfix 항목을 함께 읽는다.

1. 읽기 전용 확인으로 `npx supabase migration list --linked`를 실행하고 local/remote history를 비교한다.
2. 적용 전 일반 push 미리보기로 `npx supabase db push --dry-run`를 실행한다.
3. dry-run 출력은 정확히 위 6개 migration만 표시하고 예상하지 않은 파일이 없어야 하며, 순서도 표와 일치해야 한다.
4. history drift, 파일 불일치, 추가 파일, 순서 차이가 하나라도 있으면 중단하고 적용하지 않는다.
5. drift가 없고 아래 사전 조회와 0 active writer 조건이 충족된 후, 운영 책임자가 maintenance gate에 명시적 운영 승인을 내려야 한다. 승인 없이는 apply하지 않는다.
6. 승인된 maintenance window에서만 일반 apply 명령 `npx supabase db push`를 실행한다.
7. apply가 완료된 후 DB schema와 RPC signature, service-role ACL을 검증한다.
8. 이 검증이 모두 통과한 다음에만 application을 배포한다.

`--include-all`은 절대 사용하지 않는다. DB migration은 application 배포 전에 먼저 적용한다. migration 적용 후 DB schema, RPC signature, service-role ACL을 검증한 다음 application을 배포한다. 이 개발 작업에서는 승인된 운영 절차를 문서화만 하며 `npx supabase db push`를 실행하지 않는다.

여섯 파일은 모두 `lock_timeout = '5s'`와 `statement_timeout = '2min'`으로 제한한다. 1번이 커밋될 때 기존 주문만 `legacy_email`로 고정되고, 이후 모든 주문 INSERT는 RPC 버전과 무관하게 trigger를 통과한다. INSERT 순간 사용자의 Kakao REST 검증 시각이 24시간을 넘었거나 provenance가 불완전하면 `CHECKOUT_PHONE_REQUIRED`로 중단하며, caller가 제공한 주문 매칭 값을 신뢰하지 않는다. 이전 사용자 writer가 검증 시각 없이 raw 전화번호를 바꾸면 DB trigger가 normalized 값과 provenance를 제거한다. 3번은 legacy raw 전화번호나 기존 주문을 전화번호 후보로 승격하지 않는다. 생성된 주문의 정책, normalized 전화번호, 출처, 검증 시각은 UPDATE할 수 없다. 6번의 별도 fence는 연락처 호환 컬럼에만 INSERT·UPDATE 모두 적용된다.

### 2026-07-19 hotfix: 정규화 helper의 service_role EXECUTE 복구

추가로 적용할 파일은 `20260719170000_restore_groble_phone_normalizer_service_role_execute.sql` 1개다.

위 1번 migration이 `public.users`에 `users_phone_number_provenance_check`를 추가하면서, 같은 파일에서 정규화 helper의 EXECUTE를 `service_role`에서까지 회수했다. CHECK 제약은 SECURITY DEFINER 경계 없이 DML을 실행한 role로 평가되고 Postgres는 이 제약의 OR 분기를 단축 평가하지 않는다. 그 결과 `service_role`의 `public.users` 쓰기가 provider와 전화번호 유무를 가리지 않고 전부 42501로 실패했다. `/auth/callback`의 카카오 프로필 동기화뿐 아니라 `/api/user/me`의 사용자 행 생성·갱신도 함께 막혔고, 얼리버드 Basic 결제의 `CHECKOUT_PHONE_REQUIRED`는 그 2차 증상이다.

위 3번 항목의 "정확히 6개"는 완료된 rollout에 대한 기준이다. 이 hotfix를 적용할 때 dry-run 출력은 위 1개 파일만 표시해야 하며, 그 밖의 파일이 보이면 중단한다. 나머지 단계는 그대로 따른다. 이 파일은 권한 부여 한 줄뿐이라 테이블을 잠그지 않지만 timeout 제한은 동일하게 둔다.

7번 검증은 다음 읽기 전용 조회로 수행한다. 개인정보 값은 조회하지 않는다.

```sql
SELECT pg_catalog.has_function_privilege(
           'service_role', 'public.normalize_kr_mobile_e164(text)', 'EXECUTE'
       ) AS service_role,
       pg_catalog.has_function_privilege(
           'anon', 'public.normalize_kr_mobile_e164(text)', 'EXECUTE'
       ) AS anon,
       pg_catalog.has_function_privilege(
           'authenticated', 'public.normalize_kr_mobile_e164(text)', 'EXECUTE'
       ) AS authenticated;
```

`service_role`은 `true`, `anon`과 `authenticated`는 `false`여야 한다. 하나라도 다르면 배포를 중단한다.

배포 후 확인은 카카오 로그인의 전화번호 저장과 구글 로그인의 사용자 행 생성을 모두 포함한다. 카카오 경로만 확인하면 `/api/user/me` 경로의 회복을 놓친다. 사용자 행 확인은 집계로만 하고 전화번호 원문과 이메일은 조회하거나 로그에 남기지 않는다.

advisory lock의 전역 순서는 rolling wrapper의 `payment -> product -> user ID 오름차순`, checkout과 직접 INSERT trigger 경로의 `product -> user`이다. product key는 모든 경로에서 `earlybird:groble:product:<product_id>`를 같은 방식으로 hash한다. checkout RPC가 INSERT trigger에 진입할 때 같은 transaction의 product lock을 다시 얻는 것은 reentrant이며, service-role 직접 INSERT도 trigger가 snapshot 조회 전에 product lock을 얻으므로 wrapper의 product-wide 판정 사이에 verified 주문을 끼워 넣을 수 없다. canonical 12개 인자 호출은 기존 `payment -> user` 순서를 유지한다. wrapper는 duplicate payment의 기존 주문 owner도 초기 sorted user set에 포함하므로 canonical로 위임할 때 payment와 해당 user lock을 같은 transaction에서 재진입하며, 다른 상품 wrapper와도 user lock 순서가 뒤집히지 않는다.

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

SELECT pid, usename, application_name, state, xact_start, query_start
FROM pg_catalog.pg_stat_activity
WHERE pid <> pg_catalog.pg_backend_pid()
  AND state <> 'idle'
  AND (
      query ILIKE '%create_earlybird_checkout%'
      OR query ILIKE '%INSERT INTO public.earlybird_orders%'
  )
ORDER BY query_start;
```

어느 테이블이든 10,000행 또는 10MB를 넘거나 30초 이상 진행 중인 transaction이 있으면 일반 push를 중단하고 쓰기 트래픽을 제한한 maintenance window에서 다시 검토한다. Phase 1 직전에는 checkout과 직접 order INSERT를 중단하고 두 번째 조회가 0행인지 확인한다. Phase 1의 `ALTER TABLE`/trigger DDL은 이미 `earlybird_orders` relation을 사용 중인 transaction을 drain하고, 새 bridge는 커밋 이후 호출을 product-first 순서로 전환한다. relation lock에 아직 도달하지 않은 pre-Phase-1 호출까지 배제하려면 조회와 migration 사이에도 쓰기 제한을 유지해야 한다. Phase 1 bridge에서 이미 실행 중인 호출이 Phase 2 이후에 재개될 수 있으므로, renamed legacy body는 모든 application role에서 revoke한 채 유지하고 wrapper와 함께 별도 post-drain migration에서만 제거한다. 작은 실측 규모와 0 active writer가 유지되면 `npx supabase migration list --linked`로 순서를 재확인하고 위 release gate의 명시적 운영 승인을 받은 뒤 ordinary apply 단계로 진행한다.

`lock_timeout` 또는 `statement_timeout`으로 특정 파일이 실패하면 그 파일의 transaction은 전체 롤백된다. 자동 반복하거나 migration history를 수동 완료 처리하지 않는다. `migration list --linked`로 완료된 이전 파일과 실패한 파일을 확인하고, 대기 transaction을 제거하거나 maintenance window를 잡은 뒤 미적용 파일부터 재시도한다. `DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW`는 검증된 전화번호가 여러 사용자에게 연결된 상태이므로 재시도 대상이 아니라 계정 소유권 확인 후 데이터를 해결해야 하는 중단 조건이다.

12개 인자 canonical과 9개 인자 wrapper는 모두 bounded 입력 검증을 먼저 수행하고, `NULL`을 포함해 `payment.completed`가 아닌 event type을 duplicate 조회 전에 `GROBLE_PAYMENT_EVIDENCE_INVALID`로 거부한다. wrapper는 그 뒤 payment lock, namespaced product lock, 같은 상품의 미해결 verified owner, 기존 payment ID 주문 owner, 이메일 후보 user lock을 하나의 안정적인 ID 순서로 획득한다. 그 뒤 이미 처리된 event ID 또는 payment ID를 읽기 전용으로 확인하고, 알려진 재전송이면 canonical finalizer의 `duplicate_event` 또는 `duplicate_payment` 경로로 위임한다. 새 이벤트라면 구매자 이메일과 관계없이 같은 상품의 미해결 `verified_kakao_phone` 주문을 product lock 아래에서 다시 확인한다. 하나라도 있으면 webhook event나 idempotency row를 쓰기 전에 `GROBLE_CANONICAL_PHONE_REQUIRED`로 롤백하며, 처리 가능한 `legacy_email` 후보가 없는 경우에도 같은 오류로 중단한다. 새 인스턴스의 12개 인자 canonical 호출이 같은 payment ID로 동시에 들어와도 payment lock에서 먼저 직렬화되므로 user/payment 역순 교착이 없어야 한다. 이전 인스턴스가 모두 drain된 후에도 wrapper와 Phase 1 internal checkout body를 즉시 삭제하지 않고, 호출 현황을 확인한 후 별도 post-drain forward migration으로만 제거한다.

## 결제 확정과 수량 운영

- 성공 화면 진입이나 프론트 숫자로 접수 확정하지 않는다.
- 공식 raw-body HMAC과 ±5분 timestamp를 통과한 `payment.completed`만 접수를 확정하며, `payment.cancel_requested`는 환불 검토 상태로만 전환한다.
- `verified_kakao_phone` 주문의 결제 완료는 checkout 시점의 불변 정규화 전화번호 snapshot으로만 매칭한다. 사용자 프로필 전화번호가 이후 바뀌어도 주문 snapshot은 바뀌지 않으며 이메일로 fallback하지 않는다. 이메일 매칭은 migration 전에 생성된 `legacy_email` 주문에만 허용한다.
- 같은 사용자·상품·금액에 해당하는 미결제 `legacy_email` 취소 주문이 여러 건이면 최신 주문을 임의로 고르지 않고 `ambiguous_buyer`로 격리한다.
- Groble 구매자의 정규화 전화번호와 소문자 이메일은 signed webhook transaction의 전화번호 우선·이메일 fallback 매칭 RPC 입력으로만 일시 처리한다. raw 전화번호·표시 이름은 RPC에 전달하지 않고, 이메일·전화번호·표시 이름을 주문·웹훅 이벤트에 영속 저장하지 않으며 브라우저 응답·Amplitude·Axiom에 전송하지 않는다. 카드 정보와 원본 payload도 저장하지 않는다.
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
