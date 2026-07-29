# V2.19 Pro Gender Second-Look Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-30-v219-pro-gender-second-look-design.md`  
**Execution boundary:** implement and verify through zero-provider dry preflight;
do not create or execute a paid job.

## Task 1: Register an evaluation-only V2.19 identity

Files:

- `lib/services/ai/stage-policy.ts`
- `lib/services/ai/stage-policy.test.ts`
- `lib/services/analysis/replay/replay-source-lineage.ts`
- `lib/services/analysis/replay/replay-evaluation-policy.test.ts`
- `lib/services/analysis/replay/replay-bundle.ts`
- `lib/services/analysis/replay/replay-bundle.test.ts`
- `lib/services/analysis/replay/historical-partial-available-capture.ts`
- `lib/services/analysis/replay/historical-partial-available-capture.test.ts`

Red:

- Add tests requiring V2.19 to inherit V2.18/V2.12 control stage bytes.
- Add tests requiring a unique authenticated historical-partial capability.
- Add tests proving V2.19 is resolvable only from the matching sealed
  evaluation policy and remains impossible to select for production.

Green:

- Add the V2.19 policy constant, registry entry, capability flag, source
  lineage schema, bundle schema, and capture branch.
- Keep every control stage object byte-identical to V2.18.

## Task 2: Add reviewed Pro pricing and conservative budget math

Files:

- `lib/services/ai/gemini-cost.ts`
- `lib/services/ai/gemini-cost.test.ts`
- new `lib/services/analysis/replay/replay-v219-budget.ts`
- new `lib/services/analysis/replay/replay-v219-budget.test.ts`

Red:

- Require global Pro pricing at USD 2/M input and USD 12/M output.
- Require exact fixed-point conservative reservation math.
- Require per-stage and total dispatch ceilings, four-attempt multiplication,
  atomic reserve-before-dispatch behavior, and fail-closed overflow.
- Require missing usage to remain incomplete rather than zero.

Green:

- Add the canonical Pro pricing entry.
- Implement integer micro-USD or pico-USD budget calculations without
  floating-point admission comparisons.
- Expose a module-private issued-budget brand and read-only aggregate
  snapshot.

## Task 3: Implement the distinct-post-first Pro projection

Files:

- new `lib/services/analysis/replay/replay-v219-gender-second-look.ts`
- new `lib/services/analysis/replay/replay-v219-gender-second-look.test.ts`

Red:

- Require deterministic profile-first, distinct-feed-post-first,
  carousel-context-last ordering capped at 1+8.
- Require request-local opaque IDs and exact round-trip mapping.
- Reject fewer than two unique media items for treatment admission.
- Reject unknown/duplicate evidence IDs, weak binary claims, owner/context
  contradictions, and extra response fields.

Green:

- Implement pure cohort/media projection, prompt, strict schema, and
  finalization functions.
- Keep names, bios, captions, handles, source IDs, ordinals, and post IDs out
  of the prompt and returned aggregate structures.

## Task 4: Implement pure V2.19 calibration and rescue evaluation

Files:

- `lib/services/analysis/replay/replay-v219-gender-second-look.ts`
- `lib/services/analysis/replay/replay-v219-gender-second-look.test.ts`

Red:

- Require pre-fusion V2.12 known labels only for calibration.
- Require high binary, same owner, two unique evidence IDs, high
  personal/creator context, and both official exclusions.
- Preserve 30/10/10 volume and 95% overall/male/female agreement gates.
- Add zero known-male-to-female and zero official accepted gates.
- Preserve stage-conflict matching and unavailable-row exclusions.
- Require observed and missing-public worst-case unknown conservation.
- Record Wilson diagnostics without using them to weaken a gate.

Green:

- Implement fixed-key aggregate calibration, null-reason histograms,
  counterfactual rescues, final rates, and adoption gates.
- Document in types/comments that agreement is control consistency, not
  independent ground truth.

## Task 5: Add a replay-only Pro provider adapter

Files:

- new `lib/services/analysis/replay/replay-v219-ai-adapter.ts`
- new `lib/services/analysis/replay/replay-v219-ai-adapter.test.ts`
- `lib/services/analysis/replay/replay-staged-ai-adapter.ts`
- `lib/services/analysis/replay/replay-staged-ai-adapter.test.ts`
- `lib/services/analysis/replay/replay-runner.ts`

Red:

- Require the exact Pro/HIGH/HIGH/2048 configuration and at most nine images.
- Require structured schema parsing and opaque-ID finalization.
- Require treatment concurrency two.
- Require the shared budget reservation callback to run before every SDK
  provider dispatch, including retries.
- Require a forged or unbudgeted V2.19 runner to fail paid admission.

Green:

- Add an optional treatment method to the replay runner interface.
- Issue V2.19 control and treatment methods from one frozen adapter carrying
  the same non-forgeable shared budget.
- Preserve existing V2.12–V2.18 adapter behavior byte-for-byte outside the new
  conditional branch.

## Task 6: Integrate the static cohort and treatment report

Files:

- `lib/services/analysis/replay/replay-runner.ts`
- `lib/services/analysis/replay/replay-runner.test.ts`
- `lib/services/analysis/replay/replay-runner-policy-capability.test.ts`

Red:

- Require treatment admission to depend only on public/source media
  structure.
- Require exactly one logical treatment invocation per statically eligible
  row, regardless of control outcome.
- Require known calibration and final-unknown rescue roles to be disjoint.
- Require provider non-success and incomplete result shapes to remain
  unresolved.
- Require final gender totals and every treatment histogram to conserve.

Green:

- Run the bounded treatment stage after control results settle, using the
  already authenticated in-memory media.
- Evaluate calibration against pre-fusion known control rows and rescues
  against post-V2.18-fusion unknown rows.
- Add treatment stage telemetry and the pure aggregate V2.19 report.

## Task 7: Extend the strict terminal contract and safe output

Files:

- `lib/services/analysis/replay/replay-job-report-contract.ts`
- `lib/services/analysis/replay/replay-job-report-contract.test.ts` if present,
  otherwise `scripts/replay-analysis-v2-job.test.ts`
- `lib/services/analysis/replay/replay-job-gcs.ts`
- `lib/services/analysis/replay/replay-job-gcs.test.ts`

Red:

- Require a V2.19 terminal union member with the fixed aggregate report.
- Require exact count/rate/gate/ceiling conservation.
- Reject identifiers, names, bios, captions, URLs, prompt/media/evidence
  fields, provider payloads, raw errors, secrets, and extra keys.
- Accept safe aggregate dispatch and USD fields only.

Green:

- Add the V2.19 strict schema and safe-line mapping.
- Keep the existing GCS unsafe-key/value validator at least as strict.

## Task 8: Add CLI, job entry, and package graph support

Files:

- `scripts/replay-analysis-v2.ts`
- `scripts/replay-analysis-v2.test.ts`
- `scripts/replay-analysis-v2-job.ts`
- `scripts/replay-analysis-v2-job.test.ts`
- new `scripts/replay-analysis-v219-job.ts`
- `scripts/build-replay-analysis-v2-job.mjs`
- `scripts/build-replay-analysis-v2-job.test.ts`

Red:

- Require V2.19 capture/run parsing only with historical-partial lineage.
- Require a V2.19 immutable direct-entry marker.
- Require the job to construct only the V2.19 issued runner.
- Require the exact local build graph to include the new pure/budget/adapter
  modules and no Instagram, Apify, Supabase admin, result store, or production
  writer.

Green:

- Add V2.19 evaluation constants, entrypoint, package allowlist, and builder
  policy.
- Preserve existing paid double-confirmation and single-execution-token
  behavior.

## Task 9: Implement zero-provider dry preflight

Files:

- new `lib/services/analysis/replay/replay-v219-preflight.ts`
- new `lib/services/analysis/replay/replay-v219-preflight.test.ts`
- `scripts/replay-analysis-v2.ts`
- `scripts/replay-analysis-v2.test.ts`

Red:

- Require authenticated bundle validation, exact retained-source counts,
  static cohort count, media histogram, and exact ceiling derivation.
- Install spies that fail if Gemini, Apify, Instagram, production stores, or
  result writers are constructed.
- Require dry preflight to stop before Cloud Run job creation.

Green:

- Add a pure V2.19 preflight report and CLI path.
- Print only fixed aggregate values and reviewed pricing metadata.

## Task 10: Verification and paid-gate handoff

Run:

- targeted V2.19 tests after each red/green cycle;
- `git diff --check`;
- full `npm test`;
- `npm run lint`;
- TypeScript checking through the repository's supported command;
- replay worker package build and graph audit;
- zero-provider dry preflight against the authenticated retained source.

Then report:

- exact static treatment candidate count;
- exact control, treatment, and total logical-call ceilings;
- exact control, treatment, and total provider-dispatch ceilings;
- model/location/resolution/output pricing basis;
- conservative USD ceiling;
- proof of zero Apify/Instagram/provider calls during preflight;
- test/build status;
- explicit control-label limitation.

Stop and wait for a new written paid-execution confirmation.
