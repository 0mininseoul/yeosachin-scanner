# Production preflight and checkout recovery hotfix

**Status:** Approved on 2026-08-28

## Goal

Restore the production path from anonymous preflight through Kakao sign-in to a
Groble checkout page, without losing the selected target or plan and without
weakening payment-ledger safety.

The launch-critical path is:

1. an anonymous visitor completes preflight;
2. the visitor selects Basic or Standard;
3. Kakao sign-in claims the anonymous preflight for the authenticated account;
4. checkout creation returns a same-origin continuation URL;
5. a server-owned endpoint revalidates the order and responds with a `303` to
   the Groble checkout URL;
6. a confirmed Groble payment continues through the existing automatic
   admission and analysis pipeline.

## Production evidence and root causes

The failed production journey was not one isolated timeout. It was a sequence
of three contract failures.

### 1. Anonymous preflight claim could not retire a stale owner preflight

`claim_anonymous_analysis_v2_preflight` is currently `SECURITY INVOKER`. The
claim transaction attempts to expire a stale authenticated preflight before it
claims the anonymous row, but the authenticated caller no longer has the RLS
permission needed for that owner-row update. The transaction therefore reaches
the active-owner uniqueness constraint and returns `409`/`23505`.

The login callback then returns the visitor to an unclaimed analysis state.
Re-entering the Instagram handle creates unnecessary work instead of resuming
the completed anonymous preflight.

### 2. Authenticated preflight creation omitted `target_input_hash`

Anonymous creation persisted `target_input_hash`; the authenticated creation
path did not. When the worker selected the B-lite cohort, the missing hash
caused `PRECHECKOUT_BLITE_SOURCE_PERSISTENCE_ERROR`. The retry repeated the same
failure and the request did not fall back to the ordinary provider path until
the user-visible timeout boundary.

The observed provider work was materially shorter than the end-to-end wait, so
the long UX was caused by persistence/retry behavior rather than normal Apify
latency.

### 3. Checkout navigation depended on client-side external assignment

Checkout creation and recovery returned a raw external Groble URL. The browser
then attempted `window.location.assign(checkoutUrl)`. Server logs could prove
that a checkout URL was issued, but could not prove that the browser crossed
the external-navigation boundary. A stale administrator test
`payment_pending` order also caused the current Standard checkout request to be
classified as an existing active lineage.

`SUPERSEDED_LINEAGE` was rendered with the same recovery affordance as a
recoverable current lineage, which contradicted the ledger contract.

## Invariants

- A preflight belongs to at most one authenticated account.
- A user has at most one live authenticated preflight after a claim transaction.
- Claim authorization is derived from `auth.uid()`, never a trusted client UUID.
- A B-lite preflight never starts unless its target hash is durably bound.
- Legacy rows without a hash take the ordinary provider path immediately; they
  do not wait for repeated B-lite failures.
- The application never accepts a client-provided Groble destination.
- Groble checkout recovery is owner-bound, current-lineage-bound, phone-bound,
  and limited to 24 hours from order creation.
- `SUPERSEDED_LINEAGE` is status-only and is never offered as recoverable.
- No external-user `payment_pending` row is changed without independent Groble
  no-sale evidence.
- The administrator account remains intact.

## Design

### 1. Atomic anonymous-to-authenticated preflight claim

Add a migration that preserves the existing public RPC signature while moving
the privileged state transition into a non-exposed schema.

- Create a tightly scoped `private` helper as `SECURITY DEFINER` with
  `search_path = ''`.
- Keep a public `SECURITY INVOKER` wrapper with the current
  `claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)` signature.
- The helper verifies that `auth.uid()` equals the requested user, takes a
  deterministic per-user transaction lock, and locks both the anonymous row and
  any live owner row.
- A stale owner row is terminalized inside the same transaction.
- A live owner row for the same normalized target is replayed as the canonical
  preflight, while the anonymous row is safely retired.
- A live owner row for a different target remains a bounded conflict.
- Otherwise the anonymous row is claimed for the authenticated user.
- Revoke default function execution. Grant only the minimum schema/function
  privileges needed by the authenticated wrapper call.

Do not restore a broad owner UPDATE RLS policy. The privileged operation is one
auditable state machine transition, not general row mutation.

### 2. Persist target identity at authenticated creation

The authenticated route computes `preflightTargetInputHash(target, env)` before
calling the store. The production store contract requires that hash.

Add a new, unambiguous v2 creation RPC rather than overloading the existing
PostgREST function name. It must:

- remain service-role-only;
- validate a lowercase 64-character hexadecimal hash;
- reuse the current create-or-replay transaction;
- atomically bind the hash when the row is created or when a compatible replay
  has no hash;
- reject a replay whose persisted hash disagrees; and
- return only after the hash is durable.

The existing RPC remains available for rollback compatibility. Beta/test paths
that intentionally use a different contract remain explicit rather than being
silently widened.

Before B-lite activation, the worker checks the persisted hash. A legacy row
without one emits a bounded skip reason and immediately runs the ordinary
provider path. It must not activate B-lite and throw.

### 3. Same-origin checkout continuation with server-side `303`

Checkout POST returns `{ orderId, nextUrl }`, where `nextUrl` is a validated
same-origin route such as `/api/earlybird/checkout/redirect?...`. It no longer
returns a raw Groble URL to application UI code.

The browser:

- accepts only the expected same-origin continuation path;
- records the existing Amplitude `checkout_redirected` boundary; and
- immediately navigates to `nextUrl` without waiting for an analytics flush.

The redirect endpoint:

- requires an active authenticated account;
- validates bounded query input;
- reloads the owner-bound order and current account phone;
- verifies target, plan, pricing snapshot, disclosure, seller reference,
  payment evidence absence, and the 24-hour recovery window;
- generates the Groble URL on the server from trusted configuration;
- emits the server business event `earlybird.checkout_redirected`;
- returns `303 See Other` with `Cache-Control: no-store`; and
- redirects failures to a bounded same-origin status/error destination rather
  than exposing internal database or provider details.

The initial checkout and a valid recovery use the same redirect contract.
Existing PUT recovery may remain temporarily only if a compatibility caller is
proved to need it; product UI must not depend on the raw external URL response.

### 4. Recovery and lineage UX

`earlybird_orders.created_at` is part of the server recovery record.

- A current, otherwise valid `payment_pending` order is resumable for 24 hours.
- A current row older than 24 hours is status/support-only. Age alone does not
  change its ledger status.
- `STALE_PRICING_LINEAGE` may route to the status page and resume only when the
  server revalidation still succeeds.
- `SUPERSEDED_LINEAGE` routes to status-only UX and never renders a checkout
  continuation CTA.
- The status DTO exposes only the bounded capability needed by the UI, such as
  `checkoutRecoverable`; the browser does not reproduce ledger rules.

This deliberately separates “the user may reuse this checkout session” from
“the payment ledger has provider evidence that no sale occurred.”

### 5. Administrator test-order cleanup

The user explicitly confirmed that the administrator's historical orders are
test records and that the current `0_min._.00` Standard pending order is not a
real sale. A one-shot migration may remove or terminalize only the exact
blocking administrator test row under strict semantic preconditions:

- administrator email matches the known administrator account;
- normalized target is `0_min._.00` and plan is Standard;
- status is `payment_pending`;
- payment ID, paid timestamp, actual payment amount, and confirmed seller
  reference evidence are absent; and
- no paid/fulfillment/result child record exists.

The migration must fail closed if the expected row count or any precondition is
different. It must not delete or disable the administrator account and must not
touch external-user orders.

The other external `payment_pending` rows remain unchanged. Their eventual
cleanup continues to require the existing Groble dashboard no-sale
reconciliation contract or a future provider verification integration.

## Observability

Add the server business event `earlybird.checkout_redirected` to the bounded
observability schema and operations contract. Safe properties may include the
plan, recovery-vs-new mode, and a non-sensitive outcome classification. Do not
log checkout URLs, seller references, phone numbers, tokens, user UUIDs, or raw
provider payloads.

The launch funnel is interpreted as:

- `checkout_started`: checkout creation was requested;
- `earlybird.checkout_created`: the ledger accepted or replayed the order;
- Amplitude `checkout_redirected`: the browser entered the same-origin
  continuation boundary; and
- Axiom `earlybird.checkout_redirected`: the server completed all revalidation
  and issued the Groble `303`.

Payment success remains authoritative only in Supabase/Groble finalization, not
in either redirect event.

## Error handling

- Claim conflicts return stable public codes without PostgreSQL details.
- Hash mismatch is a permanent persistence-contract error; missing legacy hash
  is an ordinary-provider fallback.
- Redirect validation failures return a bounded same-origin UX and emit a safe
  reason code.
- An observability failure must not prevent an otherwise valid checkout
  redirect, but logging gets a short bounded flush opportunity.
- No retry path creates a second pending order for the same owner lineage.

## Test strategy

### TypeScript and route tests

- authenticated creation supplies and persists the target hash;
- legacy missing-hash rows bypass B-lite immediately;
- checkout POST returns only a safe same-origin `nextUrl`;
- unsafe or malformed continuation URLs are rejected by the browser helper;
- redirect GET returns `303`, `no-store`, and a server-generated Groble URL only
  after all owner/phone/order checks pass;
- redirect failures stay same-origin and disclose no sensitive detail;
- recovery is allowed at less than 24 hours and denied after 24 hours;
- `SUPERSEDED_LINEAGE` has no recovery CTA;
- duplicate clicks are idempotent;
- Amplitude and Axiom redirect events occur at their intended boundaries.

### PostgreSQL contract tests

- an authenticated caller can claim an anonymous row when the previous owner
  row is stale;
- concurrent claims leave exactly one canonical owner row;
- live same-target replay and live different-target conflict are deterministic;
- one caller cannot claim for another `auth.uid()`;
- v2 create-or-replay always returns a hash-bound row;
- mismatched replay hash fails atomically;
- the administrator cleanup affects exactly the authorized test row and fails
  closed for any payment evidence.

### Regression suite

Run the focused auth callback, preflight, checkout, status/UI, observability, and
database contract suites, then lint, production build, and migration validation.

## Rollout and rollback

1. Verify migration history against the linked production project.
2. Use an isolated Supabase workdir with an explicit migration allowlist.
3. Run migration dry-run and inspect every pending statement.
4. Apply only the approved hotfix migrations and verify remote history before
   repeating any command.
5. Deploy the existing `yeosachin_scanner` Vercel project.
6. Canary the administrator flow: anonymous preflight, Standard selection,
   Kakao sign-in, state restoration, same-origin continuation, Groble test
   checkout, webhook admission, progress, and result.
7. Keep the concierge path available. If automatic admission is unsafe, disable
   its existing reversible gate without rolling back payment finalization.

Application rollback may restore the previous RPC caller because the old
creation RPC remains. Database rollback must not resurrect the deleted or
terminalized administrator test order. No external payment ledger row is part
of this hotfix rollback.

## Non-goals

- bulk cleanup of historical external `payment_pending` rows;
- broad Supabase table reduction;
- replacement of Groble provider reconciliation;
- changes to Apify token routing or the analysis ranking algorithm;
- changes to fixed landing-page marketing copy; and
- unrelated refactoring beyond code made obsolete by this hotfix.

## Acceptance criteria

- The approved administrator journey reaches Groble after one sign-in without
  re-entering the target.
- The restored preflight is the originally completed anonymous preflight.
- No B-lite persistence retry consumes the user-visible timeout when a legacy
  hash is missing.
- The browser never receives or validates the raw Groble destination as product
  state.
- Current valid recovery works for 24 hours; superseded or older lineages do
  not expose a continuation CTA.
- No external pending-payment row is mutated.
- Focused tests, lint, build, migration checks, deployment, and the production
  canary all pass before the user is told to retry the real-payment test.
