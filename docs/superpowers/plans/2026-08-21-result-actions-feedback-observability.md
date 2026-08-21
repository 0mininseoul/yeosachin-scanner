# Result Actions and Feedback Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Record successful result-page sharing channels in Amplitude and record authoritative feedback persistence outcomes in Amplitude and Axiom without collecting feedback text.

**Architecture:** Keep the result page as the owner of product analytics. ResultActions reports only confirmed clipboard/Instagram-DM outcomes through a callback, and the page maps those outcomes to the existing result_shared event. ResultFeedback emits a client event after a successful API response, while the server route emits sanitized operational events before returning from the database-insert path and schedules a deferred Axiom flush.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Vitest/jsdom, Amplitude unified client, Axiom operational logger, Supabase.

---

## File Map

- Modify lib/services/analytics.ts: register result_feedback_submitted and allow instagram_dm as a share channel.
- Modify lib/observability/schema.ts: register feedback persistence event names and the insert-failure error code.
- Modify components/result-actions.tsx: expose a confirmed share-outcome callback for clipboard and Instagram DM actions.
- Modify app/result/[requestId]/page.tsx: map the callback to EVENTS.RESULT_SHARED and pass it to ResultActions.
- Modify components/result-feedback.tsx: emit the feedback Amplitude event after HTTP success.
- Modify app/api/result-feedback/route.ts: emit sanitized Axiom success/failure events and defer flushing.
- Modify lib/services/analytics.test.ts: cover the new taxonomy and property validation.
- Create components/result-actions.test.tsx: verify callback timing for successful and failed share actions.
- Create components/result-feedback.test.tsx: verify feedback analytics fires only after successful persistence acknowledgement and excludes text.
- Modify lib/services/feedback/result-feedback-route.test.ts: verify success/failure operational emissions and privacy.

### Task 1: Extend the analytics contracts

**Files:**
- Modify: lib/services/analytics.ts (EVENTS, AnalyticsShareChannel, PROPERTY_VALIDATORS, and EVENT_SCHEMAS)
- Test: lib/services/analytics.test.ts (EVENTS export and property-schema tests)

- [ ] **Step 1: Write the failing contract assertions**

Add RESULT_FEEDBACK_SUBMITTED: 'result_feedback_submitted' to the expected EVENTS object. Extend the property-schema test with:

~~~ts
analytics.trackEvent(analytics.EVENTS.RESULT_SHARED, {
    request_id: VALID_USER_ID,
    share_channel: 'instagram_dm',
});
analytics.trackEvent(analytics.EVENTS.RESULT_FEEDBACK_SUBMITTED, {
    request_id: SECOND_UUID,
    body: '비공개 의견은 전송하지 않아야 한다',
});

expect(amplitudeMocks.track.mock.calls).toContainEqual([
    'result_shared',
    { request_id: VALID_USER_ID, share_channel: 'instagram_dm' },
]);
expect(amplitudeMocks.track.mock.calls).toContainEqual([
    'result_feedback_submitted',
    { request_id: SECOND_UUID },
]);
expect(JSON.stringify(amplitudeMocks.track.mock.calls)).not.toContain('비공개 의견');
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run: npm test -- lib/services/analytics.test.ts

Expected: FAIL because the new event is not exported and instagram_dm is rejected by the current validator.

- [ ] **Step 3: Implement the minimal analytics contract**

In lib/services/analytics.ts:

~~~ts
export const EVENTS = {
    // existing events...
    RESULT_VIEWED: 'result_viewed',
    RESULT_SHARED: 'result_shared',
    RESULT_FEEDBACK_SUBMITTED: 'result_feedback_submitted',
} as const;

export type AnalyticsShareChannel = 'clipboard' | 'instagram_dm' | 'kakao' | 'web_share';

// In PROPERTY_VALIDATORS:
share_channel: enumValidator(['clipboard', 'instagram_dm', 'kakao', 'web_share']),

// In EVENT_SCHEMAS:
[EVENTS.RESULT_FEEDBACK_SUBMITTED]: ['request_id'],
~~~

The existing APPROVED_EVENTS construction will include the new event automatically. Do not add body, text, or error properties to PropertyName.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: npm test -- lib/services/analytics.test.ts

Expected: PASS, including the existing adversarial-property tests.

- [ ] **Step 5: Commit**

~~~bash
git add lib/services/analytics.ts lib/services/analytics.test.ts
git commit -m "feat: register result feedback analytics event"
~~~

### Task 2: Add confirmed callbacks to result share actions

**Files:**
- Modify: components/result-actions.tsx (props, copy, and shareToInstagramDm handlers)
- Create: components/result-actions.test.tsx

- [ ] **Step 1: Write the failing component tests**

Create a jsdom test that renders ResultActions with shareUrl, a no-op Kakao handler, and onShare. Stub navigator.clipboard.writeText and window.open. The tests must assert:

~~~ts
it('reports clipboard only after writeText resolves', async () => {
    const onShare = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    // render, open the menu, click "링크 복사", flush one async act cycle
    expect(writeText).toHaveBeenCalledWith(shareUrl);
    expect(onShare).toHaveBeenCalledWith('clipboard');
});

it('reports Instagram DM only after the link copy resolves', async () => {
    const onShare = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    // render, open the menu, click "DM 공유", flush one async act cycle
    expect(writeText).toHaveBeenCalledWith(shareUrl);
    expect(onShare).toHaveBeenCalledWith('instagram_dm');
});

it('does not report a failed copy as a share', async () => {
    const onShare = vi.fn();
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    // render, open the menu, click "링크 복사", flush one async act cycle
    expect(onShare).not.toHaveBeenCalled();
});
~~~

Use the existing React 19 createRoot/act test style; do not add a testing-library dependency.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: npm test -- components/result-actions.test.tsx

Expected: FAIL because ResultActions has no onShare prop and emits no callbacks.

- [ ] **Step 3: Implement the minimal callback contract**

Add an optional prop:

~~~ts
onShare?: (channel: 'clipboard' | 'instagram_dm') => void;
~~~

In copy, call onShare?.('clipboard') only after writeText or copyTextSync returns success and before the menu-close timeout. In shareToInstagramDm, call onShare?.('instagram_dm') only from the successful clipboard promise continuation or after a successful synchronous fallback copy. Keep the handler non-async, preserve the current user-gesture navigation, and never call the callback on a rejected/failed copy.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: npm test -- components/result-actions.test.tsx lib/services/share/result-actions-gesture-contract.test.ts

Expected: PASS, including the gesture-preservation source contracts.

- [ ] **Step 5: Commit**

~~~bash
git add components/result-actions.tsx components/result-actions.test.tsx
git commit -m "feat: report confirmed result share channels"
~~~

### Task 3: Wire share callbacks to the result-page Amplitude event

**Files:**
- Modify: app/result/[requestId]/page.tsx (ResultActions usage)
- Test: lib/services/amplitude-caller-contract.test.ts

- [ ] **Step 1: Write the failing page contract assertion**

Add a source assertion that the ResultActions usage passes an onShare callback which calls:

~~~ts
trackEvent(EVENTS.RESULT_SHARED, {
    request_id: requestId,
    share_channel: channel,
});
~~~

The assertion must also retain the existing page-level Kakao tracking.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: npm test -- lib/services/amplitude-caller-contract.test.ts

Expected: FAIL because the result page currently passes only onKakaoShare and onPrepare to ResultActions.

- [ ] **Step 3: Implement the page callback**

Pass this callback at the existing ResultActions call site:

~~~tsx
onShare={(channel) => {
    trackEvent(EVENTS.RESULT_SHARED, {
        request_id: requestId,
        share_channel: channel,
    });
}}
~~~

Do not alter marketing copy or the existing Kakao/native-share handlers.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: npm test -- lib/services/amplitude-caller-contract.test.ts components/result-actions.test.tsx

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add app/result/[requestId]/page.tsx lib/services/amplitude-caller-contract.test.ts
git commit -m "feat: track result action share channels"
~~~

### Task 4: Track successful feedback submission in Amplitude

**Files:**
- Modify: components/result-feedback.tsx (successful response branch)
- Create: components/result-feedback.test.tsx

- [ ] **Step 1: Write the failing component tests**

Create a jsdom test with the analytics module mocked to expose trackEvent and EVENTS.RESULT_FEEDBACK_SUBMITTED. Stub fetch with a successful JSON response and a failed response. Render the component, open the form, enter text, and click 의견 보내기.

~~~ts
it('tracks only after the feedback API succeeds and strips the body', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));
    // open, fill, submit, await the async act cycle
    expect(trackEvent).toHaveBeenCalledWith('result_feedback_submitted', {
        request_id: requestId,
    });
    expect(JSON.stringify(trackEvent.mock.calls)).not.toContain('사적인 의견');
});

it('does not track when feedback persistence fails', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'failed' }), { status: 500 }));
    // open, fill, submit, await the async act cycle
    expect(trackEvent).not.toHaveBeenCalled();
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run: npm test -- components/result-feedback.test.tsx

Expected: FAIL because the component does not import or call trackEvent.

- [ ] **Step 3: Implement the success-only Amplitude call**

Import trackEvent and EVENTS from @/lib/services/analytics. In the existing response.ok branch, after the response check and before setPhase('sent'), add:

~~~ts
trackEvent(EVENTS.RESULT_FEEDBACK_SUBMITTED, { request_id: requestId });
~~~

Do not pass trimmed, the original body, or the server error payload.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: npm test -- components/result-feedback.test.tsx

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add components/result-feedback.tsx components/result-feedback.test.tsx
git commit -m "feat: track result feedback submissions"
~~~

### Task 5: Add sanitized feedback outcome events to Axiom

**Files:**
- Modify: lib/observability/schema.ts (event and error-code registries)
- Modify: app/api/result-feedback/route.ts (insertResultFeedback handling)
- Modify: lib/services/feedback/result-feedback-route.test.ts

- [ ] **Step 1: Write the failing route assertions**

Mock @/lib/observability/server with operationalLogger.emit and flushOperationalLogs. Configure the existing Supabase owner lookup chain to return the owned request and make insertResultFeedback resolve or reject with ResultFeedbackPersistenceError.

For success, assert:

~~~ts
expect(operationalEmit).toHaveBeenCalledWith({
    event: 'result_feedback.persisted',
    severity: 'info',
    fields: { request_id: requestId },
});
expect(JSON.stringify(operationalEmit.mock.calls)).not.toContain('결과 의견');
~~~

For insert failure, assert a 500 response and:

~~~ts
expect(operationalEmit).toHaveBeenCalledWith({
    event: 'result_feedback.persistence_failed',
    severity: 'error',
    fields: {
        request_id: requestId,
        error_code: 'RESULT_FEEDBACK_INSERT_FAILED',
    },
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run: npm test -- lib/services/feedback/result-feedback-route.test.ts

Expected: FAIL because the event names are not registered and the route emits no specific operational events.

- [ ] **Step 3: Register the event names and error code**

In lib/observability/schema.ts, add to the registries:

~~~ts
'result_feedback.persisted',
'result_feedback.persistence_failed',
~~~

and:

~~~ts
'RESULT_FEEDBACK_INSERT_FAILED',
~~~

Keep request_id and error_code in the existing allowed field list; do not add body, user agent, or user ID fields.

- [ ] **Step 4: Emit from the authoritative insert path and schedule a deferred flush**

In app/api/result-feedback/route.ts, import after from next/server, flushOperationalLogs/operationalLogger, and ResultFeedbackPersistenceError. Add this fail-open helper:

~~~ts
function scheduleFeedbackLogFlush(): void {
    try {
        after(() => flushOperationalLogs());
    } catch {
        void flushOperationalLogs();
    }
}
~~~

Wrap only insertResultFeedback:

~~~ts
try {
    await insertResultFeedback({
        requestId: parsed.data.requestId,
        userId: user.id,
        body,
        userAgent: request.headers.get('user-agent')?.slice(0, 500) || undefined,
    });
} catch (error) {
    operationalLogger.emit({
        event: 'result_feedback.persistence_failed',
        severity: 'error',
        fields: {
            request_id: parsed.data.requestId,
            error_code: error instanceof ResultFeedbackPersistenceError
                ? error.code
                : 'INTERNAL_ERROR',
        },
    });
    scheduleFeedbackLogFlush();
    throw error;
}

operationalLogger.emit({
    event: 'result_feedback.persisted',
    severity: 'info',
    fields: { request_id: parsed.data.requestId },
});
scheduleFeedbackLogFlush();
~~~

Keep the existing generic 500 response and ensure the catch never serializes the body or raw database error. The logger and flush remain fail-open.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: npm test -- lib/services/feedback/result-feedback-route.test.ts lib/observability/schema.test.ts

Expected: PASS, including sanitization of the newly registered events.

- [ ] **Step 6: Commit**

~~~bash
git add lib/observability/schema.ts app/api/result-feedback/route.ts lib/services/feedback/result-feedback-route.test.ts
git commit -m "feat: log result feedback persistence outcomes"
~~~

### Task 6: Full verification and handoff

**Files:**
- Verify all changed files and the committed diff.

- [ ] **Step 1: Run the focused regression suite**

~~~bash
npm test -- \
  lib/services/analytics.test.ts \
  lib/services/amplitude-caller-contract.test.ts \
  lib/services/share/result-actions-gesture-contract.test.ts \
  lib/services/feedback/result-feedback-route.test.ts \
  lib/observability/schema.test.ts \
  components/result-actions.test.tsx \
  components/result-feedback.test.tsx
~~~

Expected: exit code 0 with all selected tests passing.

- [ ] **Step 2: Run lint**

Run: npm run lint

Expected: exit code 0 with no ESLint errors.

- [ ] **Step 3: Run the production build**

Run: npm run build

Expected: exit code 0 and a successful Next.js webpack production build.

- [ ] **Step 4: Inspect the final diff and status**

Run: git diff HEAD~5..HEAD --stat && git status --short

Expected: only the approved analytics, share callback, feedback, observability, test, and plan/design files are changed; no secrets, feedback body, share URL, user-agent, or raw exception payload appears in the diff.
