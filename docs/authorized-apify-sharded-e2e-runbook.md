# Authorized Apify operation-split E2E runbook

This runbook applies only to the explicitly authorized `0_min._.00` E2E. It does not define a beta, early-access, or production credential strategy.

## Invariants

1. Public V2 admission remains disabled.
2. The request uses a signed `test_entitlement` and is created while authenticated as `ym1113@kakao.com`.
3. The exact target allowlist is `0_min._.00`, and the exact owner UUID is `974247fa-8d0e-4ab7-b6d2-ddf256ad6bdd` (`ym1113@kakao.com`).
4. The request-bound operation map is written in the same transaction that consumes the entitlement, before the initial job is dispatched.
5. A relationship side uses one slot. Followers and following may use different slots because they are independent Actor operations.
6. Normal requests continue to use `ANALYSIS_V2_APIFY_API_TOKEN_SLOT` only.
7. No provider token is stored in PostgreSQL or printed in logs.

## Policy configuration

Set the authorized-test variables below on the entitlement intake runtime. Set the normal-slot
variable shown in the same block on both the intake and worker so `primary` is effective before and
after request dispatch:

```dotenv
ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED=true
ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET=0_min._.00
ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID=974247fa-8d0e-4ab7-b6d2-ddf256ad6bdd
ANALYSIS_V2_APIFY_API_TOKEN_SLOT=primary
ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT=secondary
ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT=quinary
ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT=primary
ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT=primary
ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT=secondary
ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT=secondary
```

This preferred next-run mapping preserves the current active secret identities: `secondary` is the
physical Senary account, `quinary` is the physical Quinary account, and `primary` is the physical
Septenary account. It is schema-valid because the two relationship sides differ, `target-profile`
and `profile-fallback` share the profile fallback variable, and the target and candidate liker slots
differ.

Use this mapping only if immediate read-only balance checks, exact Actor daily item and run quota
checks, and active/latest Secret Manager references all confirm the intended accounts have enough
headroom. Both the intake and worker must resolve their effective normal selected slot to `primary`
through the current active primary Secret Manager reference. Never rotate a numeric secret version
to force this mapping or the normal-slot selection. The worker must have Secret Manager references
for every slot named by the policy.

Fresh-admission/preflight target-profile fallback occurs before request-bound sharding is bound and
therefore uses the effective normal selected slot. That slot must be `primary`, matching the
request-bound `target-profile` and `profile-fallback` entries, so the schema-v1 attested preflight
run can be reused consistently after the request is created.

## Pre-run checks

1. Apply migrations through `20260717160000_allow_analysis_v2_rate_limit_exhaustion_fallback.sql` using the normal ordered migration path. Do not use `--include-all`.
2. Only after those migrations succeed, deploy and enable the reviewed commit on Vercel and Cloud Run, then confirm both deployed SHAs match it.
3. Confirm the worker can load `accessMode` plus the optional request-bound policy.
4. Confirm both intake and worker have effective normal selected slot `primary`, resolved through the current active primary secret reference without rotating to a numeric secret version.
5. Confirm every credential slot referenced by the policy resolves to its intended physical account without displaying token values.
6. In the browser session, confirm the Supabase user email is exactly `ym1113@kakao.com` and record its UUID.
7. Confirm the preflight target is exactly `0_min._.00`, the selected plan is eligible, and the girlfriend exclusion decision is explicit.
8. Confirm both Vercel and Cloud Run use `SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED=true`, `SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS=750`, and `SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS=100`. A coordination failure or guard overrun must stop the direct Instagram request; it must not be bypassed for an E2E.
9. Confirm Cloud Run has no traffic-tagged revision and exactly one revision receives 100% traffic. The deploy script rejects even a zero-percent tagged revision while Gemini concurrency remains process-local.
10. Immediately before deploying or starting this canary, confirm there are no processing V2 requests, no claimed/running V2 jobs, no active provider runs, and no queued task from an earlier request. Wait for any old revision request to finish before promotion.

### Profile-repair micro-canary

Use `npm run canary:apify-profile-repair` only to measure the bounded repair of the failed V2
profile-fallback batches from one reviewed source request. Keep the source request UUID, expected
owner UUID, and expected owner email as operator input only. Set the owner values through
`AUTHORIZED_E2E_OWNER_ID` and `AUTHORIZED_E2E_OWNER_EMAIL`; do not add any of these three values to
the repository, command output, logs, screenshots, or evidence notes. Disable shell tracing before
setting them.

Failed V2 terminal cleanup replaces the request and consumed-preflight usernames with deterministic
`retained.*` tombstones. The replay loader and paid reservation must not require, restore, or infer
the scrubbed request field. They authorize this one-off source only through the immutable
`authorized-free-e2e-v1` execution policy, the matching test-entitlement consumption, the reciprocal
consumed preflight/request/owner lineage, and both exact terminal tombstones. The execution policy
must contain the fixed authorized target and its `profile-fallback` slot must match the selected
credential slot. A missing or conflicting policy, consumption, preflight link, or tombstone blocks
both replay and journal reservation; early-bird orders and result heuristics are not substitutes.

Before any replay or paid invocation, review and apply
`20260718123000_add_profile_repair_canary_journal.sql` followed by
`20260718124500_fix_profile_repair_canary_source_policy.sql` through the ordered migration path and
review the exact script SHA. First run the command without `--confirm-paid-api-call`, supplying
exactly one `--source-request-id`, `--critical-job-key`, and explicit `--credential-slot`. This default replay
must make zero new Actor starts and zero journal writes. It must reconstruct the inputs only from
the eight succeeded source `profile-fallback` jobs, verify their stored Actor and credential slot,
and report exactly 15 unique incomplete usernames including the critical batch member. Output is
limited to bounded aggregate counts and cost/gate status; it must not contain usernames, owner or
request identifiers, run or dataset identifiers, tokens, URLs, payloads, hashes, or provider
messages.

After that replay is reviewed, a human may separately approve one paid invocation by adding the
exact valueless `--confirm-paid-api-call` flag. The limits are fixed in code: two repetitions,
15 usernames per Actor run, `$0.05` maximum charge per run, and `$0.10` maximum total exposure.
Do not accept command-line overrides. Repetition two may start only after repetition one is
terminal, passes the quality gate, has stable reconciled actual cost at or below `$0.05`, and is
recorded that way in the journal. A later retry after reconciliation requires a fresh human approval
and must resume only the run ID already stored for that repetition.

Stop without starting a replacement, rotating credentials, issuing another Actor start, manually
aborting, or resurrecting a terminal run if source ownership, target, V2 failure status, job count,
source input shape, Actor, slot, or exact 15-member union does not match; if a run start is ambiguous;
if a terminal result has fewer than 14 successes, more than one unavailable result, any other
failure, or no critical recovery; or if actual cost is unsettled or exceeds either cap. Audit an
ambiguous start in Apify and the journal before any later approved invocation. A timed-out
reconciliation remains conservative and blocks repetition two even if the provider later reports a
terminal run.

### Early-access Gemini concurrency boundary

The launch worker uses one configured Cloud Run instance, container concurrency eight, and a V2
queue capped at eight concurrent dispatches and eight dispatches per second. This reduces the
observed fleet burst while retaining enough profile-AI parallelism for the five-minute canary.
Cloud Run maximum instances is not a hard distributed semaphore and can be exceeded briefly during
traffic spikes or revision rollout. Therefore this configuration is authorized only while public
V2 admission is disabled, early-bird purchases do not create analysis tasks, and the operator runs
one signed E2E or one manually controlled analysis at a time.

Before automatic or concurrent paid analysis is enabled, add a fenced, expiring distributed Gemini
lease shared by every worker revision. Do not treat `max instances=1` or process-local semaphores as
that production gate.

### Free Actor API quota

An Apify account balance or monthly platform credit does not prove that a specific Actor can
serve another API run. The Scraping Solutions relationship Actor applies its own free API/MCP
daily item and run limits. The observed `0.0.71` build reported 1,000 API items and five API runs
per UTC day, but this is Actor policy rather than an application contract and may change.

Before a free-account canary, inspect that account's recent runs for the exact Actor and UTC day.
Do not infer remaining Actor quota from the Apify account usage balance. A terminal status message
or run log containing the free API daily-limit signal is classified as
`SCRAPING_PROVIDER_QUOTA_ERROR`; do not retry the same operation on the same account until the
Actor quota resets or the account is upgraded. Production must continue to use one configured
paid account instead of rotating free accounts.

## Success checks

1. The request row's `user_id` equals the verified UUID for `ym1113@kakao.com`.
2. Followers and following have distinct persisted provider-run slots and pass completeness gates independently.
3. Every fallback, liker, and comment run uses the slot required by the persisted operation map.
4. The request reaches `completed`; failed or incomplete relationship coverage is not presented as a complete result.
5. The completed request appears on the same user's `기록` page and the result link can be reopened after leaving the browser.
6. Record total duration, stage durations, provider usage, Gemini usage, and any fallback reason without recording credentials or private payloads.
7. When fresh admission produced a schema-v1 attested target profile run, confirm target evidence replayed that run ID without a second profile Actor or `analysis_v2_provider_runs` row. Attribute its cost only to the preflight. If no attested descriptor exists, confirm the existing bound profile fallback was used instead.

## Teardown

1. Set `ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED=false` on the intake runtime.
2. Remove non-selected temporary Apify secret references from the worker after no policy-bound request remains active.
3. Keep public admission disabled until the separate paid launch decision.
4. Commercial display terms are defined only by the canonical ["Groble 얼리버드 표시안 (성공 E2E 후 확정)" block](./operations-cost-model.md). Payment integration is outside this E2E's scope and remains on a separate branch; do not implement or enable it as part of this run.

## 2026-07-16 canary evidence

Request `392edd9d-1999-4a44-9dc1-3a479a3ceb10` used the authenticated owner and exact target
specified above. Preflight declared 469 followers and 635 following and selected Standard. The
analysis did not complete:

- The primary relationship account had already used 940 of the Actor's 1,000 daily free API
  items. The Actor reserved only 60 of the requested 469 follower results and downloaded 45
  before request-wide cleanup aborted the still-running sibling.
- The following-side run reached a terminal free API daily-limit status and produced no usable
  relationship evidence. The application correctly failed closed with
  `SCRAPING_PROVIDER_QUOTA_ERROR`; it did not present a partial mutual count as complete.
- The logged-out target full-profile request received HTTP 429. The exact unresolved target used
  one Apify profile fallback, with reconciled provider cost `$0.0026`.
- No relationship manifest, mutual-profile batch, Gemini attempt, or final result was created.
  Gemini cost was `$0`; total reconciled provider cost was `$0.0026`.
- Wall time to terminal failure was about 465 seconds. The excess delay came from a cleanup-intent
  race that retained a 360-second job lease. The recovery branch must include the immediate claim
  release and provider-branch quiescence regression tests before the next canary.

This run proves the admission, authenticated ownership, provider ledger, quota fail-closed, and
cost reconciliation paths. It does not prove full relationship coverage, mutual-profile crawling,
Gemini latency, result rendering, or the five-minute success target.

### Recovery protections added after the canary

- A cleanup-only database transition immediately returns an exact live claim to `pending` while
  request-wide provider cleanup remains incomplete. It preserves the handler attempt count, works
  on the seventh attempt, and fails closed for stale claims or completed/missing cleanup intents.
- Parallel provider branches are always awaited to terminal settlement. When one branch fails, a
  request-scoped cancellation signal prevents only a sibling that is still queued and has not
  reserved or started an Actor. A run with a checkpointed run ID continues to terminal settlement
  so its durable ledger and cost records remain reconcilable. A reserved start without a confirmed
  run ID remains fail-closed and requires the existing unconfirmed-start reconciliation process.

The next authorized canary still must prove full relationship coverage, mutual-profile crawling,
Gemini latency, result rendering, and the five-minute success target. The target profile's observed
logged-out HTTP 429 also remains a separate self-hosted crawler reliability issue; this recovery
change does not classify the fallback as proof that logged-out collection is production-ready.

### Fresh-admission target profile reuse

A successful fresh-admission Apify run is reusable by `track:target-evidence:collect` only when its
bounded full-profile snapshot passed schema-v1 validation (`latestPosts` parser max 10) and the
request, target, admission generation, job
input hash, and live lease still match. Replay reads the existing dataset and writes the normal
profile checkpoint, but does not start another profile Actor, bind a V2 provider-run row, or record
the cost again. Missing or legacy `NULL` attestations use the existing bound fallback. Malformed
descriptors and replay parse failures fail closed; they never authorize an automatic replacement
Actor.

### Production-wide self-hosted start coordination

A later profile fanout started seven batches across about five Cloud Run instances. The old gate
and circuit were process-local, so 210 self-hosted profile attempts produced no successes: five
profiles reached Instagram and returned HTTP 429 (ten network requests including retries), while
205 were skipped by local circuits. An earlier single-request Cloud Run egress probe had returned
HTTP 200; that probe did not validate aggregate multi-instance behavior.

The default full-profile and admission paths now reserve every network start through one PII-free
Supabase singleton before `onRequest` accounting or `fetch`. The 750ms interval plus 100ms response
guard produces an 850ms reservation slot. Therefore, 237 starts span 200.6 seconds from first to
last, so operators should budget about 201 seconds plus response tail latency. Admission calls wait
at most 500ms, full-profile calls wait at most 60 seconds, and the RPC itself hard-times out at
750ms. The local concurrency-four scheduler, 300ms interval, and circuit remain
defense in depth. Database/RPC errors and malformed reservation payloads fail closed as sanitized,
retryable transport-style profile failures, allowing only the existing bounded fallback policy to
decide the next step. This aggregate pacing reduces burst risk; it does not guarantee Instagram
will accept logged-out requests, and a successful single egress probe is not production evidence.

## 2026-07-17 Standard canary evidence (failed)

Preflight `3d6759a9-948c-4de1-be7a-d02aa72ed8fd` created Standard request
`b27bc417-5e45-41b1-aad3-af733fdbb954` for the exact target `0_min._.00`. The request failed and
does not satisfy the success checks in this runbook.

- Wall time was exactly `1,308,289ms` (`21m48.289s`): queue `978ms` and processing
  `1,307,311ms`. Of 21 jobs, 11 completed, one failed, and nine were cancelled. `private-names`
  batch 1 exhausted all seven attempts, then sibling AI checkpoint jobs were cancelled.
- The first root cause was an incorrect comparison between the private-name topology content hash
  and an independently scoped consumer job hash. The second was a candidate feature completion
  contract that required a media bundle for non-`verified_female` classifications even though the
  executor persisted that bundle only for `verified_female`. Forward migration
  `20260717120000_fix_analysis_v2_checkpoint_contracts.sql` and its PGlite tests correct these
  contracts. They are not yet recorded here as deployed or validated by a successful E2E.
- All 12 request provider runs settled with exact actual cost `$2.1816`. The preflight actual
  `$0.0052` is separate. Gemini recorded 400 attempts and estimated `$0.57216325`, but two
  feature-analysis `response-rejected` attempts had missing or malformed usage. Therefore
  `costComplete=false`: request cost is a lower bound of `$2.75376325`, and end-to-end cost including
  preflight is a lower bound of `$2.75896325`. GCP infrastructure and the unknown cost of those two
  malformed-usage calls are excluded.
- Most provider and AI generation work had finished around `3m10`; the remaining approximately
  `18m38` was checkpoint retry and cancellation delay. This suggests, but does not prove,
  sub-five-minute feasibility after the checkpoint fix.
- There were 236 candidate detailed profiles and zero direct `selfhosted` successes. Six outcomes
  were rate limits, while roughly 230 were global-gate or circuit outcomes that sent no Instagram
  request. Fallback targeted only the exact unresolved accounts; all 236 were unresolved in this
  run. Apify candidate fallback produced 227 successes and nine incomplete/unavailable outcomes.
  Aggregate profile coverage including the target was 228 successes and nine incomplete outcomes.
  Cloud Run datacenter egress remains a launch blocker for self-hosted-only profile collection.
- The candidate liker stage never ran because the request failed upstream.

This failed canary is diagnostic and lower-bound cost evidence only. It is not a successful sample,
p50/p95 evidence, a five-minute SLA result, or final sale-price evidence.
