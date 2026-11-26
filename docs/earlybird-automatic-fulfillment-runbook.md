# Earlybird automatic fulfillment

The production source of truth is [Analysis V2 production operations](./analysis-v2-production-operations.md). This runbook defines the narrower payment-to-analysis admission and rollback boundary.

## Launch contract

Automatic fulfillment is admitted by the signed Groble `payment.completed` webhook, not by a historical database sweep.

- `EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED` is a Vercel-only kill switch. Missing or `false` preserves concierge handling.
- When the switch is `true`, `EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE` must be a fixed RFC3339 instant. Only a payment whose signed `paidAt` is at or after that instant is eligible.
- An eligible order is finalized first, bound durably to the `secondary` Apify credential slot, and then admitted. Request creation remains in the existing fulfillment advance/recovery path.
- Signed payments before the cutoff are still finalized and notified, but remain `awaiting_operator` for concierge handling.
- Duplicate webhook deliveries apply the same original `paidAt` cutoff. They cannot make an older payment newly eligible.

The canonical Cloud Run worker must use:

```dotenv
EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED=false
ANALYSIS_V2_RECOVERY_ENABLED=true
```

The first setting prevents the independent recovery sweep from admitting historical `awaiting_operator` rows outside the webhook cutoff. Recovery remains enabled so webhook-admitted `admission_pending` and `retryable_failure` rows continue to drain.

Manual concierge fulfillment remains available throughout. Its operator-selected immutable token slot is not rewritten by the webhook path.

## 결제 후 동시 분석 한도

서명된 실제 결제에 자리를 배정한 뒤에는 유효한 사전 확인이 끝나는 즉시 같은 주문의 정식 분석을 접수한다. 워커가 결과를 확정하면 해당 주문과 이행을 함께 완료해 소유자가 결과와 이미지를 열 수 있다. 이 두 처리는 각각 `20261126100002`, `20261126100003` 마이그레이션에 있다. 5분 복구는 중단된 인계를 이어서 처리한다. 사전 확인의 2분 유효기간과 기존 환불·결과 공개 검사는 동일하게 적용된다.

`20261126100000_add_paid_analysis_capacity_queue.sql`을 먼저 적용하고 웹과 워커를 배포한다. 최초 `paid_analysis_capacity_policy.max_active`은 NULL이다. 이 상태에서는 기존 자동 접수가 계속된다. 실제 부하 검사에서 확인한 최대 동시 사용자 수와 검증 기록 위치를 같은 UPDATE에 지정하면 Basic·Standard에 공통 한도가 적용된다. 두 플랜의 예상 시간은 처음에 모두 NULL이다. Basic에서 검증한 시간은 `expected_basic_max_minutes`에, Standard에서 검증한 시간은 `expected_standard_max_minutes`에 분 단위로 설정한다. 한 플랜만 검증했다면 그 플랜에만 값을 설정한다.

만석이어도 결제와 주문은 확정한다. 웹훅이 승인한 주문은 DB에 남고, 복구 워커가 자리가 생기면 결제 시각 순서로 진행한다. 대기 중에는 새 프로필 조회, 공급자 비용 예약, 분석 횟수 차감이 없다. 분석 시간의 시작은 서버가 실행을 인수한 `earlybird_fulfillments.capacity_first_started_at`이다. 주문이 처음 시작된 순간의 플랜별 예상 시간이 고정된다. 대기 중인 주문에는 시간이 표시되지 않는다.

한도를 줄여도 실행 중인 분석은 계속된다. 대기 없는 정책으로 롤백하려면 `max_active`를 NULL로 되돌린다. 나중에 다시 활성화할 때는 두 플랜의 예상 시간 설정을 다시 확인한다. 기존 대기 건은 복구 워커가 이어받으므로 주문이나 결제 상태를 변경할 필요가 없다.

## 결과 이메일

`20261126100001_add_paid_result_email_outbox.sql`을 적용한 뒤 운영 유료 워커에 승인된 Resend 키의 Secret Manager 버전과 확인된 발신 주소를 연결한다. 워커와 배포 매니페스트에 `RESEND_API_KEY`·`RESEND_FROM_EMAIL` 바인딩을 반영한다. 활성화 시각부터 완료되는 결과에만 메일을 보내려면 첫 발송 전에 `paid_result_email_rollout.starts_at`을 실제 활성화 시각으로 지정한다.

운영 유료 워커에서 `PAID_RESULT_EMAIL_ENABLED=true`로 복구 작업이 정상 동작하는지 확인한 뒤 운영 웹에 같은 플래그를 설정한다. 로그인·결제 소유자·검증된 수신자가 일치하는 대기 화면에 이메일 안내가 표시된다. 이미 보낸 메일과 전송 여부가 불확실한 시도는 원장에 보존한다. Dev에서는 발송을 끈다.

## 운영 Standard 슬롯

`supabase/operations/20261126_expand_paid_standard_vertex.sql`은 별도 운영 전환 작업이다. 배포 대상의 기존 함수·권한·임대 상태가 맞는지 확인하고 검증한 시점에 적용한다. `analysis-paid-worker`의 `PAID_STANDARD_VERTEX_CAPACITY_MODE=expanded128`이 활성화된 경우 결제와 소유권을 확인한 Standard만 확대 풀을 사용한다. 복구 시에는 새 워커 설정을 우선 끄고 진행 중인 시도와 정산을 마친다. 기존 비용·슬롯 원장을 보존한다.

## Token boundary

- New preflights select deterministically from `primary`, `quinary`, and `senary` through `PREFLIGHT_APIFY_API_TOKEN_SLOTS=primary,quinary,senary`.
- Existing preflight provider runs always resume their stored slot, including historical `tenth` rows.
- Formal paid `apify_v1` work uses the order-scoped `secondary` slot. It does not rotate or fall back to a preflight credential.
- Keep existing secret references while durable old runs can still reference them. A token being excluded from new selection is not permission to delete its secret.

## Rollout

1. Deploy the database migration before application or worker code that calls its new RPC.
2. Deploy Vercel with webhook auto-admission disabled.
3. Deploy the canonical worker with recovery enabled, historical automatic admission disabled, and the exact preflight token pool configured.
4. Confirm the request, job, provider-run, fulfillment, and task queues are quiescent twice before opening the gate.
5. Set a fixed future cutoff, enable webhook auto-admission, and use the first post-cutoff payment as the canary.
6. Verify that the order is bound to `secondary`, produces exactly one V2 request and bootstrap job, reaches a published result, and retains the recent-mutual badge metadata.

Do not move the cutoff backward during the rollout. Do not change paid-order state as a deployment control.

## Rollback

Set `EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED=false` in Vercel. This immediately returns new payments to concierge handling without closing checkout or changing payment finalization.

Keep `ANALYSIS_V2_RECOVERY_ENABLED=true` until already admitted work drains. If the worker itself is unsafe, disable only the worker/dispatch gate after recording aggregate queue state; do not mutate payment status or delete provider-run evidence.

After rollback, verify that no new post-disable fulfillment moved from `awaiting_operator`, while existing durable admissions either completed or remain recoverable.
