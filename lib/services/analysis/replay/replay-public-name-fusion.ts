import type {
    PrivateNameAnalysisResult,
} from '@/lib/services/ai/private-name-analysis';
import type {
    FeatureAnalysisResult,
    GenderTriageResult,
} from '@/lib/services/ai/v2-staged-analysis';

export const PUBLIC_NAME_FUSION_NAME_CONFIDENCE_MIN = 0.8;
export const PUBLIC_NAME_FUSION_FEMALE_SCORE_MIN = 0.8;
export const PUBLIC_NAME_FUSION_MALE_SCORE_MAX = 0.2;
export const PUBLIC_NAME_FUSION_CALIBRATION_PREDICTED_MIN = 30;
export const PUBLIC_NAME_FUSION_SEX_PREDICTED_MIN = 10;
export const PUBLIC_NAME_FUSION_AGREEMENT_MIN_BPS = 9_500;

export type PublicNameFusionVote = 'male' | 'female';
export type PublicNameFusionBaseline = PublicNameFusionVote | 'unknown';

export interface PublicNameFusionCandidate {
    id: string;
    baseline: PublicNameFusionBaseline;
    officialOrGroupExcluded: boolean;
    name?: PrivateNameAnalysisResult;
    feature?: FeatureAnalysisResult;
    triage?: GenderTriageResult;
}

export interface PublicNameFusionSexCalibration {
    known: number;
    predicted: number;
    agreed: number;
    disagreed: number;
}

export interface PublicNameVisualFusionReport {
    publicAnalyzed: number;
    providerOk: boolean;
    calibration: PublicNameFusionSexCalibration & {
        male: PublicNameFusionSexCalibration;
        female: PublicNameFusionSexCalibration;
    };
    officialNegative: {
        known: number;
        attempted: number;
        accepted: number;
    };
    unknown: {
        eligible: number;
        predicted: number;
        rescuedMale: number;
        rescuedFemale: number;
        unresolved: number;
    };
    baseline: Record<PublicNameFusionBaseline, number>;
    final: Record<PublicNameFusionBaseline, number>;
    missingPublic: number;
    gates: {
        calibrationVolumePass: boolean;
        overallAgreementPass: boolean;
        maleVolumePass: boolean;
        maleAgreementPass: boolean;
        femaleVolumePass: boolean;
        femaleAgreementPass: boolean;
        officialNegativePass: boolean;
        observedUnknownRate: number;
        observedUnknownPass: boolean;
        worstCaseUnknownRate: number;
        worstCaseUnknownPass: boolean;
        adoptionPass: boolean;
    };
}

export function publicNameVote(
    result: PrivateNameAnalysisResult,
): PublicNameFusionVote | null {
    if (
        !result.isName
        || result.confidence < PUBLIC_NAME_FUSION_NAME_CONFIDENCE_MIN
    ) return null;
    if (result.femaleScore >= PUBLIC_NAME_FUSION_FEMALE_SCORE_MIN) {
        return 'female';
    }
    if (result.femaleScore <= PUBLIC_NAME_FUSION_MALE_SCORE_MAX) {
        return 'male';
    }
    return null;
}

export function publicVisualVote(input: {
    feature?: FeatureAnalysisResult;
    triage?: GenderTriageResult;
}): {
    vote: PublicNameFusionVote | null;
    officialOrGroup: boolean;
} {
    const selected = input.feature
        ? {
            gender: input.feature.features.gender,
            confidence: input.feature.features.genderConfidence,
            ownerConsistency: input.feature.features.ownerConsistency,
            evidenceSelectionIds:
                input.feature.features.evidenceSelectionIds.gender,
            accountContext: input.feature.features.accountContext,
        }
        : input.triage
            ? {
                gender: input.triage.assessment.inferredGender,
                confidence: input.triage.assessment.confidence,
                ownerConsistency: input.triage.assessment.ownerConsistency,
                evidenceSelectionIds:
                    input.triage.assessment.evidenceSelectionIds,
                accountContext: input.triage.v29AccountContext,
            }
            : undefined;
    const officialOrGroup =
        selected?.accountContext === 'official_group_or_brand';
    if (
        input.feature?.finalGenderDecision ===
            'unresolved_stage_conflict'
    ) {
        return { vote: null, officialOrGroup };
    }
    const personal = selected?.accountContext === 'personal'
        || selected?.accountContext === 'individual_creator';
    const vote = selected?.gender === 'female'
        ? 'female'
        : selected?.gender === 'male'
            ? 'male'
            : null;
    const supportedConfidence = selected?.confidence === 'medium'
        || selected?.confidence === 'high';
    if (
        !selected
        || vote === null
        || !supportedConfidence
        || selected.ownerConsistency !== 'same_person'
        || selected.evidenceSelectionIds.length < 1
        || !personal
    ) {
        return { vote: null, officialOrGroup };
    }
    return { vote, officialOrGroup };
}

function emptySexCalibration(): PublicNameFusionSexCalibration {
    return { known: 0, predicted: 0, agreed: 0, disagreed: 0 };
}

function agreementPass(values: PublicNameFusionSexCalibration): boolean {
    return values.predicted > 0
        && values.agreed * 10_000
            >= values.predicted * PUBLIC_NAME_FUSION_AGREEMENT_MIN_BPS;
}

function rate(numerator: number, denominator: number): number {
    return denominator === 0
        ? 0
        : Number((numerator / denominator).toFixed(4));
}

export function evaluatePublicNameVisualFusion(input: {
    candidates: readonly PublicNameFusionCandidate[];
    providerOk: boolean;
    missingPublic: number;
}): PublicNameVisualFusionReport {
    const baseline = { male: 0, female: 0, unknown: 0 };
    for (const candidate of input.candidates) baseline[candidate.baseline]++;
    const calibration = {
        ...emptySexCalibration(),
        male: emptySexCalibration(),
        female: emptySexCalibration(),
    };
    calibration.known = baseline.male + baseline.female;
    calibration.male.known = baseline.male;
    calibration.female.known = baseline.female;
    const officialNegative = { known: 0, attempted: 0, accepted: 0 };
    const unknown = {
        eligible: 0,
        predicted: 0,
        rescuedMale: 0,
        rescuedFemale: 0,
        unresolved: baseline.unknown,
    };

    for (const candidate of input.candidates) {
        const visual = publicVisualVote(candidate);
        const name = input.providerOk
            && candidate.name?.id === candidate.id
            ? publicNameVote(candidate.name)
            : null;
        const officialOrGroup = candidate.officialOrGroupExcluded
            || visual.officialOrGroup;
        const modalityEligible = name !== null && visual.vote !== null;
        const modalityAccepted =
            modalityEligible && name === visual.vote;
        if (officialOrGroup) {
            officialNegative.known++;
            if (modalityEligible) officialNegative.attempted++;
            if (modalityAccepted) officialNegative.accepted++;
        }
        if (candidate.baseline !== 'unknown') {
            const sex = calibration[candidate.baseline];
            if (!name) continue;
            calibration.predicted++;
            sex.predicted++;
            if (name === candidate.baseline) {
                calibration.agreed++;
                sex.agreed++;
            } else {
                calibration.disagreed++;
                sex.disagreed++;
            }
            continue;
        }
        const eligible = !officialOrGroup && modalityEligible;
        const prediction = eligible && modalityAccepted ? name : null;
        if (eligible) unknown.eligible++;
        if (!prediction) continue;
        unknown.predicted++;
        unknown.unresolved--;
        if (prediction === 'male') unknown.rescuedMale++;
        else unknown.rescuedFemale++;
    }

    const final = {
        male: baseline.male + unknown.rescuedMale,
        female: baseline.female + unknown.rescuedFemale,
        unknown: unknown.unresolved,
    };
    const observedTotal = input.candidates.length;
    const worstCaseTotal = observedTotal + input.missingPublic;
    const worstCaseUnknown = final.unknown + input.missingPublic;
    const calibrationVolumePass =
        calibration.predicted >= PUBLIC_NAME_FUSION_CALIBRATION_PREDICTED_MIN;
    const overallAgreementPass = agreementPass(calibration);
    const maleVolumePass =
        calibration.male.predicted >= PUBLIC_NAME_FUSION_SEX_PREDICTED_MIN;
    const maleAgreementPass =
        maleVolumePass && agreementPass(calibration.male);
    const femaleVolumePass =
        calibration.female.predicted >= PUBLIC_NAME_FUSION_SEX_PREDICTED_MIN;
    const femaleAgreementPass =
        femaleVolumePass && agreementPass(calibration.female);
    const officialNegativePass = officialNegative.accepted === 0;
    const observedUnknownPass = final.unknown * 5 <= observedTotal;
    const worstCaseUnknownPass = worstCaseUnknown * 5 <= worstCaseTotal;
    const gates = {
        calibrationVolumePass,
        overallAgreementPass,
        maleVolumePass,
        maleAgreementPass,
        femaleVolumePass,
        femaleAgreementPass,
        officialNegativePass,
        observedUnknownRate: rate(final.unknown, observedTotal),
        observedUnknownPass,
        worstCaseUnknownRate: rate(worstCaseUnknown, worstCaseTotal),
        worstCaseUnknownPass,
        adoptionPass: input.providerOk
            && calibrationVolumePass
            && overallAgreementPass
            && maleVolumePass
            && maleAgreementPass
            && femaleVolumePass
            && femaleAgreementPass
            && officialNegativePass
            && observedUnknownPass
            && worstCaseUnknownPass,
    };
    return {
        publicAnalyzed: input.providerOk ? input.candidates.length : 0,
        providerOk: input.providerOk,
        calibration,
        officialNegative,
        unknown,
        baseline,
        final,
        missingPublic: input.missingPublic,
        gates,
    };
}
