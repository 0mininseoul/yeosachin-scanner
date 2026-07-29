import type {
    PrivateNameAnalysisResult,
} from '@/lib/services/ai/private-name-analysis';
import type {
    FeatureAnalysisResult,
    GenderTriageResult,
} from '@/lib/services/ai/v2-staged-analysis';
import type {
    PublicNameFusionBaseline,
    PublicNameVisualFusionReport,
} from './replay-public-name-fusion';
import {
    publicNameVote,
    publicVisualVote,
} from './replay-public-name-fusion';

export const PUBLIC_VISUAL_NULL_REASONS_V218 = [
    'missing_result',
    'stage_conflict',
    'nonbinary_gender',
    'low_confidence',
    'owner_mismatch_or_not_visible',
    'no_evidence',
    'nonpersonal_context',
    'official_or_group',
] as const;

export type PublicVisualNullReasonV218 =
    typeof PUBLIC_VISUAL_NULL_REASONS_V218[number];
export type PublicSelectedContextV218 =
    | 'personal'
    | 'individual_creator'
    | 'uncertain'
    | 'official_group_or_brand';

export interface PublicGenderHeadroomCandidateV218 {
    id: string;
    baseline: PublicNameFusionBaseline;
    officialOrGroupExcluded: boolean;
    fullNamePresent: boolean;
    name?: PrivateNameAnalysisResult;
    feature?: FeatureAnalysisResult;
    triage?: GenderTriageResult;
    resolverMedia: readonly (
        | { kind: 'profile' }
        | { kind: 'feed'; postId?: string }
    )[];
}

export interface PublicHeadroomCalibrationV218 {
    known: number;
    predicted: number;
    agreed: number;
    disagreed: number;
    wilsonLowerBoundBps: number;
}

interface PublicHeadroomCalibrationGroupV218 {
    overall: PublicHeadroomCalibrationV218;
    male: PublicHeadroomCalibrationV218;
    female: PublicHeadroomCalibrationV218;
}

export interface PublicGenderHeadroomReportV218 {
    baselineUnknown: number;
    finalUnknown: number;
    requiredAdditionalRescuesToObserved20: number;
    requiredAdditionalRescuesToWorst20: number;
    unknownNameVote: {
        female: number;
        male: number;
        none: number;
    };
    unknownVisualVote: {
        female: number;
        male: number;
        none: number;
        nullReasons: Record<PublicVisualNullReasonV218, number>;
    };
    guardedFemaleNameOnly: {
        strongName: number;
        officialBlocked: number;
        contextBlocked: number;
        stageConflictBlocked: number;
        maleVisualConflictBlocked: number;
        eligible: number;
    };
    mediaHeadroom: {
        finalUnknown: number;
        resolverMediaAtLeast2: number;
        distinctFeedPostsAtLeast2: number;
        profileOnly: number;
        noMedia: number;
        contextPersonalOrCreator: number;
        contextUncertain: number;
        contextOfficial: number;
        highBinaryTriageSameOwner: number;
        distinctPosts2AndPersonalOrCreator: number;
        distinctPosts2AndUncertain: number;
        distinctPosts2AndStrongFemaleName: number;
    };
    knownCalibrationRestricted: PublicHeadroomCalibrationGroupV218 & {
        fullNamePresent: PublicHeadroomCalibrationGroupV218;
        usernameOnly: PublicHeadroomCalibrationGroupV218;
    };
    gates: {
        guardedFemaleCandidateVolumePass: boolean;
        restrictedFemaleSamplePass: boolean;
        restrictedFemalePrecisionPass: boolean;
        officialFinalRescuePass: boolean;
        nameOnlyPathWorthFurtherStudy: boolean;
    };
}

function selectedVisual(input: {
    feature?: FeatureAnalysisResult;
    triage?: GenderTriageResult;
}): {
    gender: 'female' | 'male' | 'unknown';
    confidence: 'low' | 'medium' | 'high';
    ownerConsistency:
        | 'same_person'
        | 'multiple_or_unclear'
        | 'not_visible'
        | 'mixed_people';
    evidenceSelectionIds: readonly string[];
    accountContext: PublicSelectedContextV218;
} | undefined {
    if (input.feature) {
        return {
            gender: input.feature.features.gender,
            confidence: input.feature.features.genderConfidence,
            ownerConsistency: input.feature.features.ownerConsistency,
            evidenceSelectionIds:
                input.feature.features.evidenceSelectionIds.gender,
            accountContext: input.feature.features.accountContext,
        };
    }
    if (!input.triage) return undefined;
    return {
        gender: input.triage.assessment.inferredGender,
        confidence: input.triage.assessment.confidence,
        ownerConsistency: input.triage.assessment.ownerConsistency,
        evidenceSelectionIds:
            input.triage.assessment.evidenceSelectionIds,
        accountContext: input.triage.v29AccountContext ?? 'uncertain',
    };
}

export function publicVisualDiagnosticV218(input: {
    officialOrGroupExcluded: boolean;
    feature?: FeatureAnalysisResult;
    triage?: GenderTriageResult;
}): {
    vote: 'female' | 'male' | null;
    nullReason: PublicVisualNullReasonV218 | null;
    rawGender: 'female' | 'male' | 'unknown' | null;
    selectedContext: PublicSelectedContextV218;
    stageConflict: boolean;
} {
    const selected = selectedVisual(input);
    const selectedContext = selected?.accountContext ?? 'uncertain';
    const stageConflict =
        input.feature?.finalGenderDecision === 'unresolved_stage_conflict';
    const rawGender = selected?.gender ?? null;
    const result = (
        vote: 'female' | 'male' | null,
        nullReason: PublicVisualNullReasonV218 | null,
    ) => ({
        vote,
        nullReason,
        rawGender,
        selectedContext,
        stageConflict,
    });
    if (
        input.officialOrGroupExcluded
        || selectedContext === 'official_group_or_brand'
    ) {
        return result(null, 'official_or_group');
    }
    if (!selected) return result(null, 'missing_result');
    if (stageConflict) return result(null, 'stage_conflict');
    if (selected.gender !== 'female' && selected.gender !== 'male') {
        return result(null, 'nonbinary_gender');
    }
    if (
        selected.confidence !== 'medium'
        && selected.confidence !== 'high'
    ) {
        return result(null, 'low_confidence');
    }
    if (selected.ownerConsistency !== 'same_person') {
        return result(null, 'owner_mismatch_or_not_visible');
    }
    if (selected.evidenceSelectionIds.length === 0) {
        return result(null, 'no_evidence');
    }
    if (
        selectedContext !== 'personal'
        && selectedContext !== 'individual_creator'
    ) {
        return result(null, 'nonpersonal_context');
    }
    return result(selected.gender, null);
}

export function oneSidedWilsonLowerBoundBps95(
    agreed: number,
    predicted: number,
): number {
    if (
        !Number.isInteger(agreed)
        || !Number.isInteger(predicted)
        || agreed < 0
        || predicted < 0
        || agreed > predicted
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_V218_WILSON_INPUT_INVALID');
    }
    if (predicted === 0) return 0;
    const z = 1.6448536269514722;
    const proportion = agreed / predicted;
    const zSquared = z * z;
    const lower = (
        proportion
        + zSquared / (2 * predicted)
        - z * Math.sqrt(
            proportion * (1 - proportion) / predicted
            + zSquared / (4 * predicted * predicted),
        )
    ) / (1 + zSquared / predicted);
    return Math.floor(lower * 10_000);
}

function emptyCalibration(): PublicHeadroomCalibrationV218 {
    return {
        known: 0,
        predicted: 0,
        agreed: 0,
        disagreed: 0,
        wilsonLowerBoundBps: 0,
    };
}

function emptyCalibrationGroup(): PublicHeadroomCalibrationGroupV218 {
    return {
        overall: emptyCalibration(),
        male: emptyCalibration(),
        female: emptyCalibration(),
    };
}

function finalizeCalibration(
    group: PublicHeadroomCalibrationGroupV218,
): void {
    for (const values of [group.overall, group.male, group.female]) {
        values.wilsonLowerBoundBps = oneSidedWilsonLowerBoundBps95(
            values.agreed,
            values.predicted,
        );
    }
}

function countCalibration(
    group: PublicHeadroomCalibrationGroupV218,
    baseline: 'female' | 'male',
    vote: 'female' | 'male' | null,
): void {
    const values = [group.overall, group[baseline]];
    for (const calibration of values) {
        calibration.known++;
        if (!vote) continue;
        calibration.predicted++;
        if (vote === baseline) calibration.agreed++;
        else calibration.disagreed++;
    }
}

function requiredRescues(
    unknown: number,
    total: number,
): number {
    return Math.max(0, unknown - Math.floor(total / 5));
}

function finalClassification(
    candidate: PublicGenderHeadroomCandidateV218,
    providerOk: boolean,
): PublicNameFusionBaseline {
    if (candidate.baseline !== 'unknown' || !providerOk) {
        return candidate.baseline;
    }
    const nameVote = candidate.name?.id === candidate.id
        ? publicNameVote(candidate.name)
        : null;
    const visual = publicVisualVote(candidate);
    if (
        !nameVote
        || !visual.vote
        || nameVote !== visual.vote
        || candidate.officialOrGroupExcluded
        || visual.officialOrGroup
    ) {
        return 'unknown';
    }
    return nameVote;
}

export function evaluatePublicGenderHeadroomV218(input: {
    candidates: readonly PublicGenderHeadroomCandidateV218[];
    providerOk: boolean;
    missingPublic: number;
    fusion: PublicNameVisualFusionReport;
}): PublicGenderHeadroomReportV218 {
    if (
        !Number.isInteger(input.missingPublic)
        || input.missingPublic < 0
        || input.fusion.providerOk !== input.providerOk
        || input.fusion.missingPublic !== input.missingPublic
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_V218_HEADROOM_CONSERVATION_FAILED',
        );
    }
    const baseline = { male: 0, female: 0, unknown: 0 };
    const final = { male: 0, female: 0, unknown: 0 };
    const finalByCandidate = new Map<string, PublicNameFusionBaseline>();
    for (const candidate of input.candidates) {
        baseline[candidate.baseline]++;
        const classification = finalClassification(
            candidate,
            input.providerOk,
        );
        final[classification]++;
        finalByCandidate.set(candidate.id, classification);
    }
    if (
        baseline.male !== input.fusion.baseline.male
        || baseline.female !== input.fusion.baseline.female
        || baseline.unknown !== input.fusion.baseline.unknown
        || final.male !== input.fusion.final.male
        || final.female !== input.fusion.final.female
        || final.unknown !== input.fusion.final.unknown
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_V218_HEADROOM_CONSERVATION_FAILED',
        );
    }

    const unknownNameVote = { female: 0, male: 0, none: 0 };
    const nullReasons = Object.fromEntries(
        PUBLIC_VISUAL_NULL_REASONS_V218.map(reason => [reason, 0]),
    ) as Record<PublicVisualNullReasonV218, number>;
    const unknownVisualVote = {
        female: 0,
        male: 0,
        none: 0,
        nullReasons,
    };
    const guardedFemaleNameOnly = {
        strongName: 0,
        officialBlocked: 0,
        contextBlocked: 0,
        stageConflictBlocked: 0,
        maleVisualConflictBlocked: 0,
        eligible: 0,
    };
    const mediaHeadroom = {
        finalUnknown: final.unknown,
        resolverMediaAtLeast2: 0,
        distinctFeedPostsAtLeast2: 0,
        profileOnly: 0,
        noMedia: 0,
        contextPersonalOrCreator: 0,
        contextUncertain: 0,
        contextOfficial: 0,
        highBinaryTriageSameOwner: 0,
        distinctPosts2AndPersonalOrCreator: 0,
        distinctPosts2AndUncertain: 0,
        distinctPosts2AndStrongFemaleName: 0,
    };
    const knownCalibrationRestricted = {
        ...emptyCalibrationGroup(),
        fullNamePresent: emptyCalibrationGroup(),
        usernameOnly: emptyCalibrationGroup(),
    };

    for (const candidate of input.candidates) {
        const nameVote = input.providerOk
            && candidate.name?.id === candidate.id
            ? publicNameVote(candidate.name)
            : null;
        const visual = publicVisualDiagnosticV218(candidate);
        const fusionVisual = publicVisualVote(candidate);
        const personalOrCreator =
            visual.selectedContext === 'personal'
            || visual.selectedContext === 'individual_creator';
        if (candidate.baseline === 'unknown') {
            if (input.providerOk) {
                unknownNameVote[nameVote ?? 'none']++;
            }
            if (visual.vote) {
                unknownVisualVote[visual.vote]++;
            } else {
                unknownVisualVote.none++;
                if (!visual.nullReason) {
                    throw new Error(
                        'ANALYSIS_V2_REPLAY_V218_HEADROOM_CONSERVATION_FAILED',
                    );
                }
                nullReasons[visual.nullReason]++;
            }
            if (
                input.providerOk
                && nameVote === 'female'
                && fusionVisual.vote !== 'female'
            ) {
                guardedFemaleNameOnly.strongName++;
                if (
                    candidate.officialOrGroupExcluded
                    || fusionVisual.officialOrGroup
                ) {
                    guardedFemaleNameOnly.officialBlocked++;
                } else if (!personalOrCreator) {
                    guardedFemaleNameOnly.contextBlocked++;
                } else if (visual.stageConflict) {
                    guardedFemaleNameOnly.stageConflictBlocked++;
                } else if (
                    fusionVisual.vote === 'male'
                    || visual.rawGender === 'male'
                ) {
                    guardedFemaleNameOnly.maleVisualConflictBlocked++;
                } else {
                    guardedFemaleNameOnly.eligible++;
                }
            }
        } else if (
            !candidate.officialOrGroupExcluded
            && personalOrCreator
        ) {
            countCalibration(
                knownCalibrationRestricted,
                candidate.baseline,
                nameVote,
            );
            countCalibration(
                candidate.fullNamePresent
                    ? knownCalibrationRestricted.fullNamePresent
                    : knownCalibrationRestricted.usernameOnly,
                candidate.baseline,
                nameVote,
            );
        }

        if (finalByCandidate.get(candidate.id) !== 'unknown') continue;
        const distinctFeedPosts = new Set(
            candidate.resolverMedia.flatMap(media => (
                media.kind === 'feed' && media.postId ? [media.postId] : []
            )),
        ).size;
        const distinctPosts2 = distinctFeedPosts >= 2;
        if (candidate.resolverMedia.length >= 2) {
            mediaHeadroom.resolverMediaAtLeast2++;
        }
        if (distinctPosts2) mediaHeadroom.distinctFeedPostsAtLeast2++;
        if (
            candidate.resolverMedia.length > 0
            && distinctFeedPosts === 0
        ) {
            mediaHeadroom.profileOnly++;
        }
        if (candidate.resolverMedia.length === 0) mediaHeadroom.noMedia++;
        if (personalOrCreator) {
            mediaHeadroom.contextPersonalOrCreator++;
            if (distinctPosts2) {
                mediaHeadroom.distinctPosts2AndPersonalOrCreator++;
            }
        } else if (
            visual.selectedContext === 'official_group_or_brand'
        ) {
            mediaHeadroom.contextOfficial++;
        } else {
            mediaHeadroom.contextUncertain++;
            if (distinctPosts2) {
                mediaHeadroom.distinctPosts2AndUncertain++;
            }
        }
        const triage = candidate.triage?.assessment;
        if (
            (triage?.inferredGender === 'male'
                || triage?.inferredGender === 'female')
            && triage.confidence === 'high'
            && triage.ownerConsistency === 'same_person'
        ) {
            mediaHeadroom.highBinaryTriageSameOwner++;
        }
        if (
            distinctPosts2
            && input.providerOk
            && nameVote === 'female'
        ) {
            mediaHeadroom.distinctPosts2AndStrongFemaleName++;
        }
    }
    finalizeCalibration(knownCalibrationRestricted);
    finalizeCalibration(knownCalibrationRestricted.fullNamePresent);
    finalizeCalibration(knownCalibrationRestricted.usernameOnly);

    const observedTotal = input.candidates.length;
    const worstTotal = observedTotal + input.missingPublic;
    const worstUnknown = final.unknown + input.missingPublic;
    const requiredAdditionalRescuesToObserved20 = requiredRescues(
        final.unknown,
        observedTotal,
    );
    const requiredAdditionalRescuesToWorst20 = requiredRescues(
        worstUnknown,
        worstTotal,
    );
    const guardedFemaleCandidateVolumePass =
        guardedFemaleNameOnly.eligible
            >= requiredAdditionalRescuesToObserved20;
    const restrictedFemaleSamplePass =
        knownCalibrationRestricted.female.predicted >= 150;
    const restrictedFemalePrecisionPass =
        knownCalibrationRestricted.female.wilsonLowerBoundBps >= 9_500;
    const officialFinalRescuePass =
        input.fusion.officialNegative.accepted === 0;
    return {
        baselineUnknown: baseline.unknown,
        finalUnknown: final.unknown,
        requiredAdditionalRescuesToObserved20,
        requiredAdditionalRescuesToWorst20,
        unknownNameVote,
        unknownVisualVote,
        guardedFemaleNameOnly,
        mediaHeadroom,
        knownCalibrationRestricted,
        gates: {
            guardedFemaleCandidateVolumePass,
            restrictedFemaleSamplePass,
            restrictedFemalePrecisionPass,
            officialFinalRescuePass,
            nameOnlyPathWorthFurtherStudy:
                input.providerOk
                && guardedFemaleCandidateVolumePass
                && restrictedFemaleSamplePass
                && restrictedFemalePrecisionPass
                && officialFinalRescuePass,
        },
    };
}
