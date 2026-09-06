import { describe, expect, it } from 'vitest';
import {
    getLegacyAnalysisPublicReadiness,
    PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
} from './legacy-analysis-public-readiness';

const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const expectedPreflightFingerprint = '6ab53812cdc725c34bf3409713a893ec7787482e17df16ef622f3173a57251f2';

describe('public V1 freeze readiness observation', () => {
    it('reports non-sensitive active freeze evidence from the public runtime', () => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
            ANALYSIS_CAPACITY_SOURCE_SHA: sourceSha,
            VERCEL_GIT_COMMIT_SHA: sourceSha,
            ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE: 'vercel:production:analysis-v1',
            PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight-task@example-project.iam.gserviceaccount.com',
            PREFLIGHT_TASKS_TARGET_URL: 'https://preflight.example.com/api/analysis/preflight/worker',
            PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://preflight.example.com',
        });
        expect(result.ready).toBe(true);
        expect(result.sourceSha).toBe(sourceSha);
        expect(result.preflightProducerConfigFingerprintVersion)
            .toBe(PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION);
        expect(result.preflightProducerConfigFingerprint).toBe(expectedPreflightFingerprint);
        expect(result.preflightProducerConfigReady).toBe(true);
        expect(result.routes['/api/analysis/start']).toEqual({
            gateState: 'frozen',
            expectedStatus: 410,
            gateBeforeRuntime: true,
        });
        expect(Object.keys(result)).toEqual([
            'schemaVersion', 'ready', 'stage', 'freezeMode',
            'publicFreezeEnabled', 'sourceSha', 'legacyTargetResource',
            'preflightProducerConfigFingerprintVersion',
            'preflightProducerConfigFingerprint', 'preflightProducerConfigReady', 'routes',
        ]);
    });

    it('fails closed when public freeze config or provenance is absent', () => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
            VERCEL_GIT_COMMIT_SHA: sourceSha,
            ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE: 'vercel:production:analysis-v1',
        });
        expect(result.ready).toBe(false);
        expect(result.publicFreezeEnabled).toBe(false);
        expect(result.sourceSha).toBe(sourceSha);
        expect(result.preflightProducerConfigFingerprint).toBeNull();
        expect(result.preflightProducerConfigReady).toBe(false);
        expect(Object.values(result.routes).every((route) => route.expectedStatus === 410)).toBe(true);
    });

    it('fails closed when the active producer target or audience is invalid', () => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
            VERCEL_GIT_COMMIT_SHA: sourceSha,
            ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE: 'vercel:production:analysis-v1',
            PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight-task@example-project.iam.gserviceaccount.com',
            PREFLIGHT_TASKS_TARGET_URL: 'https://preflight.example.com/api/analysis/not-worker',
            PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://preflight.example.com',
        });
        expect(result.ready).toBe(false);
        expect(result.preflightProducerConfigFingerprint).toBeNull();
        expect(result.preflightProducerConfigReady).toBe(false);
    });

    it('does not treat bootstrap as active public freeze evidence', () => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'bootstrap',
            ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'false',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'bootstrap',
            ANALYSIS_CAPACITY_SOURCE_SHA: sourceSha,
            VERCEL_GIT_COMMIT_SHA: sourceSha,
        });
        expect(result.ready).toBe(false);
        expect(result.routes['/api/analysis/run'].gateBeforeRuntime).toBe(true);
    });

    it('rejects conflicting manual provenance instead of overriding Vercel provenance', () => {
        const result = getLegacyAnalysisPublicReadiness({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
            ANALYSIS_CAPACITY_SOURCE_SHA: sourceSha.replace(/0/g, 'f'),
            VERCEL_GIT_COMMIT_SHA: sourceSha,
            PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'preflight-task@example-project.iam.gserviceaccount.com',
            PREFLIGHT_TASKS_TARGET_URL: 'https://preflight.example.com/api/analysis/preflight/worker',
            PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://preflight.example.com',
        });
        expect(result.ready).toBe(false);
        expect(result.sourceSha).toBeNull();
    });
});
