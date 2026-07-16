# V2 Carousel Slide Caption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Instagram carousel slide captions from the already-selected profile provider and feed a deterministic, bounded dossier into existing V2 analysis calls without adding provider runs, Gemini calls, or DAG stages.

**Architecture:** Extend the canonical Instagram media item and private profile checkpoint with an optional bounded caption, then normalize slide captions in a small pure domain policy. Existing feature, partner-safety, and high-risk-narrative executors consume that policy: the selected three slides keep aligned evidence, the remaining contact-sheet slides receive aligned text context, and the narrative receives one content-addressed dossier capped at 2,000 display characters.

**Tech Stack:** TypeScript, Zod, Vitest, Supabase PostgreSQL migrations, existing Instagram self-hosted/Apify providers, existing Vertex Gemini staged-analysis runtime.

---

## File Map

- `lib/types/instagram.ts`: canonical optional child-slide caption.
- `lib/services/instagram/providers/apify.ts`: parse `childPosts.caption` and merge exact slide mentions.
- `lib/services/instagram/providers/selfhosted/mappers.ts`: parse child caption shapes and merge exact slide mentions.
- `lib/services/analysis/v2-profile-fetch-store.ts`: private checkpoint validation for child captions.
- `supabase/migrations/20260716130000_allow_carousel_child_captions.sql`: database JSON validator replacement.
- `lib/domain/analysis/carousel-caption-policy.ts`: pure selection, normalization, deduplication, alignment, and 2,000-character dossier packing.
- `lib/services/ai/v2-staged-analysis.ts`: bounded partner-contact caption context and narrative dossier schemas/prompts.
- `lib/services/analysis/v2-ai-scoring-executors.ts`: wire the pure policy into existing calls only.

### Task 1: Lock the Existing Duplicate-Parent-Caption Regression

**Files:**
- Modify: `lib/services/analysis/v2-ai-scoring-executors.ts`
- Test: `lib/services/analysis/v2-ai-scoring-executors.test.ts`
- Test: `lib/services/analysis/v2-profile-fetch-store.test.ts`

- [ ] **Step 1: Keep the failing E2E-shaped regression test**

The test must select first/middle/last images from one carousel while the post has one parent caption, parse the outbound input through `featureAnalysisInputSchema`, and assert:

```ts
expect(featureInput.media.filter(row => row.postId === 'caption-carousel-post'))
    .toHaveLength(3);
expect(featureInput.captions.filter(row => (
    row.selectionId.includes('caption-carousel-post')
))).toHaveLength(1);
expect(new Set(featureInput.captions.map(row => row.evidenceRefId)).size)
    .toBe(featureInput.captions.length);
```

- [ ] **Step 2: Verify the pre-fix failure is the production schema failure**

```bash
npx vitest run lib/services/analysis/v2-ai-scoring-executors.test.ts \
  -t "sends one caption evidence row when a selected carousel contributes three images"
```

Expected before the fix: FAIL because repeated parent captions generate duplicate `evidenceRefId` values.

- [ ] **Step 3: Deduplicate parent fallback captions by post**

```ts
const seenPostIds = new Set<string>();
return selections.flatMap(selection => {
    if (!selection.postId || seenPostIds.has(selection.postId)) return [];
    const caption = postById.get(selection.postId)?.caption?.trim();
    if (!caption) return [];
    seenPostIds.add(selection.postId);
    return [{
        evidenceRefId: `caption:${sha256('analysis-v2-caption-ref-v1', {
            candidate: profile.username,
            postId: selection.postId,
        }).slice(0, 48)}`,
        selectionId: selection.selectionId,
        text: caption,
    }];
});
```

- [ ] **Step 4: Preserve the latest-eight-post checkpoint boundary test**

Use 12 source posts and assert the checkpoint stores IDs `post-11` through `post-4`, proving the caption work does not widen the stored post count.

- [ ] **Step 5: Run and commit**

```bash
npx vitest run \
  lib/services/analysis/v2-ai-scoring-executors.test.ts \
  lib/services/analysis/v2-profile-fetch-store.test.ts
git add lib/services/analysis/v2-ai-scoring-executors.ts \
  lib/services/analysis/v2-ai-scoring-executors.test.ts \
  lib/services/analysis/v2-profile-fetch-store.test.ts
git commit -m "fix: dedupe carousel parent caption evidence"
```

Expected: PASS, then a focused regression commit.

### Task 2: Preserve Slide Captions Across Providers and Checkpoints

**Files:**
- Modify: `lib/types/instagram.ts`
- Modify: `lib/services/instagram/providers/apify.ts`
- Modify: `lib/services/instagram/providers/selfhosted/mappers.ts`
- Modify: `lib/services/analysis/v2-profile-fetch-store.ts`
- Test: `lib/services/instagram/providers/apify.test.ts`
- Test: `lib/services/instagram/providers/selfhosted/mappers.test.ts`
- Test: `lib/services/analysis/v2-profile-fetch-store.test.ts`
- Test: `lib/services/analysis/v2-profile-fetch-migration-contract.test.ts`
- Create: `supabase/migrations/20260716130000_allow_carousel_child_captions.sql`

- [ ] **Step 1: Write provider and checkpoint failures first**

Add fixtures with distinct slide captions, including `@target.user`, and assert:

```ts
expect(post.mediaItems?.map(item => item.caption)).toEqual([
    'first slide',
    'with @target.user',
    undefined,
]);
expect(post.mentionedUsers).toContain('target.user');
expect(analysisV2CheckpointMediaItemSchema.parse({
    type: 'image',
    imageUrl: 'https://cdninstagram.com/frame.jpg',
    caption: 'slide caption',
}).caption).toBe('slide caption');
expect(() => analysisV2CheckpointMediaItemSchema.parse({
    type: 'image',
    imageUrl: 'https://cdninstagram.com/frame.jpg',
    caption: 'x'.repeat(2_201),
})).toThrow();
```

The self-hosted fixture must cover direct `caption` and `edge_media_to_caption.edges[0].node.text` child shapes. Tests must keep child order.

- [ ] **Step 2: Confirm data is currently discarded**

```bash
npx vitest run \
  lib/services/instagram/providers/apify.test.ts \
  lib/services/instagram/providers/selfhosted/mappers.test.ts \
  lib/services/analysis/v2-profile-fetch-store.test.ts
```

Expected before implementation: FAIL because child captions are absent from the canonical model.

- [ ] **Step 3: Extend the model and provider mappers**

```ts
export interface InstagramPostMediaItem {
    id?: string;
    type: InstagramPostMediaType;
    caption?: string;
    imageUrl?: string;
    thumbnailUrl?: string;
    videoUrl?: string;
}
```

In Apify, parse `caption: z.string().nullable().optional()` and include a trimmed non-empty value. In self-hosted, return the first non-empty authored caption from direct `caption` or `edge_media_to_caption.edges[0].node.text`; do not treat accessibility/alt text as a user caption.

Extract exact Instagram usernames with the repository's existing mention parser and merge slide mentions into the parent `mentionedUsers` through stable, lower-cased, first-seen-order dedupe. Do not infer mentions without an `@` token.

- [ ] **Step 4: Extend the application checkpoint schema**

```ts
export const analysisV2CheckpointMediaItemSchema = z.object({
    id: boundedMediaIdSchema.optional(),
    type: z.enum(['image', 'video', 'reel']),
    caption: z.string().max(2_200).optional(),
    imageUrl: boundedUrlSchema.optional(),
    thumbnailUrl: boundedUrlSchema.optional(),
    videoUrl: boundedUrlSchema.optional(),
}).strict();
```

Keep the existing media-URL `superRefine` unchanged.

- [ ] **Step 5: Implement the generated Supabase migration**

Populate `supabase/migrations/20260716130000_allow_carousel_child_captions.sql` by copying the existing `public.analysis_v2_valid_profile_snapshot(JSONB)` body and changing only child-media validation so `caption` is allowed and, when present, is a JSON string no longer than 2,200 characters:

```sql
OR media_item.value - ARRAY[
    'id', 'type', 'caption', 'imageUrl', 'thumbnailUrl', 'videoUrl'
] <> '{}'::JSONB
OR (
    media_item.value ? 'caption'
    AND (
        jsonb_typeof(media_item.value->'caption') <> 'string'
        OR length(media_item.value->>'caption') > 2200
    )
)
```

Reapply the existing ownership/search-path and `REVOKE ALL` statements exactly. Update the contract test to require the allowlist, string check, 2,200 bound, and revoke.

- [ ] **Step 6: Run and commit**

```bash
npx vitest run \
  lib/services/instagram/providers/apify.test.ts \
  lib/services/instagram/providers/selfhosted/mappers.test.ts \
  lib/services/analysis/v2-profile-fetch-store.test.ts \
  lib/services/analysis/v2-profile-fetch-migration-contract.test.ts
git add lib/types/instagram.ts lib/services/instagram/providers \
  lib/services/analysis/v2-profile-fetch-store.ts \
  lib/services/analysis/v2-profile-fetch-store.test.ts \
  lib/services/analysis/v2-profile-fetch-migration-contract.test.ts \
  supabase/migrations
git commit -m "feat: preserve carousel slide captions"
```

Expected: PASS, then a provider/checkpoint commit.

### Task 3: Build the Deterministic Carousel Caption Policy

**Files:**
- Create: `lib/domain/analysis/carousel-caption-policy.ts`
- Create: `lib/domain/analysis/carousel-caption-policy.test.ts`

- [ ] **Step 1: Write the policy contract tests**

```ts
const policy = buildCarouselCaptionPolicy({
    targetUsername: 'target.user',
    profile,
    featureSelections,
    partnerSelections,
});
expect(policy.featureCaptions.map(row => row.selectionId)).toEqual([
    'post:carousel:0', 'post:carousel:3', 'post:carousel:5',
]);
expect(policy.partnerCaptions.map(row => row.selectionId)).toEqual([
    'post:carousel:1', 'post:carousel:2', 'post:carousel:4',
]);
expect(policy.dossier?.text.length).toBeLessThanOrEqual(2_000);
expect(policy.dossier?.text).toContain('@target.user');
```

Also cover NFKC normalization, whitespace collapse, empty removal, exact dedupe preserving first occurrence, no complete carousel, missing child captions, deterministic repeated output, and over-budget input where every unique slide gets a non-empty excerpt before residual allocation.

- [ ] **Step 2: Confirm the module is absent**

```bash
npx vitest run lib/domain/analysis/carousel-caption-policy.test.ts
```

Expected: FAIL with module-not-found or missing export.

- [ ] **Step 3: Implement focused public types**

```ts
export type CarouselCaptionEvidence = Readonly<{
    evidenceRefId: string;
    selectionId: string;
    text: string;
}>;

export function buildCarouselCaptionPolicy(input: Readonly<{
    targetUsername: string;
    profile: Pick<InstagramProfile, 'username' | 'latestPosts'>;
    featureSelections: readonly SelectedAnalysisMedia[];
    partnerSelections: readonly SelectedAnalysisMedia[];
}>): Readonly<{
    featureCaptions: CarouselCaptionEvidence[];
    partnerCaptions: CarouselCaptionEvidence[];
    dossier: Readonly<{ evidenceRefId: string; text: string }> | null;
}>;
```

Use the latest complete carousel selected by the canonical media policy, and map selections to captions by `postId` plus `mediaIndex`. Use `sha256` refs including username, post ID, media index, and normalized text so different slide captions cannot collide.

- [ ] **Step 4: Implement the 2,000-character packer**

Normalize with `text.normalize('NFKC').replace(/\s+/g, ' ').trim()`. Dedupe exact normalized strings in slide order. If the labeled dossier fits, preserve all text. Otherwise reserve labels within the same budget, allocate a deterministic base excerpt to every unique slide, then give residual characters first to exact `@targetUsername` captions and next to lower media indexes. Add `...` only inside an entry allocation and assert final JavaScript string length is at most 2,000. Do not call a tokenizer or network API.

- [ ] **Step 5: Run and commit**

```bash
npx vitest run lib/domain/analysis/carousel-caption-policy.test.ts
git add lib/domain/analysis/carousel-caption-policy.ts \
  lib/domain/analysis/carousel-caption-policy.test.ts
git commit -m "feat: add bounded carousel caption policy"
```

Expected: PASS, then a pure-domain commit.

### Task 4: Extend Existing Gemini Inputs Without Adding Calls

**Files:**
- Modify: `lib/services/ai/v2-staged-analysis.ts`
- Modify: `lib/services/ai/stage-policy.ts`
- Test: `lib/services/ai/v2-staged-analysis.test.ts`
- Test: `lib/services/ai/stage-policy.test.ts`

- [ ] **Step 1: Add failing partner-caption and narrative-dossier tests**

For partner safety, pass contact-sheet-aligned rows:

```ts
partnerCaptions: [{
    evidenceRefId: 'carousel-caption:abc',
    selectionId: 'post:carousel:1',
    text: 'second slide text',
}]
```

For narrative, pass:

```ts
carouselCaptionDossier: {
    evidenceRefId: 'carousel-dossier:abc',
    text: '[슬라이드 1] city walk\n[슬라이드 2] @target.user',
}
```

Assert the first narrative line may cite the dossier ref, unknown refs are rejected, the dossier cannot satisfy second-line interaction evidence, and inputs above 2,000 characters fail validation.

- [ ] **Step 2: Verify strict schemas reject the fields**

```bash
npx vitest run lib/services/ai/v2-staged-analysis.test.ts \
  -t "partner caption|carousel caption dossier"
```

Expected before implementation: FAIL on strict input parsing.

- [ ] **Step 3: Extend bounded schemas and prompts**

Add a shared caption-row schema with bounded `evidenceRefId`, `selectionId`, and `text`. Extend partner input with `partnerCaptions: z.array(...).max(17)` and refine every row selection ID belongs to `contactSheet.sourceSelectionIds`. Extend narrative input with nullable `carouselCaptionDossier` whose text is `.min(1).max(2_000)`.

Partner prompt rules state caption text is context only; any non-null partner signal must still cite visual contact-sheet source IDs. Narrative prompt and sanitization include the dossier as style/persona evidence only. Add its ref to `allowedRefs`, `styleRefs`, and first-line fallback refs, never to interaction groups or second-line coverage.

- [ ] **Step 4: Version affected identities without changing runtime policy**

```ts
export const AI_STAGE_POLICY_VERSION = 'ai-stage-policy-v2.3';
```

Bump partner-safety and high-risk-narrative prompt/schema versions so old checkpoint identities cannot be reused. Do not change model, thinking level, retry count, timeout, output-token limit, or concurrency.

- [ ] **Step 5: Run and commit**

```bash
npx vitest run \
  lib/services/ai/v2-staged-analysis.test.ts \
  lib/services/ai/stage-policy.test.ts \
  lib/services/ai/gemini.test.ts
git add lib/services/ai/v2-staged-analysis.ts \
  lib/services/ai/v2-staged-analysis.test.ts \
  lib/services/ai/stage-policy.ts lib/services/ai/stage-policy.test.ts
git commit -m "feat: ground analysis with slide captions"
```

Expected: PASS with only explicit version expectations changing.

### Task 5: Wire the Policy and Prove Topology/Cost Invariants

**Files:**
- Modify: `lib/services/analysis/v2-ai-scoring-executors.ts`
- Test: `lib/services/analysis/v2-ai-scoring-executors.test.ts`
- Test: `lib/services/analysis/v2-dag-planner.test.ts`
- Test: `lib/services/analysis/v2-worker.test.ts`
- Modify: `docs/operations-cost-model.md`

- [ ] **Step 1: Add failing executor wiring tests**

Build one candidate with a complete 20-slide carousel and unique captions. Assert:

```ts
expect(featureInput.captions).toEqual(expect.arrayContaining([
    expect.objectContaining({ selectionId: expect.stringContaining(':0') }),
    expect.objectContaining({ selectionId: expect.stringContaining(':10') }),
    expect.objectContaining({ selectionId: expect.stringContaining(':19') }),
]));
expect(partnerInput.partnerCaptions).toHaveLength(17);
expect(narrativeInput.carouselCaptionDossier?.text.length)
    .toBeLessThanOrEqual(2_000);
```

Record `features`, `partnerSafety`, and `narrative` invocation counts. Assert one feature call per detailed public candidate, at most one partner call per verification TOP10 candidate, and at most one narrative call per final high-risk TOP3 candidate. Assert no new DAG job type exists.

- [ ] **Step 2: Confirm only caption wiring fails**

```bash
npx vitest run \
  lib/services/analysis/v2-ai-scoring-executors.test.ts \
  lib/services/analysis/v2-dag-planner.test.ts \
  lib/services/analysis/v2-worker.test.ts
```

Expected before implementation: FAIL on absent caption inputs while existing topology tests stay green.

- [ ] **Step 3: Wire once per profile without network work**

Call `buildCarouselCaptionPolicy` from existing executor paths using `mediaPolicy(profile)` selections. Reuse `featureCaptions` plus one parent-caption fallback per post in feature input, `partnerCaptions` beside the existing contact sheet, and `carouselCaptionDossier` in the existing narrative input.

Never call an Instagram provider, Apify client, Gemini function, count-tokens endpoint, or new asynchronous task from this policy. Do not add a DAG stage, table, public result field, or user-visible raw caption.

- [ ] **Step 4: Update the cost/operations document**

Record:

```text
Incremental Apify Actor runs: 0
Incremental Apify dataset items: 0
Incremental Gemini generation calls: 0
Incremental DAG jobs: 0
Maximum additional displayed caption context per high-risk dossier: 2,000 characters
```

State that input-token billing can vary within the fixed cap and is validated through E2E total-cost and p95 non-regression, not claimed as literal zero token cost.

- [ ] **Step 5: Run the complete local quality gate**

```bash
npx vitest run \
  lib/domain/analysis/carousel-caption-policy.test.ts \
  lib/services/instagram/providers/apify.test.ts \
  lib/services/instagram/providers/selfhosted/mappers.test.ts \
  lib/services/analysis/v2-profile-fetch-store.test.ts \
  lib/services/analysis/v2-profile-fetch-migration-contract.test.ts \
  lib/services/ai/v2-staged-analysis.test.ts \
  lib/services/ai/stage-policy.test.ts \
  lib/services/analysis/v2-ai-scoring-executors.test.ts \
  lib/services/analysis/v2-dag-planner.test.ts \
  lib/services/analysis/v2-worker.test.ts
npx tsc --noEmit
npx eslint lib/types/instagram.ts \
  lib/domain/analysis/carousel-caption-policy.ts \
  lib/services/instagram/providers/apify.ts \
  lib/services/instagram/providers/selfhosted/mappers.ts \
  lib/services/analysis/v2-profile-fetch-store.ts \
  lib/services/ai/v2-staged-analysis.ts \
  lib/services/analysis/v2-ai-scoring-executors.ts
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 6: Commit, review, merge, deploy, and E2E-gate**

```bash
git add lib docs supabase/migrations
git commit -m "feat: analyze bounded carousel slide captions"
```

After spec and code-quality review, open a PR and merge only after CI. Apply the migration, deploy the reviewed worker revision, then run one `0_min._.00` E2E using the already-planned unused relationship slots. Verify followers 469, following 635, mutuals 383; no provider-run, dataset-item, Gemini-attempt, or DAG-job increase; result saved to the exact owner history; and total cost/time do not regress beyond normal provider variance. Finally disable temporary test access and sharding, restore production secret references, delete cookie/temp files, and stop local server/browser daemons.
