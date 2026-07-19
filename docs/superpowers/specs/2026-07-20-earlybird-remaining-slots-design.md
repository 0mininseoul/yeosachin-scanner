# 얼리버드 플랜 잔여 수량(선착순 한정) 실시간 연동 — 설계

- 날짜: 2026-07-20
- 브랜치: `feat/earlybird-remaining-slots-realtime` (`main` 기준)

> **[중요: 폐기된 접근 안내]** 이 문서는 `remainingSlots`를 preflight ready 확정 시점에
> `planCardsSnapshot`에 영속화하는 접근을 설계하고 있으나, 이 접근은 이후 **폐기(superseded)**
> 되었다. `analysis_v2_valid_plan_cards_snapshot` 제약
> (`supabase/migrations/20260713142811_add_analysis_v2_preflight.sql:65-72`)이 플랜 카드당
> 정확히 5개 키만 허용하는 화이트리스트라서, `remainingSlots` 컬럼 영속화가 이 제약에
> 반려되었기 때문이다. 대신 `remainingSlots`는 **read time**에 `publicPreflightStatusDto`에서
> 계산되며, preflight 상태 GET 라우트(`app/api/analysis/preflight/[preflightId]/route.ts`)에서
> 주입된다 — 커밋 `918a13f` 기준. 아래 본문은 폐기된 영속화 설계이므로 참고용으로만 남겨둔다.

## 배경 / 현재 동작

`earlybird_plan_inventory`(`plan_id, sale_limit, sold_count`)와
`finalize_earlybird_groble_payment` RPC(`supabase/migrations/20260717140000_add_groble_earlybird_presale.sql`
86-99행, 714-758행)는 결제 확정 시점에 이미 원자적으로 재고를 차감하고 있고, 이 부분은
정상 동작하므로 **수정하지 않는다**.

문제는 그 값을 프런트가 못 받는다는 것:

1. `lib/contracts/analysis-v2.ts:149`의 `planQuoteV1Schema`는 이미 옵셔널
   `remainingSlots: z.number().int().nonnegative().nullable().optional()`을 선언하고 있고,
   `app/analyze/page.tsx:649-656`도 이미 `plan.remainingSlots`가 숫자면
   "🔥 선착순 마감 임박 · N건 남음"을 렌더링하도록 분기되어 있다. 하지만
   `lib/services/analysis/preflight.ts`의 스냅샷 빌더가 이 필드를 채우지 않아 항상
   `undefined`이고, 결과적으로 정적 카피 "얼리버드 선착순 한정"만 항상 노출된다.
2. `app/earlybird/earlybird-status.tsx:114`가 `` `${order.planSequence}번째 / 10건` ``으로
   "10건"을 하드코딩하고 있다. 실제로는 `lib/domain/earlybird/catalog.ts`의
   `serverLimit: 10`과 우연히 일치할 뿐, 실데이터 소스가 아니다.

프런트(`app/analyze/page.tsx`)는 수정하지 않는다 — 서버가 값만 채우면 된다.

## 확정된 결정

- 새 브랜치는 **`main`에서 분기**한다(현재 `fix/accept-groble-discounted-earlybird-payments`
  브랜치의 미병합 커밋 2개와 독립적으로 유지).
- `remainingSlots`는 **preflight가 ready로 확정되는 시점에 1회만 계산해 영속화**한다.
  이후 30분 TTL 동안 상태를 다시 조회해도 재계산하지 않는다(상태 폴링 경로에 새로운 DB
  부하를 추가하지 않기 위함).
- `EarlybirdOrderStatusDto`의 총 한도 필드(`planCapacity`)는 DB를 다시 읽지 않고
  `lib/domain/earlybird/catalog.ts`의 `EARLYBIRD_PLAN_CATALOG[planId].serverLimit` 상수를
  그대로 노출한다. `sale_limit`은 DB CHECK 제약(`earlybird_plan_inventory_limit_check`)으로
  두 플랜 다 `10`으로 고정되어 있어 DB를 다시 읽어도 같은 값이고, 이 필드는 "잔여 수량"이
  아니라 "총 한도"라 실시간성이 필요 없다. `order-status.ts`에 이미 있는 `PLAN_NAMES`
  정적 매핑과 동일한 패턴이다.
- Task 3(제약)에 따라 **새 마이그레이션·컬럼·RPC는 추가하지 않는다**. 두 변경 모두 기존
  테이블/RPC에 대한 읽기 전용 연동이다.

## 대안 검토 (`buildReadyPreflightSnapshot`이 재고를 얻는 방식)

| 접근 | 방식 | 결론 |
|---|---|---|
| **A. 동기 유지 + 주입 파라미터** ✅ | `buildReadyPreflightSnapshot`은 그대로 동기 함수로 두고, 4번째 파라미터로 `remainingSlotsByPlan: Partial<Record<PlanId, number>> = {}`를 추가. DB 조회(비동기)는 호출부인 `processPreflight`가 수행 후 결과를 넘겨준다. | 채택. 기존 `catalogSnapshot: PreflightCatalogSnapshot = currentPreflightCatalogSnapshot()` 주입-기본값 패턴과 동일. `preflight.test.ts`의 기존 4개 동기 호출부가 전혀 수정 없이 통과한다(새 파라미터를 생략하면 `remainingSlots`가 단순히 비어 있는 것으로 처리됨). |
| B. `buildReadyPreflightSnapshot`을 async로 전환 | 함수 내부에서 직접 `supabaseAdmin` 조회 | 기각. 테스트 4곳(`preflight.test.ts`)과 실제 호출부 1곳까지 총 5곳의 호출부를 `await`로 바꿔야 하는데, 이 함수는 순수 계산 함수라는 기존 설계 의도와도 어긋난다. 얻는 이득 없이 블라스트 반경만 커짐. |
| C. `processPreflight`가 스냅샷 생성 후 별도로 `remainingSlots`만 patch | 스냅샷 빌드 → 완료 후 필드만 덧붙임 | 기각. 스키마 파싱(`readyPreflightSnapshotSchema.parse`)을 두 번 하거나 파싱 이후 스키마를 우회해 직접 필드를 꽂아야 해서 오히려 더 복잡하고 타입 안전성이 떨어진다. |

## Feature 1 — `preflight.ts`: `remainingSlots` 계산 및 영속화

### 재고 조회 함수 (신규, `preflight.ts` 내부)

```ts
async function fetchEarlybirdRemainingSlots(): Promise<Partial<Record<PlanId, number>>> {
    try {
        const { data, error } = await supabaseAdmin
            .from('earlybird_plan_inventory')
            .select('plan_id, sale_limit, sold_count')
            .in('plan_id', ['basic', 'standard']);
        if (error || !data) return {};
        return Object.fromEntries(
            data
                .filter((row): row is { plan_id: string; sale_limit: number; sold_count: number } =>
                    (row.plan_id === 'basic' || row.plan_id === 'standard')
                    && Number.isSafeInteger(row.sale_limit)
                    && Number.isSafeInteger(row.sold_count))
                .map(row => [row.plan_id, Math.max(0, row.sale_limit - row.sold_count)])
        );
    } catch {
        return {};
    }
}
```

- 조회 실패(네트워크 오류, RLS 문제 등)는 **preflight 전체를 실패시키지 않고** 빈 맵을 반환한다
  → 해당 플랜들은 `remainingSlots`가 생략되어 프런트가 기존 정적 카피로 폴백한다.
- `processPreflight`(현재 1061행~)에서, 프로필 수집 성공 직후·`buildReadyPreflightSnapshot`
  호출(현재 1178행) **직전**에 `await fetchEarlybirdRemainingSlots()`를 호출해 결과를
  4번째 인자로 전달한다.
  ```ts
  const remainingSlotsByPlan = await (dependencies.getRemainingSlots
      ?? fetchEarlybirdRemainingSlots)();
  const snapshot = buildReadyPreflightSnapshot(
      profile,
      claim.accessMode,
      claim.catalogSnapshot,
      remainingSlotsByPlan
  );
  ```
  `dependencies.getRemainingSlots`는 기존 `getProfile`/`getFallbackProfile`과 같은 방식의
  테스트용 주입 포인트로 추가한다(선택적, 기본은 실제 구현). 기존 테스트들은
  `supabaseAdmin`을 `{}`로 모킹하고 있어(`preflight.test.ts:7`) 이 파라미터를 넘기지 않아도
  `fetchEarlybirdRemainingSlots`의 내부 `try/catch`가 `TypeError`를 삼키고 빈 맵을 반환하므로
  **기존 테스트는 수정 없이 그대로 통과**한다.

### 타입/스키마

- `ReadyPreflightSnapshot['plans'][number]`(191-215행)에 `remainingSlots?: number | null;` 추가.
- `readyPreflightSnapshotSchema`(217-232행)는 이미 `planQuoteV1Schema`를 배열로 쓰고 있고
  그 스키마가 `remainingSlots`를 옵셔널로 지원하므로 **수정 불필요**.

### `buildReadyPreflightSnapshot`(881행~)

- 시그니처에 4번째 파라미터 `remainingSlotsByPlan: Partial<Record<PlanId, number>> = {}` 추가.
- `plans: PLAN_IDS.map(...)`(922-935행) 블록에서, `planId`가 `'basic'` 또는 `'standard'`이고
  `remainingSlotsByPlan[planId]`가 숫자일 때만 `remainingSlots` 키를 포함한다(`plus`는
  대상에서 제외, 키 자체를 생략).

### 영속화 — `planCardsSnapshot()`(432-448행)

현재 5개 필드만 보존하는 allowlist에 `remainingSlots`를 추가한다:

```ts
function planCardsSnapshot(snapshot: ReadyPreflightSnapshot) {
    return Object.fromEntries(snapshot.plans.map(plan => [plan.planId, {
        launchStatus: plan.launchStatus,
        relationshipCapacity: plan.relationshipCapacity,
        detailedMutualLimit: plan.detailedMutualLimit,
        selectionState: plan.selectionState,
        unavailableReason: plan.unavailableReason,
        remainingSlots: plan.remainingSlots,
    }]));
}
```

이 함수가 `finalizeReady` 경로에서 `plan_cards_snapshot` 컬럼에 쓰일 값을 만들기 때문에,
여기에 추가하지 않으면 DB 왕복 후 값이 사라진다. `readySnapshotFromColumns`(533-583행)는
이미 `{ planId, ...card, pricingVersion, price }`로 카드를 그대로 스프레드하므로 별도 수정
없이 `remainingSlots`가 자동으로 복원된다.

## Feature 2 — `EarlybirdOrderStatusDto.planCapacity`

### `lib/services/earlybird/order-status.ts`

- `EarlybirdOrderStatusDto`(52-64행)에 `planCapacity: number;` 필드 추가.
- `loadLatestEarlybirdOrder`의 반환 객체(111-123행)에서
  `planCapacity: EARLYBIRD_PLAN_CATALOG[order.plan_id].serverLimit` 추가(catalog.ts에서
  `EARLYBIRD_PLAN_CATALOG` import). `EARLYBIRD_PLAN_CATALOG`는 `satisfies`로 선언되어 각
  플랜의 리터럴 타입이 그대로 유지되므로(`basic`/`standard`는 `serverLimit: 10`), `order.plan_id`가
  이미 `'basic' | 'standard'`로 좁혀져 있는 것과 맞물려 `.serverLimit`은 캐스팅 없이 바로
  `number`(리터럴 `10`)로 타입이 맞는다.

### `app/earlybird/earlybird-status.tsx`

- 114행의 `` `${order.planSequence}번째 / 10건` ``을
  `` `${order.planSequence}번째 / ${order.planCapacity}건` ``으로 교체.

## 테스트

- `lib/services/analysis/preflight.test.ts`:
  - `fetchEarlybirdRemainingSlots`(또는 동등 헬퍼)의 정상/부분 조회/에러 케이스.
  - `buildReadyPreflightSnapshot`에 `remainingSlotsByPlan`을 넘겼을 때 basic/standard에만
    반영되고 `plus`는 생략되는지.
  - `processPreflight`가 `getRemainingSlots` 주입을 통해 최종 `finalizeReady` 스냅샷에
    `remainingSlots`가 실려 있는지(영속화 왕복 포함, `planCardsSnapshot`/
    `readySnapshotFromColumns` 경로).
  - 기존 테스트들은 수정 없이 그대로 통과해야 한다(회귀 확인).
- `lib/services/earlybird/order-status-route.test.ts`:
  - 95-122행의 `toEqual` 전수 비교에 `planCapacity: 10`을 추가해야 한다(안 하면 새 필드
    추가만으로 기존 테스트가 깨짐).
- `npm run build`로 타입 체크.

## 범위 밖 (YAGNI)

- Groble 자체 대시보드 재고(앱 DB와 별도로 수기 관리) — 이번 작업과 무관.
- `earlybird_plan_inventory`/`finalize_earlybird_groble_payment` 수정 — 이미 정상 동작, 손대지 않음.
- 새 마이그레이션·컬럼·RPC 추가.
- 상태 폴링 시점의 재고 재조회(라이브 리프레시) — ready 시점 1회 계산으로 확정.
- `plus` 플랜의 재고/잔여 수량 개념 — waitlist 전용이라 해당 없음.
