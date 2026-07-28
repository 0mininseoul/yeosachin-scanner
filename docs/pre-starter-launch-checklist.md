# Apify Starter 전환 체크리스트 (역사적·완료된 의사결정 맥락)

기준 기록일: 2026-07-24. 이 문서는 Secondary Apify 계정의 Starter 전환을 검토하던 당시의 read-only gate를 보존한다. Secondary는 이미 Starter이며, automatic fulfillment와 공개 자동 분석은 현재 열려 있다. 따라서 이 문서는 현재 launch gate나 credential 변경 승인서가 아니다. 현재 worker·queue·결제 이행·rollback의 정본은 [Analysis V2 프로덕션 운영 정본](./analysis-v2-production-operations.md)이다.

과거 checklist의 목적은 “통과해도 구독 구매·secret 교체·자동 입장 활성화를 뜻하지 않는다”는 경계를 보존하는 것이었다. 아래 사실은 당시의 판단 근거이며, 역사적 사실을 현재와 다르게 고치지 않는다.

## 당시 확인 항목

### 1. 실제 유료 수요와 책임

당시 gate는 UTC 반개구간에서 다음 report를 실행하도록 요구했다.

```bash
npm run report:earlybird-demand -- \
  --start <YYYY-MM-DD> \
  --end <YYYY-MM-DD>
```

- seller reference와 결제 증거가 함께 확인된 reference-confirmed 실결제 1건 이상이어야 했다.
- 미확인 paid 주문은 0건이어야 했다.
- 기한 초과 이행은 0건이어야 했다.
- 환불 책임 주문은 0건이어야 했다.
- report 종료 코드는 `0`이어야 했다.

checkout 이동, 프론트 이벤트, 수동 연결, test-send, waitlist는 실결제로 세지 않는 조건이었다. 이 문서는 실제 유료 gate가 충족됐거나 특정 결제 증거가 확인됐다고 주장하지 않는다. 특히 독립된 provider 증거가 없는 `payment_pending` 상태는 변경 근거로 삼지 않는다.

### 2. 전환 시점의 정지 확인

credential cutover 직전 같은 read-only snapshot에서 active analysis requests, jobs, provider runs, fulfillment leases가 모두 0인지 확인하는 조건이었다. `pending`, `processing`, `starting`, `running`, 만료되지 않은 lease, `admission_pending`, `retryable_failure`, `analysis_in_progress`가 있으면 cutover를 중단했다. R2 결과 이미지 보존·삭제나 provider cleanup 실패도 선행 복구 대상이었다.

### 3. Gemini 전역 lease

`analysis_v2_gemini_leases`의 Gemini slot 8개가 모두 `available`, `quarantined`가 0개여야 했다. `leased`는 terminal attempt 원장과 대조했고, quarantine은 DB owner의 evidence SHA-256 절차 없이 해제하지 않았다.

### 4. 배포·판매 snapshot

- production migration history와 reviewed branch를 비교하고, dry-run에 예상하지 않은 migration이 없었어야 했다.
- server catalog와 DB checkout RPC의 가격 버전은 `earlybird-2026-07-v2`여야 했다.
- Groble 가격과 재고가 server catalog와 같아야 했다. Basic/Standard는 6,900원/9,900원, 각각 재고 10건, 기준가 13,900원/19,900원, 표시 할인율 50%였고 Plus는 checkout 없이 대기 신청만 유지했다.
- read-only checkout 회귀에서 Basic/Standard 링크와 seller reference를 확인해야 했다.

### 5. 당시 비용 판단

Plus 통제 표본의 provider actual `$3.33835`, Gemini 모델 추정 `$0.5858645`, observed subtotal `$3.9242145`는 `costComplete=false`였다. Gemini usage 1건과 GCP infrastructure가 빠졌고 Basic/Standard p50/p95도 미측정이어서 최종 가격이나 complete cost를 확정하는 자료가 아니었다.

## 현재와의 차이

당시에는 `EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED=false`를 cutover 기본값으로 보았고, 정확히 `true`일 때만 canonical `analysis-worker`가 유효한 paid Basic/Standard `awaiting_operator` 행을 자동 입장시키는 설계였다. 현재 canonical production worker는 automatic fulfillment를 켰고, `analysis-worker-secondary-e2e`는 worker/recovery/tasks/preflight 및 automatic fulfillment를 모두 `false`로 유지한다. webhook이 enqueue-only이고 payment evidence 없는 상태를 임의로 바꾸지 않는 경계는 그대로다.

당시 “Starter 구매 또는 `APIFY_SECONDARY_API_TOKEN` 변경에는 명시적 승인 필요”라는 문구는 이미 끝난 전환의 안전 경계였다. 새로운 credential/secret 변경, 실제 결제 생성, migration 적용, 별도 deployment는 여전히 각각의 정확한 대상과 승인 범위를 요구한다.
