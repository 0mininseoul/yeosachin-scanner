# Discord Payment Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Send a privacy-safe Discord Embed to thread 1537327100254486611 when a Groble payment is durably accepted, with a transactional outbox and bounded delivery retries.

**Architecture:** An AFTER trigger on earlybird_orders creates one outbox row when an order enters paid, making notification creation atomic with payment finalization. A server-only dispatcher claims rows through Supabase RPCs, reads only the order plan/time and the user name/gender, masks and formats the payload, and posts it using the existing Discord bot token. The Groble route schedules an immediate after() drain for accepted payments; an authenticated cron route provides recovery.

**Tech Stack:** Next.js App Router route handlers, Supabase PostgreSQL migrations/RPCs, Supabase admin client, Discord Bot API v10, Vitest, PGlite.

---

## File Map

- Create: supabase/migrations/20260813160000_add_earlybird_payment_discord_outbox.sql — payment outbox table, paid-transition trigger, claim/complete/reconcile RPCs.
- Create: lib/services/earlybird/payment-discord.ts — server-only configuration, safe payload construction, Discord delivery, and outbox lifecycle calls.
- Create: lib/services/earlybird/payment-discord.test.ts — payload privacy, masking, configuration, delivery, retry, and ambiguous-failure tests.
- Create: lib/services/earlybird/payment-discord-migration-pglite.test.ts — execute the migration against a minimal PGlite schema and verify trigger idempotency and claim lifecycle.
- Create: app/api/internal/earlybird-payment-discord-outbox/route.ts — CRON_SECRET-protected recovery drain.
- Create: lib/services/earlybird/payment-discord-cron-route.test.ts — cron authorization and drain ordering tests.
- Modify: app/api/webhooks/groble/route.ts — schedule payment outbox delivery only for finalization disposition accepted.
- Modify: lib/services/earlybird/groble-webhook-route.test.ts — mock after()/payment dispatcher and assert accepted-only scheduling.
- Modify: .env.example — document non-secret payment Discord toggle/thread settings and shared bot-token reuse.
- Modify: vercel.json — configure the internal route and a bounded recovery cron.
- Create: docs/superpowers/plans/2026-08-13-discord-payment-notification.md — this implementation plan.

## Task 1: Write the failing migration lifecycle test

**Files:**
- Create: lib/services/earlybird/payment-discord-migration-pglite.test.ts
- Reference: supabase/migrations/20260813160000_add_earlybird_payment_discord_outbox.sql

- [ ] **Step 1: Create a minimal PGlite fixture and migration assertions**

Create roles anon, authenticated, and service_role, define public.uuid_generate_v4(), and create only the columns the migration needs:

~~~sql
CREATE TABLE public.users (
    id uuid PRIMARY KEY,
    name varchar(255),
    gender varchar(20)
);
CREATE TABLE public.earlybird_orders (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    plan_id text NOT NULL CHECK (plan_id IN ('basic', 'standard')),
    status text NOT NULL,
    paid_at timestamptz
);
~~~

Load the new migration, then test that:

~~~sql
INSERT INTO public.users (id, name, gender)
VALUES ('123e4567-e89b-42d3-a456-426614174000', '김민수', 'male');
INSERT INTO public.earlybird_orders (id, user_id, plan_id, status)
VALUES ('223e4567-e89b-42d3-a456-426614174000', '123e4567-e89b-42d3-a456-426614174000', 'basic', 'payment_pending');
UPDATE public.earlybird_orders
SET status = 'paid', paid_at = '2026-08-13T00:00:00+09:00'
WHERE id = '223e4567-e89b-42d3-a456-426614174000';
~~~

Assert one outbox row exists, a second paid-to-paid update does not add another row, and a non-paid status does not create one. Claim through claim_earlybird_payment_discord_outbox(10) as service_role and assert the returned fields are only the order ID, claim token, plan, paid time, name, gender, and attempts. Complete the claim as sent and assert the row becomes sent.

- [ ] **Step 2: Run the focused test and verify the failure is caused by the missing migration**

Run:

~~~bash
npm test -- lib/services/earlybird/payment-discord-migration-pglite.test.ts
~~~

Expected: the test fails because 20260813160000_add_earlybird_payment_discord_outbox.sql does not exist yet, before any production implementation is written.

## Task 2: Add the transactional payment Discord outbox

**Files:**
- Create: supabase/migrations/20260813160000_add_earlybird_payment_discord_outbox.sql
- Test: lib/services/earlybird/payment-discord-migration-pglite.test.ts

- [ ] **Step 1: Create the outbox table with no recipient data**

Create public.earlybird_payment_discord_outbox with id, unique order_id, status (pending, sending, sent, failed, ambiguous_failed), bounded attempts, next_attempt_at, claim_token, claimed_at, sent_at, failure_code, and timestamps. Do not add email, phone, buyer name, gender, or payment ID columns. Enable and force RLS, revoke table access from PUBLIC, anon, and authenticated, and grant table access only to service_role as in the existing Kakao Discord outbox migrations.

- [ ] **Step 2: Create the paid-transition trigger**

Add public.enqueue_earlybird_payment_discord_outbox() as a SECURITY DEFINER trigger function with search_path = pg_catalog, public. Insert NEW.id only when NEW.status = 'paid' and the prior status was not 'paid'; use ON CONFLICT (order_id) DO NOTHING. Attach it as an AFTER INSERT OR UPDATE OF status trigger on public.earlybird_orders, replacing any same-name trigger if present.

- [ ] **Step 3: Create the bounded claim RPC**

Define claim_earlybird_payment_discord_outbox(p_limit integer DEFAULT 1) as a service-role-only RPC. Select pending rows whose next_attempt_at is due with FOR UPDATE SKIP LOCKED, cap the limit to 10, update them to sending with a new UUID claim token and incremented attempts, then return:

~~~text
id, order_id, claim_token, plan_id, paid_at, buyer_name, gender, attempts
~~~

Join earlybird_orders and users only for these safe fields. Never select email, phone, payment ID, seller reference, or raw Discord data.

- [ ] **Step 4: Create complete and stale-claim RPCs**

Define complete_earlybird_payment_discord_outbox(p_outbox_id uuid, p_claim_token uuid, p_outcome text, p_failure_code text DEFAULT NULL, p_retry_after_seconds integer DEFAULT 0). Require the row to be sending and the claim token to match. Map sent to sent, bounded retry with attempts below 3 to pending, ambiguous_failed to terminal ambiguous_failed, and all other outcomes to failed.

Define reconcile_stale_earlybird_payment_discord_claims(p_lease_seconds integer DEFAULT 900) to terminalize expired sending claims as ambiguous_failed without issuing a second Discord POST. Revoke all functions from public roles and grant execute only to service_role.

- [ ] **Step 5: Run the PGlite test and verify the migration is green**

Run:

~~~bash
npm test -- lib/services/earlybird/payment-discord-migration-pglite.test.ts
~~~

Expected: all trigger, idempotency, claim, complete, and stale-claim assertions pass.

- [ ] **Step 6: Commit the database boundary**

~~~bash
git add supabase/migrations/20260813160000_add_earlybird_payment_discord_outbox.sql lib/services/earlybird/payment-discord-migration-pglite.test.ts
git commit -m "feat: add transactional payment Discord outbox"
~~~

## Task 3: Write the failing Discord payload and delivery tests

**Files:**
- Create: lib/services/earlybird/payment-discord.test.ts
- Reference: lib/services/identity/kakao-signup-discord.ts

- [ ] **Step 1: Add hoisted Supabase/Sentry mocks and a representative claimed item**

Mock server-only, @/lib/supabase/admin, and @sentry/nextjs exactly as the existing Kakao Discord tests do. Use a claimed item containing:

~~~ts
const ITEM = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    order_id: '223e4567-e89b-42d3-a456-426614174000',
    claim_token: '323e4567-e89b-42d3-a456-426614174000',
    plan_id: 'basic',
    buyer_name: '김민수',
    gender: 'male',
    paid_at: '2026-08-13T00:01:00.000Z',
    attempts: 1,
};
~~~

- [ ] **Step 2: Write payload privacy and formatting tests**

Assert that buildPaymentDiscordPayload(ITEM) creates exactly four fields: 상품명 Basic, 결제자 김*수, 성별 남성, and 2026-08-13 09:01 (KST). Assert allowed_mentions is { parse: [] }, and serialized payload does not contain email, phone, payment_id, or the claim token. Add cases for standard, missing/unknown gender, missing name, one-character name, and Unicode graphemes.

- [ ] **Step 3: Write delivery behavior tests**

Cover these behaviors before implementation:

~~~ts
it('claims once, posts to the configured payment thread, and completes sent', async () => {
    mocks.rpc
        .mockResolvedValueOnce({ data: [ITEM], error: null })
        .mockResolvedValueOnce({ error: null });
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(deliverEarlybirdPaymentDiscordNotifications({ fetcher })).resolves.toBe(1);
    expect(fetcher).toHaveBeenCalledWith(
        'https://discord.com/api/v10/channels/1537327100254486611/messages',
        expect.objectContaining({ method: 'POST' }),
    );
    expect(mocks.rpc).toHaveBeenLastCalledWith(
        'complete_earlybird_payment_discord_outbox',
        expect.objectContaining({ p_outcome: 'sent', p_outbox_id: ITEM.id }),
    );
});
it('does not call Supabase or Discord when payment notifications are disabled or incomplete', async () => {
    vi.stubEnv('PAYMENT_DISCORD_ENABLED', 'false');
    await expect(deliverEarlybirdPaymentDiscordNotifications()).resolves.toBe(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
});
it('retries only a bounded 429 and terminalizes 5xx/network ambiguity', async () => {
    mocks.rpc
        .mockResolvedValueOnce({ data: [ITEM], error: null })
        .mockResolvedValueOnce({ error: null });
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await deliverEarlybirdPaymentDiscordNotifications({ fetcher });
    expect(mocks.rpc).toHaveBeenLastCalledWith(
        'complete_earlybird_payment_discord_outbox',
        expect.objectContaining({
            p_outcome: 'ambiguous_failed',
            p_failure_code: 'DISCORD_5XX_AMBIGUOUS',
        }),
    );
});
it('keeps buyer name, gender, token, and Discord response details out of observability', async () => {
    mocks.rpc
        .mockResolvedValueOnce({ data: [{ ...ITEM, buyer_name: '민감한 구매자' }], error: null })
        .mockResolvedValueOnce({ error: null });
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await deliverEarlybirdPaymentDiscordNotifications({ fetcher });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('민감한 구매자');
    expect(JSON.stringify(mocks.captureMessage.mock.calls)).not.toContain('민감한 구매자');
});
~~~

Use vi.stubEnv for PAYMENT_DISCORD_ENABLED, PAYMENT_DISCORD_THREAD_ID, and the existing KAKAO_SIGNUP_DISCORD_BOT_TOKEN; inject a fetcher so no real Discord request is possible.

- [ ] **Step 4: Run the focused tests and verify they fail for missing implementation**

Run:

~~~bash
npm test -- lib/services/earlybird/payment-discord.test.ts
~~~

Expected: import/behavior failures because payment-discord.ts does not exist yet.

## Task 4: Implement the payment Discord dispatcher

**Files:**
- Create: lib/services/earlybird/payment-discord.ts
- Test: lib/services/earlybird/payment-discord.test.ts

- [ ] **Step 1: Add server-only configuration and safe display helpers**

Implement configuration that returns null unless PAYMENT_DISCORD_ENABLED === 'true', PAYMENT_DISCORD_THREAD_ID is non-empty, and KAKAO_SIGNUP_DISCORD_BOT_TOKEN is non-empty. Reuse maskKakaoName and formatKst from lib/services/identity/kakao-signup-discord.ts. Map only female to 여성 and male to 남성; all other values become 미제공. Map only basic to Basic and standard to Standard; invalid values become 미제공.

- [ ] **Step 2: Implement the exact Embed builder**

Expose buildPaymentDiscordPayload(item) with this shape:

~~~ts
return {
    embeds: [{
        title: '💳 결제가 완료됐어요!',
        color: 0x57F287,
        fields: [
            { name: '🛍️ 상품명', value: productName(item.plan_id), inline: true },
            { name: '👤 결제자', value: maskKakaoName(item.buyer_name) ?? '미제공', inline: true },
            { name: '⚧ 성별', value: displayGender(item.gender), inline: true },
            { name: '📅 결제일시', value: formatKst(new Date(item.paid_at)), inline: false },
        ],
    }],
    allowed_mentions: { parse: [] },
};
~~~

Do not add email, phone, payment ID, or claim token to the payload.

- [ ] **Step 3: Implement claim, POST, and completion lifecycle**

Implement deliverEarlybirdPaymentDiscordNotifications({ limit = 1, fetcher = fetch } = {}) with the same bounded 10-second timeout and at-most-once policy as the existing signup dispatcher:

~~~ts
const { data, error } = await supabaseAdmin.rpc(
    'claim_earlybird_payment_discord_outbox',
    { p_limit: Math.max(1, Math.min(limit, 10)) },
);
~~~

POST to the Discord v10 channel message endpoint using the configured thread ID and Authorization: Bot <botToken>. Complete sent on 2xx, retry only on 429 while attempts remain, and ambiguous_failed on 5xx/timeout/network errors. Read only a bounded retry delay from Discord and never log response bodies.

Also implement reconcileStaleEarlybirdPaymentDiscordClaims() using the matching RPC. Use safe operational error codes under a payment-discord Sentry/console category and never include the claimed item in error data.

- [ ] **Step 4: Run focused tests and verify green**

~~~bash
npm test -- lib/services/earlybird/payment-discord.test.ts
~~~

Expected: all payload, privacy, config, claim, POST, retry, timeout, and observability tests pass.

- [ ] **Step 5: Commit the dispatcher**

~~~bash
git add lib/services/earlybird/payment-discord.ts lib/services/earlybird/payment-discord.test.ts
git commit -m "feat: dispatch payment Discord notifications"
~~~

## Task 5: Connect accepted Groble webhooks to immediate delivery

**Files:**
- Modify: app/api/webhooks/groble/route.ts
- Modify: lib/services/earlybird/groble-webhook-route.test.ts

- [ ] **Step 1: Add a failing accepted-only scheduling test**

Mock next/server while preserving NextResponse, replacing after with a spy that records the callback. Mock deliverEarlybirdPaymentDiscordNotifications. Add assertions that a finalizer result of accepted calls after() once, while the existing table-driven duplicate_event, mismatch, cancel, refund, and other non-accepted cases do not call it.

The test must also assert that buyer email, phone, payment ID, seller reference, and product ID do not enter the scheduled delivery arguments or observability output.

- [ ] **Step 2: Run the route test and verify it fails**

~~~bash
npm test -- lib/services/earlybird/groble-webhook-route.test.ts
~~~

Expected: the accepted-only scheduling assertion fails because the route does not yet import or schedule the payment dispatcher.

- [ ] **Step 3: Schedule a best-effort post-response drain**

Import after from next/server and deliverEarlybirdPaymentDiscordNotifications from the new module. After the finalization schema is parsed, add:

~~~ts
if (finalization.disposition === 'accepted') {
    const deliver = async () => {
        await deliverEarlybirdPaymentDiscordNotifications({ limit: 10 }).catch(() => undefined);
    };
    try {
        after(deliver);
    } catch {
        void deliver();
    }
}
~~~

Do not call the dispatcher for duplicate or rejected dispositions, and do not make Discord delivery failure change the already-successful webhook response.

- [ ] **Step 4: Run the route test and verify green**

~~~bash
npm test -- lib/services/earlybird/groble-webhook-route.test.ts
~~~

Expected: existing Groble webhook behavior remains green and only accepted payments schedule delivery.

## Task 6: Add cron recovery and production configuration

**Files:**
- Create: app/api/internal/earlybird-payment-discord-outbox/route.ts
- Create: lib/services/earlybird/payment-discord-cron-route.test.ts
- Modify: .env.example
- Modify: vercel.json

- [ ] **Step 1: Write the failing cron route test**

Mock the two dispatcher functions and assert missing/wrong Authorization: Bearer $CRON_SECRET returns 401 without claiming. Assert the valid header calls reconciliation before delivery with { limit: 10 } and returns { claimed, reconciled } without recipient data.

- [ ] **Step 2: Run the focused cron test and verify it fails**

~~~bash
npm test -- lib/services/earlybird/payment-discord-cron-route.test.ts
~~~

Expected: import failure because the route does not exist.

- [ ] **Step 3: Implement the authenticated route**

Use runtime = 'nodejs'. Match the existing Kakao cron authorization exactly:

~~~ts
const expected = process.env.CRON_SECRET;
if (!expected || request.headers.get('authorization') !== 'Bearer ' + expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
const reconciled = await reconcileStaleEarlybirdPaymentDiscordClaims();
const claimed = await deliverEarlybirdPaymentDiscordNotifications({ limit: 10 });
return NextResponse.json({ claimed, reconciled });
~~~

- [ ] **Step 4: Add non-secret env and Vercel entries**

Add to .env.example near the Kakao Discord settings:

~~~dotenv
# Groble accepted-payment Discord alert (server-only; reuses KAKAO_SIGNUP_DISCORD_BOT_TOKEN)
PAYMENT_DISCORD_ENABLED=false
PAYMENT_DISCORD_THREAD_ID=1537327100254486611
~~~

Add the new route with maxDuration: 60 under functions, and add a five-minute recovery cron entry:

~~~json
{
    "path": "/api/internal/earlybird-payment-discord-outbox",
    "schedule": "*/5 * * * *"
}
~~~

Do not read, print, or commit any local or Vercel secret value.

- [ ] **Step 5: Run focused cron tests and verify green**

~~~bash
npm test -- lib/services/earlybird/payment-discord-cron-route.test.ts
~~~

Expected: authorization, reconciliation ordering, response-shape, and no-recipient-data assertions pass.

- [ ] **Step 6: Commit the integration and configuration**

~~~bash
git add app/api/webhooks/groble/route.ts lib/services/earlybird/groble-webhook-route.test.ts app/api/internal/earlybird-payment-discord-outbox/route.ts lib/services/earlybird/payment-discord-cron-route.test.ts .env.example vercel.json
git commit -m "feat: wire accepted payments to Discord thread"
~~~

## Task 7: Run full verification and prepare the PR

**Files:**
- Verify all changed files and the approved design/plan documents.

- [ ] **Step 1: Run all targeted tests together**

~~~bash
npm test -- \
    lib/services/earlybird/payment-discord-migration-pglite.test.ts \
    lib/services/earlybird/payment-discord.test.ts \
    lib/services/earlybird/payment-discord-cron-route.test.ts \
    lib/services/earlybird/groble-webhook-route.test.ts
~~~

Expected: exit code 0 with zero failed tests.

- [ ] **Step 2: Run the complete test suite**

~~~bash
npm test
~~~

Expected: exit code 0 with zero failed tests.

- [ ] **Step 3: Run lint and production build**

~~~bash
npm run lint
npm run build
~~~

Expected: both commands exit 0 without introducing warnings/errors attributable to this change.

- [ ] **Step 4: Inspect the final diff for privacy and scope**

~~~bash
git diff --check
git status --short
git diff --stat
git diff -- .env.example app/api/webhooks/groble/route.ts lib/services/earlybird/payment-discord.ts supabase/migrations/20260813160000_add_earlybird_payment_discord_outbox.sql vercel.json
~~~

Confirm that no email, phone, payment ID, token value, user UUID, or unrelated landing copy appears in the Discord payload, logs, migration outbox columns, or staged diff.

- [ ] **Step 5: Commit any final test-only or documentation adjustment**

~~~bash
git add docs/superpowers/plans/2026-08-13-discord-payment-notification.md
git commit -m "docs: record payment Discord implementation plan"
~~~

- [ ] **Step 6: Push and open a draft PR**

~~~bash
git push -u origin 0mininseoul/discord-payment-notification-thread
gh pr create --draft --title "feat: send accepted Groble payments to Discord" --body-file /tmp/discord-payment-notification-pr-body.md
~~~

The PR body must state that accepted Groble payments now create a transactional Discord outbox, that only masked name/product/time/gender are sent, that the existing bot token is reused, and list the exact test/lint/build commands and results. Mention the required production settings PAYMENT_DISCORD_ENABLED=true and PAYMENT_DISCORD_THREAD_ID=1537327100254486611; do not include any secret value.
