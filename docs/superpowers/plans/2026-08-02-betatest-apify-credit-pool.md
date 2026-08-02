# Betatest Apify Free-Credit Pool Implementation Plan

> **For Codex:** Execute this plan with the `subagent-driven-development` workflow and test-driven development. Keep remote migrations, live secret mutation, deployment, and real Apify Actor calls outside the implementation branch until review and local verification are green and the user separately approves production rollout.

**Goal:** Give explicitly allowlisted users entering through `/betatest` a checkout-free Analysis V2 path that uses only the six free Apify accounts, detects their current credit, rejects before analysis when the pool cannot safely cover the selected plan, and makes released capacity available to the next user without a deployment or a queue wait.

**Architecture:** Add a server-persisted `betatest` entry channel without widening the existing `PlanAccessMode` domain. The preflight worker reads live Apify account limits/usage for the six free credential slots and stores only sanitized slot-level snapshots. At admission, an atomic database allocator reserves conservative per-operation budgets and freezes an operation-to-slot policy for the request. Existing provider-run ledgers must prove every new run uses the frozen slot and stays within the operation reservation. Terminal request/preflight transitions settle reconciled usage and release unused capacity; the worker refreshes balances opportunistically after settlement. This is runtime state management: there is no per-analysis secret change, revision rollout, or deployment.

**Stack:** Next.js 16 App Router, React 19, TypeScript, Apify Client, Supabase/PostgreSQL, PGlite, Cloud Tasks/Cloud Run, Vitest, Bash, Vercel.

---

## Accepted product and safety invariants

- `/betatest` is authenticated and separately allowlisted on the server. Knowing the URL is never authority.
- `BETATEST_FREE_POOL_ENABLED` defaults to false. No migration seeds a user grant.
- The free pool contains exactly `primary`, `tertiary`, `quaternary`, `quinary`, `senary`, and `septenary`.
- `secondary` remains available to ordinary paid/production flows but is structurally invalid in every beta pool table, allocator, policy, and test fixture.
- Tokens, Apify account identifiers, user UUIDs, and cookies are never persisted in pool snapshots or emitted in pool logs. Only credential-slot aliases and aggregate USD figures may be stored/observed.
- A balance snapshot comes from Apify's account limits/current monthly usage APIs, has a bounded age, and fails closed if any required field is missing, invalid, stale, or the call fails.
- Outstanding reservations and reconciled spend newer than a snapshot are subtracted from observed headroom. The system never trusts the provider snapshot alone while runs are active.
- Admission reserves the whole selected-plan budget before an analysis request can start. Insufficient capacity returns a stable capacity-unavailable response; it does not silently use `secondary`, charge product checkout, partially start, or create an unbounded wait queue.
- Each request gets one immutable operation-slot map. Retries resume the same provider run/slot; no mid-run token rotation is allowed.
- Terminal transitions release unused reservations transactionally. Actual usage stays debited until a later provider snapshot is new enough to include it.
- Preflight-only reservations expire and settle through the existing retention/recovery paths.
- Immediate next-user admission is guaranteed only while real reservable headroom exists. A genuine exhausted/free-provider-unavailable pool is surfaced honestly.
- The landing-page marketing copy in `app/page.tsx` is untouched.

## Credential and operation vocabulary

General V2 Apify credential slots become:

`primary | secondary | tertiary | quaternary | quinary | senary | septenary`

Beta-free slots are a separate exact subset:

`primary | tertiary | quaternary | quinary | senary | septenary`

The beta operation policy uses these exact operation families:

1. `target-profile`
2. `relationship-followers`
3. `relationship-following`
4. `profile-fallback`
5. `profile-repair`
6. `target-likers`
7. `target-comments`
8. `candidate-likers`

The existing `authorized-free-e2e-v1` policy remains byte-for-byte compatible. Beta uses a new policy version, `betatest-free-pool-v1`; legacy profile repair may continue to alias `profile-fallback`, but beta profile repair must have its own reserved family.

## Pool model

The forward migration introduces service-owned data equivalent to:

- `analysis_beta_access_grants`: allowlisted user, enabled/expiry metadata, no public enumeration.
- `analysis_apify_credit_snapshots`: one row per beta-free slot with observed limit/usage, billing-cycle identity, observation time, and health state.
- `analysis_beta_pool_allocations`: one idempotent allocation per beta preflight/request, its lifecycle, selected plan, immutable policy version, and expiry/settlement timestamps.
- `analysis_beta_pool_reservations`: one row per allocation/operation with exact slot, conservative reserved USD, reconciled actual USD, and lifecycle state.

All tables force RLS and revoke direct client access. Narrow authenticated self-check RPCs may answer only whether the caller has beta access; allocation, refresh, bind, settle, and recovery RPCs are service-role only.

The allocator uses deterministic best-fit/decreasing placement over current effective headroom, proposes a complete map, and commits through one RPC that locks all six account rows in canonical slot order, rechecks freshness/headroom, inserts every reservation, and binds the policy atomically. A serialization/headroom conflict may be recalculated a bounded number of times; it never waits in a durable admission queue.

---

## Task 1: Add the seventh general slot and free-pool credit primitives

**Files:**

- Modify: `lib/services/instagram/providers/types.ts`
- Modify: `lib/services/instagram/providers/apify-relationship.ts`
- Modify: `lib/services/instagram/providers/apify.test.ts`
- Create: `lib/services/analysis/beta-apify-credit-pool.ts`
- Create: `lib/services/analysis/beta-apify-credit-pool.test.ts`
- Modify: `.env.example`

**Test first:**

- Prove general runtime selects `APIFY_SEPTENARY_API_TOKEN` only for `septenary`.
- Prove the beta-free tuple is exactly the six accepted slots and rejects `secondary` and unknown values.
- Prove live readings normalize finite non-negative monthly limit/usage and billing-cycle timestamps.
- Prove effective available credit never goes below zero and accounts for active reservations/local post-snapshot debit.
- Prove concurrent six-slot refresh returns only sanitized aliases/amounts and fails the whole admission refresh closed when a required account cannot be read.
- Prove no returned/loggable structure includes tokens or provider account IDs.

**Implementation:**

- Append `septenary` to the shared V2 slot tuple and exact env-key map.
- Add a separate immutable `BETA_APIFY_FREE_CREDENTIAL_SLOTS` constant that excludes `secondary` by construction.
- Add a small injected Apify user-client boundary for `limits()`/`monthlyUsage()` so tests make no network calls.
- Keep current primary legacy-token fallback behavior unchanged; every non-primary slot is same-name and fail-closed.

Run the focused tests, lint the touched modules, self-review, and commit.

## Task 2: Add the append-only pool schema and atomic reservation lifecycle

**Files:**

- Create: `supabase/migrations/20260802HHMMSS_add_betatest_apify_credit_pool.sql` using the next collision-free timestamp at implementation time
- Create: `lib/services/analysis/beta-apify-credit-pool-migration-contract.test.ts`
- Create: `lib/services/analysis/beta-apify-credit-pool-pglite.test.ts`
- Modify only if the general slot validator requires forward recreation: focused existing migration contract/PGlite tests

**Test first:**

- Prove the forward helper accepts all seven general slots while the beta helper accepts exactly six and rejects `secondary`/null.
- Prove RLS, direct-access revokes, service-only mutation grants, normalized non-negative amounts, snapshot age, cycle, and unique ownership constraints.
- Prove grants cannot be enumerated and the authenticated self-check cannot inspect another user.
- Prove proposed operation maps require all eight exact keys, finite positive bounded budgets, only beta-free slots, and `betatest-free-pool-v1`.
- Prove an allocation is all-or-nothing, idempotent for the same preflight/request identity, and conflicts on altered plan/budget/map.
- Prove two concurrent allocations cannot oversubscribe the same observed headroom.
- Prove stale/unhealthy snapshots reject admission.
- Prove provider-run reservation rejects the wrong slot, `secondary`, an unknown operation, and cumulative maximum charge above that operation's budget.
- Prove terminal success/failure/cancel/timeout and expired preflights release unused amounts while preserving reconciled post-snapshot debit.
- Prove repeated settlement/recovery is idempotent and an unreconciled started run remains conservatively held.

**Implementation:**

- Add the four pool/access tables and exact helper validators described above.
- Add narrow RPCs for self-access check, sanitized snapshot upsert, preflight hold, complete request allocation/bind, provider-run budget validation, terminal settlement, and expired-preflight recovery.
- Extend the general credential validator to `septenary` with an append-only migration; do not edit prior applied migrations.
- Preserve `authorized-free-e2e-v1` and its seven-key map. Add a new policy constraint branch instead of rewriting old semantics.
- Use row locks in canonical slot order and database time for every freshness/expiry decision.
- Keep functions `SECURITY DEFINER SET search_path = ''`, validate `auth.uid()` where applicable, revoke before narrowly granting, and do not expose token/account identity columns because none exist.

Run both contract and PGlite tests, the affected historical policy tests, self-review, and commit.

## Task 3: Integrate refresh, reservations, and immutable slot policy into V2 runtime

**Files:**

- Modify focused preflight context/store/worker modules under `lib/services/analysis/`
- Modify provider-policy and provider-run persistence modules under `lib/services/analysis/`
- Modify collection executors only where operation-family identity is selected
- Modify `app/api/analysis/preflight/worker/route.ts` and `app/api/analysis/v2/worker/route.ts` only through shared service boundaries
- Add focused unit, route, lifecycle, and recovery tests beside each changed module

**Test first:**

- Prove a beta preflight refreshes all six free snapshots before its first paid Apify start and reserves `target-profile` on a free slot.
- Prove failure/staleness/capacity exhaustion terminalizes beta preflight with a stable capacity-unavailable code before an analysis request/provider start.
- Prove ordinary production and signed `test_entitlement` preflights are unchanged.
- Prove beta plan admission computes conservative budgets from the immutable plan/provider caps, allocates the remaining seven families atomically, and binds `betatest-free-pool-v1` before initial analysis dispatch.
- Prove every collection/profile-repair/provider-run start resolves an exact operation family and the DB rejects a different credential slot or cumulative maximum charge overflow.
- Prove retries/recovery reload the stored map and never recalculate or rotate slots.
- Prove every request terminal status invokes idempotent settlement; refresh is attempted after settlement but a refresh failure cannot erase the conservative local debit.
- Prove preflight expiry/cancel releases holds, while ambiguous/unreconciled starts remain held.
- Prove logs/events include only slot aliases and aggregate credit, never tokens, account IDs, or raw provider payloads.

**Implementation:**

- Persist `analysis_entry_channel = 'betatest'` before preflight dispatch; client headers/query parameters cannot set it on the ordinary route.
- Refresh through the worker, where the six secrets already exist. Vercel never receives the pool tokens.
- Share provider cost constants with the allocator or add one reviewed catalog so reserved maximums cannot drift below runtime `maxTotalChargeUsd`.
- Add explicit beta `profile-repair` operation routing while retaining legacy test-policy behavior.
- Attach the preflight allocation to the created request in the same transaction that binds the provider execution policy and reserves initial dispatch.
- Settle via durable DB state transitions; opportunistic provider refresh is an optimization, not the correctness boundary.

Run focused runtime suites, self-review, and commit.

## Task 4: Build the authenticated `/betatest` entry and checkout-free UX

**Files:**

- Create: `app/betatest/page.tsx` and minimal colocated client/component files as needed
- Create: dedicated beta preflight and admission route handlers under `app/api/analysis/betatest/`
- Refactor the existing analyze form/hook only enough to inject trusted endpoint/flow configuration
- Modify: `proxy.ts`
- Add route/component/proxy tests

**Test first:**

- Prove an anonymous `/betatest` visit redirects to `/login?redirectTo=%2Fbetatest` and returns safely after auth.
- Prove authenticated users without an active grant receive no analysis form and no beta API authority.
- Prove an active grant plus enabled flag uses only the dedicated beta route and persists the beta channel server-side.
- Prove disabling the feature fails closed even for a granted user.
- Prove the ordinary `/analyze` endpoints cannot opt into beta by body, header, referrer, or query string.
- Prove beta admission bypasses product checkout/payment/waitlist and routes directly to the normal progress page only after pool allocation succeeds.
- Prove capacity exhaustion keeps the user on a clear retryable state without creating a request, charging checkout, or exposing account details.
- Prove idempotent retries reopen the same preflight/request.
- Prove existing `/analyze`, early-bird checkout, login redirect validation, progress, and result behavior remain green.
- Prove `app/page.tsx` marketing copy is unchanged.

**Implementation:**

- Use server-side auth plus the narrow grant self-check on the page and every beta mutation route.
- Reuse the existing analyze UI and progress/result pages; inject the beta API base/checkout-free admission behavior rather than fork the entire UX.
- Keep user-visible language about current free-analysis availability; do not expose slot names, balances per account, tokens, or internal policy.
- Add `/betatest` to protected-route handling without weakening existing redirect safety.

Run focused route/component suites, self-review, and commit.

## Task 5: Extend exact secret/deployment inventories and operational controls

**Files:**

- Modify: `scripts/configure-analysis-v2-secrets.sh`
- Modify: `scripts/generate-analysis-v2-env-files.sh`
- Modify: `scripts/deploy-analysis-v2-worker.sh`
- Modify: `scripts/test-analysis-v2-secret-scripts.sh`
- Modify: `scripts/test-analysis-v2-infra-scripts.sh`
- Modify relevant runtime environment contract tests
- Modify: `.env.example`

**Test first:**

- Prove exact identity `septenary` -> `APIFY_SEPTENARY_API_TOKEN` -> `ai-baram-v2-apify-septenary:<numeric-version>` throughout configuration, manifest generation, deployment, validation, and recovery inventories.
- Prove plaintext tokens are rejected and never printed.
- Prove beta feature flags default off and are identical in Vercel/worker configuration where required.
- Prove `secondary` remains mounted for existing production recovery where already required but is never classified as beta-free.
- Prove a normal deployment contains all reviewed same-name secret refs; no runtime code mutates refs or deploys a revision per request/settlement.
- Preserve exact numeric versions, deploy locks, active-revision checks, and existing prune-fence behavior.

**Implementation:**

- Add the same-name septenary secret reference to worker build/runtime inventories.
- Add the beta flag and staleness/timeout settings as non-secret env values with conservative validation.
- Do not add Apify tokens to Vercel.
- Keep rollout as one ordinary reviewed deployment. Request completion changes only DB/runtime pool state.

Run both Bash suites and focused environment tests, self-review, and commit.

## Task 6: Add observability, recovery, and the operator runbook

**Files:**

- Create: `docs/betatest-apify-credit-pool-runbook.md`
- Modify relevant operational logger/event contracts and admin observability response tests
- Modify: `docs/analysis-v2-production-operations.md` only where the new channel needs a cross-reference
- Modify: `lib/observability/operations-docs-contract.test.ts`

**Required coverage:**

- Events/metrics: refresh success/failure/latency, total effective headroom, allocation success/rejection, reservation/actual/released USD, stale snapshots, settlement lag, and active allocations. Labels use slot aliases only and remain bounded-cardinality.
- Alerts: repeated refresh failure, stale snapshots, negative/overcommitted invariant, settlement lag, and unexpected beta use while the feature is disabled.
- Recovery: feature-off stops new beta admission but does not abandon active allocations; active requests continue on their frozen maps; terminal/recovery settlement remains idempotent.
- Grant operations: documented service-role/SQL procedure with exact user supplied out-of-band, expiry, audit metadata, and rollback. Never include a real UUID in repository docs.
- Rollout: migration dry-run/allowlist/history verification, secret existence/version verification, worker deploy, Vercel deploy, grant a single test user, zero-cost mock/synthetic validation, one explicitly approved live canary, staged expansion, and rollback.
- Explicitly state that no per-analysis deployment occurs and why runtime reservation is the no-wait handoff mechanism.

Run docs/observability contracts, self-review, and commit.

## Task 7: End-to-end verification and final review

Run, in order:

1. All changed/focused Vitest and Bash suites.
2. All PGlite and migration contract tests affected by credential/policy changes.
3. `npm run lint`
4. `npx tsc --noEmit`
5. `npm run build`
6. `npm test -- --run`
7. `git diff --check`
8. Secret scan over the reviewed diff.

Request one final code review across the complete branch and fix all critical/important findings. Confirm the original worktree and its protected user-owned files are untouched. Do not run `supabase db push`, mutate Secret Manager, deploy Cloud Run/Vercel, seed a grant, or make a real Apify call in this implementation phase.

## Production rollout requiring separate approval

After local implementation is green, present the exact commit SHA, migration allowlist, dry-run evidence, secret-reference diff, deployment commands, rollback commands, and canary budget to the user. Only after explicit rollout approval:

1. verify the linked project and remote migration head read-only;
2. use an isolated temporary Supabase workdir and dry-run the single allowlisted migration;
3. apply it once and verify remote migration history/definitions before doing anything else;
4. verify/create the same-name septenary secret version without printing it;
5. deploy the worker with beta disabled, verify revision/SHA/secret refs;
6. deploy Vercel with beta disabled and verify route health;
7. enable the flag, add exactly the approved grant, and run an explicitly approved bounded canary;
8. monitor pool/ledger invariants, then expand or disable using the documented rollback.
