# Bounded Preflight Fallback UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Play the precheckout graph once, expose parent/B-lite readiness as bounded client/API states, and make fallback plans/retry actions explicit and idempotent.

**Architecture:** Keep the accepted preflight and B-lite status read as the single request binding. Stop the SVG player after its 20,000ms pass, render a static delayed surface for non-terminal work, and use sanitized ready-parent `unavailable`/`failed` outcomes for the existing plans CTA while only parent `terminal`/`expired` outcomes enable an explicit-new-preflight CTA. Extend the closed analytics vocabulary without changing provider, worker, payment, database, or landing-page code.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Vitest/jsdom, Supabase-owned preflight status and existing B-lite terminal store.

---

## Scope guard and existing contracts

- In scope: `components/precheckout-stage-graphs.tsx`, `components/precheckout-demo.tsx`, `components/preflight-pending-status.tsx`, `components/precheckout-immersive.tsx`, `app/api/analysis/precheckout-blite/route.ts`, `lib/services/precheckout/blite-status-contract.ts`, `lib/services/precheckout/blite-page-flow.ts`, `lib/services/analytics.ts`, `app/analyze/page.tsx`, and their focused tests.
- Out of scope: `app/page.tsx`, Supabase migrations, B-lite worker/provider code, payment/order code, deployment scripts, and production data.
- The status route must keep the existing fail-open `204` response for malformed/unauthorized ownership reads. A valid owned ready parent with no B-lite cache row returns an explicit sanitized `unavailable` body.
- The existing preflight hook remains the only submission owner. Terminal/expired retry clears its previous idempotency lifecycle and calls `startPreflight` only from a click callback.

## TDD evidence rule

For every behavior below, perform the listed RED step before changing the production file, capture the failing test name and assertion in the commit/worker handoff, then implement the smallest GREEN change and run the named regression suite. Do not keep a production change that was written before its corresponding failing test.

### Task 1: Stop the graph after one initial pass and add a static delayed surface

**Files:**
- Modify: `components/precheckout-stage-graphs.tsx`
- Modify: `components/precheckout-demo.tsx`
- Modify: `components/preflight-pending-status.tsx`
- Test: `components/precheckout-demo.test.tsx`
- Test: `components/precheckout-immersive.test.tsx`
- Test: `lib/services/analysis/preflight-pending-status.test.ts`

- [ ] **Step 1: Write the failing one-pass graph test.**

In `components/precheckout-demo.test.tsx`, replace the waiting-loop expectation with a single-boundary contract. Render `PrecheckoutDemo` in waiting mode with `finishRequested={false}` and an `onInitialPassComplete` spy. Advance exactly `PRECHECKOUT_DEMO_DURATION_MS`; assert the spy was called once, `onComplete` was not called, and the player has not scheduled a later stage transition. Advance another 24,000ms; assert the initial-boundary spy is still called once and no waiting-copy cycle has changed.

```tsx
it('reports the initial pass once and never loops the graph after 20 seconds', async () => {
    const onInitialPassComplete = vi.fn();
    const onComplete = vi.fn();
    await act(async () => {
        root.render(createElement(PrecheckoutDemo, {
            mode: 'waiting',
            startedAtMs: 0,
            finishRequested: false,
            onInitialPassComplete,
            onComplete,
            onError: vi.fn(),
        }));
    });

    await advanceTimersBy(DEMO_DURATION_MS);
    expect(onInitialPassComplete).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    expect(container.querySelector('[data-precheckout-demo-phase="waiting"]')).not.toBeNull();

    await advanceTimersBy(24_000);
    expect(onInitialPassComplete).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-precheckout-progress]')).toBeNull();
});
```

- [ ] **Step 2: Run the graph test and record RED.**

Run:

```bash
npx vitest run components/precheckout-demo.test.tsx -t "reports the initial pass once and never loops"
```

Expected RED: TypeScript/test failure because `onInitialPassComplete` is not yet an accepted prop and the current waiting mode changes to a looping phase instead of reporting the initial boundary.

- [ ] **Step 3: Write the failing static delayed component test.**

In `lib/services/analysis/preflight-pending-status.test.ts`, import `PrecheckoutDelayedStatus` and assert its static markup contains a bounded state marker and explicit copy but no `anim-indeterminate`, `anim-blink`, `setTimeout`, or retry/plans button.

```tsx
it('renders a static parent-pending state without an indefinite spinner or CTA', () => {
    const markup = renderToStaticMarkup(createElement(PrecheckoutDelayedStatus, {
        targetInstagramId: 'target',
        parentState: 'pending',
    }));

    expect(markup).toContain('data-precheckout-delayed-state="parent_pending"');
    expect(markup).toContain('확인이 조금 더 필요해요');
    expect(markup).not.toContain('anim-indeterminate');
    expect(markup).not.toContain('anim-blink');
    expect(markup).not.toContain('<button');
});
```

- [ ] **Step 4: Run the static-state test and record RED.**

Run:

```bash
npx vitest run lib/services/analysis/preflight-pending-status.test.ts -t "static parent-pending"
```

Expected RED: import/export failure because `PrecheckoutDelayedStatus` does not yet exist.

- [ ] **Step 5: Implement the smallest one-pass player change.**

In `components/precheckout-stage-graphs.tsx`, keep the four `4_500ms` stage durations and `REVEAL_MS = 2_000`, but remove the `continueAfterFirstPassRef` slow-loop branch and keep the animation-frame condition `elapsed < TOTAL_MS`. Leave SVG artwork, stage labels, rail progression, reduced-motion behavior, and error handling unchanged.

In `components/precheckout-demo.tsx`, add this prop and one guarded callback:

```ts
onInitialPassComplete?: () => void;
```

Use a `initialPassReportedRef` and invoke the callback at `startedAt + PRECHECKOUT_DEMO_DURATION_MS` in waiting mode. Waiting mode must not schedule rotating copy or call `onComplete` unless an explicit completion request was made before the boundary. Keep `onComplete` exactly-once and preserve the existing absolute `startedAtMs` clock. Remove `nextTransitionAt`, `PRECHECKOUT_WAIT_STAGE_DURATION_MS`, and `WAITING_PROGRESS_COPY` only after the focused tests no longer reference the old loop.

In `components/preflight-pending-status.tsx`, keep `PreflightPendingStatus` unchanged for the legacy surface and add a pure `PrecheckoutDelayedStatus` with `role="status"`, `aria-live="polite"`, `data-precheckout-delayed-state`, and no timers, button, or animated loading classes. Use the fixed copy `확인이 조금 더 필요해요` and a static request-status supporting message.

- [ ] **Step 6: Run the Task 1 focused tests to GREEN.**

Run:

```bash
npx vitest run components/precheckout-demo.test.tsx lib/services/analysis/preflight-pending-status.test.ts
```

Expected: all one-pass, strict-mode, reduced-motion, body-overflow, and existing legacy pending-status tests pass. Update only tests whose assertions describe the removed waiting loop; keep the 20,000ms initial contract exact.

- [ ] **Step 7: Commit the one-pass/static surface change.**

```bash
git add components/precheckout-stage-graphs.tsx components/precheckout-demo.tsx components/preflight-pending-status.tsx components/precheckout-demo.test.tsx lib/services/analysis/preflight-pending-status.test.ts
git commit -m "fix: stop precheckout graph after one pass"
```

### Task 2: Expose parent-pending, unavailable, and expired API states

**Files:**
- Modify: `lib/services/precheckout/blite-status-contract.ts`
- Modify: `app/api/analysis/precheckout-blite/route.ts`
- Test: `app/api/analysis/precheckout-blite/route.test.ts`
- Test: `lib/services/precheckout/blite-status-contract.test.ts` (create)

- [ ] **Step 1: Write the failing status-contract tests.**

Create `lib/services/precheckout/blite-status-contract.test.ts` with finite-state tests for `parent_pending`, `unavailable`, `terminal`, and `expired`, including rejection of an unbounded retry delay and unknown state. Keep existing `pending`, `complete`, and `failed` serialization tests unchanged.

```ts
it('accepts only bounded parent-pending and terminal browser states', () => {
    expect(bliteBrowserStatusV1Schema.parse({
        state: 'parent_pending',
        parentState: 'processing',
        retryAfterMs: 1_000,
    })).toEqual({
        state: 'parent_pending',
        parentState: 'processing',
        retryAfterMs: 1_000,
    });
    expect(bliteBrowserStatusV1Schema.parse({ state: 'unavailable' })).toEqual({ state: 'unavailable' });
    expect(bliteBrowserStatusV1Schema.parse({ state: 'terminal' })).toEqual({ state: 'terminal' });
    expect(bliteBrowserStatusV1Schema.parse({ state: 'expired' })).toEqual({ state: 'expired' });
    expect(() => bliteBrowserStatusV1Schema.parse({
        state: 'parent_pending', parentState: 'pending', retryAfterMs: 60_000,
    })).toThrow();
});
```

- [ ] **Step 2: Run the contract test and record RED.**

Run:

```bash
npx vitest run lib/services/precheckout/blite-status-contract.test.ts -t "bounded parent-pending"
```

Expected RED: missing `bliteBrowserStatusV1Schema` export.

- [ ] **Step 3: Write the failing route tests.**

In `app/api/analysis/precheckout-blite/route.test.ts`, add tests that set `findForOwner` to a stored `pending` row and expect `202` with `state: parent_pending`, set a stored ready row plus `readStatus(null)` and expect `200` with `state: unavailable`, and set an expired row and expect `410` with `state: expired`. Assert terminal B-lite failure remains a `200` `failed` response and that no provider/store method other than the existing status read is called.

```ts
it('distinguishes a pending parent before reading B-lite', async () => {
    mocks.findForOwner.mockResolvedValue({ ...ready(), status: 'pending' });
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
        state: 'parent_pending',
        parentState: 'pending',
        retryAfterMs: 1_000,
    });
    expect(mocks.readStatus).not.toHaveBeenCalled();
});
```

Add the ordering regression explicitly: a pending row whose `expiresAt` is in the
past must return `410` `{ state: 'expired' }` without calling `readStatus`, while a
pending row with a malformed `expiresAt` fails open as `204` without calling
`readStatus`. These assertions must run before the pending-parent branch is changed.

- [ ] **Step 4: Run route tests and record RED.**

Run:

```bash
npx vitest run app/api/analysis/precheckout-blite/route.test.ts -t "pending parent|ready parent|expired"
```

Expected RED: the current route returns `204` for each new branch.

- [ ] **Step 5: Implement the finite status serializer and route classification.**

In `blite-status-contract.ts`, add a strict `bliteBrowserStatusV1Schema` union for the existing serialized B-lite states plus:

```ts
z.object({
    state: z.literal('parent_pending'),
    parentState: z.enum(['pending', 'processing']),
    retryAfterMs: z.number().int().min(500).max(2_000),
}).strict(),
z.object({ state: z.literal('unavailable') }).strict(),
z.object({ state: z.literal('terminal') }).strict(),
z.object({ state: z.literal('expired') }).strict(),
```

Export its inferred type and helper constructors that parse before returning. Do not add raw parent status, database error, provider, or target fields.

In the route, parse and validate `expiresAt` before classifying the owned `StoredPreflight`: malformed expiry fails open as `204`, and `expired` or an expiry timestamp at/before `Date.now()` returns a parsed `expired` 410 body even when the row is still `pending`/`processing`; only then may a valid unexpired `pending`/`processing` row return `parent_pending` 202. `blocked`/`consumed` returns a sanitized `terminal` 200 body without exposing the block code. For a ready parent, a null durable status returns a parsed `unavailable` 200 body; existing complete/pending/failed durable rows continue through `toBliteStatusV1`, with durable `failed` remaining a ready-parent plans fallback. Keep all exception paths fail-open `204` and preserve `Cache-Control: no-store`.

- [ ] **Step 6: Run status-contract and route tests to GREEN.**

```bash
npx vitest run lib/services/precheckout/blite-status-contract.test.ts app/api/analysis/precheckout-blite/route.test.ts
```

Expected: all existing and new tests pass, including auth/anonymous ownership and terminal B-lite no-generation assertions.

- [ ] **Step 7: Commit the API contract change.**

```bash
git add lib/services/precheckout/blite-status-contract.ts lib/services/precheckout/blite-status-contract.test.ts app/api/analysis/precheckout-blite/route.ts app/api/analysis/precheckout-blite/route.test.ts
git commit -m "fix: expose bounded preflight status states"
```

### Task 3: Model delayed, unavailable, terminal, expiry, and explicit retry actions

**Files:**
- Modify: `lib/services/precheckout/blite-page-flow.ts`
- Test: `lib/services/precheckout/blite-page-flow.test.ts`

- [ ] **Step 1: Write the failing pure state tests.**

Add focused tests for a status-to-surface resolver. The resolver must map `parent_pending`, B-lite `pending`, and transient reads to a CTA-free delayed surface, `unavailable` and durable B-lite `failed` to a plans action, and parent `terminal`/`expired` to a retry action. Add a second test proving `canRetryPrecheckout` is true only for authoritative parent terminal/expired outcomes and false for delayed, transient, unavailable, and durable B-lite failed states; add a request-binding test proving retry receives the same target but requires an explicit `retry` action before creating a new lifecycle.

```ts
it.each([
    ['parent_pending', 'delayed'],
    ['pending', 'delayed'],
    ['transient', 'delayed'],
    ['unavailable', 'plans'],
    ['failed', 'plans'],
    ['terminal', 'retry'],
    ['expired', 'retry'],
] as const)('maps %s to the bounded %s action', (status, expected) => {
    expect(resolvePrecheckoutFallbackAction(status)).toBe(expected);
});

it('allows a new preflight only after an explicit terminal/expiry retry action', () => {
    expect(canRetryPrecheckout('failed')).toBe(false);
    expect(canRetryPrecheckout('expired')).toBe(true);
    expect(canRetryPrecheckout('parent_pending')).toBe(false);
    expect(canRetryPrecheckout('transient')).toBe(false);
    expect(canRetryPrecheckout('unavailable')).toBe(false);
});
```

- [ ] **Step 2: Run the pure state tests and record RED.**

```bash
npx vitest run lib/services/precheckout/blite-page-flow.test.ts -t "bounded|explicit terminal"
```

Expected RED: missing resolver/action exports.

- [ ] **Step 3: Implement the minimal pure resolver.**

In `blite-page-flow.ts`, add strict finite types:

```ts
export type PrecheckoutBrowserStatus = 'parent_pending' | 'pending' | 'complete' | 'unavailable' | 'failed' | 'terminal' | 'expired';
export type PrecheckoutFallbackAction = 'delayed' | 'plans' | 'retry';

export function resolvePrecheckoutFallbackAction(
    status: Exclude<PrecheckoutBrowserStatus, 'complete'>,
): PrecheckoutFallbackAction {
    if (status === 'unavailable' || status === 'failed') return 'plans';
    if (status === 'terminal' || status === 'expired') return 'retry';
    return 'delayed';
}

export function canRetryPrecheckout(
    status: Exclude<PrecheckoutBrowserStatus, 'complete'>,
): boolean {
    return status === 'terminal' || status === 'expired';
}
```

Keep the existing reducer behavior and idempotency tests intact; these helpers are the
single mapping used by the immersive component and the retry decision. In particular,
`failed` is a ready-parent plans action, and `canRetryPrecheckout` returns true only
for authoritative parent `terminal` or `expired`.

- [ ] **Step 4: Run the pure state tests to GREEN.**

```bash
npx vitest run lib/services/precheckout/blite-page-flow.test.ts
```

Expected: all existing reducer tests plus the new mapping/idempotency tests pass.

- [ ] **Step 5: Commit the pure state change.**

```bash
git add lib/services/precheckout/blite-page-flow.ts lib/services/precheckout/blite-page-flow.test.ts
git commit -m "feat: define bounded precheckout fallback actions"
```

### Task 4: Add analytics vocabulary and fallback CTA instrumentation

**Files:**
- Modify: `lib/services/analytics.ts`
- Test: `lib/services/analytics.test.ts`

- [ ] **Step 1: Write the failing analytics tests.**

Add one test that tracks `DEMO_STARTED` with `{ demo_mode: 'waiting' }` and asserts the property survives validation. Add one test that tracks `PRECHECKOUT_EVENTS.BLITE_FALLBACK_CTA_CLICKED` with a valid UUID, `parent_state: 'pending'`, and `fallback_reason: 'preflight_expired'`, asserting the SDK receives only those allowlisted properties plus the helper-supplied `preflight_id`; pass raw username/provider fields and assert they are absent.

```ts
it('keeps waiting demo mode and the bounded fallback CTA event', async () => {
    enableBrowser();
    const analytics = await loadAnalytics();
    await analytics.initAmplitude(null);
    analytics.markAnalyticsIdentityReady();

    analytics.trackEvent(analytics.PRECHECKOUT_EVENTS.DEMO_STARTED, { demo_mode: 'waiting' });
    analytics.trackPrecheckoutEvent(
        analytics.PRECHECKOUT_EVENTS.BLITE_FALLBACK_CTA_CLICKED,
        VALID_USER_ID,
        {
            parent_state: 'pending',
            fallback_reason: 'preflight_expired',
            username: 'raw-target',
        } as never,
    );

    expect(amplitudeMocks.track).toHaveBeenCalledWith(
        'precheckout_demo_started', { demo_mode: 'waiting' },
    );
    expect(amplitudeMocks.track).toHaveBeenCalledWith(
        'precheckout_blite_fallback_cta_clicked', {
            preflight_id: VALID_USER_ID,
            parent_state: 'pending',
            fallback_reason: 'preflight_expired',
        },
    );
    expect(JSON.stringify(amplitudeMocks.track.mock.calls)).not.toContain('raw-target');
});
```

- [ ] **Step 2: Run analytics tests and record RED.**

```bash
npx vitest run lib/services/analytics.test.ts -t "waiting demo mode|fallback CTA"
```

Expected RED: `waiting` is currently stripped and the dedicated event is not in the approved event/schema maps.

- [ ] **Step 3: Implement the closed analytics additions.**

In `analytics.ts`:

- Add `BLITE_FALLBACK_CTA_CLICKED: 'precheckout_blite_fallback_cta_clicked'` to `PRECHECKOUT_EVENTS`.
- Add `parent_state` to `PropertyName` and validate only `pending`, `processing`, `ready`, `expired`, and `unknown`.
- Add `waiting` to the `demo_mode` enum.
- Add `blite_unavailable`, `blite_terminal`, and `preflight_expired` to the fallback-reason enum while retaining existing reasons.
- Register the new event schema as `['preflight_id', 'parent_state', 'fallback_reason']`.

Do not broaden `trackPrecheckoutEvent`, remove UUID validation, or pass raw API payloads. Keep integer-duration bounds unchanged.

- [ ] **Step 4: Run analytics tests to GREEN.**

```bash
npx vitest run lib/services/analytics.test.ts
```

Expected: all analytics identity, privacy, dedupe, event-schema, and new allowlist tests pass.

- [ ] **Step 5: Commit the analytics change.**

```bash
git add lib/services/analytics.ts lib/services/analytics.test.ts
git commit -m "feat: track bounded precheckout fallback CTA"
```

### Task 5: Wire the immersive client state and page-owned retry

**Files:**
- Modify: `components/precheckout-immersive.tsx`
- Modify: `app/analyze/page.tsx`
- Test: `components/precheckout-immersive.test.tsx`
- Test: `app/analyze/page.test.ts`

- [ ] **Step 1: Write the failing immersive state tests.**

Add tests with a valid `parent_pending` 202 body, ready-parent `unavailable` 200 body,
ready-parent durable `failed` 200 body, parent terminal 200 body, and `expired` 410 body.

```tsx
it('shows a static delayed state after the one graph pass for a pending parent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
        state: 'parent_pending', parentState: 'pending', retryAfterMs: 1_000,
    }, 202)));
    await act(async () => {
        root.render(createElement(PrecheckoutImmersive, {
            preflightId: PREFLIGHT_ID,
            claimToken: null,
            submittedAtMs: Date.parse(SUBMITTED_AT),
            targetUsername: 'target',
            onGoToPlans: vi.fn(),
            onRetry: vi.fn(),
        }));
    });
    await settleUi();
    await advance(20_000);

    expect(container.querySelector('[data-precheckout-delayed-state="parent_pending"]')).not.toBeNull();
    expect(container.querySelector('[data-precheckout-fallback]')).toBeNull();
    expect(container.textContent).not.toContain('상세 분석 보기');
});
```

Add one test asserting ready-parent `unavailable` shows the plans label and clicking it emits `precheckout_blite_fallback_cta_clicked` plus `precheckout_plan_gate_reached` and calls `onGoToPlans` once. Add a ready-parent durable `failed` test asserting the same existing plans action, `parent_state: 'ready'`, and no `onRetry`. Add terminal/expired tests asserting their button is `다시 확인하기`, no callback runs before click, and exactly one `onRetry` runs after click. Advance beyond T+90 and assert a `parent_pending`/B-lite `pending` delayed state remains static, has no retry CTA, and does not create a new preflight until an authoritative terminal/expired response and explicit click; assert the status fetch count stays within the fast-pass plus 5-second slow-poll bound.

- [ ] **Step 2: Run immersive tests and record RED.**

```bash
npx vitest run components/precheckout-immersive.test.tsx -t "static delayed|unavailable|다시 확인하기"
```

Expected RED: the current component maps `parent_pending` to transient, keeps a loop, has no delayed marker, and always renders the plans CTA for fallback.

- [ ] **Step 3: Implement status parsing and bounded state transitions.**

In `PrecheckoutImmersive`:

- Extend `BrowserBliteStatus` with `parent_pending`, `expired`, `terminal`, and `transient` handling as represented by the status contract; preserve complete DTO validation and request coalescing.
- Mount `PrecheckoutDemo` in waiting mode with `continueAfterFirstPass={false}` (or remove the prop) and `onInitialPassComplete`.
- Keep `exitRef` null for delayed state. At the initial boundary call `setView('delayed')` only when no result/terminal exit has already been requested. Do not mark delayed as a settled terminal path, so a later complete/failed/expired status can replace the static state.
- Set `initialPassCompleteRef` before resolving a late status. A result or authoritative terminal/expired fallback received after the boundary settles immediately; a status received before it settles at exactly the boundary. Parent-pending, B-lite-pending, and transient reads never settle the flow into a retry action.
- Map `parent_pending` and B-lite `pending` to `PrecheckoutDelayedStatus`; map `unavailable` and durable B-lite `failed` to a plans fallback; map parent `terminal` and `expired` to a retry fallback. Map transient/fail-open reads to the same static delayed surface. Do not use a client display bound to synthesize retry; a still-pending status remains delayed indefinitely, including after T+90, until an authoritative parent terminal/expired response arrives.
- During the one 20,000ms visual pass, honor only bounded fast retry hints (250–2,000ms). Once `onInitialPassComplete` fires, use the named `PRECHECKOUT_BLITE_SLOW_POLL_INTERVAL_MS = 5_000` interval for `parent_pending`, B-lite `pending`, and transient/fail-open reads; clear all timers and do not create a second poll in flight. The next slow read must still immediately accept complete/terminal/expired state.
- Emit `BLITE_FALLBACK_SELECTED` once on fallback selection with only bounded `parent_state`/`fallback_reason` fields. Emit `BLITE_FALLBACK_CTA_CLICKED` once inside the fallback button handler, then call either `onGoToPlans` or `onRetry`; never call either callback during render or polling. A durable B-lite `failed` state calls `onGoToPlans`; only parent `terminal`/`expired` calls `onRetry`.
- Keep result, gender confirmation, rejection, demo error, and heading-announcement behavior unchanged except for the new dedicated fallback-click event.

Update `FallbackScreen` to accept `action: 'plans' | 'retry'` and a continuation callback. Use `다시 확인하기` only for parent terminal/expiry retry action and preserve `상세 분석 보기` for ready-parent plans action and gender rejection. Do not show B-lite failure details.

- [ ] **Step 4: Run immersive tests to GREEN.**

```bash
npx vitest run components/precheckout-immersive.test.tsx
```

Expected: all existing result/gender/fallback/remount/StrictMode tests and all new static-state, API-state, CTA, and no-loop tests pass. Replace old tests that assert a rotating six-second loop or unconditional `상세 분석 보기` with the state-specific contracts; keep graph duration and no-early-plan assertions exact.

- [ ] **Step 5: Write the failing page retry-boundary test.**

In `app/analyze/page.test.ts`, assert the source wires `onRetry={handleRetryPreflight}`, clears the old precheckout surface/idempotency lifecycle before `startPreflight`, and does not invoke `startPreflight` from an effect or status poll. Keep the existing active-surface and heading reset assertions.

```ts
it('owns terminal retry in the page and starts a new preflight only from the retry callback', () => {
    const page = readFileSync(join(process.cwd(), 'app/analyze/page.tsx'), 'utf8');
    expect(page).toContain('onRetry={handleRetryPreflight}');
    expect(page).toContain('const handleRetryPreflight = useCallback');
    expect(page).toContain('setPrecheckoutSurface({ preflightId: null, surface: \'awaiting\' });');
    expect(page).toContain('reset();');
    expect(page).toContain('void startPreflight(retryTarget);');
});
```

- [ ] **Step 6: Run page test and record RED.**

```bash
npx vitest run app/analyze/page.test.ts -t "terminal retry"
```

Expected RED: the page currently passes no retry callback and has no handler that clears the old lifecycle before starting a new request.

- [ ] **Step 7: Implement the page-owned explicit retry.**

In `app/analyze/page.tsx`, add a stable `handleRetryPreflight` callback that captures `targetInstagramId` as `retryTarget`, returns when no target is bound, clears `bliteResultShown`, sets the active surface to `{ preflightId: null, surface: 'awaiting' }`, calls the existing `reset()` to clear coordinator/idempotency state, and then calls `void startPreflight(retryTarget)`. Pass it as `onRetry` to `PrecheckoutImmersive`. Do not change `app/page.tsx` or landing copy. Keep normal `onGoToPlans` unchanged so unavailable plans and durable B-lite `failed` do not create a new preflight.

- [ ] **Step 8: Run page tests to GREEN.**

```bash
npx vitest run app/analyze/page.test.ts
```

Expected: all page source-boundary assertions pass, including old-surface isolation and heading restoration.

- [ ] **Step 9: Commit the immersive/page integration.**

```bash
git add components/precheckout-immersive.tsx components/precheckout-immersive.test.ts app/analyze/page.tsx app/analyze/page.test.ts
git commit -m "fix: make precheckout fallback actions explicit"
```

### Task 6: Full focused verification and self-review

**Files:**
- Verify: all files in Tasks 1–5
- Do not modify: `app/page.tsx`, migrations, workers, providers, payment code, deployment scripts

- [ ] **Step 1: Run focused regression suites.**

```bash
npx vitest run \
  components/precheckout-demo.test.tsx \
  components/precheckout-immersive.test.tsx \
  lib/services/analysis/preflight-pending-status.test.ts \
  lib/services/precheckout/blite-status-contract.test.ts \
  lib/services/precheckout/blite-page-flow.test.ts \
  app/api/analysis/precheckout-blite/route.test.ts \
  app/analyze/page.test.ts \
  lib/services/analytics.test.ts
```

Expected: zero failures and no unhandled timer/fetch errors.

- [ ] **Step 2: Run static checks.**

```bash
npx tsc --noEmit
npm run lint
git diff --check
```

Expected: all commands exit zero. Any pre-existing `package-lock.json` diff remains untouched and is not staged.

- [ ] **Step 3: Run the production build and full test suite.**

```bash
npm run build
npm test
```

Expected: webpack production build and the full Vitest suite exit zero. If a non-secret public build variable is missing, use a syntactically valid command-local placeholder and do not print or copy secrets.

- [ ] **Step 4: Self-review the state/analytics boundary.**

Check:

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- app/page.tsx
git status --short
```

Confirm the diff contains no `app/page.tsx` changes; no fallback status carries raw response/provider/task data; no CTA handler runs during polling/render; status reads remain bound to one preflight/claim key; explicit retry clears the old lifecycle before `startPreflight`; and the only new analytics event is the dedicated fallback CTA with finite properties.

- [ ] **Step 5: Commit any confirmed review-only correction and report evidence.**

If self-review finds a real defect, add its failing test first, run RED, apply the smallest fix, rerun Task 6, and make one logical commit. Otherwise leave the logical commits unchanged and report the focused test command, static checks, build/test result, and the preserved pre-existing lockfile diff to the coordinator.
