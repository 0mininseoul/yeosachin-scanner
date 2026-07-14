import { z } from 'zod';
import { ANALYSIS_IMAGE_PREPARATION_FAILURE_REASONS } from '@/lib/services/ai/image-preprocessing';
import {
    featureAnalysisResultSchema,
    genderTriageResultSchema,
    partnerSafetyResultSchema,
} from '@/lib/services/ai/v2-staged-analysis';
import { analysisV2CheckpointProfileSchema } from './v2-profile-fetch-store';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type {
    AnalysisV2AiScoringStageStore,
    AnalysisV2FinalScoreSnapshot,
    AnalysisV2NarrativeSnapshot,
    AnalysisV2PartnerSafetySnapshot,
    AnalysisV2PrimaryJoinSnapshot,
    AnalysisV2ProfileAiOutcome,
    AnalysisV2ReverseLikeSnapshot,
    AnalysisV2ScreeningSnapshot,
    AnalysisV2StageReadClaim,
} from './v2-ai-scoring-executors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PROFILE_AI_OPERATION_KEY_PATTERN = /^(gender-triage|feature-analysis):[a-f0-9]{64}$/;
const PARTNER_OPERATION_KEY_PATTERN = /^partner-safety:[a-f0-9]{64}$/;
const NARRATIVE_OPERATION_KEY_PATTERN = /^high-risk-narrative:[a-f0-9]{64}$/;

export const ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES = Object.freeze({
    table: 'analysis_v2_ai_scoring_stage_checkpoints',
    checkpointRpc: 'checkpoint_analysis_v2_ai_scoring_stage',
    loadRpc: 'load_analysis_v2_ai_scoring_stage',
    loadProfileBatchesRpc: 'load_analysis_v2_profile_ai_stage_batches',
    purgeRpc: 'purge_analysis_v2_ai_scoring_stage',
});

const stageKindSchema = z.enum([
    'profile_ai_batch',
    'primary_join',
    'screening',
    'reverse_likes',
    'partner_safety',
    'final_score',
    'narrative',
]);

type StageKind = z.infer<typeof stageKindSchema>;

const candidateIdSchema = z.string().regex(CANDIDATE_ID_PATTERN);
const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9._]{1,30}$/);
const hashSchema = z.string().regex(SHA256_PATTERN);
const selectionIdSchema = z.string().trim().min(1).max(240);
const profileAiOperationKeySchema = z.string().regex(PROFILE_AI_OPERATION_KEY_PATTERN);
const appearanceGradeSchema = z.union([
    z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
]);
const nullableRankSchema = z.number().int().min(1).max(900).nullable();

const mediaCoverageSchema = z.object({
    selectedCount: z.number().int().min(0).max(20),
    normalizedCount: z.number().int().min(0).max(20),
    failures: z.array(z.object({
        selectionId: selectionIdSchema,
        reason: z.enum(ANALYSIS_IMAGE_PREPARATION_FAILURE_REASONS),
        disposition: z.enum(['transient', 'permanent']),
    }).strict()).max(20),
}).strict().superRefine((value, context) => {
    if (value.selectedCount !== value.normalizedCount + value.failures.length) {
        context.addIssue({ code: 'custom', message: 'Media coverage counts drifted.' });
    }
});

const captionSchema = z.object({
    evidenceRefId: z.string().trim().min(1).max(240),
    selectionId: selectionIdSchema,
    text: z.string().max(2_200),
}).strict();

const profileOutcomeSchema = z.object({
    candidateId: candidateIdSchema,
    instagramId: usernameSchema,
    status: z.enum([
        'verified_female',
        'verified_non_female',
        'unresolved',
        'unresolved_stage_conflict',
        'fetch_unavailable',
        'media_unavailable',
    ]),
    profile: analysisV2CheckpointProfileSchema.nullable(),
    triage: genderTriageResultSchema.nullable(),
    feature: featureAnalysisResultSchema.nullable(),
    normalizedSelectionIds: z.array(selectionIdSchema).max(11),
    captions: z.array(captionSchema).max(10),
    mediaCoverage: mediaCoverageSchema,
    genderOperationKey: profileAiOperationKeySchema.regex(/^gender-triage:/).nullable(),
    genderResultHash: hashSchema.nullable(),
    featureOperationKey: profileAiOperationKeySchema.regex(/^feature-analysis:/).nullable(),
    featureResultHash: hashSchema.nullable(),
    mediaBundlePersisted: z.boolean(),
}).strict().superRefine((value, context) => {
    const unavailable = value.status === 'fetch_unavailable';
    if (unavailable !== (value.profile === null)) {
        context.addIssue({ code: 'custom', path: ['profile'], message: 'Profile status mismatch.' });
    }
    if (unavailable && (
        value.triage || value.feature || value.genderOperationKey || value.genderResultHash
        || value.featureOperationKey || value.featureResultHash
        || value.normalizedSelectionIds.length > 0 || value.mediaBundlePersisted
    )) {
        context.addIssue({ code: 'custom', message: 'Unavailable outcome contains analysis data.' });
    }
    const mediaUnavailable = value.status === 'media_unavailable';
    if (mediaUnavailable && (
        value.profile === null || value.triage || value.feature
        || value.genderOperationKey || value.genderResultHash
        || value.featureOperationKey || value.featureResultHash
        || value.mediaBundlePersisted
    )) {
        context.addIssue({ code: 'custom', message: 'Media-unavailable outcome is inconsistent.' });
    }
    if (!unavailable && !mediaUnavailable && (
        !value.triage || !value.genderOperationKey || !value.genderResultHash
        || value.normalizedSelectionIds.length === 0
    )) {
        context.addIssue({ code: 'custom', message: 'Analyzed outcome is incomplete.' });
    }
    const featureRequired = [
        'verified_female', 'unresolved', 'unresolved_stage_conflict',
    ].includes(value.status);
    if (featureRequired && (
        !value.feature || !value.featureOperationKey || !value.featureResultHash
    )) {
        context.addIssue({ code: 'custom', message: 'Feature outcome is incomplete.' });
    }
    if (value.mediaBundlePersisted !== (value.status === 'verified_female')) {
        context.addIssue({ code: 'custom', message: 'Only verified women retain media bundles.' });
    }
    if (
        value.mediaCoverage.normalizedCount !== value.normalizedSelectionIds.length
        || value.mediaCoverage.selectedCount !== (
            value.mediaCoverage.normalizedCount + value.mediaCoverage.failures.length
        )
    ) {
        context.addIssue({ code: 'custom', message: 'Media coverage counts drifted.' });
    }
});

const interactionSchema = z.object({
    candidateUsername: usernameSchema,
    postId: z.string().trim().min(1).max(255),
    signal: z.enum(['female_target_like', 'female_target_comment']),
    sourceInteractionId: z.string().trim().min(1).max(255),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    content: z.string().max(1_000).optional(),
}).strict();

const primaryCandidateSchema = z.object({
    candidateId: candidateIdSchema,
    instagramId: usernameSchema,
    interactions: z.array(interactionSchema).max(690),
}).strict();

const preliminaryCandidateSchema = z.object({
    candidateId: candidateIdSchema,
    username: usernameSchema,
    appearanceGrade: appearanceGradeSchema,
    exposureScore: z.number().int().min(0).max(5),
    isBusinessAccount: z.boolean(),
    hasWeakPartnerEvidence: z.boolean(),
    hasStrongPartnerEvidence: z.boolean(),
    uniqueTargetPostsLikedByCandidate: z.number().int().min(0).max(4),
    boundedCandidateCommentsOnTarget: z.number().int().min(0).max(12),
    hasTagOrCaptionMention: z.boolean(),
    recentFemaleMutualRank: nullableRankSchema,
    recentMutualBadgeRank: z.number().int().min(1).max(5).nullable(),
    preScore: z.number().finite().min(0).max(97),
    verificationShortlistRank: z.number().int().min(1).max(10).nullable(),
}).strict();

const scoreComponentsSchema = z.object({
    candidateToTargetLikes: z.number().finite().min(0).max(20),
    candidateToTargetComments: z.number().finite().min(0).max(26),
    targetToCandidateLike: z.number().finite().min(0).max(3),
    tagOrCaptionMention: z.number().finite().min(0).max(14),
    recentMutual: z.number().finite().min(0).max(17),
    appearanceExposure: z.number().finite().min(0).max(20),
}).strict();

const riskResultSchema = z.object({
    policyVersion: z.literal('risk-policy-v2.2'),
    components: scoreComponentsSchema,
    softContextBeforeBusinessAdjustment: z.object({
        recentMutual: z.number().finite().min(0).max(17),
        appearanceExposure: z.number().finite().min(0).max(20),
    }).strict(),
    businessSoftContextMultiplier: z.union([z.literal(0.5), z.literal(1)]),
    weakPartnerAdjustment: z.union([z.literal(-5), z.literal(0)]),
    preScore: z.number().finite().min(0).max(97),
    rawScore: z.number().finite().min(0).max(100),
    possibleUpperBound: z.number().finite().min(0).max(100),
    publicScore: z.number().finite().min(1).max(10),
    displayScore: z.number().finite().min(1).max(10),
    possibleUpperPublicScore: z.number().finite().min(1).max(10),
    possibleUpperDisplayScore: z.number().finite().min(1).max(10),
    riskBand: z.enum(['normal', 'caution', 'high_risk']),
    partnerCapApplied: z.boolean(),
}).strict();

const finalCandidateSchema = preliminaryCandidateSchema.extend({
    reverseLikeStatus: z.enum(['observed', 'not_observed', 'not_collected']),
    risk: riskResultSchema,
    featuredRank: z.number().int().min(1).max(15).nullable(),
    relativeWatchRank: z.number().int().min(1).max(2).nullable(),
}).strict();

const reverseLikeRowSchema = z.object({
    candidateId: candidateIdSchema,
    shortlistRank: z.number().int().min(1).max(10),
    status: z.enum(['observed', 'observed_not_found', 'not_collected']),
    operationKey: z.string().trim().min(1).max(240).nullable(),
}).strict();

const partnerSafetyRowSchema = z.object({
    candidateId: candidateIdSchema,
    shortlistRank: z.number().int().min(1).max(10),
    result: partnerSafetyResultSchema,
    operationKey: z.string().regex(PARTNER_OPERATION_KEY_PATTERN).nullable(),
    resultHash: hashSchema.nullable(),
    mediaCoverage: mediaCoverageSchema,
}).strict();

const narrativeRowSchema = z.object({
    candidateId: candidateIdSchema,
    lines: z.tuple([
        z.string().trim().min(1).max(180),
        z.string().trim().min(1).max(180),
    ]),
    source: z.enum(['checkpoint', 'safe_fallback']),
    operationKey: z.string().regex(NARRATIVE_OPERATION_KEY_PATTERN),
    aiResultHash: hashSchema.nullable(),
}).strict().superRefine((value, context) => {
    if ((value.source === 'checkpoint') !== (value.aiResultHash !== null)) {
        context.addIssue({ code: 'custom', message: 'Narrative result provenance drifted.' });
    }
});

const profilePayloadSchema = z.object({
    outcomes: z.array(profileOutcomeSchema).min(1).max(30),
}).strict();
const primaryPayloadSchema = z.object({
    candidates: z.array(primaryCandidateSchema).max(900),
}).strict();
const screeningPayloadSchema = z.object({
    shortlistHash: hashSchema,
    candidates: z.array(preliminaryCandidateSchema).max(900),
}).strict();
const reverseRowsPayloadSchema = z.object({
    rows: z.array(reverseLikeRowSchema).max(10),
}).strict();
const partnerRowsPayloadSchema = z.object({
    rows: z.array(partnerSafetyRowSchema).max(10),
}).strict();
const narrativeRowsPayloadSchema = z.object({
    rows: z.array(narrativeRowSchema).max(3),
}).strict();
const finalPayloadSchema = z.object({
    candidates: z.array(finalCandidateSchema).max(900),
    narrativeCandidateIds: z.array(candidateIdSchema).max(3),
    narrativeBatchHash: hashSchema,
}).strict();

const rpcEnvelopeSchema = z.object({
    stageKind: stageKindSchema,
    batch: z.number().int().min(0).max(100_000).nullable(),
    revision: z.literal(1),
    resultHash: hashSchema,
    itemCount: z.number().int().min(0).max(1_200),
    payload: z.unknown(),
}).strict();

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2AiScoringStageSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export class AnalysisV2AiScoringStageFenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_SCORING_STAGE_FENCE_MISMATCH');
        this.name = 'AnalysisV2AiScoringStageFenceError';
    }
}

export class AnalysisV2AiScoringStageConflictError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_SCORING_STAGE_CONFLICT');
        this.name = 'AnalysisV2AiScoringStageConflictError';
    }
}

function validateClaim(input: AnalysisV2StageReadClaim): AnalysisV2StageReadClaim {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !JOB_KEY_PATTERN.test(input.jobKey)
        || !UUID_PATTERN.test(input.claimToken)
        || !SHA256_PATTERN.test(input.jobInputHash)
    ) {
        throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_VALIDATION_ERROR: invalid claim.');
    }
    return {
        requestId: input.requestId.toLowerCase(),
        jobKey: input.jobKey,
        claimToken: input.claimToken.toLowerCase(),
        jobInputHash: input.jobInputHash,
    };
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    if (
        error.message === 'ANALYSIS_V2_AI_SCORING_STAGE_FENCE_MISMATCH'
        || error.message === 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH'
    ) {
        throw new AnalysisV2AiScoringStageFenceError();
    }
    if (error.message === 'ANALYSIS_V2_AI_SCORING_STAGE_CONFLICT') {
        throw new AnalysisV2AiScoringStageConflictError();
    }
    throw new Error(
        `ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

interface StagePayloadMap {
    profile_ai_batch: z.infer<typeof profilePayloadSchema>;
    primary_join: z.infer<typeof primaryPayloadSchema>;
    screening: z.infer<typeof screeningPayloadSchema>;
    reverse_likes: z.infer<typeof reverseRowsPayloadSchema>;
    partner_safety: z.infer<typeof partnerRowsPayloadSchema>;
    final_score: z.infer<typeof finalPayloadSchema>;
    narrative: z.infer<typeof narrativeRowsPayloadSchema>;
}

function payloadSchema(kind: StageKind): z.ZodType<StagePayloadMap[StageKind]> {
    switch (kind) {
        case 'profile_ai_batch': return profilePayloadSchema;
        case 'primary_join': return primaryPayloadSchema;
        case 'screening': return screeningPayloadSchema;
        case 'reverse_likes': return reverseRowsPayloadSchema;
        case 'partner_safety': return partnerRowsPayloadSchema;
        case 'narrative': return narrativeRowsPayloadSchema;
        case 'final_score': return finalPayloadSchema;
    }
}

function parseEnvelope<K extends StageKind>(
    data: unknown,
    expectedKind: K,
    expectedBatch: number | null
): Omit<z.infer<typeof rpcEnvelopeSchema>, 'payload' | 'stageKind'> & {
    stageKind: K;
    payload: StagePayloadMap[K];
} {
    const parsed = rpcEnvelopeSchema.safeParse(Array.isArray(data) ? data[0] : data);
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: invalid response.');
    }
    if (parsed.data.stageKind !== expectedKind || parsed.data.batch !== expectedBatch) {
        throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: response drift.');
    }
    const payload = payloadSchema(expectedKind).safeParse(parsed.data.payload);
    if (!payload.success) {
        throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: invalid payload.');
    }
    return {
        ...parsed.data,
        stageKind: expectedKind,
        payload: payload.data as StagePayloadMap[K],
    };
}

function uniqueCandidates<T extends { candidateId: string }>(rows: readonly T[]): void {
    const ids = rows.map(row => candidateIdSchema.parse(row.candidateId));
    if (new Set(ids).size !== ids.length) {
        throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_VALIDATION_ERROR: duplicate candidate.');
    }
}

function commonParams(claim: AnalysisV2StageReadClaim) {
    const parsed = validateClaim(claim);
    return {
        p_request_id: parsed.requestId,
        p_job_key: parsed.jobKey,
        p_claim_token: parsed.claimToken,
        p_job_input_hash: parsed.jobInputHash,
    };
}

export function createSupabaseAnalysisV2AiScoringStageStore(
    client: AnalysisV2AiScoringStageSupabaseClient = supabaseAdmin
): AnalysisV2AiScoringStageStore {
    async function checkpoint<K extends StageKind>(
        claim: AnalysisV2StageReadClaim,
        kind: K,
        batch: number | null,
        itemCount: number,
        payload: unknown
    ) {
        const parsedPayload = payloadSchema(kind).parse(payload);
        const { data, error } = await client.rpc(
            ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES.checkpointRpc,
            {
                ...commonParams(claim),
                p_stage_kind: kind,
                p_batch: batch,
                p_item_count: itemCount,
                p_payload: parsedPayload,
            }
        );
        if (error) throwRpcError(error, 'checkpoint');
        const envelope = parseEnvelope(data, kind, batch);
        if (envelope.itemCount !== itemCount) {
            throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: item count drift.');
        }
        return envelope;
    }

    async function load<K extends Exclude<StageKind, 'profile_ai_batch'>>(
        claim: AnalysisV2StageReadClaim,
        kind: K
    ) {
        const { data, error } = await client.rpc(
            ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES.loadRpc,
            { ...commonParams(claim), p_stage_kind: kind }
        );
        if (error) throwRpcError(error, 'load');
        return data === null ? null : parseEnvelope(data, kind, null);
    }

    return {
        async checkpointProfileAiBatch(input) {
            const outcomes = profileOutcomeSchema.array().min(1).max(30).parse(input.outcomes);
            uniqueCandidates(outcomes);
            const envelope = await checkpoint(
                input,
                'profile_ai_batch',
                input.batch,
                outcomes.length,
                { outcomes }
            );
            return {
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                itemCount: envelope.itemCount,
            };
        },

        async loadProfileAiOutcomes(input) {
            const { data, error } = await client.rpc(
                ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES.loadProfileBatchesRpc,
                commonParams(input)
            );
            if (error) throwRpcError(error, 'profile batch load');
            if (!Array.isArray(data)) {
                throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: invalid profile batches.');
            }
            const batches = data.map(item => parseEnvelope(
                item,
                'profile_ai_batch',
                rpcEnvelopeSchema.parse(item).batch
            )).sort((left, right) => left.batch! - right.batch!);
            const outcomes = batches.flatMap(batch => batch.payload.outcomes);
            uniqueCandidates(outcomes);
            return Object.freeze(outcomes) as readonly AnalysisV2ProfileAiOutcome[];
        },

        async checkpointPrimaryJoin(input) {
            const candidates = primaryCandidateSchema.array().max(900).parse(input.candidates);
            uniqueCandidates(candidates);
            const envelope = await checkpoint(
                input, 'primary_join', null, candidates.length, { candidates }
            );
            return Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                candidates: envelope.payload.candidates,
            }) as AnalysisV2PrimaryJoinSnapshot;
        },

        async loadPrimaryJoin(input) {
            const envelope = await load(input, 'primary_join');
            return envelope === null ? null : Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                candidates: envelope.payload.candidates,
            }) as AnalysisV2PrimaryJoinSnapshot;
        },

        async checkpointScreening(input) {
            uniqueCandidates(input.candidates);
            const envelope = await checkpoint(input, 'screening', null, input.candidates.length, {
                shortlistHash: input.shortlistHash,
                candidates: input.candidates,
            });
            return Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                shortlistHash: envelope.payload.shortlistHash,
                candidates: envelope.payload.candidates,
            }) as AnalysisV2ScreeningSnapshot;
        },

        async loadScreening(input) {
            const envelope = await load(input, 'screening');
            return envelope === null ? null : Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                shortlistHash: envelope.payload.shortlistHash,
                candidates: envelope.payload.candidates,
            }) as AnalysisV2ScreeningSnapshot;
        },

        async checkpointReverseLikes(input) {
            uniqueCandidates(input.rows);
            const envelope = await checkpoint(
                input, 'reverse_likes', null, input.rows.length, { rows: input.rows }
            );
            return Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                rows: envelope.payload.rows,
            }) as AnalysisV2ReverseLikeSnapshot;
        },

        async loadReverseLikes(input) {
            const envelope = await load(input, 'reverse_likes');
            return envelope === null ? null : Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                rows: envelope.payload.rows,
            }) as AnalysisV2ReverseLikeSnapshot;
        },

        async checkpointPartnerSafety(input) {
            uniqueCandidates(input.rows);
            const envelope = await checkpoint(
                input, 'partner_safety', null, input.rows.length, { rows: input.rows }
            );
            return Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                rows: envelope.payload.rows,
            }) as AnalysisV2PartnerSafetySnapshot;
        },

        async loadPartnerSafety(input) {
            const envelope = await load(input, 'partner_safety');
            return envelope === null ? null : Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                rows: envelope.payload.rows,
            }) as AnalysisV2PartnerSafetySnapshot;
        },

        async checkpointFinalScores(input) {
            uniqueCandidates(input.candidates);
            const envelope = await checkpoint(input, 'final_score', null, input.candidates.length, {
                candidates: input.candidates,
                narrativeCandidateIds: input.narrativeCandidateIds,
                narrativeBatchHash: input.narrativeBatchHash,
            });
            return Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                candidates: envelope.payload.candidates,
                narrativeCandidateIds: envelope.payload.narrativeCandidateIds,
                narrativeBatchHash: envelope.payload.narrativeBatchHash,
            }) as AnalysisV2FinalScoreSnapshot;
        },

        async loadFinalScores(input) {
            const envelope = await load(input, 'final_score');
            return envelope === null ? null : Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                candidates: envelope.payload.candidates,
                narrativeCandidateIds: envelope.payload.narrativeCandidateIds,
                narrativeBatchHash: envelope.payload.narrativeBatchHash,
            }) as AnalysisV2FinalScoreSnapshot;
        },

        async checkpointNarratives(input) {
            uniqueCandidates(input.rows);
            const envelope = await checkpoint(
                input, 'narrative', null, input.rows.length, { rows: input.rows }
            );
            return Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                rows: envelope.payload.rows,
            }) as AnalysisV2NarrativeSnapshot;
        },

        async purgeTerminal(input) {
            const { data, error } = await client.rpc(
                ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES.purgeRpc,
                commonParams(input)
            );
            if (error) throwRpcError(error, 'purge');
            if (!Number.isSafeInteger(data) || (data as number) < 0) {
                throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: invalid purge result.');
            }
            return data as number;
        },
    };
}

export const analysisV2AiScoringStageStore =
    createSupabaseAnalysisV2AiScoringStageStore();
