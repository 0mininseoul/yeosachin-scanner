# Vertex AI cost optimization evidence

Date: 2026-09-02 (Asia/Seoul)

## Scope and safety

This change implements the approved forward-only `ai-stage-policy-v2.12` cost path, complete Vertex pricing, pre-dispatch monetary reservations, replay-safe telemetry, and a provider-free dry-run gate. The landing-page marketing copy and `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql` were not changed. No paid model request, production-account canary, Vertex Batch job, production Supabase mutation, or production credential was used.

## Historical cause (completed read-only audit)

**Facts from the audit:** On 2026-08-19 KST, Gemini 3.7 Flash returned HTTP 200 for 3,085 calls with 19,968,183 input tokens and 9,522,267 output tokens; on 2026-08-18 it returned HTTP 200 for 394 calls with 2,522,696 input tokens and 899,675 output tokens. The observed one-minute peak was 77 calls, 480,053 input tokens, and 222,307 output tokens. Cloud Run preflight volume remained roughly 297 / 292 / 295 and worker-route volume 9 / 4 / 4 across Aug 18 / 19 / 20, respectively; no raw IDs or payloads are included here.

**High-confidence inference:** The 2026-08-19 spike was caused by the pre-merge `ai-stage-policy-v2.11` concierge stateless replay path, whose `skipTokenLog` behavior hid the 3.7 replay stages from the ordinary durable token-usage view. The volume pattern does not indicate a corresponding Cloud Run preflight or worker-route surge, so the replay explanation is stronger than a fresh-user traffic explanation, but it remains an inference from the read-only aggregates rather than a direct per-request trace.

## Design and implementation artifacts

- Design: `docs/superpowers/specs/2026-09-02-vertex-ai-cost-optimization-design.md`
- Implementation plan: `docs/superpowers/plans/2026-09-02-vertex-ai-cost-optimization.md`
- Deterministic fixture: `reports/vertex-ai-cost-optimization-fixture.json`
- Cost/quality gate: `lib/services/ai/vertex-ai-cost-gate.ts`, `scripts/vertex-ai-cost-gate.ts`
- Budget store and migration: `lib/services/ai/vertex-ai-budget-store.ts`, `supabase/migrations/20260902090000_add_vertex_ai_cost_budget_reservations.sql`
- Forward policy fences: `supabase/migrations/20260902091000_add_vertex_ai_cost_policy_fences.sql`

The implementation uses the canonical `gemini-3.1-flash-lite` family for the default first pass and permits the canonical `gemini-3.7-flash` family only with the typed `high_value` or `ambiguous` route reason. Route/model identity, prompt/media projection, output/thinking ceiling, attempt number, and request/order/day scope are reserved before every provider attempt, including retries and replay; measured usage settles the reservation and missing usage conservatively retains the reservation. In `NODE_ENV=production`, a configured/global guard and v2.12 fail closed unless `VERTEX_AI_BUDGET_STORE=supabase`; no process-local fallback is used. Production uses the shared service-role Supabase RPC store, while tests/replay use the same atomic interface in memory or an explicit injected store; replay keeps durable result/token writes disabled but emits in-memory attempt telemetry. Recovery with an omitted day key preserves the original day for reserved/settled attempts across UTC midnight, while cancelled pre-dispatch retries can be re-admitted on the current day.

## TDD evidence

### RED

Before implementation, this command was run:

```text
npm test -- --run lib/services/ai/vertex-ai-cost-policy.test.ts lib/services/ai/vertex-ai-cost-gate.test.ts lib/services/ai/gemini.test.ts lib/services/ai/vertex-ai-cost-migrations-pglite.test.ts
```

It was RED: policy had 4 failures (canonical-model helper, midnight identity retention, cancelled retry identity, and production-store fail-closed behavior), the gate had 3 failures (count-based quality evidence and model-pairing contract), Gemini had 3 failures (invalid v2.12 model admission and production-store fail-closed behavior), and the new migration suite first failed while applying its dynamic fence fixture and then at the cross-day identity assertion. No provider or paid model was called.

### GREEN

After implementation, the focused command passed 8 files and 81 tests, including the RED cases for production-store selection, midnight recovery, exact model pairing, case-count recall, and executable PGlite migration application. The migration suite applies both SQL files and exercises ACL/RLS, concurrent reservation admission, settlement, cross-day recovery, cancellation re-admission, and dynamic v2.12 fence rewrites against representative current definitions. The full suite also passed; exact counts are recorded below. No paid model or production account canary was used.

## Exact modeled cost and quality evidence

Command:

```text
npm run cost:vertex-ai:gate
```

Result: modeled cost checks pass, but the release gate is intentionally blocked by `VERTEX_AI_HIGH_RISK_RECALL_EVIDENCE_UNVERIFIED`.

| Metric | Baseline | Proposed | Evidence |
| --- | ---: | ---: | --- |
| Input tokens | 28,696,298 | 28,696,298 | Aggregate volume unchanged |
| Output tokens | 13,834,322 | 13,834,322 | Aggregate volume unchanged |
| Gross cost | $146.801862 | $56.801862 | Historical 3.7 pricing vs Lite/default split |
| Savings | — | **$90.000000 (61.307124%)** | Exceeds 50% release threshold |

The proposed route split is 24,000,000 input + 10,000,000 output tokens on `gemini-3.1-flash-lite` ($21.000000), and 4,696,298 input + 3,834,322 output tokens on explicitly justified `gemini-3.7-flash` ($35.801862). The fixture derives observed recall from `97 / 100 = 0.97` case counts, with baseline `100 / 100 = 1.00`; it does not self-report a measured recall scalar. Its evidence status is `unverified_fixture`, so the ratio clears the required `0.95` threshold but production rollout remains blocked. Unknown usage rate is `0`, default-route share is `0.8`, maximum output is `4096`, maximum thinking is `LOW`, and maximum attempts is `2`.

`npm run cost:vertex-ai:gate` exits non-zero for the checked-in fixture by design while still reporting deterministic modeled cost arithmetic. Production rollout must remain off until a real labeled or authorized canary report replaces the unverified status; no claim is made here about production recall.

## Verification

- `npx tsc --noEmit --pretty false`: passed (exit 0).
- `npm run lint`: passed (exit 0), with 16 pre-existing warnings and 0 errors; no real credentials were supplied.
- `git diff --check`: passed (exit 0).
- Focused command (`npm test -- --run --silent --reporter=dot` plus the 8 cost-policy/gate/Gemini/migration/contract suites): passed, 8 files and 81 tests.
- Full command (`npm test -- --run --silent --reporter=dot`): passed, 739 files passed and 2 skipped (741 total); 7,808 tests passed and 75 skipped (7,883 total).
- `npm run build` with non-secret synthetic Supabase URL/keys: passed; production bundle compiled, typechecked, generated 48 static pages, and finalized route optimization. No real credentials were supplied.
- The focused, typecheck, lint, diff, and build checks above were rerun after rebasing onto `origin/main` at `5d789fcd0f73242fe5838a0335332995699695d`.
- `lib/services/ai/vertex-ai-cost-migrations-pglite.test.ts` applies both cost migrations in an ephemeral PGlite database and exercises advisory locking, run/order/day denial, idempotent retry identity, cancellation re-admission, conservative settlement, ACL/RLS, `search_path` hardening, and dynamic policy-fence rewrites. Local Supabase/Docker was unavailable, so no remote or persistent database was touched.

## Deployment and rollout requirements

1. Apply `20260902090000_add_vertex_ai_cost_budget_reservations.sql`, then `20260902091000_add_vertex_ai_cost_policy_fences.sql` through the approved production Supabase migration procedure.
2. Deploy with `ANALYSIS_V2_VERTEX_AI_COST_OPTIMIZATION_V212_ROLLOUT=off`, `VERTEX_AI_BUDGET_GUARD_ENABLED=true`, `VERTEX_AI_BUDGET_STORE=supabase`, and the reviewed limits `VERTEX_AI_PER_RUN_BUDGET_USD=2.00`, `VERTEX_AI_PER_ORDER_BUDGET_USD=5.00`, `VERTEX_AI_DAILY_BUDGET_USD=100.00`.
3. Run the fixture gate and inspect route share, denials, unknown-usage rate, reserved-vs-measured cost, schema rejection rate, and real labeled/canary high-risk recall before moving the new flag to `test_entitlement`, then guarded `production` rollout. The checked-in fixture's unverified status is an explicit blocker.
4. Keep Vertex Batch disabled for interactive traffic; an offline concierge exporter may use it later only with the same route, budget, and telemetry contract. Roll back by setting the v2.12 flag to `off`; if the shared budget store is unavailable, fail closed before dispatch.

## Risks and limitations

- The 61.307124% figure is deterministic fixture modeling, not a production-spend claim; actual route mix and usage must be monitored during rollout.
- The observed `0.97` recall is a deterministic fixture ratio, not labeled or canary evidence. Production rollout remains blocked until the evidence status is upgraded with real cases.
- Prompt/media token projection is intentionally conservative, and unknown provider usage retains reserved spend; this may deny work earlier than measured settlement would suggest.
- Pricing aliases and Vertex location rates must be reviewed whenever model SKU pricing changes; unknown model/rate data fails closed rather than being treated as free.
- SQL behavior was validated by executable PGlite migration tests and static contracts; production migration application and shared-instance concurrency still require the deployment procedure and post-deploy RPC/history verification.
- Terminal reservation rows are not automatically deleted because pruning them would break late duplicate recovery. The migration adds a `(state, created_at)` index. A concrete service-role follow-up is required before the ledger's operational horizon is reached: archive only rows older than a replay horizon, aggregate them with an immutable checksum, retain reservation-key tombstones, verify no unresolved usage/active rows, and update snapshots to read aggregates plus active detail. Until then retention remains intentionally unbounded and no bounded-safety claim is made.
