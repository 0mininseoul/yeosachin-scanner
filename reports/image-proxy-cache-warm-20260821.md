# Option 2 image-proxy cache warming — 2026-08-21

Script: `scripts/warm-image-proxy-cache.ts` (uncommitted, worktree
`concierge-profile-pack-adoption-20260818`).
Run: `npx tsx --env-file=.env.local scripts/warm-image-proxy-cache.ts --concurrency=4 --pace-ms=200`

## Result

| outcome | count |
|---|---|
| unique images in scope | 3265 |
| **warmed in R2 (total)** | **1582** (1191 written this run + 391 already present from the two calibration runs) |
| skipped — signature expired (HTTP 403) | 1665 |
| skipped — origin unreachable (network_failure after 3 attempts) | 18 |
| unusable/rejected URL | 0 |

R2: bucket `ai-baram-detector-result-images-prod`, prefix `image-proxy-cache/v1/`.

## Scope

88 request ids = 53 results attached to a non-refunded order
(`completed` / `paid` / `analysis_in_progress`) ∪ 64 requests completed in the
last 30 days. URL sources are exactly the three the result and share routes feed
into `createImageProxyPath`: `analysis_requests.step_data.targetProfileImage`
(27 unique), `analysis_results.suspect_profile_image` (949),
`private_accounts.profile_image` (2338). 5124 rows scanned, deduped to 3265
distinct cache keys.

## Key parity (verified)

Cache keys come from `imageProxyCacheKey(canonicalizeImageProxyUrl(rawUrl))` and
objects are written with `writeImageProxyCacheObject` — the same functions the
proxy reads through. End-to-end check on 25 live rows: mint the generic
`/api/image-proxy?token=…` path with `createImageProxyPath`, verify it with
`verifyImageProxyToken` exactly as the route does, derive the key from that
`authorizedUrl`, read it back from R2 → **25/25 hit, 0 miss**.

Every warmed key is also read back through `readImageProxyCacheObject` before the
run counts it, so `cached` means "the proxy can serve this", not "the PUT
returned".

## Notes for a re-run

- Idempotent: an existing key is neither refetched nor rewritten
  (`alreadyCached`). Postgres access is read-only; the only writes are the cache
  objects.
- Two bugs were found and fixed during calibration, both worth knowing:
  1. **PostgREST truncation** — unbounded `.in()` selects silently capped at
     1000 rows, hiding half the private accounts. Every scan now pages
     explicitly (3265 unique images vs 1514 before the fix).
  2. **Per-call `S3Client`** — `image-proxy-cache` builds a fresh client when
     none is injected, which is right for a serverless request but leaked
     keep-alive sockets across a 3265-image batch and broke ~200 writes. The
     script now shares one client through the existing `dependencies.client`
     seam.
- IPv6 egress is broken on this operator network; ~80% of Instagram CDN hosts
  fail dual-stack. The script passes an IPv4-preferring `resolveHostname` to
  `downloadSecureImage`. Production dual-stack resolution is untouched — the
  override lives in the script, not the library.
- Meta rate-limits a single IP bursting profile images (the first run collapsed
  into 2055 `network_failure`s). `--pace-ms=200` jittered + `--concurrency=4`
  runs clean; full pass takes ~25 min.
- The 1665 expired URLs cannot be recovered from the CDN — those need a fresh
  Apify profile re-collection, not cache warming.
