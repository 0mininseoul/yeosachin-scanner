# Commerce and Operations Canonicalization Implementation Plan

> Historical plan disposition (2026-09-13): this exact-22 multi-family backfill plan is retained for provenance only; its backfill entry point was retired. Do not run commands referencing `scripts/backfill-commerce-operations-canonical.ts`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** 결제·fulfillment·notification·account lifecycle·configuration·lease·maintenance family를 12개 canonical public table로 정리하고 기존 commercial evidence를 손실 없이 보존한다.

**Architecture:** \`users\`, \`earlybird_waitlist\`, \`earlybird_orders\`, \`result_feedback\`는 기존 aggregate 이름을 유지한다. \`payment_events\`, \`fulfillment_jobs\`, \`notification_outbox\`, \`account_lifecycle\`, \`system_configuration\`, \`system_leases\`, \`maintenance_jobs\`만 추가하고 기존 webhook/fulfillment/recovery writers는 bounded dual-write adapter 뒤에 둔다.

**Tech Stack:** PostgreSQL/Supabase RLS/RPC, TypeScript/Zod, Vitest, PGlite, disposable PostgreSQL, Next.js route handlers.

---

## Scope and exact files

| Action | Path |
|---|---|
| Create (generated path) | \`$COMMERCE_MIGRATION_PATH\` from \`npx supabase migration new add_commerce_operation_canonical_tables\` |
| Create | \`lib/services/commerce/canonical-commerce-store.ts\` |
| Create | \`lib/services/commerce/canonical-commerce-store.test.ts\` |
| Create | \`lib/services/commerce/canonical-commerce-pglite.test.ts\` |
| Create | \`lib/services/operations/canonical-operations-store.ts\` |
| Create | \`lib/services/operations/canonical-operations-store.test.ts\` |
| Create | \`scripts/backfill-commerce-operations-canonical.ts\` |
| Create | \`scripts/backfill-commerce-operations-canonical.test.ts\` |
| Modify | \`app/api/webhooks/groble/route.ts\`, \`lib/services/groble/webhook.ts\` |
| Modify | \`lib/services/earlybird/fulfillment-store.ts\`, \`lib/services/earlybird/payment-discord.ts\` |
| Modify | \`lib/services/identity/account-deletion.ts\`, \`lib/services/identity/account-principal-store.ts\` |
| Modify | \`app/api/internal/earlybird-payment-discord-outbox/route.ts\`, \`app/api/internal/kakao-signup-discord-outbox/route.ts\`, \`app/api/internal/sentry-discord-alert-outbox/route.ts\` |

이 plan은 fixed landing copy와 protected migration을 수정하지 않는다. \`payments\`, \`payment_orders\`, \`pending_analysis\`는 owner catalog evidence가 없는 unknown/no-action 대상으로 남기며, external order의 \`payment_pending\` 상태를 provider evidence 없이 변경하는 RPC를 만들지 않는다.

## Canonical contracts

~~~sql
CREATE TABLE public.payment_events (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    event_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL CHECK (provider IN ('groble')),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'payment.completed', 'payment.cancel_requested', 'payment.refunded'
    )),
    payment_id TEXT NOT NULL,
    order_id UUID REFERENCES public.earlybird_orders(id) ON DELETE SET NULL,
    disposition TEXT NOT NULL,
    amount_krw INTEGER CHECK (amount_krw IS NULL OR amount_krw > 0),
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.fulfillment_jobs (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    order_id UUID NOT NULL UNIQUE REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    request_id UUID UNIQUE REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN (
        'awaiting_operator', 'admission_pending', 'analysis_in_progress',
        'completed', 'retryable_failure', 'manual_review'
    )),
    attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
    lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    lease_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    last_error_code TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.notification_outbox (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    channel TEXT NOT NULL CHECK (channel IN ('discord', 'kakao', 'sentry')),
    event_kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'sent', 'retryable', 'dead')),
    attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.account_lifecycle (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    event_kind TEXT NOT NULL CHECK (event_kind IN (
        'classification', 'paid_evidence', 'deletion_requested',
        'objects_purged', 'database_purged', 'retired', 'e2e'
    )),
    state TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.system_configuration (
    config_key TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    state TEXT NOT NULL CHECK (state IN ('draft', 'effective', 'retired')),
    config JSONB NOT NULL,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    effective_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (config_key, version),
    CHECK (pg_catalog.jsonb_typeof(config) = 'object')
);

CREATE TABLE public.system_leases (
    lease_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('provider', 'capacity', 'maintenance', 'notification')),
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    state TEXT NOT NULL CHECK (state IN ('available', 'held', 'expired', 'fenced')),
    holder_hash TEXT CHECK (holder_hash IS NULL OR holder_hash ~ '^[a-f0-9]{64}$'),
    lease_expires_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    fence_token BIGINT NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.maintenance_jobs (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN (
        'recovery', 'replay', 'rearm', 'cleanup',
        'terminalize', 'purge', 'audit_assembly'
    )),
    target_key_hash TEXT NOT NULL CHECK (target_key_hash ~ '^[a-f0-9]{64}$'),
    state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'retryable', 'blocked')),
    attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    lease_expires_at TIMESTAMPTZ,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (kind, target_key_hash)
);
~~~

각 새 table은 ENABLE/FORCE RLS, service-role-only RPC, \`search_path = ''\`, immutable event/lifecycle/config trigger를 사용한다. payment/event payload에는 provider token, cookie, raw contact, raw webhook body를 저장하지 않는다. \`system_leases.holder_hash\`와 \`maintenance_jobs.target_key_hash\`만 저장한다.

## Task 1: RED schema and commercial safety contracts

**Files:**

- Create: \`lib/services/commerce/canonical-commerce-store.test.ts\`
- Create: \`lib/services/commerce/canonical-commerce-pglite.test.ts\`
- Create: \`lib/services/operations/canonical-operations-store.test.ts\`
- Create (generated path): \`$COMMERCE_MIGRATION_PATH\`

- [ ] **Step 1: Write RED tests.** Assert all seven table names, enum/checks, unique idempotency/dedupe keys, RLS/ACL, append-only protections, no browser grant, no raw webhook/token/contact keys, and the explicit forbidden transition \`payment_pending -> payment_failed\` unless the independent provider no-sale evidence RPC is called. Assert every SECURITY DEFINER RPC uses \`SET search_path = ''\`, revokes EXECUTE from \`PUBLIC, anon, authenticated\`, and grants EXECUTE only to \`service_role\`.

~~~ts
expect(sql).toContain('CREATE TABLE public.payment_events');
expect(sql).toContain('CREATE TABLE public.maintenance_jobs');
expect(sql).toContain('UNIQUE (kind, target_key_hash)');
expect(sql).not.toMatch(/provider_token|access_token|cookie|raw_body|buyer_phone/i);
expect(sql).toContain('PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED');
~~~

- [ ] **Step 2: Run RED.**

~~~bash
npx vitest run lib/services/commerce/canonical-commerce-store.test.ts lib/services/commerce/canonical-commerce-pglite.test.ts lib/services/operations/canonical-operations-store.test.ts
~~~

Expected: FAIL because the generated commerce/operations migration file is absent.

- [ ] **Step 3: Create the migration and add schema and minimal RPCs.** Run Steps 3–4 in one shell session so the generated path variable remains available. Capture exactly one path from the CLI output, place the contract SQL above in that file, and add indexes \`payment_events_order_recorded_idx\`, \`fulfillment_jobs_recovery_idx\`, \`notification_outbox_delivery_idx\`, \`account_lifecycle_account_recorded_idx\`, \`system_configuration_effective_idx\`, \`system_leases_expiry_idx\`, and \`maintenance_jobs_recovery_idx\`. Every SECURITY DEFINER function uses \`SET search_path = ''\` and the explicit service-role-only ACL below. The only function allowed to move \`payment_pending\` is the existing evidence-gated no-sale reconciliation path; canonical event recording is append-only.

~~~bash
set -euo pipefail
COMMERCE_MIGRATION_OUTPUT="$(npx supabase migration new add_commerce_operation_canonical_tables)"
COMMERCE_MIGRATION_PATH="$(printf '%s\n' "$COMMERCE_MIGRATION_OUTPUT" | sed -n 's/^Created new migration at //p')"
test "$(printf '%s\n' "$COMMERCE_MIGRATION_PATH" | awk 'NF { count++ } END { print count + 0 }')" -eq 1
test -f "$COMMERCE_MIGRATION_PATH"
export COMMERCE_MIGRATION_PATH
~~~

Define \`record_payment_event_v1\` as \`LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''\`, then apply its explicit service-role-only ACL:

~~~sql
REVOKE EXECUTE ON FUNCTION public.record_payment_event_v1(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_event_v1(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;
~~~

- [ ] **Step 4: Run GREEN and commit.**

~~~bash
npx vitest run lib/services/commerce/canonical-commerce-store.test.ts lib/services/commerce/canonical-commerce-pglite.test.ts lib/services/operations/canonical-operations-store.test.ts
git diff --check
git add "$COMMERCE_MIGRATION_PATH" lib/services/commerce/canonical-commerce-store.test.ts lib/services/commerce/canonical-commerce-pglite.test.ts lib/services/operations/canonical-operations-store.test.ts
git commit -m "feat: add commerce operation canonical tables"
~~~

Expected: focused tests PASS and no state-changing production command runs.

## Task 2: Payment, fulfillment, notification, and account adapters

**Files:**

- Create: \`lib/services/commerce/canonical-commerce-store.ts\`
- Create: \`lib/services/operations/canonical-operations-store.ts\`
- Modify: \`app/api/webhooks/groble/route.ts\`, \`lib/services/groble/webhook.ts\`, \`lib/services/earlybird/fulfillment-store.ts\`, \`lib/services/earlybird/payment-discord.ts\`
- Modify: \`lib/services/identity/account-deletion.ts\`, \`lib/services/identity/account-principal-store.ts\`
- Test: \`lib/services/earlybird/groble-webhook-route.test.ts\`, \`lib/services/earlybird/fulfillment-store.test.ts\`, \`lib/services/earlybird/payment-discord.test.ts\`

- [ ] **Step 1: Write RED adapter tests.** A webhook event is idempotent by \`event_id\` and \`idempotency_key\`; duplicate event writes one canonical row. Fulfillment claim/release preserves lease generation and fence. Notification enqueue is deduped by \`dedupe_key\`. Account deletion appends lifecycle events and never lets a later account reclaim a deleted journey. A canonical write failure leaves a bounded maintenance job and does not fabricate paid evidence.

- [ ] **Step 2: Implement minimal dual-writes.** Add server-only stores with \`recordPaymentEvent\`, \`upsertFulfillmentJob\`, \`enqueueNotification\`, \`appendAccountLifecycle\`, \`acquireSystemLease\`, and \`enqueueMaintenanceJob\`. Groble route continues signature validation and existing finalization RPC, while the same transaction records a redacted canonical event. Fulfillment and outbox routes read canonical rows only when family flag is true; flags default false. Account deletion writes \`account_lifecycle\` before each irreversible external/database step, but no deletion step is shortened.

~~~ts
export type PaymentEventResult =
    | { status: 'recorded'; duplicate: false }
    | { status: 'recorded'; duplicate: true };

export async function recordPaymentEvent(input: {
    eventId: string;
    idempotencyKey: string;
    eventType: 'payment.completed' | 'payment.cancel_requested' | 'payment.refunded';
    paymentId: string;
    payloadHash: string;
    amountKrw: number | null;
}): Promise<PaymentEventResult> {
    return canonicalCommerceRpc('record_payment_event_v1', {
        p_event_id: input.eventId,
        p_idempotency_key: input.idempotencyKey,
        p_event_type: input.eventType,
        p_payment_id: input.paymentId,
        p_payload_hash: input.payloadHash,
        p_amount_krw: input.amountKrw,
    });
}
~~~

- [ ] **Step 3: Run GREEN.**

~~~bash
npx vitest run lib/services/earlybird/groble-webhook-route.test.ts lib/services/earlybird/fulfillment-store.test.ts lib/services/earlybird/payment-discord.test.ts lib/services/identity/account-deletion.test.ts lib/services/identity/account-principal-store.test.ts
~~~

Expected: PASS; duplicate webhook, lease fence, outbox retry, deletion lifecycle, and payment-pending safety assertions are green.

- [ ] **Step 4: Commit adapters.**

~~~bash
git add app/api/webhooks/groble/route.ts lib/services/groble/webhook.ts lib/services/earlybird/fulfillment-store.ts lib/services/earlybird/payment-discord.ts lib/services/identity/account-deletion.ts lib/services/identity/account-principal-store.ts lib/services/commerce/canonical-commerce-store.ts lib/services/operations/canonical-operations-store.ts
git commit -m "feat: dual-write commerce operation evidence"
~~~

## Task 3: Bounded backfill, shadow reads, and rollback

**Files:**

- Create: \`scripts/backfill-commerce-operations-canonical.ts\`
- Create: \`scripts/backfill-commerce-operations-canonical.test.ts\`
- Modify: \`lib/services/commerce/canonical-commerce-store.ts\`, \`lib/services/operations/canonical-operations-store.ts\`

- [ ] **Step 1: Write RED parity tests.** Backfill old \`earlybird_webhook_events\`, \`earlybird_fulfillments\`, \`earlybird_*_outbox\`, \`account_classification_audit\`, \`account_paid_evidence\`, \`account_deletion_jobs\`, \`account_ledger_rollout_state\`, recovery tables, and lease tables in batches of at most 100. Assert event/payment/order relationships, fulfillment states/fences, notification dedupe, lifecycle order, config version, lease generation, and maintenance retry parity. Missing provider/payment evidence is blocked, never converted to \`payment_failed\`.

~~~ts
expect(derivePaymentDisposition({
    orderStatus: 'payment_pending',
    providerEvidence: null,
})).toEqual({ status: 'blocked', code: 'PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED' });
expect(derivePaymentDisposition({
    orderStatus: 'payment_pending',
    providerEvidence: { disposition: 'no_sale', checkedAt: '2026-09-09T00:00:00.000Z' },
})).toEqual({ status: 'eligible_for_separate_reconciliation' });
~~~

- [ ] **Step 2: Implement report-only backfill and family flags.** Add \`backfillCommerceOperationsCanonical({ limit: 100, cursor })\`; reject every destructive option; emit aggregate checksums without UUIDs, email, phone, raw provider payload, or order IDs. Read flags are \`COMMERCE_CANONICAL_PAYMENT_READ\`, \`COMMERCE_CANONICAL_FULFILLMENT_READ\`, \`COMMERCE_CANONICAL_NOTIFICATION_READ\`, \`COMMERCE_CANONICAL_ACCOUNT_READ\`, \`COMMERCE_CANONICAL_CONFIG_READ\`, \`COMMERCE_CANONICAL_LEASE_READ\`, and \`COMMERCE_CANONICAL_MAINTENANCE_READ\`, all false by default.

- [ ] **Step 3: Run GREEN.**

~~~bash
npx vitest run scripts/backfill-commerce-operations-canonical.test.ts lib/services/commerce/canonical-commerce-store.test.ts lib/services/operations/canonical-operations-store.test.ts
npx tsx --conditions=react-server scripts/backfill-commerce-operations-canonical.ts --limit=100 --report-only
~~~

Expected: tests PASS; report-only output has \`status: blocked\` for missing evidence and never changes an order.

- [ ] **Step 4: Commit backfill and rollback reader.**

~~~bash
git add scripts/backfill-commerce-operations-canonical.ts scripts/backfill-commerce-operations-canonical.test.ts lib/services/commerce/canonical-commerce-store.ts lib/services/operations/canonical-operations-store.ts
git commit -m "feat: add commerce operation parity backfill"
~~~

## Task 4: Full verification and handoff

- [ ] **Step 1: Run owned and repository gates.**

~~~bash
npx vitest run lib/services/commerce/canonical-commerce-store.test.ts lib/services/commerce/canonical-commerce-pglite.test.ts lib/services/operations/canonical-operations-store.test.ts scripts/backfill-commerce-operations-canonical.test.ts lib/services/earlybird/groble-webhook-route.test.ts lib/services/earlybird/fulfillment-store.test.ts lib/services/earlybird/payment-discord.test.ts lib/services/identity/account-deletion.test.ts
npx tsc --noEmit --pretty false
npm run lint
npm run build
git diff --check
~~~

Expected: tests/typecheck/build PASS, lint has 0 errors, and diff check has no output.

- [ ] **Step 2: Run guarded native PostgreSQL concurrency tests.** Use only the repository's disposable loopback guard for \`earlybird_concurrency_test\`; prove duplicate webhook, payment/order lock order, fulfillment \`SKIP LOCKED\`, notification lease fence, account deletion idempotency, and maintenance retry. Never use a linked, staging, or production connection string.

- [ ] **Step 3: Record evidence.** Write \`docs/reports/2026-09-09-supabase-22-commerce-operations-evidence.md\` with source/canonical checksums, event/payment disposition counts, unknown evidence count, lease/fence results, rollback flag values, and \`payment_pending\` non-mutation proof. The report remains blocked if any provider, archive, restore, dependency, or ownership gate is absent.

- [ ] **Step 4: Commit the evidence report.**

~~~bash
git add docs/reports/2026-09-09-supabase-22-commerce-operations-evidence.md
git commit -m "docs: record commerce operation evidence"
~~~

No DROP, analysis admission activation, \`payment_pending\` mutation, or real \`0_min._.00\` canary is authorized by this plan.
