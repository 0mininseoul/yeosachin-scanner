import { describe, expect, it } from 'vitest';
import {
    ANALYSIS_V2_EXECUTION_CAPABILITY,
    isAnalysisV2StartAvailable,
} from './v2-execution-gate';

describe('analysis V2 execution gate', () => {
    it('keeps entitlement consumption closed until the jobs capability ships', () => {
        expect(ANALYSIS_V2_EXECUTION_CAPABILITY).toBe('preflight_only');
        expect(isAnalysisV2StartAvailable({
            ANALYSIS_V2_EXECUTION_ENABLED: 'true',
        })).toBe(false);
    });
});
