# Amplitude UX Funnel Chart Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make landing sources dynamically visible and align the production Amplitude dashboard with the current anonymous preflight-to-payment UX.

**Architecture:** Keep attribution normalization in `analytics-funnel.ts` and event-boundary validation in `analytics.ts`. Preserve the event vocabulary and change only saved Amplitude chart definitions for reporting. Supabase remains the payment ledger.

**Tech Stack:** TypeScript, Vitest, Next.js 16, Amplitude Unified Browser SDK, Amplitude web UI through the logged-in Comet session.

---

### Task 1: Add bounded dynamic source attribution

**Files:**
- Modify: `lib/services/analytics-funnel.test.ts:40-90`
- Modify: `lib/services/analytics-funnel.ts:90-165`
- Modify: `lib/services/analytics.test.ts`
- Modify: `lib/services/analytics.ts:195-250`

- [ ] **Step 1: Write failing helper tests**

Replace the closed-source assertions with dynamic-source and alias cases:

```ts
it('normalizes bounded dynamic sources and canonical aliases', () => {
    expect(readAttribution('?utm_source=New%20Partner')).toEqual({ source: 'new partner' });
    expect(readAttribution('?utm_source=thread')).toEqual({ source: 'threads' });
    expect(readAttribution('?utm_source=threads.net')).toEqual({ source: 'threads' });
    expect(readAttribution('?utm_source=twitter.com')).toEqual({ source: 'x' });
    expect(readAttribution('?utm_source=x.com')).toEqual({ source: 'x' });
    expect(readAttribution('?utm_source=everytime.kr')).toEqual({ source: 'everytime' });
    expect(readAttribution(`?utm_source=${'a'.repeat(65)}`)).toEqual({});
});
```

Keep the existing direct, medium, campaign, content, term, ChatGPT, and shared-attribution cases. Remove only the assertions that every arbitrary source must be discarded.

- [ ] **Step 2: Verify the helper test fails**

Run `npx vitest run lib/services/analytics-funnel.test.ts`.

Expected: FAIL because the current source vocabulary is closed.

- [ ] **Step 3: Implement the source normalizer**

Add this boundary in `analytics-funnel.ts` and use it for `utm_source`:

```ts
const MAX_ATTRIBUTION_SOURCE_LENGTH = 64;
const ATTRIBUTION_SOURCE_ALIASES: Readonly<Record<string, string>> = {
    'chatgpt.com': 'chatgpt',
    thread: 'threads',
    'threads.net': 'threads',
    twitter: 'x',
    'twitter.com': 'x',
    'x.com': 'x',
    'everytime.kr': 'everytime',
};

export function normalizeAttributionSource(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized.length > MAX_ATTRIBUTION_SOURCE_LENGTH) return undefined;
    return ATTRIBUTION_SOURCE_ALIASES[normalized] ?? normalized;
}
```

Retain the current closed validators for `medium`, `campaign`, `content`, and `term`. Apply default `medium=referral` to canonical `chatgpt` only when the URL has no `utm_medium`.

- [ ] **Step 4: Write a failing adapter-boundary test**

In `analytics.test.ts`, assert:

```ts
analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, { source: 'new partner' });
analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, { source: 'a'.repeat(65) });

expect(amplitudeMocks.track.mock.calls).toContainEqual([
    'landing_viewed', { source: 'new partner' },
]);
expect(amplitudeMocks.track.mock.calls).toContainEqual(['landing_viewed', {}]);
```

- [ ] **Step 5: Verify the adapter test fails**

Run `npx vitest run lib/services/analytics.test.ts`.

Expected: FAIL because `analytics.ts` still validates `source` with a closed enum.

- [ ] **Step 6: Reuse the normalizer at the event boundary**

Import `normalizeAttributionSource` into `analytics.ts` and replace the closed `source` enum validator with:

```ts
source: normalizeAttributionSource,
```

- [ ] **Step 7: Verify and commit attribution changes**

Run `npx vitest run lib/services/analytics-funnel.test.ts lib/services/analytics.test.ts lib/services/landing-lead.test.ts`.

Expected: all tests PASS.

Commit only the four attribution files with message `feat: accept dynamic Amplitude sources`.

### Task 2: Update the analytics operating contract

**Files:**
- Modify: `docs/amplitude-analytics-operations.md:1-180`

- [ ] **Step 1: Document the new source contract**

State that source accepts trimmed, lowercase, non-empty values up to 64 characters; aliases are canonicalized; unseen values appear prospectively; historical discarded values cannot be reconstructed; and medium remains collected but is not charted.

- [ ] **Step 2: Replace the dashboard inventory**

Document exactly these definitions:

```text
유입 추이 및 채널: landing_viewed daily unique users, grouped by source only
핵심 UX 퍼널: landing_viewed → preflight_started → exclusion_decided →
  precheckout_demo_completed → precheckout_plan_gate_reached → plan_selected →
  auth_completed → checkout_redirected → payment_confirmed_viewed
단계별 이탈: the same nine ordered events
사전 조회 실패: daily preflight_failed event totals grouped by error_code
결제 확인: daily payment_confirmed_viewed event totals grouped by plan_id,
  filtered to basic and standard
```

Remove `플랜 수요` and `결과 이용` from the active dashboard inventory. Retain the statement that `payment_confirmed_viewed` is not the revenue ledger.

- [ ] **Step 3: Verify and commit the document**

Run `git diff --check -- docs/amplitude-analytics-operations.md` and search the active dashboard section for the old funnel order and deleted chart names.

Expected: no stale active instruction remains and the diff check passes.

Commit only the operations document with message `docs: update Amplitude dashboard contract`.

### Task 3: Modify the production Amplitude dashboard

**Files:**
- Remote project: Amplitude `yeosachin`
- Dashboard: `얼리버드 전환 대시보드` (`p7w87cf8`)
- Modify charts: `유입 추이 및 채널`, `핵심 결제 퍼널`, `사전 조회 품질`, `결제 확인`, `단계별 이탈`
- Delete charts: `플랜 수요`, `결과 이용`

- [ ] **Step 1: Confirm the production scope**

Use the logged-in Comet session and confirm the URL is under `/analytics/yeosachin/`. Record only chart names and opaque chart IDs. Do not expose user/device IDs or raw payloads.

- [ ] **Step 2: Update `유입 추이 및 채널`**

Keep one `landing_viewed` measurement, use daily unique users, group only by `source`, and remove the `medium` measurement. Save this description:

```text
landing_viewed 일별 고유 사용자 수를 source별로 확인합니다. 정규화된 신규 UTM source는 자동으로 새 항목에 표시됩니다.
```

- [ ] **Step 3: Update the core funnel**

Rename `핵심 결제 퍼널` to `핵심 UX 퍼널`. Configure the approved nine events in exact order, unique users, completed within seven days. Save a description listing the same order and identifying preview completion and plan-gate entry as visible UX transitions.

- [ ] **Step 4: Update `단계별 이탈`**

Configure the same nine ordered events and retain its drop-off and conversion-time purpose. Save a description listing the same event order.

- [ ] **Step 5: Replace `사전 조회 품질`**

Rename it to `사전 조회 실패`. Remove success and duration measurements. Keep one daily `preflight_failed` event-total measurement grouped by `error_code`. State in the description that normal business blocks are excluded.

- [ ] **Step 6: Simplify `결제 확인`**

Remove unique-user and `amount_krw` measurements. Keep one daily event-total `payment_confirmed_viewed` measurement, filter `plan_id` to `basic` and `standard`, and group by `plan_id`. State that this observes confirmation-screen views and Supabase is the payment ledger.

- [ ] **Step 7: Delete exactly two charts**

Permanently delete `플랜 수요` and `결과 이용`. Verify each confirmation dialog names the expected chart before confirming. Do not delete any other saved content.

- [ ] **Step 8: Verify all remote changes**

Return to the dashboard, verify the five retained chart cards, then re-open every retained chart and read its event order, metric, filter, grouping, title, and description.

### Task 4: Final verification and handoff

**Files:**
- Verify only; do not modify unrelated files.

- [ ] **Step 1: Run focused tests**

Run `npx vitest run lib/services/analytics-funnel.test.ts lib/services/analytics.test.ts lib/services/landing-lead.test.ts lib/services/amplitude-funnel-caller-contract.test.ts lib/services/amplitude-privacy-contract.test.ts`.

Expected: all tests PASS.

- [ ] **Step 2: Run static and diff checks**

Run `npm run lint`, `git diff --check`, and `git status --short`.

Expected: lint and diff checks pass. The pre-existing user-owned `package-lock.json` modification remains untouched.

- [ ] **Step 3: Report the completed scope**

Summarize changed code and documentation paths, list the five final chart definitions, confirm deletion of the two requested charts, and disclose any incomplete verification. Do not include credentials, raw payloads, or identifiers.
