# Vertex AI cost optimization design

**Status:** Approved implementation design (the product owner approved the previously recommended direction before this implementation run).

**Date:** 2026-09-02

## Goal and constraints

The release must make Vertex AI spend predictable before a request reaches the provider, lower gross cost by at least 50% on the measured baseline, and retain a measurable quality contract. This work is limited to AI routing, pricing, budget admission, telemetry, dry-run evidence, focused tests, and their documentation. It does not alter the score-audit cleanup migration or the landing-page marketing copy.

The implementation must not call a paid model or run a production-account canary. All evidence in this change is deterministic fixture evidence and local unit-test evidence. Historical policy versions remain byte-compatible; the new policy is forward-only and opt-in through rollout configuration.

## Baseline and success criterion

The UTC 2026-08-19 baseline fixture is fixed at:

| Quantity | Value |
| --- | ---: |
| Input tokens | 28,696,298 |
| Output tokens | 13,834,322 |
| Historical `gemini-3.7-flash` input rate | $1.50 / 1M |
| Historical `gemini-3.7-flash` output rate | $7.50 / 1M |
| Baseline gross cost | **$146.801862** |

The arithmetic is exact at the six-decimal reporting precision:
`28,696,298 × $1.50 / 1,000,000 + 13,834,322 × $7.50 / 1,000,000 = $146.801862`.

The proposed fixture keeps the aggregate token volume and splits work into a low-cost default route and an explicitly escalated route:

| Route | Model | Input | Output | Cost |
| --- | --- | ---: | ---: | ---: |
| Default first pass | `gemini-3.1-flash-lite` | 24,000,000 | 10,000,000 | $21.000000 |
| Explicit high-value/ambiguous escalation | `gemini-3.7-flash` | 4,696,298 | 3,834,322 | $35.801862 |
| **Proposed total** | — | **28,696,298** | **13,834,322** | **$56.801862** |

The modeled reduction is exactly `$90.000000`, or `61.307124%`, which clears the 50% release threshold without claiming that production traffic has already achieved that result.

## Routing contract

The new forward-only AI stage policy (`ai-stage-policy-v2.12`) uses `gemini-3.1-flash-lite` as the first-pass/default model. `gemini-3.7-flash` is selected only when the caller supplies one of two typed, auditable escalation reasons:

* `high_value`: a high-risk narrative or another explicitly designated high-value concierge operation;
* `ambiguous`: a triage result that is unknown, mixed, or below the deterministic confidence threshold and requires a quality-preserving second pass.

An absent reason always means the default route. A free-form model override cannot silently turn a normal request into an escalation: the selected model and route are part of the result identity and the pre-dispatch budget record. Legacy policies (`v2.6` through `v2.11`) keep their existing model choices and identities. The cost-optimized policy is enabled only for a request that passes the new rollout flag and all existing policy gates.

Output and thinking budgets are part of the route contract. The default route uses the smallest stage-specific ceiling that can satisfy its schema; escalation uses a bounded ceiling rather than inheriting the historical 8,192-token feature/narrative ceiling. Retry policy is capped at one retry for cost-optimized stages, and response-rejection retries are disabled unless the stage explicitly declares the ambiguous/high-value quality contract. A retry is a new budget admission and is never free.

The asynchronous Vertex Batch API is intentionally not used in the user-facing analysis path. A future offline concierge exporter may submit only explicitly opted-in, non-latency-sensitive work through Batch, with the same route, cost estimate, budget admission, and telemetry records. This release only defines the seam and rollout requirement; it does not submit a Batch job.

## Pricing and fail-closed behavior

`lib/services/ai/gemini-cost.ts` is the single pricing table used by estimates and response telemetry. It covers the models that can be selected by the supported stage policies, including the historical 3.7 rates above, the existing 3.1 Flash-Lite global/non-global rates, and the existing 3 Flash preview rates. Resource-name and revision aliases resolve to a canonical model before pricing.

The existing nullable estimator remains available for compatibility with callers that report `unknown`. New budget admission uses a strict estimator: an unknown model, location, or malformed rate is an admission error, never a zero-dollar estimate. A response with null or malformed usage settles conservatively at its pre-dispatch reservation; it cannot erase spend from telemetry or budgets. Prices and model IDs are versioned in the policy snapshot so an estimate can be reproduced after a pricing-table update.

## Pre-dispatch budget enforcement

Every Vertex AI attempt, including legacy calls, durable V2 stage calls, explicit escalation, retry, and stateless replay, passes through the same budget guard before the SDK invocation. The guard estimates input tokens from the prepared prompt/media projection and reserves the configured maximum output/thinking budget at the selected model rate. The reservation key is `(requestId, operationKey, attempt)`; duplicate recovery observations do not double charge, while a genuine retry has a distinct key.

The guard enforces three independent ceilings:

* `VERTEX_AI_PER_RUN_BUDGET_USD` (default `2.00`), grouped by analysis request;
* `VERTEX_AI_PER_ORDER_BUDGET_USD` (default `5.00`), grouped by the optional paid order;
* `VERTEX_AI_DAILY_BUDGET_USD` (default `100.00`), grouped by UTC day.

Deployments use a shared durable reservation store so concurrent instances cannot race past a ceiling. Tests and local dry runs use an in-memory implementation with the same atomic interface. A successful response settles to measured usage when usage is complete; unknown usage keeps the reserved estimate. Failed attempts keep their reservation because a provider may have charged for a generated response. A reservation is never released merely because a caller did not receive a parseable result.

The guard is deliberately independent of the existing concurrency/admission lease. The lease controls active calls and rate; this guard controls dollars. Both checks must pass before dispatch. Budget denial is a typed, observable failure and is returned before any paid-model SDK call.

## Telemetry and replay

Durable production calls continue to write their existing attempt ledger and token usage records. A replay has no permission to write production result/token tables, but it must still emit the same in-memory attempt telemetry (`inputTokens`, `outputTokens`, `thinkingTokens`, `estimatedCostUsd`, usage completeness, route, and reservation outcome). Replay reports aggregate those fields per stage and at the run level. `skipTokenLog` therefore only suppresses the durable database side effect; it is not a telemetry bypass and cannot suppress budget accounting.

Each attempt reports model, route, policy version, location, prompt/schema versions, output/thinking ceiling, latency, retry disposition, and cost-estimate status. Missing response usage is represented as `unknown` and retains the pre-dispatch estimate. Operational dashboards can consequently distinguish measured cost from guarded cost without treating an unknown response as free.

## Dry-run quality and cost gate

`reports/vertex-ai-cost-optimization-fixture.json` is a checked-in, non-secret fixture containing the fixed baseline/proposed token split and quality contract. `scripts/vertex-ai-cost-gate.ts` and its pure library evaluate:

* gross modeled savings is at least 50%;
* all priced routes have known, non-null rates;
* 3.7 usage has an explicit `high_value` or `ambiguous` reason;
* default first-pass routing is the majority path;
* unknown-usage rate is at most 30%;
* high-risk recall is at least 95% of the baseline fixture;
* output/thinking/retry ceilings stay within the new policy limits.

The gate prints a stable JSON summary and exits non-zero on any violation. It never imports a provider client, reads production credentials, or sends a network request. Focused tests exercise both the failing (RED) and passing (GREEN) cases, including unknown pricing, budget denial before dispatch, retry reservation, replay telemetry, and the exact baseline arithmetic.

## Rollout, deployment, and rollback

1. Apply the dedicated budget-reservation migration and deploy the code with the new policy rollout flag off.
2. Run the fixture gate, focused tests, typecheck, lint, relevant full tests, and build in CI. Confirm no paid-model invocation is present in the dry-run path.
3. Enable the policy only for an internal/test entitlement. Inspect route share, budget denials, unknown-usage rate, measured-vs-reserved cost, schema rejection rate, and high-risk recall against the fixture contract.
4. Promote to production in a guarded percentage rollout after the shared reservation store and UTC-day aggregation are verified. Batch remains disabled for interactive traffic.
5. Roll back by disabling the policy flag; historical policy versions and result identities remain available for recovery. If the budget store is unavailable, fail closed before provider dispatch and alert rather than bypassing the guard.

Required deployment configuration is the rollout flag, all three budget ceilings, a durable budget-store connection/RPC, and the existing Vertex project/location credentials. No production account canary is part of this change. The release handoff must include the exact fixture output (`$146.801862 → $56.801862`, `$90.000000`, `61.307124%`) and the quality-contract result, plus a confirmation that no score-audit cleanup migration was changed.
