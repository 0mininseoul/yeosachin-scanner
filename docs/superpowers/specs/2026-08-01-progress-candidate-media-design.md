# Progress Candidate Media Design

**Date:** 2026-08-01  
**Status:** Design approved; implementation and production rollout pending

## Goal

While analysis V2 screens a candidate, the progress page shows one bounded media bundle for that candidate: the profile image followed by one to three already-collected feed thumbnails. The feature must not add provider calls, image processing, worker network round trips, or analysis latency.

## Scope

This design applies only to candidate profiles processed by the `profile_ai` stage. It does not show a fixed gallery for the analysis target, retain server-side candidate history, change analysis scoring, alter provider adoption, or modify landing-page copy.

## Minimality Decision

The implementation extends the existing active-profile heartbeat path. It does not add a new table, R2 image capture, thumbnail normalization, provider fetch, feature flag, or observability pipeline.

The existing heartbeat already owns the exact lifecycle needed here: it is written under the live profile job lease, projected only to the request owner, and purged at terminal state. A separate projection table would duplicate those fences. R2 capture would add image downloads and cleanup for media that only needs to exist during progress.

## Data Source and Selection

The `profile_ai` executor already holds each successful profile checkpoint, including `profilePicUrl` and up to eight canonical recent posts. Before beginning AI work for an item, it derives a preview synchronously from that object:

- profile image: the existing `profilePicUrl`, when valid;
- feed thumbnails: at most three deterministic, distinct display images from recent posts;
- video and reel items use a verified thumbnail/display image, never a raw video URL;
- missing or invalid images are omitted rather than replaced with a fabricated URL.

Selection reuses the existing media-policy rules or a small pure helper extracted from them. It performs no I/O and preserves the canonical newest-first order.

The earlier `profile_fetch` start callback remains username-only because media does not exist at that point. Rich media begins in `profile_ai`, where the checkpoint is already available. This avoids adding post-fetch callbacks or replay-sensitive provider behavior.

## Runtime Data Flow

1. `profile_ai` receives the already-persisted candidate profile.
2. It derives `{ profileImageUrl, feedImageUrls }` synchronously.
3. The existing `reportActiveProfile` callback receives the username and optional media preview.
4. The progress reporter masks the username and converts accepted HTTPS Instagram image URLs to opaque `/api/image-proxy?...` paths.
5. The existing active-profile heartbeat RPC writes the profile proxy path and up to three feed proxy paths in its existing call.
6. `load_analysis_v2_progress` overlays the latest live, lease-fenced heartbeat into the owner-only progress response.
7. The browser accumulates at most twenty candidate bundles and renders each as profile image followed by its feed thumbnails.

No raw username, raw image URL, caption, post identifier, cookie, token, or provider response enters the progress DTO.

## Contract and Database Change

`activeProfile` remains nullable and keeps its existing fields. It gains one optional field:

```ts
{
  maskedUsername: string;
  imageUrl: string | null;
  feedImageUrls?: string[]; // zero to three proxy paths
}
```

The optional shape allows the updated application to read both old and new database responses. The schema remains strict: the array is capped at three, each value is bounded, unique, and begins with `/api/image-proxy?`.

The existing `analysis_v2_active_profile_heartbeats` table gains one bounded `TEXT[]` column with an empty-array default. The existing heartbeat function is replaced transactionally with the same name plus a defaulted feed-image parameter. Old workers can continue calling it without the new argument; new workers use the same RPC with one additional argument. No overload is retained, avoiding PostgREST function ambiguity.

The owner load function includes `feedImageUrls` only for a live heartbeat. Terminal cleanup continues deleting the heartbeat row, so no new retention policy is needed.

## Rendering

The current drifting progress rail remains. Its history item changes from one face to one candidate media bundle:

```text
[profile] [feed 1] [feed 2] [feed 3]
```

Bundles remain bounded to twenty candidates in browser memory. Adjacent repeated heartbeats for the same masked candidate do not append duplicates. The current candidate keeps the existing active treatment. Missing feed media renders only the profile; missing profile media uses the existing fallback and still permits valid feed thumbnails. Images use browser-side lazy loading through the existing proxy route.

No new marketing copy or candidate-identifying text is introduced.

## Performance and Failure Rules

- Provider call count is unchanged.
- Heartbeat call count and DB round-trip count are unchanged.
- The worker does not download, decode, resize, or store image bytes.
- Selection examines at most eight checkpoint posts and three emitted URLs.
- Browser image requests are asynchronous and do not block worker execution.
- Media selection, URL validation, or proxy signing failure degrades to an empty preview and must not fail or retry the analysis.
- Existing username heartbeat persistence and lease-fence failures retain their current behavior; media does not weaken those invariants.

No runtime feature flag is added. If production behavior regresses, rollback uses the previous Cloud Run revision while the additive database field remains inert.

## Rollout

Production changes remain blocked until explicit approval.

When approved, rollout order is:

1. deploy the Vercel application that accepts the optional field;
2. apply the single allowlisted migration after dry-run and migration-history verification;
3. deploy the canonical Cloud Run worker that writes candidate media;
4. verify one real analysis without causing a duplicate provider run;
5. compare stage timing and provider/heartbeat counts with the pre-change baseline.

This order prevents the worker from emitting a field before the web client accepts it. The migration remains compatible with the old worker because the new RPC parameter has a default.

## Tests

- selection unit tests: newest-first order, maximum three, deduplication, video/reel thumbnail choice, invalid URLs, and empty media;
- executor/reporter tests: the loaded checkpoint is reused, username masking remains intact, proxy paths are emitted, and selection failure is non-fatal;
- worker tests: provider call count and heartbeat call count do not increase;
- store/contract tests: strict optional field, maximum length, uniqueness, proxy-only paths, and old response compatibility;
- migration contract and PGlite tests: defaulted RPC compatibility, exact live-lease fence, owner isolation, idempotent heartbeat update, and terminal purge;
- route/client/component tests: validated response, bounded bundle history, adjacent deduplication, lazy rendering, and image fallback;
- full lint, TypeScript, focused Vitest suites, and existing CI.

## Acceptance Criteria

- During `profile_ai`, each visible candidate bundle contains its profile image and zero to three available feed thumbnails in order.
- No provider operation, provider spend, worker image fetch, or heartbeat call is added.
- Raw media URLs and unmasked usernames never reach the progress response.
- Missing or failed media never delays, retries, or fails analysis.
- Terminal progress exposes no active candidate media.
- The implementation is reviewed independently and passes CI before any production migration or deployment is requested.
