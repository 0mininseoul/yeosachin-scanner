# Precheckout B-lite Observability Design

## Goal

Make every paid B-lite generation outcome queryable in Axiom without mixing the teaser path with the paid analysis V2 pipeline or retaining Instagram content and identifiers.

## Event contract

The route emits one terminal event for the generation lease it owns:

- `precheckout_blite.completed`: Apify profile collection and Gemini inference produced a valid DTO and the durable cache write completed.
- `precheckout_blite.profile_collection_failed`: the Apify profile operation threw before inference.
- `precheckout_blite.inference_failed`: Gemini or image preparation did not produce a valid inference result.

Expected fail-open cases that do not prove a provider failure, such as private profiles, profiles with no posts, access denial, an existing pending lease, and cache validation failures, remain product warnings rather than provider-failure events.

## Fields and privacy

All three events include `preflight_id`, `operation`, `provider`, `duration_ms`, and `disposition`. Failure events additionally include a bounded `error_code`. Gemini terminal-attempt telemetry may include the allowlisted model, attempt number, token counts, thinking level, and estimated cost when available.

The events never include username, profile URL, image bytes or URL, bio, caption, prompt, model output, claim token, email, or user UUID. `preflight_id` is the only durable correlation identifier.

## Data flow

The B-lite route passes the existing scraper telemetry hook to the explicitly selected Apify profile call so the generic `scraper.batch_completed` or `scraper.batch_failed` event is retained. The route also emits its B-lite-specific terminal event so an operator can distinguish teaser failures from other scraper activity.

The inference service supplies an `onAttemptTelemetry` callback to `analyzeWithGemini`. The callback maps the final attempt into the B-lite event contract and stays best-effort: Axiom delivery can never change the user-facing response. The route owns the single final success event after the durable DTO checkpoint succeeds.

## Error handling

Observability is fail-open. Logger errors are swallowed by the existing operational logger. The route continues returning `204` for B-lite failure, preserving preflight and checkout availability. A terminal event is emitted at most once per owned durable generation lease; cache hits and `pending` responses do not pretend that a new provider call occurred.

## Verification

Unit tests first prove that the event schema accepts the three names and rejects non-allowlisted fields. Route tests prove Apify failure, inference failure, and durable success emit the expected bounded records while access and cache paths do not emit false provider outcomes. Inference tests prove Gemini attempt telemetry reaches the B-lite mapper. After deploy, an owned production canary must yield `precheckout_blite.completed` in Axiom, and the operator query must also surface future provider failures by the two failure event names.
