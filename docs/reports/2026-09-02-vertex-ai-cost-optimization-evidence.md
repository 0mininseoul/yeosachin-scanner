# Vertex AI cost optimization evidence

Date: 2026-09-02 (Asia/Seoul)

## Scope and safety

This change implements the approved forward-only `ai-stage-policy-v2.12` cost path, complete Vertex pricing, pre-dispatch monetary reservations, replay-safe telemetry, and a provider-free dry-run gate. The landing-page marketing copy and `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql` were not changed. No paid model request, production-account canary, Vertex Batch job, production Supabase mutation, or production credential was used.

## Design and implementation artifacts

- Design: `docs/superpowers/specs/2026-09-02-vertex-ai-cost-optimization-design.md`
- Implementation plan: `docs/superpowers/plans/2026-09-02-vertex-ai-cost-optimization.md`
- Deterministic fixture: `reports/vertex-ai-cost-optimization-fixture.json`
- Cost/quality gate: `lib/services/ai/vertex-ai-cost-gate.ts`, `scripts/vertex-ai-cost-gate.ts`
- Budget store and migration: `lib/services/ai/vertex-ai-budget-store.ts`, `supabase/migrations/20260902090000_add_vertex_ai_cost_budget_reservations.sql`
- Forward policy fences: `supabase/migrations/20260902091000_add_vertex_ai_cost_policy_fences.sql`

The implementation uses `gemini-3.1-flash-lite` for the default first pass and permits `gemini-3.7-flash` only with the typed `high_value` or `ambiguous` route reason. Route/model identity, prompt/media projection, output/thinking ceiling, attempt number, and request/order/day scope are reserved before every provider attempt, including retries and replay; measured usage settles the reservation and missing usage conservatively retains the reservation. Production uses the shared service-role Supabase RPC store, while tests/replay use the same atomic interface in memory; replay keeps durable result/token writes disabled but emits in-memory attempt telemetry.

## TDD evidence

### RED

Before implementation, this command was run:

```text
npm test -- --run lib/services/ai/vertex-ai-cost-policy.test.ts lib/services/ai/vertex-ai-cost-gate.test.ts
```

It failed as expected because the new modules did not exist (`Cannot find module './vertex-ai-cost-gate'` and `Cannot find module './vertex-ai-cost-policy'`), with zero tests executed in the two new suites.

### GREEN

After implementation, the same focused policy/gate command passed: 2 files and 8 tests. The final focused integration run passed 15 files and 442 tests, including pricing, route policy, budget store, Gemini admission ordering and abort settlement, V2 stage/runtime identity, replay adapter/runner telemetry, V214 concierge replay, and both migration contract suites.

## Exact modeled cost and quality evidence

Command:

```text
npm run cost:vertex-ai:gate
```

Result: passed with no violations.

| Metric | Baseline | Proposed | Evidence |
| --- | ---: | ---: | --- |
| Input tokens | 28,696,298 | 28,696,298 | Aggregate volume unchanged |
| Output tokens | 13,834,322 | 13,834,322 | Aggregate volume unchanged |
| Gross cost | $146.801862 | $56.801862 | Historical 3.7 pricing vs Lite/default split |
| Savings | — | **$90.000000 (61.307124%)** | Exceeds 50% release threshold |

The proposed route split is 24,000,000 input + 10,000,000 output tokens on `gemini-3.1-flash-lite` ($21.000000), and 4,696,298 input + 3,834,322 output tokens on explicitly justified `gemini-3.7-flash` ($35.801862). The quality contract passed with unknown usage rate `0`, high-risk recall `0.97`, default-route share `0.8`, maximum output `4096`, maximum thinking `LOW`, and maximum attempts `2`.

## Verification

- `npx tsc --noEmit --pretty false`: passed.
- `npm run lint`: passed with 0 errors and 16 existing warnings; no new lint error was introduced.
- `git diff --check`: passed.
- `npm test -- --run`: passed, 737 files and 7,794 tests; 2 files and 75 tests skipped by existing integration/smoke gates.
- `npm run build` with non-secret synthetic Supabase URL/keys: passed; Next.js compiled, typechecked, generated 48 static pages, and finalized the route build. A no-env build is expected to fail at existing Supabase configuration checks, so no real credentials were supplied.
- The budget SQL migration was compiled and exercised in an ephemeral PGlite database, including advisory locking, run/order/day denial, idempotent retry identity, cancellation re-admission, conservative settlement, ACL/RLS, and `search_path` hardening. Local Supabase/Docker was unavailable, so no remote or persistent database was touched.

## Deployment and rollout requirements

1. Apply `20260902090000_add_vertex_ai_cost_budget_reservations.sql`, then `20260902091000_add_vertex_ai_cost_policy_fences.sql` through the approved production Supabase migration procedure.
2. Deploy with `ANALYSIS_V2_VERTEX_AI_COST_OPTIMIZATION_V212_ROLLOUT=off`, `VERTEX_AI_BUDGET_GUARD_ENABLED=true`, `VERTEX_AI_BUDGET_STORE=supabase`, and the reviewed limits `VERTEX_AI_PER_RUN_BUDGET_USD=2.00`, `VERTEX_AI_PER_ORDER_BUDGET_USD=5.00`, `VERTEX_AI_DAILY_BUDGET_USD=100.00`.
3. Run the fixture gate and inspect route share, denials, unknown-usage rate, reserved-vs-measured cost, schema rejection rate, and high-risk recall before moving the new flag to `test_entitlement`, then guarded `production` rollout.
4. Keep Vertex Batch disabled for interactive traffic; an offline concierge exporter may use it later only with the same route, budget, and telemetry contract. Roll back by setting the v2.12 flag to `off`; if the shared budget store is unavailable, fail closed before dispatch.

## Risks and limitations

- The 61.307124% figure is deterministic fixture modeling, not a production-spend claim; actual route mix and usage must be monitored during rollout.
- Prompt/media token projection is intentionally conservative, and unknown provider usage retains reserved spend; this may deny work earlier than measured settlement would suggest.
- Pricing aliases and Vertex location rates must be reviewed whenever model SKU pricing changes; unknown model/rate data fails closed rather than being treated as free.
- SQL behavior was validated in PGlite and static migration contracts; production migration application and shared-instance concurrency still require the deployment procedure and post-deploy RPC/history verification.
