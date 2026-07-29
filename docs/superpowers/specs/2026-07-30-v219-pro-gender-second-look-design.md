# V2.19 Pro Gender Second-Look Replay Design

**Status:** implementation design approved  
**Date:** 2026-07-30  
**Scope:** authenticated, sealed-source, paid-AI replay evaluation only  
**Control:** immutable V2.18/V2.12 provider path  
**Treatment model:** `gemini-3.1-pro-preview`  
**Out of scope:** production policy selection, persisted user results, a new
Instagram/Apify read, threshold relaxation, frontend copy, and paid execution
before a separate cost-gate approval

## 1. Problem and evidence

The single retained V2.18 replay ended with 75 unknown public profiles out of
235 observed public profiles. Reaching an observed unknown rate of at most 20%
requires 28 additional rescues. Treating the five missing public profiles as
unknown requires 32 additional rescues for the worst-case rate.

V2.18 ruled out the two smaller changes:

- The guarded name-only path had only four eligible unknown profiles, so it
  cannot close either gap.
- The current Flash resolver made 42 provider dispatches, but only three
  resolver results were applied. Repeating the same model and admission path
  is not a plausible 28/32-account intervention.

The remaining evidence-sized cohort is visual:

- 44 final-unknown profiles had at least two resolver media items.
- 37 final-unknown profiles had at least two distinct feed posts.
- The V2.18 visual headroom diagnostic examined feature/triage output, not the
  stronger resolver output.
- Current resolver media ordering can spend bounded slots on carousel context
  before later distinct-post representatives.

The next shadow therefore changes model and input evidence while preserving
the existing acceptance floor.

## 2. Considered approaches

### A. Full evidence-eligible Pro second-look — selected

Run a replay-only Gemini 3.1 Pro second-look for every retained public profile
that statically has at least two selected resolver media items. This gives the
same-run treatment output for known calibration rows and final-unknown rescue
rows, avoids outcome-dependent provider admission, and makes the paid cohort
count derivable without a provider call.

The higher call count is acceptable because this is one bounded evaluation,
the user prioritizes unknown-rate quality over the five-minute latency target,
and the run has an explicit dispatch and USD reservation fence.

### B. Unknown-only Pro plus a stratified known sample

This is cheaper, but treatment admission would depend on nondeterministic
control output and calibration would use a separately sampled cohort. It is a
weaker comparison and makes the exact pre-provider topology harder to audit.

### C. Flash with distinct-post-first input only

This is the cheapest option, but V2.18 already used Flash at high thinking and
high media resolution. Its observed application yield is too low to make
28/32 additional rescues plausible.

## 3. Evaluation boundary

V2.19 is a new evaluation-only replay capability. It inherits the complete
V2.18 control path byte-for-byte and adds one in-memory treatment stage after
the sealed source has been authenticated.

The following boundaries are immutable:

- production policy selection remains capped at V2.10;
- production persisted-policy allowlists do not include V2.19;
- no analysis request, stage checkpoint, result summary, or user result is
  written by the replay;
- the worker package has no Instagram or Apify credential/import path;
- the only input is the same sealed 1,904-media source used by V2.18;
- the terminal artifact is aggregate-only;
- creating or executing a paid Cloud Run job remains forbidden until the
  exact dry-preflight cohort, dispatch ceiling, pricing basis, and conservative
  USD ceiling have been reviewed and explicitly confirmed.

V2.19 does not reinterpret a missing or failed provider response as evidence.
Every non-successful treatment invocation remains unknown.

## 4. Static treatment cohort and media projection

Treatment admission uses source structure only. It does not use triage,
feature, resolver, name, or final-classification output.

A retained profile is treatment-eligible when:

1. it is public; and
2. the V2.12 resolver media policy selects at least two unique media items.

The dry preflight must compute the exact eligible count from the authenticated
bundle without constructing a Gemini client or calling any provider. It fails
closed if:

- the retained source identity differs from the approved sealed source;
- retained media is not exactly 1,904;
- retained public profiles are not exactly 235;
- any selected media reference is missing from the bundle;
- an opaque treatment ID cannot round-trip to exactly one source selection;
- the eligible count exceeds 235.

Each treatment input contains at most nine images:

- the profile image, when present; then
- up to eight feed images.

Feed images are reordered to maximize independent evidence:

1. the first representative from each distinct post, in canonical source
   order;
2. only after distinct-post representatives, remaining carousel context in
   canonical order.

The model receives no handle, name, bio, caption, URL, post ID, ordinal, or
source selection ID. Media are projected to request-local opaque IDs such as
`second-look-media:1`. The prompt contains only the fixed instructions and the
opaque ID allowlist.

## 5. Model contract

The treatment configuration is fixed:

| Field | Value |
| --- | --- |
| Model | `gemini-3.1-pro-preview` |
| Location | `global` |
| Thinking | `HIGH` |
| Media resolution | `HIGH` |
| Profile image limit | 1 |
| Feed image limit | 8 |
| Maximum output | 2,048 units |
| Maximum attempts per logical call | 4 |
| Treatment concurrency | 2 |

The response uses a strict structured schema with:

- `inferredGender`: `female`, `male`, or `unknown`;
- `genderConfidence`: `low`, `medium`, or `high`;
- `ownerConsistency`: `same_person`, `mixed_people`, or `not_visible`;
- `accountContext`: `personal`, `individual_creator`,
  `official_group_or_brand`, or `uncertain`;
- `contextConfidence`: `low`, `medium`, or `high`;
- `genderEvidenceIds`: at most five opaque IDs;
- `contextEvidenceIds`: at most five opaque IDs.

Schema refinement rejects:

- an ID outside the request-local allowlist;
- duplicate IDs being counted as independent evidence;
- high-confidence binary gender with fewer than two unique gender evidence
  IDs;
- high-confidence personal/creator context with no context evidence;
- non-unknown gender when the owner is not visible;
- any extra response key.

The prompt asks the model to identify the repeatedly visible account owner,
separate mixed people, classify gender only from visible evidence, and classify
official/group/brand context independently. It never asks the model to infer a
specific identity.

## 6. Rescue and calibration semantics

The treatment output does not replace an already-known control classification.
It is evaluated in two disjoint roles.

### 6.1 Known calibration

For a profile already classified male or female by the pre-fusion V2.12
control path, the treatment emits a calibration vote only when all of the
following hold. Name-fusion rescues are not promoted into calibration labels.

- binary gender;
- `genderConfidence=high`;
- `ownerConsistency=same_person`;
- at least two unique gender evidence IDs;
- `accountContext` is `personal` or `individual_creator`;
- `contextConfidence=high`;
- the profile was not excluded as official/group by the control path;
- the treatment did not classify it as official/group.

The V2.17 thresholds are preserved:

- at least 30 predicted known rows overall;
- at least 10 predicted rows for each known sex;
- at least 95% agreement overall;
- at least 95% agreement on known male rows;
- at least 95% agreement on known female rows;
- zero accepted official/group counterfactuals.

V2.19 adds, rather than relaxes, a direct false-female gate:

- zero known-male rows may be accepted as female.

The report also records one-sided 95% Wilson lower bounds for the overall,
known-male, and known-female slices. These are diagnostics; they do not replace
or weaken the fixed agreement gates.

### 6.2 Final-unknown rescue

Only a profile still unknown after the strict V2.18 name-and-visual fusion is a
rescue candidate. A treatment result can rescue it only when it passes the
same vote conditions used by calibration and the complete calibration gate
passes.

Existing reconciliation semantics remain intact:

- an ordinary unresolved result requires high-confidence same-owner binary
  evidence with at least two unique evidence IDs;
- an unresolved stage conflict additionally requires the treatment gender to
  match one of the two conflicting binary stage genders;
- fetch-, media-, or analysis-unavailable control rows are not treatment
  rescues;
- a control official/group exclusion is final;
- a treatment official/group classification is final for this shadow;
- no medium-confidence, single-evidence, owner-mismatch, or provider-failed
  result is accepted.

The report may show the counterfactual rescue count even when a global gate
fails, but `adoptionPass` remains false unless calibration, official, observed
unknown, and worst-case unknown gates all pass. V2.19 itself never changes
production regardless of `adoptionPass`.

## 7. Aggregate report

The strict V2.19 terminal report adds fixed-key aggregate fields only:

- static treatment cohort count and media-count histogram;
- logical calls, provider dispatches, attempts, retries, rate limits, and
  bounded failure dispositions;
- structured-response outcomes and rejection-reason counts;
- known calibration totals by control sex, agreement/disagreement, Wilson
  bounds, and known-male-to-female count;
- official/group attempted and accepted counts;
- final-unknown treatment outcomes and null-reason counts;
- counterfactual rescued male/female counts;
- observed and worst-case final unknown counts/rates;
- each fixed quality gate;
- configured and reserved USD ceiling plus aggregate estimated cost when usage
  metadata is complete.

It cannot contain an account identifier, request identifier, handle, name,
bio, caption, URL, prompt, opaque media ID, post ID, image bytes, provider
response, error text, credential, secret, or per-account row. The existing GCS
safe-value validator and a V2.19 conservation schema both validate the single
JSON line before upload.

## 8. Hard dispatch and cost fences

The paid adapter owns one non-forgeable, process-local budget shared by the
control and treatment stages.

The dry preflight derives and prints, without secrets:

- exact static treatment cohort size `C`;
- control logical-call ceiling `710`;
- treatment logical-call ceiling `C`;
- total logical-call ceiling `710 + C`;
- control provider-dispatch ceiling `710 * 4 = 2,840`;
- treatment provider-dispatch ceiling `C * 4`;
- total provider-dispatch ceiling `(710 + C) * 4`;
- per-stage configured model, resolution, image limit, output limit, and
  pricing rate;
- the conservative maximum reserved USD amount.

Before every provider dispatch, the shared fence atomically reserves:

1. one dispatch from the applicable stage and total ceiling; and
2. that stage's conservative maximum request charge.

Reservation occurs before SDK provider entry. A reservation that would exceed
any stage, treatment, total-dispatch, or USD ceiling throws a fixed safe error
and makes no provider call.

The conservative charge uses:

- the repository's reviewed global on-demand model rates;
- the fixed maximum output for that stage;
- the model-family media-resolution maximum per selected image;
- a reviewed text/schema/envelope upper bound that is greater than the maximum
  bytes admitted by the strict input schemas.

The Pro pricing entry is fixed to the reviewed Google rate for requests below
200k input units: USD 2 per million input units and USD 12 per million output
units. The bound assumes every logical call uses all four attempts, every
attempt uses the maximum admitted images and text/schema allowance, and every
attempt consumes its entire output allowance.

The reviewed primary sources are Google's
[Vertex AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing),
[Gemini 3 model guide](https://ai.google.dev/gemini-api/docs/gemini-3), and
[Gemini 3 media-resolution table](https://ai.google.dev/gemini-api/docs/media-resolution).
The dry preflight must fail if the repository pricing entry or configured
media-unit allowance differs from these reviewed constants.

Actual aggregate estimated cost is complete only when usage metadata is
complete for every dispatched attempt. Missing usage never becomes zero and
does not alter the conservative ceiling.

## 9. Zero-provider dry preflight and paid gate

The dry preflight must:

1. authenticate and validate the sealed bundle;
2. validate V2.19 evaluation lineage and immutable worker identity;
3. derive the static cohort and media projection;
4. validate aggregate-report schemas with synthetic outcomes;
5. derive the exact logical-call, provider-dispatch, and conservative USD
   ceilings;
6. prove that no Gemini client, Apify client, Instagram transport, production
   store, or result writer was constructed;
7. exit before creating a Cloud Run execution.

After that preflight, the exact count and ceilings are reported for explicit
approval. Implementation completion, a successful dry preflight, or an
existing general paid-AI flag is not approval to start V2.19.

## 10. Test strategy

Implementation follows red-green TDD. Tests must cover:

- distinct-post-first deterministic projection and opaque-ID round trips;
- strict schema rejection and evidence-count invariants;
- unchanged stage-conflict reconciliation and official exclusions;
- known calibration conservation and every quality gate;
- false-female gate failure on one known-male-to-female result;
- no rescue from a non-successful invocation or missing usage;
- static cohort derivation independent of AI output;
- exact logical/dispatch formulas;
- atomic dispatch and USD reservation before provider entry;
- retry consumption of both dispatch and USD reservations;
- aggregate-only report rejection for identifiers, prompt/media fields, raw
  response/error content, and extra keys;
- V2.19 CLI, source lineage, package allowlist, immutable entry marker, and
  production-policy non-selectability;
- zero-provider dry preflight using spies that fail if a provider/client/store
  constructor is reached.

Targeted tests, the full Vitest suite, lint, TypeScript checking, and the replay
job package build must pass before the dry-preflight result is presented.

## 11. Rollback and production status

V2.19 adds no production rollout state, database migration, or stored result,
so rollback is deletion of the unused evaluation job/package after evidence
retention. Production remains V2.10 until a separate, explicitly reviewed
production design changes the selector, persistence allowlist, operational
runbook, and user-result semantics.
