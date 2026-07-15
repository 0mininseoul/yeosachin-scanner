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
