# Groble Earlybird Presale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **[중요: 폐기된 기한 안내]** 이 계획서는 판독 결과 제공 기한을 결제 완료 후 **48시간**
> (`earlybird-48h-v1` 고지 버전, `due_at = paid_at + interval '48 hours'`)으로 지시하고 있으나,
> 이후 **폐기(superseded)** 되었다. 현재는 결제 완료 후 **24시간**이며, 고지 버전도
> `earlybird-24h-v1`로 이름이 바뀌었다 —
> `supabase/migrations/20260720100000_shorten_earlybird_delivery_window.sql` 기준. 아래
> 본문의 48시간 관련 지시는 폐기된 설계이므로 그대로 따르지 말 것.

**Goal:** Complete a secure, owner-scoped Groble earlybird presale flow for Basic and Standard, with Plus waitlisting and no automatic analysis dispatch.

**Architecture:** A server-owned earlybird catalog prices preflight snapshots and validates checkout requests. Groble redirects are preceded by a durable pending order; signed `payment.completed` webhooks are finalized by a service-role-only Postgres RPC that serializes payment IDs and plan inventory, while signed cancellation requests enter refund review through a separate RPC. Owner status reads and manual fulfillment remain isolated from `analysis_requests` and Cloud Tasks.

**Tech Stack:** Next.js 16 App Router, TypeScript, Zod, Supabase/Postgres RLS and SECURITY DEFINER RPCs, Vitest, PGlite.

---

### Task 1: Server-owned earlybird and Groble contracts

**Files:**
- Create: `lib/domain/earlybird/catalog.ts`
- Create: `lib/domain/earlybird/catalog.test.ts`
- Create: `lib/services/groble/config.ts`
- Create: `lib/services/groble/config.test.ts`
- Create: `lib/services/groble/webhook.ts`
- Create: `lib/services/groble/webhook.test.ts`
- Modify: `lib/domain/analysis/plan-catalog.ts`
- Modify: `lib/domain/analysis/plan-catalog.test.ts`

- [ ] **Step 1: Write failing catalog tests**

Assert `earlybird-2026-07-v1`, Basic `39900/14900/10`, Standard `69900/19900/10`, Plus waitlist-only, and the exact `earlybird-48h-v1` disclosure text.

- [ ] **Step 2: Verify catalog tests fail**

Run: `npm test -- lib/domain/earlybird/catalog.test.ts lib/domain/analysis/plan-catalog.test.ts`

Expected: FAIL because the earlybird catalog does not exist and analysis pricing is deferred.

- [ ] **Step 3: Implement the immutable catalog**

Export `EARLYBIRD_PRICING_VERSION`, `EARLYBIRD_DISCLOSURE_VERSION`, `EARLYBIRD_DISCLOSURE_TEXT`, `EARLYBIRD_PLAN_CATALOG`, and strict plan helpers. Change the analysis catalog to `production` launch status with quoted Basic/Standard prices and a deferred Plus price while retaining server-owned capacities. This enables preflight and purchase selection only; it does not dispatch analysis.

- [ ] **Step 4: Write and run failing Groble configuration and signature tests**

Cover missing product IDs/payment addresses/secrets, invalid values, URL generation, HMAC-SHA256 raw-body verification, previous-secret rotation, constant-time comparison, ±5 minute timestamp rejection, and strict `payment.completed` parsing.

Run: `npm test -- lib/services/groble/config.test.ts lib/services/groble/webhook.test.ts`

Expected: FAIL because the Groble modules do not exist.

- [ ] **Step 5: Implement Groble server modules and verify green**

Build checkout URLs as `https://groble.im/payment/${encodeURIComponent(paymentAddress)}` from the plan-specific payment-address variables. Keep `GROBLE_BASIC_PRODUCT_ID` and `GROBLE_STANDARD_PRODUCT_ID` separate for webhook `content.id` validation. Verify `X-Groble-Signature`, optional previous signature, timestamp, event ID, merchant UID, `PAYMENT_WINDOW`, `ONE_TIME`, product ID, buyer email, KRW final amount, and purchased timestamp.

Run: `npm test -- lib/domain/earlybird/catalog.test.ts lib/domain/analysis/plan-catalog.test.ts lib/services/groble/config.test.ts lib/services/groble/webhook.test.ts`

Expected: PASS.

### Task 2: Forward migration, RLS, inventory, and atomic finalization

**Files:**
- Create with CLI: `supabase/migrations/20260717140000_add_groble_earlybird_presale.sql`
- Create: `lib/services/earlybird/earlybird-migration-contract.test.ts`
- Create: `lib/services/earlybird/earlybird-pglite.test.ts`

- [x] **Step 1: Generate an empty forward migration**

Run: `npx supabase migration new add_groble_earlybird_presale`

Result: created `supabase/migrations/20260717140000_add_groble_earlybird_presale.sql`.

- [ ] **Step 2: Write failing migration contract tests**

Assert the migration creates `earlybird_orders`, `earlybird_plan_inventory`, `earlybird_webhook_events`, `earlybird_waitlist`; enables RLS; adds owner-only select policies; revokes mutations and RPC execution; grants only service role RPC execution; gives `payment_id` a UNIQUE constraint; and contains no automatic analysis or task dispatch.

Run: `npm test -- lib/services/earlybird/earlybird-migration-contract.test.ts`

Expected: FAIL against the empty migration.

- [ ] **Step 3: Write failing PGlite behavior tests**

Bootstrap the existing user, preflight, and analysis request boundaries, apply the migration, and prove:

- Standard-required preflight rejects Basic checkout.
- Plus creates a waitlist row and no order.
- Duplicate webhook event/payment IDs replay one order.
- Concurrent Basic confirmations yield sequences 1 through 10 and isolate the 11th as `overflow_refund_required`.
- Concurrent Standard confirmations do the same independently.
- Basic and Standard inventory and sequences do not affect one another.
- Product or amount mismatch produces `payment_failed` without inventory consumption.
- Accepted orders calculate `due_at = paid_at + interval '48 hours'`.
- Finalization creates zero `analysis_requests` and zero pipeline jobs.
- Authenticated owner reads only their own order; non-owner reads none.

Run: `npm test -- lib/services/earlybird/earlybird-pglite.test.ts`

Expected: FAIL because tables and RPCs do not exist.

- [ ] **Step 4: Implement the migration**

Use `timestamptz`, integer KRW amounts, text status check constraints, indexed foreign keys and owner/status/product lookup indexes. Add service-only `create_earlybird_checkout`, `join_earlybird_waitlist`, and `finalize_earlybird_groble_payment` functions with `SECURITY DEFINER SET search_path = ''`. Lock the payment advisory key, pending order, and one plan inventory row in that order.

- [ ] **Step 5: Verify migration tests green**

Run: `npm test -- lib/services/earlybird/earlybird-migration-contract.test.ts lib/services/earlybird/earlybird-pglite.test.ts`

Expected: PASS, including both 11-payment concurrency cases.

### Task 3: Checkout and waitlist server APIs

**Files:**
- Create: `lib/services/earlybird/contracts.ts`
- Create: `lib/services/earlybird/store.ts`
- Create: `lib/services/earlybird/checkout.ts`
- Create: `lib/services/earlybird/checkout-route.test.ts`
- Create: `app/api/earlybird/checkout/route.ts`
- Create: `app/api/earlybird/waitlist/route.ts`

- [ ] **Step 1: Write failing route tests**

Exercise unauthenticated requests, invalid consent, stale/non-owner/non-ready preflights, Standard-required Basic blocking, Plus checkout blocking, Plus waitlist creation, and idempotent checkout replay. Assert client prices and counts are ignored and no task dispatcher is imported or called.

Run: `npm test -- lib/services/earlybird/checkout-route.test.ts`

Expected: FAIL because routes do not exist.

- [ ] **Step 2: Implement strict contracts and store**

Accept only `{preflightId, planId, disclosureAccepted}`. Use the authenticated server client for identity and the admin client only for the service-role RPC. Return `{orderId, checkoutUrl}` for Basic/Standard and `{waitlistId, status:'waitlisted'}` for Plus.

- [ ] **Step 3: Implement routes and verify green**

Map domain failures to bounded 400/401/404/409/410/503 JSON responses without logging email, product ID, signatures, or tokens.

Run: `npm test -- lib/services/earlybird/checkout-route.test.ts`

Expected: PASS.

### Task 4: Signed Groble webhook route

**Files:**
- Create: `app/api/webhooks/groble/route.ts`
- Create: `lib/services/earlybird/groble-webhook-route.test.ts`

- [ ] **Step 1: Write failing webhook route tests**

Cover bad content type, missing/invalid/stale signatures, malformed payload, non-payment events, product/amount mismatch, valid Basic and Standard payments, duplicate webhook idempotency, and sanitized logging. Assert no `analysis_requests`, Cloud Tasks, or V2 dispatcher dependency is invoked.

Run: `npm test -- lib/services/earlybird/groble-webhook-route.test.ts`

Expected: FAIL because the webhook route does not exist.

- [ ] **Step 2: Implement verify-before-parse webhook processing**

Read `request.text()` once, validate Groble headers and raw HMAC, parse the strict event, map only configured product IDs to Basic/Standard, and call `finalize_earlybird_groble_payment`. Return a fast 200 for processed, duplicate, unmatched, mismatch, and overflow dispositions; return bounded 4xx only for permanently invalid requests.

- [ ] **Step 3: Verify route tests green**

Run: `npm test -- lib/services/earlybird/groble-webhook-route.test.ts`

Expected: PASS.

### Task 5: Owner status restoration and safe result link

**Files:**
- Create: `app/api/earlybird/orders/latest/route.ts`
- Create: `lib/services/earlybird/order-status.ts`
- Create: `lib/services/earlybird/order-status-route.test.ts`
- Create: `app/earlybird/page.tsx`
- Create: `app/earlybird/earlybird-status.tsx`
- Modify: `proxy.ts`

- [ ] **Step 1: Write failing owner status tests**

Prove unauthenticated and non-owner reads are blocked, DTOs omit raw webhook/buyer/card data, plan query filters safely, timestamps and plan sequence survive refresh, and a result link appears only when the referenced `analysis_requests.user_id` matches the order owner.

Run: `npm test -- lib/services/earlybird/order-status-route.test.ts`

Expected: FAIL because the status API does not exist.

- [ ] **Step 2: Implement owner-safe status projection**

Return target username, plan, actual amount, paid/created time, due time, plan sequence, mapped display status, and optional `/result/{requestId}` only. Add `/earlybird` to protected routes.

- [ ] **Step 3: Implement the status page and verify green**

Render payment confirmation, queued, in-progress, complete, and exceptional states using existing case UI. Do not add a new refund policy sentence.

Run: `npm test -- lib/services/earlybird/order-status-route.test.ts`

Expected: PASS.

### Task 6: Analyze-page purchase UI and durable return path

**Files:**
- Modify: `app/analyze/page.tsx`
- Create: `lib/services/earlybird/ui-state.ts`
- Create: `lib/services/earlybird/ui-state.test.ts`

- [ ] **Step 1: Write failing UI-state tests**

Assert deep-link plan selection from `?plan=basic|standard`, exact required disclosure text, checkout disabled until consent, quoted/reference price formatting, Standard-required Basic disabled, Plus waitlist behavior, and the banned phrases absent.

Run: `npm test -- lib/services/earlybird/ui-state.test.ts`

Expected: FAIL because the earlybird UI state module does not exist.

- [ ] **Step 2: Implement pure UI state and page integration**

Replace test-entitlement gating with Basic/Standard checkout and Plus waitlist actions. POST the preflight ID and selected plan, then navigate in the same tab to the server-returned Groble URL. Preserve existing fixed marketing copy outside the plan purchase section.

- [ ] **Step 3: Verify UI tests green**

Run: `npm test -- lib/services/earlybird/ui-state.test.ts`

Expected: PASS.

### Task 7: Environment and operational handoff

**Files:**
- Modify: `.env.example`
- Create: `docs/groble-earlybird-operations.md`

- [ ] **Step 1: Add environment contracts**

Document server-only product IDs, plan-specific payment addresses, `GROBLE_WEBHOOK_SECRET`, and optional `GROBLE_WEBHOOK_PREVIOUS_SECRET`. Do not commit real values and do not prefix them with `NEXT_PUBLIC_`.

- [ ] **Step 2: Add operator URLs and rollout steps**

Document the exact Basic/Standard entry and movement URLs, `사전 구매 현황 확인` movement button text, webhook URL, subscribed payment and cancellation events, environment setup, migration-before-code deployment order, Groble dashboard stock retention, and the explicit prohibition on deploying or running a real payment without approval.

- [ ] **Step 3: Run documentation and copy checks**

Run: `npm test -- lib/services/earlybird/ui-state.test.ts`

Expected: the earlybird implementation and operations guide use only the approved presale wording.

### Task 8: Full verification, independent review, and PR

**Files:**
- Review all changed files.

- [ ] **Step 1: Run focused tests**

Run: `npm test -- lib/domain/earlybird lib/services/groble lib/services/earlybird`

Expected: all focused tests pass.

- [ ] **Step 2: Run static and full verification**

Run: `npx tsc --noEmit && npm run lint && npm test && npm run build`

Expected: all commands exit 0; only explicitly existing skipped smoke tests remain skipped.

- [ ] **Step 3: Validate database migration locally**

Run: `npx supabase db lint --local` when the local stack is available, plus `npx supabase migration list --local`. If Docker/local Supabase is unavailable, report that limitation and rely on the PGlite migration suite without deploying remotely.

- [ ] **Step 4: Request an independent code review**

Provide the reviewer with the base SHA, head SHA, this plan, and the full user requirements. Fix all Critical and Important findings and rerun affected verification.

- [ ] **Step 5: Push and open a PR**

Push `feat/groble-reservation-payment` and create a PR against `main` containing the architecture summary, security controls, exact verification evidence, migration/rollout order, and an explicit note that production deployment and real payment testing were not performed.
