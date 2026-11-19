import { z } from 'zod';
import {
    featureAnalysisInputSchema,
    featureAnalysisResultSchema,
} from '@/lib/services/ai/v2-staged-analysis';
import type { V2PreliminaryCandidateScore } from '@/lib/services/analysis/v2-candidate-scoring';

const candidateId = z.string().regex(/^candidate:[a-f0-9]{40}$/);
const rank = z.number().int().positive().nullable();
const preliminarySchema = z.object({
    candidateId,
    username: z.string().regex(/^eval_\d{1,3}$/),
    appearanceGrade: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    exposureScore: z.number().min(0).max(5),
    accountContext: z.enum(['personal', 'individual_creator', 'official_group_or_brand', 'uncertain']),
    hasWeakPartnerEvidence: z.boolean(),
    hasStrongPartnerEvidence: z.boolean(),
    uniqueTargetPostsLikedByCandidate: z.number().int().nonnegative(),
    boundedCandidateCommentsOnTarget: z.number().int().nonnegative(),
    hasCandidateToTargetTagOrCaptionMention: z.boolean(),
    hasTargetToCandidateTagOrCaptionMention: z.boolean(),
    recentFemaleMutualRank: rank,
    recentMutualBadgeRank: rank,
    preScore: z.number().finite(),
    verificationShortlistRank: rank,
}).strict() satisfies z.ZodType<V2PreliminaryCandidateScore>;

const sampleSchema = z.object({
    candidateId,
    input: featureAnalysisInputSchema,
    featureOperationKey: z.string().regex(/^feature-analysis:[a-f0-9]{64}$/),
    featureResult: featureAnalysisResultSchema,
}).strict();

export const devStandardEvalBundleSchema = z.object({
    version: z.literal(1),
    expiresAt: z.number().int().positive(),
    candidates: z.tuple([sampleSchema, sampleSchema, sampleSchema]),
    preliminary: z.array(preliminarySchema).min(3).max(800),
    observed: z.array(candidateId).max(800),
    notCollected: z.array(candidateId).max(800),
    partnerOverrides: z.array(z.object({
        candidateId,
        evidence: z.enum(['weak', 'strong']),
    }).strict()).max(800),
    originalHighRiskIds: z.array(candidateId).max(800),
}).strict().superRefine((bundle, ctx) => {
    const cohort = new Set(bundle.preliminary.map(row => row.candidateId));
    const groups = [
        bundle.candidates.map(row => row.candidateId),
        bundle.observed, bundle.notCollected,
        bundle.partnerOverrides.map(row => row.candidateId), bundle.originalHighRiskIds,
    ];
    if (cohort.size !== bundle.preliminary.length
        || groups.some(ids => new Set(ids).size !== ids.length || ids.some(id => !cohort.has(id)))
        || bundle.observed.some(id => bundle.notCollected.includes(id))) {
        ctx.addIssue({ code: 'custom', message: 'Evaluation cohort identity mismatch' });
    }
});

export type DevStandardEvalBundle = z.infer<typeof devStandardEvalBundleSchema>;
