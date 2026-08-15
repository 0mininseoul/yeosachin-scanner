import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createAnalysisV2SelectedMediaNormalizer } from '@/lib/services/ai/image-preprocessing';
import { issueReplayStatelessCapability } from '@/lib/services/ai/replay-stateless-capability';
import { AI_STAGE_POLICY_V211_VERSION } from '@/lib/services/ai/stage-policy';
import {
    createFeatureAnalysisResultIdentity,
    createHighRiskNarrativeResultIdentity,
    featureAnalysis,
    highRiskNarrative,
    type FeatureAnalysisInput,
    type HighRiskNarrativeInput,
    type StagedAiAuditContext,
} from '@/lib/services/ai/v2-staged-analysis';
import type { InteractionEvidenceRow } from '@/lib/services/analysis/interaction-stage';
import {
    captureAnalysisV2ReplayBundle,
} from '@/lib/services/analysis/replay/replay-capture';
import {
    firstPaymentConciergeCheckpointProfile,
    firstPaymentConciergeEvaluationPolicy,
    createFirstPaymentConciergeHighRiskNarrativeInput,
} from '@/lib/services/analysis/first-payment-concierge';
import { loadRetainedConciergeProfileArtifacts } from './correct-concierge-basic-result';
import {
    areMateriallyNearDuplicatePublicCopies,
    isForbiddenV211Overview,
    isForbiddenV211RiskNarrative,
} from '@/lib/services/analysis/public-copy-quality';

const ORDER_START = '2026-08-12T00:00:00Z';
const ORDER_END = '2026-08-13T00:00:00Z';
const SHA256 = /^[a-f0-9]{64}$/;
const USERNAME = /^[a-z0-9._]{1,30}$/;

export type V214FrozenResultRow = Readonly<{
    rank: number;
    suspect_instagram_id: string;
    suspect_full_name: string | null;
    risk_grade: 'normal' | 'caution' | 'high_risk';
    one_line_overview: string | null;
    risk_analysis: unknown;
    [key: string]: unknown;
}>;

export type V214GeneratedCopy = Readonly<{
    rank: number;
    source: string;
    oneLineOverview: string;
    riskAnalysis: readonly string[];
    evidence: Readonly<{
        candidateFullName: string;
        targetFullName: string;
        observedInteraction: 'like' | 'comment' | 'tag' | 'mention';
    }> | null;
}>;

export const V214_COPY_QUALITY_VERSION = 'v214-gemini-first-payment-copy-v1';

const interactionTerms = {
    like: '좋아요',
    comment: '댓글',
    tag: '태그',
    mention: '멘션',
} as const;

function nonCopySnapshot(row: V214FrozenResultRow): Record<string, unknown> {
    return Object.fromEntries(Object.entries(row).filter(([key]) => (
        key !== 'one_line_overview' && key !== 'risk_analysis'
    )));
}

function requireExactV214Scope(
    rows: readonly V214FrozenResultRow[],
    generated: readonly V214GeneratedCopy[],
): Map<number, V214GeneratedCopy> {
    if (
        rows.length !== 16
        || generated.length !== 16
        || new Set(rows.map(row => row.rank)).size !== 16
        || new Set(generated.map(row => row.rank)).size !== 16
        || rows.some(row => !Number.isInteger(row.rank) || row.rank < 1 || row.rank > 16)
        || generated.some(row => !Number.isInteger(row.rank) || row.rank < 1 || row.rank > 16)
    ) {
        throw new Error('CONCIERGE_COPY_V214_RESULT_SCOPE_CONFLICT');
    }
    const byRank = new Map(generated.map(row => [row.rank, row]));
    if (rows.some(row => !byRank.has(row.rank))) {
        throw new Error('CONCIERGE_COPY_V214_RESULT_SCOPE_CONFLICT');
    }
    return byRank;
}

function assertGeminiOverview(
    previous: string | null,
    generated: V214GeneratedCopy,
): void {
    const overview = generated.oneLineOverview.trim();
    if (generated.source !== 'gemini') {
        throw new Error('CONCIERGE_COPY_V214_GEMINI_SOURCE_REQUIRED');
    }
    if (
        overview.length < 25
        || overview.length > 180
        || overview === previous?.trim()
        || isForbiddenV211Overview(overview)
    ) {
        throw new Error('CONCIERGE_COPY_V214_OVERVIEW_INVALID');
    }
}

function assertHighRiskNarrative(
    riskGrade: V214FrozenResultRow['risk_grade'],
    previousRiskAnalysis: unknown,
    generated: V214GeneratedCopy,
): void {
    if (riskGrade !== 'high_risk') {
        if (generated.riskAnalysis.length !== 0 || generated.evidence !== null) {
            throw new Error('CONCIERGE_COPY_V214_NON_HIGH_RISK_NARRATIVE_CONFLICT');
        }
        return;
    }
    const evidence = generated.evidence;
    const [first, second] = generated.riskAnalysis;
    const all = generated.riskAnalysis.join(' ');
    if (
        !evidence
        || generated.riskAnalysis.length !== 2
        || !first
        || !second
        || first.length > 180
        || second.length > 180
        || !first.includes(evidence.candidateFullName)
        || !second.includes(evidence.candidateFullName)
        || !second.includes(evidence.targetFullName)
        || !all.includes(interactionTerms[evidence.observedInteraction])
        || isForbiddenV211RiskNarrative(generated.riskAnalysis)
        || /(?:대상\s*계정|후보\s*계정|위장여사친)/u.test(all)
    ) {
        throw new Error('CONCIERGE_COPY_V214_HIGH_RISK_EVIDENCE_INVALID');
    }
    if (canonical(generated.riskAnalysis) === canonical(previousRiskAnalysis)) {
        throw new Error('CONCIERGE_COPY_V214_HIGH_RISK_NARRATIVE_UNCHANGED');
    }
}

/**
 * The only in-memory shape allowed to cross the v2.14 RPC boundary. It keeps
 * every original fact in a separate exact snapshot and carries Gemini-origin
 * replacement text only; the database function rechecks both before updating.
 */
export function buildV214GeminiCopyPayload(input: {
    rows: readonly V214FrozenResultRow[];
    generated: readonly V214GeneratedCopy[];
}) {
    const byRank = requireExactV214Scope(input.rows, input.generated);
    const rows = input.rows.map(frozen => {
        const generated = byRank.get(frozen.rank)!;
        assertGeminiOverview(frozen.one_line_overview, generated);
        assertHighRiskNarrative(frozen.risk_grade, frozen.risk_analysis, generated);
        return {
            rank: frozen.rank,
            suspectInstagramId: frozen.suspect_instagram_id,
            riskGrade: frozen.risk_grade,
            previousOverview: frozen.one_line_overview,
            previousRiskAnalysis: frozen.risk_analysis,
            oneLineOverview: generated.oneLineOverview.trim(),
            riskAnalysis: [...generated.riskAnalysis],
            source: 'gemini' as const,
            ...(generated.evidence ? { evidence: generated.evidence } : {}),
        };
    });
    if (
        new Set(rows.map(row => row.oneLineOverview)).size !== 16
        || rows.some((left, index) => rows.slice(index + 1).some(right => (
            areMateriallyNearDuplicatePublicCopies(left.oneLineOverview, right.oneLineOverview)
        )))
    ) {
        throw new Error('CONCIERGE_COPY_V214_OVERVIEW_DEDUPLICATION_FAILED');
    }
    return {
        qualityVersion: V214_COPY_QUALITY_VERSION,
        rows,
        factSnapshot: input.rows.map(nonCopySnapshot),
    };
}

const orderSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    result_request_id: z.string().uuid(),
    target_instagram_id: z.string().regex(USERNAME),
    status: z.literal('completed'),
    plan_id: z.literal('basic'),
}).passthrough();

const resultRowSchema = z.object({
    rank: z.number().int().min(1).max(16),
    suspect_instagram_id: z.string().regex(USERNAME),
    suspect_full_name: z.string().nullable(),
    risk_grade: z.enum(['normal', 'caution', 'high_risk']),
    one_line_overview: z.string().nullable(),
    risk_analysis: z.array(z.string()),
}).passthrough();

const targetEvidenceRowSchema = z.object({
    actorUsername: z.string().regex(USERNAME),
    postId: z.string().min(1).max(255),
    signal: z.enum(['target_post_like', 'target_post_comment']),
    sourceInteractionId: z.string().min(1).max(255),
    occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
    content: z.string().max(1_000).nullable().optional(),
}).strict();

type V214ExactScope = Readonly<{
    order: z.infer<typeof orderSchema>;
    rows: readonly V214FrozenResultRow[];
    sourceFingerprint: string;
    publishedResultHash: string;
    priorCorrectionResultHash: string;
    targetFullName: string;
    targetEvidence: readonly z.infer<typeof targetEvidenceRowSchema>[];
}>;

function normalizedUsername(value: string): string {
    return value.trim().replace(/^@/u, '').toLowerCase();
}

function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => (
        `${JSON.stringify(key)}:${canonical(object[key])}`
    )).join(',')}}`;
}

function sha256(value: unknown): string {
    return createHash('sha256').update(canonical(value)).digest('hex');
}

function v214FailureCode(error: unknown): string {
    for (let current = error, depth = 0; depth < 3 && current instanceof Error; depth += 1) {
        const match = /^([A-Z][A-Z0-9_]{2,119})(?::|$)/u.exec(current.message);
        if (match?.[1]) return match[1];
        current = current.cause;
    }
    if (error instanceof z.ZodError) return 'CONCIERGE_COPY_V214_GEMINI_VALIDATION_REJECTED';
    return 'CONCIERGE_COPY_V214_GENERATION_FAILED';
}

function exactTargetFullName(stepData: unknown): string | null {
    if (!stepData || typeof stepData !== 'object' || Array.isArray(stepData)) return null;
    const root = stepData as {
        targetProfileCheckpoint?: { fullName?: unknown };
        targetProfile?: { fullName?: unknown };
    };
    const value = root.targetProfileCheckpoint?.fullName ?? root.targetProfile?.fullName;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function loadExactV214Scope(): Promise<V214ExactScope> {
    const { data: orders, error: orderError } = await supabaseAdmin
        .from('earlybird_orders')
        .select('id,user_id,result_request_id,target_instagram_id,status,plan_id')
        .eq('plan_id', 'basic')
        .eq('status', 'completed')
        .gte('paid_at', ORDER_START)
        .lt('paid_at', ORDER_END);
    if (orderError || !orders || orders.length !== 1) {
        throw new Error('CONCIERGE_COPY_V214_ORDER_SCOPE_CONFLICT');
    }
    const order = orderSchema.parse(orders[0]);
    const [{ data: rows, error: rowsError }, { data: request, error: requestError }, { data: requests, error: requestsError }] = await Promise.all([
        supabaseAdmin.from('analysis_results').select('*').eq('request_id', order.result_request_id).order('rank'),
        supabaseAdmin.from('analysis_requests').select('step_data').eq('id', order.result_request_id).maybeSingle(),
        supabaseAdmin.from('analysis_requests')
            .select('id,status,pipeline_version,target_instagram_id')
            .eq('user_id', order.user_id)
            .eq('target_instagram_id', order.target_instagram_id)
            .eq('status', 'failed')
            .eq('pipeline_version', 'v2'),
    ]);
    if (rowsError || !rows || rows.length !== 16) {
        throw new Error('CONCIERGE_COPY_V214_RESULT_SCOPE_CONFLICT');
    }
    if (requestError || !request || requestsError || !requests || requests.length !== 1) {
        throw new Error('CONCIERGE_COPY_V214_SOURCE_SCOPE_CONFLICT');
    }
    const parsedRows = z.array(resultRowSchema).parse(rows) as V214FrozenResultRow[];
    const stepData = request.step_data as {
        sourceFingerprint?: unknown;
        conciergeBootstrap?: {
            sourceFingerprint?: unknown;
            resultHash?: unknown;
            v213CopyCorrection?: { correctionResultHash?: unknown };
        };
    } | null;
    const sourceFingerprint = typeof stepData?.conciergeBootstrap?.sourceFingerprint === 'string'
        ? stepData.conciergeBootstrap.sourceFingerprint
        : stepData?.sourceFingerprint;
    const publishedResultHash = stepData?.conciergeBootstrap?.resultHash;
    const priorCorrectionResultHash = stepData?.conciergeBootstrap?.v213CopyCorrection?.correctionResultHash;
    const targetFullName = exactTargetFullName(stepData);
    if (
        typeof sourceFingerprint !== 'string' || !SHA256.test(sourceFingerprint)
        || typeof publishedResultHash !== 'string' || !SHA256.test(publishedResultHash)
        || typeof priorCorrectionResultHash !== 'string' || !SHA256.test(priorCorrectionResultHash)
        || !targetFullName
    ) {
        throw new Error('CONCIERGE_COPY_V214_CAS_OR_SUBJECT_CONFLICT');
    }
    const sourceRequestId = String((requests[0] as { id?: unknown }).id ?? '');
    if (!z.string().uuid().safeParse(sourceRequestId).success) {
        throw new Error('CONCIERGE_COPY_V214_SOURCE_SCOPE_CONFLICT');
    }
    const { data: targetEvidence, error: targetEvidenceError } = await supabaseAdmin.rpc(
        'load_analysis_v2_target_evidence',
        { p_request_id: sourceRequestId, p_job_key: 'track:target-evidence:collect' },
    );
    const rawTargetRows = targetEvidence as { rows?: unknown } | null;
    if (targetEvidenceError || !rawTargetRows || !Array.isArray(rawTargetRows.rows)
        || rawTargetRows.rows.length !== 95) {
        throw new Error('CONCIERGE_COPY_V214_TARGET_EVIDENCE_CONFLICT');
    }
    return {
        order,
        rows: parsedRows,
        sourceFingerprint,
        publishedResultHash,
        priorCorrectionResultHash,
        targetFullName,
        targetEvidence: z.array(targetEvidenceRowSchema).parse(rawTargetRows.rows),
    };
}

function featureAudit(input: FeatureAnalysisInput, requestId: string): StagedAiAuditContext {
    const resultIdentity = createFeatureAnalysisResultIdentity(input, AI_STAGE_POLICY_V211_VERSION);
    return {
        requestId,
        operationKey: resultIdentity.operationKey,
        resultIdentity,
        prepare: async () => ({ result: null, source: null, startingAttempt: 1 }),
        onBeforeAttempt: () => undefined,
        onAttemptTelemetry: () => undefined,
    };
}

function narrativeAudit(input: HighRiskNarrativeInput, requestId: string): StagedAiAuditContext {
    const resultIdentity = createHighRiskNarrativeResultIdentity(
        input,
        AI_STAGE_POLICY_V211_VERSION,
    );
    return {
        requestId,
        operationKey: resultIdentity.operationKey,
        resultIdentity,
        prepare: async () => ({ result: null, source: null, startingAttempt: 1 }),
        onBeforeAttempt: () => undefined,
        onAttemptTelemetry: () => undefined,
    };
}

function interactionRows(
    targetEvidence: readonly z.infer<typeof targetEvidenceRowSchema>[],
): readonly InteractionEvidenceRow[] {
    return targetEvidence.map(row => ({
        candidateUsername: normalizedUsername(row.actorUsername),
        postId: row.postId,
        signal: row.signal === 'target_post_like' ? 'female_target_like' : 'female_target_comment',
        sourceInteractionId: row.sourceInteractionId,
        ...(row.occurredAt ? { occurredAt: row.occurredAt } : {}),
        ...(row.content ? { content: row.content } : {}),
    }));
}

function observedInteraction(input: HighRiskNarrativeInput): 'like' | 'comment' | 'tag' | 'mention' {
    if (input.interactions.candidateToTargetLike.status === 'observed') return 'like';
    if (input.interactions.candidateToTargetComment.status === 'observed') return 'comment';
    if (input.interactions.candidateToTargetTag.status === 'observed'
        || input.interactions.targetToCandidateTag.status === 'observed') return 'tag';
    if (input.interactions.candidateToTargetMention.status === 'observed'
        || input.interactions.targetToCandidateMention.status === 'observed') return 'mention';
    throw new Error('CONCIERGE_COPY_V214_HIGH_RISK_INTERACTION_EVIDENCE_MISSING');
}

async function generateGeminiCopy(scope: V214ExactScope) {
    const profiles = await loadRetainedConciergeProfileArtifacts();
    const selectedProfiles = scope.rows.map(row => {
        const profile = profiles.get(normalizedUsername(row.suspect_instagram_id));
        if (!profile) throw new Error('CONCIERGE_COPY_V214_PROFILE_SCOPE_CONFLICT');
        return firstPaymentConciergeCheckpointProfile(profile);
    });
    const sourceLineage = {
        selectedPlanId: 'basic',
        policyVersions: {
            pipeline: 'v2',
            aiStage: AI_STAGE_POLICY_V211_VERSION,
            risk: 'risk-policy-v2.5',
            scheduler: 'ai-scheduler-v1',
        },
    } as const;
    const bundle = await captureAnalysisV2ReplayBundle({
        selector: { targetUsername: scope.order.target_instagram_id },
        repository: {
            async findCompletedReplaySourceExact() {
                return { requestFingerprint: scope.sourceFingerprint, sourceLineage, completed: true };
            },
            async loadReplaySource() {
                return {
                    profiles: selectedProfiles,
                    evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
                    providerRuns: [],
                };
            },
        },
        normalizeMedia: createAnalysisV2SelectedMediaNormalizer(),
        evaluationPolicy: firstPaymentConciergeEvaluationPolicy,
    });
    if (bundle.profiles.length !== 16) throw new Error('CONCIERGE_COPY_V214_PROFILE_SCOPE_CONFLICT');
    const capturedByUsername = new Map(bundle.profiles.map(profile => [profile.username, profile]));
    const retainedByUsername = new Map(selectedProfiles.map(profile => [profile.username.toLowerCase(), profile]));
    const requestId = randomUUID();
    const replayCapability = issueReplayStatelessCapability();
    const targetProfile = {
        username: scope.order.target_instagram_id,
        fullName: scope.targetFullName,
        followersCount: 0,
        followingCount: 0,
        postsCount: 0,
        isPrivate: false,
        isVerified: false,
        latestPosts: [],
    };
    const interactions = interactionRows(scope.targetEvidence);
    const generated = [] as V214GeneratedCopy[];
    for (const row of scope.rows) {
        const username = normalizedUsername(row.suspect_instagram_id);
        const captured = capturedByUsername.get(username);
        const profile = retainedByUsername.get(username);
        if (!captured || !profile || captured.featureSelectionIds.length === 0) {
            throw new Error('CONCIERGE_COPY_V214_PROFILE_MEDIA_MISSING');
        }
        const triageSelectionIds = captured.triageSelectionIds.slice(0, 5);
        const featureInput: FeatureAnalysisInput = {
            triage: {
                assessment: {
                    inferredGender: 'female',
                    confidence: 'medium',
                    ownerConsistency: 'same_person',
                    evidenceSelectionIds: triageSelectionIds.slice(0, 2),
                },
                routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall',
                analyzedSelectionIds: triageSelectionIds,
                v29AccountContext: 'personal',
            },
            bio: captured.bio ?? null,
            accountProfile: {
                fullName: captured.fullName,
                hasProfileImage: Boolean(captured.hasProfileImage),
                bio: captured.bio ?? null,
            },
            media: captured.media.map(media => ({
                selectionId: media.selectionId,
                kind: media.kind,
                normalizedJpegBase64: media.jpegBase64,
                ...(media.postId ? { postId: media.postId } : {}),
            })),
            captions: captured.captions,
        };
        const feature = await featureAnalysis(
            featureInput,
            featureAudit(featureInput, requestId),
            { aiStagePolicyVersion: AI_STAGE_POLICY_V211_VERSION, replayCapability },
        );
        if (row.risk_grade !== 'high_risk') {
            generated.push({
                rank: row.rank,
                source: 'gemini',
                oneLineOverview: feature.features.oneLineOverview,
                riskAnalysis: [],
                evidence: null,
            });
            continue;
        }
        const candidateFullName = profile.fullName ?? row.suspect_full_name;
        if (!candidateFullName) throw new Error('CONCIERGE_COPY_V214_CANDIDATE_FULL_NAME_REQUIRED');
        const narrativeInput = createFirstPaymentConciergeHighRiskNarrativeInput({
            targetProfile,
            candidateProfile: { ...profile, fullName: candidateFullName },
            capturedProfile: captured,
            feature,
            interactions,
        });
        const narrative = await highRiskNarrative(
            narrativeInput,
            narrativeAudit(narrativeInput, requestId),
            { aiStagePolicyVersion: AI_STAGE_POLICY_V211_VERSION },
        );
        if (narrative.source !== 'gemini') {
            throw new Error('CONCIERGE_COPY_V214_GEMINI_NARRATIVE_REQUIRED');
        }
        generated.push({
            rank: row.rank,
            source: 'gemini',
            oneLineOverview: feature.features.oneLineOverview,
            riskAnalysis: narrative.lines,
            evidence: {
                candidateFullName,
                targetFullName: scope.targetFullName,
                observedInteraction: observedInteraction(narrativeInput),
            },
        });
    }
    return generated;
}

async function verifyV214Correction(input: {
    requestId: string;
    payload: ReturnType<typeof buildV214GeminiCopyPayload>;
}): Promise<void> {
    const { data: rows, error } = await supabaseAdmin
        .from('analysis_results').select('*').eq('request_id', input.requestId).order('rank');
    if (error || !rows || rows.length !== 16) {
        throw new Error('CONCIERGE_COPY_V214_VERIFY_READ_FAILED');
    }
    const current = z.array(resultRowSchema).parse(rows) as V214FrozenResultRow[];
    if (
        canonical(current.map(nonCopySnapshot)) !== canonical(input.payload.factSnapshot)
        || current.some((row, index) => (
            row.one_line_overview !== input.payload.rows[index]?.oneLineOverview
            || canonical(row.risk_analysis) !== canonical(input.payload.rows[index]?.riskAnalysis)
            || row.one_line_overview === input.payload.rows[index]?.previousOverview
        ))
        || current.filter(row => row.risk_grade === 'high_risk').length !== 2
        || new Set(current.map(row => row.one_line_overview)).size !== 16
    ) {
        throw new Error('CONCIERGE_COPY_V214_VERIFY_CONFLICT');
    }
}

async function main(): Promise<void> {
    if (process.argv.slice(2).join(' ') !== '--confirm-v214-gemini-copy-correction') {
        throw new Error('CONCIERGE_COPY_V214_CONFIRMATION_REQUIRED');
    }
    const scope = await loadExactV214Scope();
    const generated = await generateGeminiCopy(scope);
    const payload = buildV214GeminiCopyPayload({ rows: scope.rows, generated });
    const correctionResultHash = sha256({
        qualityVersion: payload.qualityVersion,
        sourceFingerprint: scope.sourceFingerprint,
        publishedResultHash: scope.publishedResultHash,
        priorCorrectionResultHash: scope.priorCorrectionResultHash,
        factSnapshot: payload.factSnapshot,
        rows: payload.rows,
    });
    const { data, error } = await supabaseAdmin.rpc('correct_earlybird_v214_concierge_gemini_copy', {
        p_order_id: scope.order.id,
        p_owner_id: scope.order.user_id,
        p_result_request_id: scope.order.result_request_id,
        p_source_fingerprint: scope.sourceFingerprint,
        p_expected_published_result_hash: scope.publishedResultHash,
        p_prior_correction_result_hash: scope.priorCorrectionResultHash,
        p_expected_v213_fact_snapshot: payload.factSnapshot,
        p_correction_result_hash: correctionResultHash,
        p_copy_payload: { qualityVersion: payload.qualityVersion, rows: payload.rows },
    });
    if (error || !data || !['corrected', 'already_corrected'].includes(String((data as { state?: unknown }).state))) {
        throw new Error('CONCIERGE_COPY_V214_RPC_FAILED');
    }
    await verifyV214Correction({ requestId: scope.order.result_request_id, payload });
    console.log(JSON.stringify({
        state: 'completed',
        rpcState: (data as { state: string }).state,
        resultRows: 16,
        highRiskRows: 2,
        geminiOverviewRows: 16,
        geminiNarrativeRows: 2,
    }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch(error => {
        console.error(JSON.stringify({ state: 'failed', code: v214FailureCode(error) }));
        process.exitCode = 1;
    });
}
