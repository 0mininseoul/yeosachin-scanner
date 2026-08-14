import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ApifyClient } from 'apify-client';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { makeApifyProvider } from '@/lib/services/instagram/providers/apify';
import { makeApifyInteractionAdapter } from '@/lib/services/instagram/providers/apify-interactions';
import { createAnalysisV2SelectedMediaNormalizer } from '@/lib/services/ai/image-preprocessing';
import { AI_STAGE_POLICY_V211_VERSION } from '@/lib/services/ai/stage-policy';
import { createReplayStagedAiAdapter } from '@/lib/services/analysis/replay/replay-staged-ai-adapter';
import { captureAnalysisV2ReplayBundle } from '@/lib/services/analysis/replay/replay-capture';
import type { AnalysisV2ReplayBundle } from '@/lib/services/analysis/replay/replay-bundle';
import { FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY } from '@/lib/services/analysis/replay/replay-source-lineage';
import { runAnalysisV2AiReplay, type ReplayAccountAiDetail } from '@/lib/services/analysis/replay/replay-runner';
import { extractRawTargetInteractions } from '@/lib/services/analysis/v2-target-interactions';
import { instagramPostUrl, selectRecentInteractionPosts } from '@/lib/services/analysis/interaction-posts';
import {
    buildCanonicalConciergeResult,
    deriveConciergePrivacyPartition,
    validateCanonicalConciergeCorrection,
    type ConciergeTargetPostMentionEvidence,
    type ConciergeRelationshipEvidence,
} from '@/lib/services/analysis/concierge-basic-correction';
import { selectConciergeSourceRequest } from '@/lib/services/analysis/concierge-source-scope';
import { isAnalysisResultOperator, resolveAnalysisResultOwner } from '@/lib/services/analysis/result-operator-access';
import { requireActiveAccountClassification } from '@/lib/services/identity/account-principal-store';
import type { InstagramFollower, InstagramProfile } from '@/lib/types/instagram';

const SAMPLE_START = '2026-08-12T09:07:00.000Z';
const SAMPLE_END = '2026-08-12T09:08:00.000Z';
const RELATIONSHIP_LIMIT = 1_200;
const PROFILE_BATCH_SIZE = 30;
const CANONICAL_WORKDIR = '/private/tmp/fresh-admission-v3-supabase.yfdl1o';
const BASIC_SOURCE_LINEAGE = Object.freeze({
    selectedPlanId: 'basic',
    policyVersions: {
        pipeline: 'v2',
        aiStage: AI_STAGE_POLICY_V211_VERSION,
        risk: 'risk-policy-v2.5',
        scheduler: 'ai-scheduler-v1',
    },
} as const);
const conciergeEvaluationPolicy = Object.freeze({
    capability: FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY,
    aiStage: AI_STAGE_POLICY_V211_VERSION,
} as const);

const targetEvidenceRowSchema = z.object({
    actorUsername: z.string().trim().min(1).max(30),
    postId: z.string().min(1).max(255),
    signal: z.enum(['target_post_like', 'target_post_comment']),
    sourceInteractionId: z.string().min(1).max(255),
    occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
    content: z.string().max(1_000).nullable().optional(),
}).strict();

type TargetEvidenceRow = z.infer<typeof targetEvidenceRowSchema>;
type ApifySlot = 'tertiary' | 'secondary' | 'primary';
type ProviderLineage = { slot: ApifySlot; runIds: string[] };
type FreshRelationship = {
    rows: readonly InstagramFollower[];
    uniqueCount: number;
    duplicateCount: number;
    lineage: ProviderLineage;
};

function normalizedUsername(value: string): string {
    return value.trim().replace(/^@/, '').toLowerCase();
}

function sha256(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    return /^([A-Z][A-Z0-9_]{2,119})/.exec(message)?.[1] ?? 'CONCIERGE_EXACT_CORRECTION_FAILED';
}

function sqlString(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

function checkpointProfile(profile: InstagramProfile) {
    const latestPosts = profile.latestPosts === undefined
        ? undefined
        : [...profile.latestPosts]
            .sort((left, right) => (
                Date.parse(right.timestamp) - Date.parse(left.timestamp)
                || left.id.localeCompare(right.id)
            ))
            .slice(0, 8);
    return {
        ...profile,
        ...(latestPosts === undefined ? {} : { latestPosts }),
    };
}

function isQuotaError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('SCRAPING_PROVIDER_QUOTA_ERROR');
}

function tokenFor(slot: ApifySlot): string | null {
    return process.env[`APIFY_${slot.toUpperCase()}_API_TOKEN`]?.trim() || null;
}

function makeDirectProvider(slot: ApifySlot, token: string) {
    // The relationship adapter accepts only primary/secondary as its legacy static
    // definition, while the client itself is explicitly pinned to the selected token.
    // This keeps the incident's tertiary-first priority without changing production code.
    const adapterSlot = slot === 'secondary' ? 'secondary' : 'primary';
    const env = {
        APIFY_API_TOKEN_SLOT: adapterSlot,
        APIFY_API_TOKEN: token,
        APIFY_SECONDARY_API_TOKEN: token,
        APIFY_RELATIONSHIP_BUILD: '0.0.71',
    };
    return makeApifyProvider({
        env,
        client: new ApifyClient({ token, maxRetries: 0 }),
    });
}

async function collectRelationshipSide(
    targetUsername: string,
    side: 'followers' | 'following',
): Promise<FreshRelationship> {
    const slots: ApifySlot[] = ['tertiary', 'secondary', 'primary'];
    let lastError: unknown;
    for (const slot of slots) {
        const token = tokenFor(slot);
        if (!token) continue;
        const runIds: string[] = [];
        try {
            const provider = makeDirectProvider(slot, token);
            const context = {
                credentialSlot: slot === 'secondary' ? 'secondary' as const : 'primary' as const,
                maxChargeUsd: 1.5,
                recordUsage: () => undefined,
                onRunStarted: (runId: string) => { runIds.push(runId); },
            };
            const rows = side === 'followers'
                ? await provider.getFollowers!(targetUsername, RELATIONSHIP_LIMIT, context)
                : await provider.getFollowing!(targetUsername, RELATIONSHIP_LIMIT, context);
            const seen = new Set<string>();
            let duplicateCount = 0;
            const normalizedRows = rows.flatMap(row => {
                const username = normalizedUsername(row.username);
                if (!username || seen.has(username)) {
                    duplicateCount++;
                    return [];
                }
                seen.add(username);
                return [{ ...row, username }];
            });
            return {
                rows: Object.freeze(normalizedRows),
                uniqueCount: seen.size,
                duplicateCount,
                lineage: { slot, runIds },
            };
        } catch (error) {
            lastError = error;
            if (!isQuotaError(error)) throw error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('CONCIERGE_APIFY_TOKEN_UNAVAILABLE');
}

function makeProfileContext(slot: ApifySlot, runIds: string[]) {
    return {
        credentialSlot: slot === 'secondary' ? 'secondary' as const : 'primary' as const,
        maxChargeUsd: 0.12,
        recordUsage: () => undefined,
        onRunStarted: (runId: string) => { runIds.push(runId); },
    };
}

async function hydrateExactMutualProfiles(
    usernames: readonly string[],
): Promise<{ profiles: readonly InstagramProfile[]; unresolved: readonly string[]; lineage: ProviderLineage }> {
    const profiles = new Map<string, InstagramProfile>();
    const runIds: string[] = [];
    let selectedSlot: ApifySlot | null = null;
    let lastAvailableSlot: ApifySlot | null = null;
    for (const slot of ['tertiary', 'secondary', 'primary'] as const) {
        const token = tokenFor(slot);
        if (!token) continue;
        lastAvailableSlot = slot;
        const provider = makeDirectProvider(slot, token);
        try {
            for (let offset = 0; offset < usernames.length; offset += PROFILE_BATCH_SIZE) {
                const batch = usernames.slice(offset, offset + PROFILE_BATCH_SIZE)
                    .filter(username => !profiles.has(username));
                if (!batch.length) continue;
                const outcomes = await provider.getProfilesBatchOutcomes!(
                    [...batch],
                    PROFILE_BATCH_SIZE,
                    makeProfileContext(slot, runIds),
                );
                for (const outcome of outcomes) {
                    if (outcome.outcome.status === 'success' && 'profile' in outcome) {
                        selectedSlot = slot;
                        profiles.set(normalizedUsername(outcome.profile.username), outcome.profile);
                    }
                }
            }
            const unresolvedAfterBatch = usernames.filter(username => !profiles.has(username));
            for (const username of unresolvedAfterBatch) {
                for (let attempt = 0; attempt < 2 && !profiles.has(username); attempt++) {
                    try {
                        const profile = await provider.getProfile!(
                            username,
                            makeProfileContext(slot, runIds),
                        );
                        if (profile) {
                            selectedSlot = slot;
                            profiles.set(normalizedUsername(profile.username), profile);
                        }
                    } catch (error) {
                        if (!isQuotaError(error)) throw error;
                    }
                }
            }
            if (profiles.size === usernames.length) break;
        } catch (error) {
            if (!isQuotaError(error)) throw error;
        }
    }
    if (!selectedSlot) selectedSlot = lastAvailableSlot;
    if (!selectedSlot) throw new Error('CONCIERGE_PROFILE_TOKEN_UNAVAILABLE');
    const unresolved = usernames.filter(username => !profiles.has(username));
    return {
        profiles: Object.freeze([...profiles.values()]),
        unresolved: Object.freeze(unresolved),
        lineage: { slot: selectedSlot, runIds },
    };
}

function makeDirectInteractionAdapter(slot: ApifySlot, token: string) {
    const adapterSlot = slot === 'secondary' ? 'secondary' : 'primary';
    const env = {
        APIFY_API_TOKEN_SLOT: adapterSlot,
        APIFY_API_TOKEN: token,
        APIFY_SECONDARY_API_TOKEN: token,
    };
    return makeApifyInteractionAdapter({
        env,
        client: new ApifyClient({ token, maxRetries: 0 }),
    });
}

type ReviewedTargetSnapshot = {
    targetPosts: readonly ConciergeTargetPostMentionEvidence[];
    persistedTargetPosts: readonly Readonly<{
        id: string;
        taggedUsers: readonly string[];
        mentionedUsers: readonly string[];
    }>[];
    targetEvidence: readonly TargetEvidenceRow[];
    lineage: ProviderLineage;
};

/** Collects the reviewed target surface in the correction run; no failed-request staging read. */
async function collectReviewedTargetSnapshot(
    targetUsername: string,
): Promise<ReviewedTargetSnapshot> {
    let lastError: unknown;
    for (const slot of ['tertiary', 'secondary', 'primary'] as const) {
        const token = tokenFor(slot);
        if (!token) continue;
        const runIds: string[] = [];
        try {
            const provider = makeDirectProvider(slot, token);
            const targetProfile = await provider.getProfile!(
                targetUsername,
                makeProfileContext(slot, runIds),
            );
            if (!targetProfile || normalizedUsername(targetProfile.username) !== normalizedUsername(targetUsername)) {
                throw new Error('CONCIERGE_TARGET_PROFILE_SCOPE_CONFLICT');
            }
            const sourcePosts = selectRecentInteractionPosts(
                [...(targetProfile.latestPosts ?? [])],
                8,
            );
            if (sourcePosts.length === 0) {
                throw new Error('CONCIERGE_TARGET_POSTS_UNAVAILABLE');
            }
            const persistedTargetPosts = sourcePosts.map(post => Object.freeze({
                id: post.id,
                taggedUsers: Object.freeze([...post.taggedUsers].map(normalizedUsername)),
                mentionedUsers: Object.freeze([...post.mentionedUsers].map(normalizedUsername)),
            }));
            const targetPosts = persistedTargetPosts.map(post => Object.freeze({
                taggedUsers: [...post.taggedUsers],
                mentionedUsers: [...post.mentionedUsers],
            }));
            const likerPosts = selectRecentInteractionPosts(sourcePosts, 4).map(instagramPostUrl);
            const commentPosts = selectRecentInteractionPosts(sourcePosts, 6).map(instagramPostUrl);
            const interactionContext = {
                credentialSlot: slot === 'secondary' ? 'secondary' as const : 'primary' as const,
                maxChargeUsd: 2,
                recordUsage: () => undefined,
                onRunStarted: (runId: string) => { runIds.push(runId); },
            };
            const interactionProvider = makeDirectInteractionAdapter(slot, token);
            const [likers, comments] = await Promise.all([
                interactionProvider.getPostLikers(likerPosts, 150, interactionContext),
                interactionProvider.getPostComments(commentPosts, 15, interactionContext),
            ]);
            const extracted = extractRawTargetInteractions({
                targetPosts: sourcePosts,
                likers,
                comments,
                excludedUsernames: [normalizedUsername(targetUsername)],
            });
            const targetEvidence = extracted.evidence.map(row => targetEvidenceRowSchema.parse({
                actorUsername: normalizedUsername(row.actorUsername),
                postId: row.postId,
                signal: row.signal,
                sourceInteractionId: row.sourceInteractionId,
                occurredAt: row.occurredAt ?? null,
                content: row.content ?? null,
            }));
            if (targetEvidence.length !== 95) {
                throw new Error('CONCIERGE_TARGET_EVIDENCE_SNAPSHOT_INCOMPLETE');
            }
            return {
                targetPosts: Object.freeze(targetPosts),
                persistedTargetPosts: Object.freeze(persistedTargetPosts),
                targetEvidence: Object.freeze(targetEvidence),
                lineage: { slot, runIds },
            };
        } catch (error) {
            lastError = error;
            if (!isQuotaError(error)) throw error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('CONCIERGE_TARGET_SNAPSHOT_UNAVAILABLE');
}

export function parseReviewedTargetEvidence(value: unknown): readonly TargetEvidenceRow[] {
    if (!Array.isArray(value)) {
        throw new Error('CONCIERGE_TARGET_EVIDENCE_UNAVAILABLE');
    }
    const parsed = z.array(targetEvidenceRowSchema).safeParse(value);
    if (!parsed.success || parsed.data.length !== 95) {
        throw new Error('CONCIERGE_TARGET_EVIDENCE_UNAVAILABLE');
    }
    return Object.freeze(parsed.data.map(row => Object.freeze(row)));
}

function relationshipEvidence(
    side: 'followers' | 'following',
    rows: readonly InstagramFollower[],
): ConciergeRelationshipEvidence[] {
    return rows.map((row, index) => ({
        username: normalizedUsername(row.username),
        side: side === 'followers' ? 'follower' : 'following',
        isPrivate: row.isPrivate,
        isVerified: row.isVerified,
        fullName: row.fullName ?? null,
        profilePicUrl: row.profilePicUrl ?? null,
        ordinal: index + 1,
    }));
}

export function buildAtomicPublicationSql(input: {
    orderId: string;
    requestId: string;
    femaleRows: readonly unknown[];
    privateRows: readonly unknown[];
    counts: { male: number; female: number; unknown: number };
    mutualFollows: number;
    lineage: Record<string, unknown>;
    reviewedSource: {
        sourceRequestId: string;
        ownerId: string;
        targetUsername: string;
        resultRequestId: string;
        targetPosts: readonly unknown[];
        targetEvidence: readonly unknown[];
    };
}): string {
    const sourceFingerprint = input.lineage.sourceFingerprint;
    if (typeof sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(sourceFingerprint)) {
        throw new Error('CONCIERGE_REVIEWED_SOURCE_FINGERPRINT_INVALID');
    }
    if (input.reviewedSource.resultRequestId !== input.requestId) {
        throw new Error('CONCIERGE_REVIEWED_SOURCE_SCOPE_CONFLICT');
    }
    const payload = JSON.stringify({ femaleRows: input.femaleRows, privateRows: input.privateRows });
    const requestId = sqlString(input.requestId);
    const orderId = sqlString(input.orderId);
    const payloadSql = `${sqlString(payload)}::jsonb`;
    const genderStats = `${sqlString(JSON.stringify(input.counts))}::jsonb`;
    const lineageSql = `${sqlString(JSON.stringify(input.lineage))}::jsonb`;
    const targetPostsSql = `${sqlString(JSON.stringify(input.reviewedSource.targetPosts))}::jsonb`;
    const targetEvidenceSql = `${sqlString(JSON.stringify(input.reviewedSource.targetEvidence))}::jsonb`;
    const resultHash = sha256({
        schema: 'concierge-result-publication-v1',
        sourceFingerprint,
        femaleRows: input.femaleRows,
        privateRows: input.privateRows,
        counts: input.counts,
        mutualFollows: input.mutualFollows,
    });
    const resultHashSql = sqlString(resultHash);
    const sourceFingerprintSql = sqlString(sourceFingerprint);
    const sourceRequestId = sqlString(input.reviewedSource.sourceRequestId);
    const ownerId = sqlString(input.reviewedSource.ownerId);
    const targetUsername = sqlString(input.reviewedSource.targetUsername);
return `BEGIN;
SELECT pg_catalog.set_config('app.earlybird_v211_concierge_publication_marker', '0', TRUE);
SELECT pg_catalog.set_config('app.earlybird_v211_concierge_publication_skip', '0', TRUE);
DO $guard$
DECLARE
  v_pointer uuid;
  v_order_user_id uuid;
  v_order_target text;
  v_order_status text;
  v_plan_id text;
  v_paid_at timestamptz;
  v_request_user_id uuid;
  v_request_target text;
  v_request_status text;
  v_pipeline_version text;
  v_reviewed_source_fingerprint text;
  v_published_source_fingerprint text;
  v_published_result_hash text;
BEGIN
  SELECT result_request_id, user_id, target_instagram_id, status, plan_id, paid_at
    INTO v_pointer, v_order_user_id, v_order_target, v_order_status, v_plan_id, v_paid_at
    FROM public.earlybird_orders WHERE id = ${orderId} FOR UPDATE;
  IF v_pointer IS DISTINCT FROM ${requestId}
     OR v_order_status <> 'completed' OR v_plan_id <> 'basic'
     OR v_paid_at < '${SAMPLE_START}'::timestamptz OR v_paid_at >= '${SAMPLE_END}'::timestamptz THEN
    RAISE EXCEPTION 'CONCIERGE_ATOMIC_SCOPE_CONFLICT';
  END IF;
  SELECT status, pipeline_version, user_id, target_instagram_id
    INTO v_request_status, v_pipeline_version, v_request_user_id, v_request_target
    FROM public.analysis_requests WHERE id = ${requestId} FOR UPDATE;
  IF v_request_status <> 'completed' OR v_pipeline_version <> 'v1' THEN
    RAISE EXCEPTION 'CONCIERGE_ATOMIC_REQUEST_SCOPE_CONFLICT';
  END IF;
  IF v_request_user_id IS NULL OR v_order_user_id IS NULL
     OR v_request_user_id IS DISTINCT FROM v_order_user_id
     OR v_request_target IS NULL OR v_order_target IS NULL
     OR lower(btrim(v_request_target)) IS DISTINCT FROM lower(btrim(v_order_target)) THEN
    RAISE EXCEPTION 'CONCIERGE_ATOMIC_IDENTITY_SCOPE_CONFLICT';
  END IF;
  SELECT reviewed_source_fingerprint, published_source_fingerprint, published_result_hash
    INTO v_reviewed_source_fingerprint, v_published_source_fingerprint, v_published_result_hash
    FROM public.earlybird_v211_concierge_replays
   WHERE order_id = ${orderId}
   FOR UPDATE;
  IF v_reviewed_source_fingerprint IS NOT NULL
     AND v_reviewed_source_fingerprint <> ${sourceFingerprintSql} THEN
    RAISE EXCEPTION 'CONCIERGE_PUBLICATION_CAS_CONFLICT';
  END IF;
  IF v_published_source_fingerprint IS NOT NULL THEN
    IF v_published_source_fingerprint = ${sourceFingerprintSql}
       AND v_published_result_hash = ${resultHashSql} THEN
      PERFORM pg_catalog.set_config('app.earlybird_v211_concierge_publication_skip', '1', TRUE);
    ELSE
      RAISE EXCEPTION 'CONCIERGE_PUBLICATION_CAS_CONFLICT';
    END IF;
  END IF;
END $guard$;
DO $completeness_guard$
BEGIN
  IF COALESCE((
      (${lineageSql})->'relationship'->>'completenessProven'
    )::boolean, FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION 'CONCIERGE_RELATIONSHIP_SNAPSHOT_INCOMPLETE';
  END IF;
END $completeness_guard$;
DO $register_reviewed_source$
BEGIN
  PERFORM public.register_earlybird_v211_concierge_reviewed_source(
    ${orderId}::uuid, ${sourceRequestId}::uuid, ${requestId}::uuid, ${ownerId}::uuid,
    ${targetUsername}, ${sourceFingerprintSql}, ${targetPostsSql}, ${targetEvidenceSql}
  );
END $register_reviewed_source$;
DO $cas$
DECLARE
  v_reviewed_source_fingerprint text;
  v_published_source_fingerprint text;
  v_published_result_hash text;
BEGIN
  IF pg_catalog.current_setting('app.earlybird_v211_concierge_publication_skip', TRUE) = '1' THEN
    RETURN;
  END IF;
  SELECT reviewed_source_fingerprint, published_source_fingerprint, published_result_hash
    INTO v_reviewed_source_fingerprint, v_published_source_fingerprint, v_published_result_hash
    FROM public.earlybird_v211_concierge_replays
   WHERE order_id = ${orderId}
   FOR UPDATE;
  IF v_reviewed_source_fingerprint IS DISTINCT FROM ${sourceFingerprintSql}
     OR v_published_source_fingerprint IS NOT NULL
     OR v_published_result_hash IS NOT NULL THEN
    RAISE EXCEPTION 'CONCIERGE_PUBLICATION_CAS_CONFLICT';
  END IF;
  PERFORM pg_catalog.set_config('app.earlybird_v211_concierge_publication_marker', '1', TRUE);
  UPDATE public.earlybird_v211_concierge_replays
     SET published_source_fingerprint = ${sourceFingerprintSql},
         published_result_hash = ${resultHashSql},
         published_at = pg_catalog.clock_timestamp()
   WHERE order_id = ${orderId}
     AND reviewed_source_fingerprint = ${sourceFingerprintSql}
     AND published_source_fingerprint IS NULL
     AND published_result_hash IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONCIERGE_PUBLICATION_CAS_CONFLICT';
  END IF;
END $cas$;
DO $write$
BEGIN
  IF pg_catalog.current_setting('app.earlybird_v211_concierge_publication_skip', TRUE) = '1' THEN
    RETURN;
  END IF;
  DELETE FROM public.analysis_results WHERE request_id = ${requestId};
  INSERT INTO public.analysis_results (
  request_id, rank, suspect_instagram_id, suspect_profile_image, suspect_full_name, bio,
  risk_score, photogenic_grade, exposure_level, is_tagged, risk_grade, gender_confidence,
  gender_status, is_unlocked, likes_count, intimate_comments_count, one_line_overview, risk_analysis
  )
  SELECT ${requestId}, rank, suspect_instagram_id, suspect_profile_image, suspect_full_name, bio,
  risk_score, photogenic_grade, exposure_level, is_tagged, risk_grade, gender_confidence,
  gender_status, is_unlocked, likes_count, intimate_comments_count, one_line_overview, risk_analysis
  FROM jsonb_to_recordset(${payloadSql}->'femaleRows') AS rows(
  rank integer, suspect_instagram_id text, suspect_profile_image text, suspect_full_name text,
  bio text, risk_score integer, photogenic_grade integer, exposure_level text, is_tagged boolean,
  risk_grade text, gender_confidence double precision, gender_status text, is_unlocked boolean,
  likes_count integer, intimate_comments_count integer, one_line_overview varchar(180), risk_analysis jsonb
  );
  DELETE FROM public.private_accounts WHERE request_id = ${requestId};
  INSERT INTO public.private_accounts (
  request_id, instagram_id, profile_image, full_name, name_female_score, name_is_name, name_confidence
  )
  SELECT ${requestId}, instagram_id, profile_image, full_name, name_female_score, name_is_name, name_confidence
  FROM jsonb_to_recordset(${payloadSql}->'privateRows') AS rows(
  instagram_id text, profile_image text, full_name text, name_female_score double precision,
  name_is_name boolean, name_confidence double precision
  );
  UPDATE public.analysis_requests
   SET status = 'completed', progress = 100, progress_step = '분석 완료!',
       mutual_follows = ${input.mutualFollows},
       opposite_gender_count = ${input.counts.female}, gender_stats = ${genderStats},
       step_data = jsonb_set(
         CASE WHEN jsonb_typeof(step_data) = 'object' THEN step_data ELSE '{}'::jsonb END,
         '{conciergeEvidence}', jsonb_set(
           ${lineageSql}, '{publication}', jsonb_build_object(
             'sourceFingerprint', ${sourceFingerprintSql},
             'resultHash', ${resultHashSql}
           ), TRUE
         ), TRUE
       ),
       current_step = 'completed', error_message = NULL, completed_at = now()
   WHERE id = ${requestId};
END $write$;
COMMIT;`;
}

function applyAtomicPublication(input: Parameters<typeof buildAtomicPublicationSql>[0]): void {
    execFileSync('supabase', [
        '--workdir', CANONICAL_WORKDIR, 'db', 'query', '--linked', '--agent=yes', '--output', 'json',
        buildAtomicPublicationSql(input),
    ], { stdio: 'pipe', encoding: 'utf8' });
}

async function verifyAuthorization(order: { userId: string }, requestId: string): Promise<void> {
    const owner = await resolveAnalysisResultOwner(requestId, 'v1');
    if (owner !== order.userId) throw new Error('CONCIERGE_BUYER_OWNER_AUTHORIZATION_FAILED');
    await requireActiveAccountClassification(order.userId);
    const users = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1_000 });
    const admin = users.data.users.find(user => user.email?.trim().toLowerCase() === 'ym1113@kakao.com');
    if (!admin || !isAnalysisResultOperator({ id: admin.id, email: admin.email })) {
        throw new Error('CONCIERGE_ADMIN_ALLOWLIST_AUTHORIZATION_FAILED');
    }
    await requireActiveAccountClassification(admin.id);
}

async function main(): Promise<void> {
    const startedAt = Date.now();
    const { data: orders, error: orderError } = await supabaseAdmin
        .from('earlybird_orders')
        .select('id,user_id,target_instagram_id,target_followers_count,target_following_count,result_request_id,status,plan_id,paid_at')
        .eq('plan_id', 'basic').gte('paid_at', SAMPLE_START).lt('paid_at', SAMPLE_END);
    if (orderError || !orders || orders.length !== 1) throw new Error('CONCIERGE_SAMPLE_ORDER_SCOPE_CONFLICT');
    const order = orders[0]!;
    if (order.status !== 'completed' || typeof order.result_request_id !== 'string' || typeof order.target_instagram_id !== 'string') {
        throw new Error('CONCIERGE_SAMPLE_ORDER_NOT_READY');
    }
    const { data: requests, error: requestError } = await supabaseAdmin
        .from('analysis_requests')
        .select('id,user_id,target_instagram_id,status,pipeline_version')
        .eq('user_id', order.user_id);
    if (requestError || !requests) throw new Error('CONCIERGE_SAMPLE_REQUEST_LOOKUP_FAILED');
    const request = requests.find(row => row.id === order.result_request_id);
    const { data: sourceLineagePayload, error: lineageError } = await supabaseAdmin.rpc(
        'read_earlybird_v211_concierge_result_source',
        { p_order_id: order.id },
    );
    const sourceRequestId = z.object({ sourceRequestId: z.string().uuid() })
        .safeParse(sourceLineagePayload).data?.sourceRequestId;
    if (lineageError || !sourceRequestId) {
        throw new Error('CONCIERGE_SAMPLE_REQUEST_SCOPE_CONFLICT');
    }
    const sourceRequest = selectConciergeSourceRequest(requests, {
        sourceRequestId,
        userId: order.user_id,
        targetInstagramId: order.target_instagram_id,
    });
    if (!request || request.status !== 'completed' || request.pipeline_version !== 'v1') {
        throw new Error('CONCIERGE_SAMPLE_REQUEST_SCOPE_CONFLICT');
    }
    const targetSnapshot = await collectReviewedTargetSnapshot(order.target_instagram_id);
    const targetPosts = targetSnapshot.targetPosts;
    const targetEvidence = targetSnapshot.targetEvidence;
    const followers = await collectRelationshipSide(order.target_instagram_id, 'followers');
    const following = await collectRelationshipSide(order.target_instagram_id, 'following');
    const followerNames = followers.rows.map(row => normalizedUsername(row.username));
    const followingNames = following.rows.map(row => normalizedUsername(row.username));
    const followerSet = new Set(followerNames);
    const orderedMutualUsernames = followingNames.filter(username => followerSet.has(username));
    if (new Set(orderedMutualUsernames).size !== orderedMutualUsernames.length) {
        throw new Error('CONCIERGE_MUTUAL_IDENTITY_CONFLICT');
    }
    const exactMutualCount = orderedMutualUsernames.length;
    const hydration = await hydrateExactMutualProfiles(orderedMutualUsernames);
    const relationshipRows = [
        ...relationshipEvidence('followers', followers.rows),
        ...relationshipEvidence('following', following.rows),
    ];
    const partition = deriveConciergePrivacyPartition({
        profiles: hydration.profiles,
        relationshipRows,
        requireExactMutual: true,
    });
    if (partition.unresolvedUsernames.length !== hydration.unresolved.length) {
        throw new Error('CONCIERGE_UNRESOLVED_RECONCILIATION_FAILED');
    }
    const sourceFingerprint = sha256({
        sourceRequest: sourceRequest.id,
        ownerId: order.user_id,
        orderId: order.id,
        resultRequestId: order.result_request_id,
        targetUsername: normalizedUsername(order.target_instagram_id),
        relationship: {
            followers: followers.rows,
            following: following.rows,
            followerLineage: followers.lineage,
            followingLineage: following.lineage,
        },
        profiles: hydration.profiles.map(profile => ({
            username: normalizedUsername(profile.username), isPrivate: profile.isPrivate,
            posts: profile.latestPosts?.map(post => post.id) ?? [],
        })),
        targetPosts: targetSnapshot.persistedTargetPosts,
        targetEvidence,
        targetProviderLineage: targetSnapshot.lineage,
    });
    const profileByUsername = new Map(hydration.profiles.map(profile => [normalizedUsername(profile.username), profile]));
    const replayProfiles = orderedMutualUsernames
        .filter(username => profileByUsername.has(username))
        .map(username => checkpointProfile(profileByUsername.get(username)!));
    const sourceEvidence: AnalysisV2ReplayBundle['evidence'] = {
        relationship: relationshipRows.map(row => ({
            username: row.username, side: row.side, isPrivate: row.isPrivate,
            isVerified: row.isVerified, fullName: row.fullName, ordinal: row.ordinal,
        })),
        targetInteractions: targetEvidence.map(row => ({
            actorUsername: normalizedUsername(row.actorUsername), postId: row.postId,
            signal: row.signal, sourceInteractionId: row.sourceInteractionId,
            occurredAt: row.occurredAt ?? null, content: row.content ?? null,
        })),
        reverseInteractions: [],
    };
    const bundle = await captureAnalysisV2ReplayBundle({
        selector: { targetUsername: order.target_instagram_id },
        repository: {
            async findCompletedReplaySourceExact() {
                return { requestFingerprint: sourceFingerprint, sourceLineage: BASIC_SOURCE_LINEAGE, completed: true };
            },
            async loadReplaySource() {
                return { profiles: replayProfiles, evidence: sourceEvidence, providerRuns: [] };
            },
        },
        normalizeMedia: createAnalysisV2SelectedMediaNormalizer(),
        evaluationPolicy: conciergeEvaluationPolicy,
    });
    const details = new Map<number, ReplayAccountAiDetail>();
    const report = await runAnalysisV2AiReplay({
        bundle, runner: createReplayStagedAiAdapter(AI_STAGE_POLICY_V211_VERSION), mode: 'paid-ai',
        paidAiOptIn: true, evaluationPolicy: conciergeEvaluationPolicy,
        onAccountAnalyzed(detail) { details.set(detail.ordinal, detail); },
    });
    const profilesByOrdinal = new Map(bundle.profiles.map(profile => [
        profile.ordinal,
        profileByUsername.get(normalizedUsername(profile.username))!,
    ]));
    const targetInteractions = targetEvidence.map(row => ({
        actorUsername: normalizedUsername(row.actorUsername), postId: row.postId,
        signal: row.signal, sourceInteractionId: row.sourceInteractionId,
        ...(row.occurredAt ? { occurredAt: row.occurredAt } : {}),
        ...(row.content ? { content: row.content } : {}),
    }));
    const result = buildCanonicalConciergeResult({
        targetUsername: order.target_instagram_id,
        profilesByOrdinal,
        details: [...details.values()],
        orderedMutualUsernames,
        targetInteractions,
        targetPosts,
        privateProfiles: partition.privateProfiles,
    });
    validateCanonicalConciergeCorrection({
        fetchedCount: exactMutualCount,
        partition,
        result,
    });
    if (result.femaleRows.length === 0) {
        throw new Error('CONCIERGE_NO_CANONICAL_RANKED_RESULT');
    }
    if (report.gender.male !== result.counts.male || report.gender.female !== result.counts.female
        || report.gender.unknown !== result.counts.unknown) {
        throw new Error('CONCIERGE_PUBLIC_GENDER_REPORT_RECONCILIATION_FAILED');
    }
    const currentOrder = await supabaseAdmin.from('earlybird_orders')
        .select('id,result_request_id,status,plan_id,paid_at').eq('id', order.id).maybeSingle();
    if (currentOrder.error || !currentOrder.data || currentOrder.data.result_request_id !== order.result_request_id
        || currentOrder.data.status !== 'completed' || currentOrder.data.plan_id !== 'basic') {
        throw new Error('CONCIERGE_PUBLICATION_SCOPE_CHANGED');
    }
    const beforeRows = await supabaseAdmin.from('analysis_results').select('rank').eq('request_id', order.result_request_id);
    const beforePrivate = await supabaseAdmin.from('private_accounts').select('instagram_id').eq('request_id', order.result_request_id);
    const completenessProven = followers.rows.length === order.target_followers_count
        && following.rows.length === order.target_following_count;
    if (!completenessProven) {
        throw new Error('CONCIERGE_RELATIONSHIP_SNAPSHOT_INCOMPLETE');
    }
    const lineage = {
        schema: 'concierge-exact-mutual-v1',
        sourceFingerprint,
        relationship: {
            followers: {
                declaredSnapshot: order.target_followers_count, requestedLimit: RELATIONSHIP_LIMIT,
                collected: followers.rows.length, unique: followers.uniqueCount,
                duplicates: followers.duplicateCount, runIds: followers.lineage.runIds,
            },
            following: {
                declaredSnapshot: order.target_following_count, requestedLimit: RELATIONSHIP_LIMIT,
                collected: following.rows.length, unique: following.uniqueCount,
                duplicates: following.duplicateCount, runIds: following.lineage.runIds,
            },
            exactIntersection: exactMutualCount,
            completenessProven,
        },
        hydration: {
            exactMutual: exactMutualCount, hydrated: partition.profiles.length,
            public: partition.publicProfiles.length, private: partition.privateProfiles.length,
            unresolved: partition.unresolvedUsernames.length, runIds: hydration.lineage.runIds,
        },
        target: {
            posts: targetSnapshot.persistedTargetPosts,
            evidenceCount: targetEvidence.length,
            runIds: targetSnapshot.lineage.runIds,
        },
    };
    await verifyAuthorization({ userId: order.user_id }, order.result_request_id);
    applyAtomicPublication({
        orderId: order.id, requestId: order.result_request_id,
        femaleRows: result.femaleRows, privateRows: result.privateRows,
        counts: { male: result.counts.male, female: result.counts.female, unknown: result.counts.unknown },
        mutualFollows: exactMutualCount,
        lineage,
        reviewedSource: {
            sourceRequestId: sourceRequest.id,
            ownerId: order.user_id,
            targetUsername: order.target_instagram_id,
            resultRequestId: order.result_request_id,
            targetPosts: targetSnapshot.persistedTargetPosts,
            targetEvidence,
        },
    });
    const [afterRequest, afterResults, afterPrivate] = await Promise.all([
        supabaseAdmin.from('analysis_requests').select('status,progress,gender_stats,pipeline_version').eq('id', order.result_request_id).maybeSingle(),
        supabaseAdmin.from('analysis_results').select('rank,risk_score,risk_grade,one_line_overview,risk_analysis,gender_status').eq('request_id', order.result_request_id).order('rank'),
        supabaseAdmin.from('private_accounts').select('instagram_id').eq('request_id', order.result_request_id),
    ]);
    if (afterRequest.error || !afterRequest.data || afterRequest.data.status !== 'completed'
        || afterRequest.data.progress !== 100 || afterRequest.data.pipeline_version !== 'v1'
        || afterResults.error || !afterResults.data || afterResults.data.length !== result.femaleRows.length
        || afterResults.data.some(row => row.risk_score === null || row.risk_grade === null
            || row.gender_status !== 'confirmed'
            || typeof row.one_line_overview !== 'string'
            || row.one_line_overview.length === 0 || row.one_line_overview.length > 180)
        || afterPrivate.error || !afterPrivate.data || afterPrivate.data.length !== result.privateRows.length) {
        throw new Error('CONCIERGE_PUBLICATION_VERIFY_FAILED');
    }
    const highRiskRows = afterResults.data.filter(row => row.risk_grade === 'high_risk');
    if (highRiskRows.some(row => !Array.isArray(row.risk_analysis) || row.risk_analysis.length !== 2)) {
        throw new Error('CONCIERGE_PUBLICATION_NARRATIVE_VERIFY_FAILED');
    }
    const overviewRows = afterResults.data.filter(row => row.risk_grade !== 'high_risk');
    if (overviewRows.some(row => typeof row.one_line_overview !== 'string'
        || row.one_line_overview.length === 0 || row.one_line_overview.length > 180)) {
        throw new Error('CONCIERGE_PUBLICATION_OVERVIEW_VERIFY_FAILED');
    }
    const genderStats = afterRequest.data.gender_stats as Record<string, number> | null;
    if (!genderStats || genderStats.male + genderStats.female + genderStats.unknown !== partition.publicProfiles.length) {
        throw new Error('CONCIERGE_PUBLIC_GENDER_STATS_VERIFY_FAILED');
    }
    console.log(JSON.stringify({
        state: 'completed',
        before: { resultRows: beforeRows.data?.length ?? 0, privateRows: beforePrivate.data?.length ?? 0 },
        after: {
            followerSnapshot: order.target_followers_count, followingSnapshot: order.target_following_count,
            followersCollected: followers.rows.length, followingCollected: following.rows.length,
            followersUnique: followers.uniqueCount, followingUnique: following.uniqueCount,
            exactIntersection: exactMutualCount, hydrated: partition.profiles.length,
            public: partition.publicProfiles.length, private: partition.privateProfiles.length,
            unresolved: partition.unresolvedUsernames.length,
            publicGender: { male: result.counts.male, female: result.counts.female, unknown: result.counts.unknown },
            resultRows: result.femaleRows.length, highRiskRows: highRiskRows.length,
        },
        authorization: { buyerOwner: true, configuredAdminAllowlist: true },
        elapsedSeconds: Number(((Date.now() - startedAt) / 1_000).toFixed(1)),
    }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch(error => {
        console.error(JSON.stringify({ state: 'failed', code: safeError(error) }));
        process.exitCode = 1;
    });
}
