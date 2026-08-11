# 계정 원장 분리와 paid-ever 상태 설계

- 상태: 2026-08-10 사용자 승인
- 기준일: 2026-08-10
- 범위: Supabase 사용자 원장, E2E 계정 수명주기, 결제 플래그, API 사용자 조회·동기화 경계
- 비범위: Instagram 수집, Groble 상품·가격 변경, 기존 주문 상태 수정, 사용자 삭제

## 1. 결정

1. 사용자 행은 복사하지 않고 현재 `public.users` 물리 테이블을 단일 기준 원장 `public.account_principals`로 rename한다.
2. 운영자가 보는 `public.users`는 `production / active`만 보여주는 읽기 전용 view로 다시 만든다.
3. `public.e2e_users`는 모든 E2E 행과 수명주기를 보여주는 service-role 전용 view로 만든다.
4. 기존 합성 E2E 행은 삭제하지 않고 `retired`로 분류한다. active E2E Auth identity는 Basic/Standard 두 개만 둔다.
5. `is_paid_user`는 검증된 외부 결제의 paid-ever, `has_active_purchase`는 환불되지 않은 현재 주문 접근권으로 분리한다.
6. rename 전 애플리케이션을 안정된 service-only RPC 경계로 옮긴다. 새 코드가 아직 없는 `account_principals`를 먼저 읽는 배포는 하지 않는다.

## 2. 확인된 현재 상태

2026-08-10 원격 DB 읽기 전용 감사 기준이다. 적용 직전에 같은 쿼리로 다시 확인하며 수치가 달라지면 중단한다.

- `public.users` 50행, Supabase Auth 연결 33행, 미연결 17행
- Auth 미연결 17행은 주문과 분석 request를 가진 합성 E2E lineage
- 테스트 흔적이 많은 Auth identity 한 개는 관리자 운영 계정
- `public.users`를 참조하는 FK 11개, 현재 함수 정의 43개
- 애플리케이션의 직접 `from('users')` 호출은 5곳
- 양수 결제 형태를 가진 계정은 19개지만 17개는 합성 E2E, 한 개는 operator, 한 개만 external이다. 19개 모두 현재 `is_paid_user = false`다.

마지막 사실 때문에 `payment_id + paid_at + 양수 금액`만으로 paid-ever를 backfill하면 안 된다.

## 3. 데이터 모델과 조회 표면

### 3.1 기준 원장

`account_principals`에 다음 열을 둔다.

| 열 | 허용값 | 의미 |
|---|---|---|
| `account_class` | `production`, `e2e_test` | 운영 계정과 E2E 계정 분리 |
| `traffic_class` | `external`, `operator`, `e2e_test`, `internal_tester` | 퍼널·매출·관측 분리 |
| `lifecycle` | `active`, `retired` | 로그인·분석 admission 허용 여부 |
| `first_paid_at` | timestamptz nullable | 가장 이른 검증 외부 결제 시각 |

기존 `is_paid_user`는 유지하되 §6의 정의로 한 번 정규화한 뒤 false로 되돌리지 않는다. 모든 열은 CHECK constraint를 갖고, 계정 생성 기본값은 `production / external / active`다.

### 3.2 view와 권한

- `public.users`: `account_class = 'production' AND lifecycle = 'active'`
- `public.e2e_users`: `account_class = 'e2e_test'`; active와 retired를 모두 보여주고 lifecycle로 구분
- `public.account_principals`: 서버 전용 기준 원장

두 view는 `security_invoker = true`, `security_barrier = true`로 만든다. `anon`과 `authenticated`에는 세 relation의 직접 SELECT/DML 권한을 주지 않는다. `service_role`에는 base와 view SELECT, base에 필요한 DML만 부여하고 view DML은 명시적으로 revoke한다. 브라우저는 계속 `/api/user/me`의 제한된 DTO만 받는다.

view는 Supabase Dashboard에서 계정을 구분해 보는 운영 표면이지 인증 경계의 전부가 아니다. API와 admission도 base의 `lifecycle`을 검사한다.

## 4. 무중단에 가까운 전환 순서

### Phase A: 감사와 additive schema

1. remote migration history, schema drift, active request/job를 확인한다.
2. 열·constraint·index와 §5~§6의 service-only 함수 및 감사 원장을 추가한다. 이때 물리 테이블 이름은 아직 `users`다.
3. 현재 함수 정의에서 `public.users`를 참조하는 객체의 이름·인자형·정의 hash, FK OID와 삭제 규칙, trigger·policy·publication 의존성을 기계 생성한 cutover inventory로 고정한다.
4. 기존 `is_paid_user = true` 중 §6의 외부 결제 증거가 없는 행이 하나라도 있으면 자동 정규화하지 않고 migration을 중단한다.

### Phase B: 안정된 RPC bridge

다음 service-only RPC를 먼저 만들고, 내부 구현은 아직 물리 `users`를 사용한다.

- 현재 로그인 계정 조회
- 계정 생성 또는 승인된 프로필 필드 보강
- Kakao 승인 프로필 upsert
- checkout 전화번호 조회
- account classification 조회

현재 직접 호출 5곳을 이 RPC로 바꾼 bridge revision을 배포한다. RPC는 모두 `SECURITY DEFINER SET search_path = ''`, `PUBLIC/anon/authenticated EXECUTE` revoke, `service_role`만 grant한다. 인자와 반환 열은 고정 schema로 검증한다.

bridge revision이 100% serving이고 이전 revision의 요청이 모두 drain됐을 때만 Phase C로 간다. 이후 DB cutover의 rollback 가능한 앱 revision도 이 bridge revision 이상으로 제한한다.

### Phase C: 원자적 rename cutover

한 DB transaction에서 다음을 실행한다.

1. `ALTER TABLE public.users RENAME TO account_principals`
2. bridge RPC 구현을 `account_principals`로 교체
3. cutover inventory에 고정된 현재 함수 43개의 본문을 새 relation 이름으로 교체
4. `users`와 `e2e_users` view 생성, 명시적 REVOKE/GRANT 적용
5. FK의 `confrelid`가 rename 전 relation OID와 같고 11개 삭제 규칙도 같은지 assertion
6. 함수·trigger·policy·publication inventory가 예상 집합과 정확히 같은지 assertion

어느 assertion이나 함수 교체가 실패하면 transaction 전체가 rollback되어 물리 테이블은 `users`로 남는다. 단순 view의 upsert 가능성이나 PostgREST schema 추론에 의존하지 않는다. commit 뒤 PostgREST schema cache를 갱신하고 bridge RPC 계약 테스트를 다시 수행한다.

## 5. 분류와 수명주기

### 5.1 기존 17개 합성 행

일반 SQL migration에 UUID allowlist나 이메일 pattern을 넣지 않는다. 별도 server-only 분류 command가 다음 순서로 실행된다.

1. DB 안에서 Auth 미연결, 주문·request 존재, 그리고 주문과 accepted `payment.completed` webhook의 order/payment/product/amount가 정확히 일치하면서 주문 `payment_id`와 webhook `event_id`/`idempotency_key`/`payment_id`가 모두 bounded `^e2e-[a-z0-9][a-z0-9_-]{0,63}$` marker shape인 후보를 재계산한다. accepted non-marker·mismatch·malformed lineage가 하나라도 있으면 제외한다.
2. 정렬된 후보 집합을 Keychain의 감사 키로 HMAC하고, 같은 방식으로 사전 승인해 Keychain에 저장한 기대 HMAC과 timing-safe 비교한다.
3. 후보 수 17과 HMAC이 모두 맞을 때만 한 transaction에서 `e2e_test / e2e_test / retired`로 변경한다.
4. aggregate count와 command version만 운영 로그에 남기고 식별자·HMAC·이메일은 stdout, 문서, Axiom, shell history에 남기지 않는다.

관리자와 지정 내부 테스터도 command-line 인자가 아니라 Keychain에서 식별자를 직접 읽는 같은 command로 분류한다. 관리자는 `production / operator / active`, 내부 테스터는 `e2e_test / internal_tester / retired`다. 변경 전후 분류는 DB 내부 감사 테이블에 account FK와 reason code로 기록한다.

### 5.2 신규 E2E identity 두 개

1. 운영자 provisioner가 Auth identity를 만들고 자격 증명을 즉시 Keychain에 저장한다. 비밀번호나 UUID를 출력하지 않는다.
2. 자격 증명을 runner에 넘기기 전에 service-only provision 함수로 principal을 `e2e_test / e2e_test / active`로 생성한다.
3. 로그인 callback은 기존 분류를 보존하고, E2E app metadata와 principal 분류가 불일치하면 production으로 생성하지 않고 거절한다.
4. Basic runner는 Basic entitlement만, Standard runner는 Standard entitlement만 받을 수 있게 runner role을 별도 열 또는 E2E registry에 고정한다.

신규 임시 테스트 계정을 추가하지 않는다. 실패한 identity를 폐기해야 하면 먼저 앱 admission을 막고 모든 세션을 무효화한 뒤 `retired`로 바꾼다.

### 5.3 `retired`의 강제 의미

- `retired`는 라벨이 아니라 로그인 후 앱 세션 bootstrap, preflight, checkout, test entitlement, 결과 owner admission을 모두 거절하는 상태다.
- middleware/API의 계정 guard가 매 요청 base lifecycle을 확인한다. 이미 발급된 Auth refresh token이 남아도 앱 권한은 생기지 않는다.
- Auth identity가 있는 retired E2E 계정은 세션을 관리자 경로로 무효화한다. 세션 무효화 실패 시 lifecycle guard가 계속 fail-closed한다.
- 과거 주문·결과의 FK와 감사 이력은 남기되 retired E2E는 외부 KPI와 운영 `users` view에서 제외한다.

## 6. 결제 상태

### 6.1 검증 결제 증거

qualifying payment는 다음을 모두 만족한 주문이다.

1. `earlybird_webhook_events.event_type = 'payment.completed'`
2. 해당 event의 `disposition = 'accepted'`이고 `order_id`가 주문과 일치
3. 주문의 `payment_id`, `paid_at`, `actual_amount_krw > 0`이 event와 일치
4. 계정의 `traffic_class = 'external'`

seller-reference 경로도 최종적으로 같은 accepted event와 주문을 만들므로 별도 느슨한 판정식을 만들지 않는다. `payment_pending`, `payment_failed`, `cancelled`, 0원, accepted event가 없는 수동 상태 변경은 qualifying이 아니다.

기존 `finalize_earlybird_groble_payment*` 함수가 `accepted`를 확정하는 transaction 안에서 하나의 `record_external_paid_ever(order_id, event_id)` helper를 호출한다. 이미 accepted된 event/payment의 정상 duplicate 응답에서도 같은 helper를 멱등 호출해 flag drift를 스스로 복구한다. helper는:

- order/event/account를 재검증한다.
- 주문별 유일한 paid evidence row를 기록한다.
- external이면 `is_paid_user = true`로 올린다.
- `first_paid_at = LEAST(existing, qualifying paid_at)`로 가장 이른 시각을 보존한다.
- operator/E2E/internal-tester이면 evidence는 감사할 수 있지만 paid-ever와 외부 매출에는 반영하지 않는다.

중복 webhook과 reconciliation replay는 order/event unique key로 멱등이다. `is_paid_user`는 false→true만 허용하고, `first_paid_at`은 null→값 또는 더 이른 값으로만 바뀐다.

### 6.2 backfill

account/traffic 분류가 끝난 뒤 accepted event를 정본으로 같은 helper를 재생한다. 기대 assertion은 다음과 같다.

- 합성 E2E 17개와 operator 한 개는 `is_paid_user = false`
- 첫 external 구매자 한 개만 false→true
- 설명되지 않은 기존 true, accepted event 없는 positive order, account 없는 order는 0개

수치가 달라지면 자동 수정하지 않고 중단한다.

### 6.3 `has_active_purchase`

저장 boolean이 아니라 service-only RPC에서 `EXISTS`로 파생한다.

- §6.1의 accepted payment evidence가 있음
- 주문 status가 `paid`, `analysis_in_progress`, `completed` 중 하나
- status가 `refund_pending`, `refunded`, `overflow_refund_required`가 아님

이 서비스는 1회 분석 상품이므로 `completed`도 해당 결과 접근권이 유지되는 active purchase다. 복수 주문 중 하나라도 위 조건을 만족하면 account-level 값은 true다. 결제·결과 권한은 계속 구체적인 order/request lineage로 검사하며 `is_paid_user`만으로 우회하지 않는다.

## 7. 잠금·권한·관측 계약

- 기존 결제 finalizer의 `payment → product → 정렬된 account advisory lock` 순서를 유지하고 paid helper는 그 안에서 account row를 갱신한다.
- 분류 command는 account advisory lock만 취하고 결제·product lock을 역순으로 취하지 않는다.
- service-only 함수는 모두 고정 `search_path`, 명시적 EXECUTE revoke/grant, 대상 account·caller 검증을 갖는다.
- 앱이 내보내는 계정 연결 이벤트는 서버가 당시 `traffic_class`를 snapshot한다. 과거 이벤트를 현재 분류로 덮어쓰지 않는다.
- anonymous 이벤트는 로그인 전 `unknown`이며, 외부 KPI에는 검증된 account lineage가 생긴 이벤트만 포함한다.
- 계정 row가 없거나 분류가 모순되면 주문 상태를 임의 수정하지 않고 transaction을 실패시키고 안전한 오류 코드만 기록한다.

## 8. 테스트와 출시 gate

### 자동 테스트

- bridge 배포 전후 다섯 앱 경로의 조회·insert·profile 보강·전화번호 조회가 동일
- rename transaction 실패 주입 시 relation과 함수 정의가 모두 원상태
- rename 뒤 FK OID/삭제 규칙 11개, 함수 inventory 43개가 기대와 일치
- anon/authenticated의 base/view 직접 SELECT/DML과 함수 EXECUTE가 거절됨
- production active만 `users`, 모든 E2E만 `e2e_users`에 표시되고 view DML이 거절됨
- retired 계정의 기존·신규 세션에서 모든 앱 admission이 거절됨
- 일반 가입이 production, provisioner만 E2E를 만들며 callback이 분류를 덮어쓰지 않음
- accepted payment, duplicate, reconciliation, refund 후 paid-ever, 더 이른 backfill
- pending/failed/0원/unaccepted/operator/E2E/internal-tester가 paid-ever를 올리지 않음
- `has_active_purchase`의 복수 주문·환불 상태 표
- external 퍼널·매출에서 operator/E2E/internal-tester/unknown 제외

### 원격 pass/fail

1. 적용 직전 기준 수치가 §2와 다르면 중단한다.
2. 분류 뒤 `users` view에는 production active만, `e2e_users` active에는 정확히 Basic/Standard 두 행만 있다.
3. 첫 external 구매자만 새 paid-ever true이고 accepted order에 대한 active purchase가 true다. 환불 상태라면 paid-ever만 true여야 한다.
4. 관리자 계정은 operator/active이며 기존 고객 결과를 계속 조회한다.
5. 기존 실제 사용자 표본 로그인·`/api/user/me`·보관함 조회 계약 테스트가 모두 통과한다.
6. remote migration history는 승인 allowlist와 정확히 같고 추가 pending migration을 적용하지 않는다.

## 9. 복구 전략

Phase C 이전에는 앱을 bridge revision으로 rollback할 수 있다. Phase C rename transaction이 commit된 뒤에는 구조를 다시 rename하지 않고 bridge RPC 이름을 유지한 채 fix-forward한다. compatibility `users` view는 보존하되 구 direct-table revision으로 rollback하지 않는다. 분류 오판은 DB 감사 이벤트와 승인 reason을 남기고 해당 행만 교정한다. 사용자 행·주문·결과를 삭제하거나 복사하는 복구는 하지 않는다.

## 10. 기술 근거

- [Supabase: Tables and view security](https://supabase.com/docs/guides/database/tables)
- [Supabase: Securing the Data API](https://supabase.com/docs/guides/api/securing-your-api)
- [PostgreSQL: ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)
- [PostgreSQL: SECURITY DEFINER 함수 보안](https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY)
