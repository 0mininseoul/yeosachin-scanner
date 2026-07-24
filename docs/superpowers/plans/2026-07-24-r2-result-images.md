# R2 Result Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Snapshot target, female-public, and private-mutual result images into a private 30-day Cloudflare R2 store, allow bounded small capture gaps, and deliver ready images only through the owner-bound proxy.

**Architecture:** A worker-side capture coordinator securely downloads and normalizes each source to bounded WebP, writes it through an S3-compatible R2 adapter, verifies it with `HeadObject`, and checkpoints metadata plus a repair outbox in Supabase. The existing signed result-image locator remains the browser API; the authenticated resolver returns either a legacy remote locator while the flag is off or an opaque R2 object reference while the flag is on. Finalization validates row/image manifests and bounded coverage in SQL.

**Tech Stack:** TypeScript, Vitest, Sharp, AWS S3-compatible client, Supabase PostgreSQL, PGlite, Cloudflare R2

---

## File map

- Modify `package.json` and `package-lock.json`: pin the S3 client dependency.
- Create `lib/services/media/result-image-normalizer.ts` and test: first-frame 256px WebP normalization and 128 KiB bound.
- Create `lib/services/media/r2-result-image-store.ts` and test: config, opaque keys, put/head/get/delete, redacted errors.
- Create `lib/services/media/result-image-capture.ts` and test: bounded source fetch, concurrency, metadata checkpoint, and repair behavior.
- Create `lib/services/media/result-image-registry.ts` and test: typed Supabase RPC boundary.
- Modify `lib/services/media/result-image-resolver.ts` and test: legacy/R2 compatibility reader and exact-expiry denial.
- Modify `app/api/image-proxy/route.ts` and `lib/services/media/image-proxy-route.test.ts`: owner-only WebP delivery without raw fallback.
- Modify `supabase/migrations/20260724123500_add_analysis_v2_result_image_objects.sql`: metadata, coverage fence, repair outbox, purge outbox, grants, and RLS.
- Create `lib/services/analysis/v2-result-image-objects-migration-contract.test.ts`: SQL surface contract.
- Create `lib/services/analysis/v2-result-image-objects-pglite.test.ts`: threshold, expiry, idempotency, and deletion behavior.
- Modify `lib/services/analysis/v2-result-store.ts`, `lib/services/analysis/v2-result-store.test.ts`, `lib/services/analysis/v2-ai-scoring-executors.ts`, and `lib/services/analysis/v2-ai-scoring-executors.test.ts`: submit ordered image-manifest hash and enforce readiness flag.
- Modify `app/api/analysis/result/[requestId]/route.ts` and `lib/services/analysis/v2-owner-history-deletion-migration-contract.test.ts`: immediate hide plus durable purge intent.
- Create `scripts/configure-analysis-v2-result-image-r2.sh` and test: private bucket/lifecycle/least-privilege drift checks; do not execute provisioning without approval.
- Modify `.env.example`: server-only R2 variables and readiness flag.
- Modify privacy/retention copy only after locating its current canonical file; frontend result layout remains out of scope.

### Task 1: Bounded WebP normalization

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/services/media/result-image-normalizer.ts`
- Create: `lib/services/media/result-image-normalizer.test.ts`

- [ ] **Step 1: Add the pinned S3 client**

Run:

```bash
npm install --save-exact @aws-sdk/client-s3@3.901.0
```

Expected: package files change; no other dependency is upgraded.

- [ ] **Step 2: Write failing image tests**

Tests must generate fixtures in memory with Sharp and prove:

```ts
const result = await normalizeResultImage(animatedOrRotatedInput);
expect(result.contentType).toBe('image/webp');
expect(result.bytes.byteLength).toBeLessThanOrEqual(128 * 1024);
expect(result.width).toBeLessThanOrEqual(256);
expect(result.height).toBeLessThanOrEqual(256);
expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
```

Also assert first-frame flattening, metadata removal, malformed input rejection, decoded
dimension limits, and deterministic output for the same source bytes.

- [ ] **Step 3: Run and verify RED**

```bash
npx vitest run lib/services/media/result-image-normalizer.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement bounded normalization**

Use `sharp(input, { animated: false, limitInputPixels: 16_777_216 })`, `rotate()`,
`resize(256, 256, { fit: 'cover', withoutEnlargement: true })`, and WebP quality attempts
`[82, 74, 66, 58, 50, 42]`. Reject output still above 128 KiB. Do not call
`withMetadata()`.

- [ ] **Step 5: Run tests and commit**

```bash
npx vitest run lib/services/media/result-image-normalizer.test.ts
git add package.json package-lock.json \
  lib/services/media/result-image-normalizer.ts \
  lib/services/media/result-image-normalizer.test.ts
git commit -m "feat: normalize retained result images"
```

Expected: test PASS and commit succeeds.

### Task 2: Private R2 object adapter

**Files:**
- Create: `lib/services/media/r2-result-image-store.ts`
- Create: `lib/services/media/r2-result-image-store.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing adapter tests**

Use a fake `send(command)` client and assert:

- object keys match `v1/[0-9a-f]{32}/(target|female|private)/[0-9a-f]{32}.webp`;
- no username, owner UUID, email, Instagram ID, or raw URL appears in a key;
- writer operations are `PutObject`, `HeadObject`, `DeleteObject`;
- reader operations are `GetObject`, `HeadObject`;
- put metadata contains only content hash and private cache metadata;
- thrown errors contain a bounded code and never endpoint, access key, secret, bucket, or key.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run lib/services/media/r2-result-image-store.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement configuration and opaque key derivation**

```ts
export interface ResultImageR2Config {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
}

export function resultImageObjectKey(input: {
    requestId: string;
    kind: 'target' | 'female' | 'private';
    candidateId: string | null;
    sourceFingerprint: string;
}): string {
    const namespace = hmac128('analysis-namespace', input.requestId);
    const objectId = hmac128(
        'result-image',
        `${input.kind}\n${input.candidateId ?? 'target'}\n${input.sourceFingerprint}`
    );
    return `v1/${namespace}/${input.kind}/${objectId}.webp`;
}
```

Use a server-only application secret as the HMAC key, validate every environment variable,
and construct separate reader/writer factories so Vercel never needs write credentials.

- [ ] **Step 4: Implement put/head/get/delete with integrity checks**

`put` must set `ContentType: image/webp`, `CacheControl: private, max-age=86400`, and the
SHA-256 metadata; `head` must require exact byte size and hash; `get` must enforce the
stored maximum before buffering; `delete` must be idempotent.

- [ ] **Step 5: Document server-only environment names**

Add:

```dotenv
ANALYSIS_V2_RESULT_IMAGES_ENABLED=false
ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT=
ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET=
ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID=
ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY=
ANALYSIS_V2_RESULT_IMAGE_OBJECT_HMAC_SECRET=
```

No variable may start with `NEXT_PUBLIC_`.

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run lib/services/media/r2-result-image-store.test.ts
git add .env.example \
  lib/services/media/r2-result-image-store.ts \
  lib/services/media/r2-result-image-store.test.ts
git commit -m "feat: add private R2 result image adapter"
```

Expected: PASS.

### Task 3: Metadata, repair, purge, and bounded finalization fence

**Files:**
- Modify: `supabase/migrations/20260724123500_add_analysis_v2_result_image_objects.sql`
- Create: `lib/services/analysis/v2-result-image-objects-migration-contract.test.ts`
- Create: `lib/services/analysis/v2-result-image-objects-pglite.test.ts`

- [ ] **Step 1: Write failing SQL tests**

Contract/PGlite tests must prove:

- force RLS and no table grants for `anon`/`authenticated`;
- service-role functions revoke `PUBLIC` and grant only `service_role`;
- ready rows require opaque keys, 64-hex hashes, 1–131072 bytes, capture time, and
  `expires_at` approximately 30 days after capture;
- non-ready rows forbid object metadata and expire 30 days after observation;
- raw `http://` or `https://` values are rejected;
- row coverage passes only when `durable / expected >= 0.98` and `expected - durable <= 5`;
- sourced-image coverage passes only when `ready / sourced >= 0.95` and failed count <= 10;
- zero denominators pass;
- target/top-three sourced images must be ready;
- manifest hash and idempotent replay are enforced;
- capture failures enqueue repair; owner deletion enqueues opaque purge keys and hides the
  analysis immediately.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run \
  lib/services/analysis/v2-result-image-objects-migration-contract.test.ts \
  lib/services/analysis/v2-result-image-objects-pglite.test.ts
```

Expected: FAIL because the migration contains only its scaffold comment.

- [ ] **Step 3: Create the metadata table and constraints**

Create `analysis_v2_result_image_objects` keyed by `(request_id, kind, candidate_locator)`.
Use enums/check constraints for `target|female|private` and
`ready|source_missing|capture_failed`. Store a nullable bounded internal failure code, not
provider messages. Add force RLS and indexes for expiry and repair claiming.

- [ ] **Step 4: Create register/claim/complete/purge RPCs**

All mutations must verify the request/job fence, be replay-idempotent, compare an ordered
manifest hash, lease repair/purge work with UUID claim tokens, and return bounded records.
Revoke all function execution from `PUBLIC, anon, authenticated` and grant exact signatures
to `service_role`.

- [ ] **Step 5: Extend finalization**

The finalizer SQL must compute:

```sql
row_ok := expected_rows = 0 OR (
    durable_rows::NUMERIC / expected_rows >= 0.98
    AND expected_rows - durable_rows <= 5
);
image_ok := sourced_images = 0 OR (
    ready_images::NUMERIC / sourced_images >= 0.95
    AND capture_failed_images <= 10
);
```

It must additionally require exactly one metadata row per durable row plus target,
unexpired ready objects, mandatory ready target/top-three sourced images, and matching
ordered row/summary/image hashes. `source_missing` is not a failure. Persist expected and
durable counts internally for observability.

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run \
  lib/services/analysis/v2-result-image-objects-migration-contract.test.ts \
  lib/services/analysis/v2-result-image-objects-pglite.test.ts
git add \
  supabase/migrations/20260724123500_add_analysis_v2_result_image_objects.sql \
  lib/services/analysis/v2-result-image-objects-migration-contract.test.ts \
  lib/services/analysis/v2-result-image-objects-pglite.test.ts
git commit -m "feat: persist result image manifests"
```

Expected: PASS.

### Task 4: Capture coordinator and finalizer integration

**Files:**
- Create: `lib/services/media/result-image-registry.ts`
- Create: `lib/services/media/result-image-registry.test.ts`
- Create: `lib/services/media/result-image-capture.ts`
- Create: `lib/services/media/result-image-capture.test.ts`
- Modify: `lib/services/analysis/v2-result-store.ts`
- Modify: `lib/services/analysis/v2-result-store.test.ts`
- Modify: `lib/services/analysis/v2-ai-scoring-executors.ts`
- Modify: `lib/services/analysis/v2-ai-scoring-executors.test.ts`

- [ ] **Step 1: Write failing capture tests**

Test a mixed manifest containing ready, source-missing, and transiently failing items.
Assert maximum upload concurrency eight, retry exhaustion produces `capture_failed`, a
successful `HeadObject` precedes `ready`, replay skips verified objects, and a 50,000-row
synthetic manifest holds only one bounded page plus eight image buffers at once.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run \
  lib/services/media/result-image-registry.test.ts \
  lib/services/media/result-image-capture.test.ts \
  lib/services/analysis/v2-result-store.test.ts \
  lib/services/analysis/v2-ai-scoring-executors.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the registry RPC adapter**

Expose typed methods `loadManifestPage`, `registerOutcome`, `claimRepair`,
`completeRepair`, `claimPurge`, and `completePurge`. Validate UUIDs, opaque keys, hashes,
byte sizes, timestamps, and bounded failure codes at the TypeScript boundary.

- [ ] **Step 4: Implement secure capture**

Reuse the current secure-media downloader/host allowlist instead of raw `fetch`. Normalize,
put, head-verify, and register each image. Use eight workers over paginated locators and
never retain the entire source image set in memory. Compute the ordered manifest hash from
metadata fields, not image bytes.

- [ ] **Step 5: Integrate the finalizer behind the server flag**

When `ANALYSIS_V2_RESULT_IMAGES_ENABLED=false`, retain the current finalizer behavior.
When true, require capture completion and submit the image manifest hash/counts to the
new SQL fence. This compatibility flag allows code deployment before R2 provisioning.

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run \
  lib/services/media/result-image-registry.test.ts \
  lib/services/media/result-image-capture.test.ts \
  $(rg -l "v2-result-finalizer" lib --glob '*test.ts')
git add \
  lib/services/media/result-image-registry.ts \
  lib/services/media/result-image-registry.test.ts \
  lib/services/media/result-image-capture.ts \
  lib/services/media/result-image-capture.test.ts \
  lib/services/analysis/v2-result-store.ts \
  lib/services/analysis/v2-result-store.test.ts \
  lib/services/analysis/v2-ai-scoring-executors.ts \
  lib/services/analysis/v2-ai-scoring-executors.test.ts
git commit -m "feat: capture retained result images"
```

Expected: PASS.

### Task 5: Owner-bound R2 delivery

**Files:**
- Modify: `lib/services/media/result-image-resolver.ts`
- Create or modify: `lib/services/media/result-image-resolver.test.ts`
- Modify: `app/api/image-proxy/route.ts`
- Modify: `lib/services/media/image-proxy-route.test.ts`

- [ ] **Step 1: Write failing owner/expiry tests**

Test owner success, non-owner denial, deleted analysis denial, non-ready denial,
`now === expiresAt` denial, hash/size mismatch denial, private cache headers, and no raw
Instagram fallback after an R2 read failure. Verify logs/responses never contain bucket or
object key.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run \
  lib/services/media/result-image-resolver.test.ts \
  lib/services/media/image-proxy-route.test.ts
```

Expected: FAIL because the resolver returns only a raw URL.

- [ ] **Step 3: Add a compatibility locator**

```ts
export type ResolvedResultImage =
    | { source: 'legacy_url'; url: string }
    | {
        source: 'r2';
        objectKey: string;
        sha256: string;
        byteSize: number;
        expiresAt: string;
    };
```

The service-role RPC must authenticate owner/request/kind/candidate, return the R2 variant
only for a ready unexpired row, and keep the legacy URL variant only while the readiness
flag is false.

- [ ] **Step 4: Stream verified WebP through the existing route**

For R2, call the read-only adapter, verify bytes/hash/size, and return `image/webp`.
Use owner-scoped private cache headers bounded by token and object expiry. Return a
non-cacheable placeholder/not-found response on failure; never disclose or retry the raw
source URL.

- [ ] **Step 5: Run tests and commit**

```bash
npx vitest run \
  lib/services/media/result-image-resolver.test.ts \
  lib/services/media/image-proxy-route.test.ts
git add \
  lib/services/media/result-image-resolver.ts \
  lib/services/media/result-image-resolver.test.ts \
  app/api/image-proxy/route.ts \
  lib/services/media/image-proxy-route.test.ts
git commit -m "feat: serve owner result images from R2"
```

Expected: PASS.

### Task 6: Early deletion and infrastructure-as-code

**Files:**
- Modify: `app/api/analysis/result/[requestId]/route.ts`
- Modify: `lib/services/analysis/v2-owner-history-deletion-migration-contract.test.ts`
- Create: `scripts/configure-analysis-v2-result-image-r2.sh`
- Create: `scripts/configure-analysis-v2-result-image-r2.test.ts`

- [ ] **Step 1: Write failing deletion and script tests**

Deletion tests must assert immediate owner invisibility, transactional purge intent, retry
after R2 failure, idempotent delete confirmation, and lifecycle-safe expired cleanup.
Script tests must inspect dry-run output for a private Standard bucket, disabled public
development URL, exact `v1/` 30-day lifecycle, separate reader/writer tokens, and a drift
check that never prints secrets.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run \
  lib/services/analysis/v2-owner-history-deletion-migration-contract.test.ts \
  scripts/configure-analysis-v2-result-image-r2.test.ts
```

Expected: FAIL on missing purge and configuration behavior.

- [ ] **Step 3: Integrate purge outbox with deletion**

In the same database transaction that hides the analysis, copy only opaque ready object
keys into the purge outbox. A worker claims bounded batches, calls idempotent R2 delete,
confirms absence, then completes the database purge. Metadata at 30 days is deleted only
after confirmed object purge or an explicit lifecycle grace cutoff.

- [ ] **Step 4: Implement dry-run-first R2 configuration**

The script must require an explicit `--apply` flag for writes, otherwise inspect/print a
redacted plan. It must create/update only the named bucket/lifecycle and exact scoped token
policies. It must refuse public access and refuse account-wide token policies.

- [ ] **Step 5: Run tests and commit**

```bash
npx vitest run \
  lib/services/analysis/v2-owner-history-deletion-migration-contract.test.ts \
  scripts/configure-analysis-v2-result-image-r2.test.ts
git add \
  app/api/analysis/result/[requestId]/route.ts \
  lib/services/analysis/v2-owner-history-deletion-migration-contract.test.ts \
  scripts/configure-analysis-v2-result-image-r2.sh \
  scripts/configure-analysis-v2-result-image-r2.test.ts
git commit -m "feat: purge retained result images"
```

Expected: PASS. Do not run the script with `--apply`.

### Task 7: R2 verification and operational handoff

**Files:**
- Modify only intentional compatibility fixes and the canonical privacy/retention copy.

- [ ] **Step 1: Run focused suites**

```bash
npx vitest run \
  lib/services/media/result-image-normalizer.test.ts \
  lib/services/media/r2-result-image-store.test.ts \
  lib/services/media/result-image-registry.test.ts \
  lib/services/media/result-image-capture.test.ts \
  lib/services/media/result-image-resolver.test.ts \
  lib/services/media/image-proxy-route.test.ts \
  lib/services/analysis/v2-result-image-objects-migration-contract.test.ts \
  lib/services/analysis/v2-result-image-objects-pglite.test.ts \
  scripts/configure-analysis-v2-result-image-r2.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository verification**

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Expected: all exit 0.

- [ ] **Step 3: Inspect migration/security drift without applying production changes**

Run local migration checks and Supabase advisory tests available in `package.json`.
Expected: no destructive migration, no direct `anon`/`authenticated` access, no public
bucket or leaked secret.

- [ ] **Step 4: Stop at the operational approval boundary**

Report the exact proposed R2 bucket/lifecycle/token scopes and the exact production
Supabase migration list. Obtain explicit approval before:

```text
1. creating or mutating the Cloudflare R2 bucket/tokens,
2. writing R2/Vercel/Cloud Run production secrets,
3. applying either production Supabase migration,
4. enabling ANALYSIS_V2_RESULT_IMAGES_ENABLED,
5. running the paid Plus E2E.
```

- [ ] **Step 5: After approval, canary then one authorized E2E**

Provision through the reviewed script, apply migrations, run one synthetic canary
put/head/owner-read/expiry-simulation/purge, then enable one request and run the already
authorized target E2E. Verify row/image thresholds, target/top-three image readiness,
relative tiers, official-context demotion, and varied overviews. Retiring the old sample
remains a separate deletion approval.
