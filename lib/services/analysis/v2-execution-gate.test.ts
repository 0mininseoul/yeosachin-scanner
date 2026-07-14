import { describe, expect, it } from 'vitest';
import {
    ANALYSIS_V2_EXECUTION_CAPABILITY,
    isAnalysisV2AdmissionAvailable,
    isAnalysisV2RecoveryAvailable,
    isAnalysisV2WorkerAvailable,
} from './v2-execution-gate';

describe('analysis V2 split execution gates', () => {
    it('ships the jobs capability behind three explicit independent flags', () => {
        expect(ANALYSIS_V2_EXECUTION_CAPABILITY).toBe('jobs');
        const env = {
            ANALYSIS_V2_ADMISSION_ENABLED: 'false',
            ANALYSIS_V2_WORKER_ENABLED: 'true',
            ANALYSIS_V2_RECOVERY_ENABLED: 'true',
        };
        expect(isAnalysisV2AdmissionAvailable(env)).toBe(false);
        expect(isAnalysisV2WorkerAvailable(env)).toBe(true);
        expect(isAnalysisV2RecoveryAvailable(env)).toBe(true);
    });

    it.each([
        [isAnalysisV2AdmissionAvailable, 'ANALYSIS_V2_ADMISSION_ENABLED'],
        [isAnalysisV2WorkerAvailable, 'ANALYSIS_V2_WORKER_ENABLED'],
        [isAnalysisV2RecoveryAvailable, 'ANALYSIS_V2_RECOVERY_ENABLED'],
    ] as const)('fails closed and rejects ambiguous %s values', (gate, key) => {
        expect(gate({})).toBe(false);
        expect(gate({ [key]: 'off' })).toBe(false);
        expect(gate({ [key]: 'on' })).toBe(true);
        expect(() => gate({ [key]: 'enabled' })).toThrow(`${key} must be boolean.`);
    });
});
