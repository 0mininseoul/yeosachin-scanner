import { describe, expect, it } from 'vitest';
import {
    evaluatePublicNameVisualFusion,
} from './replay-public-name-fusion';
import {
    evaluatePublicGenderHeadroomV218,
    oneSidedWilsonLowerBoundBps95,
    publicVisualDiagnosticV218,
    type PublicGenderHeadroomCandidateV218,
} from './replay-public-gender-headroom-v218';

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
        oneLineOverview:
            '고정된 공개 자료를 근거로 만든 충분히 긴 테스트용 계정 요약입니다.',
        ...overrides,
    },
    finalGenderDecision: 'unresolved' as const,
    analyzedSelectionIds: ['media-1'],
});

const name = (
    id: string,
    vote: 'female' | 'male' | 'none',
) => ({
    id,
    isName: vote !== 'none',
    confidence: vote === 'none' ? 0 : 1,
    femaleScore: vote === 'female' ? 1 : vote === 'male' ? 0 : 0.5,
});

const feed = (postId: string) => ({ kind: 'feed' as const, postId });
const profile = { kind: 'profile' as const };

function candidate(
    id: string,
    overrides: Partial<PublicGenderHeadroomCandidateV218> = {},
): PublicGenderHeadroomCandidateV218 {
    return {
        id,
        baseline: 'unknown',
        officialOrGroupExcluded: false,
        fullNamePresent: false,
        resolverMedia: [],
        ...overrides,
    };
}

describe('V2.18 public gender headroom diagnostics', () => {
    it('assigns one deterministic visual null reason and always prefers raw feature evidence', () => {
        expect(publicVisualDiagnosticV218({
            officialOrGroupExcluded: false,
            feature: feature('female', { genderConfidence: 'low' }),
            triage: triage('male'),
        })).toEqual({
            vote: null,
            nullReason: 'low_confidence',
            rawGender: 'female',
            selectedContext: 'personal',
            stageConflict: false,
        });
        expect(publicVisualDiagnosticV218({
            officialOrGroupExcluded: true,
            feature: {
                ...feature('male', { accountContext: 'uncertain' }),
                finalGenderDecision: 'unresolved_stage_conflict',
            },
        })).toEqual({
            vote: null,
            nullReason: 'official_or_group',
            rawGender: 'male',
            selectedContext: 'uncertain',
            stageConflict: true,
        });
        expect([
            publicVisualDiagnosticV218({
                officialOrGroupExcluded: false,
            }).nullReason,
            publicVisualDiagnosticV218({
                officialOrGroupExcluded: false,
                feature: {
                    ...feature('female'),
                    finalGenderDecision: 'unresolved_stage_conflict',
                },
            }).nullReason,
            publicVisualDiagnosticV218({
                officialOrGroupExcluded: false,
                feature: feature('unknown'),
            }).nullReason,
            publicVisualDiagnosticV218({
                officialOrGroupExcluded: false,
                feature: feature('female', { genderConfidence: 'low' }),
            }).nullReason,
            publicVisualDiagnosticV218({
                officialOrGroupExcluded: false,
                feature: feature('female', {
                    ownerConsistency: 'not_visible',
                }),
            }).nullReason,
            publicVisualDiagnosticV218({
                officialOrGroupExcluded: false,
                feature: feature('female', {
                    evidenceSelectionIds: {
                        gender: [],
                        appearance: [],
                        exposure: [],
                        business: [],
                        accountContext: [],
                        marriagePartner: [],
                    },
                }),
            }).nullReason,
            publicVisualDiagnosticV218({
                officialOrGroupExcluded: false,
                feature: feature('female', { accountContext: 'uncertain' }),
            }).nullReason,
            publicVisualDiagnosticV218({
                officialOrGroupExcluded: false,
                feature: feature('female', {
                    accountContext: 'official_group_or_brand',
                }),
            }).nullReason,
        ]).toEqual([
            'missing_result',
            'stage_conflict',
            'nonbinary_gender',
            'low_confidence',
            'owner_mismatch_or_not_visible',
            'no_evidence',
            'nonpersonal_context',
            'official_or_group',
        ]);
    });

    it.each([
        [0, 0, 0],
        [1, 1, 2_698],
        [95, 100, 9_008],
        [99, 100, 9_564],
        [148, 150, 9_605],
        [150, 150, 9_822],
    ])(
        'computes fixed one-sided 95%% Wilson lower bound %i/%i as %i bps',
        (agreed, predicted, expected) => {
            expect(oneSidedWilsonLowerBoundBps95(
                agreed,
                predicted,
            )).toBe(expected);
        },
    );

    it('conserves the exact synthetic unknown, guarded, media, calibration, and missing-public matrix', () => {
        const candidates = [
            candidate('u1', {
                name: name('u1', 'female'),
                feature: feature('female'),
            }),
            candidate('u2', {
                name: name('u2', 'male'),
                feature: feature('male'),
            }),
            candidate('u3', {
                name: name('u3', 'female'),
            }),
            candidate('u4', {
                name: name('u4', 'female'),
                feature: {
                    ...feature('female'),
                    finalGenderDecision: 'unresolved_stage_conflict',
                },
                resolverMedia: [profile],
            }),
            candidate('u5', {
                name: name('u5', 'male'),
                feature: feature('unknown'),
                resolverMedia: [feed('carousel-1'), feed('carousel-1')],
            }),
            candidate('u6', {
                name: name('u6', 'female'),
                feature: feature('female', { genderConfidence: 'low' }),
                resolverMedia: [feed('post-1'), feed('post-2')],
            }),
            candidate('u7', {
                name: name('u7', 'female'),
                feature: feature('female', {
                    ownerConsistency: 'not_visible',
                }),
                resolverMedia: [
                    feed('carousel-2'),
                    feed('carousel-2'),
                    profile,
                ],
            }),
            candidate('u8', {
                name: name('u8', 'female'),
                feature: feature('female', {
                    evidenceSelectionIds: {
                        gender: [],
                        appearance: [],
                        exposure: [],
                        business: [],
                        accountContext: [],
                        marriagePartner: [],
                    },
                }),
                triage: triage('female', {
                    assessment: {
                        inferredGender: 'female',
                        confidence: 'high',
                        ownerConsistency: 'same_person',
                        evidenceSelectionIds: ['media-1'],
                    },
                }),
                resolverMedia: [feed('post-3'), feed('post-4')],
            }),
            candidate('u9', {
                name: name('u9', 'female'),
                feature: feature('female', { accountContext: 'uncertain' }),
                resolverMedia: [feed('post-5'), feed('post-6')],
            }),
            candidate('u10', {
                name: name('u10', 'female'),
                feature: feature('female', {
                    accountContext: 'official_group_or_brand',
                }),
                resolverMedia: [feed('post-7'), feed('post-8')],
            }),
            candidate('u11', {
                name: name('u11', 'female'),
                feature: feature('male'),
                resolverMedia: [feed('post-9'), feed('post-10')],
            }),
            candidate('k1', {
                baseline: 'female',
                name: name('k1', 'female'),
                feature: feature('female'),
                fullNamePresent: true,
            }),
            candidate('k2', {
                baseline: 'female',
                name: name('k2', 'male'),
                feature: feature('female'),
            }),
            candidate('k3', {
                baseline: 'female',
                name: name('k3', 'female'),
                feature: feature('female', { accountContext: 'uncertain' }),
            }),
            candidate('k4', {
                baseline: 'male',
                name: name('k4', 'male'),
                feature: feature('male', {
                    accountContext: 'individual_creator',
                }),
                fullNamePresent: true,
            }),
            candidate('k5', {
                baseline: 'male',
                name: name('k5', 'female'),
                feature: feature('male'),
            }),
            candidate('k6', {
                baseline: 'male',
                officialOrGroupExcluded: true,
                name: name('k6', 'male'),
            }),
        ];
        const fusion = evaluatePublicNameVisualFusion({
            candidates,
            providerOk: true,
            missingPublic: 3,
        });

        const report = evaluatePublicGenderHeadroomV218({
            candidates,
            providerOk: true,
            missingPublic: 3,
            fusion,
        });

        expect(fusion.final).toEqual({ male: 4, female: 4, unknown: 9 });
        expect(report).toMatchObject({
            baselineUnknown: 11,
            finalUnknown: 9,
            requiredAdditionalRescuesToObserved20: 6,
            requiredAdditionalRescuesToWorst20: 8,
            unknownNameVote: { female: 9, male: 2, none: 0 },
            unknownVisualVote: {
                female: 1,
                male: 2,
                none: 8,
                nullReasons: {
                    missing_result: 1,
                    stage_conflict: 1,
                    nonbinary_gender: 1,
                    low_confidence: 1,
                    owner_mismatch_or_not_visible: 1,
                    no_evidence: 1,
                    nonpersonal_context: 1,
                    official_or_group: 1,
                },
            },
            guardedFemaleNameOnly: {
                strongName: 8,
                officialBlocked: 1,
                contextBlocked: 2,
                stageConflictBlocked: 1,
                maleVisualConflictBlocked: 1,
                eligible: 3,
            },
            mediaHeadroom: {
                finalUnknown: 9,
                resolverMediaAtLeast2: 7,
                distinctFeedPostsAtLeast2: 5,
                profileOnly: 1,
                noMedia: 1,
                contextPersonalOrCreator: 6,
                contextUncertain: 2,
                contextOfficial: 1,
                highBinaryTriageSameOwner: 1,
                distinctPosts2AndPersonalOrCreator: 3,
                distinctPosts2AndUncertain: 1,
                distinctPosts2AndStrongFemaleName: 5,
            },
            knownCalibrationRestricted: {
                overall: {
                    known: 4,
                    predicted: 4,
                    agreed: 2,
                    disagreed: 2,
                    wilsonLowerBoundBps: 1_824,
                },
                female: {
                    known: 2,
                    predicted: 2,
                    agreed: 1,
                    disagreed: 1,
                    wilsonLowerBoundBps: 1_208,
                },
                male: {
                    known: 2,
                    predicted: 2,
                    agreed: 1,
                    disagreed: 1,
                    wilsonLowerBoundBps: 1_208,
                },
                fullNamePresent: {
                    overall: {
                        known: 2,
                        predicted: 2,
                        agreed: 2,
                        disagreed: 0,
                        wilsonLowerBoundBps: 4_250,
                    },
                },
                usernameOnly: {
                    overall: {
                        known: 2,
                        predicted: 2,
                        agreed: 0,
                        disagreed: 2,
                        wilsonLowerBoundBps: 0,
                    },
                },
            },
            gates: {
                guardedFemaleCandidateVolumePass: false,
                restrictedFemaleSamplePass: false,
                restrictedFemalePrecisionPass: false,
                officialFinalRescuePass: true,
                nameOnlyPathWorthFurtherStudy: false,
            },
        });
    });

    it('fails all name-derived diagnostics closed while preserving visual and missing-public math', () => {
        const candidates = [
            candidate('u1', {
                name: name('u1', 'female'),
                feature: feature('female'),
            }),
            candidate('k1', {
                baseline: 'female',
                name: name('k1', 'female'),
                feature: feature('female'),
            }),
        ];
        const fusion = evaluatePublicNameVisualFusion({
            candidates,
            providerOk: false,
            missingPublic: 3,
        });

        const report = evaluatePublicGenderHeadroomV218({
            candidates,
            providerOk: false,
            missingPublic: 3,
            fusion,
        });

        expect(fusion.final).toEqual(fusion.baseline);
        expect(report).toMatchObject({
            baselineUnknown: 1,
            finalUnknown: 1,
            requiredAdditionalRescuesToObserved20: 1,
            requiredAdditionalRescuesToWorst20: 3,
            unknownNameVote: { female: 0, male: 0, none: 0 },
            unknownVisualVote: {
                female: 1,
                male: 0,
                none: 0,
            },
            guardedFemaleNameOnly: {
                strongName: 0,
                officialBlocked: 0,
                contextBlocked: 0,
                stageConflictBlocked: 0,
                maleVisualConflictBlocked: 0,
                eligible: 0,
            },
            knownCalibrationRestricted: {
                overall: {
                    known: 1,
                    predicted: 0,
                    agreed: 0,
                    disagreed: 0,
                    wilsonLowerBoundBps: 0,
                },
            },
            gates: {
                nameOnlyPathWorthFurtherStudy: false,
            },
        });
    });
});
