import { z } from 'zod';
import { MAX_TRIAGE_MEDIA } from '@/lib/domain/analysis/media-policy';
import type {
    FeatureAnalysisResult,
    GenderResolutionResult,
    GenderTriageResult,
} from './v2-staged-analysis';

export type GenderBaselineClassification =
    | FeatureAnalysisResult['finalGenderDecision']
    | 'fetch_unavailable'
    | 'media_unavailable'
    | 'analysis_unavailable';
export type GenderClassificationSource =
    | 'triage'
    | 'feature'
    | 'gender_resolution'
    | 'unknown'
    | 'unavailable';

export interface GenderResolutionReconciliationInput {
    baselineClassification: GenderBaselineClassification;
    baselineSource: Exclude<GenderClassificationSource, 'gender_resolution'>;
    triage: GenderTriageResult['assessment'] | null;
    feature: FeatureAnalysisResult | null;
    /** Only a ready, audited, pre-cutoff resolver result may be passed here. */
    resolver: GenderResolutionResult | null;
}

export interface GenderResolutionReconciliationResult {
    finalClassification: GenderBaselineClassification;
    classificationSource: GenderClassificationSource;
    resolverApplied: boolean;
}

const genderResolutionResultSchema = z.object({
    assessment: z.object({
        inferredGender: z.enum(['female', 'male', 'unknown']),
        confidence: z.enum(['low', 'medium', 'high']),
        ownerConsistency: z.enum(['same_person', 'mixed_people', 'not_visible']),
        evidenceSelectionIds: z.array(z.string().trim().min(1).max(240)).max(5),
    }).strict(),
    analyzedSelectionIds: z.array(z.string().trim().min(1).max(240)).max(MAX_TRIAGE_MEDIA),
}).strict();

function verifiedClassificationFor(
    gender: 'female' | 'male',
): Extract<GenderBaselineClassification, 'verified_female' | 'verified_non_female'> {
    return gender === 'female' ? 'verified_female' : 'verified_non_female';
}

function isBinaryGender(value: unknown): value is 'female' | 'male' {
    return value === 'female' || value === 'male';
}

function isMediumOrHigh(value: 'low' | 'medium' | 'high'): boolean {
    return value === 'medium' || value === 'high';
}

export function applyGenderResolution(
    input: GenderResolutionReconciliationInput,
): GenderResolutionReconciliationResult {
    const unchanged = (): GenderResolutionReconciliationResult => ({
        finalClassification: input.baselineClassification,
        classificationSource: input.baselineSource,
        resolverApplied: false,
    });
    if (
        input.baselineClassification === 'verified_female'
        || input.baselineClassification === 'verified_non_female'
        || input.baselineClassification === 'fetch_unavailable'
        || input.resolver === null
    ) {
        return unchanged();
    }

    const resolver = genderResolutionResultSchema.parse(input.resolver).assessment;
    const resolverGender = resolver.inferredGender;
    const resolverEvidenceCount = new Set(resolver.evidenceSelectionIds).size;
    const isHighSameOwnerResolver = isBinaryGender(resolverGender)
        && resolver.confidence === 'high'
        && resolver.ownerConsistency === 'same_person'
        && resolverEvidenceCount >= 2;
    let shouldApply = false;

    if (
        input.baselineClassification === 'unresolved'
        // A profile that reached the resolver with no retained feature is
        // still a real, re-normalized profile.  A high/same-owner result is
        // sufficient to repair a transient feature/analysis failure.  The
        // resolver never runs for fetch_unavailable because there is no
        // profile snapshot from which to form valid model media.
        || input.baselineClassification === 'media_unavailable'
        || input.baselineClassification === 'analysis_unavailable'
    ) {
        shouldApply = isHighSameOwnerResolver;
        const feature = input.feature?.features;
        if (
            !shouldApply
            && feature
            && isBinaryGender(resolverGender)
            && feature.gender === resolverGender
            && isMediumOrHigh(feature.genderConfidence)
            && isMediumOrHigh(resolver.confidence)
            && feature.ownerConsistency === 'same_person'
            && resolver.ownerConsistency === 'same_person'
            && new Set([
                ...feature.evidenceSelectionIds.gender,
                ...resolver.evidenceSelectionIds,
            ]).size >= 3
        ) {
            shouldApply = true;
        }
    } else if (
        input.baselineClassification === 'unresolved_stage_conflict'
        && isHighSameOwnerResolver
    ) {
        const conflictingGenders = new Set([
            input.triage?.inferredGender,
            input.feature?.features.gender,
        ].filter(isBinaryGender));
        shouldApply = conflictingGenders.has(resolverGender);
    }

    if (!shouldApply || !isBinaryGender(resolverGender)) {
        return unchanged();
    }
    return {
        finalClassification: verifiedClassificationFor(resolverGender),
        classificationSource: 'gender_resolution',
        resolverApplied: true,
    };
}
