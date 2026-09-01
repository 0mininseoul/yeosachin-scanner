# Vertex AI Cost Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guarded low-cost-first Vertex AI path that models at least 50% gross savings against the fixed 2026-08-19 baseline while preserving an explicit quality contract and complete replay/production telemetry.

**Architecture:** Keep historical AI stage policies immutable and add an opt-in `ai-stage-policy-v2.12`. A pure route/pricing/budget layer chooses Flash-Lite by default and allows 3.7 only for typed high-value/ambiguous escalation. `analyzeWithGemini` performs strict pre-dispatch admission for every attempt, while durable V2 adapters and replay adapters provide the order/request scopes and collect the same telemetry; a pure fixture gate supplies deterministic release evidence.

**Tech Stack:** TypeScript, Next.js App Router, Vitest, Zod, existing Google GenAI integration, Supabase RPC/store seam, JSON fixture and Node script.

---

## 1. Lock the public contracts with failing tests (RED)

- [ ] Add `lib/services/ai/vertex-ai-cost-policy.test.ts` covering typed routes, default Lite routing, explicit high-value/ambiguous 3.7 routing, strict unknown pricing, output/thinking/retry ceilings, and per-run/order/day budget denial before a dispatch callback.
- [ ] Add `lib/services/ai/vertex-ai-cost-gate.test.ts` covering exact baseline arithmetic, the 50% savings threshold, quality thresholds, and failures for unknown usage, unapproved 3.7 use, excessive retries, and insufficient recall.
- [ ] Add replay assertions to the focused replay tests for non-null attempt token/cost telemetry and budget admission on replay; add a Gemini integration seam assertion that the provider callback is not reached when admission rejects.
- [ ] Run the new focused tests before adding implementation. Capture the observed failing output as the RED evidence in `docs/reports/2026-09-02-vertex-ai-cost-optimization-evidence.md`; failures must be missing-contract/behavior failures rather than test-discovery errors.

## 2. Complete model pricing and build the pure policy/guard (GREEN)

- [ ] Extend `lib/services/ai/gemini-cost.ts` with canonical `gemini-3.7-flash` pricing at `$1.50/$7.50` per million tokens, explicit pricing lookup exports, and a strict fail-closed estimator while preserving nullable legacy behavior and existing model tests.
- [ ] Add `lib/services/ai/vertex-ai-cost-policy.ts` with route/reason types, policy ceilings, prompt/media pre-dispatch estimation, UTC day keys, environment limit parsing, and a reservation interface.
- [ ] Implement an atomic in-memory budget guard for tests/local execution and a durable-store interface for production. Enforce per-run, per-order, and UTC-day ceilings, idempotent recovery keys, conservative unknown settlement, and distinct retry reservations.
- [ ] Add the dedicated Supabase migration/store RPC contract for shared monetary reservations. Do not modify `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql`.
- [ ] Re-run the policy/cost tests and record the first GREEN run. Confirm the test provider callback count is zero for rejected admissions and that exact fixture math is stable to six decimals.

## 3. Add the forward-only stage policy and route identity

- [ ] Add `ai-stage-policy-v2.12` to `lib/services/ai/stage-policy.ts` with Lite defaults, bounded output/thinking values, one-retry ceilings, a cost-guard capability, and an explicit rollout selector input. Do not mutate v2.6-v2.11 snapshots or their selection behavior when the new flag is absent.
- [ ] Add route selection helpers that require `high_value` or `ambiguous` for 3.7 and default every stage to Lite. Keep route/model/thinking/media/max-output in the staged result identity so a default and escalation cannot share a cache/result row.
- [ ] Update `lib/services/ai/v2-staged-analysis.ts` feature/narrative/triage options to pass matching route overrides to both identity creation and `analyzeWithGemini`; derive ambiguous escalation only from the deterministic triage contract and mark high-value narrative calls explicitly in the durable runtime.
- [ ] Add/update stage-policy and staged-analysis tests proving old policy bytes are unchanged, v2.12 defaults are Lite, escalation identities differ, and no untyped model override silently selects 3.7.
- [ ] Run focused stage tests and typecheck after the policy integration.

## 4. Enforce admission and lower attempts/budgets on every provider path

- [ ] Wire the shared budget guard into `lib/services/ai/gemini.ts` immediately before SDK dispatch, using selected model/location, prompt/media estimate, output/thinking ceiling, request/order/operation scopes, and attempt number. Ensure custom/legacy calls are also fail-closed for unknown pricing when the guard is enabled.
- [ ] Pass durable request/order scope through `lib/services/analysis/v2-ai-stage-runtime.ts` and `lib/services/analysis/v2-ai-result-store.ts` without bypassing existing concurrency leases or result identity checks.
- [ ] Lower v2.12 default output/thinking/retry budgets and ensure a rejected response-retry is admitted as a new attempt; preserve historical retry behavior for old policies.
- [ ] Add production-path tests for default, escalation, retry, and budget-denied dispatch ordering, then run the focused Gemini/V2 runtime suites.

## 5. Remove replay telemetry bypass while retaining durable-write isolation

- [ ] Extend `StagedAiAuditContext` and replay adapter plumbing with an in-memory `onTelemetry` callback. Remove the semantic dependency on `skipTokenLog` for replay admission while retaining the stateless capability that prevents production token/result writes.
- [ ] Aggregate input/output/thinking tokens, estimated cost, unknown-usage status, route, reservation, retry count, and failure disposition in `lib/services/analysis/replay/replay-staged-ai-adapter.ts` and `replay-runner.ts`.
- [ ] Add tests proving replay has no Supabase write, still has complete telemetry and budget reservations, and duplicate recovery observations do not double-count while genuine retries do.
- [ ] Run the replay-focused suite and record GREEN evidence.

## 6. Add the deterministic fixture gate and operations evidence

- [ ] Add `reports/vertex-ai-cost-optimization-fixture.json` with the fixed token totals, route split, model rates, quality thresholds, and route/attempt metadata.
- [ ] Add `lib/services/ai/vertex-ai-cost-gate.ts` with schema validation, cost/savings calculation, and quality/route/budget contract evaluation. Keep it provider-free and deterministic.
- [ ] Add `scripts/vertex-ai-cost-gate.ts`, package script `cost:vertex-ai:gate`, and focused CLI tests. The command must not load `.env.local`, credentials, or call a network endpoint.
- [ ] Run the gate to produce before/after cost evidence and quality-contract evidence in `docs/reports/2026-09-02-vertex-ai-cost-optimization-evidence.md`.

## 7. Verification and handoff

- [ ] Run focused tests, `npm run typecheck` (or the repository’s equivalent), `npm run lint`, relevant full tests, and `npm run build`; fix only regressions caused by this work.
- [ ] Inspect `git diff` and `git status` for scope: no marketing-copy edits, no score-audit cleanup migration edits, and preserve unrelated pre-existing changes.
- [ ] Commit only the cost design/plan, AI routing/cost/budget/telemetry implementation, focused tests, migration/store contract, fixture, script, and evidence docs; push the branch and open a PR.
- [ ] In the final coordinator report include the PR URL, changed files, observed RED and GREEN commands, exact modeled savings (`$146.801862 → $56.801862`, `$90.000000`, `61.307124%`), quality evidence, known risks, and rollout/deployment requirements. Confirm that no paid model or production-account canary was run.
