# Instagram provider operations

This module collects public Instagram data through direct public profile reads or documented, API-key-authenticated vendor APIs. It does not use Instagram login cookies, account pools, proxy rotation, stealth, or access-control evasion.

## Production routing

| Capability | Default | Allowed operators | Automatic fallback |
|---|---|---|---|
| `profile` | `selfhosted` | `selfhosted`, `apify` | `selfhosted -> apify` |
| `profilesBatch` | `selfhosted` | `selfhosted`, `apify` | `selfhosted -> apify` |
| `followers` | `apify` | `apify`, `flashapi`, `coderx` | none |
| `following` | `apify` | `apify`, `flashapi`, `coderx`, `rapidapi` | none |

Only `profile` and `profilesBatch` make one automatic fallback attempt. Relationship operations have no automatic fallback: a failed or incomplete Apify result rejects the operation instead of silently switching vendors. FlashAPI, CoderX, and the deprecated Stable RapidAPI adapter are explicit operator choices only. `selfhosted` supports direct public profile and profile-batch reads; it has no relationship-list implementation.

Unset `SCRAPER_*` values use the production defaults above. Explicit invalid provider or fallback values fail closed before a paid call. `SCRAPER_FALLBACK=false` disables the profile fallback; it does not add or change a relationship fallback.

## Vendor contracts

### Direct public-profile primary

`selfhosted` makes direct, unauthenticated public-profile reads only. In production, a Supabase reservation RPC coordinates the default full-profile and admission fetchers across every Vercel and Cloud Run instance. The default 750ms interval plus 100ms response guard creates an 850ms reservation slot, so 237 starts span 200.6 seconds from first to last, or about 201 seconds of scheduling before response tail latency. `SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED` defaults to true only when `NODE_ENV=production`, and an explicit true or false overrides that default; `SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS` defaults to 750 and accepts only 250-60000. Admission calls may wait up to 500ms and full-profile calls up to 60 seconds; the RPC rejects a longer wait before mutating the singleton. RPC latency plus positive sleep overshoot must remain within the 100ms guard, and the RPC hard-times out after 750ms or sooner when the caller invocation deadline requires it. A reservation, deadline, guard, or payload-validation failure is sanitized, classified as retryable transport failure, and prevents the Instagram request so the existing fallback policy can decide. The database RPC never sleeps and stores no request, user, or profile identifier.

The process-local concurrency-four scheduler, 300ms start interval, and circuit breakers remain defense in depth. They open on rate-limit/auth failures, repeated successful-response schema failures, or a small burst of retryable transport/5xx/timeout failures. Explicitly disabling the global gate makes no RPC and retains this prior local behavior. Rate coordination reduces aggregate bursts but cannot guarantee that Instagram will accept a logged-out request. Only HTTP 404 or an explicit `data.user: null` returns `null`; every other HTTP 200 envelope and required profile field is validated before the circuit records success.

The pre-payment target preflight and checkout-time fresh admission are selfhosted-first. Only a classified selfhosted provider failure may enter an Apify profile-summary fallback, with `maxTotalChargeUsd=$0.0026`; an explicit selfhosted not-found result does not fallback. The initial preflight and each fresh-admission generation reserve distinct PII-free operation rows in `analysis_preflight_provider_runs`. A retry in the same generation resumes its stored run ID, while a fresh generation never reuses the initial preflight snapshot. During migration-first rollout, a generation RPC atomically adopts only a legacy-worker row reserved at or after that generation's `admission_requested_at`; older initial rows are never adopted. If the generation row already exists, a legacy worker's attempt to insert the old operation fails before Actor start. Authenticated usage is reconciled no earlier than 30 seconds after each run settles. The initial fallback and one fresh-generation fallback therefore have independent `$0.0026` ceilings and can cost at most `$0.0052` together. Additional fresh generations, when allowed by the admission state machine, each have their own bounded row and ceiling. An expired or abandoned preflight retains every operation row until all usage is reconciled. Neither path supplies an Instagram login cookie or session.

### FlashAPI manual diagnostic provider

Host: `flashapi1.p.rapidapi.com`

- Resolve a username: `GET /ig/user_id/?user=<username>`
- Followers: `GET /ig/followers/?id_user=<decimal-id>`
- Following: `GET /ig/following/?id_user=<decimal-id>`
- Continue a list with the returned `next_max_id` query parameter.

The client shares one request-start rate gate, caches numeric IDs, reuses an in-flight lookup, applies bounded timeout/retry behavior, and deduplicates usernames case-insensitively. Each provider operation also has configured network-request and estimated-cost ceilings; retries and the username lookup consume the same budget. The Standard 1,000-result path permits 200 pages, 210 total requests, and $0.21 estimated spend per relationship operation. Repeated no-progress pages and cursor cycles fail independently. The client shares observed RapidAPI remaining quota across concurrent operations and stops queued work before the configured reserve. Quota state expires from `x-ratelimit-requests-reset`, with `FLASHAPI_QUOTA_STATE_TTL_MS` as a bounded fallback when that header is absent; late responses from an expired quota window cannot lower the new window. Because the marketplace does not publish a response schema, parsing is fail-closed: only explicitly whitelisted ID and `users` envelopes are accepted.

The 60% minimum unique ratio is only an internal pagination-health bound; it does not relax the shared 99% relationship completeness gate. In the full live canary, FlashAPI exhausted its returned cursors after 115 requests and 139.232 seconds with 320/474 followers and 425/642 following. It returned 745 unique rows out of 1,116 declared relationships, or 66.76% coverage, despite quota and page/request budgets remaining. FlashAPI is therefore excluded from production defaults and automatic fallback. Do not treat a non-empty or cursor-complete FlashAPI response as a complete relationship list.

### Apify relationship primary and profile fallback

Relationship actor: `scraping_solutions/instagram-scraper-followers-following-no-cookies`

The exact actor input is:

```json
{
  "Account": ["public_username"],
  "resultsLimit": 100,
  "dataToScrape": "Followers"
}
```

`dataToScrape` is `Followers` or `Followings`; the Actor currently requires at least 25 requested results, so smaller caller limits are fetched at 25 and sliced locally. Relationship runs pin the exact Actor build through `APIFY_RELATIONSHIP_BUILD` (default `0.0.71`); only exact `x.y.z` versions are accepted. CoderX remains unpinned. Actor executions share a concurrency semaphore that defaults to two. The Actor lifetime defaults to 900 seconds because Apify counts `READY` scheduler allocation time against it, while each worker invocation waits at most 240 seconds before the durable checkpoint resumes the same run. Transient Dataset transport or pagination-metadata inconsistencies receive five exponential-backoff rereads (15.5 seconds total by default) without rerunning the paid actor. Apify's preliminary terminal cost does not delay Dataset processing; a delayed authenticated run read finalizes billing separately. Each parallel followers/following result is atomically checkpointed as soon as it finishes, so a hard timeout reuses the completed sibling instead of starting that paid Actor again. A Dataset that remains consistently empty after those bounded rereads is preserved as a legitimate empty result. Rows remain strictly validated against the declared Dataset total and documented schema, and usernames are deduplicated. `apify/instagram-profile-scraper` is the single profile fallback.

The live follower canary returned 473/474 unique rows (99.79%) in 39.909 seconds at $0.40205 observed usage. An independent Free-account canary returned 641/642 following rows (99.84%) in 44.460 seconds at $0.54485 observed usage. Both relationship capabilities passed the shared 99% gate; combined observed coverage was 1,114/1,116 (99.82%). Production never pools accounts or splits a request to bypass plan quotas. Standard analyses require one paid Apify account with enough capacity. `APIFY_API_TOKEN_SLOT` permits explicit whole-deployment credential rotation or a manual canary only; it is not automatic failover.

A rapid repeat canary on the same target later returned only 28 stable rows for each relationship operation and was rejected by the 99% gate. The final charge was limited to those rows, but the run was not useful. Production intentionally does not start a second paid relationship Actor automatically; alert on incomplete coverage and require an operator-controlled retry after the provider incident or cooldown is understood.

Relationship Dataset order is preserved through deduplication, mutual extraction, and `analysis_requests.step_data.mutualFollows`. The product treats the first ten mutuals in that order as the most recent mutuals based on two controlled account observations and labels up to five public female results accordingly. The Actor contract exposes no follow timestamp or chronological-order field, so operators must treat this as a product assumption when changing Actor builds or providers.

### Effective profile-data scope

The self-hosted path is an unauthenticated `web_profile_info` request, not browser scrolling. The local concurrency-four, 300ms scheduler alone would place 350 cold starts at about 105 seconds, but it is not the production-wide limit. With the default 850ms effective aggregate reservation slot, 237 starts schedule in about 201 seconds and every instance participates in the same sequence. Its process-local circuit still fails fast on rate limits or schema drift. The target's newest six posts by timestamp are retained for interaction collection; up to 350 public mutual profiles retain IDs, shortcodes, timestamps, counts, captions, tags, and up to ten images. Gemini receives one profile image plus ten feed images in quality mode. Failed or missing public-profile reads are supplemented once with `apify/instagram-profile-scraper`, so the profile stage is not guaranteed to be free. Each V2 durable candidate batch distinguishes explicitly verified `unavailable` rows from settled `failed/incomplete` rows and permits the latter only up to `requested - ceil(0.9 * requested)` per batch; duplicate usernames, unexpected usernames, and other failure categories remain fatal errors. Target profile evidence and ordinary non-durable calls retain strict completeness checks.

### Post interactions

- Target comments: official `apify/instagram-comment-scraper`, at most 6 URLs and 15 top-level comments per URL; replies are forced off.
- Post likers: community `datadoping/instagram-likes-scraper`, 150 per target post across the newest four posts and 100 for one newest candidate post. The paid follow-up is capped at the ten observed women with the highest intermediate score.
- Neither Actor receives an Instagram login, cookie, or session ID.
- Only liker/comment rows matching an already-classified public female mutual are persisted. Unrelated usernames are discarded in memory.
- A positive match is evidence; absence from a truncated result is unknown. Coverage and raw counts remain server-internal and influence ranking without being exposed on result pages.
- Per-request admin selection accepts `likers` and `comments` as `apify` or `disabled`; there is no automatic paid fallback.
- Every interaction batch stores a `running` reservation before the paid Actor starts. A process interruption is finalized as failed on resume instead of rerunning the same charge; the result exposes the resulting low coverage.

### Manual providers

- CoderX actor: `coderx/instagram-followers-following-scraper-no-cookies-login`. Input is `username`, `scrape_type`, and `max_items`. It is manual-only.
- Stable RapidAPI: the manual-only `following` compatibility adapter requires `STABLE_RAPIDAPI_HOST`, `STABLE_RAPIDAPI_KEY` (or `RAPIDAPI_KEY`), and a positive `STABLE_RAPIDAPI_ESTIMATED_COST_PER_REQUEST_USD`. It rejects the FlashAPI host.

## Completeness and telemetry

Relationship calls receive an expected result count computed from the target profile's declared count and the requested plan limit. A malformed declared count fails closed. Every provider must return at least 99% of the expected result count; a short relationship result rejects the operation without automatic fallback. Provider-specific minimum unique ratios are earlier pagination-health checks only: FlashAPI defaults to 60% based on observed overlapping pages, while Apify and CoderX default to 95%. None of them overrides the shared 99% completeness gate. Apify defaults to 1,200 results per operation for the Plus plan; CoderX remains capped at 1,000. Both reject requests before actor startup when their configured estimated-cost ceiling would be exceeded. Apify also forwards the computed operation estimate as the platform `maxTotalChargeUsd` cap. Only explicit server-side environment overrides can raise these bounds.

Telemetry records provider, capability, request/result counts, raw and unique counts, declared-count expectation, minimum complete count, coverage ratio, sanitized failure category, fallback status, latency, outcome, configured cost estimate, and available RapidAPI rate-limit values. These telemetry cost fields are estimates, not billing truth. Billing truth is the authenticated `usageTotalUsd` read at least thirty seconds after terminal state and finalized once in `analysis_provider_cost_ledger`; `chargedEventCounts × eventPrice` is an audit cross-check, not an amount to add.

Console telemetry is always emitted. Database persistence is best-effort and disabled by default. Apply [`008_add_scraper_provider_usage.sql`](../../../supabase/migrations/008_add_scraper_provider_usage.sql), then set `SCRAPER_TELEMETRY_PERSIST=true`.

Before production analysis, apply every migration from [`007_add_gemini_cost_latency.sql`](../../../supabase/migrations/007_add_gemini_cost_latency.sql) onward in migration order. The follow-ups add relationship telemetry and checkpoints, request mutation controls, the username contract, interaction staging, background task state, deep-risk narratives, private-account name sorting, atomic completion compaction, and one-active-request enforcement. Step calls acquire a 330-second atomic lease, slightly longer than the 300-second serverless hard timeout and short enough for the configured Cloud Tasks retry schedule to recover a crashed invocation. Lease acquisition fails closed when the migration/RPC is unavailable. `/api/analysis/start` callers must send a 16-128 character safe `Idempotency-Key`; replaying the same key and payload for that user returns the existing request without incrementing quota, while reusing it with a different target, gender, or provider selection returns HTTP 409. A user can have only one pending or processing request at a time.

Production background execution uses a Seoul Cloud Tasks queue with deterministic task names and an exact OIDC service-account identity. The shared Google credential bootstrap materializes `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` before either Gemini or Cloud Tasks initializes ADC. The request row switches to `background_processing=true` only after the initial task is accepted; otherwise the authenticated progress page remains the fallback step driver. Each successful background step enqueues the next persisted state, so closing or suspending the browser does not stop the analysis. Run [`scripts/configure-analysis-tasks-queue.sh`](../../../scripts/configure-analysis-tasks-queue.sh) with the three `ANALYSIS_TASKS_*` queue variables exported to reproduce the production rate and retry policy. Its 40-second minimum retry backoff exceeds the 30-second lease margin after the 300-second function limit.

Authenticated clients can select only the owner-scoped progress/history columns on `analysis_requests`. Pipeline `step_data`, raw interaction tables, component scores, and unsanitized narratives are service-role only. Atomic completion keeps only ordered mutual usernames and the target profile image in `step_data`, then removes raw interaction staging in the same transaction. The progress UI polls the granted status columns instead of subscribing to full-row Postgres Changes.

Leases currently have no heartbeat or token-fenced downstream writes. Alert before any step approaches the 300-second runtime limit. A continuation enqueue failure clears `background_processing` so the authenticated progress page can resume; successful Cloud Tasks retries can reclaim background ownership after acquiring the lease. `/api/analysis/run` is disabled by default and additionally requires the admin bearer key when the migration-only `ENABLE_LEGACY_ANALYSIS_RUN=true` escape hatch is set. Keep it disabled for production and local user flows.

## Per-request selection

Public scraper functions accept an optional trailing `ScrapeRequestOptions`. Analysis requests persist the serializable selection in `analysis_requests.step_data.scraperOptions`.

Only `POST /api/analysis/start` accepts an override, and only with an exact `Authorization: Bearer <ADMIN_API_KEY>` header. End-user authentication alone is insufficient.

```json
{
  "targetInstagramId": "public_username",
  "targetGender": "female",
  "scraperOptions": {
    "followers": "coderx",
    "following": "coderx",
    "fallback": false
  }
}
```

Unknown keys, unsupported capability/provider pairs, and non-boolean fallback values are rejected before any paid call.

## Read-only paid canary

The canary loads `.env.local`, prints aggregate JSON only, and never prints usernames or result rows. It performs paid read calls, so confirmation is mandatory. Do not put these commands in CI.

```bash
# Manual FlashAPI diagnostic, maximum 100 results per selected list.
npm run canary:instagram -- --provider flashapi --username public_username --relationship followers --followers-count 474 --limit 10 --confirm-paid-api-call

# Explicit higher-cost confirmation, maximum 1,200. Full canaries require declared counts.
npm run canary:instagram -- --provider apify --username public_username --relationship both --followers-count 474 --following-count 642 --limit 1200 --confirm-full-paid-api-call
```

`--relationship` accepts `followers`, `following`, or `both` and defaults to `both`. Only the selected relationship calls are started. A full canary requires `--followers-count` and/or `--following-count` for every selected list and enforces the production 99% gate. FlashAPI canaries use the same provider entry point as production, so username lookup, retries, pagination, and cost ceilings share the operation budget. Output includes per-step and total wall latency, expected/minimum/actual result counts, coverage, request/raw/unique/cost aggregates, follower/following/mutual counts, and available RapidAPI rate-limit headers. Errors are category-sanitized. The repository test suite never makes paid calls.

## Key configuration

See [`.env.example`](../../../.env.example) for bounded timeout, retry, page, ratio, and cost settings. Paid RapidAPI request retries default to zero because a transport failure can still consume quota; raising `FLASHAPI_RETRIES` explicitly accepts that extra spend. `APIFY_API_TOKEN` is required for the production relationship path and profile fallback. `FLASHAPI_RAPIDAPI_KEY` is optional and only needed for an explicitly selected manual diagnostic. Keep all credentials server-side.

The current scope boundary is recorded in [`docs/instagram-provider-scope-ledger.md`](../../../docs/instagram-provider-scope-ledger.md).
