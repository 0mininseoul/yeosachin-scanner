# Analysis V2 AI replay operations

## Scope and status

AI stage policy V2.11 through V2.17 is evaluation-only. Production policy selection and the
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

The timings below include replay capture/normalization and AI work for the same historical source.
They are useful for relative comparison only, not an end-to-end product SLA or production cost
model.

| Evaluation policy | Unknown ratio | Wall time | Notes |
| --- | ---: | ---: | --- |
| V2.12 | 35.32% | 304.3s | Baseline AI-only evaluation. |
| V2.13 | 31.20% | 364.6s | High-resolution feature shadow. |
| V2.14 | 34.04% | 500.5s | Feature-model shadow. |
| V2.15 | 32.34% | 505.7s | Larger feature response cap. |
| V2.16 | 33.62% | 705.5s | Single-profile admission shadow; 32 admitted single-profile candidates yielded 0 rescues. |

V2.17 name-and-visual fusion is prepared as a separate evaluation capability. At the time of this
document revision it has not been executed; add its aggregate result only after the strict report
and zero-Apify checks pass.

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

After a V2.17 result is independently reviewed, add a short link from
[`analysis-v2-production-operations.md`](./analysis-v2-production-operations.md) near the gender
quality section and from [`operations-cost-model.md`](./operations-cost-model.md) near evaluation
versus production-cost evidence. Do not update either canonical document until that result exists.
