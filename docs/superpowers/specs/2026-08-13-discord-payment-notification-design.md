# Discord 결제 알림 설계

## 목표

Groble 결제가 기존 결제 원장에서 `accepted`로 확정되면, Discord의 결제 알림 스레드에 가입 알림과 유사한 Embed를 자동 전송한다.

알림에는 다음 정보만 포함한다.

- 상품명: `basic`은 `Basic`, `standard`는 `Standard`
- 결제자 이름: 기존 Unicode 안전 마스킹 규칙으로 가운데를 `*` 처리
- 결제일시: KST
- 성별: `users.gender`의 `female`/`male`을 `여성`/`남성`으로 매핑

이메일, 전화번호, 결제 ID, 구매자 원문 연락처는 Embed·로그·outbox에 포함하지 않는다.

## 데이터 흐름

1. Groble 웹훅이 기존 결제 finalizer를 호출한다.
2. finalizer가 주문을 `paid`로 전환하는 같은 DB 트랜잭션에서 `earlybird_payment_discord_outbox`에 `order_id`를 한 번만 적재한다.
3. 웹훅은 finalization disposition이 `accepted`인 경우에만 `after()`로 Discord outbox drain을 예약한다.
4. dispatcher는 DB claim RPC로 pending row를 가져오며, `earlybird_orders`와 `users`에서 Embed에 필요한 안전한 필드만 조회한다.
5. Discord Bot API의 해당 thread message endpoint에 Embed를 POST한다.
6. 성공·429·실패 결과를 claim token으로 outbox에 기록한다. 별도 내부 cron은 즉시 전송되지 않은 pending row와 stale claim을 복구한다.

중복 방지는 `earlybird_payment_discord_outbox.order_id` unique 제약과 DB claim으로 처리한다. `duplicate_event`, `mismatch`, 환불·취소 이벤트는 알림을 만들지 않는다.

## 구성 및 경계

- 새 outbox 테이블과 claim/complete/reconcile RPC를 Supabase migration으로 추가한다.
- 새 서버 모듈은 가입 알림 모듈의 전송 정책과 KST formatter를 재사용하되, 결제 payload와 outbox는 별도로 둔다.
- 기존 `KAKAO_SIGNUP_DISCORD_BOT_TOKEN` 값을 같은 Discord 앱의 서버 전용 Bot token으로 재사용한다. 결제 알림은 별도 토글과 스레드 설정을 사용한다.
- 운영 설정은 `PAYMENT_DISCORD_ENABLED=true`, `PAYMENT_DISCORD_THREAD_ID=1537327100254486611`로 둔다. 토큰 값은 코드·문서·로그에 기록하지 않는다.
- Vercel cron은 내부 인증(`CRON_SECRET`)을 유지하고, dispatcher가 처리할 수 있는 bounded batch만 drain한다.

## v1 → v2 결제금액 claim cutover

v2 migration은 기존 `claim_earlybird_payment_discord_outbox(integer)`를 교체하지
않고 `claim_earlybird_payment_discord_outbox_v2(integer)`를 추가한다. 따라서 이미
배포된 v1 worker가 같은 pending row를 먼저 claim하면 새 결제금액 필드가 없는
알림이 전송될 수 있다. migration과 새 worker 활성화 사이의 경계를 운영자가
실수로 뒤집지 않도록 다음 guard를 사용한다. 이 변수들은 배포 환경에 저장하지
않는 일회성 cutover 확인값이다.

1. v1 worker/cron을 중지하고 in-flight 호출이 끝날 때까지 기다린 뒤, 아래처럼
   `drained` 또는 `disabled`를 명시한다. 먼저 pre-migration gate가 통과해야 한다.

   ```bash
   PAYMENT_DISCORD_OLD_WORKER_STATE=drained \
   PAYMENT_DISCORD_V2_MIGRATION_APPLIED=false \
   PAYMENT_DISCORD_V2_WORKER_ENABLED=false \
   scripts/assert-payment-discord-cutover.sh pre-migration
   ```

2. pre-migration gate가 통과한 뒤에만
   `20260814100000_add_actual_amount_to_payment_discord_claim.sql`을 적용한다.
   적용 전에는 `supabase db push --include-all`을 사용하지 않고, reviewed
   migration allowlist와 dry-run 절차를 따른다.

3. migration 적용과 ACL 확인이 끝난 뒤 새 worker를 배포하고 v2 activation gate를
   실행한다. old worker 상태를 다시 확인하며, v2 활성화 전에 migration 적용값과
   worker enabled 값을 모두 명시한다.

   ```bash
   PAYMENT_DISCORD_OLD_WORKER_STATE=drained \
   PAYMENT_DISCORD_V2_MIGRATION_APPLIED=true \
   PAYMENT_DISCORD_V2_WORKER_ENABLED=true \
   scripts/assert-payment-discord-cutover.sh activate-v2
   ```

`disabled`는 `drained` 대신 사용할 수 있다. v1 RPC는 이 cutover 동안 호환성을
위해 남겨두지만, old worker가 drain/disable 되기 전에는 migration을 적용하거나
v2 worker를 활성화하지 않는다.

## Embed 계약

```text
title: 💳 결제가 완료됐어요!
fields:
  🛍️ 상품명  Basic | Standard
  👤 결제자   김*수
  ⚧ 성별     여성 | 남성 | 미제공
  📅 결제일시 YYYY-MM-DD HH:mm (KST)
allowed_mentions: { parse: [] }
```

이름이 없거나 한 글자면 기존 마스킹 helper의 `미제공`/`*` fallback을 사용한다. Discord 실패 관측에는 수신자 데이터, 주문 식별자, Bot token, Discord 응답 원문을 남기지 않는다.

## 실패 정책

- 설정이 꺼져 있거나 불완전하면 외부 요청 없이 종료하며 outbox는 pending으로 남긴다.
- Discord 2xx는 `sent`로 완료한다.
- 명시적인 429만 bounded `Retry-After`로 최대 3회까지 재시도한다.
- 5xx, timeout, network disconnect는 Discord가 이미 수락했을 가능성이 있으므로 `ambiguous_failed`로 terminal 처리해 중복 전송을 피한다.
- claim·complete·reconcile RPC 오류는 안전한 운영 코드만 로그에 남기고 결제 웹훅 성공 여부에는 영향을 주지 않는다.

## 검증 범위

- Embed가 요구된 4개 필드만 만들고 이메일·전화번호·결제 ID를 포함하지 않는지 검증한다.
- 이름 마스킹과 성별 매핑, KST 표시를 단위 테스트한다.
- `paid` 전환이 outbox를 한 번만 생성하고 다른 상태·중복 이벤트는 생성하지 않는 migration contract/PGlite 테스트를 추가한다.
- `accepted` 웹훅만 drain을 예약하고, duplicate·mismatch·refund·cancel은 예약하지 않는 route 테스트를 추가한다.
- 대상 단위 테스트, 전체 `npm test`, `npm run lint`, `npm run build`를 실행한다.

## 범위 밖

- 기존 랜딩 마케팅 카피 변경
- 이메일·전화번호를 포함한 운영자 알림 확장
- 환불·취소용 별도 Discord 알림
- 새로운 Discord 앱 또는 별도 Bot token 발급
