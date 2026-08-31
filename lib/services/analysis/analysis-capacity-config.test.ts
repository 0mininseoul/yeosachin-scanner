import { describe, expect, it } from 'vitest';
import {
    ANALYSIS_CAPACITY_LIMITS,
    assertAnalysisCapacityConfig,
    getAnalysisCapacityConfig,
    parseAnalysisWorkloadRole,
} from './analysis-capacity-config';
import { assertAnalysisTaskWorkloadRole } from './workload-role';

const baseEnv = {
    ANALYSIS_WORKLOAD_ROLE: 'preflight',
    ANALYSIS_CAPACITY_STAGE: 'initial',
    PREFLIGHT_TASKS_QUEUE: 'analysis-preflight',
    PREFLIGHT_TASKS_TARGET_URL: 'https://preflight.example.com/api/analysis/preflight/worker',
    PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://preflight.example.com',
    PREFLIGHT_TASKS_CLOUD_RUN_SERVICE: 'analysis-preflight-worker',
    PREFLIGHT_TASKS_CLOUD_RUN_REGION: 'asia-northeast3',
    ANALYSIS_V2_TASKS_QUEUE: 'analysis-v2-pipeline',
    ANALYSIS_V2_TASKS_TARGET_URL: 'https://paid.example.com/api/analysis/v2/worker',
    ANALYSIS_V2_TASKS_OIDC_AUDIENCE: 'https://paid.example.com',
    ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE: 'analysis-paid-worker',
    ANALYSIS_V2_TASKS_CLOUD_RUN_REGION: 'asia-northeast3',
};

describe('automatic-analysis capacity configuration', () => {
    it('keeps approved initial and expansion ceilings explicit', () => {
        expect(ANALYSIS_CAPACITY_LIMITS).toEqual({
            preflightInitial: 32,
            preflightExpanded: 64,
            paidInitial: 8,
            paidExpandedMinimum: 16,
        });
        expect(getAnalysisCapacityConfig(baseEnv)).toMatchObject({
            role: 'preflight',
            activeConcurrency: 32,
            maxInstances: 32,
        });
        expect(getAnalysisCapacityConfig({
            ...baseEnv,
            ANALYSIS_WORKLOAD_ROLE: 'paid',
        })).toMatchObject({
            role: 'paid',
            activeConcurrency: 8,
            maxInstances: 8,
        });
    });

    it('allows expansion only behind an explicit canary gate', () => {
        expect(() => getAnalysisCapacityConfig({
            ...baseEnv,
            ANALYSIS_CAPACITY_STAGE: 'expanded',
        })).toThrow('ANALYSIS_CAPACITY_EXPANSION_GATE_REQUIRED');
        expect(getAnalysisCapacityConfig({
            ...baseEnv,
            ANALYSIS_CAPACITY_STAGE: 'expanded',
            ANALYSIS_CAPACITY_EXPANSION_CANARY: 'true',
        })).toMatchObject({
            activeConcurrency: 64,
            maxInstances: 64,
        });
        expect(getAnalysisCapacityConfig({
            ...baseEnv,
            ANALYSIS_WORKLOAD_ROLE: 'paid',
            ANALYSIS_CAPACITY_STAGE: 'expanded',
            ANALYSIS_CAPACITY_EXPANSION_CANARY: 'true',
        })).toMatchObject({
            activeConcurrency: 16,
            maxInstances: 16,
        });
    });

    it('fails closed on role, queue, target, and audience drift', () => {
        expect(() => parseAnalysisWorkloadRole(undefined)).toThrow(
            'ANALYSIS_WORKLOAD_ROLE_REQUIRED'
        );
        expect(() => parseAnalysisWorkloadRole('unknown')).toThrow(
            'ANALYSIS_WORKLOAD_ROLE_INVALID'
        );
        expect(() => getAnalysisCapacityConfig({
            ...baseEnv,
            PREFLIGHT_TASKS_TARGET_URL: 'https://paid.example.com/api/analysis/v2/worker',
        })).toThrow('ANALYSIS_CAPACITY_TARGET_ROLE_MISMATCH');
        expect(() => assertAnalysisCapacityConfig({
            ...baseEnv,
            ANALYSIS_WORKLOAD_ROLE: 'preflight',
            PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://other.example.com',
        })).toThrow('ANALYSIS_CAPACITY_AUDIENCE_TARGET_MISMATCH');
        expect(() => getAnalysisCapacityConfig({
            ...baseEnv,
            PREFLIGHT_TASKS_TARGET_URL:
                'https://shared.example.com/api/analysis/preflight/worker',
            PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://shared.example.com',
            ANALYSIS_V2_TASKS_TARGET_URL:
                'https://shared.example.com/api/analysis/v2/worker',
            ANALYSIS_V2_TASKS_OIDC_AUDIENCE: 'https://shared.example.com',
        })).toThrow('ANALYSIS_CAPACITY_TARGET_ROLE_COLLISION');
    });

    it('accepts legacy roleless payloads only for mixed-version drain and rejects declared drift', () => {
        expect(() => assertAnalysisTaskWorkloadRole(undefined, 'preflight')).not.toThrow();
        expect(() => assertAnalysisTaskWorkloadRole(null, 'paid')).not.toThrow();
        expect(() => assertAnalysisTaskWorkloadRole('paid', 'preflight')).toThrow(
            'ANALYSIS_WORKLOAD_ROLE_MISMATCH',
        );
        expect(() => assertAnalysisTaskWorkloadRole('preflight', 'paid')).toThrow(
            'ANALYSIS_WORKLOAD_ROLE_MISMATCH',
        );
    });
});
