# Final Automatic Analysis Launch Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining presentation, gender-quality, checkout, and measured-latency launch blockers, then perform one non-duplicated Standard production E2E before enabling public automatic analysis and privacy-bounded Amplitude Session Replay.

**Architecture:** Every semantic AI change receives a new immutable AI policy version and is evaluated against the sealed historical Standard source before any new Apify collection. Payment state remains fail-closed until an opaque provider reference makes late completion unambiguous. Public admission remains closed until the same reviewed source is deployed and one full production E2E passes the quality, UI, cost, routing, and duration gates.

**Tech Stack:** Next.js 16, TypeScript, Vitest, Supabase/PostgreSQL/PGlite, Gemini staged analysis, Cloud Run/Cloud Tasks, Apify, Vercel, Amplitude.

---

## Non-negotiable gates

- Never force a gender or relax evidence thresholds merely to reach 20% unknown.
- Never start a second Apify E2E while a request/provider run is active or ambiguous.
- Never clear or reuse a payment order without independent provider evidence.
- Keep public admission closed until the final E2E succeeds.
- Implementations and independent reviews are performed by separate Terra workers.

### Task 1: Restore the intended presentation policy under a new immutable AI version

**Files:**
- Modify: `lib/services/ai/policy-version.ts`
- Modify: `lib/services/ai/stage-policy.ts`
- Modify: `lib/services/ai/v2-staged-analysis.ts`
- Modify: `lib/services/ai/v2-staged-analysis.test.ts`
- Modify: `lib/services/analysis/v2-ai-policy-store.ts`
- Create: `supabase/migrations/20260728110000_add_ai_stage_policy_v210.sql`
- Create/modify: focused policy and PGlite contract tests

- [ ] Add failing tests proving the successor policy uses the v2.8 concrete/witty overview and high-risk narrative contracts, rejects self-reference, and permits at most one evidence-backed `ㅋㅋ` only in one-line overviews.
- [ ] Add failing tests proving v2.9 behavior remains immutable and the successor preserves all v2.9 scheduler/model/threshold semantics.
- [ ] Implement a named capability predicate instead of scattered exact-version comparisons.
- [ ] Add a forward-only DB migration accepting the successor snapshot and applying the same atomic presentation guard.
- [ ] Run focused tests, PGlite tests, `npx tsc --noEmit`, and commit.
- [ ] Obtain independent specification and code-quality approval.

### Task 2: Diagnose the unknown-gender cohorts before changing semantics

**Files:**
- Modify: `lib/services/analysis/replay/resolver-experiment-runner.ts`
- Modify: `lib/services/analysis/replay/resolver-experiment-runner.test.ts`
- Modify: `scripts/replay-resolver-experiment.ts`
- Modify: `scripts/replay-resolver-experiment.test.ts`

- [ ] Add aggregate-only reason histograms for triage outcome, account-context admission, insufficient media, resolver outcome, and high-confidence application.
- [ ] Prove reports contain no account identifiers, names, bios, captions, URLs, prompts, or media locators.
- [ ] Run the historical-source resolver experiment once with paid Gemini and zero new Apify runs.
- [ ] Classify the remaining unknowns into missing evidence, admission capacity, inconclusive model output, and rejected response cohorts.

### Task 3: Create and evaluate an evidence-preserving gender successor policy

**Files:**
- Selected only after Task 2 identifies the dominant remediable cohort.
- Expected boundaries: resolver admission/media selection, staged AI prompt/model policy, scheduler policy, replay adapters, and forward-only policy migrations.

- [ ] Write a labeled hypothesis tied to Task 2’s aggregate evidence.
- [ ] Add failing tests that retain `unknown` for insufficient or inconsistent evidence.
- [ ] Implement the smallest new immutable policy change without modifying thresholds opportunistically.
- [ ] Independently review the implementation.
- [ ] Run AI-only replay against the same source and compare duration, calls, failures, and unknown percentage.
- [ ] Repeat with a new reviewed hypothesis only when the previous result supplies evidence for it; stop if 20% is not achievable from available media without forcing labels.

### Task 4: Preserve risk-ranking product rules

**Files:**
- Modify only if regression tests reveal drift: `lib/domain/analysis/relative-risk-policy.ts`
- Test: `lib/domain/analysis/relative-risk-policy.test.ts`

- [ ] Lock the product interpretation in tests: official/group accounts are ineligible; high-risk candidates require inbound evidence when any inbound candidate exists; if all candidates have zero inbound, the top eligible score may satisfy the required high-risk slot.
- [ ] Rank candidates by score within each eligibility pool.
- [ ] Require 1–3 high-risk and 2–10 caution accounts when at least three eligible candidates exist.
- [ ] Confirm both candidate→target and target→candidate tags retain their existing score components.

### Task 5: Make checkout recovery accurate without weakening payment attribution

**Files:**
- Modify: `app/api/earlybird/checkout/route.ts`
- Modify: earlybird checkout route/UI-state tests
- Modify: status-page copy only where needed

- [ ] Return a distinct safe code for a superseded/cancelled checkout lineage instead of describing it as a still-processing window.
- [ ] Route the user directly to the existing status explanation without mutating order state or issuing another checkout.
- [ ] Keep re-purchase blocked until Groble supplies a provider intent identifier or a documented expiry/invalidation guarantee that can be verified server-side.
- [ ] Document the provider dependency and operator procedure.

### Task 6: Verify measured duration and production routing

- [ ] Run scheduler/model tests and confirm the existing follower/following estimate bands remain honest.
- [ ] Deploy reviewed application, migration, and canonical `analysis-worker` source.
- [ ] Verify canonical queues target `analysis-worker`, secondary-e2e receives zero calls, and public admission remains closed.
- [ ] Check for active or ambiguous requests/provider runs.
- [ ] Start exactly one authorized Standard E2E only when none exists.
- [ ] Measure preflight, collection, AI stages, R2/proxy image success, total duration, and modeled/provider cost.
- [ ] Require a successful result, no failed library card, and all specified result UI invariants.

### Task 7: Open automatic analysis only after all launch gates pass

- [ ] Require full E2E success, unknown at or below 20%, complete cost evidence, correct worker routing, and acceptable duration for the displayed band.
- [ ] Enable public automatic admission using the reviewed deployment procedure.
- [ ] Enable Amplitude Session Replay at the existing privacy-bounded 1–10% production sampling configuration.
- [ ] Verify masked replay/event arrival without exposing Instagram IDs, profile content, contacts, or result narratives.
- [ ] Exercise rollback/readiness checks.

### Task 8: Finalize the repository

- [ ] Update and deduplicate operational docs so current policies and launch state have one canonical source.
- [ ] Run complete CI-equivalent tests and independent final review.
- [ ] Create PR, wait for CI, merge, deploy, and verify deployed SHA/revisions.
- [ ] Remove only worktrees proven clean, merged, and unused; preserve active Demo/Sentry worktrees and all user-owned untracked files.
- [ ] Report baseline-versus-final measurements and explicitly list any externally blocked item.
