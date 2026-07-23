# V2 Result Fidelity Design

## Problem

The only completed V2 archive sample for the requested target was assembled manually after an interrupted E2E run. Its 181 stored profile-image URLs had already expired before the sample was created, its 86 public-account summaries contain only three repeated fallback phrases, and its private-account order cannot prove the production name-scoring path. A fresh E2E run is therefore required for trustworthy result data.

Separately, V2 finalization does not persist gender totals in `analysis_v2_result_summaries`. The owner result contract cannot expose male, female, and unknown counts after the staging rows are purged. Re-running E2E without fixing this durable boundary would reproduce the missing gender card.

## Approved approach

1. Add required `genderStats` counts to the V2 public summary contract.
2. Add durable male, female, and unknown columns to `analysis_v2_result_summaries`.
3. Populate those columns atomically with a `BEFORE INSERT` trigger while terminal candidate classifications still exist:
   - female: `verified_female`
   - male: `verified_non_female`
   - unknown: every other terminal classification
4. Require the three counts to sum to `screened_mutuals`.
5. Backfill the existing completed sample from its valid legacy `analysis_requests.gender_stats`. Use finalized female-row count plus an unknown remainder only when a legacy snapshot is unavailable or invalid.
6. Expose the persisted counts through `analysis_v2_result_summary_json` and the TypeScript result store.
7. Keep the public contract strict, but let the internal DB reader normalize a pre-migration summary to `{ male: 0, female: 0, unknown: screenedMutuals }`. Deploy this compatibility reader before the migration so the rollout cannot break result reads in either schema state.
8. Leave all frontend files to the separate frontend session. Its agreed API boundary is `summary.genderStats`.
9. After review, migration, and deployment, run a new authorized Plus E2E for the exact target. Keep the current sample until the new result succeeds.

## Data and privacy boundaries

- No result username, raw image URL, provider token, request UUID, or user credential is emitted in diagnostics or handoff text.
- Gender totals are aggregate result metadata and contain no new account identifiers.
- The result API remains owner-scoped and image URLs continue to be represented by owner-bound proxy locators.
- The old sample is not deleted as part of this change.

## Verification

- Contract tests reject missing or inconsistent gender totals.
- Result-store tests prove current and pre-migration DB summaries become complete owner-facing summaries without leaking source image URLs.
- A focused PGlite test proves legacy backfill, trigger classification mapping, mismatch rejection, and JSON serialization.
- Full tests, lint, typecheck, build, migration lint, code review, and production canary checks pass before E2E.
- The final browser check verifies current profile images, distinct account summaries, private ordering, gender totals, integer risk display, and the ten-segment gauge after the frontend commit is integrated.
