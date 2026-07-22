# 승인된 Apify 작업 분리 E2E 런북

이 런북은 명시적으로 승인된 `0_min._.00` E2E 한 건에만 적용한다. 베타·얼리 액세스·일반 운영 요청의 credential 전략을 정의하지 않는다.

## 불변 조건

1. 이 canary를 위해 공개 preflight/판매 admission 상태를 바꾸지 않는다. 유효한 서명 admission은 해당 요청에만 `test_entitlement`를 선택하고, 잘못된 header는 production으로 통과시키지 않고 거절한다.
2. 요청은 서명된 `test_entitlement`를 사용하며 승인된 사용자로 인증된 상태에서 생성한다. header가 없는 요청의 `PREFLIGHT_ACCESS_MODE`는 계속 `production`이다.
3. 정확한 target allowlist와 owner UUID는 승인된 값 하나로 고정한다.
4. 요청별 operation map은 entitlement를 소비하는 같은 transaction에서 최초 job dispatch 전에 기록한다.
5. followers와 following은 독립 Actor 작업이므로 서로 다른 slot을 사용할 수 있지만 각 방향은 하나의 slot만 사용한다.
6. 일반 요청은 계속 `ANALYSIS_V2_APIFY_API_TOKEN_SLOT` 하나만 사용한다.
7. provider token은 PostgreSQL에 저장하거나 로그에 출력하지 않는다.

## 정책 설정

아래 승인 테스트 변수는 entitlement intake runtime에 설정한다. 같은 블록의 normal slot은
intake와 worker 모두에 설정해 요청 dispatch 전후에 `secondary`가 동일하게 적용되게 한다.

```dotenv
ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED=true
ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET=0_min._.00
ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID=974247fa-8d0e-4ab7-b6d2-ddf256ad6bdd
ANALYSIS_V2_APIFY_API_TOKEN_SLOT=secondary
ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT=tertiary
ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT=quaternary
ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT=secondary
ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT=secondary
ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT=quinary
ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT=quinary
```

이 mapping에서 normal/profile/target-likers는 실제 판매에 사용할 `secondary:1` 계정을,
relationship 두 방향은 각각 `tertiary:1`과 `quaternary:1`을, target-comments와
candidate-likers는 `quinary:1`을 사용한다. 두 relationship 방향이 다르고 target/candidate
liker slot도 다르며, preflight와 request profile은 같은 normal slot을 사용하므로 schema에
맞는다.

실행 직전 read-only 잔액, 정확한 Actor 일일 item/run quota, active job, Secret Manager numeric
reference를 다시 확인해 모든 계정에 충분한 여유가 있을 때만 이 mapping을 사용한다. intake와
worker의 effective normal slot은 모두 현재 `secondary:1` reference로 해석되어야 한다. 이
mapping을 만들기 위해 기존 numeric secret version을 덮어쓰지 않는다. worker에는 정책에
등장하는 각 slot의 정확한 numeric reference만 제공한다.

Fresh-admission/preflight target-profile fallback은 request-bound sharding보다 먼저 실행되므로
effective normal slot을 사용한다. 따라서 이 slot은 request의 `target-profile`과
`profile-fallback`과 같은 `secondary`여야 하며, schema-v1로 증명된 preflight run을 요청 생성
후에도 일관되게 재사용한다.

## Pre-run checks

1. 정상 순서로 `20260722110000_record_definite_apify_start_rejections.sql`까지 migration을 적용한다. `--include-all`은 사용하지 않는다. `20260719190000`은 이미 수동 reconciliation으로 적용됐으므로 다시 실행하지 않고 git/history에만 정확히 존재해야 한다.
2. Only after those migrations succeed, deploy and enable the reviewed commit on Vercel and Cloud Run, then confirm both deployed SHAs match it.
3. Confirm the worker can load `accessMode` plus the optional request-bound policy.
4. intake와 worker의 effective normal selected slot이 모두 `secondary`이고 현재 `secondary:1` secret reference로 해석되는지 확인한다. numeric secret version은 교체하지 않는다.
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

The replacement-canary source RPC can revalidate SQL lineage and the eight distinct terminal
job/run identities, but it cannot inspect external KVS rows. The zero-start application replay is
therefore the authority for the raw-set proof. Reservation atomically requires and stores only its
bounded aggregates: 8 source runs; 15 candidate, unique, public, and incomplete rows; zero
unavailable or primary-success candidate rows; three critical rows; and the ordered-set HMAC. Any
aggregate mismatch fails before either journal row is written. Never add per-account identifiers or
raw replay outcomes to the journal.

After that replay is reviewed, a human may separately approve one paid invocation by adding the
exact valueless `--confirm-paid-api-call` flag. The limits are fixed in code: two repetitions,
15 usernames per Actor run, `$0.05` maximum charge per run, and `$0.10` maximum total exposure.
Do not accept command-line overrides. Repetition two may start only after repetition one is
terminal, passes the quality gate, has stable reconciled actual cost at or below `$0.05`, and is
recorded that way in the journal. A later retry after reconciliation requires a fresh human approval
and must resume only the run ID already stored for that repetition.

The fixed `$0.05` maximum-charge identity is distinct from observed billing truth. Persist and
reconcile an observed actual amount up to the `$1.00` incident bound. An amount above `$0.05`
fails the quality gate and forbids repetition two, but it must not block three-storage cleanup,
source cleanup, or HMAC purge. An observed amount above `$1.00` is an incident and is rejected.

### Official profile-provider replacement canary

This command validates pinned `apify/instagram-scraper` build `0.0.692`; it does not rewrite the
historical profile-repair result. Its paid-readiness check accepts the Actor's exact single result
charge contract in either the retained flat `profile-result.eventPriceUsd` form or the live tiered
`result.eventTieredPricingUsd[plan.tier].tieredEventPriceUsd` form. The retained flat compatibility
form predates the primary/one-time metadata. Tiered pricing must have no additional charge event,
must mark `result` primary and non-one-time, and every declared known tier must keep the exact
15-result total at or below `$0.05`; unknown or malformed tiers fail closed.
Disable shell tracing and keep the source request identity in a protected environment variable so
it is not copied into shell history.

First run the read-only replay without the paid confirmation flag:

```bash
set +x
npm run canary:instagram-profile-provider -- \
  --source-request-id="${PROFILE_PROVIDER_CANARY_SOURCE_REQUEST_ID}"
```

Require 8 source runs, exactly 15 unique public incomplete candidates, three critical candidates,
Actor start delta zero, journal-write delta zero, and total actual cost zero. Replay mode never
resumes cleanup or writes a terminal checkpoint. If retained source storage has already entered
terminal cleanup, use scheduled recovery or an explicitly confirmed cleanup/resume command instead
of treating replay as cleanup authorization.

Before a paid invocation, verify the exact merged SHA on Cloud Run, set
`ANALYSIS_V2_RECOVERY_ENABLED=true`, and require the exact recovery Scheduler to be enabled and
structurally unchanged. The CLI runs both deployment scripts in `--check` mode before each new
reservation. Apify does not expose the account-level default run-access setting through its public
user API, so an operator must inspect the account setting in Console immediately before execution,
confirm `Restricted`, also confirm `Share run data with developers` is disabled, wait at least one
minute after any setting change, and provide the short-lived verification timestamp required by the
CLI. The command never changes either account setting. A terminal run's own `generalAccess` is then
read from Apify and stored as separate gate evidence; an operator attestation cannot override a
non-`RESTRICTED` run.

After the Console checks and propagation wait, set these operator attestations without shell
tracing. `VERIFIED_AT` must be an ISO timestamp between one and five minutes old when each new
reservation is checked:

```dotenv
PROFILE_PROVIDER_CANARY_ACCOUNT_DEFAULT_ACCESS=RESTRICTED
PROFILE_PROVIDER_CANARY_SHARE_RUN_DATA_WITH_DEVELOPERS=DISABLED
PROFILE_PROVIDER_CANARY_ACCOUNT_DEFAULT_ACCESS_VERIFIED_AT=<fresh-iso-timestamp>
```

Only after a fresh approval for the exact Actor/build, 15 public inputs, two conditional
repetitions, `$0.05` per-run cap, `$0.10` session cap, and terminal storage deletion may the same
command include the exact valueless flag:

```bash
set +x
npm run canary:instagram-profile-provider -- \
  --source-request-id="${PROFILE_PROVIDER_CANARY_SOURCE_REQUEST_ID}" \
  --confirm-paid-api-call
```

If repetition 1 completed in an earlier process, starting repetition 2 requires a new executing
session and fresh approval. If a start is ambiguous, follow
[`profile-provider-canary-ambiguous-start-resolution-runbook.md`](./profile-provider-canary-ambiguous-start-resolution-runbook.md);
never issue a replacement start. If terminal cleanup was interrupted, the confirmed paid command
may resume cleanup before source replay and starts zero Actors, or the recovery Scheduler may
reclaim the expired cleanup lease. Keep recovery enabled until the experiment is terminal, every
source/canary KVS, dataset, and request queue is verified absent, and the ordered-set HMAC is clear.

Stop without starting a replacement, rotating credentials, issuing another Actor start, manually
aborting, or resurrecting a terminal run if source ownership, target, V2 failure status, job count,
source input shape, Actor, slot, or exact 15-member union does not match; if a run start is ambiguous;
if a terminal result is not exactly 15/15 successes, has any unavailable result, any other
failure, or no critical recovery; or if actual cost is unsettled or exceeds either cap. Audit an
ambiguous start in Apify and the journal before any later approved invocation. A timed-out
reconciliation remains conservative and blocks repetition two even if the provider later reports a
terminal run.

### Early-access Gemini concurrency boundary

The launch worker uses one configured Cloud Run instance, container concurrency eight, and a V2
queue capped at eight concurrent dispatches and eight dispatches per second. This reduces the
observed fleet burst while retaining enough profile-AI parallelism for the five-minute canary.
Cloud Run maximum instances is not a hard distributed semaphore and can be exceeded briefly during
traffic spikes or revision rollout. Therefore this configuration is authorized only while
early-bird purchases do not create analysis tasks, automatic analysis dispatch remains disabled,
and the operator runs one signed E2E or one manually controlled analysis at a time. Live public
preflight/sale admission may remain enabled because a valid signed admission is request-scoped.

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
3. Restore the pre-run public admission/access-mode state exactly; do not use teardown to enable automatic analysis. Normal no-header requests must remain on the production access mode.
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
