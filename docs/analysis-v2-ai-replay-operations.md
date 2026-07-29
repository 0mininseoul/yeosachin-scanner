# Analysis V2 AI replay operations

## Scope and status

AI stage policy V2.11 through V2.18 is evaluation-only. Production policy selection and the
persisted-policy allowlist remain capped at V2.10 until a separately reviewed production rollout
changes both boundaries. An evaluation result must not be treated as a production deployment,
full Standard E2E result, SLA proof, or unit-cost evidence.

The evaluation source is one sealed, completed historical Standard request. A replay reconstructs
only its sealed source and starts no new Apify Actor. It may make paid Gemini calls only after the
paid-call confirmation has been reviewed. Do not substitute a live request, an incomplete source,
or a newly collected profile set.

## Immutable replay identity

Every execution records and checks the following immutable inputs before a Gemini call:

- evaluation capability and AI stage policy version;
- sealed source identity and source lineage;
- replay bundle identity and authenticated-encryption AAD binding;
- fixed worker image digest and fixed package object generation;
- an execution token with a single expected execution identity.

The terminal report is aggregate-only. It must reject account identifiers, names, bios, captions,
URLs, prompts, media locators, raw provider output, tokens, and other PII. Do not relax the
validator to diagnose a run; use the protected source boundary instead.

## Paid Gemini execution procedure

1. Confirm the capability is evaluation-only, the sealed source is complete, and the selected
   policy is not production-selectable.
2. Record Apify Actor count before the run. The required actor delta is zero.
3. Build a package from the reviewed commit, pin its object generation and image digest, and
   upload encrypted input with the matching immutable AAD.
4. Require a second, explicit paid-Gemini confirmation immediately before creating the job. A
   dry reconstruction alone is not that confirmation.
5. Create a fresh execution token without a trailing newline. Set the job's expected execution
   identity from that exact token and validate its length/format without printing its value.
6. Creating the Cloud Run Job starts this replay automatically when the start token is present.
   Do not invoke a second manual execution in response to the CLI's generic execute suggestion.
7. After terminal completion, download only the strict aggregate report. Verify exactly one
   claim object and one report object, zero retries unless the report explains them, and an
   unchanged Apify Actor count.

Any mismatch, missing immutable input, duplicate claim/report, non-zero Actor delta, invalid
report, or ambiguous paid invocation is a failed evaluation. Do not use it as a quality gate pass.

## Observed AI-only evaluations

The timings below are AI-only replay wall times for the same historical source. Source capture and
normalization are tracked separately and are not included in these rows. The measurements are
useful for relative comparison only, not an end-to-end product SLA or production cost model.

| Evaluation policy | Unknown ratio | Wall time | Notes |
| --- | ---: | ---: | --- |
| V2.12 | 35.32% | 304.3s | Baseline AI-only evaluation. |
| V2.13 | 31.20% | 364.6s | High-resolution feature shadow. |
| V2.14 | 34.04% | 500.5s | Feature-model shadow. |
| V2.15 | 32.34% | 505.7s | Larger feature response cap. |
| V2.16 | 33.62% | 705.5s | Single-profile admission shadow; 32 admitted single-profile candidates yielded 0 rescues. |
| V2.17 | 32.77% | 314.009s | Name-and-visual fusion shadow; six strict rescues, but quality gates failed. |
| V2.18 | 31.91% | 320.220s | Aggregate public-gender headroom diagnostic; all study/adoption gates failed. |

### V2.17 strict result

The sealed-source capture observed 385 source profiles and 1,915 selected media items. It retained
380 profiles: 235 public, 145 private, and 1,904 media items. Capture and normalization took
581.209s. That duration is neither Instagram collection time nor AI analysis time and must not be
used as a product SLA measurement. Apify Actor delta was zero.

The first execution was a pre-generation configuration failure: its model location was regional
instead of the required `global` location, so 123 requests were rejected with 4xx responses in
11.29s. It produced no successful-generation evidence and is not a quality result. The corrected
single paid replay used the required global location and ran once; no duplicate successful replay
was started.

The corrected strict report was:

| Metric | Result |
| --- | ---: |
| Corrected replay wall time | 314.009s |
| Baseline male / female / unknown | 70 / 82 / 83 |
| Final male / female / unknown | 74 / 84 / 77 |
| Observed unknown ratio | 32.77% |
| Worst-case unknown ratio | 34.17% |
| Strict fusion rescues | 6 (male 4, female 2) |
| Calibration agreement | 96 / 103 (93.2%) |
| Male calibration agreement | 45 / 51 (88.2%) |
| Female calibration agreement | 51 / 52 (98.1%) |
| Known official counterfactuals | 12 |
| Official fusion attempted / accepted | 1 / 1 |
| Adoption gate | false |

Stage telemetry for that corrected replay was:

| Stage | Calls | Mean latency | Retries | Rate limited | Failure / rejection detail |
| --- | ---: | ---: | ---: | ---: | --- |
| gender triage | 231 | 3,018ms | 0 | 0 | 0 failures |
| feature analysis | 175 | 5,034ms | 0 | 0 | 1 response rejected |
| private-name analysis | 5 | 7,279ms | 0 | 0 | 1 response rejected |
| gender resolver | 39 | 12,613ms | 0 | 0 | ambiguous 2, transport 2, capacity 9, cutoff 1 |

V2.17 is rejected for production. It missed the 20% unknown objective, overall and male calibration
gates, and the official-account exclusion gate. Production remains on V2.10. This result is an
AI-only evaluation; it is not a full Standard E2E, SLA measurement, or product cost sample.

### V2.18 aggregate headroom result

V2.18 reused the same authenticated sealed Standard source without source refresh or media
substitution. It retained 380 profiles: 235 public, 145 private, and 1,904 media items. Exactly one
expected execution ran with one task, task attempt zero, no Cloud Run retry, one claim, and one
strict report. The worker package has no Apify import or credential path, so this evaluation made
no Instagram or Apify call and could not mutate a production request or user result.

The strict aggregate report was:

| Metric | Result |
| --- | ---: |
| Replay wall time | 320.220s |
| Baseline male / female / unknown | 71 / 82 / 82 |
| Final male / female / unknown | 76 / 84 / 75 |
| Observed unknown ratio | 31.91% |
| Worst-case unknown ratio | 33.33% |
| Additional rescues required for observed `<=20%` | 28 |
| Additional rescues required for worst-case `<=20%` | 32 |
| Unknown name vote, female / male / none | 16 / 23 / 43 |
| Unknown visual vote, female / male / none | 6 / 7 / 69 |
| Guarded strong-female-name / eligible | 13 / 4 |
| Final unknown with resolver media `>=2` | 44 |
| Final unknown with distinct feed posts `>=2` | 37 |
| Distinct posts `>=2` and personal/creator context | 20 |
| Distinct posts `>=2` and uncertain context | 8 |

Known-result restricted calibration predicted 90 of 153 known rows and agreed on 86. Male
agreement was 42/45 and female agreement was 44/45. Their one-sided 95% Wilson lower bounds were
84.44% and 90.63%, respectively. The username-only slice made zero predictions, so it provided no
calibration evidence.

The guarded-female candidate-volume, restricted-female sample, restricted-female precision,
official-final-rescue, and name-only-further-study gates were all false. Four guarded name-only
candidates cannot close either the 28-account observed gap or the 32-account worst-case gap.
Although 37 final-unknown accounts have at least two distinct feed posts, only 20 also have a
personal/creator context, and V2.18 did not evaluate a new visual model or establish precision for
an expanded cohort. The raw media count therefore identifies model headroom but does not prove that
`<=20%` is achievable under the current safe gates. Production remains on V2.10.

Stage telemetry for the single V2.18 execution was:

| Stage | Calls | Mean latency | Retries | Rate limited | Failure / rejection detail |
| --- | ---: | ---: | ---: | ---: | --- |
| gender triage | 231 | 2,994ms | 0 | 0 | 0 failures |
| feature analysis | 175 | 5,136ms | 0 | 0 | 2 response rejected |
| private-name analysis | 5 | 7,680ms | 0 | 0 | 0 failures |
| gender resolver | 42 | 9,765ms | 0 | 0 | response rejected 2, capacity 4, ambiguous 1, transport 1, cutoff 1 |

The exact provider-dispatch total was 453. For this source, the replay topology permits at most 710
logical calls; Gemini permits at most four attempts per logical call, so the pre-execution hard
dispatch ceiling was 2,840. The strict terminal report intentionally retains no token counts or
per-attempt cost, and project-level token monitoring was not yet attributable to this execution.
Actual Gemini USD cost is therefore incomplete and must not be fabricated. At the configured output
caps and repository pricing, `$1.211904` is only the maximum output-token component for the 453
observed dispatches; input-token cost is additional and unknown. This is not a complete replay cost,
full Standard cost, or unit-cost sample.

## Teardown

Tear down only after terminal evidence has been retained in the approved aggregate form. Remove
resources in this order:

1. Cloud Run Jobs and completed executions;
2. execution and input Secret Manager versions after reference-count verification;
3. live GCS package/input/claim/report objects, then confirm bucket soft-delete state;
4. temporary IAM bindings and service accounts.

Never delete a still-referenced secret, package generation, claim, or report object. Object and
secret deletion is not a substitute for reviewing a failed or ambiguous paid invocation.

## Canonical documentation placement

Current production policy and product cost boundaries remain canonical in
[`analysis-v2-production-operations.md`](./analysis-v2-production-operations.md) and
[`operations-cost-model.md`](./operations-cost-model.md). This document is the canonical aggregate
record for AI-only replay operations and evaluation results.
