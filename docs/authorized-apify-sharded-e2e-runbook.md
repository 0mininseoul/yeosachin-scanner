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

Set these non-secret variables on the entitlement intake runtime for the authorized run:

```dotenv
ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED=true
ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET=0_min._.00
ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID=974247fa-8d0e-4ab7-b6d2-ddf256ad6bdd
ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT=primary
ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT=secondary
ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT=tertiary
ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT=quaternary
ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT=tertiary
ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT=quinary
```

The worker must have Secret Manager references for every slot named by the policy. The normal selected slot and its single-slot behavior remain unchanged.

## Pre-run checks

1. Confirm the deployed Vercel and Cloud Run commit SHAs match the reviewed main commit.
2. Confirm the database migration is applied and the worker can load `accessMode` plus the optional request-bound policy.
3. Confirm all five Apify slots resolve to distinct intended test accounts without displaying token values.
4. In the browser session, confirm the Supabase user email is exactly `ym1113@kakao.com` and record its UUID.
5. Confirm the preflight target is exactly `0_min._.00`, the selected plan is eligible, and the girlfriend exclusion decision is explicit.

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

## Teardown

1. Set `ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED=false` on the intake runtime.
2. Remove non-selected temporary Apify secret references from the worker after no policy-bound request remains active.
3. Keep public admission disabled until the separate paid launch decision.
4. Do not enable the deferred KRW 1,900 reservation, discounted early-access, or full-price payment flow as part of this run.

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
