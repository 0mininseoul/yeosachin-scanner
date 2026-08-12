# Preflight outcome analytics and delay UX design

## Goal

Separate expected product-policy blocks from technical preflight failures in Amplitude, and make the pending experience accurately reflect observed production latency without introducing an unreliable ETA.

Production evidence sampled on 2026-08-12 contained 176 preflight worker requests: 97 ready outcomes, 55 private-account blocks, 13 capacity blocks, 8 not-found blocks, and 3 provider failures. Worker latency was 27.9 seconds at p50, 42.4 seconds at p90, and 71.4 seconds at maximum. The existing single message that says completion normally takes a few seconds is therefore misleading for the common path.

## Scope

- Add the Amplitude event `preflight_blocked`.
- Keep `preflight_succeeded` for ready terminal outcomes.
- Restrict `preflight_failed` to technical failures.
- Preserve the existing privacy allowlist and event deduplication guarantees.
- Add progressive pending guidance to the standard `/analyze` and `/betatest` flows.
- Reuse the existing design system and components. Do not change landing-page marketing copy.

This change does not alter server preflight decisions, provider deadlines, polling cadence, retries, plan eligibility, or the Axiom event contract.

## Analytics contract

### Terminal outcome classification

The client classifies a terminal preflight response by semantics rather than by the transport DTO's `blocked` status alone.

| Amplitude event | Condition |
| --- | --- |
| `preflight_succeeded` | Terminal status is `ready`. |
| `preflight_blocked` | Terminal status is `blocked` with `TARGET_NOT_FOUND`, `TARGET_PRIVATE`, `TARGET_UNSUPPORTED`, `OVER_PLUS_CAPACITY`, or `BETA_CAPACITY_UNAVAILABLE`. |
| `preflight_failed` | A request/poll fails technically, or a terminal `blocked` status contains any other error code such as `PROVIDER_ERROR`, `QUEUE_UNAVAILABLE`, or `ANALYSIS_FAILED`. |

Unknown terminal codes fail closed into `preflight_failed`; they must not silently dilute the technical-failure metric.

### Properties

`preflight_blocked` accepts the same bounded, privacy-reviewed properties as the current terminal failure event:

- `duration_ms`
- `error_code`
- `stage`
- `preflight_id`

No Instagram handle, profile data, URL, user contact field, or raw error is added. Existing error-code normalization remains authoritative, including `OVER_PLUS_CAPACITY` mapping to `PLAN_CAPACITY_EXCEEDED`.

### Deduplication

The outcome key supports `succeeded`, `blocked`, and `failed`. A given preflight lineage emits one terminal event for its classified outcome across polling, remounts, and React lifecycle re-entry. Attempt failures that happen before a preflight ID exists remain `preflight_failed` and retain the existing best-effort behavior.

Historical `preflight_failed` data is not rewritten. Dashboard comparisons must use the deployment timestamp as the event-contract boundary.

## Pending UX

### Visual direction

Use the approved progressive-status direction while preserving the current product language:

- Existing `CaseCard`, `Panel`, `Eyebrow`, `BrandMark`, typography, spacing, borders, and semantic color tokens remain the visual primitives.
- Do not introduce a new palette, rounded visual language, percentage meter, countdown, or estimated completion time.
- The component remains compatible with Amplitude masking/blocking attributes already used around dynamic account identity.

### Time-based messages

Pending guidance has three monotonic stages:

| Elapsed time | Primary guidance | Supporting guidance |
| --- | --- | --- |
| 0–14.999 seconds | `프로필과 계정 규모를 확인하고 있습니다.` | Normal active state. |
| 15–44.999 seconds | `조금만 더 확인하고 있어요.` | `화면을 벗어나도 점검은 계속됩니다.` |
| 45 seconds or more | `평소보다 확인이 오래 걸리고 있습니다.` | `점검은 계속 진행 중입니다. 화면을 벗어나도 괜찮아요.` |

The UI may label the active conceptual step and show completed/upcoming steps, but it must not claim that a server sub-step has completed unless that fact is available. The safe sequence is presentation-only: request accepted, account information being checked, plan eligibility next.

### Timing source and lifecycle

The hook exposes a trusted preflight start timestamp derived from the existing in-memory and session-storage timing source. A shared pending-status component derives the stage from that timestamp and updates only at the 15-second and 45-second boundaries.

- A resumed pending preflight uses its persisted start timestamp so the message never regresses to an earlier stage.
- Resetting or starting a different target resets the visible timer lineage.
- Unmounting clears timers.
- Background-tab throttling is handled by recalculating from wall-clock time when the timer fires, rather than incrementing a counter.
- Terminal ready/blocked transitions immediately remove the pending component.

The initial POST button can continue to say `계정 확인 중…`; progressive guidance begins once the accepted pending preflight exists.

## Component boundaries

1. Analytics classification helper
   - Pure function mapping terminal status/code to `succeeded`, `blocked`, or `failed`.
   - Owns the closed business-block code set.

2. Analytics schema
   - Registers `preflight_blocked` and its allowlisted properties.
   - Extends the outcome deduplication key type.

3. Pending-stage helper
   - Pure function mapping trusted elapsed milliseconds to `initial`, `taking_longer`, or `delayed`.
   - Boundary behavior is explicit at 15,000 and 45,000 milliseconds.

4. Shared pending-status component
   - Renders the existing design system for both standard and beta flows.
   - Receives only safe display identity and timing inputs.

5. Flow integrations
   - `/analyze` and `/betatest` replace their duplicated pending presentation with the shared component.
   - Existing reset, retry, polling, and terminal error behavior remains unchanged.

## Error handling

- A malformed or unknown terminal blocked code is tracked as `preflight_failed` with normalized `UNKNOWN` when necessary.
- Missing or invalid start timestamps omit `duration_ms` and begin the visual message at the initial stage; they do not fabricate a duration.
- Analytics SDK failures remain non-blocking and cannot alter the product response or visible terminal state.
- Timer failures cannot alter polling or preflight execution because UI timing is presentation-only.

## Test strategy

Tests are written before production changes and must demonstrate the red-green cycle.

- Analytics allowlist accepts `preflight_blocked` and strips unapproved properties.
- Business-block codes emit `preflight_blocked`, including the normalized capacity code.
- Provider, queue, analysis, unknown, network, and HTTP failures emit `preflight_failed`.
- Ready emits only `preflight_succeeded`.
- Deduplication keys are distinct and stable for all three outcomes.
- Pending-stage boundaries cover 0, 14,999, 15,000, 44,999, and 45,000 milliseconds.
- Resumed timestamps enter the correct later stage without regressing.
- Analyze and beta flow component tests verify the shared pending UI and current design-system primitives.
- Focused tests, lint, and production build are run before completion is claimed.

## Rollout and measurement

After deployment, Amplitude dashboards should graph `preflight_succeeded`, `preflight_blocked`, and `preflight_failed` separately and annotate the contract-change timestamp. Technical reliability uses succeeded versus failed outcomes; product eligibility uses blocked reasons separately. Axiom and Cloud Run remain the source for server root-cause analysis.

No production data migration, Supabase migration, provider configuration change, or historical event rewrite is required.
