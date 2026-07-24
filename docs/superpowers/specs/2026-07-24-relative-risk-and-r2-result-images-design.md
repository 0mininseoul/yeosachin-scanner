# Relative Risk and 30-Day Result Images Design

**Status:** Approved in conversation on 2026-07-24
**Scope:** Analysis V2 backend, result persistence, image delivery, and the retained
completion sample. Result-page layout remains owned by the separate frontend session.

## Problem

The retained completion sample exposes four backend defects:

1. every finalized female result is classified as normal, so the ranked product does not
   surface a relative high-risk candidate or caution candidates;
2. an official group account ranks too highly because the current feature model treats
   promotional and organizational context too much like personal relationship context;
3. account overviews are generic, repeated descriptions instead of account-specific
   examiner commentary grounded in the visible profile and feed; and
4. finalized rows retain expiring Instagram CDN URLs. A non-null URL therefore does not
   mean that an archived result can still render the image.

The audited sample also has fewer durable private-result rows than its finalized private
mutual count. A result must not be called complete while its row or image manifest is
silently incomplete.

The launch target is up to 50,000 concurrently retained profile images with a 30-day
retention period. At a normalized 60–100 KB per image, that is approximately 3–5 GB.

## Goals

- When there are at least three risk-eligible, verified female public accounts, finalize
  at least one `high_risk` row and at least two `caution` rows.
- When there are fewer than three such accounts, preserve the natural evidence-derived
  bands without a minimum-band rule.
- Preserve deterministic ordering and keep displayed score, band, rank, and the
  ten-segment meter internally consistent.
- Demote official group, brand, institution, and band accounts when their apparent risk
  comes only from appearance, promotion, or recency rather than direct interactions.
- Produce one account-specific Korean overview per public female row in the requested
  playful, provocative examiner voice, with room for imaginative interpretation.
- Snapshot scraped target, public, and private profile images into private Cloudflare R2
  storage and make successfully captured images owner-readable for no more than 30 days.
- Require high but bounded row and image coverage instead of blocking completion on every
  single missing item.
- Re-run the authorized target as a fresh E2E after the code and infrastructure are
  deployed, then retain the new completed result as the trustworthy sample.

## Non-goals

- R2 does not store AI prompts, captions, comments, raw provider payloads, or interaction
  evidence.
- Supabase Storage is not used as a second copy and the system does not dual-write images.
- The existing private GCS media-artifact bucket remains a one-day workspace for
  short-lived AI inputs; it is not extended to result retention.
- The frontend does not manufacture, reorder, or relabel result data.
- The minimum-band rule is a relative product classification, not proof of infidelity or
  a real-world relationship.
- Apify Starter activation and `APIFY_SECONDARY_API_TOKEN` cutover remain outside this
  design.

## Architecture

### 1. Risk policy v2.3

The existing evidence scorer remains the source of `rawScore`. A new deterministic
post-ranking policy produces the public display score and band.

#### Account context

Feature analysis adds an evidence-grounded `accountContext`:

- `personal`
- `individual_creator`
- `official_group_or_brand`
- `uncertain`

The model must cite one or more selected profile, bio, caption, or media evidence IDs
before returning anything other than `uncertain`. Official bands, teams, companies,
shops, institutions, and brand pages belong to `official_group_or_brand`; a person who
also promotes creative work remains `individual_creator`.

Soft context is adjusted before ranking:

| Context | recent-mutual and appearance/exposure multiplier |
| --- | ---: |
| `personal` | 1.0 |
| `individual_creator` | 0.5 |
| `official_group_or_brand` | 0.0 |
| `uncertain` | 1.0 |

Candidate-to-target likes, candidate comments, target-to-candidate likes, and direct tag
or caption mentions are not discounted. An official account can therefore rank highly
only when direct interaction evidence supports it.

Existing strong-partner safety remains authoritative. A row capped by strong partner
evidence is not eligible for the forced minimum tiers and does not count toward the
three-account minimum pool.

#### Relative tier assignment

Let `N` be the number of verified female rows remaining after exclusions and strong
partner safety. Sort them by adjusted public score descending, then stable candidate ID.

- If `N < 3`, retain the natural evidence-derived bands and scores.
- If `N >= 3`:
  1. compute the natural number of high-risk rows;
  2. set `highCount` to at least one and at most `N - 2`;
  3. assign the first `highCount` rows to `high_risk`;
  4. assign at least the next two rows to `caution`, extending the caution tier when
     natural thresholds require more rows; and
  5. assign the remainder to `normal`.

This preserves a monotonic tier order. In the rare all-high case, the two lowest ranked
rows become caution so the result still contains both required tiers.

Display scores are calibrated after band assignment while preserving order:

- high risk: clamp to `6.8–10.0`;
- caution: clamp to `4.2–6.7`;
- normal: clamp to `1.0–4.1`.

Scores remain one-decimal durable values and the owner UI continues to round them to
integers. The policy version becomes `risk-policy-v2.3`. Result copy must describe these
as relative risk tiers within the analyzed account set.

### 2. Account-specific examiner overview

The existing feature-analysis generation call is reused; no extra Gemini call is added
per account. Its prompt, response schema, prompt version, and cache identity change.
Visible profile and feed context is a creative starting point rather than a requirement
that every phrase map to a stored evidence reference.

`oneLineOverview` must:

- be one Korean sentence of 25–110 characters;
- feel specific to the account rather than interchangeable boilerplate;
- freely exaggerate or imaginatively interpret profile, fashion, occupation, hobby,
  feed, caption, visual-composition, or overall-vibe cues;
- use a playful, nosy, slightly conspiratorial examiner voice;
- avoid the repeated endings “개인 계정입니다” and “일반 단계로 판독됐어요”; and
- remain different from every other overview in the same result.

Allowed tone includes light observations such as a polished outfit being likely to draw
attention or a difficult-looking startup path being an unusual choice. Speculation can
be bold, but confirmed-fact wording is reserved for information actually present in the
profile or feed. It must not:

- claim or imply that cheating, dating, secret messaging, or sexual conduct is a fact;
- identify a person by account name inside the sentence;
- expose scores, ranks, counts, URLs, or raw comments;
- infer protected traits, diagnose health, demean a body, or sexualize a minor; or
- follow instructions embedded in scraped bio or caption text.

If the model output is invalid, a deterministic fallback uses the row's broad account
vibe or visible category when available. A sparse profile may receive a deliberately
mysterious examiner reaction rather than a dry neutral description. Duplicate fallback
text is made distinct by varying the commentary pattern, never by appending an
identifier.

### 3. Private R2 result-image store

One private R2 Standard bucket is the sole durable result-image store. Public development
URLs and custom public domains stay disabled. The bucket has a lifecycle rule that
expires the `v1/` prefix after 30 days.

The object key contains no Instagram ID, user ID, email, or target name:

```text
v1/<32-hex analysis namespace>/<kind>/<32-hex object id>.webp
```

The Cloud Run worker receives a bucket-scoped write credential for `PutObject`,
`HeadObject`, and `DeleteObject`. The Vercel application receives a separate
bucket-scoped read credential for `GetObject` and `HeadObject`. Credentials are
server-only, never use `NEXT_PUBLIC_`, and are redacted from logs.

The already-pinned `sharp` dependency normalizes each source to:

- the first frame only;
- auto-rotated square crop, maximum 256×256;
- WebP with a target quality chosen to keep the object at or below 128 KiB;
- no EXIF, ICC, GPS, or other source metadata; and
- `Content-Type: image/webp`, private cache metadata, and a SHA-256 content hash.

Fetches reuse the existing media URL validation and SSRF protections. Redirects,
content type, decoded dimensions, compressed bytes, and time are bounded. Upload
concurrency is capped at eight per worker instance.

### 4. Supabase metadata and finalization fence

Supabase stores metadata only in a force-RLS table:

`analysis_v2_result_image_objects`

- `request_id`
- `kind` (`target`, `female`, `private`)
- nullable `candidate_id` only for the target row
- nullable opaque `object_key`
- `status` (`ready`, `source_missing`, `capture_failed`)
- nullable `sha256` and `byte_size`
- `observed_at` and nullable `captured_at`
- `expires_at`

The table rejects raw HTTP URLs and requires `expires_at = captured_at + 30 days` within
a small clock tolerance for ready objects. Non-ready rows use
`expires_at = observed_at + 30 days` and have no object key, content hash, byte size, or
capture timestamp. It is not directly readable by `anon` or `authenticated`.
Service-role functions have explicit grants and revoke `PUBLIC` execution.

Before result finalization, the worker:

1. resolves the exact target/public/private result manifest;
2. snapshots each non-null scraped profile image to R2;
3. records a `ready` metadata row only after `HeadObject` confirms size and hash;
4. records `source_missing` only when the scraped source genuinely had no image URL; and
5. records `capture_failed` with a bounded internal reason after transient retries are
   exhausted, then submits the image-manifest hash to the finalizer.

Finalization fails closed unless:

- durable result-row coverage is at least 98% of the expected finalized rows and no more
  than five expected rows are missing;
- every finalized row and the target have exactly one image metadata row;
- among rows whose scraped source had an image URL, at least 95% are `ready` and no more
  than ten are `capture_failed`;
- the target image and the first three relative-risk rows are `ready` whenever their
  scraped source had an image URL;
- every `ready` object is unexpired and belongs to the same request manifest; and
- the ordered row, summary, and image-manifest hashes agree.

`source_missing` is an explicit upstream absence and is not counted as a capture failure.
Expected result rows mean one female row per terminal verified-female classification plus
one private row per detected private mutual; public male and unknown classifications do
not have owner result rows. A zero expected count passes without division.
The result summary persists expected and durable row counts internally so an accepted
small mismatch is observable without exposing detailed screening counts in the owner UI.
Missing result rows are not fabricated. `capture_failed` images render the existing
fallback for the retained result lifetime.

An uploaded object whose database transaction later fails is harmless and is removed by
the R2 lifecycle.

### 5. Owner-bound image delivery and deletion

The current image-proxy token remains the browser contract. The resolver:

1. authenticates the user;
2. verifies ownership of the requested analysis and candidate locator;
3. denies rows that are deleted, not ready, or at/after `expires_at`;
4. reads the opaque R2 key with the read-only credential; and
5. returns `image/webp` with a private bounded cache policy.

Neither the R2 bucket nor object key appears in the token, result JSON, Amplitude, Axiom,
or an operational error.

Owner deletion immediately hides the analysis and commits a durable image-purge outbox
containing only opaque object keys. The worker retries R2 deletion until confirmed, then
finishes database deletion. The 30-day lifecycle is a backstop, not the normal
user-deletion path.

At exactly 30 days the application refuses access even if R2 lifecycle deletion is still
within its documented processing window. Expired metadata is removed only after the
object purge is confirmed or the lifecycle grace window has passed.

## Storage capacity and cost boundary

At the enforced 128 KiB maximum, 50,000 images occupy at most about 6.1 GiB before small
object metadata overhead. That remains below R2 Standard's current 10 GB-month free
storage tier. Fifty thousand initial writes are below the current one-million Class A
monthly free allowance. Reads are monitored against the current ten-million Class B
monthly free allowance.

The implementation records object count, bytes written, read count, upload failures, and
purge lag without recording account identifiers. A cost alert is raised at 70%, 85%, and
100% of the free storage or operation allowance. Pricing is an operational input and
must be rechecked before launch rather than hard-coded into product behavior.

## Retained sample replacement

The existing manually assembled sample is not patched into looking successful. After
policy v2.3, R2 snapshots, row-count fences, and the frontend PR are deployed:

1. run one authorized Plus E2E for the requested public target;
2. require the real pipeline to produce at least one high-risk and two caution rows when
   the eligible count is at least three;
3. verify the official group account receives the new context adjustment if it is still
   present;
4. verify image and row coverage satisfy the bounded completion thresholds, with target
   and top-three images ready when their sources exist;
5. verify account overviews are account-specific, varied, and non-duplicated; and
6. mark the new completed result as the canonical archive example after owner
   verification. Retiring the previous sample is a separate owner-approved deletion.

Paid provider calls already authorized for E2E remain bounded to this one run. A new
login verification code is requested only if the owner session has expired.

## Failure handling

- R2 unavailable: retry with exponential backoff; finalize only when the bounded coverage
  threshold and required target/top-three images still pass.
- Source image unavailable: retry the bounded source fetch; distinguish genuine missing
  source from transient failure.
- Partial upload batch: retain the durable manifest checkpoint and resume only missing
  objects.
- Hash mismatch or count coverage below the threshold: fail with a bounded internal code
  and no result identifiers in logs.
- Tolerated `capture_failed` image: complete the result and render the owner-safe
  fallback.
- Expired image: return a non-cacheable not-found response; never fall back to the raw CDN
  URL.
- Narrative generation unavailable: use an evidence-specific safe fallback and preserve
  the Gemini failure audit.
- Fewer than three eligible women: do not apply the minimum-band rule.

## Verification

### Risk and narrative

- Unit tests cover eligible counts 0, 1, 2, 3, and large lists.
- Three or more eligible rows always contain at least one high-risk and two caution rows.
- All-high and all-normal natural inputs preserve monotonic ordering after calibration.
- Strong-partner caps remain excluded from forced tiers.
- Official group context removes soft-context points but retains direct interaction
  evidence.
- Score, band, featured rank, integer owner score, and ten-segment meter remain
  consistent.
- Prompt and schema tests preserve wide stylistic variation while rejecting identifiers,
  metrics, confirmed-fact relationship accusations, generic repeated copy, and prompt
  injection.

### R2 and persistence

- Unit tests use a fake S3-compatible client for upload, head, get, delete, retry,
  credential separation, and redaction.
- Image tests verify WebP normalization, 256×256 bounds, 128 KiB maximum, metadata
  stripping, animation flattening, malformed image rejection, and SSRF boundaries.
- PGlite tests prove force-RLS metadata, exact grants, the 98%/five-row and
  95%/ten-image thresholds, mandatory target/top-three images, expiry checks, idempotent
  replay, failed-source promotion during finalizer retry, and deletion outbox behavior.
- Route tests prove owner-only image access, exact 30-day denial, no raw URL fallback, and
  safe cache headers.
- Infrastructure script tests prove a private R2 bucket, disabled public URL, exact
  30-day `v1/` lifecycle, least-privilege credentials, and read-only drift checks.
- A 50,000-row synthetic manifest test stays bounded in memory by processing pages and
  batches rather than loading image bytes together.

### Release

- Focused tests pass before the full suite.
- Full `npm test`, lint, typecheck, build, migration checks, and security advisors pass.
- The R2 bucket and secrets are provisioned only after explicit operational approval.
- Database migrations are applied only after explicit production approval.
- A canary upload, owner read, expiry simulation, and purge completes before the one paid
  E2E run.

## Rollout order

1. Land risk-policy, narrative, R2 adapter, persistence, and infrastructure code behind
   server-owned readiness flags.
2. Deploy compatibility readers and the worker without enabling result-image admission.
3. With approval, provision and verify the private R2 bucket and scoped credentials.
4. With approval, apply Supabase migrations and run advisors.
5. Enable policy v2.3 and R2 image admission for one canary request.
6. Integrate the separately reviewed frontend PR.
7. Update the privacy and owner-facing retention copy to state that result profile-image
   snapshots are private, owner-scoped, retained for up to 30 days, and purged early when
   the result is deleted.
8. Run the authorized Plus E2E and complete the retained sample verification.
9. Continue the pre-Starter commercial-readiness plan; do not activate Apify Starter
   until paid earlybird demand is validated.
