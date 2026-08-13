# Preflight + B-lite single-collection design

Date: 2026-08-13
Status: approved architecture, implementation not started
Base: `origin/main` at `5c5a05574a0e477d2e8cdc90eb14cc64c6c1b4fe`  
Production baseline: `PRECHECKOUT_BLITE_ENABLED=false`; legacy ready-preflight account card and plans are visible

## 1. Outcome

Preflight and precheckout B-lite will share exactly one target-profile/feed collection. The preflight worker starts one bounded Apify profile actor, validates one returned `InstagramProfile` snapshot, derives eligibility and the ready account summary from that snapshot, and persists a bounded, short-lived source artifact from the same snapshot. B-lite inference runs asynchronously from that artifact and never starts another Instagram collection.

Preflight readiness is independent of Gemini. As soon as collection, validation, eligibility, and the durable source checkpoint succeed, preflight can become `ready` and B-lite inference can proceed under its own lease. While B-lite is pending, the client hides both the legacy target card and plans. It then follows one of two deterministic paths:

- normal success: account card + valid B-lite, then the user's CTA, then the approved unskippable 12-second four-stage full-screen demo, then plans; or
- eligible fallback: durable B-lite failure or the T+48 unresolved latch starts that same demo automatically, then atomically reveals the legacy account card + plans.

No terminal or slow B-lite path may strand the user without plans.

For an eligible normal success, the end-to-end service-level objective is p95 at or below 60 seconds from target submission to atomic account-card + B-lite reveal. For eligible fallback/unavailable paths, sixty seconds is a hard plans-hidden guard: if B-lite has not won before T+48, the deterministic fallback demo occupies the reserved T+48–T+60 window and legacy card + plans are visible by T+60. The successful B-lite path is intentionally user-driven after reveal; time waiting for its CTA, and the following demo, do not violate the submit-to-B-lite SLO or fallback plans guard. No fallback ever starts another Instagram collection.

## 2. Scope and non-goals

This design owns the contracts and rollout sequence only. It does not include implementation code, migrations, environment changes, deployment, or a direct Vercel release.

In scope:

- single-collection preflight/B-lite data flow;
- durable source-artifact schema and lifecycle;
- readiness and B-lite state machines;
- lease/idempotency rules;
- UI reveal/fail-open contract;
- deletion, retention, authorization, privacy, observability, rollout, tests, cost, and latency acceptance criteria;
- dependency boundary with open PR #368.

Out of scope:

- changes to paid analysis collection after checkout;
- changes to the B-lite DTO, prompt claims, marketing copy, plan catalog, pricing, or payment state;
- a new object-storage subsystem or storage of downloaded image bytes;
- changing production while this specification is under review.

## 3. Current-main findings

Current main has the following relevant behavior:

1. `processPreflight` collects a target profile, derives eligibility, builds `ReadyPreflightSnapshot`, and marks the preflight ready. Depending on channel and configuration, the collection path may use self-hosted summary, authenticated summary, or Apify fallback. Summary paths do not preserve recent feed evidence.
2. Anonymous preflight has `analysis_anonymous_profile_cache`, keyed by an opaque target-input hash. It stores a summary for 24 hours and uses a separate 60-second cross-instance lease. It deliberately omits `latestPosts`.
3. `/api/analysis/precheckout-blite` currently waits for ready, claims `precheckout_blite_cache`, then launches a separate Apify full-profile/feed request and Gemini inference in the browser request. It has a 75-second server budget, an 80-second client budget, and returns `204` on failure. Those separate budgets are superseded by the single 60-second submission-anchored deadline below.
4. `precheckout_blite_cache` is preflight-owned, service-role-only, cascade-deleted with the preflight, and deleted when `pii_scrubbed_at` changes. It stores only `pending|complete`, uses a two-minute generation lease, and has no durable terminal failure.
5. `PrecheckoutImmersive` currently gates plans while its request is unresolved, but the legacy account card exists outside that component. Therefore pending B-lite can show the card before B-lite, which violates the approved atomic reveal.
6. The current B-lite inference already bounds text to 10 recent posts and image input to 4 images (profile image plus at most 3 post images), validates a strict versioned DTO, and uses low-cost image preprocessing.
7. Account deletion and preflight retention already scrub or delete preflight-derived records. Any new source artifact must join those same database-enforced paths.
8. Main records the production rollback: `PRECHECKOUT_BLITE_ENABLED=false`, no B-lite/demo, legacy card and plans visible.

## 4. Alternatives and decision

Approach B was approved after alternatives were audited. This specification makes the remaining storage decision explicit.

### Rejected: extend `analysis_anonymous_profile_cache`

That cache is target-hash shared, summary-only, and valid for 24 hours. Adding captions, tags, mentions, and media references would widen both sensitivity and reuse across unrelated preflights. It is not naturally attached to an owner/preflight deletion cascade, and anonymous and authenticated flows do not share identical lifecycle requirements.

### Rejected: store source inside `analysis_preflights`

This would inflate a high-traffic lifecycle row, mix readiness state with transient inference evidence, make retention updates rewrite a large JSON value, and broaden the number of queries that can accidentally select source PII.

### Decision: new preflight-owned source table

Add a dedicated `precheckout_blite_sources` table with one row per preflight and an `ON DELETE CASCADE` foreign key to `analysis_preflights`. Keep the existing `precheckout_blite_cache` as the B-lite output/lease table, extending its state contract rather than mixing source and result payloads.

This separation gives the source a short TTL and narrow service-role API, keeps output replay independent, and makes deletion and operational audits explicit. It also avoids duplicating PR #368 telemetry.

## 5. Source artifact contract

### 5.1 Identity and lineage

Each source row is keyed by `preflight_id`. It records:

- `schema_version = 1`;
- `target_input_hash`, matching the preflight/provider-run lineage without storing an extra clear-text username column;
- `provider = 'apify'`;
- the exact provider-run identifier or provider-run ledger reference used by preflight;
- `collected_at`, `expires_at`, `created_at`, and `updated_at`;
- `payload` JSONB;
- `payload_bytes`, computed and checked from the serialized JSON representation;
- a SHA-256 `payload_hash` for integrity/idempotency diagnostics, never as an authorization token.

The writer must prove that the source, ready snapshot, and provider-run checkpoint belong to the same preflight claim and same target-input hash. A retry may replay the same provider run and upsert an identical payload hash. It must not replace a live artifact with a different snapshot under the same completed preflight generation.

### 5.2 Payload bounds

The payload is a strict, versioned projection of the validated `InstagramProfile`, not a raw Apify dataset item.

Hard limits:

- serialized JSON: at most 256 KiB;
- recent posts: at most 10, newest first;
- caption: at most 160 Unicode characters per post, whitespace collapsed;
- hashtags: at most 15 per post, each at most 100 characters;
- tagged usernames: at most 15 per post;
- mentioned usernames: at most 15 per post;
- media references: at most 4 total, ordered as profile image then up to 3 recent post images;
- each URL/reference: at most 8,192 characters and restricted to the already accepted Instagram/Apify media URL rules;
- full name: at most 60 characters;
- numeric counts: finite non-negative integers within the existing Instagram schema limits.

Persist only fields already allowlisted by the B-lite digest/image builder. Do not persist external URL, cookies, request headers, provider credentials, raw actor output, videos, image bytes, prompts, model output, email, user UUID, IP/device hashes, or claim/lease tokens inside the payload.

The account username is already present in `analysis_preflights` for the ready flow; the source projection does not duplicate it. Tags and mentions in captions remain source PII and receive the same short deletion lifecycle as the row.

### 5.3 TTL and cleanup

`expires_at = min(collected_at + 30 minutes, analysis_preflights.expires_at)`. Thirty minutes matches the current preflight/claim window and is long enough for queue delay and bounded inference retry without becoming a general-purpose cache.

Source reads require `expires_at > clock_timestamp()` and an unsanitized parent preflight. Expired rows are unusable even before physical deletion. The existing retention job gains a bounded source purge before/with terminal preflight scrubbing. Purge must be feature-flag independent so disabling B-lite never stops deletion.

Database enforcement must delete the source:

- by cascade when its preflight is deleted;
- immediately when parent `pii_scrubbed_at` transitions from null;
- during permanent account deletion through the existing preflight deletion/scrub path;
- on bounded retention cleanup after expiry;
- immediately after the lease owner has loaded and validated the payload into bounded process memory and B-lite reaches a durable terminal state. If the worker dies before that deletion, retention removes the row by expiry. No reader may require keeping the source for the full DTO cache lifetime.

No source TTL extension occurs on read, poll, cache hit, inference retry, login, or checkout.

### 5.4 Media handling

Store references only, never downloaded bytes. At inference time, reuse the existing image-preprocessing path to fetch and bound at most four images. A failed or expired media URL reduces image evidence; it does not trigger another Instagram/Apify collection. B-lite may continue with remaining image/text evidence if its existing inference contract permits it.

If zero usable posts remain, or the artifact fails strict schema/hash/size validation, inference terminates as `source_invalid`/`source_insufficient`; once the preflight is eligible ready, the UI latches `fallback_demo`. It must not recollect.

## 6. Single-collection preflight flow

For the B-lite canary cohort, the preflight target stage uses one explicitly selected Apify full profile/feed collection. The provider-run ledger remains the source of truth for reservation, idempotent replay, ambiguous start recovery, terminal status, slot, and cost settlement.

Ordered flow:

1. Claim the preflight under the existing idempotent worker lease.
2. Reserve or resume the one preflight provider run. Do not create a B-lite-specific provider run.
3. Collect and validate one profile/feed snapshot with the existing bounded recent-post policy.
4. From that exact in-memory snapshot, classify target-not-found, private account, schema/provider failure, and capacity conditions.
5. Derive follower/following eligibility and `ReadyPreflightSnapshot` from the same snapshot.
6. Project and checkpoint the bounded source artifact.
7. Atomically finalize the preflight as ready only if both the ready snapshot and source checkpoint are durable for B-lite-cohort requests.
8. After durable readiness, enqueue or invoke asynchronous B-lite inference. Gemini is not part of the readiness transaction and is never awaited by the preflight readiness response/poll.

### 6.1 One monotonic end-to-end deadline

The server establishes `submitted_at` when it durably accepts the preflight. For replay, refresh, login claim, or worker retry, the original stored timestamp remains authoritative. All workers and API responses derive one `deadline_at = submitted_at + 60 seconds` from database time; clients receive that absolute deadline and calculate remaining time using a monotonic elapsed-time baseline captured when the accepted response arrives. The browser must not trust a caller-supplied timestamp or reset the countdown after readiness, remount, poll retry, tab duplication, login, or B-lite dispatch.

The 60-second phase envelope is cumulative, not five independent timeouts:

| Cumulative window | Maximum | Work |
| --- | ---: | --- |
| T+0s to T+2s | 2s | validate/accept request, durable preflight creation, first worker dispatch |
| T+2s to T+40s | 38s | reserve/resume and settle the one Apify target profile/feed collection |
| T+40s to T+43s | 3s | validate snapshot, derive eligibility/ready data, atomically checkpoint source + ready state, dispatch inference |
| T+43s to T+48s | 5s | load source, prepare at most four media items, run the foreground Gemini attempt, validate/checkpoint DTO, and deliver a success eligible to win the current-page latch |
| T+48s to T+60s | 12s | reserved unskippable four-stage fallback demo for unresolved B-lite, ending in atomic legacy account-card + plans reveal |

These are deadline allocations, not permission to wait when a prior phase finishes early. Unused collection/checkpoint time flows forward to B-lite, but T+48 is an immutable current-page arbitration cutoff because the full 12-second demo must fit before T+60. The eligible-normal-success p95 target remains account-card + B-lite reveal by T+60, and all p50/p95/p99 latency reporting uses the original `submitted_at` origin.

The current 105-second preflight provider deadline and separate 75/80-second B-lite budgets do not apply to this cohort. Apify receives the cumulative T+40 deadline and checkpoint/dispatch receives T+43. Every nested provider call, poll, image fetch, retry/backoff, and Gemini call receives the earliest parent `AbortSignal`/absolute deadline. Before starting any retry or media fetch, the caller proves enough time remains; otherwise it records a bounded timeout and stops. The client arbitrates exactly once at T+48: a valid DTO already accepted by the client wins normal success; otherwise fallback wins. Inference already in progress may continue under its server T+56 execution cutoff so a late valid DTO can be persisted/cached for a later page visit, but it cannot affect the latched page. At T+56 the inference controller aborts outstanding media/Gemini work and forbids a new attempt.

The combined trusted worker route uses a 75-second `maxDuration` in Next/Vercel, giving 15 seconds after the fallback UX deadline for cancellation, durable terminal checkpoint, telemetry flush, and task acknowledgement. That margin is cleanup-only: it cannot keep fallback plans hidden, start/restart Apify, start Gemini, or extend `deadline_at`. The status-only browser route must have a small runtime ceiling (15 seconds or less) because it performs no provider work. Configuration/runtime contract tests must reject a worker duration below 75 seconds or any nested deadline exceeding its cumulative boundary.

For a public account with posts, a missing/incomplete feed is not silently accepted for the cohort because it would make the single collection unusable. It follows the bounded provider failure taxonomy. A private account and a not-found account remain explicit business outcomes and never run Gemini. A beta capacity denial remains `BETA_CAPACITY_UNAVAILABLE`; it must not be recast as not-found or generic inference failure.

The rollout selector must choose the single-collection path before provider work. A request must never begin the old summary path and later add the full-feed path. Selection is server-only and snapshotted on the preflight: the existing `PRECHECKOUT_BLITE_ENABLED` remains the master kill switch, and a new integer `PRECHECKOUT_BLITE_ROLLOUT_PERCENT` accepts only `0..100` (invalid or absent means `0`). Eligible production preflights enter the cohort by a stable hash of `preflight_id` into 100 buckets. The stored cohort bit, not a later environment read, controls source requirements, inference dispatch, and UI status for that preflight. Internal signed test-entitlement traffic may be explicitly forced into the cohort for canary; ordinary clients cannot select it. Outside the cohort, the existing legacy preflight remains unchanged.

## 7. Durable B-lite state machine

Extend the output store to represent terminal failure rather than making absence ambiguous. Logical states:

```text
absent
  -> pending(lease owner, attempt=1)
      -> complete(dto)
      -> failed(reason)
      -> pending(new owner, attempt+1) after an expired lease and within retry bounds
```

Allowed durable states are `pending | complete | failed`.

### 7.1 Claim and lease rules

- Claim is service-role-only and atomic under a row lock.
- One row exists per preflight; the unique key is the idempotency fence.
- A live `pending` lease returns `pending` without provider/model work.
- An expired lease may be stolen with a new token only if the source is live, the attempt count is below 2, and the inference deadline has not elapsed.
- Complete and failed are immutable terminal states. Replays return the same terminal disposition.
- Completion/failure updates require the current lease token and an unexpired lease.
- Stale owners cannot complete, fail, release, or overwrite a successor.
- Releasing a lease is reserved for a dispatch failure before Gemini starts. Once an inference attempt starts, it must finish as `complete`, `failed`, or be recovered only after lease expiry.
- Lease duration remains 2 minutes for crash fencing, but useful work is bounded by the shared T+56 server inference deadline and current-page success eligibility ends at T+48. The longer lease never grants extra execution time; after T+56 recovery may only terminalize/clean up, not retry inference.

### 7.2 Failure reasons

Persist only a bounded enum, never raw error text:

- `source_missing`
- `source_expired`
- `source_invalid`
- `source_insufficient`
- `dispatch_failed`
- `inference_timeout`
- `inference_rate_limited`
- `inference_provider_failed`
- `inference_response_invalid`
- `persistence_failed`
- `attempts_exhausted`

Preflight business reasons remain on the preflight state and are not converted into B-lite rows:

- `TARGET_PRIVATE`
- `TARGET_NOT_FOUND`
- `BETA_CAPACITY_UNAVAILABLE`
- the existing bounded provider/configuration failure classifications.

A retention or account-deletion race returns an unavailable/failed disposition without resurrecting source data. B-lite failure never changes preflight readiness, eligibility, checkout availability, plan selection, payment, or an existing `payment_pending` state.

## 8. API and asynchronous execution

The browser endpoint changes from “generate now” to “read status.” It authenticates owner or anonymous claim exactly as today, validates preflight identity/expiry, and returns a strict non-cacheable response:

- `200 { state: 'complete', dto }` for a valid durable DTO;
- `202 { state: 'pending', retryAfterMs }` with a bounded 500–2,000 ms hint;
- `204` for disabled, failed, expired, private/not-found/capacity, inaccessible, invalid, or otherwise unavailable paths.

The endpoint must not collect Instagram data, call Gemini, acquire a generation lease, expose a failure reason, or write logs containing source PII.

The preflight worker may dispatch inference only after committing readiness/source. Preferred execution is a dedicated authenticated Cloud Task or an equivalent existing trusted worker task kind. Dispatch is idempotent by preflight ID; task replay only claims the durable output lease. If dispatch fails, preflight stays ready and immediately enters the fallback demo once the terminal failure is visible. A bounded recovery scan may redispatch live source rows whose output is absent or whose lease expired only while enough time remains before T+56 and subject to the two-attempt limit. Recovery or fallback never recollects Instagram.

## 9. UI reveal contract

The analyze page owns a single reveal state for the whole ready section, not separate visibility in the legacy card and `PrecheckoutImmersive`.

States:

- `legacy`: flag disabled or request outside cohort; show the current legacy account card + plans without demo.
- `preflight_failed`: private, not-found, capacity, or another explicit preflight business failure; preserve that reason and show neither demo nor plans.
- `blite_pending`: eligible ready cohort, B-lite unresolved, and fallback not latched; hide account card and plans while polling against the original submission clock.
- `blite_ready`: a valid DTO wins before fallback begins; atomically reveal account card + B-lite. The user controls when to press the approved CTA.
- `success_demo`: after that CTA, run the approved four-stage full-screen demo for exactly 12 seconds with no skip, then reveal plans according to the approved normal flow.
- `fallback_demo`: the deterministic fallback latch won because a durable B-lite terminal failure arrived before T+48 or B-lite remained unresolved at T+48. Start the same four-stage full-screen demo immediately and run it exactly once for 12 seconds with no skip.
- `fallback_legacy`: fallback demo completed, or demo rendering/runtime failed; atomically reveal legacy account card + plans.

The page owns one irreversible `pathLatch: 'normal' | 'fallback'`. A valid B-lite DTO may compare-and-set `normal` only before fallback begins. A durable terminal B-lite failure at submission-relative time `F < 48s` compare-and-sets `fallback` immediately; the demo ends at `F + 12s` rather than waiting unnecessarily for T+60. If neither terminal outcome has won, the T+48 timer compare-and-sets `fallback`. Repeated polls, duplicate terminal messages, React remount/effect replay, and multiple tabs on the same page context cannot start a second demo or change the winning latch.

The fallback demo uses the same approved 12-second four-stage full-screen sequence as the normal path, with no skip control and exactly-once stage progression. When it ends, account card and plans appear together in one committed state update. Any render exception, timer/runtime failure, unavailable demo asset, or accessibility boundary failure during `fallback_demo` immediately enters `fallback_legacy`; once an eligible ready preflight exists, demo failure must never leave plans hidden.

A B-lite DTO completed after `fallback` latches or during `fallback_demo` is still validated and may be persisted/cached, but it cannot replace, interrupt, shorten, or restart the current page's fallback flow. Refresh/re-entry may use that DTO only when its durable `completed_at` proves completion within the source and server T+56 validity rules; otherwise it opens the appropriate legacy/failure view. Invalid DTO/schema versions count as durable/current-page B-lite failure and latch fallback when the preflight is eligible ready.

The T+60 plans-hidden hard guard applies to eligible fallback/unavailable paths. A T+48 unresolved latch reserves the whole T+48–T+60 demo window and reaches `fallback_legacy` by T+60. A terminal failure at arbitrary submission-relative time `F < 48s` starts immediately and reveals plans by `F + 12s`. Successful `blite_ready` intentionally remains user-driven through its CTA and subsequent demo; user inactivity on B-lite is not an SLA violation and does not trigger fallback. Private/not-found/capacity and other preflight business failures are not eligible fallback paths and retain their explicit no-demo, no-plans outcome.

No fallback state, demo event, timeout, refresh, retry, or late-result handler invokes an Instagram collection. Accessibility requires announced pending/demo stages and no hidden-but-focusable plan controls.

## 10. Authorization, privacy, and deletion

- Source and output tables have RLS enabled and forced.
- Revoke all table/function privileges from `PUBLIC`, `anon`, and `authenticated`.
- Grant only the minimal table/RPC permissions to `service_role`; browser clients never query these tables directly.
- Security-definer functions use an empty or fully qualified `search_path`, validate input, and expose only bounded dispositions.
- Anonymous reads continue to require the signed preflight claim; authenticated reads remain owner-scoped.
- No logs or telemetry may contain username, full name, bio, captions, hashtags, tagged/mentioned usernames, URLs, image bytes, prompt/model output, claim token, lease token, email, IP/device hash, or user UUID.
- Account deletion and retention tests must prove source and derived persona deletion. Output cache deletion on `pii_scrubbed_at` remains intact.

## 11. PR #368 dependency and observability

Open PR #368, “feat: add PII-safe B-lite operational observability,” is the dependency for B-lite terminal telemetry. It registers and emits:

- `precheckout_blite.completed`
- `precheckout_blite.profile_collection_failed`
- `precheckout_blite.inference_failed`

It also forwards bounded Gemini attempt telemetry, deduplicates terminal events per generation lease, retains generic Apify telemetry, and excludes source/model PII. This architecture must rebase on or merge after #368; it must not copy its event schemas, adapter, tests, or operations query.

Required adaptation after #368:

- move the Apify profile-collection event ownership to the preflight single-collection stage;
- keep completion/failure emission owned by the durable inference lease;
- add bounded dispositions for `source_*`, dispatch, fallback latch reason, demo outcome, and T+60 guard counts only if the existing allowlist cannot express them;
- preserve `preflight_id` as the sole durable correlation identifier;
- do not emit a false provider attempt for cache hits, polls, private/not-found/capacity outcomes, access denial, or another owner's pending lease.

If #368 changes before implementation, compare the final merged diff first. Implement only the gaps needed for this state machine.

## 12. Metrics and acceptance thresholds

Metrics are aggregate and PII-safe. Every percentile is split by environment and rollout cohort.

### Cost

- Apify target collections per admitted cohort preflight: exactly 1 logical provider run; duplicate physical starts are a release blocker.
- Compare `provider actual_usage_usd / cohort preflight` against current preflight plus B-lite combined baseline.
- B-lite Gemini attempts, prompt/completion/thinking tokens, media count, and estimated cost come from #368's bounded attempt telemetry.
- Track B-lite completion cost and eligible-fallback cost separately; failed inference must not cause an Instagram recollection.

### Latency

- preflight creation to durable ready p50/p95/p99;
- provider start to source checkpoint;
- ready to B-lite complete;
- target submission to atomic account-card + B-lite reveal p50/p95/p99 for eligible normal successes, with p95 <= 60 seconds as the SLO;
- eligible fallback ratio, split by durable terminal failure before T+48, unresolved-at-T+48 latch, and demo runtime error;
- terminal failure timestamp T and T-to-fallback-demo-start latency;
- T+48 latch-to-demo-start latency, exactly-once demo completion rate, and observed demo duration;
- target submission to atomic fallback legacy account-card + plans p50/p95/p99, including the T+60 guard rate;
- late B-lite completion count after fallback latch and refresh/re-entry reuse rate; current-page late-result swap count must remain zero;
- lease wait/steal and recovery delay.

Canary acceptance for at least 30 eligible public profiles or 24 hours, whichever is later:

- zero duplicate Apify starts for the same provider-run lineage;
- 100% of ready cohort rows have a live source checkpoint at readiness;
- zero preflight readiness paths awaiting Gemini;
- eligible normal success submit-to-account-card+B-lite p95 is at or below 60 seconds;
- 100% of durable B-lite terminal failures at arbitrary T<48 latch fallback and begin the demo without waiting for T+48/T+60;
- 100% of unresolved eligible ready requests latch fallback at T+48 and start one demo;
- every fallback demo runs the same four stages exactly once for 12 seconds with no skip, unless a demo error immediately reveals legacy card + plans;
- zero eligible fallback/unavailable requests keep plans hidden after T+60 (no scheduling/render tolerance beyond the hard guard);
- zero late B-lite results replace or interrupt a latched fallback page;
- private/not-found/capacity and other preflight business failures show their explicit reason with no demo or plans;
- zero PII fields in sampled Axiom/Sentry/application logs;
- no source row remains beyond `expires_at + 10 minutes` under a healthy retention schedule;
- B-lite completion rate and cost/latency are reported, not silently assumed. Expansion requires explicit operator review of those values rather than a hard-coded success-rate threshold.

## 13. Test strategy

### Unit and contract tests

- strict source projection accepts only allowlisted fields and enforces every count/text/URL/byte bound;
- readiness and source projection derive from the same object/snapshot hash;
- source expiry is capped by parent preflight expiry and never extended;
- private, not-found, capacity, incomplete feed, provider timeout, and schema failure keep distinct reasons;
- B-lite digest and image preparation consume the durable projection without needing raw Apify output;
- status API never invokes scraper or Gemini;
- the UI reducer/latch permits exactly one irreversible `normal|fallback` winner and rejects late/duplicate transitions;
- PR #368 terminal dedupe and PII allowlist remain green after ownership moves.

### Database/PGlite tests

- RLS/privilege denial for anon/authenticated and service-role-only RPC access;
- source insert is fenced to the current preflight claim/provider lineage;
- identical replay succeeds; different payload hash cannot overwrite a completed source;
- concurrent claims yield one inference owner;
- expired lease steal, stale completion rejection, two-attempt exhaustion, and immutable terminal states;
- cascade, `pii_scrubbed_at`, retention, and permanent-account-deletion remove source and output;
- cleanup is independent of feature flags;
- `complete` requires a schema-valid bounded DTO; `failed` requires an allowlisted reason.

### Route/worker integration tests

- one mocked Apify result produces eligibility, ready snapshot, and source; no second scraper call occurs;
- ready is observable before a deliberately blocked Gemini promise settles;
- all phases receive the same stored submission timestamp and cumulative deadline; readiness, retries, refresh, and remount never reset it;
- a T+40 provider abort, T+43 checkpoint/dispatch cutoff, T+48 page latch, and T+56 inference abort propagate to their owners and never cause recollection;
- dispatch failure leaves ready intact, durably terminalizes B-lite, and starts fallback demo as soon as the client observes it;
- retries resume the same provider run and inference lease semantics;
- polls and duplicate browser tabs cause no provider/model work;
- deletion/retention racing inference cannot resurrect or complete deleted data.

### UI tests

- a valid DTO before fallback wins `blite_ready`, then user CTA runs exactly one unskippable 12-second four-stage `success_demo`, then plans;
- a durable terminal failure observed at arbitrary submission-relative `F < 48s` starts exactly one `fallback_demo` immediately and reveals legacy card + plans at `F + 12s`;
- unresolved B-lite at T+48 irreversibly latches `fallback_demo`, runs the exact 12-second four-stage sequence with no skip, and reveals legacy card + plans by T+60;
- a late DTO after fallback latch or during demo is cached when valid but never swaps, interrupts, shortens, or restarts the current page flow;
- refresh/re-entry accepts a late DTO only when durable completion is within source/T+56 validity;
- private, not-found, capacity, and other preflight business failures show no demo and no plans;
- any fallback demo render/runtime/asset error immediately atomically reveals legacy card + plans;
- eligible fallback/unavailable plans are never hidden at T+60.000 or later;
- user inactivity in `blite_ready` does not trigger fallback and is excluded from the plans-hidden guard;
- flag disabled exactly preserves current production legacy rendering;
- focus, screen-reader status, refresh, and multi-tab behavior do not strand plan selection.

### End-to-end/canary checks

- synthetic fixtures first, then explicitly authorized production canary profiles;
- provider ledger proves one logical/physical start;
- database checks prove source/output lifecycle;
- Axiom query from #368 proves bounded collection/inference outcomes and no forbidden fields;
- current checkout/payment regression suite remains green; no test mutates `payment_pending` without independent evidence;
- canary dashboards report submit-origin p50/p95/p99, fallback ratios/reasons, demo duration/exactly-once outcomes, T+60 guard rate, and late-result non-swap; provider ledger inspection proves no fallback path recollects.

## 14. Rollout, deployment, and rollback

Production remains `PRECHECKOUT_BLITE_ENABLED=false` until implementation, migration, tests, #368 integration, and user review are complete.

Deployment order when database changes exist:

1. Merge/reconcile #368 first or rebase implementation on its final merged form.
2. Prepare additive forward migration(s) with contract and PGlite coverage.
3. In an isolated Supabase workdir, verify the exact migration allowlist and run dry-run. Never use `db push --include-all` in a mixed worktree.
4. Apply only approved migration(s), then verify remote migration history, tables, functions, RLS, grants, and retention behavior. If CLI output hangs after apply, verify remote state before terminating; do not repeat the push blindly.
5. Merge the GitHub implementation PR to `main`. Vercel deploys only through the normal GitHub/main integration. Do not run a direct Vercel production deploy.
6. Keep `PRECHECKOUT_BLITE_ENABLED=false` and rollout percent `0` while the backward-compatible app revision reaches production.
7. Enable only signed internal test-entitlement canaries first, then expand the stable production cohort through `1%`, `5%`, `25%`, and `100%`. Each stage must satisfy the canary window and acceptance checks before the next GitHub/main configuration change.

Rollback is flag-first: set B-lite cohort/enabled state false through the normal GitHub/main production configuration path, restoring the legacy card + plans. Additive source/output schema remains safe and retention continues. Do not roll back by changing orders or `payment_pending`, deleting provider ledgers, disabling retention, or deploying directly to Vercel.

## 15. Implementation boundaries

Expected implementation areas, without prescribing file-level code:

- preflight provider selection and full snapshot projection;
- source store/RPC and additive lifecycle migration;
- output-store terminal states and inference task/recovery;
- status-only precheckout API;
- analyze-page shared reveal state;
- #368 adapter relocation rather than duplication;
- lifecycle, concurrency, observability, and UI tests;
- operating documentation for migration-first rollout and canary queries.

Marketing copy in `app/page.tsx` is out of scope and must remain unchanged.

## 16. Approval gate

No additional product/architecture decision is required to implement this specification. The remaining gate is user review of the exact bounds and operational thresholds in this document. Any proposal to store media bytes, reuse the 24-hour anonymous target cache, wait for Gemini before ready, expose source data to browser roles, remove legacy fail-open, or deploy directly to Vercel is a scope change requiring new approval.
