# Result Actions and Feedback Observability Design

## Goal

Make successful result-page sharing actions visible in Amplitude and make result feedback visible in both product analytics and operational logs, without recording user-written feedback or share URLs.

## Scope

- Preserve the existing `result_shared` event for Kakao sharing.
- Emit `result_shared` after a successful Instagram DM handoff preparation, with `share_channel: "instagram_dm"`.
- Emit `result_shared` after a successful explicit link copy, with `share_channel: "clipboard"`.
- Add `result_feedback_submitted` after the feedback API confirms persistence.
- Emit structured Axiom operational events for feedback persistence success and failure.
- Do not change result-page copy, layout, share-link creation, or feedback storage behavior.

## Event Contracts

### Amplitude

`result_shared`

- `request_id`: analysis request UUID.
- `share_channel`: `kakao`, `instagram_dm`, `clipboard`, or the existing `web_share` fallback.
- Emit only after the channel-specific action has succeeded. A DM action counts as successful once the link is copied and the Instagram destination is opened or offered to the user.
- Do not emit when share-link preparation or clipboard copying fails.

`result_feedback_submitted`

- `request_id`: analysis request UUID.
- Emit only after `/api/result-feedback` returns a successful persistence response.
- Do not include the feedback body, body length, user agent, target handle, or error text.

### Axiom

`result_feedback.persisted`

- Severity: `info`.
- Fields: `request_id` only.
- Emit after the database insert succeeds.

`result_feedback.persistence_failed`

- Severity: `error`.
- Fields: `request_id` and `error_code: "RESULT_FEEDBACK_INSERT_FAILED"` for an insert failure, otherwise `error_code: "INTERNAL_ERROR"`.
- Emit from the existing caught failure path and replace the unstructured console-only signal.
- Never include the feedback body, user ID, user agent, database message, or raw exception.

Operational logging remains fail-open: analytics or logging failures must not alter the feedback response. The route schedules a deferred operational-log flush after emitting either outcome so buffered Axiom delivery does not add latency to the response.

## Component Boundaries and Data Flow

`ResultActions` owns the concrete DM and clipboard outcomes, so it will accept an outcome callback from the result page. The result page maps confirmed outcomes to the shared Amplitude event contract. Kakao remains in its existing page-level handler.

`ResultFeedback` owns the client request outcome and records the Amplitude event only after an HTTP success. The server route records the authoritative persistence outcome to Axiom immediately after the insert or inside the caught persistence failure path.

## Testing

- Extend the analytics validator tests so the new event and `instagram_dm` channel are accepted with only approved properties.
- Add or extend result-action tests to prove DM and clipboard callbacks occur only on confirmed success and not on failure.
- Add a feedback component contract test proving Amplitude fires after a successful response and does not include feedback text.
- Extend feedback route tests to prove the server emits sanitized success and failure operational events.
- Run focused Vitest tests, lint, and the production build.

## Non-goals

- No events for opening or cancelling the feedback form.
- No Amplitude failure event for feedback submission.
- No Axiom event for client-only share actions.
- No historical backfill or production analytics query.
