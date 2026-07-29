import { describe, expect, it } from 'vitest';
import {
    evaluateProGenderSecondLookV219,
    projectProGenderSecondLookV219,
    selectProGenderSecondLookMediaV219,
    type ProGenderSecondLookCandidateV219,
    type ProGenderSecondLookMediaV219,
    type ProGenderSecondLookResultV219,
} from './replay-v219-gender-second-look';

function media(
    selectionId: string,
    kind: 'profile' | 'feed',
    postId?: string,
): ProGenderSecondLookMediaV219 {
    return {
        selectionId,
        kind,
        jpegBase64: '/9j/2Q==',
        ...(postId ? { postId } : {}),
    };
}

function result(
    inferredGender: 'female' | 'male' | 'unknown',
    overrides: Partial<ProGenderSecondLookResultV219> = {},
): ProGenderSecondLookResultV219 {
    return {
        inferredGender,
        genderConfidence: inferredGender === 'unknown' ? 'low' : 'high',
        ownerConsistency:
            inferredGender === 'unknown' ? 'not_visible' : 'same_person',
        accountContext:
            inferredGender === 'unknown' ? 'uncertain' : 'personal',
        contextConfidence:
            inferredGender === 'unknown' ? 'low' : 'high',
        genderEvidenceIds:
            inferredGender === 'unknown' ? [] : ['source-1', 'source-2'],
        contextEvidenceIds:
            inferredGender === 'unknown' ? [] : ['source-1'],
        ...overrides,
    };
}

function candidate(
    index: number,
    controlLabel: 'female' | 'male' | 'unknown' | 'unavailable',
    treatment: ProGenderSecondLookResultV219 | undefined,
    overrides: Partial<ProGenderSecondLookCandidateV219> = {},
): ProGenderSecondLookCandidateV219 {
    return {
        key: `candidate-${index}`,
        controlLabel,
        finalBeforeTreatment:
            controlLabel === 'female' || controlLabel === 'male'
                ? controlLabel
                : 'unknown',
        controlTerminal:
            controlLabel === 'unavailable' ? 'analysis_unavailable'
                : 'unresolved',
        officialOrGroupExcluded: false,
        invocationOutcome: treatment ? 'ok' : 'failed',
        ...(treatment ? { treatment } : {}),
        ...overrides,
    };
}

describe('V2.19 Pro gender second-look media projection', () => {
    it('orders profile then distinct posts before carousel context and caps at 1+8', () => {
        const selected = selectProGenderSecondLookMediaV219([
            media('profile', 'profile'),
            media('a-1', 'feed', 'post-a'),
            media('a-2', 'feed', 'post-a'),
            media('b-1', 'feed', 'post-b'),
            media('b-2', 'feed', 'post-b'),
            media('c-1', 'feed', 'post-c'),
            media('d-1', 'feed', 'post-d'),
            media('e-1', 'feed', 'post-e'),
            media('f-1', 'feed', 'post-f'),
            media('g-1', 'feed', 'post-g'),
            media('h-1', 'feed', 'post-h'),
            media('i-1', 'feed', 'post-i'),
        ]);

        expect(selected.map(item => item.selectionId)).toEqual([
            'profile',
            'a-1',
            'b-1',
            'c-1',
            'd-1',
            'e-1',
            'f-1',
            'g-1',
            'h-1',
        ]);
    });

    it('uses carousel context only after every distinct representative', () => {
        const selected = selectProGenderSecondLookMediaV219([
            media('profile', 'profile'),
            media('a-1', 'feed', 'post-a'),
            media('a-2', 'feed', 'post-a'),
            media('a-3', 'feed', 'post-a'),
            media('b-1', 'feed', 'post-b'),
            media('b-2', 'feed', 'post-b'),
        ]);

        expect(selected.map(item => item.selectionId)).toEqual([
            'profile',
            'a-1',
            'b-1',
            'a-2',
            'b-2',
            'a-3',
        ]);
    });

    it('projects only opaque IDs and round-trips strict evidence', () => {
        const projection = projectProGenderSecondLookV219([
            media('source-profile', 'profile'),
            media('source-feed-a', 'feed', 'source-post-a'),
            media('source-feed-b', 'feed', 'source-post-b'),
        ]);

        expect(projection.projectedMedia.map(item => item.selectionId))
            .toEqual([
                'second-look-media:1',
                'second-look-media:2',
                'second-look-media:3',
            ]);
        expect(projection.prompt).not.toContain('source-profile');
        expect(projection.prompt).not.toContain('source-feed');
        expect(projection.prompt).not.toContain('source-post');
        const parsed = projection.schema.parse({
            inferredGender: 'female',
            genderConfidence: 'high',
            ownerConsistency: 'same_person',
            accountContext: 'personal',
            contextConfidence: 'high',
            genderEvidenceIds: [
                'second-look-media:1',
                'second-look-media:2',
            ],
            contextEvidenceIds: ['second-look-media:2'],
        });
        expect(projection.finalize(parsed)).toMatchObject({
            inferredGender: 'female',
            genderEvidenceIds: ['source-profile', 'source-feed-a'],
            contextEvidenceIds: ['source-feed-a'],
        });
    });

    it('rejects weak, contradictory, duplicate, unknown, and extra evidence shapes', () => {
        const projection = projectProGenderSecondLookV219([
            media('source-1', 'profile'),
            media('source-2', 'feed', 'post-2'),
        ]);
        const valid = {
            inferredGender: 'female',
            genderConfidence: 'high',
            ownerConsistency: 'same_person',
            accountContext: 'personal',
            contextConfidence: 'high',
            genderEvidenceIds: [
                'second-look-media:1',
                'second-look-media:2',
            ],
            contextEvidenceIds: ['second-look-media:1'],
        } as const;

        expect(projection.schema.safeParse({
            ...valid,
            genderEvidenceIds: ['second-look-media:1'],
        }).success).toBe(false);
        expect(projection.schema.safeParse({
            ...valid,
            genderEvidenceIds: [
                'second-look-media:1',
                'second-look-media:1',
            ],
        }).success).toBe(false);
        expect(projection.schema.safeParse({
            ...valid,
            genderEvidenceIds: [
                'second-look-media:1',
                'second-look-media:99',
            ],
        }).success).toBe(false);
        expect(projection.schema.safeParse({
            ...valid,
            ownerConsistency: 'not_visible',
        }).success).toBe(false);
        expect(projection.schema.safeParse({
            ...valid,
            contextEvidenceIds: [],
        }).success).toBe(false);
        expect(projection.schema.safeParse({
            ...valid,
            extra: true,
        }).success).toBe(false);
    });

    it('rejects a treatment projection with fewer than two unique media items', () => {
        expect(() => projectProGenderSecondLookV219([
            media('only', 'profile'),
        ])).toThrow('ANALYSIS_V2_REPLAY_V219_TREATMENT_MEDIA_INSUFFICIENT');
    });
});

describe('V2.19 Pro gender second-look evaluation', () => {
    function passingCandidates(): ProGenderSecondLookCandidateV219[] {
        const values: ProGenderSecondLookCandidateV219[] = [];
        for (let index = 0; index < 20; index++) {
            values.push(candidate(index, 'male', result('male')));
            values.push(candidate(100 + index, 'female', result('female')));
        }
        for (let index = 0; index < 32; index++) {
            values.push(candidate(
                200 + index,
                'unknown',
                result(index % 2 ? 'female' : 'male'),
            ));
        }
        return values;
    }

    it('applies enough calibrated rescues to pass observed and worst-case 20 percent', () => {
        const report = evaluateProGenderSecondLookV219({
            candidates: passingCandidates(),
            baselineFinal: { male: 76, female: 84, unknown: 75 },
            observedPublic: 235,
            missingPublic: 5,
        });

        expect(report.calibration).toMatchObject({
            overall: {
                known: 40,
                predicted: 40,
                agreed: 40,
                disagreed: 0,
            },
            male: { predicted: 20, agreed: 20, disagreed: 0 },
            female: { predicted: 20, agreed: 20, disagreed: 0 },
            knownMaleToFemale: 0,
        });
        expect(report.unknown).toMatchObject({
            baseline: 75,
            treatmentCandidates: 32,
            counterfactualRescuedMale: 16,
            counterfactualRescuedFemale: 16,
            appliedRescuedMale: 16,
            appliedRescuedFemale: 16,
            final: 43,
        });
        expect(report.final).toEqual({
            male: 92,
            female: 100,
            unknown: 43,
        });
        expect(report.gates).toMatchObject({
            calibrationVolumePass: true,
            overallAgreementPass: true,
            maleVolumePass: true,
            maleAgreementPass: true,
            femaleVolumePass: true,
            femaleAgreementPass: true,
            falseFemalePass: true,
            officialNegativePass: true,
            observedUnknownPass: true,
            worstCaseUnknownPass: true,
            adoptionPass: true,
        });
    });

    it('blocks all applied rescues when one known male becomes female', () => {
        const candidates = passingCandidates();
        candidates[0] = candidate(0, 'male', result('female'));
        const report = evaluateProGenderSecondLookV219({
            candidates,
            baselineFinal: { male: 76, female: 84, unknown: 75 },
            observedPublic: 235,
            missingPublic: 5,
        });

        expect(report.calibration.knownMaleToFemale).toBe(1);
        expect(report.unknown).toMatchObject({
            counterfactualRescuedMale: 16,
            counterfactualRescuedFemale: 16,
            appliedRescuedMale: 0,
            appliedRescuedFemale: 0,
            final: 75,
        });
        expect(report.gates.falseFemalePass).toBe(false);
        expect(report.gates.adoptionPass).toBe(false);
    });

    it('preserves stage-conflict matching and unavailable exclusions', () => {
        const base = passingCandidates();
        base.push(candidate(500, 'unknown', result('female'), {
            controlTerminal: 'unresolved_stage_conflict',
            conflictingGenders: ['male'],
        }));
        base.push(candidate(501, 'unknown', result('male'), {
            controlTerminal: 'unresolved_stage_conflict',
            conflictingGenders: ['male', 'female'],
        }));
        base.push(candidate(502, 'unavailable', result('female'), {
            finalBeforeTreatment: 'unknown',
            controlTerminal: 'media_unavailable',
        }));
        const report = evaluateProGenderSecondLookV219({
            candidates: base,
            baselineFinal: { male: 76, female: 84, unknown: 78 },
            observedPublic: 238,
            missingPublic: 5,
        });

        expect(report.unknown.nullReasons).toMatchObject({
            stage_conflict_mismatch: 1,
            unavailable_control: 1,
        });
        expect(report.unknown.counterfactualRescuedMale).toBe(17);
        expect(report.unknown.counterfactualRescuedFemale).toBe(16);
    });

    it('fails the official negative gate on a qualifying official counterfactual', () => {
        const values = passingCandidates();
        values.push(candidate(600, 'male', result('female'), {
            officialOrGroupExcluded: true,
        }));
        const report = evaluateProGenderSecondLookV219({
            candidates: values,
            baselineFinal: { male: 76, female: 84, unknown: 75 },
            observedPublic: 235,
            missingPublic: 5,
        });

        expect(report.officialNegative).toEqual({
            known: 1,
            attempted: 1,
            accepted: 1,
        });
        expect(report.gates.officialNegativePass).toBe(false);
        expect(report.gates.adoptionPass).toBe(false);
    });

    it('keeps non-success, low evidence, and nonpersonal treatment unknown', () => {
        const values = passingCandidates();
        values.push(candidate(700, 'unknown', undefined));
        values.push(candidate(701, 'unknown', result('female', {
            genderEvidenceIds: ['source-1'],
        })));
        values.push(candidate(702, 'unknown', result('male', {
            accountContext: 'uncertain',
            contextConfidence: 'low',
            contextEvidenceIds: [],
        })));
        const report = evaluateProGenderSecondLookV219({
            candidates: values,
            baselineFinal: { male: 76, female: 84, unknown: 78 },
            observedPublic: 238,
            missingPublic: 5,
        });

        expect(report.unknown.nullReasons).toMatchObject({
            provider_non_ok: 1,
            insufficient_gender_evidence: 1,
            nonpersonal_context: 1,
        });
    });
});
