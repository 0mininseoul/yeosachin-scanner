import { describe, expect, it } from 'vitest';
import {
    PUBLIC_NAME_FUSION_FEMALE_SCORE_MIN,
    PUBLIC_NAME_FUSION_MALE_SCORE_MAX,
    PUBLIC_NAME_FUSION_NAME_CONFIDENCE_MIN,
    evaluatePublicNameVisualFusion,
    publicNameVote,
    publicVisualVote,
} from './replay-public-name-fusion';

const triage = (
    gender: 'female' | 'male' | 'unknown',
    overrides: Record<string, unknown> = {},
) => ({
    assessment: {
        inferredGender: gender,
        confidence: 'medium' as const,
        ownerConsistency: 'same_person' as const,
        evidenceSelectionIds: ['media-1'],
    },
    routingDecision: 'route_to_feature_analysis' as const,
    routingReason: 'conserve_female_recall' as const,
    analyzedSelectionIds: ['media-1'],
    v29AccountContext: 'personal' as const,
    ...overrides,
});

const feature = (
    gender: 'female' | 'male' | 'unknown',
    overrides: Record<string, unknown> = {},
) => ({
    features: {
        gender,
        genderConfidence: 'medium' as const,
        ownerConsistency: 'same_person' as const,
        appearanceGrade: 3,
        exposureScore: 0,
        businessClassification: 'personal' as const,
        businessConfidence: 'medium' as const,
        accountContext: 'personal' as const,
        marriageEvidence: 'none' as const,
        partnerEvidence: 'none' as const,
        partnerExclusionContext: 'none' as const,
        evidenceSelectionIds: {
            gender: ['media-1'],
            appearance: [],
            exposure: [],
            business: [],
            accountContext: ['media-1'],
            marriagePartner: [],
        },
        oneLineOverview: '고정된 공개 자료를 근거로 만든 충분히 긴 테스트용 계정 요약입니다.',
        ...overrides,
    },
    finalGenderDecision: 'unresolved' as const,
    analyzedSelectionIds: ['media-1'],
});

describe('V2.17 public name and visual fusion', () => {
    it('freezes the strict name thresholds and never emits a weak or non-name vote', () => {
        expect(PUBLIC_NAME_FUSION_NAME_CONFIDENCE_MIN).toBe(0.8);
        expect(PUBLIC_NAME_FUSION_FEMALE_SCORE_MIN).toBe(0.8);
        expect(PUBLIC_NAME_FUSION_MALE_SCORE_MAX).toBe(0.2);
        expect(publicNameVote({
            id: 'ordinal:1', isName: true, confidence: 0.8, femaleScore: 0.8,
        })).toBe('female');
        expect(publicNameVote({
            id: 'ordinal:2', isName: true, confidence: 0.8, femaleScore: 0.2,
        })).toBe('male');
        expect(publicNameVote({
            id: 'ordinal:3', isName: false, confidence: 1, femaleScore: 0.8,
        })).toBeNull();
        expect(publicNameVote({
            id: 'ordinal:4', isName: true, confidence: 0.79, femaleScore: 0.8,
        })).toBeNull();
        expect(publicNameVote({
            id: 'ordinal:5', isName: true, confidence: 1, femaleScore: 0.5,
        })).toBeNull();
    });

    it('prefers raw feature over triage and blocks weak, unsupported, or official visual votes', () => {
        expect(publicVisualVote({
            feature: feature('female'),
            triage: triage('male'),
        })).toEqual({ vote: 'female', officialOrGroup: false });
        expect(publicVisualVote({
            feature: feature('female', { genderConfidence: 'low' }),
            triage: triage('male'),
        })).toEqual({ vote: null, officialOrGroup: false });
        expect(publicVisualVote({
            triage: triage('male'),
        })).toEqual({ vote: 'male', officialOrGroup: false });
        expect(publicVisualVote({
            feature: feature('female', {
                accountContext: 'official_group_or_brand',
            }),
            triage: triage('female'),
        })).toEqual({ vote: null, officialOrGroup: true });
        expect(publicVisualVote({
            feature: feature('female', {
                evidenceSelectionIds: {
                    gender: [],
                    appearance: [],
                    exposure: [],
                    business: [],
                    accountContext: ['media-1'],
                    marriagePartner: [],
                },
            }),
        })).toEqual({ vote: null, officialOrGroup: false });
    });

    it('fails closed when a high female feature conflicts with a high male triage', () => {
        expect(publicVisualVote({
            feature: {
                ...feature('female', { genderConfidence: 'high' }),
                finalGenderDecision: 'unresolved_stage_conflict',
            },
            triage: triage('male', {
                assessment: {
                    inferredGender: 'male',
                    confidence: 'high',
                    ownerConsistency: 'same_person',
                    evidenceSelectionIds: ['media-1'],
                },
            }),
        })).toEqual({ vote: null, officialOrGroup: false });
    });

    it('calibrates every strong public name vote instead of only visual consensus', () => {
        const candidates = Array.from({ length: 100 }, (_, index) => {
            const baseline = index < 50 ? 'female' as const : 'male' as const;
            const correctName = index % 50 >= 35;
            const nameVote = correctName
                ? baseline
                : baseline === 'female' ? 'male' : 'female';
            return {
                id: `ordinal:${index + 1}`,
                baseline,
                officialOrGroupExcluded: false,
                name: {
                    id: `ordinal:${index + 1}`,
                    isName: true,
                    confidence: 1,
                    femaleScore: nameVote === 'female' ? 1 : 0,
                },
                feature: feature(baseline),
            };
        });

        const report = evaluatePublicNameVisualFusion({
            candidates,
            providerOk: true,
            missingPublic: 0,
        });

        expect(report.calibration).toEqual({
            known: 100,
            predicted: 100,
            agreed: 30,
            disagreed: 70,
            female: {
                known: 50, predicted: 50, agreed: 15, disagreed: 35,
            },
            male: {
                known: 50, predicted: 50, agreed: 15, disagreed: 35,
            },
        });
        expect(report.gates).toMatchObject({
            calibrationVolumePass: true,
            overallAgreementPass: false,
            adoptionPass: false,
        });
    });

    it('hard-blocks canonical official provenance while measuring counterfactual acceptance', () => {
        const report = evaluatePublicNameVisualFusion({
            candidates: [{
                id: 'ordinal:1',
                baseline: 'unknown',
                officialOrGroupExcluded: true,
                name: {
                    id: 'ordinal:1',
                    isName: true,
                    confidence: 1,
                    femaleScore: 1,
                },
                triage: triage('female', {
                    assessment: {
                        inferredGender: 'female',
                        confidence: 'high',
                        ownerConsistency: 'same_person',
                        evidenceSelectionIds: ['media-1'],
                    },
                }),
            }],
            providerOk: true,
            missingPublic: 0,
        });

        expect(report.officialNegative).toEqual({
            known: 1,
            attempted: 1,
            accepted: 1,
        });
        expect(report.unknown).toEqual({
            eligible: 0,
            predicted: 0,
            rescuedMale: 0,
            rescuedFemale: 0,
            unresolved: 1,
        });
        expect(report.final).toEqual({
            male: 0, female: 0, unknown: 1,
        });
        expect(report.gates).toMatchObject({
            officialNegativePass: false,
            adoptionPass: false,
        });
    });

    it('classifies only exact agreement and conserves calibration, unknown, official, and missing cohorts', () => {
        const candidates = [
            {
                id: 'ordinal:1',
                baseline: 'female' as const,
                officialOrGroupExcluded: false,
                name: { id: 'ordinal:1', isName: true, confidence: 1, femaleScore: 1 },
                feature: feature('female'),
                triage: triage('male'),
            },
            {
                id: 'ordinal:2',
                baseline: 'male' as const,
                officialOrGroupExcluded: false,
                name: { id: 'ordinal:2', isName: true, confidence: 1, femaleScore: 1 },
                feature: feature('female'),
                triage: triage('female'),
            },
            {
                id: 'ordinal:3',
                baseline: 'unknown' as const,
                officialOrGroupExcluded: false,
                name: { id: 'ordinal:3', isName: true, confidence: 1, femaleScore: 0 },
                feature: feature('male'),
                triage: triage('female'),
            },
            {
                id: 'ordinal:4',
                baseline: 'unknown' as const,
                officialOrGroupExcluded: false,
                name: { id: 'ordinal:4', isName: true, confidence: 1, femaleScore: 1 },
                feature: feature('male'),
                triage: triage('female'),
            },
            {
                id: 'ordinal:5',
                baseline: 'unknown' as const,
                officialOrGroupExcluded: false,
                name: { id: 'ordinal:5', isName: true, confidence: 1, femaleScore: 1 },
                feature: feature('female', {
                    accountContext: 'official_group_or_brand',
                }),
                triage: triage('female'),
            },
        ];

        const report = evaluatePublicNameVisualFusion({
            candidates,
            providerOk: true,
            missingPublic: 2,
        });

        expect(report).toMatchObject({
            publicAnalyzed: 5,
            providerOk: true,
            calibration: {
                known: 2,
                predicted: 2,
                agreed: 1,
                disagreed: 1,
                female: { known: 1, predicted: 1, agreed: 1, disagreed: 0 },
                male: { known: 1, predicted: 1, agreed: 0, disagreed: 1 },
            },
            officialNegative: { known: 1, attempted: 0, accepted: 0 },
            unknown: {
                eligible: 2,
                predicted: 1,
                rescuedMale: 1,
                rescuedFemale: 0,
                unresolved: 2,
            },
            baseline: { male: 1, female: 1, unknown: 3 },
            final: { male: 2, female: 1, unknown: 2 },
            missingPublic: 2,
        });
        expect(report.gates).toMatchObject({
            calibrationVolumePass: false,
            overallAgreementPass: false,
            maleVolumePass: false,
            maleAgreementPass: false,
            femaleVolumePass: false,
            femaleAgreementPass: false,
            officialNegativePass: true,
            observedUnknownPass: false,
            worstCaseUnknownPass: false,
            adoptionPass: false,
        });
    });

    it('fails the whole public cohort closed when the name provider is non-ok', () => {
        const report = evaluatePublicNameVisualFusion({
            candidates: [{
                id: 'ordinal:1',
                baseline: 'unknown',
                officialOrGroupExcluded: false,
                name: { id: 'ordinal:1', isName: true, confidence: 1, femaleScore: 1 },
                feature: feature('female'),
                triage: triage('female'),
            }],
            providerOk: false,
            missingPublic: 0,
        });

        expect(report).toMatchObject({
            publicAnalyzed: 0,
            providerOk: false,
            unknown: {
                eligible: 0,
                predicted: 0,
                rescuedMale: 0,
                rescuedFemale: 0,
                unresolved: 1,
            },
            baseline: { male: 0, female: 0, unknown: 1 },
            final: { male: 0, female: 0, unknown: 1 },
            gates: { adoptionPass: false },
        });
    });
});
