# Amplitude Product Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect a privacy-bounded end-to-end acquisition, preflight, checkout, analysis, result, and sharing funnel in Amplitude Analytics with 100% Session Replay and no raw Instagram identity in events or replay.

**Architecture:** Replace the unused Browser SDK wrapper with one client-only Unified SDK adapter mounted once at the root. A typed event catalog and runtime property allowlist prevent sensitive fields from being emitted, while a provider identifies only the Supabase UUID and handles OAuth completion. Existing UI and hooks emit lifecycle events at their authoritative client boundaries; explicit replay mask/block classes protect inputs, profile content, results, and payment identity.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, `@amplitude/unified`, Supabase Auth, Vitest, Amplitude web UI.

---

### Task 1: Unified SDK adapter, event contract, and one-time provider

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Replace: `lib/services/analytics.ts`
- Create: `lib/services/analytics.test.ts`
- Create: `components/amplitude-provider.tsx`
- Modify: `app/layout.tsx`

- [ ] **Step 1: Replace the package**

Run: `npm uninstall @amplitude/analytics-browser && npm install @amplitude/unified`

Expected: only `@amplitude/unified` remains in production dependencies.

- [ ] **Step 2: Write failing adapter tests with a mocked Unified SDK**

Mock `initAll`, `track`, `setUserId`, and `reset`; stub `window`; reset modules between tests. Assert:

```ts
expect(initAmplitude()).toBe(true);
expect(initAmplitude()).toBe(true);
expect(mockInitAll).toHaveBeenCalledTimes(1);
expect(mockInitAll).toHaveBeenCalledWith('test-key', {
    analytics: { autocapture: true },
    sessionReplay: {
        sampleRate: 1,
        privacyConfig: {
            defaultMaskLevel: 'medium',
            maskSelector: ['.amp-mask', '[data-amp-mask]'],
            blockSelector: ['.amp-block', '[data-amp-block]'],
        },
    },
    engagement: { skip: true },
});
```

Also test missing key fail-open, SDK exception fail-open, UUID identify/reset, and rejection of properties named `instagramId`, `targetInstagramId`, `email`, `phone`, `bio`, `caption`, `comment`, `imageUrl`, `profileImage`, or `token`.

Run: `npm test -- lib/services/analytics.test.ts`

Expected: FAIL against the old SDK wrapper.

- [ ] **Step 3: Implement the fixed event catalog and safe property set**

```ts
export const EVENTS = {
    LANDING_VIEWED: 'landing_viewed',
    TARGET_SUBMITTED: 'target_submitted',
    AUTH_STARTED: 'auth_started',
    AUTH_COMPLETED: 'auth_completed',
    PREFLIGHT_STARTED: 'preflight_started',
    PREFLIGHT_SUCCEEDED: 'preflight_succeeded',
    PREFLIGHT_FAILED: 'preflight_failed',
    EXCLUSION_DECIDED: 'exclusion_decided',
    PLAN_VIEWED: 'plan_viewed',
    PLAN_SELECTED: 'plan_selected',
    CHECKOUT_STARTED: 'checkout_started',
    CHECKOUT_REDIRECTED: 'checkout_redirected',
    PAYMENT_CONFIRMED_VIEWED: 'payment_confirmed_viewed',
    EARLYBIRD_STATUS_VIEWED: 'earlybird_status_viewed',
    ANALYSIS_STARTED: 'analysis_started',
    ANALYSIS_COMPLETED: 'analysis_completed',
    RESULT_VIEWED: 'result_viewed',
    RESULT_SHARED: 'result_shared',
} as const;

const ALLOWED_PROPERTIES = new Set([
    'provider', 'source', 'medium', 'campaign', 'content', 'term',
    'plan_id', 'required_plan_id', 'amount_krw', 'stage', 'duration_ms',
    'error_code', 'followers_bucket', 'following_bucket', 'decision',
    'preflight_id', 'order_id', 'request_id', 'status', 'share_channel',
    'is_shared', 'result_count',
]);
```

`trackEvent` copies only allowlisted scalar values and calls `track`. Never throw into product code. Export `identifyAnalyticsUser(userId: string | null)` and validate non-null IDs as UUIDs before calling `setUserId`; null calls `reset`.

- [ ] **Step 4: Initialize exactly once and skip unused engagement**

```ts
import * as amplitude from '@amplitude/unified';

export function initAmplitude(): boolean {
    if (initialized) return true;
    if (typeof window === 'undefined') return false;
    const apiKey = process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY?.trim();
    if (!apiKey) return false;
    try {
        amplitude.initAll(apiKey, {
            analytics: { autocapture: true },
            sessionReplay: {
                sampleRate: 1,
                privacyConfig: {
                    defaultMaskLevel: 'medium',
                    maskSelector: ['.amp-mask', '[data-amp-mask]'],
                    blockSelector: ['.amp-block', '[data-amp-block]'],
                },
            },
            engagement: { skip: true },
        });
        initialized = true;
        return true;
    } catch {
        return false;
    }
}
```

- [ ] **Step 5: Mount a client provider once**

`AmplitudeProvider` calls `initAmplitude()` in one empty-dependency effect. It observes `useAuth()` and sets only the Supabase UUID. If `sessionStorage.amplitude_auth_started` is present when a user first appears, emit `auth_completed` once and remove the marker. On sign-out, call `identifyAnalyticsUser(null)`.

```tsx
export function AmplitudeProvider({ children }: { children: React.ReactNode }) {
    const { user, loading } = useAuth();
    useEffect(() => { initAmplitude(); }, []);
    useEffect(() => {
        if (loading) return;
        identifyAnalyticsUser(user?.id ?? null);
        completePendingAuthEvent(user?.id ?? null, sessionStorage);
    }, [loading, user?.id]);
    return children;
}
```

Wrap `children` inside `<AmplitudeProvider>` in `app/layout.tsx`; do not import the SDK from a server component other than through this client boundary.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- lib/services/analytics.test.ts && npx tsc --noEmit`

Expected: PASS and type-check exits 0.

```bash
git add package.json package-lock.json lib/services/analytics.ts lib/services/analytics.test.ts components/amplitude-provider.tsx app/layout.tsx
git commit -m "feat: initialize Amplitude analytics and replay"
```

### Task 2: Acquisition, auth, and preflight instrumentation

**Files:**
- Modify: `app/page.tsx`
- Modify: `components/auth-buttons.tsx`
- Modify: `hooks/useAnalysisV2Preflight.ts`
- Create: `lib/services/analytics-funnel.ts`
- Create: `lib/services/analytics-funnel.test.ts`

- [ ] **Step 1: Write failing funnel utility tests**

Implement and test pure helpers with these exact contracts:

```ts
export function relationshipBucket(value: number | null | undefined):
    'unknown' | '0_400' | '401_800' | '801_1200' | 'over_1200';

export function readAttribution(search: string): {
    source?: string; medium?: string; campaign?: string; content?: string; term?: string;
};

export function safeAnalyticsErrorCode(value: unknown): string;
```

Attribution values are trimmed to 100 characters; error codes are uppercase `[A-Z0-9_]` and otherwise become `UNKNOWN`. No helper accepts or returns an Instagram username.

Run: `npm test -- lib/services/analytics-funnel.test.ts`

Expected: FAIL because the utility does not exist.

- [ ] **Step 2: Track landing and target submission without the target value**

On first landing mount emit `landing_viewed` with UTM properties. In `handleStart`, replace the old CTA event with:

```ts
trackEvent(EVENTS.TARGET_SUBMITTED, {
    stage: user ? 'authenticated' : 'anonymous',
});
```

Never pass `id`, `igId`, `pending_ig`, or route target query values.

- [ ] **Step 3: Track OAuth start and durable completion**

Immediately before `signInWithOAuth`, emit `auth_started` with `{ provider: 'kakao' }` and set the session marker. Do not track the OAuth URL or email. The root provider from Task 1 emits completion after the callback restores the user.

- [ ] **Step 4: Instrument the authoritative preflight hook**

In `startPreflight`, record a monotonic start time and emit `preflight_started` with no target. When the accepted preflight reaches `ready`, emit `preflight_succeeded` once per `preflightId` with duration, required plan, follower/following buckets, and `preflight_id`. On blocked/error emit `preflight_failed` with bounded error code and duration. On saved exclusion emit:

```ts
trackEvent(EVENTS.EXCLUSION_DECIDED, {
    preflight_id: preflight.preflightId,
    decision: excludedInstagramId ? 'exclude' : 'skip',
});
```

Do not emit the excluded ID.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- lib/services/analytics.test.ts lib/services/analytics-funnel.test.ts && npx tsc --noEmit`

Expected: PASS.

```bash
git add app/page.tsx components/auth-buttons.tsx hooks/useAnalysisV2Preflight.ts lib/services/analytics-funnel.*
git commit -m "feat: track acquisition and preflight funnel"
```

### Task 3: Plan, checkout, and earlybird status instrumentation

**Files:**
- Modify: `app/analyze/page.tsx`
- Modify: `app/earlybird/page.tsx`
- Modify: `app/earlybird/earlybird-status.tsx`
- Create: `lib/services/earlybird/analytics-state.ts`
- Create: `lib/services/earlybird/analytics-state.test.ts`

- [ ] **Step 1: Write failing deduplication state tests**

Create pure keys used by effects so refresh/rerender cannot duplicate visibility events:

```ts
export function planViewEventKey(preflightId: string, pricingVersion: string): string;
export function paymentConfirmationEventKey(orderId: string, status: string): string | null;
```

The payment key returns a value only for `paid`, `analysis_in_progress`, or `completed`. Test deterministic output and terminal/nonterminal cases.

Run: `npm test -- lib/services/earlybird/analytics-state.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Track plan visibility and selection**

When ready plan cards first render for a preflight, emit one `plan_viewed` per selectable Basic/Standard card using `sessionStorage` deduplication. Plus may still be rendered by the product, but no Plus waitlist analytics event or chart is added. On a user card click emit `plan_selected` with `plan_id`, `required_plan_id`, `amount_krw`, and `preflight_id`.

- [ ] **Step 3: Track checkout boundaries**

Before the checkout POST emit `checkout_started`. After receiving a validated Groble URL and immediately before `window.location.assign`, emit `checkout_redirected`. Both contain plan/amount/preflight UUID only. Failed checkout remains represented by Axiom server logs, not a new unapproved Amplitude event name.

- [ ] **Step 4: Track durable order visibility**

When `/earlybird` loads an owner-safe DTO, emit `earlybird_status_viewed` once per order/status. Emit `payment_confirmed_viewed` only for the paid or later accepted states using a `sessionStorage` key. Include `order_id`, `plan_id`, `amount_krw`, and `status`; do not include target ID, buyer contact, or Groble payment ID.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- lib/services/earlybird/analytics-state.test.ts && npx tsc --noEmit`

Expected: PASS.

```bash
git add app/analyze/page.tsx app/earlybird lib/services/earlybird/analytics-state.*
git commit -m "feat: track earlybird checkout conversion"
```

### Task 4: Analysis completion, result, and sharing instrumentation

**Files:**
- Modify: `hooks/useAnalysisV2Preflight.ts`
- Modify: `hooks/useAnalysisProgress.ts`
- Modify: `app/progress/[requestId]/page.tsx`
- Modify: `app/result/[requestId]/page.tsx`
- Modify: `app/share/[token]/page.tsx`

- [ ] **Step 1: Track analysis start at entitlement consumption**

After the entitlement response yields a request ID and immediately before navigating to progress, emit `analysis_started` with `request_id`, `plan_id`, and `preflight_id`. Do not track credentials or target.

- [ ] **Step 2: Track completion once at the progress state boundary**

When the progress hook first observes `status === 'completed'`, emit `analysis_completed` with request UUID and client-observed duration. Guard with a ref plus `sessionStorage` key `amplitude:analysis_completed:<requestId>`. Failure uses no extra event name; Axiom owns operational failures.

- [ ] **Step 3: Replace legacy result/share event names**

On owner result load emit `result_viewed` with request UUID, bounded result count, and `{ is_shared: false }`. On public share load emit the same event with `{ is_shared: true }` and omit the share token. All share actions emit `result_shared` with `share_channel: 'web_share' | 'clipboard' | 'kakao'` and the owner request UUID only when available.

- [ ] **Step 4: Verify no obsolete event names remain and commit**

Run:

```bash
rg -n "PAGE_VIEW_LANDING|CLICK_CTA_START|AUTH_COMPLETE|VIEW_RESULT|CLICK_SHARE" app components hooks lib
npm test -- lib/services/analytics.test.ts lib/services/analytics-funnel.test.ts
npx tsc --noEmit
```

Expected: `rg` returns no obsolete references; tests and type-check pass.

```bash
git add hooks/useAnalysisV2Preflight.ts hooks/useAnalysisProgress.ts app/progress app/result app/share
git commit -m "feat: track analysis and result engagement"
```

### Task 5: Session Replay privacy boundaries

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/analyze/page.tsx`
- Modify: `app/earlybird/earlybird-status.tsx`
- Modify: `app/result/[requestId]/page.tsx`
- Modify: `app/share/[token]/page.tsx`
- Modify: `app/mypage/analysis-list.tsx`
- Create: `lib/services/amplitude-privacy-contract.test.ts`

- [ ] **Step 1: Write a failing source contract test**

Read the six files and assert:

```ts
expect(analyze).toMatch(/data-amp-mask/);
expect(earlybird).toMatch(/data-amp-block/);
expect(result).toMatch(/data-amp-block/);
expect(shared).toMatch(/data-amp-block/);
expect(history).toMatch(/data-amp-block/);
```

Also assert no `amp-unmask` or `data-amp-unmask` appears anywhere under `app/` or `components/`.

Run: `npm test -- lib/services/amplitude-privacy-contract.test.ts`

Expected: FAIL because the markers are absent.

- [ ] **Step 2: Apply conservative markers**

- Add `data-amp-mask` to every Instagram ID input wrapper and target ID text.
- Add `data-amp-block` to profile images, bios, comments, narratives, full result cards, share result cards, order target/status details, and history rows.
- Keep payment plan names and generic status headings visible only where they contain no personal identity.
- Never add `amp-unmask`.

- [ ] **Step 3: Verify and commit**

Run: `npm test -- lib/services/amplitude-privacy-contract.test.ts && npm run build`

Expected: PASS and production build succeeds.

```bash
git add app components lib/services/amplitude-privacy-contract.test.ts
git commit -m "fix: mask sensitive Session Replay content"
```

### Task 6: Privacy notice, live verification, and Amplitude dashboard

**Files:**
- Modify: `app/privacy/page.tsx`
- Modify: `.env.example`
- Create: `docs/amplitude-analytics-operations.md`

- [ ] **Step 1: Document the client variable and privacy behavior**

Add `NEXT_PUBLIC_AMPLITUDE_API_KEY=` to `.env.example`. Update the privacy notice to disclose Analytics autocapture and Session Replay, purposes, 30-day raw replay retention where applicable, masking, and Amplitude's international processing. Do not put the real key in docs.

- [ ] **Step 2: Run static and full verification**

Run:

```bash
npm test -- lib/services/analytics.test.ts lib/services/analytics-funnel.test.ts \
  lib/services/amplitude-privacy-contract.test.ts lib/services/earlybird/analytics-state.test.ts
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 3: Verify live ingestion in a preview**

Set `NEXT_PUBLIC_AMPLITUDE_API_KEY` on the Vercel preview environment, open the preview, fire `landing_viewed`, `target_submitted`, and one preflight event, then confirm the events and one replay arrive in the logged-in Amplitude project. Inspect event properties and replay to confirm no raw Instagram ID, profile image, bio, comment, result narrative, email, or phone is visible.

- [ ] **Step 4: Build charts by direct Comet browser interaction**

Do not use the Amplitude API or a connector. In the logged-in Amplitude UI create dashboard `얼리버드 전환 대시보드` containing:

1. daily `landing_viewed` uniques broken down by source/campaign;
2. funnel `landing_viewed → target_submitted → auth_completed → preflight_succeeded → plan_selected → checkout_redirected → payment_confirmed_viewed`;
3. stage conversion and drop-off table;
4. Basic vs Standard `plan_selected` and checkout conversion;
5. preflight success rate, error code distribution, p50/p90 duration;
6. payment-confirmed count and summed `amount_krw`;
7. `result_viewed` and `result_shared` trends;
8. replay segment for sessions with target submission but no checkout redirect.

Do not create a Plus waitlist chart.

- [ ] **Step 5: Commit documentation**

```bash
git add app/privacy/page.tsx .env.example docs/amplitude-analytics-operations.md
git commit -m "docs: add Amplitude analytics operations"
```
