# Production preflight and checkout recovery hotfix implementation plan

> **Worker requirement:** Implement code and migrations with a Luna Max worker.
> Use test-driven development, preserve unrelated changes, and stop before any
> production mutation or deployment. The orchestrator owns reviews and release.

**Goal:** Make the anonymous preflight → Kakao sign-in → Standard checkout path
durable and observable, then remove only the confirmed administrator test-order
blocker through an explicitly invoked production operation.

**Architecture:** Preserve the current public claim RPC and analysis pipeline.
Move the narrowly privileged claim transition into a private PostgreSQL helper,
make authenticated creation hash-complete, bypass B-lite for legacy incomplete
rows, and replace raw external browser redirects with an owner-validated
same-origin endpoint that issues a server-side `303`.
Apply one schema migration; run the administrator cleanup separately as an
explicitly invoked production operation outside the universal migration set.

**Tech stack:** Next.js 16, React 19, TypeScript, Vitest, Supabase/PostgreSQL,
Groble, Amplitude, Axiom, Vercel.

---

### Task 1: Lock the claim and target-hash contracts with failing tests

**Files:**
- Modify the focused anonymous-preflight service and route tests.
- Modify the focused preflight service/route/worker tests.
- Add a PostgreSQL contract test or migration assertions following repository
  conventions.

- [ ] Add a failing test for claiming an anonymous preflight when the owner has
  a stale authenticated preflight.
- [ ] Add failing concurrency/authorization assertions for the claim helper.
- [ ] Add a failing route/store assertion that authenticated creation supplies
  a 64-character target hash to the v2 persistence RPC.
- [ ] Add a failing worker test proving a legacy missing hash skips B-lite and
  enters the ordinary provider path without a retry delay.
- [ ] Run only these tests and record the expected failures.

### Task 2: Implement atomic claim and hash-complete creation

**Files:**
- Modify the single recovery schema migration under `supabase/migrations/`.
- Modify `lib/services/analysis/anonymous-preflight.ts` only if the preserved
  public RPC contract requires an adapter change.
- Modify `lib/services/analysis/preflight.ts`.
- Modify `app/api/analysis/preflight/route.ts`.
- Modify the minimum worker/cohort code that currently throws on a missing hash.

- [ ] Add the private, bounded `SECURITY DEFINER` claim helper with
  `search_path = ''`, per-user transaction locking, row locking, auth identity
  validation, and minimum grants.
- [ ] Preserve the public RPC signature through a `SECURITY INVOKER` wrapper.
- [ ] Add the service-only v2 create-or-replay RPC with hash validation and
  atomic bind-or-compare behavior. Do not overload the old RPC name.
- [ ] Compute the hash before authenticated store creation and make the
  production store input require it.
- [ ] Move the legacy missing-hash branch before B-lite activation without
  registering or emitting a server `legacy_missing_target_hash` fallback.
- [ ] Run the focused tests until they pass.

### Task 3: Lock the same-origin checkout contract with failing tests

**Files:**
- Modify `app/api/earlybird/checkout/route.test.ts`.
- Add tests for `app/api/earlybird/checkout/redirect/route.ts`.
- Modify `lib/services/earlybird/checkout.test.ts` and store tests.
- Modify `lib/services/earlybird/ui-state.test.ts`.
- Modify status-page/component tests.

- [ ] Assert POST returns a safe same-origin `nextUrl` and no `checkoutUrl`.
- [ ] Assert the redirect route returns `303` plus `Cache-Control: no-store`
  only after owner, active-account, phone, order, pricing, seller-reference,
  evidence, and age validation.
- [ ] Assert malformed input and failed validation stay on a bounded same-origin
  destination without sensitive detail.
- [ ] Assert recovery is allowed before 24 hours and denied at/after 24 hours.
- [ ] Assert `SUPERSEDED_LINEAGE` never renders a recovery CTA.
- [ ] Assert duplicate client actions remain idempotent.
- [ ] Run the focused tests and record the expected failures.

### Task 4: Implement server-owned checkout navigation and bounded recovery

**Files:**
- Add `app/api/earlybird/checkout/redirect/route.ts`.
- Modify `app/api/earlybird/checkout/route.ts`.
- Modify `lib/services/earlybird/checkout.ts` and `store.ts`.
- Modify the smallest focused helper for safe same-origin continuation URLs.
- Modify `lib/services/earlybird/ui-state.ts`.
- Modify `app/analyze/page.tsx`, `app/earlybird/page.tsx`, and
  `app/earlybird/earlybird-status.tsx` only as required.
- Modify `lib/services/earlybird/order-status.ts` for a server-computed recovery
  capability.

- [ ] Generate the continuation URL on the server from bounded identifiers.
- [ ] Validate the continuation path before browser navigation.
- [ ] Navigate immediately after the Amplitude event call; do not await a
  browser analytics flush.
- [ ] Revalidate all recovery conditions on GET and generate the Groble URL only
  on the server.
- [ ] Return `303`/`no-store` on success and bounded same-origin UX on failure.
- [ ] Include `created_at` in the recovery record and enforce 24 hours in the
  service, not in the browser.
- [ ] Make superseded and expired order UI status-only.
- [ ] Delete obsolete raw-external-URL UI helpers and tests only when no caller
  remains.
- [ ] Run the checkout/status suites until they pass.

### Task 5: Add redirect observability without changing payment authority

**Files:**
- Modify the bounded business-event schema and logger call site.
- Modify observability contract tests.
- Modify the existing operations document that inventories business events.
- Preserve the recent Amplitude funnel files unless a direct continuation call
  site requires a compatible edit.

- [ ] Add `earlybird.checkout_redirected` to the Axiom event vocabulary.
- [ ] Emit it only after redirect validation and immediately before the `303`.
- [ ] Keep properties bounded and free of URLs, phone numbers, seller
  references, UUIDs, tokens, and raw payloads.
- [ ] Preserve the existing Amplitude `checkout_redirected` funnel boundary.
- [ ] Give server logging a short bounded flush opportunity without blocking a
  valid checkout on logging failure.
- [ ] Pass observability and privacy contract tests.

### Task 6: Add the fail-closed administrator blocker cleanup operation

**Files:**
- Create `supabase/operations/20260828_cleanup_confirmed_administrator_test_order.sql`.
- Add operation contract and executable PGlite/native PostgreSQL assertions.

- [ ] Resolve the administrator account by the approved email inside SQL; do
  not hardcode or print its UUID.
- [ ] Require the exact target, Standard plan, pending status, absent payment
  evidence, absent confirmed-seller/fulfillment/result evidence, and exact
  expected row count. Resolve the bounded expected product from that candidate;
  an issued but unconfirmed seller reference is allowed.
- [ ] Delete only the blocking test order using the least destructive operation
  compatible with current foreign keys and audit rules.
- [ ] Take the static operation lock, then product/user/user-row/order locks;
  fail the operation if any precondition differs or if the delete count is not
  exactly one.
- [ ] Prove the administrator account and every external-user order are
  untouched.
- [ ] Emit and archive only a static operation/count/timestamp receipt.
- [ ] Invoke the explicit transaction with
  `psql --set=ON_ERROR_STOP=1 --file
  supabase/operations/20260828_cleanup_confirmed_administrator_test_order.sql
  "$DATABASE_URL"` only with the release owner.
- [ ] Do not invoke this operation remotely from the worker.

### Task 7: Worker verification and handoff

- [ ] Run the focused auth callback, anonymous preflight, preflight route/service,
  checkout route/service/store, UI state, status, observability, and migration
  contract tests.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build` with required non-secret test-safe configuration.
- [ ] Run `git diff --check` and inspect `git status --short`.
- [ ] Review the diff for raw Groble URLs in client responses, secrets, broad RLS
  grants, accidental payment mutation, fixed landing-copy changes, generated
  artifacts, unrelated refactors, and server-owned fallback-latch telemetry.
- [ ] Commit the coherent hotfix on the isolated branch and send `worker_done`
  with commit SHA, tests, migrations, and disclosed limitations.

### Task 8: Independent reviews and fixes

**Owner:** Orchestrator and fresh reviewers.

- [ ] Run a specification-compliance review against the approved English
  design, Korean summary, and this plan.
- [ ] Fix every compliance issue with a Luna Max worker and rerun focused tests.
- [ ] Run a separate code-quality/security review of PostgreSQL privileges,
  route authorization, redirect safety, idempotency, privacy, and failure UX.
- [ ] Fix every launch-blocking issue and repeat both review gates.

### Task 9: Controlled production release and canary

**Owner:** Orchestrator. No worker performs remote mutation without this gate.

- [ ] Fetch and verify current `origin/main` and remote Supabase migration history.
- [ ] Reconcile the reviewed branch without overwriting unrelated Amplitude work.
- [ ] In an isolated Supabase workdir, allowlist only the one reviewed schema
  migration and run dry-run.
- [ ] Apply only that migration, then verify remote history before any retry.
- [ ] Separately dry-run and explicitly invoke the administrator operation only
  with the release owner; archive its non-sensitive receipt.
- [ ] Deploy only to the existing `yeosachin-scanner` Vercel project.
- [ ] Run an authenticated administrator canary through preflight restoration and
  the same-origin boundary up to Groble before payment.
- [ ] With user-authorized test payment, verify webhook payment confirmation,
  automatic admission, progress, and result publication.
- [ ] Confirm Axiom and Amplitude boundaries without exposing raw identities.
- [ ] Confirm external pending orders were unchanged.
- [ ] Keep the concierge path active and use the existing reversible automatic
  admission gate if rollback is required.
