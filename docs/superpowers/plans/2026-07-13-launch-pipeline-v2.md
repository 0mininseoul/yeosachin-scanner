# Launch Pipeline V2 Implementation Plan

**Date:** 2026-07-13

**Status:** Phase A-C contracts, guarded preflight, and durable job foundation implemented and validated; Phase D is in progress

**Branch reviewed:** `agent/launch-correctness-performance`

**Target:** a truthful, resumable, self-hosted-profile-first Instagram analysis that can return a complete result for its advertised plan scope within five minutes before payment integration is enabled.

## 1. Executive Decision

Build V2 beside the existing pipeline and move new test requests behind a feature flag. Do not rewrite or delete the current Apify, RapidAPI, FlashAPI, or V1 execution paths until V2 passes live canaries.

V2 has four architectural changes:

1. A free, self-hosted-only target preflight runs before payment or paid crawling.
2. Analysis becomes a resumable Cloud Tasks DAG instead of one request-wide sequential state machine.
3. Profile crawling checkpoints each username and sends only unresolved usernames to the paid fallback.
4. Gender triage, feature analysis, interaction evidence, score classification, and narrative generation become separate versioned stages with explicit contracts.

## 2. Product Contract

### 2.1 Funnel

```text
target username submitted
  -> self-hosted-only target preflight starts immediately
  -> girlfriend username is entered or explicitly skipped while preflight runs
  -> target avatar, username, bio and relationship counts are shown
  -> server highlights the eligible plan; all plans remain visible
  -> test entitlement now / verified payment later
  -> immutable exclusion + plan snapshot
  -> first Cloud Task accepted
  -> background analysis progress
  -> paginated result
```

The expensive analysis does not wait idly for the girlfriend field: target preflight is already running. The paid/full pipeline does wait for an exclusion decision, so the girlfriend account is absent from relationship candidates, profile fetches, Gemini inputs, interaction joins, progress facts, and results from the first full-analysis job onward.

### 2.2 Plan semantics

| Plan | follower limit | following limit | detailed mutual limit |
|---|---:|---:|---:|
| Basic | 400 | 400 | 300 |
| Standard | 800 | 800 | 600 |
| Plus | 1,200 | 1,200 | 900 |

- The canonical launch status is separate from account capacity: `production`, `test_only`, or `disabled`. All three plans remain `test_only` until their E2E, five-minute, and measured-cost gates pass. A signed server-side test entitlement can exercise `test_only`; production callers cannot.
- Runtime configuration may only make a catalog status more restrictive. Promoting `test_only` to `production` requires a reviewed catalog change, so an environment override cannot bypass a failed launch gate.
- If the capacity-minimum plan is disabled but a higher plan is enabled, the server promotes the actual required plan to the next enabled tier. If no tier can serve the account, analysis is blocked while every card remains visible with a bounded reason.
- `follower/following limit` is an admission limit. A lower plan cannot be selected for a larger declared account.
- Both relationship lists must reach at least 99% of the declared count within the eligible plan. A capped list must never be labeled as the complete list.
- `detailed mutual limit` is not the relationship-list cap. The full mutual set is computed first. It is the maximum number of public mutual accounts that can enter feed-based AI screening in that plan.
- If the detailed limit is exceeded, V2 records and displays exact scope (`detected`, `screened`, `not screened`) and never calls the subset the whole account. The selection rule is deterministic newest-provider-order after exclusion and privacy split.
- Pricing values remain versioned server data. Final KRW values and the payment gateway are deliberately deferred until E2E and measured cost gates pass.
- Accounts over 1,200 followers or following are blocked before checkout and routed to a waitlist/manual quote.

### 2.3 Score policy V2

```text
candidate -> target likes       20
candidate -> target comments    26
target -> candidate likes        3
tag/caption mention             14
recent mutual                   17
appearance/exposure             20
total                          100
```

- Appearance grade: `0 / 3 / 7 / 10 / 13`.
- Exposure: `0..5`; the 18-point appearance-plus-exposure evidence is proportionally normalized to a 20-point component and capped at 20.
- Candidate-to-target likes score `20 * min(uniqueLikedTargetPosts / 4, 1)`.
- Candidate-to-target comments score `26 * min(boundedComments / 12, 1)`, where at most two unique comments per each of six target posts contribute.
- Target-to-candidate likes score is 3 only when the target is positively observed in the newest candidate post's first 100 likers. `not_collected` is not scored as observed zero.
- Tag/caption mention score is 14 when the target is explicitly tagged or mentioned in the selected candidate feed; repeated occurrences do not exceed 14.
- Recent verified mutual women ranks 1..10: `17,16,15,14,13,12,10,8,6,4`.
- Recent mutual badges are assigned after girlfriend exclusion and final female verification. The newest five women receive ranks 1..5, independent of non-female accounts in the relationship order.
- A confirmed business context applies `0.5` only to `recent mutual + appearance/exposure`. Observed likes, comments, tags, and mentions are not reduced.
- Partner evidence is separate from the 100-point positive-evidence sum. One two-person photo with a plausible peer-age man applies a provisional `-5` raw-score adjustment unless the model identifies a celebrity/public figure or clear older-relative context. Strong repeated partner evidence caps the public score at `3.4` and therefore keeps the account in the normal band while retaining observed interaction facts internally. A labeled evaluation may replace `-5` only through a new versioned score policy.
- The raw formula is `direct + businessAdjustedSoftContext + weakPartnerAdjustment`, clamped to `0..100`, where `direct=20+26+3+14` components and `softContext=recentMutual+appearanceExposure`. Strong partner evidence applies the normal-band cap after this calculation.
- `displayScore = round(1 + 9 * rawScore / 100, 1)`. Classification uses unrounded raw values.
- Normal: `< 4.2`; caution: `>= 4.2 and < 6.8`; high risk: `>= 6.8`.
- No minimum high-risk or caution count is forced. When no account crosses a threshold, the UI may show a separate `relativeWatch` list but must not relabel it high risk or caution.
- `riskBand` and `featuredRank` are separate. The high-risk feature section shows at most three accounts; the caution feature section shows at most fifteen. All rows retain their absolute score and band in the complete list.

### 2.4 Top-10 reverse-like scope

All verified women receive a preliminary 97-point score without `target -> candidate likes`. The global preliminary top ten are atomically checkpointed. Only those ten have the newest candidate post's first 100 likers collected, after which they are reranked inside the frozen shortlist.

This is named `verificationShortlist`, not an exact global final top ten. Non-shortlisted accounts store `reverseLikeStatus=not_collected` and `possibleUpperBound=preScore+3`; missing evidence is not represented as a confirmed negative. The three-point positive-only check can reorder the frozen shortlist but cannot pretend that an uncollected account received negative evidence.

### 2.5 Provider policy

| Capability | Production primary | Optional fallback |
|---|---|---|
| target profile/posts | self-hosted logged-out crawler | Apify profile actor |
| mutual public profiles/posts | cache, then self-hosted logged-out crawler | Apify unresolved usernames only |
| followers/following | Apify no-cookie relationship actor | operator-selected external provider |
| target post likers/comments | Apify interaction actor | disabled unless separately canaried |
| candidate post likers | Apify interaction actor | disabled unless separately canaried |

Self-hosted follower/following collection that requires Instagram login sessions stays disabled. FlashAPI, RapidAPI, CoderX, and existing Apify implementations remain selectable for canary or operator override but are not deleted.

## 3. What Already Exists

- Capability-level provider routing and external fallback in `lib/services/instagram/scraper.ts`.
- Logged-out self-hosted public profile/post collection under `providers/selfhosted`.
- Relationship completeness checks, provider run checkpoints, cost ledger, and reconciliation.
- Target liker/comment and candidate liker collection with the requested `4x150`, `6x15`, and `1x100` limits.
- Cloud Tasks background continuation and OIDC verification.
- Idempotent analysis start, request leases, failure cleanup, completion compaction, RLS, and sanitized result routes.
- Gemini token, latency, model, and estimated-cost telemetry.
- Target avatar on the result header, private-account name sorting, recent-mutual badges, and two-line high-risk narrative storage.

These are extended, not replaced wholesale.

## 4. Current Gaps

1. `collect -> profiles -> analyze -> interactions -> deep_analysis -> finalize` is fully sequential and protected by one request lease.
2. Target interactions wait for the final female set instead of staging bounded raw interactors in parallel.
3. One combined Gemini call performs gender and all deeper features for every public profile.
4. Gemini model and thinking level are process-wide, not stage-specific.
5. `InstagramPost` carries only one `imageUrl`; carousel children are discarded.
6. The self-hosted batch can silently omit a rejected/null per-username result, so the exact failure reason is lost; the durable fallback can then resend a full batch to Apify after partial success.
7. Current scoring is a 290-point mix, not the agreed 100-point policy.
8. Risk grades are rank quotas, so zero-evidence data still produces a high-risk account.
9. Recent-mutual scoring uses overall mutual order and result-time badges are inferred from a compact list of at most ten usernames.
10. Progress is a fixed percentage string polled every five seconds and cannot represent parallel work or event corrections.
11. Browser-driven execution remains a fallback; production users can still lose progress when background queueing is unavailable.
12. Plan rules are duplicated and stale in code, product docs, cost docs, my-page labels, and database comments.

The previous `0_min._.00` canaries did not show a total self-hosted crawler failure. Durable provider telemetry records self-hosted target-profile success and profile batches of `30/30`, `30/30`, `15/16`, followed by another uncached batch of `17/18`. The unresolved username's terminal reason was not retained, so that one omission cannot be attributed to a specific HTTP, parsing, privacy, or rate-limit cause. The run also exercised Apify profile fallback, while its initial pipeline failure was an Apify dataset-shape mismatch. V2 therefore treats only the exact missing cause as unknown, persists per-username terminal telemetry, and sends only the frozen unresolved username set to fallback.

## 5. Target Architecture

```text
Vercel UI/API
  |
  +-- preflight API -- self-hosted target profile only -- Supabase preflight
  |
  +-- entitlement/payment boundary
             |
             v
        Cloud Tasks coordinator
             |
     +-------+--------------------+
     |                            |
     v                            v
Track A: relationship/profile AI  Track B: target interactions
followers + following             target 4-post likers
mutual + privacy                   target 6-post comments
profile batches                    bounded raw interactor staging
gender triage
feature analysis
     |                            |
     +------------- join --------+
                   |
             97-point pre-score
             top-10 checkpoint
             candidate liker jobs
             final 100-point score
             partner safety pass
             high narratives max 3
             transactional finalize
```

The same Next.js image can initially be deployed as a private Cloud Run worker while Vercel remains the UI deployment. Cloud Tasks calls the worker endpoint with OIDC. This provides server-owned execution, a 300-second task boundary per small job, and default dynamic Cloud Run egress for the self-hosted crawler. Dynamic egress is not treated as guaranteed per-request IP rotation.

## 6. Canonical Contracts and SSOT

The first implementation commit creates these read-only frontend contracts:

- `lib/domain/analysis/plan-catalog.ts`: `PlanId`, limits, pricing version, eligibility.
- `lib/domain/analysis/risk-policy.ts`: score components, modifiers, thresholds, display mapping, policy version.
- `lib/domain/analysis/media-policy.ts`: eight-post/ten-feed-image selection, carousel coverage, and partner-safety contact candidates.
- `lib/domain/analysis/recent-female-mutual-policy.ts`: verified-woman-only recency points and badges.
- `lib/domain/analysis/profile-fetch-outcome.ts`: one terminal per-username provider outcome and unresolved-set derivation.
- `lib/domain/analysis/progress-policy.ts`: weighted work units, monotonic percentage, snapshot revision, and event sequence.
- `lib/domain/analysis/result-pagination.ts`: bounded deterministic public/private cursor pagination.
- `lib/domain/analysis/pipeline-version.ts`: fail-closed V1/V2 dual-read routing.
- `lib/contracts/analysis-v2.ts`: Zod schemas and inferred DTOs for preflight, progress, result, and error codes.
- `lib/services/ai/stage-policy.ts`: model, thinking, image, output, concurrency, and prompt/schema versions per AI stage.

Non-canonical copies in `docs/PRD.md`, `docs/AI_...md`, `docs/operations-cost-model.md`, `components`, `mypage`, and migrations must import, link to, or be generated from these canonical definitions where technically possible.

### SSOT audit

| Truth | Current occurrences | Finding | V2 action |
|---|---|---|---|
| plan limits | `plan-limits.ts`, PRD, Korean planning doc, cost doc, my-page labels, migration comments | contradictory 500/1,000 and Basic/Standard-only values | canonical plan catalog; docs reference versioned catalog |
| score weights | `scoring.ts`, `interaction-score.ts`, `step/route.ts`, planning docs | contradictory 190/100/290-point systems | canonical risk policy imported by scorer and tests |
| risk grade | `classifyRiskGrade`, finalize route, `ThreatBar` fixed 12/14-8/14-4/14 | rank bucket and visual score disagree | absolute band plus real numeric display score |
| model/thinking | `gemini-cost.ts`, `gemini.ts`, env flags, cost doc | global defaults cannot express stage policy | per-stage canonical model/thinking policy |
| progress | `steps.ts`, request columns, progress page, hook | duplicated fixed sequential percentages | V2 progress contract and generated copy matrix |
| media scope | `instagram.ts`, provider mappers, preprocessing limits, combined prompt | carousel children absent; limits only partially aligned | canonical media policy and selection hash |

## 7. API Contracts

### Preflight

`POST /api/analysis/preflight`

```ts
type PreflightRequestV1 = {
  targetInstagramId: string;
};

type PreflightAcceptedV1 = {
  schemaVersion: 1;
  preflightId: string;
  expiresAt: string;
  status: 'pending';
};

type PreflightStatusV1 =
  | { schemaVersion: 1; preflightId: string; status: 'pending'; expiresAt: string }
  | {
      schemaVersion: 1;
      preflightId: string;
      status: 'ready';
      expiresAt: string;
      target: {
    username: string;
    fullName: string | null;
    bio: string | null;
    profileImage: string | null;
    followersCount: number;
    followingCount: number;
    isPrivate: boolean;
      };
      requiredPlan: 'basic' | 'standard' | 'plus';
      plans: PlanQuoteV1[];
      pricingVersion: string;
    }
  | { schemaVersion: 1; preflightId: string; status: 'blocked'; code: string };
```

- `POST` persists the preflight, enqueues a free target-profile job, and returns `PreflightAcceptedV1` immediately. `GET /api/analysis/preflight/:id` returns `PreflightStatusV1`.
- The Cloud Run worker uses the self-hosted profile provider only with `fallback=false`, so target preflight and girlfriend input genuinely run in parallel and use the selected dynamic GCP egress path.
- No relationship, interaction, Gemini, or paid-provider ledger rows.
- Owner scoped, idempotent, 30-minute TTL, signed image proxy only.

`PATCH /api/analysis/preflight/:id`

- Stores one normalized `excludedInstagramId` or an explicit skip.
- Rejects the target username, malformed usernames, cross-owner access, and mutation after entitlement consumption.

### Test entitlement and later checkout

- Before payment work, an admin-only signed test entitlement consumes the preflight and creates V2 requests.
- Production never exposes a payment bypass.
- Later `POST /api/checkout` accepts only `preflightId`; the server recomputes plan and price.
- A verified webhook transaction creates exactly one analysis request with immutable plan, scope, price, exclusion, and policy versions, then activates processing only after the first task is accepted.

### Progress

```ts
type ProgressSnapshotV1 = {
  schemaVersion: 1;
  requestId: string;
  revision: number;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'upgrade_required';
  progressBp: number;
  backgroundProcessing: boolean;
  tracks: Record<'relationshipAi' | 'interactions' | 'finalization', {
    state: 'pending' | 'running' | 'completed' | 'failed';
    stageCode: string;
    done: number;
    total: number;
    progressBp: number;
  }>;
  activeProfile: { maskedUsername: string; imageUrl: string | null } | null;
  etaRange: { lowSeconds: number; highSeconds: number } | null;
  lastEventSeq: number;
};
```

`GET /api/analysis/progress/:id?afterSeq=N` returns the current snapshot plus allowlisted events. Realtime is an accelerator; sequence-based polling repairs gaps after disconnect, sleep, or app switching.

`activeProfile` is projected at read time from sanitized per-job start heartbeats. The profile-fetch provider emits a heartbeat immediately before a real self-hosted request (or one representative username when a remote fallback batch starts), and profile AI emits one immediately before each bounded candidate task. Each row contains only a masked username and `null` or a signed image-proxy path. Parallel work uses **latest-started among jobs whose exact lease is still live** semantics, ordered by `started_at`; a completed or expired job disappears automatically. This transient field can change without a DAG/event revision, so the client refreshes it on the five-second polling path and never treats it as evidence or a persisted finding.

Allowed events expose confirmed/provisional aggregate facts only. They never expose `step_data`, captions, comments, liker usernames, evidence counts, or raw scores. A spicy claim uses a provisional code until the final score checkpoint and can be corrected by a later event.

### Result

- Summary includes plan, declared/collected relationship coverage, detected mutuals, public/private counts, screened/detailed counts, exclusion applied, score policy version, and target avatar.
- Female rows include `displayScore`, `riskBand`, `featuredRank`, `recentMutualRank`, `analysisDepth`, and `oneLineOverview`.
- Component scores and interaction counts remain server-only.
- High narrative is returned only for featured high-risk rows and includes exactly two validated lines.
- Female and private rows use cursor pagination; the UI does not render 900+ rows in one DOM tree.
- Share DTO reuses the same sanitized mapper and limits bulk rows.

## 8. Database Migration

Additive migration first; V1 active requests continue on legacy tables and routes.

### New tables

1. `analysis_preflights`
   - owner, target snapshot, required plan, exclusion, status, idempotency key, expiry, pricing version.
2. `analysis_pipeline_jobs`
   - request, job key, track, kind, batch, status, input hash, lease fencing token, attempt count, timestamps, error code.
3. `analysis_profile_fetch_results`
   - request, username, source (`cache/selfhosted/apify`), status, bounded profile/media snapshot, failure category, capture time.
4. `analysis_candidate_ai_results`
   - request, username, stage (`triage/features/partner_safety`), model/thinking/prompt/schema versions, input hash, strict result.
5. `analysis_target_interactors`
   - bounded raw target-post liker/comment staging collected before gender is known; service-role only and purged at terminal state.
6. `analysis_progress_state` and `analysis_progress_events`
   - owner-readable sanitized state/events with monotonic revision and sequence.
7. `analysis_v2_active_profile_heartbeats`
   - service-only masked profile-start heartbeats, one per live profile job; owner progress reads project only the latest-started live row.

### Existing-table extensions

- `analysis_requests`: pipeline version, preflight id, excluded username, plan/pricing/scope snapshots, policy versions, coverage summary.
- `analysis_interaction_scores`: six components, soft context, business/partner modifiers, pre/final raw score, display score, shortlist status, reverse-like collection status, bounds, risk band, featured rank, score version.
- `analysis_results`: numeric one-decimal score, raw score, risk band, featured rank, persisted recent mutual rank, analysis depth, one-line overview, score version.
- Provider/Gemini operation-key constraints: accept V2 job keys without embedding usernames.
- Completion/failure RPCs: purge all V2 PII staging atomically while preserving PII-free job, cost, and latency telemetry.

All new staging tables deny anon/authenticated reads. Only sanitized progress and result paths are owner-readable.

## 9. Implementation Phases

### Phase A: Contract foundation

1. Add the canonical policy and Zod contract files.
2. Define `pipelineVersion=v2`, policy versions, error codes, DTO fixtures, and dual-read rules.
3. Add pure tests for plan eligibility, score boundaries, recent-woman rank, media selection, result pagination, and progress monotonicity.
4. Commit this as the frontend branch point. No UI implementation begins before this commit.

### Phase B: Preflight and exclusion

Implementation status: complete on the backend branch. The migration remains unapplied until the
test-project integration gate in Phase I.

1. Add migration, RLS, expiry, and idempotency for preflights.
2. Add asynchronous preflight POST/GET, self-hosted Cloud Run job, and exclusion route.
3. Add an internal signed test entitlement; keep payment out of scope.
4. Ensure preflight creates zero Gemini, relationship, interaction, or paid-provider usage.

### Phase C: V2 job foundation

Implementation status: complete on the backend branch. The additive migration remains unapplied
until Phase I. The execution capability stays `preflight_only` until the Phase D-G handlers and
the independent recovery scheduler are connected and verified.

1. Add per-job leases and deterministic task names.
2. Extend Cloud Tasks payload to `{requestId, jobKey}` and add a V2 worker dispatcher.
3. Keep the V1 request-wide lease untouched.
4. Add coordinator fan-out/join logic and terminal cleanup.
5. Make queue acceptance mandatory for production V2; browser execution remains local-development-only.

### Phase D: Profile media and unresolved-only fallback

1. Extend `InstagramPost` with ordered `mediaItems`; keep `imageUrl` as a compatibility alias.
2. Parse self-hosted carousel children and reel/video display thumbnails.
3. Parse only fixture-proven Apify child fields; fail closed on unknown schemas.
4. Select the latest eight posts and ten feed images deterministically: one representative per post, then two additional images from the newest carousel so first/middle/last are represented when it has at least three items.
5. For risk-shortlisted accounts, build a bounded low-resolution carousel contact sheet to catch partner evidence outside the selected three frames while reverse-like work runs in parallel.
6. Emit exactly one terminal outcome for every requested username and provider attempt: `success`, `unavailable`, or `failed`, with a bounded category and latency. Rejected promises, `data.user=null`, schema failures, and transport failures must never disappear from `Promise.allSettled` aggregation.
7. Persist each cache/self-hosted outcome before freezing the unresolved username set. Send exactly that set to one durable paid Actor and merge by username once.
8. Repeat the `0_min._.00` canary only after this telemetry is deployed; use the new evidence to diagnose the missing profile instead of assigning a retrospective cause.

### Phase E: Two-stage Gemini

1. Add per-call model, thinking level, media resolution, output limit, JSON schema, stage metadata, and a process-shared concurrency limit of 10 to the Gemini wrapper. Stage limits remain lower where configured.
2. Stage 1 triage: `gemini-3.1-flash-lite`, `MINIMAL`, profile plus four representative feed images, tiny gender/owner schema. Exclude only high-confidence male results.
3. Stage 2 features: initially `gemini-3.1-flash-lite`, routed female/unknown/borderline accounts, profile plus ten selected feed images, `MEDIUM`; return final gender, appearance, exposure, business, marriage/partner evidence, one-line overview, and evidence IDs. A labeled A/B can promote this stage to Gemini 3 Flash only when the accuracy gain justifies its latency and cost.
4. High narrative: Gemini 3 Flash, featured high-risk accounts only, maximum three calls in parallel, `HIGH`, profile image, selected feed images, bio, captions, validated interaction facts, and actual sanitized comment text. Stage 2 stores one private, content-addressed normalized-media bundle per verified woman, rather than one GCS object per image, and the narrative reuses that bundle without another download/decode of Instagram media. Terminal cleanup deletes the exact object generation.
5. Cache triage and features separately by model, prompt/schema version, and media snapshot hash. V1 combined cache is a V2 miss.
6. Run an independent human-labeled A/B. Do not treat Stage 2 as Stage 1 ground truth. Keep `MINIMAL` only if the false-female quality gate passes.

This intentionally creates multiple calls for routed accounts: Stage 1, then Stage 2, and one additional high-thinking narrative call only for featured high-risk accounts. The separation avoids running medium/high reasoning and eleven-image analysis on clearly male accounts.

Google's current model documentation confirms that `gemini-3.1-flash-lite` accepts image inputs, supports structured output, and supports `MINIMAL`, `LOW`, `MEDIUM`, and `HIGH` thinking levels. The image-generation model is not used for classification.

### Phase F: Parallel evidence tracks

1. After the target snapshot, enqueue relationship collection and target liker/comment collection concurrently.
2. Store bounded target interactors without requiring the female set.
3. Stream profile batches into Stage 1 and Stage 2; do not wait for all profiles before starting AI.
4. Run private-account name analysis after the privacy split in parallel with public profile/AI work.
5. Join interactors to the final verified female set after both tracks finish.
6. Compute the 97-point pre-score globally, freeze the top ten, and collect candidate latest-post likers.
7. Compute the final score, absolute band, featured rank, and relative-watch list.

### Phase G: Narrative and finalization

1. Generate narrative input from bounded structured facts and sanitized real comments.
2. Include the profile image, selected feed images, bio, captions, target-like/comment facts, target-to-candidate-like fact, and matched comment text in the high-risk call; reuse prepared media rather than fetching it again.
3. Output schema: exactly two Korean lines, each with allowlisted evidence references.
4. First line describes the visible account style concretely; second line addresses target relationship evidence and quotes/summarizes a real comment when present.
5. The tone can be cynical, witty, provocative, and hypothesis-driven, but every relationship sentence must contain an evidence reference and cannot turn a hypothesis into a factual affair claim.
6. Reject unsupported interaction directions, invented relationships, internal metrics, handles, URLs, email, and phone numbers. Invalid output gets one deterministic cynical fallback, not another billed generation.
7. Persist score, band, featured rank, recent-woman rank, overview, and narrative, then complete and purge staging transactionally.

### Phase H: Progress and result UI integration

1. Publish monotonic work-unit progress from the DAG, not fixed sequential thresholds.
2. Add masked active-profile display, parallel track status, percent, ETA range, and an event feed with provisional/correction states.
3. Increment snapshot revision on every durable DAG/event semantic change, including terminal status and event sequence, even when the numeric percentage is unchanged. Event sequences are contiguous at append time. Active-profile heartbeats are transient companion state and use latest-started-live-job ordering rather than the DAG revision.
4. Hydrate from snapshot first, subscribe to Realtime second, then fetch any event sequence gap. Fall back to five-second polling, which also refreshes transient active-profile state.
5. Add plan/scope coverage to results, real 1.0-10.0 score bars, separate featured sections, one-line overview reveal, empty-high-risk state, pagination, and virtualized long lists.
6. Preserve reduced-motion, mobile layout, image failure, reconnect, error, and browser-return states.

### Phase I: Measurement and E2E

1. Apply migrations to a test project and configure Cloud Tasks/Cloud Run plus the bounded
   preflight-retention scheduler through GCP CLI.
2. Provision the media-artifact bucket in the worker region with uniform bucket-level access,
   enforced public-access prevention, soft delete and Object Versioning disabled, an unconditional
   `Age=1` Delete lifecycle, and worker-only object create/get/delete IAM. Verify every property
   before enabling V2 execution. Exact-generation terminal cleanup is primary; lifecycle is only
   the asynchronous backstop for an upload whose database registration remains ambiguous.
3. Run provider, RLS, migration, task-idempotency, and cleanup integration suites.
4. Test `0_min._.00` first and record every stage latency, provider source, returned/declared counts, fallback username set, Gemini calls/tokens/thinking, cost, and total wall time.
5. Repeat Basic/Standard/Plus synthetic or consented fixtures under concurrent load. A single successful canary is not a launch gate.
6. Only after E2E and cost reconciliation pass, implement payment checkout/webhook as the last phase.

## 10. Frontend Parallel Work

Frontend starts immediately after **Phase A is committed and pushed**, not before the crawler or DAG is complete.

Create a separate worktree from that exact contract commit:

```bash
git worktree add ../ai-baram-detector-frontend -b feat/launch-funnel-ui <contract-commit>
```

### Ownership boundary

Backend branch owns:

- `app/api/**`
- `supabase/**`
- `lib/services/analysis/**`
- `lib/services/instagram/**`
- `lib/services/ai/**`
- canonical domain and contract files

Frontend branch owns:

- `app/page.tsx`
- `app/analyze/**`
- `app/progress/**`
- `app/result/**`
- `app/share/**`
- `app/mypage/**`
- `components/**`
- progress/result hooks

The frontend imports the contract file read-only and develops against committed fixtures. It must not hardcode plan limits, prices, progress codes, or risk thresholds.

Required frontend fixtures before live integration:

- preflight pending, ready, private target, missing target, and over-Plus target;
- all three plan cards with exactly one eligible/highlighted state;
- no women, no high risk, high-risk top three, caution overflow, and Stage-1-only scope rows;
- provisional risk event followed by correction and confirmed event;
- active profile image missing, Realtime sequence gap, polling recovery, browser return after completion, and terminal failure;
- 900-row pagination/virtualization and reduced-motion mobile rendering.

### Integration order

1. Contract foundation merges into both branches.
2. Backend preflight/DAG/result API merges into an integration branch first.
3. Frontend rebases onto the integration branch and replaces fixture adapters with live endpoints.
4. Playwright runs on mobile and desktop, including browser close/return and Realtime gap recovery.
5. The combined branch receives code review before main.

## 11. Test and Launch Gates

### Correctness

- Relationship lists independently achieve at least 99% unique coverage or no final result is generated.
- Self-hosted successes plus Apify unresolved results merge with zero missing and zero duplicates.
- Every provider batch persists one terminal per-username outcome before fallback selection; no rejected/null item is silently omitted.
- The Apify input username set exactly equals the persisted unresolved set.
- The girlfriend username appears in no profile, AI, interaction, score, progress fact, result, or share payload.
- Recent points apply only to verified women; the newest five verified women receive the badges.
- All-low-evidence fixtures produce zero high-risk accounts.
- Business reduction touches soft context only.
- Non-shortlisted reverse likes are marked `not_collected`, not zero-observed.

### AI quality

- Independent labeled set, not model-generated truth.
- False-female rate at most 1% with a reported confidence interval.
- Female recall at least 95%.
- Structured response success at least 99.9% after schema validation.
- Unsupported interaction or relationship claims in narrative: zero.
- Narrative line count, length, Korean output, evidence references, and redaction: 100% valid.

### Resilience and privacy

- Duplicate task delivery and retry do not duplicate provider charges, progress events, or results.
- Browser close/lock for ten minutes does not stop server work.
- Reopen hydrates the latest snapshot and repairs event gaps.
- Network/Realtime payloads contain no raw comments, captions, liker usernames, evidence counts, raw component scores, or `step_data`.
- Completion and failure purge all new staging rows.

### Performance

- Preflight p95 under five seconds on cache miss.
- First confirmed useful progress fact under 60 seconds.
- Full result p95 target under 300 seconds for each enabled plan at its advertised limit.
- Higher plans remain disabled for launch if their load test misses the five-minute gate.
- Stage budgets are recorded rather than inferred: bootstrap 5s, parallel relationship/target evidence 60s, streamed profile+AI 150s, shortlist/reverse liker 45s, narrative/finalize 40s, 300s total ceiling.

### Cost

- Preflight produces zero paid-provider and Gemini cost.
- Every paid provider run has expectation, run ID, credential slot, input hash, actual/ceiling cost, and terminal reconciliation.
- Every Gemini call records stage, model, thinking, image count, latency, tokens, cache hit, and estimated cost.
- The measured 95th percentile cost for all three plans fits the price catalog before payment work starts.

## 12. Error and Rescue Registry

| Failure | User state | Rescue |
|---|---|---|
| target missing/private | preflight blocked | no charge; correct username |
| target count exceeds Plus | unsupported | waitlist/manual quote |
| count drifts over paid scope | upgrade required | stop before paid Actor; upgrade/refund |
| relationship coverage below 99% | processing failed | resume same run or one configured fallback; no partial result |
| self-hosted profile partial failure | processing continues | checkpoint successes; paid fallback unresolved only |
| both profile providers miss account | insufficient evidence | exclude verified unavailable row; otherwise fail scope gate |
| Gemini explicit 429 | delayed | bounded retry |
| Gemini ambiguous transport result | failed safely | do not replay a possibly billed generation |
| Stage 1/2 gender conflict | unresolved | no direct entry into female result; bounded adjudication/fallback policy |
| strong partner evidence | adjusted | public score capped at 3.4/normal; evidence retained internally |
| no threshold high risk | valid empty state | show truthful summary plus separate relative-watch list |
| queue unavailable | queued/failed | production does not switch to browser-paid execution |
| Realtime disconnect | stale UI only | sequence fetch plus polling recovery |
| payment webhook duplicate | no duplicate request | unique order consumption transaction |

## 13. Not In Scope Until E2E Passes

- Public payment checkout and webhook integration.
- Removing V1 routes, external providers, or legacy columns.
- Self-hosted follower/following collection with Instagram login cookies.
- Promising exact follow timestamps; provider order remains an inferred newest-first signal.
- Exposing raw interaction counts or evidence to the browser.
- Launching Plus if the measured five-minute and cost gates fail.

## 14. Implementation Tasks

1. Contract and policy SSOT with fixtures and boundary tests.
2. Preflight/exclusion schema, RLS, API, and zero-cost test.
3. V2 job table, leases, dispatcher, coordinator, and terminal purge.
4. Media-item mappers, carousel hydration, reel thumbnails, and selection tests.
5. Per-username crawler checkpoint and unresolved-only paid fallback.
6. Per-stage Gemini wrapper, triage, feature, cache, and labeled evaluation harness.
7. Parallel relationship/target-interaction tracks and join.
8. V2 score, shortlist, recent-woman policy, partner/business modifiers, and classification.
9. High narrative validator and deterministic fallback.
10. Sanitized progress state/events and result pagination API.
11. Frontend funnel, progress, result, share, and my-page V2 adaptations in the separate worktree.
12. Cloud Run/Tasks deployment, observability, canary, load, cost-model documentation update, and Playwright E2E.
13. Payment provider integration after all prior gates pass.

## 15. Review Decisions

- **CEO/product:** preserve all plan cards, auto-select the only eligible plan, and do not take payment before showing a real self-hosted target preview.
- **Design:** expose lively progress, but distinguish provisional signals from confirmed findings and support correction events.
- **Engineering:** add V2 beside V1, move from request-wide state to job rows, and freeze contracts before parallel implementation.
- **Data quality:** relationship completeness and analysis depth are first-class result fields; partial work is never described as complete.
- **User-direction challenge:** forcing at least one high-risk and caution account conflicts with absolute thresholds. V2 keeps absolute bands and uses a separately labeled relative-watch section instead.
- **Partner calibration:** V2.2 uses a provisional `-5` weak male-companion adjustment. The strong-partner confidence threshold and any later adjustment change require labeled fixtures and a new policy version; the strong-evidence outcome itself remains fixed as a normal-band cap.

### Deferred decisions that do not block Phase A

- Final Basic/Standard/Plus KRW prices and payment provider.
- Strong-partner confidence threshold and validation of the provisional `-5` adjustment from the labeled evaluation.
- Whether Stage 2 remains Flash-Lite medium or moves to Gemini 3 Flash medium after the A/B.
- Cloud Run region, CPU/memory, queue concurrency, and Gemini quota after GCP CLI inspection.
- Whether Standard/Plus are launch-enabled; each must independently pass the five-minute and cost gates.

## GSTACK REVIEW REPORT

### Review coverage

- CEO scope and funnel: reviewed.
- Design information architecture, state coverage, mobile/reconnect behavior: reviewed.
- Engineering architecture, data flow, failure recovery, performance, tests, rollout, and worktree parallelization: reviewed.
- External fact check: official Google model and thinking capability documentation checked on 2026-07-13.
- SSOT check: plan, score, model, and progress definitions are currently duplicated; canonical homes and reconciliation actions are specified above.

### Readiness

- Product contract: ready, with payment price values intentionally deferred.
- Backend contracts: Phase A and the guarded Phase B endpoints are implemented and validated.
- Frontend: ready to start only after the Phase A contract commit.
- Production launch: blocked on V2 implementation, labeled AI evaluation, full E2E, load/cost gates, and payment integration.

### Sources checked

- Gemini 3.1 Flash-Lite model: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite
- Gemini thinking levels: https://ai.google.dev/gemini-api/docs/thinking
