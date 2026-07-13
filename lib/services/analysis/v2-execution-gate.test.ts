import { describe, expect, it } from 'vitest';
import {
    ANALYSIS_V2_EXECUTION_CAPABILITY,
    isAnalysisV2StartAvailable,
} from './v2-execution-gate';

describe('analysis V2 execution gate', () => {
    it('ships the jobs capability behind the explicit execution flag', () => {
        expect(ANALYSIS_V2_EXECUTION_CAPABILITY).toBe('jobs');
        expect(isAnalysisV2StartAvailable({
            ANALYSIS_V2_EXECUTION_ENABLED: 'true',
        })).toBe(true);
    });

    it.each([
        undefined,
        '',
        '0',
        'false',
        'off',
        'no',
    ])('keeps execution closed when the flag is %s', value => {
        expect(isAnalysisV2StartAvailable({
            ANALYSIS_V2_EXECUTION_ENABLED: value,
        })).toBe(false);
    });

    it('rejects an ambiguous execution flag', () => {
        expect(() => isAnalysisV2StartAvailable({
            ANALYSIS_V2_EXECUTION_ENABLED: 'enabled',
        })).toThrow('ANALYSIS_V2_EXECUTION_ENABLED must be boolean.');
    });
});
