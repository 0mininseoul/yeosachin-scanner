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
});
