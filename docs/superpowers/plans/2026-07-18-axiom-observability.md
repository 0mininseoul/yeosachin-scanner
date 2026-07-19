# Axiom Operational Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send privacy-bounded, structured server logs for authentication, preflight, providers, Gemini, Cloud Tasks, Groble, and the V2 pipeline to an Axiom dataset that supports launch operations without making product requests depend on Axiom availability.

**Architecture:** Provision `yeosachin-logs` with the local PAT, then create a separate dataset-ingest-only runtime token. A server-only logger wraps the official Axiom Next.js stack, sanitizes every field through a closed allowlist, uses stable event names, and always fails open. Existing central telemetry and worker boundaries emit batch/stage outcomes; only failures, retries, and fallbacks may emit individual candidate Instagram IDs, while sensitive content and buyer PII are structurally impossible to pass.

**Tech Stack:** Next.js 16, TypeScript, `@axiomhq/js`, `@axiomhq/logging`, `@axiomhq/nextjs`, Axiom Events datasets and APL, Vitest.

---

### Task 1: Provision the dataset and least-privilege runtime credential

**Files:**
- Local ignored file: repository-root `.env.local`
- Create: `docs/axiom-observability-operations.md`

- [ ] **Step 1: Confirm the provisioning credential without printing it**

Run a shell check that loads `.env.local` and reports only whether `AXIOM_PERSONAL_ACCESS_TOKEN` is non-empty. Never echo, trace, serialize, or include the PAT in command output.

Expected: `AXIOM_PERSONAL_ACCESS_TOKEN=set`.

- [ ] **Step 2: Idempotently create the dataset using the PAT**

First `GET https://api.axiom.co/v2/datasets` with headers `Authorization: Bearer $AXIOM_PERSONAL_ACCESS_TOKEN` and `x-axiom-org-id: aa-obhq`. If `yeosachin-logs` is absent, send:

```json
{
  "name": "yeosachin-logs",
  "description": "Yeosachin server operational events",
  "kind": "axiom:events:v1",
  "retentionDays": 30,
  "useRetentionPeriod": true
}
```

to `POST https://api.axiom.co/v2/datasets`. If present, verify kind and retention instead of creating a duplicate. Parse responses programmatically and output only dataset name/kind/retention, never headers.

Expected: one Events dataset named `yeosachin-logs` with 30-day retention in organization `aa-obhq`.

- [ ] **Step 3: Create the runtime token in the logged-in Axiom UI**

In Settings → API tokens, create `yeosachin-runtime-ingest` with custom access limited to ingest/write on `yeosachin-logs`, no query, dataset administration, dashboard, monitor, user, token, or organization permissions. Copy the one-time value directly into ignored `.env.local` as `AXIOM_TOKEN` without displaying it. Add:

```dotenv
AXIOM_DATASET=yeosachin-logs
AXIOM_ORG_ID=aa-obhq
```

Keep `AXIOM_PERSONAL_ACCESS_TOKEN` local only. Never add it to Vercel.

- [ ] **Step 4: Prove least privilege**

With `AXIOM_TOKEN`, ingest one synthetic record into `yeosachin-logs`, then verify a dataset-list or token-create request returns 403. Query the synthetic record with the PAT or logged-in UI and delete/ignore it by `environment = 'local_setup'` in dashboards.

Expected: ingest succeeds; administration fails.

- [ ] **Step 5: Document provisioning facts without secrets**

Record dataset name, org ID, retention, token capability, rotation procedure, and the explicit rule that PAT is provisioning-only and runtime token is server-only. Do not record token values.

```bash
git add docs/axiom-observability-operations.md
git commit -m "docs: define Axiom observability provisioning"
```

### Task 2: Server-only logger and closed field allowlist

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/observability/schema.ts`
- Create: `lib/observability/schema.test.ts`
- Create: `lib/observability/server.ts`
- Create: `lib/observability/server.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Install only server packages**

Run: `npm install @axiomhq/js @axiomhq/logging @axiomhq/nextjs`

Expected: no `@axiomhq/react`, browser proxy route, or `NEXT_PUBLIC_AXIOM_*` dependency is added.

- [ ] **Step 2: Write failing sanitizer tests**

Define these public types:

```ts
export type OperationalSeverity = 'debug' | 'info' | 'warn' | 'error';

export interface OperationalEvent {
    event: string;
    severity: OperationalSeverity;
    fields?: Record<string, unknown>;
    error?: unknown;
}

export function sanitizeOperationalEvent(input: OperationalEvent): {
    message: string;
    fields: Record<string, string | number | boolean | null>;
};
```

Assert the sanitizer preserves only:

```ts
const ALLOWED_FIELD_NAMES = [
  'schema_version', 'environment', 'service', 'event', 'severity',
  'request_id', 'trace_id', 'route', 'method', 'status', 'duration_ms',
  'user_id', 'preflight_id', 'order_id', 'analysis_request_id', 'job_key',
  'target_instagram_id', 'candidate_instagram_id', 'excluded_instagram_id',
  'provider', 'operation', 'phase', 'attempt', 'result_count',
  'error_name', 'error_code', 'disposition', 'retryable',
  'estimated_cost_usd', 'input_count', 'output_count', 'model',
  'thinking_level', 'prompt_tokens', 'completion_tokens', 'thinking_tokens',
  'fallback', 'queue_name', 'progress', 'plan_id', 'amount_krw'
] as const;
```

Assert it drops keys and nested values for `email`, `phone`, `name`, `token`, `authorization`, `cookie`, `signature`, `body`, `response`, `payload`, `comment`, `bio`, `caption`, `prompt`, `image`, `media`, `url`, `profile`, and `buyer`. Bound strings to 256 characters, Instagram IDs to the existing username pattern, IDs to UUID/job-key patterns, counts to safe finite values, and error stack to zero fields. Error objects contribute only `error_name` and a safe uppercase `error_code` parsed from known prefixes.

Run: `npm test -- lib/observability/schema.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the closed schema**

Use an explicit `switch`/schema per allowed field rather than recursively redacting arbitrary input. The sanitized output always adds:

```ts
{
    schema_version: 1,
    service: 'yeosachin-web',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
    event: boundedEventName,
    severity: input.severity,
}
```

Event names must match `^[a-z][a-z0-9_.]{0,63}$`. Unknown field names never pass through.

- [ ] **Step 4: Write failing transport tests**

Inject a transport interface:

```ts
export interface OperationalTransport {
    log(level: OperationalSeverity, message: string, fields: Record<string, unknown>): void;
    flush(): Promise<void>;
}

export function createOperationalLogger(transport?: OperationalTransport): {
    emit(input: OperationalEvent): void;
    flush(): Promise<void>;
};
```

Test missing env disables transport, emit exceptions are swallowed, flush rejection is swallowed, sanitized fields only are sent, and 1,000 successful candidate events cannot be produced by the batch helper.

Run: `npm test -- lib/observability/server.test.ts`

Expected: FAIL because the server logger does not exist.

- [ ] **Step 5: Implement the official Axiom transport and fail-open wrapper**

```ts
import { Axiom } from '@axiomhq/js';
import { AxiomJSTransport, Logger } from '@axiomhq/logging';
import { nextJsFormatters } from '@axiomhq/nextjs';

function runtimeTransport(): OperationalTransport | undefined {
    const token = process.env.AXIOM_TOKEN?.trim();
    const dataset = process.env.AXIOM_DATASET?.trim();
    const orgId = process.env.AXIOM_ORG_ID?.trim();
    if (!token || !dataset || !orgId) return undefined;
    const axiom = new Axiom({ token, orgId });
    const logger = new Logger({
        transports: [new AxiomJSTransport({ axiom, dataset })],
        formatters: nextJsFormatters,
    });
    return {
        log: (level, message, fields) => logger.log(level, message, fields),
        flush: () => logger.flush(),
    };
}
```

Construct the singleton lazily, never include token/org configuration in a log, and catch all transport exceptions. Export `operationalLogger`, `flushOperationalLogs`, and a bounded `emitBatchOutcome` helper that emits success only once per batch and individual rows only for failures/retries/fallbacks.

- [ ] **Step 6: Add only server env contracts and commit**

`.env.example` gains:

```dotenv
AXIOM_TOKEN=
AXIOM_DATASET=yeosachin-logs
AXIOM_ORG_ID=
```

It must not contain `AXIOM_PERSONAL_ACCESS_TOKEN` or `NEXT_PUBLIC_AXIOM_TOKEN`.

Run: `npm test -- lib/observability/schema.test.ts lib/observability/server.test.ts && npx tsc --noEmit`

Expected: PASS.

```bash
git add package.json package-lock.json lib/observability .env.example
git commit -m "feat: add privacy bounded Axiom logger"
```

### Task 3: Next.js request errors and safe flush lifecycle

**Files:**
- Create: `instrumentation.ts`
- Create: `lib/observability/request.ts`
- Create: `lib/observability/request.test.ts`

- [ ] **Step 1: Write failing request-context tests**

```ts
export interface OperationalRequestContext {
    request_id: string;
    trace_id: string | null;
    route: string;
    method: string;
}

export function requestContext(request: Request, route: string): OperationalRequestContext;
export async function observeRoute<T extends Response>(
    request: Request,
    route: string,
    operation: (context: OperationalRequestContext) => Promise<T>
): Promise<T>;
```

Test a bounded incoming `x-request-id`, generated UUID fallback, `traceparent` trace extraction, pathname-free explicit route labels, duration/status logging, thrown error logging/rethrow, and flush after both success and failure.

Run: `npm test -- lib/observability/request.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement request context without bodies or query strings**

Use `crypto.randomUUID()` and an explicit static route string. Never inspect `request.url` search parameters, headers other than request/trace IDs, or body. `observeRoute` emits `http.route_completed` or `http.route_failed` and awaits best-effort flush in `finally`.

- [ ] **Step 3: Add sanitized Next.js global error capture**

Create `instrumentation.ts` with a custom `Instrumentation.onRequestError`. Do not use the default transform because it can include URL/query, user agent, host, or IP. Emit only:

```ts
operationalLogger.emit({
    event: 'next.request_error',
    severity: 'error',
    fields: {
        route: context.routePath,
        method: request.method,
        error_code: safeOperationalErrorCode(error),
    },
    error,
});
await flushOperationalLogs();
```

Use only documented `Instrumentation.onRequestError` fields that compile under the installed Next version.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- lib/observability/request.test.ts lib/observability/server.test.ts && npm run build`

Expected: PASS and build succeeds.

```bash
git add instrumentation.ts lib/observability/request.*
git commit -m "feat: capture server request failures in Axiom"
```

### Task 4: Auth, preflight, checkout, and Groble payment events

**Files:**
- Modify: `app/auth/callback/route.ts`
- Modify: `app/api/analysis/preflight/route.ts`
- Modify: `app/api/analysis/preflight/worker/route.ts`
- Modify: `app/api/analysis/preflight/[preflightId]/route.ts`
- Modify: `app/api/earlybird/checkout/route.ts`
- Modify: `app/api/webhooks/groble/route.ts`
- Create: `lib/observability/business-events.test.ts`

- [ ] **Step 1: Write a source contract test for event coverage and forbidden fields**

Assert the six route files emit these stable names:

```ts
[
  'auth.callback_completed', 'auth.profile_sync_failed',
  'preflight.requested', 'preflight.profile_collected', 'preflight.completed', 'preflight.failed',
  'preflight.exclusion_decided',
  'earlybird.checkout_created', 'earlybird.checkout_failed',
  'groble.webhook_received', 'groble.webhook_finalized', 'groble.webhook_rejected'
]
```

Assert no `buyerEmail`, `buyerPhone`, `displayName`, `rawBody`, signature header, OAuth token, comment, bio, caption, image URL, or external response body is passed to `operationalLogger.emit`.

Run: `npm test -- lib/observability/business-events.test.ts`

Expected: FAIL because the events are absent.

- [ ] **Step 2: Instrument auth and preflight**

Emit auth provider, user UUID, disposition, duration, and safe error code. Emit preflight target Instagram ID explicitly, preflight UUID, plan, follower/following input counts, duration, and result status. For exclusion emit only the normalized `excluded_instagram_id` plus preflight/user IDs. Do not emit social metadata or profile content.

- [ ] **Step 3: Instrument checkout and Groble**

Checkout events contain order/preflight/user UUID, target Instagram ID, plan, amount, disposition, and duration. Groble webhook events contain event type, order ID, amount, product-neutral plan ID when known, disposition, and duration. Never emit Groble buyer contact, payment ID, event ID, raw body, signature, product secret/config ID, or idempotency key.

- [ ] **Step 4: Flush at serverless boundaries and verify**

Use `await flushOperationalLogs()` immediately before each route response after business outcome logging. Logging/flush failures must not change the HTTP result.

Run: `npm test -- lib/observability/business-events.test.ts lib/services/earlybird/groble-webhook-route.test.ts && npx tsc --noEmit`

Expected: PASS.

```bash
git add app/auth/callback/route.ts app/api/analysis/preflight app/api/earlybird/checkout/route.ts app/api/webhooks/groble/route.ts lib/observability/business-events.test.ts
git commit -m "feat: log auth preflight and payment operations"
```

### Task 5: Scraper, Cloud Tasks, V2 worker, and Gemini stage events

**Files:**
- Modify: `lib/services/instagram/supabase-telemetry.ts`
- Modify: `lib/services/instagram/scraper.ts`
- Modify: `lib/services/analysis/background-tasks.ts`
- Modify: `app/api/analysis/v2/worker/route.ts`
- Modify: `lib/services/analysis/v2-ai-stage-runtime.ts`
- Modify: `lib/services/analysis/v2-ai-result-store.ts`
- Create: `lib/observability/pipeline-events.test.ts`

- [ ] **Step 1: Write failing pipeline event tests**

Assert the following stable event vocabulary:

```ts
[
  'scraper.batch_completed', 'scraper.batch_failed', 'scraper.fallback_selected',
  'scraper.candidate_failed',
  'cloud_task.enqueue_completed', 'cloud_task.enqueue_failed',
  'analysis_v2.worker_completed', 'analysis_v2.worker_retry', 'analysis_v2.worker_failed',
  'gemini.stage_completed', 'gemini.stage_rate_limited', 'gemini.stage_failed'
]
```

Test that successful profile collections emit one aggregate batch event, while candidate username is emitted only for failure/retry/fallback. Test Gemini fields contain model, thinking level, attempt, duration, token counts, estimated cost, and disposition but no prompt, response, evidence, media, or candidate narrative.

Run: `npm test -- lib/observability/pipeline-events.test.ts`

Expected: FAIL because Axiom emission is absent.

- [ ] **Step 2: Bridge existing scraper telemetry once**

In `createSupabaseScraperTelemetryHook`, retain current Supabase persistence and additionally emit one Axiom aggregate using provider, capability as operation, request/result counts, fallback, latency, status, error category, estimated cost, and request UUID. Remove the JSON `console.info` containing the whole telemetry object. In `runProfileOutcomeAttempt`, emit `candidate_instagram_id` only for failed/unavailable/fallback outcomes; successful usernames are not logged.

- [ ] **Step 3: Instrument queue and V2 delivery boundaries**

In `background-tasks.ts`, emit enqueue success/failure with analysis request UUID, static queue name, phase, attempt, and error code. Replace the V2 worker's hand-built `console` JSON with `operationalLogger.emit`, preserving its current observable job-key validation and disposition mapping. Flush before returning each worker response.

- [ ] **Step 4: Instrument durable Gemini attempt outcomes**

Emit from the point where the AI attempt ledger is terminalized so retries cannot double-count. Fields are `analysis_request_id`, `job_key`, `operation`, `model`, `thinking_level`, `attempt`, `duration_ms`, token counts, `estimated_cost_usd`, disposition, and safe error code. Never send input hashes, prompts, response JSON, evidence bundles, image/media URLs, captions, bios, comments, or usernames from the AI request.

- [ ] **Step 5: Verify log-volume and privacy contracts**

Run:

```bash
npm test -- lib/observability/pipeline-events.test.ts lib/observability/schema.test.ts \
  lib/services/analysis/v2-ai-stage-runtime.test.ts lib/services/analysis/v2-ai-result-store.test.ts
npx tsc --noEmit
```

Expected: PASS; a 900-candidate successful batch produces bounded aggregate events, not 900 Axiom records.

- [ ] **Step 6: Commit**

```bash
git add lib/services/instagram lib/services/analysis app/api/analysis/v2/worker/route.ts lib/observability/pipeline-events.test.ts
git commit -m "feat: log provider queue and AI pipeline outcomes"
```

### Task 6: Runtime configuration, live data validation, dashboard, and monitors

**Files:**
- Modify: `app/privacy/page.tsx`
- Modify: `docs/axiom-observability-operations.md`

- [ ] **Step 1: Update privacy disclosure**

Name Axiom as the processor for operational logs, disclose international transfer and 30-day retention, and state that operational logs may contain Instagram account IDs for incident diagnosis. State that buyer email/phone/name, comments, bios, captions, media URLs, credentials, and external API bodies are excluded.

- [ ] **Step 2: Run the full static verification**

Run:

```bash
npm test -- lib/observability
npx tsc --noEmit
npm run lint
npm run build
rg -n "NEXT_PUBLIC_AXIOM|AXIOM_PERSONAL_ACCESS_TOKEN" app components hooks lib .env.example
```

Expected: tests/type/lint/build pass; `rg` returns no runtime/public PAT usage.

- [ ] **Step 3: Configure preview server variables**

Add only `AXIOM_TOKEN`, `AXIOM_DATASET=yeosachin-logs`, and `AXIOM_ORG_ID=aa-obhq` to Vercel preview. Never add the PAT. Trigger one preflight, one expected provider fallback/failure fixture, one V2 worker fixture, and one signed Groble test webhook.

- [ ] **Step 4: Validate representative records in Axiom UI**

Confirm event name, environment, route/stage, duration, disposition, provider, and Instagram ID fields are queryable. Inspect raw records and schema for forbidden fields. A search for `email`, `phone`, `buyer`, `token`, `cookie`, `signature`, `comment`, `bio`, `caption`, `prompt`, `image`, `media`, and `url` must return no application fields containing sensitive values.

- [ ] **Step 5: Create the operational dashboard in the logged-in Axiom UI**

Create `Yeosachin Operational Health` with environment filters and panels for:

1. route request count, error rate, p50 and p90 duration;
2. preflight count, failure rate, error codes, and latency;
3. provider count/failure/fallback/quota by provider and operation;
4. Gemini latency, rate limits, retries, token usage, and estimated cost;
5. Cloud Tasks enqueue/retry and V2 worker failure by job key;
6. Groble accepted, unmatched, ambiguous, mismatch, and overflow dispositions;
7. analysis completion/failure and stage duration.

- [ ] **Step 6: Create monitors after representative data exists**

Create environment-scoped monitors for production only:

- Groble webhook 5xx > 0 in 5 minutes;
- Groble unmatched/ambiguous/mismatch > 0 in 15 minutes;
- terminal analysis failure > 0 in 15 minutes;
- V2 worker failed or timeout > 0 in 10 minutes;
- provider auth/quota failure > 0 in 15 minutes.

Configure the user's available Axiom notifier. If no notifier exists, create the monitors disabled and document the missing notification destination rather than inventing one.

- [ ] **Step 7: Commit documentation**

```bash
git add app/privacy/page.tsx docs/axiom-observability-operations.md
git commit -m "docs: add Axiom operations and privacy policy"
```
