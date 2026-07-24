# Apify Starter 전환 직전 체크리스트

기준일: 2026-07-24. 이 문서는 수요 검증 후 Apify Secondary 계정의 Starter 전환을 검토하기 위한 읽기 전용 gate다. 모든 항목을 통과해도 구독을 구매하거나 secret을 변경·교체하거나 자동 출시한다는 의미가 아니다.

## 1. 실제 유료 수요와 책임

아래 보고서를 UTC 반개구간으로 실행한다.

```bash
npm run report:earlybird-demand -- \
  --start <YYYY-MM-DD> \
  --end <YYYY-MM-DD>
```

- seller reference와 결제 증거가 함께 확인된 reference-confirmed 실결제 1건 이상
- 미확인 paid 주문 0건
- 기한 초과 이행 0건
- 환불 책임 주문 0건
- 보고서 종료 코드 `0`

checkout 이동, 프론트 이벤트, 수동 연결, test-send, waitlist는 실결제로 세지 않는다.
실결제 1건은 Starter 검토를 시작할 최소 수요 신호일 뿐 충분한 단위경제 증명이 아니다.

## 2. 이행과 과금 작업의 정지 상태

credential cutover 직전 같은 읽기 snapshot에서 active analysis requests, jobs, provider runs, fulfillment leases가 모두 0인지 확인한다. `pending`, `processing`,
`starting`, `running`, 만료되지 않은 lease가 하나라도 있으면 전환을 중단한다.

- `earlybird_fulfillments.awaiting_operator`는 자동 실행하지 않는다.
- `admission_pending`, `retryable_failure`, `analysis_in_progress`는 모두 해결한다.
- 미정산 provider actual이나 `costComplete=false` 요청을 0원으로 취급하지 않는다.
- R2 결과 이미지 보존·삭제 작업과 provider cleanup이 실패 중이면 먼저 복구한다.

## 3. Gemini 전역 lease

`analysis_v2_gemini_leases`의 Gemini slot 8개가 모두 `available`이어야 하고
`quarantined`는 0개여야 한다. `leased`가 있으면 worker 종료와 terminal attempt
원장을 대조한다. 격리 slot은 evidence SHA-256 hash를 남기는 DB owner 절차 없이
해제하지 않는다.

## 4. 배포와 판매 설정 일치

- production migration history가 reviewed branch와 정확히 일치해야 한다.
- `supabase db push --linked --dry-run`에 예상하지 않은 migration이 없어야 한다.
- 배포 SHA와 검토 SHA가 같고 CI·preview 검증이 통과해야 한다.
- Groble Basic/Standard 가격과 재고가 server catalog의 결제액·각 10건과 같아야 한다.
- Plus checkout은 없고 대기 신청만 유지해야 한다.
- public automatic analysis admission과 webhook 자동 fulfillment는 비활성 상태여야 한다.

## 5. 비용 판정

현재 Plus 통제 표본의 provider actual `$3.33835`, Gemini 모델 추정
`$0.5858645`, observed subtotal `$3.9242145`는 `costComplete=false`다. Gemini usage
1건과 GCP infrastructure가 빠져 있고 Basic/Standard p50/p95도 미측정이므로 최종 정가를
확정하는 자료로 사용하지 않는다.

Starter 전환 후에는 같은 Secondary 계정의 plan, 월 한도, concurrency를 읽기 전용으로
재확인하고 승인된 판매 출시 E2E를 별도로 수행한다.

## 6. 마지막 승인 경계

위 항목을 모두 확인한 뒤에도 Starter 구독 구매 또는 `APIFY_SECONDARY_API_TOKEN` 변경 직전에 소유자의 별도 명시적 승인을 다시 받아야 한다. 그 승인은 다음을 자동으로 포함하지 않는다.

- 실제 고객 결제 생성
- provider token 또는 Secret Manager version 교체
- production migration 적용이나 애플리케이션 배포
- public automatic launch
- Plus 판매 활성화

각 변경은 정확한 대상과 SHA를 제시하고 별도 승인 범위로 실행한다.
