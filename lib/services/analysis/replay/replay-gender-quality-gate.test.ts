import { describe, expect, it } from 'vitest';
import { evaluateReplayGenderQualityGate } from './replay-gender-quality-gate';

describe('replay AI-only gender quality gate', () => {
    it('separates observed unknown from missing-public worst case', () => {
        expect(evaluateReplayGenderQualityGate({
            male: 55,
            female: 133,
            unknown: 47,
            missingPublic: 5,
        })).toEqual({
            observedUnknownRate: 0.2,
            worstCaseUnknownRate: 0.2167,
            observedPass: true,
            worstCasePass: false,
        });
    });

    it('uses unrounded integer arithmetic at the twenty-percent boundary', () => {
        expect(evaluateReplayGenderQualityGate({
            male: 4, female: 0, unknown: 1, missingPublic: 0,
        }).observedPass).toBe(true);
        expect(evaluateReplayGenderQualityGate({
            male: 79, female: 0, unknown: 21, missingPublic: 0,
        }).observedPass).toBe(false);
    });
});
