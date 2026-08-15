import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    buildV211EvidenceSpecificOverview,
    buildV211EvidenceSpecificRiskNarrative,
    extractV211EvidenceTerms,
    validateV211PublicCopyRows,
    type V211PublicCopyRow,
} from '@/lib/services/analysis/public-copy-quality';
import { loadRetainedConciergeProfileArtifacts } from './correct-concierge-basic-result';

const RESULT_URL = 'https://yeosachin.com/result/975d0b48-b81a-432c-bb3e-d4a4d282e527';
const COPY_QUALITY_VERSION = 'v211-evidence-specific-v1';
const ORDER_START = '2026-08-12T00:00:00Z';
const ORDER_END = '2026-08-13T00:00:00Z';
const REVERSE_INTERACTION_ARTIFACT_PATH = process.env.CONCIERGE_REVERSE_INTERACTIONS_PATH
    ?.trim() || '/private/tmp/concierge-reverse-interactions.json';

const orderSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    result_request_id: z.string().uuid(),
    target_instagram_id: z.string().min(1),
    status: z.literal('completed'),
    plan_id: z.literal('basic'),
}).passthrough();

const resultRowSchema = z.object({
    rank: z.number().int().min(1).max(16),
    suspect_instagram_id: z.string().min(1),
    risk_grade: z.enum(['normal', 'caution', 'high_risk']),
    one_line_overview: z.string().nullable(),
    risk_analysis: z.array(z.unknown()).nullable(),
    likes_count: z.number().nullable().optional(),
    intimate_comments_count: z.number().nullable().optional(),
    normal_comments_count: z.number().nullable().optional(),
    post_tags_count: z.number().nullable().optional(),
    caption_mentions_count: z.number().nullable().optional(),
    comment_mentions_count: z.number().nullable().optional(),
    female_to_target_likes_count: z.number().nullable().optional(),
    female_to_target_comments_count: z.number().nullable().optional(),
    target_to_female_likes_count: z.number().nullable().optional(),
    is_tagged: z.boolean().nullable().optional(),
}).passthrough();

const reverseInteractionArtifactSchema = z.object({
    version: z.literal('concierge-reverse-interactions-v1'),
    orderId: z.string().uuid(),
    resultRequestId: z.string().uuid(),
    targetToCandidateCoverage: z.literal('bounded_apify_likers_v1'),
    candidateCount: z.literal(16),
    collectedCount: z.number().int().min(0).max(16),
    unavailable: z.array(z.object({
        rank: z.number().int().min(1).max(16),
        username: z.string().regex(/^[a-z0-9._]{1,30}$/),
        reason: z.literal('retained_profile_has_no_collectable_post'),
    })),
    observations: z.array(z.object({
        rank: z.number().int().min(1).max(16),
        username: z.string().regex(/^[a-z0-9._]{1,30}$/),
        postUrl: z.string().url(),
        targetLikedCandidate: z.boolean(),
        returnedLikerCount: z.number().int().min(0).max(100),
    })),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
}).passthrough();

function sha256(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedUsername(value: string): string {
    return value.trim().replace(/^@/, '').toLowerCase();
}

function positiveNumber(value: number | null | undefined): boolean {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function profileCopyEvidence(profile: {
    bio?: string;
    externalUrl?: string;
    profilePicUrl?: string;
    latestPosts?: readonly {
        caption?: string;
        type?: string;
        imageUrl?: string;
        thumbnailUrl?: string;
        mediaItems?: readonly { caption?: string; type?: string }[];
    }[];
}) {
    const posts = profile.latestPosts ?? [];
    const feedEvidence = posts.flatMap(post => [
        ...(post.caption ? [post.caption] : []),
        ...(post.mediaItems ?? []).flatMap(item => item.caption ? [item.caption] : []),
    ]);
    const structuralEvidence: string[] = [];
    if (posts.some(post => Boolean(post.imageUrl || post.thumbnailUrl || post.mediaItems?.length))) {
        structuralEvidence.push('사진 게시물 화면 구성');
    }
    if (posts.some(post => post.type === 'reel' || post.type === 'video')) {
        structuralEvidence.push('영상 게시물 흐름');
    }
    if (profile.profilePicUrl) structuralEvidence.push('프로필 이미지 표현');
    if (profile.externalUrl) structuralEvidence.push('외부 링크 맥락');
    return {
        profileEvidence: profile.bio ?? null,
        feedEvidence,
        structuralEvidence,
    };
}

function interactionEvidence(row: z.infer<typeof resultRowSchema>, targetEvidence: readonly unknown[]) {
    const candidate = normalizedUsername(row.suspect_instagram_id);
    const evidenceRows = targetEvidence.filter(item => (
        Boolean(item)
        && typeof item === 'object'
        && normalizedUsername(String((item as { actorUsername?: unknown }).actorUsername ?? '')) === candidate
    )) as Array<{ signal?: unknown; content?: unknown }>;
    const targetLikeEvidence = evidenceRows.some(item => item.signal === 'target_post_like');
    const targetCommentEvidence = evidenceRows.some(item => item.signal === 'target_post_comment');
    const comment = evidenceRows.find(item => item.signal === 'target_post_comment')?.content;
    const candidateTaggedTarget = Boolean(row.is_tagged)
        || positiveNumber(row.post_tags_count);
    const candidateMentionedTarget = positiveNumber(row.caption_mentions_count)
        || positiveNumber(row.comment_mentions_count);
    return {
        candidateLikedTarget: positiveNumber(row.female_to_target_likes_count)
            || positiveNumber(row.likes_count)
            || targetLikeEvidence,
        candidateCommentedOnTarget: positiveNumber(row.female_to_target_comments_count)
            || positiveNumber(row.intimate_comments_count)
            || targetCommentEvidence,
        targetLikedCandidate: positiveNumber(row.target_to_female_likes_count),
        targetCommentedOnCandidate: false,
        candidateTaggedTarget,
        targetTaggedCandidate: false,
        candidateMentionedTarget,
        targetMentionedCandidate: false,
        tagEvidence: candidateTaggedTarget,
        ...(typeof comment === 'string' ? { commentText: comment } : {}),
    };
}

function interactionEvidencePayload(
    input: ReturnType<typeof interactionEvidence>,
    targetReverseCoverage: string,
) {
    return {
        candidateToTarget: {
            likeObserved: input.candidateLikedTarget,
            commentObserved: input.candidateCommentedOnTarget,
            tagObserved: Boolean(input.candidateTaggedTarget),
            mentionObserved: Boolean(input.candidateMentionedTarget),
        },
        targetToCandidate: {
            likeObserved: input.targetLikedCandidate,
            commentObserved: Boolean(input.targetCommentedOnCandidate),
            tagObserved: Boolean(input.targetTaggedCandidate),
            mentionObserved: Boolean(input.targetMentionedCandidate),
            coverage: targetReverseCoverage,
        },
    };
}

export async function loadReverseInteractionArtifact(order: z.infer<typeof orderSchema>) {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(REVERSE_INTERACTION_ARTIFACT_PATH, 'utf8');
    const parsed = reverseInteractionArtifactSchema.parse(JSON.parse(raw));
    if (
        parsed.orderId !== order.id
        || parsed.resultRequestId !== order.result_request_id
        || parsed.observations.length + parsed.unavailable.length !== 16
        || new Set(parsed.observations.map(row => row.rank)).size !== parsed.observations.length
        || new Set(parsed.unavailable.map(row => row.rank)).size !== parsed.unavailable.length
    ) {
        throw new Error('CONCIERGE_COPY_CORRECTION_REVERSE_SCOPE_CONFLICT');
    }
    return parsed;
}

export async function loadExactScope() {
    const { data: orders, error: orderError } = await supabaseAdmin
        .from('earlybird_orders')
        .select('id,user_id,result_request_id,target_instagram_id,status,plan_id')
        .eq('plan_id', 'basic')
        .eq('status', 'completed')
        .gte('paid_at', ORDER_START)
        .lt('paid_at', ORDER_END);
    if (orderError || !orders || orders.length !== 1) {
        throw new Error('CONCIERGE_COPY_CORRECTION_ORDER_SCOPE_CONFLICT');
    }
    const order = orderSchema.parse(orders[0]);
    const [{ data: rows, error: rowsError }, { data: request, error: requestError }, { data: sourceCandidates, error: sourceError }] = await Promise.all([
        supabaseAdmin.from('analysis_results')
            .select('rank,suspect_instagram_id,risk_grade,one_line_overview,risk_analysis,likes_count,intimate_comments_count,normal_comments_count,post_tags_count,caption_mentions_count,comment_mentions_count,female_to_target_likes_count,female_to_target_comments_count,target_to_female_likes_count,is_tagged')
            .eq('request_id', order.result_request_id)
            .order('rank'),
        supabaseAdmin.from('analysis_requests')
            .select('step_data')
            .eq('id', order.result_request_id)
            .maybeSingle(),
        supabaseAdmin.from('analysis_requests')
            .select('id,status,pipeline_version,target_instagram_id')
            .eq('user_id', order.user_id)
            .eq('target_instagram_id', order.target_instagram_id)
            .eq('status', 'failed')
            .eq('pipeline_version', 'v2'),
    ]);
    if (rowsError || !rows || rows.length !== 16 || requestError || !request || sourceError
        || !sourceCandidates || sourceCandidates.length !== 1) {
        throw new Error('CONCIERGE_COPY_CORRECTION_SOURCE_SCOPE_CONFLICT');
    }
    const parsedRows = z.array(resultRowSchema).parse(rows);
    const stepData = request.step_data as {
        sourceFingerprint?: unknown;
        conciergeBootstrap?: { sourceFingerprint?: unknown; resultHash?: unknown };
    } | null;
    // The bootstrap/replay lineage is authoritative.  The top-level field can
    // retain a superseded pre-publication fingerprint and must never win CAS.
    const sourceFingerprint = typeof stepData?.conciergeBootstrap?.sourceFingerprint === 'string'
        ? stepData.conciergeBootstrap.sourceFingerprint
        : stepData?.sourceFingerprint;
    const publishedResultHash = stepData?.conciergeBootstrap?.resultHash;
    if (typeof sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(sourceFingerprint)
        || typeof publishedResultHash !== 'string' || !/^[a-f0-9]{64}$/.test(publishedResultHash)) {
        throw new Error('CONCIERGE_COPY_CORRECTION_CAS_CONFLICT');
    }
    const sourceRequestId = String((sourceCandidates[0] as { id: string }).id);
    const { data: targetData, error: targetError } = await supabaseAdmin.rpc('load_analysis_v2_target_evidence', {
        p_request_id: sourceRequestId,
        p_job_key: 'track:target-evidence:collect',
    });
    if (targetError || !targetData || !Array.isArray((targetData as { rows?: unknown }).rows)
        || (targetData as { rows: unknown[] }).rows.length !== 95) {
        throw new Error('CONCIERGE_COPY_CORRECTION_TARGET_EVIDENCE_CONFLICT');
    }
    return {
        order,
        rows: parsedRows,
        sourceFingerprint,
        publishedResultHash,
        sourceRequestId,
        stepData,
        targetEvidence: (targetData as { rows: unknown[] }).rows,
    };
}

export function buildCorrectionPayload(input: {
    rows: readonly z.infer<typeof resultRowSchema>[];
    profiles: ReadonlyMap<string, {
        bio?: string;
        externalUrl?: string;
        profilePicUrl?: string;
        latestPosts?: readonly {
            caption?: string;
            type?: string;
            imageUrl?: string;
            thumbnailUrl?: string;
            mediaItems?: readonly { caption?: string; type?: string }[];
        }[];
    }>;
    targetEvidence: readonly unknown[];
    reverseInteractions: z.infer<typeof reverseInteractionArtifactSchema>;
}) {
    const copyRows: V211PublicCopyRow[] = [];
    const payloadRows = input.rows.map(row => {
        const profile = input.profiles.get(normalizedUsername(row.suspect_instagram_id));
        if (!profile) throw new Error('CONCIERGE_COPY_CORRECTION_PROFILE_SCOPE_CONFLICT');
        const evidence = profileCopyEvidence(profile);
        const overview = buildV211EvidenceSpecificOverview({
            ...evidence,
            variation: row.rank - 1,
        });
        const interaction = interactionEvidence(row, input.targetEvidence);
        const reverseObservation = input.reverseInteractions.observations.find(
            candidate => candidate.rank === row.rank
        );
        const reverseUnavailable = input.reverseInteractions.unavailable.some(
            candidate => candidate.rank === row.rank
        );
        if (!reverseObservation && !reverseUnavailable) {
            throw new Error('CONCIERGE_COPY_CORRECTION_REVERSE_SCOPE_CONFLICT');
        }
        const enrichedInteraction = {
            ...interaction,
            targetLikedCandidate: reverseObservation?.targetLikedCandidate ?? false,
        };
        const riskAnalysis = row.risk_grade === 'high_risk'
            ? buildV211EvidenceSpecificRiskNarrative({
                ...evidence,
                ...enrichedInteraction,
            })
            : [];
        const copyRow: V211PublicCopyRow = {
            ...evidence,
            ...enrichedInteraction,
            oneLineOverview: overview,
            riskGrade: row.risk_grade,
            riskAnalysis,
        };
        copyRows.push(copyRow);
        return {
            rank: row.rank,
            suspect_instagram_id: normalizedUsername(row.suspect_instagram_id),
            oneLineOverview: overview,
            riskGrade: row.risk_grade,
            riskAnalysis,
            evidenceTerms: extractV211EvidenceTerms(evidence).slice(0, 4),
            interactionEvidence: interactionEvidencePayload(
                enrichedInteraction,
                reverseObservation
                    ? input.reverseInteractions.targetToCandidateCoverage
                    : 'not_collected',
            ),
        };
    });
    validateV211PublicCopyRows({ rows: copyRows });
    return {
        qualityVersion: COPY_QUALITY_VERSION,
        rows: payloadRows,
    };
}

async function verifyResult(input: {
    requestId: string;
    orderId: string;
    sourceFingerprint: string;
    publishedResultHash: string;
}) {
    const [{ data: rows, error: rowsError }, { data: request, error: requestError }, { data: privateRows, error: privateError }] = await Promise.all([
        supabaseAdmin.from('analysis_results').select('rank,risk_grade,one_line_overview,risk_analysis,gender_status').eq('request_id', input.requestId).order('rank'),
        supabaseAdmin.from('analysis_requests').select('status,progress,gender_stats,step_data').eq('id', input.requestId).maybeSingle(),
        supabaseAdmin.from('private_accounts').select('instagram_id').eq('request_id', input.requestId),
    ]);
    if (rowsError || requestError || privateError || !rows || rows.length !== 16 || !request || !privateRows) {
        throw new Error('CONCIERGE_COPY_CORRECTION_VERIFY_FAILED');
    }
    const highRisk = rows.filter(row => row.risk_grade === 'high_risk');
    const genderStats = request.gender_stats as Record<string, unknown> | null;
    const marker = (request.step_data as { conciergeBootstrap?: { copyCorrection?: { qualityVersion?: string } } } | null)?.conciergeBootstrap?.copyCorrection;
    if (
        highRisk.length !== 2
        || rows.some(row => row.gender_status !== 'confirmed' || !row.one_line_overview || row.one_line_overview.length > 180)
        || highRisk.some(row => !Array.isArray(row.risk_analysis) || row.risk_analysis.length !== 2)
        || privateRows.length !== 95
        || request.status !== 'completed'
        || request.progress !== 100
        || genderStats?.male !== 31
        || genderStats?.female !== 16
        || genderStats?.unknown !== 6
        || marker?.qualityVersion !== COPY_QUALITY_VERSION
        || input.sourceFingerprint.length !== 64
        || input.publishedResultHash.length !== 64
    ) {
        throw new Error('CONCIERGE_COPY_CORRECTION_VERIFY_FAILED');
    }
    const response = await fetch(RESULT_URL, { redirect: 'manual' });
    if (![200, 301, 302, 307, 308].includes(response.status)) {
        throw new Error('CONCIERGE_COPY_CORRECTION_RESULT_URL_FAILED');
    }
    return {
        resultRows: rows.length,
        highRiskRows: highRisk.length,
        privateRows: privateRows.length,
        publicGender: { male: 31, female: 16, unknown: 6 },
        reviewUrl: RESULT_URL,
    };
}

async function main(): Promise<void> {
    const scope = await loadExactScope();
    const profiles = await loadRetainedConciergeProfileArtifacts();
    const reverseInteractions = await loadReverseInteractionArtifact(scope.order);
    const payload = buildCorrectionPayload({
        rows: scope.rows,
        profiles,
        targetEvidence: scope.targetEvidence,
        reverseInteractions,
    });
    const correctionResultHash = sha256({
        qualityVersion: COPY_QUALITY_VERSION,
        orderId: scope.order.id,
        resultRequestId: scope.order.result_request_id,
        sourceFingerprint: scope.sourceFingerprint,
        publishedResultHash: scope.publishedResultHash,
        reverseInteractionArtifactHash: reverseInteractions.artifactHash,
        rows: payload.rows,
    });
    if (process.env.CONCIERGE_COPY_CORRECTION_DRY_RUN === '1') {
        console.log(JSON.stringify({
            state: 'dry_run_ready',
            qualityVersion: COPY_QUALITY_VERSION,
            resultRows: payload.rows.length,
            highRiskRows: payload.rows.filter(row => row.riskGrade === 'high_risk').length,
            copyHash: correctionResultHash,
            sourceFingerprint: scope.sourceFingerprint,
            publishedResultHash: scope.publishedResultHash,
        }));
        return;
    }
    // Exactly one RPC call is permitted for this correction.  The function owns
    // the transaction, row locks, immutable source CAS, and idempotency ledger.
    const { data, error } = await supabaseAdmin.rpc('correct_earlybird_v211_concierge_copy', {
        p_order_id: scope.order.id,
        p_owner_id: scope.order.user_id,
        p_result_request_id: scope.order.result_request_id,
        p_source_fingerprint: scope.sourceFingerprint,
        p_expected_published_result_hash: scope.publishedResultHash,
        p_correction_result_hash: correctionResultHash,
        p_copy_payload: payload,
    });
    if (error || !data || !['corrected', 'already_corrected'].includes(String((data as { state?: unknown }).state))) {
        throw new Error('CONCIERGE_COPY_CORRECTION_RPC_FAILED');
    }
    const verification = await verifyResult({
        requestId: scope.order.result_request_id,
        orderId: scope.order.id,
        sourceFingerprint: scope.sourceFingerprint,
        publishedResultHash: scope.publishedResultHash,
    });
    console.log(JSON.stringify({ state: 'completed', rpcState: (data as { state: string }).state, ...verification }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch(error => {
        console.error(JSON.stringify({ state: 'failed', code: error instanceof Error ? error.message : 'CONCIERGE_COPY_CORRECTION_FAILED' }));
        process.exitCode = 1;
    });
}
