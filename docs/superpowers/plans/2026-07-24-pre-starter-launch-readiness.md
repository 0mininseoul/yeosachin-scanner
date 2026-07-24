# Pre-Starter Launch Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept and measure genuine Basic/Standard early-bird payments safely, prepare operator-controlled fulfillment and deployment-wide AI concurrency controls, and stop immediately before purchasing or selecting the Apify Secondary Starter plan.

**Architecture:** Groble `sellerReference` binds a signed payment webhook to one opaque server-issued order reference, while legacy phone/email matching remains a fallback for already-issued links. A service-role-only aggregate reports only reference-confirmed commercial demand and fulfillment liabilities. Paid-order fulfillment is represented by a durable outbox that the webhook never dispatches directly; an operator must explicitly admit work, and every Gemini generation must hold one of eight database-fenced leases across all revisions.

**Tech Stack:** Next.js 16, TypeScript, Zod, Supabase/PostgreSQL, Cloud Tasks, Cloud Run, Groble webhook API, Vitest, PGlite.

---

## Scope and ordering

This roadmap is intentionally split into independently reviewable slices:

1. **Commercial evidence:** exact Groble order references, discounted late-cancel correction, and a PII-free demand report.
2. **Execution safety:** eight deployment-wide fenced Gemini leases.
3. **Fulfillment readiness:** operator-approved paid-order outbox and recovery, with automatic webhook dispatch still disabled.
4. **Decision evidence:** measured cost/readiness documentation and a read-only pre-Starter production audit.

The following are explicitly outside this plan:

- purchasing or activating an Apify Starter subscription;
- changing `APIFY_SECONDARY_API_TOKEN` or any production credential selection;
- enabling public automatic analysis admission;
- making Plus purchasable;
- changing the current Basic/Standard early-bird amounts;
- treating a test, manual reconciliation, unmatched webhook, checkout redirect, or Amplitude event as paid demand.

## File map

- `lib/services/earlybird/seller-reference.ts`: validates the opaque Groble reference format and constructs a checkout URL without exposing buyer data.
- `lib/services/earlybird/demand-report.ts`: strict schema and sanitized demand-summary adapter.
- `scripts/report-earlybird-demand.ts`: operator CLI that prints aggregate commercial evidence only.
- `lib/services/analysis/v2-gemini-lease-store.ts`: acquire, renew, release, and quarantine adapter for eight database slots.
- `lib/services/earlybird/fulfillment-store.ts`: durable paid-order outbox adapter.
- `scripts/fulfill-earlybird-order.ts`: explicit operator admission/replay command; it never accepts a target username or buyer contact.
- Three append-only migrations: commercial evidence, Gemini leases, and fulfillment outbox.
- Existing Groble, worker, observability, and operations documents are updated at their owning boundaries.

### Task 1: Bind Groble completion to one opaque order reference

**Files:**
- Create: `lib/services/earlybird/seller-reference.ts`
- Create: `lib/services/earlybird/seller-reference.test.ts`
- Modify: `lib/services/groble/config.ts`
- Modify: `lib/services/groble/config.test.ts`
- Modify: `lib/services/groble/webhook.ts`
- Modify: `lib/services/groble/webhook.test.ts`
- Modify: `lib/services/earlybird/store.ts`
- Modify: `lib/services/earlybird/checkout.ts`
- Modify: `lib/services/earlybird/checkout-route.test.ts`
- Modify: `app/api/webhooks/groble/route.ts`
- Modify: `lib/services/earlybird/groble-webhook-route.test.ts`
- Create: `supabase/migrations/20260724123000_add_groble_seller_reference.sql`
- Create: `lib/services/earlybird/groble-seller-reference-migration-contract.test.ts`
- Create: `lib/services/earlybird/groble-seller-reference-pglite.test.ts`

- [x] **Step 1: Write failing pure reference tests**

The accepted application reference is an opaque 128-bit database-issued token:

```ts
export const GROBLE_SELLER_REFERENCE_PATTERN = /^ord\.[a-f0-9]{32}$/;

export function parseGrobleSellerReference(value: unknown): string | null {
    return typeof value === 'string' && GROBLE_SELLER_REFERENCE_PATTERN.test(value)
        ? value
        : null;
}
```

Test exact length, lowercase hexadecimal, forbidden buyer identifiers, whitespace, and every character rejected by Groble's `^[A-Za-z0-9\-_.:=~]{1,128}$` boundary.

Run: `npm test -- lib/services/earlybird/seller-reference.test.ts`

Expected: FAIL because the module does not exist.

- [x] **Step 2: Generate the migration file with the Supabase CLI**

Run:

```bash
npx supabase migration new add_groble_seller_reference
```

Result: `supabase/migrations/20260724123000_add_groble_seller_reference.sql` was generated, then ordered after the current remote migration head.

- [x] **Step 3: Write failing migration contract and PGlite tests**

The migration must add private columns without expanding authenticated grants:

```sql
ALTER TABLE public.earlybird_orders
    ADD COLUMN groble_seller_reference TEXT,
    ADD COLUMN seller_reference_confirmed_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.earlybird_orders
    ADD CONSTRAINT earlybird_orders_seller_reference_check
    CHECK (
        groble_seller_reference IS NULL
        OR groble_seller_reference ~ '^ord\.[a-f0-9]{32}$'
    ) NOT VALID;

CREATE UNIQUE INDEX earlybird_orders_seller_reference_unique
    ON public.earlybird_orders(groble_seller_reference)
    WHERE groble_seller_reference IS NOT NULL;
```

Create service-role-only `issue_earlybird_groble_seller_reference(UUID)` which serializes the order, issues `ord.` plus a dashless `gen_random_uuid()`, and replays the same value. Create service-role-only `finalize_earlybird_groble_payment_by_reference(...)` which resolves the reference, delegates to the current canonical finalizer, requires the returned order to be the referenced order, and stamps `seller_reference_confirmed_at` only for the matched paid order. Revoke `PUBLIC`, `anon`, and `authenticated` from both functions before granting `service_role`.

The PGlite tests must prove:

- concurrent issuance returns one stable reference;
- a forged, missing, wrong-product, wrong-order, or test reference does not consume inventory;
- accepted and idempotently replayed payments resolve the same order;
- no raw buyer contact or reference is granted to `authenticated`;
- legacy links with no reference still use the existing canonical path.

Run:

```bash
npm test -- \
  lib/services/earlybird/groble-seller-reference-migration-contract.test.ts \
  lib/services/earlybird/groble-seller-reference-pglite.test.ts
```

Expected: FAIL until the migration exists.

- [x] **Step 4: Implement checkout issuance and URL propagation**

`earlybirdStore.createCheckout` calls `issue_earlybird_groble_seller_reference` after the idempotent checkout RPC and returns:

```ts
{
    orderId: string;
    created: boolean;
    sellerReference: string;
}
```

`getGrobleCheckoutUrl` takes that reference and returns:

```ts
const url = new URL(`https://groble.im/payment/${encodeURIComponent(address)}`);
url.searchParams.set('ref', sellerReference);
return url.toString();
```

The opaque reference appears only inside the one-time Groble checkout URL. No separate browser DTO field, operational log, Amplitude event, or owner status response includes it.

- [x] **Step 5: Parse and finalize reference-bearing webhooks**

Extend the `payment.completed` object schema with the strict application pattern:

```ts
sellerReference: z.string().regex(GROBLE_SELLER_REFERENCE_PATTERN).optional()
```

Return `sellerReference: string | null` from the parser. A present but malformed reference rejects the signed completion payload; it never falls through to phone/email matching. The route calls the reference-aware RPC when the reference is present and keeps the legacy canonical path only when the field is absent. Cancellation continues to match the persisted `merchantUid`, because Groble omits `sellerReference` from cancellation events.

- [x] **Step 6: Verify Task 1**

Run:

```bash
npm test -- \
  lib/services/earlybird/seller-reference.test.ts \
  lib/services/groble/config.test.ts \
  lib/services/groble/webhook.test.ts \
  lib/services/earlybird/checkout-route.test.ts \
  lib/services/earlybird/groble-webhook-route.test.ts \
  lib/services/earlybird/groble-seller-reference-migration-contract.test.ts \
  lib/services/earlybird/groble-seller-reference-pglite.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [x] **Step 7: Commit Task 1**

```bash
git add app/api/webhooks/groble lib/services/earlybird lib/services/groble \
  supabase/migrations
git commit -m "feat: bind Groble payments to opaque order references"
```

### Task 2: Correct discounted late-cancel reattribution

**Files:**
- Create: `supabase/migrations/20260724123100_fix_discounted_late_cancelled_payment.sql`
- Modify: `lib/services/earlybird/groble-phone-pglite.test.ts`
- Create: `lib/services/earlybird/discounted-late-cancel-migration-contract.test.ts`
- Modify: `docs/groble-earlybird-operations.md`

- [x] **Step 1: Add failing regression cases**

For canonical and rolling-compatibility overloads, create a cancelled order with `expected_amount_krw = 19_900`, then finalize a late payment of `9_900` and `0`. Both must produce:

```ts
{
    disposition: 'late_cancelled_payment',
    status: 'refund_pending',
}
```

An amount above `19_900`, a wrong product, or multiple eligible legacy candidates must remain rejected or ambiguous without consuming inventory.

Run: `npm test -- lib/services/earlybird/groble-phone-pglite.test.ts`

Expected: FAIL on discounted late payments.

- [x] **Step 2: Implement the generated forward migration**

The CLI-generated file is `supabase/migrations/20260724123100_fix_discounted_late_cancelled_payment.sql`. In both active payment-finalizer overloads, replace only the late-cancel disambiguation equality with:

```sql
cancelled_order.expected_amount_krw >= p_amount_krw
AND p_amount_krw >= 0
```

Retain product, buyer-match, lock ordering, duplicate-payment, cancellation, and inventory behavior exactly.

- [x] **Step 3: Verify and commit Task 2**

Run:

```bash
npm test -- \
  lib/services/earlybird/groble-phone-pglite.test.ts \
  lib/services/earlybird/discounted-late-cancel-migration-contract.test.ts
npx tsc --noEmit
```

Expected: PASS.

```bash
git add supabase/migrations lib/services/earlybird docs/groble-earlybird-operations.md
git commit -m "fix: reattribute discounted late Groble payments"
```

### Task 3: Produce a PII-free commercial demand report

**Files:**
- Add to Task 1 migration: `load_earlybird_demand_summary(DATE, DATE)`
- Create: `lib/services/earlybird/demand-report.ts`
- Create: `lib/services/earlybird/demand-report.test.ts`
- Create: `scripts/report-earlybird-demand.ts`
- Create: `scripts/report-earlybird-demand.test.ts`
- Modify: `package.json`
- Modify: `docs/groble-earlybird-operations.md`

- [x] **Step 1: Write failing schema and option tests**

The public TypeScript result is aggregate-only:

```ts
type EarlybirdDemandSummary = Readonly<{
    startDate: string;
    endDateExclusive: string;
    referenceConfirmedPaymentCount: number;
    referenceConfirmedGrossKrw: number;
    unconfirmedPaidOrderCount: number;
    refundLiabilityCount: number;
    overdueFulfillmentCount: number;
    pendingCheckoutCount: number;
    plusWaitlistCount: number;
    plans: readonly Readonly<{
        planId: 'basic' | 'standard';
        confirmedPaymentCount: number;
        confirmedGrossKrw: number;
        remainingSlots: number;
    }>[];
}>;
```

Reject unknown fields, negative counts, invalid dates, ranges over 90 days, usernames, buyer contacts, order IDs, payment IDs, webhook IDs, references, and provider identifiers.

Run:

```bash
npm test -- \
  lib/services/earlybird/demand-report.test.ts \
  scripts/report-earlybird-demand.test.ts
```

Expected: FAIL because the modules do not exist.

- [x] **Step 2: Implement the service-role aggregate**

`load_earlybird_demand_summary` counts commercial demand only when all are true:

```sql
order_row.status IN ('paid', 'analysis_in_progress', 'completed')
AND order_row.actual_amount_krw IS NOT NULL
AND order_row.payment_id IS NOT NULL
AND order_row.seller_reference_confirmed_at IS NOT NULL
AND order_row.paid_at >= p_start_date
AND order_row.paid_at < p_end_date_exclusive
```

Manual reconciliation, test sends, legacy/unreferenced paid rows, redirects, and client analytics never enter the confirmed count. They remain visible only as aggregate `unconfirmedPaidOrderCount`.

The function is `STABLE`, `SECURITY DEFINER`, uses `SET search_path = ''`, validates a maximum 90-day range, revokes all default execution, and grants only `service_role`.

- [x] **Step 3: Implement the CLI**

Add:

```json
"report:earlybird-demand": "tsx --env-file=.env.local scripts/report-earlybird-demand.ts"
```

Usage:

```bash
npm run report:earlybird-demand -- --start 2026-07-24 --end 2026-08-01
```

The command calls only the aggregate RPC, prints stable JSON, never prints environment variables, and exits nonzero when unconfirmed paid orders or overdue fulfillments require review. A confirmed count is evidence for the owner's Starter decision, not automatic authorization to purchase or rotate credentials.

- [x] **Step 4: Verify and commit Task 3**

Run:

```bash
npm test -- \
  lib/services/earlybird/demand-report.test.ts \
  scripts/report-earlybird-demand.test.ts \
  lib/services/earlybird/groble-seller-reference-pglite.test.ts
npx tsc --noEmit
```

Expected: PASS.

```bash
git add lib/services/earlybird scripts/report-earlybird-demand* \
  package.json docs/groble-earlybird-operations.md supabase/migrations
git commit -m "feat: report reference-confirmed earlybird demand"
```

### Task 4: Add eight deployment-wide fenced Gemini leases

**Files:**
- Create: `supabase/migrations/20260724123200_add_analysis_v2_gemini_leases.sql`
- Create: `lib/services/analysis/v2-gemini-lease-store.ts`
- Create: `lib/services/analysis/v2-gemini-lease-store.test.ts`
- Create: `lib/services/analysis/v2-gemini-lease-migration-contract.test.ts`
- Create: `lib/services/analysis/v2-gemini-lease-pglite.test.ts`
- Modify: `lib/services/analysis/v2-ai-result-store.ts`
- Modify: `lib/services/analysis/v2-ai-result-store.test.ts`
- Modify: `lib/services/ai/gemini.ts`
- Modify: `lib/services/ai/gemini.test.ts`
- Modify: `lib/services/ai/stage-policy.ts`
- Modify: `lib/services/ai/stage-policy.test.ts`
- Modify: `lib/services/analysis/v2-worker.ts`
- Modify: `lib/services/analysis/v2-worker.test.ts`
- Modify: `lib/services/analysis/v2-job-store.ts`
- Modify: `lib/services/analysis/v2-job-store.test.ts`
- Modify: `lib/services/analysis/v2-worker-error-codes.ts`
- Modify: `lib/services/analysis/v2-worker-error-codes.test.ts`
- Modify: `app/api/analysis/v2/worker/route.ts`
- Modify: `lib/services/analysis/v2-worker-route.test.ts`
- Modify: `docs/operations-cost-model.md`

- [x] **Step 1: Write failing store, migration, and PGlite tests**

Create eight fixed slots numbered 1 through 8. Each acquisition returns a random claim token and monotonically increasing fence. A lease belongs to one request/job/attempt, expires within a bounded interval, and cannot be released by a stale token or fence. An ambiguous acquisition quarantines the slot rather than assuming it is free.

Run:

```bash
npm test -- \
  lib/services/analysis/v2-gemini-lease-store.test.ts \
  lib/services/analysis/v2-gemini-lease-migration-contract.test.ts \
  lib/services/analysis/v2-gemini-lease-pglite.test.ts
```

Expected: FAIL because the lease boundary does not exist.

- [x] **Step 2: Implement the generated lease migration**

The CLI-generated file is `supabase/migrations/20260724123200_add_analysis_v2_gemini_leases.sql`. It creates eight rows and service-role-only acquire/renew/release functions. A DB-owner-only quarantine-resolution function requires an audited evidence hash. Every function uses an empty search path, bounded inputs, revoked default execution, and stable lock ordering.

- [x] **Step 3: Fence every paid SDK attempt**

The pre-attempt hook acquires a database lease before reserving a Gemini attempt. The SDK receives one hard timeout and one SDK invocation. Durable attempt terminalization happens before lease release. The only nonterminal pre-SDK signals are:

```ts
'ANALYSIS_V2_AI_CAPACITY_PENDING'
'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT'
'ANALYSIS_V2_AI_QUARANTINE_ACTIVE'
```

No signal creates fabricated attempt usage.

- [x] **Step 4: Make contention retryable without consuming failure budget**

The worker defers capacity contention and quarantine through a fenced job transition. Unknown errors remain fail-closed. The route passes a monotonic handler deadline and refuses to start a generation with less than 225 seconds remaining in the 300-second request window.

- [x] **Step 5: Verify and commit Task 4**

Run:

```bash
npm test -- \
  lib/services/analysis/v2-gemini-lease-store.test.ts \
  lib/services/analysis/v2-gemini-lease-migration-contract.test.ts \
  lib/services/analysis/v2-gemini-lease-pglite.test.ts \
  lib/services/analysis/v2-ai-result-store.test.ts \
  lib/services/ai/gemini.test.ts \
  lib/services/ai/stage-policy.test.ts \
  lib/services/analysis/v2-worker.test.ts \
  lib/services/analysis/v2-job-store.test.ts \
  lib/services/analysis/v2-worker-error-codes.test.ts \
  lib/services/analysis/v2-worker-route.test.ts
npx tsc --noEmit
```

Expected: PASS.

```bash
git add app/api/analysis/v2/worker lib/services/analysis lib/services/ai \
  supabase/migrations docs/operations-cost-model.md
git commit -m "feat: fence deployment-wide Gemini concurrency"
```

### Task 5: Prepare operator-approved paid-order fulfillment outbox

**Files:**
- Create: `supabase/migrations/20260724123300_add_earlybird_fulfillment_outbox.sql`
- Create: `lib/services/earlybird/fulfillment-store.ts`
- Create: `lib/services/earlybird/fulfillment-store.test.ts`
- Create: `lib/services/earlybird/fulfillment-migration-contract.test.ts`
- Create: `lib/services/earlybird/fulfillment-pglite.test.ts`
- Create: `scripts/fulfill-earlybird-order.ts`
- Create: `scripts/fulfill-earlybird-order.test.ts`
- Modify: `lib/services/analysis/v2-recovery.ts`
- Modify: `lib/services/analysis/v2-recovery.test.ts`
- Modify: `package.json`
- Modify: `docs/groble-earlybird-operations.md`

- [x] **Step 1: Write failing outbox and CLI tests**

The outbox has one row per paid order and these states:

```ts
type EarlybirdFulfillmentStatus =
    | 'awaiting_operator'
    | 'admission_pending'
    | 'analysis_in_progress'
    | 'completed'
    | 'retryable_failure'
    | 'manual_review';
```

The webhook may create only `awaiting_operator`. It never reserves provider work or creates an analysis request. The operator CLI requires both `--order-id <uuid>` and the exact `--confirm-paid-api-call` flag. It accepts no username, buyer contact, plan, price, provider token, or credential slot.

- [x] **Step 2: Implement the generated outbox migration**

The CLI-generated file is `supabase/migrations/20260724123300_add_earlybird_fulfillment_outbox.sql`. Create an RLS-enabled, service-only table with order uniqueness, bounded attempts, lease token/fence, next-attempt time, nullable request ID, and terminal timestamps. RPCs must:

- enqueue/replay only reference-confirmed `paid` orders;
- atomically claim one row after explicit operator admission;
- create/replay the production V2 request from the immutable order/preflight snapshot;
- preserve fresh-admission revalidation before paid provider work;
- link only a same-owner completed request;
- recover expired leases without duplicating requests or provider reservations;
- send irreconcilable payment, snapshot, or cost states to `manual_review`.

- [x] **Step 3: Implement operator admission and recovery**

Add:

```json
"earlybird:fulfill": "tsx --env-file=.env.local scripts/fulfill-earlybird-order.ts"
```

The script prints only order UUID, bounded state, request UUID when created, and the next safe operator action. The existing recovery loop replays admitted jobs but never admits `awaiting_operator` rows.

- [x] **Step 4: Verify and commit Task 5**

Run:

```bash
npm test -- \
  lib/services/earlybird/fulfillment-store.test.ts \
  lib/services/earlybird/fulfillment-migration-contract.test.ts \
  lib/services/earlybird/fulfillment-pglite.test.ts \
  scripts/fulfill-earlybird-order.test.ts \
  lib/services/analysis/v2-recovery.test.ts
npx tsc --noEmit
```

Expected: PASS.

```bash
git add lib/services/earlybird lib/services/analysis scripts/fulfill-earlybird-order* \
  package.json docs/groble-earlybird-operations.md supabase/migrations
git commit -m "feat: prepare operator-approved earlybird fulfillment"
```

### Task 6: Reconcile evidence and freeze the Starter boundary

**Files:**
- Modify: `docs/operations-cost-model.md`
- Modify: `docs/groble-earlybird-operations.md`
- Create: `docs/pre-starter-launch-checklist.md`
- Modify: `lib/observability/operations-docs-contract.test.ts`

- [x] **Step 1: Update the measured evidence without inventing missing cost**

Record the successful Plus E2E as one controlled sample:

```text
provider actual: $3.33835
Gemini modeled estimate with usage: $0.5858645
observed subtotal: $3.9242145
completeness: false because one rejected Gemini attempt lacks usage and GCP infrastructure is excluded
```

The document must continue to mark Basic/Standard p50/p95, complete unit economics, and final list prices as unmeasured. It must not use the single Plus run to set a final price.

- [x] **Step 2: Define the read-only pre-Starter decision report**

The checklist requires:

- at least one reference-confirmed commercial payment before the owner considers Starter;
- zero unreviewed/unconfirmed paid orders;
- zero overdue or refund-liability rows;
- zero active analysis requests, jobs, provider runs, or fulfillment leases at credential cutover;
- all eight Gemini slots healthy and unquarantined;
- production migration history equal to the reviewed branch;
- Groble dashboard prices and stock equal to the server catalog;
- an explicit owner approval immediately before purchasing Starter or changing `APIFY_SECONDARY_API_TOKEN`.

The checklist states that satisfying these conditions does not itself purchase a plan or rotate a secret.

- [x] **Step 3: Add a documentation contract test**

Assert that the operations documents contain the exact Starter boundary and do not claim automatic launch, Plus checkout, complete cost, or a finalized post-launch list price.

- [x] **Step 4: Verify and commit Task 6**

Run:

```bash
npm test -- lib/observability/operations-docs-contract.test.ts
npx tsc --noEmit
```

Expected: PASS.

```bash
git add docs lib/observability/operations-docs-contract.test.ts
git commit -m "docs: define the pre-Starter launch boundary"
```

### Task 7: Full verification, review, and production approval gate

**Files:**
- Review all files changed by Tasks 1 through 6.

- [ ] **Step 1: Run complete local verification**

Run:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Review the migration chain without applying it**

Run:

```bash
npx supabase migration list --linked
npx supabase db push --linked --dry-run
npx supabase db advisors --linked --type security --level warn
npx supabase db advisors --linked --type performance --level warn
```

Expected: local/remote history is coherent, dry-run lists only the reviewed new migrations in order, and new advisor findings are resolved. Do not run `supabase db push`.

- [ ] **Step 3: Verify the credential boundary**

Read production configuration without printing secret values and prove:

- no Apify credential value or Secret Manager version changed in this branch;
- `APIFY_SECONDARY_API_TOKEN` has not been selected or rotated;
- automatic public fulfillment remains disabled;
- no paid external E2E ran as part of this implementation.

- [ ] **Step 4: Push the implementation branch and open a PR**

```bash
git push -u origin feat/pre-starter-launch-readiness
gh pr create \
  --base main \
  --head feat/pre-starter-launch-readiness \
  --title "feat: prepare reference-confirmed earlybird demand validation" \
  --body "## Summary
- bind signed Groble payments to opaque server-issued order references
- report reference-confirmed demand without buyer or Instagram identifiers
- add distributed Gemini and operator-fulfillment safety gates

## Verification
- npm test
- npm run lint
- npm run build
- Supabase migration dry-run and advisors"
```

- [ ] **Step 5: Stop for the required production approval**

Request approval only after CI and preview pass, because production migration application changes payment matching and fulfillment state. The approval must cover:

1. applying the reviewed Supabase migrations;
2. deploying the reviewed application SHA;
3. running a signed Groble test-send and one non-charged reference propagation check.

Actual customer payment, Apify Starter purchase, provider token rotation, and public automatic launch require separate explicit approvals and are not bundled into this gate.

## Self-review

- **Spec coverage:** commercial demand, test/payment separation, late-cancel correctness, AI concurrency, manual fulfillment, cost evidence, and the Starter stop boundary each have an owning task.
- **Placeholder scan:** generated migration filenames are intentionally produced by the mandated CLI command; no implementation behavior is left unspecified.
- **Type consistency:** `sellerReference`, `seller_reference_confirmed_at`, aggregate report fields, lease signals, and fulfillment states use one spelling across tasks.
- **Security:** new public-schema tables use RLS, privileged functions revoke default execution, service-role values never enter clients, and buyer/Instagram identifiers are absent from demand and operator output.
