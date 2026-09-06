# Bounded Preflight Fallback UX Design

## Goal

Make the precheckout surface deterministic when the accepted preflight or its B-lite
result is delayed. The user sees one complete four-stage graph pass, then an explicit
static state; a fallback action always has a finite meaning and never sends the user
into a spinner that has no owner or completion boundary.

The change is client/API state UX, analytics, and tests only. It does not alter the
single preflight submission, B-lite dispatch, provider selection, Gemini work, payment,
Supabase schema, deployment configuration, or the landing-page marketing copy.

## Problem and evidence in the current implementation

The current client starts `PrecheckoutDemo` in `waiting` mode and keeps the SVG player
running on a six-second-per-stage loop after the initial 20-second pass. That loop is a
useful animation but it makes an unresolved request look as though work is continually
progressing, and it leaves the visible surface dependent on an indefinite poll.

`POST /api/analysis/precheckout-blite` currently returns an empty `204` both when the
parent preflight is not ready and when a ready parent has no B-lite cache row. The
browser maps both responses to `unavailable`, so the UI cannot distinguish “the parent
is still collecting” from “B-lite is not available for this ready parent.” A terminal
B-lite failure is represented separately in the durable store, but the route and the
client do not expose an explicit expired/terminal action that can create a new request.

The page already owns the accepted-preflight binding and the request coordinator. A
retry must use that owner and must not start provider work directly from a fallback
button. The existing `startPreflight` path has the correct submission contract; a
terminal/expired retry clears its prior idempotency key first and calls that path only
after the user clicks.

## Chosen behavior

### Visible sequence

1. After the exclusion decision, mount the existing four-stage graph from the accepted
   preflight's visible-entry clock. S1, S2, S3, and S4 run once for the approved
   20,000ms total.
2. At the end of that pass, stop the SVG animation and remove the looping continuation.
   If the status is still non-terminal, render a static explicit delayed state. The
   static state has no indeterminate bar, blink animation, or legacy plans CTA.
3. A durable complete DTO still wins after the graph pass and reveals the existing
   result screen. A ready parent with no B-lite row becomes an explicit plans CTA.
4. A durable B-lite terminal failure or an expired parent becomes an explicit retry
   CTA. The retry is inert until clicked; the click starts a new preflight through the
   existing page/hook path.
5. If a transient/pending read remains unresolved through the client display bound,
   show the same terminal-style retry action with the bounded reason
   `unresolved_at_90`. There is no route from this state to an indefinite loading
   spinner or an implicit new request.

The `parent_pending` response is deliberately not treated as B-lite unavailability.
It renders the delayed state while the existing parent status poll continues. A parent
that later becomes ready can then resolve to a B-lite result, B-lite pending, or B-lite
unavailable without changing the preflight ID. Parent expiry is a separate `expired`
outcome and is eligible for the explicit new-preflight retry.

### State contract

The status route exposes only bounded, sanitized state. It does not return target text,
provider identifiers, run identifiers, failure messages, credentials, or database
columns that are not already part of the existing DTO contract.

| Parent/B-lite condition | HTTP | Browser state | Post-graph surface | CTA action |
| --- | ---: | --- | --- | --- |
| Parent is `pending` or `processing` | 202 | `parent_pending` plus `parentState` and bounded `retryAfterMs` | Static delayed | None |
| Ready parent, B-lite cache is pending | 202 | `pending` plus bounded `retryAfterMs` | Static delayed | None |
| Ready parent, B-lite DTO is complete | 200 | `complete` | Existing result | Existing plans CTA |
| Ready parent, no B-lite status row | 200 | `unavailable` | Explicit fallback | Open existing plans |
| Ready parent, B-lite status is terminal failed | 200 | `failed` | Explicit fallback | Create new preflight on click |
| Parent is terminal (`blocked` or `consumed`) | 200 | `terminal` | Explicit fallback | Create new preflight on click |
| Parent is expired or past its expiry | 410 | `expired` | Explicit fallback | Create new preflight on click |
| Owner/auth/read failure or malformed request | 204 | Client treats as transient/unavailable | Existing bounded handling | Never auto-retry submission |

The route may preserve the existing `204` fail-open behavior for malformed or
unauthorized requests. A valid owned ready parent with no B-lite status must use the
explicit `unavailable` body so the client can distinguish it from `parent_pending`.

### Request binding and retry

The current `preflightId` and optional anonymous claim token remain the only inputs to
the B-lite status read. The browser request coalescing key remains
`preflightId:claimToken`; a result is reusable, while non-complete reads are not cached
past their individual request. No status read reserves a task or calls a provider.

The retry callback is page-owned. It captures the normalized target already bound to the
active preflight, clears the old lifecycle/idempotency state, and calls `startPreflight`
with that target only after the retry button's click handler runs. It does not invoke
the B-lite route, worker, provider, or payment endpoint. A normal plans CTA keeps the
current preflight and only releases the existing legacy plans surface.

The page must reset the precheckout surface and result-heading state before starting the
new request. The active-surface guard continues to reject stale callbacks from the old
preflight, so a late old status cannot release plans or replace the new graph.

## Component boundaries

- `components/precheckout-stage-graphs.tsx`: owns the one-pass SVG timeline and the
  exported 20,000ms duration. `continueAfterFirstPass` and the slow-loop branch are
  removed or made unreachable; artwork and stage ordering remain unchanged.
- `components/precheckout-demo.tsx`: owns the graph completion timer and reports the
  initial-pass boundary once. `waiting` remains an analytics/display mode for the
  initial pass, but it no longer starts a second graph cycle.
- `components/preflight-pending-status.tsx`: keeps the existing timed pending status
  used by the legacy surface and adds a pure static `PrecheckoutDelayedStatus` for the
  post-graph state. The new surface has no timer or animated loading utility.
- `app/api/analysis/precheckout-blite/route.ts` and
  `lib/services/precheckout/blite-status-contract.ts`: validate ownership, classify
  parent readiness before reading B-lite, and serialize the finite status union.
- `components/precheckout-immersive.tsx`: binds one status poll to one preflight,
  transitions from the graph to delayed/result/fallback state, and emits the dedicated
  fallback CTA event only on a user click.
- `lib/services/precheckout/blite-page-flow.ts`: records the pure state/action rules
  for delayed, unavailable, terminal, expired, and explicit retry transitions so the
  UI cannot silently create a second request.
- `lib/services/analytics.ts`: allowlists `demo_mode=waiting`, adds bounded
  `parent_state`/fallback reasons, and registers
  `precheckout_blite_fallback_cta_clicked`.
- `app/analyze/page.tsx`: passes the page-owned retry callback and keeps the existing
  legacy plans transition and request binding intact. `app/page.tsx` is out of scope.

## Analytics and operational safety

The existing per-preflight event dedupe remains authoritative. Add one dedicated event:

`precheckout_blite_fallback_cta_clicked`

Its only properties are `preflight_id`, allowlisted `parent_state`, and allowlisted
`fallback_reason`. `preflight_id` is supplied by `trackPrecheckoutEvent`, so callers
cannot omit or replace the bound ID. `demo_mode=waiting` is added to the closed enum so
the existing `DEMO_STARTED` event is not silently stripped.

Allowed parent states are finite (`pending`, `processing`, `ready`, `expired`,
`unknown`). Allowed fallback reasons retain the existing values and add only
`blite_unavailable`, `blite_terminal`, `preflight_expired`, and
`unresolved_at_90`. Durations remain integer milliseconds bounded by 86,400,000. No
raw response body, username, provider error, target ID, task ID, or timer payload is
sent to analytics.

## Alternatives considered

1. Continue the six-second graph loop until B-lite resolves. Rejected because it turns
   a delayed backend state into an apparently active progress signal and provides no
   finite visual handoff.
2. Collapse every non-ready parent to `204` and let the client use one fallback. Rejected
   because it loses the parent-pending distinction and can expose plans before the
   parent has an authoritative ready snapshot.
3. Start a fresh preflight automatically at the deadline. Rejected because it creates
   duplicate submissions/tasks and makes a provider run happen without a user gesture.
4. Add a separate provider/B-lite retry endpoint. Rejected because it duplicates the
   existing preflight admission and idempotency contract; explicit retry should reuse
   `startPreflight` after clearing the old request binding.

## Invariants

- Exactly one initial graph pass is visible per immersive mount.
- Every B-lite status request includes the current preflight ID and, when present, the
  current claim token; no old request can mutate the new surface.
- No fallback CTA is rendered as an indefinite spinner, and no retry request starts
  without a click.
- Plans remain closed until the existing result CTA or the explicit ready-parent/
  unavailable fallback CTA is clicked.
- Terminal/expired retry creates a new preflight only after the click, with no duplicate
  provider/task work from the old ID.
- StrictMode, remounts, late status reads, and callback rerenders remain idempotent.
- `app/page.tsx` marketing copy remains byte-for-byte untouched.

## Verification and rollback

The focused tests must prove the one-pass graph boundary, static delayed markup,
parent-pending API classification, ready-parent unavailability, terminal/expired CTA
actions, retry-on-click request binding, analytics allowlists, and no duplicate status
or submission calls. Run the focused suites, TypeScript, lint, build, and
`git diff --check`; then run the full Vitest suite if the worktree permits it.

Rollback is the application commit revert. No database, provider, payment, or external
service rollback is required because this design changes no durable schema or worker
behavior.
