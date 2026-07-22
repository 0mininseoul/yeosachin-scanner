# Analysis V2 Profile Repair Consumer Precedence

## Context

The profile-fetch pipeline persists up to three immutable attempts for each profile batch:
`primary`, `fallback`, and `repair`. The repair checkpoint was added after the original profile
consumer. The consumer schema accepts repair rows, but its terminal projection still merges only
fallback over primary. A profile repaired from `failed` to `success` therefore remains failed when
the profile-AI job reads it, causing the same durable consumer job to retry indefinitely.

The paid Plus E2E exposed this mismatch without creating duplicate analysis requests. One profile
batch persisted a successful repair for one failed fallback row, but the consumer continued to
raise `ANALYSIS_V2_PROFILE_CONSUMER_RETRYABLE_OUTCOME` from the stale fallback result.

## Decision

Resolve terminal profile results in attempt order:

1. `repair`, when a repair row exists for the requested username;
2. `fallback`, when a fallback row exists;
3. `primary` otherwise.

The requested username order remains the output order. The consumer continues to reject a final
`failed` outcome unless its failure category is `incomplete`, exactly as it does today. The change
does not reinterpret failures, create another repair attempt, mutate an existing checkpoint, or
alter provider selection and billing.

## Alternatives Considered

### Convert failed repair rows to unavailable

This would let the pipeline advance, but it changes the meaning of a terminal provider failure and
could silently reduce result quality. It is rejected.

### Continue Cloud Tasks retries

Retries cannot change the immutable consumer input when a successful repair row is already stored
but ignored. This cannot resolve the defect and is rejected.

### Re-run the profile producer

This would violate the existing provider-run and checkpoint fences and could create additional paid
usage. It is rejected.

## Data Flow

`load_analysis_v2_profile_fetch_for_consumer` returns validated primary, fallback, and repair result
arrays. The TypeScript consumer builds username-indexed maps for fallback and repair results, then
projects each primary row through `repair ?? fallback ?? primary`. Existing schema validation keeps
all result arrays scoped to the same request, producer job, and requested username set.

## Error Handling

- A final `success` must still include its matching profile snapshot.
- A final non-incomplete `failed` outcome remains retryable.
- A final `incomplete` or unavailable outcome remains unavailable to profile AI.
- Missing repair rows retain the current fallback/primary behavior.
- No new exception types, retry limits, or task acknowledgement rules are introduced.

## Testing

Add a focused consumer test that supplies a failed fallback row and a successful repair row for the
same username. Before the implementation, the test must fail with
`ANALYSIS_V2_PROFILE_CONSUMER_RETRYABLE_OUTCOME`. After the implementation, it must return the repair
profile. Existing fallback-over-primary and failure tests must remain green.

Run the focused test first, then the related profile consumer and worker suites, followed by the
repository's standard type, lint, and build checks before deployment.

## Rollout and E2E Continuation

Deploy the reviewed commit to the controlled E2E worker without creating a new analysis request or
manually re-running a provider stage. The existing Cloud Tasks delivery will retry the same fenced
profile-AI job against the corrected consumer. Continue observing the separate transient media
preparation job without changing its behavior in this patch.

The E2E remains a Free-account functional and cost sample. It does not satisfy the paid Starter
production gate, the five-minute latency gate, or an exact-cost gate when Gemini usage metadata is
missing.

## Non-Goals

- Changing profile repair provider policy or billing ceilings.
- Changing media normalization retry behavior.
- Backfilling or rewriting provider checkpoints.
- Treating this single E2E as production launch approval.
