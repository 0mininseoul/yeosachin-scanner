# 얼리버드 플랜 잔여 수량 실시간 연동 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **[중요: 폐기된 접근 안내]** 이 계획서는 `remainingSlots`를 preflight ready 확정 시점에
> `planCardsSnapshot`에 영속화하는 접근(아래 Task들)을 지시하고 있으나, 이 접근은 이후
> **폐기(superseded)** 되었다. `analysis_v2_valid_plan_cards_snapshot` 제약
> (`supabase/migrations/20260713142811_add_analysis_v2_preflight.sql:65-72`)이 플랜 카드당
> 정확히 5개 키만 허용하는 화이트리스트라서, `remainingSlots` 컬럼 영속화가 이 제약에
> 반려되었기 때문이다. 대신 `remainingSlots`는 **read time**에 `publicPreflightStatusDto`에서
> 계산되며, preflight 상태 GET 라우트(`app/api/analysis/preflight/[preflightId]/route.ts`)에서
> 주입된다 — 커밋 `918a13f` 기준. 아래 Task 지시는 폐기된 영속화 설계이므로 그대로 따르지 말 것.

**Goal:** preflight가 ready로 확정되는 시점에 `earlybird_plan_inventory`에서 basic/standard 플랜의 실시간 잔여 수량(`remainingSlots`)을 1회 조회해 스냅샷에 실어 영속화하고, `EarlybirdOrderStatusDto`에 플랜 총 한도(`planCapacity`)를 추가해 `earlybird-status.tsx`의 하드코딩된 "10건"을 실데이터로 교체한다.

**Architecture:** `preflight.ts`의 `buildReadyPreflightSnapshot`은 동기 함수로 유지한 채 4번째 파라미터 `remainingSlotsByPlan`을 주입받고, 비동기 DB 조회는 새 헬퍼 `fetchEarlybirdRemainingSlots()`가 담당해 `processPreflight`가 호출 후 결과를 넘긴다. 조회 실패는 빈 맵으로 폴백해 preflight 전체를 실패시키지 않는다. `planCapacity`는 DB를 다시 읽지 않고 `EARLYBIRD_PLAN_CATALOG[planId].serverLimit` 정적 상수를 그대로 노출한다(기존 `PLAN_NAMES` 패턴과 동일). 새 마이그레이션·컬럼·RPC는 추가하지 않는다.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase(supabase-js/service_role), zod, vitest.

## Global Constraints

- 테스트 러너: `npx vitest run <path>` (package.json `test` = `vitest run`).
- **새 마이그레이션·컬럼·RPC 추가 금지.** `earlybird_plan_inventory` 테이블과 `finalize_earlybird_groble_payment` RPC는 이미 정상 동작하므로 손대지 않는다.
- `app/analyze/page.tsx`는 이미 `remainingSlots`를 올바르게 소비하고 있으므로 **수정하지 않는다**.
- `remainingSlots`는 basic/standard에만 적용한다. `plus`는 대상에서 제외한다(키 자체를 생략).
- DB 조회 실패(네트워크 오류, RLS 문제 등)는 preflight 전체를 실패시키지 않고 빈 맵으로 폴백한다.
- 커밋 메시지 말미: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## File Structure

- **Modify** `lib/services/analysis/preflight.ts`: `ReadyPreflightSnapshot` 타입에 `remainingSlots` 추가, 새 헬퍼 `fetchEarlybirdRemainingSlots()` 추가, `buildReadyPreflightSnapshot()`에 4번째 파라미터 추가, `planCardsSnapshot()`에 `remainingSlots` 영속화 추가, `processPreflight()`에 `getRemainingSlots` 의존성 주입 지점과 호출부 추가.
- **Modify** `lib/services/analysis/preflight.test.ts`: 위 변경사항에 대한 단위/통합 테스트 추가.
- **Modify** `lib/services/earlybird/order-status.ts`: `EarlybirdOrderStatusDto`에 `planCapacity` 필드 추가, `loadLatestEarlybirdOrder`가 이를 채우도록 변경.
- **Modify** `lib/services/earlybird/order-status-route.test.ts`: 기존 exact-match 단언에 `planCapacity: 10` 추가(안 하면 필드 추가만으로 기존 테스트가 깨짐).
- **Modify** `app/earlybird/earlybird-status.tsx`: 하드코딩된 "10건"을 `order.planCapacity`로 교체.

---

### Task 1: `buildReadyPreflightSnapshot`이 잔여 수량을 받아 반영하도록 확장

**Files:**
- Modify: `lib/services/analysis/preflight.ts:191-215` (`ReadyPreflightSnapshot` 인터페이스), `lib/services/analysis/preflight.ts:881-938` (`buildReadyPreflightSnapshot`)
- Test: `lib/services/analysis/preflight.test.ts`

**Interfaces:**
- Consumes: 기존 `PlanId`, `PLAN_IDS`, `PreflightCatalogSnapshot`, `readyPreflightSnapshotSchema`(무수정).
- Produces: `ReadyPreflightSnapshot['plans'][number].remainingSlots?: number | null`. `buildReadyPreflightSnapshot(profile, accessMode, catalogSnapshot?, remainingSlotsByPlan?: Partial<Record<PlanId, number>>): ReadyPreflightSnapshot | AnalysisV2ErrorCode` — Task 3이 이 4번째 파라미터를 사용한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`lib/services/analysis/preflight.test.ts`의 `describe('preflight public mapping', ...)` 블록 바로 앞(1019번째 줄, `describe('preflight worker domain', ...)`의 닫는 `});` 다음)에 새 `describe` 블록을 추가한다:

```ts
describe('buildReadyPreflightSnapshot remaining slots', () => {
    it('applies injected remaining slot counts to basic and standard only', () => {
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement',
            undefined,
            { basic: 3, standard: 0, plus: 99 }
        ) as ReadyPreflightSnapshot;

        expect(snapshot.plans.find(plan => plan.planId === 'basic'))
            .toMatchObject({ remainingSlots: 3 });
        expect(snapshot.plans.find(plan => plan.planId === 'standard'))
            .toMatchObject({ remainingSlots: 0 });
        expect(snapshot.plans.find(plan => plan.planId === 'plus'))
            .not.toHaveProperty('remainingSlots');
    });

    it('omits remaining slots entirely when none are supplied', () => {
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement'
        ) as ReadyPreflightSnapshot;

        snapshot.plans.forEach(plan => {
            expect(plan).not.toHaveProperty('remainingSlots');
        });
    });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run lib/services/analysis/preflight.test.ts -t "remaining slot"`
Expected: FAIL — `remainingSlots`가 반영되지 않아 첫 번째 테스트의 `toMatchObject({ remainingSlots: 3 })` 등이 실패한다(4번째 인자를 함수가 아직 받지 않아 무시됨).

- [ ] **Step 3: 타입과 구현 수정**

`lib/services/analysis/preflight.ts:204-213`의 `plans` 배열 원소 타입에 `remainingSlots` 추가:

```ts
    plans: Array<{
        planId: PlanId;
        launchStatus: 'production' | 'test_only' | 'disabled';
        relationshipCapacity: { followers: number; following: number };
        detailedMutualLimit: number;
        selectionState: 'required' | 'available_upgrade' | 'unavailable';
        unavailableReason: 'below_required_plan' | 'launch_gate' | null;
        pricingVersion: string;
        price: PlanQuoteV1['price'];
        remainingSlots?: number | null;
    }>;
```

`lib/services/analysis/preflight.ts:881-938`의 `buildReadyPreflightSnapshot` 전체를 다음으로 교체:

```ts
export function buildReadyPreflightSnapshot(
    profile: InstagramProfile,
    accessMode: PlanAccessMode,
    catalogSnapshot: PreflightCatalogSnapshot = currentPreflightCatalogSnapshot(),
    remainingSlotsByPlan: Partial<Record<PlanId, number>> = {}
): ReadyPreflightSnapshot | AnalysisV2ErrorCode {
    assertProfileCounts(profile);
    const username = profile.username.toLowerCase();
    if (!isInstagramUsername(username)) return 'TARGET_UNSUPPORTED';
    if (profile.isPrivate) return 'TARGET_PRIVATE';

    const counts = {
        followers: profile.followersCount,
        following: profile.followingCount,
    };
    const eligibility = determinePlanEligibility(counts, {
        accessMode,
        catalog: catalogSnapshot.plans,
    });
    if (eligibility.status === 'blocked') {
        return eligibility.reason === 'over_plus_capacity'
            ? 'OVER_PLUS_CAPACITY'
            : 'TARGET_UNSUPPORTED';
    }

    const cards = buildPlanSelectionCards(counts, {
        accessMode,
        catalog: catalogSnapshot.plans,
    });
    return readyPreflightSnapshotSchema.parse({
        target: {
            username,
            fullName: boundedText(profile.fullName, 200),
            bio: boundedText(profile.bio, 2_200),
            profileImageUrl: safeProfileImageUrl(profile.profilePicUrl),
            followersCount: profile.followersCount,
            followingCount: profile.followingCount,
            isPrivate: false,
        },
        accessMode,
        capacityRequiredPlan: eligibility.capacityRequiredPlanId,
        requiredPlan: eligibility.requiredPlanId,
        plans: PLAN_IDS.map((planId, index) => {
            const plan = catalogSnapshot.plans[planId];
            const card = cards[index];
            const remainingSlots = remainingSlotsByPlan[planId];
            return {
                planId,
                launchStatus: card.launchStatus,
                relationshipCapacity: { ...plan.relationshipCapacity },
                detailedMutualLimit: plan.detailedMutualLimit,
                selectionState: card.selectionState,
                unavailableReason: card.unavailableReason,
                pricingVersion: catalogSnapshot.pricingVersion,
                price: { ...catalogSnapshot.prices[planId] },
                ...(planId !== 'plus' && remainingSlots !== undefined ? { remainingSlots } : {}),
            };
        }),
        pricingVersion: catalogSnapshot.pricingVersion,
    }) as ReadyPreflightSnapshot;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run lib/services/analysis/preflight.test.ts -t "remaining slot"`
Expected: PASS (2 tests)

- [ ] **Step 5: 전체 회귀 확인**

Run: `npx vitest run lib/services/analysis/preflight.test.ts`
Expected: PASS — 기존 4곳의 `buildReadyPreflightSnapshot(profile(), 'test_entitlement')` 호출(2개 인자만 사용)은 4번째 파라미터의 기본값 `{}`으로 동작해 그대로 통과한다.

- [ ] **Step 6: 커밋**

```bash
git add lib/services/analysis/preflight.ts lib/services/analysis/preflight.test.ts
git commit -m "$(cat <<'EOF'
feat: let buildReadyPreflightSnapshot accept injected remaining slot counts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `fetchEarlybirdRemainingSlots()` 헬퍼 추가

**Files:**
- Modify: `lib/services/analysis/preflight.ts` (import 블록, `currentPreflightCatalogSnapshot()` 다음인 430번째 줄 이후)
- Test: `lib/services/analysis/preflight.test.ts`

**Interfaces:**
- Consumes: `supabaseAdmin`(`@/lib/supabase/admin`, 이미 import됨), `PAID_EARLYBIRD_PLAN_IDS`(신규 import, `@/lib/domain/earlybird/catalog`).
- Produces: `export async function fetchEarlybirdRemainingSlots(): Promise<Partial<Record<PlanId, number>>>` — Task 3의 `processPreflight` 배선이 이 함수를 기본 구현으로 사용한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`lib/services/analysis/preflight.test.ts` 상단 import 블록(9-22행)의 named import 목록에 `fetchEarlybirdRemainingSlots`를 추가:

```ts
import {
    PREFLIGHT_DATABASE_NAMES,
    PreflightImmutableError,
    PreflightLeaseBusyError,
    buildReadyPreflightSnapshot,
    createSupabasePreflightStore,
    fetchEarlybirdRemainingSlots,
    processPreflight,
    publicPreflightStatusDto,
    trustedPreflightAccessMode,
    type ClaimedPreflight,
    type PreflightCatalogSnapshot,
    type PreflightStore,
    type ReadyPreflightSnapshot,
} from './preflight';
```

같은 파일 상단에 `supabaseAdmin`도 import 추가(1-7행 근처, `vi.mock` 다음):

```ts
import { supabaseAdmin } from '@/lib/supabase/admin';
```

`describe('buildReadyPreflightSnapshot remaining slots', ...)` 블록(Task 1에서 추가) 바로 다음에 새 `describe` 블록을 추가한다:

```ts
describe('fetchEarlybirdRemainingSlots', () => {
    afterEach(() => {
        delete (supabaseAdmin as { from?: unknown }).from;
    });

    it('computes remaining slots from sale_limit minus sold_count', async () => {
        (supabaseAdmin as unknown as { from: ReturnType<typeof vi.fn> }).from = vi.fn(() => ({
            select: vi.fn(() => ({
                in: vi.fn(async () => ({
                    data: [
                        { plan_id: 'basic', sale_limit: 10, sold_count: 7 },
                        { plan_id: 'standard', sale_limit: 10, sold_count: 10 },
                    ],
                    error: null,
                })),
            })),
        }));

        await expect(fetchEarlybirdRemainingSlots()).resolves.toEqual({
            basic: 3,
            standard: 0,
        });
    });

    it('returns an empty map when the query reports an error', async () => {
        (supabaseAdmin as unknown as { from: ReturnType<typeof vi.fn> }).from = vi.fn(() => ({
            select: vi.fn(() => ({
                in: vi.fn(async () => ({ data: null, error: { message: 'boom' } })),
            })),
        }));

        await expect(fetchEarlybirdRemainingSlots()).resolves.toEqual({});
    });

    it('fails open to an empty map when the query throws', async () => {
        (supabaseAdmin as unknown as { from: ReturnType<typeof vi.fn> }).from = vi.fn(() => {
            throw new Error('network down');
        });

        await expect(fetchEarlybirdRemainingSlots()).resolves.toEqual({});
    });

    it('ignores rows with unsafe counts while keeping the rest', async () => {
        (supabaseAdmin as unknown as { from: ReturnType<typeof vi.fn> }).from = vi.fn(() => ({
            select: vi.fn(() => ({
                in: vi.fn(async () => ({
                    data: [
                        { plan_id: 'basic', sale_limit: 10, sold_count: 12 },
                        { plan_id: 'standard', sale_limit: 10, sold_count: Number.NaN },
                    ],
                    error: null,
                })),
            })),
        }));

        await expect(fetchEarlybirdRemainingSlots()).resolves.toEqual({ basic: 0 });
    });

    it('defaults to an empty map when supabaseAdmin has no from method (existing test mock shape)', async () => {
        await expect(fetchEarlybirdRemainingSlots()).resolves.toEqual({});
    });
});
```

주의: 이 테스트 파일은 이미 `vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }))`(7번째 줄)로 모킹되어 있다. `afterEach`에서 `.from`을 지워 각 테스트가 서로 격리되도록 하고, 마지막 테스트는 `.from`이 전혀 없는 원래 모킹 상태(기존 모든 `processPreflight` 테스트가 의존하는 상태)에서도 안전하게 빈 맵을 반환하는지 확인한다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run lib/services/analysis/preflight.test.ts -t "fetchEarlybirdRemainingSlots"`
Expected: FAIL — `fetchEarlybirdRemainingSlots` is not exported from './preflight' (모듈 해석 오류로 전체 스위트가 실패)

- [ ] **Step 3: 구현 작성**

`lib/services/analysis/preflight.ts`의 `@/lib/domain/analysis/plan-catalog` import 블록(18-28행) 바로 다음에 새 import 추가:

```ts
import { PAID_EARLYBIRD_PLAN_IDS } from '@/lib/domain/earlybird/catalog';
```

`lib/services/analysis/preflight.ts:430`(`currentPreflightCatalogSnapshot` 함수의 닫는 `}` 다음) 바로 다음에 새 함수 추가:

```ts
export async function fetchEarlybirdRemainingSlots(): Promise<Partial<Record<PlanId, number>>> {
    try {
        const { data, error } = await supabaseAdmin
            .from('earlybird_plan_inventory')
            .select('plan_id, sale_limit, sold_count')
            .in('plan_id', PAID_EARLYBIRD_PLAN_IDS);
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

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run lib/services/analysis/preflight.test.ts -t "fetchEarlybirdRemainingSlots"`
Expected: PASS (5 tests)

- [ ] **Step 5: 전체 회귀 확인**

Run: `npx vitest run lib/services/analysis/preflight.test.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add lib/services/analysis/preflight.ts lib/services/analysis/preflight.test.ts
git commit -m "$(cat <<'EOF'
feat: add fail-open earlybird remaining slots lookup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `processPreflight` 배선 + `planCardsSnapshot` 영속화

**Files:**
- Modify: `lib/services/analysis/preflight.ts:432-448`(`planCardsSnapshot`), `lib/services/analysis/preflight.ts:1061-1071`(`processPreflight` 시그니처), `lib/services/analysis/preflight.ts:1178-1182`(호출부)
- Test: `lib/services/analysis/preflight.test.ts`

**Interfaces:**
- Consumes: Task 1의 `buildReadyPreflightSnapshot`의 4번째 파라미터, Task 2의 `fetchEarlybirdRemainingSlots`.
- Produces: `processPreflight`의 `dependencies.getRemainingSlots?: typeof fetchEarlybirdRemainingSlots` 주입 지점. `plan_cards_snapshot` DB 컬럼에 `remainingSlots`가 영속화됨.

- [ ] **Step 1: 실패하는 테스트 작성**

`lib/services/analysis/preflight.test.ts`의 `describe('preflight persistence adapter', ...)` 블록 안, "uses fenced completion, blocking, and scalar exclusion RPC contracts" 테스트(304-343행경) 바로 다음에 새 테스트를 추가한다:

```ts
    it('persists remaining slot counts into the plan cards snapshot RPC payload', async () => {
        const rpc = vi.fn(async () => ({ data: true, error: null }));
        const store = createSupabasePreflightStore({
            rpc,
            from: vi.fn() as never,
        });
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement',
            undefined,
            { basic: 4, standard: 0 }
        ) as ReadyPreflightSnapshot;

        await store.finalizeReady(claim(), snapshot);

        expect(rpc).toHaveBeenCalledWith(PREFLIGHT_DATABASE_NAMES.completeRpc, expect.objectContaining({
            p_plan_cards_snapshot: expect.objectContaining({
                basic: expect.objectContaining({ remainingSlots: 4 }),
                standard: expect.objectContaining({ remainingSlots: 0 }),
            }),
        }));
    });
```

`describe('preflight worker domain', ...)` 블록 안, "uses only the self-hosted profile provider without fallback and stores a ready quote" 테스트(610-646행) 바로 다음에 새 테스트를 추가한다:

```ts
    it('fetches remaining slots via the injected dependency and stores them on the ready snapshot', async () => {
        const store = workerStore();
        const getRemainingSlots = vi.fn(async () => ({ basic: 4, standard: 0 }));

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => profile()),
            providerRunStore: providerRunStore(),
            getRemainingSlots,
        })).resolves.toBe('ready');

        expect(getRemainingSlots).toHaveBeenCalledOnce();
        expect(store.finalizeReady).toHaveBeenCalledWith(
            expect.objectContaining({ preflightId, claimToken }),
            expect.objectContaining({
                plans: expect.arrayContaining([
                    expect.objectContaining({ planId: 'basic', remainingSlots: 4 }),
                    expect.objectContaining({ planId: 'standard', remainingSlots: 0 }),
                ]),
            })
        );
    });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run lib/services/analysis/preflight.test.ts -t "remaining slot"`
Expected: FAIL — `p_plan_cards_snapshot`에 `remainingSlots`가 없고, `getRemainingSlots` 의존성이 아직 존재하지 않아 무시됨(스냅샷에 `remainingSlots`가 실리지 않음).

- [ ] **Step 3: 구현 작성**

`lib/services/analysis/preflight.ts:432-448`의 `planCardsSnapshot` 전체를 다음으로 교체:

```ts
function planCardsSnapshot(
    snapshot: ReadyPreflightSnapshot
): Record<PlanId, Omit<
    ReadyPreflightSnapshot['plans'][number],
    'planId' | 'pricingVersion' | 'price'
>> {
    return Object.fromEntries(snapshot.plans.map(plan => [plan.planId, {
        launchStatus: plan.launchStatus,
        relationshipCapacity: plan.relationshipCapacity,
        detailedMutualLimit: plan.detailedMutualLimit,
        selectionState: plan.selectionState,
        unavailableReason: plan.unavailableReason,
        remainingSlots: plan.remainingSlots,
    }])) as Record<PlanId, Omit<
        ReadyPreflightSnapshot['plans'][number],
        'planId' | 'pricingVersion' | 'price'
    >>;
}
```

`lib/services/analysis/preflight.ts:1061-1071`의 `processPreflight` 시그니처에 `getRemainingSlots` 추가:

```ts
export async function processPreflight(
    preflightId: string,
    dependencies: {
        store?: PreflightStore;
        getProfile?: typeof getSelfHostedProfileSummary;
        getFallbackProfile?: typeof getApifyProfileSummary;
        providerRunStore?: PreflightProviderRunStore;
        env?: Record<string, string | undefined>;
        observer?: PreflightProcessObserver;
        getRemainingSlots?: typeof fetchEarlybirdRemainingSlots;
    } = {}
): Promise<'noop' | 'ready' | 'blocked'> {
```

`lib/services/analysis/preflight.ts:1178-1182`의 호출부를 다음으로 교체:

```ts
        const remainingSlotsByPlan = await (
            dependencies.getRemainingSlots ?? fetchEarlybirdRemainingSlots
        )();
        const snapshot = buildReadyPreflightSnapshot(
            profile,
            claim.accessMode,
            claim.catalogSnapshot,
            remainingSlotsByPlan
        );
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run lib/services/analysis/preflight.test.ts -t "remaining slot"`
Expected: PASS (전체 remaining-slot 관련 테스트, Task 1·2·3 합산 8개 이상)

- [ ] **Step 5: 전체 회귀 확인**

Run: `npx vitest run lib/services/analysis/preflight.test.ts`
Expected: PASS — 기존 `processPreflight` 테스트들은 `getRemainingSlots`를 넘기지 않으므로 기본값 `fetchEarlybirdRemainingSlots`가 호출되고, `supabaseAdmin`이 `{}`로 모킹되어 있어 내부 `try/catch`가 빈 맵을 반환해 그대로 통과한다.

- [ ] **Step 6: 커밋**

```bash
git add lib/services/analysis/preflight.ts lib/services/analysis/preflight.test.ts
git commit -m "$(cat <<'EOF'
feat: wire earlybird remaining slots into preflight ready snapshots

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `EarlybirdOrderStatusDto.planCapacity` 추가

**Files:**
- Modify: `lib/services/earlybird/order-status.ts:1-2`(import), `lib/services/earlybird/order-status.ts:52-64`(DTO), `lib/services/earlybird/order-status.ts:111-123`(반환 객체)
- Test: `lib/services/earlybird/order-status-route.test.ts:106-120`

**Interfaces:**
- Consumes: `EARLYBIRD_PLAN_CATALOG`(`@/lib/domain/earlybird/catalog`, 신규 import).
- Produces: `EarlybirdOrderStatusDto.planCapacity: number` — Task 5의 `earlybird-status.tsx`가 이 필드를 사용한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`lib/services/earlybird/order-status-route.test.ts:106-120`의 `toEqual` 객체에 `planCapacity: 10`을 `planName` 다음 줄에 추가:

```ts
        expect(body).toEqual({
            order: {
                orderId: ORDER_ID,
                targetInstagramId: 'target.account',
                planId: 'basic',
                planName: 'Basic',
                planCapacity: 10,
                actualAmountKrw: 14_900,
                acceptedAt: '2026-07-17T12:00:00.000Z',
                dueAt: '2026-07-19T12:00:00.000Z',
                planSequence: 3,
                systemStatus: 'paid',
                displayStatus: '판독 대기',
                resultUrl: null,
            },
        });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run lib/services/earlybird/order-status-route.test.ts -t "filters by owner"`
Expected: FAIL — 실제 응답에 `planCapacity`가 없어 `toEqual` 불일치.

- [ ] **Step 3: 구현 작성**

`lib/services/earlybird/order-status.ts:1-2`를 다음으로 교체:

```ts
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { EARLYBIRD_PLAN_CATALOG } from '@/lib/domain/earlybird/catalog';
```

`lib/services/earlybird/order-status.ts:52-64`의 `EarlybirdOrderStatusDto`를 다음으로 교체:

```ts
export interface EarlybirdOrderStatusDto {
    orderId: string;
    targetInstagramId: string;
    planId: 'basic' | 'standard';
    planName: 'Basic' | 'Standard';
    planCapacity: number;
    actualAmountKrw: number | null;
    acceptedAt: string | null;
    dueAt: string | null;
    planSequence: number | null;
    systemStatus: EarlybirdOrderSystemStatus;
    displayStatus: string;
    resultUrl: string | null;
}
```

`lib/services/earlybird/order-status.ts:111-123`의 반환 객체를 다음으로 교체:

```ts
    return Object.freeze({
        orderId: order.id,
        targetInstagramId: order.target_instagram_id,
        planId: order.plan_id,
        planName: PLAN_NAMES[order.plan_id],
        planCapacity: EARLYBIRD_PLAN_CATALOG[order.plan_id].serverLimit,
        actualAmountKrw: order.actual_amount_krw,
        acceptedAt: order.paid_at,
        dueAt: order.due_at,
        planSequence: order.plan_sequence,
        systemStatus: order.status,
        displayStatus: DISPLAY_STATUS[order.status],
        resultUrl,
    });
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run lib/services/earlybird/order-status-route.test.ts`
Expected: PASS (전체 스위트)

- [ ] **Step 5: 커밋**

```bash
git add lib/services/earlybird/order-status.ts lib/services/earlybird/order-status-route.test.ts
git commit -m "$(cat <<'EOF'
feat: expose plan capacity on the earlybird order status DTO

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `earlybird-status.tsx`의 하드코딩 제거

**Files:**
- Modify: `app/earlybird/earlybird-status.tsx:112-114`

**Interfaces:**
- Consumes: Task 4의 `EarlybirdOrderStatusDto.planCapacity`(이미 `import type { EarlybirdOrderStatusDto } from '@/lib/services/earlybird/order-status';`로 타입이 연결되어 있어 별도 import 변경 불필요).

이 컴포넌트는 프로젝트 전역에 `.test.tsx` 파일이 존재하지 않는 컨벤션(기존 React 컴포넌트에 대한 단위 테스트가 없음)을 따르므로, 새 테스트 파일을 만들지 않고 타입 체크(`npm run build`)로 검증한다.

- [ ] **Step 1: 구현 수정**

`app/earlybird/earlybird-status.tsx:110-115`를 다음으로 교체:

```tsx
                    <DetailRow
                        label="플랜 내 접수 순번"
                        value={order.planSequence === null
                            ? '결제 확인 후 배정'
                            : `${order.planSequence}번째 / ${order.planCapacity}건`}
                    />
```

- [ ] **Step 2: 타입 체크로 검증**

Run: `npm run build`
Expected: 빌드 성공, `order.planCapacity`가 `EarlybirdOrderStatusDto`(Task 4에서 확장됨)의 `number` 필드로 타입 체크를 통과한다.

- [ ] **Step 3: 커밋**

```bash
git add app/earlybird/earlybird-status.tsx
git commit -m "$(cat <<'EOF'
fix: source earlybird plan capacity from the order DTO instead of a hardcoded value

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 최종 통합 검증

**Files:** 없음(검증 전용 태스크)

**Interfaces:**
- Consumes: Task 1-5의 모든 산출물.

- [ ] **Step 1: 전체 관련 테스트 실행**

Run: `npx vitest run lib/services/analysis/preflight.test.ts lib/services/earlybird/order-status-route.test.ts`
Expected: PASS (모든 테스트)

- [ ] **Step 2: 전체 테스트 스위트 실행(회귀 확인)**

Run: `npm run test`
Expected: PASS — 다른 파일(예: `earlybird-pglite.test.ts`, `groble-webhook-route.test.ts` 등)이 이번 변경으로 영향받지 않았는지 확인한다.

- [ ] **Step 3: 타입 체크 및 빌드**

Run: `npm run build`
Expected: 빌드 성공, 타입 오류 없음.

- [ ] **Step 4: 최종 상태 확인**

Run: `git log --oneline -6` 및 `git status --short`
Expected: Task 1-5의 5개 커밋이 순서대로 보이고, working tree가 clean해야 한다.

## Self-Review 체크리스트 (계획 작성자용, 실행 불필요)

- **스펙 커버리지:** 디자인 문서(`docs/superpowers/specs/2026-07-20-earlybird-remaining-slots-design.md`)의 Feature 1(preflight `remainingSlots`)은 Task 1-3, Feature 2(`planCapacity`)는 Task 4-5, 테스트 섹션의 모든 항목은 각 태스크의 Step 1/2에 반영됨. 범위 밖(YAGNI) 항목(새 마이그레이션, `plus` 잔여 수량, 상태 폴링 재조회)은 어떤 태스크에도 포함되지 않음.
- **플레이스홀더 스캔:** 없음 — 모든 스텝에 완전한 코드와 정확한 파일 경로/행 번호가 포함됨.
- **타입 일관성:** `remainingSlotsByPlan`(Task 1 도입) → `fetchEarlybirdRemainingSlots`의 반환 타입(Task 2) → `processPreflight`의 `getRemainingSlots` 의존성 타입(Task 3)까지 `Partial<Record<PlanId, number>>`로 동일하게 유지됨. `planCapacity: number`(Task 4)는 `EARLYBIRD_PLAN_CATALOG[planId].serverLimit`의 리터럴 타입 `10`과 호환됨.
